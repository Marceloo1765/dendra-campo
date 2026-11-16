/* Dendra Campo: registro de locales en la calle.

   Cómo guarda los datos:
   1. Cada registro se guarda primero en el celular (IndexedDB), así nunca se pierde
      aunque falle la señal.
   2. Si config.js tiene los datos de Supabase, se sube solo a la base de datos del
      equipo y se bajan los registros de los demás. Si no, la app funciona solo en
      este celular y se exporta como ZIP. */
"use strict";

const H3_RES = 9;              // igual que config.H3_RES del proyecto
const PRECISION_BUENA_M = 20;  // hasta aquí el GPS se considera bueno
const PRECISION_MALA_M = 50;   // desde aquí se avisa antes de guardar
const LADO_MAX_FOTO = 1600;    // las fotos se reducen a este lado máximo (px)
const CALIDAD_FOTO = 0.82;
const CUBO_FOTOS = "fotos";    // carpeta de fotos en Supabase Storage
const SEGUNDOS_ENTRE_SINCRONIZACIONES = 60;

const $ = (selector) => document.querySelector(selector);

/* ---------------- Base de datos del equipo (opcional) ---------------- */

const CONFIG = window.DENDRA_CONFIG || {};
const nube = (CONFIG.supabaseUrl && CONFIG.supabaseKey && window.supabase)
  ? window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey)
  : null;
let sesion = null;             // sesión de Supabase (null = sin ingresar)
let sincronizando = false;
let ultimoErrorNube = "";
let ultimaSincronizacion = null;

/* ---------------- Base de datos local ---------------- */

let bd;

function abrirBD() {
  return new Promise((resolver, rechazar) => {
    const pedido = indexedDB.open("dendra-campo", 2);
    pedido.onupgradeneeded = () => {
      const base = pedido.result;
      // La versión 1 guardaba las fotos con otra clave: se rehace el almacén
      for (const nombre of [...base.objectStoreNames]) base.deleteObjectStore(nombre);
      base.createObjectStore("registros", { keyPath: "id" });
      // Cada foto se identifica por su ruta: "<id del registro>/<id de la foto>.jpg"
      const fotos = base.createObjectStore("fotos", { keyPath: "ruta" });
      fotos.createIndex("registro", "registroId");
    };
    pedido.onsuccess = () => resolver(pedido.result);
    pedido.onerror = () => rechazar(pedido.error);
  });
}

// Ejecuta una operación sobre un almacén y devuelve una promesa con su resultado
function operar(almacen, modo, accion) {
  return new Promise((resolver, rechazar) => {
    const transaccion = bd.transaction(almacen, modo);
    const pedido = accion(transaccion.objectStore(almacen));
    transaccion.oncomplete = () => resolver(pedido ? pedido.result : undefined);
    transaccion.onerror = () => rechazar(transaccion.error);
    transaccion.onabort = () => rechazar(transaccion.error);
  });
}

const todosLosRegistros = () => operar("registros", "readonly", (a) => a.getAll());
const guardarRegistroLocal = (r) => operar("registros", "readwrite", (a) => a.put(r));
const fotoLocal = (ruta) => operar("fotos", "readonly", (a) => a.get(ruta));
const fotosLocalesDe = (id) => operar("fotos", "readonly", (a) => a.index("registro").getAll(id));
const guardarFotoLocal = (f) => operar("fotos", "readwrite", (a) => a.put(f));
const borrarFotoLocal = (ruta) => operar("fotos", "readwrite", (a) => a.delete(ruta));

// Cosas borradas en el celular que todavía falta borrar en la nube
function leerBorrados() {
  try { return JSON.parse(localStorage.getItem("borrados")) || { registros: [], fotos: [] }; }
  catch (e) { return { registros: [], fotos: [] }; }
}
function guardarBorrados(b) {
  try { localStorage.setItem("borrados", JSON.stringify(b)); } catch (e) { /* sin almacenamiento */ }
}
function anotarBorrado(idRegistro, rutasFoto) {
  if (!nube) return;
  const b = leerBorrados();
  if (idRegistro) b.registros.push(idRegistro);
  b.fotos.push(...rutasFoto);
  guardarBorrados(b);
}

/* ---------------- Estado de la pantalla ---------------- */

let ultimaPosicion = null;   // lo último que dio el GPS: {lat, lon, precision}
let posicionFijada = null;   // la ubicación que se guardará con el registro
let fotosNuevas = [];        // fotos tomadas en el formulario: {id, blob, url}
let editando = null;         // registro que se está editando (o null)
let detalleActual = null;
let vistaActual = "nuevo";

/* ---------------- Utilidades ---------------- */

function avisar(texto) {
  const caja = $("#aviso-flotante");
  caja.textContent = texto;
  caja.hidden = false;
  clearTimeout(avisar.reloj);
  avisar.reloj = setTimeout(() => { caja.hidden = true; }, 3500);
}

