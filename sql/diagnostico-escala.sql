-- ============================================================
-- DIAGNÓSTICO PARA CALIBRAR ESCALA DE DESCUENTO POR VOLUMEN
-- ============================================================
-- Correr en el SQL Editor de Supabase del proyecto CHEF
-- (https://supabase.com/dashboard → proyecto Chef → SQL Editor)
--
-- Copiar TODO el output y pegarlo a Claude para que calcule
-- los tramos equivalentes de expo_dto_escala.
-- ============================================================

-- 1) Estadísticas de precios de productos
SELECT
  'PRODUCTOS' as seccion,
  count(*)::text as total_productos,
  round(avg(list_price)::numeric, 2)::text as avg_list_price,
  round(percentile_cont(0.50) within group (order by list_price)::numeric, 2)::text as median_list_price,
  round(min(list_price)::numeric, 2)::text as min_list_price,
  round(max(list_price)::numeric, 2)::text as max_list_price,
  round(avg(uxb)::numeric, 1)::text as avg_uxb,
  round(avg(list_price * uxb)::numeric, 2)::text as avg_caja_list
FROM products
WHERE list_price > 0;

-- 2) Distribución de subtotales de pedidos (últimos 6 meses)
SELECT
  'ORDENES' as seccion,
  count(*)::text as total_orders,
  round(avg(subtotal)::numeric, 0)::text as avg_subtotal,
  round(percentile_cont(0.25) within group (order by subtotal)::numeric, 0)::text as p25,
  round(percentile_cont(0.50) within group (order by subtotal)::numeric, 0)::text as p50_median,
  round(percentile_cont(0.75) within group (order by subtotal)::numeric, 0)::text as p75,
  round(percentile_cont(0.90) within group (order by subtotal)::numeric, 0)::text as p90,
  round(max(subtotal)::numeric, 0)::text as max_subtotal
FROM orders
WHERE created_at > now() - interval '6 months';

-- 3) Tramos actuales (los heredados de LK, si existen)
SELECT 'ESCALA_ACTUAL' as seccion, desde::text, dto::text
FROM expo_dto_escala
ORDER BY desde ASC;
