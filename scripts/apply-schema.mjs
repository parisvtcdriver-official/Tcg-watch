// ---------------------------------------------------------------------------
// apply-schema.mjs — cree les tables dans la base Turso (une seule fois,
// avant la premiere utilisation de l'app, ou apres un changement de schema).
//
// Usage : TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/apply-schema.mjs
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@libsql/client';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
    throw new Error('TURSO_DATABASE_URL et TURSO_AUTH_TOKEN doivent etre definis.');
  }
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const schema = readFileSync(join(__dirname, '..', 'schema.sql'), 'utf8');
  await client.executeMultiple(schema);
  console.log('schema applique avec succes.');
}

main().catch((err) => {
  console.error('echec application du schema :', err.message || err);
  process.exit(1);
});
