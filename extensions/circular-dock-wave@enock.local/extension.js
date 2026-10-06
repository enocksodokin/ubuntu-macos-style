/* ENOCK_PHASE14_LOADER
 *
 * Petit chargeur : le vrai code est dans wave.js, rechargé à chaque
 * activation (cache-busting). Un simple désactiver/activer suffit donc
 * à tester une modification, sans se déconnecter de la session.
 */

import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DockWaveLoader extends Extension {
    enable() {
        this._token = {};
        const token = this._token;

        import(`file://${this.path}/wave.js?v=${GLib.get_monotonic_time()}`)
            .then(({WaveController}) => {
                if (this._token !== token)
                    return;

                this._controller = new WaveController(this);
                this._controller.enable();
            })
            .catch(error => {
                console.error(`[FixedTrayWave] chargement impossible: ${error}\n${error.stack}`);
            });
    }

    disable() {
        this._token = null;
        this._controller?.disable();
        this._controller = null;
    }
}
