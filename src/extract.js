// ---------------------------------------------------------------------------
// extract.js — lecture du prix et de la disponibilite depuis une page produit.
//
// Strategie en cascade, de la plus fiable a la moins fiable :
//   1. JSON-LD schema.org (PrestaShop, Shopify, WooCommerce, Magento en
//      emettent quasiment tous) -> confiance "high"
//   2. balises meta OpenGraph / microdata itemprop            -> confiance "high"
//   3. heuristique texte en francais                          -> confiance "low"
//
// Rien ici ne depend d'une boutique en particulier : ajouter un marchand ne
// demande pas d'ecrire du code, juste une URL de recherche.
// ---------------------------------------------------------------------------

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Certaines boutiques placent leur JSON-LD tout en bas d'une page de 650 Ko
// (Maison de la Presse : bloc Product a l'octet 655 104). Un plafond trop bas
// fait manquer la seule source fiable de la page.
const MAX_HTML = 1_200_000;

export async function fetchPage(url, { timeoutMs = 12_000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'fr-FR,fr;q=0.9,en-US;q=0.6,en;q=0.5',
        'cache-control': 'no-cache',
      },
    });
    const finalUrl = res.url || url;
    if (!res.ok) return { ok: false, status: res.status, html: '', url: finalUrl };
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('xml') && !ct.includes('json')) {
      return { ok: false, status: res.status, html: '', url: finalUrl, error: 'not html' };
    }
    const html = (await res.text()).slice(0, MAX_HTML);
    return { ok: true, status: res.status, html, url: finalUrl };
  } catch (err) {
    return { ok: false, status: 0, html: '', url, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// --- utilitaires -----------------------------------------------------------

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

function typeOf(node) {
  return toArray(node?.['@type']).map((t) => String(t).toLowerCase());
}

export function parsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = String(raw).trim();
  if (!s) return null;
  // "1 299,90 €" / "1,299.90" / "12.99" / "12,99"
  s = s.replace(/[\s\u00a0\u202f]/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // le dernier separateur rencontre est le separateur decimal
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // virgule seule : decimale si 1 ou 2 chiffres derriere, sinon milliers
    s = s.length - lastComma - 1 <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

function availabilityStatus(raw) {
  if (!raw) return null;
  // on ramene tout a des lettres : "In Stock", "in_stock",
  // "https://schema.org/InStock" et "in stock" deviennent la meme chose.
  const s = String(raw).toLowerCase().replace(/[^a-z]/g, '');
  if (!s) return null;
  if (/(preorder|presale|preventeadeposit)/.test(s)) return 'preorder';
  if (/(outofstock|soldout|discontinued|backorder|nostock|unavailable|indisponible|rupture)/.test(s)) return 'oos';
  if (/(instock|limitedavailability|onlineonly|instoreonly|available|disponible)/.test(s)) return 'in_stock';
  return null;
}

// --- 1. JSON-LD ------------------------------------------------------------

function collectNodes(node, out, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectNodes(n, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;
  out.push(node);
  if (node['@graph']) collectNodes(node['@graph'], out, depth + 1);
  if (node.mainEntity) collectNodes(node.mainEntity, out, depth + 1);
  if (node.itemListElement) collectNodes(node.itemListElement, out, depth + 1);
  if (node.item) collectNodes(node.item, out, depth + 1);
  if (node.hasVariant) collectNodes(node.hasVariant, out, depth + 1);
}

export function jsonLdNodes(html) {
  const out = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim().replace(/^\ufeff/, '');
    if (!raw) continue;
    try {
      collectNodes(JSON.parse(raw), out);
    } catch {
      // JSON-LD casse (assez frequent) : on tente de recuperer le 1er objet
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start > -1 && end > start) {
        try {
          collectNodes(JSON.parse(raw.slice(start, end + 1)), out);
        } catch { /* tant pis */ }
      }
    }
  }
  return out;
}

function offersOf(product) {
  const flat = [];
  for (const o of toArray(product.offers)) {
    if (!o || typeof o !== 'object') continue;
    const t = typeOf(o).join(' ');
    if (t.includes('aggregate')) {
      flat.push({
        price: o.lowPrice ?? o.price,
        priceCurrency: o.priceCurrency,
        availability: o.availability ?? (Number(o.offerCount) > 0 ? 'InStock' : null),
        url: o.url,
      });
      for (const sub of toArray(o.offers)) if (sub && typeof sub === 'object') flat.push(sub);
    } else {
      flat.push(o);
    }
  }
  return flat;
}

// --- 2. meta / microdata ---------------------------------------------------

function metaContent(html, patterns) {
  for (const p of patterns) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${p}["'][^>]*>`,
      'i',
    );
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const val = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (val) return val;
  }
  return null;
}

function microdataPrice(html) {
  const tag = html.match(/<[^>]+itemprop\s*=\s*["']price["'][^>]*>/i)?.[0];
  if (!tag) return null;
  return tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1] ?? null;
}

// --- 3. heuristique texte --------------------------------------------------

export function stripNoise(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // menus, en-tetes et pieds de page : ils parlent des AUTRES produits du
    // site. Le menu « Precommandes Livres » de Maison de la Presse faisait
    // passer pour une precommande un blister affiche « En stock ».
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, ' ');
}

const RE_OOS = /(rupture\s+de\s+stock|actuellement\s+indisponible|momentan[ée]ment\s+indisponible|produit\s+indisponible|n['’]est\s+plus\s+disponible|plus\s+disponible|[ée]puis[ée]|sold\s*out|out\s+of\s+stock|hors\s+stock|me\s+pr[ée]venir\s+(?:quand|lors|d[eè]s)|alertez[- ]moi|pr[ée]venez[- ]moi)/i;
const RE_PREORDER = /(pr[ée][- ]?commande|pr[ée]commander|pre[- ]?order|sortie\s+le\s|disponible\s+(?:le|[àa]\s+partir\s+du)\s|date\s+d['’]arriv[ée]e)/i;
const RE_INSTOCK = /(ajouter\s+au\s+panier|ajouter\s+[àa]\s+mon\s+panier|mettre\s+au\s+panier|add\s+to\s+(?:cart|basket)|en\s+stock|disponible\s+imm[ée]diatement|exp[ée]di[ée]\s+sous|livraison\s+sous|derni(?:er|ers)\s+article|acheter\s+maintenant)/i;

function classify(text) {
  // ordre volontaire : une page en rupture contient presque toujours aussi
  // un bouton "ajouter au panier" desactive dans le DOM.
  if (RE_OOS.test(text)) return 'oos';
  if (RE_PREORDER.test(text)) return 'preorder';
  if (RE_INSTOCK.test(text)) return 'in_stock';
  return 'unknown';
}

/**
 * Le statut se lit dans le bloc d'achat, pas n'importe ou dans la page :
 * on ouvre une fenetre autour du premier prix affiche. Un mot croise dans un
 * menu ou un carrousel « vous aimerez aussi » ne doit pas decider du statut.
 */
export function textStatus(text) {
  const priceAt = text.search(/\d{1,4}(?:[\u00a0\u202f ]?\d{3})*[.,]\d{2}\s*(?:€|EUR)/i);
  if (priceAt > -1) {
    const near = classify(text.slice(Math.max(0, priceAt - 1200), priceAt + 1200));
    if (near !== 'unknown') return near;
  }
  return classify(text);
}

function textPrice(text) {
  const matches = [...text.matchAll(/(\d{1,4}(?:[   ]?\d{3})*[.,]\d{2})\s*(?:€|EUR)/gi)]
    .map((m) => parsePrice(m[1]))
    .filter((n) => n != null);
  if (!matches.length) return null;
  // le prix affiche le plus souvent sur la page est presque toujours le bon
  const tally = new Map();
  for (const n of matches) tally.set(n, (tally.get(n) || 0) + 1);
  let best = matches[0];
  let bestCount = 0;
  for (const [n, c] of tally) if (c > bestCount) { best = n; bestCount = c; }
  return best;
}

// --- l'extracteur ----------------------------------------------------------

/**
 * @returns {{price:number|null, currency:string, status:string, confidence:string, title:string|null}}
 *   status : in_stock | preorder | oos | unknown
 */
export function extractOffer(html, { ean = null } = {}) {
  const result = { price: null, currency: 'EUR', status: 'unknown', confidence: 'none', title: null };
  if (!html) return result;

  result.title =
    metaContent(html, ['og:title', 'twitter:title']) ||
    html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i)?.[1]?.trim() ||
    null;

  // 1. JSON-LD. Une page de listing publie un noeud Product PAR article :
  // si on cherche un EAN precis, on prend le noeud qui le porte plutot que
  // le premier venu, sinon on lisait le prix d'un article au hasard.
  let productNodes = jsonLdNodes(html).filter((n) => typeOf(n).some((t) => t.includes('product')));
  if (ean && productNodes.length > 1) {
    const exact = productNodes.filter((n) =>
      ['gtin13', 'gtin12', 'gtin8', 'gtin', 'sku', 'mpn'].some((k) => String(n[k] ?? '') === String(ean)));
    if (exact.length) productNodes = exact;
  }
  for (const node of productNodes) {
    if (!typeOf(node).some((t) => t.includes('product'))) continue;
    for (const offer of offersOf(node)) {
      const price = parsePrice(offer.price ?? offer.lowPrice);
      const status = availabilityStatus(offer.availability ?? offer.itemCondition);
      if (price != null && result.price == null) {
        result.price = price;
        result.currency = offer.priceCurrency || 'EUR';
        result.confidence = 'high';
      }
      if (status && result.status === 'unknown') result.status = status;
    }
    if (result.price != null && result.status !== 'unknown') break;
  }

  // 2. meta / microdata
  if (result.price == null) {
    const raw =
      metaContent(html, ['product:price:amount', 'og:price:amount', 'twitter:data1', 'price']) ||
      microdataPrice(html);
    const price = parsePrice(raw);
    if (price != null) {
      result.price = price;
      result.confidence = 'high';
      const cur = metaContent(html, ['product:price:currency', 'og:price:currency']);
      if (cur) result.currency = cur;
    }
  }
  if (result.status === 'unknown') {
    const raw =
      metaContent(html, ['product:availability', 'og:availability', 'availability']) ||
      html.match(/<link[^>]+itemprop\s*=\s*["']availability["'][^>]+href\s*=\s*["']([^"']+)["']/i)?.[1];
    const status = availabilityStatus(raw);
    if (status) result.status = status;
  }

  // 3. texte
  if (result.price == null || result.status === 'unknown') {
    const text = stripNoise(html).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
    if (result.status === 'unknown') result.status = textStatus(text);
    if (result.price == null) {
      const price = textPrice(text);
      if (price != null) {
        result.price = price;
        result.confidence = 'low';
      }
    }
  }

  return result;
}

// --- verification : est-on bien sur la fiche du produit cherche ? ----------
//
// Etape indispensable : un lien peut sembler pertinent et mener en realite a
// une page de categorie. On y trouve alors un prix parfaitement valide — celui
// d'un AUTRE article. C'est ainsi qu'un blister a 6 € heritait de 121,50 €
// chez Philibert, la meme page de rayon servant aussi pour le deck ST-35.

// Une page de recherche, un rayon ou l'accueil d'une boutique affichent des
// prix parfaitement valides — ceux d'autres articles. Aucune de ces adresses
// ne peut etre la fiche d'un produit, quel que soit son contenu.
// Deux formes distinctes, a ne pas confondre :
//   - un rayon est un PREFIXE suivi d'autre chose  -> /c/cartes-one-piece
//   - une recherche TERMINE le chemin              -> /search?q=...
// La nuance compte : chez Shopify /collections/xxx est un rayon tandis que
// /products/xxx est bien une fiche produit.
const LISTING_PREFIX =
  /\/(c|cat|categorie|categories|category|rayon|collection|collections|catalogue|univers|marque)\//i;
const LISTING_TERMINAL =
  /\/(search|recherche|rechercher|catalogsearch|resultats?|results|boutique|shop|products|produits)\/?($|\?)/i;
const LISTING_QUERY = /[?&](q|s|search|text|keyword|query|controller=search)=/i;

export function isListingUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  // racine du site : www.boutique.fr/ ou /fr/
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path === '' || /^\/[a-z]{2}(-[a-z]{2})?$/i.test(path)) return true;
  return LISTING_PREFIX.test(parsed.pathname)
    || LISTING_TERMINAL.test(parsed.pathname + parsed.search)
    || LISTING_QUERY.test(parsed.search);
}

function pageIdentity(html) {
  const title = (html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] || '').replace(/<[^>]+>/g, ' ');
  const h1 = (html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i)?.[1] || '').replace(/<[^>]+>/g, ' ');
  const names = [];
  const gtins = [];
  for (const node of jsonLdNodes(html)) {
    if (!typeOf(node).some((t) => t.includes('product'))) continue;
    if (node.name) names.push(String(node.name));
    for (const k of ['gtin13', 'gtin12', 'gtin8', 'gtin', 'sku', 'mpn']) {
      if (node[k]) gtins.push(String(node[k]));
    }
  }
  return { title, h1, names, gtins, productCount: new Set(names).size };
}

/**
 * @returns {{ok:boolean, score:number, why:string}}
 *   ok = false -> ne pas enregistrer de prix pour cette page
 */
export function confirmProduct(html, url, { ean = null, label = '' } = {}) {
  // Refus structurel, avant tout examen du contenu : ce genre d'adresse n'est
  // jamais une fiche produit. C'est ce qui laissait passer les 349,99 € lus
  // sur la grille de resultats de Koala Games.
  if (isListingUrl(url)) return { ok: false, score: -99, why: 'page de recherche ou de rayon' };

  const id = pageIdentity(html);
  const heading = `${id.title} ${id.h1} ${id.names.slice(0, 3).join(' ')} ${url}`;
  const wantedCodes = [...tokenize(label)].filter((t) => SET_CODE.test(t));
  const wantedForms = detectForms(label);

  // Edition / langue. Philippe ne veut jamais du japonais, quel que soit le
  // produit demande : une fiche identifiee comme japonaise est rejetee tout
  // de suite, avant meme de compter les points. Un produit dont le libelle
  // precise explicitement FR ou EN est en plus rejete si la fiche ne montre
  // que l'autre langue (ex. « OP-17 EN » ne doit jamais matcher une fiche
  // qui n'affiche que FR, et inversement) ; un libelle sans mention de
  // langue n'est pas restreint par cette regle.
  const pageEdition = detectEdition(heading);
  if (pageEdition.has('jp')) return { ok: false, score: -99, why: 'édition japonaise (jamais voulue)' };

  const wantedEdition = detectEdition(label);
  if (wantedEdition.size && pageEdition.size) {
    const wantsFr = wantedEdition.has('fr');
    const wantsEn = wantedEdition.has('en');
    if ((wantsFr && !wantsEn && pageEdition.has('en') && !pageEdition.has('fr')) ||
        (wantsEn && !wantsFr && pageEdition.has('fr') && !pageEdition.has('en'))) {
      return { ok: false, score: -99, why: `édition demandée (${[...wantedEdition].join('/')}) ≠ édition trouvée (${[...pageEdition].join('/')})` };
    }
  }

  let score = 0;
  const why = [];

  if (ean) {
    const e = String(ean);
    if (html.includes(e) || id.gtins.includes(e)) { score += 10; why.push('EAN present'); }
  }
  const codeHit = wantedCodes.some((c) => tokenize(heading).includes(c));
  if (codeHit) { score += 6; why.push('code extension dans le titre'); }

  const headForms = detectForms(heading);
  if (wantedForms.size && headForms.size) {
    if ([...wantedForms].some((f) => headForms.has(f))) { score += 3; why.push('format concordant'); }
    else { score -= 8; why.push('format contradictoire'); }
  }

  // beaucoup de produits distincts sur la page = c'est un rayon, pas une fiche
  if (id.productCount >= 3) { score -= 6; why.push(`${id.productCount} produits sur la page`); }

  return { ok: score >= 6, score, why: why.join(', ') || 'aucun indice' };
}

// --- recherche : trouver la page produit dans une page de resultats ---------

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

const BAD_LINK = /(\/(panier|cart|checkout|login|connexion|compte|account|cgv|contact|blog|mentions|help|aide|wishlist|favoris)\b|javascript:|mailto:|tel:|#)/i;

function tokenize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // « OP-10 », « op 10 » et « op10 » designent la meme extension : on les
    // ramene a un seul jeton, sinon le code se casse en « op » + « 10 » et
    // perd tout son pouvoir discriminant.
    .replace(/\b(op|dp|st|eb|prb|ex|ev|sv|sm|xy|bw)[\s_-]?(\d{1,3})\b/g, '$1$2')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((t) => t.length > 1);
}

// Un code d'extension (op10, dp12, st21…) identifie un produit bien mieux que
// « booster » ou « blister », que toutes les boutiques emploient pour tout.
const SET_CODE = /^(op|dp|st|eb|prb|ex|ev|sv|sm|xy|bw)\d{1,3}$/;

// Le FORMAT du produit. Dans une meme extension, « OP-17 » designe aussi bien
// un blister a 6 € qu'un display a 140 € : le code d'extension ne suffit donc
// pas a identifier un produit, il faut aussi savoir de quel conditionnement
// on parle. Deux formats differents = ce n'est pas le meme article.
const FORMS = [
  ['display',    /display|pr[ée]sentoir|bo[iî]te\s+de\s+\d+|box\s+de\s+\d+|\bcase\b|carton\s+de/i],
  ['blister',    /blister/i],
  ['doublepack', /double\s*-?\s*pack|\bdp\s?-?\d{1,2}\b/i],
  ['starter',    /starter|deck\s+de\s+d[ée]marrage|\bst\s?-?\d{1,2}\b/i],
];

function detectForms(str) {
  const out = new Set();
  const t = String(str || '');
  for (const [name, re] of FORMS) if (re.test(t)) out.add(name);
  return out;
}

// Edition / langue. Un "OP-17" existe en francais, anglais ET japonais — trois
// produits differents vendus au meme genre de prix. Philippe ne veut jamais
// du japonais quel que soit le produit, et un produit explicitement FR ne
// doit jamais faire remonter le prix d'une fiche EN (ou l'inverse).
// Mots entiers uniquement : "japonais"/"japanese" ne s'ecrivent jamais par
// accident, mais "\bEN\b"/"\bFR\b" en minuscule seraient beaucoup trop
// frequents dans une phrase ("en stock", "il y a fr...") — on ne les detecte
// donc que sous leur forme abregee EN MAJUSCULES, comme les boutiques les
// ecrivent en suffixe ("OP-17 EN", "Booster FR").
const EDITION_JP_WORD = /\bjaponais(?:e)?\b|\bjapanese\b|\bjap\.?\b/i;
const EDITION_EN_WORD = /\banglais(?:e)?\b|\benglish\b/i;
const EDITION_FR_WORD = /\bfran[cç]ais(?:e)?\b/i;

function detectEdition(str) {
  const t = String(str || '');
  const out = new Set();
  if (EDITION_JP_WORD.test(t) || /\bJP\b/.test(t)) out.add('jp');
  if (EDITION_EN_WORD.test(t) || /\bEN\b/.test(t)) out.add('en');
  if (EDITION_FR_WORD.test(t) || /\bFR\b/.test(t) || /\bVF\b/.test(t)) out.add('fr');
  return out;
}

// Retire les accents : sans ca « Pokémon » ne correspondait pas a « pokemon »
// et toutes les recherches Pokemon ecrites correctement en francais ne
// trouvaient plus rien.
const deburr = (str) =>
  String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// Les univers de jeu. Le filtre marche dans les deux sens : une page Pokemon
// est ecartee d'une recherche One Piece, et l'inverse est vrai aussi.
const FRANCHISE = /(pokemon|one\s?piece|yu\s?-?\s?gi\s?-?\s?oh|yugioh|magic\s+the\s+gathering|\bmtg\b|digimon|dragon\s?ball|lorcana|altered|riftbound|star\s?wars\s+unlimited)/i;

const franchiseOf = (str) => {
  const m = deburr(str).match(FRANCHISE);
  return m ? m[0].replace(/[\s-]/g, '') : null;
};

/**
 * Repere les liens produits d'une page de resultats et les classe par
 * pertinence vis-a-vis de l'EAN / du nom recherche.
 */
export function findProductLinks(html, baseUrl, { ean, label, limit = 2 } = {}) {
  const clean = stripNoise(html);
  const wanted = new Set([...tokenize(label), ...(ean ? [String(ean)] : [])]);
  // les tokens tres discriminants pour le TCG (op17, dp12, display, blister...)
  const strong = new Set(
    [...wanted].filter((t) => SET_CODE.test(t) || /^(\d{8,14}|display|blister|booster|double|pack|set)$/.test(t)),
  );
  // les jetons vraiment identifiants : EAN et code d'extension
  const keys = new Set([
    ...[...wanted].filter((t) => SET_CODE.test(t)),
    ...(ean ? [String(ean)] : []),
  ]);
  const wantedFranchise = franchiseOf(label);
  const wantedForms = detectForms(label);

  const seen = new Map();
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(clean)) !== null && guard++ < 600) {
    const href = m[1];
    if (BAD_LINK.test(href)) continue;
    const abs = absolutize(href, baseUrl);
    if (!abs) continue;
    // le lien vers la page courante, vers l'accueil ou vers un autre rayon
    if (abs.split('#')[0] === baseUrl.split('#')[0]) continue;
    if (isListingUrl(abs)) continue;
    let host;
    try { host = new URL(abs).host; } catch { continue; }
    if (host !== new URL(baseUrl).host) continue;

    const anchorText = m[2].replace(/<[^>]+>/g, ' ');
    const hay = new Set(tokenize(`${abs} ${anchorText}`));
    const hayStr = `${abs} ${anchorText}`.toLowerCase();

    // Un produit d'un autre univers est ecarte d'emblee. Sans ce garde-fou,
    // une recherche « blister booster One Piece » remontait un booster Pokemon.
    const linkFranchise = franchiseOf(hayStr);
    if (linkFranchise && wantedFranchise && linkFranchise !== wantedFranchise) continue;
    if (linkFranchise && !wantedFranchise) continue;

    // Un display OP-17 n'est pas un blister OP-17, meme si les deux portent le
    // meme code d'extension. Quand les deux cotes annoncent un format et qu'ils
    // ne se recoupent pas, ce n'est pas le bon article.
    if (wantedForms.size) {
      const linkForms = detectForms(hayStr);
      if (linkForms.size && ![...wantedForms].some((f) => linkForms.has(f))) continue;
    }

    // Exigence principale : le lien doit porter l'EAN ou le code d'extension.
    // C'est ce qui distingue « le blister OP-10 » de « un blister quelconque ».
    if (keys.size) {
      const hit = [...keys].some((k) => hay.has(k) || hayStr.includes(k));
      if (!hit) continue;
    }

    let score = 0;
    for (const t of wanted) if (hay.has(t)) score += strong.has(t) ? 3 : 1;
    if (ean && abs.includes(String(ean))) score += 8;
    if (/\/(produit|product|p|article|fiche)\//i.test(abs) || /\.html?$/i.test(abs)) score += 2;
    // sans cle discriminante disponible, on exige une correspondance nette
    if (score <= (keys.size ? 2 : 5)) continue;

    const prev = seen.get(abs);
    if (!prev || prev.score < score) seen.set(abs, { url: abs, score, text: anchorText.trim().slice(0, 120) });
  }

  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
