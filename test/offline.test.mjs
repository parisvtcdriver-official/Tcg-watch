// Tests hors-ligne de l'extracteur, sur des pages HTML representatives des
// 4 moteurs e-commerce qui couvrent la quasi-totalite des boutiques FR.
//   node test/offline.test.mjs

import { extractOffer, findProductLinks, parsePrice, confirmProduct, isListingUrl } from '../src/extract.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`}`);
}
const offer = (html) => { const o = extractOffer(html); return { price: o.price, status: o.status, confidence: o.confidence }; };

// ---------------------------------------------------------------------------
console.log('--- parsePrice ---');
for (const [i, e] of [['12,99 €', 12.99], ['1 299,90 €', 1299.9], ['€143.99', 143.99],
  ['1,299.90', 1299.9], ['5.99', 5.99], ['269,90', 269.9], ['139', 139],
  ['', null], [null, null], ['gratuit', null], ['0,00 €', null]]) {
  check(`parsePrice(${JSON.stringify(i)})`, parsePrice(i), e);
}

// ---------------------------------------------------------------------------
console.log('\n--- JSON-LD (PrestaShop / Shopify / WooCommerce) ---');

const prestashop = `<html><head><title>Display OP-17</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"Display 24 boosters OP17","gtin13":"4582770058710",
"offers":{"@type":"Offer","price":"143.99","priceCurrency":"EUR",
"availability":"https://schema.org/OutOfStock"}}</script></head>
<body><h1>Display OP17</h1><p>Rupture de stock</p></body></html>`;
check('PrestaShop en rupture', offer(prestashop), { price: 143.99, status: 'oos', confidence: 'high' });

const shopify = `<html><head>
<script type="application/ld+json">[{"@type":"BreadcrumbList","itemListElement":[]},
{"@context":"http://schema.org","@type":"Product","name":"Blister OP-17",
"offers":[{"@type":"Offer","price":5.99,"priceCurrency":"EUR","availability":"http://schema.org/InStock"}]}]</script>
</head><body><button>Ajouter au panier</button></body></html>`;
check('Shopify en stock', offer(shopify), { price: 5.99, status: 'in_stock', confidence: 'high' });

const woo = `<html><head><script type="application/ld+json">
{"@context":"https://schema.org/","@graph":[{"@type":"WebSite"},
{"@type":"Product","name":"Double Pack DP-12","offers":{"@type":"AggregateOffer",
"lowPrice":"12.90","highPrice":"14.90","priceCurrency":"EUR","offerCount":3,
"availability":"https://schema.org/InStock"}}]}</script></head><body></body></html>`;
check('WooCommerce @graph + AggregateOffer', offer(woo), { price: 12.9, status: 'in_stock', confidence: 'high' });

const preorder = `<html><head><script type="application/ld+json">{"@type":"Product",
"offers":{"@type":"Offer","price":"269.90","priceCurrency":"EUR",
"availability":"https://schema.org/PreOrder"}}</script></head>
<body>Précommande — date d'arrivée 30 septembre</body></html>`;
check('précommande détectée (jamais une alerte)', offer(preorder), { price: 269.9, status: 'preorder', confidence: 'high' });

const brokenLd = `<html><head><script type="application/ld+json">
{"@type":"Product","offers":{"@type":"Offer","price":"7.50","availability":"InStock"}},</script>
</head><body>En stock</body></html>`;
check('JSON-LD mal formé -> récupéré', offer(brokenLd), { price: 7.5, status: 'in_stock', confidence: 'high' });

// ---------------------------------------------------------------------------
console.log('\n--- meta OpenGraph / microdata ---');

const og = `<html><head>
<meta property="product:price:amount" content="139.99">
<meta property="product:price:currency" content="EUR">
<meta property="product:availability" content="in stock">
</head><body></body></html>`;
check('OpenGraph', offer(og), { price: 139.99, status: 'in_stock', confidence: 'high' });

const micro = `<html><body><div itemscope itemtype="http://schema.org/Product">
<meta itemprop="price" content="11.90">
<link itemprop="availability" href="http://schema.org/OutOfStock">
</div></body></html>`;
check('microdata', offer(micro), { price: 11.9, status: 'oos', confidence: 'high' });

// ---------------------------------------------------------------------------
console.log('\n--- repli texte (aucune donnée structurée) ---');

const textOos = `<html><body><h1>Display OP17</h1>
<div class="price">159,90 €</div><div class="price">159,90 €</div>
<span class="stock">Rupture de stock</span>
<button disabled>Ajouter au panier</button></body></html>`;
check('texte : rupture prime sur le bouton panier', offer(textOos), { price: 159.9, status: 'oos', confidence: 'low' });

