-- =====================================================================
-- Modulo "Consulta de clientes"  (consulta.html + consulta.js)  ·  CHEF
-- =====================================================================
-- Gemelo del modulo de Loekemeyer (repo pagina-LK-copia,
-- sql/consulta_clientes.sql). Acceso de SOLO LECTURA para un empleado que
-- no es admin y tampoco es cliente: entra con CUIT + clave (mismo esquema
-- sintetico <digitos>@cuit.loekemeyer que usan las dos paginas) y ve, por
-- cliente:
--
--   1) que le compra hoy                    -> consulta_historial(p_cod)
--   2) que NO le compra y deberia comprarle -> consulta_faltantes(p_cod)
--
-- El cliente se elige por razon social, CUIT o codigo -> consulta_buscar_clientes.
--
-- ⚠ LAS NUMERACIONES DE CHEF Y LOEKEMEYER SON INDEPENDIENTES. Este modulo
-- mide SOLO Chef, contra la base de Chef (nkhzocgdpwtgrmwleihr). El mismo
-- codigo de cliente es otro negocio en cada empresa.
--
-- SEGURIDAD: las cinco RPC son SECURITY DEFINER, llevan el guard adentro y
-- ademas tienen EXECUTE revocado a PUBLIC/anon (Postgres le da EXECUTE a
-- PUBLIC a toda funcion nueva, y anon hereda de PUBLIC). El guard va con un
-- IF de plpgsql y NO colgado del FROM de una funcion SQL: Postgres elimina
-- una subconsulta de una fila cuyas columnas no se referencian y el guard
-- quedaria sin evaluarse.
--
-- ---------------------------------------------------------------------
-- DIFERENCIAS CONTRA LA VERSION DE LOEKEMEYER, Y POR QUE
-- ---------------------------------------------------------------------
-- La base de Chef no tiene los objetos auxiliares que si tiene la de LK, asi
-- que este archivo es AUTOCONTENIDO: lo unico que necesita son las tablas que
-- Chef ya usa en su pagina (sales_lines, customers, products, item_groups,
-- app_settings, admins).
--
--   * normalizacion de texto: `consulta_norm()` propia, en vez de ficha_norm.
--   * precios: `products` directo, en vez de v_item_precio (Chef no tiene ni
--     item_precios ni el cache de precios de LK).
--   * sin normalizacion de sufijo L: no existe item_precios.base_cod aca.
--   * sin filtro de sales_excluded_items: esa tabla es de LK. ⚠ Si Chef llega
--     a tener codigos administrativos en sales_lines (descuentos por pago,
--     notas de credito), hay que crear la tabla y filtrarla, o corren la
--     fecha de ultima compra.
--   * sin exclusion de cadenas de supermercado del universo de penetracion:
--     la lista vive en precios_super.cadena, que es de LK. Es un matiz del
--     denominador, no un error; si molesta, se agregan los codigos de super
--     de Chef a mano en el CTE `univ`.
--   * sin filtro `empresa`: esta base es solo Chef.
--
-- Lo que SI se respeta, igual que en LK:
--   * una devolucion no es una compra: las cajas se suman solo si boxes > 0.
--   * "ultima compra" NO es max(invoice_date): en LK habia 390 lineas con
--     boxes = 0 y 6.611 negativas, y el max pelado mostraba como ultima
--     compra un cero mensual o una devolucion. Va con
--     max(invoice_date) FILTER (WHERE boxes > 0).
--   * invoice_date es TEXTO ISO (YYYY-MM-DD), asi que se compara como texto:
--     ordena y compara bien, y no rompe el plan con un cast por fila.
--
-- ⚠ ESTE ARCHIVO NO SE EJECUTA SOLO. Se corre a mano en el SQL editor del
-- proyecto de Chef. Despues de correrlo, PROBARLO (no leerlo) con:
--   select * from public.consulta_buscar_clientes('<parte de una razon social>', 10);
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Quien puede entrar
-- ---------------------------------------------------------------------
create table if not exists public.consulta_usuarios (
  auth_user_id uuid primary key,
  nombre       text        not null,
  activo       boolean     not null default true,
  nota         text,
  creado_at    timestamptz not null default now(),
  creado_por   uuid
);

