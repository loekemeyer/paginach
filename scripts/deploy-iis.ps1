<#
  deploy-iis.ps1 — publica en un IIS administrado con SolidCP SOLO los archivos
  que cambiaron, en vez de subir el sitio entero uno por uno.

  NO es exclusivo de loekemeyer.com: el dominio sale de scripts/deploy-sitio.json
  (versionado, no tiene nada secreto), asi que el mismo script sirve para
  chefsrl.com o cualquier otro sitio estatico del mismo hosting. Para llevarlo a
  otro repo: copiar este archivo, crear ese .json con su dominio, y agregar al
  .gitignore la linea de deploy-iis.local.json.

  Por que hace falta: el arbol pesa ~31 MB y el File Manager de SolidCP corre sobre
  IIS, que limita el tamano de subida (maxRequestLength / maxAllowedContentLength).
  Por eso un .zip del sitio completo se traba. Pero el 87% de ese peso son archivos
  que casi nunca cambian (catalogo.pdf, los 3 videos, los gif, logo.png): el codigo
  que si cambia — .js / .css / .html — pesa alrededor de 1,5 MB en total.
  Subiendo solo el delta, un deploy tipico son ~300 KB y entra sin trabarse.

  Dos modos:
    -Mode Zip  (default) arma un .zip con el delta, para descomprimir desde el
               File Manager de SolidCP. No necesita instalar ni configurar nada.
    -Mode Ftp  sube el delta directo por FTP/FTPS a la cuenta del hosting.
               Es el modo bueno: un solo comando y no hay limite de tamano.

  Ejemplos:
    .\scripts\deploy-iis.ps1                      # zip con lo que le falta al sitio
    .\scripts\deploy-iis.ps1 -Simular             # lista que subiria, sin tocar nada
    .\scripts\deploy-iis.ps1 -Mode Ftp            # sube el delta por FTP
    .\scripts\deploy-iis.ps1 -Mode Ftp -Todo      # sube el sitio entero por FTP
    .\scripts\deploy-iis.ps1 -Desde 2.3.374       # delta contra una version puntual
    .\scripts\deploy-iis.ps1 -Sitio https://www.chefsrl.com   # otro sitio, sin tocar el json

  Credenciales (modo Ftp): NUNCA en el repo, que es publico. Van en
  scripts\deploy-iis.local.json (ya esta en .gitignore):

    { "host": "ftp.loekemeyer.com", "usuario": "...", "clave": "...",
      "carpetaRemota": "/", "ftps": true }

  El usuario y la clave de FTP salen de SolidCP -> Hosting Space -> FTP Accounts.
#>

[CmdletBinding()]
param(
  [ValidateSet('Zip', 'Ftp')] [string]$Mode = 'Zip',
  [string]$Sitio = '',
  [string]$Desde = '',
  [switch]$Todo,
  [switch]$Simular
)

$ErrorActionPreference = 'Stop'
$raiz = Split-Path -Parent $PSScriptRoot
Set-Location $raiz

# --- Que sitio se publica ---------------------------------------------------
# Orden: el parametro -Sitio, si no scripts/deploy-sitio.json, si no se aborta.
# Nada de un default escondido: publicar en el dominio equivocado es peor que
# no publicar.
if (-not $Sitio) {
  $cfgSitio = Join-Path $PSScriptRoot 'deploy-sitio.json'
  if (Test-Path $cfgSitio) {
    $Sitio = (Get-Content $cfgSitio -Raw | ConvertFrom-Json).sitio
  }
}
if (-not $Sitio) {
  throw "No se sabe que sitio publicar. Crea scripts\deploy-sitio.json con { ""sitio"": ""https://www.tudominio.com"" } o pasa -Sitio https://..."
}
$Sitio = $Sitio.TrimEnd('/')

# --- Lo que NUNCA se sube -----------------------------------------------------
# web.config: el del servidor es el UNICO que existe y es el que manda (ver CLAUDE.md).
# El resto es material interno que no tiene por que servirse publico.
$excluir = @(
  '^web\.config$', '^\.locks/', '^hooks/', '^scripts/', '^docs/', '^sql/', '^supabase/',
  '\.md$', '\.sql$', '^LOCKS\.txt$', '^config-claude\.json$', '^caveman-state\.json$',
  '^vercel\.json$', '^\.github/'
)
function EsPublicable([string]$ruta) {
  foreach ($rx in $excluir) { if ($ruta -match $rx) { return $false } }
  return $true
}

# --- Version publicada hoy en el sitio ---------------------------------------
function VersionPublicada {
  try {
    $url = "$Sitio/version.js?nocache=$(Get-Random)"
    $txt = (Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20).Content
    if ($txt -match 'APP_VERSION\s*=\s*"([0-9.]+)"') { return $Matches[1] }
  } catch {
    Write-Warning "No se pudo leer la version publicada: $($_.Exception.Message)"
  }
  return $null
}

# Cada bump escribe el numero de version en version.js, asi que -S lo encuentra.
# Devuelve DOS commits (el que la puso y el que la saco); el que la puso es el mas viejo.
function CommitDeVersion([string]$ver) {
  $c = git log --format=%H -S $ver -- version.js
  if (-not $c) { return $null }
  return (@($c))[-1]
}

