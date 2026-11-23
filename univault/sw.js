const CACHE_VERSION = "v9";
const STATIC_CACHE = `univault-static-${CACHE_VERSION}`;
const DATA_CACHE = `univault-data-${CACHE_VERSION}`;
const CDN_CACHE = `univault-cdn-${CACHE_VERSION}`;

const CORE_ASSETS = [
  "/",
  "/index.html",
  "/app.html",
  "/signup.html",
  "/styles.css",
  "/landing.css",
  "/auth.css",
  "/config.js",
  "/knust-courses.js",
  "/app.js",
  "/signup.js",
  "/tour.js",
  "/ocr-reader.js",
  "/manifest.webmanifest",
  "/assets/knust-crest.png",
  "/assets/campus-students-bg.jpeg",
  "/assets/pwa-192x192.png",
  "/assets/pwa-512x512.png",
  "/assets/pwa-maskable-512x512.png",
  "/assets/apple-touch-icon.png",
];

const CACHEABLE_DATA_PATHS = [
  "/rest/v1/questions",
  "/rest/v1/question_content",
  "/rest/v1/app_settings",
  "/rest/v1/profiles",
  "/rest/v1/payouts",
  "/rest/v1/admins",
  "/rest/v1/testimonials",
  "/functions/v1/public-stats",
];

const CACHEABLE_CDN_HOSTS = [
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        Promise.allSettled(
          CORE_ASSETS.map((asset) =>
            cache.add(new Request(asset, { cache: "reload" }))
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  const keep = new Set([STATIC_CACHE, DATA_CACHE, CDN_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => (keep.has(key) ? Promise.resolve() : caches.delete(key)))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (type === "CLEAR_USER_DATA_CACHE") {
    event.waitUntil(caches.delete(DATA_CACHE));
  }
});

function isCacheableDataRequest(url) {
  return CACHEABLE_DATA_PATHS.some((prefix) => url.pathname.startsWith(prefix));
}

function isCacheableCdnRequest(url) {
  return CACHEABLE_CDN_HOSTS.includes(url.hostname);
}

async function networkFirst(request, cacheName, { ignoreSearch = false, cacheKeyUrl = false } = {}) {
  const cache = await caches.open(cacheName);
  const key = cacheKeyUrl ? request.url : request;
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(key, { ignoreSearch });
    if (cached) return cached;
    if (request.mode === "navigate") {
      const staticCache = await caches.open(STATIC_CACHE);
      const fallback =
        (await staticCache.match(request, { ignoreSearch: true })) ||
        (await staticCache.match("/app.html")) ||
        (await staticCache.match("/index.html"));
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const fresh = await fetchPromise;
  if (fresh) return fresh;
  return new Response("", { status: 504, statusText: "Offline" });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Never cache local API calls or auth endpoints
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) {
    return;
  }
  if (url.pathname.startsWith("/auth/v1/")) {
    return;
  }

  // Navigation requests (e.g., /app.html?paper=..., /index.html, /signup.html)
  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, STATIC_CACHE, { ignoreSearch: true })
    );
    return;
  }

  // Past question & archive data endpoints (Supabase REST & public-stats)
  if (isCacheableDataRequest(url)) {
    event.respondWith(
      networkFirst(request, DATA_CACHE, { cacheKeyUrl: true }).catch(
        () =>
          new Response(JSON.stringify({ error: "Offline and no cached data available." }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    return;
  }

  // Same-origin core code & assets
  if (url.origin === self.location.origin) {
    if (url.pathname === "/sw.js") return;
    if (url.pathname.startsWith("/assets/")) {
      event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
      return;
    }
    event.respondWith(networkFirst(request, STATIC_CACHE, { ignoreSearch: false }));
    return;
  }

  // Fonts & Supabase/OCR/PDF CDN scripts
  if (isCacheableCdnRequest(url)) {
    event.respondWith(staleWhileRevalidate(request, CDN_CACHE));
  }
});
