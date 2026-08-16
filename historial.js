// ================= SUPABASE =================
const SUPABASE_URL = "https://nkhzocgdpwtgrmwleihr.supabase.co";
const SUPABASE_ANON_KEY =
  "sb_publishable_aThHtJLBKytg9k_6UdH2Eg_Use7f1zH";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ================= IMÁGENES =================
const BASE_IMG = `${SUPABASE_URL}/storage/v1/object/public/products-images/`;
const IMG_VERSION = (window.LK_CONFIG && window.LK_CONFIG.IMG_VERSION) || "1";

// ================= CATALOGO ACTIVO =================
let CATALOGO_CODES = new Set();

function imgUrlByCod(cod) {
  const c = String(cod || "").trim();
  if (!c) return "img/no-image.webp";
  return `${BASE_IMG}${encodeURIComponent(c)}.jpg?v=${encodeURIComponent(IMG_VERSION)}`;
}

// helpers
const $ = (id) => document.getElementById(id);
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }
const statusBox = $("status");
const tabla = $("tabla");
const thead = $("thead");
const tbody = $("tbody");

function setStatus(msg) {
  statusBox.style.display = "block";
  statusBox.innerText = msg;
  tabla.style.display = "none";
}

async function getSession() {
  const { data, error } = await sb.auth.getSession();
  if (error) {
    console.error("getSession error:", error);
    setStatus("Error de sesión.");
    return null;
  }

  if (!data?.session) {
    setStatus("No hay sesión iniciada. Volviendo a Mayorista…");
    setTimeout(() => (location.href = "./mayorista.html"), 800);
    return null;
  }

  return data.session;
}

async function getCliente(session) {
  const { data, error } = await sb
    .from("customers")
    .select("cod_cliente, business_name")
    .eq("auth_user_id", session.user.id)
    .maybeSingle();

  if (error) {
    console.error("getCliente error:", error);
    setStatus("No se pudo cargar el cliente (RLS o datos).");
    return null;
  }
  if (!data) {
    setStatus(
      "No se encontró tu cliente asociado. (falta vincular auth_user_id)",
    );
    return null;
  }
  return data;
}

/**
 * Trae el historial de compras del cliente via RPC.
 * RPC `get_customer_history` devuelve filas con: ym (YYYY-MM), item_code,
 * description, boxes. Filtramos en backend por cod_cliente.
 */
async function getHistory(codCliente) {
  const cc = String(codCliente).trim();

  const { data, error } = await sb.rpc("get_customer_history", {
    p_cod_cliente: cc,
  });

  if (error) {
    console.error("getHistory error:", error);
    setStatus("Error cargando historial.");
    return [];
  }

  const rows = data || [];
  rows.sort((a, b) => String(b.ym || "").localeCompare(String(a.ym || "")));
  return rows;
}

async function getCatalogCodes() {
  const { data, error } = await sb
    .from("products")
    .select("cod")
    .eq("active", true);

  if (error) {
    console.error("getCatalogCodes error:", error);
    return new Set();
  }

  return new Set(
    (data || [])
      .map((r) => String(r.cod || "").trim())
      .filter(Boolean),
  );
}

