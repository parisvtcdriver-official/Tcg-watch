// ---------------------------------------------------------------------------
// migrate-from-cloudflare.mjs — reprend la liste de veille de Philippe
// (produits + boutiques deja configures et corriges sur la version
// Cloudflare) et la seme dans la nouvelle base Turso. L'historique
// (observations, alertes, cache d'URL) n'est PAS repris : il n'a de valeur
// que pour diagnostiquer un bug passe, la nouvelle app va le reconstruire
// tout de suite au premier scan.
//
// Usage : TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-from-cloudflare.mjs
// ---------------------------------------------------------------------------

import { getDb } from '../src/db.js';

// Extrait le 2026-09-12 depuis la base D1 de production (tcg-watch, Cloudflare).
const PRODUCTS = [
  { label: 'Blister booster OP-17 (illustration aléatoire)', ean: '4582770058727', query: 'One Piece Card Game OP-17 blister booster FR', price_min: 5, price_max: 8, price_deal: 6.99, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 1, notes: 'Prix conseillé ~5,99 €. Version française uniquement.' },
  { label: 'Double Pack Set 12 (DP-12) — OP17BDPFR', ean: '4582770058741', query: 'One Piece Card Game Double Pack Set 12 Duo DP-12 FR EN', price_min: 10, price_max: 15, price_deal: 11.99, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 1, notes: 'Réf. OP17BDPFR. Prix conseillé ~12,99 €.' },
  { label: 'Display 24 boosters OP-17', ean: '4582770058710', query: 'One Piece Card Game OP-17 display boîte 24 boosters FR EN', price_min: 99, price_max: 250, price_deal: 140, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 1, notes: 'Prix conseillé ~139,99 € (Micromania). Part vite : cooldown court.' },
  { label: 'Double Pack OP18', ean: '810199506692', query: 'One Piece card game OP18 Booster Double Pack', price_min: 8, price_max: 15, price_deal: 10, email: 'parisvtcdriver@gmail.com', active: 0, cooldown_hours: 12, notes: null },
  { label: 'Display OP18 EN', ean: '810199503790', query: 'Booster Box Display OP-18 (24 packs) English', price_min: 100, price_max: 200, price_deal: 120, email: 'parisvtcdriver@gmail.com', active: 0, cooldown_hours: 12, notes: null },
  { label: 'Display OP18 FR', ean: '4582770067439', query: 'One Piece OP-18 display 24 boosters FR Op18', price_min: 90, price_max: 200, price_deal: 120, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 12, notes: null },
  { label: 'Blister Booster OP10 One Piece FR', ean: '4582769796340', query: 'Blister Booster OP10 One Piece Fr', price_min: 4, price_max: 9, price_deal: 5.99, email: 'parisvtcdriver@gmail.com', active: 0, cooldown_hours: 1, notes: null },
  { label: 'Deck ST32 Zoro EN', ean: '0810199500959', query: null, price_min: 10, price_max: 20, price_deal: 14, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 12, notes: null },
  { label: 'ETB Poke 30ans FR', ean: '0196214144835', query: 'Coffret dresseur d’ Elite pokemon ETB FR', price_min: 49, price_max: 99, price_deal: 59, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 12, notes: null },
  { label: 'Deck ST32 Zoro FR', ean: '2100001380762', query: null, price_min: 10, price_max: 20, price_deal: 14, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 12, notes: null },
  { label: 'Pokebox', ean: '2100001398187', query: 'Boîte Méga Puissances – Méga-Zeraora-ex', price_min: 18, price_max: 39, price_deal: 25, email: 'parisvtcdriver@gmail.com', active: 1, cooldown_hours: 12, notes: null },
];

