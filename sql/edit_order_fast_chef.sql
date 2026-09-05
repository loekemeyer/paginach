-- =============================================================================
-- edit_order_fast_chef.sql — candado SERVER para "Editar pedido: sólo agregar"
-- Proyecto Supabase de CHEF (nkhzocgdpwtgrmwleihr) · idea 4990 · 2026-09-05
-- =============================================================================
-- ✅ APLICADO por el dueño en el SQL editor del proyecto Chef el 2026-09-05 (desde
--   Gestión Virgilio no hay acceso a ese proyecto). Desde la v2.0.30 de la página
--   `_editOrderChef()` llama a esta RPC; el insert/update directo de la v2.0.29
--   quedó atrás.
--
-- ANTES (v2.0.29): el front INSERTABA sólo las líneas nuevas en order_items y
-- actualizaba orders (subtotal, total, sheets_payload), con el candado "sólo
-- agregar" de UI + chequeo en el front. Cualquiera que llamara la REST a mano
-- podía borrar filas (la policy de delete de order_items existe: la usa
-- rollbackOrder cuando falla la carga de un pedido nuevo).
--
-- QUÉ HACE ESTE ARCHIVO: la misma regla que en LK, en el server.
--   1. RPC `edit_order_fast` (SECURITY DEFINER): valida dueño, ventana
--      (enviado_a_compras_at is null), que ninguna línea baje ni desaparezca
--      (sumado por producto; admins exceptuados), inserta el delta, actualiza
--      la cabecera y REESCRIBE sheets_payload.items (lo que leen Gestión
--      Virgilio y el mail de las 12:30).
--   2. (Opcional, comentado) sacarle al cliente el UPDATE/DELETE directo sobre
--      order_items. ⚠ Antes de hacerlo, mirar rollbackOrder() en script.js:
--      borra order_items+orders si falla la carga de un pedido nuevo. Con la
--      policy de delete cerrada, ese rollback dejaría un pedido a medias.
--      Alternativa: policy de delete sólo si el pedido tiene < 10 minutos.
--
-- EL FRONT (script.js, _editOrderChef) llama:
--   supabaseClient.rpc("edit_order_fast", { p_order_id, p_auth_user_id,
--   p_customer_id, p_items: [{product_id, cajas, uxb, unit_your_price,
--   unit_list_price, cod_art}] })   ← el carrito COMPLETO, no el delta.
--   Devuelve {order_id, lineas, subtotal, total}. Test: tests/editar-pedido.cjs.
--
-- ROLLBACK: drop function public.edit_order_fast(bigint, uuid, uuid, jsonb);
-- =============================================================================

create or replace function public.edit_order_fast(
  p_order_id     bigint,
  p_auth_user_id uuid,
  p_customer_id  uuid,
  p_items        jsonb)   -- [{product_id, cajas, uxb, unit_your_price, unit_list_price, cod_art}] = el carrito COMPLETO
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

  -- Pertenencia: dueño del customer, vendedor vinculado o admin (igual que LK).
  if not exists (select 1 from customers c where c.id = p_customer_id and c.auth_user_id = auth.uid())
     and not exists (select 1 from user_customer_links ucl where ucl.auth_user_id = auth.uid() and ucl.customer_id = p_customer_id)
     and not v_es_admin then
    raise exception 'Unauthorized: customer mismatch';
  end if;

  -- El pedido: de este cliente y todavía sin salir a compras. FOR UPDATE para
  -- serializar contra el cron de las 12:30 que setea enviado_a_compras_at.
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

  -- SÓLO AGREGAR: para cada producto que ya está, lo que llega trae al menos las
  -- mismas cajas (sumado por producto). Admin exceptuado (salida de emergencia).
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

  -- El delta → filas NUEVAS en order_items (nunca se toca una fila existente) y
  -- se suma a sheets_payload.items (misma línea si el código ya está; si no, al final).
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

revoke all on function public.edit_order_fast(bigint, uuid, uuid, jsonb) from public, anon;
grant execute on function public.edit_order_fast(bigint, uuid, uuid, jsonb) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. (OPCIONAL) Cerrar el UPDATE/DELETE directo del cliente sobre order_items.
--    Mirar primero: select polname, polcmd, pg_get_expr(polqual, polrelid)
--                     from pg_policy where polrelid = 'public.order_items'::regclass;
--    y acordarse de rollbackOrder() (ver encabezado). Ejemplo de delete acotado:
--
-- drop policy if exists order_items_delete_own on public.order_items;
-- create policy order_items_delete_reciente on public.order_items for delete to authenticated
--   using (exists (select 1 from orders o
--                   where o.id = order_items.order_id
--                     and o.auth_user_id = auth.uid()
--                     and o.created_at > now() - interval '10 minutes'
--                     and o.enviado_a_compras_at is null));
-- -----------------------------------------------------------------------------