# --- Que archivos hay que subir ----------------------------------------------
if ($Todo) {
  $archivos = git ls-files | Where-Object { EsPublicable $_ }
  $detalle = 'sitio completo'
} else {
  $ver = if ($Desde) { $Desde } else { VersionPublicada }
  if (-not $ver) {
    throw "No se pudo determinar la version publicada. Pasala a mano: -Desde 2.3.374 (o -Todo)."
  }
  $base = CommitDeVersion $ver
  if (-not $base) { throw "No encontre en el historial la version $ver." }
  $archivos = git diff --name-only $base HEAD |
    Where-Object { (EsPublicable $_) -and (Test-Path $_) }
  $local = (Get-Content version.js | Select-String 'APP_VERSION\s*=\s*"([0-9.]+)"').Matches[0].Groups[1].Value
  $detalle = "delta v$ver -> v$local"
}

$archivos = @($archivos | Sort-Object -Unique)
if ($archivos.Count -eq 0) {
  Write-Host "El sitio ya esta al dia. No hay nada que subir." -ForegroundColor Green
  return
}

$peso = ($archivos | ForEach-Object { (Get-Item $_).Length } | Measure-Object -Sum).Sum
Write-Host ""
Write-Host "$($archivos.Count) archivos ($detalle) — $([math]::Round($peso/1KB)) KB" -ForegroundColor Cyan
$archivos | ForEach-Object { Write-Host "   $_" }
Write-Host ""

if ($Simular) { Write-Host "-Simular: no se subio nada." -ForegroundColor Yellow; return }

# --- Modo Zip ------------------------------------------------------------------
if ($Mode -eq 'Zip') {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmm'
  $tmp = Join-Path $env:TEMP "lk-deploy-$stamp"
  $zip = Join-Path $raiz "deploy_$stamp.zip"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $tmp | Out-Null

  foreach ($a in $archivos) {
    $destino = Join-Path $tmp $a
    New-Item -ItemType Directory -Path (Split-Path $destino -Parent) -Force | Out-Null
    Copy-Item $a $destino -Force
  }
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $zip -CompressionLevel Optimal

  $kb = [math]::Round((Get-Item $zip).Length / 1KB)
  Write-Host "Listo: $zip ($kb KB)" -ForegroundColor Green
  Write-Host "Subilo por SolidCP -> File Manager a la raiz del sitio y usa 'Unzip'." -ForegroundColor Green
  Write-Host "Respeta las carpetas (css/, img/, osa/...), asi que descomprimi en la RAIZ." -ForegroundColor Green
  Remove-Item $tmp -Recurse -Force
  return
}

# --- Modo Ftp ------------------------------------------------------------------
$cfgPath = Join-Path $PSScriptRoot 'deploy-iis.local.json'
if (-not (Test-Path $cfgPath)) {
  throw "Falta $cfgPath con los datos de FTP. Ver el encabezado de este script."
}
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$remotaBase = if ($cfg.carpetaRemota) { [string]$cfg.carpetaRemota } else { '/' }
$remotaBase = $remotaBase.TrimEnd('/')
$cred = New-Object System.Net.NetworkCredential($cfg.usuario, $cfg.clave)
$usarFtps = [bool]$cfg.ftps

function NuevoPedido([string]$url, [string]$metodo) {
  $r = [System.Net.FtpWebRequest]::Create($url)
  $r.Method = $metodo
  $r.Credentials = $cred
  $r.EnableSsl = $usarFtps
  $r.UseBinary = $true
  $r.UsePassive = $true
  $r.KeepAlive = $false
  $r.Timeout = 120000
  return $r
}

function AsegurarCarpeta([string]$rel) {
  if (-not $rel) { return }
  $acum = ''
  foreach ($parte in $rel.Split('/')) {
    if (-not $parte) { continue }
    $acum = if ($acum) { "$acum/$parte" } else { $parte }
    try {
      $req = NuevoPedido "ftp://$($cfg.host)$remotaBase/$acum" ([System.Net.WebRequestMethods+Ftp]::MakeDirectory)
      $req.GetResponse().Close()
    } catch [System.Net.WebException] {
      # 550 = ya existe. Cualquier otra cosa si es un problema real.
      $resp = $_.Exception.Response
      if (-not $resp -or $resp.StatusCode -ne [System.Net.FtpStatusCode]::ActionNotTakenFileUnavailable) { throw }
    }
  }
}

$subidos = 0
foreach ($a in $archivos) {
  $rel = $a -replace '\\', '/'
  $carpeta = Split-Path $rel -Parent
  if ($carpeta) { AsegurarCarpeta ($carpeta -replace '\\', '/') }
  $req = NuevoPedido "ftp://$($cfg.host)$remotaBase/$rel" ([System.Net.WebRequestMethods+Ftp]::UploadFile)
  $bytes = [System.IO.File]::ReadAllBytes((Join-Path $raiz $a))
  $req.ContentLength = $bytes.Length
  $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
  $resp = $req.GetResponse(); $resp.Close()
  $subidos++
  Write-Host "   subido  $rel" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "$subidos archivos subidos a $($cfg.host)$remotaBase" -ForegroundColor Green
Write-Host "Verifica con Ctrl+F5 en $Sitio — el footer tiene que decir la version nueva." -ForegroundColor Green
