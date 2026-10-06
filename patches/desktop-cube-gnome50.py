#!/usr/bin/env python3
"""Correctif Desktop Cube pour GNOME Shell 50 (idempotent, sans risque).

1. SwipeTracker._endGesture a change de signature en GNOME 50 : (time, ...) -> (velocity, ...).
   Le cube injectait la vitesse comme un timestamp dans l'historique du geste.
2. Un 'end' en double pendant la fermeture de l'overview provoque
   "Invalid overview shown transition" ; on ignore ces transitions redondantes.

Si le code amont a change (ou est deja corrige), le script ne touche a rien.
"""
import sys, pathlib

p = pathlib.Path(sys.argv[1]) / "extension.js"
s = p.read_text()

if "LOCAL FIX (GNOME 50)" in s:
    print("cube: deja corrige"); sys.exit(0)

old = """    SwipeTracker.prototype._endGesture = function(time, distance, isTouchpad) {
      // Add a final time step to the history.
      this._history.append(time, 0);

      // Then call the original method.
      extensionThis._origEndGesture.apply(this, [time, distance, isTouchpad]);
    };
"""
new = """    // LOCAL FIX (GNOME 50): the stock signature changed from (time, distance, isTouchpad)
    // to (velocity, distance, isTouchpad). Appending `velocity` to the history as if it were
    // a timestamp corrupts later swipes, so only do this on older shells.
    SwipeTracker.prototype._endGesture = function(arg, distance, isTouchpad) {
      if (GS_VERSION < 50) {
        // Add a final time step to the history.
        this._history.append(arg, 0);
      }

      // Then call the original method.
      extensionThis._origEndGesture.apply(this, [arg, distance, isTouchpad]);
    };

    // LOCAL FIX: a duplicate 'end' reaching the overview while it is already HIDING/HIDDEN
    // throws "Invalid overview shown transition". Ignore such redundant transitions.
    this._origChangeShownState = Main.overview._changeShownState;
    Main.overview._changeShownState = function(state) {
      try {
        return extensionThis._origChangeShownState.call(this, state);
      } catch (e) {
        if (String(e.message).startsWith('Invalid overview shown transition'))
          console.warn(`[desktop-cube] ignored: ${e.message}`);
        else
          throw e;
      }
    };
"""
restore_old = "    SwipeTracker.prototype._endGesture              = this._origEndGesture;\n"
restore_new = restore_old + ("    if (this._origChangeShownState) {\n"
                             "      delete Main.overview._changeShownState;\n"
                             "      this._origChangeShownState = null;\n    }\n")

if old not in s or restore_old not in s:
    print("cube: code amont different, correctif ignore (rien modifie)"); sys.exit(0)

p.write_text(s.replace(old, new).replace(restore_old, restore_new))
print("cube: correctif GNOME 50 applique")
