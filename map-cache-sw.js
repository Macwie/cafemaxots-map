/* CafeMaxOts bounded runtime cache. Map imagery is cached only after use. */
const CACHE_PREFIX = 'cafemax-map-';
const CACHE_VERSION = 'v1';
const CACHE_POLICIES = {
  tiles: { name: `${CACHE_PREFIX}${CACHE_VERSION}-tiles`, maxEntries: 1500 },
  creatures: { name: `${CACHE_PREFIX}${CACHE_VERSION}-creatures`, maxEntries: 512 },
  spawns: { name: `${CACHE_PREFIX}${CACHE_VERSION}-spawns`, maxEntries: 32 },
  assets: { name: `${CACHE_PREFIX}${CACHE_VERSION}-assets`, maxEntries: 64 },
  shell: { name: `${CACHE_PREFIX}${CACHE_VERSION}-shell`, maxEntries: 4 },
};
const TRIM_INTERVAL = 32;
const writesSinceTrim = new Map();

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const current = new Set(Object.values(CACHE_POLICIES).map(({ name }) => name));
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(CACHE_PREFIX) && !current.has(name))
      .map((name) => caches.delete(name)));
    await Promise.all(Object.values(CACHE_POLICIES).map(trimCache));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // A fresh manifest is the switch that exposes a newly published world.
  if (url.pathname.endsWith('/map-data/manifest.json')) {
    event.respondWith(fetch(request));
    return;
  }

  const policy = policyFor(url, request);
  if (!policy) return;

  const operation = policy === CACHE_POLICIES.shell
    ? networkFirst(request, policy)
    : cacheFirst(request, policy);
  event.respondWith(operation.response);
  // Register background writes during dispatch so every browser keeps the
  // worker alive until the Cache API operation finishes.
  event.waitUntil(operation.completion);
});

function policyFor(url, request) {
  if (url.pathname.includes('/map-data/tiles/')) return CACHE_POLICIES.tiles;
  if (url.pathname.includes('/map-data/creatures/')) return CACHE_POLICIES.creatures;
  if (url.pathname.includes('/map-data/spawns/')) return CACHE_POLICIES.spawns;
  if (url.pathname.includes('/assets/')) return CACHE_POLICIES.assets;
  if (request.mode === 'navigate' || url.pathname.endsWith('/index.html')) return CACHE_POLICIES.shell;
  return undefined;
}

function cacheFirst(request, policy) {
  let storage = Promise.resolve();
  const response = (async () => {
    const cache = await caches.open(policy.name);
    const cached = await cache.match(request);
    if (cached) return cached;

    const networkResponse = await fetch(request);
    if (isCacheable(networkResponse)) storage = store(cache, request, networkResponse.clone(), policy);
    return networkResponse;
  })();
  return { response, completion: response.then(() => storage, () => undefined) };
}

function networkFirst(request, policy) {
  let storage = Promise.resolve();
  const response = (async () => {
    const cache = await caches.open(policy.name);
    try {
      const networkResponse = await fetch(request);
      if (isCacheable(networkResponse)) storage = store(cache, request, networkResponse.clone(), policy);
      return networkResponse;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      throw error;
    }
  })();
  return { response, completion: response.then(() => storage, () => undefined) };
}

function isCacheable(response) {
  return response.ok && (response.type === 'basic' || response.type === 'default');
}

async function store(cache, request, response, policy) {
  try {
    await cache.put(request, response);
  } catch (error) {
    if (!isQuotaError(error)) return;
    await trimCache({ ...policy, maxEntries: Math.max(1, Math.floor(policy.maxEntries / 2)) });
    // Cache.put may consume the response even when it rejects. Leave this
    // request uncached; the newly freed space lets a later request succeed.
    return;
  }

  const writes = (writesSinceTrim.get(policy.name) ?? 0) + 1;
  if (writes < TRIM_INTERVAL) {
    writesSinceTrim.set(policy.name, writes);
    return;
  }
  writesSinceTrim.set(policy.name, 0);
  await trimCache(policy);
}

async function trimCache(policy) {
  const cache = await caches.open(policy.name);
  const requests = await cache.keys();
  const overflow = requests.length - policy.maxEntries;
  if (overflow <= 0) return;
  await Promise.all(requests.slice(0, overflow).map((request) => cache.delete(request)));
}

function isQuotaError(error) {
  if (!error || typeof error !== 'object' || !('name' in error)) return false;
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}