const dos = (n) => String(n).padStart(2, "0");
const fechaLocal = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const horaLocal = (d) => `${dos(d.getHours())}:${dos(d.getMinutes())}`;

function nuevoId() {
  const d = new Date();
  const azar = Math.random().toString(36).slice(2, 6);
  return `${fechaLocal(d).replaceAll("-", "")}-${dos(d.getHours())}${dos(d.getMinutes())}${dos(d.getSeconds())}-${azar}`;
}

// "Café Señorial" -> "cafe-senorial" (para nombres de archivo)
function nombreArchivo(texto) {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "local";
}

function hexagono(lat, lon) {
  try { return h3.latLngToCell(lat, lon, H3_RES); } catch (e) { return ""; }
}

const enlaceMapa = (lat, lon) =>
  `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;

/* ---------------- Sincronización ---------------- */

const puedeSincronizar = () => nube && sesion && navigator.onLine;

// Sube lo pendiente y baja lo de los demás. Nunca lanza error: lo deja en ultimoErrorNube.
async function sincronizar() {
  if (!puedeSincronizar() || sincronizando) return;
  sincronizando = true;
  pintarEstadoNube();
  try {
    // 1) Borrados pendientes
    const borrados = leerBorrados();
    if (borrados.fotos.length) {
      const { error } = await nube.storage.from(CUBO_FOTOS).remove(borrados.fotos);
      if (error) throw error;
    }
    if (borrados.registros.length) {
      const { error } = await nube.from("registros").delete().in("id", borrados.registros);
      if (error) throw error;
    }
    guardarBorrados({ registros: [], fotos: [] });

    // 2) Subir registros pendientes: primero sus fotos, después la fila
    for (const registro of (await todosLosRegistros()).filter((r) => r.pendiente)) {
      for (const foto of await fotosLocalesDe(registro.id)) {
        if (foto.subida) continue;
        const { error } = await nube.storage.from(CUBO_FOTOS)
          .upload(foto.ruta, foto.blob, { contentType: "image/jpeg", upsert: true });
        if (error) throw error;
        await guardarFotoLocal({ ...foto, subida: true });
      }
      const { pendiente, version, ...fila } = registro;  // estas dos columnas son solo del celular
      const { error } = await nube.from("registros")
        .upsert({ ...fila, actualizado: new Date().toISOString() });
      if (error) throw error;
      // Si se editó mientras subía, sigue pendiente para la próxima vuelta
      const actual = (await todosLosRegistros()).find((r) => r.id === registro.id);
      if (actual && actual.version === registro.version) {
        await guardarRegistroLocal({ ...actual, pendiente: false });
      }
    }

    // 3) Bajar los registros del equipo
    const { data: remotos, error } = await nube.from("registros").select("*");
    if (error) throw error;
    const locales = new Map((await todosLosRegistros()).map((r) => [r.id, r]));
    const idsRemotos = new Set(remotos.map((r) => r.id));
    for (const remoto of remotos) {
      const local = locales.get(remoto.id);
      if (local && local.pendiente) continue;  // lo mío sin subir manda
      await guardarRegistroLocal({ ...remoto, fotos: remoto.fotos || [], pendiente: false });
    }
    // Lo que otro borró en la nube se quita también de aquí
    for (const local of locales.values()) {
      if (!local.pendiente && !idsRemotos.has(local.id)) await quitarDelCelular(local.id);
    }

    ultimoErrorNube = "";
    ultimaSincronizacion = new Date();
  } catch (e) {
    ultimoErrorNube = (e && e.message) || "error desconocido";
  }
  sincronizando = false;
  await actualizarCabecera();
  pintarEstadoNube();
  if (vistaActual === "lista") pintarLista();
  if (vistaActual === "exportar") pintarExportar();
}

async function quitarDelCelular(id) {
  for (const foto of await fotosLocalesDe(id)) await borrarFotoLocal(foto.ruta);
  await operar("registros", "readwrite", (a) => a.delete(id));
}

async function pintarEstadoNube() {
  const pendientes = (await todosLosRegistros()).filter((r) => r.pendiente).length;
  let texto;
  if (!nube) texto = "Sin base de datos: los registros están solo en este celular.";
  else if (sincronizando) texto = "Sincronizando…";
  else if (!navigator.onLine) texto = `Sin internet. ${pendientes} por subir; se subirán solos al volver la señal.`;
  else if (ultimoErrorNube) texto = `No se pudo sincronizar (${ultimoErrorNube}). ${pendientes} por subir.`;
  else if (ultimaSincronizacion) texto = `Sincronizado a las ${horaLocal(ultimaSincronizacion)}. ${pendientes} por subir.`;
  else texto = `${pendientes} por subir.`;
  $("#estado-nube").textContent = texto;
  $("#cuenta-estado").textContent = (sesion ? `Sesión: ${sesion.user.email}. ` : "") + texto;
  $("#btn-sincronizar").hidden = !nube;
  $("#btn-salir").hidden = !sesion;
}

$("#btn-sincronizar").addEventListener("click", async () => {
  if (!navigator.onLine) { avisar("Sin internet"); return; }
  await sincronizar();
  avisar(ultimoErrorNube ? "No se pudo sincronizar" : "Sincronizado");
});

window.addEventListener("online", sincronizar);
window.addEventListener("offline", pintarEstadoNube);
document.addEventListener("visibilitychange", () => { if (!document.hidden) sincronizar(); });
setInterval(() => { if (!document.hidden) sincronizar(); }, SEGUNDOS_ENTRE_SINCRONIZACIONES * 1000);

/* ---------------- Ingreso ---------------- */

$("#form-ingreso").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const caja = $("#ingreso-error");
  caja.hidden = true;
  $("#btn-ingresar").disabled = true;
  const { data, error } = await nube.auth.signInWithPassword({
    email: $("#ingreso-correo").value.trim(),
    password: $("#ingreso-clave").value,
  });
  $("#btn-ingresar").disabled = false;
  if (error) {
    caja.textContent = /invalid/i.test(error.message)
      ? "Correo o contraseña incorrectos."
      : `No se pudo ingresar: ${error.message}`;
    caja.hidden = false;
    return;
  }
  sesion = data.session;
  $("#ingreso-clave").value = "";
  entrarALaApp();
});

$("#btn-salir").addEventListener("click", async () => {
  const pendientes = (await todosLosRegistros()).filter((r) => r.pendiente).length;
  if (pendientes && !confirm(`Hay ${pendientes} registros sin subir. Se quedan en este celular y se subirán cuando vuelvas a ingresar. ¿Cerrar sesión?`)) return;
  await nube.auth.signOut();
  sesion = null;
  mostrarIngreso();
});

function mostrarIngreso() {
  for (const vista of ["nuevo", "lista", "detalle", "exportar"]) $(`#vista-${vista}`).hidden = true;
  $("#vista-ingreso").hidden = false;
  $("#barra").hidden = true;
}

