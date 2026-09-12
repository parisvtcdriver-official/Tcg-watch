// Service worker : cache de la coquille + reception des notifications push.
// Les appels /api/ ne sont JAMAIS caches — un prix perime serait pire que
// pas de prix du tout.

const CACHE = 'tcgwatch-v3';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png',
  '/apple-touch-icon.png', '/sword.mp3'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/index.html'))),
  );
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const eur = (n) => (n == null ? '' : new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* payload illisible */ }

  const deal = d.tier === 'deal';
  const preorder = d.status === 'preorder';
  const title = d.test
    ? 'TCG Watch — test'
    : d.n > 1
      ? `${deal ? '🔥' : preorder ? '📦' : '🚨'} ${d.n} produit${d.n > 1 ? 's' : ''} trouvé${d.n > 1 ? 's' : ''}`
      : deal ? '🔥 Bonne affaire' : preorder ? '📦 Précommande' : '🚨 En stock';

  const body = d.test
    ? 'Les notifications fonctionnent. Ouvre pour entendre le son.'
    : d.t
      ? `${d.t}\n${eur(d.p)} chez ${d.m}`
      : 'Un produit surveillé vient de repasser en stock.';

  // iOS sanctionne une app qui recoit un push sans rien afficher :
  // on affiche toujours quelque chose, meme si le payload est vide.
  e.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: 'tcg-stock',
    renotify: true,
    requireInteraction: deal,
    vibrate: [70, 40, 70, 40, 180],
    data: { url: d.u || null },
    actions: d.u ? [{ action: 'shop', title: 'Ouvrir la boutique' }] : [],
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const shopUrl = e.notification.data && e.notification.data.url;

  // Le bouton d'action va droit a la fiche produit : sur un display qui part
  // en quelques minutes, un clic de moins compte plus qu'un son.
  if (e.action === 'shop' && shopUrl) {
    e.waitUntil(clients.openWindow(shopUrl));
    return;
  }

  // Le clic normal ouvre l'app, qui joue le son de lame.
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.startsWith(self.location.origin)) {
        c.postMessage({ type: 'sword' });
        return c.focus();
      }
    }
    return clients.openWindow('/?sword=1');
  })());
});

// Certains navigateurs revoquent l'abonnement et en proposent un nouveau :
// on le renvoie au serveur pour ne pas perdre le canal en silence.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const sub = e.newSubscription
      || (await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: e.oldSubscription?.options?.applicationServerKey,
      }).catch(() => null));
    if (!sub) return;
    const json = sub.toJSON();
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, replaces: e.oldSubscription?.endpoint }),
    }).catch(() => {});
  })());
});
