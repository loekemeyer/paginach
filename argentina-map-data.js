/* =========================================================
   Argentina map — carga GeoJSON real desde CDN, lo convierte
   a SVG con bordes provinciales reales. Cachea en memoria.
   Fallback a SVG simplificado si la red falla.

   API:
     loadArgentinaMapSvg() → Promise<string SVG>
     ARGENTINA_MAP_SVG → string | null (set tras primera carga)
     ARGENTINA_PROVINCIAS → array canónico de nombres

   Cada path tiene data-prov="NombreProvincia" matcheando los
   nombres que devuelve detect_provincia (CABA, Buenos Aires, etc).
   ========================================================= */

// Fuentes del GeoJSON (probadas en orden — primera que funcione gana).
// Si todas fallan, cae al fallback simplificado embebido abajo.
// Nota: IIS y algunos otros servers no saben servir .geojson por default →
// 404 aunque el archivo exista. Probamos .json primero (extensión universal),
// y solo después .geojson (por si el server tiene MIME type configurado).
var ARGENTINA_GEOJSON_URLS = [
  "argentina-provinces.json",    // local con extensión .json (IIS-friendly)
  "argentina-provinces.geojson", // local con extensión original (si web.config tiene MIME)
  "https://raw.githubusercontent.com/codeforgermany/click_that_hood/master/public/data/argentina-provinces.geojson",
  "https://cdn.jsdelivr.net/gh/codeforgermany/click_that_hood@master/public/data/argentina-provinces.geojson"
];

// Mapeo GeoJSON → nombre canónico que usa detect_provincia
var ARGENTINA_NAME_MAP = {
  "Ciudad de Buenos Aires": "CABA",
  "Ciudad Autónoma de Buenos Aires": "CABA",
  "Autonomous City of Buenos Aires": "CABA", // geoBoundaries
  "Capital Federal": "CABA",
  "CABA": "CABA",
  // Posibles variaciones
  "Tierra del Fuego, Antártida e Islas del Atlántico Sur": "Tierra del Fuego",
  "Tierra del Fuego, Antártida e Islas del Atlántico Sud": "Tierra del Fuego"
};

function _normalizeArProv(name) {
  if (!name) return null;
  var trimmed = String(name).trim();
  return ARGENTINA_NAME_MAP[trimmed] || trimmed;
}

// Cache
var ARGENTINA_MAP_SVG = null;
var ARGENTINA_MAP_LOAD_PROMISE = null;

// Lista canónica de las 24 provincias (orden alfabético)
var ARGENTINA_PROVINCIAS = [
  "Buenos Aires", "CABA", "Catamarca", "Chaco", "Chubut", "Córdoba",
  "Corrientes", "Entre Ríos", "Formosa", "Jujuy", "La Pampa", "La Rioja",
  "Mendoza", "Misiones", "Neuquén", "Río Negro", "Salta", "San Juan",
  "San Luis", "Santa Cruz", "Santa Fe", "Santiago del Estero",
  "Tierra del Fuego", "Tucumán"
];

// Cargar y cachear. Idempotente. Prueba URLs en cascada.
function loadArgentinaMapSvg() {
  if (ARGENTINA_MAP_SVG) return Promise.resolve(ARGENTINA_MAP_SVG);
  if (ARGENTINA_MAP_LOAD_PROMISE) return ARGENTINA_MAP_LOAD_PROMISE;

  function tryUrl(idx) {
    if (idx >= ARGENTINA_GEOJSON_URLS.length) {
      throw new Error("Todas las URLs fallaron");
    }
    var url = ARGENTINA_GEOJSON_URLS[idx];
    return fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + " en " + url);
        return r.json();
      })
      .then(function (gj) {
        console.log("[ar-map] GeoJSON cargado desde:", url);
        return gj;
      })
      .catch(function (e) {
        console.warn("[ar-map] " + url + " falló:", e.message);
        return tryUrl(idx + 1);
      });
  }

  ARGENTINA_MAP_LOAD_PROMISE = tryUrl(0)
    .then(function (gj) {
      ARGENTINA_MAP_SVG = _buildSvgFromGeoJson(gj);
      return ARGENTINA_MAP_SVG;
    })
    .catch(function (e) {
      console.warn("[ar-map] Todo falló, fallback simplificado:", e.message);
      ARGENTINA_MAP_SVG = ARGENTINA_MAP_SVG_FALLBACK;
      return ARGENTINA_MAP_SVG;
    });
  return ARGENTINA_MAP_LOAD_PROMISE;
}

