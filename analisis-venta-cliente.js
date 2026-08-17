"use strict";

// ============================================================
// Análisis Venta Cliente — admin + customer mode (embebido en mayorista)
// Doc: .planning/PLAN.md
// ============================================================

// IMPORTANTE: este archivo se carga JUNTO con script.js en mayorista.html
// (cuando se embebe la card de "Análisis de tus compras" en el perfil).
// Para no chocar con `const SUPABASE_URL = ...` de script.js, usamos
// nombres prefijados con AVC_ acá. Sino el browser tira:
//   "Identifier 'SUPABASE_URL' has already been declared"
// y todo el archivo deja de evaluarse → avcInitCustomerMode no se define.
var AVC_SUPABASE_URL = "https://nkhzocgdpwtgrmwleihr.supabase.co";
var AVC_SUPABASE_ANON_KEY =
  "sb_publishable_aThHtJLBKytg9k_6UdH2Eg_Use7f1zH";

var sb = window.supabase.createClient(AVC_SUPABASE_URL, AVC_SUPABASE_ANON_KEY);

// Embedded mode: cuando este script corre dentro de admin.html (sidebar admin
// con .sidebar-nav). En ese caso admin.js ya hizo la auth + admin check y ya
// muestra la app shell, asi que evitamos togglear loadingScreen/appShell y
// evitamos redirigir a /mayorista en caso de fallo (admin.js lo maneja).
var AVC_EMBEDDED = !!document.querySelector(".sidebar-nav");

// Customer mode: cuando este script corre dentro de mayorista.html en la
// sección #perfil del cliente. En ese caso:
//   - NO se hace admin check (el cliente NO es admin)
//   - Se auto-loadea SU PROPIO cod_cliente (no permitir buscar otros)
//   - Se OCULTAN controles de búsqueda y reporte total
var AVC_CUSTOMER_MODE = document.body && document.body.classList.contains("avc-customer-mode");

// ============================================================
// ESTADO GLOBAL
// ============================================================
var currentCustomer = null; // { id, cod_cliente, business_name, ... }
var currentAddresses = []; // [{ id, direccion, ... }]
var productByCod = {}; // cod -> { descripcion, categoria, ... }
var productById = {}; // id -> cod
var estadisticaMadre = {}; // cod -> { ranking, e_madre_uni_mes, descripcion, categoria }
var sugerenciasCache = []; // resultado RPC sugerencias_cliente
var novedadesCache = []; // resultado RPC novedades_marca
var movements = []; // historial unificado (RPC get_customer_history) — fuente única para Consolidado + bloques globales
var webMovements = []; // solo pedidos web (orders+order_items) — usado para separar por sucursal
var branches = []; // [{ key, label, type, address?, movements: [], analysis: {...} }]
var activeBranchKey = null;
var ranking12m = null; // { pos, total, unidades }
var percentilLifetime = null; // { pct, pos, total, avgPerMonth, monthsActive, totalUnits }
var _percentilGlobalCache = null; // cache global compartida entre cargas: [{ cod, avgPerMonth, ... }]

// Constantes
var DISRUPTIVA_RATIO = 1.5;
var BAJA_MIN_COMPRAS = 2;
var BAJA_MAX_COLS = 5;
var TOP_OFRECER = 15;

// ============================================================
// AUTH GATE
// ============================================================
// Renombrado de checkAuth a avcCheckAuth para evitar pisar admin.js#checkAuth
// (function declarations son hoisted y la ultima gana cuando los dos scripts
// estan en la misma pagina).
async function avcCheckAuth() {
  // En modo embebido (admin.html) o modo cliente (mayorista.html #perfil),
  // ya hubo gate de auth previo (admin.js o script.js). Saltamos check.
  if (AVC_EMBEDDED || AVC_CUSTOMER_MODE) return true;

  var statusEl = document.getElementById("authStatus");
  var sess = await sb.auth.getSession();
  if (sess.error || !sess.data || !sess.data.session) {
    if (statusEl) statusEl.textContent = "Sin sesión. Redirigiendo...";
    setTimeout(function () {
      location.href = "/mayorista";
    }, 1200);
    return false;
  }
  var userId = sess.data.session.user.id;
  var adminCheck = await sb
    .from("admins")
    .select("auth_user_id")
    .eq("auth_user_id", userId)
    .maybeSingle();
  if (adminCheck.error || !adminCheck.data) {
    if (statusEl) statusEl.textContent = "Acceso denegado. Solo admins.";
    setTimeout(function () {
      location.href = "/mayorista";
    }, 1500);
    return false;
  }
  document.getElementById("loadingScreen").style.display = "none";
  document.getElementById("appShell").style.display = "block";
  return true;
}

// ============================================================
// HELPERS
// ============================================================
function $(id) {
  return document.getElementById(id);
}

function setStatus(msg, kind) {
  var el = $("busquedaStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className =
    "avc-search-status" + (kind ? " avc-search-status--" + kind : "");
}

function normSuc(s) {
  // lowercase + quitar acentos (combining marks U+0300..U+036F) + colapsar espacios
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

var MESES = [
  "ene",
  "feb",
  "mar",
  "abr",
  "may",
  "jun",
  "jul",
  "ago",
  "sep",
  "oct",
  "nov",
  "dic",
];

function fmtMonthYear(dt) {
  if (!dt) return "";
  var d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return "";
  return MESES[d.getMonth()] + "-" + String(d.getFullYear()).slice(-2);
}

function fmtMonthYearMM(dt) {
  if (!dt) return "";
  var d = dt instanceof Date ? dt : new Date(dt);
  if (isNaN(d.getTime())) return "";
  return String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
}

function monthKey(dt) {
  var d = dt instanceof Date ? dt : new Date(dt);
  return d.getFullYear() * 12 + d.getMonth();
}

function fmtNumber(n, dec) {
  if (n == null || !isFinite(n)) return "—";
  return Number(n).toLocaleString("es-AR", {
    minimumFractionDigits: dec || 0,
    maximumFractionDigits: dec || 0,
  });
}

// ============================================================
// PAGE INIT
// ============================================================
document.addEventListener("DOMContentLoaded", async function () {
  var ok = await avcCheckAuth();
  if (!ok) return;

  var form = $("formBuscar");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var cod = String($("inputCodCliente").value || "").trim();
      if (!cod) return;
      buscarCliente(cod);
    });
  }

  var btnExp = $("btnExportarExcel");
  if (btnExp) btnExp.addEventListener("click", onExportarExcel);

  var btnCatPdf = $("btnCatalogoPDF");
  if (btnCatPdf) btnCatPdf.addEventListener("click", avcDescargarCatalogoPDF);

  var btnTot = $("btnReporteTotal");
  if (btnTot) btnTot.addEventListener("click", onReporteTotal);

  // Customer mode (mayorista #perfil): exponemos init + auto-poll para
  // detectar cuando script.js carga el customerProfile.
  if (AVC_CUSTOMER_MODE) {
    var _avcLoaded = false;
    window.avcInitCustomerMode = async function (codCliente) {
      if (!codCliente) return;
      if (
        currentCustomer &&
        String(currentCustomer.cod_cliente) === String(codCliente)
      ) {
        return;
      }
      _avcLoaded = true;
      var es = $("emptyState");
      if (es) {
        es.style.display = "block";
        es.innerHTML =
          '<div style="padding:14px;color:#666;text-align:center;font-size:13px">' +
          "⏳ Cargando tu análisis…</div>";
      }
      try {
        await buscarCliente(String(codCliente));
      } catch (err) {
        console.error("AVC customer init error:", err);
      }
      // Post-check: si no se cargaron branches, mostrar mensaje de error visible
      setTimeout(function () {
        var es2 = $("emptyState");
        var hasContent =
          (currentCustomer && branches && branches.length > 0) || false;
        if (!hasContent && es2) {
          es2.style.display = "block";
          es2.innerHTML =
            '<div style="padding:14px;color:#b00020;background:#fff5f5;' +
            'border:1px solid #ffd1d1;border-radius:10px;font-size:13px;text-align:center">' +
            "⚠️ No se pudo cargar tu análisis. Es posible que aún no tengas " +
            "historial de compras o que los permisos no estén configurados. " +
            "Si seguís viendo esto, avisanos." +
            "</div>";
        }
      }, 200);
    };

    // Auto-poll: si script.js no nos llama (timing), watch customerProfile
    // por hasta 10s y disparamos init solos cuando aparece.
    var pollTries = 0;
    var pollInterval = setInterval(function () {
      pollTries++;
      if (_avcLoaded) {
        clearInterval(pollInterval);
        return;
      }
      var cp = window.__lkCustomerProfile;
      if (cp && cp.cod_cliente) {
        clearInterval(pollInterval);
        window.avcInitCustomerMode(String(cp.cod_cliente));
      } else if (pollTries > 100) {
        // 10s sin customerProfile → mostrar mensaje
        clearInterval(pollInterval);
        var es2 = $("emptyState");
        if (es2)
          es2.textContent =
            "Iniciá sesión para ver tu análisis.";
      }
    }, 100);
  }
});

// ============================================================
// BÚSQUEDA + CARGA — FASE 4
// ============================================================
async function buscarCliente(codCliente) {
  setStatus("Buscando cliente " + codCliente + "...");
  // Null-guards: en modo customer (mayorista) el btnExportarExcel y la
  // search section están ocultos/no renderizados. Si no chequeamos null,
  // .disabled = true tira TypeError y rompe todo el try/catch → la card
  // queda en empty state con "No se pudo cargar tu análisis".
  var _es = $("emptyState"); if (_es) _es.style.display = "none";
  var _ci = $("clienteInfo"); if (_ci) _ci.style.display = "none";
  var _st = $("sucursalTabs"); if (_st) _st.style.display = "none";
  var _sc = $("sucursalContent"); if (_sc) _sc.style.display = "none";
  var _btnExp = $("btnExportarExcel"); if (_btnExp) _btnExp.disabled = true;
  var _btnPdf = $("btnCatalogoPDF"); if (_btnPdf) _btnPdf.disabled = true;

  // reset estado
  currentCustomer = null;
  currentAddresses = [];
  movements = [];
  branches = [];
  activeBranchKey = null;
  ranking12m = null;
  percentilLifetime = null;

  try {
    // 1. Customer
    var custR = await sb
      .from("customers")
      .select("id, cod_cliente, business_name, cuit, mail, dto_vol, vend")
      .eq("cod_cliente", String(codCliente))
      .maybeSingle();
    if (custR.error) throw new Error(custR.error.message);
    if (!custR.data) {
      setStatus("Cliente " + codCliente + " no existe.", "err");
      return;
    }
    currentCustomer = custR.data;

    // 2. Addresses
    setStatus("Cargando sucursales...");
    var addrR = await sb
      .from("customer_delivery_addresses")
      .select("slot, label, direccion_entrega, zona_expreso, pending_isis")
      .eq("customer_id", currentCustomer.id)
      .order("slot", { ascending: true });
    if (addrR.error) throw new Error(addrR.error.message);
    currentAddresses = addrR.data || [];

    // 3. Estadística Madre + Productos + Comisiones (paralelo, una sola vez si ya cacheados)
    setStatus("Cargando catálogo y estadística madre...");
    await Promise.all([loadProducts(), loadEstadisticaMadre(), loadCommissions()]);

    // 4. Histórico oficial del cliente (RPC que usa la página Historial)
    setStatus("Cargando historial de compras...");
    movements = await loadHistory(currentCustomer.cod_cliente);

    // 5. Movs web (para poder separar por sucursal en pestañas)
    setStatus("Cargando pedidos web (para sucursales)...");
    webMovements = await loadWebMovements(currentCustomer.id);

    // 6. Ranking 12m
    setStatus("Calculando ranking...");
    try {
      await computeRanking12m(currentCustomer.id);
    } catch (errR) {
      console.warn("[AVC] computeRanking12m falló:", errR);
    }
    // 6.b Percentil lifetime: posiciona al cliente vs TODOS los clientes
    // según unidades/mes promedio desde su primera compra. No bloquea si
    // falla — sigue cargando el resto.
    try {
      await computePercentilLifetime(currentCustomer.cod_cliente);
    } catch (errP) {
      console.warn("[AVC] computePercentilLifetime falló:", errP);
    }

    // 7. Construir branches (Consolidado + 1 por sucursal del cliente)
    branches = buildBranches();

    // 9. Set global de items comprados por el cliente (cualquier sucursal/fuente)
    var globalPurchasedItems = new Set();
    movements.forEach(function (m) {
      globalPurchasedItems.add(m.item_code);
    });
    avcPurchasedSet = globalPurchasedItems; // para el catálogo PDF (más vendidos no comprados)

    // 10. Análisis GLOBAL del cliente — Altas / Bajas / Probó1Vez / A Ofrecer
    //     se calculan sobre TODOS los movs y se comparten entre branches.
    //     (Stats/Disruptivas/Evolución sí son por branch.)
    var globalBranch = {
      key: "__global__",
      label: "global",
      type: "consolidated",
      movements: movements,
    };
    var globalAnalysis = computeAnalysis(
      globalBranch,
      globalPurchasedItems,
    );

    branches.forEach(function (br) {
      // Mismo dataset siempre (única branch tras la migración a get_customer_history)
      br.analysis = computeAnalysis(br, globalPurchasedItems);
      // override de secciones globales del cliente (idempotente con la única branch)
      br.analysis.altas = globalAnalysis.altas;
      br.analysis.bajas = globalAnalysis.bajas;
      br.analysis.probo1Vez = globalAnalysis.probo1Vez;
      br.analysis.aOfrecer = globalAnalysis.aOfrecer;
    });

    // 10. Render
    renderClienteInfo();
    renderTabs();
    if (branches.length) {
      activateBranch(branches[0].key);
    }
    // Null-guards: en modo customer estos elementos pueden no existir
    // clienteInfo: NO forzar block en customer mode — renderClienteInfo() ya
    // lo ocultó porque es redundante con el banner del perfil.
    var _ci2 = $("clienteInfo");
    if (_ci2 && !AVC_CUSTOMER_MODE) _ci2.style.display = "block";
    var _st2 = $("sucursalTabs"); if (_st2) _st2.style.display = "flex";
    var _sc2 = $("sucursalContent"); if (_sc2) _sc2.style.display = "flex";
    var _btnExp2 = $("btnExportarExcel"); if (_btnExp2) _btnExp2.disabled = false;
    var _btnPdf2 = $("btnCatalogoPDF"); if (_btnPdf2) _btnPdf2.disabled = false;

    setStatus(
      "Listo — " +
        movements.length +
        " movimientos cargados, " +
        branches.length +
        " sucursal(es).",
      "ok",
    );
  } catch (err) {
    console.error("buscarCliente error", err);
    setStatus("Error: " + (err.message || err), "err");
  }
}

