// Chef SRL — versión del sitio.
// Para actualizar en todos los footers, cambiar SOLO la línea de abajo
// y bumpear el `?v=` del <script src="./version.js?v=N"> en las HTML
// para invalidar el cache del navegador.
const APP_VERSION = "2.0.16";

document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll("[data-app-version]").forEach(function (el) {
    el.textContent = "v" + APP_VERSION;
  });
});
