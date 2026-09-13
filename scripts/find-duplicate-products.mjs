// ---------------------------------------------------------------------------
// find-duplicate-products.mjs — diagnostic en LECTURE SEULE : repere les
// produits qui se ressemblent trop pour etre vraiment differents, pour que
// Philippe les revoie et supprime lui-meme les doublons dans l'app (bouton
// "Supprimer cette alerte" dans la fiche produit).
//
// Deux produits sont signales quand :
//   - ils ont le meme EAN, ou
//   - leur libelle, une fois nettoye (accents, casse, ponctuation), est identique
//
// Ne modifie rien.
// Usage : TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/find-duplicate-products.mjs
// ---------------------------------------------------------------------------

import { getDb } from '../src/db.js';

function normLabel(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function main() {
  const db = getDb(process.env);
  const { results: products } = await db.prepare('SELECT id, label, ean, query, active FROM products ORDER BY id').all();

  console.log(`${products.length} produit(s) au total.\n`);

  const byEan = new Map();
  const byLabel = new Map();
  for (const p of products) {
    if (p.ean) {
      if (!byEan.has(p.ean)) byEan.set(p.ean, []);
      byEan.get(p.ean).push(p);
    }
    const key = normLabel(p.label);
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(p);
  }

  let found = 0;
  for (const [ean, group] of byEan) {
    if (group.length < 2) continue;
    found++;
    console.log(`— MEME EAN ${ean} :`);
    for (const p of group) console.log(`   #${p.id}  ${p.label}  ${p.active ? '' : '(en pause)'}`);
  }
  for (const [key, group] of byLabel) {
    if (group.length < 2) continue;
    // deja signale via l'EAN ? on evite de repeter la meme paire
    if (group.every((p) => p.ean) && new Set(group.map((p) => p.ean)).size === 1) continue;
    found++;
    console.log(`— MEME NOM (« ${key} ») :`);
    for (const p of group) console.log(`   #${p.id}  ${p.label}  ${p.active ? '' : '(en pause)'}`);
  }

  if (!found) console.log('Aucun doublon evident trouve.');
  else console.log(`\n${found} groupe(s) suspect(s). Pour supprimer un doublon : ouvre sa fiche dans l'app`
    + ' (bouton "Modifier") puis "Supprimer cette alerte".');
}

main().catch((err) => {
  console.error('diagnostic echoue :', err.message || err);
  process.exit(1);
});