const textIn = `<html><body><div class="prix">6,49 €</div><div class="prix-total">6,49 €</div>
<button class="add">Ajouter au panier</button><p>Expédié sous 24h</p></body></html>`;
check('texte : en stock', offer(textIn), { price: 6.49, status: 'in_stock', confidence: 'low' });

const noisyScript = `<html><head><script>var msg="Rupture de stock";</script></head>
<body><div>8,99 €</div><div>8,99 €</div><button>Ajouter au panier</button></body></html>`;
check('le JS de la page ne fausse pas le statut', offer(noisyScript), { price: 8.99, status: 'in_stock', confidence: 'low' });

// ---------------------------------------------------------------------------
console.log('\n--- page de résultats -> fiche produit ---');

const results = `<html><body>
<a href="/panier">Mon panier</a>
<a href="/blog/one-piece-op17-actu">Actu OP17</a>
<a href="/produit/display-op17-24-boosters-4582770058710.html">Display 24 boosters OP-17 FR</a>
<a href="/produit/blister-op17-fr.html">Blister OP-17</a>
</body></html>`;
const links = findProductLinks(results, 'https://boutique.fr/recherche?s=4582770058710', {
  ean: '4582770058710', label: 'One Piece OP-17 display 24 boosters FR', limit: 2,
});
check('le bon lien produit sort en premier',
  links[0]?.url, 'https://boutique.fr/produit/display-op17-24-boosters-4582770058710.html');
check('le panier et le blog sont écartés',
  links.every((l) => !/panier|blog/.test(l.url)), true);

const external = `<html><body><a href="https://autre-site.fr/produit/display-op17-4582770058710">Display OP17</a></body></html>`;
check('les liens hors domaine sont ignorés',
  findProductLinks(external, 'https://boutique.fr/recherche', { ean: '4582770058710', label: 'display op17' }).length, 0);

// ---------------------------------------------------------------------------
console.log('\n--- regressions relevees en production ---');

// Maison de la Presse : page de 656 Ko dont le JSON-LD Product est a la toute
// fin (octet 655 104). L'ancien plafond de 400 Ko le coupait, et le repli
// texte attrapait le mot « Precommandes » du menu Livres du site.
const gros = `<html><head><meta property="product:price:amount" content="5.99"/></head><body>
<nav><ul><li>Nouveautes</li><li>Precommandes Livres</li><li>Reprise Livres</li></ul></nav>
<h1>Blister Booster OP10 One Piece</h1>
${'<div class="filler">rayon papeterie cadeaux jeux</div>'.repeat(9000)}
<div class="achat"><span>En stock</span><span>5,99 €</span><button>Ajouter au panier</button></div>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product",
"name":"Blister Booster OP10 One Piece","offers":{"@type":"Offer","price":5.99,
"priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>
</body></html>`;
check(`la page fait bien plus de 400 Ko (${Math.round(gros.length / 1024)} Ko)`, gros.length > 420000, true);
check('JSON-LD de fin de page : lu au lieu d etre tronque', offer(gros), { price: 5.99, status: 'in_stock', confidence: 'high' });

// meme page, sans donnees structurees : le repli texte ne doit pas lire le menu
const sansLd = gros.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<meta[^>]*>/gi, '');
check('sans JSON-LD, le menu « Precommandes » ne decide plus du statut',
  offer(sansLd), { price: 5.99, status: 'in_stock', confidence: 'low' });

// une vraie precommande doit toujours etre vue comme telle
const vraiePre = `<html><body><nav>Nouveautes</nav>
<div class="achat"><span>269,90 €</span><span>Precommande — sortie le 30 septembre</span></div></body></html>`;
check('une precommande annoncee dans le bloc d achat reste une precommande',
  offer(vraiePre).status, 'preorder');

// Koala Games renvoyait un booster Pokemon McDonald's pour une recherche One Piece
const melange = `<html><body>
<a href="/products/booster-pokemon-promo-pikachu-mcdonald-s-japon-2025">Booster Pokemon Pikachu McDonald's</a>
<a href="/fr/15860-one-piece-le-jeu-de-cartes">One Piece le jeu de cartes</a>
<a href="/produit/blister-booster-op10-one-piece.html">Blister Booster OP10 One Piece FR</a>
</body></html>`;
const tri = findProductLinks(melange, 'https://boutique.fr/recherche', {
  ean: '4582769796340', label: 'Blister Booster OP10 One Piece FR', limit: 5,
});
check('un produit Pokemon est ecarte d une recherche One Piece',
  tri.every((l) => !/pokemon/i.test(l.url)), true);
