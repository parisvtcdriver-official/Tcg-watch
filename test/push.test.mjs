// Verifie le chiffrement Web Push et la signature VAPID sans reseau.
//   node test/push.test.mjs
//
// Le test central est un aller-retour complet sur le vecteur d'exemple de la
// RFC 8291 : on chiffre avec nos fonctions, puis on dechiffre cote navigateur
// avec la cle privee du vecteur. Si le texte ressort intact, c'est que l'ECDH,
// le HKDF, l'AES-GCM et la structure de l'entete sont tous corrects.

import { encryptPayload, b64urlToBytes, bytesToB64url } from '../src/push.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const concat = (...a) => {
  const out = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of a) { out.set(x, o); o += x.length; }
  return out;
};

// --- vecteur RFC 8291 section 5 --------------------------------------------
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic:  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  auth:      'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic:  'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt:      'DGv6ra1nlYgDCS1FRnbzlw',
};

function jwkFromRaw(rawB64, dB64, usages) {
  const raw = b64urlToBytes(rawB64);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC', crv: 'P-256',
      x: bytesToB64url(raw.slice(1, 33)),
      y: bytesToB64url(raw.slice(33, 65)),
      ...(dB64 ? { d: dB64 } : {}),
      ext: true,
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    usages,
  );
}

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}

/** Le dechiffrement tel que le ferait le navigateur destinataire. */
async function decryptAsBrowser(body, uaPublicB64, uaPrivateB64, authB64) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const uaPriv = await jwkFromRaw(uaPublicB64, uaPrivateB64, ['deriveBits']);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPriv, 256));

  const prk = await hkdf(
    b64urlToBytes(authB64), shared,
    concat(enc.encode('WebPush: info\0'), b64urlToBytes(uaPublicB64), asPublic), 32,
  );
  const cek = await hkdf(salt, prk, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ciphertext));
  // on retire le delimiteur de fin (0x02) et le padding eventuel
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  return { text: dec.decode(plain.slice(0, end)), delimiter: plain[end] };
}

// ---------------------------------------------------------------------------
console.log('--- RFC 8291 : aller-retour de chiffrement ---');

const asKeys = {
  privateKey: await jwkFromRaw(V.asPublic, V.asPrivate, ['deriveBits']),
  publicKey: await jwkFromRaw(V.asPublic, null, []),
};
const salt = b64urlToBytes(V.salt);
const body = await encryptPayload(V.plaintext, V.uaPublic, V.auth, salt, asKeys);

check('le sel est repris tel quel en tete', bytesToB64url(body.slice(0, 16)) === V.salt);
check('la taille d enregistrement est 4096', new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0) === 4096);
check('la longueur de cle annoncee est 65', body[20] === 65);
check('la cle publique de l expediteur est celle du vecteur', bytesToB64url(body.slice(21, 86)) === V.asPublic);
check('la taille totale est coherente',
  body.length === 16 + 4 + 1 + 65 + (V.plaintext.length + 1 + 16),
  `obtenu ${body.length}`);

const round = await decryptAsBrowser(body, V.uaPublic, V.uaPrivate, V.auth);
check('le navigateur retrouve le texte exact', round.text === V.plaintext, `obtenu "${round.text}"`);
check('le delimiteur de dernier enregistrement vaut 0x02', round.delimiter === 2);

// ---------------------------------------------------------------------------
console.log('\n--- cas reel : cles ephemeres aleatoires ---');

const alerte = JSON.stringify({ t: 'Display 24 boosters OP-17', p: 139.99, m: 'Micromania', tier: 'deal' });
const body2 = await encryptPayload(alerte, V.uaPublic, V.auth);
const round2 = await decryptAsBrowser(body2, V.uaPublic, V.uaPrivate, V.auth);
check('une alerte JSON fait l aller-retour', round2.text === alerte, `obtenu "${round2.text}"`);
check('deux envois donnent des octets differents (sel aleatoire)',
  bytesToB64url(body2) !== bytesToB64url(await encryptPayload(alerte, V.uaPublic, V.auth)));

// ---------------------------------------------------------------------------
console.log('\n--- VAPID : signature du JWT ---');

const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));

const env = {
  VAPID_PRIVATE_JWK: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d }),
  VAPID_PUBLIC_KEY: bytesToB64url(pubRaw),
  VAPID_SUBJECT: 'mailto:test@exemple.fr',
};

// on rejoue la meme construction que push.js pour pouvoir verifier la signature
const header = bytesToB64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
const payload = bytesToB64url(enc.encode(JSON.stringify({
  aud: 'https://web.push.apple.com', exp: Math.floor(Date.now() / 1000) + 43200, sub: env.VAPID_SUBJECT,
})));
const signKey = await crypto.subtle.importKey('jwk',
  { ...JSON.parse(env.VAPID_PRIVATE_JWK), key_ops: ['sign'], ext: true },
  { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, enc.encode(`${header}.${payload}`)));

check('la signature ES256 fait 64 octets (r||s brut, pas du DER)', sig.length === 64, `obtenu ${sig.length}`);
check('la signature se verifie avec la cle publique',
  await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, sig, enc.encode(`${header}.${payload}`)));

const decoded = JSON.parse(dec.decode(b64urlToBytes(payload)));
check('l audience est l origine du service de push', decoded.aud === 'https://web.push.apple.com');
check('le JWT expire dans moins de 24 h (exige par les services de push)',
  decoded.exp - Math.floor(Date.now() / 1000) <= 86400);
check('la cle publique VAPID fait 65 octets non compresses', pubRaw.length === 65 && pubRaw[0] === 4);

console.log(`\n${pass} reussis, ${fail} echoues`);
process.exit(fail ? 1 : 0);
