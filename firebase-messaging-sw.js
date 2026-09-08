importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBfQlLpHbuRsZ7YKIFBj8Fa5o-HMo0SBrU",
  authDomain: "hariom-delivery.firebaseapp.com",
  projectId: "hariom-delivery",
  storageBucket: "hariom-delivery.firebasestorage.app",
  messagingSenderId: "60300951507",
  appId: "1:60300951507:web:e5d55d0d18dc2000b47926"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {

  const title = payload?.data?.title || "New Notification";
  const body  = payload?.data?.body  || "";

  self.registration.showNotification(title, {
    body: body,
    icon: "/icons/icon-192.png",
    requireInteraction: true
  });

});

/* ════════════════════════════════════════════════════
   APP-SHELL CACHE (offline-first)
   Cache version — bump when the asset list / behavior
   changes so `activate` clears the stale cache.
════════════════════════════════════════════════════ */
const CACHE_NAME = "hariom-shell-v4";
const SHELL_ASSETS = [
  "/driver_interface.html",
  "/design-system.css?v=2",
  "/shared.js?v=2",
  "/driver-manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

// Only these static asset types are cached. Everything else — especially
// dynamic API GETs like /service/tickets, /deliveries, /api/stores — must
// ALWAYS go to the network. The old cache-first handler was returning a
// stale "yesterday" table snapshot for these GETs until a hard refresh.
const CACHEABLE_ASSET = /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot|ico|json)$/i;

// Precache the app shell on install so the page can boot with no network.
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn("[SW] precache failed:", err))
  );
});

// Clean up any old caches.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;               // let POSTs go to network

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;          // pass cross-origin through

  // HTML navigations: network-first, fall back to cached shell when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/driver_interface.html").then(r => r || caches.match(event.request)))
    );
    return;
  }

  // Dynamic API requests (data): NEVER cache — always fetch fresh.
  if (!CACHEABLE_ASSET.test(url.pathname)) return;

  // Static assets (css/js/manifest/icons): cache-first, fall back to network.
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      });
    })
  );
});
