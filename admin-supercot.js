// ============================================================================
// admin-supercot.js — Modulo "Cotizadores Supermercados"
//
// Recibe un PDF de orden de compra de un super, auto-detecta la cadena, parsea
// items con regex especificas por columna, matchea contra products LK, y permite
// exportar a Excel cotizador interno o subir como pedido directo.
//
// IMPORTANTE: este modulo NO aplica dto_vol, NO aplica web_discount, NO aplica
// descuento por metodo de pago. El precio del PDF es precio final negociado.
//
// Lista de comparacion proviene de la tabla precios_super (RPC get_super_prices,
// gated por admin). Ya NO del archivo publico precios_supermercados.xlsx.
// en la raiz del proyecto, hoja por cadena. Si no hay match en el Excel, fallback
// a products.list_price.
// ============================================================================

(function () {
  "use strict";

  // ----- Config pdf.js worker -----
  if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  // ----- CSS propio (prefijo scot-) -----
  var SCOT_CSS = [
    // Override max-width del .page para esta seccion: que ocupe todo el ancho disponible.
    "#cotizadores-super.page{max-width:none;padding:24px 24px}",
    // Container: ocupa todo el espacio disponible para fitear 9 cards en grid 3x3.
    "#superCotMount{width:100%}",
    // Grid 3 columnas fijas (fallback a 2 en pantallas medianas, 1 en chicas)
    ".scot-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}",
    "@media(max-width:1100px){.scot-grid{grid-template-columns:repeat(2,1fr)}}",
    "@media(max-width:680px){.scot-grid{grid-template-columns:1fr}}",
    // Cards de la misma fila comparten alto (la vacía iguala a la cargada)
    ".scot-card-instance{display:flex;flex-direction:column;min-width:0}",
    ".scot-card-instance > .scot-card{flex:1;display:flex;flex-direction:column}",
    // Drop zone se estira y centra contenido cuando la card vacía iguala a una llena
    ".scot-card-instance > .scot-card > .scot-drop{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center}",
    ".scot-wrap{display:flex;flex-direction:column;gap:16px}",
    ".scot-card{background:var(--bg1,#fff);border:1px solid var(--border,#e5e5e5);border-radius:10px;padding:20px;margin-bottom:16px}",
    ".scot-drop{border:2px dashed var(--border,#cfcfcf);border-radius:10px;padding:18px;text-align:center;cursor:pointer;transition:all .15s}",
    ".scot-drop:hover,.scot-drop.scot-drag{border-color:var(--accent,#e67e22);background:var(--bg2,#fafafa)}",
    ".scot-drop-title{font-weight:600;margin:8px 0 4px;color:var(--text2,#222)}",
    ".scot-drop-sub{font-size:12px;color:var(--text3,#888)}",
    ".scot-status{font-size:13px;color:var(--text3,#888);padding:8px 0}",
    ".scot-status.ok{color:#2a8a3e}.scot-status.err{color:var(--danger,#c0392b)}.scot-status.warn{color:#b8780f}",
    ".scot-detected{display:inline-block;padding:4px 10px;border-radius:999px;background:var(--accent,#e67e22);color:#fff;font-size:12px;font-weight:600;letter-spacing:.3px}",
    ".scot-meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-top:12px}",
    ".scot-meta-item{background:var(--bg2,#fafafa);border:1px solid var(--border,#eee);border-radius:8px;padding:10px}",
    ".scot-meta-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3,#888);font-weight:700;margin-bottom:4px}",
    ".scot-meta-val{font-size:13px;color:var(--text2,#222);font-weight:600;word-break:break-word}",
    ".scot-meta-val input{width:100%;font-size:13px;padding:6px 8px;border:1px solid var(--border,#ddd);border-radius:6px;font-family:inherit}",
    ".scot-table-wrap{overflow-x:auto;border:1px solid var(--border,#eee);border-radius:8px;margin-top:12px}",
    ".scot-table{width:100%;border-collapse:collapse;font-size:12px}",
    ".scot-table th{background:var(--bg2,#fafafa);padding:8px 6px;text-align:left;border-bottom:1px solid var(--border,#eee);font-weight:600;color:var(--text3,#666)}",
    ".scot-table td{padding:6px;border-bottom:1px solid var(--border,#f0f0f0);vertical-align:middle}",
    ".scot-table tr.scot-row-bad td{background:#fff0ee}",
    ".scot-table tr.scot-row-excluded td{opacity:.45}",
    ".scot-table input.scot-cajas-input{width:64px;padding:4px 6px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:12px;text-align:right;font-family:inherit}",
    ".scot-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}",
    ".scot-pill.ok{background:#dff5e3;color:#1e7a31}",
    ".scot-pill.warn{background:#fff5d4;color:#b8780f}",
    ".scot-pill.bad{background:#ffd9d4;color:#c0392b}",
    ".scot-pill.miss{background:#eee;color:#666}",
    ".scot-totals{display:flex;justify-content:flex-end;gap:24px;padding:14px 0;font-size:14px}",
    ".scot-totals .lab{color:var(--text3,#888)}.scot-totals .val{font-weight:700;color:var(--text2,#222)}",
    ".scot-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}",
    ".scot-customer-search{display:flex;gap:8px;margin-top:8px}",
    ".scot-customer-search input{flex:1;padding:8px 10px;border:1px solid var(--border,#ddd);border-radius:6px;font-family:inherit}",
    ".scot-customer-results{margin-top:8px;display:flex;flex-direction:column;gap:6px}",
    ".scot-customer-row{padding:8px 10px;border:1px solid var(--border,#eee);border-radius:6px;cursor:pointer;font-size:13px}",
    ".scot-customer-row:hover{border-color:var(--accent,#e67e22);background:var(--bg2,#fafafa)}",
    ".scot-customer-current{padding:10px;background:#e8f4fd;border:1px solid #9bc8e6;border-radius:8px;font-size:13px;color:#1f4c6e;display:flex;align-items:center;justify-content:space-between;gap:10px}",
    ".scot-customer-current button{font-size:11px;padding:4px 10px;border:1px solid #1f4c6e;background:transparent;color:#1f4c6e;border-radius:4px;cursor:pointer}",
    ".scot-spinner{display:inline-block;width:16px;height:16px;border:2px solid var(--accent,#e67e22);border-top-color:transparent;border-radius:50%;animation:scot-spin .8s linear infinite;vertical-align:middle}",
    "@keyframes scot-spin{to{transform:rotate(360deg)}}",
    ".scot-section-title{font-size:14px;font-weight:700;color:var(--text2,#222);margin:0 0 8px}",
    ".scot-hint{font-size:11px;color:var(--text3,#888);margin-top:4px}",
    // Top card: super + meta compacta (izq) + total grande (der)
    ".scot-summary{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:20px}",
    ".scot-summary-left{display:flex;flex-direction:column;gap:10px;min-width:0;flex:1}",
    ".scot-meta-line{font-size:13px;color:var(--text2,#222);display:flex;gap:8px;align-items:baseline;line-height:1.4;min-width:0}",
    ".scot-meta-line .lbl{color:var(--text3,#888);font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.4px;flex-shrink:0}",
    // overflow-wrap: solo rompe palabras cuando una sola palabra no entra. Evita el corte feo letra por letra que daba word-break:break-word.
    ".scot-meta-line .val{flex:1;min-width:0;overflow-wrap:break-word;word-break:normal}",
    ".scot-meta-line.warn{color:#b8780f}",
    ".scot-meta-line.ok{color:#1e7a31}",
    ".scot-meta-line input{flex:1;font-size:11px;padding:4px 6px;border:1px solid var(--border,#ddd);border-radius:4px;font-family:inherit}",
    // total-big: permitir que se encoja un poco si la card es muy angosta para que la columna izq tenga espacio
    ".scot-total-big{display:flex;flex-direction:column;align-items:flex-end;flex-shrink:1;gap:4px;min-width:0}",
    ".scot-total-big .lab{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text3,#888);font-weight:700}",
    ".scot-total-big .val{font-size:30px;font-weight:800;color:var(--text2,#222);line-height:1.1}",
    ".scot-total-big .sub{font-size:12px;color:var(--text3,#888)}",
    // PDF total: linea destacada (mas grande que sub, con border y padding). Permite wrap en cards angostas.
    ".scot-pdf-total{font-size:14px;font-weight:700;padding:4px 10px;border-radius:6px;border:1px solid;margin-top:4px;text-align:right;line-height:1.3;max-width:100%}",
    ".scot-pdf-total.ok{background:#dff5e3;border-color:#9bd6a8;color:#1e7a31}",
    ".scot-pdf-total.warn{background:#fff5d4;border-color:#e6c668;color:#b8780f}",
    ".scot-pdf-total.bad{background:#ffd9d4;border-color:#e6a39b;color:#c0392b}",
    ".scot-pdf-total.info{background:#e6f0fb;border-color:#9bbde0;color:#1f5b94;font-weight:600;font-size:12px}",
    ".scot-pdf-total.miss{background:var(--bg2,#fafafa);border-color:var(--border,#eee);color:var(--text3,#888);font-style:italic;font-weight:500;font-size:12px}",
    // Collapsible
    ".scot-collapsible{background:var(--bg1,#fff);border:1px solid var(--border,#e5e5e5);border-radius:10px;margin-bottom:10px;overflow:hidden}",
    ".scot-collapsible > summary{list-style:none;cursor:pointer;padding:14px 18px;display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600;color:var(--text2,#222);user-select:none}",
    ".scot-collapsible > summary::-webkit-details-marker{display:none}",
    ".scot-collapsible > summary::after{content:'▾';color:var(--text3,#888);transition:transform .2s;font-size:14px}",
    ".scot-collapsible[open] > summary::after{transform:rotate(180deg)}",
    ".scot-collapsible > summary:hover{background:var(--bg2,#fafafa)}",
    ".scot-collapsible-body{padding:0 18px 18px}",
    ".scot-collapsible-meta{font-size:12px;color:var(--text3,#888);font-weight:400;margin-left:auto;margin-right:12px}",
    // Botones de accion al lado del total
    ".scot-total-actions{display:flex;gap:6px;margin-top:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end}",
    ".scot-total-actions button.scot-icon-btn{width:34px;height:34px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--border,#ddd);background:#fff;cursor:pointer;color:var(--text2,#222);transition:all .15s}",
    // Trash hover: tinte rojo (acción descartable, distinta de Ver detalle)
    ".scot-total-actions button.scot-icon-btn:not(.primary):hover{background:#fde2de;border-color:#c0392b;color:#c0392b}",
    // Tick (primary) verde
    ".scot-total-actions button.scot-icon-btn.primary{background:#22a861;color:#fff;border-color:#22a861}",
    ".scot-total-actions button.scot-icon-btn.primary:hover{background:#1d8d51;border-color:#1d8d51}",
    ".scot-total-actions button.scot-icon-btn:disabled{opacity:.5;cursor:not-allowed}",
    ".scot-total-actions button.scot-icon-btn svg{width:16px;height:16px}",
    ".scot-total-actions button.scot-icon-btn.submitted{background:#1d8d51;border-color:#1d8d51;color:#fff;cursor:default;animation:scot-submit-pulse 0.9s ease-out 1}",
    ".scot-total-actions button.scot-icon-btn.submitted:hover{background:#1d8d51;border-color:#1d8d51}",
    ".scot-total-actions button.scot-icon-btn.submitted svg{animation:scot-submit-tick 0.5s cubic-bezier(0.4,0,0.2,1) 1}",
    "@keyframes scot-submit-pulse{0%{box-shadow:0 0 0 0 rgba(34,168,97,.6);transform:scale(1)}50%{box-shadow:0 0 0 14px rgba(34,168,97,0);transform:scale(1.18)}100%{box-shadow:0 0 0 0 rgba(34,168,97,0);transform:scale(1)}}",
    "@keyframes scot-submit-tick{0%{transform:scale(0) rotate(-45deg);opacity:0}60%{transform:scale(1.3) rotate(0);opacity:1}100%{transform:scale(1) rotate(0);opacity:1}}",
    // Ver detalle: separado a la izq, hover gris claro
    ".scot-total-actions .scot-link-btn{font-size:12px;padding:6px 12px;background:transparent;border:1px solid var(--border,#ddd);border-radius:6px;cursor:pointer;color:var(--text2,#222);margin-right:14px;transition:background .15s}",
    ".scot-total-actions .scot-link-btn:hover{background:#f0f0f0}",
    // Modal de items
    ".scot-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px}",
    ".scot-modal{background:#fff;border-radius:10px;max-width:760px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden}",
    ".scot-modal-head{padding:12px 16px;border-bottom:1px solid var(--border,#eee);display:flex;justify-content:space-between;align-items:center}",
    ".scot-modal-head h3{margin:0;font-size:14px;color:var(--text2,#222)}",
    ".scot-modal-close{background:transparent;border:none;font-size:20px;cursor:pointer;color:var(--text3,#888);padding:0 6px;line-height:1}",
    ".scot-modal-body{padding:12px 16px;overflow-y:auto;flex:1}",
    ".scot-modal-body .scot-table{font-size:11px}",
    ".scot-modal-body .scot-table th,.scot-modal-body .scot-table td{padding:4px 5px}",
    ".scot-modal-body .scot-cajas-input{width:50px;padding:3px 4px;font-size:11px}",
    // Columnas de precios (5,6,7 = Precio PDF, Precio pre dto, Lista LK) agrupadas: padding lateral reducido + ancho fijo para que se vean como un bloque
    ".scot-modal-body .scot-table th:nth-child(5),.scot-modal-body .scot-table td:nth-child(5){padding-right:2px !important;width:80px}",
    ".scot-modal-body .scot-table th:nth-child(6),.scot-modal-body .scot-table td:nth-child(6){padding-left:2px !important;padding-right:2px !important;width:80px}",
    ".scot-modal-body .scot-table th:nth-child(7),.scot-modal-body .scot-table td:nth-child(7){padding-left:2px !important;width:80px}",
  ].join("\n");

  function injectCSS() {
    if (document.getElementById("scot-styles")) return;
    var s = document.createElement("style");
    s.id = "scot-styles";
    s.textContent = SCOT_CSS;
    document.head.appendChild(s);
  }

  // ----- Constantes -----
  var SHEETS_PROXY_URL =
    "https://kwkclwhmoygunqmlegrg.functions.supabase.co/sheets-proxy";
  var SHEETS_ENTREGAS_URL =
    "https://kwkclwhmoygunqmlegrg.functions.supabase.co/sheets-entregas-proxy";

  // Chef Supabase (proyecto separado para Dorinka/Cencosud)
  var CHEF_URL = "https://nkhzocgdpwtgrmwleihr.supabase.co";
  var CHEF_KEY = "sb_publishable_aThHtJLBKytg9k_6UdH2Eg_Use7f1zH";
  var CHEF_SHEETS_PROXY_URL =
    "https://nkhzocgdpwtgrmwleihr.functions.supabase.co/sheets-proxy";
  var CHEF_SHEETS_ENTREGAS_URL =
    "https://nkhzocgdpwtgrmwleihr.functions.supabase.co/sheets-entregas-proxy";

  // Cliente fijo por super en Chef Supabase (no se usa supermarket_branch_mapping)
  var CHEF_CUSTOMER_COD = {
    dorinka: "2686",
    cencosud: "2444",
  };

  // Cliente fijo por super en LK Supabase. Auto-detectado al leer el PDF, sin
  // busqueda manual. Si falta una entrada, el flow muestra error.
  var LK_CUSTOMER_COD = {
    coto: "801",
    dia: "3947",
    diarco: "4112",
    laanonima: "771",
    alberdi: "2320",
    libertad: "325",
    abastecedor: "4051",
    inc: "1651",
    messina: "1573",
    // toledo: "1947", // a sumar
  };

  // Codigo numerico de condicion de pago por super (va a columna I del sheet
  // "Pedidos LK"/"Pedidos CH"). Cada cadena tiene plazo distinto negociado.
  var SUPER_PAYMENT_CODE = {
    coto: 3,
    dia: 2,
    diarco: 2,
    dorinka: 3,
    laanonima: 3,
    cencosud: 2,
    alberdi: 1,
    libertad: 2,
    abastecedor: 1,
    inc: 14,
    // Messina: "CUENTA CORRIENTE. 15 DIAS FF" → 9 (escala web: 15-30 días)
    messina: 9,
  };

  // Ratio conocido entre el TOTAL calculado (con precios de lista LK, sin
  // descuentos aplicados) y el TOTAL del PDF (que ya tiene aplicados los
  // descuentos del super). Sirve para que la comparacion no marque "diff" cuando
  // la diferencia es explicada por el descuento esperado.
  // calc = pdfTotal × ratio  ⟺  pdfTotal = calc / ratio
  var SUPER_PDF_RATIO = {
    // Alberdi aplica -15% -5% (= 19.25% off): calc / 0.8075 vs pdfTotal Neto
    alberdi: 1 / 0.8075,
    // Dorinka aplica 16.5% volumen: mi calc divide por (1-0.165) → calc / 0.835 vs pdfTotal OC
    dorinka: 1 / 0.835,
    // Cencosud aplica 16% bonif: calc / 0.84 vs pdfTotal (si lo trae)
    cencosud: 1 / 0.84,
    // Diarco: PDF "Total OC" incluye IVA 21% sobre el sub-total de items
    diarco: 1 / 1.21,
    // Resto: ratio = 1 (no hay descuento conocido a considerar)
  };

  // Descuento ESPERADO entre el precio del PDF y la lista LK del super, PER ITEM.
  // Sirve para que la pill de cada item no marque "diff" cuando el precio del
  // PDF refleja el descuento ya negociado (no es una anomalía).
  // PDF price ≈ listPrice × (1 - SUPER_ITEM_DISCOUNT[super])
  var SUPER_ITEM_DISCOUNT = {
    // Diarco compra al 90% de la lista LK (PDF ya trae el precio descontado).
    diarco: 0.10,
    // Resto: 0 (PDF debería matchear la lista LK directamente)
  };

  var SUPERS = {
    coto: "Coto",
    dia: "Día",
    diarco: "Diarco",
    dorinka: "Dorinka (Walmart)",
    laanonima: "La Anónima",
    cencosud: "Cencosud (Jumbo/Disco/Vea)",
    alberdi: "Alberdi",
    libertad: "Libertad",
    abastecedor: "El Abastecedor (Tecnolar)",
    inc: "Carrefour (INC)",
    messina: "Messina Hnos",
  };

  // Mapeo hoja Excel -> super_key + posiciones de columnas
  // headerRow = primera fila con datos (1-indexed minus 1 in code).
  // Se corta extraccion al detectar una segunda fila con "Cod" en col0 o 3+ filas vacias.
  var SHEET_CONFIG = {
    Abastecedor: { key: "abastecedor", codCol: 0, priceCol: 2, dataStartRow: 2 },
    Alberdi: { key: "alberdi", codCol: 0, priceCol: 2, dataStartRow: 6 },
    DIARCO: { key: "diarco", codCol: 0, priceCol: 3, dataStartRow: 6 },
    DIA: { key: "dia", codCol: 0, priceCol: 3, dataStartRow: 6 },
    "La Anonima": { key: "laanonima", codCol: 1, priceCol: 3, dataStartRow: 7 },
    COTO: { key: "coto", codCol: 0, priceCol: 2, dataStartRow: 6 },
    "Jumbo Krea T": { key: "cencosud", codCol: 0, priceCol: 2, dataStartRow: 6 },
    // WMart Chef col 0 = "Cod" (Ref.Prov del PDF y cod en Chef Supabase, ej 769)
    // col 1 = "Cod Loeke" (descriptivo, ej 654). El que usa el PDF es col 0.
    "WMart Chef": { key: "dorinka", codCol: 0, priceCol: 3, dataStartRow: 7 },
    INC: { key: "inc", codCol: 0, priceCol: 2, dataStartRow: 6 },
    Libertad: { key: "libertad", codCol: 0, priceCol: 2, dataStartRow: 2 },
  };

  var allProductsCache = null;
  var allLokeProductsCache = null;
  var chefProductsCache = null;
  var chefSb = null;
  var superListPrices = {}; // { superKey: { codLk: price } }
  var superListLoaded = false;

  // isChefSuper: super que usa CLIENTE/RPC/SHEETS/L-suffix de Chef.
  // Dorinka y Cencosud van a Chef en estos aspectos.
  function isChefSuper(superKey) {
    return superKey === "dorinka" || superKey === "cencosud";
  }

  // usesChefProducts: contra qué catálogo matchea los productos del PDF.
  // CONTEXTO CH: cada empresa mira SU propio catálogo → en CH TODOS los supers
  // matchean contra Chef.products (no se lee LK). Devuelve true siempre.
  function usesChefProducts(superKey) {
    return true;
  }

  // CONTEXTO CH: window.sb ES el cliente Chef AUTENTICADO (config.js apunta el
  // proyecto primario a Chef). Por eso getChefClient devuelve window.sb: todo lo
  // Chef (products Dorinka, customers, delivery, submit + write-backs) corre con
  // la sesion del admin → pedidos con dueño (uid admin) → RLS nativa OK, sin
  // service_role ni edge function.
  function getChefClient() {
    return window.sb || null;
  }

  // state ahora vive por-card dentro de createCardInstance(). Ver más abajo.

  // Array de instancias activas (una por card)
  var cardInstances = [];
  var CARD_COUNT = 9;

  // SHA-256 del archivo en hex (para detectar PDFs duplicados entre cards)
  async function computeFileHash(file) {
    if (!window.crypto || !window.crypto.subtle) return null;
    var buf = await file.arrayBuffer();
    var hashBuf = await window.crypto.subtle.digest("SHA-256", buf);
    var bytes = new Uint8Array(hashBuf);
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  // Buscar otra card que ya tenga este hash. Devuelve idx (1-based) o null.
  function findDuplicateCardIdx(hash, ownIdx) {
    if (!hash) return null;
    for (var i = 0; i < cardInstances.length; i++) {
      if (i === ownIdx) continue;
      var s = cardInstances[i] && cardInstances[i].getState && cardInstances[i].getState();
      if (s && s.fileHash === hash) return i + 1; // 1-based para humanos
    }
    return null;
  }

  // ============================================================================
  // PARSE NUMERICO TOLERANTE
  // ============================================================================
  function parseNum(s) {
    if (s == null) return 0;
    var t = String(s).trim();
    if (!t) return 0;
    t = t.replace(/[^0-9.,\-]/g, "");
    if (!t) return 0;
    var hasDot = t.indexOf(".") !== -1;
    var hasComma = t.indexOf(",") !== -1;
    var lastDot = t.lastIndexOf(".");
    var lastComma = t.lastIndexOf(",");
    var n;
    if (hasDot && hasComma) {
      if (lastComma > lastDot) {
        n = parseFloat(t.replace(/\./g, "").replace(",", "."));
      } else {
        n = parseFloat(t.replace(/,/g, ""));
      }
    } else if (hasComma) {
      var parts = t.split(",");
      if (parts.length === 2 && parts[1].length === 3) {
        n = parseFloat(t.replace(",", "."));
      } else if (parts.length === 2 && parts[1].length <= 2) {
        n = parseFloat(t.replace(",", "."));
      } else {
        n = parseFloat(t.replace(/,/g, ""));
      }
    } else if (hasDot) {
      var pParts = t.split(".");
      // Si lo que sigue al ultimo dot son exactamente 3 digitos:
      //  - si esos 3 digitos son "000", es decimal X.000 = X (caso Coto/Diarco/Abastecedor)
      //  - si no, es miles AR ("1.260" = 1260) cuando primer parte tiene 1-3 digitos
      //  - si la primer parte tiene >=4 digitos, es decimal (3015.000 = 3015, 12345.678 = decimal)
      if (pParts.length === 2 && pParts[1].length === 3) {
        if (pParts[1] === "000" || pParts[0].length >= 4) {
          n = parseFloat(t);
        } else {
          n = parseFloat(t.replace(/\./g, ""));
        }
      } else {
        n = parseFloat(t);
      }
    } else {
      n = parseFloat(t);
    }
    return isNaN(n) ? 0 : n;
  }

  // ============================================================================
  // EXTRACCION TEXTO PDF (browser, pdf.js)
  // ============================================================================
  async function extractPdfText(file) {
    var buf = await file.arrayBuffer();
    var pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    var allLines = [];
    for (var p = 1; p <= pdf.numPages; p++) {
      var page = await pdf.getPage(p);
      var content = await page.getTextContent();
      // Agrupar por coordenada Y (tolerancia +/-1 px)
      var rows = {};
      content.items.forEach(function (it) {
        var y = Math.round(it.transform[5]);
        var key = null;
        Object.keys(rows).forEach(function (k) {
          if (key == null && Math.abs(Number(k) - y) <= 1) key = k;
        });
        if (key == null) {
          rows[y] = [];
          key = y;
        }
        rows[key].push({ x: it.transform[4], str: it.str });
      });
      var keys = Object.keys(rows)
        .map(Number)
        .sort(function (a, b) {
          return b - a;
        });
      keys.forEach(function (k) {
        var row = rows[k].sort(function (a, b) {
          return a.x - b.x;
        });
        var line = row
          .map(function (r) {
            return r.str;
          })
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (line) allLines.push(line);
      });
    }
    return allLines.join("\n");
  }

  // ============================================================================
  // DETECCION DE CADENA
  // ============================================================================
  function detectSuper(text) {
    var t = text || "";
    if (/OrdCotoPlx|COTO\s+CICSA/i.test(t)) return "coto";
    if (/OrdDiaAPlx|SUPERMERCADO\s+DIA\s+ARG/i.test(t)) return "dia";
    if (/COMPRADOR:\s*DIARCO|OrdMayPlx/i.test(t)) return "diarco";
    if (/COMPRADOR:\s*DORINKA|OrdRmsDorinka/i.test(t)) return "dorinka";
    if (/OrdLaAnonimaPlx|S\.A\.\s*IMP\s*Y\s*EXP\.\s*DE\s*LA\s*PATAGONIA/i.test(t))
      return "laanonima";
    if (/Empresa\s+Cencosud|OrdJumboPlx|OrdDiscoPlx/i.test(t)) return "cencosud";
    if (/ALBERDI|Adm\.\s*Central:\s*Rocha\s+Sol/i.test(t)) return "alberdi";
    if (/COMPRADOR:\s*LIBERTAD|OrdLibertadAPlx/i.test(t)) return "libertad";
    if (/SUPERMERCADOS\s+EL\s+ABASTECEDOR|TECNOLAR/i.test(t))
      return "abastecedor";
    if (/OrdIncPlx|COMPRADOR:\s*INC\s*S\.?A\.?/i.test(t)) return "inc";
    // Messina: el encabezado viene con letras espaciadas "M E S S I N A   H N O S"
    if (/M\s*E\s*S\s*S\s*I\s*N\s*A\s*H\s*N\s*O\s*S/i.test(t)) return "messina";
    return null;
  }

  // ============================================================================
  // HELPERS PARA PARSERS
  // ============================================================================
  function splitLines(text) {
    return text
      .split(/\n/)
      .map(function (l) {
        return l.trim();
      })
      .filter(Boolean);
  }

  function findFirstMatch(lines, regex) {
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(regex);
      if (m) return m;
    }
    return null;
  }

  // ---- DUE DATE HELPERS ----
  // Normaliza una fecha (DD/MM/YYYY o DD.MM.YYYY o DD-MM-YYYY) a "DD/MM/YYYY".
  // Si recibe DD/MM/YY agrega "20".
  function normalizeDueDate_(s) {
    if (!s) return "";
    var m = String(s).trim().match(/(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2,4})/);
    if (!m) return "";
    var d = m[1].length < 2 ? "0" + m[1] : m[1];
    var mo = m[2].length < 2 ? "0" + m[2] : m[2];
    var y = m[3];
    if (y.length === 2) y = (parseInt(y, 10) < 50 ? "20" : "19") + y;
    return d + "/" + mo + "/" + y;
  }

  // Suma "days" dias a una fecha DD/MM/YYYY (o variante). Devuelve DD/MM/YYYY.
  function addDaysToDate_(dateStr, days) {
    var n = normalizeDueDate_(dateStr);
    if (!n) return "";
    var p = n.split("/");
    var dt = new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
    if (isNaN(dt.getTime())) return "";
    dt.setDate(dt.getDate() + Number(days || 0));
    var dd = String(dt.getDate()).padStart(2, "0");
    var mm = String(dt.getMonth() + 1).padStart(2, "0");
    var yy = dt.getFullYear();
    return dd + "/" + mm + "/" + yy;
  }

  // Busca primer match de regex en lines y devuelve el grupo 1 capturado.
  function findFieldRegex_(lines, regex) {
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(regex);
      if (m) return m[1];
    }
    return "";
  }

  // Para PDFs Planexware donde el VALOR esta en otra linea que el LABEL.
  // dir = 1 (siguiente), -1 (anterior), 2 (2 lineas despues), etc.
  function findFieldByLabel_(lines, labelRegex, dir) {
    for (var i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        var idx = i + (dir || 1);
        if (idx < 0 || idx >= lines.length) continue;
        var m = String(lines[idx]).match(/(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/);
        if (m) return m[1];
      }
    }
    return "";
  }

  // Busca una fecha cerca de un label (ventana +/-N lineas), priorizando direccion.
  // opts: { window: 5, preferAfter: true }
  function findDateNearLabel_(lines, labelRegex, opts) {
    opts = opts || {};
    var window = opts.window || 5;
    var preferAfter = opts.preferAfter !== false;
    var DATE_RE = /(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/;
    for (var i = 0; i < lines.length; i++) {
      if (!labelRegex.test(lines[i])) continue;
      // Misma linea: buscar fecha despues del label
      var lm = String(lines[i]).match(labelRegex);
      if (lm) {
        var rest = String(lines[i]).substring((lm.index || 0) + lm[0].length);
        var dm = rest.match(DATE_RE);
        if (dm) return dm[1];
      }
      // Lineas alrededor en orden de proximidad
      var tries = [];
      for (var d = 1; d <= window; d++) {
        if (preferAfter) tries.push(i + d, i - d);
        else tries.push(i - d, i + d);
      }
      for (var t = 0; t < tries.length; t++) {
        var idx = tries[t];
        if (idx < 0 || idx >= lines.length) continue;
        var dm2 = String(lines[idx]).match(DATE_RE);
        if (dm2) return dm2[1];
      }
    }
    return "";
  }

  // Para PDFs estilo Planexware con N labels de fecha consecutivos seguidos
  // de N valores. Devuelve el N-esimo valor (1-based, default 3 = ultima de 3).
  // labelGroupRegex matchea cualquiera de los labels consecutivos.
  // startLabelRegex matchea solo el primero (para ubicar el inicio).
  function findNthDateAfterLabels_(lines, startLabelRegex, labelGroupRegex, n) {
    n = n || 3;
    var DATE_RE = /^\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/;
    for (var i = 0; i < lines.length; i++) {
      if (!startLabelRegex.test(lines[i])) continue;
      // contar labels consecutivos
      var labelCount = 0;
      var j = i;
      while (j < lines.length && labelGroupRegex.test(lines[j])) {
        labelCount++;
        j++;
      }
      if (labelCount < n) continue;
      // recolectar fechas en lineas siguientes
      var fechas = [];
      for (var k = j; k < lines.length && fechas.length < n + 2; k++) {
        var m = String(lines[k]).match(DATE_RE);
        if (m) fechas.push(m[1]);
        else if (lines[k].trim() !== "") {
          // si encuentra texto que no es fecha y no es vacio, romper
          if (fechas.length > 0) break;
        }
      }
      if (fechas.length >= n) return fechas[n - 1];
    }
    return "";
  }

  // Para PDFs donde N fechas vienen ANTES de los labels (caso Diarco).
  // Busca el primer label, recolecta hasta N fechas hacia atras (ignorando lineas vacias).
  function findNthDateBeforeLabel_(lines, labelRegex, n) {
    n = n || 3;
    var DATE_RE = /^\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/;
    for (var i = 0; i < lines.length; i++) {
      if (!labelRegex.test(lines[i])) continue;
      var fechas = [];
      for (var j = i - 1; j >= 0 && fechas.length < n + 2; j--) {
        var m = String(lines[j]).match(DATE_RE);
        if (m) fechas.unshift(m[1]);
        else if (lines[j].trim() !== "") {
          if (fechas.length > 0) break;
        }
      }
      if (fechas.length >= n) return fechas[n - 1];
    }
    return "";
  }

  // Strip "D" suffix from codes like "229D" -> "229" (Alberdi, La Anonima)
  function stripDSuffix(cod) {
    return String(cod || "").replace(/D$/i, "").trim();
  }

  // Coto trae los totales en una grilla: header con varias columnas y valores
  // en la siguiente linea por posicion. Tot.Imp.Neto es la 4ta columna.
  // Header: Tot.Unidades | Tot.U.Bonific. | Total Bultos | Tot.Imp.Neto | Total Cuota IVA | Total Imp.Int. | Total Imp. A Pagar
  function extractCotoTotal(text) {
    if (!text) return null;
    var lines = text.split(/\n/);
    for (var i = 0; i < lines.length; i++) {
      // Header row tiene Tot.Imp.Neto + alguna otra etiqueta tipica
      if (
        /Tot\.?\s*Imp\.?\s*Neto/i.test(lines[i]) &&
        /(Total|Pagar|Bultos|Unidades|Bonific|IVA)/i.test(lines[i])
      ) {
        for (var j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          var line = (lines[j] || "").trim();
          if (!line) continue;
          var nums = line.match(/[\d.,]+/g) || [];
          if (nums.length >= 4) {
            var v = parseNum(nums[3]);
            if (v > 0) return v;
          }
          break;
        }
      }
    }
    return null;
  }

  // Extraer el total declarado en el PDF (si lo trae). Sirve para chequeo
  // interno vs el total calculado. Las patterns están ordenadas por prioridad —
  // primero los "sub totales" sin IVA / sin impuestos para matchear directo
  // con el calc.
  function extractPdfTotal(text, superKey) {
    if (!text) return null;
    // Caso especial: Coto requiere extraccion por posicion de columna
    var cotoVal = extractCotoTotal(text);
    if (cotoVal) return cotoVal;
    // Messina: "Subtotal : 4,156,139.40" (sin IVA, matchea calc directo).
    // Solo para messina, para no pisar el fallback generico "Total:" de otras cadenas.
    if (superKey === "messina") {
      var mm = text.match(/Subtotal\s*:?\s*\$?\s*([\d.,]+)/i);
      if (mm) {
        var mv = parseNum(mm[1]);
        if (mv > 0) return mv;
      }
    }
    var patterns = [
      // Abastecedor: "TOTAL O. C.: 2365860" (sub total sin IVA, matchea calc)
      /TOTAL\s*O\.?\s*C\.?:?\s*\$?\s*([\d.,]+)/i,
      // La Anonima: "Sub total sin impuestos internos: 605640" (matchea calc)
      /Sub\s*total\s*sin\s*impuestos\s*internos:?\s*\$?\s*([\d.,]+)/i,
      // Diarco, Dorinka, Libertad, INC: "Total OC: XXX"
      /Total\s*OC:?\s*\$?\s*([\d.,]+)/i,
      // Alberdi: "Total Neto:"
      /Total\s*Neto:?\s*\$?\s*([\d.,]+)/i,
      // Alberdi: "Sub Total CD01: 1,620,168.00"
      /Sub\s*Total\s*CD\d+:?\s*\$?\s*([\d.,]+)/i,
      // Fallback genérico: "Total: 593587.76"
      /\bTotal:\s*\$?\s*([\d.,]+)/,
      // Fallback Abastecedor viejo: "TOTAL:" anchor
      /^TOTAL:?\s*\$?\s*([\d.,]+)/im,
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m && m[1]) {
        var v = parseNum(m[1]);
        if (v > 0) return v;
      }
    }
    return null;
  }

  // Buscar etiqueta + valor que pueden estar en la misma linea o en lineas
  // consecutivas. labelRe debe matchear la etiqueta (con o sin valor en grupo 1).
  // valueRe matchea el valor sobre la linea siguiente cuando la primera no lo tiene.
  function findFieldML(lines, labelRe, valueRe) {
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var m = l.match(labelRe);
      if (m) {
        if (m[1] && m[1].trim()) return m[1].trim();
        // Buscar valor en hasta 15 lineas siguientes (saltea lineas con etiquetas)
        for (var j = i + 1; j < Math.min(i + 16, lines.length); j++) {
          var v = (lines[j] || "").match(valueRe);
          if (v) return v[1].trim();
        }
      }
    }
    return "";
  }

  // ============================================================================
  // PARSERS POR CADENA
  // ============================================================================

  // ---- COTO ----
  // 2 lineas por item. Linea 1 contiene EAN. Linea 2 empieza con Fabric (5 dig)
  // y trae: Fabric Cod.Int.Prov Bultos 0 0 CxB 0 0 0 C.Neto
  function parseCoto(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      m = l.match(/L\.Dest:?\s*([A-Z0-9\-]+)/i);
      if (m && !branchId) branchId = m[1].trim();
      m = l.match(/Pedido:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/T[ée]rminos?\s*de\s*Pago:?\s*(.+?)(?:\s*L\.|$)/i);
      if (m && !paymentTermRaw) paymentTermRaw = m[1].trim();
      m = l.match(/L\.\s*de\s*Entrega:?\s*(.+)/i);
      if (m && !branchName) branchName = m[1].trim();
    });

    // Fecha vencimiento: "Fecha Tope: DD/MM/YYYY"
    var dueDate = normalizeDueDate_(findFieldRegex_(lines, /Fecha\s+Tope:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i));

    // Items: para cada linea con EAN, leer la siguiente con datos.
    // En PDFs multi-pagina, line 2 puede estar separada por header de pagina
    // (4-5 lineas: Raz.Social, Pedido, PLU/EAN header, Fabric/Cod header). Por eso
    // buscamos hasta 10 lineas adelante saltando lineas que no matcheen el patron.
    for (var i = 0; i < lines.length; i++) {
      var line1 = lines[i];
      var eanM = line1.match(/\b(\d{13})\b/);
      if (!eanM) continue;
      var line2 = "";
      for (var j = i + 1; j <= Math.min(i + 10, lines.length - 1); j++) {
        // Si encontramos otra linea con EAN antes de la linea 2, abortar (probablemente
        // este item no tiene su linea 2 en el rango)
        if (/\b\d{13}\b/.test(lines[j])) break;
        if (/^\d{4,6}\s+\w+\s+\d/.test(lines[j])) {
          line2 = lines[j];
          break;
        }
      }
      if (!line2) continue;
      // Parsear linea 2: Fabric Cod.Int.Prov Bultos B1 B2 CxB ... C.Neto
      var tokens = line2.split(/\s+/);
      if (tokens.length < 6) continue;
      var codLk = tokens[1];
      var cajas = parseInt(tokens[2]);
      var uxb = parseInt(tokens[5]);
      // C.Neto = ultimo token con decimales
      var unitPrice = 0;
      for (var k = tokens.length - 1; k >= 0; k--) {
        var v = parseNum(tokens[k]);
        if (v > 50) {
          unitPrice = v;
          break;
        }
      }
      if (codLk && cajas > 0 && unitPrice > 0) {
        items.push({
          codLk: codLk,
          ean: eanM[1],
          description: "",
          cajas: cajas,
          uxb: uxb || 0,
          unitPrice: unitPrice,
        });
      }
    }

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- DIA ----
  // 1 linea por item: DESCRIPCION EAN COD_COMPRADOR CAJAS UxB UNIDADES CAPAS PALLETS PRECIO_NETO
  // codLk = EAN[9..12]
  function parseDia(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    // Etiqueta + valor pueden estar en la misma linea o en lineas consecutivas
    for (var li = 0; li < lines.length; li++) {
      var l = lines[li];
      var nextL = lines[li + 1] || "";
      var m;
      // Lugar de entrega / Nombre — buscar patron "N - Texto" en misma linea o siguiente
      if (!branchId) {
        m = l.match(/(?:Lugar\s*de\s*entrega|Nombre):?\s*(\d+)\s*[-–]\s*(.+)/i);
        if (!m) {
          var hasLabel = /(?:Lugar\s*de\s*entrega|Nombre):?\s*$/i.test(l);
          if (hasLabel) m = nextL.match(/^(\d+)\s*[-–]\s*(.+)/);
        }
        if (m) {
          branchId = m[1].trim();
          branchName = m[2].trim();
        }
      }
      if (!orderNumber) {
        m = l.match(/N[uú]mero\s*de\s*Orden\s*de\s*Compra:?\s*(\d+)/i);
        if (!m && /N[uú]mero\s*de\s*Orden\s*de\s*Compra:?\s*$/i.test(l))
          m = nextL.match(/^(\d{4,})\s*$/);
        if (m) orderNumber = m[1].trim();
      }
      if (!paymentTermRaw) {
        m = l.match(/(?:Forma\s*de\s*[Pp]ago|Cond\.?\s*Pago):?\s*(.+)/i);
        if (m && m[1].trim()) paymentTermRaw = m[1].trim();
      }
    }

    lines.forEach(function (line) {
      var eanM = line.match(/\b(\d{13})\b/);
      if (!eanM) return;
      var ean = eanM[1];
      var idx = line.indexOf(ean);
      var after = line.substring(idx + ean.length).trim();
      var tokens = after.split(/\s+/);
      if (tokens.length < 4) return;
      var cajas = parseInt(tokens[1]);
      var uxb = parseInt(tokens[2]);
      var unitPrice = 0;
      for (var k = tokens.length - 1; k >= 0; k--) {
        var v = parseNum(tokens[k]);
        if (v > 50) {
          unitPrice = v;
          break;
        }
      }
      var codLk = ean.substring(9, 12);
      if (cajas > 0 && unitPrice > 0) {
        items.push({
          codLk: codLk,
          ean: ean,
          description: "",
          cajas: cajas,
          uxb: uxb || 0,
          unitPrice: unitPrice,
        });
      }
    });

    // Fecha vencimiento: Dia no la trae explicita. Usamos "Fecha de entrega" + 90 dias.
    var dueDate = "";
    var fechaEntrega = findFieldByLabel_(lines, /Fecha\s*de\s*entrega:?\s*$/i, 1);
    if (!fechaEntrega) {
      fechaEntrega = findFieldRegex_(lines, /Fecha\s*de\s*entrega:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i);
    }
    if (fechaEntrega) dueDate = addDaysToDate_(fechaEntrega, 90) + " (aprox)";

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- DIARCO ----
  // 1 linea: EAN Cod.Prod ...desc... UxB Bultos Unidades P.Unit TOTAL
  function parseDiarco(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      m = l.match(/Nombre:?\s*(\d+)\s*[-–]\s*(.+)/i);
      if (m && !branchId) {
        branchId = m[1].trim();
        branchName = m[2].trim();
      }
      m = l.match(/ORDEN\s*DE\s*COMPRA:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/Forma\s*de\s*Pago:?\s*(.+)/i);
      if (m && m[1].trim() && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });
    if (!orderNumber)
      orderNumber = findFieldML(lines, /ORDEN\s*DE\s*COMPRA:?\s*$/i, /^(\d{4,})\s*$/);
    if (!paymentTermRaw)
      paymentTermRaw = findFieldML(lines, /Forma\s*de\s*Pago:?\s*$/i, /^(\S.+)/);

    // Pattern: line with EAN and end matching uxb bultos unidades p.unit total
    // Trailing 5 numbers: uxb, bultos, unidades, p.unit (decimales), total (decimales)
    var TAIL = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/;
    lines.forEach(function (line) {
      var eanM = line.match(/\b(\d{13})\b/);
      if (!eanM) return;
      var ean = eanM[1];
      var tail = line.match(TAIL);
      if (!tail) return;
      var uxb = parseInt(tail[1]);
      var bultos = parseInt(tail[2]);
      var unitPrice = parseNum(tail[4]);
      // codLk = primer numero despues del EAN
      var afterEan = line.substring(line.indexOf(ean) + ean.length).trim();
      var codLk = "";
      var firstTokenM = afterEan.match(/^(\S+)/);
      if (firstTokenM) codLk = stripDSuffix(firstTokenM[1]);
      if (codLk && bultos > 0 && unitPrice > 0) {
        items.push({
          codLk: codLk,
          ean: ean,
          description: "",
          cajas: bultos,
          uxb: uxb,
          unitPrice: unitPrice,
        });
      }
    });

    // Fecha vencimiento: Diarco trae 3 fechas consecutivas ANTES de los labels
    // "Fecha OC / Fecha Entrega / Fecha Cancelación". La 3ra (Cancelación) = vto.
    var dueDate = normalizeDueDate_(findNthDateBeforeLabel_(lines, /Fecha\s*OC/i, 3));
    if (!dueDate) dueDate = normalizeDueDate_(findDateNearLabel_(lines, /Fecha\s*Cancelaci[óÛo]n/i, { window: 8, preferAfter: false }));

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- DORINKA (Walmart) ----
  // 1 linea: EAN SKU Ref.Prov ...desc... UxB Bultos_Pedidos Unidades_Pedidas Precio_simp Total_simp
  // Precio s/imp es por BULTO. unitPrice = Precio / UxB / (1 - volDiscount)
  function parseDorinka(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";
    var volDiscount = 0;

    lines.forEach(function (l) {
      var m;
      m = l.match(/LUGAR\s+DE\s+ENTREGA:?\s*([0-9]+)\s*[-–]?\s*(.*)/i);
      if (m && !branchId) {
        branchId = m[1].trim();
        branchName = (m[2] || "").trim();
      }
      m = l.match(/ORDEN\s*DE\s*COMPRA:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/Condicion\s*Pago:?\s*(.+)/i);
      if (m && !paymentTermRaw) paymentTermRaw = m[1].trim();
      m = l.match(/Descuento\s+por\s+volumen.*?(\d+(?:\.\d+)?)\s*%/i);
      if (m) volDiscount = parseNum(m[1]) / 100;
    });
    if (!orderNumber)
      orderNumber = findFieldML(lines, /ORDEN\s*DE\s*COMPRA:?\s*$/i, /^(\d{4,})\s*$/);
    if (!paymentTermRaw)
      paymentTermRaw = findFieldML(lines, /Condicion\s*Pago:?\s*$/i, /^(\S.+)/);

    // Tail: UxB Bultos Unidades Precio Total (Precio y Total con decimales)
    var TAIL = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s*$/;
    lines.forEach(function (line) {
      var eanM = line.match(/\b(\d{13})\b/);
      if (!eanM) return;
      var ean = eanM[1];
      var tail = line.match(TAIL);
      if (!tail) return;
      var uxb = parseInt(tail[1]);
      var bultos = parseInt(tail[2]);
      var precioBulto = parseNum(tail[4]);
      // codLk = Ref.Prov (3er token, despues de EAN y SKU)
      var afterEan = line.substring(line.indexOf(ean) + ean.length).trim();
      var tokens = afterEan.split(/\s+/);
      var codLk = tokens.length >= 2 ? tokens[1] : "";
      // unitPrice = Precio_per_bulto / UxB / (1 - volDiscount)
      var unitPrice = precioBulto;
      if (uxb > 0) unitPrice = unitPrice / uxb;
      if (volDiscount > 0 && volDiscount < 1)
        unitPrice = unitPrice / (1 - volDiscount);
      if (codLk && bultos > 0 && unitPrice > 0) {
        items.push({
          codLk: codLk,
          ean: ean,
          description: "",
          cajas: bultos,
          uxb: uxb,
          unitPrice: unitPrice,
        });
      }
    });

    // Fecha vencimiento: "Fecha Tope: DD/MM/YYYY"
    var dueDate = normalizeDueDate_(findFieldRegex_(lines, /Fecha\s+Tope:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i));

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      volDiscount: volDiscount,
      dueDate: dueDate,
    };
  }

  // ---- LA ANONIMA ----
  // 1 linea (puede dividirse en 2 si HNOS termina en linea siguiente):
  // Cod.Art Cod.Prov Desc Bto CantUM CU Cant Costo %Bonif %IVA Total
  // codLk = Cod.Prov (strip D), unitPrice = Costo / Bto
  function parseLaAnonima(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      m = l.match(/SUCURSAL\s+DESTINO\s*(\d+)\s*[-–]?\s*(.*)/i);
      if (m && !branchId) {
        branchId = m[1].trim();
        branchName = (m[2] || "").trim();
      }
      m = l.match(/N[ÚU]MERO\s*OC\s*:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/CONDICIONES\s*DE\s*PAGO:?\s*(.+)/i);
      if (m && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });
    // pdf.js junta columnas "LUGAR DE ENTREGA" y "SUCURSAL DESTINO" en una sola
    // linea. Necesito tomar la SEGUNDA "DIGITOS - NOMBRE" (SUCURSAL DESTINO).
    if (!branchId) {
      for (var li = 0; li < lines.length; li++) {
        if (/LUGAR\s+DE\s+ENTREGA.*SUCURSAL\s+DESTINO/i.test(lines[li]) ||
            /SUCURSAL\s+DESTINO\s*$/i.test(lines[li])) {
          for (var lj = li + 1; lj < Math.min(li + 6, lines.length); lj++) {
            var allMatches = lines[lj].match(/(\d+)\s*[-–]\s*[A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ\s.]+/g);
            if (allMatches && allMatches.length) {
              // Si hay 2 (pdf.js juntando cols), tomar el SEGUNDO.
              // Si hay 1 (pdf-parse), tomar el unico (puede ser cualquiera).
              var pick = allMatches.length >= 2 ? allMatches[1] : allMatches[0];
              var pm = pick.match(/(\d+)\s*[-–]\s*(.+)/);
              if (pm) {
                branchId = pm[1].trim();
                branchName = pm[2].trim();
                break;
              }
            }
          }
          if (branchId) break;
        }
      }
    }
    if (!orderNumber)
      orderNumber = findFieldML(lines, /N[ÚU]MERO\s*OC\s*:?\s*$/i, /^(\d{4,})\s*$/);

    // Pattern tail: ... Bto CantUM CU Cant Costo %Bonif %IVA Total
    var TAIL = /(\d+)\s+(\d+)\s+CU\s+(\d+)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s*$/;
    var HEAD = /^(\d{6,})\s+([A-Z0-9]+)\s+/i;
    // Probar cada linea como-esta, y si no matchea probar concatenando con +1 o +2 lineas
    // (el formato pdf-parse split a veces deja "HNOS 24 1 CU..." en linea siguiente)
    for (var i = 0; i < lines.length; i++) {
      if (!HEAD.test(lines[i])) continue;
      var matched = false;
      for (var span = 1; span <= 3 && !matched; span++) {
        var combined = lines.slice(i, i + span).join(" ");
        var tail = combined.match(TAIL);
        var head = combined.match(HEAD);
        if (tail && head) {
          var codLk = stripDSuffix(head[2]);
          var bto = parseInt(tail[1]);
          var cant = parseInt(tail[3]);
          var costoPorBulto = parseNum(tail[4]);
          var unitPrice = bto > 0 ? costoPorBulto / bto : costoPorBulto;
          if (codLk && cant > 0 && unitPrice > 0) {
            items.push({
              codLk: codLk,
              ean: "",
              description: "",
              cajas: cant,
              uxb: bto,
              unitPrice: unitPrice,
            });
            matched = true;
          }
        }
      }
    }

    // Fecha vencimiento: label "FECHA VENCIMIENTO:" con valor cerca (priorizar antes)
    var dueDate = normalizeDueDate_(
      findDateNearLabel_(lines, /FECHA\s*VENCIMIENTO/i, { window: 5, preferAfter: false })
    );

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- CENCOSUD (Jumbo/Disco/Vea) ----
  // 2 lineas por item (linea 2 = atributos, ignorar)
  // Linea 1: Articulo EAN ...desc... UxB Paq Cant.Uni CostoBruto CostoNeto IVA RecFinan DescCaja D#### Bonif%
  // codLk = EAN[9..12], unitPrice = CostoBruto
  function parseCencosud(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      // Pd.Emisor puede tener texto despues del ID; no anclar a fin de linea
      m = l.match(/Pd\.?\s*Emisor[:\s]*(.+?)\s*[-–]\s*(\d+)\b/i);
      if (m && !branchId) {
        branchId = m[2].trim();
        branchName = m[1].trim();
      }
      m = l.match(/Nro\s*OC\s+(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/Cond\.?\s*Pago[:\s]+(.+)/i);
      if (m && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });

    // Tail: UxB Paq Cant.Uni CostoBruto CostoNeto IVA RecFinan DescCaja D#### Bonif%
    var TAIL = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+\d+\.\d+\s+\d+\s+\d+(?:\.\d+)?\s+D\d+\s+\d+(?:\.\d+)?\s*%\s*$/;
    lines.forEach(function (line) {
      var eanM = line.match(/\b(\d{13})\b/);
      if (!eanM) return;
      var ean = eanM[1];
      var tail = line.match(TAIL);
      if (!tail) return;
      var uxb = parseInt(tail[1]);
      var paq = parseInt(tail[2]);
      var costoBruto = parseNum(tail[4]);
      var codLk = ean.substring(9, 12);
      if (paq > 0 && costoBruto > 0) {
        items.push({
          codLk: codLk,
          ean: ean,
          description: "",
          cajas: paq,
          uxb: uxb,
          unitPrice: costoBruto,
        });
      }
    });

    // Fecha vencimiento: Cencosud trae "Fh.Vencimiento" arriba sin valor inline + "Fecha Tope: DD/MM/YYYY"
    var dueDate = normalizeDueDate_(findFieldRegex_(lines, /Fecha\s+Tope:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i));
    if (!dueDate) dueDate = normalizeDueDate_(findFieldByLabel_(lines, /Fh\.?\s*Vencimiento:?\s*$/i, 1));

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- ALBERDI ----
  // 1 linea (tab-separated): Codigo Cod.Prov Descripcion P.Lista Variaciones P.Unit I.I. UxB Cant UMP Total
  // codLk = Cod.Prov (strip D), unitPrice = P.Lista (coma decimal AR)
  function parseAlberdi(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      m = l.match(/Destino:?\s*([A-Z0-9]+)\s*(.*)/i);
      if (m && !branchId) {
        branchId = m[1].trim();
        branchName = (m[2] || "").trim();
      }
      m = l.match(/Pedido\s*N[º°∫]?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/Condici[óÛo]n\s*de\s*Pago:?\s*(.+)/i);
      if (m && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });
    if (!orderNumber)
      orderNumber = findFieldML(lines, /Pedido\s*N[º°∫]?\s*$/i, /^(\d{4,})\s*$/);

    // Linea de item: empieza con Codigo (5d) seguido de Cod.Prov (2-5 chars alfanumericos)
    // Tipico: "21178 027 Colador Loekemeyer Acero Inox 10cm 1un 1260,000 -15.00-5.00 1,017.450 24 10,0 BTO 244,188.00"
    // Pattern: ^(\d+)\s+([A-Z0-9]+)\s+(.+?)\s+(\d[\d.,]*)\s+([\-\d.]+)\s+([\d,.]+)\s+(\d+)\s+([\d,.]+)\s+(\w+)\s+([\d,.]+)$
    var ITEM_RE = /^(\d+)\s+([A-Z0-9]+D?)\s+(.+?)\s+([\d.,]+)\s+([\-\d.]+)\s+([\d,.]+)\s+(\d+)\s+([\d,.]+)\s+\w+\s+([\d,.]+)\s*$/i;
    lines.forEach(function (line) {
      var m = line.match(ITEM_RE);
      if (!m) return;
      var codLk = stripDSuffix(m[2]);
      var pLista = parseNum(m[4]);
      var uxb = parseInt(m[7]);
      var cant = Math.floor(parseNum(m[8]));
      if (codLk && cant > 0 && pLista > 0) {
        items.push({
          codLk: codLk,
          ean: "",
          description: m[3].trim(),
          cajas: cant,
          uxb: uxb,
          unitPrice: pLista,
        });
      }
    });

    // Fecha vencimiento: Alberdi no la trae explicita. "Fecha de Entrega: DD.MM.YYYY" + 30 dias.
    var dueDate = "";
    var fechaEnt = findFieldRegex_(lines, /Fecha\s*de\s*Entrega:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i);
    if (fechaEnt) dueDate = addDaysToDate_(fechaEnt, 30) + " (aprox)";

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- LIBERTAD ----
  // 1 linea: EAN Articulo ...desc... UxB Bultos Cantidad CostoBruto CostoNeto Descuento TOTAL
  // codLk = EAN[9..12], unitPrice = Costo Bruto
  function parseLibertad(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      // Nombre: NAME - DIGITS  (puede tener mas texto despues como "Fecha Entrega: ...")
      m = l.match(/Nombre:?\s*(.+?)\s*[-–]\s*(\d+)\b/i);
      if (m && !branchId) {
        branchName = m[1].trim();
        branchId = m[2].trim();
      }
      m = l.match(/ORDEN\s*DE\s*COMPRA:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/Forma\s*de\s*pago:?\s*(.+)/i);
      if (m && m[1].trim() && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });
    if (!orderNumber)
      orderNumber = findFieldML(lines, /ORDEN\s*DE\s*COMPRA:?\s*$/i, /^(\d{4,})\s*$/);
    if (!paymentTermRaw)
      paymentTermRaw = findFieldML(lines, /Forma\s*de\s*pago:?\s*$/i, /^(\S.+)/);

    // Tail: UxB Bultos Cantidad CostoBruto CostoNeto Descuento TOTAL
    var TAIL = /(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/;
    lines.forEach(function (line) {
      var eanM = line.match(/\b(\d{13})\b/);
      if (!eanM) return;
      var ean = eanM[1];
      var tail = line.match(TAIL);
      if (!tail) return;
      var uxb = parseInt(tail[1]);
      var bultos = parseInt(tail[2]);
      var costoBruto = parseNum(tail[4]);
      var codLk = ean.substring(9, 12);
      if (bultos > 0 && costoBruto > 0) {
        items.push({
          codLk: codLk,
          ean: ean,
          description: "",
          cajas: bultos,
          uxb: uxb,
          unitPrice: costoBruto,
        });
      }
    });

    // Fecha vencimiento: 3 labels consecutivos (Fecha OC / Entrega / Vto), valores en orden.
    // Tomar el 3er valor.
    var dueDate = normalizeDueDate_(
      findNthDateAfterLabels_(
        lines,
        /Fecha\s*OC:?\s*$/i,
        /Fecha\s*(?:OC|Entrega|Vto):?\s*$/i,
        3
      )
    );
    if (!dueDate) {
      dueDate = normalizeDueDate_(
        findDateNearLabel_(lines, /Fecha\s*Vto/i, { window: 6, preferAfter: true })
      );
    }

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- EL ABASTECEDOR (Tecnolar) ----
  // 1 linea: Descripcion Unid PrecioRep Total EAN Bultos UxB CBruto Codigo Cod.Prov
  // codLk = Cod.Prov (ultimo token), unitPrice = C.Bruto
  function parseAbastecedor(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      m = l.match(/SUCURSAL:?\s*\[\s*([0-9]+)\s*\]\s*(.*)/i);
      if (m && !branchId) {
        branchId = m[1].trim();
        branchName = (m[2] || "").trim();
      }
      // Abastecedor: el numero puede ir ANTES del label "Orden de Compra Nro:"
      m = l.match(/Orden\s*de\s*Compra\s*Nro:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      if (!orderNumber) {
        m = l.match(/^(\d+)\s+Orden\s*de\s*Compra\s*Nro/i);
        if (m) orderNumber = m[1].trim();
      }
      m = l.match(/Cond\.?\s*Pago:?\s*(.+)/i);
      if (m && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });
    if (!orderNumber)
      orderNumber = findFieldML(
        lines,
        /Orden\s*de\s*Compra\s*Nro:?\s*$/i,
        /^(\d{4,})\s*$/,
      );

    // Hay 2 ordenes posibles segun el extractor de PDF:
    //  A) Browser pdf.js (produccion): Codigo EAN Cod.Prov Desc UxB Bultos Unid CBruto CNeto Total
    //     Ej: 150475 7795587005021 502 LOEKEMEYER ABRELATAS... 12.00 10 120.00 2545.000 2545.000 305400.0
    //  B) pdf-parse / texto column-order: ...Desc Unid CBruto Total EAN Bultos UxB CNeto Codigo Cod.Prov
    //     Ej: LOEKEMEYER ABRELATAS... 120.00 2545.000 305400.0 7795587005021 10 12.00 2545.000 150475 502
    var TAIL_BROWSER =
      /^(\d+)\s+(\d{13})\s+(\w+)\s+(.+?)\s+(\d+\.?\d*)\s+(\d+)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s+(\d+\.?\d*)\s*$/;
    var TAIL_PDFPARSE =
      /(\d{13})\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\w+)\s*$/;
    lines.forEach(function (line) {
      var mB = line.match(TAIL_BROWSER);
      if (mB) {
        var ean = mB[2];
        var codLk = mB[3];
        var uxb = parseInt(parseNum(mB[5]));
        var bultos = parseInt(mB[6]);
        var cBruto = parseNum(mB[8]);
        if (codLk && bultos > 0 && cBruto > 0) {
          items.push({
            codLk: codLk,
            ean: ean,
            description: (mB[4] || "").trim(),
            cajas: bultos,
            uxb: uxb,
            unitPrice: cBruto,
          });
        }
        return;
      }
      var mP = line.match(TAIL_PDFPARSE);
      if (mP) {
        var ean2 = mP[1];
        var bultos2 = parseInt(mP[2]);
        var uxb2 = parseInt(parseNum(mP[3]));
        var cBruto2 = parseNum(mP[4]);
        var codLk2 = mP[6];
        if (codLk2 && bultos2 > 0 && cBruto2 > 0) {
          items.push({
            codLk: codLk2,
            ean: ean2,
            description: "",
            cajas: bultos2,
            uxb: uxb2,
            unitPrice: cBruto2,
          });
        }
      }
    });

    // Fecha vencimiento: Abastecedor no la trae explicita. "Fecha Prometida" + 30 dias.
    var dueDate = "";
    var fechaProm = findFieldRegex_(lines, /Fecha\s+Prometida:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i);
    if (!fechaProm) fechaProm = findFieldRegex_(lines, /Fecha\s+Emision:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i);
    if (fechaProm) dueDate = addDaysToDate_(fechaProm, 30) + " (aprox)";

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- INC (Carrefour) ----
  // 1 linea: EAN ...desc... CJ UxB CantPed Precio Total
  // codLk = EAN[9..12], cajas = CantPed, unitPrice = Precio (per unit)
  function parseInc(text) {
    var lines = splitLines(text);
    var items = [];
    var orderNumber = "";
    var branchId = "";
    var branchName = "";
    var paymentTermRaw = "";

    lines.forEach(function (l) {
      var m;
      m = l.match(/ENTREGA:?\s*(\d+)/i);
      if (m && !branchId) branchId = m[1].trim();
      m = l.match(/Nombre:?\s*(.+)/i);
      if (m && m[1].trim() && !branchName) branchName = m[1].trim();
      m = l.match(/Nro\.?\s*OC:?\s*(\d+)/i);
      if (m && !orderNumber) orderNumber = m[1].trim();
      m = l.match(/Forma\s*de\s*pago:?\s*(.+)/i);
      if (m && m[1].trim() && !paymentTermRaw) paymentTermRaw = m[1].trim();
    });
    if (!branchId)
      branchId = findFieldML(lines, /ENTREGA:?\s*$/i, /^(\d{4,})\s*$/);
    if (!branchName)
      branchName = findFieldML(lines, /Nombre:?\s*$/i, /^(.+)$/);
    if (!orderNumber)
      orderNumber = findFieldML(lines, /Nro\.?\s*OC:?\s*$/i, /^(\d{4,})\s*$/);
    if (!paymentTermRaw)
      paymentTermRaw = findFieldML(lines, /Forma\s*de\s*pago:?\s*$/i, /^(\S.+)/);

    // Tail: CJ UxB CantPed Precio Total
    // CJ a veces aparece, a veces no. Pattern flexible: ... (CJ|UN|...) UxB CantPed Precio Total
    var TAIL = /\b(?:CJ|UN|CAJ|BLT)?\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*$/i;
    lines.forEach(function (line) {
      var eanM = line.match(/\b(\d{13})\b/);
      if (!eanM) return;
      var ean = eanM[1];
      var tail = line.match(TAIL);
      if (!tail) return;
      var uxb = parseInt(tail[1]);
      var cantPed = parseInt(tail[2]);
      var precio = parseNum(tail[3]);
      var codLk = ean.substring(9, 12);
      if (cantPed > 0 && precio > 0) {
        items.push({
          codLk: codLk,
          ean: ean,
          description: "",
          cajas: cantPed,
          uxb: uxb,
          unitPrice: precio,
        });
      }
    });

    // Fecha vencimiento: "Fecha de cancelación" — buscar fecha cerca (preferir despues)
    var dueDate = normalizeDueDate_(
      findDateNearLabel_(lines, /Fecha\s*de\s*cancelaci[óÛo]n/i, { window: 5, preferAfter: true })
    );

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  // ---- MESSINA (Hnos) ----
  // "PEDIDO DE COTIZACION". 1 linea por item (agrupada por Y):
  // COD_MESSINA DESC [DESC ADICIONAL] Caja x N Uni[d] COD_LK EAN13 UNIDADES P.UNIT %BON IMPORTE
  // El "Código Artículo Proveedor" ES el cod LK (501, 505, 960E...). La cantidad
  // viene en UNIDADES → cajas = unidades / uxb ("Caja x 6 Unid" / "Caja x 12 Uni").
  // Precio unitario POR UNIDAD (importe = unidades × precio). Subtotal sin IVA.
  function parseMessina(text) {
    var lines = splitLines(text);
    var items = [];

    var ITEM_RE = /^(\d{8,12})\s+(.+?)\s+Caja\s*x\s*(\d+)\s*Uni\w*\.?\s+(\S+)\s+(\d{13})\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)\s*$/i;
    lines.forEach(function (line) {
      var m = line.match(ITEM_RE);
      if (!m) return;
      var uxb = parseInt(m[3], 10) || 0;
      var unidades = parseNum(m[6]);
      var cajas = uxb > 0 ? Math.round(unidades / uxb) : 0;
      var unitPrice = parseNum(m[7]);
      if (cajas > 0 && unitPrice > 0) {
        items.push({
          codLk: m[4].trim().toUpperCase(),
          ean: m[5],
          description: m[2].trim(),
          cajas: cajas,
          uxb: uxb,
          unitPrice: unitPrice,
        });
      }
    });

    // "Nº Orden : 00000-00007058" → "7058" (ultimo tramo, sin ceros a la izquierda)
    var orderNumber = "";
    var om = findFieldRegex_(lines, /N[ºo°]?\s*Orden\s*:?\s*([\d-]+)/i);
    if (om) {
      var tramo = om.split("-").pop();
      orderNumber = String(parseInt(tramo, 10) || "");
    }

    // Deposito de entrega: el label "Depósito Entrega:" cierra la linea de
    // Cond.Compra y el VALOR cae en la linea de Observaciones (misma Y).
    // Ej: "Observaciones: DP1 MADRES D PLAZA D" → branchId "DP1".
    var branchId = "";
    var branchName = "";
    for (var i = 0; i < lines.length; i++) {
      var m2 =
        lines[i].match(/Dep[oó]sito\s*Entrega:?\s*([A-Z]{2,3}\d{1,3})\s+(.{3,})/i) ||
        lines[i].match(/^Observaciones:?\s*([A-Z]{2,3}\d{1,3})\s+(.{3,})/i);
      if (m2) {
        branchId = m2[1].trim().toUpperCase();
        branchName = m2[2].trim();
        break;
      }
    }

    // Condicion de compra: "Cond.Compra : 22 CUENTA CORRIENTE. 15 DIAS FF ..."
    var paymentTermRaw = "";
    var pm = findFieldRegex_(
      lines,
      /Cond\.?\s*Compra\s*:?\s*\d*\s*([A-ZÁÉÍÓÚ][^]*?)(?:\s*Dep[oó]sito\s*Entrega.*)?$/i
    );
    if (pm) paymentTermRaw = pm.trim();

    // Vencimiento: Fecha Vigencia si viene; si no, Fecha Entrega + dias de la
    // condicion de pago ("15 DIAS FF" → entrega + 15, aprox).
    var dueDate = findFieldRegex_(
      lines,
      /Fecha\s*Vigencia\s*:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i
    );
    if (!dueDate) {
      var entrega = findFieldRegex_(
        lines,
        /Fecha\s*Entrega\s*:?\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i
      );
      var diasM = paymentTermRaw.match(/(\d+)\s*DIAS/i);
      if (entrega && diasM) dueDate = addDaysToDate_(entrega, parseInt(diasM[1], 10)) + " (aprox)";
    }

    return {
      items: items,
      orderNumber: orderNumber,
      branchId: branchId,
      branchName: branchName,
      paymentTermRaw: paymentTermRaw,
      dueDate: dueDate,
    };
  }

  var PARSERS = {
    coto: parseCoto,
    dia: parseDia,
    diarco: parseDiarco,
    dorinka: parseDorinka,
    laanonima: parseLaAnonima,
    cencosud: parseCencosud,
    alberdi: parseAlberdi,
    libertad: parseLibertad,
    abastecedor: parseAbastecedor,
    inc: parseInc,
    messina: parseMessina,
  };

  // ============================================================================
  // PRODUCTS LOAD + SUPER PRICE LIST LOAD
  // ============================================================================
  async function loadAllProducts() {
    if (allProductsCache) return allProductsCache;
    // CH matchea contra su propio catalogo (Chef) → window.sb.
    if (!window.sb) throw new Error("Cliente Supabase no inicializado");
    var PAGE = 1000,
      all = [],
      offset = 0;
    while (true) {
      var r = await window.sb
        .from("products")
        .select("id,cod,description,list_price,uxb,active")
        .range(offset, offset + PAGE - 1);
      if (r.error) throw new Error(r.error.message);
      var batch = r.data || [];
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    allProductsCache = all;
    return all;
  }

  async function loadAllLokeProducts() {
    if (allLokeProductsCache) return allLokeProductsCache;
    // Chef no tiene loke_products; queda vacío (CH usa solo su catalogo).
    if (!window.sb) { allLokeProductsCache = []; return []; }
    var PAGE = 1000,
      all = [],
      offset = 0;
    while (true) {
      var r = await window.sb
        .from("loke_products")
        .select("id,cod,description,list_price,uxb,active")
        .range(offset, offset + PAGE - 1);
      if (r.error) {
        console.warn("loke_products: " + r.error.message);
        allLokeProductsCache = [];
        return [];
      }
      var batch = r.data || [];
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    allLokeProductsCache = all;
    return all;
  }

  async function loadAllChefProducts() {
    if (chefProductsCache) return chefProductsCache;
    var client = getChefClient();
    if (!client) throw new Error("Chef Supabase no disponible");
    var PAGE = 1000,
      all = [],
      offset = 0;
    while (true) {
      var r = await client
        .from("products")
        .select("id,cod,description,list_price,uxb,active")
        .range(offset, offset + PAGE - 1);
      if (r.error) throw new Error("Chef products: " + r.error.message);
      var batch = r.data || [];
      all = all.concat(batch);
      if (batch.length < PAGE) break;
      offset += PAGE;
    }
    chefProductsCache = all;
    return all;
  }

  function getProductsCacheForSuper(superKey) {
    return usesChefProducts(superKey)
      ? chefProductsCache || []
      : allProductsCache || [];
  }

  // Cargar customer fijo en Chef segun super
  async function loadChefCustomer(superKey) {
    var codCliente = CHEF_CUSTOMER_COD[superKey];
    if (!codCliente) return null;
    var client = getChefClient();
    if (!client) return null;
    // order by created_at: si hubiera un duplicado de cod_cliente, agarra el
    // más viejo (el original) de forma determinística, no uno al azar.
    var r = await client
      .from("customers")
      .select("*")
      .eq("cod_cliente", codCliente)
      .order("created_at", { ascending: true })
      .limit(1);
    if (r.error) {
      console.error("loadChefCustomer error:", r.error);
      return null;
    }
    return r.data && r.data[0] ? r.data[0] : null;
  }

  // Buscar sucursal en customer_delivery_addresses por super_branch_id (text)
  // que corresponde al branch_id del PDF (ej "93" para Coto, "504" para Dia, etc).
  // La columna super_branch_id se agrega via ALTER TABLE — ver doc del modulo.
  async function loadDeliveryAddressForBranch(customer, branchId, useChef) {
    if (!customer || !branchId) return null;
    var client = useChef ? getChefClient() : window.sb;
    if (!client) return null;
    var r = await client
      .from("customer_delivery_addresses")
      .select("slot,label,direccion_entrega,zona_expreso,super_branch_id")
      .eq("customer_id", customer.id)
      .eq("super_branch_id", String(branchId))
      .limit(1);
    if (r.error) {
      // Si la columna no existe todavia, evitar romper el flow
      if (/super_branch_id/i.test(r.error.message || "")) {
        console.warn(
          "customer_delivery_addresses no tiene columna super_branch_id — correr ALTER TABLE",
        );
        return null;
      }
      console.warn("loadDeliveryAddressForBranch error:", r.error);
      return null;
    }
    return r.data && r.data[0] ? r.data[0] : null;
  }

  // Cargar customer fijo en LK segun super
  async function loadLKCustomer(superKey) {
    var codCliente = LK_CUSTOMER_COD[superKey];
    if (!codCliente) return null;
    if (!window.sb) return null;
    var r = await window.sb
      .from("customers")
      .select("*")
      .eq("cod_cliente", codCliente)
      .limit(1);
    if (r.error) {
      console.error("loadLKCustomer error:", r.error);
      return null;
    }
    return r.data && r.data[0] ? r.data[0] : null;
  }

  // Genera variantes de un codigo para fallback:
  //  - Match exacto primero
  //  - Strip sufijo single-letter (A/L/T/D/E) y reintentar con/sin cada uno
  //  - Padding a 3 digitos si es numerico
  // Ej:
  //   "587"  -> ["587", "587E", "587L", "587A", "587T", "587D"]
  //   "587A" -> ["587A", "587", "587E", "587L", "587T", "587D"]
  //   "26"   -> ["26", "26E", ..., "026", "026E", ...]
  //   "229D" -> ["229D", "229", "229E", "229L", "229A", "229T"]
  var COMMON_SUFFIXES = ["", "E", "L", "A", "T", "D"];
  function codVariants(cod) {
    var c = String(cod || "").trim().toUpperCase();
    if (!c) return [];
    var seen = {};
    var out = [];
    function add(v) {
      if (!v) return;
      if (seen[v]) return;
      seen[v] = true;
      out.push(v);
    }
    add(c);
    // Si termina en sufijo single-letter conocido, sacarlo y probar variantes
    var sufM = c.match(/^(.+?)([A-Z])$/);
    var base = sufM && COMMON_SUFFIXES.indexOf(sufM[2]) >= 0 ? sufM[1] : c;
    // Variantes base con cada sufijo
    COMMON_SUFFIXES.forEach(function (s) {
      add(base + s);
    });
    // Padding a 3 digitos si numerico
    if (/^\d+$/.test(base)) {
      var padded = base.length < 3 ? ("000" + base).slice(-3) : base;
      var unpadded = base.replace(/^0+/, "") || base;
      COMMON_SUFFIXES.forEach(function (s) {
        add(padded + s);
        add(unpadded + s);
      });
    }
    return out;
  }

  function findInPool(pool, variants) {
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      var p = pool.find(function (x) {
        return String(x.cod || "").trim().toUpperCase() === v;
      });
      if (p) return p;
    }
    return null;
  }

  // Devuelve { product, isLoke } | null.
  // Para supers que usan products de Chef (solo Dorinka): busca en chef products.
  // Para los demas: busca en products LK, despues en loke_products.
  function findProductByCod(cod, superKey) {
    var variants = codVariants(cod);
    if (!variants.length) return null;
    var p = findInPool(getProductsCacheForSuper(superKey), variants);
    if (p) return { product: p, isLoke: false };
    if (!usesChefProducts(superKey)) {
      var lp = findInPool(allLokeProductsCache || [], variants);
      if (lp) return { product: lp, isLoke: true };
    }
    return null;
  }

  // Cargar precios por super desde la tabla precios_super, vía RPC gated por
  // admin (get_super_prices). Antes venía del xlsx PÚBLICO en el web root; ahora
  // está detrás de auth (el RPC devuelve 0 filas si no sos admin). Estructura:
  // superListPrices[super_key][COD_MAYUS] = price.
  async function loadSuperPrices() {
    if (superListLoaded) return;
    try {
      var r = await window.sb.rpc("get_super_prices");
      if (r.error) {
        console.warn("scot: get_super_prices error:", r.error.message);
        superListLoaded = true;
        return;
      }
      (r.data || []).forEach(function (row) {
        var sk = row.super_key;
        var cod = String(row.cod || "").trim().toUpperCase();
        if (!sk || !cod) return;
        if (!superListPrices[sk]) superListPrices[sk] = {};
        // First-wins: no pisar si ya existe.
        if (superListPrices[sk][cod] == null) superListPrices[sk][cod] = Number(row.price);
      });
      superListLoaded = true;
    } catch (e) {
      console.warn("scot: loadSuperPrices error", e);
      superListLoaded = true;
    }
  }

  function getSuperListPrice(superKey, codLk) {
    var dict = superListPrices[superKey];
    if (!dict) return null;
    var variants = codVariants(codLk);
    for (var i = 0; i < variants.length; i++) {
      if (dict[variants[i]] != null) return dict[variants[i]];
    }
    return null;
  }

  // Actualizar la lista de precios subiendo el xlsx: se parsea en el browser y
  // se manda al RPC set_super_prices (gated por admin, service_role). El archivo
  // NO se guarda en el server (deja de estar público). En CH solo se procesan
  // los supers de Chef (dorinka/cencosud).
  async function updateSuperPricesFromFile(file, onMsg) {
    var msg = onMsg || function () {};
    if (!file) return;
    if (!window.XLSX) return msg("La librería XLSX no cargó", "err");
    if (!window.sb) return msg("Sin sesión", "err");
    try {
      msg("Leyendo archivo…", "info");
      var buf = await file.arrayBuffer();
      var wb = window.XLSX.read(buf, { type: "array" });
      var listaArr = [], preciosArr = [];
      Object.keys(SHEET_CONFIG).forEach(function (sheetName) {
        var cfg = SHEET_CONFIG[sheetName];
        if (!isChefSuper(cfg.key)) return; // CH: solo dorinka/cencosud
        var ws = wb.Sheets[sheetName];
        if (!ws) return;
        var rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
        var fecha = "";
        for (var h = 0; h < cfg.dataStartRow && !fecha; h++) {
          var hr = rows[h] || [];
          for (var k = 0; k < hr.length; k++) {
            var m = String(hr[k] || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
            if (m) { fecha = m[3] + "-" + m[2] + "-" + m[1]; break; }
          }
        }
        listaArr.push({ super_key: cfg.key, lista_fecha: fecha });
        var seen = {};
        for (var i = cfg.dataStartRow; i < rows.length; i++) {
          var row = rows[i] || [];
          var cod = row[cfg.codCol], price = row[cfg.priceCol];
          var cs = String(cod || "").trim().toLowerCase();
          if (cs === "cod" || cs === "cod anonima" || cod === "" || cod == null) continue;
          if (typeof price !== "number" || price <= 0) continue;
          var uc = String(cod).trim().toUpperCase();
          if (!uc || seen[uc]) continue;
          seen[uc] = 1;
          preciosArr.push({ super_key: cfg.key, cod: uc, price: price });
        }
      });
      if (!listaArr.length) return msg("El xlsx no tiene las hojas de Chef (WMart Chef / Jumbo Krea T)", "err");
      msg("Subiendo " + preciosArr.length + " precios…", "info");
      var r = await window.sb.rpc("set_super_prices", { p_lista: listaArr, p_precios: preciosArr });
      if (r.error) throw new Error(r.error.message);
      superListPrices = {};
      superListLoaded = false;
      await loadSuperPrices();
      var d = r.data || {};
      msg("✓ Actualizado: " + (d.precios_total != null ? d.precios_total : preciosArr.length) + " precios · " + ((d.supers || []).join(", ")), "ok");
      return d;
    } catch (e) {
      msg("Error: " + (e.message || e), "err");
      throw e;
    }
  }

  // ============================================================================
  // BRANCH MAPPING
  // ============================================================================
  async function findBranchMapping(superKey, superBranchId) {
    if (!superKey || !superBranchId) return null;
    // supers Chef usan cliente fijo (CHEF_CUSTOMER_COD), no branch mapping.
    if (!window.sb) return null;
    var r = await window.sb
      .from("supermarket_branch_mapping")
      .select("*,customers(*)")
      .eq("super_key", superKey)
      .eq("super_branch_id", String(superBranchId))
      .limit(1);
    if (r.error) {
      console.warn("findBranchMapping error:", r.error);
      return null;
    }
    if (!r.data || !r.data.length) return null;
    return r.data[0];
  }

  async function saveBranchMapping(superKey, superBranchId, superBranchName, customer) {
    var payload = {
      super_key: superKey,
      super_branch_id: String(superBranchId),
      super_branch_name: superBranchName || "",
      customer_id: customer.id,
      cod_cliente: String(customer.cod_cliente || ""),
    };
    if (!window.sb) throw new Error("Cliente Supabase no inicializado");
    var r = await window.sb
      .from("supermarket_branch_mapping")
      .upsert(payload, { onConflict: "super_key,super_branch_id" })
      .select()
      .limit(1);
    if (r.error) {
      console.error("saveBranchMapping error:", r.error);
      throw new Error(r.error.message);
    }
    return r.data && r.data[0];
  }

  // ============================================================================
  // UI
  // ============================================================================

  function el(html) {
    var d = document.createElement("div");
    d.innerHTML = html.trim();
    return d.firstChild;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtMoney(n) {
    return Math.round(Number(n || 0)).toLocaleString("es-AR");
  }

  // ============================================================================
  // CARD INSTANCE FACTORY: cada card es independiente con su propio state.
  // ============================================================================
  function createCardInstance(idx, cardRoot) {
    var $mount = cardRoot;
    var state = {
      idx: idx,
      superKey: null,
      superLabel: null,
      rawText: "",
      items: [],
      orderNumber: "",
      branchId: "",
      branchName: "",
      paymentTermRaw: "",
      paymentTermEdited: "",
      customer: null,
      mappingExisted: false,
      deliveryAddress: null,
      pdfTotal: null,
      fileHash: null, // SHA-256 del PDF, para detectar duplicados entre cards
      submitting: false,
    };

  function renderInitial() {
    if (!$mount) return;
    $mount.innerHTML = "";
    var card = el(
      '<div class="scot-card">' +
        '<div class="scot-drop" id="scotDrop">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" style="color:var(--text3,#888)"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
        '<p class="scot-drop-title">Arrastrá uno o varios PDFs</p>' +
        '<p class="scot-drop-sub">o hacé click para elegir (hasta 9 a la vez)</p>' +
        '<input type="file" class="scot-file-input" accept=".pdf,application/pdf" multiple hidden/>' +
        "</div>" +
        '<div class="scot-status">Cadena auto-detectada</div>' +
        "</div>",
    );
    $mount.appendChild(card);

    var drop = card.querySelector(".scot-drop");
    var input = card.querySelector(".scot-file-input");
    drop.addEventListener("click", function () {
      input.click();
    });
    input.addEventListener("change", function () {
      if (input.files && input.files.length) {
        distributeFilesToCards(idx, Array.from(input.files));
      }
    });
    drop.addEventListener("dragover", function (e) {
      e.preventDefault();
      drop.classList.add("scot-drag");
    });
    drop.addEventListener("dragleave", function () {
      drop.classList.remove("scot-drag");
    });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("scot-drag");
      var files = e.dataTransfer.files;
      if (files && files.length) {
        distributeFilesToCards(idx, Array.from(files));
      }
    });
  }

  function setStatus(msg, kind) {
    if (!$mount) return;
    var s = $mount.querySelector(".scot-status");
    if (!s) return;
    s.className = "scot-status" + (kind ? " " + kind : "");
    s.innerHTML = msg;
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      setStatus("Archivo no es un PDF", "err");
      return;
    }
    setStatus('<span class="scot-spinner"></span> Procesando PDF...');
    try {
      // Hash del archivo para detectar duplicados entre cards
      var hash = await computeFileHash(file);
      var dupIdx = findDuplicateCardIdx(hash, idx);
      if (dupIdx) {
        setStatus(
          "⚠ Este PDF ya está cargado en card " + dupIdx + ". No se procesa de nuevo.",
          "err",
        );
        window.alert(
          "Este PDF ya está cargado en la card #" +
            dupIdx +
            ".\nNo se procesa de nuevo para evitar pedidos duplicados.\n\nSi querés cargarlo igual, primero descartá el de la otra card (icono tacho).",
        );
        return;
      }
      state.fileHash = hash;
      var text = await extractPdfText(file);
      state.rawText = text;
      var key = detectSuper(text);
      if (!key) {
        console.warn("Texto extraído:", text);
        setStatus(
          "No se pudo identificar la cadena. Texto extraído impreso en consola.",
          "err",
        );
        return;
      }
      state.superKey = key;
      state.superLabel = SUPERS[key];
      setStatus(
        '<span class="scot-spinner"></span> Cadena: <strong>' +
          escapeHtml(state.superLabel) +
          "</strong>. Parseando...",
      );

      var parser = PARSERS[key];
      var parsed = parser(text);
      state.orderNumber = parsed.orderNumber || "";
      state.branchId = parsed.branchId || "";
      state.branchName = parsed.branchName || "";
      state.paymentTermRaw = parsed.paymentTermRaw || "";
      state.paymentTermEdited = state.paymentTermRaw;
      state.dueDate = parsed.dueDate || "";
      state.pdfTotal = extractPdfTotal(text, key);

      if (!parsed.items.length) {
        console.warn("Texto extraído:", text);
        setStatus(
          "Cadena detectada pero no se pudieron extraer ítems. Revisá la consola para ajustar el parser.",
          "err",
        );
        return;
      }

      // Cargar products: solo Dorinka usa Chef; el resto (incluido Cencosud) usa LK + Loke.
      var loaders;
      if (usesChefProducts(key)) {
        loaders = [loadAllChefProducts(), loadSuperPrices()];
      } else {
        loaders = [loadAllProducts(), loadAllLokeProducts(), loadSuperPrices()];
      }
      await Promise.all(loaders);
      state.items = parsed.items.map(function (it) {
        var match = findProductByCod(it.codLk, key);
        var p = match ? match.product : null;
        var isLoke = match ? match.isLoke : false;
        // Si encontramos producto con codigo levemente distinto (E suffix/zero pad), usar el cod real
        var actualCod = p ? String(p.cod || "").trim() : it.codLk;
        // Para super prices probar primero el codigo real, luego el del PDF
        var superPrice = getSuperListPrice(key, actualCod);
        if (superPrice == null) superPrice = getSuperListPrice(key, it.codLk);
        var listPrice =
          superPrice != null ? superPrice : p ? Number(p.list_price || 0) : 0;
        return {
          codLk: actualCod,
          codPdf: it.codLk !== actualCod ? it.codLk : null,
          ean: it.ean || "",
          description: p ? p.description : "(producto no encontrado)",
          cajas: it.cajas,
          uxb: it.uxb || (p ? Number(p.uxb || 0) : 0),
          unitPrice: it.unitPrice,
          listPrice: listPrice,
          listPriceSource: superPrice != null ? "super" : p ? "lk" : "none",
          product: p || null,
          isLoke: isLoke,
          found: !!p,
          included: !!p,
        };
      });

      // Cliente fijo por super. En el admin de CH SOLO se cargan supers de Chef
      // (Cencosud/Dorinka). Un super LK NO se busca en Chef: su cod_cliente
      // podria colisionar con OTRO cliente Chef distinto (ej cod 2320 = Alberdi
      // en LK pero Distribuidora Veneto en Chef) y submitear al equivocado.
      // Por eso se bloquea explicitamente en vez de dejar que falle el lookup.
      if (isChefSuper(key)) {
        state.customer = await loadChefCustomer(key);
        state.mappingExisted = !!state.customer;
        if (!state.customer) {
          window.toast &&
            window.toast(
              "No se encontró cliente Chef para " + key + " (cod_cliente " + CHEF_CUSTOMER_COD[key] + ")",
              "error",
            );
        }
      } else {
        state.customer = null;
        state.mappingExisted = false;
        window.toast &&
          window.toast(
            (SUPERS[key] || key) + " no se carga en Chef. Usá el admin de LK para este super.",
            "error",
          );
      }

      // Buscar sucursal en customer_delivery_addresses por slot = branch_id
      state.deliveryAddress = await loadDeliveryAddressForBranch(
        state.customer,
        state.branchId,
        isChefSuper(key),
      );

      renderResult();
    } catch (e) {
      console.error("scot handleFile error:", e);
      setStatus("Error procesando PDF: " + (e.message || e), "err");
    }
  }

  // Diferencia per-item considerando el dto esperado del super.
  // Devuelve un float (0 = match exacto). Si listPrice no es válido, devuelve null.
  function itemPriceDiff(it, superKey) {
    if (!(it.listPrice > 0)) return null;
    var expectedDisc = SUPER_ITEM_DISCOUNT[superKey] || 0;
    var expectedPrice = it.listPrice * (1 - expectedDisc);
    return Math.abs(it.unitPrice - expectedPrice) / it.listPrice;
  }

  function computeOrderTotals() {
    var total = 0;
    var totalCajas = 0;
    var includedCount = 0;
    (state.items || []).forEach(function (it) {
      if (!it.included || !it.found) return;
      total += it.unitPrice * (it.cajas || 0) * (it.uxb || 0);
      totalCajas += it.cajas || 0;
      includedCount++;
    });
    return { total: total, totalCajas: totalCajas, includedCount: includedCount };
  }

  function buildSucursalHtml() {
    if (state.deliveryAddress) {
      return (
        '<div class="scot-meta-item" style="background:#dff5e3;border-color:#9bd6a8"><div class="scot-meta-label" style="color:#1e7a31">Sucursal (mapeada ✓)</div><div class="scot-meta-val">' +
        escapeHtml(state.deliveryAddress.label || "") +
        '<div style="font-size:11px;font-weight:400;color:#1e7a31;margin-top:4px">' +
        escapeHtml(state.deliveryAddress.direccion_entrega || "") +
        (state.deliveryAddress.zona_expreso
          ? " · Zona: " + escapeHtml(state.deliveryAddress.zona_expreso)
          : "") +
        '<div style="font-size:10px;color:#888;margin-top:2px">PDF: ' +
        escapeHtml(state.branchId) +
        "</div></div></div>"
      );
    }
    return (
      '<div class="scot-meta-item"><div class="scot-meta-label">Sucursal (sin mapear)</div><div class="scot-meta-val">' +
      escapeHtml(state.branchId || "—") +
      (state.branchName ? " — " + escapeHtml(state.branchName) : "") +
      '<div style="font-size:11px;font-weight:400;color:#b8780f;margin-top:4px">⚠ No está cargada en customer_delivery_addresses (super_branch_id=' +
      escapeHtml(state.branchId) +
      ")</div></div></div>"
    );
  }

  function renderResult() {
    $mount.innerHTML = "";
    var totals = computeOrderTotals();

    // Cliente meta line
    var cliMeta;
    if (state.customer) {
      cliMeta =
        '<div class="scot-meta-line"><span class="lbl">CLIENTE</span><span class="val">' +
        escapeHtml(state.customer.cod_cliente || "") +
        " — " +
        escapeHtml(state.customer.business_name || "") +
        "</span></div>";
    } else {
      var isChef = isChefSuper(state.superKey);
      var expectedCod = isChef
        ? CHEF_CUSTOMER_COD[state.superKey]
        : LK_CUSTOMER_COD[state.superKey];
      cliMeta =
        '<div class="scot-meta-line warn"><span class="lbl">CLIENTE</span><span class="val">⚠ no encontrado' +
        (expectedCod ? " (esperaba cod " + escapeHtml(expectedCod) + ")" : "") +
        "</span></div>";
    }

    // Sucursal text inline en UNA sola línea (label + dir + zona)
    var sucMeta;
    if (state.deliveryAddress) {
      var lbl = state.deliveryAddress.label || "";
      var dir = state.deliveryAddress.direccion_entrega || "";
      var zona = state.deliveryAddress.zona_expreso || "";
      var parts = [];
      if (lbl) parts.push(escapeHtml(lbl));
      if (dir) parts.push(escapeHtml(dir));
      if (zona) parts.push("Zona: " + escapeHtml(zona));
      sucMeta =
        '<div class="scot-meta-line ok"><span class="lbl">SUCURSAL</span><span class="val">' +
        parts.join(" · ") +
        "</span></div>";
    } else {
      sucMeta =
        '<div class="scot-meta-line warn"><span class="lbl">SUCURSAL</span><span class="val">⚠ ' +
        escapeHtml(state.branchId || "?") +
        " — sin mapear</span></div>";
    }

    // F. Vencimiento (lectura) — extraida del PDF, debajo de Sucursal
    var vtoMeta = state.dueDate
      ? '<div class="scot-meta-line ok"><span class="lbl">F. VENCIMIENTO</span><span class="val">' +
        escapeHtml(state.dueDate) +
        "</span></div>"
      : '<div class="scot-meta-line warn"><span class="lbl">F. VENCIMIENTO</span><span class="val">— no detectada en PDF</span></div>';

    // Card UNICA con todo: meta arriba a izq, total + acciones (Ver detalle, tacho, tick) arriba a der
    var missCount = state.items.filter(function (it) {
      return !it.found;
    }).length;

    // SVG icons
    var trashSvg =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>';
    var tickSvg =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="5 12 10 17 19 7"/></svg>';

    var card = el(
      '<div class="scot-card">' +
        '<div class="scot-summary">' +
        '<div class="scot-summary-left">' +
        '<div><span class="scot-detected">' +
        escapeHtml(state.superLabel) +
        "</span></div>" +
        '<div class="scot-meta-line"><span class="lbl">OC</span><span class="val">' +
        escapeHtml(state.orderNumber || "—") +
        "</span></div>" +
        cliMeta +
        sucMeta +
        vtoMeta +
        (missCount
          ? '<div class="scot-meta-line warn"><span class="lbl">ALERTA</span><span class="val">⚠ ' +
            missCount +
            " ítem(s) sin LK</span></div>"
          : "") +
        "</div>" +
        (function () {
          var ratio = SUPER_PDF_RATIO[state.superKey] || 1;
          var hasRatioAdjust = ratio !== 1;
          // Big TOTAL = el valor que debería aparecer en la OC del super
          // (calc ajustado por descuento/IVA del super). Así matchea siempre con el PDF.
          var displayedTotal = totals.total / ratio;
          var pdfBadgeHtml = "";
          if (state.pdfTotal != null) {
            var diff =
              Math.abs(displayedTotal - state.pdfTotal) /
              Math.max(state.pdfTotal, 1);
            var itemMismatchCount = state.items.filter(function (it) {
              if (!it.included || !it.found) return false;
              var p = itemPriceDiff(it, state.superKey);
              return p != null && p > 0.01;
            }).length;
            var totalOk = diff <= 0.01;
            var itemsOk = itemMismatchCount === 0;
            var cls;
            if (totalOk && itemsOk) cls = "ok";
            else if ((totalOk || itemsOk) && diff <= 0.05) cls = "warn";
            else cls = "bad";
            // Badge muestra SIEMPRE el valor del PDF (que equivale al big TOTAL).
            // El tick va al lado del PDF total — los 2 números (big TOTAL y este) son equivalentes.
            var label = "PDF: $ " + fmtMoney(state.pdfTotal);
            if (totalOk && itemsOk) label += " ✓";
            else if (!totalOk) label += " · Δ " + (diff * 100).toFixed(1) + "%";
            if (!itemsOk)
              label += " · " + itemMismatchCount + " ítem(s) con dif";
            // Si hay ratio (IVA o dto), agregar info del subtotal sin tick
            var subInfo = hasRatioAdjust
              ? '<span style="display:block;font-size:10px;font-weight:500;margin-top:2px;opacity:.85">s/dto: $ ' +
                fmtMoney(totals.total) +
                "</span>"
              : "";
            pdfBadgeHtml =
              '<span class="scot-pdf-total ' +
              cls +
              '">' +
              label +
              subInfo +
              "</span>";
          } else {
            // Día no trae total de precio en sus PDFs (solo cajas) → badge neutral.
            var noTotalLabel =
              state.superKey === "dia"
                ? "PDF Día: sin total (normal)"
                : "PDF: sin dato total";
            var noTotalCls = state.superKey === "dia" ? "info" : "miss";
            pdfBadgeHtml = hasRatioAdjust
              ? '<span class="scot-pdf-total ' +
                noTotalCls +
                '">' +
                noTotalLabel +
                '<span style="display:block;font-size:10px;margin-top:2px">s/dto: $ ' +
                fmtMoney(totals.total) +
                "</span></span>"
              : '<span class="scot-pdf-total ' +
                noTotalCls +
                '">' +
                noTotalLabel +
                "</span>";
          }
          return (
            '<div class="scot-total-big">' +
            '<span class="lab">Total</span>' +
            '<span class="val">$ ' +
            fmtMoney(displayedTotal) +
            "</span>" +
            '<span class="sub">' +
            totals.includedCount +
            " ítem(s) · " +
            totals.totalCajas +
            " caja(s)</span>" +
            pdfBadgeHtml
          );
        })() +
        '<div class="scot-total-actions">' +
        '<button type="button" class="scot-link-btn" id="scotItemsBtn">Ver detalle</button>' +
        '<button type="button" class="scot-icon-btn" id="scotResetBtn" title="Cargar otro PDF">' +
        trashSvg +
        "</button>" +
        '<button type="button" class="scot-icon-btn primary" id="scotSubmitBtn" title="Subir como pedido">' +
        tickSvg +
        "</button>" +
        "</div>" +
        "</div>" +
        "</div>" +
        "</div>",
    );
    $mount.appendChild(card);

    card
      .querySelector("#scotItemsBtn")
      .addEventListener("click", openItemsModal);
    card.querySelector("#scotResetBtn").addEventListener("click", function () {
      resetState();
      renderInitial();
    });
    card.querySelector("#scotSubmitBtn").addEventListener("click", submitOrder);
  }

  // ============================================================================
  // ITEMS MODAL
  // ============================================================================
  function openItemsModal() {
    // Reusar el mismo overlay si ya existe (de otra card)
    var existing = document.getElementById("scotItemsModal");
    if (existing) existing.remove();

    var overlay = el(
      '<div class="scot-modal-overlay" id="scotItemsModal">' +
        '<div class="scot-modal">' +
        '<div class="scot-modal-head">' +
        "<h3>Ítems del pedido — " +
        escapeHtml(state.superLabel || "") +
        " · OC " +
        escapeHtml(state.orderNumber || "—") +
        "</h3>" +
        '<button type="button" class="scot-modal-close" aria-label="Cerrar">×</button>' +
        "</div>" +
        '<div class="scot-modal-body" id="scotItemsModalBody"></div>' +
        "</div>" +
        "</div>",
    );
    document.body.appendChild(overlay);

    function close() {
      overlay.remove();
      refreshTotalDisplay();
    }
    overlay.querySelector(".scot-modal-close").addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function escListener(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", escListener);
      }
    });

    renderItemsCard(overlay.querySelector("#scotItemsModalBody"));
  }

  // Refrescar el total grande cuando cambian cajas/included (scoped al $mount de esta card)
  function refreshTotalDisplay() {
    if (!$mount) return;
    var totals = computeOrderTotals();
    var v = $mount.querySelector(".scot-total-big .val");
    var s = $mount.querySelector(".scot-total-big .sub");
    if (v) v.textContent = "$ " + fmtMoney(totals.total);
    if (s)
      s.textContent =
        totals.includedCount + " ítem(s) · " + totals.totalCajas + " caja(s)";
  }

  function renderCustomerCard(card) {
    var isChef = isChefSuper(state.superKey);
    var expectedCod = isChef
      ? CHEF_CUSTOMER_COD[state.superKey]
      : LK_CUSTOMER_COD[state.superKey];
    if (state.customer) {
      var c = state.customer;
      var subInfo =
        '<div style="font-size:11px;color:#1f4c6e;margin-top:2px">Cliente fijo en ' +
        (isChef ? "Chef" : "LK") +
        " Supabase para " +
        escapeHtml(state.superLabel) +
        " (sucursal PDF: " +
        escapeHtml(state.branchId || "—") +
        ")</div>";
      card.innerHTML =
        '<div class="scot-customer-current">' +
        "<div><strong>" +
        escapeHtml(c.cod_cliente || "") +
        "</strong> — " +
        escapeHtml(c.business_name || "") +
        subInfo +
        "</div>" +
        "</div>";
    } else {
      card.innerHTML =
        '<p style="font-size:13px;color:var(--danger,#c0392b);margin:0">No se encontró cliente para <strong>' +
        escapeHtml(state.superLabel) +
        "</strong>. " +
        (expectedCod
          ? "Esperaba cod_cliente <strong>" +
            escapeHtml(expectedCod) +
            "</strong> en " +
            (isChef ? "Chef" : "LK") +
            " Supabase. Verificá que exista o avisame para actualizar el mapeo."
          : "No hay cod_cliente configurado para esta cadena.") +
        "</p>";
    }
  }

  async function searchCustomer(q, container) {
    q = (q || "").trim();
    if (!q) {
      window.toast && window.toast("Ingresá un código o razón social", "warning");
      return;
    }
    container.innerHTML = '<div style="font-size:12px;color:#888"><span class="scot-spinner"></span> Buscando...</div>';
    var isNum = /^\d+$/.test(q);
    var r;
    if (isNum) {
      r = await window.sb
        .from("customers")
        .select("*")
        .eq("cod_cliente", q)
        .limit(10);
    } else {
      r = await window.sb
        .from("customers")
        .select("*")
        .ilike("business_name", "%" + q + "%")
        .order("business_name", { ascending: true })
        .limit(20);
    }
    if (r.error) {
      container.innerHTML = '<div style="color:var(--danger,#c0392b);font-size:12px">' + escapeHtml(r.error.message) + "</div>";
      return;
    }
    if (!r.data || !r.data.length) {
      container.innerHTML = '<div style="color:#888;font-size:12px">Sin resultados</div>';
      return;
    }
    container.innerHTML = "";
    r.data.forEach(function (c) {
      var row = el(
        '<div class="scot-customer-row" data-id="' +
          c.id +
          '"><strong>' +
          escapeHtml(c.cod_cliente || "") +
          "</strong> — " +
          escapeHtml(c.business_name || "") +
          "</div>",
      );
      row.addEventListener("click", function () {
        selectCustomer(c);
      });
      container.appendChild(row);
    });
  }

  async function selectCustomer(c) {
    state.customer = c;
    if (state.branchId) {
      try {
        await saveBranchMapping(
          state.superKey,
          state.branchId,
          state.branchName,
          c,
        );
        state.mappingExisted = true;
        window.toast && window.toast("Mapeo guardado para futuras órdenes", "success");
      } catch (e) {
        window.toast && window.toast("Mapeo no guardado: " + (e.message || e), "warning");
      }
    }
    var card = document.getElementById("scotCustCard");
    if (card) renderCustomerCard(card);
  }

  function renderItemsCard(card) {
    var foundCount = state.items.filter(function (it) {
      return it.found;
    }).length;
    var missCount = state.items.length - foundCount;

    var rows = state.items
      .map(function (it, idx) {
        var pct = itemPriceDiff(it, state.superKey);
        var pillCls, pillTxt;
        if (!it.found) {
          pillCls = "miss";
          pillTxt = "no LK";
        } else if (pct == null) {
          pillCls = "miss";
          pillTxt = "—";
        } else if (pct <= 0.01) {
          pillCls = "ok";
          pillTxt = "OK";
        } else if (pct <= 0.2) {
          pillCls = "warn";
          pillTxt = (pct * 100).toFixed(0) + "%";
        } else {
          pillCls = "bad";
          pillTxt = (pct * 100).toFixed(0) + "%";
        }
        var srcBadge = "";
        if (it.listPriceSource === "super")
          srcBadge = '<div style="font-size:9px;color:#1e7a31">Súper</div>';
        else if (it.listPriceSource === "lk")
          srcBadge = '<div style="font-size:9px;color:#888">LK gral</div>';
        var rowCls =
          (!it.found ? " scot-row-bad" : "") +
          (!it.included ? " scot-row-excluded" : "");
        var subtotal = it.unitPrice * (it.cajas || 0) * (it.uxb || 0);
        // Chef supers (Cencosud/Dorinka) llevan sufijo "L" en el código LK.
        // Se muestra en pantalla para que coincida con el Excel y la sheet.
        var codLkDisplay = isChefSuper(state.superKey)
          ? it.codLk + "L"
          : it.codLk;
        return (
          '<tr class="' +
          rowCls +
          '" data-idx="' +
          idx +
          '">' +
          '<td><input type="checkbox" class="scot-incl-chk" ' +
          (it.included ? "checked" : "") +
          (!it.found ? " disabled" : "") +
          "/></td>" +
          '<td title="' +
          escapeHtml(it.description || "") +
          '">' +
          escapeHtml(codLkDisplay) +
          (it.isLoke
            ? ' <span class="scot-pill" style="background:#fde2c4;color:#a04a00;font-size:9px;padding:1px 5px">LOKE</span>'
            : "") +
          (it.codPdf
            ? '<div style="font-size:9px;color:#888">PDF: ' + escapeHtml(it.codPdf) + "</div>"
            : "") +
          (it.ean ? '<div style="font-size:10px;color:#888">' + escapeHtml(it.ean) + "</div>" : "") +
          "</td>" +
          '<td><input type="number" class="scot-cajas-input" value="' +
          (it.cajas || 0) +
          '" min="0" step="1"/></td>' +
          '<td style="text-align:right">' +
          (it.uxb || 0) +
          "</td>" +
          '<td style="text-align:right">$ ' +
          fmtMoney(it.unitPrice) +
          "</td>" +
          '<td style="text-align:right">' +
          (function () {
            var dto = SUPER_ITEM_DISCOUNT[state.superKey] || 0;
            if (dto <= 0 || dto >= 1) return "—";
            var preDto = it.unitPrice / (1 - dto);
            return "$ " + fmtMoney(preDto);
          })() +
          "</td>" +
          '<td style="text-align:right">$ ' +
          fmtMoney(it.listPrice) +
          srcBadge +
          '</td><td><span class="scot-pill ' +
          pillCls +
          '">' +
          pillTxt +
          "</span></td>" +
          '<td style="text-align:right">$ ' +
          fmtMoney(subtotal) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");

    var total = 0;
    var totalCajas = 0;
    state.items.forEach(function (it) {
      if (!it.included || !it.found) return;
      total += it.unitPrice * (it.cajas || 0) * (it.uxb || 0);
      totalCajas += it.cajas || 0;
    });

    card.innerHTML =
      (missCount
        ? '<p class="scot-hint" style="color:var(--danger,#c0392b);margin:0 0 8px">⚠ ' +
          missCount +
          " ítem(s) sin match en LK — quedan excluidos del pedido.</p>"
        : "") +
      '<div class="scot-table-wrap">' +
      '<table class="scot-table">' +
      '<thead><tr><th></th><th>Cód LK</th><th>Cajas</th><th style="text-align:right">UxB</th><th style="text-align:right">Precio PDF</th><th style="text-align:right">Precio pre dto</th><th style="text-align:right">Lista LK</th><th>Δ</th><th style="text-align:right">Subtotal</th></tr></thead>' +
      "<tbody>" +
      rows +
      "</tbody></table></div>" +
      '<div class="scot-totals">' +
      '<div><span class="lab">Cajas: </span><span class="val">' +
      totalCajas +
      "</span></div>" +
      '<div><span class="lab">Subtotal sección: </span><span class="val">$ ' +
      fmtMoney(total) +
      "</span></div>" +
      "</div>";

    card.querySelectorAll(".scot-incl-chk").forEach(function (chk) {
      chk.addEventListener("change", function () {
        var tr = chk.closest("tr");
        var idx = Number(tr.dataset.idx);
        state.items[idx].included = chk.checked;
        renderItemsCard(card);
        refreshTotalDisplay();
      });
    });
    card.querySelectorAll(".scot-cajas-input").forEach(function (inp) {
      inp.addEventListener("change", function () {
        var tr = inp.closest("tr");
        var idx = Number(tr.dataset.idx);
        var v = parseInt(inp.value);
        state.items[idx].cajas = v > 0 ? v : 0;
        renderItemsCard(card);
        refreshTotalDisplay();
      });
    });
  }

  // ============================================================================
  // EXPORT EXCEL
  // ============================================================================
  function exportToExcel() {
    if (!state.items.length) {
      window.toast && window.toast("No hay ítems para exportar", "warning");
      return;
    }
    if (!window.XLSX) {
      window.toast && window.toast("XLSX no disponible", "error");
      return;
    }
    var sucursalLabel =
      (state.deliveryAddress && state.deliveryAddress.label) ||
      ((state.branchId || "") +
        (state.branchName ? " - " + state.branchName : ""));
    var customerLabel = state.customer
      ? state.customer.cod_cliente + " - " + (state.customer.business_name || "")
      : "(sin cliente)";

    var addLSuffix =
      state.superKey === "cencosud" || state.superKey === "dorinka";

    // Calcular totales
    var totalCajas = 0;
    var totalUnidades = 0;
    var totalGeneral = 0;
    var validRows = [];
    state.items.forEach(function (it) {
      if (!it.included || !it.found) return;
      var unidades = (it.cajas || 0) * (it.uxb || 0);
      var subtotal = it.unitPrice * unidades;
      totalCajas += it.cajas || 0;
      totalUnidades += unidades;
      totalGeneral += subtotal;
      validRows.push({
        cod: addLSuffix ? it.codLk + "L" : it.codLk,
        desc: it.description || "",
        uxb: it.uxb || 0,
        cajas: it.cajas || 0,
        unidades: unidades,
        unitPrice: Number((it.unitPrice || 0).toFixed(2)),
        subtotal: Number(subtotal.toFixed(2)),
      });
    });

    // Fecha de hoy formateada
    var hoy = new Date();
    var fechaStr =
      String(hoy.getDate()).padStart(2, "0") +
      "/" +
      String(hoy.getMonth() + 1).padStart(2, "0") +
      "/" +
      hoy.getFullYear();

    // ----- Construir AOA estructurado -----
    var aoa = [];
    aoa.push(["PEDIDO " + (state.superLabel || "").toUpperCase()]); // Row 1: titulo
    aoa.push([]); // Row 2: gap
    aoa.push(["Cliente", customerLabel]); // Row 3
    aoa.push(["Cadena", state.superLabel]); // Row 4
    aoa.push(["Nro OC (PDF)", state.orderNumber || "—"]); // Row 5
    aoa.push(["Sucursal", sucursalLabel || "—"]); // Row 6
    aoa.push(["Cond. Pago", state.paymentTermEdited || "—"]); // Row 7
    aoa.push(["Fecha", fechaStr]); // Row 8
    aoa.push([]); // Row 9: gap
    aoa.push([
      "Cód LK",
      "Descripción",
      "UxB",
      "Cajas",
      "Unidades",
      "Precio unit.",
      "Subtotal",
    ]); // Row 10: header tabla
    var firstItemRow = aoa.length + 1; // 1-indexed → 11
    validRows.forEach(function (r) {
      aoa.push([r.cod, r.desc, r.uxb, r.cajas, r.unidades, r.unitPrice, r.subtotal]);
    });
    var lastItemRow = aoa.length; // 1-indexed
    aoa.push([]); // gap
    aoa.push(["", "", "", totalCajas, totalUnidades, "TOTAL", Number(totalGeneral.toFixed(2))]); // total row

    var ws = window.XLSX.utils.aoa_to_sheet(aoa);

    // ----- Anchos de columna -----
    ws["!cols"] = [
      { wch: 12 }, // Cód
      { wch: 50 }, // Desc
      { wch: 7 },  // UxB
      { wch: 8 },  // Cajas
      { wch: 11 }, // Unidades
      { wch: 14 }, // Precio unit
      { wch: 16 }, // Subtotal
    ];

    // ----- Merges -----
    ws["!merges"] = [
      // Titulo top: A1:G1
      { s: { r: 0, c: 0 }, e: { r: 0, c: 6 } },
      // Cliente: B3:G3
      { s: { r: 2, c: 1 }, e: { r: 2, c: 6 } },
      // Cadena: B4:G4
      { s: { r: 3, c: 1 }, e: { r: 3, c: 6 } },
      // Nro OC: B5:G5
      { s: { r: 4, c: 1 }, e: { r: 4, c: 6 } },
      // Sucursal: B6:G6
      { s: { r: 5, c: 1 }, e: { r: 5, c: 6 } },
      // Cond. Pago: B7:G7
      { s: { r: 6, c: 1 }, e: { r: 6, c: 6 } },
      // Fecha: B8:G8
      { s: { r: 7, c: 1 }, e: { r: 7, c: 6 } },
    ];

    // ----- Number format en columnas de precio/subtotal -----
    var moneyFmt = '"$"#,##0.00';
    for (var ri = firstItemRow - 1; ri < lastItemRow; ri++) {
      // Columna F (5): Precio unit
      var fAddr = window.XLSX.utils.encode_cell({ r: ri, c: 5 });
      if (ws[fAddr]) ws[fAddr].z = moneyFmt;
      // Columna G (6): Subtotal
      var gAddr = window.XLSX.utils.encode_cell({ r: ri, c: 6 });
      if (ws[gAddr]) ws[gAddr].z = moneyFmt;
    }
    // Total row (last row): col 6 = total general
    var totalAddr = window.XLSX.utils.encode_cell({ r: aoa.length - 1, c: 6 });
    if (ws[totalAddr]) ws[totalAddr].z = moneyFmt;

    var wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Pedido");
    var fname =
      "pedido_" +
      state.superKey +
      "_" +
      (state.branchId || "sin_suc") +
      "_" +
      (state.orderNumber || "sin_nro") +
      ".xlsx";
    window.XLSX.writeFile(wb, fname);
    window.toast && window.toast("Excel exportado: " + fname, "success");
  }

  // ============================================================================
  // SUBMIT
  // ============================================================================
  async function submitOrder() {
    if (state.submitting) return;
    // CH: solo supers de Chef (Cencosud/Dorinka). Defensa extra ante colision
    // de cod_cliente con clientes Chef distintos.
    if (!isChefSuper(state.superKey)) {
      window.toast && window.toast(
        "Este super se carga desde el admin de LK, no en Chef.", "error");
      return;
    }
    if (!state.customer) {
      window.toast && window.toast("Falta cliente Chef para este super", "warning");
      return;
    }
    var validItems = state.items.filter(function (it) {
      return it.included && it.found && (it.cajas || 0) > 0;
    });
    if (!validItems.length) {
      window.toast && window.toast("No hay ítems válidos para subir", "warning");
      return;
    }
    var missing = state.items.filter(function (it) {
      return it.included && !it.found;
    });
    if (missing.length) {
      var ok = window.confirm(
        missing.length +
          " ítem(s) marcado(s) sin match en LK no se enviarán. ¿Continuar?",
      );
      if (!ok) return;
    }

    // Confirm si hay diferencia REAL (en total considerando dto conocido) O items con dif de precio
    if (state.pdfTotal != null) {
      var calcTotal = computeOrderTotals().total;
      var ratio = SUPER_PDF_RATIO[state.superKey] || 1;
      var expectedPdf = calcTotal / ratio;
      var totalDiff = Math.abs(expectedPdf - state.pdfTotal) / Math.max(state.pdfTotal, 1);
      var mismatchedItems = state.items.filter(function (it) {
        if (!it.included || !it.found) return false;
        var p = itemPriceDiff(it, state.superKey);
        return p != null && p > 0.01;
      });
      if (totalDiff > 0.01 || mismatchedItems.length > 0) {
        var msg = "⚠ Hay diferencias en el pedido:\n\n";
        if (totalDiff > 0.01) {
          msg +=
            "TOTAL\n" +
            "  Calculado: $ " + fmtMoney(calcTotal) + "\n" +
            (ratio !== 1
              ? "  Esperado en PDF (con dto " + ((1 - 1 / ratio) * 100).toFixed(1) + "%): $ " + fmtMoney(expectedPdf) + "\n"
              : "") +
            "  PDF:       $ " + fmtMoney(state.pdfTotal) + "\n" +
            "  Diferencia: " + (totalDiff * 100).toFixed(1) + "%\n\n";
        }
        if (mismatchedItems.length > 0) {
          msg += "ITEMS CON DIFERENCIA DE PRECIO (" + mismatchedItems.length + "):\n";
          mismatchedItems.slice(0, 10).forEach(function (it) {
            var p = ((it.unitPrice - it.listPrice) / it.listPrice * 100).toFixed(1);
            msg +=
              "  " + it.codLk + ": PDF $ " + fmtMoney(it.unitPrice) +
              " vs Lista $ " + fmtMoney(it.listPrice) +
              " (Δ " + p + "%)\n";
          });
          if (mismatchedItems.length > 10) msg += "  ... y " + (mismatchedItems.length - 10) + " más\n";
          msg += "\n";
        }
        msg += "¿Confirmás subir el pedido igual?";
        var okDiff = window.confirm(msg);
        if (!okDiff) return;
      }
    }

    state.submitting = true;
    var btn = $mount && $mount.querySelector("#scotSubmitBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Subiendo...";
    }

    try {
      var isChef = isChefSuper(state.superKey);
      var addLSuffix = isChef;
      // Mapeo de códigos especiales por supermercado.
      // Coto: artículo 505 se envía como 505I a la sheet Pedidos Web (y PPP),
      // NO afecta a la web ni a otros supermercados — solo Coto en PDF Krikos.
      var SUPER_COD_MAP = {
        coto: { "505": "505I" },
      };
      function outCod(cod) {
        var s = String(cod);
        var supMap = SUPER_COD_MAP[state.superKey];
        if (supMap && supMap[s]) s = supMap[s];
        return addLSuffix ? s + "L" : s;
      }

      // Cliente Supabase + token segun super.
      // - dbClient: para llamar la RPC submit_order_fast. Chef supers van a Chef DB.
      // - sheets-proxy: SIEMPRE va a la edge function de LK porque ahi vive el
      //   Google Sheet "Pedidos Web". Para Chef se manda flag is_chef + target_sheet
      //   asi la edge function escribe en la hoja "Pedidos CH" en vez de la default.
      var dbClient, authUserId, authToken, proxyUrl, entregasUrl, apiKey;
      // Sesion LK (necesaria para sheets-proxy)
      var sessRes = await window.sb.auth.getSession();
      var session = sessRes.data && sessRes.data.session;
      if (!session) throw new Error("Sesión inválida");
      authToken = session.access_token;
      apiKey = window.SUPABASE_ANON_KEY || "";
      // CONTEXTO CH: todo va a Chef con la sesion del admin logueado. window.sb
      // ES Chef autenticado → pedido con dueño (uid admin) → RLS nativa OK.
      // sheets-proxy: el de Chef (mismo Apps Script, rutea a "Pedidos CH").
      proxyUrl = CHEF_SHEETS_PROXY_URL;
      entregasUrl = CHEF_SHEETS_ENTREGAS_URL;
      dbClient = window.sb;
      authUserId = session.user.id;

      var subtotal = 0;
      var rpcItems = validItems.map(function (it) {
        var line = it.unitPrice * (it.cajas || 0) * (it.uxb || 0);
        subtotal += line;
        return {
          product_id: it.product.id,
          cajas: it.cajas,
          uxb: it.uxb,
          is_loke: !!it.isLoke,
          // Para Chef RPC (que tiene columnas extra en order_items)
          unit_list_price: Number(it.listPrice || it.unitPrice || 0),
          unit_your_price: Number(it.unitPrice || 0),
          line_total: line,
        };
      });
      var total = subtotal;
      var paymentMethodText =
        state.paymentTermEdited || state.paymentTermRaw || "Sin especificar";

      // CH: TODOS los supers matchean contra Chef.products → sus product_id son
      // FK válidas en Chef.order_items. Se mandan los items reales (incluido
      // Cencosud, que antes iba header-only porque matcheaba LK).
      var rpcItemsForChef = rpcItems;

      // Direccion + sheetsPayload. order_number se completa con el id real
      // despues de crear el pedido.
      // Si hay direccion mapeada usarla; si no, fallback al texto crudo del PDF
      var deliveryDireccion =
        (state.deliveryAddress && state.deliveryAddress.direccion_entrega) ||
        ((state.branchId || "") +
          (state.branchName ? " - " + state.branchName : ""));
      var deliveryZona =
        (state.deliveryAddress && state.deliveryAddress.zona_expreso) || "";
      var sucursalEntrega =
        state.deliveryAddress && state.deliveryAddress.label
          ? state.deliveryAddress.label
          : (state.branchId || "") +
            (state.branchName ? " - " + state.branchName : "") +
            " [" +
            state.superLabel +
            "]";

      var sheetsPayload = {
        order_number: "",
        pdf_oc: String(state.orderNumber || ""),
        cod_cliente: String(state.customer.cod_cliente || ""),
        vend: String(state.customer.vend || ""),
        condicion_pago: paymentMethodText,
        condicion_pago_code: SUPER_PAYMENT_CODE[state.superKey] || 0,
        sucursal_entrega: sucursalEntrega,
        cliente_nuevo: "",
        is_promo: false,
        is_chef: isChef,
        target_sheet: isChef ? "Pedidos CH" : "Pedidos Web",
        empresa: isChef ? "CH" : "LK",
        extra_discount: 0,
        deuda: Number(state.customer.debt || 0),
        payment_term: state.customer.payment_term == null ? null : Number(state.customer.payment_term),
        credit_limit: state.customer.credit_limit == null ? null : Number(state.customer.credit_limit),
        due_date: String(state.dueDate || ""),
        source: "Krikos",
        items: validItems.map(function (it) {
          return {
            cod_art: outCod(it.codLk),
            cajas: it.cajas,
            uxb: it.uxb,
          };
        }),
      };

      // CH: submit NATIVO a Chef con la sesion del admin logueado
      // (dbClient=window.sb, authUserId=uid admin). El pedido queda con dueño
      // → la RPC submit_order_fast pasa el gate de admin y el pedido entra a
      // Chef.orders con id real. Cencosud manda p_items=[] (matchea LK, evita
      // FK en Chef.order_items); Dorinka manda items Chef validos.
      var orderId;
      var rpcResult = await dbClient.rpc("submit_order_fast", {
        p_auth_user_id: authUserId,
        p_customer_id: state.customer.id,
        p_status: "pendiente",
        p_payment_method: paymentMethodText,
        p_payment_discount: 0,
        p_web_discount: 0,
        p_subtotal: subtotal,
        p_total: total,
        p_items: rpcItemsForChef,
      });
      if (rpcResult.error || !rpcResult.data) {
        throw new Error(
          (rpcResult.error &&
            (rpcResult.error.message || rpcResult.error.details)) ||
            "RPC submit_order_fast falló",
        );
      }
      orderId = rpcResult.data;

      // Completar order_number ahora que tenemos el id real.
      sheetsPayload.order_number = String(orderId);

      // Persistir sheets_payload en la order. En CH corre via window.sb (admin
      // autenticado, dueño de la order) → RLS orders_update_own_sheets OK. El
      // mail de compras (procesar-pedidos-db) filtra sheets_payload NOT NULL.
      // Chef.orders NO tiene placed_by_auth_user_id → no se manda.
      dbClient
        .from("orders")
        .update({ sheets_payload: sheetsPayload, is_promo: false, extra_discount: 0 })
        .eq("id", orderId)
        .then(function () {});

      sendToSheetsWithRetry(sheetsPayload, authToken, 3, proxyUrl, apiKey)
        .then(function () {
          dbClient
            .from("orders")
            .update({ sheets_sent: true })
            .eq("id", orderId)
            .then(function () {});
        })
        .catch(function (e) {
          console.warn("scot sheets error (order " + orderId + "):", e);
        });

      var entregasPayload = {
        order_number: orderId,
        fecha: new Date().toLocaleDateString("es-AR"),
        cod_cliente: state.customer.cod_cliente,
        cliente: state.customer.business_name,
        vendedor: state.customer.vend || "",
        direccion_entrega: deliveryDireccion,
        barrio_entrega: deliveryZona,
        empresa: isChef ? "CH" : "LK",
        is_promo: false,
        extra_discount: 0,
        items: validItems.map(function (it) {
          return {
            cod_art: outCod(it.codLk),
            description: it.description || "",
            cajas: it.cajas,
            uxb: it.uxb,
          };
        }),
      };
      sendToEntregas(entregasPayload, authToken, entregasUrl, apiKey);

      window.toast && window.toast("Pedido " + orderId + " subido", "success");
      if (btn) {
        btn.disabled = true;
        btn.classList.add("submitted");
        btn.title = "Pedido " + orderId + " subido";
      }
    } catch (e) {
      console.error("scot submit error:", e);
      window.toast && window.toast("Error: " + (e.message || e), "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Subir como pedido";
      }
      state.submitting = false;
    }
  }

  // ----- helpers sheets -----
  function withTimeout(promise, ms, label) {
    var t;
    var timeout = new Promise(function (_, reject) {
      t = setTimeout(function () {
        reject(new Error("Timeout (" + ms + "ms) " + label));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () {
      clearTimeout(t);
    });
  }

  async function sendToSheets(payload, token, proxyUrl, apiKey) {
    var resp = await fetch(proxyUrl || SHEETS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: apiKey || window.SUPABASE_ANON_KEY || "",
      },
      body: JSON.stringify(payload),
    });
    var data = await resp.json().catch(function () {
      return {};
    });
    if (!resp.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || "Proxy error " + resp.status);
    }
    return { ok: true };
  }

  async function sendToSheetsWithRetry(payload, token, maxAttempts, proxyUrl, apiKey) {
    maxAttempts = maxAttempts || 3;
    var lastError = null;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await withTimeout(
          sendToSheets(payload, token, proxyUrl, apiKey),
          25000,
          "sheets-proxy " + attempt,
        );
      } catch (e) {
        lastError = e;
        console.warn("scot sheets intento " + attempt + " fallo:", e);
        if (attempt < maxAttempts)
          await new Promise(function (r) {
            setTimeout(r, 1200);
          });
      }
    }
    throw lastError || new Error("Fallo envio a Sheets");
  }

  async function sendToEntregas(payload, token, entregasUrl, apiKey) {
    try {
      var resp = await fetch(entregasUrl || SHEETS_ENTREGAS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          apikey: apiKey || window.SUPABASE_ANON_KEY || "",
        },
        body: JSON.stringify(payload),
      });
      var data = await resp.json().catch(function () {
        return {};
      });
      if (!resp.ok || (data && data.ok === false)) {
        console.warn("scot entregas error:", (data && data.error) || resp.status);
      }
    } catch (e) {
      console.warn("scot entregas exception:", e);
    }
  }

  // ============================================================================
  // RESET
  // ============================================================================
  function resetState() {
    state.superKey = null;
    state.superLabel = null;
    state.rawText = "";
    state.items = [];
    state.orderNumber = "";
    state.branchId = "";
    state.branchName = "";
    state.paymentTermRaw = "";
    state.paymentTermEdited = "";
    state.customer = null;
    state.mappingExisted = false;
    state.deliveryAddress = null;
    state.pdfTotal = null;
    state.fileHash = null;
    state.submitting = false;
  }

    // Render inicial al crear la instancia
    renderInitial();
    return {
      idx: idx,
      reset: resetState,
      render: renderInitial,
      getState: function () { return state; },
      handleFile: handleFile,
    };
  }

  // Distribuir varios PDFs entre cards vacias. Empieza por la card del drop
  // (originIdx) y sigue con las demas vacias en orden.
  function distributeFilesToCards(originIdx, files) {
    if (!files || !files.length) return;
    var queue = files.slice();
    // 1. La card de origen recibe el primer archivo (aunque no este vacia? Mejor solo si esta vacia)
    var origin = cardInstances[originIdx];
    if (origin && (!origin.getState().superKey)) {
      var f = queue.shift();
      if (f) origin.handleFile(f);
    }
    // 2. Distribuir el resto a cards vacias
    for (var i = 0; i < cardInstances.length && queue.length; i++) {
      if (i === originIdx) continue;
      var s = cardInstances[i].getState();
      if (!s.superKey) {
        cardInstances[i].handleFile(queue.shift());
      }
    }
    if (queue.length) {
      window.alert(
        queue.length +
          " PDF(s) no se cargaron — todas las cards están ocupadas. Liberá cards (icono tacho) y reintentá.",
      );
    }
  }
  // ============================================================================
  // FIN CARD FACTORY
  // ============================================================================

  // ============================================================================
  // INIT
  // ============================================================================
  function init() {
    var section = document.getElementById("cotizadores-super");
    if (!section) return;
    var mount = document.getElementById("superCotMount");
    if (!mount) return;
    if (!window.pdfjsLib) {
      mount.innerHTML =
        '<div class="scot-card"><p style="color:var(--danger,#c0392b);font-size:13px">pdf.js no cargó. Recargá la página.</p></div>';
      return;
    }
    if (!window.sb) {
      mount.innerHTML =
        '<div class="scot-card"><p style="font-size:13px;color:var(--text3,#888)">Esperando inicialización del panel...</p></div>';
      return;
    }
    injectCSS();
    // Toolbar (actualizar lista de precios) + grid de cards
    mount.innerHTML =
      '<div class="scot-toolbar" style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
        '<button type="button" id="scotUpdPricesBtn" style="padding:7px 12px;border:1px solid var(--border,#d0d0d0);border-radius:8px;background:var(--surface,#fff);cursor:pointer;font-size:13px">⬆ Actualizar lista de precios (xlsx)</button>' +
        '<input type="file" id="scotUpdPricesFile" accept=".xlsx,.xls" style="display:none" />' +
        '<span id="scotUpdPricesMsg" style="font-size:12px;color:var(--text3,#888)"></span>' +
      '</div>' +
      '<div class="scot-grid" id="scotGrid"></div>';
    var grid = mount.querySelector("#scotGrid");
    // Wire "Actualizar lista de precios"
    (function () {
      var btn = mount.querySelector("#scotUpdPricesBtn");
      var fileEl = mount.querySelector("#scotUpdPricesFile");
      var msgEl = mount.querySelector("#scotUpdPricesMsg");
      function setMsg(t, kind) {
        if (!msgEl) return;
        msgEl.textContent = t;
        msgEl.style.color = kind === "err" ? "#c0392b" : kind === "ok" ? "#1e8e3e" : "var(--text3,#888)";
      }
      if (btn && fileEl) {
        btn.addEventListener("click", function () { fileEl.click(); });
        fileEl.addEventListener("change", function () {
          var f = fileEl.files && fileEl.files[0];
          fileEl.value = "";
          if (f) updateSuperPricesFromFile(f, setMsg);
        });
      }
    })();
    cardInstances = [];
    for (var i = 0; i < CARD_COUNT; i++) {
      var cardRoot = document.createElement("div");
      cardRoot.className = "scot-card-instance";
      cardRoot.dataset.idx = i;
      grid.appendChild(cardRoot);
      cardInstances.push(createCardInstance(i, cardRoot));
    }
    // Pre-cargar precios super en background
    loadSuperPrices();
  }

  function bootstrap() {
    setTimeout(init, 200);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }

  // API publica para reuso desde admin-excel-krikos.js (mismo pipeline de match
  // de productos LK + Loke, pero con input desde Excel arbitrario en vez de PDF).
  window.scotApi = {
    loadAllProducts: loadAllProducts,
    loadAllLokeProducts: loadAllLokeProducts,
    codVariants: codVariants,
    findInPool: findInPool,
    parseNum: parseNum,
    // Lookup directo por cod en LK products + loke_products (sin chef).
    findProductByCodLK: function (cod) {
      var variants = codVariants(cod);
      if (!variants.length) return null;
      var p = findInPool(allProductsCache || [], variants);
      if (p) return { product: p, isLoke: false };
      var lp = findInPool(allLokeProductsCache || [], variants);
      if (lp) return { product: lp, isLoke: true };
      return null;
    },
    getProductsCache: function () { return allProductsCache || []; },
    getLokeProductsCache: function () { return allLokeProductsCache || []; },
  };
})();
