// ---------------------------------------------------------------------------
// push.js — Web Push (RFC 8030 / 8291 / 8292) avec la seule Web Crypto API.
//
// Pas de dependance : les bibliotheques node classiques ne tournent pas dans un
// Worker. Tout est fait a la main :
//   - VAPID (RFC 8292)  : un JWT ES256 qui prouve au service de push qui envoie
//   - aes128gcm (RFC 8291) : le contenu de la notification est chiffre de bout
//     en bout, le service de push (Apple, Google, Mozilla) ne peut pas le lire
//
// Le payload est chiffre plutot qu'envoye vide : un push sans contenu n'est pas
// accepte de la meme facon par tous les services, et iOS penalise une app qui
// recoit un push sans afficher de notification.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

// --- base64url <-> octets ---------------------------------------------------
export function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(bytes) {
  let bin = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const concat = (...arrs) => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

// --- HKDF (RFC 5869) --------------------------------------------------------
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

// --- VAPID : le JWT qui identifie l'expediteur (RFC 8292) -------------------
async function vapidJwt(env, audience) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64url(enc.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'mailto:alertes@tcg-watch.app',
  })));
  const signingInput = `${header}.${payload}`;
  // Web Crypto rend deja la signature en r||s brut, exactement ce qu'attend ES256
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(sig)}`;
}

// --- chiffrement du contenu (RFC 8291) --------------------------------------
/**
 * @param {string} plaintext        le JSON a transmettre
 * @param {string} uaPublicB64      cle publique du navigateur (p256dh)
 * @param {string} authSecretB64    secret d'authentification du navigateur
 * @param {Uint8Array} [fixedSalt]  uniquement pour les tests (vecteur RFC)
 * @param {CryptoKeyPair} [fixedKeys]
 */
export async function encryptPayload(plaintext, uaPublicB64, authSecretB64, fixedSalt, fixedKeys) {
  const uaPublic = b64urlToBytes(uaPublicB64);
  const authSecret = b64urlToBytes(authSecretB64);
  const salt = fixedSalt || crypto.getRandomValues(new Uint8Array(16));

  const asKeys = fixedKeys || await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'],
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256),
  );

  // PRK : lie le secret ECDH aux deux cles publiques, pour qu'il ne puisse pas
  // etre rejoue vers un autre destinataire
  const prk = await hkdf(
    authSecret,
    shared,
    concat(enc.encode('WebPush: info\0'), uaPublic, asPublic),
    32,
  );
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // 0x02 = delimiteur de dernier enregistrement
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, padded),
  );

  // en-tete : salt(16) | taille d'enregistrement(4) | longueur de cle(1) | cle publique(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// --- envoi ------------------------------------------------------------------
/**
 * @returns {{ok:boolean, status:number, gone:boolean, error?:string}}
 *   gone = true -> l'abonnement n'existe plus, il faut le supprimer en base
 */
export async function sendPush(env, sub, payloadObj, { ttl = 3600, urgency = 'high' } = {}) {
  try {
    const endpoint = new URL(sub.endpoint);
    const jwt = await vapidJwt(env, endpoint.origin);
    const body = await encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        urgency,
      },
      body,
    });

    // 404 / 410 : le navigateur a desinstalle l'app ou revoque l'autorisation
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, gone: true };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, gone: false, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status, gone: false };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: String(err?.message || err) };
  }
}

/** Envoie a tous les abonnes et nettoie ceux qui n'existent plus. */
export async function pushToAll(env, payloadObj) {
  const subs = (await env.DB.prepare('SELECT * FROM push_subs').all()).results;
  if (!subs.length) return { sent: 0, removed: 0, failed: 0 };

  const results = await Promise.all(subs.map((s) => sendPush(env, s, payloadObj)));
  const gone = [];
  let sent = 0, failed = 0;
  results.forEach((r, i) => {
    if (r.ok) sent++;
    else if (r.gone) gone.push(subs[i].id);
    else failed++;
  });
  if (gone.length) {
    await env.DB.prepare(
      `DELETE FROM push_subs WHERE id IN (${gone.map(() => '?').join(',')})`,
    ).bind(...gone).run();
  }
  return { sent, removed: gone.length, failed };
}
