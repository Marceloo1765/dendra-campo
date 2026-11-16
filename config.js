/* Conexión con la base de datos del equipo (Supabase, proyecto "dendra-campo").
   Con los dos valores vacíos, la app funciona solo en este celular (sin sincronizar).
   La clave "publishable" está hecha para ser pública: lo que protege los datos son
   las cuentas del equipo y las reglas de supabase.sql. NUNCA pegar aquí la clave "secret". */
window.DENDRA_CONFIG = {
  supabaseUrl: "https://ulmbbfujuxqcmuavmlkc.supabase.co",
  supabaseKey: "sb_publishable_dbOZ0ltnhRHvm-3jkfCDxg_X8OI7yO4",
};