// ============================================================
// CARGADORES
// ============================================================
async function loadProducts() {
  if (Object.keys(productByCod).length) return;
  var off = 0;
  while (true) {
    var r = await sb
      .from("products")
      .select(
        "id, cod, description, category, subcategory, badge_status, active, uxb, list_price",
      )
      .range(off, off + 999);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    batch.forEach(function (p) {
      var cod = String(p.cod || "").trim().toUpperCase();
      if (!cod) return;
      productByCod[cod] = {
        id: p.id,
        descripcion: p.description || cod,
        categoria: p.category || p.subcategory || "",
        badge: String(p.badge_status || "").trim().toUpperCase(),
        active: p.active !== false,
        uxb: Number(p.uxb) || 1,
        listPrice: Number(p.list_price) || 0,
      };
      productById[p.id] = cod;
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
}

// Items LOKE excluidos del histórico (mismo set que historial.js)
var EXCLUDED_CODES = new Set([
  "101","103","104","108","110","111","112","113","114","115","116","119","120","121","123","186","193",
]);

// ymToDate: 'YYYY-MM' -> Date al día 15 del mes (centro, evita bordes)
function ymToDate(ym) {
  var s = String(ym || "").trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  var y = Number(s.slice(0, 4));
  var m = Number(s.slice(5, 7));
  return new Date(y, m - 1, 15);
}

async function loadEstadisticaMadre() {
  if (Object.keys(estadisticaMadre).length) return;
  var off = 0;
  while (true) {
    var r = await sb
      .from("estadistica_madre")
      .select(
        "cod, descripcion, categoria, ranking, e_madre_uni_mes, tendencia_uni",
      )
      .range(off, off + 999);
    if (r.error) {
      // tabla puede no existir todavía — log y seguir
      console.warn("estadistica_madre no disponible:", r.error.message);
      return;
    }
    var batch = r.data || [];
    batch.forEach(function (e) {
      var cod = String(e.cod || "").trim().toUpperCase();
      if (!cod) return;
      estadisticaMadre[cod] = e;
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
}

// Carga histórico oficial del cliente desde el RPC que usa la página Historial
// (fuente de verdad — incluye web + ERP, agregado mensual en cajas).
async function loadHistory(codCliente) {
  var r = await sb.rpc("get_customer_history", {
    p_cod_cliente: String(codCliente),
  });
  if (r.error) {
    console.warn("get_customer_history error", r.error);
    return [];
  }
  var rows = r.data || [];
  var movs = [];
  rows.forEach(function (row) {
    var cod = String(row.item_code || "").trim().toUpperCase();
    if (!cod) return;
    if (EXCLUDED_CODES.has(cod)) return;
    var dt = ymToDate(row.ym);
    if (!dt) return;
    var boxes = Number(row.boxes) || 0;
    if (boxes <= 0) return;
    var uxb = (productByCod[cod] && productByCod[cod].uxb) || 1;
    var qty = boxes * uxb;
    // Si products no trae descripción, usar la del row
    if (productByCod[cod] && !productByCod[cod].descripcion) {
      productByCod[cod].descripcion =
        String(row.description || "").trim() || cod;
    }
    movs.push({
      fecha: dt,
      ym: row.ym,
      item_code: cod,
      qty: qty,
      boxes: boxes,
      sucursal: "",
      sucursalRaw: "",
      fuente: "historial",
      orderId: null,
    });
  });
  // ordenar asc
  movs.sort(function (a, b) {
    return a.fecha - b.fecha;
  });
  return movs;
}

// helper: clave de "pedido" para agrupar movs por (orden web única) o (mes calendario para fuentes agregadas)
function _orderKey(m) {
  if (m.fuente === "web" && m.orderId) return "w_" + m.orderId;
  // historial / erp: agrupar por mes calendario
  return (
    "m_" + m.fecha.getFullYear() + "-" + (m.fecha.getMonth() + 1)
  );
}

async function loadWebMovements(customerId) {
  var allOrderIds = [];
  var orderMeta = {}; // id -> { fecha, sucursalRaw, sucursalNorm }
  var off = 0;
  while (true) {
    var r = await sb
      .from("orders")
      .select("id, created_at, sheets_payload")
      .eq("customer_id", customerId)
      .range(off, off + 999);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    batch.forEach(function (o) {
      var sp = o.sheets_payload || {};
      var sucRaw =
        sp.sucursal_entrega ||
        sp.sucursalEntrega ||
        sp.delivery ||
        sp.delivery_label ||
        "";
      orderMeta[o.id] = {
        fecha: new Date(o.created_at),
        sucursalRaw: sucRaw,
        sucursalNorm: normSuc(sucRaw),
      };
      allOrderIds.push(o.id);
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
  if (!allOrderIds.length) return [];

  var movs = [];
  for (var bi = 0; bi < allOrderIds.length; bi += 200) {
    var slice = allOrderIds.slice(bi, bi + 200);
    var ioff = 0;
    while (true) {
      var ir = await sb
        .from("order_items")
        .select("order_id, product_id, cajas, uxb, is_loke")
        .in("order_id", slice)
        .range(ioff, ioff + 999);
      if (ir.error) throw new Error(ir.error.message);
      var ibatch = ir.data || [];
      ibatch.forEach(function (it) {
        var meta = orderMeta[it.order_id];
        if (!meta) return;
        var cod = productById[it.product_id];
        if (!cod) return;
        var cajas = Number(it.cajas) || 0;
        var uxb = Number(it.uxb) || 0;
        var qty = cajas * uxb;
        if (!qty) return;
        movs.push({
          fecha: meta.fecha,
          item_code: cod,
          qty: qty,
          boxes: cajas,
          sucursal: meta.sucursalNorm,
          sucursalRaw: meta.sucursalRaw,
          fuente: "web",
          orderId: it.order_id,
        });
      });
      if (ibatch.length < 1000) break;
      ioff += 1000;
    }
  }
  return movs;
}

async function loadSalesHistory(codCliente) {
  try {
    var r = await sb.rpc("get_customer_sales_history", {
      p_customer_code: String(codCliente),
    });
    if (r.error) {
      console.warn("get_customer_sales_history error:", r.error.message);
      return [];
    }
    var data = r.data || [];
    var movs = [];
    data.forEach(function (sl) {
      // campos que varían según la implementación del RPC. Intentamos varios alias:
      var cod = String(
        sl.item_code || sl.cod || sl.codigo || sl.product_code || "",
      )
        .trim()
        .toUpperCase();
      if (!cod) return;
      var fecha = sl.fecha || sl.date || sl.invoice_date || sl.fecha_venta;
      if (!fecha) return;
      var d = new Date(fecha);
      if (isNaN(d.getTime())) return;
      var qty = Number(
        sl.unidades || sl.qty || sl.cantidad || sl.quantity || 0,
      );
      if (!qty) return;
      movs.push({
        fecha: d,
        item_code: cod,
        qty: qty,
        sucursal: "", // ERP no tiene sucursal
        sucursalRaw: "",
        fuente: "erp",
        orderId: sl.order_id || sl.invoice_id || null,
      });
    });
    return movs;
  } catch (e) {
    console.warn("loadSalesHistory exc", e);
    return [];
  }
}

async function loadSugerenciasFor(codCliente) {
  try {
    var r = await sb.rpc("sugerencias_cliente", {
      p_customer: String(codCliente),
    });
    if (!r.error) sugerenciasCache = r.data || [];
  } catch (e) {
    sugerenciasCache = [];
  }
}

async function loadNovedades() {
  try {
    var r = await sb.rpc("novedades_marca");
    if (!r.error) novedadesCache = r.data || [];
  } catch (e) {
    novedadesCache = [];
  }
}

async function computeRanking12m(customerId) {
  // Pos del cliente actual entre todos los clientes con compras web últimos 12m por unidades.
  // Cálculo cliente-side (web only) — el ERP no es accesible para todos los clientes vía RPC.
  try {
    var since = new Date();
    since.setMonth(since.getMonth() - 12);
    var sinceISO = since.toISOString();

    // Trae todos los orders 12m con customer_id
    var allOrders = [];
    var off = 0;
    while (true) {
      var r = await sb
        .from("orders")
        .select("id, customer_id")
        .gte("created_at", sinceISO)
        .range(off, off + 999);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      allOrders = allOrders.concat(batch);
      if (batch.length < 1000) break;
      off += 1000;
    }
    if (!allOrders.length) return;
    var ordCust = {};
    allOrders.forEach(function (o) {
      ordCust[o.id] = o.customer_id;
    });
    var orderIds = allOrders.map(function (o) {
      return o.id;
    });

    var unitsByCust = {};
    for (var bi = 0; bi < orderIds.length; bi += 200) {
      var slice = orderIds.slice(bi, bi + 200);
      var ioff = 0;
      while (true) {
        var ir = await sb
          .from("order_items")
          .select("order_id, cajas, uxb")
          .in("order_id", slice)
          .range(ioff, ioff + 999);
        if (ir.error) throw new Error(ir.error.message);
        var ibatch = ir.data || [];
        ibatch.forEach(function (it) {
          var cid = ordCust[it.order_id];
          if (!cid) return;
          var u = (Number(it.cajas) || 0) * (Number(it.uxb) || 0);
          unitsByCust[cid] = (unitsByCust[cid] || 0) + u;
        });
        if (ibatch.length < 1000) break;
        ioff += 1000;
      }
    }
    var ranking = Object.keys(unitsByCust).map(function (cid) {
      return { customer_id: cid, units: unitsByCust[cid] };
    });
    ranking.sort(function (a, b) {
      return b.units - a.units;
    });
    var pos = ranking.findIndex(function (x) {
      return x.customer_id === customerId;
    });
    ranking12m = {
      pos: pos === -1 ? null : pos + 1,
      total: ranking.length,
      unidades: unitsByCust[customerId] || 0,
    };
  } catch (e) {
    console.warn("computeRanking12m error", e);
    ranking12m = null;
  }
}

// ============================================================
// PERCENTIL LIFETIME — posiciona al cliente vs TODOS los clientes según
// unidades/mes promedio desde su primera compra. Penaliza clientes que
// dejaron de comprar (cuenta meses hasta HOY, no hasta última compra).
//
// Sets `percentilLifetime` global = { pct, pos, total, avgPerMonth,
//   monthsActive, totalUnits } o null si no se puede calcular.
//
// El cache `_percentilGlobalCache` se construye 1 sola vez por sesión
// para no rehacer la query global (50k+ rows en v_customer_item_month)
// en cada cliente cargado.
// ============================================================
async function computePercentilLifetime(codClienteActual) {
  percentilLifetime = null;
  var codActual = String(codClienteActual || "").trim();
  if (!codActual) return;

  // Reusar cache global si ya está construido
  var ranked = _percentilGlobalCache;
  if (!ranked) {
    try {
      // 1) Cargar toda la view v_customer_item_month (paginada)
      var allRows = [];
      var pp = 0;
      while (true) {
        var r = await sb
          .from("v_customer_item_month")
          .select("cod_cliente, customer_code, ym, item_code, boxes")
          .range(pp * 1000, (pp + 1) * 1000 - 1);
        if (r.error) throw r.error;
        var batch = r.data || [];
        allRows = allRows.concat(batch);
        if (batch.length < 1000) break;
        pp++;
        if (pp > 500) break; // safeguard
      }

      // 2) Mapa uxb por cod (de productByCod o productsCache si existen)
      var uxbByCod = {};
      var prodCache = (typeof productByCod === "object" && productByCod) || {};
      Object.keys(prodCache).forEach(function (k) {
        var p = prodCache[k];
        if (p && p.uxb != null) uxbByCod[String(k).toUpperCase()] = Number(p.uxb) || 0;
      });

      // 3) Agregar por cliente: total unidades + primer/último ym.
      // La view chef puede usar `cod_cliente` o `customer_code` según el setup.
      var byCust = {};
      allRows.forEach(function (row) {
        var cod = String(row.cod_cliente || row.customer_code || "").trim();
        if (!cod) return;
        var item = String(row.item_code || "").trim().toUpperCase();
        var uxb = uxbByCod[item] || 1;
        var units = (Number(row.boxes) || 0) * uxb;
        if (units <= 0) return;
        var ym = String(row.ym || "");
        if (!byCust[cod]) byCust[cod] = { totalUnits: 0, firstYm: ym, lastYm: ym };
        var b = byCust[cod];
        b.totalUnits += units;
        if (ym < b.firstYm) b.firstYm = ym;
        if (ym > b.lastYm) b.lastYm = ym;
      });

      // 4) Calcular avg/mes para cada cliente (meses activos = desde primera
      // compra hasta HOY, no hasta última — penaliza inactivos)
      function monthsBetween(ymStart, ymEnd) {
        var ms = ymStart.match(/^(\d{4})-(\d{2})/);
        var me = ymEnd.match(/^(\d{4})-(\d{2})/);
        if (!ms || !me) return 1;
        var diff = (Number(me[1]) - Number(ms[1])) * 12 + (Number(me[2]) - Number(ms[2])) + 1;
        return Math.max(diff, 1);
      }
      ranked = Object.keys(byCust).map(function (cod) {
        var b = byCust[cod];
        var nowYm =
          new Date().getFullYear() + "-" +
          String(new Date().getMonth() + 1).padStart(2, "0");
        var months = monthsBetween(b.firstYm, nowYm);
        return {
          cod: cod,
          totalUnits: b.totalUnits,
          monthsActive: months,
          avgPerMonth: b.totalUnits / months,
          firstYm: b.firstYm,
          lastYm: b.lastYm,
        };
      });
      ranked.sort(function (a, b) { return b.avgPerMonth - a.avgPerMonth; });
      _percentilGlobalCache = ranked;
      console.log("[AVC] percentil cache built: " + ranked.length + " clientes");
    } catch (e) {
      console.warn("computePercentilLifetime build cache error", e);
      return;
    }
  }

  // 5) Encontrar al cliente actual y calcular percentil (100 = mejor)
  var pos = ranked.findIndex(function (x) { return x.cod === codActual; });
  if (pos === -1) return;
  var me = ranked[pos];
  var pct = Math.round(((ranked.length - pos) / ranked.length) * 100);
  percentilLifetime = {
    pct: pct,
    pos: pos + 1,
    total: ranked.length,
    avgPerMonth: me.avgPerMonth,
    monthsActive: me.monthsActive,
    totalUnits: me.totalUnits,
  };
}

// ============================================================
// BRANCHES — agrupa movimientos por sucursal
// ============================================================
function buildBranches() {
  var list = [];

  // Consolidado: histórico oficial (todas las compras del cliente, todas las fuentes)
  list.push({
    key: "__consolidated__",
    label: "Consolidado",
    type: "consolidated",
    address: null,
    movements: movements.slice(),
  });

  // 1 pestaña por sucursal — usa solo pedidos WEB filtrados por dirección/label/slot.
  // (El histórico oficial ERP no distingue sucursal, así que estas pestañas
  //  reflejan únicamente la actividad web por delivery address.)
  function addrCandidates(addr) {
    var c = [];
    if (addr.label) c.push(normSuc(addr.label));
    if (addr.direccion_entrega) c.push(normSuc(addr.direccion_entrega));
    if (addr.slot != null) c.push(normSuc(String(addr.slot)));
    return c.filter(Boolean);
  }
  currentAddresses.forEach(function (addr) {
    var cands = addrCandidates(addr);
    var movs = webMovements.filter(function (m) {
      return m.sucursal && cands.indexOf(m.sucursal) !== -1;
    });
    // Pestaña corta: solo label si existe, sino dirección, sino slot
    var label =
      (addr.label && String(addr.label).trim()) ||
      (addr.direccion_entrega && String(addr.direccion_entrega).trim()) ||
      "Sucursal " + addr.slot;
    list.push({
      key: "addr_" + addr.slot,
      label: label,
      type: "branch",
      address: addr,
      movements: movs,
    });
  });

  // Pedidos web cuyo sucursal_entrega no matcheó ninguna address registrada
  var matchedNorm = new Set();
  currentAddresses.forEach(function (a) {
    addrCandidates(a).forEach(function (n) {
      matchedNorm.add(n);
    });
  });
  var orphanMovs = webMovements.filter(function (m) {
    return m.sucursal && !matchedNorm.has(m.sucursal);
  });
  if (orphanMovs.length) {
    list.push({
      key: "__orphans__",
      label: "Sin asignar",
      type: "branch",
      address: null,
      movements: orphanMovs,
    });
  }

  return list;
}

// ============================================================
// COMPUTE ANALYSIS — FASE 5
// ============================================================
function computeAnalysis(branch, globalPurchased) {
  var movs = branch.movements;

  // index por item_code y por fecha de pedido (mes)
  var byItem = {}; // cod -> [{ fecha, qty, ... }]
  movs.forEach(function (m) {
    if (!byItem[m.item_code]) byItem[m.item_code] = [];
    byItem[m.item_code].push(m);
  });
  Object.keys(byItem).forEach(function (cod) {
    byItem[cod].sort(function (a, b) {
      return a.fecha - b.fecha;
    });
  });

  // Pedidos únicos del cliente: web → 1 por orderId; historial/erp → 1 por mes calendario
  var ordersMap = {}; // ordKey -> { fecha, items: {cod: qty}, itemsBoxes: {cod: boxes} }
  movs.forEach(function (m) {
    var key = _orderKey(m);
    if (!ordersMap[key]) {
      ordersMap[key] = { fecha: m.fecha, items: {}, itemsBoxes: {} };
    }
    ordersMap[key].items[m.item_code] =
      (ordersMap[key].items[m.item_code] || 0) + (Number(m.qty) || 0);
    ordersMap[key].itemsBoxes[m.item_code] =
      (ordersMap[key].itemsBoxes[m.item_code] || 0) +
      (Number(m.boxes) || 0);
  });
  var orders = Object.keys(ordersMap)
    .map(function (k) {
      return ordersMap[k];
    })
    .sort(function (a, b) {
      return a.fecha - b.fecha;
    });

  // ---------- ALTAS (primera vez ever en esta branch) ----------
  var altas = Object.keys(byItem).map(function (cod) {
    var first = byItem[cod][0];
    var info =
      productByCod[cod] ||
      estadisticaMadre[cod] || { descripcion: cod, categoria: "" };
    return {
      cod: cod,
      descripcion: info.descripcion,
      categoria: info.categoria || "",
      fecha: first.fecha,
      qty: first.qty,
    };
  });
  altas.sort(function (a, b) {
    return b.fecha - a.fecha;
  });

  // ---------- BAJAS + PROBÓ 1 VEZ ----------
  var bajas = [];
  var probo1Vez = [];

  Object.keys(byItem).forEach(function (cod) {
    var compras = byItem[cod];
    var info =
      productByCod[cod] ||
      estadisticaMadre[cod] || { descripcion: cod, categoria: "" };

    // contar pedidos únicos donde aparece el item
    var pedidosConItem = new Set();
    compras.forEach(function (c) {
      var key =
        c.fuente === "web" && c.orderId
          ? "w_" + c.orderId
          : "erp_" + c.fecha.toISOString().slice(0, 10);
      pedidosConItem.add(key);
    });

    if (pedidosConItem.size < BAJA_MIN_COMPRAS) {
      probo1Vez.push({
        cod: cod,
        descripcion: info.descripcion,
        categoria: info.categoria || "",
        mes: fmtMonthYear(compras[0].fecha),
        fecha: compras[0].fecha,
        qty: compras[0].qty,
      });
      return;
    }

    var primera = compras[0].fecha;
    var ultima = compras[compras.length - 1].fecha;

    // pedidos posteriores a la última compra del item
    var posteriores = orders.filter(function (o) {
      return o.fecha > ultima;
    });
    if (!posteriores.length) return; // último pedido fue con el item; no hay bajas que reportar

    // si en algún posterior reaparece, sale de Bajas (no debería pasar porque "ultima" sería más nueva, pero por las dudas)
    var reaparece = posteriores.some(function (o) {
      return o.items[cod];
    });
    if (reaparece) return;

    // agrupar posteriores por mes-año, máx 5
    var seenMonths = new Set();
    var bajasMeses = [];
    for (var i = 0; i < posteriores.length && bajasMeses.length < BAJA_MAX_COLS; i++) {
      var mk = monthKey(posteriores[i].fecha);
      if (seenMonths.has(mk)) continue;
      seenMonths.add(mk);
      bajasMeses.push(fmtMonthYear(posteriores[i].fecha));
    }

    if (!bajasMeses.length) return;

    var ultimaQty = compras[compras.length - 1].qty;
    var sumQty = compras.reduce(function (acc, c) {
      return acc + (Number(c.qty) || 0);
    }, 0);
    var promQty = compras.length ? sumQty / compras.length : 0;

    bajas.push({
      cod: cod,
      descripcion: info.descripcion,
      plazoCompro:
        fmtMonthYearMM(primera) + " - " + fmtMonthYearMM(ultima),
      bajas: bajasMeses,
      ultimaCompra: ultima,
      ultimaQty: ultimaQty,
      promedioQty: promQty,
      comprasCount: pedidosConItem.size,
    });
  });

  bajas.sort(function (a, b) {
    return b.ultimaCompra - a.ultimaCompra;
  });
  probo1Vez.sort(function (a, b) {
    return b.fecha - a.fecha;
  });

  // ---------- A OFRECER (top 15) ----------
  // Excluye TODO lo comprado por el cliente (cualquier sucursal),
  // no solo lo del branch actual.
  var excludedItems = globalPurchased || new Set(Object.keys(byItem));
  var aOfrecer = computeAOfrecer(excludedItems);

  // ---------- STATS ----------
  var stats = computeStats(orders, branch);

  // ---------- DISRUPTIVAS (última compra) ----------
  var disruptivas = [];
  if (orders.length) {
    var ultima = orders[orders.length - 1];
    Object.keys(ultima.items).forEach(function (cod) {
      var qtyAct = ultima.items[cod];
      var hist = byItem[cod] || [];
      // promedio histórico = avg de pedidos anteriores donde aparece (excluyendo este)
      var prevPedidos = []; // qty agregado por pedido distinto de este
      var seenKey = new Set();
      hist.forEach(function (m) {
        var k =
          m.fuente === "web" && m.orderId
            ? "w_" + m.orderId
            : "erp_" + m.fecha.toISOString().slice(0, 10);
        if (m.fecha >= ultima.fecha) return;
        if (seenKey.has(k)) {
          prevPedidos[prevPedidos.length - 1] += m.qty;
        } else {
          seenKey.add(k);
          prevPedidos.push(m.qty);
        }
      });
      if (!prevPedidos.length) return;
      var prom =
        prevPedidos.reduce(function (a, b) {
          return a + b;
        }, 0) / prevPedidos.length;
      if (qtyAct >= DISRUPTIVA_RATIO * prom) {
        var info =
          productByCod[cod] ||
          estadisticaMadre[cod] || { descripcion: cod, categoria: "" };
        disruptivas.push({
          cod: cod,
          descripcion: info.descripcion,
          qtyActual: qtyAct,
          promedio: prom,
          ratio: qtyAct / prom,
        });
      }
    });
    disruptivas.sort(function (a, b) {
      return b.ratio - a.ratio;
    });
  }

  // ---------- EVOLUCIÓN MENSUAL 5 AÑOS ----------
  var evolucion = computeEvolucion(movs);

  return {
    altas: altas,
    bajas: bajas,
    probo1Vez: probo1Vez,
    aOfrecer: aOfrecer,
    stats: stats,
    disruptivas: disruptivas,
    evolucion: evolucion,
    ordersCount: orders.length,
  };
}

function computeAOfrecer(excludedSet) {
  // Productos NUEVOS del catálogo (badge_status === "NUEVO") activos,
  // excluyendo los items que el cliente ya compró (set provisto, normalmente global).
  var excluded = excludedSet instanceof Set ? excludedSet : new Set();

  // Baseline de demanda = mediana del e_madre (unidades/mes en el negocio) de
  // los productos que el cliente SÍ compra. Sirve para el "se vende N× más".
  var _baseVals = [];
  excluded.forEach(function (cod) {
    var em = estadisticaMadre[cod];
    if (em && em.e_madre_uni_mes > 0) _baseVals.push(em.e_madre_uni_mes);
  });
  _baseVals.sort(function (a, b) { return a - b; });
  var _baseline = _baseVals.length ? _baseVals[Math.floor(_baseVals.length / 2)] : 0;

  var arr = [];
  Object.keys(productByCod).forEach(function (cod) {
    var p = productByCod[cod];
    if (!p) return;
    if (p.badge !== "NUEVO") return;
    if (p.active === false) return;
    if (excluded.has(cod)) return;
    var em = estadisticaMadre[cod];
    arr.push({
      cod: cod,
      descripcion: p.descripcion || cod,
      categoria: p.categoria || (em ? em.categoria : "") || "",
      ranking: em ? em.ranking : null,
      e_madre: em ? em.e_madre_uni_mes : null,
      mult: em && em.e_madre_uni_mes && _baseline ? em.e_madre_uni_mes / _baseline : null,
    });
  });

  // ordenar por ranking estadística madre asc (null al final), luego descripción
  arr.sort(function (a, b) {
    var ra = a.ranking == null ? 1e9 : a.ranking;
    var rb = b.ranking == null ? 1e9 : b.ranking;
    if (ra !== rb) return ra - rb;
    return String(a.descripcion).localeCompare(String(b.descripcion));
  });
  return arr.slice(0, TOP_OFRECER);
}

// ============================================================
// CATÁLOGO DE RECUPERACIÓN (PDF) — para mostrarle al cliente cara a cara.
// Nombre del cliente arriba, fotos de storage, A OFRECER (nuevos no comprados,
// con "se vende N× más") y BAJAS (los que compraba y dejó). Reusa jsPDF
// (cargado en admin.html). Chef sirve las fotos en .jpg (no .webp).
// ============================================================
var avcPurchasedSet = null; // set de item_code que el cliente SÍ compra (para el catálogo)
var AVC_BASE_IMG =
  AVC_SUPABASE_URL + "/storage/v1/object/public/products-images/";

// Lista AMPLIA para el catálogo: los más vendidos del negocio (ranking de
// estadística madre) que el cliente NO compra. Devuelve top N con "mult" (N× más).
function avcCatalogoOfrecer(topN) {
  var purchased = avcPurchasedSet || new Set();
  var bv = [];
  purchased.forEach(function (cod) {
    var em = estadisticaMadre[cod];
    if (em && em.e_madre_uni_mes > 0) bv.push(em.e_madre_uni_mes);
  });
  bv.sort(function (x, y) { return x - y; });
  var base = bv.length ? bv[Math.floor(bv.length / 2)] : 0;
  var arr = [];
  Object.keys(productByCod).forEach(function (cod) {
    var p = productByCod[cod];
    if (!p || p.active === false) return;
    if (purchased.has(cod)) return;
    var em = estadisticaMadre[cod];
    if (!em || (em.ranking == null && !em.e_madre_uni_mes)) return; // solo con demanda
    arr.push({
      cod: cod,
      descripcion: p.descripcion || cod,
      categoria: p.categoria || em.categoria || "",
      ranking: em.ranking,
      e_madre: em.e_madre_uni_mes,
      mult: em.e_madre_uni_mes && base ? em.e_madre_uni_mes / base : null,
    });
  });
  arr.sort(function (m, n) {
    var rm = m.ranking == null ? 1e9 : m.ranking;
    var rn = n.ranking == null ? 1e9 : n.ranking;
    return rm - rn;
  });
  return arr.slice(0, topN || 20);
}

function avcLoadImageDataURL(src) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      try {
        var c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        resolve(c.toDataURL("image/jpeg", 0.85));
      } catch (e) {
        resolve(null);
      }
    };
    img.onerror = function () { resolve(null); };
    img.src = src;
  });
}

// ---- Motor de equivalencias de código (misma lógica que el mayorista) ----
var AVC_EQUIV_VARIANT = {
  cromado: 1, cromada: 1, niquelado: 1, niquelada: 1, rojo: 1, roja: 1,
  color: 1, colores: 1, metalizado: 1, metalizada: 1, metalizados: 1,
  acacia: 1, nylon: 1, silicona: 1, silicon: 1, inox: 1, inoxidable: 1,
  acero: 1, madera: 1, loeke: 1, ergonomico: 1, bambu: 1, premium: 1,
  alambre: 1, plastico: 1, plastica: 1, mgo: 1, mango: 1, capuchon: 1,
  super: 1, tradicional: 1, chata: 1, ac: 1
};
var AVC_EQUIV_PREMIUM = { acacia: 1, inox: 1, inoxidable: 1, acero: 1, silicona: 1, premium: 1, bambu: 1 };
function avcEquivNorm(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
function avcEquivBase(desc) {
  var toks = avcEquivNorm(desc).split(" ").filter(function (t) {
    if (!t) return false;
    if (AVC_EQUIV_VARIANT[t]) return false;
    if (/^\d+(cm|mm|ml|lt|l|pza)?$/.test(t)) return false;
    if (t.length === 1) return false;
    if (t === "de" || t === "la" || t === "el" || t === "con" || t === "para" ||
        t === "pza" || t === "pieza" || t === "uso" || t === "usos" || t === "pie") return false;
    return true;
  });
  if (toks[0] && toks[0].length > 4 && toks[0].slice(-1) === "s") toks[0] = toks[0].slice(0, -1);
  return toks.join(" ");
}
function avcEquivTier(desc) {
  var toks = avcEquivNorm(desc).split(" ");
  for (var i = 0; i < toks.length; i++) if (AVC_EQUIV_PREMIUM[toks[i]]) return 1;
  return 0;
}

async function avcDescargarCatalogoPDF() {
  if (!currentCustomer) { alert("Elegí un cliente primero."); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("No se pudo cargar el generador de PDF (jsPDF). Recargá la página.");
    return;
  }
  var br = null;
  for (var i = 0; i < branches.length; i++) {
    if (branches[i].key === activeBranchKey) { br = branches[i]; break; }
  }
  if (!br) br = branches[0];
  var a = (br && br.analysis) || {};
  var purchased = avcPurchasedSet || new Set();

  // --- Equivalencias: base -> grupo, y qué base YA lleva el cliente ---
  var groupByBase = {};
  var baseOf = {};
  Object.keys(productByCod).forEach(function (cod) {
    var p = productByCod[cod];
    if (!p || p.active === false) return;
    var b = avcEquivBase(p.descripcion || "");
    if (!b) return;
    baseOf[cod] = b;
    var em = estadisticaMadre[cod];
    (groupByBase[b] = groupByBase[b] || []).push({
      cod: cod,
      desc: p.descripcion || cod,
      tier: avcEquivTier(p.descripcion || ""),
      precio: p.listPrice && p.uxb ? p.listPrice * p.uxb : null,
      uxb: p.uxb || null,
      ranking: em ? em.ranking : null,
    });
  });
  var carried = {};
  purchased.forEach(function (cod) {
    var b = baseOf[cod];
    if (!b) return;
    var p = productByCod[cod];
    var d = (p && p.descripcion) || cod;
    var t = avcEquivTier((p && p.descripcion) || "");
    if (!carried[b] || t > carried[b].tier) carried[b] = { tier: t, desc: d };
  });

  // --- SUMAR: más vendidos que no compra, SIN equivalentes de lo que ya lleva ---
  var ofrecer = avcCatalogoOfrecer(60);
  var sumar = [];
  for (var k = 0; k < ofrecer.length && sumar.length < 16; k++) {
    var o = ofrecer[k];
    if (carried[baseOf[o.cod]]) continue;
    var p = productByCod[o.cod];
    var sub = o.categoria ? o.categoria + ". " : "";
    if (o.mult && o.mult >= 1.3) {
      sub += "Se vende ~" + (o.mult >= 10 ? Math.round(o.mult) : o.mult.toFixed(1)) +
        "× más que tu compra promedio.";
    } else if (o.e_madre) { sub += "Buena demanda en el mercado."; }
    sumar.push({
      cod: o.cod, titulo: o.descripcion || o.cod,
      precio: p && p.listPrice && p.uxb ? p.listPrice * p.uxb : null,
      uxb: p && p.uxb ? p.uxb : null,
      sub: sub || "Producto del catálogo con demanda.", ranking: o.ranking,
    });
  }

  // --- MEJORÁ: por cada base que lleva en estándar, la versión premium equivalente ---
  var upgrades = [];
  var seenUp = {};
  Object.keys(carried).forEach(function (b) {
    if (carried[b].tier >= 1) return;
    (groupByBase[b] || []).forEach(function (g) {
      if (g.tier < 1 || purchased.has(g.cod) || seenUp[g.cod]) return;
      seenUp[g.cod] = 1;
      upgrades.push({
        cod: g.cod, titulo: g.desc, precio: g.precio, uxb: g.uxb,
        sub: "Vos llevás " + String(carried[b].desc).trim() + ". Probá esta versión premium.",
        ranking: g.ranking,
      });
    });
  });
  upgrades.sort(function (m, n) {
    var rm = m.ranking == null ? 1e9 : m.ranking, rn = n.ranking == null ? 1e9 : n.ranking;
    return rm - rn;
  });
  upgrades = upgrades.slice(0, 8);

  // --- BAJAS: productos que dejó de llevar ---
  var bajasRaw = a.bajas || [];
  var bajas = bajasRaw.map(function (b) {
    var p = productByCod[b.cod];
    var last = b.ultimaCompra ? new Date(b.ultimaCompra) : null;
    var lastTxt = last ? "Última compra: " + last.toLocaleDateString("es-AR") : "";
    var extra = b.comprasCount ? "  ·  " + b.comprasCount + " compras" : "";
    return {
      cod: b.cod, titulo: b.descripcion || (p && p.descripcion) || b.cod,
      precio: p && p.listPrice && p.uxb ? p.listPrice * p.uxb : null,
      uxb: p && p.uxb ? p.uxb : null,
      sub: (lastTxt + extra).trim() || "Lo comprabas antes.",
    };
  }).slice(0, 16);

  var secciones = [];
  if (sumar.length) secciones.push({ titulo: "PRODUCTOS PARA SUMAR", items: sumar });
  if (upgrades.length) secciones.push({ titulo: "MEJORÁ LO QUE YA LLEVÁS", items: upgrades });
  if (bajas.length) secciones.push({ titulo: "PRODUCTOS QUE DEJASTE DE LLEVAR", items: bajas });
  if (!secciones.length) {
    alert("Este cliente no tiene productos para ofrecer ni bajas para mostrar.");
    return;
  }

  var btn = document.getElementById("btnCatalogoPDF");
  var btnTxt = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Generando…"; }
  try {
    var rs = (currentCustomer.business_name || "Cliente").trim();
    await avcBuildCatalogoPDF(rs, String(currentCustomer.cod_cliente || ""), secciones);
  } catch (e) {
    console.error("[AVC] catálogo PDF falló:", e);
    alert("No se pudo generar el catálogo: " + (e && e.message ? e.message : e));
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = btnTxt || "📄 Catálogo PDF"; }
  }
}

// Render 2 columnas con foto + precio + subtítulo (mismo layout que el mayorista).
async function avcBuildCatalogoPDF(rs, cod, secciones) {
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF("p", "mm", "a4");
  var W = 210, H = 297, M = 12, GAP = 8;
  var colW = (W - 2 * M - GAP) / 2;
  var photoW = 46, cardH = 82;
  var y, col;

  function money(n) {
    if (n == null || !isFinite(n)) return "";
    return "$" + Math.round(n).toLocaleString("es-AR");
  }

  doc.setFillColor(17, 24, 39);
  doc.rect(0, 0, W, 42, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("SELECCIÓN PREPARADA PARA", M, 16);
  doc.setFontSize(18);
  doc.text(String(rs).toUpperCase().slice(0, 40), M, 27);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 200, 200);
  doc.text("Cod " + cod + "  ·  Productos elegidos para vos", M, 36);
  doc.setTextColor(0, 0, 0);
  y = 50; col = 0;

  function nextPage() { doc.addPage(); y = M + 4; col = 0; }

  function seccion(txt) {
    if (col === 1) { y += cardH; col = 0; }
    if (y > H - cardH - 12) nextPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(180, 30, 30);
    doc.text(txt, M, y);
    doc.setTextColor(0, 0, 0);
    y += 2;
    doc.setDrawColor(220, 220, 220);
    doc.line(M, y, W - M, y);
    y += 7;
  }

  async function card(item) {
    if (col === 0 && y + cardH > H - M) nextPage();
    var x = M + col * (colW + GAP);
    var px = x + (colW - photoW) / 2;
    var dataUrl = await avcLoadImageDataURL(
      AVC_BASE_IMG + encodeURIComponent(item.cod) + ".jpg"
    );
    if (dataUrl) {
      try { doc.addImage(dataUrl, "JPEG", px, y, photoW, photoW); } catch (e) {}
    } else {
      doc.setDrawColor(230, 230, 230);
      doc.rect(px, y, photoW, photoW);
      doc.setFontSize(7);
      doc.setTextColor(175, 175, 175);
      doc.text("sin foto", x + colW / 2 - 6, y + photoW / 2);
      doc.setTextColor(0, 0, 0);
    }
    var ty = y + photoW + 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    var tl = doc.splitTextToSize(String(item.titulo || item.cod), colW).slice(0, 2);
    doc.text(tl, x, ty);
    ty += tl.length * 4.4 + 1;
    if (item.precio) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(20, 120, 40);
      doc.text(money(item.precio) + (item.uxb ? " /caja (" + item.uxb + " u.)" : ""), x, ty);
      doc.setTextColor(0, 0, 0);
      ty += 5;
    }
    if (item.sub) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(110, 110, 110);
      doc.text(doc.splitTextToSize(String(item.sub), colW).slice(0, 3), x, ty);
      doc.setTextColor(0, 0, 0);
    }
    if (col === 0) { col = 1; } else { col = 0; y += cardH; }
  }

  for (var s = 0; s < (secciones || []).length; s++) {
    seccion(secciones[s].titulo);
    var items = secciones[s].items || [];
    for (var i = 0; i < items.length; i++) await card(items[i]);
    if (col === 1) { y += cardH; col = 0; }
  }

  doc.save("catalogo_" + cod + ".pdf");
}
if (typeof window !== "undefined") window.avcDescargarCatalogoPDF = avcDescargarCatalogoPDF;

// ============================================================
// ACUERDO — índice precio_lista / precio_neto
// Fórmula: cascada del Excel "Formato Calculo Acuerdo"
//   bruto = (1 - dto_vol) * (1 - dto_pago) * (1 - dto_web)
//   neto  = bruto * (1 - flete) * (1 - comision) * (1 - costo_fin)
//   acuerdo = 1 / neto
// dto_vol = customers.dto_vol (por cliente)
// comision = customer_commissions.rate (por cliente). Sin valor o cliente fuera de tabla → 0%.
// resto: tasas fijas del formato (ajustar acá si cambian)
// ============================================================
var ACUERDO_RATES = {
  dtoPago: 0.25,
  dtoWeb: 0.02,
  flete: 0.015,
  costoFin: 0,
  comisionFallback: 0, // cliente sin valor en planilla → 0% por ahora
};

// Cache cargado una vez por sesión: cod_cliente (string) -> rate (number) | null
var commissionByCod = null;
async function loadCommissions() {
  if (commissionByCod) return commissionByCod;
  commissionByCod = {};
  var r = await sb
    .from("customer_commissions")
    .select("cod_cliente, rate")
    .limit(5000);
  if (r.error) {
    console.warn("loadCommissions error", r.error.message);
    return commissionByCod;
  }
  (r.data || []).forEach(function (row) {
    var k = String(row.cod_cliente);
    var v = row.rate == null ? null : Number(row.rate);
    commissionByCod[k] = v;
  });
  return commissionByCod;
}

function comisionForCustomer(c) {
  if (!c || !commissionByCod) return ACUERDO_RATES.comisionFallback;
  var key = String(c.cod_cliente || "");
  var v = commissionByCod[key];
  if (v == null || !isFinite(v)) return ACUERDO_RATES.comisionFallback;
  return v;
}

function computeAcuerdo(customer) {
  if (!customer) return null;
  var dtoVol = Number(customer.dto_vol || 0);
  if (!isFinite(dtoVol)) dtoVol = 0;
  if (dtoVol > 1) dtoVol = dtoVol / 100; // normalizar si viniera como % crudo
  var comision = comisionForCustomer(customer);
  var r = ACUERDO_RATES;
  var bruto = (1 - dtoVol) * (1 - r.dtoPago) * (1 - r.dtoWeb);
  var neto = bruto * (1 - r.flete) * (1 - comision) * (1 - r.costoFin);
  if (neto <= 0) return null;
  return {
    indice: 1 / neto, // ej 1.51
    netoPct: neto, // ej 0.6624 = 66.24% de la lista
    descuentoTotalPct: 1 - neto, // ej 0.3376 = 33.76% off lista
    dtoVol: dtoVol,
    comision: comision,
  };
}

// ============================================================
// FRECUENCIA ALERT — flag cliente que se "sale" de su frecuencia de compra
//   level=null   : insuficientes pedidos / sin freq / al día
//   level='due'  : pasó >= 1× freq desde última compra (esperando pedido)
//   level='overdue': pasó >= 1.5× freq (atrasado)
// Mín. 3 pedidos para considerar la freq confiable.
// ============================================================
var FREQ_ALERT_DUE_RATIO = 1.0;
var FREQ_ALERT_OVERDUE_RATIO = 1.5;
var FREQ_ALERT_MIN_ORDERS = 3;

function computeFrequencyAlert(s) {
  if (!s || !s.frecuenciaMeses || !s.ultimaCompra) return null;
  if ((s.pedidos || 0) < FREQ_ALERT_MIN_ORDERS) return null;
  var nowMs = Date.now();
  var last = s.ultimaCompra instanceof Date ? s.ultimaCompra.getTime() : 0;
  if (!last) return null;
  var monthsSinceLast = (nowMs - last) / (1000 * 60 * 60 * 24 * 30.4375);
  if (monthsSinceLast <= 0) return null;
  var ratio = monthsSinceLast / s.frecuenciaMeses;
  var level = null;
  if (ratio >= FREQ_ALERT_OVERDUE_RATIO) level = "overdue";
  else if (ratio >= FREQ_ALERT_DUE_RATIO) level = "due";
  if (!level) return null;
  return {
    level: level,
    monthsSinceLast: monthsSinceLast,
    freq: s.frecuenciaMeses,
    ratio: ratio,
  };
}

function computeStats(orders, branch) {
  if (!orders.length) {
    return {
      pedidos: 0,
      frecuenciaMeses: null,
      promCajas: null,
      promUnidades: null,
      acuerdo: null,
      ranking: branch.type === "consolidated" ? ranking12m : null,
    };
  }

  // frecuencia: meses promedio entre pedidos consecutivos
  var freq = null;
  if (orders.length >= 2) {
    var diffs = [];
    for (var i = 1; i < orders.length; i++) {
      var ms = orders[i].fecha - orders[i - 1].fecha;
      diffs.push(ms / (1000 * 60 * 60 * 24 * 30.4375));
    }
    freq =
      diffs.reduce(function (a, b) {
        return a + b;
      }, 0) / diffs.length;
  }

  // promedio CAJAS por pedido + total unidades (referencia)
  var totalU = 0;
  var totalB = 0;
  orders.forEach(function (o) {
    Object.keys(o.items).forEach(function (cod) {
      totalU += o.items[cod];
    });
    Object.keys(o.itemsBoxes || {}).forEach(function (cod) {
      totalB += o.itemsBoxes[cod];
    });
  });
  var promCajas = totalB / orders.length;
  var promUni = totalU / orders.length;

  return {
    pedidos: orders.length,
    frecuenciaMeses: freq,
    promCajas: promCajas,
    promUnidades: promUni,
    totalCajas: totalB,
    totalUnidades: totalU,
    acuerdo: null,
    ranking: branch.type === "consolidated" ? ranking12m : null,
    primeraCompra: orders[0].fecha,
    ultimaCompra: orders[orders.length - 1].fecha,
  };
}

function computeEvolucion(movs) {
  // últimos 60 meses — agrega unidades y monto $ aproximado por mes
  var ahora = new Date();
  var startKey = ahora.getFullYear() * 12 + ahora.getMonth() - 59;
  var bucketU = {};
  var bucketM = {};
  movs.forEach(function (m) {
    var k = m.fecha.getFullYear() * 12 + m.fecha.getMonth();
    if (k < startKey) return;
    var qty = Number(m.qty) || 0;
    bucketU[k] = (bucketU[k] || 0) + qty;
    var price =
      (productByCod[m.item_code] && productByCod[m.item_code].listPrice) || 0;
    bucketM[k] = (bucketM[k] || 0) + qty * price;
  });
  var rows = [];
  for (
    var k = ahora.getFullYear() * 12 + ahora.getMonth();
    k >= startKey;
    k--
  ) {
    var year = Math.floor(k / 12);
    var mon = k % 12;
    rows.push({
      mes: MESES[mon] + "-" + String(year).slice(-2),
      year: year,
      mon: mon,
      unidades: bucketU[k] || 0,
      monto: bucketM[k] || 0,
    });
  }
  return rows;
}

// ============================================================
// RENDER
// ============================================================
function renderClienteInfo() {
  var c = currentCustomer;
  var info = $("clienteInfo");
  if (!info) return;
  if (!c) {
    info.style.display = "none";
    return;
  }
  // En modo customer (cliente viendo su propio perfil), ocultamos el banner
  // con CUIT / email / sucursales / artículos / meses — el cliente ya ve sus
  // datos arriba en la profile-summary del perfil, esto es redundante.
  if (AVC_CUSTOMER_MODE) {
    info.style.display = "none";
    return;
  }
  // Métricas claras del cliente:
  //  - Artículos distintos: cantidad de cods únicos en todo el histórico
  //  - Meses con compra: meses calendario donde compró algo (cualquier item)
  var itemsSet = new Set();
  var monthSet = new Set();
  movements.forEach(function (m) {
    itemsSet.add(m.item_code);
    monthSet.add(m.fecha.getFullYear() + "-" + (m.fecha.getMonth() + 1));
  });
  // Badge de alerta de frecuencia (consolidado)
  var alertBadge = "";
  var consolidated = branches.find(function (b) {
    return b.type === "consolidated";
  });
  if (consolidated && consolidated.analysis && consolidated.analysis.stats) {
    var fa = computeFrequencyAlert(consolidated.analysis.stats);
    if (fa) {
      var cls =
        fa.level === "overdue"
          ? "avc-alert-badge avc-alert-badge--danger"
          : "avc-alert-badge avc-alert-badge--warn";
      var icon = fa.level === "overdue" ? "🚨" : "⚠️";
      var label =
        fa.level === "overdue" ? "ATRASADO" : "ESPERANDO PEDIDO";
      var detail =
        "últ. hace " +
        fmtNumber(fa.monthsSinceLast, 1) +
        " m (frecuencia " +
        fmtNumber(fa.freq, 1) +
        " m)";
      alertBadge =
        '<span class="' +
        cls +
        '" title="' +
        escHtml(detail) +
        '">' +
        icon +
        " " +
        label +
        " · " +
        escHtml(detail) +
        "</span> ";
    }
  }

  info.innerHTML =
    '<div class="avc-info-card">' +
    alertBadge +
    "<strong>" +
    escHtml(c.business_name || "") +
    "</strong>" +
    (c.cuit ? " — CUIT " + escHtml(c.cuit) : "") +
    (c.mail ? " — " + escHtml(c.mail) : "") +
    " — Sucursales registradas: " +
    currentAddresses.length +
    " — Artículos distintos: " +
    itemsSet.size +
    " — Meses con compra: " +
    monthSet.size +
    "</div>";
}

function renderTabs() {
  var tabs = $("sucursalTabs");
  tabs.innerHTML = branches
    .map(function (br) {
      var ds = new Set();
      br.movements.forEach(function (m) {
        ds.add(m.item_code);
      });
      // tooltip extendido: incluye dirección si la tiene
      var tooltipParts = [ds.size + " artículos distintos"];
      if (br.address) {
        if (br.address.label) tooltipParts.push("Label: " + br.address.label);
        if (br.address.direccion_entrega)
          tooltipParts.push("Dirección: " + br.address.direccion_entrega);
      }
      return (
        '<button class="avc-tab" data-key="' +
        escHtml(br.key) +
        '" title="' +
        escHtml(tooltipParts.join(" • ")) +
        '">' +
        escHtml(br.label) +
        " (" +
        ds.size +
        ")</button>"
      );
    })
    .join("");
  tabs.querySelectorAll(".avc-tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      activateBranch(btn.dataset.key);
    });
  });
}

