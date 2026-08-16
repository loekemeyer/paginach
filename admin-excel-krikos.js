// ============================================================================
// admin-excel-krikos.js — Modulo "Excel Krikos"
//
// Misma logica que admin-supercot.js (PDF Krikos) pero leyendo orden de compra
// directamente desde Excel (.xlsx o .xls), para clientes mayoristas / cadenas
// que no estan cubiertas por los parsers PDF.
//
// Estrategia de match:
//   1) Si hay columna EAN clara (header /ean/i, valores 13 digitos) →
//      codLk = EAN[9..12] (igual que PDFs Krikos).
//   2) Si no, intenta match por:
//      a) cualquier columna numerica/codigo del row (COD ART, ARTICULO, ENVASE,
//         SKU, REF, CODIGO ZEUS, etc.) probando todas las variantes
//         (codVariants) contra products LK + loke_products.
//      b) fallback: match por descripcion fuzzy si no hay ningun cod que pegue.
//
// Multi-sucursal: si el archivo tiene varias columnas de cantidades por
// sucursal (ej Megamix), aparece un selector de sucursal arriba de cada card
// y se usa esa columna como qty del pedido.
//
// Submit: misma RPC submit_order_fast + sheets-proxy + sheets-entregas-proxy
// que el modulo PDF, pero contra el cliente seleccionado (no hay cliente
// fijo por cadena).
// ============================================================================

