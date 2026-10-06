#!/usr/bin/env bash
# ubuntu-macos-style — transforme Ubuntu (GNOME 50) en bureau façon macOS.
# Usage : ./install.sh [--yes] [--no-apt] [--no-restart] [--keep-wallpaper] [--force]
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
SRC_DIR="$HOME/.local/src/ubuntu-macos-style"
STATE_DIR="$HOME/.local/state/ubuntu-macos-style"
BACKUP_DIR="$STATE_DIR/backup-$(date +%Y%m%d-%H%M%S)"
WALL_DIR="$HOME/.local/share/backgrounds"

# Versions épinglées : tout le monde obtient exactement le même résultat.
GTK_URL=https://github.com/vinceliuice/WhiteSur-gtk-theme.git;      GTK_SHA=d5782652d412137e26fb8ff55b55a5572e4c6995
ICON_URL=https://github.com/vinceliuice/WhiteSur-icon-theme.git;    ICON_SHA=73d8040da51a9ed74e47c7366e7e9ff437601a5c
CURSOR_URL=https://github.com/vinceliuice/WhiteSur-cursors.git;     CURSOR_SHA=e190baf618ed95ee217d2fd45589bd309b37672b
WALL_SHA=5c1d7ca20b8de0a7efe443792c19e49277262e02
WIDGETS_URL=https://github.com/r3nhick/desktop-widgets.git;          WIDGETS_SHA=03c677f956707af0a5f38e3bd667ea2618eca336
LINTEL_URL=https://github.com/eliotBenitez/lintel.git;              LINTEL_SHA=ca84855fb8a096fe442f3367eb71ab4d1940747e   # v0.17.2

# Extensions installées depuis extensions.gnome.org (dernière version compatible).
# (desktop-widgets n'y est pas : installé depuis GitHub, voir plus bas.)
EGO_EXTENSIONS=(
  dash-to-dock@micxgx.gmail.com
  blur-my-shell@aunetx
  compiz-windows-effect@hermes83.github.com
  compiz-alike-magic-lamp-effect@hermes83.github.com
  desktop-cube@schneegans.github.com
)
# Mes extensions (dans ce repo).
OWN_EXTENSIONS=(circular-dock-wave@enock.local professional-dashboard@enock.local smart-phase11@enock.local)
# Activées en plus de celles déjà actives chez toi.
ENABLE_EXTENSIONS=(
  tiling-assistant@ubuntu.com user-theme@gnome-shell-extensions.gcampax.github.com
  "${EGO_EXTENSIONS[@]}" desktop-widgets@r3nhick lintel@topbar "${OWN_EXTENSIONS[@]}"
)

ASSUME_YES=0; NO_APT=0; NO_RESTART=0; KEEP_WALL=0; FORCE=0
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-apt) NO_APT=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --keep-wallpaper) KEEP_WALL=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "Option inconnue : $a" >&2; exit 2 ;;
  esac
done