check('une page de categorie sans code d extension est ecartee',
  tri.every((l) => !l.url.includes('15860-one-piece')), true);
check('seul le blister OP10 est retenu', tri.length === 1 && tri[0].url.includes('blister-booster-op10'), true);

// « OP-10 », « op 10 » et « op10 » doivent se valoir
const tiret = findProductLinks(
  `<html><body><a href="/produit/one-piece-blister-sang-royal-op-10.html">Blister Sang Royal OP-10</a></body></html>`,
  'https://boutique.fr/recherche', { ean: null, label: 'Blister Booster OP10 One Piece FR' });
check('le code ecrit « OP-10 » est reconnu comme op10', tiret.length === 1, true);

// Le code d'extension ne suffit pas : dans OP-17 il y a un blister a 6 € et un
// display a 140 €. Sans distinction de format, le blister heritait du prix du
// display (121,50 € chez Philibert, 249,99 € chez Koala Games).
const rayon = `<html><body>
<a href="/produit/one-piece-display-de-24-boosters-op17.html">Display 24 boosters OP17 FR</a>
<a href="/produit/one-piece-blister-booster-op17.html">Blister Booster OP17 FR</a>
<a href="/produit/one-piece-double-pack-set-12-op17.html">Double Pack Set 12 OP17</a>
<a href="/produit/one-piece-starter-deck-st21.html">Starter Deck ST-21</a>
</body></html>`;
const formeAttendue = (label) =>
  findProductLinks(rayon, 'https://boutique.fr/recherche', { ean: null, label, limit: 5 })
    .map((l) => l.url.split('/').pop());

check('un blister ne remonte que le blister',
  formeAttendue('Blister booster OP-17 (illustration aléatoire)'), ['one-piece-blister-booster-op17.html']);
check('un display ne remonte que le display',
  formeAttendue('Display 24 boosters OP-17'), ['one-piece-display-de-24-boosters-op17.html']);
check('un double pack ne remonte que le double pack',
  formeAttendue('Double Pack Set 12 (DP-12) OP-17'), ['one-piece-double-pack-set-12-op17.html']);
check('« boîte de 24 boosters » est reconnu comme un display',
  formeAttendue('One Piece OP-17 boîte de 24 boosters'), ['one-piece-display-de-24-boosters-op17.html']);

// ---------------------------------------------------------------------------
console.log('\n--- confirmation : est-on sur LA bonne fiche ? ---');

// Le symptome qui a mis la puce a l oreille : le meme prix chez un marchand
// pour deux produits sans rapport (Philibert 121,50 € pour un blister ET pour
// un deck ST-35). Signe qu on lisait une page de rayon, pas une fiche.
const pageRayon = `<html><head><title>Cartes One Piece — Philibert</title></head>
<body><h1>One Piece, le jeu de cartes</h1>
<script type="application/ld+json">{"@type":"Product","name":"Deck ST-21 Zoro","offers":{"@type":"Offer","price":"121.50"}}</script>
<script type="application/ld+json">{"@type":"Product","name":"Display OP-17","offers":{"@type":"Offer","price":"249.99"}}</script>
<script type="application/ld+json">{"@type":"Product","name":"Blister OP-16","offers":{"@type":"Offer","price":"6.90"}}</script>
</body></html>`;
const fiche = `<html><head><title>Blister Booster OP-17 One Piece — Version française</title></head>
<body><h1>Blister Booster OP-17</h1>
<script type="application/ld+json">{"@type":"Product","name":"Blister Booster OP-17","gtin13":"4582770058727",
"offers":{"@type":"Offer","price":"5.99","availability":"https://schema.org/InStock"}}</script>
</body></html>`;
const idBlister = { ean: '4582770058727', label: 'Blister booster OP-17 (illustration aléatoire)' };

check('une page de rayon est refusée',
  confirmProduct(pageRayon, 'https://philibertnet.com/fr/15860-one-piece', idBlister).ok, false);
check('la vraie fiche produit est acceptée',
  confirmProduct(fiche, 'https://boutique.fr/produit/blister-op17.html', idBlister).ok, true);
check('une fiche du bon format mais du mauvais article est refusée',
  confirmProduct(
    `<html><head><title>Display 24 boosters OP-17</title></head><body><h1>Display OP-17</h1></body></html>`,
    'https://boutique.fr/produit/display-op17.html', idBlister).ok, false);
check('l EAN seul suffit à confirmer, même sans titre explicite',
  confirmProduct(`<html><head><title>Article 4582770058727</title></head><body>4582770058727</body></html>`,
    'https://boutique.fr/p/12345', idBlister).ok, true);