// Convierte un GeoJSON FeatureCollection a SVG. Proyección equirectangular
// con corrección por cos(lat) para que no se vea estirado horizontalmente.
function _buildSvgFromGeoJson(gj) {
  // Bounding box global
  var minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  function visit(coord) {
    if (coord[0] < minLon) minLon = coord[0];
    if (coord[0] > maxLon) maxLon = coord[0];
    if (coord[1] < minLat) minLat = coord[1];
    if (coord[1] > maxLat) maxLat = coord[1];
  }
  gj.features.forEach(function (f) {
    var g = f.geometry; if (!g) return;
    if (g.type === "Polygon") {
      g.coordinates.forEach(function (ring) { ring.forEach(visit); });
    } else if (g.type === "MultiPolygon") {
      g.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) { ring.forEach(visit); });
      });
    }
  });

  // Dimensiones del SVG con corrección de aspecto
  var lonRange = maxLon - minLon;
  var latRange = maxLat - minLat;
  var aspectCorr = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  var width = 260;
  var height = width * (latRange / lonRange) / aspectCorr;

  function project(coord) {
    var x = (coord[0] - minLon) / lonRange * width;
    var y = height - (coord[1] - minLat) / latRange * height;
    return [x, y];
  }

  function ringToD(ring) {
    var s = "";
    for (var i = 0; i < ring.length; i++) {
      var p = project(ring[i]);
      s += (i === 0 ? "M" : "L") + p[0].toFixed(2) + "," + p[1].toFixed(2);
    }
    return s + "Z";
  }

  var paths = gj.features.map(function (f) {
    // Soporta múltiples conventions de naming: shapeName (geoBoundaries),
    // name/NAME (click_that_hood), nombre (gov.ar).
    var rawName =
      f.properties &&
      (f.properties.shapeName ||
        f.properties.name ||
        f.properties.NAME ||
        f.properties.nombre);
    var prov = _normalizeArProv(rawName);
    if (!prov) return "";
    var d = "";
    var g = f.geometry; if (!g) return "";
    if (g.type === "Polygon") {
      g.coordinates.forEach(function (ring) { d += ringToD(ring); });
    } else if (g.type === "MultiPolygon") {
      g.coordinates.forEach(function (poly) {
        poly.forEach(function (ring) { d += ringToD(ring); });
      });
    }
    return '<path data-prov="' + prov + '" d="' + d + '" />';
  });

  return '<svg viewBox="0 0 ' + width.toFixed(0) + ' ' + height.toFixed(0) +
    '" xmlns="http://www.w3.org/2000/svg" class="ar-map-svg" preserveAspectRatio="xMidYMid meet">' +
    '<g stroke="#ffffff" stroke-width="0.4" stroke-linejoin="round">' +
    paths.join("") +
    '</g></svg>';
}

// Fallback simplificado (polygons básicos) si la red falla.
var ARGENTINA_MAP_SVG_FALLBACK = '\
<svg viewBox="0 0 200 500" xmlns="http://www.w3.org/2000/svg" class="ar-map-svg">\
  <g stroke="#ffffff" stroke-width="0.7" stroke-linejoin="round">\
    <polygon data-prov="Jujuy" points="48,0 95,0 92,38 58,42 48,30"/>\
    <polygon data-prov="Salta" points="95,0 158,0 155,60 100,58 92,38"/>\
    <polygon data-prov="Formosa" points="140,5 200,5 200,48 145,48"/>\
    <polygon data-prov="Misiones" points="175,42 200,42 200,108 175,108"/>\
    <polygon data-prov="Tucumán" points="78,58 110,58 110,88 78,88"/>\
    <polygon data-prov="Chaco" points="110,58 178,58 178,102 105,102"/>\
    <polygon data-prov="Catamarca" points="55,78 90,78 90,138 55,132"/>\
    <polygon data-prov="Santiago del Estero" points="90,82 138,82 138,138 95,138"/>\
    <polygon data-prov="Corrientes" points="140,92 178,92 178,145 140,145"/>\
    <polygon data-prov="La Rioja" points="40,132 85,132 85,172 40,168"/>\
    <polygon data-prov="Santa Fe" points="138,102 172,102 172,205 148,205 148,145"/>\
    <polygon data-prov="Córdoba" points="90,142 148,142 148,212 90,212"/>\
    <polygon data-prov="Entre Ríos" points="162,148 198,148 198,208 162,208"/>\
    <polygon data-prov="San Juan" points="35,162 80,162 80,212 35,208"/>\
    <polygon data-prov="San Luis" points="80,202 122,202 122,252 80,248"/>\
    <polygon data-prov="Mendoza" points="25,208 80,208 80,292 25,288"/>\
    <polygon data-prov="Buenos Aires" points="122,202 200,202 200,308 132,308 122,252"/>\
    <polygon data-prov="CABA" points="184,214 192,214 192,222 184,222"/>\
    <polygon data-prov="La Pampa" points="80,248 132,248 132,298 80,292"/>\
    <polygon data-prov="Neuquén" points="30,278 92,278 92,338 30,332"/>\
    <polygon data-prov="Río Negro" points="80,298 198,298 198,355 80,345"/>\
    <polygon data-prov="Chubut" points="55,345 182,345 182,408 55,408"/>\
    <polygon data-prov="Santa Cruz" points="50,408 178,408 172,475 60,475"/>\
    <polygon data-prov="Tierra del Fuego" points="85,475 168,475 162,498 90,498"/>\
  </g>\
</svg>';

// Pre-cargar el SVG en cuanto se carga el script — para que esté listo
// cuando el usuario abra el modal.
loadArgentinaMapSvg();