function renderTabla(rows) {
  if (!rows || !rows.length) {
    setStatus("Sin datos");
    return;
  }

  // 1) Meses presentes
  const mesesSet = new Set();
  for (const r of rows) {
    const ym = (r.ym || "").trim();
    if (!/^\d{4}-\d{2}$/.test(ym)) continue;
    mesesSet.add(ym);
  }

  const meses = Array.from(mesesSet).sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
  const meses60 = meses.slice(0, 60);

  // 2) Agrupar por item_code
  const map = {};
  for (const r of rows) {
    const item = (r.item_code || "").trim();
    if (!item) continue;

    const key = (r.ym || "").trim();
    if (!/^\d{4}-\d{2}$/.test(key)) continue;
    if (!meses60.includes(key)) continue;

    const boxes = Number(r.boxes) || 0;

    if (!map[item]) {
      map[item] = {
        desc: (r.description || "").trim() || item,
        total: 0,
        meses: {},
      };
    }

    map[item].total += boxes;
    map[item].meses[key] = (map[item].meses[key] || 0) + boxes;
  }

  const arr = Object.entries(map)
    .map(([cod, v]) => ({
      cod,
      ...v,
      enCatalogo: CATALOGO_CODES.has(String(cod).trim()),
    }))
    .sort((a, b) => b.total - a.total);

  // 3) Header — fila de AÑO + fila de MES
  thead.innerHTML = "";

  // --- Fila de año (colspan por grupo) ---
  const trYear = document.createElement("tr");

  // 5 columnas fijas vacías unificadas en 1 celda
  const thEmpty = document.createElement("th");
  thEmpty.className = "year-empty";
  thEmpty.colSpan = 5;
  trYear.appendChild(thEmpty);

  // Agrupar meses consecutivos por año
  const yearGroups = [];
  let curYear = null;
  let curCount = 0;
  for (const ym of meses60) {
    const y = ym.slice(0, 4);
    if (y === curYear) {
      curCount++;
    } else {
      if (curYear !== null) yearGroups.push({ year: curYear, span: curCount });
      curYear = y;
      curCount = 1;
    }
  }
  if (curYear !== null) yearGroups.push({ year: curYear, span: curCount });

  for (const g of yearGroups) {
    const th = document.createElement("th");
    th.className = "year-th";
    th.colSpan = g.span;
    th.innerText = g.year;
    trYear.appendChild(th);
  }

  thead.appendChild(trYear);

  // --- Fila de meses ---
  const trh = document.createElement("tr");

  ["Cod", "Descripción", "Imagen", "Total", "Pedido"].forEach((t) => {
    const th = document.createElement("th");
    th.innerText = t;
    trh.appendChild(th);
  });

  meses60.forEach((ym) => {
    const y = Number(ym.slice(0, 4));
    const m = Number(ym.slice(5, 7));
    const fecha = new Date(y, m - 1, 1);

    const nombre = fecha
      .toLocaleString("es-AR", { month: "short" })
      .replace(".", "")
      .toLowerCase();

    const th = document.createElement("th");
    th.className = "mes-th";
    th.innerText = nombre;
    trh.appendChild(th);
  });

  thead.appendChild(trh);

  // 4) Body
  tbody.innerHTML = "";

  for (const p of arr) {
    const tr = document.createElement("tr");

    const tdCod = document.createElement("td");
    tdCod.innerText = p.cod;
    tr.appendChild(tdCod);

    const tdDesc = document.createElement("td");
    tdDesc.innerText = p.desc;
    tdDesc.className = "desc";
    tr.appendChild(tdDesc);

    // Imagen del producto
    const tdFoto = document.createElement("td");
    const img = document.createElement("img");
    img.src = imgUrlByCod(p.cod);
    img.alt = p.desc || p.cod;
    img.width = 400;
    img.height = 400;
    img.loading = "lazy";
    img.className = "h-img-mini";
    img.onerror = function () { this.style.display = "none"; };
    tdFoto.appendChild(img);
    tr.appendChild(tdFoto);

    const tdTotal = document.createElement("td");
    tdTotal.innerText = p.total;
    tr.appendChild(tdTotal);

    const cod = String(p.cod).trim();
    const enCatalogo = CATALOGO_CODES.has(cod);

    const tdPedido = document.createElement("td");
    tdPedido.className = "pedido-td";

    if (enCatalogo) {
      tdPedido.innerHTML = `
        <div class="h-action">
          <div class="h-stepper">
            <button type="button" class="h-step-btn" onclick="hDec('${esc(cod)}')">−</button>
            <input id="hqty-${esc(cod)}" class="h-step-in" type="number" min="0" value="0" />
            <button type="button" class="h-step-btn" onclick="hInc('${esc(cod)}')">+</button>
          </div>
          <button type="button" class="h-add-btn" id="hadd-${esc(cod)}" onclick="hAdd('${esc(cod)}')">
            Agregar
          </button>
        </div>
      `;
    } else {
      tdPedido.innerHTML = `
        <span class="h-inactive">Inactivo</span>
      `;
    }

    tr.appendChild(tdPedido);

    meses60.forEach((ym) => {
      const td = document.createElement("td");
      td.innerText = p.meses[ym] ? String(p.meses[ym]) : "";
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }

  // 5) Mostrar y habilitar scroll
  statusBox.style.display = "none";
  tabla.style.display = "table";
  tabla.style.width = "max-content";
  tabla.style.minWidth = "100%";

  const scrollParent = tabla.parentElement || document.body;
  scrollParent.style.overflowX = "auto";
}

// Trae los clientes linkeados al vendedor (mismo patrón que mayorista)
async function loadLinkedCustomersHistorial() {
  try {
    const [vendorRes, groupRes] = await Promise.all([
      sb.rpc("get_my_linked_customers"),
      sb.rpc("get_my_group_customers"),
    ]);
    const vendorList = vendorRes.error ? [] : (vendorRes.data || []);
    const groupList = groupRes.error ? [] : (groupRes.data || []);
    const seen = {};
    const merged = [];
    vendorList.forEach((c) => { if (!seen[c.customer_id]) { seen[c.customer_id] = true; merged.push(c); } });
    groupList.forEach((c) => { if (!seen[c.customer_id]) { seen[c.customer_id] = true; merged.push(c); } });
    return merged;
  } catch (e) {
    console.error("loadLinkedCustomersHistorial error:", e);
    return [];
  }
}

function renderClienteSelectorHistorial(linked, currentCod, onChangeClient) {
  const old = document.getElementById("hist-cliente-selector");
  if (old) old.remove();
  if (!linked || !linked.length) return;

  const wrap = document.createElement("div");
  wrap.id = "hist-cliente-selector";
  wrap.style.cssText = "margin:8px 0 14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

  const label = document.createElement("label");
  label.setAttribute("for", "histClienteSelect");
  label.textContent = "Ver historial de:";
  label.style.cssText = "font-weight:600;";

  const sel = document.createElement("select");
  sel.id = "histClienteSelect";
  sel.style.cssText = "padding:6px 10px;border-radius:6px;border:1px solid #c4c7cc;font:inherit;min-width:240px;";

  linked.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.cod_cliente);
    opt.textContent = `${c.business_name} (${c.cod_cliente})`;
    if (String(c.cod_cliente) === String(currentCod)) opt.selected = true;
    sel.appendChild(opt);
  });

  sel.addEventListener("change", () => {
    const match = linked.find((c) => String(c.cod_cliente) === sel.value);
    if (!match) return;
    onChangeClient(match);
  });

  wrap.appendChild(label);
  wrap.appendChild(sel);

  const clienteDiv = document.getElementById("cliente");
  if (clienteDiv && clienteDiv.parentNode) {
    clienteDiv.parentNode.insertBefore(wrap, clienteDiv);
  }
}

