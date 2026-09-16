-- Códigos E de los utensilios de acero inoxidable — 2026-09-16
-- Pedido de Thomas: los artículos pasan a llevar "E" al final (630 → 630E, …),
-- "salvo los que tengamos stock hoy sin la E".
--
-- Correr en el SQL Editor de ESTE proyecto (nkhzocgdpwtgrmwleihr).
--
-- ── Qué se corrige AHORA y qué NO ─────────────────────────────────────────────
-- El corte lo da el stock medido en Gestión Virgilio el 2026-09-16
-- (`public.vista_saldos_stock`: terminado + excedente + racks + …):
--
--   630 → 0      ✅ pasa a 630E
--   631 → 0      ✅ pasa a 631E
--   634 → 24     ⛔ queda (12 terminado + 12 excedente)
--   635 → 11     ⛔ queda
--   636 → 20     ⛔ queda (4 + 16)
--
-- Los tres que quedan se corrigen recién cuando ese stock llegue a 0 (bloque 5).
--
-- ── Por qué RENOMBRAR y no crear un producto nuevo ────────────────────────────
-- Es el mismo artículo con otro código. `order_items` referencia `product_id`
-- (uuid), no el texto del código, así que ningún pedido viejo se rompe y el
-- producto conserva precio, imágenes, categoría, orden de catálogo y ranking.
--
-- El bulto NO cambia: **todos van x12** (confirmado por Thomas el 16/09), que es
-- lo que ya dice `uxb` acá, `OC_Maximos` y `Articulos_Cajas` de Gestión.
--
-- Aguas abajo no hay que tocar nada: `precios_venta_chef` de Gestión es espejo de
-- este catálogo, así que el precio pasa solo a figurar bajo el código nuevo.

-- ═══ 1) BACKUP — correr y GUARDAR el resultado antes de tocar nada ═════════════
select id, cod, description, uxb, list_price, active, category, subcategory,
       orden_catalogo, ranking, badge_status
  from public.products
 where cod in ('630','631','634','635','636','630E','631E','634E','635E','636E')
 order by cod;
-- Al 2026-09-16 devuelve 5 filas, todas SIN la E.

-- ═══ 2) EL CAMBIO ═════════════════════════════════════════════════════════════
-- El `and cod = '...'` es a propósito: si alguien ya lo renombró, toca 0 filas.
update public.products set cod = '630E'
 where id = 'd006e49c-4064-4efb-8869-c05986d06a29' and cod = '630';   -- Cucharón Ac. Inox.
update public.products set cod = '631E'
 where id = '6215de36-16d2-435b-bb68-6aea8daaa151' and cod = '631';   -- Espumadera Ac. Inox.

-- ═══ 3) VERIFICACIÓN ══════════════════════════════════════════════════════════
select cod, description, uxb, list_price, active from public.products
 where id in ('d006e49c-4064-4efb-8869-c05986d06a29','6215de36-16d2-435b-bb68-6aea8daaa151');
-- Esperado: 630E Cucharón Ac. Inox. · 631E Espumadera Ac. Inox., uxb 12 los dos.

-- ═══ 4) ROLLBACK (si hiciera falta) ═══════════════════════════════════════════
-- update public.products set cod = '630' where id = 'd006e49c-4064-4efb-8869-c05986d06a29';
-- update public.products set cod = '631' where id = '6215de36-16d2-435b-bb68-6aea8daaa151';

-- ═══ 5) Cuando 634 / 635 / 636 lleguen a stock 0 ══════════════════════════════
-- Medir primero, en GESTIÓN (hrxfctzncixxqmpfhskv):
--   select cod_art, coalesce(terminado,0)+coalesce(excedente,0)+coalesce(separar_pedidos,0)
--        + coalesce(a_facturar,0)+coalesce(a_guardar,0)+coalesce(racks,0)
--        + coalesce(racks_ch,0)+coalesce(para_envasar,0) total
--     from public.vista_saldos_stock where upper(btrim(cod_art)) in ('634','635','636');
-- update public.products set cod = '634E' where id = 'd91ef2e8-8ad2-49bf-892b-2919891003f6' and cod = '634';  -- Cuchara Calada
-- update public.products set cod = '635E' where id = '3b749e49-8bce-4875-bfd0-c94e0810ecd4' and cod = '635';  -- Espátula Lisa
-- update public.products set cod = '636E' where id = '199505b7-8c05-4d60-9943-de628cb6f8c4' and cod = '636';  -- Espátula Calada
