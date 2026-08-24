# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Static multi-page site for **Chef SRL** (Argentine kitchen-utensil wholesaler, production domain **chefsrl.com**). Forked from the sister project [`loekemeyer/pagina-LK-copia`](https://github.com/loekemeyer/pagina-LK-copia) (Loekemeyer SRL). There is no build step, no bundler, no test harness — files are served as-is by IIS. All JS runs in the browser and talks directly to Supabase.

**Relación con Loekemeyer:** Chef y Loekemeyer son empresas hermanas. Comparten esquema de autenticación (CUIT sintético `<cuit>@cuit.loekemeyer`), códigos de vendedor ERP, y lista de expresos (la de Chef es fallback a la de LK). **Las numeraciones de clientes son INDEPENDIENTES** — el mismo código es un negocio distinto en cada empresa. Cuando un cliente cambia su PIN en Chef, `script.js` lo sincroniza al Supabase de Loekemeyer.

## Backend (Supabase)

### Proyecto primario — Chef SRL

- Project URL: `https://nkhzocgdpwtgrmwleihr.supabase.co`
- Anon key embebida en `config.js` y redeclarada en `script.js`, `admin.js`, `historial.js`, `sugerencias.js`. Si se rota, actualizar en TODOS esos archivos.
- `config.js` centraliza las constantes en `window.LK_CONFIG`, pero los archivos individuales también las hardcodean — hay duplicación por diseño (no hay módulos).

### Proyecto secundario — Loekemeyer (solo para sync)

- Project URL: `https://kwkclwhmoygunqmlegrg.supabase.co`
- Usado para: sincronización de PIN por CUIT y los proxies de Google Sheets del módulo de cotización de súper (`sheets-proxy`, `sheets-entregas-proxy`).

### Auth

- Email/password con email sintético `<cuit-digits>@cuit.loekemeyer` y PIN de 6 dígitos como password.
- Admin gateado por presencia del `auth_user_id` en la tabla `admins`; cada página de admin redirige a `mayorista.html` si falla ese chequeo.
- PPP admin (CUIT `30515842450`) tiene 2FA extra vía OTP por mail (Edge Function `admin-otp`).

### Edge Functions (Chef)

- `smooth-handler` — Google Sheets proxy para envío de pedidos.
- `sheets-entregas-proxy` — proxy de Sheets para direcciones de entrega.
- `notify-new-address` — notificación de nuevas direcciones de entrega.
- `admin-otp` — códigos OTP para login admin PPP.

### Tablas principales

`customers`, `customer_delivery_addresses`, `admins`, `user_customer_links`, `products`, `loke_products`, `item_groups`, `orders`, `order_items`, `app_settings`, `v_customer_item_month`, `supermarket_branch_mapping`, `estadistica_madre`, `expo_config`, `expo_clientes_pendientes`, `expo_dto_escala`.

### RPCs clave

`submit_order_fast`, `get_customer_history`, `get_customer_sales_history`, `sugerencias_cliente`, `novedades_marca`, `get_my_assortment_18m`, `get_my_linked_customers`, `get_my_group_customers`, `lookup_cuit_by_username`, `get_vendor_order_for_pdf`, `get_my_vendor_orders`, `run_ppp_cross_reference`, `get_procesar_pedidos_stats`, `get_procesar_pedidos_recent`, `get_all_sales_lines_admin`, `get_all_sales_lines_admin_with_customer`, `get_estadistica_madre_detail`, `expo_dashboard`, `expo_peek_cod`, `expo_reservar_cod`, `buscar_cliente_expo`, `get_super_prices`, `set_super_prices`, `get_customer_months_bulk`.

### Reglas de Supabase

- REST API limita a 1000 filas — `.from("tabla").select(...)` trunca sin error. **El trabajo pesado va en RPCs.**
- `authenticated` tiene `statement_timeout` de ~8 s. Agregar primero, acotar después.
- Imágenes de producto: `{SUPABASE_URL}/storage/v1/object/public/products-images/{cod}.jpg?v={IMG_VERSION}`. NO usar `/storage/v1/render/image/public/` — image transformations probablemente no está habilitado. `IMG_VERSION` sale de `config.js`.
- `app_settings.web_order_discount` se lee al cargar como descuento web (fallback `0.02`).

