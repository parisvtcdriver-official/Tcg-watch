// ---------------------------------------------------------------------------
// add-op17-en-pokemon30.mjs — ajoute les produits OP-17 version anglaise
// (les versions FR etaient deja correctes, verifiees) et toute la gamme
// Pokemon 30e anniversaire FR. Corrige aussi deux boutiques dont l'adresse
// de recherche avait change (Micromania, Play-in) et en ajoute deux
// nouvelles specialisees TCG.
//
// Usage : TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/add-op17-en-pokemon30.mjs
// ---------------------------------------------------------------------------

import { getDb } from '../src/db.js';

const EMAIL = 'parisvtcdriver@gmail.com';

const NEW_PRODUCTS = [
  // --- OP-17 anglais (les versions FR existent deja et sont correctes) ---
  { label: 'Blister Booster OP-17 EN', ean: null, query: 'One Piece Card Game OP-17 Booster Pack EN blister', price_min: 8, price_max: 20, price_deal: 14, cooldown_hours: 1, notes: 'Pas d\'EAN officiel confirme pour le format blister EN, recherche par nom' },
  { label: 'Double Pack OP-17 EN', ean: '810199502014', query: null, price_min: 10, price_max: 20, price_deal: 14, cooldown_hours: 1, notes: null },
  { label: 'Display 24 boosters OP-17 EN', ean: '810199501970', query: null, price_min: 99, price_max: 250, price_deal: 150, cooldown_hours: 1, notes: 'Prix conseille ~139,99 $' },

  // --- Pokemon 30e anniversaire FR (l'ETB existe deja) ---
  { label: 'Collection Poster 30 ans FR', ean: '0196214147225', query: null, price_min: 10, price_max: 25, price_deal: 17, cooldown_hours: 12, notes: '3 boosters + 3 promos oiseaux legendaires + poster' },
  { label: 'Duopack Évoli 30 ans FR', ean: '0196214152311', query: null, price_min: 8, price_max: 18, price_deal: 12, cooldown_hours: 12, notes: '2 boosters + carte promo Evoli' },
  { label: 'Collection K.O. Évoli 30 ans FR', ean: null, query: 'Pokémon Collection K.O. Évoli 30e Anniversaire FR', price_min: 6, price_max: 18, price_deal: 12, cooldown_hours: 12, notes: 'EAN non trouve, recherche par nom' },
  { label: 'Tripacks Collection Autocollant (lot de 2) 30 ans FR', ean: '0196214144972', query: null, price_min: 12, price_max: 28, price_deal: 20, cooldown_hours: 12, notes: null },
  { label: 'Lot de 2 Pokébox (Nymphali + Amphinobi) 30 ans FR', ean: '0196214146907', query: null, price_min: 30, price_max: 55, price_deal: 44, cooldown_hours: 12, notes: null },
  { label: 'Coffret Amphinobi-ex 30 ans FR', ean: '0196214147164', query: null, price_min: 15, price_max: 32, price_deal: 24, cooldown_hours: 12, notes: '4 boosters + promo + carte jumbo' },
  { label: 'Coffret Nymphali-ex 30 ans FR', ean: '0196214147102', query: null, price_min: 15, price_max: 32, price_deal: 24, cooldown_hours: 12, notes: '4 boosters + promo + carte jumbo' },
  { label: 'Bundle 6 Boosters 30 ans FR', ean: null, query: 'Pokémon Bundle 6 Boosters 30e Anniversaire FR', price_min: 25, price_max: 48, price_deal: 37, cooldown_hours: 12, notes: 'EAN non trouve, recherche par nom' },
  { label: 'Collection Classeur 30 ans FR', ean: '0196214145153', query: null, price_min: 28, price_max: 55, price_deal: 40, cooldown_hours: 12, notes: 'Classeur 9 pochettes + 5 boosters' },
  { label: 'Display 10 Mini Tins 30 ans FR', ean: null, query: 'Pokémon Display 10 Mini Tins Jour Nuit 30e Anniversaire FR', price_min: 70, price_max: 140, price_deal: 105, cooldown_hours: 12, notes: 'EAN non trouve, recherche par nom' },
  { label: 'Mini Tin Jour & Nuit 30 ans FR', ean: null, query: 'Pokémon Mini Tin 30e Anniversaire FR', price_min: 7, price_max: 16, price_deal: 11, cooldown_hours: 12, notes: 'Vendue a l\'unite, 10 illustrations differentes' },
  { label: 'Lot de 2 Decks de Combat Mentali/Noctali 30 ans FR', ean: null, query: 'Pokémon Deck de Combat 30e Anniversaire Mentali Noctali FR', price_min: 25, price_max: 50, price_deal: 36, cooldown_hours: 12, notes: 'Sortie prevue fin octobre 2026' },
  { label: 'Coffret Ultra-Premium Mentali-ex (Journée) 30 ans FR', ean: null, query: 'Pokémon Coffret Ultra-Premium Mentali-ex 30e Anniversaire FR', price_min: 150, price_max: 280, price_deal: 220, cooldown_hours: 12, notes: 'Sortie prevue debut novembre 2026, ~29 boosters' },
  { label: 'Coffret Ultra-Premium Noctali-ex (Soirée) 30 ans FR', ean: null, query: 'Pokémon Coffret Ultra-Premium Noctali-ex 30e Anniversaire FR', price_min: 150, price_max: 280, price_deal: 220, cooldown_hours: 12, notes: 'Sortie prevue debut novembre 2026, ~29 boosters' },
  { label: 'Coffret Premium Métamorph 30 ans FR', ean: null, query: 'Pokémon Coffret Premium Métamorph 30e Anniversaire FR', price_min: 25, price_max: 50, price_deal: 38, cooldown_hours: 12, notes: 'Sortie prevue debut novembre 2026, presentoir acrylique + 8 boosters' },
  { label: 'Coffret Figurine Mew 30 ans FR', ean: null, query: 'Pokémon Coffret Figurine Mew 30e Anniversaire FR', price_min: 18, price_max: 42, price_deal: 30, cooldown_hours: 12, notes: 'Sortie prevue debut novembre 2026, figurine + 5 boosters' },
  { label: 'Coffret Figurine Mewtwo 30 ans FR', ean: null, query: 'Pokémon Coffret Figurine Mewtwo 30e Anniversaire FR', price_min: 18, price_max: 42, price_deal: 30, cooldown_hours: 12, notes: 'Sortie prevue debut novembre 2026, figurine + 5 boosters' },
];