function activateBranch(key) {
  activeBranchKey = key;
  $("sucursalTabs")
    .querySelectorAll(".avc-tab")
    .forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.key === key);
    });
  var br = branches.find(function (b) {
    return b.key === key;
  });
  if (!br) return;
  renderBranchContent(br);
}

function renderBranchContent(br) {
  var cont = $("sucursalContent");
  var a = br.analysis;
  var html = "";

  // STATS
  html += renderStatsBlock(br, a.stats);

  // ALTAS (collapsible)
  html += renderTableBlock(
    "Altas (primera compra)",
    a.altas,
    [
      { key: "descripcion", label: "Descripción" },
      { key: "categoria", label: "Categoría" },
      {
        key: "fecha",
        label: "1ra Compra",
        fmt: function (v) {
          return fmtMonthYear(v);
        },
      },
      {
        key: "qty",
        label: "Unidades",
        cls: "num",
        fmt: function (v) {
          return fmtNumber(v);
        },
      },
    ],
    null,
    true,
  );

  // BAJAS (collapsible)
  html += renderBajasBlock(a.bajas, true);

  // PROBÓ 1 VEZ (collapsible)
  html += renderTableBlock(
    "Probó solo 1 vez",
    a.probo1Vez,
    [
      { key: "descripcion", label: "Descripción" },
      { key: "mes", label: "Mes/Año" },
      {
        key: "qty",
        label: "Unidades",
        cls: "num",
        fmt: function (v) {
          return fmtNumber(v);
        },
      },
    ],
    "Items con una sola compra histórica.",
    true,
  );

  // A OFRECER (collapsible) — Top N productos NUEVOS del catálogo no comprados
  html += renderTableBlock(
    "A Ofrecer (Top " + TOP_OFRECER + " Nuevos)",
    a.aOfrecer,
    [
      { key: "descripcion", label: "Descripción" },
      { key: "categoria", label: "Categoría" },
      {
        key: "ranking",
        label: "Ranking Madre",
        cls: "num",
        fmt: function (v) {
          return v == null ? "—" : v;
        },
      },
      {
        key: "e_madre",
        label: "E.Madre Uni/Mes",
        cls: "num",
        fmt: function (v) {
          return v == null ? "—" : fmtNumber(v);
        },
      },
    ],
    "Productos marcados NUEVO en el catálogo que el cliente todavía no compró.",
    true,
  );

  // DISRUPTIVAS
  if (a.disruptivas.length) {
    html += renderDisruptivasBlock(a.disruptivas);
  }

  // EVOLUCIÓN (gráfico)
  html += renderEvolucionBlock(a.evolucion);

  cont.innerHTML = html;

  // Inicializar charts después de insertar el HTML
  initEvoCharts(cont);

  // Re-inicializar el chart cuando se abre el details (Chart.js puede dimensionar mal si arranca oculto)
  cont.querySelectorAll("details.avc-collapsible").forEach(function (det) {
    det.addEventListener(
      "toggle",
      function () {
        if (det.open) initEvoCharts(det);
      },
      { once: false },
    );
  });
}

