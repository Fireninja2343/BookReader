/*
 SERVICE WORKER - OFFLINE APP SHELL

 Precaches the app's HTML/CSS/JS/manifest/icons so the reader works
 offline. Books are NOT cached here - they already live in IndexedDB
 (see 02-db.js).

 Uses a network-first strategy with a timeout. Requests refresh the
 cache when online, falling back to cached files only if the network
 fails or is too slow.

 IMPORTANT: bump CACHE_VERSION whenever a cached file changes so old
 caches are replaced on the next service worker update.
*/
const CACHE_VERSION = "epub-reader-shell-v1";

const APP_SHELL_FILES = [
    "./",
    "index.html",
    "manifest.json",

    "Styles/00-base.css",
    "Styles/01-library.css",
    "Styles/02-reader.css",
    "Styles/03-stats.css",
    "Styles/04-notes.css",
    "Styles/05-responsive.css",
    "Styles/06-danger-zone.css",

    "Scripts/00-config.js",
    "Scripts/01-state.js",
    "Scripts/02-db.js",
    "Scripts/03-groups.js",
    "Scripts/04-library-view.js",
    "Scripts/05-drag-drop.js",
    "Scripts/06-backup-restore.js",
    "Scripts/07-epub-parser.js",
    "Scripts/08-epub-import.js",
    "Scripts/09-epub-reader.js",
    "Scripts/10-reader-controls.js",
    "Scripts/11-view-router.js",
    "Scripts/12-context-menu.js",
    "Scripts/13-stats-view.js",
    "Scripts/14-utils.js",
    "Scripts/15-firebase-sync.js",
    "Scripts/16-notes.js",
    "Scripts/17-reading-history.js",
    "Scripts/18-timeline.js",
    "Scripts/19-danger-zone.js",
    "Scripts/20-soft-sync.js",
    "Scripts/21-version-badge.js",

    "icons/favicon.ico",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/icon-512-maskable.png",
];

// Third-party CDN scripts. Cached so the app shell still loads offline.
const CDN_FILES = [
    "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_VERSION);

            // Fail the install if any app-shell file is missing.
            await cache.addAll(APP_SHELL_FILES);

            // CDN failures shouldn't block offline app-shell caching.
            await Promise.all(
                CDN_FILES.map(async (url) => {
                    try {
                        const response = await fetch(url, { mode: "no-cors" });
                        await cache.put(url, response);
                    } catch (e) {
                        console.warn("[ServiceWorker] Failed to precache CDN file:", url, e);
                    }
                })
            );

            // Activate immediately instead of waiting for old tabs to close.
            self.skipWaiting();
        })()
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_VERSION)
                    .map((name) => caches.delete(name))
            );
            await self.clients.claim();
        })()
    );
});

// Fall back to cache if the network is too slow.
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("fetch", (event) => {
    // Only cache GET requests.
    if (event.request.method !== "GET") return;

    const requestUrl = new URL(event.request.url);
    const isSameOrigin = requestUrl.origin === self.location.origin;
    const isPrecachedCdnFile = CDN_FILES.includes(event.request.url);

    // Ignore unrelated cross-origin requests (e.g. Firestore traffic).
    if (!isSameOrigin && !isPrecachedCdnFile) return;

    event.respondWith(networkFirstWithCacheFallback(event.request));
});

async function networkFirstWithCacheFallback(request) {
    try {
        const networkResponse = await fetchWithTimeout(request, NETWORK_TIMEOUT_MS);

        // Keep the cache updated with the latest network response.
        const cache = await caches.open(CACHE_VERSION);
        cache.put(request, networkResponse.clone());

        return networkResponse;
    } catch (e) {
        // Fall back to the cached response if the network fails.
        const cached = await caches.match(request);
        if (cached) return cached;

        // First load with no cache and no network.
        throw e;
    }
}

function fetchWithTimeout(request, timeoutMs) {
    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error("Network request timed out"));
        }, timeoutMs);

        fetch(request, { signal: controller.signal }).then(
            (response) => {
                clearTimeout(timeoutId);
                resolve(response);
            },
            (err) => {
                clearTimeout(timeoutId);
                reject(err);
            }
        );
    });
}