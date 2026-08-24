-- ============================================================================
-- expo_guardar_cliente  — alta/edición de cliente de expo o de vendedor
-- ----------------------------------------------------------------------------
-- Persiste en UNA transacción: customers (insert/update) + direcciones de
-- entrega + staging del ERP (expo_clientes_pendientes). Reemplaza los 3 inserts
-- directos que hacía el front, que RLS bloqueaba para un VENDEDOR (solo admin
-- podía insertar en customers).
--
-- AUTORIZA: admin O vendedor (auth_user_id con filas en user_customer_links).
-- Al crear, si el que llama es vendedor, VINCULA el cliente a su cartera.
-- Un vendedor solo puede EDITAR clientes que sigan en el staging de expo
-- (no clientes ya establecidos en el ERP).
--
-- SECURITY DEFINER + revoke a public/anon.
-- ============================================================================

create or replace function public.expo_guardar_cliente(
  p_id uuid,
  p_cust jsonb,
  p_addrs jsonb,
  p_staging jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_admin boolean;
  v_vend  boolean;
  v_id    uuid;
begin
  v_admin := exists (select 1 from admins a where a.auth_user_id = auth.uid());
  v_vend  := exists (select 1 from user_customer_links l where l.auth_user_id = auth.uid());
  if not v_admin and not v_vend then
    raise exception 'no autorizado';
  end if;

  if p_id is null then
    insert into customers (
      business_name, cuit, cod_cliente, dto_vol, vend, mail, whatsapp,
      direccion_fiscal, localidad, escala_activa, pin, auth_user_id
    ) values (
      p_cust->>'business_name',
      nullif(p_cust->>'cuit',''),
      nullif(p_cust->>'cod_cliente','')::bigint,
      coalesce((p_cust->>'dto_vol')::numeric, 0),
      nullif(p_cust->>'vend',''),
      nullif(p_cust->>'mail',''),
      nullif(p_cust->>'whatsapp',''),
      nullif(p_cust->>'direccion_fiscal',''),
      nullif(p_cust->>'localidad',''),
      coalesce((p_cust->>'escala_activa')::boolean, true),
      nullif(p_cust->>'pin',''),
      nullif(p_cust->>'auth_user_id','')::uuid
    ) returning id into v_id;

    if not v_admin and v_vend then
      insert into user_customer_links (auth_user_id, customer_id)
      values (auth.uid(), v_id)
      on conflict do nothing;
    end if;
  else
    v_id := p_id;
    if not v_admin and not exists (
      select 1 from expo_clientes_pendientes s where s.customer_id = v_id
    ) then
      raise exception 'no autorizado (cliente fuera de expo)';
    end if;
    update customers set
      business_name    = p_cust->>'business_name',
      cuit             = nullif(p_cust->>'cuit',''),
      cod_cliente      = nullif(p_cust->>'cod_cliente','')::bigint,
      dto_vol          = coalesce((p_cust->>'dto_vol')::numeric, 0),
      vend             = nullif(p_cust->>'vend',''),
      mail             = nullif(p_cust->>'mail',''),
      whatsapp         = nullif(p_cust->>'whatsapp',''),
      direccion_fiscal = nullif(p_cust->>'direccion_fiscal',''),
      localidad        = nullif(p_cust->>'localidad',''),
      escala_activa    = coalesce((p_cust->>'escala_activa')::boolean, true),
      auth_user_id     = coalesce(nullif(p_cust->>'auth_user_id','')::uuid, auth_user_id)
    where id = v_id;
  end if;

  delete from customer_delivery_addresses where customer_id = v_id;
  if coalesce(jsonb_array_length(p_addrs), 0) > 0 then
    insert into customer_delivery_addresses (
      customer_id, slot, label, direccion_entrega, localidad, provincia, nombre_expreso
    )
    select v_id,
      (a->>'slot')::smallint,
      a->>'label',
      nullif(a->>'direccion_entrega',''),
      nullif(a->>'localidad',''),
      nullif(a->>'provincia',''),
      nullif(a->>'nombre_expreso','')
    from jsonb_array_elements(p_addrs) a;
  end if;

  delete from expo_clientes_pendientes where customer_id = v_id;
  if p_staging is not null then
    insert into expo_clientes_pendientes (
      customer_id, cod_cliente, business_name, cuit, direccion, numero, cp,
      localidad, provincia, condicion_iva, telefono, whatsapp, mail, vend,
      dto_vol, pin, direcciones_entrega, estado, actualizado_at
    ) values (
      v_id,
      nullif(p_staging->>'cod_cliente','')::bigint,
      p_staging->>'business_name',
      nullif(p_staging->>'cuit',''),
      nullif(p_staging->>'direccion',''),
      nullif(p_staging->>'numero',''),
      nullif(p_staging->>'cp',''),
      nullif(p_staging->>'localidad',''),
      nullif(p_staging->>'provincia',''),
      nullif(p_staging->>'condicion_iva',''),
      nullif(p_staging->>'telefono',''),
      nullif(p_staging->>'whatsapp',''),
      nullif(p_staging->>'mail',''),
      nullif(p_staging->>'vend',''),
      coalesce((p_staging->>'dto_vol')::numeric, 0),
      nullif(p_staging->>'pin',''),
      coalesce(p_staging->'direcciones_entrega', '[]'::jsonb),
      coalesce(nullif(p_staging->>'estado',''), 'pendiente'),
      now()
    );
  end if;

  return v_id;
end $$;

revoke execute on function public.expo_guardar_cliente(uuid,jsonb,jsonb,jsonb) from public, anon;
grant  execute on function public.expo_guardar_cliente(uuid,jsonb,jsonb,jsonb) to authenticated, service_role;