function entrarALaApp() {
  $("#vista-ingreso").hidden = true;
  $("#barra").hidden = false;
  mostrarVista("nuevo");
  actualizarCabecera();
  sincronizar();
}

/* ---------------- Ubicación ---------------- */

function iniciarGPS() {
  if (!("geolocation" in navigator)) {
    mostrarErrorGPS("Este navegador no da la ubicación. Escribe las coordenadas a mano.");
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => {
      ultimaPosicion = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy };
      $("#gps-mensaje").hidden = true;
      pintarUbicacion();
      pintarPuntoGPS();
      pintarAyudaMapa();
    },
    (error) => {
      const textos = {
        1: "La ubicación está bloqueada. Actívala para este sitio en los ajustes del navegador, o escribe las coordenadas a mano.",
        2: "El GPS no encuentra señal. Sal a un lugar abierto o escribe las coordenadas a mano.",
        3: "El GPS está tardando. Espera unos segundos en un lugar abierto.",
      };
      mostrarErrorGPS(textos[error.code] || "No se pudo leer la ubicación.");
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
}

function mostrarErrorGPS(texto) {
  const caja = $("#gps-mensaje");
  caja.textContent = texto;
  caja.hidden = false;
  if (!ultimaPosicion && !posicionFijada) {
    const estado = $("#gps-estado");
    estado.textContent = "sin GPS";
    estado.className = "pastilla mal";
  }
}

// Muestra la ubicación fijada si hay una; si no, la del GPS en vivo
async function pintarUbicacion() {
  const p = posicionFijada || ultimaPosicion;
  const estado = $("#gps-estado");
  if (!p) return;

  $("#gps-coords").textContent = `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}`;
  const celda = hexagono(p.lat, p.lon);
  const enHexagono = (await todosLosRegistros()).filter((r) => r.h3 === celda).length;
  const precision = p.precision != null ? `±${Math.round(p.precision)} m · ` : "";
  $("#gps-detalle").textContent =
    `${precision}hexágono ${celda} · ${enHexagono} ${enHexagono === 1 ? "registro" : "registros"} en este hexágono`;

  if (posicionFijada) {
    estado.textContent = posicionFijada.origen === "mapa" ? "elegida en el mapa" : "fijada";
    estado.className = "pastilla bien";
    $("#btn-fijar").textContent = "Volver al GPS en vivo";
  } else {
    const mala = p.precision > PRECISION_MALA_M, regular = p.precision > PRECISION_BUENA_M;
    estado.textContent = mala ? "GPS impreciso" : regular ? "GPS regular" : "GPS bueno";
    estado.className = "pastilla " + (mala ? "mal" : regular ? "aviso" : "bien");
    $("#btn-fijar").textContent = "Fijar esta ubicación";
  }
}

$("#btn-fijar").addEventListener("click", () => {
  if (posicionFijada) {
    posicionFijada = null;
  } else if (ultimaPosicion) {
    posicionFijada = { ...ultimaPosicion };
  } else {
    avisar("Todavía no hay ubicación del GPS");
    return;
  }
  pintarUbicacion();
});

$("#btn-manual").addEventListener("click", () => {
  $("#manual").hidden = !$("#manual").hidden;
});

function leerManual() {
  const lat = parseFloat($("#manual-lat").value), lon = parseFloat($("#manual-lon").value);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    return { lat, lon, precision: null };
  }
  return null;
}
for (const id of ["#manual-lat", "#manual-lon"]) {
  $(id).addEventListener("change", () => {
    const manual = leerManual();
    if (manual) { posicionFijada = manual; pintarUbicacion(); }
  });
}

