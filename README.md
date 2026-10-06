# Ubuntu → macOS 🍎

Transforme ton Ubuntu en bureau façon macOS **en une commande** : thème WhiteSur, icônes, curseurs,
dock animé, barre du haut, flou, effets de fenêtres, cube 3D, widgets de bureau.

> *Turn Ubuntu into a macOS-style desktop with one command. Tested on Ubuntu 26.04 / GNOME Shell 50, Wayland.*

## Installer

```bash
git clone https://github.com/enocksodokin/ubuntu-macos-style.git
cd ubuntu-macos-style
./install.sh
```

Le script :

1. installe les paquets nécessaires (demande ton mot de passe `sudo` une fois) ;
2. **sauvegarde tes réglages actuels** ;
3. télécharge le thème, les icônes, les curseurs et les extensions depuis leurs **sources officielles**, à une version précise ;
4. applique mes réglages ;
5. te propose de te **déconnecter** (puis de **redémarrer** si tu préfères) pour afficher le résultat.

> ⚠️ Sauvegarde ton travail avant de répondre « oui » à la déconnexion.

Après la reconnexion, tu peux vérifier que tout est chargé : `./scripts/check.sh`

### Options

| Option | Effet |
|---|---|
| `--yes` | pas de questions, pas de déconnexion automatique |
| `--no-apt` | n'installe aucun paquet (tu as déjà tout) |
| `--no-restart` | ne propose pas de se déconnecter |
| `--keep-wallpaper` | garde ton fond d'écran |
| `--force` | continue même si ta version de GNOME Shell n'est pas la 50 |

## Revenir en arrière

```bash
./uninstall.sh
```

Restaure les réglages d'avant l'installation (thème, extensions actives, fond d'écran, etc.),
remet en place les extensions que tu avais déjà, puis supprime ce qui a été installé.
Déconnecte-toi ensuite pour finir le retour en arrière.

## Ce qui est installé

- **Thème** WhiteSur sombre, accent bleu (GTK et applications libadwaita), **icônes** et **curseurs** WhiteSur
- **Dash to Dock** + **Blur my Shell** (dock en bas, flou)
- **Lintel** : barre du haut façon macOS
- **Compiz windows effect** (fenêtres « gélatineuses ») et **Magic lamp** (minimisation en lampe)
- **Desktop Cube** : bureaux virtuels en cube 3D, avec un correctif pour GNOME 50 (voir `patches/`)
- **Desktop Widgets** : widgets sur le bureau
- 3 extensions maison : `circular-dock-wave`, `professional-dashboard`, `smart-phase11`

Le détail des projets tiers et de leurs licences est dans [`THIRD-PARTY.md`](THIRD-PARTY.md).

## Compatibilité et limites

- Testé sur **Ubuntu 26.04, GNOME Shell 50.1, Wayland**. Les extensions maison ne déclarent que la version 50 :
  sur une autre version, il faut `--force`, sans garantie.
- Sous Wayland, GNOME ne charge les extensions qu'**après une reconnexion** : c'est normal.
- Les extensions de bureau modifient beaucoup le shell. Si l'une d'elles pose problème,
  désactive-la avec l'application *Extensions*, ou lance `./uninstall.sh`.
- Le fond d'écran installé est le fond officiel WhiteSur.

## Licence

MIT pour le code de ce repo (voir [`LICENSE`](LICENSE)). Les projets tiers gardent leur propre licence.
