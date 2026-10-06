import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ROWS = [
    ['max-scale', 'Zoom maximal', 'Facteur d\'agrandissement de l\'icône sous la souris', 1.0, 2.5, 0.01, 2],
    ['wave-radius', 'Rayon de la vague', 'Distance (px) sur laquelle les voisines grossissent', 40, 500, 5, 0],
    ['spread', 'Écartement', 'Décalage latéral (px) des icônes voisines', 0, 20, 0.5, 1],
    ['follow-ms', 'Souplesse du suivi', 'En ms. 0 = instantané, plus grand = plus doux', 0, 300, 5, 0],
    ['restore-ms', 'Durée du retour', 'En ms. Vitesse de retour à la taille normale', 0, 500, 5, 0],
];

export default class DockWavePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Vague du dock',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Effet vague',
            description: 'Les changements s\'appliquent immédiatement.',
        });
        page.add(group);

        for (const [key, title, subtitle, lower, upper, step, digits] of ROWS) {
            const row = new Adw.SpinRow({
                title,
                subtitle,
                digits,
                adjustment: new Gtk.Adjustment({
                    lower,
                    upper,
                    step_increment: step,
                    page_increment: step * 10,
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
        }

        const resetGroup = new Adw.PreferencesGroup();
        page.add(resetGroup);

        const resetRow = new Adw.ActionRow({title: 'Valeurs par défaut'});
        const button = new Gtk.Button({
            label: 'Réinitialiser',
            valign: Gtk.Align.CENTER,
        });
        button.connect('clicked', () => {
            for (const [key] of ROWS)
                settings.reset(key);
        });
        resetRow.add_suffix(button);
        resetGroup.add(resetRow);
    }
}
