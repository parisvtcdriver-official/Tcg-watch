// Genere une paire de cles VAPID (notifications push) pretes a coller dans
// les variables d'environnement. A executer UNE SEULE FOIS : regenerer les
// cles invalide tous les abonnements push existants (il faudrait que
// chaque telephone se reabonne).
//   node scripts/generate-vapid-keys.mjs

import { webcrypto } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const rawPub = await webcrypto.subtle.exportKey('raw', kp.publicKey);
const jwkPriv = await webcrypto.subtle.exportKey('jwk', kp.privateKey);

console.log('VAPID_PUBLIC_KEY=' + b64url(rawPub));
console.log('VAPID_PRIVATE_JWK=' + JSON.stringify(jwkPriv));