c_b=$'\e[1m'; c_g=$'\e[32m'; c_y=$'\e[33m'; c_r=$'\e[31m'; c_0=$'\e[0m'
step() { printf '\n%s▶ %s%s\n' "$c_b" "$*" "$c_0"; }
ok()   { printf '  %s✓%s %s\n' "$c_g" "$c_0" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_y" "$c_0" "$*"; }
die()  { printf '%s✗ %s%s\n' "$c_r" "$*" "$c_0" >&2; exit 1; }
trap 'die "Échec ligne $LINENO. Tu peux relancer ./install.sh sans risque, ou annuler avec ./uninstall.sh."' ERR

# ───────────────────────── 0. Vérifications ─────────────────────────
step "Vérifications"
[ "$(id -u)" -ne 0 ] || die "Ne lance pas ce script avec sudo : il configure TON utilisateur."
command -v gnome-shell >/dev/null || die "GNOME Shell introuvable : ce script est prévu pour Ubuntu (GNOME)."
SHELL_MAJOR=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
if [ "$SHELL_MAJOR" != "50" ] && [ "$FORCE" -ne 1 ]; then
  die "GNOME Shell $SHELL_MAJOR détecté, ce repo est testé sur la version 50. Relance avec --force pour tenter quand même."
fi
ok "GNOME Shell $SHELL_MAJOR, session ${XDG_SESSION_TYPE:-inconnue}"
curl -fsI -m 10 https://github.com >/dev/null || die "Pas d'accès à internet (github.com)."
ok "Connexion internet"

# ───────────────────────── 1. Paquets ─────────────────────────
if [ "$NO_APT" -eq 0 ]; then
  step "Paquets nécessaires (sudo demandé une seule fois)"
  sudo apt-get update -qq
  sudo apt-get install -y -qq git curl unzip sassc gettext libglib2.0-bin libglib2.0-dev-bin \
    libxml2-utils dconf-cli python3 gnome-shell-extensions gnome-shell-extension-prefs rsync
  ok "Paquets installés"
else
  warn "--no-apt : je suppose que git curl unzip sassc gettext glib2 dconf python3 sont déjà là"
fi

# ───────────────────────── 2. Sauvegarde ─────────────────────────
step "Sauvegarde de tes réglages actuels"
mkdir -p "$STATE_DIR" "$EXT_DIR" "$SRC_DIR" "$WALL_DIR"
if [ -d "$STATE_DIR/original/dconf" ]; then
  # Déjà installé une fois : on garde la TOUTE première sauvegarde (ton état d'avant) intacte.
  RERUN=1; BACKUP_DIR="$(mktemp -d "$STATE_DIR/rerun-XXXXXX")"; mkdir -p "$BACKUP_DIR/extensions"
  ok "Sauvegarde d'origine déjà présente, conservée : $STATE_DIR/original"
else
  RERUN=0; mkdir -p "$BACKUP_DIR/dconf" "$BACKUP_DIR/extensions"
  for p in /org/gnome/desktop/interface/ /org/gnome/desktop/wm/preferences/ /org/gnome/mutter/ \
           /org/gnome/desktop/peripherals/touchpad/ /org/gnome/desktop/background/ /org/gnome/shell/; do
    dconf dump "$p" > "$BACKUP_DIR/dconf/$(echo "$p" | tr '/' '_').ini"
  done
  ln -sfn "$BACKUP_DIR" "$STATE_DIR/original"
  ok "Sauvegarde dans $BACKUP_DIR"
fi

fetch_pinned() { # url sha dir
  local url=$1 sha=$2 dir=$3
  if [ -d "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$sha" ]; then return; fi
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch -q --depth 1 origin "$sha"
  git -C "$dir" checkout -q FETCH_HEAD
}
stash_existing() { # uuid : met de côté une version existante (non symlink) avant remplacement
  local d="$EXT_DIR/$1"
  if [ -e "$d" ] || [ -L "$d" ]; then mv "$d" "$BACKUP_DIR/extensions/$1"; fi
}
compile_schemas() { [ -d "$1/schemas" ] && glib-compile-schemas "$1/schemas" || true; }

# ───────────────────────── 3. Thème, icônes, curseurs ─────────────────────────
step "Thème WhiteSur (GTK + libadwaita), icônes et curseurs"
fetch_pinned "$GTK_URL" "$GTK_SHA" "$SRC_DIR/WhiteSur-gtk-theme"
( cd "$SRC_DIR/WhiteSur-gtk-theme" && ./install.sh -c dark -t blue -l >/dev/null )
ok "Thème GTK WhiteSur-Dark-blue"
fetch_pinned "$ICON_URL" "$ICON_SHA" "$SRC_DIR/WhiteSur-icon-theme"
( cd "$SRC_DIR/WhiteSur-icon-theme" && ./install.sh >/dev/null )
ok "Icônes WhiteSur"
fetch_pinned "$CURSOR_URL" "$CURSOR_SHA" "$SRC_DIR/WhiteSur-cursors"
( cd "$SRC_DIR/WhiteSur-cursors" && ./install.sh >/dev/null )
ok "Curseurs WhiteSur"

# ───────────────────────── 4. Extensions tierces ─────────────────────────
step "Extensions GNOME (téléchargées depuis extensions.gnome.org)"
for uuid in "${EGO_EXTENSIONS[@]}"; do
  tmp=$(mktemp -d)
  info=$(curl -fsSL "https://extensions.gnome.org/extension-info/?uuid=${uuid}&shell_version=${SHELL_MAJOR}") \
    || die "extensions.gnome.org ne répond pas pour $uuid"
  dl=$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("download_url",""))' <<<"$info")
  [ -n "$dl" ] || die "$uuid : aucune version compatible avec GNOME Shell $SHELL_MAJOR"
  curl -fsSL -o "$tmp/ext.zip" "https://extensions.gnome.org${dl}"
  stash_existing "$uuid"
  mkdir -p "$EXT_DIR/$uuid"; unzip -q -o "$tmp/ext.zip" -d "$EXT_DIR/$uuid"
  compile_schemas "$EXT_DIR/$uuid"
  rm -rf "$tmp"; ok "$uuid"
done

step "Desktop Widgets (depuis GitHub, version épinglée)"
fetch_pinned "$WIDGETS_URL" "$WIDGETS_SHA" "$SRC_DIR/desktop-widgets"
stash_existing desktop-widgets@r3nhick
mkdir -p "$EXT_DIR/desktop-widgets@r3nhick"
rsync -a --exclude='.git' "$SRC_DIR/desktop-widgets/" "$EXT_DIR/desktop-widgets@r3nhick/"
compile_schemas "$EXT_DIR/desktop-widgets@r3nhick"
ok "desktop-widgets@r3nhick"

