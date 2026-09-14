#!/usr/bin/env node
/**
 * tests/retiro.cjs — que la opción "Retira" (día + franja) esté entera.
 *
 * Portada de pagina-lk-copia el 2026-09-14. Son varias piezas sueltas —CSS,
 * HTML, funciones, tres enganches y el payload— y si falta una el síntoma es
 * silencioso: o el bloque no aparece nunca, o aparece y el dato no se guarda.
 *
 * Además cubre la trampa que en LK costó 6 pedidos perdidos entre el 11 y el
 * 14/09: el payload leía `retiroSel` de OTRA función y saltaba un
 * ReferenceError justo después de grabar el pedido. Acá se exige que la
 * variable se declare en la misma función que arma el payload.
 *
 * Correr:  node tests/retiro.cjs
 */
const fs = require("fs");
const path = require("path");

const raiz = path.join(__dirname, "..");
const js = fs.readFileSync(path.join(raiz, "script.js"), "utf8");
const html = fs.readFileSync(path.join(raiz, "mayorista.html"), "utf8");
const css = fs.readFileSync(path.join(raiz, "css", "styles.css"), "utf8");

const fallas = [];
const exigir = (cond, msg) => { if (!cond) fallas.push(msg); };

// --- Las piezas ---
exigir(/id="retiroBlock"/.test(html), "falta el bloque #retiroBlock en mayorista.html");
exigir(/id="retiroFecha"/.test(html), "falta el input de fecha #retiroFecha");
exigir(
  (html.match(/name="retiroFranja"/g) || []).length === 2,
  "tienen que ser exactamente 2 franjas horarias",
);
exigir(/\.retiro-block\s*\{/.test(css), "falta el CSS .retiro-block");

for (const fn of ["_esRetira", "_retiroSeleccion", "_retiroFechaValida",
                  "_syncRetiroUI", "_resetRetiro", "loadFeriados", "_sumarHabiles"]) {
  exigir(new RegExp("function " + fn + "\\b").test(js), "falta la función " + fn);
}

// --- Los enganches: sin estos la UI existe pero no hace nada ---
exigir(/loadFeriados\(\)\.then/.test(js),
  "los feriados no se cargan al iniciar la página");
exigir(/zonaExpreso = opt\?\.dataset\?\.zonaExpreso[\s\S]{0,400}?_syncRetiroUI\(\)/.test(js),
  "cambiar de sucursal no muestra ni oculta el bloque de retiro");
exigir(/mustChooseRetiro/.test(js) && /!mustChooseRetiro/.test(js),
  "se puede confirmar el pedido sin elegir día ni franja");
exigir(/cart\.length = 0;[\s\S]{0,300}?_resetRetiro\(\)/.test(js),
  "el día y la franja no se limpian después de confirmar el pedido");

// --- El payload, y la trampa de la variable prestada ---
const iniFn = js.indexOf("async function submitOrder(");
exigir(iniFn > 0, "no se encontró submitOrder");
if (iniFn > 0) {
  const resto = js.slice(iniFn + 1);
  const fin = resto.search(/\n(?:async )?function [A-Za-z_$]/);
  const cuerpo = resto.slice(0, fin < 0 ? undefined : fin);

  exigir(/retiro_fecha:\s*_retiroSel\.fecha/.test(cuerpo) &&
         /retiro_franja:\s*_retiroSel\.franja/.test(cuerpo),
    "el payload no lleva retiro_fecha / retiro_franja");
  exigir(/\b(?:var|let|const)\s+_retiroSel\b/.test(cuerpo),
    "_retiroSel NO está declarada dentro de submitOrder: si se toma de otra " +
    "función salta un ReferenceError DESPUÉS de grabar el pedido y queda sin ficha " +
    "(es lo que le pasó a LK del 11/09 al 14/09)");
}

if (fallas.length) {
  console.error("FALLA — la opción Retira está incompleta:");
  fallas.forEach((f) => console.error("  · " + f));
  process.exit(1);
}
console.log("retiro: OK — bloque, CSS, 7 funciones, 4 enganches y el payload, todo en su lugar.");
