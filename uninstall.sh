#!/usr/bin/env bash
# Annule l'installation : restaure tes réglages d'avant et retire ce que le repo a installé.
set -Eeuo pipefail
STATE_DIR="$HOME/.local/state/ubuntu-macos-style"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions"
BACKUP="${1:-$STATE_DIR/original}"
[ -d "$BACKUP/dconf" ] || { echo "Aucune sauvegarde trouvée dans $BACKUP" >&2; exit 1; }
BACKUP="$(readlink -f "$BACKUP")"

echo "▶ Désactivation des extensions installées"
EXTS=(dash-to-dock@micxgx.gmail.com blur-my-shell@aunetx compiz-windows-effect@hermes83.github.com
      compiz-alike-magic-lamp-effect@hermes83.github.com desktop-cube@schneegans.github.com
      desktop-widgets@r3nhick lintel@topbar circular-dock-wave@enock.local
      professional-dashboard@enock.local smart-phase11@enock.local)
for e in "${EXTS[@]}"; do gnome-extensions disable "$e" >/dev/null 2>&1 || true; done

echo "▶ Restauration des réglages depuis $BACKUP"
for f in "$BACKUP"/dconf/*.ini; do
  path="$(basename "$f" .ini | tr '_' '/')"; [[ "$path" == */ ]] || path="$path/"
  dconf reset -f "$path"; dconf load "$path" < "$f"
done

echo "▶ Suppression des fichiers installés"
for e in "${EXTS[@]}"; do rm -rf "${EXT_DIR:?}/$e"; done
rm -rf "$HOME"/.themes/WhiteSur-Dark-blue* "$HOME"/.themes/WhiteSur-Dark-solid-blue* \
       "$HOME"/.local/share/icons/WhiteSur "$HOME"/.local/share/icons/WhiteSur-dark \
       "$HOME"/.local/share/icons/WhiteSur-light "$HOME"/.local/share/icons/WhiteSur-cursors \
       "$HOME"/.local/src/ubuntu-macos-style
# Les extensions que tu avais avant (mises de côté à l'installation) sont remises en place.
if [ -d "$BACKUP/extensions" ]; then
  for d in "$BACKUP"/extensions/*; do [ -e "$d" ] && mv "$d" "$EXT_DIR/"; done
fi
echo "✓ Terminé. Déconnecte-toi puis reconnecte-toi pour finir le retour en arrière."