function wrapCollapsible(title, count, bodyHtml, opts) {
  opts = opts || {};
  var openAttr = opts.open ? " open" : "";
  var bodyCls =
    "avc-block-body" + (opts.bodyClass ? " " + opts.bodyClass : "");
  return (
    '<details class="avc-block avc-collapsible"' +
    openAttr +
    ">" +
    '<summary class="avc-block-head">' +
    '<span class="avc-caret" aria-hidden="true">▸</span>' +
    '<h3 class="avc-block-title">' +
    escHtml(title) +
    "</h3>" +
    (count != null
      ? '<span class="avc-block-count">' + escHtml(count) + "</span>"
      : "") +
    "</summary>" +
    '<div class="' +
    bodyCls +
    '">' +
    bodyHtml +
    "</div></details>"
  );
}

function renderStatsBlock(br, s) {
  var cards = [];
  cards.push(stat("Pedidos", fmtNumber(s.pedidos)));
  var freqAlert = computeFrequencyAlert(s);
  var freqValue =
    s.frecuenciaMeses == null ? "—" : fmtNumber(s.frecuenciaMeses, 1) + " m";
  var freqSub = "meses entre pedidos";
  var freqOpts = {};
  if (freqAlert) {
    freqSub =
      "últ. hace " +
      fmtNumber(freqAlert.monthsSinceLast, 1) +
      " m · esperaba cada " +
      fmtNumber(freqAlert.freq, 1) +
      " m";
    if (freqAlert.level === "overdue") {
      freqOpts = { tone: "danger", icon: "🚨" };
    } else {
      freqOpts = { tone: "warn", icon: "⚠️" };
    }
  }
  cards.push(stat("Frecuencia", freqValue, freqSub, freqOpts));
  cards.push(
    stat(
      "Promedio cajas",
      s.promCajas == null ? "—" : fmtNumber(Math.round(s.promCajas)),
      "por pedido",
    ),
  );
  // Ranking 12m: info comparativa entre clientes (posición / total clientes).
  // OCULTA en modo customer — al cliente no le interesa su ranking entre
  // otros clientes, y mostrarlo expondría que hay más arriba que él.
  if (!AVC_CUSTOMER_MODE && br.type === "consolidated" && s.ranking) {
    cards.push(
      stat(
        "Ranking 12m",
        s.ranking.pos != null ? "#" + s.ranking.pos : "—",
        "de " +
          (s.ranking.total || 0) +
          " — " +
          fmtNumber(s.ranking.unidades) +
          " uni",
      ),
    );
  }
  // Percentil lifetime — sólo en la branch Consolidado y para admin/vendor
  // (NO en modo customer, es info interna). Muestra dónde está el cliente
  // vs todos los clientes según unidades/mes promedio desde primera compra.
  if (
    br.type === "consolidated" &&
    !AVC_CUSTOMER_MODE &&
    typeof percentilLifetime !== "undefined" &&
    percentilLifetime
  ) {
    var pl = percentilLifetime;
    var tone = pl.pct >= 80 ? "good" : pl.pct >= 50 ? "" : pl.pct >= 20 ? "warn" : "danger";
    var icon = pl.pct >= 80 ? "🏆" : pl.pct >= 50 ? "" : pl.pct >= 20 ? "⚠️" : "🚨";
    var plOpts = {};
    if (tone === "good") plOpts = { icon: icon };
    else if (tone === "warn") plOpts = { tone: "warn", icon: icon };
    else if (tone === "danger") plOpts = { tone: "danger", icon: icon };
    cards.push(
      stat(
        "Percentil",
        "P" + pl.pct,
        "#" + pl.pos + " de " + pl.total + " · " +
          fmtNumber(Math.round(pl.avgPerMonth)) + " uni/mes (" +
          pl.monthsActive + "m)",
        plOpts,
      ),
    );
  }
  // Acuerdo (DV%, Com%, s/lista): info interna del vendor — OCULTA en modo
  // customer (cliente viendo su propio perfil) por privacidad/relevancia.
  if (!AVC_CUSTOMER_MODE) {
    var ac = computeAcuerdo(currentCustomer);
    if (ac) {
      var dvPct = ac.dtoVol * 100;
      var comPct = ac.comision * 100;
      var offPct = ac.descuentoTotalPct * 100;
      cards.push(
        stat(
          "Acuerdo",
          fmtNumber(ac.indice, 2),
          "DV " +
            fmtNumber(dvPct, dvPct % 1 === 0 ? 0 : 1) +
            "% · Com " +
            fmtNumber(comPct, comPct % 1 === 0 ? 0 : 1) +
            "% · " +
            fmtNumber(offPct, 1) +
            "% s/lista",
        ),
      );
    } else {
      cards.push(stat("Acuerdo", "—", "sin datos"));
    }
  }
  if (s.primeraCompra && s.ultimaCompra) {
    cards.push(
      stat(
        "Plazo Compras",
        fmtMonthYear(s.primeraCompra) + " — " + fmtMonthYear(s.ultimaCompra),
        "primera → última",
      ),
    );
  } else if (s.primeraCompra) {
    cards.push(stat("Primera compra", fmtMonthYear(s.primeraCompra)));
  } else if (s.ultimaCompra) {
    cards.push(stat("Última compra", fmtMonthYear(s.ultimaCompra)));
  }

  var body = '<div class="avc-stats-grid">' + cards.join("") + "</div>";
  return wrapCollapsible("Estadísticas", null, body, { open: true });
}