const MERCHANTS = [
  { name: 'Micromania', domain: 'micromania.fr', search_url: 'https://www.micromania.fr/search?q={q}', enabled: 1, priority: 1 },
  { name: 'Cultura', domain: 'cultura.com', search_url: 'https://www.cultura.com/recherche?controller=search&s={q}', enabled: 1, priority: 1 },
  { name: 'Fnac', domain: 'fnac.com', search_url: 'https://www.fnac.com/SearchResult/ResultList.aspx?Search={q}', enabled: 1, priority: 1 },
  { name: 'Amazon.fr', domain: 'amazon.fr', search_url: 'https://www.amazon.fr/{q}', enabled: 1, priority: 1 },
  { name: 'King Jouet', domain: 'king-jouet.com', search_url: 'https://www.king-jouet.com/recherche.htm?text={q}', enabled: 1, priority: 2 },
  { name: 'JouéClub', domain: 'joueclub.fr', search_url: 'https://www.joueclub.fr/catalogsearch/result/?q={q}', enabled: 1, priority: 2 },
  { name: 'Espace Culturel Leclerc', domain: 'e.leclerc', search_url: 'https://www.e.leclerc/fp/{q}', enabled: 1, priority: 2 },
  { name: 'Philibert', domain: 'philibertnet.com', search_url: 'https://www.philibertnet.com/fr/recherche?search_query={q}', enabled: 1, priority: 2 },
  { name: 'Smythstoys', domain: 'smythstoys.com', search_url: 'https://www.smythstoys.com/fr{q}', enabled: 0, priority: 2 },
  { name: 'Maison de la Presse', domain: 'maisondelapresse.com', search_url: 'https://www.maisondelapresse.com/catalogsearch/result/?q={q}', enabled: 1, priority: 2 },
  { name: 'Pikastore', domain: 'pikastore.fr', search_url: 'https://www.pikastore.fr/recherche?controller=search&s={q}', enabled: 1, priority: 2 },
  { name: 'Outpost', domain: 'outpostbrussels.be', search_url: 'https://outpostbrussels.be/{q}', enabled: 0, priority: 2 },
  { name: 'Play-in', domain: 'play-in.com', search_url: 'https://www.play-in.com/recherche/index/?q={q}', enabled: 1, priority: 3 },
  { name: 'UltraJeux', domain: 'ultrajeux.com', search_url: 'https://www.ultrajeux.com/search3.php?submit=1&text={q}', enabled: 1, priority: 3 },
  { name: 'Pokezenith', domain: 'pokezenith.com', search_url: 'https://www.pokezenith.com/recherche?controller=search&s={q}', enabled: 1, priority: 3 },
  { name: 'PixelHeart', domain: 'pixelheart.eu', search_url: 'https://www.pixelheart.eu/fr/?s={q}', enabled: 1, priority: 4 },
  { name: "L'Antre de Po", domain: 'lantredepo.com', search_url: 'https://lantredepo.com/?s={q}&post_type=product', enabled: 1, priority: 4 },
  { name: 'Koala Games', domain: 'koalagames.shop', search_url: 'https://www.koalagames.shop/search?q={q}', enabled: 1, priority: 4 },
  { name: 'Buy The Game', domain: 'buy-the-game.fr', search_url: 'https://buy-the-game.fr/?s={q}&post_type=product', enabled: 1, priority: 4 },
  { name: 'Les Gentlemen du Jeu', domain: 'lesgentlemendujeu.com', search_url: 'https://lesgentlemendujeu.com/recherche?controller=search&s={q}', enabled: 1, priority: 4 },
  { name: 'Otakuland', domain: 'otakuland-mangapassion.com', search_url: 'https://otakuland-mangapassion.com/recherche?controller=search&s={q}', enabled: 1, priority: 4 },
  { name: 'Fantasy Sphere', domain: 'fantasysphere.net', search_url: 'https://fantasysphere.net/recherche?controller=search&s={q}', enabled: 1, priority: 5 },
  { name: 'Playshop', domain: 'playshop.fr', search_url: 'https://playshop.fr/search?q={q}', enabled: 1, priority: 5 },
  { name: 'Hamacards', domain: 'hamacards.com', search_url: 'https://www.hamacards.com/?s={q}&post_type=product', enabled: 1, priority: 5 },
  { name: 'Guizette Family', domain: 'guizettefamily.com', search_url: 'https://www.guizettefamily.com/categorie/one-piece/{q}', enabled: 1, priority: 5 },
  { name: 'DestockTCG', domain: 'destocktcg.fr', search_url: 'https://destocktcg.fr/recherche?controller=search&s={q}', enabled: 1, priority: 5 },
  { name: 'Auchan', domain: 'auchan.fr', search_url: 'https://www.auchan.fr/{q}', enabled: 0, priority: 5 },
  { name: 'Carrefour', domain: 'carrefour.fr', search_url: 'https://www.carrefour.fr/{q}', enabled: 0, priority: 5 },
  { name: 'CardMarket', domain: 'cardmarket.com', search_url: 'https://www.cardmarket.com/fr/OnePiece{q}', enabled: 0, priority: 5 },
];

async function main() {
  const db = getDb(process.env);

  let np = 0;
  for (const p of PRODUCTS) {
    const res = await db
      .prepare(
        'INSERT INTO products (label, ean, query, price_min, price_max, price_deal, email, active, cooldown_hours, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(p.label, p.ean, p.query, p.price_min, p.price_max, p.price_deal, p.email, p.active, p.cooldown_hours, p.notes)
      .run();
    if (res.meta.changes) np++;
  }

  let nm = 0;
  for (const m of MERCHANTS) {
    const res = await db
      .prepare('INSERT OR IGNORE INTO merchants (name, domain, search_url, enabled, priority) VALUES (?,?,?,?,?)')
      .bind(m.name, m.domain, m.search_url, m.enabled, m.priority)
      .run();
    if (res.meta.changes) nm++;
  }

  console.log(`${np}/${PRODUCTS.length} produits repris, ${nm}/${MERCHANTS.length} boutiques reprises.`);
}

main().catch((err) => {
  console.error('migration echouee :', err.message || err);
  process.exit(1);
});