alter table public.consulta_usuarios enable row level security;

drop policy if exists consulta_usuarios_self on public.consulta_usuarios;
create policy consulta_usuarios_self on public.consulta_usuarios
  for select to authenticated
  using (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. Normalizacion de texto (propia: Chef no tiene ficha_norm)
-- ---------------------------------------------------------------------
create or replace function public.consulta_norm(p text)
returns text language sql immutable as $$
  select regexp_replace(
           lower(translate(coalesce(p,''),
             'áéíóúàèìòùäëïöüâêîôûãõñÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÃÕÑ',
             'aeiouaeiouaeiouaeiouaonAEIOUAEIOUAEIOUAEIOUAON')),
           '[^a-z0-9]+', ' ', 'g');
$$;

-- ---------------------------------------------------------------------
-- 3. Guard
-- ---------------------------------------------------------------------
create or replace function public.consulta_es_usuario()
returns boolean language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from public.consulta_usuarios cu
                  where cu.auth_user_id = auth.uid() and cu.activo)
      or exists (select 1 from public.admins a where a.auth_user_id = auth.uid());
$$;

create or replace function public.consulta_perfil()
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.consulta_es_usuario() then
    return jsonb_build_object('ok', false);
  end if;
  select jsonb_build_object(
           'ok', true,
           'nombre', coalesce((select cu.nombre from public.consulta_usuarios cu
                                where cu.auth_user_id = auth.uid()), 'Administrador'),
           'es_admin', exists (select 1 from public.admins a where a.auth_user_id = auth.uid())
         ) into v;
  return v;
end
$$;

