// Service worker de Défile (alcance /lidia/defile/): guarda la app para abrirla sin conexión; los datos siempre van a la red.
const CACHE = "defile-v1";
const ARCHIVOS = ["./", "index.html", "manifest.json", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)));
  self.skipWaiting();
});

// Solo borra cachés viejas de Défile: la de Lidia vive en el mismo origen.
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("defile-") && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Red primero (así siempre ves la última versión); caché si no hay conexión.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