function stat(label, value, sub, opts) {
  opts = opts || {};
  var cls = "avc-stat-card";
  if (opts.tone === "warn") cls += " avc-stat-card--warn";
  else if (opts.tone === "danger") cls += " avc-stat-card--danger";
  var icon = "";
  if (opts.icon) {
    icon = '<span class="avc-stat-icon" aria-hidden="true">' + opts.icon + "</span> ";
  }
  return (
    '<div class="' +
    cls +
    '">' +
    '<div class="avc-stat-label">' +
    icon +
    escHtml(label) +
    "</div>" +
    '<div class="avc-stat-value">' +
    escHtml(value) +
    "</div>" +
    (sub
      ? '<div class="avc-stat-sub">' + escHtml(sub) + "</div>"
      : "") +
    "</div>"
  );
}

function renderTableBlock(title, rows, cols, hint, _legacy, opts) {
  // Siempre collapsible.
  opts = opts || {};
  var tableClass = "avc-table" + (opts.dense ? " avc-table--dense" : "");
  if (!rows.length) {
    return wrapCollapsible(
      title,
      0,
      '<div class="avc-block-empty">Sin datos.</div>',
    );
  }
  // auto-tag para columna de descripción (permite wrap con max-width)
  function _colCls(c) {
    if (c.cls) return c.cls;
    if (c.key === "descripcion") return "desc";
    return "";
  }
  var th = cols
    .map(function (c) {
      var cls = _colCls(c);
      return (
        "<th" + (cls ? ' class="' + cls + '"' : "") + ">" +
        escHtml(c.label) +
        "</th>"
      );
    })
    .join("");
  var tb = rows
    .map(function (r) {
      return (
        "<tr>" +
        cols
          .map(function (c) {
            var v = r[c.key];
            if (c.fmt) v = c.fmt(v);
            var cls = _colCls(c);
            return (
              "<td" +
              (cls ? ' class="' + cls + '"' : "") +
              ">" +
              escHtml(v == null ? "" : v) +
              "</td>"
            );
          })
          .join("") +
        "</tr>"
      );
    })
    .join("");
  var hintHtml = hint
    ? '<div style="padding:0 0 6px; color:var(--text3); font-size:11.5px">' +
      escHtml(hint) +
      "</div>"
    : "";
  var bodyClass = opts.dense
    ? '<div class="avc-block-body avc-block-body--dense">'
    : '<div class="avc-block-body-inner">';
  // wrapCollapsible ya envuelve el body en .avc-block-body con padding default.
  // Para dense, sustituimos el padding default usando override en CSS.
  var body =
    hintHtml +
    '<div class="avc-table-wrap"><table class="' +
    tableClass +
    '"><thead><tr>' +
    th +
    "</tr></thead><tbody>" +
    tb +
    "</tbody></table></div>";
  return wrapCollapsible(title, rows.length, body, {
    bodyClass: opts.dense ? "avc-block-body--dense" : null,
  });
}