/* ---------------- Mapa para ajustar el punto ---------------- */

const ZOOM_MAPA = 19;
let mapa = null;         // se crea la primera vez que se abre
let puntoGPS = null;     // círculo azul: dónde estoy según el GPS
let hexagonoMapa = null; // borde del hexágono H3 donde cae el pin

function distanciaMetros(a, b) {
  return L.latLng(a.lat, a.lon).distanceTo(L.latLng(b.lat, b.lon));
}

function abrirMapa() {
  const inicio = posicionFijada || ultimaPosicion || { lat: -12.1211, lon: -77.0297 };  // sin GPS: Parque Kennedy
  $("#panel-mapa").hidden = false;
  $("#btn-mapa").textContent = "Cerrar el mapa";
  if (!mapa) {
    mapa = L.map("mapa", { zoomControl: true, attributionControl: true }).setView([inicio.lat, inicio.lon], ZOOM_MAPA);
    // Teselas de Esri (las mismas de los mapas del proyecto); necesitan internet
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      maxNativeZoom: 19, maxZoom: 21, attribution: "Tiles © Esri",
    }).addTo(mapa);
    mapa.on("move", pintarAyudaMapa);
    mapa.on("moveend", pintarHexagonoMapa);
  } else {
    mapa.invalidateSize();
    mapa.setView([inicio.lat, inicio.lon], Math.max(mapa.getZoom(), ZOOM_MAPA - 1));
  }
  pintarPuntoGPS();
  pintarAyudaMapa();
  pintarHexagonoMapa();
}

function cerrarMapa() {
  $("#panel-mapa").hidden = true;
  $("#btn-mapa").textContent = "Ajustar el punto en el mapa";
}

function pintarPuntoGPS() {
  if (!mapa || !ultimaPosicion) return;
  const centro = [ultimaPosicion.lat, ultimaPosicion.lon];
  if (!puntoGPS) {
    puntoGPS = L.circleMarker(centro, { radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1 }).addTo(mapa);
  } else {
    puntoGPS.setLatLng(centro);
  }
}

function pintarAyudaMapa() {
  if (!mapa || $("#panel-mapa").hidden) return;
  const c = mapa.getCenter();
  let texto = `Pin en ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`;
  if (ultimaPosicion) texto += ` · a ${Math.round(distanciaMetros({ lat: c.lat, lon: c.lng }, ultimaPosicion))} m de ti (punto azul)`;
  $("#mapa-ayuda").textContent = texto + ". Mueve el mapa hasta que la punta del pin quede sobre la puerta del local.";
}

function pintarHexagonoMapa() {
  if (!mapa) return;
  const c = mapa.getCenter();
  try {
    const borde = h3.cellToBoundary(hexagono(c.lat, c.lng));  // lista de [lat, lon]
    if (hexagonoMapa) hexagonoMapa.setLatLngs(borde);
    else hexagonoMapa = L.polygon(borde, { color: "#1f5c4a", weight: 2, fill: false, dashArray: "6 6", interactive: false }).addTo(mapa);
  } catch (e) { /* sin hexágono: no pasa nada */ }
}

$("#btn-mapa").addEventListener("click", () => {
  if ($("#panel-mapa").hidden) abrirMapa(); else cerrarMapa();
});

$("#btn-centrar-mapa").addEventListener("click", () => {
  if (!ultimaPosicion) { avisar("Todavía no hay ubicación del GPS"); return; }
  mapa.setView([ultimaPosicion.lat, ultimaPosicion.lon], ZOOM_MAPA);
});

