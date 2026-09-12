// Verifie que l'adaptateur DB (src/db.js) se comporte comme l'API D1 dont
// tout router.js/scan.js depend : prepare().bind().run()/.all()/.first(),
// et batch() atomique. Utilise un fichier SQLite local (libSQL peut ouvrir
// un fichier directement, pas besoin d'un vrai compte Turso pour ce test).
//   node test/db.test.mjs

import { createClient } from '@libsql/client';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { DB } from '../src/db.js';

let pass = 0, fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        obtenu ${JSON.stringify(got)}\n        attendu ${JSON.stringify(want)}`}`);
}

const path = '/tmp/tcgwatch-dbtest.sqlite';
if (existsSync(path)) unlinkSync(path);
const client = createClient({ url: `file:${path}` });
const db = new DB(client);

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
await client.executeMultiple(schema);

console.log('--- adaptateur D1-like sur Turso/libSQL ---');

const insertMerchant = await db
  .prepare('INSERT INTO merchants (name, domain, search_url, priority, enabled) VALUES (?,?,?,?,1)')
  .bind('TestShop', 'test.fr', 'https://test.fr/search?q={q}', 5)
  .run();
check('run() renvoie last_row_id', insertMerchant.meta.last_row_id > 0, true);
check('run() renvoie changes = 1', insertMerchant.meta.changes, 1);

const merchant = await db.prepare('SELECT * FROM merchants WHERE id = ?').bind(insertMerchant.meta.last_row_id).first();
check('first() renvoie la bonne ligne', merchant?.name, 'TestShop');
check('first() : les colonnes entieres restent des nombres', merchant?.enabled, 1);

const all = await db.prepare('SELECT * FROM merchants').all();
check('all() renvoie { results: [...] }', all.results.length, 1);

// batch() : plusieurs ecritures atomiques, comme scan.js pour observations+links
const p = await db
  .prepare('INSERT INTO products (label, ean, price_max, email) VALUES (?,?,?,?)')
  .bind('TestProd', '1234567890123', 99, 'a@b.com')
  .run();
const batchRes = await db.batch([
  db.prepare('INSERT INTO observations (product_id, merchant_id, price, status, checked_at) VALUES (?,?,?,?,datetime(\'now\'))')
    .bind(p.meta.last_row_id, insertMerchant.meta.last_row_id, 5.5, 'in_stock'),
  db.prepare('UPDATE products SET notes = ? WHERE id = ?').bind('vu en stock', p.meta.last_row_id),
]);
check('batch() renvoie un resultat par instruction', batchRes.length, 2);
const updated = await db.prepare('SELECT notes FROM products WHERE id = ?').bind(p.meta.last_row_id).first();
check('batch() a bien applique les deux ecritures', updated?.notes, 'vu en stock');

// ON CONFLICT ... DO UPDATE (utilise par /api/links et push_subs) : SQL
// identique a D1, doit fonctionner tel quel sur libSQL.
await db
  .prepare('INSERT INTO links (product_id, merchant_id, url, pinned) VALUES (?,?,?,1) ' +
    'ON CONFLICT(product_id, merchant_id) DO UPDATE SET url = excluded.url, pinned = 1')
  .bind(p.meta.last_row_id, insertMerchant.meta.last_row_id, 'https://test.fr/produit-1')
  .run();
await db
  .prepare('INSERT INTO links (product_id, merchant_id, url, pinned) VALUES (?,?,?,1) ' +
    'ON CONFLICT(product_id, merchant_id) DO UPDATE SET url = excluded.url, pinned = 1')
  .bind(p.meta.last_row_id, insertMerchant.meta.last_row_id, 'https://test.fr/produit-1-bis')
  .run();
const link = await db.prepare('SELECT url FROM links WHERE product_id = ? AND merchant_id = ?')
  .bind(p.meta.last_row_id, insertMerchant.meta.last_row_id).first();
check('ON CONFLICT DO UPDATE remplace bien la ligne existante', link?.url, 'https://test.fr/produit-1-bis');

console.log(`\n${pass} ok, ${fail} echoue(s)`);
unlinkSync(path);
if (fail) process.exit(1);
