// ---------------------------------------------------------------------------
// api.js — adaptateur Netlify Functions. Construit `env` a partir des
// variables d'environnement Netlify + une connexion Turso, puis delegue
// tout le travail a handleRequest() (src/router.js), qui est identique
// quelle que soit la plateforme.
// ---------------------------------------------------------------------------

import { handleRequest } from '../../src/router.js';
import { getDb } from '../../src/db.js';

function buildEnv() {
  return {
    DB: getDb(process.env),
    APP_TOKEN: process.env.APP_TOKEN || '',
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    ALERT_FROM: process.env.ALERT_FROM || 'TCG Watch <onboarding@resend.dev>',
    APP_URL: process.env.APP_URL || '',
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
    VAPID_PRIVATE_JWK: process.env.VAPID_PRIVATE_JWK || '',
    VAPID_SUBJECT: process.env.VAPID_SUBJECT || '',
    BATCH_SIZE: process.env.BATCH_SIZE || '24',
    HISTORY_DAYS: process.env.HISTORY_DAYS || '120',
  };
}

export default async (request) => handleRequest(request, buildEnv());

export const config = {
  path: '/api/*',
};
