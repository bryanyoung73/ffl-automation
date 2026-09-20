const SHELL_CACHE = "ffl-shell-v2";
const SHELL_FILES = ["/", "/app.js", "/style.css", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Data must never be served stale — always go to the network.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // App shell: network-first. This dashboard's whole point is showing
  // current state (locked players, live scores) — a stale cached app.js
  // silently serving an old version forever (which is exactly what happened
  // here: a cache-first strategy with a static cache name meant a rebuilt,
  // redeployed server was invisible to any browser that had already cached
  // the old file) is worse than an extra network round-trip. Cache is only
  // a fallback for genuine offline access, always refreshed on success.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request)),
  );
});
