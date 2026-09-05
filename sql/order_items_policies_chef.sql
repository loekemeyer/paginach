-- =============================================================================
-- order_items_policies_chef.sql — el cliente no borra ni edita líneas de un pedido viejo
-- Proyecto Supabase de CHEF (nkhzocgdpwtgrmwleihr) · idea 4990 · 2026-09-05
-- =============================================================================
-- POR QUÉ: la página inserta order_items directo (sin RPC) y `rollbackOrder()` BORRA
-- order_items + orders si falla la carga de un pedido nuevo. Para eso hoy hay una policy
-- de DELETE para el cliente. Con "Editar pedido" por RPC (edit_order_fast), el candado
-- "sólo agregar" ya vive en el server, pero cualquiera que llame la REST a mano todavía
-- puede borrar líneas de un pedido viejo con esa policy.
--
-- QUÉ HACE: reemplaza las policies de UPDATE/DELETE del cliente sobre order_items por
-- una sola de DELETE acotada: sólo líneas de un pedido PROPIO, de menos de 10 minutos y
-- que no salió a compras (lo que rollbackOrder necesita). Los admins siguen igual
-- (policy propia). El INSERT del cliente no se toca (lo usa la carga del pedido).
--
-- PASO 1 — MIRAR ANTES de tocar (pegar el resultado si hay dudas):
--   select polname, polcmd, polroles::regrole[], pg_get_expr(polqual, polrelid) as using_,
--          pg_get_expr(polwithcheck, polrelid) as with_check
--     from pg_policy where polrelid = 'public.order_items'::regclass order by polcmd, polname;
--   -- polcmd: r=select, a=insert, w=update, d=delete, *=all
--
-- PASO 2 — aplicar. El DO borra SÓLO las policies de update/delete (o ALL) cuyo rol sea
-- authenticated/public y que NO mencionen `admins` en su condición; deja las de admin.
-- ROLLBACK: recrear las que listó el paso 1 (guardar ese resultado antes).
-- =============================================================================

do $$
declare p record;
begin
  for p in
    select polname, polcmd
      from pg_policy
     where polrelid = 'public.order_items'::regclass
       and polcmd in ('w', 'd', '*')
       and coalesce(pg_get_expr(polqual, polrelid), '') not ilike '%admins%'
       and coalesce(pg_get_expr(polwithcheck, polrelid), '') not ilike '%admins%'
  loop
    raise notice 'order_items: se borra la policy % (%)', p.polname, p.polcmd;
    execute format('drop policy %I on public.order_items', p.polname);
  end loop;
end $$;

-- DELETE acotado: pedido propio, reciente, sin salir a compras (= el rollback de la carga).
create policy order_items_delete_reciente on public.order_items
  for delete to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_items.order_id
                    and o.enviado_a_compras_at is null
                    and o.created_at > now() - interval '10 minutes'
                    and (o.auth_user_id = auth.uid()
                         or exists (select 1 from public.user_customer_links ucl
                                     where ucl.auth_user_id = auth.uid() and ucl.customer_id = o.customer_id))));

-- Sin policy de UPDATE para el cliente: las líneas no se editan, se agregan (RPC).
-- Los admins conservan su policy (si existía); si no hay ninguna de admin y hace falta:
-- create policy order_items_admin_all on public.order_items for all to authenticated
--   using (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()))
--   with check (exists (select 1 from public.admins a where a.auth_user_id = auth.uid()));
