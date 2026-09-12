// ---------------------------------------------------------------------------
// scan.js — le moteur de veille.
//
// Les fonctions planifiees Netlify (toutes les plateformes, plan gratuit
// compris) ont une limite de 30 secondes — pas de mode « arriere-plan »
// garanti pour un cron sur toutes les configurations. On garde donc la
// meme strategie que sur Cloudflare : un LOT de couples (produit x
// marchand) par passage, puis un curseur en base qui avance ; le tour
// complet se fait sur plusieurs passages du cron. La seule difference :
// le budget qui limite un lot est desormais un budget de TEMPS (avant,
// c'etait un nombre de sous-requetes, specifique a Cloudflare).
// ---------------------------------------------------------------------------

import { fetchPage, extractOffer, findProductLinks, confirmProduct } from './extract.js';
import { renderAlertEmail, sendEmail } from './mail.js';
import { pushToAll } from './push.js';

// Marge de securite sous la limite reelle de 30s des fonctions planifiees
// Netlify : on s'arrete avant, plutot que de se faire couper au milieu
// d'un envoi de mail ou d'une ecriture en base.
const TIME_BUDGET_MS = 22_000;
const CONCURRENCY = 6;

// --- petit pool de concurrence --------------------------------------------
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        results[idx] = { status: 'error', error: String(err?.message || err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

// --- etat (curseur de rotation) -------------------------------------------
async function getState(db, key, fallback = null) {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
  return row?.value ?? fallback;
}
async function setState(db, key, value) {
  await db
    .prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, String(value))
    .run();
}

// --- verification d'un couple produit x marchand ---------------------------

/**
 * Renvoie { status, price, currency, confidence, url }
 * status : in_stock | preorder | oos | not_found | error
 */
async function checkPair(env, product, merchant, link, budget) {
  const spend = () => {
    if (Date.now() >= budget.deadline) throw new Error('budget de temps epuise');
  };

  const ident = { ean: product.ean, label: product.query || product.label };

  // 1. URL produit deja connue -> on va droit au but
  if (link?.url) {
    spend();
    const page = await fetchPage(link.url);
    if (page.ok) {
      const offer = extractOffer(page.html, { ean: product.ean });
      // une URL saisie a la main fait foi ; une URL devinee doit se confirmer
      const ok = link.pinned || confirmProduct(page.html, page.url, ident).ok;
      if (ok && (offer.price != null || offer.status !== 'unknown')) {
        return { ...offer, url: page.url, resolvedUrl: page.url };
      }
    }
    // la page ne repond plus / a change : on retombe sur la recherche,
    // sauf si l'URL a ete saisie a la main (pinned).
    if (link.pinned) {
      return { status: page.ok ? 'unknown' : 'not_found', price: null, currency: 'EUR', confidence: 'none', url: link.url };
    }
  }

  // 2. recherche : EAN d'abord (tres discriminant), puis le nom du produit
  if (!merchant.search_url) {
    return { status: 'not_found', price: null, currency: 'EUR', confidence: 'none', url: null };
  }

  let lastReject = null;
  const queries = [product.ean, product.query || product.label].filter(Boolean);
  for (const q of queries) {
    if (Date.now() >= budget.deadline) break;
    const searchUrl = merchant.search_url.replace('{q}', encodeURIComponent(q));
    spend();
    const results = await fetchPage(searchUrl);
    if (!results.ok) continue;

    // certaines boutiques redirigent directement vers la fiche produit
    const direct = extractOffer(results.html, { ean: product.ean });
    const looksLikeProduct = direct.price != null && direct.status !== 'unknown';

    if (looksLikeProduct && results.url !== searchUrl
        && confirmProduct(results.html, results.url, ident).ok) {
      return { ...direct, url: results.url, resolvedUrl: results.url };
    }

    const links = findProductLinks(results.html, results.url, {
      ean: product.ean,
      label: product.query || product.label,
      limit: 1,
    });
    if (!links.length) continue;

    spend();
    const page = await fetchPage(links[0].url);
    if (!page.ok) continue;

    // Verification decisive : la page trouvee parle-t-elle bien de CE produit ?
    // Sans elle, une page de rayon fournit un prix parfaitement valide mais
    // qui appartient a un autre article.
    const proof = confirmProduct(page.html, page.url, ident);
    if (!proof.ok) { lastReject = proof.why; continue; }

    const offer = extractOffer(page.html, { ean: product.ean });
    if (offer.price != null || offer.status !== 'unknown') {
      return { ...offer, url: page.url, resolvedUrl: page.url };
    }
  }

  return { status: 'not_found', price: null, currency: 'EUR', confidence: 'none', url: null, reject: lastReject };
}

// --- decision d'alerte -----------------------------------------------------

function tierFor(product, price) {
  if (product.price_deal != null && price <= product.price_deal) return 'deal';
  return 'normal';
}

async function shouldAlert(db, product, merchantId, price, tier, status) {
  const last = await db
    .prepare('SELECT price, tier, status, sent_at FROM alerts WHERE product_id = ? AND merchant_id = ? ORDER BY sent_at DESC LIMIT 1')
    .bind(product.id, merchantId)
    .first();
  if (!last) return true;

  const ageHours = (Date.now() - Date.parse(`${last.sent_at.replace(' ', 'T')}Z`)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours >= (product.cooldown_hours ?? 12)) return true;
  // le cooldown ne doit jamais faire rater une meilleure offre
  if (tier === 'deal' && last.tier !== 'deal') return true;
  if (last.price != null && price <= last.price * 0.95) return true;
  // passer de precommande a vrai stock est une info nouvelle, meme au meme prix
  if (status === 'in_stock' && last.status === 'preorder') return true;
  return false;
}

// --- le scan ---------------------------------------------------------------

/**
 * @param {object} env
 * @param {{productId?:number, full?:boolean, dryRun?:boolean}} opts
 */
export async function runScan(env, opts = {}) {
  const db = env.DB;
  const { productId = null, full = false, dryRun = false } = opts;
  const startedAt = Date.now();

  const products = (
    await (productId
      ? db.prepare('SELECT * FROM products WHERE id = ?').bind(productId).all()
      : db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all())
  ).results;

  const merchants = (
    await db.prepare('SELECT * FROM merchants WHERE enabled = 1 ORDER BY priority, id').all()
  ).results;

  if (!products.length || !merchants.length) {
    return { checked: 0, alerts: 0, note: 'aucun produit actif ou aucun marchand actif' };
  }

  // toutes les combinaisons, ordonnees par priorite de marchand
  const allPairs = [];
  for (const m of merchants) for (const p of products) allPairs.push({ product: p, merchant: m });

  const batchSize = Math.max(1, Number(env.BATCH_SIZE || 24));
  let cursor = 0;
  let pairs = allPairs;
  let wrapped = false;

  if (!full && !productId && allPairs.length > batchSize) {
    cursor = Number(await getState(db, 'cursor', '0')) || 0;
    if (cursor >= allPairs.length) cursor = 0;
    pairs = allPairs.slice(cursor, cursor + batchSize);
    const next = cursor + batchSize;
    wrapped = next >= allPairs.length;
    await setState(db, 'cursor', wrapped ? 0 : next);
  }

  // URLs produit deja connues pour ce lot
  const linkRows = (await db.prepare('SELECT product_id, merchant_id, url, pinned FROM links').all()).results;
  const linkMap = new Map(linkRows.map((r) => [`${r.product_id}:${r.merchant_id}`, r]));

  const budget = { deadline: startedAt + TIME_BUDGET_MS };
  const results = await pool(pairs, CONCURRENCY, async ({ product, merchant }) => {
    const link = linkMap.get(`${product.id}:${merchant.id}`);
    const offer = await checkPair(env, product, merchant, link, budget);
    return { product, merchant, offer, link };
  });

  // --- ecriture des observations + memorisation des URLs decouvertes -------
  const writes = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const r of results) {
    if (!r?.product) continue;
    const { product, merchant, offer, link } = r;
    const status = offer.status === 'unknown' ? 'not_found' : offer.status;

    writes.push(
      db
        .prepare(
          'INSERT INTO observations (product_id, merchant_id, price, currency, status, confidence, url, checked_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .bind(product.id, merchant.id, offer.price ?? null, offer.currency || 'EUR', status, offer.confidence || 'none', offer.url ?? null, now),
    );

    // Filet de securite : un prix trois fois au-dessus du plafond signale
    // presque toujours un autre article (un display trouve a la place d'un
    // blister). On ne memorise pas cette URL, sinon elle serait reutilisee
    // a chaque passage.
    const prixAberrant = offer.price != null && offer.price > product.price_max * 3;

    if (offer.resolvedUrl && !link?.pinned && offer.resolvedUrl !== link?.url && !prixAberrant) {
      writes.push(
        db
          .prepare(
            'INSERT INTO links (product_id, merchant_id, url, pinned, updated_at) VALUES (?,?,?,0,?) ' +
              'ON CONFLICT(product_id, merchant_id) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at WHERE links.pinned = 0',
          )
          .bind(product.id, merchant.id, offer.resolvedUrl, now),
      );
    }
  }
  if (writes.length) await db.batch(writes);

  // --- selection des alertes ----------------------------------------------
  const finds = [];
  for (const r of results) {
    if (!r?.product) continue;
    const { product, merchant, offer } = r;
    // en stock ET precommande declenchent une alerte (a la demande de Philippe,
    // le 12/09/2026) ; le mail/push precise toujours lequel des deux c'est.
    if (offer.status !== 'in_stock' && offer.status !== 'preorder') continue;
    if (offer.price == null) continue;
    if (offer.price > product.price_max) continue;         // hors plafond
    if (offer.price < (product.price_min ?? 0)) continue;  // trop beau : parsing rate ou arnaque

    const tier = tierFor(product, offer.price);
    if (!(await shouldAlert(db, product, merchant.id, offer.price, tier, offer.status))) continue;

    finds.push({
      product_id: product.id,
      product_label: product.label,
      merchant_id: merchant.id,
      merchant_name: merchant.name,
      price: offer.price,
      confidence: offer.confidence,
      tier,
      status: offer.status,
      url: offer.url,
      email: product.email,
    });
  }

  // --- envoi : un mail par destinataire, regroupant ses trouvailles --------
  let sent = 0;
  if (finds.length && !dryRun) {
    const byEmail = new Map();
    for (const f of finds) {
      if (!byEmail.has(f.email)) byEmail.set(f.email, []);
      byEmail.get(f.email).push(f);
    }
    for (const [email, group] of byEmail) {
      // en stock avant precommande, puis bonne affaire avant normal, puis prix croissant
      group.sort((a, b) => {
        if (a.status !== b.status) return a.status === 'in_stock' ? -1 : 1;
        if (a.tier !== b.tier) return a.tier === 'deal' ? -1 : 1;
        return a.price - b.price;
      });
      const { subject, html, text } = renderAlertEmail(group, env.APP_URL || null);
      const res = await sendEmail(env, { to: email, subject, html, text });
      if (res.ok) sent += group.length;
      // Sans ceci, un envoi rate est indiscernable en base d'un envoi reussi
      // hormis le 0/1 — impossible de savoir POURQUOI sans deviner. On garde
      // la raison exacte que Resend renvoie (cle absente, domaine non
      // verifie, destinataire refuse, etc.).
      await db.batch(
        group.map((f) =>
          db
            .prepare('INSERT INTO alerts (product_id, merchant_id, price, tier, status, url, emailed, mail_error, sent_at) VALUES (?,?,?,?,?,?,?,?,?)')
            .bind(f.product_id, f.merchant_id, f.price, f.tier, f.status, f.url, res.ok ? 1 : 0, res.ok ? null : String(res.error || 'erreur inconnue'), now),
        ),
      );
    }
  }

  // --- notification push : la meilleure offre du lot, en tete -------------
  let pushed = null;
  if (finds.length && !dryRun && env.VAPID_PRIVATE_JWK) {
    const best = [...finds].sort((a, b) => {
      if (a.status !== b.status) return a.status === 'in_stock' ? -1 : 1;
      return a.tier === b.tier ? a.price - b.price : a.tier === 'deal' ? -1 : 1;
    })[0];
    pushed = await pushToAll(env, {
      n: finds.length,
      t: best.product_label,
      p: best.price,
      m: best.merchant_name,
      u: best.url,
      tier: best.tier,
      status: best.status,
    });
  }

  // --- menage de l'historique (une fois par tour complet) ------------------
  if (wrapped || full) {
    const days = Math.max(7, Number(env.HISTORY_DAYS || 120));
    await db.prepare(`DELETE FROM observations WHERE checked_at < datetime('now', '-${days} days')`).run();
  }

  return {
    checked: pairs.length,
    of: allPairs.length,
    cursor,
    wrapped,
    duration_ms: Date.now() - startedAt,
    alerts: finds.length,
    emailed: sent,
    pushed,
    finds: finds.map((f) => ({ product: f.product_label, merchant: f.merchant_name, price: f.price, tier: f.tier, status: f.status, url: f.url })),
  };
}
