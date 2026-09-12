// Test de l'extracteur contre de vraies pages produit.
//   node test/extract.test.mjs
// Sert a verifier que la lecture prix/stock marche sur les boutiques reelles
// avant de deployer, et a re-tester quand un site change son HTML.

import { fetchPage, extractOffer, findProductLinks, parsePrice } from '../src/extract.js';

// --- 1) tests unitaires du parsing de prix (hors reseau) --------------------
const priceCases = [
  ['12,99 €', 12.99], ['1 299,90 €', 1299.9], ['€143.99', 143.99],
  ['1,299.90', 1299.9], ['5.99', 5.99], ['269,90', 269.9],
  ['139', 139], ['', null], [null, null], ['gratuit', null],
];
let unitFails = 0;
for (const [input, expected] of priceCases) {
  const got = parsePrice(input);
  const ok = got === expected;
  if (!ok) unitFails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  parsePrice(${JSON.stringify(input)}) = ${got} (attendu ${expected})`);
}
console.log(`\nparsePrice : ${priceCases.length - unitFails}/${priceCases.length}\n`);

// --- 2) pages produit reelles ---------------------------------------------
const PRODUCT_PAGES = [
  ['Pokezenith — display OP-17', 'https://www.pokezenith.com/op17-the-worlds-strongest-warriors/455-one-piece-display-de-24-boosters-op17-les-guerriers-les-plus-puissants-au-monde-4582770058710.html'],
  ['Otakuland — blister OP-17', 'https://otakuland-mangapassion.com/2252803-One-Piece-Card-Game-Pack-de-Booster-Blister-OP-17-Les-Guerriers-les-plus-puissants-au-monde-FR'],
  ['PixelHeart — display OP-17', 'https://www.pixelheart.eu/fr/produit/one-piece-card-game-boite-de-boosters-francais-display-op17-les-plus-puissants-des-guerriers/'],
  ['Micromania — display OP-17', 'https://www.micromania.fr/p/display-one-piece-op17-163491.html'],
];

console.log('--- pages produit ---');
for (const [name, url] of PRODUCT_PAGES) {
  const page = await fetchPage(url);
  if (!page.ok) { console.log(`SKIP  ${name} — HTTP ${page.status} ${page.error || ''}`); continue; }
  const o = extractOffer(page.html);
  console.log(`      ${name}\n        prix=${o.price} ${o.currency} | statut=${o.status} | confiance=${o.confidence}`);
}

// --- 3) pages de recherche : trouve-t-on la fiche produit ? ----------------
const SEARCHES = [
  ['Pokezenith', 'https://www.pokezenith.com/recherche?controller=search&s={q}'],
  ['Otakuland', 'https://otakuland-mangapassion.com/recherche?controller=search&s={q}'],
  ['Philibert', 'https://www.philibertnet.com/fr/recherche?controller=search&s={q}'],
];
const EAN = '4582770058710';
const LABEL = 'One Piece Card Game OP-17 display 24 boosters FR';

console.log('\n--- recherche -> fiche produit ---');
for (const [name, tpl] of SEARCHES) {
  const url = tpl.replace('{q}', encodeURIComponent(EAN));
  const page = await fetchPage(url);
  if (!page.ok) { console.log(`SKIP  ${name} — HTTP ${page.status}`); continue; }
  const links = findProductLinks(page.html, page.url, { ean: EAN, label: LABEL, limit: 2 });
  console.log(`      ${name} — ${links.length} lien(s)`);
  for (const l of links) console.log(`        [${l.score}] ${l.url.slice(0, 110)}`);
}
