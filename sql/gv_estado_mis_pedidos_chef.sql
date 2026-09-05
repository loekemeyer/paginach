-- =============================================================================
-- gv_estado_mis_pedidos_chef.sql — el estado del pedido en Gestión Virgilio, en "Mis pedidos"
-- Proyecto Supabase de CHEF (nkhzocgdpwtgrmwleihr) · ideas 8743 + 4990 · 2026-09-05
-- =============================================================================
-- Espejo de lo que LK tiene desde la v2.3.301 (pagina-LK-copia/sql/gv_estado_mis_pedidos.sql).
--
-- QUÉ HACE:
--   1. Conecta Chef con Virgilio por postgres_fdw (server `virgilio_db`) con el rol de
--      SÓLO LECTURA `ch_ppp_reader`, que ya existe en Virgilio (v13.09; mismos SELECT
--      que `lk_ppp_reader`, sin escritura, sin bypassrls).
--   2. Importa la vista `gv_pedido_web_estado_pagina` de Virgilio al schema `virgilio`:
--      un estado por (empresa, order_id) — sin_programar / programado / en_picking /
--      pickeado / en_armado / armado / facturado / entregado — con fecha_entrega, tanda,
--      facturado y entregado.
--   3. RPC `gv_estado_mis_pedidos(p_ids)`: devuelve ese estado SÓLO para los pedidos del
--      usuario logueado (dueño, vendedor vinculado o admin), con empresa = 'chef'.
--   4. `edit_order_fast` suma el candado: facturado o entregado en Gestión → no editable
--      (además del de enviado_a_compras_at, que queda).
--
-- ANTES DE CORRERLO — dos cosas del dueño:
--   (a) En VIRGILIO (hrxfctzncixxqmpfhskv), SQL editor, elegir una contraseña y ponerla:
--         alter role ch_ppp_reader password 'LA-CONTRASEÑA';
--   (b) Acá abajo, reemplazar LA-CONTRASEÑA en el `create user mapping` por la misma.
--   Correr el archivo entero después. Si `create extension` dice que ya existe, sigue.
--
-- PROBAR (en Chef, después):
--   select * from virgilio.gv_pedido_web_estado_pagina where empresa = 'chef' limit 5;
--   -- 0 filas es normal hasta que Gestión programe el primer pedido de Chef.
--
-- ROLLBACK (en Chef):
--   drop function if exists public.gv_estado_mis_pedidos(bigint[]);
--   drop foreign table if exists virgilio.gv_pedido_web_estado_pagina;
--   drop user mapping if exists for postgres server virgilio_db;
--   drop server if exists virgilio_db cascade;
--   -- y edit_order_fast sin el bloque 8743 (sql/edit_order_fast_chef.sql).
-- =============================================================================

-- ── 1. FDW hacia Virgilio ─────────────────────────────────────────────────────
create extension if not exists postgres_fdw;

create server if not exists virgilio_db
  foreign data wrapper postgres_fdw
  options (host 'db.hrxfctzncixxqmpfhskv.supabase.co', port '5432', dbname 'postgres', sslmode 'require');

-- ⚠ Reemplazar LA-CONTRASEÑA (la misma que se puso en Virgilio con `alter role`).
create user mapping if not exists for postgres
  server virgilio_db
  options (user 'ch_ppp_reader', password 'LA-CONTRASEÑA');

create schema if not exists virgilio;

-- ── 2. La vista de estado, importada ──────────────────────────────────────────
import foreign schema public limit to (gv_pedido_web_estado_pagina)
  from server virgilio_db into virgilio;

-- ── 3. RPC para "Mis pedidos" ─────────────────────────────────────────────────
create or replace function public.gv_estado_mis_pedidos(p_ids bigint[])
returns table(order_id bigint, estado text, rango integer, bloques integer, fecha_entrega date,
              tanda text, estado_desde timestamptz, entregado_at timestamptz, facturado boolean, entregado boolean)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if auth.uid() is null then return; end if;
  return query
    select g.order_id, g.estado, g.rango, g.bloques, g.fecha_entrega, g.tanda,
           g.estado_desde, g.entregado_at, g.facturado, g.entregado
      from virgilio.gv_pedido_web_estado_pagina g
      join orders o on o.id = g.order_id
     where g.empresa = 'chef'
       and g.order_id = any(coalesce(p_ids, '{}'))
       and (o.auth_user_id = auth.uid()
            or exists (select 1 from user_customer_links ucl
                        where ucl.auth_user_id = auth.uid() and ucl.customer_id = o.customer_id)
            or exists (select 1 from admins a where a.auth_user_id = auth.uid()));
end $$;
revoke all on function public.gv_estado_mis_pedidos(bigint[]) from public, anon;
grant execute on function public.gv_estado_mis_pedidos(bigint[]) to authenticated, service_role;

