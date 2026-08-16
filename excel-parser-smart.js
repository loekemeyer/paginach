// Smart Excel Parser - Fuzzy match columnas, detecta tipos automáticamente
// Sin dependencia de nombres exactos

var ExcelParserSmart = (function () {
  // Fuzzy match: score similitud entre dos strings
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    var dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
    for (var i = 0; i <= m; i++) dp[i][0] = i;
    for (var j = 0; j <= n; j++) dp[0][j] = j;
    for (var i = 1; i <= m; i++) {
      for (var j = 1; j <= n; j++) {
        var cost = a[i - 1] !== b[j - 1] ? 1 : 0;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  // Normaliza string para búsqueda
  function normalize(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[áàäâ]/g, "a")
      .replace(/[éèëê]/g, "e")
      .replace(/[íìïî]/g, "i")
      .replace(/[óòöô]/g, "o")
      .replace(/[úùüû]/g, "u")
      .replace(/[ñ]/g, "n")
      .replace(/[^\w]/g, "")
      .trim();
  }

  // Busca mejor match de columna contra keywords
  function findBestMatch(colName, keywords) {
    var normalized = normalize(colName);
    var best = { score: Infinity, keyword: null };
    keywords.forEach(function (kw) {
      var dist = levenshtein(normalized, normalize(kw));
      if (dist < best.score) {
        best.score = dist;
        best.keyword = kw;
      }
    });
    // Retorna match si distancia <= 3 (tolerancia para typos)
    return best.score <= 3 ? best.keyword : null;
  }

  // Detecta tipo de valor
  function detectType(val) {
    if (!val || val === "") return "empty";
    var s = String(val).trim();
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s)) return "date";
    if (/^[0-9]+$/.test(s) && s.length >= 8) return "cuit";
    if (/^[\w\.\-]+@[\w\.\-]+/.test(s)) return "email";
    if (!isNaN(parseFloat(s))) return "number";
    if (/^[a-z0-9\-]+$/i.test(s) && s.length < 20) return "code";
    return "text";
  }

  // Analiza sample de columna para determinar su contenido
  function analyzeColumn(colData, colName) {
    var types = {};
    var nonEmpty = 0;
    for (var i = 0; i < Math.min(colData.length, 10); i++) {
      var type = detectType(colData[i]);
      if (type !== "empty") {
        nonEmpty++;
        types[type] = (types[type] || 0) + 1;
      }
    }
    var dominantType = Object.keys(types).sort(
      (a, b) => types[b] - types[a]
    )[0];
    return {
      name: colName,
      dominantType: dominantType || "text",
      filledRatio: nonEmpty / colData.length,
      types: types,
    };
  }

  // Main: mapea automáticamente archivo Excel a schema deseado
  function mapExcelToSchema(rows, schema) {
    // rows: array de objetos desde XLSX
    // schema: { fieldName: { keywords: [...], type: 'number'|'text'|'date'|'cuit'|'email', required: bool } }

    if (!rows || rows.length === 0) return [];

    var colNames = Object.keys(rows[0]);
    var columnAnalysis = colNames.map(function (cn) {
      var colData = rows.map(r => r[cn]);
      return analyzeColumn(colData, cn);
    });

    // Mapea cada field del schema a una columna
    var mapping = {};
    Object.keys(schema).forEach(function (fieldName) {
      var fieldSpec = schema[fieldName];
      var keywords = fieldSpec.keywords || [];

      var best = { col: null, score: -Infinity };

      // Busca mejor match por fuzzy + type hint
      columnAnalysis.forEach(function (ca) {
        var fuzzyMatch = findBestMatch(ca.name, keywords);
        var typeMatch = ca.dominantType === (fieldSpec.type || "text") ? 1 : 0;
        var score = (fuzzyMatch ? 10 - (ca.name.length - fuzzyMatch.length) : 0) +
                    typeMatch * 5 +
                    ca.filledRatio * 2;

        if (score > best.score) {
          best = { col: ca.name, score: score };
        }
      });

      if (best.col || !fieldSpec.required) {
        mapping[fieldName] = best.col;
      }
    });

    // Aplica mapping y transforma valores
    return rows
      .map(function (row) {
        var mapped = {};
        Object.keys(schema).forEach(function (fieldName) {
          var colName = mapping[fieldName];
          if (colName) {
            var val = row[colName];
            mapped[fieldName] = transformValue(val, schema[fieldName].type);
          } else {
            mapped[fieldName] = null;
          }
        });
        return mapped;
      })
      .filter(function (row) {
        // Filtra filas con campos requeridos
        return Object.keys(schema).every(function (fn) {
          return !schema[fn].required || row[fn];
        });
      });
  }

  // Transforma valor según tipo
  function transformValue(val, type) {
    if (!val || val === "") return null;
    var s = String(val).trim();

    switch (type) {
      case "number":
        var n = parseFloat(s);
        return isNaN(n) ? null : n;
      case "cuit":
        return s.replace(/[^0-9]/g, "");
      case "email":
        return s.toLowerCase();
      case "date":
        return parseExcelDate(val) || s;
      default:
        return s;
    }
  }

  // Parsea fechas Excel (num) o string
  function parseExcelDate(val) {
    if (typeof val === "number") {
      // Excel epoch: 1900-01-01
      var date = new Date((val - 25569) * 86400 * 1000);
      return date.toISOString().split("T")[0];
    }
    // Si es string, intenta DD/MM/YYYY o DD-MM-YYYY
    var match = String(val).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (match) {
      var d = parseInt(match[1]), m = parseInt(match[2]), y = parseInt(match[3]);
      if (y < 100) y += y < 50 ? 2000 : 1900;
      var date = new Date(y, m - 1, d);
      return date.toISOString().split("T")[0];
    }
    return null;
  }

  // Export
  return {
    mapExcelToSchema: mapExcelToSchema,
    detectType: detectType,
    normalize: normalize,
    findBestMatch: findBestMatch,
    parseExcelDate: parseExcelDate,
  };
})();
