// ---------------------------------------------------------------------------
// router.js — l'API JSON de TCG Watch, independante de la plateforme.
//
// Sur Cloudflare Workers cette logique vivait dans index.js avec le fetch
// handler du Worker. Ici elle est isolee : netlify/functions/api.js n'est
// qu'un petit adaptateur qui construit `env` a partir de process.env et
// appelle handleApi() — exactement les memes routes, le meme SQL, le meme
// contrat Request/Response standard des deux cotes.
// ---------------------------------------------------------------------------

import { runScan } from './scan.js';
import { fetchPage, extractOffer } from './extract.js';
import { pushToAll } from './push.js';
import { renderAlertEmail, sendEmail } from './mail.js';
import { detectSearchUrl, findEan } from './discover.js';

// Marqueur de version : permet de verifier d'un coup d'oeil quelle version du
// code tourne reellement, sans deviner. A incrementer a chaque correctif.
export const VERSION = '2026-09-12-netlify-v1';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const bad = (msg, status = 400) => json({ error: msg }, status);

function authorized(request, env) {
  // Pas de token configure = premiere installation, on laisse passer pour que
  // l'app soit utilisable, mais /api/ping le signale dans l'interface.
  if (!env.APP_TOKEN) return true;
  const header = request.headers.get('x-app-token');
  if (header && header === env.APP_TOKEN) return true;
  const url = new URL(request.url);
  return url.searchParams.get('token') === env.APP_TOKEN;
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

const num = (v) => (v === '' || v == null ? null : Number(v));

// Valide et normalise une URL de recherche de boutique.
// Renvoie { url } ou { error }.
//   - ajoute https:// si le protocole manque (« www.site.fr/... » tape a la
//     main) : c'est exactement le bug qui a rendu Philibert, l'Espace
//     Culturel Leclerc et UltraJeux muets malgre une URL par ailleurs juste.
//   - exige {q} derriere un vrai parametre, pas colle dans le chemin.
export function normalizeSearchUrl(raw) {
  let searchUrl = String(raw || '').trim();
  if (!searchUrl) return { error: "l'URL de recherche est obligatoire" };
  if (!searchUrl.includes('{q}')) return { error: "l'URL doit contenir {q} a l'endroit de la recherche" };
  if (!/^https?:\/\//i.test(searchUrl)) searchUrl = `https://${searchUrl}`;
  if (!/[?&][^=&]+=\{q\}/.test(searchUrl) && !/\/\{q\}(\/|$|\?)/.test(searchUrl)) {
    return { error: "cette URL n'est pas une recherche : {q} doit suivre un paramètre, comme ?s={q} ou ?q={q}" };
  }
  try {
    new URL(searchUrl.replace('{q}', 'test'));
  } catch {
    return { error: 'URL invalide' };
  }
  return { url: searchUrl };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method.toUpperCase();

  if (path === '/api/ping') {
    return json({
      ok: true,
      version: VERSION,
      needs_token: Boolean(env.APP_TOKEN),
      token_configured: Boolean(env.APP_TOKEN),
      mail_configured: Boolean(env.RESEND_API_KEY),
      push_configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK),
      vapid_public_key: env.VAPID_PUBLIC_KEY || null,
      authorized: authorized(request, env),
      time: new Date().toISOString(),
    });
  }

  if (!authorized(request, env)) return bad('token invalide', 401);
  const db = env.DB;

  // --- vue d'ensemble ------------------------------------------------------
  if (path === '/api/bootstrap' && method === 'GET') {
    const [products, merchants, latest, alerts, devices, health] = await Promise.all([
      db.prepare('SELECT * FROM products ORDER BY active DESC, id').all(),
      db.prepare('SELECT * FROM merchants ORDER BY priority, name').all(),
      db
        .prepare(
          // MAX(id) et non MAX(checked_at) : les horodatages sont a la seconde,
          // deux relevés d'un meme couple dans la meme seconde feraient doublon.
          `SELECT o.product_id, o.merchant_id, o.price, o.status, o.confidence, o.url, o.checked_at, m.name AS merchant_name
             FROM observations o
             JOIN merchants m ON m.id = o.merchant_id
            WHERE o.id IN (SELECT MAX(id) FROM observations GROUP BY product_id, merchant_id)
            ORDER BY o.status = 'in_stock' DESC, o.price ASC`,
        )
        .all(),
      db
        .prepare(
          `SELECT a.*, p.label AS product_label, m.name AS merchant_name
             FROM alerts a JOIN products p ON p.id = a.product_id JOIN merchants m ON m.id = a.merchant_id
            ORDER BY a.sent_at DESC LIMIT 40`,
        )
        .all(),
      db.prepare('SELECT COUNT(*) AS count FROM push_subs').first(),
      // Sante des boutiques : une boutique interrogee des dizaines de fois
      // sans jamais rien remonter a presque toujours une URL de recherche
      // fausse. Sans ce compteur, la panne reste invisible.
      db
        .prepare(
          `SELECT merchant_id, COUNT(*) AS interrogations,
                  SUM(CASE WHEN status <> 'not_found' THEN 1 ELSE 0 END) AS trouvailles
             FROM observations GROUP BY merchant_id`,
        )
        .all(),
    ]);
    return json({
      products: products.results,
      merchants: merchants.results,
      latest: latest.results,
      alerts: alerts.results,
      mail_configured: Boolean(env.RESEND_API_KEY),
      push_devices: devices?.count ?? 0,
      merchant_health: health.results,
    });
  }

  // --- produits ------------------------------------------------------------
  if (path === '/api/products' && method === 'POST') {
    const b = await body(request);
    const label = String(b.label || '').trim();
    const ean = String(b.ean || '').replace(/\D/g, '') || null;
    const query = String(b.query || '').trim() || null;
    if (!label) return bad('le nom du produit est obligatoire');
    if (!ean && !query) return bad('il faut un code EAN ou un nom de recherche');
    if (!b.email) return bad("l'email d'alerte est obligatoire");
    const priceMax = num(b.price_max);
    if (!priceMax || priceMax <= 0) return bad('le prix maximum est obligatoire');

    const res = await db
      .prepare(
        'INSERT INTO products (label, ean, query, price_min, price_max, price_deal, email, cooldown_hours, notes, active) VALUES (?,?,?,?,?,?,?,?,?,1)',
      )
      .bind(
        label,
        ean,
        query,
        num(b.price_min) ?? 0,
        priceMax,
        num(b.price_deal),
        String(b.email).trim(),
        Number(b.cooldown_hours) || 12,
        String(b.notes || '').trim() || null,
      )
      .run();
    return json({ ok: true, id: res.meta?.last_row_id });
  }

  const productMatch = path.match(/^\/api\/products\/(\d+)$/);
  if (productMatch) {
    const id = Number(productMatch[1]);
    if (method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM observations WHERE product_id = ?').bind(id),
        db.prepare('DELETE FROM alerts WHERE product_id = ?').bind(id),
        db.prepare('DELETE FROM links WHERE product_id = ?').bind(id),
        db.prepare('DELETE FROM products WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === 'PATCH') {
      const b = await body(request);
      const fields = ['label', 'ean', 'query', 'price_min', 'price_max', 'price_deal', 'email', 'active', 'cooldown_hours', 'notes'];
      const sets = [];
      const vals = [];
      for (const f of fields) {
        if (!(f in b)) continue;
        sets.push(`${f} = ?`);
        vals.push(['price_min', 'price_max', 'price_deal'].includes(f) ? num(b[f]) : ['active', 'cooldown_hours'].includes(f) ? Number(b[f]) : b[f] === '' ? null : b[f]);
      }
      if (!sets.length) return bad('rien a modifier');
      vals.push(id);
      await db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
      return json({ ok: true });
    }
  }

  // --- marchands -----------------------------------------------------------
  if (path === '/api/merchants' && method === 'POST') {
    const b = await body(request);
    const name = String(b.name || '').trim();
    if (!name) return bad('le nom du marchand est obligatoire');
    const norm = normalizeSearchUrl(b.search_url);
    if (norm.error) return bad(norm.error);
    const searchUrl = norm.url;
    let domain;
    try {
      domain = new URL(searchUrl.replace('{q}', 'test')).host.replace(/^www\./, '');
    } catch {
      return bad('URL invalide');
    }
    const res = await db
      .prepare('INSERT OR IGNORE INTO merchants (name, domain, search_url, priority, enabled) VALUES (?,?,?,?,1)')
      .bind(name, domain, searchUrl, Number(b.priority) || 5)
      .run();
    if (!res.meta?.changes) return bad('ce marchand existe deja', 409);
    return json({ ok: true, id: res.meta?.last_row_id });
  }

  const merchantMatch = path.match(/^\/api\/merchants\/(\d+)$/);
  if (merchantMatch) {
    const id = Number(merchantMatch[1]);
    if (method === 'DELETE') {
      await db.batch([
        db.prepare('DELETE FROM observations WHERE merchant_id = ?').bind(id),
        db.prepare('DELETE FROM alerts WHERE merchant_id = ?').bind(id),
        db.prepare('DELETE FROM links WHERE merchant_id = ?').bind(id),
        db.prepare('DELETE FROM merchants WHERE id = ?').bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === 'PATCH') {
      const b = await body(request);
      if ('search_url' in b) {
        const norm = normalizeSearchUrl(b.search_url);
        if (norm.error) return bad(norm.error);
        b.search_url = norm.url;
      }
      const sets = [];
      const vals = [];
      for (const f of ['name', 'search_url', 'enabled', 'priority']) {
        if (!(f in b)) continue;
        sets.push(`${f} = ?`);
        vals.push(['enabled', 'priority'].includes(f) ? Number(b[f]) : b[f]);
      }
      if (!sets.length) return bad('rien a modifier');
      vals.push(id);
      await db.prepare(`UPDATE merchants SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
      return json({ ok: true });
    }
  }

  // --- reparer l'URL de recherche d'une boutique ---------------------------
  const detectMatch = path.match(/^\/api\/merchants\/(\d+)\/detect$/);
  if (detectMatch && method === 'POST') {
    const id = Number(detectMatch[1]);
    const m = await db.prepare('SELECT * FROM merchants WHERE id = ?').bind(id).first();
    if (!m) return bad('boutique inconnue', 404);
    // on teste avec un vrai produit : une URL qui ne remonte rien ne vaut rien
    const probe = await db.prepare('SELECT ean, query, label FROM products WHERE active = 1 ORDER BY id LIMIT 1').first();
    const res = await detectSearchUrl(m.domain, { ean: probe?.ean, label: probe?.query || probe?.label }, m.search_url);
    if (res.ok) {
      await db.prepare('UPDATE merchants SET search_url = ? WHERE id = ?').bind(res.url, id).run();
      // l'ancienne URL a pu memoriser de mauvaises fiches
      await db.prepare('DELETE FROM links WHERE merchant_id = ? AND pinned = 0').bind(id).run();
    }
    return json({ ...res, boutique: m.name, ancienne: m.search_url });
  }

  // --- reparer toutes les boutiques muettes d'un coup ----------------------
  if (path === '/api/merchants/repair' && method === 'POST') {
    const muettes = (await db.prepare(
      `SELECT m.* FROM merchants m
        WHERE m.enabled = 1
          AND (SELECT COUNT(*) FROM observations o WHERE o.merchant_id = m.id) >= 6
          AND (SELECT COUNT(*) FROM observations o WHERE o.merchant_id = m.id AND o.status <> 'not_found') = 0
        ORDER BY m.priority, m.id`,
    ).all()).results;

    const probe = await db.prepare('SELECT ean, query, label FROM products WHERE active = 1 ORDER BY id LIMIT 1').first();
    // on repare par petits paquets pour rester large sous la limite de 30s
    const lot = muettes.slice(0, 4);
    const resultats = [];
    for (const m of lot) {
      const res = await detectSearchUrl(m.domain, { ean: probe?.ean, label: probe?.query || probe?.label }, m.search_url);
      if (res.ok && res.url !== m.search_url) {
        await db.prepare('UPDATE merchants SET search_url = ? WHERE id = ?').bind(res.url, m.id).run();
        await db.prepare('DELETE FROM links WHERE merchant_id = ? AND pinned = 0').bind(m.id).run();
      }
      resultats.push({ boutique: m.name, ok: res.ok, url: res.url, source: res.source });
    }
    return json({
      ok: true,
      reparees: resultats.filter((r) => r.ok).length,
      echecs: resultats.filter((r) => !r.ok).length,
      restantes: Math.max(0, muettes.length - lot.length),
      resultats,
    });
  }

  // --- retrouver l'EAN d'un produit ----------------------------------------
  const eanMatch = path.match(/^\/api\/products\/(\d+)\/find-ean$/);
  if (eanMatch && method === 'POST') {
    const id = Number(eanMatch[1]);
    const product = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    if (!product) return bad('produit inconnu', 404);

    const merchants = (await db.prepare(
      'SELECT * FROM merchants WHERE enabled = 1 AND search_url IS NOT NULL ORDER BY priority, id',
    ).all()).results;

    const res = await findEan(env, product, merchants);
    if (res.ok) await db.prepare('UPDATE products SET ean = ? WHERE id = ?').bind(res.ean, id).run();
    return json({ ...res, produit: product.label });
  }

  // --- URL produit epinglee ------------------------------------------------
  if (path === '/api/links' && method === 'POST') {
    const b = await body(request);
    if (!b.product_id || !b.merchant_id || !b.url) return bad('product_id, merchant_id et url sont obligatoires');
    await db
      .prepare(
        'INSERT INTO links (product_id, merchant_id, url, pinned) VALUES (?,?,?,1) ' +
          'ON CONFLICT(product_id, merchant_id) DO UPDATE SET url = excluded.url, pinned = 1, updated_at = datetime(\'now\')',
      )
      .bind(Number(b.product_id), Number(b.merchant_id), String(b.url))
      .run();
    return json({ ok: true });
  }

  // --- historique de prix --------------------------------------------------
  if (path === '/api/history' && method === 'GET') {
    const productId = Number(url.searchParams.get('product_id'));
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 60));
    if (!productId) return bad('product_id manquant');
    const rows = await db
      .prepare(
        `SELECT o.checked_at, o.price, o.status, m.name AS merchant_name
           FROM observations o JOIN merchants m ON m.id = o.merchant_id
          WHERE o.product_id = ? AND o.price IS NOT NULL
            AND o.checked_at >= datetime('now', '-${days} days')
          ORDER BY o.checked_at`,
      )
      .bind(productId)
      .all();
    return json({ points: rows.results });
  }

  // --- test d'une URL a la main -------------------------------------------
  if (path === '/api/probe' && method === 'POST') {
    const b = await body(request);
    if (!b.url) return bad('url manquante');
    const page = await fetchPage(String(b.url));
    if (!page.ok) return json({ ok: false, status: page.status, error: page.error || 'page inaccessible' });
    return json({ ok: true, ...extractOffer(page.html), url: page.url });
  }

  // --- notifications push --------------------------------------------------
  if (path === '/api/push/subscribe' && method === 'POST') {
    const b = await body(request);
    const endpoint = String(b.endpoint || '');
    const p256dh = b.keys?.p256dh;
    const auth = b.keys?.auth;
    if (!endpoint || !p256dh || !auth) return bad('abonnement incomplet');
    // le navigateur peut avoir remplace un abonnement revoque
    if (b.replaces) await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(b.replaces)).run();
    await db
      .prepare(
        'INSERT INTO push_subs (endpoint, p256dh, auth, user_agent) VALUES (?,?,?,?) ' +
          'ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth',
      )
      .bind(endpoint, String(p256dh), String(auth), (request.headers.get('user-agent') || '').slice(0, 200))
      .run();
    const { count } = await db.prepare('SELECT COUNT(*) AS count FROM push_subs').first();
    return json({ ok: true, devices: count });
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const b = await body(request);
    if (!b.endpoint) return bad('endpoint manquant');
    await db.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint)).run();
    return json({ ok: true });
  }

  if (path === '/api/push/test' && method === 'POST') {
    if (!env.VAPID_PRIVATE_JWK) return bad('VAPID_PRIVATE_JWK manquant côté serveur', 503);
    const res = await pushToAll(env, { test: true, u: null });
    return json({ ok: true, ...res });
  }

  // --- test d'envoi d'un mail ---------------------------------------------
  if (path === '/api/mail/test' && method === 'POST') {
    if (!env.RESEND_API_KEY) return bad('RESEND_API_KEY manquant côté serveur', 503);
    const b = await body(request);
    const to = String(b.to || '').trim()
      || (await db.prepare('SELECT email FROM products WHERE active = 1 ORDER BY id LIMIT 1').first())?.email;
    if (!to) return bad('aucune adresse de destination');

    // un exemple realiste, marque comme test, pour verifier la mise en page
    const { subject, html, text } = renderAlertEmail([{
      product_label: 'Test — Display 24 boosters OP-17',
      merchant_name: 'Micromania',
      price: 139.99,
      tier: 'deal',
      confidence: 'high',
      url: 'https://www.micromania.fr/c/cartes-one-piece-op17',
    }], env.APP_URL || null);

    const res = await sendEmail(env, { to, subject: `[TEST] ${subject}`, html, text });
    return res.ok
      ? json({ ok: true, to, id: res.id })
      : json({ ok: false, to, error: res.error }, 502);
  }

  if (path === '/api/push/status' && method === 'GET') {
    const { count } = await db.prepare('SELECT COUNT(*) AS count FROM push_subs').first();
    return json({ devices: count, configured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK) });
  }

  // --- lancer un scan a la main -------------------------------------------
  if (path === '/api/scan' && method === 'POST') {
    const b = await body(request);
    const result = await runScan(env, {
      productId: b.product_id ? Number(b.product_id) : null,
      full: Boolean(b.full),
      dryRun: Boolean(b.dry_run),
    });
    return json({ ok: true, ...result });
  }

  return bad('route inconnue', 404);
}

/** Point d'entree commun aux deux fonctions Netlify (api.js, scan-cron.js). */
export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': 'content-type,x-app-token',
      },
    });
  }
  try {
    const res = await handleApi(request, env);
    res.headers.set('access-control-allow-origin', '*');
    return res;
  } catch (err) {
    return json({ error: String(err?.message || err) }, 500);
  }
}