$("#btn-usar-mapa").addEventListener("click", () => {
  const c = mapa.getCenter();
  // precision null: el punto lo eligió una persona, no el GPS
  posicionFijada = { lat: c.lat, lon: c.lng, precision: null, origen: "mapa" };
  cerrarMapa();
  pintarUbicacion();
  avisar("Punto elegido en el mapa");
});

/* ---------------- Fotos ---------------- */

// Reduce la foto para que pese ~200–400 KB en vez de varios MB
async function reducirFoto(archivo) {
  let imagen;
  try {
    imagen = await createImageBitmap(archivo, { imageOrientation: "from-image" });
  } catch (e) {
    imagen = await new Promise((resolver, rechazar) => {
      const img = new Image();
      img.onload = () => resolver(img);
      img.onerror = () => rechazar(new Error("No se pudo leer la foto"));
      img.src = URL.createObjectURL(archivo);
    });
  }
  const escala = Math.min(1, LADO_MAX_FOTO / Math.max(imagen.width, imagen.height));
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.round(imagen.width * escala);
  lienzo.height = Math.round(imagen.height * escala);
  lienzo.getContext("2d").drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
  return new Promise((resolver, rechazar) =>
    lienzo.toBlob((blob) => blob ? resolver(blob) : rechazar(new Error("No se pudo guardar la foto")),
      "image/jpeg", CALIDAD_FOTO));
}

// Devuelve una dirección para mostrar la foto: la copia del celular o, si no está, la de la nube
const enlacesNube = new Map();
async function urlDeFoto(ruta) {
  const local = await fotoLocal(ruta);
  if (local) return URL.createObjectURL(local.blob);
  if (!puedeSincronizar()) return null;
  if (!enlacesNube.has(ruta)) {
    const { data } = await nube.storage.from(CUBO_FOTOS).createSignedUrl(ruta, 3600);
    if (!data) return null;
    enlacesNube.set(ruta, data.signedUrl);
  }
  return enlacesNube.get(ruta);
}

// La foto como archivo (para el ZIP): del celular o descargada de la nube
async function blobDeFoto(ruta) {
  const local = await fotoLocal(ruta);
  if (local) return local.blob;
  if (!puedeSincronizar()) return null;
  const { data } = await nube.storage.from(CUBO_FOTOS).download(ruta);
  return data || null;
}

async function agregarFotos(archivos) {
  for (const archivo of archivos) {
    try {
      const blob = await reducirFoto(archivo);
      fotosNuevas.push({ id: nuevoId(), blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      avisar("No se pudo leer una foto. Prueba de nuevo.");
    }
  }
  pintarFotosFormulario();
}

async function pintarFotosFormulario() {
  const caja = $("#fotos");
  const piezas = [];
  // Al editar, primero las fotos ya guardadas (se pueden quitar)
  for (const ruta of (editando ? editando.fotos : [])) {
    piezas.push(miniatura(await urlDeFoto(ruta), () => {
      editando.fotos = editando.fotos.filter((r) => r !== ruta);
      editando.fotosQuitadas.push(ruta);
      pintarFotosFormulario();
    }));
  }
  for (const foto of fotosNuevas) {
    piezas.push(miniatura(foto.url, () => {
      fotosNuevas = fotosNuevas.filter((f) => f !== foto);
      pintarFotosFormulario();
    }));
  }
  caja.replaceChildren(...piezas);
}

function miniatura(url, alQuitar) {
  const marco = document.createElement("div");
  marco.className = "foto";
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Foto del local";
    marco.append(img);
  }
  if (alQuitar) {
    const quitar = document.createElement("button");
    quitar.type = "button";
    quitar.textContent = "✕";
    quitar.setAttribute("aria-label", "Quitar foto");
    quitar.addEventListener("click", alQuitar);
    marco.append(quitar);
  }
  return marco;
}

$("#btn-camara").addEventListener("click", () => $("#input-camara").click());
$("#btn-galeria").addEventListener("click", () => $("#input-galeria").click());
for (const id of ["#input-camara", "#input-galeria"]) {
  $(id).addEventListener("change", async (evento) => {
    await agregarFotos([...evento.target.files]);
    evento.target.value = "";  // permite volver a elegir la misma foto
  });
}

/* ---------------- Guardar ---------------- */

$("#formulario").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const posicion = posicionFijada || leerManual() || ultimaPosicion;
  if (!posicion) {
    avisar("Falta la ubicación: espera al GPS o escribe las coordenadas");
    return;
  }
  if (posicion.precision > PRECISION_MALA_M &&
      !confirm(`El GPS tiene un error de ±${Math.round(posicion.precision)} m. ¿Guardar igual?`)) {
    return;
  }

  const ahora = new Date();
  const base = editando || { id: nuevoId(), fecha: fechaLocal(ahora), hora: horaLocal(ahora), fotos: [] };
  const { fotosQuitadas = [], ...anterior } = base;
  const rutasNuevas = fotosNuevas.map((foto) => `${anterior.id}/${foto.id}.jpg`);
  const registro = {
    ...anterior,
    nombre: $("#nombre").value.trim(),
    direccion: $("#direccion").value.trim(),
    notas: $("#notas").value.trim(),
    quien: $("#quien").value.trim(),
    estado: $("#estado").value,
    tipo: $("#tipo").value,
    lat: posicion.lat,
    lon: posicion.lon,
    precision_m: posicion.precision != null ? Math.round(posicion.precision) : null,
    h3: hexagono(posicion.lat, posicion.lon),
    fotos: [...anterior.fotos, ...rutasNuevas],
    pendiente: true,           // falta subirlo a la base de datos del equipo
    version: Date.now(),       // para saber si cambió mientras se subía
  };

  try {
    for (let i = 0; i < fotosNuevas.length; i++) {
      await guardarFotoLocal({ ruta: rutasNuevas[i], registroId: registro.id, blob: fotosNuevas[i].blob, subida: false });
    }
    await guardarRegistroLocal(registro);
    for (const ruta of fotosQuitadas) await borrarFotoLocal(ruta);
    anotarBorrado(null, fotosQuitadas);
  } catch (e) {
    avisar("No se pudo guardar. Puede que el celular esté sin espacio: libera espacio en Datos.");
    return;
  }

  try { localStorage.setItem("quien", registro.quien); } catch (e) { /* sin almacenamiento: no pasa nada */ }
  avisar(`Guardado: ${registro.nombre}`);
  limpiarFormulario();
  actualizarCabecera();
  window.scrollTo(0, 0);
  sincronizar();  // se sube en segundo plano
});

