-- Escala activa: columna en customers
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS escala_activa boolean NOT NULL DEFAULT false;

-- RPC: fijar el dto y apagar la escala, atómicamente.
CREATE OR REPLACE FUNCTION public.fijar_dto_escala(p_customer_id uuid, p_dto numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM customers c
    WHERE c.id = p_customer_id
      AND c.escala_activa = true
      AND (c.auth_user_id = auth.uid()
           OR EXISTS (SELECT 1 FROM admins a WHERE a.auth_user_id = auth.uid()))
  ) THEN
    RAISE EXCEPTION 'no autorizado o escala no activa';
  END IF;

  UPDATE customers
    SET dto_vol = p_dto,
        escala_activa = false
  WHERE id = p_customer_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fijar_dto_escala(uuid, numeric) FROM public;
GRANT EXECUTE ON FUNCTION public.fijar_dto_escala(uuid, numeric) TO authenticated, service_role;
