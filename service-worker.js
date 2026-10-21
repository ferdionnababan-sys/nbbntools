/* NBBNTOOLS PWA foundation. Static pages only; transaction data stays in the app's local storage. */
const CACHE_NAME = "nbbntools-shell-v1";
const APP_SHELL = [
  "/",
  "/kasir/",
  "/offline.html",
  "/manifest.json",
  "/assets/favicon.svg",
  "/assets/app-icon.svg",
  "/assets/app-icon-maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith("nbbntools-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const key = new URL(url.pathname, self.location.origin).href;
      try {
        const response = await fetch(request);
        if (response && response.ok) await cache.put(key, response.clone());
        return response;
      } catch (_) {
        const cached = await cache.match(key) || await cache.match(request);
        return cached || await cache.match("/offline.html");
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type === "basic") {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (_) {
      return Response.error();
    }
  })());
});

