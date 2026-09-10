# CLAUDE.md — Página Chef (paginach)

Sitio web B2B de **Chef**, gemelo de la página de Loekemeyer (`pagina-LK-copia`). Mismo
esqueleto de archivos (`mayorista.html`, `admin.html`, `script.js`, `admin.js`, etc.), pero
apunta al **proyecto Supabase de Chef** (`nkhzocgdpwtgrmwleihr`), distinto del de LK
(`kwkclwhmoygunqmlegrg`). Las numeraciones de cliente y de pedido de Chef y LK son
**independientes**: el mismo número es otro negocio en cada empresa.

## ⚠ REGLA: borrar un pedido = borrarlo de TODOS lados (todos los repos/proyectos)

Cuando el usuario pida **borrar un pedido**, borrarlo de **todos los lugares donde ese pedido
interviene**, no de uno solo. Un pedido web vive en varios proyectos a la vez:

1. **Página Chef** (`nkhzocgdpwtgrmwleihr`, este repo): `orders` + `order_items`.
   (El pedido de LK vive en el proyecto LK `kwkclwhmoygunqmlegrg`, repo `pagina-LK-copia`.)
2. **Gestión Virgilio** (`hrxfctzncixxqmpfhskv`): la NP y la programación. Buscar el `order_id`
   (filtrando `empresa` = `chef`/`lk`) en `PPP_Web_NP`, `PPP_Web_Programacion`, `PPP_Web_Base`,
   `PPP_Web_Tanda_Items`. Si ya está en tanda/picking, avisarlo antes de borrar.

**Backup antes de cada borrado** (protocolo de Supabase). Borrar hijos antes que padres
(`order_items` antes de `orders`). Al terminar, reportar en qué lugares apareció y de cuáles se borró.
