#!/usr/bin/env bash
# À lancer après la reconnexion : vérifie que tout est bien chargé.
bad=0
for e in $(gsettings get org.gnome.shell enabled-extensions | tr -d "[]',"); do
  s=$(gnome-extensions info "$e" 2>/dev/null | awk '/State:/{print $2}')
  printf '%-58s %s\n' "$e" "${s:-ABSENT}"
  [ "$s" = "ACTIVE" ] || bad=1
done
echo; gsettings get org.gnome.desktop.interface gtk-theme; gsettings get org.gnome.desktop.interface icon-theme
[ $bad -eq 0 ] && echo "✓ Tout est actif" || echo "! Certaines extensions ne sont pas ACTIVE (reconnecte-toi, sinon: journalctl --user -b | grep -i 'JS ERROR')"
