document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("btnMayorista");
  if (!btn) return;

  // Ir directo a la tienda (sin pantalla "en desarrollo")
  btn.addEventListener("click", () => {
    window.location.href = "mayorista.html";
  });
});

function initClientesBounce() {
  const wrap = document.getElementById("clientesBounce");
  const track = document.getElementById("clientesTrack");
  if (!wrap || !track) return; 

  const computeShift = () => {
    const wrapW = wrap.clientWidth;
    const trackW = track.scrollWidth;

    // cuánto puede moverse sin “vaciar” el carrusel
    const shift = Math.max(0, trackW - wrapW);

    // setea variable CSS para el keyframe
    track.style.setProperty("--clientes-shift", `${shift}px`);

    // si no hay nada que mover, frenamos animación
    track.style.animationPlayState = shift === 0 ? "paused" : "running";
  };

  // esperar a que carguen las imágenes (si no, el ancho da mal)
  const imgs = Array.from(track.querySelectorAll("img"));
  let pending = imgs.length;

  if (pending === 0) {
    computeShift();
    return;
  }

  const done = () => {
    pending--;
    if (pending <= 0) computeShift();
  };

  imgs.forEach(img => {
    if (img.complete) return done();
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
  });

  window.addEventListener("resize", () => {
    // micro-debounce
    clearTimeout(window.__clientesResizeT);
    window.__clientesResizeT = setTimeout(computeShift, 120);
  });
}

document.addEventListener("DOMContentLoaded", initClientesBounce);