// URLs corrigees (l'ancienne adresse ne fonctionnait plus) ou nouvelles boutiques
const MERCHANT_UPDATES = [
  { name: 'Micromania', search_url: 'https://www.micromania.fr/on/demandware.store/Sites-Micromania-Site/default/Search-Show?q={q}' },
  { name: 'Play-in', search_url: 'https://www.play-in.com/fr/recherche?q={q}' },
];

const NEW_MERCHANTS = [
  { name: 'Pokestock', domain: 'pokestock.fr', search_url: 'https://pokestock.fr/?s={q}', enabled: 1, priority: 3 },
  { name: 'VCollect', domain: 'vcollect.fr', search_url: 'https://vcollect.fr/search?q={q}', enabled: 1, priority: 3 },
];

async function main() {
  const db = getDb(process.env);

  let np = 0;
  for (const p of NEW_PRODUCTS) {
    const res = await db
      .prepare(
        'INSERT INTO products (label, ean, query, price_min, price_max, price_deal, email, active, cooldown_hours, notes) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(p.label, p.ean, p.query, p.price_min, p.price_max, p.price_deal, EMAIL, 1, p.cooldown_hours, p.notes)
      .run();
    if (res.meta.changes) np++;
  }

  let mu = 0;
  for (const m of MERCHANT_UPDATES) {
    const res = await db
      .prepare('UPDATE merchants SET search_url = ? WHERE name = ?')
      .bind(m.search_url, m.name)
      .run();
    if (res.meta.changes) mu++;
  }

  let nm = 0;
  for (const m of NEW_MERCHANTS) {
    const res = await db
      .prepare('INSERT OR IGNORE INTO merchants (name, domain, search_url, enabled, priority) VALUES (?,?,?,?,?)')
      .bind(m.name, m.domain, m.search_url, m.enabled, m.priority)
      .run();
    if (res.meta.changes) nm++;
  }

  console.log(`${np}/${NEW_PRODUCTS.length} nouveaux produits ajoutes, ${mu}/${MERCHANT_UPDATES.length} boutiques corrigees, ${nm}/${NEW_MERCHANTS.length} nouvelles boutiques ajoutees.`);
}

main().catch((err) => {
  console.error('mise a jour echouee :', err.message || err);
  process.exit(1);
});
