---
name: publicar-sitio
description: Arma el paquete para publicar un sitio estatico que corre sobre IIS con panel SolidCP (loekemeyer.com, chefsrl.com y similares) con SOLO los archivos que cambiaron desde la version que hoy esta en el aire, y se lo entrega al usuario como un .zip chico. Usar cuando pidan publicar, subir o deployar el sitio, o cuando pregunten que le falta al dominio en produccion.
---

# Publicar en el IIS (SolidCP)

Estos sitios corren sobre **IIS administrado con SolidCP** y se publican **a
mano**: el push a `main` NO los actualiza. Lo que el push actualiza es GitHub
Pages, que sirve para mirar los cambios pero no es lo que ven los clientes.

Subir el sitio entero no funciona: son decenas de MB y el File Manager de
SolidCP corre sobre IIS, que corta las subidas grandes. Por eso se sube **solo
el delta**, que en un dia normal de trabajo son unos cientos de KB.

## 0. Que sitio es

Sale de `scripts/deploy-sitio.json` del repo en el que se esta trabajando:

```bash
cat scripts/deploy-sitio.json    # { "sitio": "https://www.loekemeyer.com" }
```

Si ese archivo no existe, **preguntarle el dominio al usuario**. No asumir
loekemeyer.com: el mismo procedimiento se usa en varios sitios y publicar en el
dominio equivocado es peor que no publicar.

## 1. Averiguar que version esta publicada

Preguntarsela al usuario ("¿que dice el footer del sitio?") o, si la sesion
tiene salida a internet, leerla:

```bash
curl -s "<sitio>/version.js?nocache=$RANDOM" | grep -o 'APP_VERSION = "[^"]*"'
```

En las sesiones remotas de Claude Code el proxy suele **bloquear esos
dominios**; ahi hay que preguntar el numero, no adivinarlo.

## 2. Ubicar el commit de esa version

Cada bump escribe el numero en `version.js`, asi que `-S` lo encuentra. Devuelve
dos commits (el que la puso y el que la saco): sirve **el mas viejo**, el que la
puso.

```bash
git log --format=%H -S "2.3.374" -- version.js | tail -1
```

## 3. Armar el ZIP con el delta

```bash
git diff --name-only <commit_base> HEAD \
  | grep -vE '^(web\.config$|\.locks/|hooks/|scripts/|docs/|sql/|supabase/|tests/|\.github/|\.claude/)|\.md$|\.sql$|^LOCKS\.txt$|^config-claude\.json$|^caveman-state\.json$|^vercel\.json$|^\.gitignore$' \
  | while read f; do [ -f "$f" ] && echo "$f"; done > /tmp/delta.txt

rm -rf /tmp/zip && mkdir -p /tmp/zip
while read f; do mkdir -p "/tmp/zip/$(dirname "$f")"; cp "$f" "/tmp/zip/$f"; done < /tmp/delta.txt
(cd /tmp/zip && zip -qr /tmp/deploy.zip .)
```

**Nunca incluir `web.config`.** El del servidor IIS es el unico que existe (no
esta en el repo) y pisarlo tira el sitio entero: ya paso una vez en LK, ver
`CLAUDE.md`. Tampoco van `sql/`, `docs/`, `supabase/`, `.claude/` ni los `.md`:
son material interno. **Ni `tests/`**: el 18/09/2026 se coló `tests/payload-scope.cjs` en un
paquete real — no rompe nada, pero es codigo interno en un server publico.

Antes de entregarlo, verificar que no se colo nada de eso:

```bash
unzip -l /tmp/deploy.zip | grep -cE 'web\.config|sql/|docs/|supabase/|tests/|\.md$'   # tiene que dar 0
```

## 4. Entregarlo

Mandarlo con `SendUserFile` y decirle al usuario:

1. SolidCP → File Manager → la **raiz** del sitio.
2. Subir el ZIP y **descomprimir ahi mismo, en la raiz** — adentro vienen las
   carpetas (`css/`, `img/`, …) y tienen que caer en su lugar.
3. Borrar el ZIP del servidor.
4. `Ctrl+F5` y confirmar que el footer muestra la version nueva.

## La via sin ZIP: FTP

`scripts/deploy-iis.ps1` hace todo esto desde Windows, y con `-Mode Ftp` ademas
**sube los archivos solo**, sin File Manager:

```powershell
.\scripts\deploy-iis.ps1 -Simular                          # lista que falta, sin tocar nada
.\scripts\deploy-iis.ps1                                   # arma el .zip del delta
.\scripts\deploy-iis.ps1 -Mode Ftp                         # sube el delta directo
.\scripts\deploy-iis.ps1 -Sitio https://www.chefsrl.com    # otro sitio, sin tocar el json
```

Para el modo Ftp hacen falta las credenciales del hosting, que salen de
**SolidCP → Hosting Space → FTP Accounts**, en `scripts/deploy-iis.local.json`:

```json
{ "host": "ftp.tudominio.com", "usuario": "...", "clave": "...", "carpetaRemota": "/", "ftps": true }
```

Ese archivo **nunca va al repo** (tiene que estar en `.gitignore`): estos
repositorios son publicos. Claude no puede correr el `.ps1` ni subir por FTP
desde una sesion remota — el proxy solo deja pasar HTTPS —, asi que desde el
chat el entregable es siempre el ZIP.

## Llevarlo a otro repo (Chef, Tierra Nativa, …)

Son tres archivos y un dato:

1. Copiar `.claude/skills/publicar-sitio/SKILL.md` y `scripts/deploy-iis.ps1`.
2. Crear `scripts/deploy-sitio.json` con el dominio de ESE sitio.
3. Agregar al `.gitignore` las lineas `scripts/deploy-iis.local.json` y
   `deploy_*.zip`.

Condiciones para que funcione sin tocar nada mas: que el repo tenga un
`version.js` con `const APP_VERSION = "x.y.z"` y que ese numero se bumpee en
cada commit (en LK lo hacen los hooks de `hooks/`). Si el repo no tiene
`version.js`, el paso 1 y el paso 2 no aplican: ahi el delta se calcula contra
un commit que el usuario indique, o contra una fecha.

Ojo con los espejos: si lo que se publica toca archivos que estan duplicados en
otro repo, hay que replicarlos ahi tambien. Que archivos y que ajustes propios
NO se deben pisar esta en el `CLAUDE.md` de cada repo.