async function init() {
  try {
    setStatus("Cargando...");
    const session = await getSession();
    if (!session) return;

    // ADMIN OVERRIDE: si la URL tiene ?cod=X (uso desde panel admin via
    // iframe), tiene prioridad sobre cualquier otra detección de cliente.
    const adminCod = (() => {
      try {
        const p = new URLSearchParams(window.location.search);
        return (p.get("cod") || "").trim();
      } catch (e) {
        return "";
      }
    })();
    console.log("[historial] adminCod from URL:", adminCod || "(none)");

    // FAST PATH: admin override — NO leer linked customers, NO LS, NO selector
    if (adminCod) {
      // Marca el body para que CSS pueda ocultar elementos no deseados en
      // contexto admin embed (botón Volver a productos, info-box, etc.)
      document.body.classList.add("lk-admin-embed");
      let businessName = "";
      try {
        const r = await sb
          .from("customers")
          .select("business_name")
          .eq("cod_cliente", adminCod)
          .maybeSingle();
        if (r && r.data) businessName = r.data.business_name || "";
      } catch (e) {
        console.warn("admin override: fetch business_name failed", e);
      }
      const clienteAdmin = {
        cod_cliente: adminCod,
        business_name: businessName,
      };
      console.log("[historial] ADMIN MODE — cliente:", clienteAdmin);

      $("cliente").innerText =
        `Cliente: ${clienteAdmin.business_name || "(sin nombre)"} (${clienteAdmin.cod_cliente})`;

      CATALOGO_CODES = await getCatalogCodes();

      const rowsAdmin = await getHistory(clienteAdmin.cod_cliente);
      console.log("[historial] rows for cod " + clienteAdmin.cod_cliente + ":", rowsAdmin.length);
      await renderTabla(rowsAdmin);
      return; // no renderizamos selector ni nada más
    }

    const linked = await loadLinkedCustomersHistorial();

    // Vendor impersonation: si un vendedor seleccionó un cliente, usar ese
    const vendorSelectedCod = (() => {
      try { return (localStorage.getItem("lk_vendor_selected_cod_cliente") || "").trim(); }
      catch(e) { return ""; }
    })();
    const vendorSelectedName = (() => {
      try { return (localStorage.getItem("lk_vendor_selected_business_name") || "").trim(); }
      catch(e) { return ""; }
    })();

    let cliente;
    if (vendorSelectedCod) {
      cliente = { cod_cliente: vendorSelectedCod, business_name: vendorSelectedName };
    } else if (linked && linked.length) {
      // Vendedor / grupo sin cliente pre-seleccionado: usar el primero vinculado
      const first = linked[0];
      cliente = {
        cod_cliente: String(first.cod_cliente || "").trim(),
        business_name: first.business_name || "",
      };
      try {
        localStorage.setItem("lk_vendor_selected_cod_cliente", cliente.cod_cliente);
        localStorage.setItem("lk_vendor_selected_business_name", cliente.business_name);
        if (first.dto_vol != null) {
          localStorage.setItem("lk_vendor_selected_dto_vol", String(first.dto_vol));
        }
      } catch (e) {}
    } else {
      cliente = await getCliente(session);
      if (!cliente) return;
    }

    $("cliente").innerText =
      `Cliente: ${cliente.business_name} (${cliente.cod_cliente})`;

    CATALOGO_CODES = await getCatalogCodes();

    const rows = await getHistory(cliente.cod_cliente);
    await renderTabla(rows);

    renderClienteSelectorHistorial(linked, cliente.cod_cliente, async (newClient) => {
      cliente = { cod_cliente: newClient.cod_cliente, business_name: newClient.business_name };
      try {
        localStorage.setItem("lk_vendor_selected_cod_cliente", String(newClient.cod_cliente || ""));
        localStorage.setItem("lk_vendor_selected_business_name", newClient.business_name || "");
        if (newClient.dto_vol != null) {
          localStorage.setItem("lk_vendor_selected_dto_vol", String(newClient.dto_vol));
        }
      } catch (e) {}
      $("cliente").innerText =
        `Cliente: ${cliente.business_name} (${cliente.cod_cliente})`;
      setStatus("Cargando...");
      const rows2 = await getHistory(cliente.cod_cliente);
      await renderTabla(rows2);
    });
  } catch (e) {
    console.error("Init crash:", e);
    setStatus("Error inesperado cargando historial. Ver consola.");
  }
}