-- ---------------------------------------------------------------------
-- 4. Buscador de clientes (razon social / CUIT / codigo)
-- ---------------------------------------------------------------------
-- El CUIT se compara SOLO por digitos y exige al menos 6: sin ese piso,
-- buscar el codigo "996" devuelve ademas todos los clientes cuyo CUIT
-- contiene "996" en algun lado.
create or replace function public.consulta_buscar_clientes(p_q text, p_limit integer default 30)
returns table(cod_cliente text, business_name text, cuit text, ultima_compra date, cajas_12m numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_q   text := public.consulta_norm(coalesce(p_q, ''));
  v_dig text := regexp_replace(coalesce(p_q, ''), '\D', '', 'g');
  v_d12 text := to_char(current_date - interval '12 months', 'YYYY-MM-DD');
  v_lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if not public.consulta_es_usuario() then raise exception 'no autorizado'; end if;
  v_q := btrim(v_q);
  if v_q = '' then return; end if;
  return query
  with cand as (
    select c.cod_cliente::text as cod,
           coalesce(c.business_name, '(sin razon social)') as nom,
           c.cuit as cu
      from public.customers c
     where c.cod_cliente::text = v_dig
        or public.consulta_norm(coalesce(c.business_name, '')) like '%' || v_q || '%'
        or (length(v_dig) >= 6
            and regexp_replace(coalesce(c.cuit, ''), '\D', '', 'g') like '%' || v_dig || '%')
     order by public.consulta_norm(coalesce(c.business_name, ''))
     limit v_lim
  )
  select cand.cod, cand.nom, cand.cu, m.ultima, coalesce(m.cajas, 0)
    from cand
    left join lateral (
      select max(s.invoice_date) filter (where s.boxes > 0)::date as ultima,
             sum(case when s.boxes > 0 and s.invoice_date >= v_d12 then s.boxes else 0 end)::numeric as cajas
        from public.sales_lines s
       where s.customer_code = cand.cod
    ) m on true
   order by m.ultima desc nulls last, cand.nom;
end
$$;

-- ---------------------------------------------------------------------
-- 5. Que le compra (historial por articulo)
-- ---------------------------------------------------------------------
-- neto_12m valoriza con la cadena completa: cajas * uxb * list_price *
-- (1-dto_vol) * (1-web_order_discount). list_price es POR UNIDAD, no por
-- caja: sin el uxb el monto sale dividido por las unidades por caja.
create or replace function public.consulta_historial(p_cod text)
returns table(cod text, descripcion text, categoria text, cajas_12m numeric,
              cajas_prev12 numeric, cajas_hist numeric, ultima_compra date, neto_12m numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_d12 text    := to_char(current_date - interval '12 months', 'YYYY-MM-DD');
  v_d24 text    := to_char(current_date - interval '24 months', 'YYYY-MM-DD');
  v_dto numeric := 0;
  v_web numeric := 0.02;
begin
  if not public.consulta_es_usuario() then raise exception 'no autorizado'; end if;
  select coalesce(c.dto_vol, 0) into v_dto
    from public.customers c where c.cod_cliente::text = p_cod limit 1;
  v_dto := coalesce(v_dto, 0);
  select coalesce(nullif(a.value, '')::numeric, 0.02) into v_web
    from public.app_settings a where a.key = 'web_order_discount';
  v_web := coalesce(v_web, 0.02);
  return query
  with agg as (
    select s.item_code as c,
           sum(case when s.boxes > 0 and s.invoice_date >= v_d12 then s.boxes else 0 end)::numeric as c12,
           sum(case when s.boxes > 0 and s.invoice_date >= v_d24 and s.invoice_date < v_d12 then s.boxes else 0 end)::numeric as cprev,
           sum(case when s.boxes > 0 then s.boxes else 0 end)::numeric as chist,
           max(s.invoice_date) filter (where s.boxes > 0) as ult
      from public.sales_lines s
     where s.customer_code = p_cod
     group by s.item_code
  )
  select agg.c,
         coalesce(p.description, '(sin alta en el padron)'),
         p.category,
         agg.c12, agg.cprev, agg.chist, agg.ult::date,
         round(agg.c12 * coalesce(p.uxb, 0) * coalesce(p.list_price, 0) * (1 - v_dto) * (1 - v_web), 2)
    from agg
    left join public.products p on p.cod = agg.c
   where agg.chist > 0
   order by agg.c12 desc, agg.ult desc nulls last;
end
$$;

-- ---------------------------------------------------------------------
-- 6. Que NO le compra y deberia comprarle
-- ---------------------------------------------------------------------
-- "Deberia" = penetracion: sobre los clientes de Chef que compraron algo en
-- los ultimos 12 meses, que porcentaje compra ESE articulo. Devuelve tambien
-- lo que el cliente compraba ANTES y dejo de comprar (ultima_compra /
-- cajas_hist), que es la fila mas accionable de todas.
-- Se respeta item_groups: si compra una variante del mismo grupo, el grupo
-- entero no es faltante.
create or replace function public.consulta_faltantes(p_cod text, p_limit integer default 200)
returns table(cod text, descripcion text, categoria text, pct_clientes numeric,
              clientes_compran integer, cajas_mercado numeric, cajas_prom_cliente numeric,
              ultima_compra date, cajas_hist numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_d12 text    := to_char(current_date - interval '12 months', 'YYYY-MM-DD');
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  if not public.consulta_es_usuario() then raise exception 'no autorizado'; end if;
  return query
  with univ as (
    select s.customer_code as cc, s.item_code as c, s.boxes as bx
      from public.sales_lines s
     where s.invoice_date >= v_d12 and s.boxes > 0
  ),
  tot as (select count(distinct univ.cc)::numeric as n from univ),
  pen as (select univ.c, count(distinct univ.cc)::numeric as cli, sum(univ.bx)::numeric as cj
            from univ group by univ.c),
  mio as (
    select distinct s.item_code as c
      from public.sales_lines s
     where s.customer_code = p_cod and s.invoice_date >= v_d12 and s.boxes > 0
  ),
  grp as (select distinct ig.group_id from public.item_groups ig join mio on mio.c = ig.item_code),
  hist as (
    select s.item_code as c,
           max(s.invoice_date) filter (where s.boxes > 0) as ult,
           sum(case when s.boxes > 0 then s.boxes else 0 end)::numeric as cj
      from public.sales_lines s
     where s.customer_code = p_cod
     group by s.item_code
  )
  select p.cod::text, p.description, p.category,
         round(pen.cli * 100.0 / nullif(tot.n, 0), 0),
         pen.cli::integer, pen.cj,
         round(pen.cj / nullif(pen.cli, 0), 1),
         h.ult::date, coalesce(h.cj, 0)
    from public.products p
    join pen on pen.c = p.cod::text
   cross join tot
    left join public.item_groups pig on pig.item_code = p.cod::text
    left join hist h on h.c = p.cod::text
   where p.active = true
     and coalesce(p.badge_status, '') <> 'SIN STOCK'
     and not exists (select 1 from mio where mio.c = p.cod::text)
     and not exists (select 1 from grp where pig.group_id = grp.group_id)
   order by pen.cli desc, pen.cj desc
   limit v_lim;
end
$$;

-- ---------------------------------------------------------------------
-- 7. Permisos
-- ---------------------------------------------------------------------
revoke all on function public.consulta_es_usuario()                   from public, anon;
revoke all on function public.consulta_perfil()                       from public, anon;
revoke all on function public.consulta_buscar_clientes(text, integer)  from public, anon;
revoke all on function public.consulta_historial(text)                from public, anon;
revoke all on function public.consulta_faltantes(text, integer)       from public, anon;

grant execute on function public.consulta_es_usuario()                   to authenticated, service_role;
grant execute on function public.consulta_perfil()                       to authenticated, service_role;
grant execute on function public.consulta_buscar_clientes(text, integer)  to authenticated, service_role;
grant execute on function public.consulta_historial(text)                to authenticated, service_role;
grant execute on function public.consulta_faltantes(text, integer)       to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 8. Alta del usuario  (PASO MANUAL, la clave NO va escrita en el repo)
-- ---------------------------------------------------------------------
-- Es OTRO auth user que el de Loekemeyer aunque sea el mismo CUIT y la misma
-- clave: son dos proyectos de Supabase distintos y no comparten sesion.
-- OJO: email_change / confirmation_token / recovery_token van en '' y NUNCA
-- en null; gotrue rompe con "Database error finding user" si son null.
--
--   with u as (
--     insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
--       email_confirmed_at, created_at, updated_at,
--       confirmation_token, recovery_token, email_change, email_change_token_new,
--       raw_app_meta_data, raw_user_meta_data)
--     values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(),
--       'authenticated','authenticated','<digitos del CUIT>@cuit.loekemeyer',
--       extensions.crypt('<la clave>', extensions.gen_salt('bf')),
--       now(), now(), now(), '', '', '', '',
--       '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb)
--     returning id
--   )
--   insert into public.consulta_usuarios (auth_user_id, nombre, nota)
--   select u.id, '<Nombre>', 'Solo lectura, modulo de consulta (consulta.html).' from u
--   returning auth_user_id, nombre, activo;
--
-- Verificacion (tiene que dar clave_ok = true):
--   select u.email,
--          u.encrypted_password = extensions.crypt('<la clave>', u.encrypted_password) as clave_ok,
--          cu.nombre, cu.activo
--     from auth.users u join public.consulta_usuarios cu on cu.auth_user_id = u.id
--    where u.email = '<digitos del CUIT>@cuit.loekemeyer';
--
-- Baja sin borrar nada:
--   update public.consulta_usuarios set activo = false where auth_user_id = '<id>';