function initLegalModals() {
  const modal = document.getElementById("legalModal");
  if (!modal) return;

  const titleEl = document.getElementById("legalTitle");
  const contentEl = document.getElementById("legalContent");
  const closeBtn = modal.querySelector(".modal-close");

  // ✅ Contenido (podés pegar tus textos largos acá)
  const CONTENT = {
    privacy: {
      title: "Política de Privacidad",
      html: `<h4>1. IDENTIFICACIÓN DEL RESPONSABLE</h4>
      <p><strong>CHEF SRL</strong><br>
      Correo electrónico: <a href="mailto:ventas@chefsrl.com">ventas@chefsrl.com</a><br>
      Teléfono: <a href="tel:+5491131181021">+54 9 11 3118 1021</a><br>
      Sitio web: <a href="https://chefsrl.com" target="_blank" rel="noopener">https://chefsrl.com</a></p>
      <p>En cumplimiento de la Ley 25.326 de Protección de Datos Personales de la República Argentina, se informa a los usuarios la presente Política de Privacidad.</p>

      <hr>

      <h4>2. DATOS PERSONALES RECOPILADOS</h4>
      <p>A través del sitio web y la sección mayorista se podrán recopilar los siguientes datos:</p>
      <ul>
        <li>Nombre y apellido</li>
        <li>Razón social</li>
        <li>CUIT</li>
        <li>Teléfono</li>
        <li>Correo electrónico</li>
        <li>Dirección comercial y/o de entrega</li>
        <li>Historial de pedidos</li>
        <li>Datos de autenticación (usuario y contraseña encriptada)</li>
        <li>Datos técnicos de navegación (IP, cookies, dispositivo, navegador)</li>
      </ul>

      <hr>

      <h4>3. FINALIDAD DEL TRATAMIENTO</h4>
      <p>Los datos serán utilizados exclusivamente para:</p>
      <ul>
        <li>Validación y registro de clientes mayoristas</li>
        <li>Autenticación de usuarios</li>
        <li>Visualización personalizada de precios</li>
        <li>Gestión de carrito y pedidos electrónicos</li>
        <li>Facturación y logística</li>
        <li>Atención postventa</li>
        <li>Cumplimiento de obligaciones legales y fiscales</li>
        <li>Mejora del funcionamiento del sitio</li>
      </ul>
      <p><strong>CHEF SRL</strong> no comercializa ni cede datos personales a terceros con fines publicitarios.</p>

      <hr>

      <h4>4. CUENTAS DE USUARIO</h4>
      <p>El acceso a la sección mayorista requiere autenticación mediante CUIT y contraseña. El usuario es responsable de:</p>
      <ul>
        <li>Mantener la confidencialidad de su contraseña</li>
        <li>No compartir credenciales</li>
        <li>Informar cualquier uso no autorizado</li>
      </ul>
      <p>Las contraseñas se almacenan mediante mecanismos de encriptación y no son accesibles en texto plano.</p>

      <hr>

      <h4>5. MODIFICACIÓN DE CONTRASEÑA</h4>
      <p>El usuario podrá modificar su contraseña desde su perfil personal.</p>

      <hr>

      <h4>6. CONFIDENCIALIDAD DE PRECIOS</h4>
      <p>Los precios mayoristas visibles en el área privada constituyen información comercial confidencial.
      El usuario se compromete a no difundir dicha información sin autorización expresa de <strong>CHEF SRL</strong>.</p>

      <hr>

      <h4>7. BASE DE DATOS Y SEGURIDAD INFORMÁTICA</h4>
      <p>Los datos personales se almacenan en bases de datos protegidas mediante mecanismos de autenticación, encriptación y control de acceso.</p>
      <p><strong>CHEF SRL</strong> implementa políticas de restricción de acceso a nivel de base de datos (Row Level Security), garantizando que cada usuario solo pueda acceder a la información asociada a su cuenta.</p>
      <p>Se aplican medidas técnicas razonables para prevenir accesos no autorizados, pérdida o alteración de información.</p>

      <hr>

      <h4>8. DERECHOS DEL TITULAR DE LOS DATOS</h4>
      <p>El usuario podrá ejercer los derechos de:</p>
      <ul>
        <li>Acceso</li>
        <li>Rectificación</li>
        <li>Actualización</li>
        <li>Supresión</li>
      </ul>
      <p>mediante solicitud enviada a <a href="mailto:ventas@chefsrl.com">ventas@chefsrl.com</a>.</p>
      <p>La Agencia de Acceso a la Información Pública es el órgano de control en Argentina.</p>

      <hr>

      <h4>9. MODIFICACIONES</h4>
      <p><strong>CHEF SRL</strong> podrá modificar la presente política en cualquier momento, publicando la versión actualizada en el sitio web.</p>`
    },
    terms: {
      title: "Términos y Condiciones",
      html: `<p> Última actualización: <em>20/02/2026</em></p>

      <hr>

      <h4>1. ACEPTACIÓN</h4>
      <p>El acceso y uso del sitio web implica la aceptación plena de los presentes Términos y Condiciones.</p>

      <hr>

      <h4>2. CARÁCTER DEL SITIO</h4>
      <p>El sitio tiene carácter institucional y comercial B2B (mayorista). Permite:</p>
      <ul>
        <li>Visualización de productos</li>
        <li>Acceso a precios mediante autenticación</li>
        <li>Gestión de carrito</li>
        <li>Generación de pedidos electrónicos</li>
      </ul>
      <p>No constituye una plataforma de pago automático salvo que se indique expresamente.</p>

      <hr>

      <h4>3. ACCESO MAYORISTA</h4>
      <p>Solo usuarios registrados y autorizados podrán:</p>
      <ul>
        <li>Visualizar precios</li>
        <li>Agregar productos al carrito</li>
        <li>Generar pedidos</li>
      </ul>
      <p><strong>CHEF SRL</strong> se reserva el derecho de aprobar o rechazar solicitudes de registro.</p>

      <hr>

      <h4>4. PEDIDOS ELECTRÓNICOS</h4>
      <p>El carrito constituye una solicitud de pedido y no implica aceptación automática. Todo pedido queda sujeto a:</p>
      <ul>
        <li>Verificación comercial</li>
        <li>Disponibilidad de stock</li>
        <li>Condiciones de pago vigentes</li>
      </ul>
      <p>La empresa podrá modificar o cancelar pedidos ante errores evidentes de carga o inconsistencias.</p>

      <hr>

      <h4>5. CONFIDENCIALIDAD COMERCIAL</h4>
      <p>Los precios, condiciones y descuentos visibles en el área privada son información confidencial.
      La difusión no autorizada podrá generar la suspensión o cancelación de la cuenta.</p>

      <hr>

      <h4>6. RESPONSABILIDAD DEL USUARIO</h4>
      <p>El usuario se compromete a:</p>
      <ul>
        <li>Proveer información veraz</li>
        <li>No compartir credenciales</li>
        <li>No intentar vulnerar la seguridad del sistema</li>
        <li>No utilizar automatismos o scraping</li>
      </ul>

      <hr>

      <h4>7. PROPIEDAD INTELECTUAL</h4>
      <p>Todos los contenidos del sitio (marca, imágenes, textos, diseño, código) son propiedad de <strong>CHEF SRL</strong>.
      Se prohíbe su reproducción sin autorización escrita.</p>

      <hr>

      <h4>8. LIMITACIÓN DE RESPONSABILIDAD</h4>
      <p><strong>CHEF SRL</strong> no será responsable por:</p>
      <ul>
        <li>Fallas técnicas o interrupciones</li>
        <li>Problemas derivados de terceros proveedores</li>
        <li>Uso indebido del sitio por parte del usuario</li>
        <li>Eventos de fuerza mayor</li>
      </ul>

      <hr>

      <h4>9. JURISDICCIÓN</h4>
      <p>Se aplicarán las leyes de la República Argentina. Cualquier controversia será resuelta ante los tribunales ordinarios competentes.</p>`
    }
  };

  function openModal(key) {
    const data = CONTENT[key];
    if (!data) return;

    titleEl.textContent = data.title;
    contentEl.innerHTML = data.html;

    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  }

  // Links del footer
  document.querySelectorAll(".footer-link[data-modal]").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      openModal(a.dataset.modal);
    });
  });

  // Cerrar
  closeBtn?.addEventListener("click", closeModal);

  // Click fuera (backdrop)
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  // Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeModal();
  });
}

document.addEventListener("DOMContentLoaded", initLegalModals);