// ====== Cola de agregados desde Historial (por COD) ======
const HISTORY_PENDING_KEY = "chef_pending_adds_cod_v1";

function readPendingAdds() {
  try {
    const raw = localStorage.getItem(HISTORY_PENDING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePendingAdds(arr) {
  try {
    localStorage.setItem(HISTORY_PENDING_KEY, JSON.stringify(arr));
  } catch (e) {
    console.warn("No se pudo guardar pending adds:", e);
  }
}

window.hDec = function (cod) {
  const el = document.getElementById(`hqty-${cod}`);
  if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) - 1);
};

window.hInc = function (cod) {
  const el = document.getElementById(`hqty-${cod}`);
  if (!el) return;
  el.value = Math.max(0, (parseInt(el.value, 10) || 0) + 1);
};

window.hAdd = function (cod) {
  const code = String(cod).trim();

  if (!CATALOGO_CODES.has(code)) return;

  const el = document.getElementById(`hqty-${code}`);
  const qty = el ? Math.max(0, parseInt(el.value, 10) || 0) : 0;

  if (qty <= 0) return;

  const list = readPendingAdds();
  const found = list.find((x) => String(x.cod).trim() === code);

  if (found) found.qty = (parseInt(found.qty, 10) || 0) + qty;
  else list.push({ cod: code, qty });

  writePendingAdds(list);

  const btn = document.getElementById(`hadd-${code}`);
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = "Agregado ✓";
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = prev;
      btn.disabled = false;
    }, 900);
  }
};

document.addEventListener("DOMContentLoaded", init);

window.addEventListener("storage", (e) => {
  if (e.key === "lk_vendor_selected_cod_cliente" && e.oldValue !== e.newValue) {
    location.reload();
  }
});
