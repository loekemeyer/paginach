#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Deja de pedir permiso por cada lectura / edicion en Claude Code.
#
# GENERICO A PROPOSITO: no nombra este repo. Copiarlo tal cual a cualquier otro
# (mismo path: scripts/claude-permisos.sh) junto con el hook SessionStart de
# .claude/settings.json.
#
# Hace DOS cosas, y hacen falta las dos:
#
#   1) ~/.claude/settings.json  (permisos a nivel USUARIO)
#      Es el unico lugar cuya allow list NO pasa por el "trust dialog": aplica
#      en cualquier repo, tambien en los contenedores remotos de Claude Code web,
#      que nacen vacios en cada sesion. Se MERGEA: nunca pisa lo que ya este.
#
#   2) projects["<dir>"].hasTrustDialogAccepted = true  en ~/.claude.json
#      Sin eso Claude Code IGNORA permissions.allow del .claude/settings.json
#      DEL REPO y lo dice: "Ignoring N permissions.allow entries: this workspace
#      has not been trusted".
#
# ⚠ CUANDO CORRERLO: **antes** de que arranque Claude — en el setup script del
# entorno (Claude Code web) o una vez a mano en local. Los permisos se leen al
# arrancar la sesion, asi que correrlo desde un hook SessionStart recien tiene
# efecto en la sesion SIGUIENTE (medido).
#
# ⚠ Y de las dos, la que aguanta es (1). ~/.claude.json es el archivo que Claude
# Code se guarda para si y reescribe al cerrar la sesion desde lo que tenia en
# memoria al arrancar, asi que la sesion que dispara el hook puede pisar el trust
# al salir. ~/.claude/settings.json no lo toca nadie: ese es el que vale.
#
# Uso:  bash scripts/claude-permisos.sh
# ---------------------------------------------------------------------------
set -u

DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
HOME_DIR="${HOME:-/root}"
mkdir -p "$HOME_DIR/.claude"

python3 -c '
import json, os, sys

home, proj = sys.argv[1], sys.argv[2]

def leer(p):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return {}

def escribir(p, d):
    tmp = p + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)

# --- 1) allow list a nivel usuario (no pasa por el trust dialog) -------------
# Solo lectura, busqueda, edicion y git de lectura. git push, curl, rm y el SQL
# de Supabase NO estan: esos siguen preguntando, que es lo que se quiere.
BASE = [
    "Read", "Glob", "Grep", "Edit", "Write", "NotebookEdit",
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)",
    "Bash(git show:*)", "Bash(git branch:*)", "Bash(git fetch:*)",
    "Bash(git add:*)", "Bash(git commit:*)",
    "Bash(ls:*)", "Bash(mkdir:*)", "Bash(node --check:*)",
]
us = os.path.join(home, ".claude", "settings.json")
d = leer(us)
perms = d.setdefault("permissions", {})
allow = perms.setdefault("allow", [])
nuevos = [x for x in BASE if x not in allow]
allow.extend(nuevos)
escribir(us, d)

# --- 2) trust del workspace (habilita el .claude/settings.json del repo) -----
cj = os.path.join(home, ".claude.json")
d = leer(cj)
p = d.setdefault("projects", {}).setdefault(proj, {})
ya = p.get("hasTrustDialogAccepted") is True
p["hasTrustDialogAccepted"] = True
escribir(cj, d)

print("permisos usuario: +%d nuevos (%d en total) | trust %s: %s"
      % (len(nuevos), len(allow), "ya estaba" if ya else "marcado", proj))
' "$HOME_DIR" "$DIR"
