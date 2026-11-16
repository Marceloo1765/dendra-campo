-- Dendra Campo: base de datos del equipo.
-- Pegar todo en Supabase → SQL Editor → Run. Se puede correr más de una vez sin dañar nada.

-- 1) Tabla de registros (primero las columnas de cafes_campo.csv)
create table if not exists public.registros (
  id           text primary key,
  nombre       text not null,
  direccion    text,
  lat          double precision not null,
  lon          double precision not null,
  fecha        date not null,
  quien        text,
  notas        text,
  estado       text,
  tipo         text,
  h3           text,
  precision_m  integer,
  hora         text,
  fotos        text[] not null default '{}',
  subido_por   uuid default auth.uid(),
  actualizado  timestamptz not null default now()
);

-- 2) Solo las personas con cuenta (el equipo) pueden leer y escribir
alter table public.registros enable row level security;
drop policy if exists "equipo lee" on public.registros;
drop policy if exists "equipo crea" on public.registros;
drop policy if exists "equipo edita" on public.registros;
drop policy if exists "equipo borra" on public.registros;
create policy "equipo lee"   on public.registros for select to authenticated using (true);
create policy "equipo crea"  on public.registros for insert to authenticated with check (true);
create policy "equipo edita" on public.registros for update to authenticated using (true) with check (true);
create policy "equipo borra" on public.registros for delete to authenticated using (true);

-- 3) Carpeta privada para las fotos
insert into storage.buckets (id, name, public) values ('fotos', 'fotos', false)
on conflict (id) do nothing;

drop policy if exists "equipo ve fotos" on storage.objects;
drop policy if exists "equipo sube fotos" on storage.objects;
drop policy if exists "equipo reemplaza fotos" on storage.objects;
drop policy if exists "equipo borra fotos" on storage.objects;
create policy "equipo ve fotos"        on storage.objects for select to authenticated using (bucket_id = 'fotos');
create policy "equipo sube fotos"      on storage.objects for insert to authenticated with check (bucket_id = 'fotos');
create policy "equipo reemplaza fotos" on storage.objects for update to authenticated using (bucket_id = 'fotos') with check (bucket_id = 'fotos');
create policy "equipo borra fotos"     on storage.objects for delete to authenticated using (bucket_id = 'fotos');