function renderBajasBlock(rows /* , _legacy */) {
  if (!rows.length) {
    return wrapCollapsible(
      "Bajas",
      0,
      '<div class="avc-block-empty">Sin bajas.</div>',
    );
  }
  // Bajas: sin descripción (la columna se tapaba). Identifica por Cod.
  var ths =
    "<th>Cod</th><th>Plazo Compro</th>" +
    '<th class="num">Últ. compra (uni)</th><th class="num">Promedio (uni)</th>' +
    "<th>1ra Baja</th><th>2da Baja</th><th>3ra Baja</th><th>4ta Baja</th><th>5ta Baja</th>";
  var tb = rows
    .map(function (r) {
      var cells = [
        { v: r.cod },
        { v: r.plazoCompro },
        { v: fmtNumber(r.ultimaQty), cls: "num" },
        { v: fmtNumber(r.promedioQty, 1), cls: "num" },
        { v: r.bajas[0] || "" },
        { v: r.bajas[1] || "" },
        { v: r.bajas[2] || "" },
        { v: r.bajas[3] || "" },
        { v: r.bajas[4] || "" },
      ];
      return (
        "<tr>" +
        cells
          .map(function (c) {
            return (
              "<td" +
              (c.cls ? ' class="' + c.cls + '"' : "") +
              ">" +
              escHtml(c.v) +
              "</td>"
            );
          })
          .join("") +
        "</tr>"
      );
    })
    .join("");
  var body =
    '<div class="avc-table-wrap"><table class="avc-table"><thead><tr>' +
    ths +
    "</tr></thead><tbody>" +
    tb +
    "</tbody></table></div>";
  return wrapCollapsible("Bajas", rows.length, body);
}

function renderDisruptivasBlock(rows) {
  var hint =
    '<div style="padding:0 0 10px; color:var(--text3); font-size:12px">' +
    "Líneas cuya cantidad ≥ " +
    DISRUPTIVA_RATIO +
    "× el promedio histórico de ese cliente para el item.</div>";
  var tb = rows
    .map(function (r) {
      return (
        '<tr class="avc-disruptive">' +
        '<td class="desc">' +
        escHtml(r.descripcion) +
        "</td>" +
        '<td class="num">' +
        fmtNumber(r.qtyActual) +
        "</td>" +
        '<td class="num">' +
        fmtNumber(r.promedio, 1) +
        "</td>" +
        '<td class="num">' +
        fmtNumber(r.ratio, 2) +
        "×</td>" +
        "</tr>"
      );
    })
    .join("");
  var body =
    hint +
    '<div class="avc-table-wrap"><table class="avc-table"><thead><tr>' +
    '<th class="desc">Descripción</th><th class="num">Qty última</th><th class="num">Prom histórico</th><th class="num">Ratio</th>' +
    "</tr></thead><tbody>" +
    tb +
    "</tbody></table></div>";
  return wrapCollapsible("⚡ Disruptivas (última compra)", rows.length, body);
}

// el chartId es único por branch para no pisar canvases entre tabs
var _evoChartId = 0;
var _evoChartInstances = {};

function renderEvolucionBlock(rows) {
  var canvasId = "avcEvoChart_" + ++_evoChartId;
  // datos asc (más viejo a más nuevo) — invertimos porque vienen desc
  var asc = rows.slice().reverse();
  var labels = asc.map(function (r) {
    return r.mes;
  });
  var dataU = asc.map(function (r) {
    return r.unidades;
  });
  var dataM = asc.map(function (r) {
    return Math.round(r.monto || 0);
  });
  var dataJson = encodeURIComponent(
    JSON.stringify({ labels: labels, dataU: dataU, dataM: dataM }),
  );
  var hint =
    '<div style="padding:0 0 8px; color:var(--text3); font-size:11.5px">' +
    "Importes calculados como Unidades × Precio de lista actual " +
    "(aproximación; los precios reales cambian en el tiempo).</div>";
  var body =
    hint +
    '<div style="position:relative; height:300px">' +
    '<canvas id="' +
    canvasId +
    '" data-evo="' +
    dataJson +
    '"></canvas>' +
    "</div>";
  return wrapCollapsible(
    "Evolución mensual (últimos 5 años)",
    rows.length + " meses",
    body,
  );
}