// sur une page de rayon, extractOffer doit choisir le noeud portant l EAN
const rayonAvecEan = pageRayon.replace('"name":"Blister OP-16"', '"name":"Blister OP-17","gtin13":"4582770058727"');
check('parmi plusieurs produits, celui qui porte l EAN est retenu',
  extractOffer(rayonAvecEan, { ean: '4582770058727' }).price, 6.9);

// ---------------------------------------------------------------------------
console.log('\n--- adresses de rayon : refus structurel ---');

// Les URL reellement enregistrees par le scanner en production. Chacune a
// fourni un prix valide appartenant a un autre article : 349,99 € pour un
// Double Pack a 13 €, 11,50 € lus sur la page d accueil de Philibert.
for (const u of [
  'https://www.koalagames.shop/search?q=One+Piece+Card+Game+Double+Pack+Set+12',
  'https://www.philibertnet.com/fr/',
  'https://lantredepo.com/?s=op17&post_type=product',
  'https://www.pokezenith.com/recherche?controller=search&s=4582770058710',
  'https://www.micromania.fr/c/cartes-one-piece-op17',
]) check(`refusé : ${u.slice(8, 52)}…`, isListingUrl(u), true);

// et les vraies fiches produit doivent passer
for (const u of [
  'https://www.pikastore.fr/one-piece/39916--en-one-piece-starter-deck-st-35-sabo.html',
  'https://lantredepo.com/one-piece-card-game-op-17-display-de-24-boosters-fr/',
  'https://www.maisondelapresse.com/blister-booster-op10-one-piece.html',
]) check(`accepté : ${u.slice(8, 52)}…`, isListingUrl(u), false);

// même avec un contenu impeccable, une adresse de recherche est refusée
const grilleParfaite = `<html><head><title>Blister Booster OP-17</title></head><body>
<h1>Blister Booster OP-17</h1>4582770058727
<script type="application/ld+json">{"@type":"Product","name":"Blister Booster OP-17","gtin13":"4582770058727",
"offers":{"@type":"Offer","price":"5.99","availability":"https://schema.org/InStock"}}</script></body></html>`;
check('le contenu ne rattrape pas une adresse de recherche',
  confirmProduct(grilleParfaite, 'https://www.koalagames.shop/search?q=OP-17', idBlister).ok, false);
check('la même page à une vraie adresse est acceptée',
  confirmProduct(grilleParfaite, 'https://www.koalagames.shop/products/blister-op17', idBlister).ok, true);

// la page de résultats ne doit jamais se proposer elle-même comme fiche
const auto = `<html><body>
<a href="/search?q=op17">Voir tous les résultats OP-17</a>
<a href="/">Accueil</a>
<a href="/products/blister-booster-op17-fr">Blister Booster OP-17 FR</a>
</body></html>`;
const propres = findProductLinks(auto, 'https://boutique.fr/search?q=op17', {
  ean: null, label: 'Blister booster OP-17', limit: 5,
});
check('un seul lien retenu, la vraie fiche',
  propres.map((l) => l.url), ['https://boutique.fr/products/blister-booster-op17-fr']);

// ---------------------------------------------------------------------------
console.log('\n--- plusieurs univers chez la même boutique ---');

const multiJeux = `<html><body>
<a href="/products/display-pokemon-ev08-fr">Display Pokémon EV08 FR</a>
<a href="/products/display-one-piece-op17-fr">Display One Piece OP-17 FR</a>
<a href="/products/display-yu-gi-oh-2026">Display Yu-Gi-Oh 2026</a>
</body></html>`;
const cherche = (label) =>
  findProductLinks(multiJeux, 'https://boutique.fr/search?q=x', { ean: null, label, limit: 5 })
    .map((l) => l.url.split('/').pop());

// « Pokémon » accentué ne correspondait pas à « pokemon » : toutes les
// recherches Pokémon écrites en français correct ne trouvaient rien.
check('« Pokémon » accentué trouve le produit Pokémon',
  cherche('Pokémon EV08 display 36 boosters FR'), ['display-pokemon-ev08-fr']);
check('« Pokemon » sans accent donne le même résultat',
  cherche('Pokemon EV08 display 36 boosters FR'), ['display-pokemon-ev08-fr']);
check('One Piece ne remonte que du One Piece',
  cherche('One Piece OP-17 display 24 boosters FR'), ['display-one-piece-op17-fr']);
check('le filtre marche aussi pour Yu-Gi-Oh',
  cherche('Yu-Gi-Oh display 2026'), ['display-yu-gi-oh-2026']);

// ---------------------------------------------------------------------------
console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