(function () {
  "use strict";

  // ----- CSS propio (prefijo xkr-) -----
  var XKR_CSS = [
    "#excel-krikos.page{max-width:none;padding:24px}",
    "#excelKrikosMount{width:100%}",
    ".xkr-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}",
    "@media(max-width:1100px){.xkr-grid{grid-template-columns:1fr}}",
    ".xkr-card-instance{display:flex;flex-direction:column;min-width:0}",
    ".xkr-card{background:var(--bg1,#fff);border:1px solid var(--border,#e5e5e5);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:12px;flex:1}",
    ".xkr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
    ".xkr-section-title{font-size:12px;font-weight:700;color:var(--text3,#888);text-transform:uppercase;letter-spacing:.5px;margin:0}",
    ".xkr-cust-search{display:flex;gap:8px;position:relative}",
    ".xkr-cust-input{flex:1;padding:8px 10px;border:1px solid var(--border,#ddd);border-radius:6px;font-family:inherit;font-size:13px}",
    ".xkr-suggest{position:absolute;top:100%;left:0;right:0;background:#fff;border:1px solid var(--border,#ddd);border-top:none;border-radius:0 0 6px 6px;box-shadow:0 4px 14px rgba(0,0,0,.08);z-index:10;max-height:240px;overflow-y:auto;display:none}",
    ".xkr-suggest-row{padding:8px 10px;cursor:pointer;font-size:13px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border,#f0f0f0)}",
    ".xkr-suggest-row:hover{background:var(--bg2,#fafafa)}",
    ".xkr-suggest-cod{font-weight:700;color:var(--accent,#e67e22);min-width:50px;font-size:12px}",
    ".xkr-suggest-empty{padding:10px;color:var(--text3,#888);font-size:12px;text-align:center}",
    ".xkr-cust-current{padding:10px;background:#e8f4fd;border:1px solid #9bc8e6;border-radius:8px;font-size:13px;color:#1f4c6e;display:flex;align-items:center;justify-content:space-between;gap:10px}",
    ".xkr-cust-current button{font-size:11px;padding:4px 10px;border:1px solid #1f4c6e;background:transparent;color:#1f4c6e;border-radius:4px;cursor:pointer}",
    ".xkr-drop{border:2px dashed var(--border,#cfcfcf);border-radius:10px;padding:18px;text-align:center;cursor:pointer;transition:all .15s}",
    ".xkr-drop:hover,.xkr-drop.xkr-drag{border-color:var(--accent,#e67e22);background:var(--bg2,#fafafa)}",
    ".xkr-drop-title{font-weight:600;margin:6px 0 2px;color:var(--text2,#222);font-size:13px}",
    ".xkr-drop-sub{font-size:11px;color:var(--text3,#888)}",
    ".xkr-status{font-size:12px;color:var(--text3,#888)}",
    ".xkr-status.ok{color:#2a8a3e}.xkr-status.err{color:var(--danger,#c0392b)}.xkr-status.warn{color:#b8780f}",
    ".xkr-spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--accent,#e67e22);border-top-color:transparent;border-radius:50%;animation:xkr-spin .8s linear infinite;vertical-align:middle;margin-right:4px}",
    "@keyframes xkr-spin{to{transform:rotate(360deg)}}",
    ".xkr-meta{display:flex;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--text2,#222)}",
    ".xkr-meta-pill{background:var(--bg2,#fafafa);border:1px solid var(--border,#eee);border-radius:6px;padding:4px 10px}",
    ".xkr-meta-pill .lbl{color:var(--text3,#888);font-weight:600;text-transform:uppercase;font-size:9px;letter-spacing:.4px;margin-right:4px}",
    ".xkr-branch-row{display:flex;gap:8px;align-items:center;font-size:13px}",
    ".xkr-branch-row select{padding:6px 8px;border:1px solid var(--border,#ddd);border-radius:6px;font-family:inherit;font-size:13px;flex:1}",
    ".xkr-table-wrap{overflow-x:auto;border:1px solid var(--border,#eee);border-radius:8px;max-height:380px;overflow-y:auto}",
    ".xkr-table{width:100%;border-collapse:collapse;font-size:12px}",
    ".xkr-table th{position:sticky;top:0;background:var(--bg2,#fafafa);padding:7px 6px;text-align:left;border-bottom:1px solid var(--border,#eee);font-weight:600;color:var(--text3,#666);font-size:11px;text-transform:uppercase;letter-spacing:.3px;z-index:1}",
    ".xkr-table td{padding:5px 6px;border-bottom:1px solid var(--border,#f0f0f0);vertical-align:middle}",
    ".xkr-table tr.xkr-row-bad td{background:#fff0ee}",
    ".xkr-table tr.xkr-row-warn td{background:#fffbe6}",
    ".xkr-table tr.xkr-row-excluded td{opacity:.45}",
    ".xkr-table input.xkr-cajas-input{width:60px;padding:3px 5px;border:1px solid var(--border,#ddd);border-radius:4px;font-size:12px;text-align:right;font-family:inherit}",
    ".xkr-pill{display:inline-block;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:600}",
    ".xkr-pill.ok{background:#dff5e3;color:#1e7a31}",
    ".xkr-pill.warn{background:#fff5d4;color:#b8780f}",
    ".xkr-pill.bad{background:#ffd9d4;color:#c0392b}",
    ".xkr-pill.miss{background:#eee;color:#666}",
    ".xkr-totals{display:flex;justify-content:flex-end;gap:18px;padding:10px 0 0;font-size:13px;flex-wrap:wrap}",
    ".xkr-totals .lab{color:var(--text3,#888)}",
    ".xkr-totals .val{font-weight:700;color:var(--text2,#222)}",
    ".xkr-actions{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid var(--border,#eee);padding-top:10px}",
    ".xkr-btn{font-size:12px;padding:7px 14px;border-radius:6px;border:1px solid var(--border,#ddd);background:#fff;cursor:pointer;color:var(--text2,#222);font-family:inherit}",
    ".xkr-btn:hover{background:var(--bg2,#fafafa)}",
    ".xkr-btn.primary{background:#22a861;color:#fff;border-color:#22a861}",
    ".xkr-btn.primary:hover{background:#1d8d51;border-color:#1d8d51}",
    ".xkr-btn.danger{background:transparent;color:#c0392b;border-color:#e6a39b}",
    ".xkr-btn.danger:hover{background:#fde2de;color:#c0392b}",
    ".xkr-btn:disabled{opacity:.5;cursor:not-allowed}",
    ".xkr-error-box{background:#fde2de;border:1px solid #e6a39b;color:#c0392b;border-radius:6px;padding:8px 10px;font-size:12px}",
    ".xkr-warn-box{background:#fff5d4;border:1px solid #e6c668;color:#b8780f;border-radius:6px;padding:8px 10px;font-size:12px}",
  ].join("\n");

  function injectCSS() {
    if (document.getElementById("xkr-styles")) return;
    var s = document.createElement("style");
    s.id = "xkr-styles";
    s.textContent = XKR_CSS;
    document.head.appendChild(s);
  }

  // ----- Constantes -----
  // CONTEXTO CH: el pedido va a Chef (window.sb autenticado), así que el push
  // al sheet usa el proxy de Chef (rutea a "Pedidos CH").
  var SHEETS_PROXY_URL =
    "https://nkhzocgdpwtgrmwleihr.functions.supabase.co/sheets-proxy";
  var SHEETS_ENTREGAS_URL =
    "https://nkhzocgdpwtgrmwleihr.functions.supabase.co/sheets-entregas-proxy";

  var CARD_COUNT = 4;
  var cardInstances = [];

  // ============================================================================
  // BRANCH → CUSTOMER MAPPING
  // ============================================================================
  // Algunos clientes mayoristas mandan UN solo Excel multi-sucursal donde cada
  // columna de sucursal es facturada a una razón social distinta dentro del
  // mismo grupo (ej grupo Bazar y Cía / Multi Bazar). El .doc "Datos de
  // facturación y transporte" es el maestro humano; acá lo replicamos para que
  // al elegir la sucursal se auto-resuelva el cliente (CUIT) y la dirección
  // de entrega.
  //
  // Cada entrada: match (regex sobre header de la columna), cuit (solo dígitos
  // — se usa como lookup contra customers.cuit), label (razón social para
  // mostrar), delivery (dirección de entrega para sucursal_entrega + entregas).
  var BRANCH_GROUPS = [
    {
      name: "Bazar y Cía / Multi Bazar",
      // Match liviano del nombre del cliente de cabecera del Excel — si aparece
      // "LOEKEMEYER" en B/D del header igual queda; lo que distingue al grupo
      // son las sucursales (BRC, MEGAMIX, etc.). Dejamos null y matcheamos
      // por sucursales unicamente.
      branches: [
        { match: /\b(san[\s.\-_]*mar(?:tin)?)\b/i, cuit: "30714207152", label: "Multi Bazar S.R.L", delivery: "Intendente Campos 1983, San Martín (1650)" },
        { match: /\brio[\s.\-_]*gall.*25.*mayo\b/i, cuit: "30714207152", label: "Multi Bazar S.R.L", delivery: "25 de Mayo 44, Río Gallegos" },
        { match: /\brio[\s.\-_]*gall.*(nestor|kirchner)\b/i, cuit: "30710587619", label: "Bazar y Cía S.A", delivery: "Av. Néstor Kirchner 1012, Río Gallegos" },
        { match: /\bbrc.*moreno\b/i, cuit: "30714207152", label: "Multi Bazar S.R.L", delivery: "Moreno 350 (8400), Bariloche, Río Negro" },
        { match: /\bbrc.*onelli\b/i, cuit: "30714207152", label: "Multi Bazar S.R.L", delivery: "Onelli 653 (8400), Bariloche, Río Negro" },
        { match: /\bmegamix\b/i, cuit: "30710587619", label: "Bazar y Cía S.A", delivery: "Jean Jaurès 245, CABA (1215)" },
        { match: /\b(m[\s.\-_]*paz|marcos[\s.\-_]*paz)\b/i, cuit: "30710587619", label: "Bazar y Cía S.A", delivery: "Marcos Paz" },
        { match: /\bzarate\b/i, cuit: "30714207152", label: "Multi Bazar S.R.L", delivery: "Zárate (entrega CABA Jean Jaurès 245)" },
        { match: /\b(korn|alejandro[\s.\-_]*korn)\b/i, cuit: "30710587619", label: "Bazar y Cía S.A", delivery: "Alejandro Korn" },
        { match: /\b(tesei|villa[\s.\-_]*tesei)\b/i, cuit: "30710587619", label: "Bazar y Cía S.A", delivery: "Av. Gobernador Vergara 2330, Villa Tesei" },
      ],
    },
  ];

  // Devuelve el mapping si el header de la sucursal matchea alguna entrada de
  // algún grupo. Devuelve { groupName, cuit, label, delivery } | null.
  function resolveBranchCustomer(headerText) {
    var h = String(headerText || "").trim();
    if (!h) return null;
    for (var g = 0; g < BRANCH_GROUPS.length; g++) {
      var grp = BRANCH_GROUPS[g];
      for (var i = 0; i < grp.branches.length; i++) {
        if (grp.branches[i].match.test(h)) {
          return {
            groupName: grp.name,
            cuit: grp.branches[i].cuit,
            label: grp.branches[i].label,
            delivery: grp.branches[i].delivery,
          };
        }
      }
    }
    return null;
  }

  // Lookup customer en DB por CUIT (solo dígitos).
  var _custByCuitCache = {};
  async function loadCustomerByCuit(cuit) {
    var key = String(cuit || "").replace(/[^\d]/g, "");
    if (!key) return null;
    if (_custByCuitCache[key] !== undefined) return _custByCuitCache[key];
    try {
      var r = await window.sb
        .from("customers")
        .select("id,cod_cliente,business_name,cuit,vend,debt,dto_vol,payment_term,credit_limit")
        .eq("cuit", key)
        .limit(1);
      if (r.error) {
        console.warn("xkr loadCustomerByCuit error:", r.error);
        _custByCuitCache[key] = null;
        return null;
      }
      var c = r.data && r.data[0] ? r.data[0] : null;
      _custByCuitCache[key] = c;
      return c;
    } catch (e) {
      console.warn("xkr loadCustomerByCuit exception:", e);
      _custByCuitCache[key] = null;
      return null;
    }
  }

  // ----- Helpers -----
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
  function normText(s) {
    return String(s == null ? "" : s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  // Tokenize description for fuzzy match (drop stopwords/short tokens)
  function descTokens(s) {
    var STOP = { de: 1, la: 1, el: 1, los: 1, las: 1, con: 1, sin: 1, para: 1, "y": 1, a: 1, "o": 1, "u": 1 };
    return normText(s)
      .split(" ")
      .filter(function (t) { return t && t.length >= 2 && !STOP[t]; });
  }
  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var setB = {};
    b.forEach(function (t) { setB[t] = 1; });
    var inter = 0;
    a.forEach(function (t) { if (setB[t]) inter++; });
    var uni = a.length + b.length - inter;
    return uni > 0 ? inter / uni : 0;
  }

  // ----- Excel parsing -----

  // Tokens conocidos para detectar columnas. Se busca por inclusion en el header
  // normalizado (sin acentos, lowercase).
  var COL_PATTERNS = {
    ean: [/\bean(?:13)?\b/, /codigo\s*de\s*barra/, /cod\s*ean/],
    code: [
      /\bcod\b/, /\bcodigo\b/, /\bcod\s*art/, /\bcod\s*articulo/,
      /\barticulo\b/, /\bart\b/, /\benvase\b/, /\bsku\b/, /\bref\b/,
      /\bcod\s*zeus\b/, /\bplu\b/, /\bcod\s*int\b/, /\bcod\s*producto/,
      /\bcod\s*loeke\b/, /\bcod\s*loke\b/,
    ],
    desc: [
      /\bdescripcion\b/, /\bdesc\b/, /\bproducto\b/, /\bdetalle\b/,
      /\bdenominacion\b/, /\bnombre\b/,
    ],
    uxb: [
      /\buxb\b/, /\bu\s*x\s*b\b/, /\bu\/b\b/, /\buxc\b/,
      /unidades?\s*x\s*bulto/, /unidades?\s*por\s*bulto/, /unid\s*caja/,
    ],
    qtyBoxes: [
      /\bbultos\b/, /\bcajas\b/, /\bbult\b/,
    ],
    qtyUnits: [
      /\bcantidad\b/, /\bcant\b/, /\bpedido\b/, /\bunidades\b/, /\bunid\b/,
      /\bqty\b/, /\bsolicitado\b/, /\borden\b/,
    ],
    priceFinal: [
      /\bprecio\s*final\b/, /\bp\.\s*final\b/, /\bp\s*final\b/,
      /\bprecio\s*unit/, /\bp\.\s*unit/, /\bcosto\s*unit/, /\bcosto\s*neto\b/,
      /\bunit\s*price\b/,
    ],
    price: [
      /\bcosto\b/, /\bprecio\b/, /\bp\.\s*lista\b/, /\bp\s*lista\b/,
    ],
  };

  // Headers a EXCLUIR de branchCols (cols numericas que no son sucursales:
  // bonificaciones, impuestos, totales, pendientes, etc.)
  var BRANCH_EXCLUDE = /\b(bonif|dto|descuento|imp\w*|iva|rec\w*|retorno|sub.?total|total|pendiente|stock|saldo)\b/i;

  function matchCol(headerNorm, patterns) {
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(headerNorm)) return true;
    }
    return false;
  }

  function classifyHeader(header) {
    var n = normText(header);
    if (!n) return null;
    if (matchCol(n, COL_PATTERNS.ean)) return "ean";
    // Prioridad: descripcion antes que codigo (ej "DESCRIPCION" tiene "desc")
    if (matchCol(n, COL_PATTERNS.desc)) return "desc";
    if (matchCol(n, COL_PATTERNS.uxb)) return "uxb";
    if (matchCol(n, COL_PATTERNS.qtyBoxes)) return "qtyBoxes";
    if (matchCol(n, COL_PATTERNS.qtyUnits)) return "qtyUnits";
    if (matchCol(n, COL_PATTERNS.priceFinal)) return "priceFinal";
    if (matchCol(n, COL_PATTERNS.price)) return "price";
    if (matchCol(n, COL_PATTERNS.code)) return "code";
    return null;
  }

  // Cuenta cuantas columnas en una fila estan clasificadas → eso indica que
  // probablemente es la fila de header.
  function scoreHeaderRow(row) {
    if (!row || !row.length) return 0;
    var classified = 0;
    var distinctRoles = {};
    for (var c = 0; c < row.length; c++) {
      var role = classifyHeader(row[c]);
      if (role) {
        classified++;
        distinctRoles[role] = 1;
      }
    }
    // Bonus si hay al menos desc + (qty | price | code)
    var hasDesc = !!distinctRoles.desc;
    var hasQty = !!(distinctRoles.qtyUnits || distinctRoles.qtyBoxes);
    var hasCode = !!(distinctRoles.code || distinctRoles.ean);
    var bonus = 0;
    if (hasDesc) bonus += 2;
    if (hasQty || hasCode) bonus += 2;
    return classified + bonus;
  }

  function findHeaderRow(aoa) {
    var bestIdx = -1;
    var bestScore = 0;
    var maxScan = Math.min(aoa.length, 50);
    for (var r = 0; r < maxScan; r++) {
      var sc = scoreHeaderRow(aoa[r]);
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = r;
      }
    }
    return bestScore >= 4 ? bestIdx : -1;
  }

  // Identifica columnas: roles fijos + columnas "branch" (sucursales).
  // Las branch cols son numericas, sin role asignado, a la derecha del price col,
  // con header NO vacio.
  function analyzeColumns(headerRow, dataRows) {
    var cols = headerRow.map(function (h, i) {
      return { idx: i, header: String(h == null ? "" : h).trim(), role: classifyHeader(h) };
    });
    var roles = {
      desc: null, uxb: null,
      qtyBoxes: null, qtyUnits: null,
      priceFinal: null, price: null,
    };
    var codeCols = [];
    var eanCols = [];
    cols.forEach(function (c) {
      if (c.role === "code") codeCols.push(c.idx);
      else if (c.role === "ean") eanCols.push(c.idx);
      else if (c.role && roles[c.role] == null) roles[c.role] = c.idx;
    });
    // priceCol: preferir priceFinal sobre price genérica
    var priceCol = roles.priceFinal != null ? roles.priceFinal : roles.price;
    var listPriceCol = roles.priceFinal != null && roles.price != null ? roles.price : null;

    // Branch cols: heuristica = headers no vacios despues del price, con datos
    // numericos y variabilidad real (no son columnas Bonif/Imp/Total que repiten valor).
    var afterPrice = priceCol != null ? priceCol : -1;
    var branchCols = [];
    cols.forEach(function (c) {
      if (c.role) return;
      if (codeCols.indexOf(c.idx) >= 0) return;
      if (!c.header) return;
      if (afterPrice >= 0 && c.idx <= afterPrice) return;
      // Excluir headers de bonif/imp/iva/total/etc
      if (BRANCH_EXCLUDE.test(c.header)) return;
      // Verificar contenido: numerico + con variabilidad (>=2 valores distintos)
      var numericCount = 0, total = 0;
      var distinctVals = {};
      var nonZero = 0;
      var sample = dataRows.slice(0, Math.min(dataRows.length, 50));
      sample.forEach(function (row) {
        var v = row[c.idx];
        if (v == null || v === "") return;
        total++;
        var nv;
        if (typeof v === "number") { numericCount++; nv = v; }
        else if (/^[\d.,\-]+$/.test(String(v).trim())) {
          numericCount++;
          nv = window.scotApi ? window.scotApi.parseNum(v) : parseFloat(String(v).replace(",", "."));
        }
        if (nv != null) {
          distinctVals[String(nv)] = 1;
          if (nv !== 0) nonZero++;
        }
      });
      if (total < 1) return;
      if (numericCount / total < 0.6) return;
      if (Object.keys(distinctVals).length < 2) return; // sin variabilidad → no es branch
      if (nonZero === 0) return;
      branchCols.push(c.idx);
    });

    return {
      eanCols: eanCols,
      descCol: roles.desc,
      uxbCol: roles.uxb,
      qtyBoxesCol: roles.qtyBoxes,
      qtyUnitsCol: roles.qtyUnits,
      priceCol: priceCol,
      listPriceCol: listPriceCol,
      codeCols: codeCols,
      branchCols: branchCols,
      headers: headerRow,
    };
  }

  // Lee Excel arbitrario. Devuelve { sheets: [{name, aoa, header, cols, dataRows}] }
  // header e cols solo se calculan para sheets con header detectado.
  function parseWorkbook(buf, fileName) {
    var isXls = /\.xls$/i.test(fileName);
    var wb = window.XLSX.read(buf, { type: "array", cellDates: true, cellText: false });
    var sheets = [];
    wb.SheetNames.forEach(function (sn) {
      var ws = wb.Sheets[sn];
      if (!ws) return;
      var aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
      // Strip leading completely empty rows (mantener indice original via map opcional)
      // No alteramos aoa para mantener semantica de header detection.
      if (!aoa.length) return;
      var headerIdx = findHeaderRow(aoa);
      if (headerIdx < 0) {
        sheets.push({ name: sn, aoa: aoa, headerIdx: -1 });
        return;
      }
      var headerRow = aoa[headerIdx];
      var dataRows = aoa.slice(headerIdx + 1);
      var cols = analyzeColumns(headerRow, dataRows);
      sheets.push({
        name: sn,
        aoa: aoa,
        headerIdx: headerIdx,
        headerRow: headerRow,
        dataRows: dataRows,
        cols: cols,
        isXls: isXls,
      });
    });
    return { sheets: sheets, rawWorkbook: wb };
  }

  function isJunkRow(row, cols) {
    if (!row) return true;
    // Junk si row totalmente vacia, o si CUALQUIER celda dice TOTAL/TOTALES,
    // o si no hay valor en ninguna codeCol/eanCol (sin codigo no hay match posible).
    var hasAny = false;
    for (var i = 0; i < row.length; i++) {
      var v = row[i];
      if (v == null) continue;
      var s = String(v).trim();
      if (s === "") continue;
      hasAny = true;
      var up = s.toUpperCase();
      if (up === "TOTAL" || up === "TOTALES" || up.indexOf("TOTAL ") === 0) return true;
    }
    if (!hasAny) return true;
    if (cols) {
      var idxs = (cols.codeCols || []).concat(cols.eanCols || []);
      if (idxs.length > 0) {
        var hasCodOrEan = false;
        for (var j = 0; j < idxs.length; j++) {
          var cv = row[idxs[j]];
          if (cv != null && String(cv).trim() !== "") { hasCodOrEan = true; break; }
        }
        if (!hasCodOrEan) return true;
      }
    }
    return false;
  }

  // EAN[9..12] = LK code (igual que parsers PDF Krikos)
  function eanToLkCod(ean) {
    var s = String(ean || "").replace(/[^\d]/g, "");
    if (s.length < 13) return null;
    // posicion 9..12 (1-indexed) = chars 8..11 (0-indexed) → substr(8, 4)
    var c = s.substr(8, 4);
    // Trim leading zeros pero mantener 3 digitos minimo (codVariants se ocupa
    // de las variantes con pad)
    return c.replace(/^0+/, "") || c;
  }

  // Para cada row, intenta encontrar producto LK matcheando:
  //   1) por EAN[9..12] (probando TODAS las cols EAN del row, no solo la primera)
  //   2) por cada code col + sus variantes (codVariants)
  //   3) por descripcion fuzzy (jaccard tokens >= 0.55)
  function matchRowToProduct(rowVals, cols) {
    if (!window.scotApi) return null;
    var lkPool = window.scotApi.getProductsCache() || [];
    var lokePool = window.scotApi.getLokeProductsCache() || [];
    var pools = [
      { pool: lkPool, isLoke: false },
      { pool: lokePool, isLoke: true },
    ];

    // 1) EAN — probar TODAS las columnas EAN del row (algunas Excels tienen
    //    3 cols EAN distintas y solo una tiene el EAN cuyas pos 9..12 dan el LK code).
    var eanRaws = (cols.eanCols || []).map(function (ci) { return rowVals[ci]; })
      .filter(function (v) { return v != null && String(v).trim() !== ""; });
    for (var ei = 0; ei < eanRaws.length; ei++) {
      var derivedCod = eanToLkCod(eanRaws[ei]);
      if (derivedCod) {
        var match = window.scotApi.findProductByCodLK(derivedCod);
        if (match) return Object.assign({ matchedBy: "ean" }, match);
      }
    }

    // 2) Code cols + EANs crudos como codigo. Probar todos, tomar el primero que matchea.
    // Cods compuestos como "29/437E" o "529E 478E" se tokenizan por / espacio coma
    // para probar cada parte (el match correcto puede ser un sub-token).
    var codCandidates = [];
    function pushCodVariants(raw) {
      var s = String(raw == null ? "" : raw).trim();
      if (!s) return;
      if (codCandidates.indexOf(s) < 0) codCandidates.push(s);
      if (/[\/\s,]/.test(s)) {
        s.split(/[\/\s,]+/).forEach(function (tok) {
          tok = tok.trim();
          if (tok && codCandidates.indexOf(tok) < 0) codCandidates.push(tok);
        });
      }
    }
    cols.codeCols.forEach(function (ci) {
      pushCodVariants(rowVals[ci]);
    });
    eanRaws.forEach(function (e) {
      var eanStr = String(e).replace(/[^\d]/g, "");
      if (eanStr && codCandidates.indexOf(eanStr) < 0) codCandidates.push(eanStr);
    });
    for (var i = 0; i < codCandidates.length; i++) {
      var c = codCandidates[i];
      var m = window.scotApi.findProductByCodLK(c);
      if (m) return Object.assign({ matchedBy: "cod" }, m);
    }

    // 3) Descripcion fuzzy
    var descRaw = cols.descCol != null ? rowVals[cols.descCol] : "";
    if (descRaw && String(descRaw).trim()) {
      var qTokens = descTokens(descRaw);
      if (qTokens.length >= 2) {
        var bestScore = 0;
        var bestProd = null;
        var bestIsLoke = false;
        for (var p = 0; p < pools.length; p++) {
          var pool = pools[p].pool;
          for (var k = 0; k < pool.length; k++) {
            var prod = pool[k];
            if (prod.active === false) continue;
            var pTokens = descTokens(prod.description || "");
            if (!pTokens.length) continue;
            var sc = jaccard(qTokens, pTokens);
            if (sc > bestScore) {
              bestScore = sc;
              bestProd = prod;
              bestIsLoke = pools[p].isLoke;
            }
          }
        }
        if (bestProd && bestScore >= 0.55) {
          return { product: bestProd, isLoke: bestIsLoke, matchedBy: "desc", descScore: bestScore };
        }
      }
    }
    return null;
  }

  // ============================================================================
  // CARD INSTANCE
  // ============================================================================
  function createCardInstance(idx, cardRoot) {
    var $mount = cardRoot;
    var state = {
      idx: idx,
      customer: null,           // cliente actual (manual o auto)
      customerLockedAuto: false, // true si la sucursal lo auto-resuelve
      file: null,
      fileName: "",
      sheets: [],
      activeSheetIdx: -1,
      cols: null,
      // Si hay multi-branch, qty viene de branchCol; si no, de qtyBoxesCol/qtyUnitsCol
      activeBranchCol: -1,
      // Map branchColIdx → { groupName, cuit, label, delivery, customer? } cuando la
      // sucursal pertenece a un grupo conocido (ej Bazar y Cía / Multi Bazar).
      branchCustMap: {},
      detectedGroupName: null,
      activeDelivery: "",       // dirección de entrega resuelta para la branch activa
      items: [],
      submitting: false,
      submitted: false,
      orderId: null,
    };

    function renderInitial() {
      $mount.innerHTML = "";
      var card = el(
        '<div class="xkr-card">' +
          '<div class="xkr-cust-search">' +
          '<input class="xkr-cust-input" type="text" placeholder="Buscar cliente por código o razón social..."/>' +
          '<div class="xkr-suggest"></div>' +
          "</div>" +
          '<div class="xkr-drop">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28" style="color:var(--text3,#888)"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '<p class="xkr-drop-title">Arrastrá un Excel (.xlsx o .xls)</p>' +
          '<p class="xkr-drop-sub">o hacé click para elegir</p>' +
          '<input type="file" class="xkr-file-input" accept=".xlsx,.xls" hidden/>' +
          "</div>" +
          '<div class="xkr-status">Esperando cliente y archivo</div>' +
          "</div>",
      );
      $mount.appendChild(card);
      wireInputs(card);
    }

    function wireInputs(card) {
      var input = card.querySelector(".xkr-cust-input");
      var suggest = card.querySelector(".xkr-suggest");
      var drop = card.querySelector(".xkr-drop");
      var fileInput = card.querySelector(".xkr-file-input");

      var suggestTimer = null;
      input.addEventListener("input", function () {
        if (suggestTimer) clearTimeout(suggestTimer);
        var q = input.value;
        suggestTimer = setTimeout(function () {
          suggestCustomers(q, suggest, function (c) {
            input.value = (c.cod_cliente || "") + " — " + (c.business_name || "");
            suggest.style.display = "none";
            state.customer = c;
            updateStatus();
          });
        }, 220);
      });
      input.addEventListener("blur", function () {
        setTimeout(function () { suggest.style.display = "none"; }, 200);
      });

      drop.addEventListener("click", function () { fileInput.click(); });
      fileInput.addEventListener("change", function () {
        if (fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
      });
      drop.addEventListener("dragover", function (e) {
        e.preventDefault();
        drop.classList.add("xkr-drag");
      });
      drop.addEventListener("dragleave", function () {
        drop.classList.remove("xkr-drag");
      });
      drop.addEventListener("drop", function (e) {
        e.preventDefault();
        drop.classList.remove("xkr-drag");
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          handleFile(e.dataTransfer.files[0]);
        }
      });
    }

    function setStatus(msg, kind) {
      var s = $mount.querySelector(".xkr-status");
      if (!s) return;
      s.className = "xkr-status" + (kind ? " " + kind : "");
      s.innerHTML = msg;
    }

    function updateStatus() {
      if (state.customer && !state.file) {
        setStatus("Cliente seleccionado. Subí el Excel.", "ok");
      } else if (!state.customer && state.file) {
        setStatus("Excel cargado. Falta seleccionar cliente.", "warn");
      } else if (state.customer && state.file) {
        setStatus("Listo.", "ok");
      } else {
        setStatus("Esperando cliente y archivo");
      }
    }

    async function handleFile(file) {
      state.file = file;
      state.fileName = file.name;
      setStatus('<span class="xkr-spinner"></span> Procesando Excel...');
      try {
        var buf = await file.arrayBuffer();
        var parsed = parseWorkbook(buf, file.name);
        state.sheets = parsed.sheets;
        // Tomar la primera sheet con header detectado
        var firstWithHdr = -1;
        for (var i = 0; i < parsed.sheets.length; i++) {
          if (parsed.sheets[i].headerIdx >= 0) { firstWithHdr = i; break; }
        }
        if (firstWithHdr < 0) {
          setStatus("No se detectó una tabla con headers válidos en ninguna hoja del archivo.", "err");
          state.file = null;
          return;
        }
        state.activeSheetIdx = firstWithHdr;
        state.cols = parsed.sheets[firstWithHdr].cols;
        // Resolver branch → cliente conocido (ej grupo Bazar y Cía)
        state.branchCustMap = {};
        state.detectedGroupName = null;
        state.cols.branchCols.forEach(function (bi) {
          var info = resolveBranchCustomer(state.cols.headers[bi]);
          if (info) {
            state.branchCustMap[bi] = info;
            if (!state.detectedGroupName) state.detectedGroupName = info.groupName;
          }
        });
        // Default branch: si hay multi-branch, ninguno seleccionado todavia
        state.activeBranchCol = state.cols.branchCols.length === 1 ? state.cols.branchCols[0] : -1;
        // Cargar productos y matchear
        await Promise.all([
          window.scotApi.loadAllProducts(),
          window.scotApi.loadAllLokeProducts(),
        ]);
        // Si la única branch ya viene mapeada, auto-resolver cliente
        if (state.activeBranchCol >= 0 && state.branchCustMap[state.activeBranchCol]) {
          await applyBranchAutoCustomer();
        }
        rebuildItems();
        renderResult();
      } catch (e) {
        console.error("xkr handleFile:", e);
        setStatus("Error procesando Excel: " + (e.message || e), "err");
      }
    }

    // Lookup customer por CUIT del mapping y setearlo como activo + bloqueado.
    // Si no se encuentra en DB, deja state.customer = null y customerLockedAuto
    // = true igual (la UI muestra el mapping pero indica falta de cliente real).
    async function applyBranchAutoCustomer() {
      var info = state.branchCustMap[state.activeBranchCol];
      if (!info) {
        state.customerLockedAuto = false;
        state.activeDelivery = "";
        return;
      }
      state.customerLockedAuto = true;
      state.activeDelivery = info.delivery || "";
      var c = await loadCustomerByCuit(info.cuit);
      state.customer = c;
    }

    // Construye state.items desde state.sheets[activeSheetIdx] usando activeBranchCol
    // (si no hay multi-branch, usa qtyBoxesCol o qtyUnitsCol).
    function rebuildItems() {
      var sheet = state.sheets[state.activeSheetIdx];
      if (!sheet || !sheet.cols) { state.items = []; return; }
      var cols = sheet.cols;
      var qtyCol = -1;
      var qtyIsBoxes = false;
      if (state.activeBranchCol >= 0) {
        qtyCol = state.activeBranchCol;
        qtyIsBoxes = false; // branch cols suelen ser unidades
      } else if (cols.qtyBoxesCol != null) {
        qtyCol = cols.qtyBoxesCol;
        qtyIsBoxes = true;
      } else if (cols.qtyUnitsCol != null) {
        qtyCol = cols.qtyUnitsCol;
        qtyIsBoxes = false;
      }
      var items = [];
      sheet.dataRows.forEach(function (row, ridx) {
        if (isJunkRow(row, cols)) return;
        var rawQty = qtyCol >= 0 ? Number(window.scotApi.parseNum(row[qtyCol])) : 0;
        if (!rawQty || rawQty <= 0) return; // skip rows sin pedido en esa branch
        var match = matchRowToProduct(row, cols);
        var p = match ? match.product : null;
        var uxb = cols.uxbCol != null ? Number(window.scotApi.parseNum(row[cols.uxbCol])) : 0;
        if (!uxb && p) uxb = Number(p.uxb || 0);
        // cajas
        var cajas = 0;
        if (qtyIsBoxes) {
          cajas = Math.round(rawQty);
        } else if (uxb > 0) {
          cajas = Math.round(rawQty / uxb);
        } else {
          cajas = Math.round(rawQty);
        }
        var unitPrice = cols.priceCol != null
          ? Number(window.scotApi.parseNum(row[cols.priceCol]))
          : 0;
        if (!unitPrice && p) unitPrice = Number(p.list_price || 0);
        // listPrice: preferir columna lista del Excel (si la hay) sobre LK list_price
        var listPrice = 0;
        if (cols.listPriceCol != null) {
          listPrice = Number(window.scotApi.parseNum(row[cols.listPriceCol])) || 0;
        }
        if (!listPrice && p) listPrice = Number(p.list_price || 0);
        var rawDesc = cols.descCol != null ? String(row[cols.descCol] || "") : "";
        items.push({
          rowIdx: ridx,
          codCandidates: cols.codeCols.map(function (ci) { return row[ci]; }),
          ean: (cols.eanCols || [])[0] != null ? row[cols.eanCols[0]] : null,
          rawDesc: rawDesc,
          rawQty: rawQty,
          qtyIsBoxes: qtyIsBoxes,
          uxb: uxb,
          cajas: cajas,
          cajasMismatch: !qtyIsBoxes && uxb > 0 && cajas * uxb !== Math.round(rawQty),
          unitPrice: unitPrice,
          listPrice: listPrice,
          product: p,
          isLoke: match ? match.isLoke : false,
          matchedBy: match ? match.matchedBy : null,
          descScore: match ? match.descScore : null,
          codLk: p ? String(p.cod || "").trim() : null,
          description: p ? p.description : rawDesc,
          found: !!p,
          included: !!p,
        });
      });
      state.items = items;
    }

    function computeTotals() {
      var total = 0, totalCajas = 0, includedCount = 0;
      state.items.forEach(function (it) {
        if (!it.included || !it.found) return;
        total += (it.unitPrice || 0) * (it.cajas || 0) * (it.uxb || 0);
        totalCajas += it.cajas || 0;
        includedCount++;
      });
      return { total: total, totalCajas: totalCajas, includedCount: includedCount };
    }

    function renderResult() {
      $mount.innerHTML = "";
      var sheet = state.sheets[state.activeSheetIdx];
      var cols = sheet.cols;
      var totals = computeTotals();
      var hasMultiBranch = cols.branchCols.length > 1;

      // Sheet picker (si hay >1 hoja con header)
      var sheetsWithHdr = state.sheets.filter(function (s) { return s.headerIdx >= 0; });
      var sheetPickerHtml = "";
      if (sheetsWithHdr.length > 1) {
        sheetPickerHtml =
          '<div class="xkr-branch-row"><span style="color:var(--text3,#888);font-size:11px">Hoja:</span>' +
          '<select id="xkrSheetSel">' +
          state.sheets
            .map(function (s, i) {
              if (s.headerIdx < 0) return "";
              return (
                '<option value="' + i + '"' +
                (i === state.activeSheetIdx ? " selected" : "") + ">" +
                escapeHtml(s.name) +
                "</option>"
              );
            })
            .join("") +
          "</select></div>";
      }

      // Branch picker (si multi-branch). Cuando una sucursal está mapeada a
      // un cliente conocido, lo mostramos en la opción para que se vea el
      // routing antes de elegir.
      var branchPickerHtml = "";
      if (hasMultiBranch) {
        branchPickerHtml =
          '<div class="xkr-branch-row"><span style="color:var(--text3,#888);font-size:11px">Sucursal:</span>' +
          '<select id="xkrBranchSel">' +
          '<option value="-1"' + (state.activeBranchCol < 0 ? " selected" : "") + ">— Seleccionar sucursal —</option>" +
          cols.branchCols
            .map(function (ci) {
              var lab = cols.headers[ci] || ("Col " + ci);
              var info = state.branchCustMap[ci];
              var suffix = info ? " → " + info.label : "";
              return (
                '<option value="' + ci + '"' +
                (state.activeBranchCol === ci ? " selected" : "") + ">" +
                escapeHtml(String(lab).trim() + suffix) +
                "</option>"
              );
            })
            .join("") +
          "</select></div>";
      }

      // Banner de grupo detectado
      var groupBannerHtml = "";
      if (state.detectedGroupName) {
        groupBannerHtml =
          '<div style="background:#e8f4fd;border:1px solid #9bc8e6;color:#1f4c6e;border-radius:6px;padding:8px 10px;font-size:12px">' +
          '<strong>Grupo detectado:</strong> ' + escapeHtml(state.detectedGroupName) +
          ' &middot; cada sucursal se factura a una razón social distinta. Al elegir la sucursal se auto-resuelve el cliente.' +
          "</div>";
      }

      // Customer line — distintos modos:
      //  - Auto-locked + cliente resuelto: pill verde "Auto" + razón social
      //  - Auto-locked + sin cliente en DB: pill warn (aviso) + datos del mapping
      //  - Manual con cliente: pill normal + cambiar
      //  - Manual sin cliente: search input
      var custHtml;
      var autoInfo = state.customerLockedAuto ? state.branchCustMap[state.activeBranchCol] : null;
      if (autoInfo && state.customer) {
        custHtml =
          '<div class="xkr-cust-current" style="background:#dff5e3;border-color:#9bd6a8;color:#1e7a31">' +
          '<span><span class="xkr-pill ok" style="margin-right:6px">AUTO</span><strong>' +
          escapeHtml(state.customer.cod_cliente || "") + "</strong> — " +
          escapeHtml(state.customer.business_name || "") +
          (state.customer.vend ? " · Vend " + escapeHtml(state.customer.vend) : "") +
          (state.activeDelivery ? '<div style="font-size:11px;font-weight:400;margin-top:3px">📍 ' + escapeHtml(state.activeDelivery) + "</div>" : "") +
          "</span></div>";
      } else if (autoInfo && !state.customer) {
        custHtml =
          '<div class="xkr-warn-box">' +
          '<strong>Mapping de sucursal:</strong> ' + escapeHtml(autoInfo.label) +
          ' (CUIT ' + escapeHtml(autoInfo.cuit) + ')' +
          '<div style="margin-top:4px">⚠ No se encontró un customer en la DB con ese CUIT. Verificá la carga del cliente o continuá con búsqueda manual abajo.</div>' +
          "</div>" +
          '<div class="xkr-cust-search">' +
          '<input class="xkr-cust-input" type="text" placeholder="Buscar cliente manualmente..."/>' +
          '<div class="xkr-suggest"></div>' +
          "</div>";
      } else if (state.customer) {
        custHtml =
          '<div class="xkr-cust-current"><span><strong>' +
          escapeHtml(state.customer.cod_cliente || "") + "</strong> — " +
          escapeHtml(state.customer.business_name || "") +
          (state.customer.vend ? " · Vend " + escapeHtml(state.customer.vend) : "") +
          '</span><button class="xkr-change-cust">Cambiar</button></div>';
      } else {
        custHtml =
          '<div class="xkr-cust-search">' +
          '<input class="xkr-cust-input" type="text" placeholder="Buscar cliente por código o razón social..."/>' +
          '<div class="xkr-suggest"></div>' +
          "</div>" +
          '<div class="xkr-warn-box">⚠ Falta seleccionar cliente para subir el pedido.</div>';
      }

      // Detection summary
      var foundCount = state.items.filter(function (it) { return it.found; }).length;
      var missCount = state.items.filter(function (it) { return !it.found; }).length;
      var detectMeta =
        '<div class="xkr-meta">' +
        '<div class="xkr-meta-pill"><span class="lbl">Archivo</span>' + escapeHtml(state.fileName) + "</div>" +
        '<div class="xkr-meta-pill"><span class="lbl">Hoja</span>' + escapeHtml(sheet.name) + "</div>" +
        '<div class="xkr-meta-pill"><span class="lbl">Items</span>' + state.items.length + "</div>" +
        '<div class="xkr-meta-pill" style="background:#dff5e3;border-color:#9bd6a8;color:#1e7a31"><span class="lbl">Match</span>' + foundCount + "</div>" +
        (missCount > 0
          ? '<div class="xkr-meta-pill" style="background:#ffd9d4;border-color:#e6a39b;color:#c0392b"><span class="lbl">Sin match</span>' + missCount + "</div>"
          : "") +
        ((cols.eanCols || []).length > 0
          ? '<div class="xkr-meta-pill"><span class="lbl">EAN cols</span>' + cols.eanCols.length + " (probando todas)</div>"
          : '<div class="xkr-meta-pill" style="color:#b8780f"><span class="lbl">Modo</span>cod + desc fuzzy</div>') +
        "</div>";

      // Items table
      var rows = state.items.map(function (it, i) {
        var rowClass = "";
        if (!it.found) rowClass = "xkr-row-bad";
        else if (it.cajasMismatch) rowClass = "xkr-row-warn";
        if (!it.included) rowClass += " xkr-row-excluded";
        var pill = "";
        if (it.found) {
          if (it.matchedBy === "ean") pill = '<span class="xkr-pill ok">EAN</span>';
          else if (it.matchedBy === "cod") pill = '<span class="xkr-pill ok">COD</span>';
          else if (it.matchedBy === "desc") pill = '<span class="xkr-pill warn">DESC ' + Math.round((it.descScore || 0) * 100) + '%</span>';
        } else {
          pill = '<span class="xkr-pill miss">sin match</span>';
        }
        return (
          "<tr class=\"" + rowClass + "\" data-i=\"" + i + "\">" +
          "<td>" + (i + 1) + "</td>" +
          "<td>" + (it.codLk ? escapeHtml(it.codLk) : '<span style="color:#888">' + escapeHtml(it.codCandidates.filter(Boolean).join("/") || "—") + "</span>") + "</td>" +
          "<td>" + escapeHtml((it.description || "").slice(0, 60)) + (it.description && it.description.length > 60 ? "…" : "") + "</td>" +
          "<td style=\"text-align:right\">" + (it.uxb || "—") + "</td>" +
          '<td><input class="xkr-cajas-input" type="number" min="0" value="' + (it.cajas || 0) + '"/></td>' +
          "<td style=\"text-align:right\">" + (it.cajas * (it.uxb || 0)) + "</td>" +
          "<td style=\"text-align:right\">$ " + fmtMoney(it.unitPrice) + "</td>" +
          "<td style=\"text-align:right\">$ " + fmtMoney(it.unitPrice * it.cajas * (it.uxb || 0)) + "</td>" +
          "<td>" + pill + (it.cajasMismatch ? ' <span class="xkr-pill warn">qty no múltiplo de uxb</span>' : "") + "</td>" +
          '<td><label style="display:inline-flex;align-items:center;gap:4px;font-size:11px"><input type="checkbox" class="xkr-incl" ' + (it.included ? "checked" : "") + (!it.found ? " disabled" : "") + "/>incl.</label></td>" +
          "</tr>"
        );
      }).join("");

      var card = el(
        '<div class="xkr-card">' +
          custHtml +
          groupBannerHtml +
          sheetPickerHtml +
          branchPickerHtml +
          (hasMultiBranch && state.activeBranchCol < 0
            ? '<div class="xkr-warn-box">El archivo tiene múltiples columnas de sucursales. Elegí una para ver los items.</div>'
            : "") +
          detectMeta +
          (state.items.length === 0 && (!hasMultiBranch || state.activeBranchCol >= 0)
            ? '<div class="xkr-warn-box">No se encontraron items con cantidad pedida en esta hoja/sucursal.</div>'
            : "") +
          (state.items.length > 0
            ? '<div class="xkr-table-wrap"><table class="xkr-table"><thead><tr>' +
              "<th>#</th><th>COD LK</th><th>Descripción</th><th>UxB</th><th>Cajas</th><th>Unid.</th><th>Precio</th><th>Subtotal</th><th>Match</th><th></th>" +
              "</tr></thead><tbody>" + rows + "</tbody></table></div>"
            : "") +
          (state.items.length > 0
            ? '<div class="xkr-totals">' +
              '<span><span class="lab">Items:</span> <span class="val">' + totals.includedCount + "</span></span>" +
              '<span><span class="lab">Cajas:</span> <span class="val">' + totals.totalCajas + "</span></span>" +
              '<span><span class="lab">Total:</span> <span class="val">$ ' + fmtMoney(totals.total) + "</span></span>" +
              "</div>"
            : "") +
          '<div class="xkr-actions">' +
          '<button class="xkr-btn danger" id="xkrReset">Descartar</button>' +
          (state.items.length > 0
            ? '<button class="xkr-btn primary" id="xkrSubmit"' +
              (state.submitted ? " disabled" : "") + ">" +
              (state.submitted ? "Pedido " + (state.orderId || "") + " subido" : "Subir como pedido") +
              "</button>"
            : "") +
          "</div>" +
          "</div>",
      );
      $mount.innerHTML = "";
      $mount.appendChild(card);

      // Wire
      if (!state.customer) {
        wireCustSearchOnly(card);
      } else {
        var changeBtn = card.querySelector(".xkr-change-cust");
        if (changeBtn) {
          changeBtn.addEventListener("click", function () {
            state.customer = null;
            renderResult();
          });
        }
      }

      var sheetSel = card.querySelector("#xkrSheetSel");
      if (sheetSel) {
        sheetSel.addEventListener("change", async function () {
          state.activeSheetIdx = parseInt(sheetSel.value, 10);
          state.cols = state.sheets[state.activeSheetIdx].cols;
          // Re-resolver branchCustMap para la nueva hoja
          state.branchCustMap = {};
          state.detectedGroupName = null;
          state.cols.branchCols.forEach(function (bi) {
            var info = resolveBranchCustomer(state.cols.headers[bi]);
            if (info) {
              state.branchCustMap[bi] = info;
              if (!state.detectedGroupName) state.detectedGroupName = info.groupName;
            }
          });
          state.activeBranchCol = state.cols.branchCols.length === 1 ? state.cols.branchCols[0] : -1;
          state.customer = null;
          state.customerLockedAuto = false;
          state.activeDelivery = "";
          if (state.activeBranchCol >= 0 && state.branchCustMap[state.activeBranchCol]) {
            await applyBranchAutoCustomer();
          }
          rebuildItems();
          renderResult();
        });
      }
      var branchSel = card.querySelector("#xkrBranchSel");
      if (branchSel) {
        branchSel.addEventListener("change", async function () {
          var prevLocked = state.customerLockedAuto;
          state.activeBranchCol = parseInt(branchSel.value, 10);
          // Si la nueva sucursal está mapeada → auto-resolver cliente.
          // Si no → liberar lock; si veníamos de auto, limpiar el cliente
          // (la elección anterior pertenecía a otra razón social).
          if (state.activeBranchCol >= 0 && state.branchCustMap[state.activeBranchCol]) {
            await applyBranchAutoCustomer();
          } else {
            state.customerLockedAuto = false;
            state.activeDelivery = "";
            if (prevLocked) state.customer = null;
          }
          rebuildItems();
          renderResult();
        });
      }
      var resetBtn = card.querySelector("#xkrReset");
      if (resetBtn) resetBtn.addEventListener("click", resetState);
      var submitBtn = card.querySelector("#xkrSubmit");
      if (submitBtn) submitBtn.addEventListener("click", submitOrder);

      // Wire cajas input + incl checkbox
      card.querySelectorAll("tr[data-i]").forEach(function (tr) {
        var i = parseInt(tr.dataset.i, 10);
        var caInp = tr.querySelector(".xkr-cajas-input");
        var inclChk = tr.querySelector(".xkr-incl");
        if (caInp) {
          caInp.addEventListener("input", function () {
            state.items[i].cajas = Math.max(0, parseInt(caInp.value, 10) || 0);
            // Re-render solo totales y subtotal — full re-render por simplicidad
            renderResult();
          });
        }
        if (inclChk) {
          inclChk.addEventListener("change", function () {
            state.items[i].included = inclChk.checked;
            renderResult();
          });
        }
      });
    }

    function wireCustSearchOnly(card) {
      var input = card.querySelector(".xkr-cust-input");
      var suggest = card.querySelector(".xkr-suggest");
      if (!input || !suggest) return;
      var suggestTimer = null;
      input.addEventListener("input", function () {
        if (suggestTimer) clearTimeout(suggestTimer);
        var q = input.value;
        suggestTimer = setTimeout(function () {
          suggestCustomers(q, suggest, function (c) {
            state.customer = c;
            renderResult();
          });
        }, 220);
      });
      input.addEventListener("blur", function () {
        setTimeout(function () { suggest.style.display = "none"; }, 200);
      });
    }

    function resetState() {
      state.customer = null;
      state.customerLockedAuto = false;
      state.file = null;
      state.fileName = "";
      state.sheets = [];
      state.activeSheetIdx = -1;
      state.cols = null;
      state.activeBranchCol = -1;
      state.branchCustMap = {};
      state.detectedGroupName = null;
      state.activeDelivery = "";
      state.items = [];
      state.submitting = false;
      state.submitted = false;
      state.orderId = null;
      renderInitial();
    }

    async function submitOrder() {
      if (state.submitting || state.submitted) return;
      if (!state.customer) {
        window.toast && window.toast("Falta cliente", "warning");
        return;
      }
      var validItems = state.items.filter(function (it) {
        return it.included && it.found && (it.cajas || 0) > 0;
      });
      if (!validItems.length) {
        window.toast && window.toast("No hay items válidos", "warning");
        return;
      }
      var missing = state.items.filter(function (it) { return !it.found; });
      if (missing.length) {
        var ok = window.confirm(
          missing.length + " item(s) sin match en LK no se enviarán. ¿Continuar?",
        );
        if (!ok) return;
      }
      var mismatchUxb = state.items.filter(function (it) {
        return it.included && it.found && it.cajasMismatch;
      });
      if (mismatchUxb.length) {
        var ok2 = window.confirm(
          mismatchUxb.length +
            " item(s) tienen cantidad que no es múltiplo exacto de UxB " +
            "(se redondea a la caja más cercana). ¿Continuar?",
        );
        if (!ok2) return;
      }

      state.submitting = true;
      var btn = $mount.querySelector("#xkrSubmit");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Subiendo...";
      }

      try {
        var sessRes = await window.sb.auth.getSession();
        var session = sessRes.data && sessRes.data.session;
        if (!session) throw new Error("Sesión inválida");
        var authToken = session.access_token;
        var apiKey = window.SUPABASE_ANON_KEY || "";
        var subtotal = 0;
        var rpcItems = validItems.map(function (it) {
          var line = it.unitPrice * (it.cajas || 0) * (it.uxb || 0);
          subtotal += line;
          return {
            product_id: it.product.id,
            cajas: it.cajas,
            uxb: it.uxb,
            is_loke: !!it.isLoke,
            unit_list_price: Number(it.listPrice || it.unitPrice || 0),
            unit_your_price: Number(it.unitPrice || 0),
            line_total: line,
          };
        });
        var total = subtotal;
        var paymentMethodText = "Contado";
        var rpcResult = await window.sb.rpc("submit_order_fast", {
          p_auth_user_id: session.user.id,
          p_customer_id: state.customer.id,
          p_status: "pendiente",
          p_payment_method: paymentMethodText,
          p_payment_discount: 0,
          p_web_discount: 0,
          p_subtotal: subtotal,
          p_total: total,
          p_items: rpcItems,
        });
        if (rpcResult.error || !rpcResult.data) {
          throw new Error(
            (rpcResult.error && (rpcResult.error.message || rpcResult.error.details)) ||
              "RPC falló",
          );
        }
        var orderId = rpcResult.data;

        // Sucursal label desde branchCol header (si hay multi-branch).
        var branchLabel = "";
        if (state.activeBranchCol >= 0 && state.cols && state.cols.headers) {
          branchLabel = String(state.cols.headers[state.activeBranchCol] || "").trim();
        }
        // Si la branch tiene mapping conocido, usar la dirección oficial del .doc
        // como dirección de entrega real. Si no, dejar el label del header.
        var deliveryDireccion = state.activeDelivery || branchLabel || "";
        var sucursalEntrega = branchLabel
          ? (state.customer.business_name || "") + " — " + branchLabel
          : (state.customer.business_name || "");

        var sheetsPayload = {
          order_number: String(orderId),
          pdf_oc: "",
          cod_cliente: String(state.customer.cod_cliente || ""),
          vend: String(state.customer.vend || ""),
          condicion_pago: paymentMethodText,
          condicion_pago_code: 1,
          sucursal_entrega: sucursalEntrega,
          cliente_nuevo: "",
          is_promo: false,
          is_chef: true,
          target_sheet: "Pedidos CH",
          empresa: "CH",
          extra_discount: 0,
          deuda: Number(state.customer.debt || 0),
          payment_term: state.customer.payment_term == null ? null : Number(state.customer.payment_term),
          credit_limit: state.customer.credit_limit == null ? null : Number(state.customer.credit_limit),
          source: "Excel",
          items: validItems.map(function (it) {
            return { cod_art: it.codLk, cajas: it.cajas, uxb: it.uxb };
          }),
        };

        window.sb
          .from("orders")
          .update({ sheets_payload: sheetsPayload, is_promo: false, extra_discount: 0 })
          .eq("id", orderId)
          .then(function () {});

        sendToSheetsWithRetry(sheetsPayload, authToken, 3, apiKey)
          .then(function () {
            window.sb
              .from("orders")
              .update({ sheets_sent: true })
              .eq("id", orderId)
              .then(function () {});
          })
          .catch(function (e) {
            console.warn("xkr sheets error:", e);
          });

        var entregasPayload = {
          order_number: orderId,
          fecha: new Date().toLocaleDateString("es-AR"),
          cod_cliente: state.customer.cod_cliente,
          cliente: state.customer.business_name,
          vendedor: state.customer.vend || "",
          direccion_entrega: deliveryDireccion,
          barrio_entrega: "",
          empresa: "CH",
          is_promo: false,
          extra_discount: 0,
          items: validItems.map(function (it) {
            return {
              cod_art: it.codLk,
              description: it.description || "",
              cajas: it.cajas,
              uxb: it.uxb,
            };
          }),
        };
        sendToEntregas(entregasPayload, authToken, apiKey);

        state.submitted = true;
        state.orderId = orderId;
        window.toast && window.toast("Pedido " + orderId + " subido", "success");
        if (btn) {
          btn.textContent = "Pedido " + orderId + " subido";
          btn.disabled = true;
        }
      } catch (e) {
        console.error("xkr submit:", e);
        window.toast && window.toast("Error: " + (e.message || e), "error");
        state.submitting = false;
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Subir como pedido";
        }
      }
    }

    renderInitial();
    return {
      idx: idx,
      reset: resetState,
      getState: function () { return state; },
    };
  }

  // ============================================================================
  // CUSTOMER SEARCH (compartido entre cards)
  // ============================================================================
  async function suggestCustomers(q, suggestEl, onPick) {
    q = String(q || "").trim();
    if (q.length < 2) {
      suggestEl.style.display = "none";
      return;
    }
    var isNum = /^\d+$/.test(q);
    try {
      var promises = [
        window.sb
          .from("customers")
          .select("id,cod_cliente,business_name,dto_vol,vend,debt,payment_term,credit_limit")
          .ilike("business_name", "%" + q + "%")
          .order("business_name", { ascending: true })
          .limit(8),
      ];
      if (isNum) {
        promises.push(
          window.sb
            .from("customers")
            .select("id,cod_cliente,business_name,dto_vol,vend,debt,payment_term,credit_limit")
            .eq("cod_cliente", q)
            .limit(3),
        );
      }
      var results = await Promise.all(promises);
      var seen = {}, merged = [];
      results.forEach(function (r) {
        if (r.error || !r.data) return;
        r.data.forEach(function (c) {
          if (seen[c.id]) return;
          seen[c.id] = true;
          merged.push(c);
        });
      });
      if (isNum) {
        merged.sort(function (a, b) {
          var aMatch = String(a.cod_cliente) === q ? 0 : 1;
          var bMatch = String(b.cod_cliente) === q ? 0 : 1;
          return aMatch - bMatch;
        });
      }
      if (!merged.length) {
        suggestEl.innerHTML = '<div class="xkr-suggest-empty">Sin resultados</div>';
        suggestEl.style.display = "block";
        return;
      }
      suggestEl.innerHTML = merged
        .slice(0, 10)
        .map(function (c) {
          return (
            '<div class="xkr-suggest-row" data-id="' + c.id + '">' +
            '<span class="xkr-suggest-cod">' + escapeHtml(c.cod_cliente || "") + "</span>" +
            '<span>' + escapeHtml(c.business_name || "") + '</span>' +
            "</div>"
          );
        })
        .join("");
      suggestEl.style.display = "block";
      suggestEl.querySelectorAll(".xkr-suggest-row").forEach(function (row) {
        row.addEventListener("mousedown", function (e) {
          e.preventDefault();
          var id = row.dataset.id;
          var c = merged.find(function (x) { return x.id === id; });
          if (c) onPick(c);
        });
      });
    } catch (e) {
      console.error("xkr suggest:", e);
    }
  }

  // ----- Sheets helpers -----
  function withTimeout(promise, ms, label) {
    var t;
    var timeout = new Promise(function (_, reject) {
      t = setTimeout(function () { reject(new Error("Timeout " + label)); }, ms);
    });
    return Promise.race([promise, timeout]).finally(function () { clearTimeout(t); });
  }
  async function sendToSheets(payload, token, apiKey) {
    var resp = await fetch(SHEETS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: apiKey || window.SUPABASE_ANON_KEY || "",
      },
      body: JSON.stringify(payload),
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || (data && data.ok === false)) {
      throw new Error((data && data.error) || "Proxy error " + resp.status);
    }
    return { ok: true };
  }
  async function sendToSheetsWithRetry(payload, token, maxAttempts, apiKey) {
    maxAttempts = maxAttempts || 3;
    var lastError = null;
    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await withTimeout(sendToSheets(payload, token, apiKey), 25000, "sheets " + attempt);
      } catch (e) {
        lastError = e;
        console.warn("xkr sheets intento " + attempt + " fallo:", e);
        if (attempt < maxAttempts)
          await new Promise(function (r) { setTimeout(r, 1200); });
      }
    }
    throw lastError || new Error("Fallo envio");
  }
  async function sendToEntregas(payload, token, apiKey) {
    try {
      var resp = await fetch(SHEETS_ENTREGAS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + token,
          apikey: apiKey || window.SUPABASE_ANON_KEY || "",
        },
        body: JSON.stringify(payload),
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok || (data && data.ok === false)) {
        console.warn("xkr entregas error:", (data && data.error) || resp.status);
      }
    } catch (e) {
      console.warn("xkr entregas exception:", e);
    }
  }

  // ============================================================================
  // INIT
  // ============================================================================
  function init() {
    var section = document.getElementById("excel-krikos");
    if (!section) return;
    var mount = document.getElementById("excelKrikosMount");
    if (!mount) return;
    if (!window.XLSX) {
      mount.innerHTML = '<div class="xkr-error-box">XLSX no cargó. Recargá la página.</div>';
      return;
    }
    if (!window.sb) {
      mount.innerHTML = '<div style="font-size:13px;color:#888">Esperando inicialización...</div>';
      setTimeout(init, 400);
      return;
    }
    if (!window.scotApi) {
      mount.innerHTML = '<div style="font-size:13px;color:#888">Esperando módulo PDF Krikos (scotApi)...</div>';
      setTimeout(init, 400);
      return;
    }
    injectCSS();
    mount.innerHTML = '<div class="xkr-grid" id="xkrGrid"></div>';
    var grid = mount.querySelector("#xkrGrid");
    cardInstances = [];
    for (var i = 0; i < CARD_COUNT; i++) {
      var cardRoot = document.createElement("div");
      cardRoot.className = "xkr-card-instance";
      cardRoot.dataset.idx = i;
      grid.appendChild(cardRoot);
      cardInstances.push(createCardInstance(i, cardRoot));
    }
  }

  function bootstrap() { setTimeout(init, 250); }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
