/* Regresión — "Editar pedido: sólo agregar" (idea 4990, 2026-09-05).
   Corre mayorista.html headless con supabase-js STUBEADO (sin red): un cliente logueado con dos
   pedidos (55 editable, 56 ya enviado a compras). Verifica el botón Editar, el piso por línea
   (−/✕/cantidad a mano bloqueados), y que confirmar en modo edición INSERTA sólo el delta en
   order_items, actualiza orders y reescribe sheets_payload.items — sin crear un pedido nuevo.
   Uso: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tests/editar-pedido.cjs */
const path = require("path");
let chromium;
try { ({ chromium } = require("/opt/node22/lib/node_modules/playwright")); }
catch (_e) { try { ({ chromium } = require("playwright")); } catch (_e2) { console.error("Playwright no encontrado."); process.exit(2); } }

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));

  // Supabase falso: un query builder encadenable sobre tablas en memoria.
  await p.addInitScript(() => {
    const tables = {
      orders: [
        { id: 55, created_at: "2026-09-05T10:00:00Z", total: 1862, subtotal: 2000, customer_id: "c1", enviado_a_compras_at: null,
          payment_method: "Contado", payment_discount: 0.05, web_discount: 0.02,
          sheets_payload: { orderNumber: 55, codCliente: "9", sucursalEntrega: "Sucursal X", order_total: 1862, items: [{ cod_art: "101", cajas: 2, uxb: 10 }] } },
        { id: 56, created_at: "2026-09-04T10:00:00Z", total: 500, subtotal: 500, customer_id: "c1", enviado_a_compras_at: "2026-09-04T15:30:00Z",
          payment_method: "Contado", payment_discount: 0, web_discount: 0, sheets_payload: { items: [{ cod_art: "101", cajas: 1, uxb: 10 }] } },
      ],
      order_items: [
        { id: 1, order_id: 55, product_id: "p1", cajas: 2, uxb: 10 },
        { id: 2, order_id: 56, product_id: "p1", cajas: 1, uxb: 10 },
      ],
      order_tracking: [],
    };
    const calls = [];
    function builder(table) {
      const st = { table, op: "select", filters: [], payload: null, single: false };
      const bb = {};
      const chain = (name) => (...a) => {
        if (["insert", "update", "delete", "upsert"].includes(name)) { st.op = name; st.payload = a[0]; }
        if (name === "single" || name === "maybeSingle") st.single = true;
        if (name === "eq" || name === "in") st.filters.push([name, a[0], a[1]]);
        return bb;
      };
      ["select", "insert", "update", "delete", "upsert", "eq", "in", "order", "limit", "single", "maybeSingle", "neq", "gte", "lte", "gt", "lt", "is", "not", "or", "range", "ilike", "like", "match"].forEach((n) => (bb[n] = chain(n)));
      bb.then = (res, rej) => {
        calls.push(JSON.parse(JSON.stringify(st)));
        let rows = tables[st.table] || (tables[st.table] = []);
        const pasa = (r) => st.filters.every(([n, col, val]) => n === "eq" ? String(r[col]) === String(val) : (Array.isArray(val) ? val.map(String).includes(String(r[col])) : true));
        let data = null;
        if (st.op === "select") { const out = rows.filter(pasa); data = st.single ? (out[0] || null) : out; }
        else if (st.op === "insert") { const arr = Array.isArray(st.payload) ? st.payload : [st.payload]; arr.forEach((r, i) => rows.push(Object.assign({ id: 1000 + rows.length + i }, r))); data = st.single ? rows[rows.length - 1] : arr; }
        else if (st.op === "update") { rows.forEach((r) => { if (pasa(r)) Object.assign(r, st.payload); }); }
        else if (st.op === "delete") { tables[st.table] = rows.filter((r) => !pasa(r)); }
        return Promise.resolve({ data, error: null }).then(res, rej);
      };
      return bb;
    }
    window.__fake = {
      tables, calls, from: builder,
      rpc: () => Promise.resolve({ data: [], error: null }),
      auth: { getSession: async () => ({ data: { session: null } }), getUser: async () => ({ data: { user: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({}) },
      channel: () => { const c = { on() { return c; }, subscribe() { return c; }, unsubscribe() {} }; return c; },
      removeChannel() {}, functions: { invoke: async () => ({ data: null, error: null }) },
    };
    window.supabase = { createClient: () => window.__fake };
    window.__alerts = [];
    window.alert = (m) => { window.__alerts.push(String(m)); };
  });
  // Sin red: lo externo (CDNs, translate, fuentes) se responde vacío.
  await p.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("file://")) return route.continue();
    if (/supabase-js/.test(u)) return route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stub: window.supabase ya está definido */" });
    return route.fulfill({ status: 200, contentType: /\.css/.test(u) ? "text/css" : "application/javascript", body: "" });
  });
  await p.goto("file://" + path.join(__dirname, "..", "mayorista.html"), { waitUntil: "load" });
  await p.waitForTimeout(600);

  const r = await p.evaluate(async () => {
    const out = {};
    const F = window.__fake;
    currentSession = { user: { id: "u1" }, access_token: "x" };
    customerProfile = { id: "c1", business_name: "Cliente Test", cod_cliente: "9", dto_vol: 0 };
    products = [
      { id: "p1", cod: "101", description: "Producto uno", list_price: 100, uxb: 10, active: true, badge_status: "" },
      { id: "p2", cod: "102", description: "Producto dos", list_price: 200, uxb: 5, active: true, badge_status: "" },
    ];
    cart.length = 0;
    setEditingOrderId(null); setEditBanner(null);

    // 1. Mis pedidos: Editar sólo en el 55 (el 56 ya salió a compras)
    await loadMyOrdersUI();
    const box = document.getElementById("myOrdersBox").innerHTML;
    out.btnEditar55 = /data-edit="55"/.test(box) && !/data-edit="56"/.test(box) && (box.match(/Editar pedido/g) || []).length === 1;

    // 2. Abrir el 55: carrito con el piso
    await editOrder("55");
    out.abre = editingOrderId === "55" && cart.length === 1 && cart[0].productId === "p1" && cart[0].qtyCajas === 2 && editMinQty("p1") === 2;
    const banner = document.getElementById("editOrderBanner");
    out.banner = !!banner && /#55/.test(banner.textContent) && document.getElementById("carrito").classList.contains("active");
    let cartHtml = document.getElementById("cart").innerHTML;
    out.pisoVisible = /Ya en el pedido: 2/.test(cartHtml) && /disabled(="")?\s+title="Ya está en el pedido/.test(cartHtml) && !/removeItem\('p1'\)/.test(cartHtml);
    if (!out.pisoVisible) out.pisoHtml = cartHtml.slice(0, 900);

    // 3. No se baja ni se saca lo que ya estaba
    window.__alerts.length = 0;
    changeQty("p1", -1); removeItem("p1"); manualQty("p1", "1");
    out.noBaja = cart[0].qtyCajas === 2 && window.__alerts.length === 3 && /sólo se le puede AGREGAR/.test(window.__alerts[0]);
    // …pero sí se sube y se agregan productos nuevos, que sí se pueden sacar
    changeQty("p1", 1);
    cart.push({ productId: "p2", qtyCajas: 1 }); updateCart();
    cartHtml = document.getElementById("cart").innerHTML;
    out.sube = cart[0].qtyCajas === 3 && /removeItem\('p2'\)/.test(cartHtml);
    removeItem("p2"); out.sacaNuevo = cart.length === 1;
    cart.push({ productId: "p2", qtyCajas: 1 }); updateCart(); refreshSubmitEnabled();
    out.confirmarHabilitado = !document.getElementById("submitOrderBtn").disabled;   // sin entrega ni pago elegidos

    // 4. Confirmar = agregar al 55, no crear pedido nuevo
    const callsAntes = F.calls.length;
    await submitOrder();
    const nuevas = F.calls.slice(callsAntes);
    out.sinPedidoNuevo = !nuevas.some((c) => c.table === "orders" && c.op === "insert");
    const ins = nuevas.filter((c) => c.table === "order_items" && c.op === "insert");
    const filas = ins.length === 1 ? ins[0].payload : [];
    const uyp1 = unitYourPrice(100), uyp2 = unitYourPrice(200);
    out.deltaInsertado = filas.length === 2
      && filas.some((f) => f.product_id === "p1" && f.cajas === 1 && f.uxb === 10 && f.order_id === "55" && f.unit_your_price === uyp1)
      && filas.some((f) => f.product_id === "p2" && f.cajas === 1 && f.uxb === 5 && f.unit_your_price === uyp2);
    const o55 = F.tables.orders.find((o) => o.id === 55);
    const esperadoSub = 2000 + uyp1 * 1 * 10 + uyp2 * 1 * 5;
    out.cabecera = Math.abs(o55.subtotal - esperadoSub) < 0.01 && Math.abs(o55.total - esperadoSub * 0.98 * 0.95) < 0.01;
    const it = o55.sheets_payload.items;
    out.payload = it.length === 2 && it[0].cod_art === "101" && it[0].cajas === 3 && it[1].cod_art === "102" && it[1].cajas === 1 && it[1].uxb === 5
      && o55.sheets_payload.sucursalEntrega === "Sucursal X" && Math.abs(o55.sheets_payload.order_total - o55.total) < 0.01 && !!o55.sheets_payload.editado_at;
    out.salioDelModo = editingOrderId === null && cart.length === 0 && !document.getElementById("editOrderBanner");
    out.confirmacion = document.getElementById("pedidoConfirmado").classList.contains("active")
      && /Pedido N° 55 actualizado · 2 líneas agregadas \(2 cajas\)/.test(document.getElementById("successOrderNum").textContent);

    // 5. El 56 ya salió a compras: no se puede
    setEditingOrderId("56", { p1: 1 }); cart.length = 0; cart.push({ productId: "p1", qtyCajas: 2 }); updateCart();
    const antes56 = F.tables.order_items.length;
    await submitOrder();
    out.bloquea56 = /ya salió a compras/.test(document.getElementById("orderStatus").textContent) && F.tables.order_items.length === antes56 && editingOrderId === "56";
    // 6. Sin cambios → aviso, sin escribir
    setEditingOrderId("55", { p1: 3, p2: 1 }); cart.length = 0; cart.push({ productId: "p1", qtyCajas: 3 }, { productId: "p2", qtyCajas: 1 }); updateCart();
    await submitOrder();
    out.sinCambios = /No agregaste nada nuevo/.test(document.getElementById("orderStatus").textContent) && F.tables.order_items.length === antes56;
    cancelEdit();
    out.cancela = editingOrderId === null && cart.length === 0 && document.getElementById("productos").classList.contains("active");
    return out;
  });

  const checks = [
    ["Mis pedidos: Editar sólo en el pedido que no salió a compras", r.btnEditar55],
    ["editOrder: carrito con las líneas del pedido y su piso", r.abre],
    ["cartel amarillo con el N° y va al carrito", r.banner],
    ["el − deshabilitado, sin ✕, 'Ya en el pedido: 2'", r.pisoVisible],
    ["no se baja ni se saca lo que ya estaba (3 avisos)", r.noBaja],
    ["sí se sube y lo nuevo se puede sacar", r.sube && r.sacaNuevo],
    ["Confirmar habilitado sin elegir entrega ni pago", r.confirmarHabilitado],
    ["confirmar NO crea un pedido nuevo", r.sinPedidoNuevo],
    ["inserta sólo el delta en order_items (2 filas)", r.deltaInsertado],
    ["actualiza subtotal/total con los descuentos del pedido", r.cabecera],
    ["reescribe sheets_payload.items (101→3, 102 nuevo) + order_total", r.payload],
    ["sale del modo edición y vacía el carrito", r.salioDelModo],
    ["pantalla de confirmación: 'actualizado · 2 líneas agregadas'", r.confirmacion],
    ["pedido ya enviado a compras: bloquea sin escribir", r.bloquea56],
    ["sin cambios: avisa y no escribe", r.sinCambios],
    ["Cancelar edición vuelve a productos", r.cancela],
    ["sin errores de página", errs.length === 0],
  ];
  let bad = 0;
  for (const [name, ok] of checks) { console.log((ok ? "  ok   " : "  FALLA") + " · " + name); if (!ok) bad++; }
  if (bad) console.log("  detalle:", JSON.stringify(r));
  if (errs.length) console.log("  pageerror: " + errs.join(" | "));
  console.log(bad ? "editar-pedido: " + bad + " FALLA(S)" : "editar-pedido: OK (" + checks.length + " chequeos)");
  await b.close();
  process.exit(bad ? 1 : 0);
})();
