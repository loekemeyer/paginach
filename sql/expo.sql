-- =====================================================================
-- MÓDULO EXPO — backend (Chef SRL, proyecto Supabase nkhzocgdpwtgrmwleihr)
-- =====================================================================
-- Portado desde Loekemeyer (pagina-LK-copia). Este archivo NO se ejecuta
-- solo: se corre A MANO en el SQL editor del proyecto Supabase de Chef.
--
-- Es idempotente (create ... if not exists / create or replace) salvo la
-- SEMILLA del contador de código y la escala, que solo se cargan si están
-- vacías. Se puede correr entero de una.
--
-- ANTES DE CORRER, revisar los DOS puntos marcados con  <<< AJUSTAR >>> :
--   1) expo_config.next_cod  → (máximo código de cliente del ERP de Chef) + 1
--   2) expo_dto_escala        → tramos de descuento por volumen de Chef
--
-- Supone que ya existen (con estos nombres) las tablas del sitio:
--   customers(id uuid, cod_cliente bigint, business_name, cuit, dto_vol,
--             vend, mail, whatsapp, direccion_fiscal, localidad, pin,
--             auth_user_id)
--   customer_delivery_addresses(customer_id uuid, slot, label,
--             direccion_entrega, localidad, provincia, nombre_expreso)
--   admins(auth_user_id uuid)
--   orders(customer_id uuid, total)
-- NO usa nada de "Línea Loke" (Chef no la tiene).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) PIN de 6 dígitos (password del login del cliente: usuario = CUIT).
--    El alta genera un PIN aleatorio de 6 dígitos; el constraint lo exige.
--    Se agrega solo si no existe ya (evita error al re-correr).
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'customers_pin_6_digits'
  ) then
    alter table public.customers
      add constraint customers_pin_6_digits check (pin ~ '^\d{6}$') not valid;
    -- NOT VALID: no revalida las filas viejas (por si algún pin histórico no
    -- cumple). Los inserts/updates nuevos SÍ se validan. Para exigirlo a todo:
    --   alter table public.customers validate constraint customers_pin_6_digits;
  end if;
end $$;


-- ---------------------------------------------------------------------
-- 2) Contador del código de cliente del sistema (singleton, fila id=1).
--    NO se deriva del padrón de la web (que es parcial): se siembra desde
--    el ERP para no colisionar.
-- ---------------------------------------------------------------------
create table if not exists public.expo_config (
  id int primary key default 1,
  next_cod bigint not null,
  constraint expo_config_singleton check (id = 1)
);

-- <<< AJUSTAR >>> Reemplazar 5000 por (máximo código de cliente del ERP de
-- Chef) + 1. Solo carga si la tabla está vacía; si ya tiene fila, no la pisa.
insert into public.expo_config (id, next_cod)
select 1, 5000
where not exists (select 1 from public.expo_config where id = 1);

alter table public.expo_config enable row level security;
drop policy if exists expo_config_admin on public.expo_config;
create policy expo_config_admin on public.expo_config for all
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- peek: leer el próximo código sin consumirlo (para mostrarlo en el modal).
create or replace function public.expo_peek_cod()
returns bigint language sql security definer set search_path = public as $$
  select next_cod from public.expo_config where id = 1;
$$;

-- reservar: consume un código (incrementa el contador) y devuelve el reservado.
create or replace function public.expo_reservar_cod()
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  update public.expo_config set next_cod = next_cod + 1 where id = 1
    returning next_cod - 1 into v;
  return v;
end; $$;

revoke execute on function public.expo_peek_cod()     from public, anon;
revoke execute on function public.expo_reservar_cod() from public, anon;
grant  execute on function public.expo_peek_cod()     to authenticated, service_role;
grant  execute on function public.expo_reservar_cod() to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 3) Staging de clientes NUEVOS de expo (para levantarlos al ERP luego).
--    El frontend escribe este NÚCLEO de columnas. Se puede extender con
--    columnas que espejen el maestro del ERP para la importación; el
--    frontend no las usa.
-- ---------------------------------------------------------------------
create table if not exists public.expo_clientes_pendientes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  cod_cliente bigint,
  business_name text,
  cuit text,
  condicion_iva text,
  direccion text,           -- calle fiscal
  numero text,
  cp text,
  localidad text,
  provincia text,
  telefono text,
  whatsapp text,
  mail text,
  vend text,
  dto_vol numeric,
  pin text,
  direcciones_entrega jsonb default '[]'::jsonb,
    -- [{titulo, direccion, localidad, provincia, expreso}]
  estado text default 'pendiente',   -- 'pendiente' | 'cargado_erp'
  creado_por uuid default auth.uid(),
  creado_at timestamptz default now(),
  actualizado_at timestamptz default now()
);

alter table public.expo_clientes_pendientes enable row level security;
drop policy if exists expo_pend_admin_all on public.expo_clientes_pendientes;
create policy expo_pend_admin_all on public.expo_clientes_pendientes
  for all
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));


