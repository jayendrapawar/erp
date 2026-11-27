/**
 * Shayona Inventory — Service Worker v5
 *
 * Strategies:
 *   - App shell JS/CSS (_next/static)          → CacheFirst  (versioned hashes, safe forever)
 *   - Page HTML + page data (all app routes)   → Network; the saved copy ONLY when offline.
 *     (v5, 21 Nov 2026: the old 5 s timeout served old pages and old orders / stock whenever the
 *     database was waking up. Page data for in-app navigation (RSC) is never saved.)
 *   - Images / icons / manifest                → CacheFirst
 *   - Catalogue API route (/api/catalogue)     → not touched: the page keeps its own copy and asks
 *     only when the catalogue changed (24 Nov 2026; the old 30 min copy here hid Master edits)
 *   - Server Actions (POST)                    → NetworkOnly (never cache mutations)
 *   - Everything else                          → Network; saved copy only when offline
 */

const CACHE_VERSION  = 'v5'
const CACHE_NAME     = `shayona-${CACHE_VERSION}`
const STATIC_CACHE   = `shayona-static-${CACHE_VERSION}`
const PAGES_CACHE    = `shayona-pages-${CACHE_VERSION}` // components/scanner-page.tsx saves /scanner here too: change both
// Owned by the page (lib/use-catalogue-cache.ts), not by this worker: kept when the worker updates.
const ORDER_CATALOGUE_CACHE = 'shayona-order-catalogue-v1'

// Pages to pre-cache on install (must be navigable without live DB)
const PRECACHE_URLS = [
  '/sign-in',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
]

// All HTML page path prefixes — anything here gets NetworkFirst + cache fallback
const PAGE_PATHS = [
  '/',
  '/orders',
  '/scanner',
  '/dashboard',
  '/sign-in',
  '/sign-up',
  '/master',
  '/billing',
  '/reports',
  '/purchases',
  '/home',
]

// ── Install: pre-cache critical shell ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PAGES_CACHE)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  )
})

// ── Activate: evict all old caches ───────────────────────────────────────────
self.addEventListener('activate', (event) => {
  const valid = new Set([CACHE_NAME, STATIC_CACHE, PAGES_CACHE, ORDER_CATALOGUE_CACHE])
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !valid.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// ── Fetch: route-based strategies ─────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Only intercept same-origin GETs
  if (request.method !== 'GET' || url.origin !== self.location.origin) return

  // _next/static — immutable versioned assets
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE))
    return
  }

  // Icons, manifest, static images
  if (
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    /\.(png|ico|svg|webp|jpg|jpeg|gif)$/.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(request, CACHE_NAME))
    return
  }

  // Catalogue API — straight to the server (the page keeps the copy)
  if (url.pathname === '/api/catalogue') return

  // Pages and their data — always from the server; the saved copy only when there is no connection
  const isHtmlPage =
    request.headers.get('accept')?.includes('text/html') ||
    PAGE_PATHS.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))

  if (isHtmlPage) {
    event.respondWith(networkFirst(request, PAGES_CACHE))
    return
  }

  // _next/data and internal Next routes
  if (url.pathname.startsWith('/_next/')) {
    event.respondWith(networkFirst(request, CACHE_NAME))
    return
  }

  // Default
  event.respondWith(networkFirst(request, CACHE_NAME))
})

// ── Strategies ────────────────────────────────────────────────────────────────

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(cacheName)
    cache.put(request, response.clone())
  }
  return response
}

/**
 * Network first with no time limit: a slow answer (database waking up) still shows fresh data. The
 * saved copy is used only when the network fails (offline). In-app page data (RSC) is never saved:
 * it changes with every order and scan.
 */
async function networkFirst(request, cacheName) {
  const url = new URL(request.url)
  const isRsc = request.headers.get('RSC') === '1' || url.searchParams.has('_rsc')
  try {
    const response = await fetch(request)
    if (response.ok && !isRsc) {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch {
    if (isRsc) return Response.error()
    const cached = await caches.match(request)
    if (cached) return cached
    if (request.headers.get('accept')?.includes('text/html')) {
      const fallback = await caches.match('/sign-in')
      if (fallback) return fallback
    }
    return new Response('Offline — open the app while connected first.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
    })
  }
}
