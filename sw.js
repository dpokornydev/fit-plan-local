const CACHE_NAME = "become-better-v98";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=98",
  "./app.js?v=98",
  "./supabase-config.js?v=98",
  "./manifest.webmanifest",
  "./icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/icon-maskable-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/brand-mark-v2.png",
  "./assets/become-better-logo-v2.png",
  "./assets/supabase.min.js?v=98"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("become-better-v") && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Authentication, account data and signed photos must always reach Supabase.
  if (url.origin !== self.location.origin) return;
  const cacheable = event.request.mode === "navigate" || ASSETS.some((asset) => new URL(asset, self.registration.scope).href === url.href);
  if (!cacheable) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") return (await caches.match("./index.html")) || Response.error();
        return Response.error();
      })
  );
});