-- ---------------------------------------------------------------------
-- 4) Escala de descuento por volumen (clientes NUEVOS de expo).
--    El dto se elige por el subtotal de LISTA del carrito, en vivo.
--    Editable desde el panel admin (Escala Expo).
-- ---------------------------------------------------------------------
create table if not exists public.expo_dto_escala (
  id uuid primary key default gen_random_uuid(),
  desde numeric not null,      -- subtotal de lista desde el cual aplica
  dto   numeric not null,      -- fracción 0..1
  creado_at timestamptz default now()
);

alter table public.expo_dto_escala enable row level security;
drop policy if exists expo_escala_read on public.expo_dto_escala;
create policy expo_escala_read on public.expo_dto_escala for select using (true);
drop policy if exists expo_escala_admin on public.expo_dto_escala;
create policy expo_escala_admin on public.expo_dto_escala
  for all
  using      (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
  with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));

-- <<< AJUSTAR >>> Tramos de arranque (heredados de LK). RECALCULARLOS con los
-- precios/volumen de Chef. Se pueden editar después desde Admin → Escala Expo.
-- Solo carga si la tabla está vacía.
insert into public.expo_dto_escala (desde, dto)
select * from (values
  (0::numeric, 0.00::numeric), (600000::numeric, 0.02::numeric),
  (1000000::numeric, 0.04::numeric), (1500000::numeric, 0.06::numeric),
  (2300000::numeric, 0.08::numeric), (4000000::numeric, 0.10::numeric),
  (6000000::numeric, 0.12::numeric)
) as t(desde, dto)
where not exists (select 1 from public.expo_dto_escala);


-- ---------------------------------------------------------------------
-- 5) Buscador del popup "Elegir cliente" (cód / razón social / CUIT / dir).
--    SECURITY DEFINER, con gate de admin adentro. Solo lectura, tope 25.
-- ---------------------------------------------------------------------
create or replace function public.buscar_cliente_expo(p_q text)
returns table(
  id uuid, cod_cliente bigint, business_name text, cuit text,
  dto_vol numeric, vend text, direccion text, localidad text
)
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_q      text := btrim(coalesce(p_q, ''));
  v_digits text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_isnum  boolean := v_q ~ '^\d+$';
  v_cod    bigint := null;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  if length(v_q) < 2 then return; end if;
  -- Cast protegido: SOLO dígitos puros. v_q::bigint directo en el WHERE se
  -- const-foldea y tira 22P02 con un CUIT con guiones.
  if v_isnum and length(v_q) <= 18 then
    begin v_cod := v_q::bigint; exception when others then v_cod := null; end;
  end if;

  return query
  select * from (
    with matches as (
      select c.id
      from customers c
      where (v_cod is not null and c.cod_cliente = v_cod)
         or c.business_name ilike '%' || v_q || '%'
         or (length(v_digits) >= 4
             and regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') like '%' || v_digits || '%')
      union
      select da.customer_id
      from customer_delivery_addresses da
      where length(v_q) >= 3
        and (da.direccion_entrega ilike '%' || v_q || '%'
             or da.localidad ilike '%' || v_q || '%')
    )
    select distinct on (c.id)
      c.id, c.cod_cliente, c.business_name, c.cuit, c.dto_vol, c.vend,
      coalesce(nullif(c.direccion_fiscal, ''), da.direccion_entrega) as direccion,
      coalesce(nullif(c.localidad, ''), da.localidad) as localidad
    from customers c
    join matches m on m.id = c.id
    left join customer_delivery_addresses da on da.customer_id = c.id
    order by c.id, da.slot nulls last
  ) s
  order by s.cod_cliente
  limit 25;
end;
$function$;

revoke execute on function public.buscar_cliente_expo(text) from public, anon;
grant  execute on function public.buscar_cliente_expo(text) to authenticated, service_role;


-- ---------------------------------------------------------------------
-- 6) Métricas del panel "Clientes Expo pend." (dashboard).
--    SECURITY DEFINER, gate de admin adentro. anon revocado.
-- ---------------------------------------------------------------------
create or replace function public.expo_dashboard()
returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v jsonb;
begin
  if not exists (select 1 from admins a where a.auth_user_id = auth.uid()) then
    raise exception 'no autorizado';
  end if;
  select jsonb_build_object(
    'clientes_total',      (select count(*) from expo_clientes_pendientes),
    'clientes_pendientes', (select count(*) from expo_clientes_pendientes where estado = 'pendiente'),
    'clientes_cargados',   (select count(*) from expo_clientes_pendientes where estado = 'cargado_erp'),
    'pedidos_count',       (select count(*) from orders o
                              where o.customer_id in (select customer_id from expo_clientes_pendientes where customer_id is not null)),
    'pedidos_monto',       (select coalesce(sum(o.total),0) from orders o
                              where o.customer_id in (select customer_id from expo_clientes_pendientes where customer_id is not null))
  ) into v;
  return v;
end;
$function$;

revoke execute on function public.expo_dashboard() from public, anon;
grant  execute on function public.expo_dashboard() to authenticated, service_role;

-- =====================================================================
-- FIN. Verificación rápida (opcional):
--   select public.expo_peek_cod();               -- próximo código
--   select * from public.expo_dto_escala order by desde;
--   select public.expo_dashboard();              -- {} de métricas (logueado admin)
-- =====================================================================