step "Lintel (barre du haut façon macOS)"
fetch_pinned "$LINTEL_URL" "$LINTEL_SHA" "$SRC_DIR/lintel"
stash_existing lintel@topbar
( cd "$SRC_DIR/lintel" && ./install.sh >/dev/null )
ok "lintel@topbar (v0.17.2)"

# ───────────────────────── 5. Mes extensions + correctifs ─────────────────────────
step "Mes extensions et correctifs"
for uuid in "${OWN_EXTENSIONS[@]}"; do
  stash_existing "$uuid"
  cp -r "$REPO_DIR/extensions/$uuid" "$EXT_DIR/$uuid"
  if [ "$SHELL_MAJOR" != "50" ]; then
    python3 - "$EXT_DIR/$uuid/metadata.json" "$SHELL_MAJOR" <<'PY'
import json,sys; p,v=sys.argv[1:]; m=json.load(open(p)); m["shell-version"]=sorted(set(m["shell-version"]+[v])); json.dump(m,open(p,"w"),indent=2)
PY
  fi
  compile_schemas "$EXT_DIR/$uuid"; ok "$uuid"
done
python3 "$REPO_DIR/patches/desktop-cube-gnome50.py"   "$EXT_DIR/desktop-cube@schneegans.github.com" | sed 's/^/  ✓ /'
python3 "$REPO_DIR/patches/desktop-widgets-quiet.py"  "$EXT_DIR/desktop-widgets@r3nhick"             | sed 's/^/  ✓ /'

# ───────────────────────── 6. Réglages ─────────────────────────
step "Application des réglages"
dconf load /org/gnome/ < "$REPO_DIR/config/desktop.dconf"
dconf load /org/gnome/shell/extensions/ < "$REPO_DIR/config/extensions.dconf"
python3 - "${ENABLE_EXTENSIONS[@]}" <<'PY'
import ast, subprocess, sys
want = sys.argv[1:]
def get(key):
    out = subprocess.run(["gsettings","get","org.gnome.shell",key],capture_output=True,text=True).stdout.strip()
    return ast.literal_eval(out.replace("@as ","")) if out else []
enabled  = get("enabled-extensions")
disabled = [e for e in get("disabled-extensions") if e not in want]
enabled += [e for e in want if e not in enabled]
subprocess.run(["gsettings","set","org.gnome.shell","enabled-extensions",str(enabled)],check=True)
subprocess.run(["gsettings","set","org.gnome.shell","disabled-extensions",str(disabled)],check=True)
PY
gsettings set org.gnome.shell disable-user-extensions false
ok "Thèmes, extensions et réglages appliqués"

if [ "$KEEP_WALL" -eq 0 ]; then
  curl -fsSL -o "$WALL_DIR/WhiteSur-dark.jpg" \
    "https://raw.githubusercontent.com/vinceliuice/WhiteSur-wallpapers/${WALL_SHA}/4k/WhiteSur-dark.jpg"
  gsettings set org.gnome.desktop.background picture-uri      "file://$WALL_DIR/WhiteSur-dark.jpg"
  gsettings set org.gnome.desktop.background picture-uri-dark "file://$WALL_DIR/WhiteSur-dark.jpg"
  ok "Fond d'écran WhiteSur"
fi

# ───────────────────────── 7. Fin ─────────────────────────
step "Terminé 🎉"
echo "  Les extensions ne se chargent qu'après une reconnexion (limite de GNOME sous Wayland)."
echo "  Pour annuler : ./uninstall.sh"
[ "$RERUN" -eq 1 ] && rm -rf "$BACKUP_DIR"   # anciennes copies de nos propres fichiers : inutiles
[ "$NO_RESTART" -eq 1 ] && { warn "Déconnecte-toi puis reconnecte-toi pour voir le résultat."; exit 0; }
[ "$ASSUME_YES" -eq 1 ] && { warn "--yes : pas de redémarrage automatique. Déconnecte-toi pour voir le résultat."; exit 0; }

read -r -p $'\n  Sauvegarde ton travail. Se déconnecter maintenant ? [O/n] ' r
if [[ ! "$r" =~ ^[nN] ]]; then
  gnome-session-quit --logout --no-prompt 2>/dev/null || loginctl terminate-user "$USER"
else
  read -r -p "  Redémarrer l'ordinateur à la place ? [o/N] " r2
  if [[ "$r2" =~ ^[oOyY] ]]; then systemctl reboot; else warn "OK, déconnecte-toi quand tu veux."; fi
fi
