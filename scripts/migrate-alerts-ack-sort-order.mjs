// ---------------------------------------------------------------------------
// migrate-alerts-ack-sort-order.mjs — deux ajouts a la base deja en place :
//
//   1. alerts.acknowledged_at   : rempli quand Philippe clique "vu" dans
//      l'app. Tant que c'est vide, la meme trouvaille n'est jamais renvoyee.
//   2. products.sort_order      : position choisie a la main dans la liste
//      (boutons haut/bas, par bloc One Piece / Pokemon). Initialisee a
//      l'id existant pour que l'ordre actuel ne bouge pas au premier chargement.
//   3. products.franchise       : bloc d'affichage ('One Piece' / 'Pokémon' /
//      'Autre'). Devine a partir du nom pour les produits deja en base
//      (y compris la gamme 30 ans qui ne dit pas "Pokemon" dans son nom :
//      Evoli, Amphinobi, Metamorph...) ; les prochains produits le
//      recevront directement depuis la fiche (champ "Jeu").
//
// schema.sql (CREATE TABLE IF NOT EXISTS) ne modifie jamais une table qui
// existe deja : cette migration fait le travail sur la base de Philippe.
//
// Usage : TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-alerts-ack-sort-order.mjs
// ---------------------------------------------------------------------------

import { getDb } from '../src/db.js';

function guessFranchise(label, query) {
  const s = `${label || ''} ${query || ''}`.toLowerCase();
  if (/one\s?-?piece|\bop-?\d{1,3}\b/.test(s)) return 'One Piece';
  if (/pok[ée]mon|30\s*(e\s*)?(ans|anniversaire)|[ée]voli|amphinobi|nymphali|m[ée]tamorph|mentali|noctali|\bmew\b|mewtwo/.test(s)) return 'Pokémon';
  return 'Autre';
}

async function addColumn(db, table, ddl, label) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
    console.log(`${label} : colonne ajoutee.`);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/duplicate column|already exists/i.test(msg)) {
      console.log(`${label} : deja presente, rien a faire.`);
    } else {
      throw err;
    }
  }
}

async function main() {
  const db = getDb(process.env);

  await addColumn(db, 'alerts', 'acknowledged_at TEXT', 'alerts.acknowledged_at');
  await addColumn(db, 'products', 'sort_order INTEGER', 'products.sort_order');
  await addColumn(db, 'products', 'franchise TEXT', 'products.franchise');

  await db.prepare('UPDATE products SET sort_order = id WHERE sort_order IS NULL').run();
  console.log('products.sort_order initialise a l\'id pour les lignes qui ne l\'avaient pas encore.');

  const { results: sansFranchise } = await db.prepare('SELECT id, label, query FROM products WHERE franchise IS NULL').all();
  for (const p of sansFranchise) {
    await db.prepare('UPDATE products SET franchise = ? WHERE id = ?').bind(guessFranchise(p.label, p.query), p.id).run();
  }
  console.log(`products.franchise devine pour ${sansFranchise.length} produit(s) sans jeu renseigne.`);
}

main().catch((err) => {
  console.error('migration echouee :', err.message || err);
  process.exit(1);
});
