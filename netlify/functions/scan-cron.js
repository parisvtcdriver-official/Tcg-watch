// ---------------------------------------------------------------------------
// scan-cron.js — le declencheur autonome. Netlify appelle cette fonction
// tout seul selon `schedule` ci-dessous, meme app fermee, meme telephone
// eteint : c'est l'equivalent exact du [triggers] cron de Cloudflare.
// ---------------------------------------------------------------------------

import { runScan } from '../../src/scan.js';
import { getDb } from '../../src/db.js';

function buildEnv() {
  return {
    DB: getDb(process.env),
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

export default async () => {
  try {
    const r = await runScan(buildEnv());
    console.log('scan', JSON.stringify(r));
  } catch (err) {
    console.error('scan failed', err?.message || err);
  }
  return new Response('ok');
};

export const config = {
  schedule: '*/5 * * * *',
};
