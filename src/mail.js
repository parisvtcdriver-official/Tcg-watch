// ---------------------------------------------------------------------------
// mail.js — envoi des alertes par mail via Resend (3 000 mails/mois gratuits).
// Un seul mail par passage du scanner, regroupant toutes les trouvailles.
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const eur = (n) =>
  n == null ? '—' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);

export function renderAlertEmail(finds, appUrl) {
  const hasDeal = finds.some((f) => f.tier === 'deal');
  const hasStock = finds.some((f) => f.status === 'in_stock');
  const hasPreorder = finds.some((f) => f.status === 'preorder');
  const subject =
    finds.length === 1
      ? `${hasDeal ? '🔥 BONNE AFFAIRE' : finds[0].status === 'preorder' ? '📦 PRÉCOMMANDE' : '🚨 EN STOCK'} — ${finds[0].product_label} à ${eur(finds[0].price)} chez ${finds[0].merchant_name}`
      : `${hasDeal ? '🔥' : '🚨'} ${finds.length} produit${finds.length > 1 ? 's' : ''}${hasStock && hasPreorder ? ' (stock + précommande)' : hasPreorder ? ' en précommande' : ' en stock'} — TCG Watch`;

  const rows = finds
    .map((f) => {
      const deal = f.tier === 'deal';
      const preorder = f.status === 'preorder';
      return `
      <tr>
        <td style="padding:0 0 14px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="border:1px solid ${deal ? '#f0b429' : preorder ? '#3a6b8a' : '#2a2f3a'};border-radius:12px;
                        background:${deal ? '#1f1a0d' : preorder ? '#0f1c26' : '#161a23'};">
            <tr><td style="padding:16px 18px;">
              ${deal ? '<div style="font:700 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.09em;color:#f0b429;text-transform:uppercase;padding-bottom:8px;">Bonne affaire</div>' : ''}
              ${preorder ? '<div style="font:700 11px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.09em;color:#5fb3e0;text-transform:uppercase;padding-bottom:8px;">Précommande — pas encore livrable</div>' : ''}
              <div style="font:600 16px/1.35 -apple-system,Segoe UI,Roboto,sans-serif;color:#eef1f6;">
                ${esc(f.product_label)}
              </div>
              <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#95a0b3;padding-top:4px;">
                ${esc(f.merchant_name)}${f.confidence === 'low' ? ' · <span style="color:#e0a458;">prix à vérifier sur la page</span>' : ''}
              </div>
              <div style="font:700 26px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;color:${deal ? '#f0b429' : preorder ? '#5fb3e0' : '#4ade80'};padding:10px 0 14px 0;">
                ${eur(f.price)}
              </div>
              <a href="${esc(f.url)}"
                 style="display:inline-block;background:${deal ? '#f0b429' : preorder ? '#3a6b8a' : '#e23c3c'};color:${deal ? '#1a1405' : '#ffffff'};
                        font:600 14px/1 -apple-system,Segoe UI,Roboto,sans-serif;text-decoration:none;
                        padding:12px 20px;border-radius:8px;">Ouvrir la fiche produit →</a>
            </td></tr>
          </table>
        </td>
      </tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#0d1017;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
   <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
      <tr><td style="padding-bottom:18px;">
        <div style="font:700 20px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;color:#eef1f6;">TCG Watch</div>
        <div style="font:400 13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#95a0b3;padding-top:4px;">
          ${finds.length} produit${finds.length > 1 ? 's' : ''} sous ${finds.length > 1 ? 'tes plafonds' : 'ton plafond'} de prix
          ${hasStock && hasPreorder ? '(certains en stock, d\'autres en précommande — regarde le badge de chaque carte)' : hasPreorder ? '(en précommande, pas encore livrable)' : ''}.
          Les displays partent en quelques minutes.
        </div>
      </td></tr>
      ${rows}
      <tr><td style="padding-top:10px;font:400 12px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#6b7688;">
        ${appUrl ? `<a href="${esc(appUrl)}" style="color:#6b7688;">Ouvrir l'app</a> · ` : ''}Stock vérifié à l'instant, mais il peut partir entre l'envoi et ton clic.
      </td></tr>
    </table>
   </td></tr>
  </table>
</body></html>`;

  const text = finds
    .map((f) => `${f.tier === 'deal' ? '[BONNE AFFAIRE] ' : ''}${f.status === 'preorder' ? '[PRÉCOMMANDE] ' : ''}${f.product_label} — ${eur(f.price)} chez ${f.merchant_name}\n${f.url}`)
    .join('\n\n');

  return { subject, html, text };
}

export async function sendEmail(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY manquant' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.ALERT_FROM || 'TCG Watch <onboarding@resend.dev>',
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        text,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body?.message || `HTTP ${res.status}` };
    return { ok: true, id: body?.id };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
