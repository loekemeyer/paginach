"use strict";

/***********************
 * SUPABASE CONFIG
 ***********************/
const SUPABASE_URL = "https://nkhzocgdpwtgrmwleihr.supabase.co";

const SUPABASE_ANON_KEY =
  "sb_publishable_aThHtJLBKytg9k_6UdH2Eg_Use7f1zH"; // 👈 pegá completa la tuya

const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

// Segunda DB (Loekemeyer) — solo para sincronizar PIN por CUIT
const LOEKEMEYER_SUPABASE_URL = "https://kwkclwhmoygunqmlegrg.supabase.co";
const LOEKEMEYER_SUPABASE_ANON_KEY =
  "sb_publishable_mVX5MnjwM770cNjgiL6yLw_LDNl9pML";
const supabaseLoekemeyer = window.supabase.createClient(
  LOEKEMEYER_SUPABASE_URL,
  LOEKEMEYER_SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);


/***********************
 * GOOGLE SHEETS (PROXY)
 ***********************/
const SHEETS_PROXY_URL =
  "https://nkhzocgdpwtgrmwleihr.supabase.co/functions/v1/smooth-handler";

const SHEETS_ENTREGAS_PROXY_URL =
  "https://nkhzocgdpwtgrmwleihr.supabase.co/functions/v1/sheets-entregas-proxy";

const NOTIFY_NEW_ADDRESS_URL =
  "https://nkhzocgdpwtgrmwleihr.supabase.co/functions/v1/notify-new-address";

/***********************
 * UI CONSTANTS
 ***********************/
let WEB_ORDER_DISCOUNT = 0.02; // default fallback

/* ===== EXPO: flags de estado + completitud (portado desde LK) ===== */
// cualquier cliente del padrón vía "Elegir cliente" o crea uno con "Nuevo cliente".
const EXPO_MODE = true;
// Modo cliente-expo: activo cuando el cliente seleccionado es un cliente NUEVO
// de expo (está en expo_clientes_pendientes). En ese modo el pricing deja de ser
// "admin/precio lista" y pasa a cliente real: dto por ESCALA (según subtotal de
// lista, en vivo) + contado (-25%) OBLIGATORIO + web (-2%).
var _expoClientMode = false;      // cliente NUEVO de expo (escala + contado forzado)
var _expoActiveCustomer = false;  // hay un cliente REAL seleccionado (mostrar SU precio)
var _expoClientComplete = false;  // el cliente NUEVO de expo tiene TODOS los datos (salvo expreso)
var _expoScale = null; // [{desde, dto}] ordenado por desde asc

// Completitud automática de un cliente nuevo de expo: TODOS los campos son
// obligatorios salvo el Expreso de cada dirección de entrega. Opera sobre una
// fila de staging (expo_clientes_pendientes) o un objeto con los mismos campos.
function _expoDatosCompletos(d) {
  if (!d) return false;
  var req = [
    d.business_name, d.cuit, d.condicion_iva, d.vend, d.whatsapp, d.mail,
    d.direccion, d.numero, d.cp, d.localidad, d.provincia,
  ];
  for (var i = 0; i < req.length; i++) {
    if (!String(req[i] == null ? "" : req[i]).trim()) return false;
  }
  var dirs = Array.isArray(d.direcciones_entrega) ? d.direcciones_entrega : [];
  if (!dirs.length) return false;
  for (var j = 0; j < dirs.length; j++) {
    var a = dirs[j] || {};
    // Expreso NO es obligatorio (puede no haber uno fijo).
    if (
      !String(a.direccion || "").trim() ||
      !String(a.localidad || "").trim() ||
      !String(a.provincia || "").trim()
    )
      return false;
  }
  return true;
}

// Lista legible de lo que falta (para avisar al confirmar "Datos completados").
function _expoFaltantes(d) {
  var out = [];
  var map = [
    ["business_name", "Razón social"], ["cuit", "CUIT"],
    ["condicion_iva", "Condición IVA"], ["vend", "Vendedor"],
    ["whatsapp", "WhatsApp"], ["mail", "Mail"], ["direccion", "Calle"],
    ["numero", "Número"], ["cp", "C.P."], ["localidad", "Localidad"],
    ["provincia", "Provincia"],
  ];
  map.forEach(function (m) {
    if (!String(d[m[0]] == null ? "" : d[m[0]]).trim()) out.push(m[1]);
  });
  var dirs = Array.isArray(d.direcciones_entrega) ? d.direcciones_entrega : [];
  if (!dirs.length) out.push("una dirección de entrega");
  else {
    var bad = false;
    dirs.forEach(function (a) {
      a = a || {};
      if (
        !String(a.direccion || "").trim() ||
        !String(a.localidad || "").trim() ||
        !String(a.provincia || "").trim()
      )
        bad = true;
    });
    if (bad) out.push("dirección de entrega (calle/localidad/provincia)");
  }
  return out;
}

// Lee el formulario de alta a la forma que consumen _expoDatosCompletos/_expoFaltantes.
function _expoReadFormData() {
  function v(id) {
    var e = document.getElementById(id);
    return e ? String(e.value || "").trim() : "";
  }
  return {
    business_name: v("expoNewRazon"),
    cuit: v("expoNewCuit").replace(/[^0-9]/g, ""),
    condicion_iva: v("expoNewCondIva"),
    vend: v("expoNewVend"),
    whatsapp: v("expoNewWhatsapp"),
    mail: v("expoNewMail"),
    direccion: v("expoNewDirFiscal"),
    numero: v("expoNewNumFiscal"),
    cp: v("expoNewCpFiscal"),
    localidad: v("expoNewLocFiscal"),
    provincia: v("expoNewProvFiscal"),
    direcciones_entrega: _expoAddrCollect(),
  };
}

// Habilita el botón "Datos completados" (verde) SOLO cuando está todo completo
// (incluida la sucursal; el único opcional es el expreso). Corre en vivo.
function _expoNewSyncComplete() {
  var btn = document.getElementById("expoNewClose");
  if (!btn) return;
  btn.disabled = !_expoDatosCompletos(_expoReadFormData());
}

const BASE_IMG = `${SUPABASE_URL}/storage/v1/object/public/products-images/`;
const IMG_PARAMS = `?width=400&height=400&resize=contain&quality=75`;
const IMG_VERSION = (window.LK_CONFIG && window.LK_CONFIG.IMG_VERSION) || "9999-12-31-2";

/***********************
 * ORDEN FIJO (como pediste)
 ***********************/
const CATEGORY_ORDER = [
  "Abrelatas",
  "Peladores",
  "Sacacorchos",
  "Cortadores",
  "Ralladores",
  "Coladores",
  "Afiladores",
  "Utensilios",
  "Pinzas",
  "Destapadores",
  "Tapon Vino",
  "Repostería",
  "Madera",
  "Mate",
  "Accesorios",
  "Cuchillos de untar",
];



const UTENSILIOS_SUB_ORDER = [
  "Inoxidable",
  "Nylon",
];

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function getWebOrderDiscount() {
  try {
    const { data, error } = await supabaseClient
      .from("app_settings")
      .select("value")
      .eq("key", "web_order_discount")
      .single();

    if (error) throw error;
    return Number(data?.value) || 0;
  } catch (e) {
    console.warn("No se pudo leer web_order_discount, usando default 0.02", e);
    return 0.02;
  }
}

/***********************
 * STATE
 ***********************/
let products = []; // productos cargados
let currentSession = null; // sesión supabase
let isAdmin = false; // admin flag
let customerProfile = null; // {id, business_name, dto_vol, ...}
function isListPriceOnlyClient() {
  // EXPO: con un cliente real seleccionado, NO es precio-lista (muestra su precio).
  if (_expoActiveCustomer) return false;
  return isAdmin || String(customerProfile?.cod_cliente) === "5000";
}

const cart = []; // [{ productId: uuidString, qtyCajas }]

// Entrega desde DB (slots 1..25)
let deliveryChoice = { slot: "", label: "", direccionEntrega: "", zonaExpreso: "" };
let deliveryConfirmed = false;

let lastConfirmedOrder = null;
var successAnim = null;

let sortMode = "category"; // category | bestsellers | price_desc | price_asc

// Filtros UI (DESKTOP / estado aplicado)
let filterAll = true; // "Todos" ON por default
let filterCats = new Set(); // acumulativo
let searchTerm = ""; // buscador
let filterNewOnly = false; // ✅ NUEVOS (desktop + mobile)
let filterMyAssortment = false; // ✅ MI SURTIDO (18 meses)
let myAssortmentIds = null; // Set<string> de product_id

// ===== Anomaly Detection =====
const ANOMALY_THRESHOLD = 6;
let _anomalyCache = { customerId: null, map: null };

// ===== Upsell Popup =====
const UPSELL_CODES = ["598E","589E","566E","522E","539E","583E","536E","538E","540E"];

// ===== Mobile Filters (pendientes) =====
let pendingFilterAll = true;
let pendingFilterCats = new Set();
let pendingFilterNewOnly = false; // ✅ NUEVOS (overlay mobile)

/***********************
 * DOM HELPERS
 ***********************/
function $(id) {
  return document.getElementById(id);
}

function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }

function formatMoney(n) {
  return Math.round(Number(n || 0)).toLocaleString("es-AR");
}

function headerTwoLine(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length >= 2) {
    return `<span class="split-2line">${parts[0]}<br>${parts
      .slice(1)
      .join(" ")}</span>`;
  }
  return String(text || "");
}

function splitTwoWords(text) {
  const parts = String(text || "")
    .trim()
    .split(/\s+/);
  if (parts.length === 2) {
    return `<span class="split-2line">${parts[0]}<br>${parts[1]}</span>`;
  }
  return String(text || "");
}

function setOrderStatus(message, type = "") {
  const el = $("orderStatus");
  if (!el) return;

  el.classList.remove("ok", "err");
  if (type) el.classList.add(type);
  el.textContent = message || "";
}

/***********************
 * MOBILE MENU
 ***********************/
function toggleMobileMenu(forceOpen) {
  const menu = $("mobileMenu");
  const btn = $("hamburgerBtn");
  if (!menu || !btn) return;

  const willOpen =
    typeof forceOpen === "boolean"
      ? forceOpen
      : !menu.classList.contains("open");

  menu.classList.toggle("open", willOpen);
  menu.setAttribute("aria-hidden", willOpen ? "false" : "true");
  btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
}

function closeMobileMenu() {
  toggleMobileMenu(false);
}

function closeMobileUserMenu() {
  const m = $("mobileUserMenu");
  if (!m) return;

  m.classList.remove("open");
  m.setAttribute("aria-hidden", "true");
}

function toggleMobileUserMenu() {
  const m = $("mobileUserMenu");
  if (!m) return;

  const willOpen = !m.classList.contains("open");
  m.classList.toggle("open", willOpen);
  m.setAttribute("aria-hidden", willOpen ? "false" : "true");
}

window.closeMobileUserMenu = closeMobileUserMenu;

/***********************
 * SECTIONS
 ***********************/
function showSection(id) {
  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));

  const el = $(id);
  if (el) el.classList.add("active");

  closeCategoriesMenu();
  closeUserMenu();
  closeMobileMenu();
  closeFiltersOverlay();
  closeMobileUserMenu();

  // Cada cambio de "página" (carrito, perfil, pedidoConfirmado, etc.) tiene
  // que arrancar desde arriba — sino el usuario aterriza en una posición
  // de scroll que dejó en la página anterior y no ve el contenido nuevo.
  // Excepción: productos NO scrollea porque tiene su propio comportamiento
  // (goToProductsTop hace su scroll, navegación por categorías tampoco
  // debería resetear el scroll si el usuario está mirando un producto).
  if (id !== "productos") {
    try {
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch (e) {
      // Fallback para navegadores viejos que no soportan behavior:"instant"
      window.scrollTo(0, 0);
    }
  }

  // 🔥 CARGAR SUCURSALES EN CARRITO
  if (id === "carrito") {
    loadDeliveryOptions();
    // Refrescar lista del módulo "no llevás" cada vez que se abre el carrito
    _missingModuleAllPids = null;
    _missingModuleOffset = 0;
    if (typeof renderMissingAssortmentModule === "function") {
      renderMissingAssortmentModule();
    }
  }
}

function goToProductsTop() {
  showSection("productos");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/***********************
 * CUIT -> EMAIL INTERNO
 ***********************/
function normalizeCUIT(cuit) {
  return String(cuit || "")
    .trim()
    .replace(/\s+/g, "");
}

function cuitDigits(cuit) {
  return normalizeCUIT(cuit).replace(/\D/g, "");
}

function cuitToInternalEmail(cuit) {
  const digits = cuitDigits(cuit);
  if (!digits) return "";
  return `${digits}@cuit.loekemeyer`;
}

/***********************
 * LOGIN MODAL
 ***********************/
function openLogin() {
  setOrderStatus("");

  const err = $("loginError");
  if (err) {
    err.style.display = "none";
    err.innerText = "";
  }

  $("loginModal")?.classList.add("open");
  $("loginModal")?.setAttribute("aria-hidden", "false");
}

function closeLogin() {
  $("loginModal")?.classList.remove("open");
  $("loginModal")?.setAttribute("aria-hidden", "true");
}

function looksLikeCUIT(val) {
  const digits = String(val || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 11 && /^[\d\s\-]+$/.test(val);
}

/***********************
 * LOGIN MAESTRO (admin)
 * El admin entra como cualquier cliente (menos PPP) poniendo su CLAVE MAESTRA en
 * el campo CUIT y el CÓDIGO DE CLIENTE en la contraseña, con verificación por un
 * código de 6 dígitos que llega a su mail. La clave NO vive en este archivo: se
 * valida server-side en la Edge Function master-login (compara su hash sha256
 * contra el guardado en Vault). Si la clave es incorrecta, se trata como un
 * usuario inexistente (no se revela que el modo maestro existe).
 ***********************/
async function masterLoginCall(action, master, cod, code) {
  try {
    const res = await fetch(SUPABASE_URL + "/functions/v1/master-login", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ action, master, cod, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || "http_" + res.status };
    return { data };
  } catch (e) {
    return { error: "network" };
  }
}

async function intentarLoginMaestro(master, cod) {
  const codClean = String(cod).replace(/[\s.\-]/g, "");
  if (!/^\d{1,11}$/.test(codClean)) return false;
  const r = await masterLoginCall("send", master, codClean, null);
  if (r.error) {
    if (r.error === "invalid") return false;
    const msg =
      r.error === "no_client" ? "Ese código de cliente o CUIT no existe."
      : r.error === "not_allowed" ? "No se puede entrar como esa cuenta."
      : r.error === "rate_limited" ? "Demasiados intentos. Esperá 10 minutos."
      : (r.error === "mail_not_configured" || r.error === "mail_failed") ? "No se pudo enviar el código. Avisá a IT."
      : "No se pudo iniciar el acceso maestro.";
    const err = $("loginError");
    if (err) { err.innerText = msg; err.style.display = "block"; }
    return "pending";
  }
  mostrarMasterOtp(master, codClean);
  return "pending";
}

function mostrarMasterOtp(master, cod) {
  const ov = $("masterOtpOverlay");
  if (!ov) return;
  const codeInput = $("masterOtpCode");
  const errEl = $("masterOtpError");
  const verifyBtn = $("masterOtpVerify");
  const resendBtn = $("masterOtpResend");
  const cancelBtn = $("masterOtpCancel");
  if (codeInput) codeInput.value = "";
  if (errEl) errEl.innerText = "";
  ov.style.display = "flex";
  setTimeout(() => codeInput && codeInput.focus(), 60);

  async function verificar() {
    const code = (codeInput.value || "").replace(/\s+/g, "");
    if (!/^\d{6}$/.test(code)) { errEl.innerText = "Ingresá el código de 6 dígitos."; return; }
    verifyBtn.disabled = true; errEl.innerText = "Verificando…";
    const r = await masterLoginCall("verify", master, cod, code);
    if (r.error || !r.data || !r.data.email) {
      errEl.innerText = r.error === "invalid_code" ? "Código inválido o vencido." : "No se pudo verificar.";
      verifyBtn.disabled = false; codeInput.value = ""; codeInput.focus();
      return;
    }
    const { error } = await supabaseClient.auth.signInWithPassword({
      email: r.data.email, password: r.data.pin,
    });
    if (error) { errEl.innerText = "No se pudo iniciar sesión como ese cliente."; verifyBtn.disabled = false; return; }
    try { localStorage.setItem("is_logged", "1"); } catch (e) {}
    ov.style.display = "none";
    location.reload();
  }
  async function reenviar() {
    resendBtn.disabled = true; errEl.innerText = "";
    const r = await masterLoginCall("send", master, cod, null);
    errEl.innerText = r.error ? "No se pudo reenviar." : "Código reenviado.";
    setTimeout(() => { resendBtn.disabled = false; }, 3000);
  }
  function cerrar() { ov.style.display = "none"; verifyBtn.disabled = false; resendBtn.disabled = false; }
  verifyBtn.onclick = verificar;
  resendBtn.onclick = reenviar;
  cancelBtn.onclick = cerrar;
  codeInput.onkeydown = (e) => { if (e.key === "Enter") verificar(); };
}

async function login() {
  const input = ($("cuitInput")?.value || "").trim();
  const password = ($("passInput")?.value || "").trim();

  if (!input || !password) {
    const err = $("loginError");
    if (err) {
      err.innerText = "Completá CUIT/usuario y contraseña.";
      err.style.display = "block";
    }
    return;
  }

  let email = "";

  if (looksLikeCUIT(input)) {
    // --- Flujo CUIT (actual) ---
    email = cuitToInternalEmail(input);
    if (!email) {
      const err = $("loginError");
      if (err) {
        err.innerText = "CUIT inválido.";
        err.style.display = "block";
      }
      return;
    }
  } else {
    // --- Flujo usuario: buscar CUIT por username ---
    const { data: row, error: rpcErr } = await supabaseClient
      .rpc("lookup_cuit_by_username", { p_username: input.toLowerCase() });

    if (rpcErr || !row) {
      // ¿Login maestro? Clave compleja en el campo CUIT + código de cliente en la
      // contraseña. Si la clave maestra es válida, dispara el código por mail.
      const maestro = await intentarLoginMaestro(input, password);
      if (maestro === "pending") return;
      const err = $("loginError");
      if (err) {
        err.innerText = rpcErr
          ? "Error buscando usuario: " + rpcErr.message
          : "Usuario no encontrado.";
        err.style.display = "block";
      }
      return;
    }

    // La RPC devuelve el CUIT (text); armar el email interno con él.
    email = cuitToInternalEmail(row);
    if (!email) {
      const err = $("loginError");
      if (err) {
        err.innerText = "CUIT inválido para ese usuario.";
        err.style.display = "block";
      }
      return;
    }
  }

  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    const err = $("loginError");
    if (err) {
      err.innerText = "CUIT/usuario o contraseña incorrectos.";
      err.style.display = "block";
    }
    return;
  }

  currentSession = data.session || null;

  // ✅ marca que hubo login
  localStorage.setItem("is_logged", "1");

  closeLogin();

  // limpiar búsqueda
  searchTerm = "";
  const ns = $("navSearch");
  if (ns) ns.value = "";

  // onAuthStateChange (SIGNED_IN) se encarga del refresh completo en paralelo.
  // No duplicamos refreshAuthState/updateCart aca para no hacer el doble trabajo.
}

/***********************
 * LOGOUT
 ***********************/
async function logout() {
  if (window.__isLoggingOut) return;
  window.__isLoggingOut = true;

  try {
    const signOutPromise = supabaseClient.auth.signOut().catch(() => {});
    await Promise.race([
      signOutPromise,
      new Promise((r) => setTimeout(r, 1200)),
    ]);

    Object.keys(localStorage)
      .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
      .forEach((k) => localStorage.removeItem(k));

    Object.keys(sessionStorage)
      .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
      .forEach((k) => sessionStorage.removeItem(k));

    currentSession = null;
    isAdmin = false;
    customerProfile = null;
    deliveryChoice = { slot: "", label: "", direccionEntrega: "", zonaExpreso: "" };
    deliveryConfirmed = false;
    localStorage.removeItem("is_logged");
    localStorage.removeItem("lk_vendor_selected_cod_cliente");
    localStorage.removeItem("lk_vendor_selected_business_name");
    localStorage.removeItem("lk_vendor_selected_dto_vol");
    localStorage.removeItem("lk_expo_selected_client"); // EXPO

    // Vaciar carrito
    cart.length = 0;
    localStorage.removeItem(CART_LS_KEY);

    if ($("customerNote")) $("customerNote").innerText = "";
    if ($("helloNavText")) $("helloNavText").innerText = "";
    if ($("loginBtn")) $("loginBtn").style.display = "inline";
    if ($("userBox")) $("userBox").style.display = "none";

    closeUserMenu();
    resetShippingSelect();

    // reset filtros
    filterAll = true;
    filterCats.clear();
    searchTerm = "";
    setSearchInputValue("");

    renderCategoriesMenu();
    renderCategoriesSidebar();
    renderProducts();
    updateCart();

    showSection("productos");

    setTimeout(() => location.reload(), 50);
  } catch (e) {
    console.error("logout error:", e);
    setOrderStatus(
      "No se pudo cerrar sesión. Probá recargando la página.",
      "err",
    );
    window.__isLoggingOut = false;
  }
}

/***********************
 * AUTH/PROFILE HELPERS
 ***********************/
async function initAuthUI() {
  const authBox = document.getElementById("authBox");
  if (!authBox) return;

  const { data, error } = await supabaseClient.auth.getSession();
  const session = data?.session || null;

  if (session?.user) {
    authBox.innerHTML = `<span>${esc(session.user.email)}</span>`;
  } else {
    authBox.innerHTML = `<button id="btnLogin">Iniciar sesión</button>`;
  }

  authBox.style.visibility = "visible";
}

initAuthUI();


async function refreshAuthState(preloadedSession) {
  if (preloadedSession !== undefined) {
    currentSession = preloadedSession;
  } else {
    const { data } = await supabaseClient.auth.getSession();
    currentSession = data.session || null;
  }

  if (!currentSession) {
    isAdmin = false;
    customerProfile = null;
    deliveryChoice = { slot: "", label: "", direccionEntrega: "", zonaExpreso: "" };
    deliveryConfirmed = false;
    const clienteNuevoRow = $("clienteNuevoRow");
    const clienteNuevoInput = $("clienteNuevoInput");
    if (clienteNuevoRow) clienteNuevoRow.style.display = "none";
    if (clienteNuevoInput) clienteNuevoInput.value = "";

    syncAdminCheckoutUI();

    if ($("loginBtn")) $("loginBtn").style.display = "inline";
    if ($("userBox")) $("userBox").style.display = "none";
    if ($("ctaCliente")) $("ctaCliente").style.display = "inline-flex";
    if ($("helloNavBtn")) $("helloNavBtn").innerText = "";
    if ($("customerNote")) $("customerNote").innerText = "";
    if ($("menuMyOrders")) $("menuMyOrders").style.display = "none";

    resetShippingSelect();
    return;
  }

  // Paralelizar las dos consultas (son independientes)
  const [adminRes, custRes] = await Promise.all([
    supabaseClient
      .from("admins")
      .select("auth_user_id")
      .eq("auth_user_id", currentSession.user.id)
      .maybeSingle(),
    supabaseClient
      .from("customers")
      .select(
        "id,business_name,dto_vol,cod_cliente,cuit,direccion_fiscal,localidad,vend,mail,debt,payment_term,credit_limit",
      )
      .eq("auth_user_id", currentSession.user.id)
      .maybeSingle(),
  ]);

  isAdmin = !!adminRes.data && !adminRes.error;

  // Mostrar/ocultar link a panel admin
  const menuAdmin = $("menuAdminPanel");
  if (menuAdmin) menuAdmin.style.display = isAdmin ? "block" : "none";

  const clienteNuevoRow = $("clienteNuevoRow");
  const clienteNuevoInput = $("clienteNuevoInput");

  if (clienteNuevoRow) {
    clienteNuevoRow.style.display = isAdmin ? "block" : "none";
  }

  if (clienteNuevoInput && !isAdmin) {
    clienteNuevoInput.value = "";
  }
  syncAdminCheckoutUI();

  customerProfile = custRes.data || null;
  // Snapshot del perfil propio del vendedor para poder volver desde "Pedir para"
  _vendorOwnProfile = customerProfile ? Object.assign({}, customerProfile) : null;

  if ($("loginBtn")) $("loginBtn").style.display = "none";
  if ($("userBox")) $("userBox").style.display = "inline-flex";
  if ($("ctaCliente")) $("ctaCliente").style.display = "none";

  const name = (customerProfile?.business_name || "").trim();
  if ($("helloNavText"))
    $("helloNavText").innerText = name ? `Hola, ${name} !` : "Hola!";

  if ($("menuMyOrders")) $("menuMyOrders").style.display = "block";

  // Aplicar visibilidad del menu user (Historial / Sugerencias solo para clientes)
  if (typeof applyProfileVendorVisibility === "function") applyProfileVendorVisibility();
  // "Pedidos Clientes" + items vendor en el dropdown — al login (sin esperar a abrir perfil)
  if (typeof updateMenuNotifVisibility === "function") updateMenuNotifVisibility();

  const note = $("customerNote");
  if (note) {
    if (!currentSession) note.innerText = "";
    else if (isAdmin) note.innerText = "Modo Administrador";
    else if (Number(customerProfile?.dto_vol || 0) > 0) note.innerText = "Ya está aplicado tu Dto x Volumen";
    else note.innerText = "";
  }

  // NOTA: loadDeliveryOptions se invoca al entrar al carrito (showSection "carrito")
  // y loadMyAssortmentIds se invoca al activar el filtro "Mi surtido".
  // No los cargamos aca para no bloquear el refresh/login.
}

function hasVendorSelection() {
  try { return !!(localStorage.getItem("lk_vendor_selected_cod_cliente") || "").trim(); }
  catch(e) { return false; }
}

function getDtoVol() {
  // Si un admin/vendedor seleccionó un cliente, usar el dto del cliente
  // EXPO: con un cliente de expo activo, usar SU dto (escala o real), no 0.
  if (isAdmin && !hasVendorSelection() && !_expoActiveCustomer) return 0;
  return Number(customerProfile?.dto_vol || 0);
}

function unitYourPrice(listPrice) {
  const dto = getDtoVol();
  return Number(listPrice || 0) * (1 - dto);
}

/***********************
 * MÉTODO DE PAGO
 ***********************/
function getPaymentDiscount() {
  if (_expoClientMode) return 0.25; // EXPO cliente nuevo: contado -25% forzado
  if (isAdmin && !hasVendorSelection() && !_expoActiveCustomer) return 0;

  const sel = $("paymentSelect");
  if (!sel) return 0;

  const v = parseFloat(sel.value);
  return isNaN(v) ? 0 : v;
}

function getPaymentMethodText() {
  if (_expoClientMode) return "Contado"; // EXPO cliente nuevo
  if (isAdmin && !hasVendorSelection() && !_expoActiveCustomer) return "Contado";

  const sel = $("paymentSelect");
  if (!sel) return "";

  const opt = sel.options[sel.selectedIndex];
  return opt?.textContent ? opt.textContent.trim() : "";
}

function getPaymentMethodCode() {
  if (_expoClientMode) return 10; // EXPO cliente nuevo: Contado -25% (código CHEF)
  if (isAdmin && !hasVendorSelection() && !_expoActiveCustomer) return 10;

  const sel = $("paymentSelect");
  const v = sel ? String(sel.value) : "";

  // Códigos CHEF (ver tabla CHEF↔Loeke)
  if (v === "0.25") return 10; // Contado -25%
  if (v === "0.20") return 11; // 15 a 30 días -20%
  if (v === "0.15") return 12; // 31 a 45 días -15%
  if (v === "0.10") return 13; // 46 a 60 días -10%
  if (v === "0.05") return 14; // E-Cheq 90 días -5%
  if (v === "0.00") return 15; // E-Cheq 120 días 0%
  if (v === "LATER") return 18; // Prefiero no decidir ahora

  return 0; // desconocido
}

function setPaymentByValue(val) {
  const sel = $("paymentSelect");
  if (!sel) return;

  sel.value = String(val);
  syncPaymentButtons();
  updateCart();
  refreshSubmitEnabled();
}

function syncPaymentButtons() {
  const sel = $("paymentSelect");
  const wrap = $("paymentButtons");
  if (!sel || !wrap) return;

  const current = String(sel.value);
  wrap.querySelectorAll(".pay-btn").forEach((btn) => {
    btn.classList.toggle("active", String(btn.dataset.value) === current);
  });
}

function syncAdminCheckoutUI() {
  const hideAdmin = isAdmin && !hasVendorSelection();
  const paymentRow = $("paymentRow");
  const webNoteBox = $("webNoteBox");
  const webDiscountLine = $("webDiscountLine");
  const paymentDiscountLine = $("paymentDiscountLine");
  const totalNoDiscountLine = $("totalNoDiscountLine");
  const totalDiscountsLine = $("totalDiscountsLine");

  if (paymentRow) paymentRow.style.display = hideAdmin ? "none" : "";
  if (webNoteBox) webNoteBox.style.display = hideAdmin ? "none" : "";
  if (webDiscountLine) webDiscountLine.style.display = hideAdmin ? "none" : "";
  if (paymentDiscountLine)
    paymentDiscountLine.style.display = hideAdmin ? "none" : "";
  if (totalNoDiscountLine)
    totalNoDiscountLine.style.display = hideAdmin ? "none" : "";
  if (totalDiscountsLine)
    totalDiscountsLine.style.display = hideAdmin ? "none" : "";
}

/***********************
 * PRODUCTS (DB/RPC)
 ***********************/
function mapProduct(p) {
  return {
    id: p.id,
    cod: p.cod,
    category: p.category || "Sin categoría",
    subcategory: p.subcategory && String(p.subcategory).trim()
      ? String(p.subcategory).trim()
      : null,
    ranking: p.ranking == null || p.ranking === "" ? null : Number(p.ranking),
    orden_catalogo: p.orden_catalogo == null || p.orden_catalogo === ""
      ? null
      : Number(p.orden_catalogo),
    description: p.description,
    list_price: p.list_price,
    uxb: p.uxb,
    images: Array.isArray(p.images) ? p.images : [],
    badge_status: p.badge_status
      ? String(p.badge_status).trim().toUpperCase()
      : null,
    active: p.active !== undefined ? !!p.active : undefined,
  };
}

const PRODUCTS_CACHE_KEY = "chef_products_cache";
const PRODUCTS_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function _getProductsCache(logged) {
  try {
    const raw = sessionStorage.getItem(PRODUCTS_CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (cached.logged !== logged) return null;
    if (Date.now() - cached.ts > PRODUCTS_CACHE_TTL) return null;
    return cached.data;
  } catch { return null; }
}

function _setProductsCache(data, logged) {
  try {
    sessionStorage.setItem(PRODUCTS_CACHE_KEY, JSON.stringify({
      data, logged, ts: Date.now(),
    }));
  } catch { /* sessionStorage lleno, ignorar */ }
}

async function loadProductsFromDB() {
  // Skeleton mientras hace fetch (solo la primera vez, cuando aún no hay products)
  if (typeof renderProductSkeletons === "function" && (!products || !products.length)) {
    renderProductSkeletons(8);
  }
  const logged = !!currentSession;

  // Intentar caché primero
  const cached = _getProductsCache(logged);
  if (cached) {
    products = cached.map(mapProduct);
    return;
  }

  if (!logged) {
    // Público: intenta RPC
    const { data, error } = await supabaseClient.rpc(
      "get_products_public_sorted",
      { sort_mode: sortMode },
    );

    if (!error && Array.isArray(data) && data.length) {
      _setProductsCache(data, logged);
      products = data.map(mapProduct);
      return;
    }

    // ✅ Fallback: consulta directa (requiere policy SELECT para anon)
    if (error)
      console.warn("Public RPC failed, fallback to direct select:", error);

    const { data: rows, error: err2 } = await supabaseClient
      .from("products")
      .select(
        "id,cod,category,subcategory,ranking,orden_catalogo,description,list_price,uxb,images,badge_status",
      )
      .eq("active", true);

    if (err2) {
      console.error("Public select failed:", err2);
      products = [];
      return;
    }

    _setProductsCache(rows, logged);
    products = (rows || []).map(mapProduct);
    return;
  }

  // ✅ LOGUEADO: traer todos (sort se hace en JS)
  let q = supabaseClient
    .from("products")
    .select(
      "id,cod,category,subcategory,ranking,orden_catalogo,description,list_price,uxb,images,badge_status,active",
    )
    .eq("active", true);

  if (sortMode === "bestsellers") {
    q = q.order("ranking", { ascending: true, nullsFirst: false });
  } else if (sortMode === "price_desc") {
    q = q.order("category", { ascending: true });
    q = q.order("list_price", { ascending: false, nullsFirst: false });
    q = q.order("orden_catalogo", { ascending: true, nullsFirst: false });
  } else if (sortMode === "price_asc") {
    q = q.order("category", { ascending: true });
    q = q.order("list_price", { ascending: true, nullsFirst: false });
    q = q.order("orden_catalogo", { ascending: true, nullsFirst: false });
  } else {
    q = q.order("category", { ascending: true });
    q = q.order("orden_catalogo", { ascending: true, nullsFirst: false });
    q = q.order("description", { ascending: true });
  }

  const { data, error } = await q;

  if (error) {
    console.error("Error loading products:", error);
    products = [];
    return;
  }

  _setProductsCache(data, logged);
  products = (data || []).map(mapProduct);
}

/***********************
 * CATEGORÍAS HELPERS (orden fijo + fallback)
 ***********************/
function getOrderedCategoriesFrom(list) {
  const presentCats = new Set(
    (list || []).map((p) => String(p.category || "").trim()).filter(Boolean),
  );

  const inOrder = CATEGORY_ORDER.filter((cat) => presentCats.has(cat));

  const extras = Array.from(presentCats)
    .filter((cat) => !CATEGORY_ORDER.includes(cat))
    .sort((a, b) => a.localeCompare(b, "es"));

  // devuelve un array plano, en el orden correcto
  return [...inOrder, ...extras];
}

function slugifyCategory(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]/g, "");
}

function normalizeText(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getSortComparator() {
  return (a, b) => {
    const aOrd =
      a.orden_catalogo === null || a.orden_catalogo === undefined
        ? 999999
        : Number(a.orden_catalogo);
    const bOrd =
      b.orden_catalogo === null || b.orden_catalogo === undefined
        ? 999999
        : Number(b.orden_catalogo);

    const aRank =
      a.ranking === null || a.ranking === undefined
        ? 999999
        : Number(a.ranking);
    const bRank =
      b.ranking === null || b.ranking === undefined
        ? 999999
        : Number(b.ranking);

    const aPrice =
      a.list_price === null || a.list_price === undefined
        ? -1
        : Number(a.list_price);
    const bPrice =
      b.list_price === null || b.list_price === undefined
        ? -1
        : Number(b.list_price);

    if (sortMode === "bestsellers") {
      return (
        aRank - bRank ||
        aOrd - bOrd ||
        String(a.description || "").localeCompare(
          String(b.description || ""),
          "es",
        )
      );
    }

    if (sortMode === "price_desc") {
      return (
        bPrice - aPrice ||
        aOrd - bOrd ||
        String(a.description || "").localeCompare(
          String(b.description || ""),
          "es",
        )
      );
    }

    if (sortMode === "price_asc") {
      const aP = aPrice < 0 ? 999999999 : aPrice;
      const bP = bPrice < 0 ? 999999999 : bPrice;

      return (
        aP - bP ||
        aOrd - bOrd ||
        String(a.description || "").localeCompare(
          String(b.description || ""),
          "es",
        )
      );
    }

    return (
      aOrd - bOrd ||
      String(a.description || "").localeCompare(
        String(b.description || ""),
        "es",
      )
    );
  };
}

// Actualiza clases .active y checkboxes in-place en sidebar y menu sin
// reconstruir el innerHTML. Evita que al togglear una categoria se destruya
// el checkbox que acabas de clickear (lo que desencadena scroll-jump).
function updateCategoriesActiveState() {
  const list = $("categoriesSidebarList");
  if (list) {
    const allInp = list.querySelector("#toggleAll");
    if (allInp) {
      allInp.checked = filterAll;
      allInp.closest(".toggle-row")?.classList.toggle("active", filterAll);
    }
    list.querySelectorAll(".toggle-cat").forEach((inp) => {
      const isOn = filterCats.has(inp.dataset.cat);
      inp.checked = isOn;
      inp.closest(".toggle-row")?.classList.toggle("active", isOn);
    });
  }

  const menu = $("categoriesMenu");
  if (menu) {
    const ddAll = menu.querySelector("#ddToggleAll");
    if (ddAll) ddAll.checked = filterAll;
    menu.querySelectorAll(".dd-toggle-cat").forEach((inp) => {
      inp.checked = filterCats.has(inp.dataset.cat);
    });
  }
}

function renderCategoriesMenu() {
  const menu = $("categoriesMenu");
  if (!menu) return;

  const ordered = getOrderedCategoriesFrom(products);

  menu.innerHTML = `
    <div>
      <label class="dd-toggle-row dd-chip">
        <span>Todos los artículos</span>
        <input type="checkbox" id="ddToggleAll" ${filterAll ? "checked" : ""}>
      </label>

      <div class="dd-sep"></div>

      <div class="dd-cats-grid">
        ${ordered
          .map(
            (cat) => `
              <label class="dd-chip">
                <span>${esc(cat)}</span>
                <input
                  type="checkbox"
                  class="dd-toggle-cat"
                  data-cat="${esc(cat)}"
                  ${filterCats.has(cat) ? "checked" : ""}
                >
              </label>
            `,
          )
          .join("")}
      </div>
    </div>
  `;

  const ddAll = $("ddToggleAll");
  if (ddAll) {
    ddAll.addEventListener("change", () => {
      filterAll = ddAll.checked;
      if (filterAll) filterCats.clear();
      if (!filterAll && filterCats.size === 0) filterAll = true;

      updateCategoriesActiveState();
      renderProducts();
    });
  }

  menu.querySelectorAll(".dd-toggle-cat").forEach((inp) => {
    inp.addEventListener("change", () => {
      const cat = inp.dataset.cat;
      if (inp.checked) filterCats.add(cat);
      else filterCats.delete(cat);

      if (filterCats.size > 0) filterAll = false;
      if (filterCats.size === 0) filterAll = true;

      updateCategoriesActiveState();
      renderProducts();
    });
  });
}

/***********************
 * SIDEBAR CATEGORÍAS (desktop)
 ***********************/
function renderCategoriesSidebar() {
  const list = $("categoriesSidebarList");
  if (!list) return;

  const ordered = getOrderedCategoriesFrom(products);

  list.innerHTML = `
    <label class="toggle-row ${filterAll ? "active" : ""}">
      <span class="toggle-text">Todos los artículos</span>
      <input type="checkbox" id="toggleAll" ${filterAll ? "checked" : ""}>
      <span class="toggle-ui"></span>
    </label>

    <div class="toggle-sep"></div>

    ${ordered
      .map(
        (cat) => `
          <label class="toggle-row ${filterCats.has(cat) ? "active" : ""}">
            <span class="toggle-text">${esc(cat)}</span>
            <input
              type="checkbox"
              class="toggle-cat"
              data-cat="${esc(cat)}"
              ${filterCats.has(cat) ? "checked" : ""}
            >
            <span class="toggle-ui"></span>
          </label>
        `,
      )
      .join("")}
  `;

  const all = $("toggleAll");
  if (all) {
    all.addEventListener("change", () => {
      filterAll = all.checked;
      if (filterAll) filterCats.clear();
      if (!filterAll && filterCats.size === 0) filterAll = true;

      updateCategoriesActiveState();
      renderProducts();
    });
  }

  list.querySelectorAll(".toggle-cat").forEach((inp) => {
    inp.addEventListener("change", () => {
      const cat = inp.dataset.cat;
      if (inp.checked) filterCats.add(cat);
      else filterCats.delete(cat);

      if (filterCats.size > 0) filterAll = false;
      if (filterCats.size === 0) filterAll = true;

      updateCategoriesActiveState();
      renderProducts();
    });
  });
}

/***********************
 * USER MENU
 ***********************/
function closeUserMenu() {
  const menu = $("userMenu");
  if (!menu) return;
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
}

function toggleUserMenu() {
  const menu = $("userMenu");
  if (!menu) return;

  const open = menu.classList.contains("open");
  closeCategoriesMenu();
  menu.classList.toggle("open", !open);
  menu.setAttribute("aria-hidden", !open ? "false" : "true");

  const btn = $("helloNavBtn");
  if (btn) btn.setAttribute("aria-expanded", !open ? "true" : "false");
}

/***********************
 * PERFIL (UI)
 ***********************/
function waLink(msg) {
  const text = encodeURIComponent(String(msg || "").trim());
  return `https://wa.me/5491131181021?text=${text}`;
}

async function loadMyOrdersUI() {
  const box = $("myOrdersBox");
  const toggleBtn = $("btnOrdersToggle");

  if (!box) return;

  if (!currentSession || !customerProfile?.id) {
    box.textContent = "Iniciá sesión para ver tus pedidos.";
    return;
  }

  box.textContent = "Cargando…";

  try {
    const { data, error } = await supabaseClient
      .from("orders")
      .select("id, created_at, total")
      .eq("customer_id", customerProfile.id)
      .order("created_at", { ascending: false });

    if (error) throw error;

    if (!data || !data.length) {
      box.innerHTML = `
        <div class="empty-state-mini">
          <svg class="empty-state-mini-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="60" cy="60" r="48" fill="none" stroke="#222" stroke-width="7"/>
            <circle cx="46" cy="52" r="5" fill="#222"/>
            <circle cx="74" cy="52" r="5" fill="#222"/>
            <path d="M44 80 Q60 66 76 80" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>
          </svg>
          <div class="empty-state-mini-text">
            <strong>No hay pedidos todavía</strong>
            <span>Cuando hagas tu primer pedido aparecerá acá.</span>
          </div>
        </div>
      `;
      if (toggleBtn) toggleBtn.style.display = "none";
      return;
    }

    // Tracking: lookup directo en order_tracking por np_number = String(order.id)
    // Columnas reales en order_tracking: np_number, status, fecha_entrega
    // Valores de status: "recibido" | "programado" | "entregado"
    const orderIds = data.map((o) => o.id);
    const orderIdsAsNps = orderIds.map((id) => String(id));
    const trackByNp = {};
    if (orderIdsAsNps.length) {
      try {
        const { data: tracks } = await supabaseClient
          .from("order_tracking")
          .select("np_number, status, fecha_entrega")
          .in("np_number", orderIdsAsNps);
        (tracks || []).forEach((t) => (trackByNp[t.np_number] = t));
      } catch (e) {
        console.warn("[orders] no se pudo leer order_tracking:", e);
      }
    }

    function getOrderStage(orderId) {
      const t = trackByNp[String(orderId)];
      if (!t) return { stage: 0, label: "Recibido", subtitle: "" };
      const fechaStr = t.fecha_entrega
        ? new Date(t.fecha_entrega).toLocaleDateString("es-AR")
        : "";
      if (t.status === "entregado") {
        return { stage: 2, label: "Entregado", subtitle: fechaStr ? "el " + fechaStr : "" };
      }
      if (t.status === "programado") {
        return { stage: 1, label: "Programado", subtitle: fechaStr ? "para " + fechaStr : "" };
      }
      return { stage: 0, label: "Recibido", subtitle: "" };
    }

    function renderStepper(st) {
      const parts = [];
      for (let i = 0; i <= 2; i++) {
        if (i > 0) {
          parts.push('<span class="o-line ' + (i <= st.stage ? "done" : "") + '"></span>');
        }
        parts.push(
          '<span class="o-dot ' + (i <= st.stage ? "done" : "") +
            (i === st.stage ? " current" : "") + '" title="' +
            ["Recibido", "Programado", "Entregado"][i] + '"></span>'
        );
      }
      return '<div class="o-stepper">' + parts.join("") + "</div>";
    }

    let showAll = false;

    function render() {
      const list = showAll ? data : data.slice(0, 3);

      box.innerHTML = list
        .map((order) => {
          const fecha = new Date(order.created_at);
          const fechaStr = fecha.toLocaleDateString("es-AR");
          const totalStr = Math.round(Number(order.total || 0)).toLocaleString(
            "es-AR",
          );
          const st = getOrderStage(order.id);
          const stepper = renderStepper(st);
          const sub = st.subtitle
            ? '<span class="o-stage-sub">' + esc(st.subtitle) + "</span>"
            : "";

          return `
  <div class="order-row">
    <div class="order-col order-date">${esc(fechaStr)}</div>
    <div class="order-col order-total">$ ${esc(totalStr)}</div>
    <div class="order-col order-action">
      <div class="hist-actions">
        <button class="hist-btn subtle" data-download-order="${esc(order.id)}">
          Descargar Pedido
        </button>
        <button class="hist-btn" data-repeat="${esc(order.id)}">
          Repetir Pedido
        </button>
      </div>
    </div>
    <div class="order-col order-tracking" data-stage="${st.stage}">
      ${stepper}
      <span class="o-stage-label o-stage-${st.stage}">${esc(st.label)}</span>
      ${sub}
    </div>
  </div>
`;
        })
        .join("");
    }

    render();

    if (toggleBtn) {
      toggleBtn.style.display = data.length > 3 ? "inline-block" : "none";
      toggleBtn.textContent = "Ver Más";

      toggleBtn.onclick = () => {
        showAll = !showAll;
        toggleBtn.textContent = showAll ? "Ver Menos" : "Ver Más";
        render();
      };
    }

    // Evento repetir/descargar pedido (evitar listeners duplicados)
    if (!box._orderHandler) {
      box._orderHandler = async (e) => {
        const repeatId = e.target.dataset.repeat;
        if (repeatId) {
          await repeatOrder(repeatId);
          return;
        }
        const downloadId = e.target.dataset.downloadOrder;
        if (downloadId) {
          await descargarComprobantePedido(downloadId);
        }
      };
      box.addEventListener("click", box._orderHandler);
    }
  } catch (err) {
    box.textContent = "Error cargando pedidos.";
    console.error(err);
  }
}

async function repeatOrder(orderId) {
  try {
    // Pedimos varias posibles columnas de cantidad para cubrir tu esquema real
    const { data, error } = await supabaseClient
      .from("order_items")
      .select("product_id, cajas")
      .eq("order_id", orderId);

    if (error) throw error;
    if (!data || !data.length) {
      alert("Ese pedido no tiene items para repetir.");
      return;
    }

    // Vaciar carrito actual
    cart.splice(0, cart.length);

    // Agregar productos al carrito
    data.forEach((it) => {
      const cajas = Number(
        it.cajas ??
          it.qtyCajas ??
          it.qty_cajas ??
          it.cantidad ??
          it.qty ??
          it.cajas_pedidas ??
          0,
      );

      if (!it.product_id || !cajas) return;

      cart.push({
        productId: it.product_id,
        qtyCajas: Math.max(1, Math.round(cajas)),
      });
    });

    // Refrescar UI
    updateCart();
    renderProducts();

    // Ir al carrito
    showSection("carrito");
  } catch (err) {
    console.error("repeatOrder error:", err);
    alert("No se pudo repetir el pedido.");
  }
}

async function loadMyAddressesUI() {
  const box = $("myAddressesBox");
  if (!box) return;

  if (!currentSession || !customerProfile?.id) {
    box.innerHTML = "Iniciá sesión para ver tus sucursales.";
    return;
  }

  box.innerHTML = "Cargando…";

  const { data, error } = await supabaseClient
    .from("customer_delivery_addresses")
    .select("slot,label,direccion_entrega,zona_expreso,pending_isis")
    .eq("customer_id", customerProfile.id)
    .order("slot", { ascending: true });

  if (error) {
    box.innerHTML = "No se pudieron cargar las sucursales.";
    return;
  }

  const rows = data || [];
  if (!rows.length) {
    box.innerHTML = `
      <div class="empty-state-mini">
        <svg class="empty-state-mini-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="60" cy="60" r="48" fill="none" stroke="#222" stroke-width="7"/>
          <circle cx="46" cy="52" r="5" fill="#222"/>
          <circle cx="74" cy="52" r="5" fill="#222"/>
          <path d="M44 80 Q60 66 76 80" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>
        </svg>
        <div class="empty-state-mini-text">
          <strong>No tenés sucursales cargadas</strong>
          <span>Agregá una sucursal para poder hacer pedidos.</span>
        </div>
      </div>
    `;
    return;
  }

  // Slice: por default mostrar solo 8 + botón "Ver Más" para expandir
  var ADDR_INITIAL = 8;
  var showAllAddr = false;
  function renderAddrList() {
    var visible = showAllAddr ? rows : rows.slice(0, ADDR_INITIAL);
    var listHtml = visible
      .map(
        (r) => `
      <div class="addr-item${r.pending_isis ? ' addr-item--pending' : ''}">
        <span class="addr-slot">${esc(r.slot)}</span>
        <div class="addr-info">
          <span class="addr-label">${esc(r.label || "—")}</span>
          ${r.zona_expreso ? `<span class="addr-meta">${esc(r.zona_expreso)}</span>` : ""}
        </div>
        ${r.pending_isis ? '<span class="addr-pending" title="Pendiente de confirmación administrativa">⏳</span>' : ""}
      </div>
    `,
      )
      .join("");
    box.innerHTML = `<div class="addr-list" data-count="${visible.length}">${listHtml}</div>`;
  }
  renderAddrList();

  // Toggle Ver Más / Ver Menos en el wrapper de acciones de la card
  var toggleBtn = document.getElementById("btnAddressesToggle");
  if (toggleBtn) {
    if (rows.length > ADDR_INITIAL) {
      toggleBtn.style.display = "";
      toggleBtn.textContent = "Ver Más";
      toggleBtn.onclick = function () {
        showAllAddr = !showAllAddr;
        toggleBtn.textContent = showAllAddr ? "Ver Menos" : "Ver Más";
        renderAddrList();
      };
    } else {
      toggleBtn.style.display = "none";
    }
  }
}

async function changePasswordUI() {
  if (window.__changingPass) return;
  window.__changingPass = true;
  const statusEl = document.getElementById("passStatus");
  const btn = document.getElementById("btnChangePass");

  const p1 = String(document.getElementById("newPass1")?.value || "").trim();
  const p2 = String(document.getElementById("newPass2")?.value || "").trim();

  const setStatus = (t) => {
    if (statusEl) statusEl.textContent = t;
  };

  // Validaciones
  if (!currentSession) {
    setStatus("Tenés que iniciar sesión.");
    window.__changingPass = false;
    return;
  }
  if (!p1 || !p2) {
    setStatus("Completá ambos campos.");
    window.__changingPass = false;
    return;
  }
  if (!/^\d+$/.test(p1) || !/^\d+$/.test(p2)) {
    setStatus("La contraseña debe ser solo numérica.");
    window.__changingPass = false;
    return;
  }
  if (p1.length < 6) {
    setStatus("La contraseña debe tener al menos 6 números.");
    window.__changingPass = false;
    return;
  }
  if (p1 !== p2) {
    setStatus("Las contraseñas no coinciden.");
    window.__changingPass = false;
    return;
  }

  btn && (btn.disabled = true);
  setStatus("Guardando…");

  try {
    // 1) Obtener sesión fresca (token)
    const { data: sessData, error: sessErr } =
      await supabaseClient.auth.getSession();
    if (sessErr) throw sessErr;

    let session = sessData?.session;

    // si por alguna razón no hay session, pedimos re-login
    if (!session?.access_token) {
      setStatus(
        "⚠️ Tu sesión no está disponible. Cerrá sesión e iniciá sesión de nuevo.",
      );
      return;
    }

    // 2) Llamada directa a Supabase Auth (PUT /auth/v1/user)
    const controller = new AbortController();
    const TIMEOUT_MS = 15000;
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

    // Si tenés el PIN actual guardado en customerProfile, evitamos setear el mismo
    const pinActual = String(customerProfile?.pin ?? "").trim();
    if (pinActual && String(p1) === pinActual) {
      setStatus("❌ El PIN nuevo no puede ser igual al actual.");
      btn && (btn.disabled = false);
      window.__changingPass = false;
      return;
    }

    const resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: "PUT",
      signal: controller.signal,
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: p1 }),
    });

    clearTimeout(t);

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Auth ${resp.status}: ${txt || resp.statusText}`);
    }

    setStatus("✅ Contraseña actualizada.");

    // ✅ Actualizar PIN en customers (por auth_user_id) + confirmar resultado
    try {
      const newPin = Number(p1); // pin es int8 => mandamos número

      const { data: upRow, error: upErr } = await supabaseClient
        .from("customers")
        .update({ pin: newPin })
        .eq("auth_user_id", currentSession.user.id) // ✅ clave para RLS
        .select("pin")
        .single();

      if (upErr) throw upErr;

      // refrescar cache local (así la próxima validación "mismo pin" funciona)
      if (customerProfile) customerProfile.pin = upRow?.pin;

      // 🔗 Sync PIN a Loekemeyer DB (vinculada por CUIT)
      try {
        const cuitRaw = String(customerProfile?.cuit || "").trim();
        const digits = cuitRaw.replace(/\D/g, "");
        // Probar todos los formatos plausibles para que no importe cómo
        // esté almacenado el CUIT en la otra DB (con/sin guiones/espacios).
        const formatted =
          digits.length === 11
            ? `${digits.slice(0, 2)}-${digits.slice(2, 10)}-${digits.slice(10)}`
            : "";
        const candidates = [
          ...new Set([cuitRaw, digits, formatted].filter(Boolean)),
        ];

        if (candidates.length) {
          const { data: lkRows, error: lkErr } = await supabaseLoekemeyer
            .from("customers")
            .update({ pin: newPin })
            .in("cuit", candidates)
            .select("cuit");
          if (lkErr) throw lkErr;
          if (!lkRows || lkRows.length === 0) {
            console.warn(
              "Sync PIN Loekemeyer: no se encontró fila con cuit",
              candidates,
            );
          }
        } else {
          console.warn("Sync PIN Loekemeyer: customerProfile.cuit vacío");
        }
      } catch (eLk) {
        console.warn("Sync PIN Loekemeyer falló:", eLk);
      }

      // opcional: dejar un OK explícito
      // setStatus('✅ Contraseña actualizada y PIN guardado.');
    } catch (e) {
      console.warn("PIN no se pudo actualizar en customers:", e);
      setStatus(
        "✅ Contraseña actualizada. ⚠️ No se pudo guardar el PIN en customers (RLS).",
      );
    }

    document.getElementById("newPass1").value = "";
    document.getElementById("newPass2").value = "";
  } catch (err) {
    if (String(err?.name) === "AbortError") {
      setStatus("❌ Timeout al actualizar contraseña (red/bloqueo).");
    } else {
      setStatus(`❌ ${String(err?.message || err)}`);
    }
  } finally {
    btn && (btn.disabled = false);
    window.__changingPass = false;
  }
}

function fillProfileSummaryUI() {
  // Si no existe el HTML nuevo, no hacemos nada
  if (!$("pfRazonSocial")) return;

  // Si no hay sesión/perfil, mostramos guiones
  if (!currentSession || !customerProfile) {
    $("pfRazonSocial").textContent = "—";
    $("pfCodCliente").textContent = "—";
    $("pfCuit").textContent = "—";
    $("pfCorreo").textContent = "—";
    $("pfDtoVol").textContent = "—";
    return;
  }

  const razon = String(customerProfile.business_name || "").trim();
  const cod = String(customerProfile.cod_cliente || "").trim();
  const cuit = String(customerProfile.cuit || "").trim();
  const mail = String(customerProfile.mail || "").trim();
  const dto = Number(customerProfile.dto_vol || 0); // en tu DB parece venir como 0.15, 0.20, etc.

  $("pfRazonSocial").textContent = razon || "—";
  $("pfCodCliente").textContent = cod || "—";
  $("pfCuit").textContent = cuit || "—";
  $("pfCorreo").textContent = mail || "—";

  // Mostrar % (si dto_vol es 0.15 => 15)
  // Si dto = 0 o no finito, ocultar la pill entera (#pfDtoVolWrap).
  // Importante: NO usar parentElement de pfDtoVol porque ahora el % está
  // wrapeado en un span intermedio (para que "12%" quede en una sola línea).
  const dtoEl = $("pfDtoVol");
  const dtoContainer = $("pfDtoVolWrap");
  if (Number.isFinite(dto) && dto > 0) {
    if (dtoEl) dtoEl.textContent = Math.round(dto * 100);
    if (dtoContainer) dtoContainer.style.display = "";
  } else {
    if (dtoContainer) dtoContainer.style.display = "none";
  }

  // Marcar la card según tipo (vendor en perfil propio vs cliente / vendor-as-cliente)
  const summaryEl = document.querySelector("#perfil .profile-summary");
  if (summaryEl) {
    if (typeof isVendorOwnMode === "function" && isVendorOwnMode()) {
      summaryEl.classList.add("is-vendor-profile");
    } else {
      summaryEl.classList.remove("is-vendor-profile");
    }
  }
}

async function openProfile() {
  if (!currentSession) {
    openLogin();
    return;
  }
  showSection("perfil");
  fillProfileSummaryUI();
  applyProfileVendorVisibility();
  // Cargar pedidos, sucursales y estado de tracking en paralelo
  await Promise.all([loadMyOrdersUI(), loadMyAddressesUI(), loadTrackingStatus()]);
  loadDraftCarts();
  // Card "Pedidos Clientes" para vendedores en perfil propio
  if (typeof loadVendorNotificationsUI === "function") {
    loadVendorNotificationsUI();
  }

  // Análisis de compras embebido (modo customer): exponemos customerProfile
  // global para que el módulo lo lea cuando el usuario expanda la card.
  // Lazy load: solo se dispara la búsqueda cuando hace click en el header
  // de la card colapsable (no al abrir el perfil).
  try {
    window.__lkCustomerProfile = customerProfile;
    setupAnalisisCardToggle();
  } catch (e) {
    console.warn("setupAnalisisCardToggle falló:", e);
  }
}

// Wire del toggle de la card "Análisis de tus compras". Lazy load.
function setupAnalisisCardToggle() {
  var card = document.getElementById("profileCardAnalisis");
  var btn = document.getElementById("profileCardAnalisisToggle");
  var body = document.getElementById("profileCardAnalisisBody");
  if (!card || !btn || !body) return;
  if (btn.__wired) return;
  btn.__wired = true;

  btn.addEventListener("click", function () {
    var isOpen = card.getAttribute("data-open") === "true";
    if (isOpen) {
      card.setAttribute("data-open", "false");
      btn.setAttribute("aria-expanded", "false");
      body.hidden = true;
    } else {
      card.setAttribute("data-open", "true");
      btn.setAttribute("aria-expanded", "true");
      body.hidden = false;
      // Lazy load: la primera vez que se abre, dispara avcInit
      if (!card.__avcLoaded) {
        card.__avcLoaded = true;
        var codCli =
          customerProfile && customerProfile.cod_cliente
            ? String(customerProfile.cod_cliente)
            : "";
        if (codCli && typeof window.avcInitCustomerMode === "function") {
          window.avcInitCustomerMode(codCli);
        }
      }
    }
  });
}

// Abre el perfil + expande la card de Análisis + scrollea a ella.
window.openAnalisisFromMenu = async function () {
  if (!currentSession) {
    openLogin();
    return;
  }
  if (typeof closeUserMenu === "function") closeUserMenu();
  if (typeof closeMobileUserMenu === "function") closeMobileUserMenu();
  await openProfile();
  // Esperar el siguiente tick para que el toggle button esté wireado
  setTimeout(function () {
    var card = document.getElementById("profileCardAnalisis");
    var btn = document.getElementById("profileCardAnalisisToggle");
    if (!card || !btn) return;
    if (card.getAttribute("data-open") !== "true") {
      btn.click(); // expandir
    }
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 100);
};

// Aplica la visibilidad correcta de las cards del perfil + items del user menu
// según contexto:
//  - Vendor en perfil propio (isVendorOwnMode):
//      cards: solo "Pedidos Clientes" + "Pedidos sin Confirmar"
//      menu: Mi perfil + Pedidos Clientes + Pedidos sin Confirmar
//  - Cliente (o vendor actuando como cliente):
//      cards: todas las de cliente, excepto "Pedidos Clientes"
//      menu: Mi perfil + Pedidos sin Confirmar + Historial Compras + Sugerencia IA
function applyProfileVendorVisibility() {
  var ownMode = typeof isVendorOwnMode === "function" && isVendorOwnMode();
  var isVendor = typeof isActualVendor === "function" && isActualVendor();

  // Body classes (para que CSS pueda condicionar selectivamente):
  //  - is-vendor-user: el usuario logueado es vendedor
  //  - is-vendor-own-mode: vendedor en perfil propio (sin cliente seleccionado)
  try {
    document.body.classList.toggle("is-vendor-user", isVendor);
    document.body.classList.toggle("is-vendor-own-mode", ownMode);
  } catch (e) {}

  // Elementos "solo cliente" (ocultos en vendor own mode):
  //   - cards del perfil: Sucursales, Historial Web, Estado, Historial Compras, Sugerencias
  //   - items del user menu (desktop + mobile): Historial Compras, Sugerencia Compra x IA
  var clientOnlyIds = [
    "profileCardSucursales",
    "profileCardOrdersWeb",
    "profileCardEstadoPedidos",
    "profileCardHistorial",
    "profileCardSugerencias",
    "menuHistorial",
    "menuHistorialMobile",
    "menuSugerencias",
    "menuSugerenciasMobile",
  ];
  clientOnlyIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.style.display = ownMode ? "none" : "";
  });

  // Análisis: oculto en admin (no aplica a su perfil propio) y en vendor own
  // mode (no aplica al vendedor mismo). En vendor con cliente seleccionado SÍ
  // aparece (es del cliente). Lo del vendor own mode lo cubre CSS body class.
  var menuAnalisis = document.getElementById("menuAnalisis");
  var menuAnalisisMobile = document.getElementById("menuAnalisisMobile");
  if (menuAnalisis) menuAnalisis.style.display = isAdmin ? "none" : "";
  if (menuAnalisisMobile) menuAnalisisMobile.style.display = isAdmin ? "none" : "";

  // "Pedidos Clientes" (solo vendor own mode) lo maneja loadVendorNotificationsUI con card.hidden
  // "Pedidos sin Confirmar" siempre visible — no se toca acá
}
window.applyProfileVendorVisibility = applyProfileVendorVisibility;

window.openProfile = openProfile;

/***********************
 * PEDIDOS SIN CONFIRMAR (DRAFTS)
 ***********************/
async function openSaveDraftModal() {
  if (!currentSession) { openLogin(); return; }
  if (isVendorProfile() && !document.getElementById("customerSelect")?.value) {
    alert("Elegí una razón social antes de guardar el pedido.");
    return;
  }
  if (!customerProfile?.id) {
    alert("No se encontró el perfil del cliente.");
    return;
  }
  if (!cart.length) {
    alert("El carrito está vacío.");
    return;
  }

  const modal = document.getElementById("saveDraftModal");
  if (!modal) return;
  const nameInput = document.getElementById("draftNameInput");
  const notesInput = document.getElementById("draftNotesInput");
  const clearChk = document.getElementById("draftClearAfter");
  const status = document.getElementById("saveDraftStatus");
  const hint = document.getElementById("saveDraftHint");
  const btnConfirm = document.getElementById("btnSaveDraftConfirm");
  const capList = document.getElementById("saveDraftCapList");

  if (nameInput) nameInput.value = "";
  if (notesInput) notesInput.value = "";
  if (clearChk) clearChk.checked = false;
  if (status) { status.textContent = ""; status.className = "profile-status"; }
  if (hint) { hint.textContent = ""; hint.style.color = "#666"; hint.style.fontWeight = "normal"; }
  if (capList) { capList.style.display = "none"; capList.innerHTML = ""; }
  if (btnConfirm) { btnConfirm.textContent = "Guardar pedido"; btnConfirm.disabled = false; }

  modal.classList.add("open");
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");

  await refreshSaveDraftModalState();
}

async function refreshSaveDraftModalState() {
  const nameInput = document.getElementById("draftNameInput");
  const hint = document.getElementById("saveDraftHint");
  const btnConfirm = document.getElementById("btnSaveDraftConfirm");
  const capList = document.getElementById("saveDraftCapList");

  try {
    if (window.__activeDraftId) {
      const { data } = await supabaseClient
        .from("saved_carts")
        .select("name")
        .eq("id", window.__activeDraftId)
        .maybeSingle();
      const nm = (data && data.name) ? data.name : "el pedido guardado";
      if (hint) { hint.textContent = "Vas a actualizar: " + nm; hint.style.color = "#666"; hint.style.fontWeight = "normal"; }
      if (btnConfirm) { btnConfirm.textContent = "Actualizar pedido"; btnConfirm.disabled = false; }
      if (nameInput && data && data.name && !nameInput.value) nameInput.value = data.name;
      if (capList) { capList.style.display = "none"; capList.innerHTML = ""; }
      return;
    }

    const { data: drafts, error } = await supabaseClient
      .from("saved_carts")
      .select("id, name, item_count, updated_at")
      .eq("customer_id", customerProfile.id)
      .order("updated_at", { ascending: false });

    if (error) throw error;
    const used = (drafts || []).length;

    if (used >= 3) {
      if (hint) {
        hint.textContent = "Llegaste al tope: 3 pedidos sin confirmar. Eliminá uno para poder guardar este.";
        hint.style.color = "#b00020";
        hint.style.fontWeight = "600";
      }
      if (btnConfirm) { btnConfirm.textContent = "Guardar pedido (3/3)"; btnConfirm.disabled = true; }
      if (capList) {
        const escape = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        capList.style.display = "block";
        capList.innerHTML =
          '<div style="font-size:12px;font-weight:600;margin-bottom:6px;">Tus pedidos sin confirmar:</div>' +
          (drafts || []).map((d) => {
            const title = escape(d.name || "Pedido guardado");
            const fecha = d.updated_at ? new Date(d.updated_at).toLocaleString("es-AR") : "";
            const count = Number(d.item_count || 0);
            return ''
              + '<div style="display:flex;gap:8px;justify-content:space-between;align-items:center;border:1px solid #eee;border-radius:8px;padding:8px 10px;margin-bottom:6px;">'
              +   '<div style="flex:1 1 auto;min-width:0;">'
              +     '<div style="font-weight:600;font-size:13px;">' + title + '</div>'
              +     '<div style="color:#666;font-size:11px;">' + count + ' item' + (count === 1 ? '' : 's') + ' · ' + fecha + '</div>'
              +   '</div>'
              +   '<button type="button" class="profile-btn danger" '
              +     'style="padding:6px 10px;font-size:12px;" '
              +     'onclick="deleteDraftFromModal(\'' + escape(d.id) + '\')">Eliminar</button>'
              + '</div>';
          }).join("");
      }
    } else {
      if (hint) { hint.textContent = "Tenés " + used + " de 3 pedidos sin confirmar."; hint.style.color = "#666"; hint.style.fontWeight = "normal"; }
      if (btnConfirm) { btnConfirm.textContent = "Guardar pedido"; btnConfirm.disabled = false; }
      if (capList) { capList.style.display = "none"; capList.innerHTML = ""; }
    }
  } catch (e) {
    console.warn("refreshSaveDraftModalState error:", e);
  }
}

async function deleteDraftFromModal(draftId) {
  if (!draftId) return;
  if (!confirm("¿Eliminar este pedido sin confirmar?")) return;

  try {
    const { error } = await supabaseClient
      .from("saved_carts")
      .delete()
      .eq("id", draftId);

    if (error) throw error;

    if (window.__activeDraftId === draftId) {
      window.__activeDraftId = null;
    }
    loadDraftCarts();
    await refreshSaveDraftModalState();
  } catch (err) {
    console.error("deleteDraftFromModal error:", err);
    alert("No se pudo eliminar: " + (err.message || String(err)));
  }
}

function closeSaveDraftModal() {
  const modal = document.getElementById("saveDraftModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

async function saveCart() {
  const status = document.getElementById("saveDraftStatus");
  const setStatus = (msg, cls) => {
    if (!status) return;
    status.textContent = msg || "";
    status.className = "profile-status" + (cls ? " " + cls : "");
  };
  const btn = document.getElementById("btnSaveDraftConfirm");

  try {
    if (!currentSession) { openLogin(); return; }
    if (!customerProfile?.id) { setStatus("No hay cliente seleccionado.", "err"); return; }
    if (!cart.length) { setStatus("El carrito está vacío.", "err"); return; }

    if (btn) { btn.disabled = true; btn.textContent = "Guardando…"; }
    setStatus("Guardando…");

    const name = String(document.getElementById("draftNameInput")?.value || "").trim();
    const notes = String(document.getElementById("draftNotesInput")?.value || "").trim();
    const clearAfter = !!document.getElementById("draftClearAfter")?.checked;
    const paySel = document.getElementById("paymentSelect");
    const paymentMethod = paySel ? String(paySel.value || "") : "";

    const items = cart.map((x) => ({
      productId: String(x.productId),
      qtyCajas: Math.max(1, parseInt(x.qtyCajas, 10) || 1),
      isUpsellPromo: !!x.isUpsellPromo,
    }));

    const basePayload = {
      name: name || null,
      notes: notes || null,
      payment_method: paymentMethod || null,
      delivery_slot: deliveryChoice?.slot || null,
      delivery_label: deliveryChoice?.label || null,
      items: items,
      updated_at: new Date().toISOString(),
    };

    if (window.__activeDraftId) {
      const { error } = await supabaseClient
        .from("saved_carts")
        .update(basePayload)
        .eq("id", window.__activeDraftId);

      if (error) throw error;
      setStatus("Pedido actualizado.", "ok");
    } else {
      const { count, error: countErr } = await supabaseClient
        .from("saved_carts")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customerProfile.id);

      if (countErr) throw countErr;

      if ((count || 0) >= 3) {
        setStatus("Ya tenés 3 pedidos sin confirmar. Eliminá uno antes de guardar otro.", "err");
        return;
      }

      const insertPayload = Object.assign({}, basePayload, {
        customer_id: customerProfile.id,
        created_by_auth_user_id: currentSession?.user?.id || null,
      });

      const { error } = await supabaseClient
        .from("saved_carts")
        .insert(insertPayload);

      if (error) throw error;
      setStatus("Pedido guardado.", "ok");
    }

    if (clearAfter) {
      cart.splice(0, cart.length);
      saveCartToLS();
      updateCart();
      renderProducts();
    }

    loadDraftCarts();

    setTimeout(closeSaveDraftModal, 700);
  } catch (err) {
    console.error("saveCart error:", err);
    setStatus("No se pudo guardar el pedido: " + (err.message || String(err)), "err");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Guardar pedido"; }
  }
}

async function loadDraftCarts() {
  const box = document.getElementById("draftCartsBox");
  if (!box) return;

  if (!currentSession || !customerProfile?.id) {
    box.innerHTML = "Iniciá sesión para ver tus pedidos sin confirmar.";
    return;
  }

  box.innerHTML = "Cargando…";

  // Vendedor en perfil propio → traer drafts de TODOS los clientes vinculados
  // Cliente (o vendedor actuando como cliente) → solo drafts del customerProfile activo
  const vendorOwnMode = typeof isVendorOwnMode === "function" && isVendorOwnMode();
  const customerIds = vendorOwnMode
    ? (linkedCustomers || []).map(function (c) { return c.customer_id; })
    : [customerProfile.id];

  if (vendorOwnMode && !customerIds.length) {
    box.innerHTML = '<div class="draft-empty" style="color:#666;">No hay clientes vinculados.</div>';
    return;
  }

  // Mapa para resolver nombre por customer_id (vendor mode)
  const custInfo = {};
  (linkedCustomers || []).forEach(function (c) {
    custInfo[c.customer_id] = {
      business_name: c.business_name || "",
      cod_cliente: c.cod_cliente || "",
    };
  });

  try {
    const { data, error } = await supabaseClient
      .from("saved_carts")
      .select("id, customer_id, name, notes, item_count, created_at, updated_at, payment_method, delivery_label")
      .in("customer_id", customerIds)
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      const emptyMsg = vendorOwnMode
        ? "Ninguno de tus clientes tiene pedidos sin confirmar."
        : "Cuando guardes un pedido aparecerá acá.";
      const emptyTitle = vendorOwnMode
        ? "Sin pedidos pendientes"
        : "Nada sin confirmar";
      box.innerHTML = `
        <div class="empty-state-mini">
          <svg class="empty-state-mini-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Disquete (icono universal de "guardar") -->
            <path d="M26 22 L82 22 L98 38 L98 98 Q98 102 94 102 L26 102 Q22 102 22 98 L22 26 Q22 22 26 22 Z"
                  fill="none" stroke="#222" stroke-width="6" stroke-linejoin="round"/>
            <rect x="36" y="22" width="40" height="22" fill="#222"/>
            <rect x="62" y="26" width="10" height="14" fill="#fff"/>
            <rect x="34" y="62" width="52" height="32" rx="2" fill="none" stroke="#222" stroke-width="5"/>
            <line x1="44" y1="74" x2="76" y2="74" stroke="#222" stroke-width="4" stroke-linecap="round"/>
            <line x1="44" y1="84" x2="68" y2="84" stroke="#222" stroke-width="4" stroke-linecap="round"/>
          </svg>
          <div class="empty-state-mini-text">
            <strong>${emptyTitle}</strong>
            <span>${emptyMsg}</span>
          </div>
        </div>
      `;
      return;
    }

    const escape = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    // Helper: fecha relativa ("hoy", "ayer", "hace 3 días", etc.)
    const relativeDate = (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      const now = new Date();
      const diffMs = now - d;
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffMins = Math.floor(diffMs / (1000 * 60));
      if (diffMins < 1) return "hace instantes";
      if (diffMins < 60) return "hace " + diffMins + " min";
      if (diffHours < 24 && d.getDate() === now.getDate()) return "hoy";
      if (diffDays === 0) return "hoy";
      if (diffDays === 1) return "ayer";
      if (diffDays < 7) return "hace " + diffDays + " días";
      return d.toLocaleDateString("es-AR");
    };

    box.innerHTML = rows.map((r) => {
      const title = escape(r.name || "Pedido guardado");
      const fechaRel = relativeDate(r.updated_at);
      const notesHtml = r.notes ? '<div class="draft-notes">' + escape(r.notes) + '</div>' : "";
      const count = Number(r.item_count || 0);
      const itemsLabel = count + ' item' + (count === 1 ? '' : 's');
      // En modo vendedor propio, mostrar nombre del cliente arriba
      const ci = vendorOwnMode ? custInfo[r.customer_id] || {} : null;
      const clientHtml = (vendorOwnMode && ci)
        ? '<div class="draft-client-name">' +
          escape(ci.business_name || "Cliente") +
          (ci.cod_cliente ? " (" + escape(ci.cod_cliente) + ")" : "") +
          "</div>"
        : "";

      // Icono disquete (mismo que el empty state) — visual hierarchy
      const diskIcon = ''
        + '<svg class="draft-icon-svg" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
        +   '<path d="M26 22 L82 22 L98 38 L98 98 Q98 102 94 102 L26 102 Q22 102 22 98 L22 26 Q22 22 26 22 Z" '
        +         'fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="round"/>'
        +   '<rect x="36" y="22" width="40" height="22" fill="currentColor"/>'
        +   '<rect x="62" y="26" width="10" height="14" fill="#fff"/>'
        +   '<rect x="34" y="62" width="52" height="32" rx="2" fill="none" stroke="currentColor" stroke-width="5"/>'
        +   '<line x1="44" y1="74" x2="76" y2="74" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
        +   '<line x1="44" y1="84" x2="68" y2="84" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>'
        + '</svg>';

      // Icono carrito para el botón "Cargar al carrito"
      const cartIcon = '<svg class="draft-load-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>';

      // Icono tacho rojo para eliminar
      const trashIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';

      return ''
        + '<div class="draft-row-v2" data-draft-id="' + escape(r.id) + '">'
        +   '<div class="draft-icon-wrap">' + diskIcon + '</div>'
        +   '<div class="draft-info">'
        +     clientHtml
        +     '<div class="draft-title">' + title + '</div>'
        +     '<div class="draft-meta">'
        +       '<span class="draft-pill-items">' + itemsLabel + '</span>'
        +       (fechaRel ? '<span class="draft-meta-dot">·</span><span class="draft-meta-date">' + fechaRel + '</span>' : '')
        +     '</div>'
        +     notesHtml
        +   '</div>'
        +   '<div class="draft-actions-v2">'
        +     '<button type="button" class="draft-load-btn" onclick="loadDraftIntoCart(\'' + escape(r.id) + '\')" aria-label="Cargar al carrito">'
        +       cartIcon + '<span>Cargar al carrito</span>'
        +     '</button>'
        +     '<button type="button" class="draft-delete-btn" onclick="deleteDraftCart(\'' + escape(r.id) + '\')" aria-label="Eliminar">'
        +       trashIcon
        +     '</button>'
        +   '</div>'
        + '</div>';
    }).join("");
  } catch (err) {
    console.error("loadDraftCarts error:", err);
    box.innerHTML = "No se pudieron cargar los pedidos guardados.";
  }
}

async function loadDraftIntoCart(draftId) {
  if (!draftId) return;
  try {
    const { data, error } = await supabaseClient
      .from("saved_carts")
      .select("id, customer_id, items, payment_method, delivery_slot, delivery_label")
      .eq("id", draftId)
      .maybeSingle();

    if (error) throw error;
    if (!data) { alert("Ese pedido ya no existe."); return; }

    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) { alert("Ese pedido guardado no tiene items."); return; }

    if (cart.length > 0 && !confirm("Tu carrito actual se reemplazará por el pedido guardado. ¿Continuar?")) {
      return;
    }

    cart.splice(0, cart.length);
    items.forEach((it) => {
      const pid = String(it.productId || it.product_id || "");
      const qty = Math.max(1, Math.round(Number(it.qtyCajas || it.qty_cajas || 0)));
      if (!pid || !qty) return;
      cart.push({
        productId: pid,
        qtyCajas: qty,
        isUpsellPromo: !!it.isUpsellPromo,
      });
    });
    saveCartToLS();

    const beforeCount = cart.length;
    if (typeof normalizeCartAgainstProducts === "function") normalizeCartAgainstProducts();
    const removed = beforeCount - cart.length;

    if (data.payment_method) {
      const paySel = document.getElementById("paymentSelect");
      if (paySel && Array.from(paySel.options).some((o) => o.value === data.payment_method)) {
        paySel.value = data.payment_method;
      }
    }
    if (data.delivery_slot) {
      deliveryChoice = {
        slot: data.delivery_slot,
        label: data.delivery_label || "",
        direccionEntrega: deliveryChoice?.direccionEntrega || "",
        zonaExpreso: deliveryChoice?.zonaExpreso || "",
      };
      const shipSel = document.getElementById("shippingSelect");
      if (shipSel && Array.from(shipSel.options).some((o) => o.value === data.delivery_slot)) {
        shipSel.value = data.delivery_slot;
        if (typeof _csRefreshWrappedSelect === "function") {
          _csRefreshWrappedSelect(shipSel, "Elegir Sucursal");
        }
      }
    }

    window.__activeDraftId = data.id;

    updateCart();
    renderProducts();
    if (typeof syncPaymentButtons === "function") syncPaymentButtons();
    if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();

    showSection("carrito");
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (removed > 0) {
      setTimeout(() => {
        alert("Pedido cargado. " + removed + " producto" + (removed === 1 ? "" : "s") + " ya no están disponibles y se omitieron.");
      }, 100);
    }
  } catch (err) {
    console.error("loadDraftIntoCart error:", err);
    alert("No se pudo cargar el pedido guardado.");
  }
}

async function deleteDraftCart(draftId) {
  if (!draftId) return;
  if (!confirm("¿Eliminar este pedido sin confirmar?")) return;

  try {
    const { error } = await supabaseClient
      .from("saved_carts")
      .delete()
      .eq("id", draftId);

    if (error) throw error;

    if (window.__activeDraftId === draftId) {
      window.__activeDraftId = null;
    }
    loadDraftCarts();
  } catch (err) {
    console.error("deleteDraftCart error:", err);
    alert("No se pudo eliminar: " + (err.message || String(err)));
  }
}

function openDraftsFromMenu() {
  openProfile();
  loadDraftCarts();
  setTimeout(() => {
    const el = document.getElementById("draftCartsBox");
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 250);
}

window.openSaveDraftModal = openSaveDraftModal;
window.closeSaveDraftModal = closeSaveDraftModal;
window.saveCart = saveCart;
window.loadDraftCarts = loadDraftCarts;
window.loadDraftIntoCart = loadDraftIntoCart;
window.deleteDraftCart = deleteDraftCart;
window.deleteDraftFromModal = deleteDraftFromModal;
window.openDraftsFromMenu = openDraftsFromMenu;

/***********************
 * ESTADO DE PEDIDOS (TRACKING) - lado cliente
 ***********************/
async function loadTrackingStatus() {
  const box = $("trackingStatusBox");
  if (!box) return;

  if (!currentSession || !customerProfile?.cod_cliente) {
    box.textContent = "Iniciá sesión para ver el estado de tus pedidos.";
    return;
  }

  box.textContent = "Cargando…";

  try {
    const codCliente = Number(customerProfile.cod_cliente);
    const { data, error } = await supabaseClient
      .from("order_tracking")
      .select("np_number, status, fecha_estimada, fecha_entrega, direccion_entrega")
      .eq("cod_cliente", codCliente)
      .order("np_number", { ascending: false });

    if (error) throw error;

    if (!data || !data.length) {
      box.innerHTML = `
        <div class="empty-state-mini">
          <svg class="empty-state-mini-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="60" cy="60" r="48" fill="none" stroke="#222" stroke-width="7"/>
            <circle cx="46" cy="52" r="5" fill="#222"/>
            <circle cx="74" cy="52" r="5" fill="#222"/>
            <path d="M44 80 Q60 66 76 80" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>
          </svg>
          <div class="empty-state-mini-text">
            <strong>No hay información de seguimiento</strong>
            <span>Cuando tu pedido esté en camino aparecerá acá.</span>
          </div>
        </div>
      `;
      return;
    }

    const VISIBLE_COUNT = 3;
    const rows = data.map(function(r) {
      let statusLabel, statusClass, extra = "";
      switch (r.status) {
        case "a_programar":
          statusLabel = "A Programar";
          statusClass = "tracking-badge a-programar";
          break;
        case "programado":
          statusLabel = "Programado";
          statusClass = "tracking-badge programado";
          extra = r.fecha_estimada ? "<span class=\"tracking-fecha\">Entrega estimada: " + esc(r.fecha_estimada) + "</span>" : "";
          break;
        case "enviado":
          statusLabel = "Enviado";
          statusClass = "tracking-badge enviado";
          extra = r.fecha_entrega ? "<span class=\"tracking-fecha\">Entregado: " + esc(r.fecha_entrega) + "</span>" : "";
          break;
        case "retirado":
          statusLabel = "Retirado";
          statusClass = "tracking-badge retirado";
          extra = r.fecha_entrega ? "<span class=\"tracking-fecha\">Retirado: " + esc(r.fecha_entrega) + "</span>" : "";
          break;
        default:
          statusLabel = "Sin estado";
          statusClass = "tracking-badge";
      }

      return '<div class="tracking-row">'
        + '<span class="tracking-np">NP ' + esc(r.np_number || "-") + '</span>'
        + '<span class="' + statusClass + '">' + statusLabel + '</span>'
        + extra
        + '</div>';
    });

    if (data.length <= VISIBLE_COUNT) {
      box.innerHTML = rows.join("");
    } else {
      box.innerHTML = rows.slice(0, VISIBLE_COUNT).join("")
        + '<div class="tracking-hidden" id="trackingHiddenRows" style="display:none">'
        + rows.slice(VISIBLE_COUNT).join("")
        + '</div>'
        + '<button type="button" class="tracking-ver-mas" id="trackingVerMasBtn" onclick="'
        + "document.getElementById('trackingHiddenRows').style.display='block';"
        + "this.style.display='none';"
        + '">Ver más (' + (data.length - VISIBLE_COUNT) + ' pedidos)</button>';
    }

  } catch (err) {
    box.textContent = "Error cargando estado de pedidos.";
    console.error(err);
  }
}

/***********************
 * BUSCADOR
 ***********************/
function setSearchInputValue(val) {
  const inp = $("productsSearch");
  if (inp) inp.value = val || "";
}

function getFilteredProducts() {
  let list = products.slice();

  // Categorías
  if (!filterAll) {
    list = list.filter((p) => filterCats.has(String(p.category || "").trim()));
  }

  // NUEVOS
  if (filterNewOnly) {
    list = list.filter(
      (p) =>
        String(p.badge_status || "")
          .trim()
          .toUpperCase() === "NUEVO",
    );
  }

  // MI SURTIDO
  if (filterMyAssortment) {
    if (myAssortmentIds instanceof Set) {
      list = list.filter((p) => myAssortmentIds.has(String(p.id)));
    }
  }

  // Buscador
  if (searchTerm && String(searchTerm).trim()) {
    const term = normalizeText(searchTerm);
    list = list.filter((p) => {
      const hay = [p.cod, p.description].map(normalizeText).join(" ");
      return hay.includes(term);
    });
  }

  return list;
}

async function loadMyAssortmentIds() {
  if (!currentSession) return new Set();
  if (!customerProfile?.cod_cliente) return new Set();

  const { data, error } = await supabaseClient.rpc("get_my_assortment_18m", {
    p_customer: String(customerProfile.cod_cliente),
  });

  if (error) {
    console.error("RPC get_my_assortment_18m error:", error);
    return new Set();
  }

  return new Set((data || []).map((r) => String(r.product_id)));
}

/***********************
 * RENDER PRODUCTS  ✅ (INFINITE SCROLL)
 ***********************/
const RENDER_BATCH = 40;
let _renderState = null;
let _scrollObserver = null;

function _buildCard(p, logged) {
    const pid = String(p.id);
    const codSafe = String(p.cod || "").trim();

    const imgSrc = `${BASE_IMG}${encodeURIComponent(codSafe)}.jpg?v=${encodeURIComponent(
      IMG_VERSION,
    )}`;
    const imgFallback = "img/no-image.webp";

    const vendorBrowse = typeof isVendorProfileBrowseMode === "function" && isVendorProfileBrowseMode();
    const tuPrecio = logged ? unitYourPrice(p.list_price) : 0;
    // Vendor en browse mode: solo Precio Lista (no "Tu Precio Contado").
    // Admin sin razón social: idem.
    const showListPriceOnly = (isAdmin && !hasVendorSelection()) || vendorBrowse;

    const tuPrecioContado = logged
      ? showListPriceOnly
        ? Number(p.list_price || 0)
        : tuPrecio * (1 - WEB_ORDER_DISCOUNT) * (1 - 0.25)
      : 0;

    const badge = String(p.badge_status || "")
      .trim()
      .toUpperCase();

    let badgeHtml = "";

    const isMyAssortment =
      myAssortmentIds instanceof Set &&
      myAssortmentIds.has(String(p.id));

    let assortmentStarHtml = "";

    if (badge === "NUEVO") {
      badgeHtml = '<div class="badge-nuevo">NUEVO</div>';
    } else if (badge === "LIQUIDACION" || badge === "LIQUIDACIÓN") {
      badgeHtml = '<div class="badge-liquidacion">LIQUIDACIÓN</div>';
    } else if (badge === "SIN STOCK") {
      badgeHtml = '<div class="badge-sinstock">SIN STOCK</div>';
    } else if (badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE") {
      badgeHtml = '<div class="badge-proximamente">PRÓXIMAMENTE</div>';
    }

if (isMyAssortment) {
  assortmentStarHtml = `
  <div class="badge-mi-surtido" title="Mi surtido" aria-label="Mi surtido">
    <svg viewBox="0 0 28 28" aria-hidden="true">
      <circle class="star-ring" cx="14" cy="14" r="11.5"></circle>
      <path class="star-fill" d="M14 5.8l2.15 4.35 4.8.7-3.48 3.39.82 4.79L14 16.76 9.71 19.03l.82-4.79-3.48-3.39 4.8-.7L14 5.8z"></path>
    </svg>
  </div>
`;
}

    const inCart = cart.find((i) => String(i.productId) === String(pid));
    const qty = inCart ? Number(inCart.qtyCajas || 0) : 0;
    const totalUni = qty * Number(p.uxb || 0);

    return `
      <div class="product-card" id="card-${esc(pid)}">
      ${badgeHtml}
       ${assortmentStarHtml}
        <img
          id="img-${esc(pid)}"
          src="${imgSrc}"
          alt="${esc(String(p.description || ""))}"
          loading="lazy"
          decoding="async"
          onerror="this.onerror=null;this.src='${imgFallback}'"
        >

        <div class="card-top">
          <div class="card-row">
            <div class="card-cod">Cod: <span>${esc(codSafe)}</span></div>
            <div class="card-uxb">UxB: <span>${esc(p.uxb)}</span></div>
          </div>

          <div class="card-desc">${esc(String(p.description || ""))}</div>

          <div class="${logged ? "" : "price-hidden"} card-prices">
  <div class="card-price-line">
    Precio Lista: <strong>$${formatMoney(p.list_price)}</strong><span class="card-iva">+ IVA</span>
  </div>

  ${
    showListPriceOnly
      ? ""
      : `
    <div class="card-price-line">
      Tu Precio Contado: <strong>$${formatMoney(tuPrecioContado)}</strong><span class="card-iva">+ IVA</span>
    </div>
  `
  }
</div>

          <div class="${logged ? "price-hidden" : ""} card-prices">
            <div class="price-locked">Inicia sesión para ver precios</div>
          </div>
        </div>

        ${
          badge === "SIN STOCK"
            ? `
      <button class="add-btn disabled" disabled>
        Sin stock
      </button>
    `
            : badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE"
              ? `
      <button class="add-btn disabled" disabled>
        Próximamente
      </button>
    `
            : !logged
              ? `
        <button class="add-btn add-login-btn" onclick="openLogin()">
          Iniciar sesión para ver precios
        </button>
      `
              : qty <= 0
                ? `
          <button class="add-btn ${vendorBrowse ? "add-vendor-browse" : ""}" id="add-${esc(pid)}" onclick="${vendorBrowse ? "scrollToCustomerSelector()" : "addFirstBox('" + esc(pid) + "')"}" title="${vendorBrowse ? "Elegí primero una razón social" : ""}">
            ${vendorBrowse ? "Elegir razón social" : "Agregar al pedido"}
          </button>
        `
                : `
          <div class="card-cartbar" id="qty-${esc(pid)}">
          <div class="cartbar-top">
            <div class="cartbar-label">Subtotal</div>
            <div class="cartbar-subtotal">
              <strong class="cartbar-subv">
                $${formatMoney(
                  logged
                    ? unitYourPrice(p.list_price) * (qty * Number(p.uxb || 0))
                    : 0,
                )}
              </strong>
              <span class="cartbar-iva">+ IVA</span>
            </div>
          </div>
                <div class="cartbar-controls">
                  <div class="cartbar-left">
                    <div class="cartbar-stepper">
                      <button type="button" class="step-btn" onclick="changeQty('${esc(pid)}', -1)">−</button>
                      <input
                        class="step-input"
                        type="number"
                        min="1"
                        step="1"
                        value="${qty}"
                        inputmode="numeric"
                        onchange="manualQty('${esc(pid)}', this.value)"
                      >
                      <button type="button" class="step-btn" onclick="changeQty('${esc(pid)}', 1)">+</button>
                    </div>

                    <button type="button" class="chip chip-5" onclick="changeQty('${esc(pid)}', 5)">+5</button>
                  </div>
                </div>

                <div class="cartbar-units">
                  Unidades: <strong>${formatMoney(totalUni)}</strong>
                </div>

                <button type="button" class="remove-btn remove-compact" onclick="removeItem('${esc(pid)}')">
                  Quitar
                </button>
              </div>
            `
        }
      </div>
    `;
}

/* Prepara la lista plana de items con sus metadatos de categoría */
function _prepareFlatList(list) {
  if (sortMode === "bestsellers") {
    const items = [...list].sort(getSortComparator());
    return { mode: "flat", items };
  }

  // Modo categoría: armar bloques ordenados
  const cats = getOrderedCategoriesFrom(list);
  const blocks = [];

  cats.forEach((category) => {
    let items = list.filter(
      (p) => String(p.category || "").trim() === String(category).trim(),
    );
    items = items.sort(getSortComparator());
    if (!items.length) return;

    if (String(category).trim().toLowerCase() === "utensilios") {
      const groups = new Map();
      items.forEach((p) => {
        const key = p.subcategory && String(p.subcategory).trim()
          ? String(p.subcategory).trim() : "Otros";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      });

      const present = Array.from(groups.keys());
      const fixed = UTENSILIOS_SUB_ORDER.filter((s) => present.includes(s));
      const extras = present
        .filter((s) => s !== "Otros" && !UTENSILIOS_SUB_ORDER.includes(s))
        .sort((a, b) => a.localeCompare(b, "es"));
      const hasOtros = present.includes("Otros");
      const subcatsOrdered = [...fixed, ...extras, ...(hasOtros ? ["Otros"] : [])];

      const subItems = [];
      subcatsOrdered.forEach((sub) => {
        const prods = (groups.get(sub) || []).sort(getSortComparator());
        subItems.push({ subcategory: sub, products: prods });
      });

      blocks.push({ category, subcategories: subItems });
    } else {
      blocks.push({ category, products: items });
    }
  });

  return { mode: "category", blocks };
}

/* Renderiza un lote de productos en modo bestsellers (flat) */
function _renderFlatBatch() {
  const s = _renderState;
  if (!s || s.done) return;

  const container = $("productsContainer");
  if (!container) return;

  let grid = container.querySelector(".products-grid");
  if (!grid) {
    grid = document.createElement("div");
    grid.className = "products-grid";
    container.appendChild(grid);
  }

  const end = Math.min(s.cursor + RENDER_BATCH, s.items.length);
  const fragment = document.createDocumentFragment();
  const tmp = document.createElement("div");

  for (let i = s.cursor; i < end; i++) {
    tmp.innerHTML = _buildCard(s.items[i], s.logged);
    fragment.appendChild(tmp.firstElementChild);
  }
  grid.appendChild(fragment);

  s.cursor = end;
  if (s.cursor >= s.items.length) {
    s.done = true;
    _removeSentinel();
  } else {
    _ensureSentinel();
  }
}

/* Renderiza un lote de categorías */
function _renderCategoryBatch() {
  const s = _renderState;
  if (!s || s.done) return;

  const container = $("productsContainer");
  if (!container) return;

  let rendered = 0;
  const tmp = document.createElement("div");

  while (s.blockIdx < s.blocks.length && rendered < RENDER_BATCH) {
    const blk = s.blocks[s.blockIdx];
    const catId = `cat-${slugifyCategory(blk.category)}`;

    // Si es un bloque nuevo, crear el contenedor
    if (!s.currentBlock) {
      const block = document.createElement("div");
      block.className = "category-block";
      const heading = document.createElement("h2");
      heading.className = "category-title";
      heading.id = catId;
      heading.textContent = blk.category;
      block.appendChild(heading);
      // Categorías con subcategorías: cada subcategoría crea su propio grid y el
      // título va como header (fuera del grid). Evita el hueco vacío que dejaba
      // el título como item de un grid con grid-auto-rows:1fr.
      if (!blk.subcategories) {
        const grid = document.createElement("div");
        grid.className = "products-grid";
        block.appendChild(grid);
        s.currentGrid = grid;
      } else {
        s.currentGrid = null;
      }
      container.appendChild(block);
      s.currentBlock = block;
      s.itemIdx = 0;
      s.subIdx = 0;
    }

    if (blk.subcategories) {
      // Utensilios con subcategorías
      while (s.subIdx < blk.subcategories.length && rendered < RENDER_BATCH) {
        const sub = blk.subcategories[s.subIdx];

        // Al iniciar la subcategoría: título como header (fuera del grid) + su
        // propio grid de cards.
        if (s.itemIdx === 0) {
          const subTitle = document.createElement("div");
          subTitle.className = "subcategory-title";
          subTitle.textContent = sub.subcategory;
          s.currentBlock.appendChild(subTitle);
          const subGrid = document.createElement("div");
          subGrid.className = "products-grid";
          s.currentBlock.appendChild(subGrid);
          s.currentGrid = subGrid;
        }

        const subEnd = Math.min(s.itemIdx + (RENDER_BATCH - rendered), sub.products.length);
        for (let i = s.itemIdx; i < subEnd; i++) {
          tmp.innerHTML = _buildCard(sub.products[i], s.logged);
          s.currentGrid.appendChild(tmp.firstElementChild);
          rendered++;
        }
        s.itemIdx = subEnd;

        if (s.itemIdx >= sub.products.length) {
          s.subIdx++;
          s.itemIdx = 0;
        }
      }

      if (s.subIdx >= blk.subcategories.length) {
        s.blockIdx++;
        s.currentBlock = null;
        s.currentGrid = null;
      }
    } else {
      // Categoría normal
      const prods = blk.products;
      const end = Math.min(s.itemIdx + (RENDER_BATCH - rendered), prods.length);
      for (let i = s.itemIdx; i < end; i++) {
        tmp.innerHTML = _buildCard(prods[i], s.logged);
        s.currentGrid.appendChild(tmp.firstElementChild);
        rendered++;
      }
      s.itemIdx = end;

      if (s.itemIdx >= prods.length) {
        s.blockIdx++;
        s.currentBlock = null;
        s.currentGrid = null;
      }
    }
  }

  if (s.blockIdx >= s.blocks.length) {
    s.done = true;
    _removeSentinel();
  } else {
    _ensureSentinel();
  }
}

function _loadMoreProducts() {
  if (!_renderState || _renderState.done) return;
  if (_renderState.mode === "flat") _renderFlatBatch();
  else _renderCategoryBatch();
}

function _ensureSentinel() {
  const container = $("productsContainer");
  if (!container) return;
  let sentinel = document.getElementById("scrollSentinel");
  if (!sentinel) {
    sentinel = document.createElement("div");
    sentinel.id = "scrollSentinel";
    sentinel.style.height = "1px";
    container.appendChild(sentinel);
  } else {
    container.appendChild(sentinel);
  }

  if (!_scrollObserver) {
    _scrollObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) _loadMoreProducts();
    }, { rootMargin: "600px" });
  }
  _scrollObserver.observe(sentinel);
}

function _removeSentinel() {
  const sentinel = document.getElementById("scrollSentinel");
  if (sentinel) {
    if (_scrollObserver) _scrollObserver.unobserve(sentinel);
    sentinel.remove();
  }
}

/***********************
 * ✨ NOVEDADES — Carrusel productos badge_status = "NUEVO"
 * Auto-scroll tipo marquee (loop infinito por duplicación), pausa al hover.
 * Render parcial: solo el foot de cada card se actualiza en cambios de cart.
 * Animación via requestAnimationFrame en JS (no CSS) para que las flechas
 * puedan correr la posición manualmente sin pelearse con keyframes.
 ***********************/
let __ncStructureSig = ""; // signature de estructura (login + lista de NUEVOS)

const __ncAnim = {
  rafId: null,
  pos: 0, // px desplazados (siempre >= 0; se aplica como translateX(-pos))
  halfWidth: 0, // ancho de un "set" (N cards + N gaps)
  speed: 42, // px/sec
  lastTs: 0,
  paused: false, // pausa por hover/focus
  manualMode: false, // true durante transición de flechas
};

const NC_HIDDEN_KEY = "lk_nc_user_hidden";

function _ncIsUserHidden() {
  try {
    return localStorage.getItem(NC_HIDDEN_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function _ncSetUserHidden(hidden) {
  try {
    if (hidden) localStorage.setItem(NC_HIDDEN_KEY, "1");
    else localStorage.removeItem(NC_HIDDEN_KEY);
  } catch (e) {}
}

function _ncHideByUser() {
  var sec = document.getElementById("newProductsCarousel");
  var showBtn = document.getElementById("ncShowBtn");
  if (sec) sec.hidden = true;
  if (showBtn) showBtn.hidden = false;
  // Carrusel oculto → sidebar de categorías vuelve a su top original
  document.documentElement.style.setProperty("--nc-carousel-h", "0px");
  _ncSetUserHidden(true);
}

function _ncShowByUser() {
  _ncSetUserHidden(false);
  var showBtn = document.getElementById("ncShowBtn");
  if (showBtn) showBtn.hidden = true;
  renderNewProductsCarousel();
}

function _ncFrame(ts) {
  const s = __ncAnim;
  const dt = (ts - s.lastTs) / 1000;
  s.lastTs = ts;

  if (!s.paused && !s.manualMode && s.halfWidth > 0) {
    s.pos += s.speed * dt;
    if (s.pos >= s.halfWidth) s.pos -= s.halfWidth;
  }

  if (!s.manualMode) {
    const track = document.getElementById("newCarouselTrack");
    if (track) track.style.transform = `translateX(${-s.pos}px)`;
  }

  s.rafId = requestAnimationFrame(_ncFrame);
}

function _ncStartAnimation() {
  if (__ncAnim.rafId) return;
  __ncAnim.lastTs = performance.now();
  __ncAnim.rafId = requestAnimationFrame(_ncFrame);
}

function _ncRecalcHalfWidth() {
  const track = document.getElementById("newCarouselTrack");
  if (!track) return;
  const cards = track.querySelectorAll(".nc-card");
  if (cards.length === 0) {
    __ncAnim.halfWidth = 0;
    return;
  }
  const cardW = cards[0].getBoundingClientRect().width;
  const gapPx = parseFloat(getComputedStyle(track).gap) || 14;
  const setSize = cards.length / 2;
  __ncAnim.halfWidth = setSize * (cardW + gapPx);
}

function _ncShift(dir) {
  const s = __ncAnim;
  const track = document.getElementById("newCarouselTrack");
  if (!track || s.halfWidth === 0) return;
  if (s.manualMode) return; // evita double-click rápido

  const cards = track.querySelectorAll(".nc-card");
  const cardW = cards[0]?.getBoundingClientRect().width || 340;
  const gapPx = parseFloat(getComputedStyle(track).gap) || 14;
  const step = (cardW + gapPx) * 2; // mueve 2 cards por click

  let targetPos = s.pos + dir * step;
  targetPos = ((targetPos % s.halfWidth) + s.halfWidth) % s.halfWidth;

  s.manualMode = true;
  track.style.transition = "transform 0.45s cubic-bezier(0.4, 0, 0.2, 1)";
  track.style.transform = `translateX(${-targetPos}px)`;

  setTimeout(() => {
    track.style.transition = "";
    s.pos = targetPos;
    s.manualMode = false;
  }, 470);
}

function _ncWireControls() {
  if (window.__ncWired) return;
  const section = document.getElementById("newProductsCarousel");
  const prev = document.getElementById("ncnPrev");
  const next = document.getElementById("ncnNext");

  if (section) {
    section.addEventListener("mouseenter", () => {
      __ncAnim.paused = true;
    });
    section.addEventListener("mouseleave", () => {
      __ncAnim.paused = false;
    });
    section.addEventListener("focusin", () => {
      __ncAnim.paused = true;
    });
    section.addEventListener("focusout", () => {
      __ncAnim.paused = false;
    });
    // Touch devices: pausar 5s al tocar
    let touchTimer = null;
    section.addEventListener(
      "touchstart",
      () => {
        __ncAnim.paused = true;
        clearTimeout(touchTimer);
        touchTimer = setTimeout(() => {
          __ncAnim.paused = false;
        }, 5000);
      },
      { passive: true },
    );
  }

  if (prev) prev.addEventListener("click", () => _ncShift(-1));
  if (next) next.addEventListener("click", () => _ncShift(1));

  // Botón cerrar (X) → oculta carrusel + persiste preferencia
  var closeBtn = document.getElementById("ncCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      _ncHideByUser();
    });
  }

  // Botón "Mostrar novedades" → vuelve a mostrar
  var showBtn = document.getElementById("ncShowBtn");
  if (showBtn) {
    showBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      _ncShowByUser();
    });
  }

  // En resize, recalcular halfWidth + altura del carrusel + re-render
  // (debounced) por si cambia el modo marquee↔static (ej. agrandar/achicar
  // la ventana cambia cuántas cards entran en el viewport).
  var __ncResizeTimer = null;
  window.addEventListener("resize", function () {
    _ncRecalcHalfWidth();
    var s = document.getElementById("newProductsCarousel");
    if (s && !s.hidden) {
      var h = s.getBoundingClientRect().height;
      document.documentElement.style.setProperty(
        "--nc-carousel-h",
        Math.round(h) + "px",
      );
    }
    clearTimeout(__ncResizeTimer);
    __ncResizeTimer = setTimeout(function () {
      try {
        renderNewProductsCarousel();
      } catch (e) {}
    }, 200);
  });

  // Detectar cuando el carrusel está "pegado" al header (sticky stuck)
  // → toggleamos clase .is-stuck para aplicar top plano + fade inferior.
  var stuckRaf = null;
  function checkStuck() {
    stuckRaf = null;
    var sec = document.getElementById("newProductsCarousel");
    if (!sec || sec.hidden) return;
    var rect = sec.getBoundingClientRect();
    // 86px = altura del header fijo (mismo que el `top:` del sticky)
    sec.classList.toggle("is-stuck", rect.top <= 86);
  }
  window.addEventListener(
    "scroll",
    function () {
      if (stuckRaf) return;
      stuckRaf = requestAnimationFrame(checkStuck);
    },
    { passive: true },
  );
  requestAnimationFrame(checkStuck);

  window.__ncWired = true;
}

function _ncBuildPriceBlock(p, logged, showListPriceOnly) {
  if (!logged) {
    return `<div class="nc-price-locked">Iniciá sesión para ver tu precio</div>`;
  }
  if (showListPriceOnly) {
    return `
      <div class="nc-price-label">Precio Lista</div>
      <div class="nc-price-big">$${formatMoney(p.list_price)} <span class="nc-iva">+ IVA</span></div>
    `;
  }
  const tuPrecio = unitYourPrice(p.list_price);
  const tuPrecioContado = tuPrecio * (1 - WEB_ORDER_DISCOUNT) * (1 - 0.25);
  return `
    <div class="nc-price-label">Tu precio contado</div>
    <div class="nc-price-big">$${formatMoney(tuPrecioContado)} <span class="nc-iva">+ IVA</span></div>
  `;
}

function _ncBuildFootBlock(p, logged) {
  const pid = String(p.id);
  const inCart = cart.find((i) => String(i.productId) === pid);
  const qty = inCart ? Number(inCart.qtyCajas || 0) : 0;

  if (!logged) {
    return `<button type="button" class="nc-add nc-login" onclick="openLogin()">Iniciar sesión</button>`;
  }
  if (qty <= 0) {
    return `<button type="button" class="nc-add" onclick="addFirstBox('${pid}')">Agregar</button>`;
  }
  return `
    <div class="nc-stepper" title="Restá hasta 0 para quitar del pedido">
      <button type="button" class="nc-step" onclick="changeQty('${pid}', -1)" aria-label="Restar">−</button>
      <input class="nc-qty" type="number" min="1" step="1" value="${qty}" inputmode="numeric" onchange="manualQty('${pid}', this.value)">
      <button type="button" class="nc-step" onclick="changeQty('${pid}', 1)" aria-label="Sumar">＋</button>
    </div>
  `;
}

function _ncBuildCardHtml(p, logged, showListPriceOnly, cloneFlag) {
  const pid = String(p.id);
  const codSafe = String(p.cod || "").trim();
  // chef usa imágenes JPG con cache-busting por IMG_VERSION (no WebP+IMG_PARAMS)
  const imgSrc = `${BASE_IMG}${encodeURIComponent(codSafe)}.jpg?v=${encodeURIComponent(IMG_VERSION)}`;
  const imgFallback = "img/no-image.jpg";
  const descSafe = String(p.description || "").replace(/"/g, "&quot;");

  return `
    <article class="nc-card" role="listitem" data-pid="${pid}"${cloneFlag ? ' aria-hidden="true"' : ""}>
      <div class="nc-img-wrap">
        <img
          src="${imgSrc}"
          alt="${descSafe}"
          loading="lazy"
          onerror="this.onerror=null;this.src='${imgFallback}'"
        >
      </div>
      <div class="nc-content">
        <div class="nc-badge">NUEVO</div>
        <div class="nc-body">
          <div class="nc-meta">
            <span class="nc-cod">Cod: <strong>${codSafe}</strong></span>
            <span class="nc-uxb">UxB: <strong>${p.uxb}</strong></span>
          </div>
          <div class="nc-desc" title="${descSafe}">${String(p.description || "")}</div>
        </div>
        <div class="nc-pay">
          <div class="nc-price-block">
            ${_ncBuildPriceBlock(p, logged, showListPriceOnly)}
          </div>
          <div class="nc-foot">
            ${_ncBuildFootBlock(p, logged)}
          </div>
        </div>
      </div>
    </article>
  `;
}

// Decide si el carrusel debe entrar en modo marquee (auto-scroll + duplicado)
// o en modo estático (cards centradas, sin animación) según cuántos productos
// únicos NUEVO haya vs cuántos entran en el viewport.
function _ncShouldMarquee(uniqueCount, sec) {
  if (uniqueCount < 3) return false;
  var viewport = sec && sec.querySelector(".new-carousel-viewport");
  if (!viewport) return uniqueCount >= 6; // fallback conservador
  var vw = viewport.getBoundingClientRect().width || 0;
  // card 300px + gap 14px = ~314px por slot (en mobile baja a 280/260, pero
  // estimar de más es seguro: si dudamos, vamos a static).
  var slotW = 314;
  var visible = Math.max(1, Math.ceil(vw / slotW));
  // Necesitamos al menos visible + 1 cards únicas para que el loop no
  // muestre el mismo producto dos veces dentro del viewport mientras se
  // anima (sin esto, la sensación es "se cargan otra vez los productos").
  return uniqueCount >= visible + 1;
}

function renderNewProductsCarousel() {
  const sec = document.getElementById("newProductsCarousel");
  const track = document.getElementById("newCarouselTrack");
  const showBtn = document.getElementById("ncShowBtn");
  if (!sec || !track) return;

  // Productos cuyo COD termina en "E" (línea destacada de chef).
  // Antes filtraba por badge_status === "NUEVO"; cambiado a sufijo de
  // código a pedido del cliente. La lista se sigue tratando como
  // "Novedades" en la UI (mismo título, mismo carrusel, mismo botón
  // Ocultar/Mostrar) — sólo cambió el criterio de selección.
  const news = (Array.isArray(products) ? products : []).filter((p) => {
    const cod = String(p.cod || "").trim();
    if (!cod) return false;
    return cod.toUpperCase().endsWith("E");
  });

  // Usuario cerró el carrusel → mostrar botón "Mostrar novedades" (solo
  // si hay productos NUEVO; si no hay, ni el botón aparece).
  if (_ncIsUserHidden()) {
    sec.hidden = true;
    if (showBtn) showBtn.hidden = !news.length;
    // Carrusel oculto → sidebar pierde el offset (top vuelve a 110px)
    document.documentElement.style.setProperty("--nc-carousel-h", "0px");
    return;
  }

  if (!news.length) {
    sec.hidden = true;
    if (showBtn) showBtn.hidden = true;
    track.innerHTML = "";
    __ncStructureSig = "";
    // Sin productos NUEVO → sidebar pierde el offset
    document.documentElement.style.setProperty("--nc-carousel-h", "0px");
    return;
  }

  if (showBtn) showBtn.hidden = true;

  // Orden estable: ranking asc → orden_catalogo asc → cod
  news.sort((a, b) => {
    const ra = Number(a.ranking ?? 99999);
    const rb = Number(b.ranking ?? 99999);
    if (ra !== rb) return ra - rb;
    const oa = Number(a.orden_catalogo ?? 99999);
    const ob = Number(b.orden_catalogo ?? 99999);
    if (oa !== ob) return oa - ob;
    return String(a.cod || "").localeCompare(String(b.cod || ""));
  });

  sec.hidden = false;
  // Quitar modo estático heredado — siempre marquee (LK behavior)
  sec.classList.remove("nc-static");

  const logged = !!currentSession;
  const showListPriceOnly = isListPriceOnlyClient();

  // Signature: cuando cambia → full rebuild. Cart no afecta signature.
  const sig =
    (logged ? currentSession.user.id : "guest") +
    "|" +
    (showListPriceOnly ? "L" : "N") +
    "|" +
    news.map((p) => p.id).join(",");

  // Asegurar que el lock por cart NO esté activo — el carrusel solo pausa
  // por hover/focus del mouse, no porque haya items en el cart.
  __ncAnim.lockedByCart = false;

  if (sig === __ncStructureSig && track.children.length) {
    // Solo cart cambió → actualizar foot por card (sin tocar el track → no resetea anim)
    news.forEach((p) => {
      const pid = String(p.id);
      const matches = track.querySelectorAll(
        `.nc-card[data-pid="${CSS.escape(pid)}"] .nc-foot`,
      );
      const footHtml = _ncBuildFootBlock(p, logged);
      matches.forEach((foot) => {
        foot.innerHTML = footHtml;
      });
    });
    // Refresh --nc-carousel-h: cuando el carrusel se OCULTA y se VUELVE a
    // mostrar (Ocultar → Mostrar novedades), el sig matchea y entramos acá.
    // Sin actualizar la variable, la sidebar de categorías queda con el
    // offset 0 (del hide) y se solapa con el banner al scrollear.
    // Inmediato: fallback 140px para evitar flicker en scroll temprano.
    document.documentElement.style.setProperty("--nc-carousel-h", "140px");
    requestAnimationFrame(() => {
      var h = sec.getBoundingClientRect().height;
      if (h > 0) {
        document.documentElement.style.setProperty(
          "--nc-carousel-h",
          Math.round(h) + "px",
        );
      }
    });
    return;
  }

  // Full rebuild — duplicamos SIEMPRE el set para que la animación
  // translateX loopee seamless (LK behavior — no static mode aunque haya
  // pocos productos; las flechas también dependen de tener el clone).
  __ncStructureSig = sig;

  const cardsOnce = news
    .map((p) => _ncBuildCardHtml(p, logged, showListPriceOnly, false))
    .join("");
  const cardsClone = news
    .map((p) => _ncBuildCardHtml(p, logged, showListPriceOnly, true))
    .join("");
  track.innerHTML = cardsOnce + cardsClone;

  __ncAnim.pos = 0;
  __ncAnim.manualMode = false;
  track.style.transition = "";
  track.style.transform = "translateX(0)";

  _ncWireControls();

  // Setear --nc-carousel-h con un fallback razonable INMEDIATAMENTE para
  // que la sidebar sticky no se solape con el carrusel en el primer frame.
  document.documentElement.style.setProperty("--nc-carousel-h", "140px");

  // Recalcular después de que el browser haya pintado las cards
  requestAnimationFrame(() => {
    _ncRecalcHalfWidth();
    // Pocos productos (<3): pausar permanente (no anima) pero el clone sigue
    // existiendo así las flechas funcionan. 3+ productos: marquee activo.
    __ncAnim.paused = news.length < 3;
    _ncStartAnimation();
    // Setear altura real del carrusel → la sidebar sticky se acomoda abajo
    var h = sec.getBoundingClientRect().height;
    document.documentElement.style.setProperty(
      "--nc-carousel-h",
      Math.round(h) + "px",
    );
  });
}

function renderProducts() {
  const container = $("productsContainer");
  if (!container) return;

  _expoSyncDto(); // EXPO: dto por escala según carrito, antes de pintar precios

  // ✨ Sync carrusel de novedades en cada render (mantiene qty en cart sincronizada)
  try {
    renderNewProductsCarousel();
  } catch (e) {
    console.warn("renderNewProductsCarousel falló:", e);
  }

  // Guardar scroll del sidebar para restaurarlo después del re-render.
  const sidebar = $("categoriesSidebar");
  const sidebarTop = sidebar ? sidebar.getBoundingClientRect().top : null;
  const prevScrollY = window.scrollY;

  // Limpiar estado previo
  _removeSentinel();
  container.innerHTML = "";
  _renderState = null;

  const logged = !!currentSession;
  const list =
    typeof getFilteredProducts === "function"
      ? getFilteredProducts()
      : products;

  if (!list.length) {
    container.innerHTML = `
      <div class="empty-message">
        Sin resultados${
          typeof searchTerm === "string" && searchTerm.trim()
            ? ` para "${esc(String(searchTerm).trim())}"`
            : ""
        }.
      </div>
    `;
    return;
  }

  const prepared = _prepareFlatList(list);

  if (prepared.mode === "flat") {
    _renderState = { mode: "flat", items: prepared.items, cursor: 0, done: false, logged };
    _renderFlatBatch();
  } else {
    _renderState = {
      mode: "category", blocks: prepared.blocks,
      blockIdx: 0, subIdx: 0, itemIdx: 0,
      currentBlock: null, currentGrid: null,
      done: false, logged,
    };
    _renderCategoryBatch();
  }

  // Restaurar posición del sidebar después del render.
  // Solo aplica si el usuario YA tenia scroll antes del render.
  // Si el browser auto-bajó el scroll porque el grid se achicó (ej: filtrar
  // una categoria con pocos productos), NO compensar: ese cambio es legitimo
  // y compensar encima produce un salto visible.
  if (sidebar && sidebarTop !== null && prevScrollY > 0) {
    const postScrollY = window.scrollY;
    const autoClamped = postScrollY < prevScrollY - 4;
    if (!autoClamped) {
      const newTop = sidebar.getBoundingClientRect().top;
      const drift = newTop - sidebarTop;
      if (Math.abs(drift) > 2) {
        window.scrollBy(0, drift);
      }
    }
  }

  if (!container.children.length || (container.children.length === 1 && container.firstElementChild.id === "scrollSentinel")) {
    container.innerHTML = `
      <div class="empty-message">
        Sin resultados${
          typeof searchTerm === "string" && searchTerm.trim()
            ? ` para "${esc(String(searchTerm).trim())}"`
            : ""
        }.
      </div>
    `;
  }
}

/***********************
 * MOBILE FILTERS OVERLAY
 ***********************/
function openFiltersOverlay() {
  const ov = $("filtersOverlay");
  if (!ov) return;

  pendingFilterAll = filterAll;
  pendingFilterCats = new Set(filterCats);
  pendingFilterNewOnly = filterNewOnly;

  renderFiltersOverlayUI();

  ov.classList.add("open");
  ov.setAttribute("aria-hidden", "false");
}

function closeFiltersOverlay() {
  const ov = $("filtersOverlay");
  if (!ov) return;

  ov.classList.remove("open");
  ov.setAttribute("aria-hidden", "true");
}

function applyPendingFilters() {
  filterAll = !!pendingFilterAll;
  filterCats = new Set(Array.from(pendingFilterCats || []));
  filterNewOnly = !!pendingFilterNewOnly;

  // UI sync del botón NUEVOS desktop (si existe)
  const b = $("btnFilterNew");
  if (b) b.classList.toggle("on", !!filterNewOnly);

  closeFiltersOverlay();
  renderProducts();
}

function cancelPendingFilters() {
  closeFiltersOverlay();
}

// Panel FILTROS (mobile): SOLO Surtido + Ordenar por.
// Las categorías viven en su propio overlay separado (renderCategoriasOverlayUI).
function renderFiltersOverlayUI() {
  const grid = $("filtersGrid");
  if (!grid) return;

  const sortActive = (mode) => sortMode === mode;

  grid.innerHTML = `
    <div class="mf-section-label">Surtido</div>
    <button type="button" class="mf-btn ${filterMyAssortment ? "on" : ""}" data-toggle="surtido">
      ★ Mi surtido
    </button>
    <button type="button" class="mf-btn mf-btn2 ${pendingFilterNewOnly ? "on" : ""}" data-new="1">
      ⚡ NUEVOS
    </button>

    <div class="mf-section-label">Ordenar por</div>
    <button type="button" class="mf-btn ${sortActive("bestsellers") ? "on" : ""}" data-sort="bestsellers">
      Más vendidos
    </button>
    <button type="button" class="mf-btn ${sortActive("price_desc") ? "on" : ""}" data-sort="price_desc">
      Mayor precio
    </button>
    <button type="button" class="mf-btn ${sortActive("price_asc") ? "on" : ""}" data-sort="price_asc">
      Menor precio
    </button>
  `;

  grid.querySelectorAll(".mf-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isNew = btn.dataset.new === "1";
      const sortAttr = btn.dataset.sort;
      const toggleAttr = btn.dataset.toggle;

      // NUEVOS toggle (pendiente — se aplica con botón "Aplicar")
      if (isNew) {
        pendingFilterNewOnly = !pendingFilterNewOnly;
        renderFiltersOverlayUI();
        return;
      }

      // Mi surtido toggle — aplica directo, no requiere "Aplicar"
      if (toggleAttr === "surtido") {
        filterMyAssortment = !filterMyAssortment;
        if (typeof syncMyAssortmentBtn === "function") syncMyAssortmentBtn();
        if (filterMyAssortment && !(myAssortmentIds instanceof Set)) {
          loadMyAssortmentIds().then((ids) => {
            myAssortmentIds = ids;
            if (typeof renderProducts === "function") renderProducts();
          });
        } else if (typeof renderProducts === "function") {
          renderProducts();
        }
        renderFiltersOverlayUI();
        return;
      }

      // Sort mode — aplica directo
      if (sortAttr) {
        sortMode = sortAttr;
        if (typeof applySortUI === "function") applySortUI();
        renderFiltersOverlayUI();
        return;
      }
    });
  });
}

// Panel CATEGORÍAS (mobile): bottom-sheet separado, sólo categorías.
// "Todos los artículos" + lista de categorías. Selección múltiple
// acumulativa, se aplica con botón "Aplicar".
function renderCategoriasOverlayUI() {
  const grid = $("categoriasGrid");
  if (!grid) return;

  const ordered = getOrderedCategoriesFrom(products);
  const isOn = (cat) => pendingFilterCats.has(cat);

  grid.innerHTML = `
    <button type="button" class="mf-btn mf-btn-all ${pendingFilterAll ? "on" : ""}" data-all="1">
      Todos los artículos
    </button>
    ${ordered
      .map(
        (cat) => `
          <button type="button" class="mf-btn ${isOn(cat) ? "on" : ""}" data-cat="${esc(cat)}">
            ${esc(cat)}
          </button>
        `,
      )
      .join("")}
  `;

  grid.querySelectorAll(".mf-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const isAll = btn.dataset.all === "1";
      const cat = btn.dataset.cat;

      if (isAll) {
        pendingFilterAll = true;
        pendingFilterCats.clear();
      } else {
        pendingFilterAll = false;
        if (pendingFilterCats.has(cat)) pendingFilterCats.delete(cat);
        else pendingFilterCats.add(cat);
        if (pendingFilterCats.size === 0) {
          pendingFilterAll = true;
        }
      }

      renderCategoriasOverlayUI();
    });
  });
}

function openCategoriasOverlay() {
  const ov = $("categoriasOverlay");
  if (!ov) return;
  // Sync TODO el estado pendiente desde el estado aplicado real, así si
  // el usuario abrió filtros antes y los canceló sin aplicar, no quedan
  // pending flags zombies que se aplicarían al hacer Apply en categorías.
  pendingFilterAll = filterAll;
  pendingFilterCats = new Set(filterCats);
  pendingFilterNewOnly = filterNewOnly;
  renderCategoriasOverlayUI();
  ov.classList.add("open");
  ov.setAttribute("aria-hidden", "false");
}

function closeCategoriasOverlay() {
  const ov = $("categoriasOverlay");
  if (!ov) return;
  ov.classList.remove("open");
  ov.setAttribute("aria-hidden", "true");
}

window.openCategoriasOverlay = openCategoriasOverlay;
window.closeCategoriasOverlay = closeCategoriasOverlay;

/***********************
 * DELIVERY OPTIONS (DB)
 ***********************/
function resetShippingSelect() {
  const sel = $("shippingSelect");
  if (!sel) return;

  sel.innerHTML = `<option value="" selected>Elegir Sucursal</option>`;
  deliveryChoice = { slot: "", label: "", direccionEntrega: "", zonaExpreso: "" };
  deliveryConfirmed = false;

  // Limpiar boton confirmar si existe
  var confirmBtn = document.getElementById("shipConfirmBtn");
  if (confirmBtn) confirmBtn.remove();
  var shipCard = sel.closest(".ship-card");
  if (shipCard) shipCard.classList.remove("has-confirm");

  // Reenvolver el select con el dropdown custom (sin opciones → popup vacío)
  if (typeof _csWireSelectDropdown === "function") {
    _csWireSelectDropdown(sel, {
      placeholder: "Elegir Sucursal",
      extraClass: "cs-dropdown-card cs-dropdown-ship",
      emptyText: "Sin sucursales disponibles",
    });
  }
}

let _deliveryOptionsLoadedForCustomer = null;

async function loadDeliveryOptions(force) {
  const sel = $("shippingSelect");
  if (!sel) return;

  // Si no hay sesión, intentar recuperarla una vez
  if (!currentSession || !customerProfile?.id) {
    try { await refreshAuthState(); } catch (_) {}
  }
  if (!currentSession || !customerProfile?.id) {
    resetShippingSelect();
    _deliveryOptionsLoadedForCustomer = null;
    return;
  }

  // No recargar si ya estan cargadas para el mismo cliente (salvo force)
  if (!force && _deliveryOptionsLoadedForCustomer === customerProfile.id) {
    updateCart();
    return;
  }

  resetShippingSelect();

  try {
    let data, error;
    // Intentar con todos los campos; si falla (columna no existe), fallback a slot,label
    ({ data, error } = await supabaseClient
      .from("customer_delivery_addresses")
      .select("slot,label,direccion_entrega,zona_expreso")
      .eq("customer_id", customerProfile.id)
      .order("slot", { ascending: true }));

    if (error) {
      console.warn("delivery options full select failed, fallback:", error.message);
      ({ data, error } = await supabaseClient
        .from("customer_delivery_addresses")
        .select("slot,label")
        .eq("customer_id", customerProfile.id)
        .order("slot", { ascending: true }));
    }

    if (error) {
      console.error("delivery options error:", error);
      return;
    }

    const rows = data || [];
    rows.forEach((row) => {
      const opt = document.createElement("option");
      opt.value = String(row.slot);
      opt.textContent = `${row.slot}: ${row.label}`;
      opt.dataset.label = row.label || "";
      opt.dataset.direccionEntrega = row.direccion_entrega || "";
      opt.dataset.zonaExpreso = row.zona_expreso || "";
      sel.appendChild(opt);
    });

    // Lógica botón "Confirmar dirección entrega":
    //  - 1 sola sucursal → auto-confirma + oculta botón + oculta hint
    //  - 2+ sucursales → muestra botón + hint, cliente debe apretarlo
    var singleAddress = rows.length === 1;

    if (rows.length >= 1) {
      // Si hay una sola, auto-seleccionar en el dropdown + auto-confirmar
      if (singleAddress) {
        sel.value = String(rows[0].slot);
        deliveryChoice.slot = String(rows[0].slot);
        deliveryChoice.label = rows[0].label || "";
        deliveryChoice.direccionEntrega = rows[0].direccion_entrega || "";
        deliveryChoice.zonaExpreso = rows[0].zona_expreso || "";
        deliveryConfirmed = true; // auto-confirm
      }

      // Reenvolver el select con el dropdown custom
      if (typeof _csWireSelectDropdown === "function") {
        _csWireSelectDropdown(sel, {
          placeholder: "Elegir Sucursal",
          extraClass: "cs-dropdown-card cs-dropdown-ship",
          emptyText: "Sin sucursales disponibles",
        });
      }

      var existingBtn = document.getElementById("shipConfirmBtn");
      var shipCard = sel.closest(".ship-card");
      var hintEl = shipCard ? shipCard.querySelector(".ship-hint") : null;

      if (singleAddress) {
        // 1 sucursal → no botón, no hint
        if (shipCard) {
          shipCard.classList.add("auto-confirmed");
          shipCard.classList.remove("has-confirm");
        }
        if (hintEl) hintEl.style.display = "none";
        if (existingBtn) existingBtn.remove();
      } else {
        // 2+ sucursales → mostrar hint + botón Confirmar (re-set por si venía
        // oculto de un cliente previo con 1 sucursal)
        if (shipCard) {
          shipCard.classList.add("has-confirm");
          shipCard.classList.remove("auto-confirmed");
        }
        if (hintEl) hintEl.style.display = "";

        if (existingBtn) {
          // Reset si venía confirmado de un cliente previo
          if (existingBtn.classList.contains("confirmed")) {
            existingBtn.classList.remove("confirmed");
            existingBtn.textContent = "Confirmar";
            existingBtn.disabled = false;
          }
        } else {
          var btn = document.createElement("button");
          btn.type = "button";
          btn.id = "shipConfirmBtn";
          btn.className = "ship-confirm-btn";
          btn.textContent = "Confirmar";
          var dropdownWrap = sel.closest(".cs-dropdown") || sel;
          dropdownWrap.parentNode.insertBefore(btn, dropdownWrap.nextSibling);

          btn.addEventListener("click", function () {
            var v = sel ? String(sel.value || "").trim() : "";
            if (!v) return;
            this.textContent = "Confirmada";
            this.classList.add("confirmed");
            this.disabled = true;
            deliveryConfirmed = true;
            var shipCardConfirmed = this.closest(".ship-card");
            if (shipCardConfirmed) {
              var hintConfirmed = shipCardConfirmed.querySelector(".ship-hint");
              if (hintConfirmed) hintConfirmed.style.display = "none";
            }
            refreshSubmitEnabled();
            updateCart();
          });
        }

        // Estado inicial del botón: habilitado si hay slot
        var shipBtn = document.getElementById("shipConfirmBtn");
        if (shipBtn && !deliveryConfirmed) {
          shipBtn.disabled = !deliveryChoice.slot;
        }
      }
    }

    _deliveryOptionsLoadedForCustomer = customerProfile.id;
  } catch (e) {
    console.error("loadDeliveryOptions exception:", e);
  }

  updateCart();
}

// =============================
// UX: fly-to-cart + toast "Ver pedido"
// =============================
let __viewOrderShowTimer = null;
let __viewOrderHideTimer = null;

function getVisibleCartIconEl() {
  // Desktop icon
  const desktop = document.getElementById("cartIcon");
  if (desktop && desktop.offsetParent !== null) return desktop;

  // Mobile icon (dentro del botón)
  const mobileBtn = document.getElementById("mobileCartBtn");
  if (mobileBtn && mobileBtn.offsetParent !== null) {
    const img = mobileBtn.querySelector("img");
    return img || mobileBtn;
  }

  // fallback: link del carrito
  const link = document.getElementById("cartLink");
  if (link && link.offsetParent !== null) return link;

  return null;
}

// ✅ Dispara la cadena completa de animaciones al agregar al carrito:
//    1) imagen vuela al carrito; 2) bump card; 3) pop del input qty; 4) shake del cart icon.
// Llamar SIEMPRE después de renderProducts() para que las clases se apliquen al DOM ya re-renderizado.
function triggerAddAnimations(productId) {
  requestAnimationFrame(() => {
    // 1) imagen vuela al carrito
    flyProductImageToCart(productId);

    // 2) bump de la card
    const card = document.getElementById(`card-${productId}`);
    if (card) {
      card.classList.remove("lk-bump");
      void card.offsetWidth; // reflow → re-dispara animación si se clickea rápido
      card.classList.add("lk-bump");
    }

    // 3) pop del input de cantidad
    if (card) {
      const qtyInput = card.querySelector(".step-input");
      if (qtyInput) {
        qtyInput.classList.remove("lk-pop");
        void qtyInput.offsetWidth;
        qtyInput.classList.add("lk-pop");
      }

      // 3b) celebración en la imagen: bounce + wobble + pulse combinados
      const img = card.querySelector("img");
      if (img) {
        img.classList.remove("lk-celebrate");
        void img.offsetWidth;
        img.classList.add("lk-celebrate");
      }
    }

    // 4) shake del ícono del carrito cuando "llega" el vuelo
    setTimeout(() => {
      const target = getVisibleCartIconEl();
      if (!target) return;
      target.classList.remove("lk-cart-shake");
      void target.offsetWidth;
      target.classList.add("lk-cart-shake");
    }, 480);
  });
}

function flyProductImageToCart(productId) {
  const img = document.getElementById(`img-${productId}`);
  const target = getVisibleCartIconEl();
  if (!img || !target) return;

  const r1 = img.getBoundingClientRect();
  const r2 = target.getBoundingClientRect();
  if (!r1.width || !r1.height || !r2.width || !r2.height) return;

  const clone = img.cloneNode(true);
  clone.className = "fly-to-cart";
  clone.style.left = `${r1.left}px`;
  clone.style.top = `${r1.top}px`;
  clone.style.width = `${r1.width}px`;
  clone.style.height = `${r1.height}px`;
  clone.style.opacity = "1";
  clone.style.transform = "translate3d(0,0,0) scale(1)";

  document.body.appendChild(clone);

  const dx = r2.left + r2.width / 2 - (r1.left + r1.width / 2);
  const dy = r2.top + r2.height / 2 - (r1.top + r1.height / 2);

  // start anim next frame
  requestAnimationFrame(() => {
    clone.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.15)`;
    clone.style.opacity = "0";
  });

  clone.addEventListener("transitionend", () => clone.remove(), { once: true });
}

function hideViewOrderToast() {
  const t = document.getElementById("viewOrderToast");
  if (!t) return;
  t.classList.remove("show");
  t.setAttribute("aria-hidden", "true");
}

function positionViewOrderToastBelowHeader() {
  const header =
    document.querySelector("header") || document.querySelector(".header");
  const toast = document.getElementById("viewOrderToast");
  if (!header || !toast) return;

  const headerRect = header.getBoundingClientRect();
  const offset = Math.max(0, headerRect.bottom + 10); // 10px de aire

  toast.style.top = `${offset}px`;
}

function showViewOrderToast() {
  const t = document.getElementById("viewOrderToast");
  if (!t) return;

  positionViewOrderToastBelowHeader();

  t.classList.add("show");
  t.setAttribute("aria-hidden", "false");
}

function scheduleViewOrderToastAfterAdd() {
  // no acumulativo: si agregás otra vez, resetea el “3s visible”
  clearTimeout(__viewOrderShowTimer);
  clearTimeout(__viewOrderHideTimer);

  // aparece rápido (80ms) para que se sienta “instantáneo”
  __viewOrderShowTimer = setTimeout(() => {
    showViewOrderToast();

    // y se oculta 3s después de aparecer
    clearTimeout(__viewOrderHideTimer);
    __viewOrderHideTimer = setTimeout(() => hideViewOrderToast(), 3000);
  }, 80);
}

/***********************
 * CART
 ***********************/
// ==============================
// CART (persistencia entre páginas)
// ==============================
const CART_LS_KEY = "lk_mayorista_cart_v1";

function loadCartFromLS() {
  try {
    const raw = localStorage.getItem(CART_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // normaliza (mantiene isUpsellPromo para no perder el flag al recargar)
    return arr
      .map((x) => ({
        productId: String(x.productId),
        qtyCajas: Math.max(1, parseInt(x.qtyCajas, 10) || 1),
        isUpsellPromo: !!x.isUpsellPromo,
      }))
      .filter((x) => x.productId);
  } catch {
    return [];
  }
}

function saveCartToLS() {
  try {
    // guardamos SOLO lo mínimo + el flag isUpsellPromo (necesario para
    // que el carrito sobreviva navegación y recargas sin perder el precio de upsell).
    const payload = cart.map((x) => ({
      productId: String(x.productId),
      qtyCajas: Math.max(1, parseInt(x.qtyCajas, 10) || 1),
      isUpsellPromo: !!x.isUpsellPromo,
    }));
    localStorage.setItem(CART_LS_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn("No se pudo guardar el carrito en localStorage:", e);
  }
}

// Hidrata el carrito YA, al evaluar el script (antes de DOMContentLoaded).
// Esto garantiza que cualquier código que dependa de `cart` durante la
// inicialización vea el carrito recuperado (carrusel de novedades, contadores,
// renderProducts en la primera pasada, etc.).
(function hydrateCartFromLS() {
  const savedCart = loadCartFromLS();
  if (savedCart.length) cart.splice(0, cart.length, ...savedCart);
})();

function isVendorProfileBrowseMode() {
  if (!isActualVendor() || !currentSession) return false;
  // Vendedor en perfil propio (sin cliente seleccionado vía dropdown o LS)
  return isVendorOwnMode() && !hasVendorSelection();
}
window.isVendorProfileBrowseMode = isVendorProfileBrowseMode;

/**
 * Oculta el botón "Pedido (N)" del header (desktop + mobile) cuando el
 * vendedor está en modo browse (perfil propio sin cliente seleccionado) O
 * cuando está viendo su propio perfil. El vendedor no puede comprar a su
 * nombre, entonces no tiene sentido mostrarle el carrito hasta que actúe
 * como un cliente.
 */
function _updateCartUIVisibility() {
  // Ocultar carrito tanto en browse mode como en perfil propio del vendedor
  var hide =
    isVendorProfileBrowseMode() ||
    (typeof isVendorOwnMode === "function" && isVendorOwnMode());
  var cartLink = document.getElementById("cartLink");
  if (cartLink) cartLink.style.display = hide ? "none" : "";
  var mobileCartBtn = document.getElementById("mobileCartBtn");
  if (mobileCartBtn) mobileCartBtn.style.display = hide ? "none" : "";
}
window._updateCartUIVisibility = _updateCartUIVisibility;

function scrollToCustomerSelector() {
  var banner = document.getElementById("customerSelectorBanner");
  if (banner && banner.scrollIntoView) {
    banner.scrollIntoView({ behavior: "smooth", block: "center" });
    // Flash visual para llamar atención
    banner.classList.remove("cs-flash-attention");
    void banner.offsetWidth;
    banner.classList.add("cs-flash-attention");
    return;
  }
  // Fallback: scrollear al select normal
  var el =
    document.getElementById("customerSelect") ||
    document.querySelector(".customer-selector-banner");
  if (el && el.scrollIntoView) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
window.scrollToCustomerSelector = scrollToCustomerSelector;

function addFirstBox(productId) {
  if (!currentSession) {
    openLogin();
    return;
  }

  // Guard: vendor en browse mode (sin cliente seleccionado) → no puede
  // comprar a su nombre, redirigir al selector de razón social
  if (isVendorProfileBrowseMode()) {
    scrollToCustomerSelector();
    return;
  }

  // Guard: no permitir agregar productos PROXIMAMENTE / SIN STOCK
  // (botones inline ya están disabled, esto cubre cualquier path adicional)
  const product = (products || []).find(
    (p) => String(p.id) === String(productId),
  );
  if (product) {
    const status = String(product.badge_status || "")
      .trim()
      .toUpperCase();
    if (
      status === "SIN STOCK" ||
      status === "PROXIMAMENTE" ||
      status === "PRÓXIMAMENTE"
    ) {
      return;
    }
  }

  const existing = cart.find((i) => i.productId === productId);

  if (existing) {
    existing.qtyCajas += 1;
  } else {
    cart.push({ productId, qtyCajas: 1 });
    toggleControls(productId, true);
  }

  // ✅ Toast: 3s después del último “agregar” (no acumulativo)
  scheduleViewOrderToastAfterAdd();

  updateCart();
  renderProducts();

  // 🎬 Animaciones: vuela al carrito + bump card + pop qty + shake ícono (siempre)
  triggerAddAnimations(productId);
}

function changeQty(productId, delta) {
  const item = cart.find((i) => i.productId === productId);
  if (!item) return;

  item.qtyCajas += delta;

  if (item.qtyCajas <= 0) {
    removeItem(productId);
    return;
  }

  const input = document.querySelector(`#qty-${CSS.escape(productId)} input`);
  if (input) input.value = item.qtyCajas;

  updateCart();
  renderProducts();

  // 🎬 Solo al SUMAR (no al restar)
  if (delta > 0) triggerAddAnimations(productId);
}

function manualQty(productId, value) {
  const qty = Math.max(0, parseInt(value, 10) || 0);

  const item = cart.find((i) => i.productId === productId);
  if (!item) return;

  if (qty <= 0) {
    removeItem(productId);
    return;
  }

  item.qtyCajas = qty;
  updateCart();
  renderProducts();
}

function removeItem(productId) {
  const idx = cart.findIndex((i) => i.productId === productId);
  if (idx >= 0) cart.splice(idx, 1);

  toggleControls(productId, false);
  updateCart();
  renderProducts();
}

function toggleControls(productId, show) {
  const addBtn = $(`add-${productId}`);
  const qtyWrap = $(`qty-${productId}`);

  if (addBtn) addBtn.style.display = show ? "none" : "inline-block";
  if (qtyWrap) qtyWrap.style.display = show ? "block" : "none";
}

function calcTotals() {
  const logged = !!currentSession;
  const paymentDiscount = getPaymentDiscount();
  const webDiscountRate = (isAdmin && !hasVendorSelection() && !_expoActiveCustomer) ? 0 : WEB_ORDER_DISCOUNT;

  let subtotal = 0;

  if (logged) {
    cart.forEach((item) => {
      const p = products.find((x) => String(x.id) === String(item.productId));
      if (!p) return;

      const totalUni = item.qtyCajas * Number(p.uxb || 0);
      subtotal += unitYourPrice(p.list_price) * totalUni;
    });
  }

  let totalNoDiscount = 0;
  cart.forEach((item) => {
    const p = products.find((x) => String(x.id) === String(item.productId));
    if (!p) return;

    const totalUni = item.qtyCajas * Number(p.uxb || 0);
    totalNoDiscount += Number(p.list_price || 0) * totalUni;
  });

  const webDiscountValue = subtotal * webDiscountRate;
  const afterWeb = subtotal - webDiscountValue;

  const paymentDiscountValue = afterWeb * paymentDiscount;
  const finalTotal = afterWeb - paymentDiscountValue;

  const totalDiscounts = Math.max(0, totalNoDiscount - finalTotal);

  return {
    logged,
    paymentDiscount,
    webDiscountRate,
    subtotal,
    totalNoDiscount,
    webDiscountValue,
    paymentDiscountValue,
    finalTotal,
    totalDiscounts,
  };
}

function updateCart() {
  const cartDiv = $("cart");
  if (!cartDiv) return;

  _expoSyncDto();    // EXPO: recalcula dto por escala según el carrito actual
  _expoUpdateChip(); // EXPO: repinta el chip del cliente activo

  const submitBtn = document.getElementById("submitOrderBtn");

  const hasShipping = !!deliveryChoice?.slot && deliveryConfirmed;
  const hasPayment = (isAdmin && !hasVendorSelection())
    ? true
    : !!document.getElementById("paymentSelect")?.value;
  const hasItems = cart.length > 0;

  submitBtn.disabled = !(hasShipping && hasPayment && hasItems);

  const t = calcTotals();

  if (!cart.length) {
    cartDiv.innerHTML = `
      <div class="cart-empty">
        <div class="cart-empty-row">
          <svg class="cart-empty-face" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <circle cx="60" cy="60" r="48" fill="none" stroke="#222" stroke-width="7"/>
            <circle cx="46" cy="52" r="5" fill="#222"/>
            <circle cx="74" cy="52" r="5" fill="#222"/>
            <path d="M44 80 Q60 66 76 80" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>
          </svg>
          <div class="cart-empty-text-wrap">
            <h3 class="cart-empty-title">Tu carrito está vacío</h3>
            <p class="cart-empty-text">Explorá los productos y agregá los que necesites para armar tu pedido.</p>
          </div>
        </div>
        <button type="button" class="cart-empty-btn" onclick="showSection('productos')">
          ← Ver productos
        </button>
      </div>
    `;
  } else {
    let rows = "";

    cart.forEach((item) => {
      const p = products.find((x) => String(x.id) === String(item.productId));
      if (!p) return;

      const totalCajas = item.qtyCajas;
      const totalUni = totalCajas * Number(p.uxb || 0);

      const tuPrecioUnit = t.logged ? unitYourPrice(p.list_price) : 0;
      const lineTotal = t.logged ? tuPrecioUnit * totalUni : 0;

      const pidAttr = String(item.productId).replace(/'/g, "\\'");

      rows += `
        <tr>
          <td><strong>${esc(String(p.cod || ""))}</strong></td>
          <td class="desc">${splitTwoWords(esc(p.description))}</td>
          <td>
            <div class="cart-step">
              <button type="button" class="cart-step-btn" onclick="changeQty('${pidAttr}', -1)" aria-label="Restar una caja">−</button>
              <input type="number" min="0" class="cart-step-input" value="${totalCajas}" onchange="manualQty('${pidAttr}', this.value)" aria-label="Cantidad de cajas" />
              <button type="button" class="cart-step-btn" onclick="changeQty('${pidAttr}', 1)" aria-label="Sumar una caja">+</button>
              <button type="button" class="cart-step-remove" onclick="removeItem('${pidAttr}')" aria-label="Eliminar del pedido" title="Eliminar">✕</button>
            </div>
          </td>
          <td>${formatMoney(totalUni)}</td>
          <td>${t.logged ? "$" + formatMoney(tuPrecioUnit) + "<br><span class='cart-iva'>+ IVA</span>" : "—"}</td>
          <td><strong>${t.logged ? "$" + formatMoney(lineTotal) + "<br><span class='cart-iva'>+ IVA</span>" : "—"}</strong></td>
        </tr>
      `;
    });

    cartDiv.innerHTML = `
      <table class="cart-table">
        <colgroup>
          <col class="cod">
          <col class="desc">
          <col class="cajas">
          <col class="uni">
          <col class="tp">
          <col class="total">
        </colgroup>

        <thead>
          <tr>
            <th>${headerTwoLine("Cod")}</th>
            <th>${headerTwoLine("Descripción")}</th>
            <th>${headerTwoLine("Total Cajas")}</th>
            <th>${headerTwoLine("Total Uni")}</th>
            <th>${headerTwoLine((isAdmin && !hasVendorSelection()) ? "Precio Lista" : "Tu Precio")}</th>
            <th>${headerTwoLine("Total $")}</th>
          </tr>
        </thead>

        <tbody>${rows}</tbody>
      </table>
    `;
  }

  $("subtotal") && ($("subtotal").innerText = formatMoney(t.subtotal));
  $("webDiscountValue") &&
    ($("webDiscountValue").innerText = formatMoney(t.webDiscountValue));
  $("paymentDiscountValue") &&
    ($("paymentDiscountValue").innerText = formatMoney(t.paymentDiscountValue));
  $("total") && ($("total").innerText = formatMoney(t.finalTotal));

  if ($("pedidoTotalHeader"))
    $("pedidoTotalHeader").innerText = formatMoney(t.finalTotal);

  if ($("paymentDiscountPercent")) {
    $("paymentDiscountPercent").innerText =
      (t.paymentDiscount * 100).toFixed(0) + "%";
  }

  $("totalNoDiscount") &&
    ($("totalNoDiscount").innerText = formatMoney(t.totalNoDiscount));
  $("totalDiscounts") &&
    ($("totalDiscounts").innerText = formatMoney(t.totalDiscounts));

  let count = 0;
  cart.forEach((i) => (count += i.qtyCajas));
  $("cartCount") && ($("cartCount").innerText = count);
  $("mobileCartCount") && ($("mobileCartCount").innerText = count);

  const btn = $("submitOrderBtn");
  if (btn) {
    const mustChooseDelivery = !deliveryChoice.slot;
    const mustConfirmDelivery = !!deliveryChoice.slot && !deliveryConfirmed;
    const canConfirm =
      !!currentSession && cart.length > 0 && !mustChooseDelivery && !mustConfirmDelivery;

    btn.disabled = !canConfirm;

    if (!!currentSession && cart.length > 0 && mustChooseDelivery) {
      setOrderStatus(
        "Elegí una opción de Entrega para poder confirmar el pedido.",
        "err",
      );
    } else if (!!currentSession && cart.length > 0 && mustConfirmDelivery) {
      setOrderStatus(
        'Confirmá tu dirección de entrega para poder confirmar el pedido.',
        "err",
      );
    } else if (btn.disabled === false) {
      setOrderStatus("");
    }
  }
  syncAdminCheckoutUI();
  // Refrescar módulo "¿Seguro que no necesitás esto?" cada vez que cambia
  // el carrito — así si el cliente agrega un item, desaparece de la lista
  if (typeof renderMissingAssortmentModule === "function") {
    renderMissingAssortmentModule();
  }
  // ✅ persiste carrito para otras páginas (sugerencias, historial, etc.)
  saveCartToLS();
}

/***********************
 * SEND TO SHEETS + SUBMIT ORDER
 ***********************/
async function sendOrderToSheets({
  orderNumber,
  codCliente,
  vend,
  condicionPago,
  condicionPagoCode,
  sucursalEntrega,
  clienteNuevo,
  items,
  // Datos del customer para construir Leyenda 2 (D/LC/PP) en Apps Script
  deuda,
  payment_term,
  credit_limit,
  order_total,
}) {
  if (!SHEETS_PROXY_URL) {
    throw new Error("Sheets proxy config missing");
  }

  const payload = {
    order_number: String(orderNumber || "").trim(),
    condicion_pago_code: Number(condicionPagoCode || 0),
    cod_cliente: String(codCliente || "").trim(),
    vend: String(vend || "").trim(),
    condicion_pago: String(condicionPago || "").trim(),
    sucursal_entrega: String(sucursalEntrega || "").trim(),
    cliente_nuevo: String(clienteNuevo || "").trim(),
    is_chef: true, // marca pedidos de la página Chef → ruta a hoja "Pedidos CH"
    // Campos para Leyenda 2 (col J en Pedidos CH)
    deuda: Number(deuda || 0),
    payment_term: payment_term != null ? Number(payment_term) : null,
    credit_limit: credit_limit != null ? Number(credit_limit) : null,
    order_total: Number(order_total || 0),
    items: (items || []).map((it) => ({
      cod_art: String(it.cod_art || "").trim(),
      cajas: Number(it.cajas || 0),
      uxb: Number(it.uxb || 0),
    })),
  };

  const token = currentSession?.access_token || "";
  const resp = await fetch(SHEETS_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!resp.ok || data?.ok === false) {
    throw new Error(data?.error || `Proxy error ${resp.status}`);
  }

  return data;
}

async function withTimeout(promise, ms, label = "timeout") {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`Timeout (${ms}ms) en ${label}`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(t);
  }
}


/***********************
 * ROLLBACK ORDER
 ***********************/
async function rollbackOrder(orderId) {
  if (!orderId) return;

  const delItems = await supabaseClient
    .from("order_items")
    .delete()
    .eq("order_id", orderId);

  if (delItems.error) {
    console.error("rollback order_items error:", delItems.error);
  }

  const delOrder = await supabaseClient
    .from("orders")
    .delete()
    .eq("id", orderId);

  if (delOrder.error) {
    console.error("rollback orders error:", delOrder.error);
  }
}

/***********************
 * SEND TO SHEETS WITH RETRY
 ***********************/
async function sendOrderToSheetsWithRetry(payload, maxAttempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        setOrderStatus("Error al enviar a Sheets. Reintentando...", "err");
        setSubmitOrderLoading(true, `Reintentando... (${attempt}/${maxAttempts})`);
      }

      const result = await withTimeout(
        sendOrderToSheets(payload),
        25000,
        `Sheets proxy intento ${attempt}`,
      );

      return result;
    } catch (e) {
      lastError = e;
      console.warn(`Sheets intento ${attempt} falló:`, e);

      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }

  throw lastError || new Error("Falló el envío a Sheets");
}

/***********************
 * SEND TO ENTREGAS SHEET (PPP + Base Picking)
 ***********************/
async function sendOrderToEntregasSheet(payload) {
  if (!SHEETS_ENTREGAS_PROXY_URL) return;
  try {
    const token = currentSession?.access_token || SUPABASE_ANON_KEY;
    const resp = await fetch(SHEETS_ENTREGAS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(function() { return {}; });
    if (!resp.ok || data?.ok === false) {
      console.warn("Entregas sheet error:", data?.error || resp.status);
    }
  } catch (e) {
    console.warn("Entregas sheet error:", e);
  }
}

/***********************
 * VALIDATE CART
 ***********************/
function normalizeCartAgainstProducts() {
  if (!Array.isArray(products) || !products.length) return;

  const validIds = new Set(products.map((p) => String(p.id)));
  const cleaned = cart.filter((item) => validIds.has(String(item.productId)));

  if (cleaned.length !== cart.length) {
    cart.splice(0, cart.length, ...cleaned);
    saveCartToLS();
  }
}

/***********************
 * ANOMALY DETECTION
 ***********************/
async function loadAnomalyData(codCliente) {
  if (_anomalyCache.customerId === codCliente && _anomalyCache.map) {
    return _anomalyCache.map;
  }
  try {
    const { data, error } = await supabaseClient
      .from("v_customer_item_month")
      .select("item_code, boxes, ym")
      .eq("customer_code", String(codCliente).trim());

    if (error || !data || !data.length) {
      _anomalyCache = { customerId: codCliente, map: new Map() };
      return _anomalyCache.map;
    }

    const totals = {};
    const itemMonths = {};
    for (const r of data) {
      const code = String(r.item_code || "").trim();
      if (!code) continue;
      totals[code] = (totals[code] || 0) + Number(r.boxes || 0);
      if (!itemMonths[code]) itemMonths[code] = new Set();
      itemMonths[code].add(r.ym);
    }

    const map = new Map();
    for (const code in totals) {
      const months = itemMonths[code].size || 1;
      map.set(code, { avg: totals[code] / months, totalBoxes: totals[code], months: months });
    }

    _anomalyCache = { customerId: codCliente, map: map };
    return map;
  } catch (e) {
    console.warn("loadAnomalyData error:", e);
    return new Map();
  }
}

function checkItemAnomaly(anomalyMap, codArt, cajasOrdered) {
  if (!anomalyMap || !anomalyMap.size) return null;
  const code = String(codArt || "").trim();
  const info = anomalyMap.get(code);
  if (!info || info.avg <= 0) return null;
  const ratio = cajasOrdered / info.avg;
  if (ratio >= ANOMALY_THRESHOLD) {
    return { avg: info.avg, ratio: ratio, months: info.months };
  }
  return null;
}

async function sendAnomalyAlertToSheets(alertPayload) {
  if (!SHEETS_PROXY_URL) return;
  try {
    var payload = Object.assign({ action: "anomaly_alert" }, alertPayload);
    var token = currentSession?.access_token || SUPABASE_ANON_KEY;
    var resp = await fetch(SHEETS_PROXY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(payload),
    });
    var data = await resp.json().catch(function() { return {}; });
    if (!resp.ok || data?.ok === false) {
      console.warn("Anomaly alert sheet error:", data?.error || resp.status);
    }
  } catch (e) {
    console.warn("Anomaly alert sheet error:", e);
  }
}

/***********************
 * UPSELL POPUP
 ***********************/
function getNextSundayMidnight() {
  var now = new Date();
  var day = now.getDay();
  var daysUntilSunday = day === 0 ? 0 : 7 - day;
  var target = new Date(now);
  target.setDate(target.getDate() + daysUntilSunday);
  target.setHours(23, 59, 59, 999);
  if (now >= target && day === 0) {
    target.setDate(target.getDate() + 7);
  }
  return target;
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00:00";
  var s = Math.floor(ms / 1000);
  var d = Math.floor(s / 86400); s %= 86400;
  var h = Math.floor(s / 3600); s %= 3600;
  var m = Math.floor(s / 60); s %= 60;
  var parts = [];
  if (d > 0) parts.push(d + "d");
  parts.push(String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0"));
  return parts.join(" ");
}

function getUpsellProducts() {
  var cartIds = new Set(cart.map(function(i) { return String(i.productId); }));
  var historyIds = myAssortmentIds instanceof Set ? myAssortmentIds : new Set();

  var eligible = UPSELL_CODES.map(function(cod) {
    var p = products.find(function(x) { return String(x.cod || "").trim() === cod; });
    if (!p) return null;
    var pid = String(p.id);
    if (cartIds.has(pid)) return null;
    if (historyIds.has(pid)) return null;
    return p;
  }).filter(Boolean);

  eligible.sort(function(a, b) {
    var ra = a.ranking != null ? Number(a.ranking) : Infinity;
    var rb = b.ranking != null ? Number(b.ranking) : Infinity;
    return ra - rb;
  });

  return eligible.slice(0, 4);
}

function showUpsellPopup(upsellProducts) {
  return new Promise(function(resolve) {
    var overlay = document.createElement("div");
    overlay.id = "upsellOverlay";
    overlay.className = "upsell-overlay";

    var logged = !!currentSession && !!customerProfile;
    var upsellCart = {};
    var deadline = getNextSundayMidnight();
    var timerInterval = null;

    function calcContadoPrice(listPrice) {
      if (!logged) return 0;
      if (isAdmin && !hasVendorSelection()) return Number(listPrice || 0);
      return unitYourPrice(listPrice) * (1 - WEB_ORDER_DISCOUNT) * (1 - 0.25);
    }
    function calcUpsellPrice(listPrice) {
      return calcContadoPrice(listPrice) * (1 - 0.30);
    }

    function updateBtnState() {
      var hasItems = Object.values(upsellCart).some(function(q) { return q > 0; });
      var addBtn = document.getElementById("upsellAddBtn");
      var noBtn = document.getElementById("upsellNoBtn");
      if (addBtn) addBtn.style.display = hasItems ? "inline-flex" : "none";
      if (noBtn) noBtn.textContent = hasItems ? "No agregar nada" : "No, gracias";
    }

    var cardsHtml = upsellProducts.map(function(p) {
      var pid = String(p.id);
      var codSafe = String(p.cod || "").trim();
      var imgSrc = BASE_IMG + encodeURIComponent(codSafe) + ".jpg?v=" + encodeURIComponent(IMG_VERSION);
      var contado = calcContadoPrice(p.list_price);
      var oferta = calcUpsellPrice(p.list_price);
      var uxb = Number(p.uxb || 0);

      return '<div class="upsell-card" data-pid="' + esc(pid) + '">' +
        '<img src="' + imgSrc + '" onerror="this.src=\'img/no-image.webp\'" alt="' + esc(codSafe) + '">' +
        '<div class="upsell-card-info">' +
          '<div class="upsell-cod">' + esc(codSafe) + '</div>' +
          '<div class="upsell-desc">' + esc(String(p.description || "")) + '</div>' +
          '<div class="upsell-uxb">UxB: ' + uxb + '</div>' +
          '<div class="upsell-price-list">Precio de lista: $' + formatMoney(p.list_price) + ' + IVA</div>' +
          (logged ? '<div class="upsell-price-old">Contado: $' + formatMoney(contado) + ' + IVA</div>' +
          '<div class="upsell-price-offer">OFERTA ESPECIAL: <strong>$' + formatMoney(oferta) + ' + IVA</strong></div>' : '') +
        '</div>' +
        '<div class="upsell-controls">' +
          '<button type="button" class="upsell-minus" data-pid="' + esc(pid) + '">−</button>' +
          '<span class="upsell-qty" id="upsellQty-' + esc(pid) + '">0</span>' +
          '<button type="button" class="upsell-plus" data-pid="' + esc(pid) + '">+</button>' +
        '</div>' +
      '</div>';
    }).join("");

    overlay.innerHTML =
      '<div class="upsell-popup">' +
        '<button type="button" id="upsellCloseX" class="upsell-close-x" aria-label="Cerrar">&times;</button>' +
        '<div class="upsell-header">' +
          '<div class="upsell-title">Antes de confirmar...</div>' +
          '<div class="upsell-subtitle">Estos productos todavia no los probaste. Aprovechar el precio contado!</div>' +
          '<div class="upsell-timer" id="upsellTimer"></div>' +
        '</div>' +
        '<div class="upsell-cards">' + cardsHtml + '</div>' +
        '<div class="upsell-actions">' +
          '<button type="button" id="upsellNoBtn" class="upsell-btn-no">No, gracias</button>' +
          '<button type="button" id="upsellAddBtn" class="upsell-btn-add" style="display:none">Agregar al pedido y enviar</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(overlay);

    function tickTimer() {
      var now = new Date();
      var ms = deadline - now;
      var el = document.getElementById("upsellTimer");
      if (el) el.textContent = "Oferta valida por: " + formatCountdown(ms);
    }
    tickTimer();
    timerInterval = setInterval(tickTimer, 1000);

    function cleanup() {
      clearInterval(timerInterval);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    overlay.addEventListener("click", function(e) {
      var btn = e.target.closest("[data-pid]");
      if (!btn) return;
      var pid = btn.dataset.pid;
      if (!upsellCart[pid]) upsellCart[pid] = 0;

      if (btn.classList.contains("upsell-plus")) {
        upsellCart[pid]++;
      } else if (btn.classList.contains("upsell-minus")) {
        if (upsellCart[pid] > 0) upsellCart[pid]--;
      }

      var qtyEl = document.getElementById("upsellQty-" + pid);
      if (qtyEl) qtyEl.textContent = upsellCart[pid];
      updateBtnState();
    });

    document.getElementById("upsellCloseX").addEventListener("click", function() {
      cleanup();
      resolve("cancel");
    });

    document.getElementById("upsellNoBtn").addEventListener("click", function() {
      cleanup();
      resolve(false);
    });

    document.getElementById("upsellAddBtn").addEventListener("click", function() {
      Object.keys(upsellCart).forEach(function(pid) {
        var qty = upsellCart[pid];
        if (qty <= 0) return;
        var existing = cart.find(function(i) { return String(i.productId) === pid; });
        if (existing) {
          existing.qtyCajas += qty;
        } else {
          cart.push({ productId: pid, qtyCajas: qty });
        }
      });
      updateCart();
      renderProducts();
      cleanup();
      resolve(true);
    });
  });
}

function setSubmitOrderLoading(isLoading, text = "") {
  const btn = $("submitOrderBtn");
  if (!btn) return;

  if (isLoading) {
    btn.disabled = true;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = text || "Enviando...";
    btn.classList.add("is-loading");
    btn.setAttribute("aria-busy", "true");
  } else {
    btn.classList.remove("is-loading");
    btn.setAttribute("aria-busy", "false");
    btn.textContent = btn.dataset.originalText || "Confirmar pedido";
  }
}

async function submitOrder() {
  // Upsell check — show popup before confirming
  if (!window.__submittingOrder && !window.__upsellShown) {
    var upsellProducts = getUpsellProducts();
    if (upsellProducts.length > 0) {
      window.__upsellShown = true;
      var upsellResult = await showUpsellPopup(upsellProducts);
      window.__upsellShown = false;
      if (upsellResult === "cancel") return;
    }
  }

  const btn = $("submitOrderBtn");
  const clienteNuevoValue = isAdmin
    ? String($("clienteNuevoInput")?.value || "").trim()
    : "";

  try {
    setOrderStatus("");

    if (window.__submittingOrder) return;
    window.__submittingOrder = true;
    setSubmitOrderLoading(true, "Enviando...");

    if (!currentSession) { openLogin(); window.__submittingOrder = false; setSubmitOrderLoading(false); return; }

    if (isVendorProfile() && !document.getElementById("customerSelect")?.value) {
      setOrderStatus("Debés seleccionar una razón social para confirmar el pedido.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    // EXPO: defensa en profundidad — no enviar un cliente NUEVO de expo incompleto.
    if (_expoClientMode && !_expoClientComplete) {
      setOrderStatus("Faltan datos del cliente nuevo para confirmar el pedido.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    if (!customerProfile?.id) {
      setOrderStatus("No se encontró el perfil del cliente.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    if (!cart.length) {
      setOrderStatus("Carrito vacío.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    // Validar que ningún producto del carrito esté SIN STOCK, PROXIMAMENTE o inactivo
    const sinStockItems = [];
    const proximamenteItems = [];
    const inactivosItems = [];
    cart.forEach((item) => {
      const p = products.find((x) => String(x.id) === String(item.productId));
      if (!p) { inactivosItems.push(item.productId); return; }
      const badge = String(p.badge_status || "").trim().toUpperCase();
      if (badge === "SIN STOCK") sinStockItems.push(p.cod || p.description);
      else if (badge === "PROXIMAMENTE" || badge === "PRÓXIMAMENTE") proximamenteItems.push(p.cod || p.description);
    });

    if (inactivosItems.length) {
      setOrderStatus("Hay productos en tu pedido que ya no están disponibles. Revisá el carrito.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }
    if (sinStockItems.length) {
      setOrderStatus("Productos sin stock en el pedido: " + sinStockItems.join(", ") + ". Quitalos antes de confirmar.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }
    if (proximamenteItems.length) {
      setOrderStatus("Productos PRÓXIMAMENTE en el pedido: " + proximamenteItems.join(", ") + ". Quitalos antes de confirmar.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    if (!deliveryChoice?.slot) {
      setOrderStatus("Debés seleccionar una sucursal de entrega.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    if (!deliveryConfirmed) {
      setOrderStatus('Debés apretar "Confirmar" en Dirección de Entrega antes de confirmar el pedido.', "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    const paySel = document.getElementById("paymentSelect");
    if (!(isAdmin && !hasVendorSelection()) && (!paySel || !String(paySel.value || "").trim())) {
      setOrderStatus("Debés seleccionar un método de pago.", "err");
      window.__submittingOrder = false; setSubmitOrderLoading(false); return;
    }

    const t = calcTotals();

    const orderPayload = {
      auth_user_id: currentSession.user.id,
      customer_id: customerProfile.id,
      status: "pendiente",
      payment_method: getPaymentMethodText(),
      payment_discount: Number(t.paymentDiscount || 0),
      web_discount: (isAdmin && !hasVendorSelection()) ? 0 : WEB_ORDER_DISCOUNT,
      subtotal: Number(t.subtotal || 0),
      total: Number(t.finalTotal || 0),
    };

    const resHead = await withTimeout(
      supabaseClient
        .from("orders")
        .insert(orderPayload)
        .select("id")
        .single(),
      60000,
      "Supabase insert orders",
    );

    const orderRow = resHead.data;
    const orderErr = resHead.error;

    if (orderErr || !orderRow?.id) {
      const msg =
        orderErr?.message ||
        orderErr?.details ||
        orderErr?.hint ||
        JSON.stringify(orderErr || {});
      console.error("[ORDER] ERROR insert orders:", orderErr);
      setOrderStatus(`No se pudo confirmar el pedido: ${msg}`, "err");
      return;
    }

    const orderId = orderRow.id;

    const itemsPayload = cart
      .map((item) => {
        const p = products.find((x) => String(x.id) === String(item.productId));
        if (!p) return null;

        const qtyCajas = Number(item.qtyCajas || 0);
        const uxb = Number(p.uxb || 0);
        const totalUni = qtyCajas * uxb;

        return {
          order_id: orderId,
          product_id: p.id,
          cod_art: String(p.cod || "").trim(),
          cajas: qtyCajas,
          uxb,
          unidades: totalUni,
          unit_price: Number(unitYourPrice(p.list_price) || 0),
          list_price: Number(p.list_price || 0),
          description: String(p.description || ""),
        };
      })
      .filter(Boolean);

    const itemsForDb = itemsPayload.map((it) => ({
      order_id: it.order_id,
      product_id: it.product_id,
      cajas: it.cajas,
      uxb: it.uxb,
      unit_your_price: it.unit_price,
      unit_list_price: it.list_price,
    }));

    const resItems = await withTimeout(
      supabaseClient.from("order_items").insert(itemsForDb),
      60000,
      "Supabase insert order_items",
    );

    if (resItems.error) {
      const msg = resItems.error.message || JSON.stringify(resItems.error);
      setOrderStatus(`Pedido creado, pero falló la carga de items: ${msg}`, "err");
      return;
    }

    // ---- Guardar datos para PDF ----
    var _pdfItems = itemsPayload.map(function(it) {
      var unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
      var listUnit = Number(it.list_price || 0);
      var tuPrecioUnit = (isAdmin && !hasVendorSelection())
        ? listUnit
        : listUnit * (1 - getDtoVol()) * (1 - WEB_ORDER_DISCOUNT);
      return {
        cod: it.cod_art,
        description: it.description || "",
        cajas: Number(it.cajas || 0),
        unidades: unidades,
        tu_precio_unit: tuPrecioUnit,
        sub_total: tuPrecioUnit * unidades,
        list_price_unit: listUnit,
        list_sub_total: listUnit * unidades,
      };
    });
    var _listSubtotal = _pdfItems.reduce(function(acc, it) {
      return acc + Number(it.list_sub_total || 0);
    }, 0);

    lastConfirmedOrder = {
      orderId: orderId,
      customerName: customerProfile?.business_name || "",
      codCliente: customerProfile?.cod_cliente || "",
      sucursalEntrega: deliveryChoice.label || deliveryChoice.slot || "",
      metodoPago: getPaymentMethodText(),
      subtotal: Number(t.subtotal || 0),
      listSubtotal: _listSubtotal,
      descuentos: Number(t.totalDiscounts || 0),
      total: Number(t.finalTotal || 0),
      items: _pdfItems,
      paymentDiscount: Number(t.paymentDiscount || 0),
      webDiscount: Number(t.webDiscountRate || 0),
      dtoVol: Number(getDtoVol() || 0),
    };

    // ---- Armar Sheets payload ANTES de resetear UI ----
    // Incluye deuda/payment_term/credit_limit/order_total para que el
    // Apps Script pueda armar la "Leyenda 2" (col J) con la cadena
    // D OK/X - LC OK/X - PP N. Sin estos campos quedaría siempre como
    // "D OK - LC OK - PP Null".
    const sheetsPayload = {
      orderNumber: orderId,
      codCliente: customerProfile?.cod_cliente || "",
      vend: customerProfile?.vend || "",
      condicionPago: getPaymentMethodText(),
      condicionPagoCode: getPaymentMethodCode(),
      sucursalEntrega: lastConfirmedOrder.sucursalEntrega,
      clienteNuevo: clienteNuevoValue,
      // Datos del customer para la Leyenda 2 (D / LC / PP)
      deuda: Number(customerProfile?.debt || 0),
      payment_term: customerProfile?.payment_term != null ? Number(customerProfile.payment_term) : null,
      credit_limit: customerProfile?.credit_limit != null ? Number(customerProfile.credit_limit) : null,
      order_total: Number(lastConfirmedOrder?.total || 0),
      items: itemsPayload.map((it) => ({
        cod_art: it.cod_art,
        cajas: it.cajas,
        uxb: it.uxb,
      })),
    };

    // ---- Persistir sheets_payload en la DB (para el mail de compras desde Supabase) ----
    // Aditivo: el pedido ya está guardado; esto solo agrega el payload en orders
    // para que la edge function procesar-pedidos-db arme el mail sin depender del
    // Google Sheet. No toca el envío al proxy (sigue mandando al Apps Script igual).
    supabaseClient
      .from("orders")
      .update({ sheets_payload: sheetsPayload })
      .eq("id", orderId)
      .then(function () {}, function (err) {
        console.warn("No se pudo persistir sheets_payload:", err);
      });

    // ---- Armar Entregas payload (PPP + Base Picking) ANTES de resetear UI ----
    var entregasPayload = {
      order_number: String(orderId || "").trim(),
      fecha: new Date().toLocaleDateString("es-AR"),
      cod_cliente: String(customerProfile?.cod_cliente || "").trim(),
      cliente: String(customerProfile?.business_name || "").trim(),
      vendedor: String(customerProfile?.vend || "").trim(),
      direccion_entrega: String(deliveryChoice.direccionEntrega || deliveryChoice.label || deliveryChoice.slot || "").trim(),
      barrio_entrega: String(deliveryChoice.zonaExpreso || "").trim(),
      empresa: "CH",
      items: itemsPayload.map(function(it) {
        return {
          cod_art: it.cod_art,
          description: it.description || "",
          cajas: it.cajas,
          uxb: it.uxb,
        };
      }),
    };

    // ---- Confirmación INMEDIATA al cliente ----
    cart.length = 0;
    saveCartToLS();

    // Borrar draft asociado si este pedido venía de "Pedidos sin Confirmar"
    if (window.__activeDraftId) {
      const draftIdToDelete = window.__activeDraftId;
      window.__activeDraftId = null;
      supabaseClient.from("saved_carts").delete().eq("id", draftIdToDelete)
        .then(function(){}, function(err){ console.warn("No se pudo borrar draft:", err); });
    }

    deliveryChoice = { slot: "", label: "", direccionEntrega: "", zonaExpreso: "" };
    deliveryConfirmed = false;
    _deliveryOptionsLoadedForCustomer = null;
    var shipSel = $("shippingSelect");
    if (shipSel) {
      shipSel.value = "";
      if (typeof _csRefreshWrappedSelect === "function") {
        _csRefreshWrappedSelect(shipSel, "Elegir Sucursal");
      }
    }
    if (paySel) paySel.value = "";
    document.querySelectorAll("#paymentButtons .pay-btn").forEach(function(b) { b.classList.remove("selected", "active"); });

    setOrderStatus("");
    updateCart();
    renderProducts();
    syncPaymentButtons();
    refreshSubmitEnabled();

    showSection("pedidoConfirmado");
    playSuccessAnimation();
    // EXPO: mostrar el N° de pedido en pantalla (prueba de que quedó grabado).
    try {
      var _onEl = document.getElementById("successOrderNum");
      if (_onEl) {
        _onEl.textContent = orderId ? "Pedido N° " + orderId : "";
        _onEl.style.display = orderId ? "" : "none";
      }
    } catch (e) {}
    _expoShowConfirmPanel(); // EXPO: panel de cierre (descargar/copiar/WhatsApp) + PIN
    window.scrollTo({ top: 0, behavior: "smooth" });

    // Enviar a Sheets con retry en background
    sendOrderToSheetsWithRetry(sheetsPayload, 3).catch(function(e) {
      console.warn("Sheets error (pedido guardado en DB, retry agotado):", e);
    });

    // Enviar al Sheet de entregas (PPP + Base Picking) en background
    sendOrderToEntregasSheet(entregasPayload);

    // Anomaly detection en background
    var codClienteSnap = String(customerProfile?.cod_cliente || "").trim();
    (async function() {
      try {
        var anomalyMap = await loadAnomalyData(codClienteSnap);
        if (!anomalyMap || !anomalyMap.size) return;
        var alertas = [];
        for (var ai = 0; ai < itemsPayload.length; ai++) {
          var it = itemsPayload[ai];
          var codArt = String(it.cod_art || "").trim();
          var anomaly = checkItemAnomaly(anomalyMap, codArt, it.cajas);
          if (anomaly) {
            alertas.push({ cod_art: codArt, cajas: it.cajas, promedio: Math.round(anomaly.avg * 10) / 10, ratio: Math.round(anomaly.ratio * 10) / 10 });
          }
        }
        if (alertas.length > 0) {
          sendAnomalyAlertToSheets({
            order_number: orderId,
            cod_cliente: codClienteSnap,
            cliente: customerProfile?.business_name || "",
            alertas: alertas,
          });
        }
      } catch(e) { console.warn("anomaly check error:", e); }
    })();

  } catch (e) {
    console.error("submitOrder error:", e);
    setOrderStatus("Ocurrió un problema al enviar el pedido, reintentá el envío.", "err");

    var btn2 = $("submitOrderBtn");
    if (btn2) {
      btn2.disabled = false;
      btn2.classList.remove("is-loading", "is-disabled");
      btn2.setAttribute("aria-busy", "false");
      btn2.textContent = btn2.dataset.originalText || "Confirmar pedido";
    }

    window.__submittingOrder = false;
    return;
  } finally {
    window.__submittingOrder = false;
    setSubmitOrderLoading(false);
    refreshSubmitEnabled();
  }
}

function refreshSubmitEnabled() {
  const btn = document.getElementById("submitOrderBtn");
  if (!btn) return;

  const shipSel = document.getElementById("shippingSelect");
  const paySel = document.getElementById("paymentSelect");

  const hasShipping = !!(shipSel && String(shipSel.value || "").trim()) && deliveryConfirmed;
  // EXPO: con un cliente de expo activo se exige método de pago como en la web normal.
  const hasPayment = (isAdmin && !hasVendorSelection() && !(EXPO_MODE && _expoActiveCustomer))
    ? true
    : !!(paySel && String(paySel.value || "").trim());
  const custSel = document.getElementById("customerSelect");
  const hasCustomer = !isVendorProfile() || !!(custSel && String(custSel.value || "").trim());

  // EXPO: bloquear el envío si el cliente NUEVO de expo está incompleto (salvo expreso).
  const expoOk = !(_expoClientMode && !_expoClientComplete);
  var expoGate = document.getElementById("expoOrderGate");
  if (expoGate) expoGate.style.display = expoOk ? "none" : "block";

  btn.disabled = !(hasShipping && hasPayment && hasCustomer && expoOk);

  // (opcional) feedback visual simple
  btn.classList.toggle("is-disabled", btn.disabled);
}

/***********************
 * PANTALLA CONFIRMACIÓN
 ***********************/
function volverMayorista() {
  showSection("productos");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function playSuccessAnimation() {
  var container = document.getElementById("successAnimation");
  if (!container) return;

  // Sólo el SVG del check va acá. El título "Pedido Confirmado" vive en
  // su propio elemento dentro de .success-text para poder centrarse sobre
  // el ancho del card (no restringido a los 180px del wrapper del check).
  container.innerHTML = `
    <svg class="success-checkmark" viewBox="0 0 130 130" xmlns="http://www.w3.org/2000/svg">
      <circle class="success-checkmark__circle" cx="65" cy="65" r="60" fill="none" stroke="#2e8b57" stroke-width="6"/>
      <path class="success-checkmark__check" fill="none" stroke="#2e8b57" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" d="M38 65 l18 18 l36 -36"/>
    </svg>
  `;
}

function loadImageAsDataURL(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = src;
  });
}

let _jspdfLoaded = false;
function loadJsPDF() {
  if (_jspdfLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
    s.onload = () => { _jspdfLoaded = true; resolve(); };
    s.onerror = () => reject(new Error("No se pudo cargar jsPDF"));
    document.head.appendChild(s);
  });
}

// Intenta extraer la tasa de descuento desde el texto del método de pago
// (ej: "Pago Contado: 25% Dto" → 0.25). Devuelve null si no encuentra.
function parsePaymentDiscountFromText(text) {
  const m = String(text || "").match(/(\d+)\s*%/);
  if (!m) return null;
  return Number(m[1]) / 100;
}

// Dibuja el encabezado de la tabla de ítems
function _drawItemsHeader(doc, y, cols) {
  doc.setFillColor(240, 240, 240);
  doc.rect(14, y - 5, 182, 8, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text("Cod", cols.cod, y);
  doc.text("Descripción", cols.desc, y);
  doc.text("Cajas", cols.cajas, y, { align: "right" });
  doc.text("Uni", cols.uni, y, { align: "right" });
  doc.text("Precio", cols.precio, y, { align: "right" });
  doc.text("Subtotal", cols.subtotal, y, { align: "right" });
  return y + 8;
}

// Genera PDF del pedido con formato "Pedido Web" (grilla de métodos de pago)
async function descargarPedidoPDF() {
  if (!lastConfirmedOrder) {
    alert("No hay un pedido para descargar.");
    return;
  }

  await loadJsPDF();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF("p", "mm", "a4");
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, 210, 297, "F");

  const {
    customerName,
    codCliente,
    sucursalEntrega,
    metodoPago,
    subtotal,
    listSubtotal,
    total,
    items,
    paymentDiscount,
    webDiscount,
    dtoVol,
  } = lastConfirmedOrder;

  // Subtotal "puro de lista" (sin ningún descuento) para columnas y totales
  const listSub = Number(
    listSubtotal ||
      (items || []).reduce((acc, it) => acc + Number(it.list_sub_total || 0), 0)
  );

  const pageWidth = 210;
  const margin = 14;
  const rightX = pageWidth - margin; // 196
  const cols = {
    cod: margin + 1,     // 15 (left)
    desc: margin + 18,   // 32 (left)
    cajas: margin + 91,  // 105 (right)
    uni: margin + 111,   // 125 (right)
    precio: margin + 146,// 160 (right)
    subtotal: rightX - 2,// 194 (right)
  };

  // HEADER: franja azul + banner Chef respetando proporción original (882x75)
  const headerH = 24;
  const imgRatio = 882 / 75;
  const fitW = headerH * imgRatio;
  const offsetX = (210 - fitW) / 2;
  let headerBanner = null;
  try {
    headerBanner = await loadImageAsDataURL("img/HeaderChef.png");
  } catch (_) {}

  function drawHeader() {
    doc.setFillColor(11, 49, 93);
    doc.rect(0, 0, 210, headerH, "F");
    if (headerBanner) {
      doc.addImage(headerBanner, "PNG", offsetX, 0, fitW, headerH);
    }
  }

  drawHeader();

  // TÍTULO
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(22);
  doc.text("Pedido Web", margin, 40);

  // DATOS GENERALES
  let y = 52;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text(`Cliente: ${customerName}`, margin, y); y += 6;
  doc.text(`Cod. Cliente: ${codCliente}`, margin, y); y += 6;
  if (sucursalEntrega) {
    doc.text(`Sucursal de entrega: ${sucursalEntrega}`, margin, y); y += 6;
  }
  doc.text(`Método de pago: ${metodoPago || "—"}`, margin, y); y += 4;

  // Nota a la derecha arriba de la tabla
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text("Subtotal no contempla Descuentos", rightX, y, { align: "right" });
  doc.setTextColor(0, 0, 0);
  y += 8;

  // TABLA DE ÍTEMS
  y = _drawItemsHeader(doc, y, cols);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  items.forEach((it) => {
    if (y > 250) {
      doc.addPage();
      drawHeader();
      y = 36;
      y = _drawItemsHeader(doc, y, cols);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
    }
    const desc = String(it.description || "").slice(0, 30);
    const precio = Number(it.list_price_unit != null ? it.list_price_unit : it.tu_precio_unit || 0);
    const sub = Number(it.list_sub_total != null ? it.list_sub_total : it.sub_total || 0);
    doc.text(String(it.cod || ""), cols.cod, y);
    doc.text(desc, cols.desc, y);
    doc.text(String(it.cajas || 0), cols.cajas, y, { align: "right" });
    doc.text(String(it.unidades || 0), cols.uni, y, { align: "right" });
    doc.text(`$${formatMoney(precio)}`, cols.precio, y, { align: "right" });
    doc.text(`$${formatMoney(sub)}`, cols.subtotal, y, { align: "right" });
    y += 7;
  });

  // TOTALES a la derecha
  y += 6;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Subtotal sin Descuentos:", rightX - 50, y, { align: "right" });
  doc.text(`$${formatMoney(listSub)} + IVA`, rightX, y, { align: "right" });

  // Descuento del método de pago elegido = listSub - totalConEseMétodo.
  const _pdForDelta = Number(paymentDiscount || 0);
  const _wdForDelta = (typeof webDiscount === "number") ? Number(webDiscount) : WEB_ORDER_DISCOUNT;
  const _dvForDelta = (typeof dtoVol === "number") ? Number(dtoVol) : 0;
  const _noSelDelta = /no\s*decidir/i.test(String(metodoPago || ""));
  const totalSelMethod = listSub * (1 - _dvForDelta) * (1 - _wdForDelta) * (1 - _pdForDelta);
  const deltaMetodo = Math.max(0, listSub - totalSelMethod);

  const _hideDiscounts = isAdmin && !hasVendorSelection();
  if (!_hideDiscounts && !_noSelDelta && deltaMetodo > 0) {
    y += 7;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(80, 80, 80);
    doc.text("Descuentos c/ Método de pago elegido:", rightX - 25, y, { align: "right" });
    doc.text(`$${formatMoney(deltaMetodo)}`, rightX, y, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }

  y += 14;

  // GRILLA DE MÉTODOS DE PAGO (solo cliente mayorista estándar)
  const showPaymentGrid = !_hideDiscounts && Number(subtotal || 0) > 0;

  if (showPaymentGrid) {
    const pd = Number(paymentDiscount || 0);
    const wd = (typeof webDiscount === "number") ? Number(webDiscount) : WEB_ORDER_DISCOUNT;
    const dv = (typeof dtoVol === "number") ? Number(dtoVol) : 0;
    const noSelection = /no\s*decidir/i.test(String(metodoPago || ""));

    const options = [
      { label: "Contado",        discount: 0.25 },
      { label: "30 días",        discount: 0.20 },
      { label: "45 días",        discount: 0.15 },
      { label: "60 días",        discount: 0.10 },
      { label: "90 días eCheq",  discount: 0.05 },
      { label: "120 días eCheq", discount: 0.00 },
    ];

    const gapX = 4;
    const gapY = 4;
    const boxW = (rightX - margin - gapX * 2) / 3; // 3 columnas
    const boxH = 14;

    // Salto de página si no entra la grilla
    if (y + 2 * boxH + gapY > 275) {
      doc.addPage();
      drawHeader();
      y = 36;
    }

    options.forEach((opt, i) => {
      const row = Math.floor(i / 3);
      const col = i % 3;
      const bx = margin + col * (boxW + gapX);
      const by = y + row * (boxH + gapY);
      const optTotal = listSub * (1 - dv) * (1 - wd) * (1 - opt.discount);
      const selected = !noSelection && Math.abs(opt.discount - pd) < 0.001;

      if (selected) {
        doc.setDrawColor(34, 139, 76); // verde
        doc.setLineWidth(0.9);
      } else {
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.3);
      }
      doc.roundedRect(bx, by, boxW, boxH, 3, 3);

      doc.setFont("helvetica", selected ? "bold" : "normal");
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);

      const labelLines = opt.label.includes("eCheq")
        ? opt.label.replace(" eCheq", "\neCheq").split("\n")
        : [opt.label];

      const labelX = bx + 3;
      if (labelLines.length === 1) {
        doc.text(labelLines[0], labelX, by + boxH / 2 + 1);
      } else {
        doc.text(labelLines[0], labelX, by + boxH / 2 - 1.2);
        doc.text(labelLines[1], labelX, by + boxH / 2 + 3);
      }

      // Flecha dibujada con líneas (Helvetica no soporta "→" unicode).
      const firstLineW = doc.getTextWidth(labelLines[0]);
      const aLen = 4;
      const ax = labelX + firstLineW + 1.5;
      const ay = by + boxH / 2;
      doc.setDrawColor(selected ? 34 : 90, selected ? 139 : 90, selected ? 76 : 90);
      doc.setLineWidth(selected ? 0.7 : 0.5);
      doc.line(ax, ay, ax + aLen, ay);
      doc.line(ax + aLen, ay, ax + aLen - 1.4, ay - 1.2);
      doc.line(ax + aLen, ay, ax + aLen - 1.4, ay + 1.2);
      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.2);

      doc.setFont("helvetica", selected ? "bold" : "normal");
      doc.setFontSize(9);
      doc.text(
        `$${formatMoney(optTotal)} + IVA`,
        bx + boxW - 3,
        by + boxH / 2 + 1,
        { align: "right" }
      );
    });

    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.2);
    y += 2 * boxH + gapY + 4;
  } else {
    // Admin / sin descuentos: mostramos total simple
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Total:", rightX - 45, y, { align: "right" });
    doc.text(`$${formatMoney(total)} + IVA`, rightX, y, { align: "right" });
    y += 10;
  }

  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  const HH = String(now.getHours()).padStart(2, "0");
  const MM = String(now.getMinutes()).padStart(2, "0");
  const SS = String(now.getSeconds()).padStart(2, "0");

  const fileName = `Pedido-${dd}_${mm}_${yy}-${HH}_${MM}_${SS}.pdf`;
  doc.save(fileName);
}

// Descargar comprobante de un pedido ya guardado
async function descargarComprobantePedido(orderId) {
  try {
    if (!orderId) {
      alert("No se encontró el pedido.");
      return;
    }

    console.log("[descargarComprobantePedido] orderId=", orderId, "typeof=", typeof orderId);

    // ESTRATEGIA PRINCIPAL: RPC SECURITY DEFINER get_vendor_order_for_pdf.
    // Bypasea RLS pero valida server-side que el caller sea el dueño del
    // pedido o un vendor con acceso vía customer.vend. Funciona tanto para
    // clientes propios como para pedidos de clientes linkeados al vendedor.
    let orderRow = null;
    let itemsFromRpc = null;
    let customerFromRpc = null;
    {
      const rpcRes = await supabaseClient.rpc("get_vendor_order_for_pdf", {
        p_order_id: Number(orderId),
      });
      if (rpcRes.error) {
        console.warn("[descargarComprobantePedido] RPC error (probable que no esté deployada todavía):", rpcRes.error.message);
      } else if (rpcRes.data) {
        orderRow = rpcRes.data.order || null;
        itemsFromRpc = rpcRes.data.items || null;
        customerFromRpc = rpcRes.data.customer || null;
        if (orderRow) console.log("[descargarComprobantePedido] OK via RPC");
      }
    }

    // FALLBACKS (sólo si el RPC no existe o devolvió null): mantenemos los
    // 3 intentos anteriores para compat con instalaciones que aún no tienen
    // el RPC deployado.
    let orderErr = null;
    if (!orderRow) {
      console.warn("[descargarComprobantePedido] RPC sin resultado, cayendo a fallbacks directos");
      const res = await supabaseClient
        .from("orders")
        .select("id, total, subtotal, payment_method, customer_id")
        .eq("id", orderId)
        .maybeSingle();
      orderRow = res.data;
      orderErr = res.error;
    }
    if (!orderRow && customerProfile?.id) {
      const res2 = await supabaseClient
        .from("orders")
        .select("id, total, subtotal, payment_method, customer_id")
        .eq("id", orderId)
        .eq("customer_id", customerProfile.id)
        .maybeSingle();
      orderRow = res2.data;
      if (res2.error) orderErr = res2.error;
    }
    if (!orderRow && customerProfile?.id) {
      const res3 = await supabaseClient
        .from("orders")
        .select("id, total, subtotal, payment_method, customer_id")
        .eq("customer_id", customerProfile.id);
      if (res3.data) {
        orderRow = res3.data.find(o => String(o.id) === String(orderId)) || null;
      }
    }

    if (orderErr && !orderRow) {
      console.error("orderErr:", orderErr);
      alert("Error consultando el pedido: " + (orderErr.message || ""));
      return;
    }
    if (!orderRow) {
      console.error("[descargarComprobantePedido] orderId=" + orderId + " no encontrado.");
      console.error("customerProfile=", customerProfile);
      alert(
        "No se encontró el pedido. Si sos vendedor consultando un pedido de cliente, " +
        "es necesario deployar el RPC 'get_vendor_order_for_pdf' en Supabase. " +
        "Ver setup_get_vendor_order_for_pdf.sql en el repo."
      );
      return;
    }

    // ITEMS — si vinieron del RPC los usamos; sino query directa (cliente propio).
    let itemsRows;
    if (itemsFromRpc) {
      itemsRows = itemsFromRpc;
    } else {
      const itemsRes = await supabaseClient
        .from("order_items")
        .select("product_id, cajas, uxb")
        .eq("order_id", orderId);
      if (itemsRes.error) {
        console.error("itemsErr:", itemsRes.error);
        alert("No se pudieron leer los ítems del pedido.");
        return;
      }
      itemsRows = itemsRes.data || [];
    }

    // CUSTOMER — preferir customer del RPC (que es del DUEÑO del pedido,
    // no del usuario logueado). Si no hay RPC, usar customerProfile o fetch.
    let customerName = "";
    let codCliente = "";
    if (customerFromRpc) {
      customerName = customerFromRpc.business_name || "";
      codCliente = String(customerFromRpc.cod_cliente || "");
    } else {
      customerName = customerProfile?.business_name || "";
      codCliente = customerProfile?.cod_cliente || "";
      if (!customerName || !codCliente) {
        const { data: custRow } = await supabaseClient
          .from("customers")
          .select("business_name, cod_cliente")
          .eq("id", orderRow.customer_id)
          .maybeSingle();
        customerName = custRow?.business_name || "";
        codCliente = custRow?.cod_cliente || "";
      }
    }

    // PRODUCTS — si los items vienen del RPC ya tienen cod/description/list_price.
    // Si no, hay que fetchearlos.
    let productsMap = new Map();
    const itemsHaveProductInfo = itemsFromRpc && itemsRows.length > 0 && "cod" in (itemsRows[0] || {});

    if (!itemsHaveProductInfo) {
      const productIds = itemsRows.map((r) => r.product_id).filter(Boolean);
      if (productIds.length) {
        const { data: prods } = await supabaseClient
          .from("products")
          .select("id, cod, description, list_price")
          .in("id", productIds);
        productsMap = new Map((prods || []).map((p) => [String(p.id), p]));
      }
    }

    const orderItems = itemsRows.map((it) => {
      const prod = itemsHaveProductInfo
        ? { cod: it.cod, description: it.description, list_price: it.list_price }
        : (productsMap.get(String(it.product_id)) || {});
      const unidades = Number(it.cajas || 0) * Number(it.uxb || 0);
      const listUnit = Number(prod.list_price || 0);
      const tuPrecioUnit = (isAdmin && !hasVendorSelection())
        ? listUnit
        : listUnit * (1 - getDtoVol()) * (1 - WEB_ORDER_DISCOUNT);
      return {
        cod: prod.cod || "",
        description: prod.description || "",
        cajas: Number(it.cajas || 0),
        unidades,
        tu_precio_unit: tuPrecioUnit,
        sub_total: tuPrecioUnit * unidades,
        list_price_unit: listUnit,
        list_sub_total: listUnit * unidades,
      };
    });

    const listSubtotal = orderItems.reduce((acc, it) => acc + Number(it.list_sub_total || 0), 0);

    lastConfirmedOrder = {
      orderId: orderRow.id,
      customerName,
      codCliente,
      sucursalEntrega: "",
      metodoPago: orderRow.payment_method || "",
      subtotal: Number(orderRow.subtotal || 0),
      listSubtotal: listSubtotal,
      descuentos: Math.max(0, Number(orderRow.subtotal || 0) - Number(orderRow.total || 0)),
      total: Number(orderRow.total || 0),
      items: orderItems,
      paymentDiscount: parsePaymentDiscountFromText(orderRow.payment_method || "") || 0,
      webDiscount: (isAdmin && !hasVendorSelection()) ? 0 : WEB_ORDER_DISCOUNT,
      dtoVol: getDtoVol(),
    };

    await descargarPedidoPDF();
  } catch (err) {
    console.error("descargarComprobantePedido error:", err);
    alert("No se pudo descargar el comprobante.");
  }
}

async function openMyOrders() {
  await openProfile();
}
window.openMyOrders = openMyOrders;

/***********************
 * VENDOR MODE (LINKED CUSTOMERS)
 ***********************/
let linkedCustomers = [];

async function loadLinkedCustomers() {
  if (!currentSession) { linkedCustomers = []; return; }

  var result = await supabaseClient.rpc("get_my_linked_customers");
  if (result.error) {
    console.error("loadLinkedCustomers error:", result.error);
    linkedCustomers = [];
    return;
  }

  linkedCustomers = result.data || [];
}

function isVendorProfile() {
  if (!linkedCustomers || !linkedCustomers.length) return false;
  // Excluir self-references — si el RPC devuelve sólo al propio usuario
  // (caso de un cliente), no contar como vendor. Solo es vendor cuando
  // tiene OTROS clientes vinculados.
  if (!_vendorOwnProfile) return false;
  var ownId = String(_vendorOwnProfile.id);
  var others = linkedCustomers.filter(function (c) {
    return String(c.customer_id) !== ownId;
  });
  return others.length > 0;
}

var VENDOR_SELF_VALUE = "__vendor__";

// Datos estructurados (en vez de HTML) para alimentar el dropdown custom + el
// <select> oculto que mantenemos por compatibilidad con código que lee .value.
function buildCustomerOptionsData() {
  var data = [];
  // Opción "perfil propio" para volver del modo actuando-como-cliente:
  //  - Vendedores reales: label "— Perfil vendedor —"
  //  - Admins: label con el business_name del perfil propio (ej. "Chef SRL")
  var isVendor = typeof isActualVendor === "function" && isActualVendor();
  if (isVendor) {
    data.push({
      value: VENDOR_SELF_VALUE,
      label: "— Perfil vendedor —",
      disabled: false,
      hidden: false,
    });
  } else if (typeof isAdmin !== "undefined" && isAdmin && _vendorOwnProfile) {
    var ownName = (_vendorOwnProfile.business_name || "").trim() || "Mi cuenta";
    data.push({
      value: VENDOR_SELF_VALUE,
      label: ownName,
      disabled: false,
      hidden: false,
    });
  }
  data.push({
    value: "",
    label: "Elegir razón social...",
    disabled: true,
    hidden: true,
  });
  linkedCustomers.forEach(function (c) {
    data.push({
      value: c.customer_id,
      label: c.business_name + " (" + c.cod_cliente + ")",
      disabled: false,
      hidden: false,
    });
  });
  return data;
}

// Escape HTML para inyectar texto en innerHTML sin XSS
function _csEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Crea un dropdown custom (div + lista) que reemplaza al <select> nativo.
 * Mantiene un <select> oculto con el `targetId` para compatibilidad con el
 * resto del código que lee `document.getElementById(id).value`.
 *
 * Fix bug Chrome + Win dark mode: el popup nativo de <select> se renderea
 * con tema dark un frame antes de aplicar custom CSS → flicker negro.
 */
function _csCreateDropdown(targetId, optionsData, currentValue, extraClass) {
  var wrap = document.createElement("div");
  wrap.className = "cs-dropdown" + (extraClass ? " " + extraClass : "");
  wrap.dataset.target = targetId;

  var selOpt = optionsData.find(function (o) {
    return o.value === currentValue;
  });
  var labelText = selOpt ? selOpt.label : "Elegir razón social...";

  // <select> oculto para parity con código existente que lee .value
  var hiddenSel = document.createElement("select");
  hiddenSel.id = targetId;
  hiddenSel.className = "cs-hidden-select";
  hiddenSel.tabIndex = -1;
  hiddenSel.setAttribute("aria-hidden", "true");
  hiddenSel.innerHTML = optionsData
    .map(function (o) {
      var attrs = "";
      if (o.disabled) attrs += " disabled";
      if (o.hidden) attrs += " hidden";
      return (
        '<option value="' +
        _csEscape(o.value) +
        '"' +
        attrs +
        ">" +
        _csEscape(o.label) +
        "</option>"
      );
    })
    .join("");
  hiddenSel.value = currentValue || "";
  hiddenSel.addEventListener("change", onAnyCustomerSelectChange);

  // Trigger button
  var trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    '<span class="cs-trigger-label">' +
    _csEscape(labelText) +
    "</span>" +
    '<span class="cs-trigger-arrow" aria-hidden="true">▾</span>';

  // Popup
  var popup = document.createElement("div");
  popup.className = "cs-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  popup.innerHTML = optionsData
    .filter(function (o) {
      return !o.hidden;
    })
    .map(function (o) {
      var selectedAttr =
        o.value === currentValue ? ' data-selected="true"' : "";
      var disabledAttr = o.disabled ? " disabled" : "";
      return (
        '<button type="button" class="cs-option" role="option" data-value="' +
        _csEscape(o.value) +
        '"' +
        selectedAttr +
        disabledAttr +
        ">" +
        _csEscape(o.label) +
        "</button>"
      );
    })
    .join("");

  wrap.appendChild(trigger);
  wrap.appendChild(popup);
  wrap.appendChild(hiddenSel);

  _csWireDropdown(wrap);

  return wrap;
}

function _csWireDropdown(wrap) {
  var trigger = wrap.querySelector(".cs-trigger");
  var popup = wrap.querySelector(".cs-popup");
  var hiddenSel = wrap.querySelector(".cs-hidden-select");
  if (!trigger || !popup || !hiddenSel) return;

  trigger.addEventListener("click", function (e) {
    e.stopPropagation();
    var isOpen = !popup.hidden;
    _csCloseAllPopups();
    if (!isOpen) {
      popup.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      var sel = popup.querySelector('.cs-option[data-selected="true"]');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
  });

  popup.addEventListener("click", function (e) {
    var opt = e.target.closest(".cs-option");
    if (!opt || opt.disabled) return;
    e.stopPropagation();
    var value = opt.dataset.value;
    var label = opt.textContent;

    trigger.querySelector(".cs-trigger-label").textContent = label;
    popup.querySelectorAll(".cs-option").forEach(function (o) {
      delete o.dataset.selected;
    });
    opt.dataset.selected = "true";

    hiddenSel.value = value;
    hiddenSel.dispatchEvent(new Event("change", { bubbles: true }));

    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  });
}

function _csCloseAllPopups() {
  document.querySelectorAll(".cs-popup").forEach(function (p) {
    if (!p.hidden) {
      p.hidden = true;
      var t = p.parentElement && p.parentElement.querySelector(".cs-trigger");
      if (t) t.setAttribute("aria-expanded", "false");
    }
  });
}

function _csRefreshDropdownVisual(hiddenSel) {
  if (!hiddenSel) return;
  var wrap = hiddenSel.closest(".cs-dropdown");
  if (!wrap) return;
  var val = hiddenSel.value;
  var triggerLabel = wrap.querySelector(".cs-trigger-label");
  var popup = wrap.querySelector(".cs-popup");
  if (!triggerLabel || !popup) return;

  var newLabel = "Elegir razón social...";
  popup.querySelectorAll(".cs-option").forEach(function (o) {
    delete o.dataset.selected;
    if (o.dataset.value === val) {
      o.dataset.selected = "true";
      newLabel = o.textContent;
    }
  });
  triggerLabel.textContent = newLabel;
}

// Helper para setear valor programáticamente (sincroniza hidden select +
// refresca visual del dropdown custom). Usar en lugar de `el.value = X` directo.
function _csSetValue(id, value) {
  var el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  _csRefreshDropdownVisual(el);
}

/**
 * Envuelve un <select> existente con un dropdown custom (.cs-dropdown).
 * A diferencia de _csCreateDropdown, NO crea un select nuevo — preserva
 * el original con sus <option> y datasets, para que el código existente
 * que lee `sel.options[selIdx].dataset.X` siga funcionando.
 *
 * Cuando el usuario clickea una opción, setea el select.value y dispatcha
 * un evento 'change' para que el listener original corra normalmente.
 *
 * Llamar de nuevo regenera el popup (idempotente).
 */
function _csWireSelectDropdown(selectEl, opts) {
  if (!selectEl) return;
  opts = opts || {};
  var placeholder = opts.placeholder || "Elegir...";
  var extraClass = opts.extraClass || "cs-dropdown-card";

  // Si el select ya está dentro de un wrap, removerlo para regenerar limpio
  var existingWrap = selectEl.closest(".cs-dropdown");
  if (existingWrap) {
    existingWrap.parentNode.insertBefore(selectEl, existingWrap);
    existingWrap.remove();
  }

  // Crear el wrap nuevo
  var wrap = document.createElement("div");
  wrap.className = "cs-dropdown " + extraClass;
  wrap.dataset.target = selectEl.id;

  // Construir optionsData desde los <option> reales del select
  var optionsData = Array.prototype.map.call(selectEl.options, function (o) {
    return {
      value: o.value,
      label: o.textContent,
      disabled: o.disabled,
      hidden: o.hidden,
      isPlaceholder: o.value === "",
    };
  });

  // Label inicial del trigger: opción seleccionada o placeholder
  var currentVal = selectEl.value || "";
  var selOpt = optionsData.find(function (o) {
    return o.value === currentVal && !o.isPlaceholder;
  });
  var labelText = selOpt ? selOpt.label : placeholder;

  // Trigger
  var trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    '<span class="cs-trigger-label">' +
    _csEscape(labelText) +
    "</span>" +
    '<span class="cs-trigger-arrow" aria-hidden="true">▾</span>';

  // Popup con todas las options (excepto el placeholder vacío, ya implícito en el trigger)
  var popup = document.createElement("div");
  popup.className = "cs-popup";
  popup.setAttribute("role", "listbox");
  popup.hidden = true;
  var realOpts = optionsData.filter(function (o) {
    return !o.isPlaceholder && !o.hidden;
  });
  if (realOpts.length === 0) {
    popup.innerHTML =
      '<div class="cs-option cs-option-empty" aria-disabled="true">' +
      _csEscape(opts.emptyText || "Sin opciones disponibles") +
      "</div>";
  } else {
    popup.innerHTML = realOpts
      .map(function (o) {
        var selectedAttr =
          o.value === currentVal ? ' data-selected="true"' : "";
        var disabledAttr = o.disabled ? " disabled" : "";
        return (
          '<button type="button" class="cs-option" role="option" data-value="' +
          _csEscape(o.value) +
          '"' +
          selectedAttr +
          disabledAttr +
          ">" +
          _csEscape(o.label) +
          "</button>"
        );
      })
      .join("");
  }

  // Wire trigger: toggle popup
  trigger.addEventListener("click", function (e) {
    e.stopPropagation();
    var isOpen = !popup.hidden;
    _csCloseAllPopups();
    if (!isOpen) {
      popup.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      var sel = popup.querySelector('.cs-option[data-selected="true"]');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }
  });

  // Wire popup: pickear opción → actualizar select + dispatch change
  popup.addEventListener("click", function (e) {
    var opt = e.target.closest(".cs-option");
    if (!opt || opt.disabled) return;
    e.stopPropagation();
    var value = opt.dataset.value;
    var label = opt.textContent;

    trigger.querySelector(".cs-trigger-label").textContent = label;
    popup.querySelectorAll(".cs-option").forEach(function (o) {
      delete o.dataset.selected;
    });
    opt.dataset.selected = "true";

    selectEl.value = value;
    selectEl.dispatchEvent(new Event("change", { bubbles: true }));

    popup.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  });

  // Reposicionar el select adentro del wrap (oculto) y dejar wrap en su lugar
  var parent = selectEl.parentNode;
  parent.insertBefore(wrap, selectEl);
  wrap.appendChild(trigger);
  wrap.appendChild(popup);
  wrap.appendChild(selectEl);
  selectEl.classList.add("cs-hidden-select");
}

// Refresca el visual del dropdown que envuelve a un <select> ya existente
// (uso típico: después de cambiar select.value programáticamente).
function _csRefreshWrappedSelect(selectEl, placeholder) {
  if (!selectEl) return;
  var wrap = selectEl.closest(".cs-dropdown");
  if (!wrap) return;
  var triggerLabel = wrap.querySelector(".cs-trigger-label");
  var popup = wrap.querySelector(".cs-popup");
  if (!triggerLabel || !popup) return;

  var val = selectEl.value || "";
  var newLabel = placeholder || "Elegir...";
  popup.querySelectorAll(".cs-option").forEach(function (o) {
    delete o.dataset.selected;
    if (o.dataset.value === val) {
      o.dataset.selected = "true";
      newLabel = o.textContent;
    }
  });
  triggerLabel.textContent = newLabel;
}

// Listeners globales (una sola vez): click fuera + Escape cierran popups
if (typeof window !== "undefined" && !window.__csGlobalWired) {
  document.addEventListener("click", function () {
    _csCloseAllPopups();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") _csCloseAllPopups();
  });
  window.__csGlobalWired = true;
}

function syncCustomerSelectors(sourceId) {
  var source = document.getElementById(sourceId);
  if (!source) return;
  var val = source.value;
  ["customerSelect", "customerSelectCart"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el && el.id !== sourceId) {
      el.value = val;
      _csRefreshDropdownVisual(el);
    }
  });
}

function onAnyCustomerSelectChange(e) {
  syncCustomerSelectors(e.target.id);
  onLinkedCustomerSelected();
}

/* ===================================================================
   MÓDULO EXPO — portado desde LK (pagina-LK-copia).
   Entrada 'Elegir cliente' / 'Nuevo cliente', pricing por escala,
   staging de clientes nuevos, panel de cierre. Sin Línea Loke (no existe en chef).
   =================================================================== */
/***********************
 * EXPO — entrada "Elegir cliente" / "Nuevo cliente"
 * Reemplaza el selector "Elegir razón social" en esta copia.
 ***********************/
var _expoPickWired = false;
var _expoSearchTimer = null;

function _expoEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

// Carga la escala de descuento por volumen (una vez).
async function _expoLoadScale() {
  if (_expoScale) return _expoScale;
  try {
    var r = await supabaseClient
      .from("expo_dto_escala")
      .select("desde,dto")
      .order("desde", { ascending: true });
    _expoScale = r.error ? [] : (r.data || []);
  } catch (e) {
    _expoScale = [];
  }
  return _expoScale;
}

// Subtotal de LISTA del carrito (sin dto): base para elegir el tramo.
function _expoListSubtotal() {
  var s = 0;
  (cart || []).forEach(function (item) {
    var p = products.find(function (x) { return String(x.id) === String(item.productId); });
    if (!p) return;
    s += Number(p.list_price || 0) * (item.qtyCajas * Number(p.uxb || 0));
  });
  return s;
}

// dto (fracción) que corresponde a un subtotal según la escala.
function _expoScaleDtoFor(sub) {
  if (!_expoScale || !_expoScale.length) return 0;
  var dto = 0;
  _expoScale.forEach(function (t) {
    if (sub >= Number(t.desde)) dto = Number(t.dto);
  });
  return dto;
}

// Sincroniza el dto del cliente-expo con la escala según el carrito actual.
// Lo escribe en customerProfile.dto_vol para que TODO el pricing lo lea igual.
function _expoSyncDto() {
  if (!_expoClientMode || !customerProfile) return;
  customerProfile.dto_vol = _expoScaleDtoFor(_expoListSubtotal());
  _expoRenderCheckpoints();
}

// Garantiza que el <select> oculto tenga la <option> del cliente elegido.
// Ese value lo leen onLinkedCustomerSelected y el gate de confirmación.
function _expoEnsureOption(id, label) {
  var sel = document.getElementById("customerSelect");
  if (!sel) return;
  if (!sel.querySelector('option[value="' + id + '"]')) {
    var o = document.createElement("option");
    o.value = id;
    o.textContent = label || "";
    sel.appendChild(o);
  }
}

function _expoNextTier(sub) {
  if (!_expoScale) return null;
  for (var i = 0; i < _expoScale.length; i++) {
    if (Number(_expoScale[i].desde) > sub) {
      return { dto: Number(_expoScale[i].dto), falta: Number(_expoScale[i].desde) - sub };
    }
  }
  return null;
}

function _expoMoney(n) {
  try {
    return Number(n || 0).toLocaleString("es-AR", { maximumFractionDigits: 0 });
  } catch (e) {
    return String(Math.round(Number(n || 0)));
  }
}

// Monto compacto para las etiquetas de los checkpoints: 600000 → $600k, 1500000 → $1,5M.
function _expoCompact(n) {
  n = Number(n) || 0;
  if (n >= 1000000) {
    var m = n / 1000000;
    return "$" + (m % 1 === 0 ? m : m.toFixed(1).replace(".", ",")) + "M";
  }
  if (n >= 1000) return "$" + Math.round(n / 1000) + "k";
  return "$" + n;
}

// Barra de "checkpoints": muestra los tramos de la escala como hitos, el progreso
// del pedido (lista) y cuánto falta para el próximo tramo. Solo para cliente nuevo.
function _expoRenderCheckpoints() {
  var cp = document.getElementById("expoCheckpoints");
  if (!cp) return;
  if (!_expoClientMode || !_expoScale || !_expoScale.length) {
    cp.style.display = "none";
    return;
  }
  var tiers = _expoScale.slice().sort(function (a, b) {
    return Number(a.desde) - Number(b.desde);
  });
  var sub = _expoListSubtotal();
  var n = tiers.length;
  var curIdx = 0;
  for (var i = 0; i < n; i++) if (sub >= Number(tiers[i].desde)) curIdx = i;
  var pos = function (i) { return n <= 1 ? 100 : (i / (n - 1)) * 100; };
  var fillFrac;
  if (curIdx >= n - 1) {
    fillFrac = 100;
  } else {
    var a = Number(tiers[curIdx].desde), b = Number(tiers[curIdx + 1].desde);
    var prog = b > a ? Math.min(1, Math.max(0, (sub - a) / (b - a))) : 0;
    fillFrac = pos(curIdx) + prog * (pos(curIdx + 1) - pos(curIdx));
  }
  var steps = "";
  tiers.forEach(function (t, i) {
    var cls = i < curIdx ? "done" : i === curIdx ? "current" : "todo";
    steps +=
      '<div class="expo-cp-step ' + cls + '" style="left:' + pos(i) + '%">' +
      '<span class="expo-cp-pct">' + Math.round(Number(t.dto) * 100) + "%</span>" +
      '<span class="expo-cp-dot"></span>' +
      '<span class="expo-cp-amt">' + _expoCompact(t.desde) + "</span>" +
      "</div>";
  });
  var next = _expoNextTier(sub);
  var curDto = Math.round(Number(tiers[curIdx].dto) * 100);
  var right = next
    ? "Faltan <b>$" + _expoMoney(next.falta) + "</b> para " + Math.round(next.dto * 100) + "%"
    : "<b>Descuento máximo alcanzado</b>";
  cp.innerHTML =
    '<div class="expo-cp-head">' +
      '<span class="expo-cp-title">Descuento por volumen · <b>' + curDto + "%</b></span>" +
      '<span class="expo-cp-sub">Pedido (lista): <b>$' + _expoMoney(sub) + "</b></span>" +
      '<span class="expo-cp-next">' + right + "</span>" +
    "</div>" +
    '<div class="expo-cp-track">' +
      '<div class="expo-cp-fill" style="width:' + fillFrac + '%"></div>' +
      steps +
    "</div>";
  cp.style.display = "";
}

function _expoUpdateChip() {
  var chip = document.getElementById("expoCurrentChip");
  if (!chip) return;
  if (!(customerProfile && customerProfile.id && customerProfile.business_name)) {
    chip.textContent = "Sin cliente seleccionado";
    chip.classList.remove("has-client");
    return;
  }
  var dto = Number(customerProfile.dto_vol || 0);
  var name =
    '<span class="expo-chip-name">' + _expoEsc(customerProfile.business_name) + "</span>";
  var inner;
  if (_expoClientMode) {
    // El detalle del dto por volumen se muestra en la barra de checkpoints.
    var estado = _expoClientComplete
      ? '<span class="expo-chip-ok">✓ Datos completos</span>'
      : '<span class="expo-chip-falta">Faltan datos</span>';
    inner = name + '<span class="expo-chip-meta">Contado 1ª compra · ' + estado + "</span>";
  } else {
    inner =
      name +
      '<span class="expo-chip-meta">Cód ' +
      _expoEsc(customerProfile.cod_cliente || "—") +
      (dto > 0 ? " · Dto " + Math.round(dto * 100) + "%" : "") +
      "</span>";
  }
  // La cruz (soltar cliente) solo cuando hay un cliente ELEGIDO/NUEVO de expo,
  // NO en el perfil propio del operador (ahí no hay nada que soltar).
  var cruz = _expoActiveCustomer
    ? '<button type="button" class="expo-chip-clear" title="Soltar cliente y volver a tu perfil" ' +
      'onclick="expoClearCustomer()">&times;</button>'
    : "";
  chip.innerHTML = '<div class="expo-chip-text">' + inner + "</div>" + cruz;
  chip.classList.add("has-client");
  _expoRenderCheckpoints();
  _expoRefreshResumeBtn();
}

function renderExpoEntryBar() {
  var bar = document.createElement("div");
  bar.id = "customerSelectorBanner";
  bar.className = "customer-selector-banner expo-entry-bar";
  bar.innerHTML =
    '<div class="expo-current" id="expoCurrentChip">Sin cliente seleccionado</div>' +
    '<div class="expo-entry-actions">' +
    '<button type="button" class="expo-btn expo-btn-pick" id="expoElegirBtn">Elegir cliente</button>' +
    '<button type="button" class="expo-btn expo-btn-new" id="expoNuevoBtn">+ Nuevo cliente</button>' +
    '<button type="button" class="expo-btn expo-btn-resume" id="expoContinuarBtn" style="display:none">Continuar carga pausada</button>' +
    "</div>" +
    '<select id="customerSelect" class="expo-hidden-select" tabindex="-1" aria-hidden="true"><option value=""></option></select>';

  var section = document.getElementById("productos");
  var anchorRow = null;
  if (section) {
    var sortRow = section.querySelector(".sort-row");
    if (sortRow) {
      sortRow.insertBefore(bar, sortRow.firstChild);
      anchorRow = sortRow;
    } else {
      var titleRow = section.querySelector(".section-title-row");
      if (titleRow) { titleRow.parentNode.insertBefore(bar, titleRow.nextSibling); anchorRow = titleRow; }
      else section.insertBefore(bar, section.firstChild);
    }
  }

  // Barra de checkpoints del dto por volumen (full-width, debajo de la fila).
  var cp = document.getElementById("expoCheckpoints");
  if (!cp) {
    cp = document.createElement("div");
    cp.id = "expoCheckpoints";
    cp.className = "expo-cp-wrap";
    cp.style.display = "none";
  }
  if (anchorRow && anchorRow.parentNode) {
    anchorRow.parentNode.insertBefore(cp, anchorRow.nextSibling);
  } else if (section) {
    section.insertBefore(cp, section.firstChild);
  }

  // Si ya hay un cliente activo, reflejarlo en el select oculto + chip.
  if (customerProfile && customerProfile.id) {
    _expoEnsureOption(customerProfile.id, customerProfile.business_name);
    var selNow = document.getElementById("customerSelect");
    if (selNow) selNow.value = customerProfile.id;
    _expoUpdateChip();
  }

  var elegirBtn = document.getElementById("expoElegirBtn");
  var nuevoBtn = document.getElementById("expoNuevoBtn");
  var contBtn = document.getElementById("expoContinuarBtn");
  if (elegirBtn) elegirBtn.addEventListener("click", expoOpenPickModal);
  if (nuevoBtn) nuevoBtn.addEventListener("click", expoNuevoCliente);
  if (contBtn) contBtn.addEventListener("click", expoOpenResumeModal);

  _expoWirePickModal();
  _expoWireResumeModal();
  // Mostrar "Continuar carga pausada" solo si hay clientes en staging.
  _expoRefreshResumeBtn();
}

// Muestra/oculta el botón "Continuar carga pausada" según haya pendientes.
async function _expoRefreshResumeBtn() {
  var btn = document.getElementById("expoContinuarBtn");
  if (!btn) return;
  // En el perfil propio del operador (sin cliente de expo elegido) NO mostrar el
  // botón: siempre hay clientes en staging y aparecería permanentemente. Solo se
  // ve con un cliente de expo activo (para editarlo/completarlo).
  if (!_expoActiveCustomer || !_expoClientMode) {
    btn.style.display = "none";
    return;
  }
  try {
    var r = await supabaseClient
      .from("expo_clientes_pendientes")
      .select("business_name,cuit,condicion_iva,vend,whatsapp,mail,direccion,numero,cp,localidad,provincia,direcciones_entrega")
      .eq("estado", "pendiente");
    // Re-chequear: mientras esperábamos, el operador pudo soltar el cliente y
    // volver a su perfil (race). Si ya no hay cliente activo, ocultar.
    if (!_expoActiveCustomer || !_expoClientMode) {
      btn.style.display = "none";
      return;
    }
    if (r.error || !r.data || !r.data.length) {
      btn.style.display = "none";
      return;
    }
    var incompletos = r.data.filter(function (d) {
      return !_expoDatosCompletos(d);
    }).length;
    btn.style.display = "";
    if (incompletos > 0) {
      // Hay clientes con datos a medias → "Continuar carga pausada".
      btn.classList.add("expo-btn-resume");
      btn.classList.remove("expo-btn-resume-done");
      btn.textContent = "Continuar carga pausada (" + incompletos + ")";
    } else {
      // Cliente activo completo → editar solo ese (los viejos completos no se listan).
      btn.classList.remove("expo-btn-resume");
      btn.classList.add("expo-btn-resume-done");
      btn.textContent = "✓ Editar cliente";
    }
  } catch (e) {
    btn.style.display = "none";
  }
}

// EXPO: panel de cierre en la confirmación. El operador manda el resumen por
// WhatsApp desde el teléfono de ventas (botón wa.me) — NO lo manda un bot solo.
// Aparece para CUALQUIER cliente expo (nuevo o ya elegido), no solo los nuevos.
// El PIN sólo se muestra para clientes NUEVOS (modo cliente-expo).
var _expoConfirmMsg = ""; // resumen armado, para el botón "Copiar resumen"
async function _expoShowConfirmPanel() {
  var panel = document.getElementById("expoConfirmPanel");
  if (!panel) return;
  var stdWrap = document.querySelector(".success-download-wrap");
  // Sólo tiene sentido en modo expo con un cliente activo (nuevo o elegido).
  var esExpo =
    EXPO_MODE && (_expoClientMode || _expoActiveCustomer);
  if (!esExpo || !lastConfirmedOrder || !(customerProfile && customerProfile.id)) {
    panel.style.display = "none";
    _expoConfirmMsg = "";
    if (stdWrap) stdWrap.style.display = ""; // cliente normal: descarga estándar visible
    return;
  }
  var esClienteNuevo = !!_expoClientMode;
  // El panel trae su propio botón de descarga → ocultar el estándar
  if (stdWrap) stdWrap.style.display = "none";
  var pin = "", wsp = "";
  try {
    var r = await supabaseClient
      .from("customers")
      .select("pin,whatsapp")
      .eq("id", customerProfile.id)
      .maybeSingle();
    if (r.data) {
      pin = r.data.pin || "";
      wsp = r.data.whatsapp || "";
    }
  } catch (e) { /* ignore */ }

  // Título + fila del PIN según sea cliente nuevo o ya existente.
  var titleEl = document.getElementById("expoConfirmTitle");
  var pinrowEl = document.getElementById("expoConfirmPinrow");
  if (titleEl) {
    titleEl.textContent = esClienteNuevo
      ? "Cliente nuevo — cerrá el circuito"
      : "Enviá la confirmación al cliente";
  }
  if (pinrowEl) pinrowEl.style.display = esClienteNuevo ? "" : "none";
  var pinEl = document.getElementById("expoConfirmPin");
  if (pinEl) pinEl.textContent = pin || "—";

  // ---- Resumen del pedido ----
  var dtoPct = Math.round(Number(lastConfirmedOrder.dtoVol || 0) * 100);
  var total = _expoMoney(lastConfirmedOrder.total || 0);
  var msg =
    "¡Tu pedido fue confirmado! ✅\n\n" +
    "Hola " + (lastConfirmedOrder.customerName || "") +
    ", te paso el resumen de tu pedido en Chef:\n\n" +
    "Pedido N° " + (lastConfirmedOrder.orderId || "") + "\n" +
    "Total: $" + total + " + IVA\n" +
    "Descuento por volumen otorgado: " + dtoPct + "%\n";
  if (esClienteNuevo) {
    msg +=
      "Pago: Contado (1ra compra)\n\n" +
      "Para tus próximos pedidos online:\n" +
      "Usuario: tu CUIT\n" +
      "Clave: " + (pin || "(a definir)") + "\n\n";
  } else {
    msg += "\n";
  }
  msg += "¡Gracias por tu compra!";
  _expoConfirmMsg = msg;

  var waBtn = document.getElementById("expoConfirmWa");
  if (waBtn) {
    var num = String(wsp).replace(/[^0-9]/g, "");
    // Si el cliente no tiene WhatsApp cargado, wa.me igual abre el selector de
    // contacto con el texto pre-cargado; el operador elige a quién mandarlo.
    waBtn.href = "https://wa.me/" + num + "?text=" + encodeURIComponent(msg);
  }
  // Reset visual del botón "Copiar resumen" por si quedó en estado "copiado".
  var copyBtn = document.getElementById("expoConfirmCopy");
  if (copyBtn) copyBtn.classList.remove("expo-copied");
  panel.style.display = "";
}

// EXPO: copia el resumen del pedido al portapapeles (fallback para pegarlo a mano).
async function expoCopiarResumen() {
  var txt = _expoConfirmMsg || "";
  if (!txt) return;
  var ok = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(txt);
      ok = true;
    }
  } catch (e) { /* fallback abajo */ }
  if (!ok) {
    try {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch (e2) { /* nada */ }
  }
  var btn = document.getElementById("expoConfirmCopy");
  if (btn) {
    var prev = btn.dataset.origHtml || btn.innerHTML;
    btn.dataset.origHtml = prev;
    btn.classList.add("expo-copied");
    btn.innerHTML = ok ? "✓ Resumen copiado" : "No se pudo copiar";
    setTimeout(function () {
      btn.classList.remove("expo-copied");
      btn.innerHTML = btn.dataset.origHtml || prev;
    }, 1800);
  }
}

function expoOpenPickModal() {
  var m = document.getElementById("expoPickModal");
  if (!m) return;
  m.classList.add("open"); // ✅ clave: .modal se muestra con .open, no quitando .hidden
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  var inp = document.getElementById("expoPickSearch");
  var res = document.getElementById("expoPickResults");
  if (inp) inp.value = "";
  if (res)
    res.innerHTML =
      '<div class="expo-pick-hint">Escribí cód, razón social, CUIT o dirección…</div>';
  if (inp) setTimeout(function () { inp.focus(); }, 30);
}

function expoClosePickModal() {
  var m = document.getElementById("expoPickModal");
  if (!m) return;
  m.classList.remove("open");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

async function _expoRunSearch() {
  var inp = document.getElementById("expoPickSearch");
  var res = document.getElementById("expoPickResults");
  if (!inp || !res) return;
  var q = inp.value.trim();
  if (q.length < 2) {
    res.innerHTML =
      '<div class="expo-pick-hint">Escribí al menos 2 caracteres…</div>';
    return;
  }
  res.innerHTML = '<div class="expo-pick-hint">Buscando…</div>';
  var r = await supabaseClient.rpc("buscar_cliente_expo", { p_q: q });
  // El input pudo cambiar mientras esperábamos: descartar respuesta vieja.
  if (inp.value.trim() !== q) return;
  if (r.error) {
    res.innerHTML =
      '<div class="expo-pick-hint expo-pick-err">Error: ' +
      _expoEsc(r.error.message) +
      "</div>";
    return;
  }
  var rows = r.data || [];
  if (!rows.length) {
    res.innerHTML =
      '<div class="expo-pick-hint">Sin resultados para "' +
      _expoEsc(q) +
      '"</div>';
    return;
  }
  var html = "";
  rows.forEach(function (c) {
    var dto = Number(c.dto_vol || 0);
    html +=
      '<button type="button" class="expo-pick-row" data-id="' +
      c.id +
      '"><span class="expo-pick-name">' +
      _expoEsc(c.business_name) +
      '</span><span class="expo-pick-sub">Cód ' +
      _expoEsc(c.cod_cliente || "—") +
      (c.cuit ? " · CUIT " + _expoEsc(c.cuit) : "") +
      (dto > 0 ? " · Dto " + Math.round(dto * 100) + "%" : "") +
      "</span>" +
      (c.direccion
        ? '<span class="expo-pick-dir">' +
          _expoEsc(c.direccion) +
          (c.localidad ? " · " + _expoEsc(c.localidad) : "") +
          "</span>"
        : "") +
      "</button>";
  });
  res.innerHTML = html;
  res.querySelectorAll(".expo-pick-row").forEach(function (row) {
    row.addEventListener("click", function () {
      var cust = rows.find(function (x) {
        return String(x.id) === row.dataset.id;
      });
      if (cust) expoApplyCustomer(cust);
    });
  });
}

async function expoApplyCustomer(cust, opts) {
  opts = opts || {};
  // Registrar en linkedCustomers para que el resto del flujo lo reconozca.
  if (
    !(linkedCustomers || []).some(function (c) {
      return String(c.customer_id) === String(cust.id);
    })
  ) {
    linkedCustomers.push({
      customer_id: cust.id,
      cod_cliente: cust.cod_cliente,
      business_name: cust.business_name,
      dto_vol: cust.dto_vol,
      vend: cust.vend,
    });
  }
  _expoEnsureOption(cust.id, cust.business_name);
  var sel = document.getElementById("customerSelect");
  if (sel) sel.value = cust.id;
  expoClosePickModal();

  // Hay un cliente real seleccionado: mostrar SUS precios (dto + web), no lista.
  _expoActiveCustomer = true;

  // ¿Es cliente NUEVO de expo? (forzado desde el alta, o presente en staging).
  // Solo esos entran en "modo cliente-expo" (escala + contado obligatorio + web).
  // En la misma consulta traemos los campos para calcular la COMPLETITUD (auto).
  _expoClientMode = !!opts.forceExpoNew;
  _expoClientComplete = false;
  try {
    var st = await supabaseClient
      .from("expo_clientes_pendientes")
      .select("business_name,cuit,condicion_iva,vend,whatsapp,mail,direccion,numero,cp,localidad,provincia,direcciones_entrega")
      .eq("customer_id", cust.id)
      .eq("estado", "pendiente")
      .order("actualizado_at", { ascending: false })
      .limit(1);
    if (!st.error && st.data && st.data.length) {
      _expoClientMode = true; // presente en staging = cliente de expo
      _expoClientComplete = _expoDatosCompletos(st.data[0]);
    }
  } catch (e) { /* si falla, queda incompleto (bloquea envío por las dudas) */ }
  if (_expoClientMode) await _expoLoadScale();

  await onLinkedCustomerSelected({ customerId: cust.id, isRestore: !!opts.fromRestore });

  // Persistir el cliente elegido de expo en su propia clave, para restaurarlo al
  // volver de historial/sugerencias (que recargan la página): el cliente puede
  // venir del padrón y NO estar en linkedCustomers, así que la restauración
  // normal (que busca dentro de linkedCustomers) no lo encuentra.
  if (!opts.fromRestore) {
    try {
      localStorage.setItem(
        "lk_expo_selected_client",
        JSON.stringify({
          id: cust.id,
          cod_cliente: cust.cod_cliente,
          business_name: cust.business_name,
          dto_vol: cust.dto_vol,
          vend: cust.vend,
          expoClientMode: _expoClientMode,
        }),
      );
    } catch (e) {}
  }

  if (_expoClientMode) {
    // Forzar contado en la UI de pago (el cálculo ya lo fuerza igual).
    var paySel = document.getElementById("paymentSelect");
    if (paySel) paySel.value = "0.25";
    _expoSyncDto();
    updateCart();
    renderProducts();
  }
  _expoUpdateChip();
}

// EXPO: soltar el cliente elegido y volver al perfil del operador (admin).
// Evita quedarse "pegado" a un cliente que no se terminó de fijar.
function expoClearCustomer() {
  if (cart && cart.length > 0) {
    if (
      !window.confirm(
        "Vas a soltar al cliente y volver a tu perfil. El pedido en curso (" +
          cart.length +
          " ítem/s) se vacía. ¿Continuar?",
      )
    )
      return;
    cart.splice(0, cart.length);
    if (typeof saveCartToLS === "function") saveCartToLS();
  }
  try {
    localStorage.removeItem("lk_expo_selected_client");
  } catch (e) {}
  _expoActiveCustomer = false;
  _expoClientMode = false;
  _expoClientComplete = false;
  var sel = document.getElementById("customerSelect");
  if (sel) sel.value = VENDOR_SELF_VALUE;
  // Restaurar el perfil propio del operador (misma vía que "Perfil Vendedor").
  Promise.resolve(
    onLinkedCustomerSelected({ customerId: VENDOR_SELF_VALUE, isRestore: true }),
  ).then(function () {
    _expoUpdateChip();
    if (typeof updateCart === "function") updateCart();
    if (typeof renderProducts === "function") renderProducts();
    if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
  });
}
window.expoClearCustomer = expoClearCustomer;
window.expoCopiarResumen = expoCopiarResumen;
window._expoCloseNewModal = _expoCloseNewModal;

/* ===================================================================
   EXPO — Lector de QR de credenciales (autocompleta "Nuevo cliente")
   Escaneo con la cámara (jsQR self-hosted, anda en iOS Safari) + parser
   multi-formato. El parseo (_expoParseQR) está aislado: cambiar de formato
   es tocar UNA función.
   Formato confirmado (credencial EXPOSITOR Expo Presentes), pipe-delimited:
     CODE|NOMBRE|APELLIDO|EMPRESA||||||   ej: 822126|JUAN|FARIAS|CHEF||||||
   OJO: el campo 3 es la EMPRESA (razón social), no el cargo. El formato del
   VISITANTE no está confirmado; si viene pipe-delimited se parsea igual.
   =================================================================== */
var _expoQrStream = null;
var _expoQrRaf = null;
var _expoJsqrLoading = null;

function _expoLoadJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (_expoJsqrLoading) return _expoJsqrLoading;
  _expoJsqrLoading = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = "jsqr.js?v=1";
    s.onload = function () { resolve(); };
    s.onerror = function () { reject(new Error("No se pudo cargar el lector de QR")); };
    document.head.appendChild(s);
  });
  return _expoJsqrLoading;
}

// --- Parseo del texto crudo del QR: detecta formato y devuelve campos ---
function _expoParseQR(raw) {
  var text = String(raw == null ? "" : raw).trim();
  if (!text) return { source: "vacio" };
  if (/^BEGIN:VCARD/i.test(text)) return _expoParseVCard(text);
  if (_expoIsExpoPresentes(text)) return _expoParseExpoPresentes(text);
  if (/^https?:\/\//i.test(text)) return _expoParseUrl(text);
  if (/^MECARD:/i.test(text)) return _expoParseMecard(text);
  return { fullName: text, source: "qr_text" };
}

function _expoIsExpoPresentes(text) {
  if (text.indexOf("|") < 0) return false;
  var f = text.split("|");
  if (f.length < 5) return false;
  var c0 = (f[0] || "").trim();
  return c0.length > 0 && c0.length <= 20 && /^[A-Za-z0-9-]+$/.test(c0);
}

function _expoParseExpoPresentes(text) {
  // Layout posicional confirmado (expositor Y visitante/comerciante):
  //   0:CODE 1:NOMBRE 2:APELLIDO 3:EMPRESA 4:DNI 5:CUIT 6:TEL 7:EMAIL
  // El de expositor trae 4-7 vacíos; el de visitante los completa.
  var f = text.split("|");
  var nombre = (f[1] || "").trim();
  var apellido = (f[2] || "").trim();
  var empresa = (f[3] || "").trim();
  var cuit = (f[5] || "").replace(/\D/g, "");   // f[4] = DNI (sin campo en el alta → se ignora)
  var tel = (f[6] || "").replace(/\D/g, "");
  var email = (f[7] || "").trim();
  var fullName = (nombre + " " + apellido).trim();
  var out = {
    fullName: fullName || undefined,
    company: empresa || undefined,
    source: "qr_expo_presentes",
  };
  if (cuit.length === 11) out.cuit = cuit;
  if (tel) out.whatsapp = tel;
  if (email && email.indexOf("@") > 0) out.email = email;
  return out;
}

function _expoParseVCard(text) {
  function grab(re) { var m = text.match(re); return m ? m[1].trim() : ""; }
  var fn = grab(/(?:^|\n)FN:(.+)/i);
  if (!fn) {
    var n = grab(/(?:^|\n)N:(.+)/i);
    if (n) fn = n.split(";").filter(Boolean).reverse().join(" ").trim();
  }
  return {
    fullName: fn || undefined,
    company: grab(/(?:^|\n)ORG:(.+)/i) || undefined,
    whatsapp: grab(/(?:^|\n)TEL[^:]*:(.+)/i) || undefined,
    email: grab(/(?:^|\n)EMAIL[^:]*:(.+)/i) || undefined,
    position: grab(/(?:^|\n)TITLE:(.+)/i) || undefined,
    source: "qr_vcard",
  };
}

function _expoParseMecard(text) {
  function grab(k) { var m = text.match(new RegExp(k + ":([^;]*)", "i")); return m ? m[1].trim() : ""; }
  var n = grab("N");
  if (n) n = n.split(",").filter(Boolean).reverse().join(" ").trim();
  return {
    fullName: n || undefined,
    whatsapp: grab("TEL") || undefined,
    email: grab("EMAIL") || undefined,
    company: grab("ORG") || undefined,
    source: "qr_mecard",
  };
}

function _expoParseUrl(text) {
  var out = { source: "qr_url" };
  try {
    var u = new URL(text);
    var q = u.searchParams;
    var nombre = q.get("nombre") || q.get("name");
    var empresa = q.get("empresa") || q.get("company");
    var wsp = q.get("whatsapp") || q.get("tel") || q.get("phone");
    var mail = q.get("email");
    if (nombre) out.fullName = nombre;
    if (empresa) out.company = empresa;
    if (wsp) out.whatsapp = wsp;
    if (mail) out.email = mail;
  } catch (e) {}
  return out;
}

// --- Rellena el formulario con lo que trajo el QR. Devuelve campos completados.
function _expoFillFromQR(p) {
  var llenos = [];
  function set(id, val, label) {
    if (!val) return;
    var el = document.getElementById(id);
    if (!el) return;
    el.value = val;
    llenos.push(label);
  }
  // Razón social: empresa; si no vino empresa, el nombre completo.
  set("expoNewRazon", p.company || p.fullName, "Razón social");
  set("expoNewCuit", p.cuit, "CUIT");
  set("expoNewMail", p.email, "Mail");
  if (p.whatsapp) set("expoNewWhatsapp", String(p.whatsapp).replace(/[^0-9]/g, ""), "WhatsApp");
  if (p.province) {
    var sel = document.getElementById("expoNewProvFiscal");
    if (sel) {
      var want = String(p.province).toLowerCase();
      Array.prototype.forEach.call(sel.options, function (o) {
        if (o.value && o.value.toLowerCase() === want) { sel.value = o.value; llenos.push("Provincia"); }
      });
    }
  }
  if (typeof _expoNewSyncComplete === "function") _expoNewSyncComplete();
  return llenos;
}

// --- Escaneo con la cámara ---
function _expoScanQR() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Este dispositivo/navegador no permite usar la cámara. Cargá los datos a mano.");
    return;
  }
  var ov = document.getElementById("expoQrScan");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "expoQrScan";
    ov.className = "expo-qr-scan";
    ov.innerHTML =
      '<div class="expo-qr-inner">' +
      '<video id="expoQrVideo" playsinline muted autoplay></video>' +
      '<div class="expo-qr-frame"></div>' +
      '<div class="expo-qr-hint" id="expoQrHint">Apuntá al QR de la credencial…</div>' +
      '<button type="button" class="expo-qr-cancel" onclick="_expoStopScan()">Cancelar</button>' +
      "</div>";
    document.body.appendChild(ov);
  }
  ov.style.display = "flex";
  var video = document.getElementById("expoQrVideo");
  var hint = document.getElementById("expoQrHint");

  _expoLoadJsQR().then(function () {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  }).then(function (stream) {
    _expoQrStream = stream;
    video.srcObject = stream;
    video.setAttribute("playsinline", "");
    return video.play();
  }).then(function () {
    var canvas = document.createElement("canvas");
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var tick = function () {
      if (!_expoQrStream) return;
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        try {
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" }) : null;
          if (code && code.data) { _expoOnQrDecoded(code.data); return; }
        } catch (e) {}
      }
      _expoQrRaf = requestAnimationFrame(tick);
    };
    _expoQrRaf = requestAnimationFrame(tick);
  }).catch(function (err) {
    if (hint) hint.textContent = "No se pudo abrir la cámara: " + (err && err.message ? err.message : err);
    setTimeout(_expoStopScan, 2800);
  });
}

function _expoStopScan() {
  if (_expoQrRaf) { cancelAnimationFrame(_expoQrRaf); _expoQrRaf = null; }
  if (_expoQrStream) {
    try { _expoQrStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    _expoQrStream = null;
  }
  var ov = document.getElementById("expoQrScan");
  if (ov) ov.style.display = "none";
}

function _expoOnQrDecoded(raw) {
  _expoStopScan();
  var p = _expoParseQR(raw);
  var llenos = _expoFillFromQR(p);
  var msg = llenos.length
    ? "QR leído. Completado: " + llenos.join(", ") + ". Revisá y completá el resto."
    : "QR leído pero sin datos para cargar (formato " + (p.source || "?") + "). Cargá a mano.";
  if (typeof _expoNewStatus === "function") _expoNewStatus(msg, !llenos.length);
  else alert(msg);
}

window._expoScanQR = _expoScanQR;
window._expoStopScan = _expoStopScan;

// ---- EXPO: Nuevo cliente (Fase 2) ----
// Estado del alta en curso: permite pausar (guardar parcial) y volver a editar.
var _expoNewState = { id: null, authId: null };
var _expoNewWired = false;

// PIN de 6 DÍGITOS: es el password del login del cliente (CUIT + PIN) y la tabla
// customers tiene el constraint customers_pin_6_digits (pin ~ '^\d{6}$').
function _expoNewGenPin() {
  var r = "";
  for (var i = 0; i < 6; i++) r += String(Math.floor(Math.random() * 10));
  return r;
}

// Crea el usuario auth con un cliente aparte (no pisa la sesión del operador).
async function _expoCreateAuthUser(cuit, pin) {
  var digits = String(cuit || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  var email = digits + "@cuit.loekemeyer";
  var tmp = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  var res = await tmp.auth.signUp({ email: email, password: pin });
  if (res.error) {
    if (res.error.message.toLowerCase().includes("already registered")) {
      var lg = await tmp.auth.signInWithPassword({ email: email, password: pin });
      if (!lg.error && lg.data.user) return lg.data.user.id;
    }
    console.warn("expo auth signup:", res.error.message);
    return null;
  }
  return res.data.user ? res.data.user.id : null;
}

function _expoNewStatus(msg, kind) {
  var el = document.getElementById("expoNewStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = kind === "err" ? "#b91c1c" : kind === "ok" ? "#166534" : "#6b7280";
}

// Provincias argentinas (24 jurisdicciones) para los desplegables del alta.
var EXPO_PROVINCIAS = [
  "Buenos Aires", "Ciudad Autónoma de Buenos Aires", "Catamarca", "Chaco",
  "Chubut", "Córdoba", "Corrientes", "Entre Ríos", "Formosa", "Jujuy",
  "La Pampa", "La Rioja", "Mendoza", "Misiones", "Neuquén", "Río Negro",
  "Salta", "San Juan", "San Luis", "Santa Cruz", "Santa Fe",
  "Santiago del Estero", "Tierra del Fuego", "Tucumán",
];
function _expoProvinciaOptions(selected) {
  var out = '<option value="">Provincia</option>';
  EXPO_PROVINCIAS.forEach(function (p) {
    out +=
      '<option value="' + p + '"' +
      (String(selected || "") === p ? " selected" : "") +
      ">" + p + "</option>";
  });
  return out;
}

// Expresos/transportistas TAL CUAL están cargados en ISIS (última columna del
// export de sucursales). El campo Expreso autocompleta contra esta lista para
// que se elija el nombre EXACTO y la importación al ERP no falle por un typo.
// PENDIENTE CHEF: lista de expresos de Loekemeyer, usada como FALLBACK hasta que
// llegue el padrón de expresos de Chef. Si nunca llega, quedan estos activos.
var EXPO_EXPRESOS = [
  "11 de Marzo", "4H S.R.L.", "7 de Agosto", "AG Distribuciones Cordoba", "AGUILAR", "ALBO",
  "ALCUVA", "ALEX", "ALONSO", "Alta Cba Encomiendas", "ALVEAR SUR", "AMANES", "AMICCI",
  "ANDESMAR", "Andina HC SRL", "ANDINA HNOS", "ARAVERA", "ARIAS (COMODORO)",
  "ARIAS (SANTA FE)", "ARNES", "ASCENCIO", "Astutti", "AVELLANEDA", "AZUL",
  "BAIRES MATADEROS", "BALUT", "BARILOCHE", "BBB Express", "BELGRANO", "BICENTENARIO",
  "BILLETA", "BIN", "BISONTE", "BOLLATI", "BOLLATTI", "CALTABIANO", "CAMIONERA MENDOCINA",
  "CARDONE S.A.", "CARENA", "CARGO", "CARLITOS (para Entre Rios)",
  "CARLITOS (para Prov BsAS)", "CARNEVALI", "CAROSIO Y VAIROLATTI",
  "Carossio, Vairolatti y Cía SRL", "CATALBIANO", "CAÑADA DE GOMEZ", "CD Bazares en Linea",
  "CEMA", "CENTRAL ARGENTINO", "CHAMORRO", "CHAVEZ HNOS", "Chilecito", "CHIVILCOY",
  "CIARLANTINI", "CONTE", "COOP DE TRABAJO RSUT LTDA", "COPAR", "CRUZ DEL SUR", "DE LA VEGA",
  "Delog", "DEMONTE", "DIAGONAL", "DIEMAR", "DON ROBERTO", "DOÑA RAMONA", "EL CHANGUITO",
  "EL CHINO", "EL FARO SA", "EL JESUITA", "EL NOBLE", "EL RAPIDO", "EL RAYO", "El Resero",
  "EL VASQUITO", "ENCARGO", "ENCARGO EXPRESS", "ENCOMIENDAS CARLOS CASARES",
  "ENTREGA DEPOSITO", "Estacion De Cargas Serena SRL", "ESTRELLA", "EXPRESO 2 CIUDADES",
  "EXPRESO ALFA", "Expreso Biletta S.R.L.", "EXPRESO CAMUFER", "EXPRESO CAVALA",
  "Expreso de a 4 Bahia", "Expreso El Rapido", "Expreso El Vasquito SA", "EXPRESO FUEGUINOS",
  "EXPRESO GARMENDIA", "Expreso Interprovincial", "Expreso Junin", "Expreso Lo Bruno",
  "EXPRESO MAIPU", "EXPRESO MKS", "EXPRESO PANAMA", "EXPRESO PUERTAS DE CUYO",
  "EXPRESO RICHTER", "Expreso Suarence", "EXPRESO T.A.S.", "EXPRESO TRAN VITALE",
  "Expreso Trole", "EXPRESO TROLE", "Expreso Valeiras", "FANTACCI", "Ferrocargas del Sur",
  "FONTANA", "FORZAP", "FRASER", "FRONTERA", "GAL LOGISTICA SA",
  "Gestiones y Soluciones Logist", "GOMEZ", "Grupo Nava", "Guillan", "HACHA DE PIEDRA",
  "HADA", "HERMES", "ILIA", "IMAZ", "INCA", "INTERPROVINCIAL", "JE Logistica",
  "JOSE BELARDI", "KEMBER", "L y D Logistica", "LA ANTARTIDA", "LA SEVILLANITA", "LAN CARG",
  "LANCIONI", "LARRAZ", "LAST EXPRES", "Lazaro Cargas", "LEO", "LESCANO", "LEZANA", "Lider",
  "Logiscar SAS", "LOGISTICA ANDREA", "Logistica Busca Lo Mio", "Logistica Cardo",
  "Logistica Difabio", "LOGISTICA SALTA SRL", "LOGISTICA SATELITAL SRL",
  "Logistica TransSAB", "LOPEZ", "LOTSA", "LUCES", "LUJAN DE CUYO", "LUKE", "LURO", "M Z",
  "MALARGUE", "MF Logistica", "MIGUEL MESSARA", "MONTERO HERMANOS SRL", "MORABITO",
  "Morresi", "MOSTTO- PERGAMINO", "MOSTTO- PORTELA", "Moyano Cargas", "NOR PATAGONICO",
  "NT SERVICIOS", "NUB LOGISTICA S.A.S", "NUB LOGISTICAS SAS", "NUEVA ROMA",
  "NUEVO HORIZONTE", "NUEVO TRANSPORTE SRL", "NUEVO VALLE", "Oliva", "OLIVA HNOS", "ORION",
  "ORO BLANCO", "ORO NEGRO", "Ortiz", "PACINI", "PEDRITO", "PIGUE", "POLI", "PRADA",
  "PREMAT", "PRIVITERA", "PUNILLA", "Raosa S.R.L.", "Red del Norte", "RETIRA", "RICHARDS",
  "RIDISSI", "Rio Lavayen", "RIVADAVIA", "RIVERO", "RODRIGO", "RODRIGUEZ", "RUTA 11",
  "SALDAR", "SALMA", "SALTA", "San Carlos (Bs As)", "SAN CARLOS (Rosario)", "SAN JOSE",
  "SAN NICOLAS", "SANCHEZ", "SANELLI", "SANTA ELISA", "SANTA ROSA", "SANTULI", "SARITA",
  "Scor Dina", "Servicargas Transporte", "Servicios Logisticos y Postale", "SEVILLANITA",
  "SNAIDER", "SOLMAR", "SPACAPAN", "SUDAMERICANO", "SZILAK S.R.L.", "TAQSA PAQ", "TARRES",
  "TB LOGISTICA", "TIM CAR", "Todo Facil Express", "Tokio", "TRADELOG", "Trand Melly's",
  "TRANS", "TRANS-NORT", "TRANSCARGO ARGENTINA", "Transfull SA", "TRANSGUAZU", "TRANSNORT",
  "TRANSP THUNDER", "TRANSP.LAS FLORES", "Transporte Falco", "Transporte Frontera",
  "TRANSPORTE HIPPOCARGO", "Transporte Iros", "Transporte Jaime", "TRANSPORTE LA RUTA S-A-",
  "Transporte Milana", "TRANSPORTE PILONI", "Transporte RSUT", "TRANSPORTE SALDAR",
  "Transporte Santa Fe", "Transporte Sierra", "Transportes Union SA", "TRANSVEL", "TRAVERSO",
  "Tuñon y Mossotto", "UNION (CHUBUT)", "VALLE DE LERMA", "VELOMAX", "VESPRINI", "Victorica",
  "VILLA ANGELA", "VILLANOVA", "YOUVE", "Ñandubay",
];
// Crea (una vez) el <datalist> global que alimenta el autocomplete de Expreso.
function _expoBuildExpresoDatalist() {
  if (document.getElementById("expoExpresoList")) return;
  var dl = document.createElement("datalist");
  dl.id = "expoExpresoList";
  var html = "";
  EXPO_EXPRESOS.forEach(function (n) {
    html += '<option value="' + _expoEsc(n) + '"></option>';
  });
  dl.innerHTML = html;
  document.body.appendChild(dl);
}
function _expoFillProvincias() {
  var sel = document.getElementById("expoNewProvFiscal");
  if (sel) sel.innerHTML = _expoProvinciaOptions(sel.value);
}

function _expoAddrAddRow(prefill, prepend) {
  prefill = prefill || {};
  _expoBuildExpresoDatalist();
  var list = document.getElementById("expoAddrList");
  if (!list) return;
  var row = document.createElement("div");
  row.className = "expo-addr-row";
  row.innerHTML =
    '<input class="expo-inp expo-addr-tit" placeholder="Nombre sucursal — ej: Gurruchaga 2100 - Palermo" />' +
    '<div class="expo-addr-fields">' +
    '<input class="expo-inp expo-addr-dir" placeholder="Dirección de entrega" />' +
    '<input class="expo-inp expo-addr-loc" placeholder="Localidad / zona" />' +
    '<select class="expo-inp expo-addr-prov">' + _expoProvinciaOptions(prefill.provincia) + "</select>" +
    '<input class="expo-inp expo-addr-exp" list="expoExpresoList" autocomplete="off" placeholder="Expreso (empezá a escribir)" />' +
    '<button type="button" class="expo-addr-del" title="Quitar">&times;</button>' +
    "</div>";
  row.querySelector(".expo-addr-tit").value = prefill.titulo || "";
  row.querySelector(".expo-addr-dir").value = prefill.direccion || "";
  row.querySelector(".expo-addr-loc").value = prefill.localidad || "";
  row.querySelector(".expo-addr-prov").value = prefill.provincia || "";
  row.querySelector(".expo-addr-exp").value = prefill.expreso || "";
  // Autocompletar el título como "dirección - zona" si el operador no lo tocó.
  var titEl = row.querySelector(".expo-addr-tit");
  var dirEl = row.querySelector(".expo-addr-dir");
  var locEl = row.querySelector(".expo-addr-loc");
  function _autoTit() {
    if (titEl.dataset.touched === "1") return;
    var d = dirEl.value.trim(), l = locEl.value.trim();
    titEl.value = d && l ? d + " - " + l : d || l || "";
  }
  dirEl.addEventListener("input", _autoTit);
  locEl.addEventListener("input", _autoTit);
  titEl.addEventListener("input", function () { titEl.dataset.touched = "1"; });
  row.querySelector(".expo-addr-del").addEventListener("click", function () {
    row.remove();
    // Garantizar mínimo 1 fila
    if (!document.querySelectorAll("#expoAddrList .expo-addr-row").length)
      _expoAddrAddRow();
    _expoNewSyncComplete();
  });
  // Las sucursales nuevas (botones Agregar / Usar fiscal) van ARRIBA (primeras).
  if (prepend && list.firstChild) list.insertBefore(row, list.firstChild);
  else list.appendChild(row);
  _expoNewSyncComplete();
}

function _expoAddrCollect() {
  var out = [];
  document.querySelectorAll("#expoAddrList .expo-addr-row").forEach(function (r) {
    var dir = (r.querySelector(".expo-addr-dir").value || "").trim();
    if (!dir) return;
    var loc = (r.querySelector(".expo-addr-loc").value || "").trim();
    var tit = (r.querySelector(".expo-addr-tit").value || "").trim();
    out.push({
      titulo: tit || (loc ? dir + " - " + loc : dir), // nombre de sucursal
      direccion: dir,
      localidad: loc,
      provincia: (r.querySelector(".expo-addr-prov").value || "").trim(),
      expreso: (r.querySelector(".expo-addr-exp").value || "").trim(),
    });
  });
  return out;
}

// Vendedores (código ERP → nombre). El 7 (FCA = nosotros) va primero.
// Vendedores compartidos: Loekemeyer y Chef usan los mismos códigos ERP.
var EXPO_VENDEDORES = [
  { c: "7", n: "FCA (Nosotros)" },
  { c: "1", n: "Andres O. Luca" }, { c: "2", n: "Audisio Mario" },
  { c: "3", n: "Cagnolo Mario" }, { c: "4", n: "Carrizo Gabriel" },
  { c: "5", n: "Fabrica J" }, { c: "6", n: "Fabrica P" },
  { c: "8", n: "Horizonte" }, { c: "9", n: "Juan Jose Zaffaroni" },
  { c: "10", n: "Lisa Katz" }, { c: "11", n: "Marcos Lilo" },
  { c: "12", n: "Tomas Schinder" }, { c: "13", n: "Monin Leticia S" },
  { c: "14", n: "Norhon" }, { c: "15", n: "O.M.D. Argentina" },
  { c: "16", n: "Pablo Antonelli" }, { c: "17", n: "Pedro Serra" },
  { c: "18", n: "Primer Precio" }, { c: "19", n: "Sphan" },
  { c: "20", n: "Supermercados" }, { c: "21", n: "Thomas LK" },
  { c: "22", n: "La Bianca" }, { c: "23", n: "Mottura" },
];

function _expoFillVendedores() {
  var sel = document.getElementById("expoNewVend");
  if (!sel) return;
  sel.innerHTML = EXPO_VENDEDORES.map(function (v) {
    return '<option value="' + v.c + '">' + v.c + " - " + v.n + "</option>";
  }).join("");
  sel.value = "7"; // default: nosotros
}

async function expoNuevoCliente() {
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  _expoNewState = { id: null, authId: null };
  [
    "expoNewRazon", "expoNewCuit", "expoNewWhatsapp",
    "expoNewMail", "expoNewCod",
    "expoNewDirFiscal", "expoNewNumFiscal", "expoNewCpFiscal",
    "expoNewLocFiscal", "expoNewProvFiscal",
  ].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.value = "";
  });
  var condIva = document.getElementById("expoNewCondIva");
  if (condIva) condIva.value = "Responsable Inscripto";
  _expoFillVendedores();
  _expoFillProvincias();
  document.getElementById("expoNewPin").value = _expoNewGenPin();
  document.getElementById("expoAddrList").innerHTML = "";
  _expoAddrAddRow();
  _expoNewStatus("");
  _expoWireNewModal();
  _expoNewSyncComplete();
  m.classList.add("open"); // ✅ clave: .modal se muestra con .open
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  // Código ASIGNADO por el sistema (contador propio, no depende del padrón parcial).
  try {
    var r = await supabaseClient.rpc("expo_peek_cod");
    var codEl = document.getElementById("expoNewCod");
    if (codEl && !r.error && r.data != null) codEl.value = r.data;
  } catch (e) { /* opcional */ }
}

function _expoCloseNewModal() {
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  m.classList.remove("open");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

// Validación de CUIT argentino (11 dígitos + dígito verificador módulo 11).
// Devuelve true si el DV cierra. Los placeholders 99… no cierran → se avisa,
// pero NO se bloquea (el ERP los usa a propósito).
function _expoCuitValido(digits) {
  digits = String(digits || "").replace(/[^0-9]/g, "");
  if (digits.length !== 11) return false;
  var pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  var suma = 0;
  for (var i = 0; i < 10; i++) suma += parseInt(digits[i], 10) * pesos[i];
  var resto = suma % 11;
  var dv = 11 - resto;
  if (dv === 11) dv = 0;
  if (dv === 10) return false; // CUIT inválido por norma
  return dv === parseInt(digits[10], 10);
}

// Busca clientes existentes con el MISMO CUIT (excluyendo el propio en edición).
// Reusa buscar_cliente_expo (matchea por dígitos) y filtra por coincidencia exacta.
async function _expoDuplicadosCuit(cuit, selfId) {
  var out = [];
  try {
    var r = await supabaseClient.rpc("buscar_cliente_expo", { p_q: cuit });
    if (!r.error && r.data) {
      r.data.forEach(function (c) {
        if (selfId && String(c.id) === String(selfId)) return;
        var cd = String(c.cuit || "").replace(/[^0-9]/g, "");
        if (cd && cd === cuit) out.push(c);
      });
    }
  } catch (e) { /* si falla la búsqueda, no bloquea el alta */ }
  return out;
}

// mode: "order"    → guarda parcial y va a armar el pedido (arranque incompleto).
//       "complete" → exige TODOS los datos (salvo expreso). Si falta, avisa qué
//                    y NO cierra (igual guarda lo que hay). Si está completo,
//                    cierra y lleva al carrito para pagar/enviar.
async function _expoGuardarNuevo(mode) {
  if (mode === true) mode = "order"; // compat retro (viejo pauseOnly)
  mode = mode || "order";
  var razon = (document.getElementById("expoNewRazon").value || "").trim();
  var cuit = (document.getElementById("expoNewCuit").value || "").replace(/[^0-9]/g, "");
  // Mínimo para registrar al cliente: SOLO la razón social (para tenerlo cargado
  // apenas llega y arrancar el pedido). El CUIT y el resto pueden venir después;
  // el ENVÍO del pedido queda bloqueado hasta que esté completo (chequeo auto).
  if (!razon) {
    _expoNewStatus("La razón social es obligatoria para registrar al cliente.", "err");
    return;
  }
  var addrs = _expoAddrCollect();

  // Chequeos de CUIT solo si ya lo cargaron (puede completarse más tarde).
  if (cuit) {
    // Validar CUIT (avisar, no bloquear: hay placeholders 99… a propósito).
    if (!_expoCuitValido(cuit)) {
      if (!confirm(
        "El CUIT " + cuit + " no parece válido (dígito verificador no cierra o no tiene 11 dígitos).\n\n" +
        "¿Guardar igual? (usá esto solo si es un CUIT provisorio)."
      )) {
        _expoNewStatus("Revisá el CUIT.", "err");
        return;
      }
    }
    // Aviso de duplicado por CUIT (excluye el propio si es edición).
    var dups = await _expoDuplicadosCuit(cuit, _expoNewState.id);
    if (dups.length) {
      var lista = dups.slice(0, 5).map(function (c) {
        return "• Cód " + (c.cod_cliente || "—") + " — " + (c.business_name || "");
      }).join("\n");
      if (!confirm(
        "Ya existe " + dups.length + " cliente(s) con el CUIT " + cuit + ":\n\n" +
        lista + "\n\n¿Crear/actualizar igual?"
      )) {
        _expoNewStatus("Alta cancelada: CUIT ya existente.", "err");
        return;
      }
    }
  }
  var cod = (document.getElementById("expoNewCod").value || "").trim();
  var pin = document.getElementById("expoNewPin").value;
  // El Dto por volumen NO se carga acá: se calcula por la escala en función del
  // pedido. El cliente se crea con dto 0 (el ERP fija el dto vigente después).
  var dto = 0;
  var whatsapp = (document.getElementById("expoNewWhatsapp").value || "").trim();
  var mail = (document.getElementById("expoNewMail").value || "").trim();
  var vend = (document.getElementById("expoNewVend").value || "").trim();
  var dirFiscal = (document.getElementById("expoNewDirFiscal").value || "").trim();
  var numFiscal = (document.getElementById("expoNewNumFiscal").value || "").trim();
  var cpFiscal = (document.getElementById("expoNewCpFiscal").value || "").trim();
  var locFiscal = (document.getElementById("expoNewLocFiscal").value || "").trim();
  var provFiscal = (document.getElementById("expoNewProvFiscal").value || "").trim();
  var tel = ""; // campo Teléfono removido del alta (queda WhatsApp)
  var condIvaEl = document.getElementById("expoNewCondIva");
  var condIva = condIvaEl ? condIvaEl.value : "";

  // Completitud automática (todo salvo expreso).
  var formData = {
    business_name: razon, cuit: cuit, condicion_iva: condIva, vend: vend,
    whatsapp: whatsapp, mail: mail, direccion: dirFiscal, numero: numFiscal,
    cp: cpFiscal, localidad: locFiscal, provincia: provFiscal,
    direcciones_entrega: addrs,
  };
  var completo = _expoDatosCompletos(formData);

  var pauseBtn = document.getElementById("expoNewPause");
  var goBtn = document.getElementById("expoNewGoOrder");
  if (pauseBtn) pauseBtn.disabled = true;
  if (goBtn) goBtn.disabled = true;
  _expoNewStatus("Guardando…");

  try {
    if (!_expoNewState.id) {
      // Reservar el código asignado por el sistema (solo en el alta inicial).
      try {
        var rc = await supabaseClient.rpc("expo_reservar_cod");
        if (!rc.error && rc.data != null) {
          cod = String(rc.data);
          var ce = document.getElementById("expoNewCod");
          if (ce) ce.value = cod;
        }
      } catch (e) { /* si falla, queda el código del peek */ }
    }
    var cust = {
      business_name: razon,
      cuit: cuit || null,
      cod_cliente: cod ? parseInt(cod, 10) : null,
      dto_vol: dto,
      vend: vend || null,
      mail: mail || null,
      whatsapp: whatsapp || null,
      direccion_fiscal: dirFiscal || null,
      localidad: locFiscal || null,
    };

    // El usuario auth (login del cliente) SOLO se puede crear con CUIT (el email
    // sintético es <cuit>@cuit.loekemeyer). Si todavía no hay CUIT, se difiere:
    // se crea cuando se complete. Puede pasar en el alta o en un guardado posterior.
    if (cuit && !_expoNewState.authId) {
      _expoNewState.authId = await _expoCreateAuthUser(cuit, pin);
    }

    if (!_expoNewState.id) {
      var insPayload = Object.assign({}, cust, { pin: pin });
      if (_expoNewState.authId) insPayload.auth_user_id = _expoNewState.authId;
      var ins = await supabaseClient
        .from("customers")
        .insert(insPayload)
        .select("id")
        .single();
      if (ins.error) throw ins.error;
      _expoNewState.id = ins.data.id;
    } else {
      var updPayload = Object.assign({}, cust);
      // Si recién ahora se creó el auth (CUIT cargado más tarde), vincularlo.
      if (_expoNewState.authId) updPayload.auth_user_id = _expoNewState.authId;
      var upd = await supabaseClient
        .from("customers")
        .update(updPayload)
        .eq("id", _expoNewState.id);
      if (upd.error) throw upd.error;
    }

    // Direcciones de entrega: reemplazo total (borrar + insertar).
    await supabaseClient
      .from("customer_delivery_addresses")
      .delete()
      .eq("customer_id", _expoNewState.id);
    var addrRows = addrs.map(function (a, i) {
      return {
        customer_id: _expoNewState.id,
        slot: i + 1,
        label: a.titulo || a.direccion, // nombre de la sucursal (dirección - zona)
        direccion_entrega: a.direccion,
        localidad: a.localidad || null,
        provincia: a.provincia || null,
        nombre_expreso: a.expreso || null,
      };
    });
    // Puede no haber ninguna dirección todavía (cliente en pausa incompleto).
    if (addrRows.length) {
      var addrIns = await supabaseClient
        .from("customer_delivery_addresses")
        .insert(addrRows);
      if (addrIns.error) throw addrIns.error;
    }

    // Staging para el ERP (una fila por cliente).
    await supabaseClient
      .from("expo_clientes_pendientes")
      .delete()
      .eq("customer_id", _expoNewState.id);
    var stIns = await supabaseClient.from("expo_clientes_pendientes").insert({
      customer_id: _expoNewState.id,
      cod_cliente: cust.cod_cliente,
      business_name: razon,
      cuit: cuit,
      direccion: dirFiscal || null,
      numero: numFiscal || null,
      cp: cpFiscal || null,
      localidad: locFiscal || null,
      provincia: provFiscal || null,
      condicion_iva: condIva || null,
      telefono: tel || null,
      whatsapp: whatsapp || null,
      mail: mail || null,
      vend: vend || null,
      dto_vol: dto,
      pin: pin,
      direcciones_entrega: addrs,
      estado: "pendiente",
      actualizado_at: new Date().toISOString(),
    });
    if (stIns.error) throw stIns.error;
    // Nota: el vend queda en customers.vend + staging (suficiente para el ERP).
    // La asociación a user_customer_links la resuelve el panel admin, no el alta expo.

    _expoClientComplete = completo;
    _expoRefreshResumeBtn();

    var custObj = {
      id: _expoNewState.id,
      cod_cliente: cust.cod_cliente,
      business_name: razon,
      cuit: cuit,
      dto_vol: dto,
      vend: vend,
    };

    // "Datos completados" pero faltan: avisar QUÉ falta y NO cerrar. El cliente
    // queda guardado parcial; el envío del pedido sigue bloqueado hasta completar.
    if (mode === "complete" && !completo) {
      var faltan = _expoFaltantes(formData);
      _expoNewStatus("Faltan datos para confirmar: " + faltan.join(", ") + ".", "err");
      if (pauseBtn) pauseBtn.disabled = false;
      if (goBtn) goBtn.disabled = false;
      return;
    }

    _expoCloseNewModal();
    await expoApplyCustomer(custObj, { forceExpoNew: true });
    if (typeof showSection === "function") {
      if (mode === "complete") {
        // Datos completos → al carrito si ya hay ítems, si no al catálogo.
        showSection(cart && cart.length > 0 ? "carrito" : "productos");
      } else {
        // Pausar y cargar pedido → al catálogo a armar el pedido.
        showSection("productos");
      }
    }
  } catch (e) {
    _expoNewStatus("Error: " + (e && e.message ? e.message : e), "err");
  } finally {
    if (pauseBtn) pauseBtn.disabled = false;
    if (goBtn) goBtn.disabled = false;
  }
}

function _expoWireNewModal() {
  if (_expoNewWired) return;
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  _expoNewWired = true;
  // Sacar del #perfil (display:none desde Productos) para que el modal renderice.
  if (m.parentElement !== document.body) document.body.appendChild(m);
  // Validación EN VIVO: el botón "Datos completados" se habilita solo si está todo.
  m.addEventListener("input", _expoNewSyncComplete);
  m.addEventListener("change", _expoNewSyncComplete);
  var byId = function (x) { return document.getElementById(x); };
  if (byId("expoNewBackdrop")) byId("expoNewBackdrop").addEventListener("click", _expoCloseNewModal);
  // "Datos completados": exige TODO (salvo expreso). Si falta, avisa qué; si
  // está completo, guarda, cierra y lleva al carrito para pagar/enviar.
  if (byId("expoNewClose")) byId("expoNewClose").addEventListener("click", function () { _expoGuardarNuevo("complete"); });
  // Sucursales nuevas van ARRIBA (prepend = true).
  if (byId("expoAddrAdd")) byId("expoAddrAdd").addEventListener("click", function () { _expoAddrAddRow({}, true); });
  if (byId("expoAddrUseFiscal"))
    byId("expoAddrUseFiscal").addEventListener("click", function () {
      var calle = (byId("expoNewDirFiscal").value || "").trim();
      var nro = (byId("expoNewNumFiscal").value || "").trim();
      var loc = (byId("expoNewLocFiscal").value || "").trim();
      var dir = (calle + " " + nro).trim();
      _expoAddrAddRow({
        titulo: dir && loc ? dir + " - " + loc : dir,
        direccion: dir,
        localidad: loc,
        provincia: (byId("expoNewProvFiscal").value || "").trim(),
      }, true);
    });
  if (byId("expoNewPause")) byId("expoNewPause").addEventListener("click", function () { _expoGuardarNuevo("order"); });
  if (byId("expoNewGoOrder")) byId("expoNewGoOrder").addEventListener("click", function () { _expoGuardarNuevo("order"); });
  if (byId("expoNewPinCopy"))
    byId("expoNewPinCopy").addEventListener("click", function () {
      var v = byId("expoNewPin").value;
      if (!v) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(v).then(function () {
          _expoNewStatus("Clave copiada.", "ok");
        });
      } else {
        byId("expoNewPin").select();
      }
    });
}

// ---- EXPO: Continuar carga pausada ----
var _expoResumeWired = false;

function _expoWireResumeModal() {
  if (_expoResumeWired) return;
  var m = document.getElementById("expoResumeModal");
  if (!m) return;
  _expoResumeWired = true;
  if (m.parentElement !== document.body) document.body.appendChild(m);
  var closeBtn = document.getElementById("expoResumeClose");
  var backdrop = document.getElementById("expoResumeBackdrop");
  if (closeBtn) closeBtn.addEventListener("click", expoCloseResumeModal);
  if (backdrop) backdrop.addEventListener("click", expoCloseResumeModal);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && m.classList.contains("open")) expoCloseResumeModal();
  });
}

function expoCloseResumeModal() {
  var m = document.getElementById("expoResumeModal");
  if (!m) return;
  m.classList.remove("open");
  m.classList.add("hidden");
  m.setAttribute("aria-hidden", "true");
}

async function expoOpenResumeModal() {
  var m = document.getElementById("expoResumeModal");
  if (!m) return;
  _expoWireResumeModal();
  m.classList.add("open");
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
  var res = document.getElementById("expoResumeList");
  if (res) res.innerHTML = '<div class="expo-pick-hint">Cargando…</div>';
  var r = await supabaseClient
    .from("expo_clientes_pendientes")
    .select("customer_id,cod_cliente,business_name,cuit,localidad,provincia,telefono,whatsapp,mail,vend,dto_vol,pin,condicion_iva,direccion,numero,cp,direcciones_entrega,actualizado_at")
    .eq("estado", "pendiente")
    .order("actualizado_at", { ascending: false });
  if (!res) return;
  if (r.error) {
    res.innerHTML = '<div class="expo-pick-hint expo-pick-err">Error: ' + _expoEsc(r.error.message) + "</div>";
    return;
  }
  // Solo el/los que están EN CURSO: incompletos ("Falta datos"), más el cliente
  // activo ahora (para poder editarlo aunque ya esté completo). Los clientes
  // viejos ya completos NO se listan acá — ensucian la carga en curso.
  var _activeCod =
    customerProfile && customerProfile.cod_cliente
      ? String(customerProfile.cod_cliente)
      : "";
  var rows = (r.data || []).filter(function (c) {
    var completo = _expoDatosCompletos(c);
    var esActivo = _activeCod && String(c.cod_cliente || "") === _activeCod;
    return !completo || esActivo;
  });
  if (!rows.length) {
    res.innerHTML = '<div class="expo-pick-hint">No hay cargas en curso.</div>';
    return;
  }
  _expoResumeRows = rows;
  var html = "";
  rows.forEach(function (c, i) {
    var nDir = Array.isArray(c.direcciones_entrega) ? c.direcciones_entrega.length : 0;
    var ok = _expoDatosCompletos(c);
    var badge = ok
      ? '<span class="expo-resume-badge ok">✓ Completo</span>'
      : '<span class="expo-resume-badge falta">Falta datos</span>';
    html +=
      '<button type="button" class="expo-pick-row" data-idx="' + i + '">' +
      '<span class="expo-pick-name">' + _expoEsc(c.business_name || "(sin razón social)") + " " + badge + "</span>" +
      '<span class="expo-pick-sub">Cód ' + _expoEsc(c.cod_cliente || "—") +
      (c.cuit ? " · CUIT " + _expoEsc(c.cuit) : "") +
      " · " + nDir + " dir." + "</span>" +
      "</button>";
  });
  res.innerHTML = html;
  res.querySelectorAll(".expo-pick-row").forEach(function (row) {
    row.addEventListener("click", function () {
      var c = _expoResumeRows[parseInt(row.dataset.idx, 10)];
      if (c) expoEditarPendiente(c);
    });
  });
}

var _expoResumeRows = [];

// Abre el modal de "Nuevo cliente" en modo EDICIÓN, precargado desde staging.
function expoEditarPendiente(row) {
  var m = document.getElementById("expoNewModal");
  if (!m) return;
  expoCloseResumeModal();
  _expoNewState = { id: row.customer_id, authId: null };
  _expoFillVendedores();
  _expoFillProvincias();
  function setVal(id, v) {
    var el = document.getElementById(id);
    if (el) el.value = v != null ? v : "";
  }
  setVal("expoNewRazon", row.business_name);
  setVal("expoNewCuit", row.cuit);
  setVal("expoNewWhatsapp", row.whatsapp);
  setVal("expoNewMail", row.mail);
  setVal("expoNewCod", row.cod_cliente);
  setVal("expoNewDirFiscal", row.direccion);
  setVal("expoNewNumFiscal", row.numero);
  setVal("expoNewCpFiscal", row.cp);
  setVal("expoNewLocFiscal", row.localidad);
  setVal("expoNewProvFiscal", row.provincia);
  var condIva = document.getElementById("expoNewCondIva");
  if (condIva) condIva.value = row.condicion_iva || "Responsable Inscripto";
  var vendSel = document.getElementById("expoNewVend");
  if (vendSel && row.vend != null && row.vend !== "") vendSel.value = String(row.vend);
  document.getElementById("expoNewPin").value = row.pin || _expoNewGenPin();
  var list = document.getElementById("expoAddrList");
  list.innerHTML = "";
  var dirs = Array.isArray(row.direcciones_entrega) ? row.direcciones_entrega : [];
  if (dirs.length) dirs.forEach(function (d) { _expoAddrAddRow(d); });
  else _expoAddrAddRow();
  _expoNewStatus("Editando carga pausada. Guardá para actualizar.", "");
  _expoWireNewModal();
  _expoNewSyncComplete();
  m.classList.add("open");
  m.classList.remove("hidden");
  m.setAttribute("aria-hidden", "false");
}

function _expoWirePickModal() {
  if (_expoPickWired) return;
  var m = document.getElementById("expoPickModal");
  if (!m) return;
  _expoPickWired = true;
  // El markup quedó dentro de #perfil (una .section que se oculta con display:none),
  // así que el modal no renderiza desde Productos. Lo movemos al body.
  if (m.parentElement !== document.body) document.body.appendChild(m);
  var closeBtn = document.getElementById("expoPickClose");
  var backdrop = document.getElementById("expoPickBackdrop");
  var inp = document.getElementById("expoPickSearch");
  if (closeBtn) closeBtn.addEventListener("click", expoClosePickModal);
  if (backdrop) backdrop.addEventListener("click", expoClosePickModal);
  if (inp)
    inp.addEventListener("input", function () {
      clearTimeout(_expoSearchTimer);
      _expoSearchTimer = setTimeout(_expoRunSearch, 250);
    });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !m.classList.contains("hidden"))
      expoClosePickModal();
  });
}

function renderCustomerSelector() {
  var existing = document.getElementById("customerSelectorBanner");
  if (existing) existing.remove();

  var existingCart = document.getElementById("customerSelectorCart");
  if (existingCart) existingCart.remove();

  // EXPO: reemplaza el selector "Elegir razón social" por la barra
  // [Elegir cliente] [Nuevo cliente]. Solo para el operador admin.
  if (EXPO_MODE && isAdmin) {
    renderExpoEntryBar();
    return;
  }

  if (!linkedCustomers.length) return;

  var optionsData = buildCustomerOptionsData();
  var isLinked =
    customerProfile &&
    linkedCustomers.some(function (c) {
      return c.customer_id === customerProfile.id;
    });
  var isOwnVendor =
    customerProfile &&
    _vendorOwnProfile &&
    String(customerProfile.id) === String(_vendorOwnProfile.id);
  var currentVal = isLinked
    ? customerProfile.id
    : isOwnVendor
      ? VENDOR_SELF_VALUE
      : "";

  // --- Banner on products page ---
  var banner = document.createElement("div");
  banner.id = "customerSelectorBanner";
  banner.className = "customer-selector-banner";

  var labelWrap = document.createElement("span");
  labelWrap.className = "cs-label-wrap";
  labelWrap.innerHTML =
    '<svg class="cs-icon" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-3.33 0-8 1.67-8 5v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1c0-3.33-4.67-5-8-5z" fill="currentColor"/>' +
    "</svg>" +
    '<span class="cs-label">Pedir para</span>';

  var dropdown = _csCreateDropdown(
    "customerSelect",
    optionsData,
    currentVal,
    "cs-dropdown-banner",
  );

  banner.appendChild(labelWrap);
  banner.appendChild(dropdown);

  var section = document.getElementById("productos");
  if (section) {
    var sortRow = section.querySelector(".sort-row");
    if (sortRow) {
      sortRow.insertBefore(banner, sortRow.firstChild);
    } else {
      var titleRow = section.querySelector(".section-title-row");
      if (titleRow) {
        titleRow.parentNode.insertBefore(banner, titleRow.nextSibling);
      } else {
        section.insertBefore(banner, section.firstChild);
      }
    }
  }

  // --- Selector in cart (above shipping) ---
  var cartCard = document.createElement("div");
  cartCard.id = "customerSelectorCart";
  cartCard.className = "ship-row";

  var cartInner = document.createElement("div");
  cartInner.className = "ship-card";

  var cartLabel = document.createElement("label");
  cartLabel.className = "ship-label";
  cartLabel.textContent = "Pedir para (Razón Social)";
  cartInner.appendChild(cartLabel);

  var cartDropdown = _csCreateDropdown(
    "customerSelectCart",
    optionsData,
    currentVal,
    "cs-dropdown-card cs-dropdown-ship",
  );
  cartInner.appendChild(cartDropdown);

  // Botón Confirmar — al costado del dropdown (mismo look que ship-confirm-btn)
  var custConfirmBtn = document.createElement("button");
  custConfirmBtn.type = "button";
  custConfirmBtn.id = "customerConfirmBtn";
  custConfirmBtn.className = "ship-confirm-btn";
  custConfirmBtn.textContent = "Confirmar";
  custConfirmBtn.addEventListener("click", function () {
    var sel = document.getElementById("customerSelectCart");
    var v = sel ? String(sel.value || "").trim() : "";
    // Sólo confirma si hay un cliente real seleccionado (no placeholder
    // ni "Perfil Vendedor").
    if (!v || v === VENDOR_SELF_VALUE) return;
    this.textContent = "Confirmada";
    this.classList.add("confirmed");
    this.disabled = true;
    if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
    if (typeof updateCart === "function") updateCart();
  });
  cartInner.appendChild(custConfirmBtn);

  var cartHint = document.createElement("div");
  cartHint.className = "ship-hint";
  cartHint.textContent =
    "Seleccioná un cliente para poder confirmar el pedido.";
  cartInner.appendChild(cartHint);

  // Card pasa a layout grid (has-confirm) — dropdown a la izq, btn a la der
  cartInner.classList.add("has-confirm");
  cartCard.appendChild(cartInner);

  var shipRow = document.querySelector("#carrito .ship-row");
  if (shipRow && shipRow.parentNode) {
    shipRow.parentNode.insertBefore(cartCard, shipRow);
  }

  // Re-evaluar visibilidad del botón "Pedido" del header — se oculta si
  // queda en vendor browse mode (sin selección), se muestra si hay cliente
  if (typeof _updateCartUIVisibility === "function") _updateCartUIVisibility();
}

async function onLinkedCustomerSelected(opts) {
  opts = opts || {};
  // Si isRestore=true, evitar vaciar el carrito (estamos restaurando la
  // misma selección al volver de historial/sugerencias, no cambiando cliente)
  var isRestore = !!opts.isRestore;
  var sel = document.getElementById("customerSelect");
  var selCart = document.getElementById("customerSelectCart");
  var val = (sel && sel.value) || (selCart && selCart.value) || "";

  if (val === VENDOR_SELF_VALUE) {
    // Volver al perfil propio del vendedor — sin necesidad de refresh
    if (_vendorOwnProfile) {
      customerProfile = Object.assign({}, _vendorOwnProfile);
    }
    try {
      localStorage.removeItem("lk_vendor_selected_cod_cliente");
      localStorage.removeItem("lk_vendor_selected_business_name");
      localStorage.removeItem("lk_vendor_selected_dto_vol");
    } catch (e) {}

    var nameSelf = (customerProfile && customerProfile.business_name || "").trim();
    var helloElSelf = $("helloNavText");
    if (helloElSelf)
      helloElSelf.innerText = nameSelf ? "Hola, " + nameSelf + " !" : "Hola!";

    var noteSelf = $("customerNote");
    if (noteSelf) noteSelf.innerText = "";

    // Vaciar carrito al cambiar de cliente (vuelta al vendor)
    cart.splice(0, cart.length);

    try {
      myAssortmentIds = await loadMyAssortmentIds();
    } catch (e) {}
    await loadDeliveryOptions(true);
    renderProducts();
    updateCart();
    if (typeof fillProfileSummaryUI === "function") fillProfileSummaryUI();
    if (typeof applyProfileVendorVisibility === "function") applyProfileVendorVisibility();
    if (typeof loadVendorNotificationsUI === "function") loadVendorNotificationsUI();
    refreshSubmitEnabled();
    if (typeof updateMenuNotifVisibility === "function") {
      updateMenuNotifVisibility();
    }
    // Volvió al perfil propio del vendedor → ocultar botón "Pedido" del header
    if (typeof _updateCartUIVisibility === "function") _updateCartUIVisibility();
    // Refrescar cards del perfil propio del vendedor (sucursales, drafts).
    // Las del cliente (myOrders, sugerencias, historial) se ocultan vía
    // applyProfileVendorVisibility → no hace falta cargarlas.
    if (typeof loadDraftCarts === "function") loadDraftCarts();
    return;
  }

  if (!val) {
    // Limpiar vendor selection al deseleccionar
    try {
      localStorage.removeItem("lk_vendor_selected_cod_cliente");
      localStorage.removeItem("lk_vendor_selected_business_name");
      localStorage.removeItem("lk_vendor_selected_dto_vol");
    } catch(e) {}
    updateCart();
    refreshSubmitEnabled();
    // Deselección → re-evaluar visibilidad del botón "Pedido"
    if (typeof _updateCartUIVisibility === "function") _updateCartUIVisibility();
    return;
  }

  // Guardar ID previo para saber si realmente cambió el cliente (vs restaurar
  // el mismo al volver de historial/sugerencias)
  var prevCustomerId = customerProfile ? String(customerProfile.id) : null;

  var result = await supabaseClient
    .from("customers")
    .select("id,business_name,dto_vol,cod_cliente,cuit,direccion_fiscal,localidad,vend,mail")
    .eq("id", val)
    .maybeSingle();

  if (result.error || !result.data) {
    console.error("onLinkedCustomerSelected error:", result.error);
    return;
  }

  customerProfile = result.data;

  // Persistir cliente seleccionado para historial/sugerencias
  try {
    localStorage.setItem("lk_vendor_selected_cod_cliente", customerProfile.cod_cliente || "");
    localStorage.setItem("lk_vendor_selected_business_name", customerProfile.business_name || "");
    localStorage.setItem("lk_vendor_selected_dto_vol", String(customerProfile.dto_vol || 0));
  } catch(e) {}

  var name = (customerProfile.business_name || "").trim();
  var helloEl = $("helloNavText");
  if (helloEl) helloEl.innerText = name ? "Hola, " + name + " !" : "Hola!";

  var note = $("customerNote");
  if (note) {
    var dto = Number(customerProfile.dto_vol || 0);
    if (dto > 0) {
      note.innerText = "Ya está aplicado tu Dto x Volumen";
    } else {
      note.innerText = "";
    }
  }

  // Vaciar carrito SOLO si el cliente realmente cambió (user action) y
  // no es un restore (página volvió de historial/sugerencias). Cuando el
  // vendor vuelve a mayorista desde otra página y se restaura la misma
  // selección via restoreSelectedCustomerIfAny, el carrito persiste.
  var customerChanged = prevCustomerId !== String(customerProfile.id);
  if (customerChanged && !isRestore) {
    cart.splice(0, cart.length);
  }

  // Recargar surtido del cliente seleccionado
  myAssortmentIds = await loadMyAssortmentIds();

  await loadDeliveryOptions(true);
  renderProducts();
  updateCart();
  syncPaymentButtons();
  // Vendor actuando como cliente → mostrar cards de cliente, ocultar Pedidos Clientes
  if (typeof applyProfileVendorVisibility === "function") applyProfileVendorVisibility();
  if (typeof loadVendorNotificationsUI === "function") loadVendorNotificationsUI();
  // Sincronizar el menú dropdown (Pedidos Clientes oculto cuando hay cliente seleccionado)
  if (typeof updateMenuNotifVisibility === "function") updateMenuNotifVisibility();
  // Cliente elegido → mostrar de nuevo el botón "Pedido" del header
  if (typeof _updateCartUIVisibility === "function") _updateCartUIVisibility();

  // Si el cliente CAMBIÓ (no es un restore), refrescar las cards del perfil
  // que dependen del cliente activo: historial de pedidos web, sucursales,
  // drafts. Sin esto, el perfil quedaba mostrando datos del cliente anterior
  // hasta que el usuario reabriera la sección.
  if (customerChanged) {
    if (typeof loadMyOrdersUI === "function") loadMyOrdersUI();
    if (typeof loadMyAddressesUI === "function") loadMyAddressesUI();
    if (typeof loadDraftCarts === "function") loadDraftCarts();
  }
}

// Restaura el cliente seleccionado por el vendedor al volver de historial/sugerencias/etc.
// Usa _csSetValue para sincronizar también el visual del dropdown custom.
async function restoreSelectedCustomerIfAny() {
  // EXPO: el cliente pudo elegirse del padrón (no queda en linkedCustomers tras
  // recargar la página al volver de historial/sugerencias). Se restaura desde su
  // propia clave, re-aplicándolo completo. fromRestore=true → NO vacía el carrito.
  if (EXPO_MODE && isAdmin) {
    var rawExpo = "";
    try {
      rawExpo = localStorage.getItem("lk_expo_selected_client") || "";
    } catch (e) {}
    if (rawExpo) {
      try {
        var ec = JSON.parse(rawExpo);
        if (ec && ec.id) {
          await expoApplyCustomer(
            {
              id: ec.id,
              cod_cliente: ec.cod_cliente,
              business_name: ec.business_name,
              dto_vol: ec.dto_vol,
              vend: ec.vend,
            },
            { forceExpoNew: !!ec.expoClientMode, fromRestore: true },
          );
          return;
        }
      } catch (e) { /* clave corrupta: seguir con la restauración normal */ }
    }
    return;
  }

  if (!linkedCustomers.length) return;
  var savedCod = "";
  try {
    savedCod = (localStorage.getItem("lk_vendor_selected_cod_cliente") || "").trim();
  } catch (e) {}
  if (!savedCod) return;

  var match = linkedCustomers.find(function (c) {
    return String(c.cod_cliente) === savedCod;
  });
  if (!match) {
    // La selección guardada ya no es válida, limpiar
    try {
      localStorage.removeItem("lk_vendor_selected_cod_cliente");
      localStorage.removeItem("lk_vendor_selected_business_name");
      localStorage.removeItem("lk_vendor_selected_dto_vol");
    } catch (e) {}
    return;
  }

  _csSetValue("customerSelect", match.customer_id);
  _csSetValue("customerSelectCart", match.customer_id);

  // Pasamos isRestore=true para que NO se vacíe el carrito — estamos
  // restaurando la misma selección al volver de historial/sugerencias
  await onLinkedCustomerSelected({ isRestore: true });
}

function openChangePassword() {
  if (!currentSession) {
    openLogin();
    return;
  }

  showSection("perfil");
  closeUserMenu?.();

  // ✅ abrir usando la función global del modal (la del PASO 1)
  // Esperamos 1 tick para asegurar que el DOM del perfil esté visible
  setTimeout(() => {
    if (typeof window.openPassModal === "function") {
      window.openPassModal();
    } else {
      // fallback por si algo falló
      const passModal = document.getElementById("passModal");
      if (passModal) {
        passModal.classList.remove("hidden");
        passModal.setAttribute("aria-hidden", "false");
        document.getElementById("newPass1")?.focus();
      }
    }
  }, 0);
}
window.openChangePassword = openChangePassword;

function openPassModal() {
  const passModal = document.getElementById("passModal");
  if (!passModal) return;

  passModal.classList.add("open"); // ✅ clave
  passModal.classList.remove("hidden"); // por si existe
  passModal.setAttribute("aria-hidden", "false");

  document.getElementById("newPass1")?.focus();
}

function closePassModal() {
  const passModal = document.getElementById("passModal");
  if (!passModal) return;

  passModal.classList.remove("open"); // ✅ clave
  passModal.classList.add("hidden");
  passModal.setAttribute("aria-hidden", "true");
}

function togglePassword(inputId, btnEl) {
  const input = document.getElementById(inputId);
  if (!input || !btnEl) return;

  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  btnEl.setAttribute("data-show", isHidden ? "1" : "0");
}

/***********************
 * INIT (arranque de la web) — CORREGIDO ✅
 ***********************/
document.addEventListener("DOMContentLoaded", async () => {
  // getWebOrderDiscount se carga en paralelo más abajo (Promise.all)
  // ===== LOADER CONTROL (solo 1ra vez por página) =====
 const loader = document.getElementById("pageLoader");
  if (loader) loader.remove();

  // Exponer funciones al HTML (onclick)
  // El carrito ya fue hidratado por la IIFE `hydrateCartFromLS` al cargar el script.
  window.showSection = showSection;
  window.goToProductsTop = goToProductsTop;
  window.openLogin = openLogin;
  window.closeLogin = closeLogin;
  window.login = login;
  window.logout = logout;

  window.addFirstBox = addFirstBox;
  window.changeQty = changeQty;
  window.manualQty = manualQty;
  window.removeItem = removeItem;
  window.updateCart = updateCart;
  window.submitOrder = submitOrder;
  window.openProfile = openProfile;
  window.volverMayorista = volverMayorista;
  window.descargarPedidoPDF = descargarPedidoPDF;
  window.descargarComprobantePedido = descargarComprobantePedido;
  // ✅ Sacar "Cambiar contraseña" del menú aunque no tenga id
  function removeChangePassItems() {
    document
      .querySelectorAll(
        "#userMenu .user-menu-item, #userMenu button, #userMenu a, #userMenu div, #userMenu span",
      )
      .forEach((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === "cambiar contraseña" || t.includes("cambiar contraseña")) {
          el.remove();
        }
      });

    // mobile (por si también existe)
    document
      .querySelectorAll(
        "#mobileUserMenu .user-menu-item, #mobileUserMenu button, #mobileUserMenu a, #mobileUserMenu div, #mobileUserMenu span",
      )
      .forEach((el) => {
        const t = (el.textContent || "").trim().toLowerCase();
        if (t === "cambiar contraseña" || t.includes("cambiar contraseña")) {
          el.remove();
        }
      });
  }

  // correr al cargar y también después (por si se renderiza tarde)
  removeChangePassItems();
  setTimeout(removeChangePassItems, 300);
  setTimeout(removeChangePassItems, 1000);

  // =============================
  // SORT (desktop botones + selects + mobile) ✅ ÚNICO BLOQUE
  // =============================
  function applySortUI() {
    const wrap = $("desktopSortButtons");
    if (wrap) {
      wrap.querySelectorAll(".ds-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.sort === sortMode);
      });
    }

    const s1 = $("sortSelect");
    if (s1) s1.value = sortMode;

    const s2 = $("mobileSortSelect");
    if (s2) s2.value = sortMode;

    // Sync custom dropdown desktop "Filtrar por…"
    const trig = $("sortDropdownTrigger");
    const popup = $("sortDropdownPopup");
    if (trig && popup) {
      const opt = popup.querySelector(`.sort-dd-option[data-value="${sortMode}"]`);
      // Default ("category") muestra "Filtrar por…" como placeholder.
      // Cualquier otra opción muestra el label de esa opción.
      const label = sortMode === "category"
        ? "Filtrar por…"
        : (opt ? opt.dataset.label : "Filtrar por…");
      const labelEl = trig.querySelector(".sort-dd-label");
      if (labelEl) labelEl.textContent = label;
      // Marcar la opción seleccionada
      popup.querySelectorAll(".sort-dd-option").forEach((b) => {
        b.removeAttribute("data-selected");
      });
      if (opt) opt.setAttribute("data-selected", "true");
      // Trigger negro cuando NO es default (indicar visualmente que hay filtro activo)
      if (sortMode === "category") {
        trig.removeAttribute("data-active");
      } else {
        trig.setAttribute("data-active", "1");
      }
    }
  }

  function syncNewFilterBtn() {
    const b = $("btnFilterNew");
    if (b) b.classList.toggle("on", !!filterNewOnly);
  }

  $("btnFilterNew")?.addEventListener("click", () => {
    filterNewOnly = !filterNewOnly;
    syncNewFilterBtn();
    renderProducts();
  });

  function syncMyAssortmentBtn() {
    const b = $("btnFilterAssortment");
    if (b) b.classList.toggle("on", !!filterMyAssortment);
  }

  // estado inicial
  syncMyAssortmentBtn();

  $("btnFilterAssortment")?.addEventListener("click", async () => {
    if (!currentSession) return openLogin();

    if (!customerProfile?.cod_cliente) {
      await refreshAuthState();
    }

    if (!customerProfile?.cod_cliente) {
      // Sin cliente vinculado no se puede filtrar surtido
      return;
    }

    filterMyAssortment = !filterMyAssortment;
    syncMyAssortmentBtn();

    if (filterMyAssortment) {
      myAssortmentIds = await loadMyAssortmentIds();
    }

    const banner = document.getElementById("assortmentBanner");
    if (banner) {
      banner.style.display = filterMyAssortment ? "block" : "none";
    }

    renderProducts();
  });

  // TOAST VER PEDIDOS
  window.addEventListener("resize", positionViewOrderToastBelowHeader);

  // al iniciar
  syncNewFilterBtn();

    async function setSortMode(next) {
    sortMode = String(next || "category");
    applySortUI();
    renderProducts();
    // Scroll al inicio de la grilla de productos, no al top de la página
    const grid = $("productsContainer");
    if (grid) grid.scrollIntoView({ behavior: "smooth", block: "start" });
  }


    $("desktopSortButtons")?.addEventListener("click", async (e) => {
    const btn = e.target.closest(".ds-btn");
    if (!btn) return;

    const nextSort = String(btn.dataset.sort || "").trim();
    if (!nextSort) return;

    await setSortMode(nextSort);
  });

  $("sortSelect")?.addEventListener("change", async (e) => {
    await setSortMode(e.target.value);
  });

  $("mobileSortSelect")?.addEventListener("change", async (e) => {
    await setSortMode(e.target.value);
  });

  // Wire del custom dropdown desktop "Filtrar por…" (toggle + click option)
  (function wireSortDropdown() {
    const trig = $("sortDropdownTrigger");
    const popup = $("sortDropdownPopup");
    if (!trig || !popup) return;

    function openPopup() {
      popup.hidden = false;
      trig.setAttribute("aria-expanded", "true");
    }
    function closePopup() {
      popup.hidden = true;
      trig.setAttribute("aria-expanded", "false");
    }
    function togglePopup() {
      if (popup.hidden) openPopup();
      else closePopup();
    }

    trig.addEventListener("click", function (e) {
      e.stopPropagation();
      togglePopup();
    });

    popup.addEventListener("click", async function (e) {
      const btn = e.target.closest(".sort-dd-option");
      if (!btn) return;
      const value = btn.dataset.value;
      closePopup();
      if (value) await setSortMode(value);
    });

    // Click afuera cierra
    document.addEventListener("click", function (e) {
      if (popup.hidden) return;
      if (e.target.closest("#sortDropdownWrap")) return;
      closePopup();
    });
    // ESC cierra
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !popup.hidden) closePopup();
    });
  })();

  applySortUI();

  // =============================
  // CUIT live format
  // =============================
  function formatCUITLive(value) {
    const d = String(value || "")
      .replace(/\D/g, "")
      .slice(0, 11);
    if (d.length <= 2) return d;
    if (d.length <= 10) return `${d.slice(0, 2)}-${d.slice(2)}`;
    return `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
  }

  const cuitEl = $("cuitInput");
  if (cuitEl) {
    cuitEl.addEventListener("input", (e) => {
      const el = e.target;
      // Solo formatear como CUIT si el input tiene solo dígitos/guiones/espacios
      if (!/[a-zA-Z]/.test(el.value)) {
        const start = el.selectionStart;
        const before = el.value;

        el.value = formatCUITLive(el.value);

        const diff = el.value.length - before.length;
        const next = (start ?? el.value.length) + diff;
        el.setSelectionRange(next, next);
      }
    });
  }

  // =============================
  // CATEGORÍAS (UNA SOLA IMPLEMENTACIÓN)
  // =============================
  function closeCategoriesMenuFixed() {
    const menu = $("categoriesMenu");
    if (!menu) return;
    menu.classList.remove("open");
    menu.style.opacity = "0";
    menu.style.visibility = "hidden";
    menu.style.pointerEvents = "none";
    menu.style.transform = "translateY(6px)";
  }

  function toggleCategoriesMenuFixed() {
    const menu = $("categoriesMenu");
    if (!menu) return;

    const willOpen = !menu.classList.contains("open");
    closeUserMenu?.();

    menu.classList.toggle("open", willOpen);

    if (willOpen) {
      menu.style.opacity = "1";
      menu.style.visibility = "visible";
      menu.style.pointerEvents = "auto";
      menu.style.transform = "translateY(0)";
    } else {
      closeCategoriesMenuFixed();
    }
  }

  // si ya tenías funciones globales, las unificamos acá
  window.closeCategoriesMenu = closeCategoriesMenuFixed;
  window.toggleCategoriesMenu = toggleCategoriesMenuFixed;

  // estado inicial cerrado
  closeCategoriesMenuFixed();

  $("categoriesBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleCategoriesMenuFixed();
  });

  // Ver Pedido animacion
  document.getElementById("viewOrderBtn")?.addEventListener("click", () => {
    hideViewOrderToast();
    showSection("carrito");
  });

  // Botón dentro del perfil
  document
    .getElementById("btnOpenPassModal")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPassModal();
    });

  // Cierres
  document
    .getElementById("btnClosePassModal")
    ?.addEventListener("click", closePassModal);
  document
    .getElementById("passModalBackdrop")
    ?.addEventListener("click", closePassModal);
  document
    .getElementById("btnChangePass")
    ?.addEventListener("click", changePasswordUI);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePassModal();
  });

  // =============================
  // USER MENU DESKTOP (BOTÓN ÚNICO userToggleBtn)
  // =============================
  const userBtn = $("userToggleBtn");
  const userMenu = $("userMenu");

  function openUserMenuFixed() {
    if (!userMenu) return;
    userMenu.classList.add("open");
    userMenu.setAttribute("aria-hidden", "false");
    userBtn?.setAttribute("aria-expanded", "true");
  }

  function closeUserMenuFixed() {
    if (!userMenu) return;
    userMenu.classList.remove("open");
    userMenu.setAttribute("aria-hidden", "true");
    userBtn?.setAttribute("aria-expanded", "false");
  }

  function toggleUserMenuFixed() {
    if (!userMenu) return;
    const isOpen = userMenu.classList.contains("open");
    if (isOpen) closeUserMenuFixed();
    else openUserMenuFixed();
  }

  // forzar que tus otras partes usen estas funciones
  window.closeUserMenu = closeUserMenuFixed;
  window.toggleUserMenu = toggleUserMenuFixed;

  // estado inicial cerrado
  closeUserMenuFixed();

  if (userBtn) {
    userBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleUserMenuFixed();
    });
  }

  if (userMenu) {
    userMenu.addEventListener("click", (e) => e.stopPropagation());
  }

  // =============================
  // PAGO (botones)
  // =============================
  // Helper para limpiar TODAS las selecciones (.selected + .active) en TODOS
  // los pay-btn (incluyendo payLaterBtn) → así nunca quedan 2 verdes.
  function _clearAllPayBtnSelections() {
    document
      .querySelectorAll("#paymentButtons .pay-btn, #payLaterBtn")
      .forEach((b) => {
        b.classList.remove("selected");
        b.classList.remove("active");
      });
  }

  $("paymentButtons")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".pay-btn");
    if (!btn) return;

    // ✅ Si clickea "Prefiero no decidir ahora" (rare, está fuera del wrap
    // pero por si está dentro en algún render), lo tratamos como método válido
    if (btn.id === "payLaterBtn") {
      const ps = $("paymentSelect");
      if (ps) ps.value = "LATER";
      _clearAllPayBtnSelections();
      btn.classList.add("selected");
      updateCart();
      refreshSubmitEnabled();
      return;
    }

    // ✅ Resto de botones normales (con descuento)
    setPaymentByValue(btn.dataset.value);
    _clearAllPayBtnSelections();
    btn.classList.add("selected");
    btn.classList.add("active");
    updateCart();
    refreshSubmitEnabled();
  });

  $("payLaterBtn")?.addEventListener("click", () => {
    const ps = $("paymentSelect");
    if (ps) ps.value = "LATER";
    _clearAllPayBtnSelections();
    $("payLaterBtn")?.classList.add("selected");
    updateCart();
    refreshSubmitEnabled();
  });

  // Pago (select)
  $("paymentSelect")?.addEventListener("change", () => {
    syncPaymentButtons();
    updateCart();
    refreshSubmitEnabled();
  });

  // Mobile: carrito -> Pedido
  $("mobileCartBtn")?.addEventListener("click", () => showSection("carrito"));

  // Mobile: avatar -> dropdown (si no logueado => login)
  $("mobileProfileBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentSession) return openLogin();
    toggleMobileUserMenu();
  });

  // PERFIL: WhatsApp + password
  $("btnAddAddress")?.addEventListener("click", () => {
    const name = (customerProfile?.business_name || "").trim();
    const cod = (customerProfile?.cod_cliente || "").trim();
    const msg = `Hola! Soy ${name}${cod ? ` (Cod Cliente ${cod})` : ""}. Quiero agregar una sucursal de entrega.`;
    window.open(waLink(msg), "_blank", "noopener");
  });

  $("btnReportError")?.addEventListener("click", () => {
    const name = (customerProfile?.business_name || "").trim();
    const cod = (customerProfile?.cod_cliente || "").trim();
    const msg = `Hola! Soy ${name}${cod ? ` (Cod Cliente ${cod})` : ""}. Quiero avisar que hay un error en la web mayorista.`;
    window.open(waLink(msg), "_blank", "noopener");
  });

  // btnChangePass listener ya registrado arriba (línea ~3615)

  // =============================
  // PERFIL - Modal contraseña (UNA SOLA VEZ)
  // =============================

  // Entregas
  const shipSel = $("shippingSelect");
  if (shipSel) {
    deliveryChoice = { slot: shipSel.value || "", label: "", direccionEntrega: "", zonaExpreso: "" };

    shipSel.addEventListener("change", () => {
      const opt = shipSel.options[shipSel.selectedIndex];
      deliveryChoice.slot = shipSel.value || "";
      deliveryChoice.label = opt?.dataset?.label || opt?.textContent || "";
      deliveryChoice.direccionEntrega = opt?.dataset?.direccionEntrega || "";
      deliveryChoice.zonaExpreso = opt?.dataset?.zonaExpreso || "";

      // Al cambiar de sucursal, hay que volver a apretar "Confirmar"
      // (mantenemos el texto corto, igual que cuando el botón se crea por
      // primera vez — antes acá se reseteaba al texto largo "Confirmar
      // direccion entrega" y rompía visualmente la card de entrega).
      deliveryConfirmed = false;
      var shipBtn = document.getElementById("shipConfirmBtn");
      if (shipBtn) {
        shipBtn.textContent = "Confirmar";
        shipBtn.classList.remove("confirmed");
        shipBtn.disabled = !deliveryChoice.slot;
      }

      updateCart();
      refreshSubmitEnabled();
    });
  }

  // =============================
  // Click afuera: cerrar menús (UNA SOLA VEZ)
  // =============================
  document.addEventListener("click", (e) => {
    // categorías
    const catBtn = $("categoriesBtn");
    const catMenu = $("categoriesMenu");
    const insideCat =
      (catBtn && catBtn.contains(e.target)) ||
      (catMenu && catMenu.contains(e.target));
    if (!insideCat) closeCategoriesMenuFixed();

    // user desktop
    const insideUser =
      (userBtn && userBtn.contains(e.target)) ||
      (userMenu && userMenu.contains(e.target));
    if (!insideUser) closeUserMenuFixed();

    // user mobile
    const mMenu = $("mobileUserMenu");
    const mBtn = $("mobileProfileBtn");
    if (mMenu && mBtn) {
      const insideM = mMenu.contains(e.target) || mBtn.contains(e.target);
      if (!insideM) closeMobileUserMenu();
    }
  });

  // Buscador NAV + Mobile (con debounce 250ms)
  const debouncedSearch = debounce(() => renderProducts(), 250);

  const navSearch = $("navSearch");
  if (navSearch) {
    navSearch.addEventListener("input", () => {
      searchTerm = String(navSearch.value || "").trim();
      debouncedSearch();
    });
  }

  const mobileSearch = $("mobileSearch");
  if (mobileSearch) {
    mobileSearch.addEventListener("input", () => {
      searchTerm = String(mobileSearch.value || "").trim();
      debouncedSearch();
    });
  }

  // Mobile filtros overlay (Surtido + Ordenar por)
  $("openFiltersBtn")?.addEventListener("click", () => openFiltersOverlay());
  $("filtersCancelBtn")?.addEventListener("click", () =>
    cancelPendingFilters(),
  );
  $("filtersApplyBtn")?.addEventListener("click", () => applyPendingFilters());

  $("filtersOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "filtersOverlay") closeFiltersOverlay();
  });

  // Mobile categorías overlay (separado del de filtros — bottom-sheet propio)
  $("openCategoriasBtn")?.addEventListener("click", () => openCategoriasOverlay());
  $("categoriasCancelBtn")?.addEventListener("click", () => closeCategoriasOverlay());
  $("categoriasApplyBtn")?.addEventListener("click", () => {
    // Reusar applyPendingFilters: aplica categorías + cierra overlay activo
    applyPendingFilters();
    closeCategoriasOverlay();
  });
  $("categoriasOverlay")?.addEventListener("click", (e) => {
    if (e.target.id === "categoriasOverlay") closeCategoriasOverlay();
  });

  // =============================
  // Cargar sesión inicial y productos (en paralelo)
  // =============================
  const { data } = await supabaseClient.auth.getSession();
  currentSession = data.session || null;

  // FAST PATH: si hay productos cacheados, pintar la grilla YA
  // y dejar que auth/precios se actualicen despues.
  const _loggedNow = !!currentSession;
  const _cachedProducts = _getProductsCache(_loggedNow);
  if (_cachedProducts) {
    products = _cachedProducts.map(mapProduct);
    renderCategoriesMenu();
    renderCategoriesSidebar();
    renderProducts();
  }

  // refreshAuthState, loadProducts, linkedCustomers y webDiscount corren en paralelo.
  // Pasamos la session ya cargada para evitar un getSession() duplicado.
  await Promise.all([
    getWebOrderDiscount().then(v => { WEB_ORDER_DISCOUNT = v; }),
    refreshAuthState(currentSession),
    loadProductsFromDB(),
    loadLinkedCustomers(),
  ]);

  // Re-aplicar visibilidad vendor ahora que linkedCustomers cargó (race con refreshAuthState).
  // Sin esto, el menu del vendedor no muestra "Pedidos Clientes" en el primer render.
  if (typeof applyProfileVendorVisibility === "function") applyProfileVendorVisibility();
  if (typeof updateMenuNotifVisibility === "function") updateMenuNotifVisibility();
  if (typeof loadVendorNotificationsUI === "function") loadVendorNotificationsUI();
  if (typeof _updateCartUIVisibility === "function") _updateCartUIVisibility();

  // Importar agregados desde HISTORIAL (depende de products cargados)
  (function importFromHistoryIfAny() {
    const HISTORY_PENDING_KEY = "chef_pending_adds_cod_v1";
    try {
      const raw = localStorage.getItem(HISTORY_PENDING_KEY);
      if (!raw) return;

      const list = JSON.parse(raw);
      if (!Array.isArray(list) || !list.length) return;

      list.forEach(({ cod, qty }) => {
        const c = String(cod || "").trim();
        const q = Math.max(1, parseInt(qty, 10) || 1);
        if (!c) return;

        const prod = products.find((p) => String(p.cod) === c);
        if (!prod) return;

        const found = cart.find(
          (ci) => String(ci.productId) === String(prod.id),
        );

        if (found) found.qtyCajas += q;
        else cart.push({ productId: String(prod.id), qtyCajas: q });
      });

      localStorage.removeItem(HISTORY_PENDING_KEY);
    } catch (e) {
      console.warn("Import history failed:", e);
    }
  })();

  normalizeCartAgainstProducts();
  renderCategoriesMenu();
  renderCategoriesSidebar();
  renderProducts();
  updateCart();
  syncPaymentButtons();
  renderCustomerSelector();

  // Si hay una selección de vendedor guardada, restaurarla
  await restoreSelectedCustomerIfAny();

  // Reactividad login/logout
  let _wasLoggedIn = !!currentSession;

  supabaseClient.auth.onAuthStateChange(async (event, session) => {
    const previouslyLoggedIn = _wasLoggedIn;
    _wasLoggedIn = !!session;

    // INITIAL_SESSION ya lo maneja la init de DOMContentLoaded.
    // TOKEN_REFRESHED no cambia el usuario.
    // SIGNED_IN cuando ya estaba logueado (tab return con token refresh) tampoco
    // debe resetear la UI.
    if (
      event === "INITIAL_SESSION" ||
      event === "TOKEN_REFRESHED" ||
      (event === "SIGNED_IN" && previouslyLoggedIn && !!session)
    ) {
      return;
    }

    currentSession = session;

    // reset surtido al cambiar sesión
    if (!currentSession) {
      myAssortmentIds = null;
      filterMyAssortment = false;
    }
    syncMyAssortmentBtn?.();

    searchTerm = "";
    const ns = $("navSearch");
    if (ns) ns.value = "";

    // Las 3 cargas son independientes -> paralelo
    await Promise.all([
      refreshAuthState(session),
      loadProductsFromDB(),
      loadLinkedCustomers(),
    ]);

    // Solo recargar surtido si el filtro esta activo
    if (filterMyAssortment && currentSession && customerProfile?.cod_cliente) {
      myAssortmentIds = await loadMyAssortmentIds();
    } else if (!currentSession) {
      myAssortmentIds = null;
    }

    renderCategoriesMenu();
    closeCategoriesMenuFixed();

    renderCategoriesSidebar();
    renderProducts();
    updateCart();

    syncPaymentButtons();

    renderCustomerSelector();

    // Restaurar selección del vendedor si había una
    await restoreSelectedCustomerIfAny();

    // Recargar direcciones si estamos en el carrito
    const carritoSection = $("carrito");
    if (carritoSection && carritoSection.classList.contains("active")) {
      loadDeliveryOptions(true);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // Solo actualizar carrito y botones, no reconstruir toda la grilla
    updateCart();
    syncPaymentButtons();
  });

  window.addEventListener("pageshow", async (e) => {
    // Solo re-renderizar si viene del bfcache (back/forward del navegador)
    if (!e.persisted) return;
    try {
      await refreshAuthState();

      if (
        filterMyAssortment &&
        currentSession &&
        customerProfile?.cod_cliente
      ) {
        myAssortmentIds = await loadMyAssortmentIds();
      }

      renderProducts();
      updateCart();
      syncPaymentButtons();
    } catch (err) {
      console.warn("Error en pageshow:", err);
    }
  });
});

function openHistorialFromMenu(v) {
  const vista = v || "hist";
  window.location.href = `./historial.html?v=${encodeURIComponent(vista)}`;
}

function getCodClienteForHistorial() {
  const dom = (
    document.getElementById("pfCodCliente")?.textContent || ""
  ).trim();

  const ls =
    localStorage.getItem("cod_cliente") ||
    localStorage.getItem("codCliente") ||
    localStorage.getItem("cliente") ||
    localStorage.getItem("customer") ||
    localStorage.getItem("customer_id") ||
    "";

  const v = (dom && dom !== "—" ? dom : ls || "").trim();
  return v && v !== "—" ? v : "";
}

// ===== HISTORIAL / SUGERENCIAS / NOVEDADES =====

function getCodClienteFromProfileOrStorage() {
  const dom = (
    document.getElementById("pfCodCliente")?.textContent || ""
  ).trim();
  if (dom && dom !== "—") return dom;

  const ls =
    localStorage.getItem("cod_cliente") ||
    localStorage.getItem("codCliente") ||
    localStorage.getItem("cliente") ||
    localStorage.getItem("customer") ||
    localStorage.getItem("customer_id") ||
    "";

  return (ls || "").trim();
}

function abrirHistorial() {
  const path = window.location.pathname;
  const base = path.includes("/productos-main/")
    ? "/productos-main/"
    : path.includes("/productos/")
      ? "/productos/"
      : "/";

  window.location.href = base + "historial";
}

/***********************
 * HELPERS PORTADOS DESDE LK
 ***********************/

// HTML escape (chef ya tiene esc(); replicamos los nombres LK por compat)
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// Stepper genérico usado en algunos contextos (estado de pedidos / notificaciones)
function debugStep(txt) {
  if (typeof setOrderStatus === "function") setOrderStatus(txt, "");
}

/***********************
 * VENDOR HELPERS (perfil propio vs actuar como cliente)
 ***********************/
let _vendorOwnProfile = null; // snapshot del perfil del vendedor logueado

function isActualVendor() {
  if (!_vendorOwnProfile) return false;
  // Vendor detectado vía dos vías:
  //  1) cod_cliente con convención numérica (LK: 10000-10099)
  //  2) tiene clientes vinculados (chef: linkedCustomers via RPC) — más
  //     robusto que el regex porque no depende del rango de cod_cliente.
  var cod = String(_vendorOwnProfile.cod_cliente || "");
  if (/^100\d{2}$/.test(cod)) return true;
  if (typeof isVendorProfile === "function" && isVendorProfile()) return true;
  return false;
}

function isVendorOwnMode() {
  if (!isActualVendor() || !currentSession) return false;
  if (!customerProfile) return false;
  return String(customerProfile.id) === String(_vendorOwnProfile.id);
}

/***********************
 * NOTIFICACIONES VENDEDOR
 ***********************/
const VENDOR_NOTIF_LIMIT_INITIAL = 5;
const VENDOR_NOTIF_LIMIT_FULL = 30;
let _vendorNotifsState = {
  orders: [],
  showAll: false,
  customerById: {},
  inFlight: null,
  lastLoadedAt: 0,
};

function vendorNotifReadKey() {
  var uid =
    (currentSession && currentSession.user && currentSession.user.id) || "anon";
  return "lk_vendor_notifs_read_" + uid;
}

function getVendorNotifReadSet() {
  try {
    var raw = localStorage.getItem(vendorNotifReadKey());
    if (!raw) return new Set();
    var arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

function markVendorNotifRead(orderId) {
  try {
    var set = getVendorNotifReadSet();
    set.add(String(orderId));
    localStorage.setItem(
      vendorNotifReadKey(),
      JSON.stringify(Array.from(set)),
    );
  } catch (e) {}
}

function markAllVendorNotifsRead() {
  try {
    var ids = (_vendorNotifsState.orders || []).map(function (o) {
      return String(o.id);
    });
    localStorage.setItem(vendorNotifReadKey(), JSON.stringify(ids));
  } catch (e) {}
}

async function loadVendorNotificationsUI() {
  var card = document.getElementById("vendorNotifsCard");
  var box = document.getElementById("vendorNotifsBox");
  var badge = document.getElementById("vendorNotifsBadge");
  var btnToggle = document.getElementById("btnNotifsToggle");
  var btnMarkAll = document.getElementById("btnNotifsMarkAllRead");
  if (!card) return;

  // Sincronizar SIEMPRE el menú dropdown ("Pedidos Clientes") con el estado
  // actual — sino queda visible para el vendor cuando elige un cliente.
  if (typeof updateMenuNotifVisibility === "function") updateMenuNotifVisibility();

  if (!isVendorOwnMode()) {
    if (card) card.hidden = true;
    return;
  }
  card.hidden = false;

  var customerById = {};
  (linkedCustomers || []).forEach(function (c) {
    customerById[c.customer_id] = {
      business_name: c.business_name || "",
      cod_cliente: c.cod_cliente || "",
    };
  });

  if (
    _vendorOwnProfile &&
    _vendorOwnProfile.vend !== undefined &&
    _vendorOwnProfile.vend !== null &&
    typeof supabaseClient !== "undefined"
  ) {
    try {
      var vendCode = String(_vendorOwnProfile.vend).trim();
      if (vendCode) {
        var vendVariants = [vendCode];
        var asNum = Number(vendCode);
        if (!isNaN(asNum)) {
          vendVariants.push(String(asNum));
          vendVariants.push(asNum);
        }
        vendVariants = vendVariants.filter(function (v, i, a) {
          return a.indexOf(v) === i;
        });

        var byVendRes = await supabaseClient
          .from("customers")
          .select("id, business_name, cod_cliente, vend")
          .in("vend", vendVariants);

        if (!byVendRes.error && Array.isArray(byVendRes.data)) {
          byVendRes.data.forEach(function (c) {
            if (!customerById[c.id]) {
              customerById[c.id] = {
                business_name: c.business_name || "",
                cod_cliente: c.cod_cliente || "",
              };
            }
          });
        }
      }
    } catch (e) {
      console.warn("[notifs] fallback by vend failed:", e);
    }
  }

  _vendorNotifsState.customerById = customerById;

  var hasCache = _vendorNotifsState.orders.length > 0;
  if (hasCache) {
    renderVendorNotifications();
  } else if (box) {
    box.textContent = "Cargando…";
  }

  if (_vendorNotifsState.inFlight) {
    try { await _vendorNotifsState.inFlight; } catch (e) {}
    if (_vendorNotifsState.orders.length) {
      renderVendorNotifications();
    } else if (box && !hasCache) {
      box.textContent = "Sin pedidos recientes de tus clientes.";
    }
    return;
  }

  _vendorNotifsState.inFlight = (async function () {
    var queryPromise = supabaseClient.rpc("get_my_vendor_orders", {
      p_limit: VENDOR_NOTIF_LIMIT_FULL,
    });
    var timeoutPromise = new Promise(function (_, reject) {
      setTimeout(function () {
        reject(new Error("Timeout (12s) consultando orders"));
      }, 12000);
    });
    return await Promise.race([queryPromise, timeoutPromise]);
  })();

  try {
    var res = await _vendorNotifsState.inFlight;
    if (res && res.error) throw res.error;
    var rawOrders = (res && res.data) || [];

    rawOrders.forEach(function (o) {
      if (!customerById[o.customer_id]) {
        customerById[o.customer_id] = {
          business_name: o.business_name || "",
          cod_cliente: o.cod_cliente || "",
        };
      }
    });
    _vendorNotifsState.customerById = customerById;
    _vendorNotifsState.orders = rawOrders;
    _vendorNotifsState.lastLoadedAt = Date.now();

    var stageByOrder = {};
    var fechaByOrder = {};
    rawOrders.forEach(function (o) {
      stageByOrder[o.id] = Number.isFinite(o.stage) ? o.stage : 0;
      fechaByOrder[o.id] = o.fecha_entrega || null;
    });
    _vendorNotifsState.stageByOrder = stageByOrder;
    _vendorNotifsState.fechaByOrder = fechaByOrder;

    if (!_vendorNotifsState.orders.length) {
      if (box) box.textContent = "Sin pedidos recientes de tus clientes.";
      if (badge) badge.hidden = true;
      if (btnToggle) btnToggle.hidden = true;
      if (btnMarkAll) btnMarkAll.hidden = true;
      if (typeof updateMenuNotifBadge === "function") updateMenuNotifBadge();
      return;
    }
    renderVendorNotifications();
  } catch (e) {
    console.error("loadVendorNotificationsUI error:", e);
    if (_vendorNotifsState.orders.length) {
      renderVendorNotifications();
    } else if (box) {
      box.textContent =
        "Error cargando notificaciones: " + (e?.message || e?.code || "ver consola");
    }
  } finally {
    _vendorNotifsState.inFlight = null;
  }
}

function renderVendorNotifications() {
  var box = document.getElementById("vendorNotifsBox");
  var badge = document.getElementById("vendorNotifsBadge");
  var btnToggle = document.getElementById("btnNotifsToggle");
  var btnMarkAll = document.getElementById("btnNotifsMarkAllRead");
  if (!box) return;

  var orders = _vendorNotifsState.orders || [];
  var customerById = _vendorNotifsState.customerById || {};
  var readSet = getVendorNotifReadSet();
  var unreadCount = orders.filter(function (o) {
    return !readSet.has(String(o.id));
  }).length;

  if (badge) {
    if (unreadCount > 0) {
      badge.hidden = false;
      badge.textContent = String(unreadCount);
    } else {
      badge.hidden = true;
    }
  }

  var showAll = _vendorNotifsState.showAll;
  var slice = showAll
    ? orders
    : orders.slice(0, VENDOR_NOTIF_LIMIT_INITIAL);

  var stageByOrder = _vendorNotifsState.stageByOrder || {};
  var fechaByOrder = _vendorNotifsState.fechaByOrder || {};

  function renderNotifStepper(stage, fechaIso, createdAtIso) {
    var stageNum = Number.isFinite(stage) ? stage : 0;
    var labels = ["Recibido", "Programado", "Enviado"];
    var parts = [];
    for (var i = 0; i <= 2; i++) {
      if (i > 0) {
        parts.push(
          '<span class="o-line ' + (i <= stageNum ? "done" : "") + '"></span>'
        );
      }
      parts.push(
        '<span class="o-dot ' +
          (i <= stageNum ? "done" : "") +
          (i === stageNum ? " current" : "") +
          '" title="' + labels[i] + '"></span>'
      );
    }

    function fmtDateShort(iso) {
      if (!iso) return "";
      try {
        var s = String(iso).slice(0, 10);
        var ps = s.split("-");
        if (ps.length === 3) {
          return ps[2] + "/" + ps[1] + "/" + ps[0].slice(2);
        }
        return new Date(iso).toLocaleDateString("es-AR");
      } catch (e) { return ""; }
    }

    var sub = "";
    var fechaShow = "";
    var prefix = "";
    if (stageNum === 0) {
      fechaShow = fmtDateShort(createdAtIso);
      prefix = "el";
    } else if (stageNum === 1) {
      fechaShow = fmtDateShort(fechaIso);
      prefix = "para";
    } else if (stageNum === 2) {
      fechaShow = fmtDateShort(fechaIso);
      prefix = "el";
    }
    if (fechaShow) {
      sub =
        '<div class="notif-stage-sub">' +
        prefix + " " + escapeHtml(fechaShow) + "</div>";
    }

    return (
      '<div class="notif-stage-wrap">' +
      '<div class="o-stepper">' + parts.join("") + "</div>" +
      '<div class="notif-stage-label o-stage-' + stageNum + '">' +
      labels[stageNum] + "</div>" + sub + "</div>"
    );
  }

  var rowsHtml = slice
    .map(function (o, idx) {
      var c = customerById[o.customer_id] || {};
      var nombre = String(c.business_name || "Cliente").trim();
      var cod = String(c.cod_cliente || "").trim();
      var orderNum = String(o.id || "").trim();
      var fechaShort = o.created_at
        ? new Date(o.created_at).toLocaleDateString("es-AR", {
            day: "2-digit",
            month: "2-digit",
          })
        : "";
      var unread = !readSet.has(String(o.id));
      var stage = stageByOrder[o.id];
      var fechaEntrega = fechaByOrder[o.id];

      var posCls =
        (idx === 0 ? " first-row" : "") +
        (idx === slice.length - 1 ? " last-row" : "");

      return (
        '<div class="notif-row' + posCls + (unread ? " unread" : "") +
        '" data-order-id="' + escapeAttr(orderNum) +
        '" data-customer-id="' + escapeAttr(o.customer_id || "") + '">' +
        '<div class="notif-spine">' +
        '<div class="notif-line"></div>' +
        '<div class="notif-dot' + (unread ? " unread" : "") + '"></div>' +
        "</div>" +
        '<div class="notif-cell notif-cell-client">' +
        '<button type="button" class="notif-client-link js-vnotif-detail" data-order-id="' +
        escapeAttr(orderNum) + '" title="Ver detalle del pedido">' +
        escapeHtml(nombre) +
        (cod ? ' <span class="notif-cod">(' + escapeHtml(cod) + ")</span>" : "") +
        "</button>" +
        "</div>" +
        '<div class="notif-cell notif-cell-date">' +
        escapeHtml(fechaShort || "—") + "</div>" +
        '<div class="notif-cell notif-cell-action">' +
        '<button type="button" class="profile-btn notif-row-btn js-vnotif-download" data-order-id="' +
        escapeAttr(orderNum) + '">Descargar</button>' +
        "</div>" +
        '<div class="notif-cell notif-cell-stage">' +
        renderNotifStepper(stage, fechaEntrega, o.created_at) +
        "</div>" +
        '<div class="notif-cell notif-cell-action">' +
        '<button type="button" class="profile-btn notif-row-btn notif-suggest-btn js-vnotif-suggest" data-customer-id="' +
        escapeAttr(o.customer_id || "") +
        '" data-order-id="' + escapeAttr(orderNum) + '">Ver sugeridos</button>' +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  var html =
    '<div class="notif-timeline">' +
    '<div class="notif-thead">' +
    "<div></div>" +
    "<div>Cliente</div>" +
    "<div>Pedido</div>" +
    "<div>Ver Detalle</div>" +
    "<div>Estado de pedido</div>" +
    "<div>Sugerir</div>" +
    "</div>" + rowsHtml + "</div>";

  box.innerHTML = html;

  if (btnToggle) {
    if (orders.length > VENDOR_NOTIF_LIMIT_INITIAL) {
      btnToggle.hidden = false;
      btnToggle.textContent = showAll ? "Ver Menos" : "Ver Más";
    } else {
      btnToggle.hidden = true;
    }
    btnToggle.onclick = function (e) {
      e.preventDefault();
      _vendorNotifsState.showAll = !_vendorNotifsState.showAll;
      renderVendorNotifications();
    };
  }
  if (btnMarkAll) {
    btnMarkAll.hidden = unreadCount === 0;
    btnMarkAll.onclick = function (e) {
      e.preventDefault();
      markAllVendorNotifsRead();
      renderVendorNotifications();
    };
  }

  if (typeof updateMenuNotifBadge === "function") updateMenuNotifBadge();

  box.querySelectorAll(".js-vnotif-detail").forEach(function (b) {
    b.addEventListener("click", function () {
      openVendorOrderDetail(b.getAttribute("data-order-id"));
    });
  });
  box.querySelectorAll(".js-vnotif-suggest").forEach(function (b) {
    b.addEventListener("click", function () {
      openVendorSuggestions(
        b.getAttribute("data-customer-id"),
        b.getAttribute("data-order-id"),
      );
    });
  });
  box.querySelectorAll(".js-vnotif-download").forEach(function (b) {
    b.addEventListener("click", async function () {
      var orderId = b.getAttribute("data-order-id");
      if (!orderId) return;
      markVendorNotifRead(orderId);
      renderVendorNotifications();
      var oldText = b.textContent;
      b.disabled = true;
      b.textContent = "Generando…";
      try {
        await descargarComprobantePedido(orderId);
      } catch (e) {
        console.error("descargar pedido (notif) error:", e);
      } finally {
        b.disabled = false;
        b.textContent = oldText;
      }
    });
  });
}

/***********************
 * MENU DROPDOWN: visibilidad notif/menú
 ***********************/
function updateMenuNotifVisibility() {
  var notifEntries = [
    document.getElementById("menuNotifications"),
    document.getElementById("menuNotificationsMobile"),
  ];
  var showNotif = isVendorOwnMode();
  notifEntries.forEach(function (el) {
    if (el) el.style.display = showNotif ? "" : "none";
  });
  if (showNotif) updateMenuNotifBadge();

  var notifCard = document.getElementById("vendorNotifsCard");
  if (notifCard) notifCard.hidden = !showNotif;

  var hideClientItems = isVendorOwnMode();
  var clientItems = [
    document.getElementById("menuHistorial"),
    document.getElementById("menuHistorialMobile"),
    document.getElementById("menuSugerencias"),
    document.getElementById("menuSugerenciasMobile"),
    document.getElementById("profileCardHistorial"),
    document.getElementById("profileCardSugerencias"),
    document.getElementById("profileCardOrdersWeb"),
    document.getElementById("profileCardSucursales"),
  ];
  clientItems.forEach(function (el) {
    if (el) el.style.display = hideClientItems ? "none" : "";
  });
}

function updateMenuNotifBadge() {
  var badges = [
    document.getElementById("menuNotifBadge"),
    document.getElementById("menuNotifBadgeMobile"),
  ];
  var orders = _vendorNotifsState.orders || [];
  var readSet = getVendorNotifReadSet();
  var unread = orders.filter(function (o) {
    return !readSet.has(String(o.id));
  }).length;
  badges.forEach(function (b) {
    if (!b) return;
    if (unread > 0) {
      b.hidden = false;
      b.textContent = unread > 99 ? "99+" : String(unread);
    } else {
      b.hidden = true;
    }
  });
}

async function openNotificationsFromMenu() {
  if (!currentSession) {
    if (typeof openLogin === "function") openLogin();
    return;
  }
  if (typeof closeUserMenu === "function") closeUserMenu();
  showSection("perfil");
  if (typeof fillProfileSummaryUI === "function") fillProfileSummaryUI();
  loadMyOrdersUI();
  loadMyAddressesUI();
  if (typeof loadDraftCarts === "function") loadDraftCarts();
  await loadVendorNotificationsUI();
  setTimeout(function () {
    var el = document.getElementById("vendorNotifsCard");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);
}

window.openNotificationsFromMenu = openNotificationsFromMenu;
window.updateMenuNotifVisibility = updateMenuNotifVisibility;
window.updateMenuNotifBadge = updateMenuNotifBadge;

/***********************
 * MODAL: detalle del pedido (vendedor)
 ***********************/
async function openVendorOrderDetail(orderId) {
  var modal = document.getElementById("vendorOrderDetailModal");
  var body = document.getElementById("vendorOrderDetailBody");
  var titleEl = document.getElementById("vendorOrderDetailTitle");
  if (!modal || !body) return;

  if (orderId) {
    markVendorNotifRead(orderId);
    renderVendorNotifications();
  }

  modal.classList.remove("hidden");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  body.textContent = "Cargando…";

  try {
    var orderRes = await supabaseClient
      .from("orders")
      .select(
        "id, created_at, total, subtotal, status, payment_method, customer_id",
      )
      .eq("id", orderId)
      .maybeSingle();
    if (orderRes.error) throw orderRes.error;
    var order = orderRes.data || {};

    var custInfo = _vendorNotifsState.customerById[order.customer_id] || {};
    if (titleEl) {
      var orderIdStr = String(orderId || "");
      var orderShown = orderIdStr.length > 8 ? orderIdStr.slice(0, 8) : orderIdStr;
      titleEl.textContent = "Detalle Pedido " + orderShown;
    }

    var itemsRes = await supabaseClient
      .from("order_items")
      .select("product_id, cajas, uxb")
      .eq("order_id", orderId);
    if (itemsRes.error) throw itemsRes.error;
    var items = itemsRes.data || [];

    var byPid = {};
    products.forEach(function (p) {
      byPid[String(p.id)] = p;
    });

    var totalFmt = Math.round(Number(order.total || 0)).toLocaleString("es-AR");
    var fechaStr = order.created_at
      ? new Date(order.created_at).toLocaleString("es-AR")
      : "";

    var rowsHtml = items.length
      ? items
          .map(function (it) {
            var prod = byPid[String(it.product_id)] || {};
            var cod = prod.cod || "";
            var desc = prod.description || "";
            var uxb = Number(it.uxb || prod.uxb || 0);
            var cajas = Number(it.cajas || 0);
            var unidades = uxb * cajas;
            var listUnit = Number(prod.list_price || prod.price_cash || 0);
            var sub = listUnit * unidades;
            return (
              "<tr>" +
              "<td>" + escapeHtml(cod) + "</td>" +
              '<td class="vd-desc">' + escapeHtml(desc) + "</td>" +
              '<td class="vd-num">' + cajas + "</td>" +
              '<td class="vd-num">' + unidades + "</td>" +
              '<td class="vd-num">$' + Math.round(listUnit).toLocaleString("es-AR") + "</td>" +
              '<td class="vd-num">$' + Math.round(sub).toLocaleString("es-AR") + "</td>" +
              "</tr>"
            );
          })
          .join("")
      : '<tr><td colspan="6" class="vd-empty">Sin ítems registrados.</td></tr>';

    body.innerHTML =
      '<div class="vd-total-banner">' +
      '<span class="vd-total-label">Total del pedido</span>' +
      '<span class="vd-total-amount">$' + totalFmt + "</span>" +
      "</div>" +
      '<div class="vd-header">' +
      "<div><b>Cliente:</b> " + escapeHtml(custInfo.business_name || "—") +
      " (" + escapeHtml(custInfo.cod_cliente || "") + ")</div>" +
      "<div><b>Fecha:</b> " + escapeHtml(fechaStr) + "</div>" +
      "<div><b>Estado:</b> " + escapeHtml(order.status || "—") + "</div>" +
      "<div><b>Pago:</b> " + escapeHtml(order.payment_method || "—") + "</div>" +
      "</div>" +
      '<div class="vd-table-wrap"><table class="vd-table">' +
      "<thead><tr><th>Cod</th><th>Descripción</th><th>Cajas</th><th>Unid</th><th>P.unit</th><th>Subtotal</th></tr></thead>" +
      "<tbody>" + rowsHtml + "</tbody>" +
      "</table></div>";
  } catch (e) {
    console.error("openVendorOrderDetail error:", e);
    body.textContent = "No se pudo cargar el pedido.";
  }
}

function closeVendorOrderDetail() {
  var modal = document.getElementById("vendorOrderDetailModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

/***********************
 * MODAL: sugerir productos (vendedor)
 ***********************/
async function openVendorSuggestions(customerId, orderId) {
  var modal = document.getElementById("vendorSuggestModal");
  var body = document.getElementById("vendorSuggestBody");
  var titleEl = document.getElementById("vendorSuggestTitle");
  if (!modal || !body) return;

  if (orderId) {
    markVendorNotifRead(orderId);
    renderVendorNotifications();
  }

  modal.classList.remove("hidden");
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  body.textContent = "Buscando sugerencias…";

  try {
    var custInfo = _vendorNotifsState.customerById[customerId] || {};
    var codCliente = custInfo.cod_cliente || "";
    if (titleEl) {
      titleEl.textContent =
        "Sugerir productos" +
        (custInfo.business_name ? " · " + custInfo.business_name : "");
    }

    if (!codCliente) {
      body.textContent = "Falta cod_cliente para este cliente.";
      return;
    }

    var sugRes = await supabaseClient.rpc("sugerencias_cliente", {
      p_customer: String(codCliente),
    });
    if (sugRes.error) {
      console.error("sugerencias_cliente error:", sugRes.error);
      body.textContent =
        "Error cargando sugerencias IA: " + (sugRes.error.message || "");
      return;
    }
    var sugRows = sugRes.data || [];

    function pickField(o, keys, fallback) {
      for (var i = 0; i < keys.length; i++) {
        var v = o[keys[i]];
        if (v !== undefined && v !== null && v !== "") return v;
      }
      return fallback === undefined ? "" : fallback;
    }

    function prodCardHtml(p, tag) {
      var pid = String(pickField(p, ["product_id", "id", "productId"], ""));
      var cod = String(pickField(p, ["cod", "codigo", "item_code"], ""));
      var desc = String(pickField(p, ["description", "descripcion", "articulo"], ""));
      var uxb = Number(pickField(p, ["uxb"], 0));
      var listPrice = Number(pickField(p, ["list_price", "price_cash", "precio"], 0));
      var motivo = String(pickField(p, ["texto_clientes", "mensaje", "texto"], ""));
      var codSafe = encodeURIComponent(cod);
      var img = cod
        ? BASE_IMG + codSafe + ".jpg?v=" + encodeURIComponent(IMG_VERSION)
        : "img/no-image.webp";
      var priceFmt = Math.round(listPrice).toLocaleString("es-AR");
      return (
        '<div class="vs-card">' +
        '<img class="vs-img" src="' + escapeAttr(img) +
        '" alt="' + escapeAttr(desc) +
        '" loading="lazy" onerror="this.onerror=null;this.src=\'img/no-image.webp\'" />' +
        '<div class="vs-info">' +
        (tag ? '<div class="vs-tag">' + tag + "</div>" : "") +
        '<div class="vs-cod">' + escapeHtml(cod) + "</div>" +
        '<div class="vs-desc">' + escapeHtml(desc) + "</div>" +
        (motivo ? '<div class="vs-motivo">' + escapeHtml(motivo) + "</div>" : "") +
        '<div class="vs-price-block">' +
        '<div class="vs-price">$' + priceFmt + "</div>" +
        '<div class="vs-uxb">UxB: ' + uxb + " · Precio Lista</div>" +
        "</div>" +
        '<div class="vs-action">' +
        '<div class="vs-qty-row">' +
        '<span class="vs-qty-label">Cajas</span>' +
        '<div class="vs-stepper">' +
        '<button type="button" class="vs-step-btn js-vs-dec" data-pid="' + escapeAttr(pid) + '">−</button>' +
        '<input class="vs-step-in" type="number" min="1" value="1" id="vs-qty-' + escapeAttr(pid) + '" />' +
        '<button type="button" class="vs-step-btn js-vs-inc" data-pid="' + escapeAttr(pid) + '">+</button>' +
        "</div>" + "</div>" +
        '<button type="button" class="profile-btn vs-add-btn js-vs-add" data-pid="' +
        escapeAttr(pid) + '" data-cust-id="' + escapeAttr(customerId) +
        '">Agregar al pedido</button>' +
        "</div>" + "</div>" + "</div>"
      );
    }

    var html = "";
    if (sugRows.length) {
      html =
        '<div class="vs-grid">' +
        sugRows
          .map(function (p) { return prodCardHtml(p, ""); })
          .join("") +
        "</div>";
    } else {
      html =
        '<div class="vs-empty">La IA no encontró sugerencias para este cliente.</div>';
    }
    body.innerHTML = html;

    body.querySelectorAll(".js-vs-inc").forEach(function (b) {
      b.addEventListener("click", function () {
        var pid = b.getAttribute("data-pid");
        var inp = document.getElementById("vs-qty-" + pid);
        if (!inp) return;
        inp.value = String(Math.max(1, (parseInt(inp.value, 10) || 1) + 1));
      });
    });
    body.querySelectorAll(".js-vs-dec").forEach(function (b) {
      b.addEventListener("click", function () {
        var pid = b.getAttribute("data-pid");
        var inp = document.getElementById("vs-qty-" + pid);
        if (!inp) return;
        inp.value = String(Math.max(1, (parseInt(inp.value, 10) || 1) - 1));
      });
    });
    body.querySelectorAll(".js-vs-add").forEach(function (b) {
      b.addEventListener("click", async function () {
        var pid = b.getAttribute("data-pid");
        var custId = b.getAttribute("data-cust-id");
        var inp = document.getElementById("vs-qty-" + pid);
        var qty = Math.max(1, parseInt(inp && inp.value, 10) || 1);
        await vendorSuggestAddToCart(pid, qty, custId, b);
      });
    });
  } catch (e) {
    console.error("openVendorSuggestions error:", e);
    body.textContent = "Error cargando sugerencias.";
  }
}

function closeVendorSuggestions() {
  var modal = document.getElementById("vendorSuggestModal");
  if (!modal) return;
  modal.classList.remove("open");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

async function vendorSuggestAddToCart(productId, qty, customerId, btnEl) {
  if (!productId || !customerId) return;
  if (!currentSession) {
    if (typeof openLogin === "function") openLogin();
    return;
  }
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.dataset._old = btnEl.textContent;
    btnEl.textContent = "Agregando…";
  }
  try {
    var needSwitch = !customerProfile || String(customerProfile.id) !== String(customerId);
    if (needSwitch) {
      var sel = document.getElementById("customerSelect");
      var selCart = document.getElementById("customerSelectCart");
      if (sel) sel.value = customerId;
      if (selCart) selCart.value = customerId;
      if (typeof onLinkedCustomerSelected === "function") {
        await onLinkedCustomerSelected();
      }
    }

    var existing = cart.find(function (i) { return i.productId === productId; });
    if (existing) {
      existing.qtyCajas = (Number(existing.qtyCajas) || 0) + qty;
    } else {
      cart.push({ productId: productId, qtyCajas: qty });
    }

    if (typeof updateCart === "function") updateCart();
    if (typeof renderProducts === "function") renderProducts();
    if (typeof scheduleViewOrderToastAfterAdd === "function") {
      scheduleViewOrderToastAfterAdd();
    }

    if (btnEl) {
      btnEl.textContent = "Agregado ✓";
      btnEl.classList.add("vs-added");
      setTimeout(function () {
        btnEl.disabled = false;
        btnEl.textContent = btnEl.dataset._old || "Agregar al pedido";
        btnEl.classList.remove("vs-added");
      }, 1400);
    }
  } catch (e) {
    console.error("vendorSuggestAddToCart error:", e);
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = btnEl.dataset._old || "Agregar al pedido";
      alert("No se pudo agregar al pedido. Probá de nuevo.");
    }
  }
}

window.vendorSuggestAddToCart = vendorSuggestAddToCart;
window.openVendorOrderDetail = openVendorOrderDetail;
window.closeVendorOrderDetail = closeVendorOrderDetail;
window.openVendorSuggestions = openVendorSuggestions;
window.closeVendorSuggestions = closeVendorSuggestions;
window.loadVendorNotificationsUI = loadVendorNotificationsUI;

// Listeners de cierre vendor modals
(function bindVendorNotifModalCloses() {
  function bindOnce() {
    var dBd = document.getElementById("vendorOrderDetailBackdrop");
    var dBtn = document.getElementById("btnCloseVendorOrderDetail");
    var dX = document.getElementById("btnXCloseVendorOrderDetail");
    var sBd = document.getElementById("vendorSuggestBackdrop");
    var sBtn = document.getElementById("btnCloseVendorSuggest");
    var sX = document.getElementById("btnXCloseVendorSuggest");
    if (dBd) dBd.addEventListener("click", closeVendorOrderDetail);
    if (dBtn) dBtn.addEventListener("click", closeVendorOrderDetail);
    if (dX) dX.addEventListener("click", closeVendorOrderDetail);
    if (sBd) sBd.addEventListener("click", closeVendorSuggestions);
    if (sBtn) sBtn.addEventListener("click", closeVendorSuggestions);
    if (sX) sX.addEventListener("click", closeVendorSuggestions);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var dM = document.getElementById("vendorOrderDetailModal");
      var sM = document.getElementById("vendorSuggestModal");
      if (dM && dM.classList.contains("open")) closeVendorOrderDetail();
      if (sM && sM.classList.contains("open")) closeVendorSuggestions();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindOnce);
  } else {
    bindOnce();
  }
})();

/***********************
 * MODAL: Nueva sucursal + Expresos
 ***********************/
function abrirModalSucursal() {
  if (!currentSession || !customerProfile?.id) {
    alert("Iniciá sesión para agregar una sucursal.");
    return;
  }
  [
    "sucCalle",
    "sucAltura",
    "sucCp",
    "sucLocalidad",
    "sucExpreso",
    "sucDireccionExpreso",
    "sucObservaciones",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const dl = document.getElementById("sucExpresoList");
  if (dl) dl.innerHTML = "";
  cargarExpresosCache();
  const prov = document.getElementById("sucProvincia");
  if (prov) prov.value = "";
  const err = document.getElementById("sucError");
  if (err) {
    err.style.display = "none";
    err.textContent = "";
  }
  const btn = document.getElementById("sucGuardarBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Guardar sucursal";
    btn.title = "Completá los campos obligatorios (*)";
  }
  actualizarExpresoSegunCABA();
  validarFormSucursal();
  const modal = document.getElementById("modalNuevaSucursal");
  if (modal) modal.classList.add("open");
}

function validarFormSucursal() {
  const get = (id) =>
    String(document.getElementById(id)?.value || "").trim();
  const calle = get("sucCalle");
  const altura = get("sucAltura");
  const cp = get("sucCp");
  const localidad = get("sucLocalidad");
  const provincia = get("sucProvincia");
  const expreso = get("sucExpreso");

  const esCaba =
    provincia === "CABA" ||
    localidad.toLowerCase() === "caba" ||
    localidad.toLowerCase() === "capital federal" ||
    localidad.toLowerCase() === "capital";

  const star = document.getElementById("sucExpresoStar");
  if (star) star.style.display = esCaba ? "none" : "";

  const okCalle = calle.length >= 2;
  const okAltura = /^\d+$/.test(altura);
  const okCp = /^\d{4,10}$/.test(cp);
  const okLoc = localidad.length >= 2;
  const okProv = provincia.length > 0;
  const okExpreso = esCaba ? true : expreso.length >= 2;

  const valido = okCalle && okAltura && okCp && okLoc && okProv && okExpreso;

  const btn = document.getElementById("sucGuardarBtn");
  if (btn) {
    btn.disabled = !valido;
    btn.title = valido ? "" : "Completá los campos obligatorios (*)";
    btn.style.opacity = valido ? "" : "0.55";
    btn.style.cursor = valido ? "" : "not-allowed";
  }
  return valido;
}

let _expresosCache = null;
let _expresosLoading = null;

async function cargarExpresosCache() {
  if (_expresosCache) return _expresosCache;
  if (_expresosLoading) return _expresosLoading;
  _expresosLoading = (async () => {
    try {
      const { data, error } = await supabaseClient
        .from("expresos")
        .select("razon_social,domicilio,localidad,cp,provincia")
        .order("razon_social", { ascending: true });
      if (error) throw error;
      _expresosCache = data || [];
      return _expresosCache;
    } catch (e) {
      console.warn("cargarExpresosCache error:", e);
      _expresosCache = [];
      return _expresosCache;
    } finally {
      _expresosLoading = null;
    }
  })();
  return _expresosLoading;
}

async function onExpresoInput() {
  const inp = document.getElementById("sucExpreso");
  const dl = document.getElementById("sucExpresoList");
  if (!inp || !dl) return;
  const q = String(inp.value || "").trim().toLowerCase();
  if (q.length < 2) {
    dl.innerHTML = "";
    return;
  }
  const lista = await cargarExpresosCache();
  const matches = lista
    .filter((e) =>
      String(e.razon_social || "").toLowerCase().includes(q),
    )
    .slice(0, 30);
  dl.innerHTML = matches
    .map(
      (e) =>
        `<option value="${String(e.razon_social || "").replace(/"/g, "&quot;")}"></option>`,
    )
    .join("");
  autocompletarDireccionExpreso();
}

function autocompletarDireccionExpreso() {
  const inpExp = document.getElementById("sucExpreso");
  const inpDir = document.getElementById("sucDireccionExpreso");
  if (!inpExp || !inpDir) return;
  const q = String(inpExp.value || "").trim().toLowerCase();
  if (!q || !_expresosCache) return;
  const match = _expresosCache.find(
    (e) => String(e.razon_social || "").toLowerCase() === q,
  );
  if (!match) return;
  const partes = [
    String(match.domicilio || "").trim(),
    String(match.localidad || "").trim(),
    String(match.provincia || "").trim(),
  ].filter(Boolean);
  const direccionSugerida = partes.join(", ");
  const valorActual = String(inpDir.value || "").trim();
  const eraAutogenerada =
    !valorActual ||
    _expresosCache.some((e) => {
      const partsE = [
        String(e.domicilio || "").trim(),
        String(e.localidad || "").trim(),
        String(e.provincia || "").trim(),
      ].filter(Boolean);
      return partsE.join(", ") === valorActual;
    });
  if (eraAutogenerada) {
    inpDir.value = direccionSugerida;
  }
}

function actualizarExpresoSegunCABA() {
  const expEl = document.getElementById("sucExpreso");
  if (!expEl) return;
  const loc = String(
    document.getElementById("sucLocalidad")?.value || "",
  ).trim().toLowerCase();
  const prov = String(
    document.getElementById("sucProvincia")?.value || "",
  ).trim();
  const esCaba =
    prov === "CABA" ||
    loc === "caba" ||
    loc === "capital federal" ||
    loc === "capital";
  const dirEl = document.getElementById("sucDireccionExpreso");
  if (esCaba) {
    expEl.value = "";
    expEl.disabled = true;
    expEl.placeholder = "No aplica para CABA";
    expEl.style.background = "#f0f0f0";
    expEl.style.color = "#999";
    if (dirEl) {
      dirEl.value = "";
      dirEl.disabled = true;
      dirEl.placeholder = "No aplica para CABA";
      dirEl.style.background = "#f0f0f0";
      dirEl.style.color = "#999";
    }
  } else {
    expEl.disabled = false;
    expEl.placeholder = "Empezá a tipear (mín. 2 letras)…";
    expEl.style.background = "";
    expEl.style.color = "";
    if (dirEl) {
      dirEl.disabled = false;
      dirEl.placeholder = "Dirección de retiro del expreso";
      dirEl.style.background = "";
      dirEl.style.color = "";
    }
  }
  if (typeof validarFormSucursal === "function") validarFormSucursal();
}

function cerrarModalSucursal() {
  const modal = document.getElementById("modalNuevaSucursal");
  if (modal) modal.classList.remove("open");
}

async function guardarNuevaSucursal() {
  const errEl = document.getElementById("sucError");
  const btn = document.getElementById("sucGuardarBtn");
  const setError = (msg) => {
    if (errEl) {
      errEl.textContent = msg;
      errEl.style.display = "block";
    }
  };

  if (!currentSession || !customerProfile?.id) {
    setError("Iniciá sesión nuevamente.");
    return;
  }

  const calle = String(document.getElementById("sucCalle")?.value || "").trim();
  const altura = String(document.getElementById("sucAltura")?.value || "").trim();
  const cp = String(document.getElementById("sucCp")?.value || "").trim();
  const localidad = String(document.getElementById("sucLocalidad")?.value || "").trim();
  const provincia = String(document.getElementById("sucProvincia")?.value || "").trim();
  const expreso = String(document.getElementById("sucExpreso")?.value || "").trim();
  const direccionExpreso = String(document.getElementById("sucDireccionExpreso")?.value || "").trim();
  const observaciones = String(document.getElementById("sucObservaciones")?.value || "").trim();

  if (!calle || calle.length < 2) return setError("Completá la calle.");
  if (!altura || !/^\d+$/.test(altura))
    return setError("La altura debe ser numérica.");
  if (!cp || !/^\d{4,10}$/.test(cp))
    return setError("El código postal debe tener al menos 4 dígitos.");
  if (!localidad || localidad.length < 2)
    return setError("Completá la localidad.");
  if (!provincia) return setError("Elegí la provincia.");

  const _locLower = localidad.toLowerCase();
  const esCaba =
    provincia === "CABA" ||
    _locLower === "caba" ||
    _locLower === "capital federal" ||
    _locLower === "capital";
  if (!esCaba && (!expreso || expreso.length < 2)) {
    return setError(
      "Indicá el expreso (obligatorio fuera de CABA). Si no sabés cuál, escribí el nombre o consultanos por WhatsApp.",
    );
  }

  if (errEl) errEl.style.display = "none";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Guardando…";
  }

  try {
    const { data: existing, error: exErr } = await supabaseClient
      .from("customer_delivery_addresses")
      .select("slot")
      .eq("customer_id", customerProfile.id);
    if (exErr) throw new Error(exErr.message || "Error al leer sucursales.");
    const nextSlot =
      (existing || []).reduce(
        (m, d) => Math.max(m, Number(d.slot || 0)),
        0,
      ) + 1;

    const label = `${calle} ${altura} - ${localidad}`;
    const direccionEntrega = `${calle} ${altura}, ${localidad}, ${provincia}`;

    const payload = {
      customer_id: customerProfile.id,
      slot: nextSlot,
      label: label,
      direccion_entrega: direccionEntrega,
      zona_expreso: expreso || null,
      nombre_expreso: expreso || null,
      direccion_expreso: direccionExpreso || null,
      calle: calle,
      altura: altura,
      cp: cp,
      localidad: localidad,
      provincia: provincia,
      observaciones: observaciones || null,
      pending_isis: true,
    };

    const ins = await supabaseClient
      .from("customer_delivery_addresses")
      .insert(payload)
      .select("slot")
      .single();
    if (ins.error)
      throw new Error(ins.error.message || "Error al guardar la sucursal.");

    const newSlot = ins.data?.slot ?? nextSlot;

    try {
      await fetch(NOTIFY_NEW_ADDRESS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentSession.access_token}`,
        },
        body: JSON.stringify({
          customer_id: customerProfile.id,
          slot: newSlot,
        }),
      });
    } catch (e) {
      console.warn("notify-new-address fallo (no bloquea):", e);
    }

    if (typeof loadDeliveryOptions === "function") await loadDeliveryOptions();
    const sel = $("shippingSelect");
    if (sel && newSlot != null) {
      sel.value = String(newSlot);
      if (typeof _csRefreshWrappedSelect === "function") {
        _csRefreshWrappedSelect(sel, "Elegir Sucursal");
      }
      const opt = sel.options[sel.selectedIndex];
      deliveryChoice = {
        slot: String(newSlot),
        label: opt?.dataset.label || label,
        direccionEntrega: opt?.dataset.direccionEntrega || direccionEntrega,
        zonaExpreso: opt?.dataset.zonaExpreso || expreso,
      };
      if (typeof refreshSubmitEnabled === "function") refreshSubmitEnabled();
    }

    cerrarModalSucursal();
    alert("Sucursal agregada. Queda pendiente de confirmación.");
  } catch (e) {
    console.error("guardarNuevaSucursal error:", e);
    setError("Error: " + (e.message || e));
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Guardar sucursal";
    }
  }
}

window.abrirModalSucursal = abrirModalSucursal;
window.cerrarModalSucursal = cerrarModalSucursal;
window.guardarNuevaSucursal = guardarNuevaSucursal;
window.validarFormSucursal = validarFormSucursal;
window.onExpresoInput = onExpresoInput;
window.autocompletarDireccionExpreso = autocompletarDireccionExpreso;
window.actualizarExpresoSegunCABA = actualizarExpresoSegunCABA;

/***********************
 * MISSING ASSORTMENT MODULE
 * (productos del surtido habitual del cliente que NO están en el carrito)
 ***********************/
function getMissingAssortmentProducts(maxItems) {
  if (!(myAssortmentIds instanceof Set) || myAssortmentIds.size === 0)
    return [];

  var cartIds = new Set(
    cart.map(function (i) { return String(i.productId); }),
  );

  var missing = products.filter(function (p) {
    var pid = String(p.id);
    return myAssortmentIds.has(pid) && !cartIds.has(pid);
  });

  missing.sort(function (a, b) {
    var ra = a.ranking != null ? Number(a.ranking) : Infinity;
    var rb = b.ranking != null ? Number(b.ranking) : Infinity;
    return ra - rb;
  });

  if (maxItems && Number(maxItems) > 0)
    return missing.slice(0, Number(maxItems));
  return missing;
}

var _missingModuleAllPids = null;
var _missingModuleOffset = 0;
var _missingModuleTotal = 0;
var MISSING_MODULE_DISPLAY = 6;

function renderMissingAssortmentModule() {
  var container = document.getElementById("missingAssortmentModule");
  if (!container) return;

  if (!currentSession || !customerProfile) {
    container.innerHTML = "";
    container.style.display = "none";
    _missingModuleAllPids = null;
    _missingModuleOffset = 0;
    return;
  }

  // Recompute SIEMPRE — así si el cliente agrega/quita un item del carrito,
  // el módulo lo refleja al instante (no se queda con la lista cacheada).
  // Performance OK: filtro simple sobre ~1000 productos.
  var fresh = getMissingAssortmentProducts();
  _missingModuleTotal = fresh.length;
  _missingModuleAllPids = fresh.map(function (p) { return String(p.id); });
  // Mantener offset si está dentro del rango, sino reset
  if (_missingModuleOffset >= _missingModuleAllPids.length) {
    _missingModuleOffset = 0;
  }

  // Mostrar TODOS los productos faltantes — el grid hace scroll vertical
  // (max-height + overflow-y en .missing-cards). El offset queda como
  // punto de partida del orden para mantener compat con Refrescar.
  var total = _missingModuleAllPids.length;
  var displayPids = [];
  if (total > 0) {
    var off = _missingModuleOffset % total;
    for (var i = 0; i < total; i++) {
      displayPids.push(_missingModuleAllPids[(off + i) % total]);
    }
  }

  var byId = new Map(
    products.map(function (p) { return [String(p.id), p]; }),
  );
  var items = displayPids
    .map(function (pid) { return byId.get(pid); })
    .filter(Boolean);

  if (!items.length) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }

  var showTuPrecio = !isAdmin && !isListPriceOnlyClient();
  var cartQtyById = new Map(
    cart.map(function (i) { return [String(i.productId), Number(i.qtyCajas || 0)]; }),
  );

  var cardsHtml = items
    .map(function (p) {
      var pid = String(p.id);
      var codSafe = String(p.cod || "").trim();
      var imgSrc = BASE_IMG + encodeURIComponent(codSafe) + ".jpg?v=" + encodeURIComponent(IMG_VERSION);
      var tuPrecio = showTuPrecio
        ? unitYourPrice(p.list_price)
        : Number(p.list_price || 0);
      var qty = cartQtyById.get(pid) || 0;

      return (
        '<div class="missing-card' + (qty > 0 ? " has-qty" : "") +
        '" data-pid="' + pid + '">' +
        '<img src="' + imgSrc +
        '" width="120" height="120" loading="lazy" onerror="this.src=\'img/no-image.webp\'" alt="' + escapeAttr(codSafe) + '">' +
        '<div class="missing-card-info">' +
        '<div class="missing-desc" title="' +
        String(p.description || "").replace(/"/g, "&quot;") + '">' +
        escapeHtml(p.description || "") + "</div>" +
        '<div class="missing-price-row">' +
        '<span class="missing-cod">' + escapeHtml(codSafe) + '</span>' +
        '<span class="missing-price-label">Tu precio contado:</span>' +
        '<span class="missing-price">$' + formatMoney(tuPrecio) + '</span>' +
        '<span class="missing-price-note">+ IVA</span>' +
        '</div>' +
        "</div>" +
        '<div class="missing-stepper">' +
        '<button type="button" class="missing-step-btn" onclick="missingStep(\'' + pid + '\', -1)" aria-label="Restar">−</button>' +
        '<span class="missing-qty" id="missingQty-' + pid + '">' + qty + "</span>" +
        '<button type="button" class="missing-step-btn" onclick="missingStep(\'' + pid + '\', 1)" aria-label="Sumar">+</button>' +
        "</div>" +
        "</div>"
      );
    })
    .join("");

  container.style.display = "";
  var totalFmt = _missingModuleTotal || items.length;
  container.innerHTML =
    '<div class="missing-header">' +
    '<div class="missing-header-left">' +
    '<div class="missing-title">¿Seguro que no necesitás esto de tu surtido?</div>' +
    '<div class="missing-subtitle">Productos de tu surtido habitual que no estás llevando (' +
    totalFmt + ").</div>" +
    "</div>" +
    "</div>" +
    '<div class="missing-cards">' +
    cardsHtml +
    "</div>";
}

function rotateMissingModule() {
  if (!_missingModuleAllPids || _missingModuleAllPids.length === 0) return;
  _missingModuleOffset =
    (_missingModuleOffset + MISSING_MODULE_DISPLAY) %
    _missingModuleAllPids.length;
  renderMissingAssortmentModule();
}

function missingStep(pid, delta) {
  var inCart = cart.find(function (i) {
    return String(i.productId) === String(pid);
  });
  if (!inCart) {
    if (delta > 0 && typeof addFirstBox === "function") addFirstBox(pid);
    return;
  }
  if (typeof changeQty === "function") changeQty(pid, delta);
}

window.missingStep = missingStep;
window.rotateMissingModule = rotateMissingModule;
window.renderMissingAssortmentModule = renderMissingAssortmentModule;

/* ============================================================
   PRODUCT SKELETONS — placeholders animados (shimmer) mientras
   se cargan los productos por primera vez.
   ============================================================ */
function renderProductSkeletons(count) {
  var container = document.getElementById("productsContainer");
  if (!container) return;
  count = Number(count || 8);
  var cards = [];
  for (var i = 0; i < count; i++) {
    cards.push(
      '<div class="lk-skeleton-card">' +
        '<div class="lk-skeleton-img"></div>' +
        '<div class="lk-skeleton-line short"></div>' +
        '<div class="lk-skeleton-line long"></div>' +
        '<div class="lk-skeleton-line medium"></div>' +
        '<div class="lk-skeleton-line short"></div>' +
        '<div class="lk-skeleton-btn"></div>' +
      '</div>'
    );
  }
  container.innerHTML = '<div class="lk-skeleton-grid">' + cards.join("") + "</div>";
}
window.renderProductSkeletons = renderProductSkeletons;

/* ============================================================
   NOVEDADES: wire global del botón "Mostrar novedades"
   El wire dentro de _ncWireControls no corre cuando el carrusel
   está oculto (renderNewProductsCarousel sale temprano), así que
   lo conectamos acá a nivel global con event delegation o directo.
   ============================================================ */
(function setupNcShowBtnGlobal() {
  function wire() {
    var showBtn = document.getElementById("ncShowBtn");
    if (!showBtn || showBtn.__wiredGlobal) return;
    showBtn.__wiredGlobal = true;
    showBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (typeof _ncShowByUser === "function") _ncShowByUser();
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();

/* ============================================================
   STICKY HEADER SHRINK — body.is-scrolled cuando scrollY > 80
   El CSS condiciona height/padding del header + logo via la
   class .is-scrolled en body para animar el achique.
   ============================================================ */
(function setupHeaderShrink() {
  var body = document.body;
  if (!body) return;
  var ticking = false;
  function update() {
    var y = window.pageYOffset || document.documentElement.scrollTop;
    body.classList.toggle("is-scrolled", y > 80);
    ticking = false;
  }
  window.addEventListener("scroll", function () {
    if (!ticking) {
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
  update();
})();

/* ============================================================
   BOTÓN "VOLVER ARRIBA" — aparece al scrollear > 400px, scroll
   smooth al hacer click.
   ============================================================ */
(function setupBackToTopBtn() {
  var btn = document.getElementById("backToTopBtn");
  if (!btn) return;
  var THRESHOLD = 400;
  var ticking = false;
  function update() {
    var y = window.pageYOffset || document.documentElement.scrollTop;
    btn.classList.toggle("visible", y > THRESHOLD);
    ticking = false;
  }
  window.addEventListener(
    "scroll",
    function () {
      if (!ticking) {
        requestAnimationFrame(update);
        ticking = true;
      }
    },
    { passive: true },
  );
  btn.addEventListener("click", function () {
    try {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      window.scrollTo(0, 0);
    }
  });
  update();
})();
