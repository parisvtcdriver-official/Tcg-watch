-- TCG Watch — schema Turso (libSQL, compatible SQLite)
-- turso db shell tcg-watch < schema.sql

CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  label          TEXT    NOT NULL,          -- nom affiche dans l'app
  ean            TEXT,                      -- code EAN (optionnel si query rempli)
  query          TEXT,                      -- nom produit pour la recherche (optionnel si ean rempli)
  price_max      REAL    NOT NULL,          -- plafond alerte "prix normal"
  price_deal     REAL,                      -- seuil alerte "bonne affaire" (optionnel)
  price_min      REAL    NOT NULL DEFAULT 0,-- garde-fou : sous ce prix c'est louche, on ignore
  email          TEXT    NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  cooldown_hours INTEGER NOT NULL DEFAULT 12,
  notes          TEXT,
  sort_order     INTEGER,                   -- position choisie a la main dans la liste (par franchise)
  franchise      TEXT,                      -- 'One Piece' | 'Pokémon' | 'Autre' -- bloc d'affichage
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS merchants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  domain     TEXT    NOT NULL,
  search_url TEXT,                          -- template de recherche, {q} = requete url-encodee
  enabled    INTEGER NOT NULL DEFAULT 1,
  priority   INTEGER NOT NULL DEFAULT 5,    -- 1 = verifie en premier
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(domain)
);

-- URL produit directe pour un couple (produit, marchand).
-- Renseignee a la main, ou memorisee automatiquement quand la recherche a
-- trouve la bonne page : les passages suivants vont droit au but.
CREATE TABLE IF NOT EXISTS links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  url         TEXT    NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,   -- 1 = saisie manuelle, ne pas ecraser
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  price       REAL,
  currency    TEXT    NOT NULL DEFAULT 'EUR',
  status      TEXT    NOT NULL,             -- in_stock | preorder | oos | not_found | error
  confidence  TEXT    NOT NULL DEFAULT 'none', -- high (JSON-LD/meta) | low (texte) | none
  url         TEXT,
  checked_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  price       REAL,
  tier        TEXT    NOT NULL,             -- deal | normal
  status      TEXT    NOT NULL DEFAULT 'in_stock', -- in_stock | preorder
  url         TEXT,
  emailed     INTEGER NOT NULL DEFAULT 0,
  mail_error  TEXT,                          -- raison exacte d'un envoi rate (Resend), sinon NULL
  acknowledged_at TEXT,                      -- rempli quand Philippe clique "vu" dans l'app ; tant que
                                              -- c'est vide, la meme trouvaille n'est jamais renvoyee
  sent_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Un appareil abonne aux notifications push. endpoint est fourni par le
-- navigateur et identifie le telephone ; p256dh et auth servent a chiffrer
-- le contenu pour que le service de push ne puisse pas le lire.
CREATE TABLE IF NOT EXISTS push_subs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint   TEXT    NOT NULL UNIQUE,
  p256dh     TEXT    NOT NULL,
  auth       TEXT    NOT NULL,
  user_agent TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_obs_product_time  ON observations(product_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_pair_time     ON observations(product_id, merchant_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_pair_time  ON alerts(product_id, merchant_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_links_pair        ON links(product_id, merchant_id);
