// ---------------------------------------------------------------------------
// db.js — adaptateur Turso (libSQL) qui imite l'API D1 de Cloudflare
// (db.prepare(sql).bind(...).run()/.all()/.first(), db.batch([...])).
//
// Le but : reutiliser handleApi() et runScan() sans reecrire une seule
// requete SQL. Turso (libSQL) est un fork de SQLite : la totalite du SQL
// deja ecrit et teste pour D1 (INSERT OR IGNORE, ON CONFLICT ... DO UPDATE,
// datetime('now'), AUTOINCREMENT) fonctionne telle quelle.
// ---------------------------------------------------------------------------

import { createClient } from '@libsql/client';

class Stmt {
  constructor(client, sql) {
    this.client = client;
    this.sql = sql;
    this.args = [];
  }
  bind(...args) {
    // D1 accepte `undefined` (le traite comme NULL) ; libSQL est plus strict.
    this.args = args.map((a) => (a === undefined ? null : a));
    return this;
  }
  async run() {
    const r = await this.client.execute({ sql: this.sql, args: this.args });
    return {
      meta: {
        changes: r.rowsAffected ?? 0,
        last_row_id: r.lastInsertRowid == null ? 0 : Number(r.lastInsertRowid),
      },
    };
  }
  async all() {
    const r = await this.client.execute({ sql: this.sql, args: this.args });
    return { results: r.rows.map(rowToPlainObject) };
  }
  async first() {
    const r = await this.client.execute({ sql: this.sql, args: this.args });
    return r.rows.length ? rowToPlainObject(r.rows[0]) : undefined;
  }
}

// Les lignes renvoyees par @libsql/client sont des objets hybrides
// (index + nom de colonne + Symbol.iterator) ; on les aplatit en objets
// simples pour que JSON.stringify() et les acces `.champ` se comportent
// exactement comme avec D1.
function rowToPlainObject(row) {
  return { ...row };
}

export class DB {
  constructor(client) {
    this.client = client;
  }
  prepare(sql) {
    return new Stmt(this.client, sql);
  }
  // db.batch([db.prepare(sql1).bind(...), db.prepare(sql2).bind(...), ...])
  // Comme D1, execute tout dans une seule transaction atomique.
  async batch(stmts) {
    if (!stmts.length) return [];
    const r = await this.client.batch(
      stmts.map((s) => ({ sql: s.sql, args: s.args })),
      'write',
    );
    return r.map((res) => ({
      meta: {
        changes: res.rowsAffected ?? 0,
        last_row_id: res.lastInsertRowid == null ? 0 : Number(res.lastInsertRowid),
      },
    }));
  }
}

let cached = null;

/** Une seule connexion reutilisee entre les invocations de la fonction (tant que la lambda reste chaude). */
export function getDb(env) {
  if (cached) return cached;
  if (!env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL manquant — la base de donnees n\'est pas configuree');
  }
  const client = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN || undefined,
  });
  cached = new DB(client);
  return cached;
}
