// Service worker de Lidia: guarda la app para abrirla rápido; los datos siempre van a la red.
const CACHE = "lidia-v2";
const ARCHIVOS = ["./", "index.html", "manifest.json", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  // Solo cachés de Lidia: Défilé guarda la suya ("defile-*") en el mismo origen.
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith("lidia-") && k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Red primero para la app (así siempre ves la última versión); caché si no hay conexión.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    // «no-cache»: siempre pregunta al servidor si hay versión nueva (GitHub Pages guarda 10 min en caché).
    // (Una navegación no acepta opciones nuevas: se pide de nuevo por su URL.)
    (e.request.mode === "navigate" ? fetch(e.request.url, { cache: "no-cache" }) : fetch(e.request, { cache: "no-cache" }))
      .then((r) => {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return r;
      })
      .catch(() => caches.match(e.request)),
  );
});
