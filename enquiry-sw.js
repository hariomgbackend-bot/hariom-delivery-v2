/* Minimal service worker for the public enquiry page.
   It exists so the page is installable on Android and opens in a standalone
   window (no browser UI). It does NOT cache anything — every request goes to
   the network, so an enquiry is never served from a stale shell. Its scope is
   restricted to /enquiry, so it never touches the DMS panels. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* network only */ });