function initEvoCharts(rootEl) {
  if (typeof Chart === "undefined") return;
  // destruir instancias previas
  Object.keys(_evoChartInstances).forEach(function (k) {
    try {
      _evoChartInstances[k].destroy();
    } catch (e) {}
    delete _evoChartInstances[k];
  });
  var canvases = rootEl.querySelectorAll("canvas[data-evo]");
  canvases.forEach(function (cv) {
    try {
      var raw = cv.getAttribute("data-evo");
      var parsed = JSON.parse(decodeURIComponent(raw));
      var ctx = cv.getContext("2d");
      _evoChartInstances[cv.id] = new Chart(ctx, {
        data: {
          labels: parsed.labels,
          datasets: [
            {
              type: "bar",
              label: "Unidades",
              data: parsed.dataU,
              backgroundColor: "rgba(33, 33, 34, 0.7)",
              borderColor: "rgba(33, 33, 34, 1)",
              borderWidth: 1,
              borderRadius: 3,
              maxBarThickness: 22,
              yAxisID: "yU",
              order: 2,
            },
            {
              type: "line",
              label: "Importe ($)",
              data: parsed.dataM,
              borderColor: "rgba(213, 0, 0, 1)",
              backgroundColor: "rgba(213, 0, 0, 0.12)",
              borderWidth: 2,
              tension: 0.25,
              pointRadius: 2,
              pointHoverRadius: 4,
              pointBackgroundColor: "rgba(213, 0, 0, 1)",
              fill: false,
              yAxisID: "yM",
              order: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: {
              display: true,
              position: "top",
              align: "end",
              labels: { font: { size: 11 }, boxWidth: 14 },
            },
            tooltip: {
              callbacks: {
                label: function (ctx) {
                  var v = Number(ctx.parsed.y || 0);
                  if (ctx.dataset.label === "Importe ($)") {
                    return (
                      "Importe: $ " +
                      v.toLocaleString("es-AR", {
                        maximumFractionDigits: 0,
                      })
                    );
                  }
                  return "Uni: " + v.toLocaleString("es-AR");
                },
              },
            },
          },
          scales: {
            x: {
              ticks: {
                font: { size: 10 },
                maxRotation: 45,
                minRotation: 45,
                autoSkip: true,
                maxTicksLimit: 24,
              },
              grid: { display: false },
            },
            yU: {
              type: "linear",
              position: "left",
              beginAtZero: true,
              ticks: {
                font: { size: 11 },
                callback: function (v) {
                  return Number(v).toLocaleString("es-AR");
                },
              },
              grid: { color: "rgba(0,0,0,0.05)" },
              title: {
                display: true,
                text: "Unidades",
                font: { size: 10 },
                color: "rgba(0,0,0,0.5)",
              },
            },
            yM: {
              type: "linear",
              position: "right",
              beginAtZero: true,
              ticks: {
                font: { size: 11 },
                color: "rgba(213, 0, 0, 1)",
                callback: function (v) {
                  var n = Number(v);
                  if (n >= 1000000)
                    return "$ " + (n / 1000000).toFixed(1) + "M";
                  if (n >= 1000) return "$ " + Math.round(n / 1000) + "k";
                  return "$ " + n;
                },
              },
              grid: { display: false },
              title: {
                display: true,
                text: "Importe $",
                font: { size: 10 },
                color: "rgba(213, 0, 0, 0.7)",
              },
            },
          },
        },
      });
    } catch (e) {
      console.warn("evo chart init", e);
    }
  });
}

// ============================================================
// EXPORT EXCEL — FASE 7
// ============================================================
function onExportarExcel() {
  if (!currentCustomer || !branches.length) {
    alert("Buscá un cliente primero.");
    return;
  }
  try {
    var wb = XLSX.utils.book_new();

    // Hoja Resumen (overview cliente + branches)
    var resumen = [];
    resumen.push(["Análisis Venta Cliente"]);
    resumen.push([
      "Cliente",
      currentCustomer.business_name || "",
    ]);
    resumen.push(["Cod Cliente", currentCustomer.cod_cliente]);
    resumen.push(["CUIT", currentCustomer.cuit || ""]);
    resumen.push(["Email", currentCustomer.mail || ""]);
    resumen.push(["Movimientos totales", movements.length]);
    resumen.push(["Sucursales del cliente", currentAddresses.length]);
    resumen.push([
      "Generado",
      new Date().toLocaleString("es-AR"),
    ]);
    resumen.push([]);
    resumen.push(["Sucursal", "Pedidos", "Movimientos", "Última compra"]);
    branches.forEach(function (br) {
      var s = br.analysis.stats;
      resumen.push([
        br.label,
        s.pedidos || 0,
        br.movements.length,
        s.ultimaCompra ? fmtMonthYearMM(s.ultimaCompra) : "",
      ]);
    });
    var wsRes = XLSX.utils.aoa_to_sheet(resumen);
    wsRes["!cols"] = [
      { wch: 28 },
      { wch: 36 },
      { wch: 14 },
      { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, wsRes, "Resumen");

    // Una hoja por branch
    branches.forEach(function (br) {
      var aoa = buildBranchAOA(br);
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [
        { wch: 12 },
        { wch: 36 },
        { wch: 18 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
      ];
      var sheetName = sanitizeSheetName(br.label, 25);
      // evitar colisión
      var base = sheetName;
      var n = 1;
      while (wb.SheetNames.indexOf(sheetName) !== -1) {
        sheetName = base + " " + ++n;
      }
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    var fname =
      "analisis-venta-" +
      currentCustomer.cod_cliente +
      "-" +
      new Date().toISOString().slice(0, 10) +
      ".xlsx";
    XLSX.writeFile(wb, fname);
  } catch (err) {
    console.error("export excel error", err);
    alert("Error generando Excel: " + (err.message || err));
  }
}

function sanitizeSheetName(name, maxLen) {
  var s = String(name || "Hoja").replace(/[\\\/\?\*\[\]:]/g, "-");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s || "Hoja";
}

function buildBranchAOA(br) {
  var rows = [];
  var a = br.analysis;
  var s = a.stats;

  rows.push([br.label]);
  rows.push([]);

  // Stats
  rows.push(["ESTADÍSTICAS"]);
  rows.push(["Pedidos", s.pedidos || 0]);
  rows.push([
    "Frecuencia (meses entre pedidos)",
    s.frecuenciaMeses == null ? "" : Number(s.frecuenciaMeses.toFixed(1)),
  ]);
  rows.push([
    "Promedio cajas por pedido",
    s.promCajas == null ? "" : Number(s.promCajas.toFixed(1)),
  ]);
  rows.push([
    "Promedio unidades por pedido (ref)",
    s.promUnidades == null ? "" : Math.round(s.promUnidades),
  ]);
  if (br.type === "consolidated" && s.ranking) {
    rows.push([
      "Ranking 12m (web, unidades)",
      s.ranking.pos != null
        ? "#" + s.ranking.pos + " de " + s.ranking.total
        : "",
    ]);
    rows.push(["Unidades 12m", s.ranking.unidades]);
  }
  var acX = computeAcuerdo(currentCustomer);
  if (acX) {
    rows.push(["Acuerdo (índice)", Number(acX.indice.toFixed(4))]);
    rows.push([
      "Acuerdo — neto s/lista (%)",
      Number((acX.netoPct * 100).toFixed(2)),
    ]);
    rows.push(["Dto Vol (%)", Number((acX.dtoVol * 100).toFixed(2))]);
    rows.push(["Comisión (%)", Number((acX.comision * 100).toFixed(2))]);
  } else {
    rows.push(["Acuerdo", "sin datos"]);
  }
  if (s.primeraCompra)
    rows.push(["Primera compra", fmtMonthYearMM(s.primeraCompra)]);
  if (s.ultimaCompra)
    rows.push(["Última compra", fmtMonthYearMM(s.ultimaCompra)]);
  rows.push([]);

  // Altas
  rows.push(["ALTAS (primera compra ever)"]);
  rows.push(["Cod", "Descripción", "Categoría", "1ra Compra", "Unidades"]);
  a.altas.forEach(function (r) {
    rows.push([
      r.cod,
      r.descripcion,
      r.categoria,
      fmtMonthYear(r.fecha),
      r.qty,
    ]);
  });
  rows.push([]);

  // Bajas
  rows.push(["BAJAS"]);
  rows.push([
    "Cod",
    "Descripción",
    "Plazo Compro",
    "Últ. compra (uni)",
    "Promedio (uni)",
    "1ra Baja",
    "2da Baja",
    "3ra Baja",
    "4ta Baja",
    "5ta Baja",
  ]);
  a.bajas.forEach(function (r) {
    rows.push([
      r.cod,
      r.descripcion,
      r.plazoCompro,
      Math.round(r.ultimaQty),
      Number((r.promedioQty || 0).toFixed(1)),
      r.bajas[0] || "",
      r.bajas[1] || "",
      r.bajas[2] || "",
      r.bajas[3] || "",
      r.bajas[4] || "",
    ]);
  });
  rows.push([]);

  // Probó 1 vez
  rows.push(["PROBÓ SOLO 1 VEZ"]);
  rows.push(["Cod", "Descripción", "Mes/Año", "Unidades"]);
  a.probo1Vez.forEach(function (r) {
    rows.push([r.cod, r.descripcion, r.mes, r.qty]);
  });
  rows.push([]);

  // A Ofrecer
  rows.push(["A OFRECER (Top " + TOP_OFRECER + ")"]);
  rows.push([
    "Cod",
    "Descripción",
    "Categoría",
    "Ranking Madre",
    "E.Madre Uni/Mes",
  ]);
  a.aOfrecer.forEach(function (r) {
    rows.push([
      r.cod,
      r.descripcion,
      r.categoria,
      r.ranking == null ? "" : r.ranking,
      r.e_madre == null ? "" : r.e_madre,
    ]);
  });
  rows.push([]);

  // Disruptivas
  if (a.disruptivas.length) {
    rows.push(["DISRUPTIVAS (última compra)"]);
    rows.push([
      "Cod",
      "Descripción",
      "Qty última",
      "Prom histórico",
      "Ratio",
    ]);
    a.disruptivas.forEach(function (r) {
      rows.push([
        r.cod,
        r.descripcion,
        r.qtyActual,
        Number(r.promedio.toFixed(1)),
        Number(r.ratio.toFixed(2)),
      ]);
    });
    rows.push([]);
  }

  // Evolución
  rows.push(["EVOLUCIÓN MENSUAL (últimos 5 años)"]);
  rows.push(["Mes", "Unidades"]);
  a.evolucion.forEach(function (r) {
    rows.push([r.mes, r.unidades]);
  });

  return rows;
}

// ============================================================
// REPORTE TOTAL CLIENTES — FASE 8
// ============================================================
var rtCanceled = false;

async function onReporteTotal() {
  if (
    !confirm(
      "Generar reporte de TODOS los clientes con movimientos.\n\n" +
        "Esto puede tardar varios minutos. ¿Continuar?",
    )
  ) {
    return;
  }
  // En Fase 11 acá va validación de 2da clave WhatsApp.

  rtShowOverlay();
  rtCanceled = false;

  try {
    rtSetMessage("Cargando catálogo y estadística madre...");
    await Promise.all([loadProducts(), loadEstadisticaMadre(), loadNovedades()]);

    rtSetMessage("Listando clientes con pedidos...");
    var customerIds = await rtFetchCustomerIdsWithOrders();
    if (rtCanceled) return rtAbort();

    rtSetMessage("Cargando datos de clientes...");
    // Trae todos los customers de una vez (con paginación)
    var customersMap = {};
    var off = 0;
    while (true) {
      var r = await sb
        .from("customers")
        .select("id, cod_cliente, business_name, cuit")
        .range(off, off + 999);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      batch.forEach(function (c) {
        customersMap[c.id] = c;
      });
      if (batch.length < 1000) break;
      off += 1000;
    }
    if (rtCanceled) return rtAbort();

    var clientes = customerIds
      .map(function (id) {
        return customersMap[id];
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return String(a.cod_cliente || "").localeCompare(
          String(b.cod_cliente || ""),
          undefined,
          { numeric: true },
        );
      });

    var wb = XLSX.utils.book_new();

    // Hoja Índice
    var idx = [
      ["Reporte Total Clientes"],
      ["Generado", new Date().toLocaleString("es-AR")],
      ["Total clientes", clientes.length],
      [],
      ["Cod", "Cliente", "CUIT", "Pedidos", "Última compra"],
    ];
    var idxRowStart = idx.length; // donde arrancan los rows
    var indexRows = [];

    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(idx),
      "Indice",
    );

    // Por cada cliente
    for (var i = 0; i < clientes.length; i++) {
      if (rtCanceled) return rtAbort();
      var c = clientes[i];
      rtSetProgress(i + 1, clientes.length, c);

      try {
        var data = await rtBuildClienteData(c);
        var sheetName = sanitizeSheetName(
          (c.cod_cliente || "?") +
            "-" +
            (c.business_name || "").slice(0, 18),
          25,
        );
        var base = sheetName;
        var n = 1;
        while (wb.SheetNames.indexOf(sheetName) !== -1) {
          sheetName = base + " " + ++n;
        }
        var ws = XLSX.utils.aoa_to_sheet(data.aoa);
        ws["!cols"] = [
          { wch: 12 },
          { wch: 36 },
          { wch: 18 },
          { wch: 14 },
          { wch: 14 },
        ];
        XLSX.utils.book_append_sheet(wb, ws, sheetName);

        indexRows.push([
          c.cod_cliente,
          c.business_name || "",
          c.cuit || "",
          data.pedidos,
          data.ultimaCompra || "",
        ]);
      } catch (e) {
        console.warn("rt cliente " + c.cod_cliente + " error", e);
        indexRows.push([
          c.cod_cliente,
          c.business_name || "",
          c.cuit || "",
          "ERROR",
          (e.message || e).toString().slice(0, 80),
        ]);
      }
    }

    // Re-escribir hoja Índice con rows finales
    var idxFull = idx.concat(indexRows);
    var wsIdx = XLSX.utils.aoa_to_sheet(idxFull);
    wsIdx["!cols"] = [
      { wch: 10 },
      { wch: 40 },
      { wch: 14 },
      { wch: 10 },
      { wch: 14 },
    ];
    // reemplazar
    wb.Sheets["Indice"] = wsIdx;

    rtSetMessage("Generando archivo...");
    var fname =
      "reporte-total-clientes-" +
      new Date().toISOString().slice(0, 10) +
      ".xlsx";
    XLSX.writeFile(wb, fname);
    rtHideOverlay();
    alert(
      "Reporte generado: " + clientes.length + " clientes en " + fname,
    );
  } catch (err) {
    console.error("onReporteTotal error", err);
    rtHideOverlay();
    alert("Error: " + (err.message || err));
  }
}

async function rtFetchCustomerIdsWithOrders() {
  var ids = new Set();
  var off = 0;
  while (true) {
    var r = await sb
      .from("orders")
      .select("customer_id")
      .range(off, off + 999);
    if (r.error) throw new Error(r.error.message);
    var batch = r.data || [];
    batch.forEach(function (o) {
      if (o.customer_id) ids.add(o.customer_id);
    });
    if (batch.length < 1000) break;
    off += 1000;
  }
  return Array.from(ids);
}

async function rtBuildClienteData(c) {
  // movs web
  var webMovs = await loadWebMovements(c.id);
  // movs erp
  var erpMovs = await loadSalesHistory(c.cod_cliente);
  var movs = webMovs.concat(erpMovs);
  movs.sort(function (a, b) {
    return a.fecha - b.fecha;
  });

  // RPC sugerencias para este cliente
  var sugStash = sugerenciasCache;
  try {
    var sr = await sb.rpc("sugerencias_cliente", {
      p_customer: String(c.cod_cliente),
    });
    sugerenciasCache = sr.error ? [] : sr.data || [];
  } catch (e) {
    sugerenciasCache = [];
  }

  // Análisis sobre branch consolidada
  var fakeBranch = {
    key: "rt_" + c.id,
    label: c.business_name || c.cod_cliente,
    type: "consolidated",
    address: null,
    movements: movs,
  };
  var analysis = computeAnalysis(fakeBranch);
  // restore cache global (no contaminar)
  sugerenciasCache = sugStash;

  var s = analysis.stats;
  var aoa = [];
  aoa.push(["Cliente: " + (c.business_name || c.cod_cliente)]);
  aoa.push(["Cod", c.cod_cliente, "CUIT", c.cuit || ""]);
  aoa.push([
    "Pedidos",
    s.pedidos || 0,
    "Frecuencia (m)",
    s.frecuenciaMeses == null ? "" : Number(s.frecuenciaMeses.toFixed(1)),
  ]);
  aoa.push([
    "Promedio cajas/pedido",
    s.promCajas == null ? "" : Number(s.promCajas.toFixed(1)),
    "Última compra",
    s.ultimaCompra ? fmtMonthYearMM(s.ultimaCompra) : "",
  ]);
  aoa.push([]);

  aoa.push(["ALTAS"]);
  aoa.push(["Cod", "Descripción", "Categoría", "1ra Compra", "Unidades"]);
  analysis.altas.slice(0, 50).forEach(function (r) {
    aoa.push([r.cod, r.descripcion, r.categoria, fmtMonthYear(r.fecha), r.qty]);
  });
  aoa.push([]);

  aoa.push(["BAJAS"]);
  aoa.push([
    "Cod",
    "Descripción",
    "Plazo Compro",
    "Últ. compra (uni)",
    "Promedio (uni)",
    "1ra Baja",
    "2da Baja",
    "3ra Baja",
    "4ta Baja",
    "5ta Baja",
  ]);
  analysis.bajas.forEach(function (r) {
    aoa.push([
      r.cod,
      r.descripcion,
      r.plazoCompro,
      Math.round(r.ultimaQty),
      Number((r.promedioQty || 0).toFixed(1)),
      r.bajas[0] || "",
      r.bajas[1] || "",
      r.bajas[2] || "",
      r.bajas[3] || "",
      r.bajas[4] || "",
    ]);
  });
  aoa.push([]);

  aoa.push(["PROBÓ SOLO 1 VEZ"]);
  aoa.push(["Cod", "Descripción", "Mes/Año", "Unidades"]);
  analysis.probo1Vez.forEach(function (r) {
    aoa.push([r.cod, r.descripcion, r.mes, r.qty]);
  });
  aoa.push([]);

  aoa.push(["A OFRECER (Top " + TOP_OFRECER + ")"]);
  aoa.push([
    "Cod",
    "Descripción",
    "Categoría",
    "Ranking Madre",
    "E.Madre Uni/Mes",
  ]);
  analysis.aOfrecer.forEach(function (r) {
    aoa.push([
      r.cod,
      r.descripcion,
      r.categoria,
      r.ranking == null ? "" : r.ranking,
      r.e_madre == null ? "" : r.e_madre,
    ]);
  });
  aoa.push([]);

  if (analysis.disruptivas.length) {
    aoa.push(["DISRUPTIVAS (última compra)"]);
    aoa.push([
      "Cod",
      "Descripción",
      "Qty última",
      "Prom histórico",
      "Ratio",
    ]);
    analysis.disruptivas.forEach(function (r) {
      aoa.push([
        r.cod,
        r.descripcion,
        r.qtyActual,
        Number(r.promedio.toFixed(1)),
        Number(r.ratio.toFixed(2)),
      ]);
    });
  }

  return {
    aoa: aoa,
    pedidos: s.pedidos || 0,
    ultimaCompra: s.ultimaCompra ? fmtMonthYearMM(s.ultimaCompra) : "",
  };
}

// ---- overlay simple ----
function rtShowOverlay() {
  var ov = document.getElementById("rtOverlay");
  if (ov) {
    ov.style.display = "flex";
    return;
  }
  var div = document.createElement("div");
  div.id = "rtOverlay";
  div.style.cssText =
    "position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9999;" +
    " display:flex; align-items:center; justify-content:center;";
  div.innerHTML =
    '<div style="background:#fff; border-radius:14px; padding:28px 36px; min-width:420px; max-width:90vw; box-shadow:0 20px 50px rgba(0,0,0,0.3)">' +
    '<h3 style="font-family:Syne,sans-serif; margin:0 0 12px; font-size:18px">Generando reporte total</h3>' +
    '<div id="rtMessage" style="font-size:13px; color:#374151; margin-bottom:10px">Iniciando...</div>' +
    '<div style="background:#f3f4f6; border-radius:8px; height:10px; overflow:hidden; margin-bottom:6px">' +
    '<div id="rtBar" style="background:#d50000; height:100%; width:0%; transition:width 0.2s"></div>' +
    "</div>" +
    '<div id="rtProgress" style="font-size:12px; color:#6b7280; margin-bottom:14px">—</div>' +
    '<button id="rtCancel" type="button" style="background:#fff; border:1px solid #d1d5db; border-radius:8px; padding:8px 14px; cursor:pointer; font-size:13px">Cancelar</button>' +
    "</div>";
  document.body.appendChild(div);
  document.getElementById("rtCancel").addEventListener("click", function () {
    rtCanceled = true;
    rtSetMessage("Cancelando...");
  });
}

function rtHideOverlay() {
  var ov = document.getElementById("rtOverlay");
  if (ov) ov.style.display = "none";
}

function rtSetMessage(msg) {
  var el = document.getElementById("rtMessage");
  if (el) el.textContent = msg;
}

function rtSetProgress(done, total, c) {
  var pct = total ? Math.round((done * 100) / total) : 0;
  var bar = document.getElementById("rtBar");
  if (bar) bar.style.width = pct + "%";
  var pr = document.getElementById("rtProgress");
  if (pr) {
    pr.textContent =
      done +
      " / " +
      total +
      " — " +
      (c.cod_cliente || "?") +
      " " +
      (c.business_name || "");
  }
}

function rtAbort() {
  rtHideOverlay();
  alert("Cancelado por el usuario.");
}

// ============================================================
// ESTADÍSTICA MADRE — IMPORTADOR
// (movido desde admin.js — ahora vive en esta página)
// ============================================================
var emParsedRows = null;

function emNormHeader(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\n\r]/g, " ")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function emFindCol(headers, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    for (var j = 0; j < headers.length; j++) {
      if (headers[j] === c) return j;
    }
  }
  for (var k = 0; k < candidates.length; k++) {
    var cc = candidates[k];
    for (var l = 0; l < headers.length; l++) {
      if (headers[l] && headers[l].indexOf(cc) !== -1) return l;
    }
  }
  return -1;
}

function emCleanDesc(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function emParseFile(buf) {
  var wb = XLSX.read(buf, { type: "array" });
  var sheetName = wb.SheetNames.find(function (n) {
    return /loeke\s*madre.*\d/i.test(n);
  });
  if (!sheetName) {
    sheetName = wb.SheetNames.find(function (n) {
      return /loeke\s*madre/i.test(n);
    });
  }
  if (!sheetName) throw new Error("No se encontró hoja 'Loeke Madre …'");
  var sheet = wb.Sheets[sheetName];
  var raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  var headerRowIdx = -1;
  for (var i = 0; i < Math.min(raw.length, 12); i++) {
    var row = raw[i].map(emNormHeader);
    if (row.indexOf("cod nuevo isis") !== -1) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    throw new Error(
      "No se encontró fila de encabezado (esperaba 'Cod Nuevo Isis').",
    );
  }

  var headers = raw[headerRowIdx].map(emNormHeader);

  var col = {
    categoria: emFindCol(headers, ["cat art", "categoria", "cat"]),
    ranking: emFindCol(headers, ["ranking"]),
    descripcion: emFindCol(headers, ["descripcion"]),
    cod: emFindCol(headers, ["cod nuevo isis", "cod"]),
    e_madre_uni_mes: emFindCol(headers, [
      "emadre uni x mes",
      "e madre uni x mes",
      "estadistica madre uni x mes",
    ]),
    tendencia_uni: emFindCol(headers, ["tendencia en uni", "tendencia uni"]),
    uni_x_caja: emFindCol(headers, ["uni x caja"]),
    e_madre_cajas: emFindCol(headers, ["emadre en cajas", "e madre en cajas"]),
    proveedor: emFindCol(headers, ["proveedor"]),
  };

  if (col.cod === -1)
    throw new Error("No se encontró columna 'Cod Nuevo Isis'.");
  if (col.descripcion === -1)
    throw new Error("No se encontró columna 'Descripcion'.");

  var rows = [];
  for (var r = headerRowIdx + 1; r < raw.length; r++) {
    var rawRow = raw[r];
    if (!rawRow || rawRow.length === 0) continue;
    var cod = String(rawRow[col.cod] || "").trim();
    if (!cod) continue;
    if (!/^\w[\w\-/.]*$/i.test(cod)) continue;

    var desc = emCleanDesc(rawRow[col.descripcion]);
    if (!desc) continue;

    function num(v) {
      if (v === "" || v == null) return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    }
    function intg(v) {
      var n = num(v);
      return n == null ? null : Math.round(n);
    }
    function str(v) {
      var s = String(v || "").trim();
      return s || null;
    }

    rows.push({
      cod: cod,
      descripcion: desc,
      categoria: col.categoria !== -1 ? str(rawRow[col.categoria]) : null,
      ranking: col.ranking !== -1 ? intg(rawRow[col.ranking]) : null,
      e_madre_uni_mes:
        col.e_madre_uni_mes !== -1 ? num(rawRow[col.e_madre_uni_mes]) : null,
      tendencia_uni:
        col.tendencia_uni !== -1 ? num(rawRow[col.tendencia_uni]) : null,
      uni_x_caja: col.uni_x_caja !== -1 ? intg(rawRow[col.uni_x_caja]) : null,
      e_madre_cajas:
        col.e_madre_cajas !== -1 ? num(rawRow[col.e_madre_cajas]) : null,
      proveedor: col.proveedor !== -1 ? str(rawRow[col.proveedor]) : null,
    });
  }

  return { sheetName: sheetName, rows: rows };
}

function emRenderPreview(rows) {
  var preview = document.getElementById("emPreview");
  if (!preview) return;
  if (!rows || !rows.length) {
    preview.style.display = "none";
    preview.innerHTML = "";
    return;
  }
  var sample = rows.slice(0, 50);
  var html =
    '<table style="width:100%; border-collapse:collapse; font-size:12px">';
  html +=
    "<thead><tr>" +
    [
      "Cod",
      "Descripción",
      "Categoría",
      "Ranking",
      "E.Madre Uni/Mes",
      "Tendencia",
      "Uni x Caja",
      "Cajas/Mes",
      "Proveedor",
    ]
      .map(function (h) {
        return (
          '<th style="background:#f9fafb; padding:6px 8px; text-align:left; border-bottom:1px solid #e5e7eb; position:sticky; top:0">' +
          h +
          "</th>"
        );
      })
      .join("") +
    "</tr></thead><tbody>";
  sample.forEach(function (r) {
    html +=
      "<tr>" +
      [
        r.cod,
        r.descripcion,
        r.categoria || "",
        r.ranking != null ? r.ranking : "",
        r.e_madre_uni_mes != null ? r.e_madre_uni_mes : "",
        r.tendencia_uni != null ? r.tendencia_uni.toFixed(3) : "",
        r.uni_x_caja != null ? r.uni_x_caja : "",
        r.e_madre_cajas != null ? r.e_madre_cajas.toFixed(2) : "",
        r.proveedor || "",
      ]
        .map(function (v) {
          return (
            '<td style="padding:5px 8px; border-bottom:1px solid #f3f4f6">' +
            String(v) +
            "</td>"
          );
        })
        .join("") +
      "</tr>";
  });
  html += "</tbody></table>";
  if (rows.length > sample.length) {
    html +=
      '<div style="padding:8px 12px; color:#6b7280; font-size:12px">' +
      "+" +
      (rows.length - sample.length) +
      " filas más (no mostradas)…</div>";
  }
  preview.innerHTML = html;
  preview.style.display = "block";
}

function emSetStatus(msg, kind) {
  var el = document.getElementById("emStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color =
    kind === "err"
      ? "#b91c1c"
      : kind === "ok"
        ? "#166534"
        : kind === "warn"
          ? "#b45309"
          : "#374151";
}

function emHandleFile(file) {
  var nameEl = document.getElementById("emFileName");
  var btnImp = document.getElementById("emBtnImportar");
  if (nameEl) nameEl.textContent = file.name;
  emSetStatus("Leyendo archivo...");
  var reader = new FileReader();
  reader.onload = function (e) {
    try {
      var parsed = emParseFile(e.target.result);
      emParsedRows = parsed.rows;
      emRenderPreview(emParsedRows);
      emSetStatus(
        "Hoja: '" +
          parsed.sheetName +
          "' — " +
          emParsedRows.length +
          " items listos para importar.",
        "ok",
      );
      if (btnImp) btnImp.disabled = emParsedRows.length === 0;
    } catch (err) {
      console.error("emParseFile error", err);
      emSetStatus("Error: " + (err.message || err), "err");
      emParsedRows = null;
      if (btnImp) btnImp.disabled = true;
    }
  };
  reader.onerror = function () {
    emSetStatus("Error al leer archivo.", "err");
  };
  reader.readAsArrayBuffer(file);
}

function emDedupRows(rows) {
  var map = {};
  var dups = 0;
  rows.forEach(function (r) {
    var key = String(r.cod || "").trim().toUpperCase();
    if (!key) return;
    if (map[key]) dups++;
    map[key] = Object.assign({}, r, { cod: key });
  });
  return { rows: Object.values(map), dups: dups };
}

function emFormatDateDDMMYY(d) {
  var dd = String(d.getDate()).padStart(2, "0");
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var yy = String(d.getFullYear()).slice(-2);
  return dd + "/" + mm + "/" + yy;
}

function emRefreshLastImportLabel() {
  var el = document.getElementById("emLastImport");
  if (!el) return;
  var stored = localStorage.getItem("lastImport_em");
  el.textContent = stored
    ? "(últ. importación: " + emFormatDateDDMMYY(new Date(stored)) + ")"
    : "";
}

async function emImportar() {
  if (!emParsedRows || !emParsedRows.length) {
    emSetStatus("No hay datos para importar.", "warn");
    return;
  }
  var btn = document.getElementById("emBtnImportar");
  if (btn) btn.disabled = true;

  try {
    var deduped = emDedupRows(emParsedRows);
    var rowsToImport = deduped.rows;
    if (deduped.dups > 0) {
      emSetStatus(
        "Detectados " +
          deduped.dups +
          " cods duplicados — se conserva última ocurrencia. Importando " +
          rowsToImport.length +
          " filas únicas...",
        "warn",
      );
    }

    var BATCH = 500;
    var total = rowsToImport.length;
    var done = 0;
    for (var i = 0; i < total; i += BATCH) {
      var batch = rowsToImport.slice(i, i + BATCH);
      var r = await sb
        .from("estadistica_madre")
        .upsert(batch, { onConflict: "cod" });
      if (r.error) {
        throw new Error(r.error.message || "Error en upsert.");
      }
      done += batch.length;
      emSetStatus(
        "Importando... " +
          done +
          "/" +
          total +
          (deduped.dups > 0 ? " (dedup: " + deduped.dups + ")" : ""),
      );
    }
    try {
      localStorage.setItem("lastImport_em", new Date().toISOString());
    } catch (_) {}
    emRefreshLastImportLabel();
    emSetStatus(
      "Importación OK: " +
        done +
        " items upserteados a estadistica_madre" +
        (deduped.dups > 0
          ? " (" + deduped.dups + " duplicados consolidados)"
          : "") +
        ".",
      "ok",
    );
  } catch (err) {
    console.error("emImportar error", err);
    emSetStatus("Error en importación: " + (err.message || err), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  var input = document.getElementById("emFileInput");
  if (input) {
    input.addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) emHandleFile(f);
    });
  }
  var btnImp = document.getElementById("emBtnImportar");
  if (btnImp) btnImp.addEventListener("click", emImportar);
  emRefreshLastImportLabel();
});
