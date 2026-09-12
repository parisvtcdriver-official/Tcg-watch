// ---------------------------------------------------------------------------
// migrate-add-alert-status.mjs — ajoute la colonne "status" a la table
// alerts (deja existante en base) pour distinguer une alerte "en stock"
// d'une alerte "precommande". Necessaire car schema.sql (CREATE TABLE IF NOT
// EXISTS) ne modifie jamais une table qui existe deja.
//
// Usage : TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/migrate-add-alert-status.mjs
// ---------------------------------------------------------------------------

import { getDb } from '../src/db.js';

async function main() {
  const db = getDb(process.env);
  try {
    await db.prepare("ALTER TABLE alerts ADD COLUMN status TEXT NOT NULL DEFAULT 'in_stock'").run();
    console.log('colonne "status" ajoutee a la table alerts.');
  } catch (err) {
    const msg = String(err?.message || err);
    if (/duplicate column|already exists/i.test(msg)) {
      console.log('colonne "status" deja presente, rien a faire.');
    } else {
      throw err;
    }
  }
}

main().catch((err) => {
  console.error('migration echouee :', err.message || err);
  process.exit(1);
});