## Pages and their scripts

| Page | Script | Role |
|---|---|---|
| `index.html` | `script.index.js` + `css/styles.index.css` | Landing pública: hero con video, logos de clientes, catálogo PDF, contacto WhatsApp, modals legales. Sin Supabase. |
| `mayorista.html` | `script.js` + `css/styles.css` | SPA principal B2B: login, catálogo, carrito, envío de pedidos, perfil, modo expo, embed de análisis de venta. ~10.900 líneas. |
| `admin.html` | `admin.js` + `admin-supercot.js` + `admin-excel-krikos.js` + `css/admin.css` | Panel admin: clientes, pedidos, PPP cross-reference, cotizador de súper (PDF/Excel), gestión expo, análisis de venta. ~7.800 líneas en `admin.js`. |
| `historial.html` | `historial.js` + `css/historial.css` | Historial de pedidos del cliente. |
| `sugerencias.html` | `sugerencias.js` + `css/sugerencias.css` | Sugerencias de compra + pestaña de novedades por marca. |
| `analisis-venta-cliente.html` | `analisis-venta-cliente.js` + `css/analisis-venta-cliente.css` | Análisis de venta por cliente (standalone y embebido en mayorista). **⚠️ Título todavía dice "Loekemeyer".** |
| `carga-pedidos.html` | — | Carga de pedidos por Excel. **⚠️ Título todavía dice "Loekemeyer".** |
| `expo-qr-test.html` | `jsqr.js` | Página de prueba del escáner QR para ferias/exposiciones. |

### Módulo Expo (ferias)

El modo Expo permite onboarding de clientes nuevos en ferias comerciales. Incluye:
- Escáner QR de credenciales (`jsqr.js`, integrado en `script.js`)
- Tabla staging `expo_clientes_pendientes` para clientes nuevos
- Descuentos por escala en `expo_dto_escala`
- Dashboard admin (`expo_dashboard` RPC)
- Esquema SQL en `sql/expo.sql`

## Design tokens

`css/tokens.css` centraliza variables CSS: `--color-brand: #0b315d` (azul marino), `--color-*`, `--radius-*`, `--shadow-*`. Las demás hojas de estilo heredan de ahí.

## Client-side state conventions (`script.js`)

- Archivo de ~10.900 líneas en namespace global (sin IIFE). Funciones expuestas a `onclick=` vía `window.fn = fn` al final del archivo.
- Estado global en `let`s de top-level: `products`, `cart`, `customerProfile`, `isAdmin`, `deliveryChoice`, `sortMode`, etc.
- Sin framework — funciones render leen globales y escriben DOM directamente.
- Detección de anomalías: `ANOMALY_THRESHOLD = 6` marca líneas de carrito > 6× el promedio mensual histórico del cliente (vista `v_customer_item_month`), cacheado en `_anomalyCache`.
- Orden de categorías hardcodeado en `CATEGORY_ORDER` y `UTENSILIOS_SUB_ORDER`.

## Common operations

- **Run locally**: servir el directorio raíz con cualquier servidor estático (`python -m http.server`). No hay dev server.
- **Deploy**: los archivos se copian al web root de IIS en `chefsrl.com`. El `web.config` del repo es el real y tiene: redirección HTTPS, compresión gzip, cache de 1 año para estáticos, clean URLs (quita `.html`), MIME types de `.webp`/`.woff2`/`.avif`, headers de seguridad, y `no-cache` para HTML.
- **Third-party libs**: se cargan por CDN en los HTML (Supabase JS v2, xlsx 0.18.5, pdf.js 3.11.174, jsPDF 2.5.1, Chart.js 4.4.7, Google Fonts). Sin bundler; agregar nuevas igual.
- **SQL scripts**: `sql/expo.sql` es el esquema del módulo expo. Los one-shot se corren a mano en el SQL editor de Supabase.

## Versionamiento automático

Los hooks viven en **`hooks/`** (versionados) y automáticamente:
- Incrementan la versión en `version.js` (+1 en patch)
- Actualizan los `?v=XXX` de `.js` y `.css` en los HTML (cache busting)
- Generan un commit message descriptivo

