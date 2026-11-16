/* Guarda los archivos de la app en el celular para que abra sin internet.
   Al cambiar cualquier archivo de la app, subir el número de VERSION. */
const VERSION = "dendra-campo-v3";
const ARCHIVOS = [
  "./", "index.html", "app.js", "config.js", "manifest.webmanifest",
  "icono-192.png", "icono-512.png",
  "vendor/h3-js.umd.js", "vendor/jszip.min.js", "vendor/supabase.js", "vendor/leaflet.js", "vendor/leaflet.css",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(nombres.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Primero la red (para recibir actualizaciones); si no hay internet, la copia guardada
self.addEventListener("fetch", (evento) => {
  if (evento.request.method !== "GET") return;
  // Solo los archivos de la app; las llamadas a la base de datos van directo a internet
  if (new URL(evento.request.url).origin !== self.location.origin) return;
  evento.respondWith(
    fetch(evento.request)
      .then((respuesta) => {
        const copia = respuesta.clone();
        caches.open(VERSION).then((cache) => cache.put(evento.request, copia));
        return respuesta;
      })
      .catch(() => caches.match(evento.request, { ignoreSearch: true }))
  );
});