function limpiarFormulario() {
  editando = null;
  posicionFijada = null;
  fotosNuevas = [];
  for (const id of ["#nombre", "#direccion", "#notas", "#manual-lat", "#manual-lon"]) $(id).value = "";
  $("#estado").value = "abierto";
  $("#tipo").value = "cafeteria";
  $("#manual").hidden = true;
  cerrarMapa();
  $("#titulo-formulario").textContent = "Nuevo registro";
  $("#btn-guardar").textContent = "Guardar registro";
  $("#btn-cancelar").hidden = true;
  pintarFotosFormulario();
  pintarUbicacion();
}

$("#btn-cancelar").addEventListener("click", () => { limpiarFormulario(); mostrarVista("lista"); });

/* ---------------- Lista y detalle ---------------- */

const ETIQUETAS_ESTADO = { abierto: "Abierto", cerrado: "Cerrado definitivamente", no_existe: "No existe" };
const ETIQUETAS_TIPO = { cafeteria: "Cafetería", cadena: "Cadena", panaderia_cafe: "Panadería con café", jugueria: "Juguería", otro: "Otro" };

let turnoLista = 0;
async function pintarLista() {
  const turno = ++turnoLista;  // si llega otra llamada mientras tanto, esta se descarta
  pintarEstadoNube();
  const registros = (await todosLosRegistros()).sort((a, b) => b.id.localeCompare(a.id));
  const piezas = [];
  if (!registros.length) {
    const vacio = document.createElement("p");
    vacio.className = "vacio";
    vacio.textContent = "Todavía no hay registros. Párate frente a un local y toca Nuevo.";
    piezas.push(vacio);
  }
  for (const r of registros) {
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "registro";
    const url = r.fotos.length ? await urlDeFoto(r.fotos[0]) : null;
    const img = document.createElement(url ? "img" : "div");
    img.className = "mini";
    if (url) { img.src = url; img.alt = ""; img.loading = "lazy"; }
    const texto = document.createElement("div");
    const nombre = document.createElement("b");
    nombre.textContent = r.nombre;
    const linea1 = document.createElement("small");
    linea1.textContent = `${ETIQUETAS_ESTADO[r.estado] || r.estado} · ${ETIQUETAS_TIPO[r.tipo] || r.tipo} · ${r.fotos.length} ${r.fotos.length === 1 ? "foto" : "fotos"}`;
    const linea2 = document.createElement("small");
    const estadoSubida = !nube ? "" : r.pendiente ? " · por subir" : " · subido";
    linea2.textContent = `${r.fecha} ${r.hora || ""} · ${r.quien || ""}${estadoSubida}`;
    texto.append(nombre, linea1, linea2);
    boton.append(img, texto);
    boton.addEventListener("click", () => abrirDetalle(r));
    piezas.push(boton);
  }
  if (turno === turnoLista) $("#lista").replaceChildren(...piezas);
}