**Activación (una vez por clon):**
```bash
git config core.hooksPath hooks
```
Sin eso los hooks NO corren. Si ves un commit sin `bump:` en el mensaje, faltó este paso.

## SEO / crawling

- `sitemap.xml` lista solo las dos entradas públicas: `/` y `/mayorista.html`. Las páginas detrás de auth NO van ahí.
- `.nojekyll` presente (no se usa Jekyll).

## web.config (IIS)

El `web.config` SÍ está en el repo (a diferencia de pagina-LK-copia donde solo vive en el servidor). Incluye:
- Redirección HTTP → HTTPS
- Compresión gzip (estática y dinámica)
- Cache de 1 año para estáticos
- Clean URLs (quita extensión `.html` con redirect externo + rewrite interno)
- HTML con `no-cache, no-store, must-revalidate`
- MIME types: `.webp`, `.woff2`, `.avif`
- Headers de seguridad: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`
- `X-Powered-By` removido

## Estructura de archivos

```
paginach/
├── config.js                  # Constantes globales (Supabase keys, IMG_VERSION)
├── version.js                 # Versión del sitio (2.0.15)
├── script.js                  # Lógica principal mayorista (~10.900 líneas)
├── script.index.js            # Landing page JS
├── admin.js                   # Panel admin (~7.800 líneas)
├── admin-supercot.js          # Parser de cotización de súper (~3.360 líneas)
├── admin-excel-krikos.js      # Parser de Excel para pedidos (~1.500 líneas)
├── analisis-venta-cliente.js  # Análisis de venta por cliente
├── historial.js               # Historial de pedidos
├── sugerencias.js             # Sugerencias de compra
├── excel-parser-smart.js      # Matcher fuzzy de columnas Excel
├── argentina-map-data.js      # GeoJSON → SVG mapa Argentina
├── jsqr.js                    # Librería QR scanner
├── web.config                 # Config IIS
├── argentina-provinces.json   # GeoJSON provincias Argentina
├── css/
│   ├── tokens.css             # Design tokens (brand colors)
│   ├── styles.css             # Estilos principales (~12.200 líneas)
│   ├── styles.index.css       # Estilos landing
│   ├── admin.css              # Estilos admin
│   ├── historial.css          # Estilos historial
│   ├── sugerencias.css        # Estilos sugerencias
│   └── analisis-venta-cliente.css
├── sql/
│   └── expo.sql               # Esquema del módulo expo
├── hooks/
│   ├── pre-commit             # Auto-bump versión + cache busting
│   └── prepare-commit-msg     # Commit message descriptivo automático
├── img/                       # Logos, favicon, videos de hero
├── pdf/catalogo.pdf           # Catálogo de productos
└── animations/success-check.json  # Lottie animation
```

## Gotchas

- **Idioma español** en todo: UI, variables, comentarios. Seguir el estilo existente.
- Las constantes de Supabase están duplicadas en `config.js` Y en cada archivo JS por diseño. Si se rotan, grep en todos.
- `admin.js` usa `var` / function-scoped old-style JS. `script.js` / `historial.js` / `sugerencias.js` usan `const`/`let`/arrows. No "modernizar" `admin.js`.
- **Páginas con branding de Loekemeyer sin reemplazar**: `analisis-venta-cliente.html` (título), `carga-pedidos.html` (título y logo). Pendiente de rebrandear.
- La lista de expresos de `script.js` es la de **Loekemeyer como fallback** hasta que Chef tenga la propia.
- **Los vendedores son compartidos**: LK y Chef usan los mismos códigos ERP de vendedor.

## Pendientes — AVISAR AL USUARIO

**Instrucción para Claude:** cuando una sesión toque alguno de estos módulos, mencionarle al usuario el pendiente antes de terminar el turno.

- **Rebrandeo incompleto**: `analisis-venta-cliente.html` y `carga-pedidos.html` todavía dicen "Loekemeyer" en el título y/o loading screen.
- **Lista de expresos propia de Chef**: `script.js` usa la de Loekemeyer como fallback.
- **`supermarket_branch_mapping` está vacía**: el módulo de cotización de súper no tiene el mapeo cliente→cadena.
