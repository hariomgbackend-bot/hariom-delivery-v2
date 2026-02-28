/* ═══════════════════════════════════════════════════
   Hariom DMS — App Shell Service Worker
   Handles: offline fallback, cache strategy, install prompt
═══════════════════════════════════════════════════ */

const CACHE_NAME = "hariom-dms-v1";
const OFFLINE_URL = "/offline.html";

// App shell files to cache on install
const PRECACHE_URLS = [
  "/offline.html",
  "/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

/* ── INSTALL: cache offline page ── */
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

/* ── FETCH: Network-first, offline fallback ── */
self.addEventListener("fetch", event => {
  // Only handle GET requests for same-origin navigation
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Skip chrome-extension and non-http requests
  if (!url.protocol.startsWith("http")) return;

  // For navigation requests (HTML pages) — network first, fallback to offline
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match(OFFLINE_URL);
      })
    );
    return;
  }

  // For icons/manifest — cache first
  if (url.pathname.startsWith("/icons/") || url.pathname === "/manifest.json") {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }
});