async function abrirDetalle(registro) {
  detalleActual = registro;
  $("#detalle-nombre").textContent = registro.nombre;
  const lineas = [
    `${ETIQUETAS_ESTADO[registro.estado] || registro.estado} · ${ETIQUETAS_TIPO[registro.tipo] || registro.tipo}`,
    registro.direccion,
    registro.notas,
    `${registro.lat.toFixed(6)}, ${registro.lon.toFixed(6)}` + (registro.precision_m != null ? ` (GPS, ±${registro.precision_m} m)` : " (punto elegido a mano)"),
    `Hexágono ${registro.h3}`,
    `${registro.fecha} ${registro.hora || ""} · ${registro.quien || ""}`,
  ].filter(Boolean);
  $("#detalle-datos").replaceChildren(...lineas.map((linea) => {
    const p = document.createElement("div");
    p.textContent = linea;
    return p;
  }));
  $("#detalle-fotos").replaceChildren();
  $("#detalle-mapa").href = enlaceMapa(registro.lat, registro.lon);
  mostrarVista("detalle");
  const piezas = [];
  for (const ruta of registro.fotos) piezas.push(miniatura(await urlDeFoto(ruta), null));
  if (detalleActual === registro) $("#detalle-fotos").replaceChildren(...piezas);
}

$("#btn-volver").addEventListener("click", () => mostrarVista("lista"));

$("#btn-borrar").addEventListener("click", async () => {
  const paraTodos = nube ? " Se borra para todo el equipo." : "";
  if (!confirm(`¿Borrar "${detalleActual.nombre}" y sus fotos?${paraTodos} No se puede deshacer.`)) return;
  anotarBorrado(detalleActual.id, detalleActual.fotos);
  await quitarDelCelular(detalleActual.id);
  avisar("Registro borrado");
  actualizarCabecera();
  mostrarVista("lista");
  sincronizar();
});

$("#btn-editar").addEventListener("click", () => {
  const r = detalleActual;
  editando = { ...r, fotos: [...r.fotos], fotosQuitadas: [] };
  fotosNuevas = [];
  posicionFijada = { lat: r.lat, lon: r.lon, precision: r.precision_m };  // se conserva la ubicación original
  $("#nombre").value = r.nombre;
  $("#direccion").value = r.direccion || "";
  $("#notas").value = r.notas || "";
  $("#quien").value = r.quien || "";
  $("#estado").value = r.estado;
  $("#tipo").value = r.tipo;
  $("#titulo-formulario").textContent = "Editar registro";
  $("#btn-guardar").textContent = "Guardar cambios";
  $("#btn-cancelar").hidden = false;
  pintarFotosFormulario();
  pintarUbicacion();
  mostrarVista("nuevo");
});

/* ---------------- Exportar ---------------- */

// Primero las columnas de data/raw/cafes_campo.csv, en su mismo orden; después las nuevas
const COLUMNAS = ["nombre", "direccion", "lat", "lon", "fecha", "quien", "notas",
                  "estado", "tipo", "h3", "precision_m", "hora", "fotos", "id"];