-- ── 4. edit_order_fast: facturado o entregado en Gestión → no editable ────────
-- Es la misma función de sql/edit_order_fast_chef.sql con el bloque 8743 agregado
-- después del chequeo de enviado_a_compras_at.
create or replace function public.edit_order_fast(
  p_order_id     bigint,
  p_auth_user_id uuid,
  p_customer_id  uuid,
  p_items        jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_enviado  timestamptz;
  v_owner    uuid;
  v_es_admin boolean;
  v_bajan    text;
  v_pay      jsonb;
  v_items    jsonb;
  v_web      numeric;
  v_pago     numeric;
  v_subtotal numeric;
  v_total    numeric;
  v_mas      numeric := 0;
  v_lineas   int := 0;
  r          record;
begin
  if p_auth_user_id is distinct from auth.uid() then
    raise exception 'Unauthorized: auth_user_id mismatch';
  end if;

  v_es_admin := exists (select 1 from admins a where a.auth_user_id = auth.uid());

  if not exists (select 1 from customers c where c.id = p_customer_id and c.auth_user_id = auth.uid())
     and not exists (select 1 from user_customer_links ucl where ucl.auth_user_id = auth.uid() and ucl.customer_id = p_customer_id)
     and not v_es_admin then
    raise exception 'Unauthorized: customer mismatch';
  end if;

  select o.enviado_a_compras_at, o.customer_id, coalesce(o.sheets_payload, '{}'::jsonb),
         coalesce(o.web_discount, 0), coalesce(o.payment_discount, 0), coalesce(o.subtotal, 0)
    into v_enviado, v_owner, v_pay, v_web, v_pago, v_subtotal
    from orders o where o.id = p_order_id for update;
  if not found then raise exception 'Pedido inexistente'; end if;
  if v_owner is distinct from p_customer_id then
    raise exception 'Unauthorized: order does not belong to customer';
  end if;
  if v_enviado is not null then
    raise exception 'Pedido ya enviado a compras: no editable' using errcode = 'check_violation';
  end if;

  -- Idea 8743: facturado o entregado en Gestión Virgilio → no se puede modificar.
  -- Si Virgilio no responde (FDW caído) no se bloquea: manda el candado de arriba.
  begin
    if exists (select 1 from virgilio.gv_pedido_web_estado_pagina g
                where g.empresa = 'chef' and g.order_id = p_order_id and (g.facturado or g.entregado)) then
      raise exception 'Pedido ya facturado: no se puede modificar.' using errcode = 'check_violation';
    end if;
  exception
    when check_violation then raise;
    when others then raise warning 'edit_order_fast: sin estado de Gestión (%)', sqlerrm;
  end;

  if not v_es_admin then
    select string_agg(coalesce(p.cod, viejo.pid::text), ', ')
      into v_bajan
      from (select oi.product_id as pid, sum(oi.cajas)::int as cajas
              from order_items oi where oi.order_id = p_order_id group by 1) viejo
      left join (select (i->>'product_id')::uuid as pid, sum((i->>'cajas')::int) as cajas
                   from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i group by 1) nuevo
             on nuevo.pid = viejo.pid
      left join products p on p.id = viejo.pid
     where coalesce(nuevo.cajas, 0) < viejo.cajas;
    if v_bajan is not null then
      raise exception 'Al pedido sólo se le puede AGREGAR: no se pueden quitar productos ni bajar cantidades (%). Si necesitás sacar algo, escribinos.', v_bajan
        using errcode = 'check_violation';
    end if;
  end if;

  v_items := coalesce(v_pay->'items', '[]'::jsonb);
  for r in
    select n.pid, n.cajas - coalesce(viejo.cajas, 0) as delta, n.uxb, n.uyp, n.ulp,
           coalesce(nullif(n.cod_art, ''), p.cod) as cod_art
      from (select (i->>'product_id')::uuid as pid, sum((i->>'cajas')::int) as cajas,
                   max((i->>'uxb')::int) as uxb,
                   max((i->>'unit_your_price')::numeric) as uyp,
                   max((i->>'unit_list_price')::numeric) as ulp,
                   max(i->>'cod_art') as cod_art
              from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) i group by 1) n
      left join (select oi.product_id as pid, sum(oi.cajas)::int as cajas
                   from order_items oi where oi.order_id = p_order_id group by 1) viejo on viejo.pid = n.pid
      left join products p on p.id = n.pid
     where n.cajas - coalesce(viejo.cajas, 0) > 0
  loop
    insert into order_items (order_id, product_id, cajas, uxb, unit_your_price, unit_list_price)
    values (p_order_id, r.pid, r.delta, r.uxb, r.uyp, r.ulp);
    v_lineas := v_lineas + 1;
    v_mas := v_mas + coalesce(r.uyp, 0) * r.delta * coalesce(r.uxb, 0);
    if exists (select 1 from jsonb_array_elements(v_items) e where upper(btrim(e->>'cod_art')) = upper(btrim(r.cod_art))) then
      select jsonb_agg(case when upper(btrim(e->>'cod_art')) = upper(btrim(r.cod_art))
                            then e || jsonb_build_object('cajas', coalesce((e->>'cajas')::numeric, 0) + r.delta)
                            else e end)
        into v_items from jsonb_array_elements(v_items) e;
    else
      v_items := v_items || jsonb_build_array(jsonb_build_object('cod_art', r.cod_art, 'cajas', r.delta, 'uxb', r.uxb));
    end if;
  end loop;

  if v_lineas = 0 then
    raise exception 'No agregaste nada nuevo al pedido.' using errcode = 'check_violation';
  end if;

  v_subtotal := v_subtotal + v_mas;
  v_total := v_subtotal * (1 - v_web) * (1 - v_pago);

  update orders
     set subtotal = v_subtotal,
         total = v_total,
         sheets_payload = v_pay || jsonb_build_object('items', v_items, 'order_total', v_total, 'editado_at', now())
   where id = p_order_id;

  return jsonb_build_object('order_id', p_order_id, 'lineas', v_lineas, 'subtotal', v_subtotal, 'total', v_total);
end;
$function$;
