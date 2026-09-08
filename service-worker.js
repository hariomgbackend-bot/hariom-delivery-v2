/* ═══════════════════════════════════════════════════
   Hariom DMS — App Shell Service Worker
   Strategy:
   - HTML navigations: network-first, offline fallback (true offline use)
   - Static assets (css/js/png/svg/woff2/ico/manifest):
     stale-while-revalidate (instant from cache, refresh in background)
   Bump CACHE_NAME on any change to force a clean install.
══════════════════════════════════════════════════ */

const CACHE_NAME = "hariom-dms-v5";
const OFFLINE_URL = "/offline.html";

// Only these static asset types get cached (stale-while-revalidate).
// Everything else — navigations and, crucially, dynamic API GETs — must
// always hit the network so the tables never show stale/back-dated data.
const CACHEABLE_ASSET = /\.(css|js|mjs|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|eot|ico|json)$/i;

// App shell assets to precache on install
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.json",
  "/driver-manifest.json",
  "/staff-manifest.json",
  "/design-system.css",
  "/shared.js",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

/* ── INSTALL: precache app shell ── */
self.addEventListener("install", event => {
  console.log("[SW] Installing...");
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        console.warn("[SW] Pre-cache partial failure (ok in dev):", err);
      });
    }).then(() => self.skipWaiting())
  );
});

/* ── ACTIVATE: clean up old caches ── */
self.addEventListener("activate", event => {
  console.log("[SW] Activating...");
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log("[SW] Deleting old cache:", k);
          return caches.delete(k);
        })
      )
    ).then(() => self.clients.claim())
  );
});

/* ── FETCH ── */
self.addEventListener("fetch", event => {
  // Only handle GET for http(s)
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith("http")) return;

  // Same-origin only; let cross-origin (CDN fonts/scripts) pass through
  if (url.origin !== self.location.origin) return;

  // ── Navigations (HTML pages): network-first, offline fallback ──
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache a fresh copy of the HTML for offline use
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          return cached || caches.match(OFFLINE_URL);
        })
    );
    return;
  }

  // ── Dynamic API requests: network-only, NEVER cached ──
  // API GETs (e.g. /service/tickets, /delivery/:id, /driverDeliveries) are
  // auth-scoped and current-data-only. Stale-while-revalidate was serving an
  // old cached table (keyed only by URL, ignoring the Authorization header),
  // which made the table "go back" to an older snapshot until a hard reset.
  if (!CACHEABLE_ASSET.test(event.request.url)) {
    return; // default network fetch — no cache round-trip
  }

  // ── Static assets (css/js/png/svg/woff2/ico/manifest): stale-while-revalidate ──
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request)
        .then(response => {
          if (response && response.status === 200 && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => cached); // offline: fall back to whatever we have
      return cached || network;
    })
  );
});