function celdaCSV(valor) {
  const texto = valor == null ? "" : String(valor);
  return /[",\n\r]/.test(texto) ? `"${texto.replaceAll('"', '""')}"` : texto;
}

async function prepararExportacion(conFotos) {
  const registros = (await todosLosRegistros()).sort((a, b) => a.id.localeCompare(b.id));
  const archivosFoto = [];
  let fotosFaltantes = 0;
  const filas = [COLUMNAS.join(",")];
  for (const r of registros) {
    const nombres = r.fotos.map((ruta, i) => `${r.id}_${nombreArchivo(r.nombre)}_${i + 1}.jpg`);
    if (conFotos) {
      for (let i = 0; i < r.fotos.length; i++) {
        const blob = await blobDeFoto(r.fotos[i]);
        if (blob) archivosFoto.push({ nombre: nombres[i], blob });
        else fotosFaltantes++;
      }
    }
    const fila = { ...r, lat: r.lat.toFixed(6), lon: r.lon.toFixed(6), fotos: nombres.join(";") };
    filas.push(COLUMNAS.map((c) => celdaCSV(fila[c])).join(","));
  }
  // "﻿" (BOM): para que Excel lea bien las tildes, igual que utf-8-sig en validacion.py
  const csv = "﻿" + filas.join("\r\n") + "\r\n";
  return { registros, csv, archivosFoto, fotosFaltantes };
}

// Entrega un archivo: en el celular abre "Compartir" (WhatsApp, Drive, correo); si no, lo descarga
async function entregar(blob, nombre) {
  const archivo = new File([blob], nombre, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try {
      await navigator.share({ files: [archivo], title: nombre });
      return true;
    } catch (e) {
      if (e.name === "AbortError") return false;  // la persona cerró el menú de compartir
    }
  }
  const enlace = document.createElement("a");
  enlace.href = URL.createObjectURL(blob);
  enlace.download = nombre;
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  return true;
}

async function exportar(conFotos) {
  avisar("Preparando el archivo…");
  const { registros, csv, archivosFoto, fotosFaltantes } = await prepararExportacion(conFotos);
  if (!registros.length) {
    avisar("No hay registros para exportar");
    return;
  }
  const ahora = new Date();
  const sello = `${fechaLocal(ahora)}_${dos(ahora.getHours())}${dos(ahora.getMinutes())}`;
  let entregado;
  if (conFotos) {
    const zip = new JSZip();
    zip.file("registros.csv", csv);
    for (const foto of archivosFoto) zip.file(`fotos/${foto.nombre}`, foto.blob);
    // STORE: los JPG ya están comprimidos, no vale la pena comprimirlos otra vez
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    entregado = await entregar(new Blob([blob], { type: "application/zip" }), `dendra_campo_${sello}.zip`);
  } else {
    entregado = await entregar(new Blob([csv], { type: "text/csv" }), `dendra_campo_${sello}.csv`);
  }
  if (!entregado) return;
  avisar(fotosFaltantes
    ? `Exportados ${registros.length} registros. Faltaron ${fotosFaltantes} fotos (sin internet para bajarlas).`
    : `Exportados ${registros.length} registros`);
}

$("#btn-exportar").addEventListener("click", () => exportar(true));
$("#btn-csv").addEventListener("click", () => exportar(false));

// Quita del celular las copias de fotos que ya están en la nube (se siguen viendo con internet)
$("#btn-limpiar").addEventListener("click", async () => {
  const subidas = (await operar("fotos", "readonly", (a) => a.getAll())).filter((f) => f.subida);
  if (!subidas.length) { avisar("No hay fotos ya subidas que quitar"); return; }
  if (!confirm(`¿Quitar de este celular ${subidas.length} fotos que ya están en la base de datos? Se seguirán viendo cuando haya internet.`)) return;
  for (const foto of subidas) await borrarFotoLocal(foto.ruta);
  avisar("Espacio liberado");
  pintarExportar();
});

async function pintarExportar() {
  pintarEstadoNube();
  const registros = await todosLosRegistros();
  $("#exportar-resumen").textContent = `${registros.length} ${registros.length === 1 ? "registro" : "registros"} para exportar.`;
  $("#tarjeta-cuenta").hidden = !nube;
  $("#btn-limpiar").hidden = !nube;
  try {
    const uso = await navigator.storage.estimate();
    $("#espacio").textContent =
      `Usado: ${(uso.usage / 1e6).toFixed(1)} MB de ${(uso.quota / 1e6).toFixed(0)} MB disponibles para esta app.`;
  } catch (e) {
    $("#espacio").textContent = "Este navegador no informa el espacio usado.";
  }
}

/* ---------------- Navegación ---------------- */

function mostrarVista(nombre) {
  vistaActual = nombre;
  for (const vista of ["nuevo", "lista", "detalle", "exportar"]) {
    $(`#vista-${vista}`).hidden = vista !== nombre;
  }
  const pestana = nombre === "detalle" ? "lista" : nombre;
  for (const boton of document.querySelectorAll("nav button")) {
    if (boton.dataset.vista === pestana) boton.setAttribute("aria-current", "page");
    else boton.removeAttribute("aria-current");
  }
  if (nombre === "lista") { pintarLista(); sincronizar(); }
  if (nombre === "exportar") pintarExportar();
  window.scrollTo(0, 0);
}

for (const boton of document.querySelectorAll("nav button")) {
  boton.addEventListener("click", () => mostrarVista(boton.dataset.vista));
}

async function actualizarCabecera() {
  const registros = await todosLosRegistros();
  const pendientes = registros.filter((r) => r.pendiente).length;
  const cola = !nube ? "solo en este celular" : pendientes ? `${pendientes} por subir` : "todo subido";
  $("#resumen-cabecera").textContent =
    `${registros.length} ${registros.length === 1 ? "registro" : "registros"} · ${cola}`;
}

/* ---------------- Arranque ---------------- */

(async function iniciar() {
  try {
    bd = await abrirBD();
  } catch (e) {
    mostrarErrorGPS("Este navegador no deja guardar datos (¿modo privado?). Abre la app en una pestaña normal.");
    $("#btn-guardar").disabled = true;
    return;
  }
  try { $("#quien").value = localStorage.getItem("quien") || ""; } catch (e) { /* sin almacenamiento */ }
  // Pide al navegador que no borre los datos por falta de uso
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  // Para que la app abra sin internet
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

  iniciarGPS();
  if (nube) {
    // La sesión queda guardada en el celular: solo se ingresa una vez
    sesion = (await nube.auth.getSession()).data.session;
    nube.auth.onAuthStateChange((evento, nueva) => { sesion = nueva; });
    if (!sesion) { mostrarIngreso(); return; }
  }
  entrarALaApp();
})();
