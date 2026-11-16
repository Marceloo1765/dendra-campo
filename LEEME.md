# Dendra Campo

App web para registrar locales en la calle: ubicación (GPS), fotos y descripción.

- Cada registro se guarda primero en el celular y, si `config.js` tiene los datos de
  Supabase, se sube solo a la base de datos del equipo. Todos los que ingresan a la app
  ven los registros de todos.
- Con `config.js` vacío funciona solo en el celular y se exporta como ZIP.

La guía paso a paso para ponerla a funcionar está en el documento "Guía de puesta en
marcha de Dendra Campo".

## Archivos

- `index.html`, `app.js`: la app.
- `config.js`: dirección y clave *publishable* de Supabase. Nunca poner la clave *secret*.
- `supabase.sql`: crea la tabla `registros`, la carpeta de fotos y los permisos. Se pega
  una vez en el SQL Editor de Supabase.
- `sw.js`: guarda la app en el celular para que abra sin internet. Al cambiar cualquier
  archivo, subir el número de `VERSION`.
- `vendor/`: h3-js 4.5.0 (hexágonos, resolución 9 como `config.H3_RES`), JSZip 3.10.2 y
  supabase-js 2.119.0.

## Columnas

`nombre, direccion, lat, lon, fecha, quien, notas` (las de `data/raw/cafes_campo.csv`, en
el mismo orden) y después `estado, tipo, h3, precision_m, hora, fotos, id`.
