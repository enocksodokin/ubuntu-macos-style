/* ENOCK_PHASE14_REAL_ICONS */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

const D2D_UUID = 'dash-to-dock@micxgx.gmail.com';

const POINTER_PAD_X = 30;
const POINTER_PAD_TOP = 58;
const POINTER_PAD_BOTTOM = 34;

const TICK_MS = 16;
const REST_EPSILON = 0.002;
const GEOMETRY_THROTTLE_MS = 200;

const SETTINGS_KEYS = {
    'max-scale': 'maxScale',
    'wave-radius': 'radius',
    'spread': 'spread',
    'follow-ms': 'followMs',
    'restore-ms': 'restoreMs',
};

function alive(actor) {
    try {
        return Boolean(actor) && !actor.is_destroyed?.();
    } catch (_) {
        return false;
    }
}

function childrenOf(actor) {
    try {
        return actor.get_children?.() ?? [];
    } catch (_) {
        return [];
    }
}

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

/*
 * Dash to Dock v109 :
 * les vrais DockAppIcon possèdent this.icon._iconBin.
 * On descend dans l'arbre jusqu'à le trouver.
 */
function findIconVisual(root) {
    const queue = [root];
    const visited = new Set();

    while (queue.length) {
        const actor = queue.shift();

        if (!alive(actor) || visited.has(actor))
            continue;

        visited.add(actor);

        const delegate = actor._delegate ?? null;

        const candidates = [
            actor?.icon?._iconBin,
            actor?._iconBin,
            delegate?.icon?._iconBin,
            delegate?._iconBin,
        ];

        for (const candidate of candidates) {
            if (alive(candidate))
                return candidate;
        }

        for (const child of childrenOf(actor))
            queue.push(child);
    }

    return null;
}

function looksLikeSeparator(actor) {
    let id = '';

    try {
        id = `${actor.get_style_class_name?.() ?? ''} ${actor.name ?? ''}`
            .toLowerCase();
    } catch (_) {}

    return (
        id.includes('separator') ||
        id.includes('placeholder') ||
        id.includes('spacer') ||
        id.includes('empty-drop-target')
    );
}

/*
 * Un DockWaveContext gère UN dock.
 *
 * Ce sont les VRAIES icônes (DockAppIcon._iconBin) qui sont agrandies,
 * avec un pivot en bas au centre : elles poussent vers le haut.
 * Le plateau du dock n'est jamais transformé.
 *
 * Pour que l'icône agrandie ne soit pas coupée, le clip de Dash to Dock
 * est levé tant que la vague est active, puis restauré au repos.
 */
class DockWaveContext {
    constructor(dock, cfg) {
        this.dock = dock;
        this.cfg = cfg;
        this.box = dock?.dash?._box ?? null;

        this.entries = [];
        this.bounds = null;
        this.lastGeometryAt = 0;

        this.signals = [];
        this.refreshId = 0;
        this.tickId = 0;
        this.lastTick = 0;

        this.active = false;   // vague en cours (clip levé)
        this.inside = false;   // le pointeur est dans la zone du dock
        this.pointerX = 0;

        this.dead = false;

        if (!alive(this.box))
            return;

        /* is_destroyed() n'existe pas en GJS : on suit le signal « destroy ». */
        this._connect(this.dock, 'destroy', () => {
            this.dead = true;
        });
        this._connect(this.box, 'destroy', () => {
            this.dead = true;
        });

        const onChange = () => {
            this.hideWave(true);
            this.scheduleRefresh(80);
        };

        this._connect(this.box, 'child-added', onChange);
        this._connect(this.box, 'child-removed', onChange);
        this._connect(this.dock, 'showing', () => this.scheduleRefresh(90));
        this._connect(this.dock, 'hiding', () => this.hideWave(true));

        this.refreshGeometry();
    }

    _connect(actor, signal, callback) {
        try {
            const record = {actor, id: actor.connect(signal, callback), gone: false};

            if (signal !== 'destroy') {
                record.goneId = actor.connect('destroy', () => {
                    record.gone = true;
                });
            }

            this.signals.push(record);
        } catch (_) {}
    }

    /* ------------------------------------------------------------ */
    /* Géométrie (mise en cache)                                      */
    /* ------------------------------------------------------------ */

    scheduleRefresh(delay = 60) {
        if (this.refreshId)
            GLib.source_remove(this.refreshId);

        this.refreshId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            delay,
            () => {
                this.refreshId = 0;

                if (this.active)
                    this.hideWave(true);

                this.refreshGeometry();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /*
     * Seuls les `item` (conteneurs d'icônes) servent à mesurer :
     * ils ne sont jamais transformés, donc la mesure reste juste
     * même pendant que les `_iconBin` sont agrandis.
     */
    refreshGeometry() {
        this.lastGeometryAt = nowMs();

        if (!alive(this.box))
            return;

        for (const old of this.entries)
            this._resetEntry(old);

        const entries = [];

        for (const item of childrenOf(this.box)) {
            if (!alive(item) || !item.visible)
                continue;

            if (looksLikeSeparator(item))
                continue;

            const visual = findIconVisual(item);

            if (!alive(visual))
                continue;

            try {
                const [ix, iy] = item.get_transformed_position();
                const [iw, ih] = item.get_transformed_size();

                if (iw <= 0 || ih <= 0)
                    continue;

                entries.push({
                    item,
                    visual,
                    cx: ix + iw / 2,
                    x1: ix,
                    x2: ix + iw,
                    y1: iy,
                    y2: iy + ih,
                    weight: 0,
                    modified: false,
                    origPivot: null,
                });
            } catch (_) {}
        }

        this.entries = entries;

        if (!entries.length) {
            this.bounds = null;
            return;
        }

        this.bounds = {
            x1: Math.min(...entries.map(e => e.x1)) - POINTER_PAD_X,
            x2: Math.max(...entries.map(e => e.x2)) + POINTER_PAD_X,
            y1: Math.min(...entries.map(e => e.y1)) - POINTER_PAD_TOP,
            y2: Math.max(...entries.map(e => e.y2)) + POINTER_PAD_BOTTOM,
        };
    }

    containsPointer(x, y) {
        const b = this.bounds;

        return Boolean(b) &&
            x >= b.x1 && x <= b.x2 &&
            y >= b.y1 && y <= b.y2;
    }

    /* ------------------------------------------------------------ */
    /* Application de la vague sur les vraies icônes                  */
    /* ------------------------------------------------------------ */

    /*
     * St.ScrollView (et d'autres conteneurs de Dash to Dock) coupent tout ce
     * qui dépasse de leur cadre, quoi qu'on désactive. On sort donc la VRAIE
     * icône du dock pendant la vague : elle est posée dans uiGroup, à la
     * position exacte de l'icône, et un espace vide de même taille garde sa
     * place dans le dock (rien ne bouge). Elle est remise en place ensuite.
     */
    _lift(entry) {
        const visual = entry.visual;
        const parent = visual.get_parent();

        if (!alive(parent) || this.dead)
            throw new Error('icône sans parent');

        const [vx, vy] = visual.get_transformed_position();
        const [vw, vh] = visual.get_transformed_size();

        const placeholder = new St.Widget({
            width: Math.round(vw),
            height: Math.round(vh),
            reactive: false,
        });

        const index = parent.get_children().indexOf(visual);

        parent.insert_child_at_index(placeholder, index);
        parent.remove_child(visual);

        Main.uiGroup.add_child(visual);
        visual.set_position(vx, vy);
        visual.set_size(vw, vh);

        /* Sans cela, GNOME n'attribue jamais de place à l'icône : elle reste invisible. */
        Main.uiGroup.queue_relayout();

        entry.lift = {parent, placeholder};
    }

    _drop(entry) {
        const lift = entry.lift;

        if (!lift)
            return;

        entry.lift = null;

        const visual = entry.visual;

        try {
            if (this.dead) {
                /* Le dock a disparu : l'icône sortie n'a plus de foyer. */
                if (visual.get_parent() === Main.uiGroup) {
                    Main.uiGroup.remove_child(visual);
                    visual.destroy();
                }

                return;
            }

            if (visual.get_parent() === Main.uiGroup)
                Main.uiGroup.remove_child(visual);

            if (
                alive(lift.parent) &&
                lift.placeholder.get_parent() === lift.parent
            ) {
                const index = lift.parent.get_children().indexOf(lift.placeholder);

                lift.parent.insert_child_at_index(visual, index);
            }

            visual.set_size(-1, -1);
            visual.fixed_position_set = false;
        } catch (_) {
            /* Rien à faire de plus : le dock se reconstruira. */
        } finally {
            try {
                lift.placeholder.get_parent()?.remove_child(lift.placeholder);
                lift.placeholder.destroy();
            } catch (_) {}
        }
    }

    _applyEntry(entry, weight) {
        const visual = entry.visual;

        if (this.dead || !alive(visual))
            return;

        if (!entry.modified) {
            try {
                entry.origPivot = visual.get_pivot_point();
                this._lift(entry);
                visual.set_pivot_point(0.5, 1.0);
                entry.modified = true;
            } catch (_) {
                this._drop(entry);
                return;
            }
        }

        const placeholder = entry.lift?.placeholder;

        if (placeholder) {
            const [px, py] = placeholder.get_transformed_position();

            if (
                Number.isFinite(px) && Number.isFinite(py) &&
                (Math.abs(px - visual.x) > 0.5 || Math.abs(py - visual.y) > 0.5)
            )
                visual.set_position(px, py);
        }

        const scale = 1 + (this.cfg.maxScale - 1) * weight;

        const direction =
            entry.cx < this.pointerX ? -1 :
            entry.cx > this.pointerX ? 1 : 0;

        visual.scale_x = scale;
        visual.scale_y = scale;
        visual.translation_x = direction * this.cfg.spread * weight;
    }

    _resetEntry(entry) {
        entry.weight = 0;

        if (!entry.modified)
            return;

        entry.modified = false;

        if (this.dead) {
            this._drop(entry);
            return;
        }

        const visual = entry.visual;

        try {
            visual.scale_x = 1;
            visual.scale_y = 1;
            visual.translation_x = 0;

            if (entry.origPivot) {
                visual.set_pivot_point(
                    entry.origPivot[0],
                    entry.origPivot[1]
                );
            }
        } catch (_) {}

        this._drop(entry);
        entry.origPivot = null;
    }

    _targetWeight(entry) {
        if (!this.inside)
            return 0;

        const distance = Math.abs(entry.cx - this.pointerX);
        const radius = this.cfg.radius;

        if (distance >= radius)
            return 0;

        /* Demi-cosinus : 1 au centre, 0 au bord du rayon. */
        return 0.5 * (1 + Math.cos(Math.PI * distance / radius));
    }

    /* ------------------------------------------------------------ */
    /* Boucle d'animation                                             */
    /* ------------------------------------------------------------ */

    _dockShown() {
        const slide = this.dock?._slider?.slideX;

        return slide === undefined || slide >= 0.99;
    }

    updatePointer(x, y) {
        if (this.dead)
            return false;

        if (!this._dockShown()) {
            if (this.active)
                this.hideWave(true);

            return false;
        }

        if (!this.active && nowMs() - this.lastGeometryAt > GEOMETRY_THROTTLE_MS)
            this.refreshGeometry();

        const inside = this.containsPointer(x, y) && this.entries.length > 0;

        if (!inside && !this.active)
            return false;

        this.pointerX = x;
        this.inside = inside;

        if (inside && !this.active)
            this.active = true;

        this._startTicking();
        return inside;
    }

    _startTicking() {
        if (this.tickId)
            return;

        this.lastTick = nowMs();

        this.tickId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TICK_MS,
            () => this._tick()
        );
    }

    _tick() {
        if (this.dead) {
            this.tickId = 0;
            return GLib.SOURCE_REMOVE;
        }

        const now = nowMs();
        const dt = Math.min(50, Math.max(1, now - this.lastTick));
        this.lastTick = now;

        const tau = this.inside ? this.cfg.followMs : this.cfg.restoreMs;
        const k = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);

        let moving = false;

        for (const entry of this.entries) {
            const target = this._targetWeight(entry);

            entry.weight += (target - entry.weight) * k;

            if (Math.abs(target - entry.weight) > REST_EPSILON)
                moving = true;
            else
                entry.weight = target;

            if (entry.weight <= REST_EPSILON && target === 0)
                this._resetEntry(entry);
            else
                this._applyEntry(entry, entry.weight);
        }

        if (moving)
            return GLib.SOURCE_CONTINUE;

        this.tickId = 0;

        if (!this.inside)
            this._finishRest();

        return GLib.SOURCE_REMOVE;
    }

    /* Tout est revenu à sa taille normale : on rend le clip au dock. */
    _finishRest() {
        for (const entry of this.entries)
            this._resetEntry(entry);

        this.active = false;
    }

    _stopTicking() {
        if (this.tickId) {
            GLib.source_remove(this.tickId);
            this.tickId = 0;
        }
    }

    /*
     * immediate = true  : tout revient tout de suite à la normale.
     * immediate = false : on laisse la boucle ramener doucement les icônes.
     */
    hideWave(immediate = false) {
        this.inside = false;

        if (immediate) {
            this._stopTicking();
            this._finishRest();
            return;
        }

        if (this.active)
            this._startTicking();
    }

    destroy() {
        if (this.refreshId) {
            GLib.source_remove(this.refreshId);
            this.refreshId = 0;
        }

        this._stopTicking();

        if (!this.dead)
            this.hideWave(true);

        for (const record of this.signals) {
            if (record.gone || this.dead)
                continue;

            try {
                record.actor.disconnect(record.id);

                if (record.goneId)
                    record.actor.disconnect(record.goneId);
            } catch (_) {}
        }

        this.signals = [];
        this.entries = [];
        this.bounds = null;
    }
}

export class WaveController {
    constructor(extension) {
        this._extension = extension;
    }

    enable() {
        this._generation = 1;
        this._manager = null;
        this._managerSignals = [];
        this._contexts = [];
        this._attachTimer = 0;

        this._settings = this._extension.getSettings();
        this._cfg = {};
        this._settingsIds = [];

        for (const key of Object.keys(SETTINGS_KEYS)) {
            this._readSetting(key);

            this._settingsIds.push(
                this._settings.connect(
                    `changed::${key}`,
                    () => this._readSetting(key)
                )
            );
        }

        this._stageId = global.stage.connect(
            'captured-event',
            (_stage, event) => {
                let type;

                try {
                    type = event.type();
                } catch (_) {
                    return Clutter.EVENT_PROPAGATE;
                }

                if (type !== Clutter.EventType.MOTION &&
                    type !== Clutter.EventType.LEAVE)
                    return Clutter.EVENT_PROPAGATE;

                let x;
                let y;

                try {
                    [x, y] = event.get_coords();
                } catch (_) {
                    return Clutter.EVENT_PROPAGATE;
                }

                for (const context of this._contexts)
                    context.updatePointer(x, y);

                /* On laisse TOUJOURS passer l'événement (clics, tooltips). */
                return Clutter.EVENT_PROPAGATE;
            }
        );

        Main.extensionManager.connectObject(
            'extension-state-changed',
            (_manager, extension) => {
                if (extension.uuid !== D2D_UUID)
                    return;

                if (
                    this._manager &&
                    extension.state === ExtensionState.ACTIVE
                )
                    return;

                this._detachManager();
                this._scheduleAttach();
            },
            this
        );

        this._attach(this._generation);
    }

    disable() {
        this._generation++;

        if (this._stageId) {
            try {
                global.stage.disconnect(this._stageId);
            } catch (_) {}

            this._stageId = 0;
        }

        Main.extensionManager.disconnectObject(this);

        if (this._attachTimer) {
            GLib.source_remove(this._attachTimer);
            this._attachTimer = 0;
        }

        this._detachManager();

        for (const id of this._settingsIds ?? []) {
            try {
                this._settings.disconnect(id);
            } catch (_) {}
        }

        this._settingsIds = [];
        this._settings = null;
        this._cfg = null;
    }

    _readSetting(key) {
        this._cfg[SETTINGS_KEYS[key]] = this._settings.get_double(key);
    }

    _lookupDockExtension() {
        const extension = Main.extensionManager.lookup(D2D_UUID);

        if (extension?.state === ExtensionState.ACTIVE)
            return extension;

        return null;
    }

    _scheduleAttach() {
        if (this._attachTimer)
            GLib.source_remove(this._attachTimer);

        const generation = ++this._generation;

        this._attachTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            250,
            () => {
                this._attachTimer = 0;
                this._attach(generation);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    async _attach(generation) {
        const extension = this._lookupDockExtension();

        if (!extension) {
            this._scheduleAttach();
            return;
        }

        let module;

        try {
            module = await import(`file://${extension.path}/extension.js`);
        } catch (error) {
            console.error(
                `[FixedTrayWave] impossible d'importer Dash to Dock: ${error}`
            );

            this._scheduleAttach();
            return;
        }

        if (generation !== this._generation)
            return;

        const manager = module.dockManager;

        if (!manager) {
            this._scheduleAttach();
            return;
        }

        this._manager = manager;

        try {
            this._managerSignals.push(
                manager.connect('docks-ready', () => this._scanDocks())
            );

            this._managerSignals.push(
                manager.connect('destroy', () => this._detachManager())
            );
        } catch (_) {}

        this._scanDocks();
    }

    _scanDocks() {
        this._destroyContexts();

        if (!this._manager)
            return;

        const docks = this._manager._allDocks ?? [];

        for (const dock of docks) {
            const context = new DockWaveContext(dock, this._cfg);

            if (alive(context.box))
                this._contexts.push(context);
        }

        console.log(
            `[FixedTrayWave] ${this._contexts.length} dock(s) attaché(s) (vraies icônes).`
        );
    }

    _destroyContexts() {
        for (const context of this._contexts)
            context.destroy();

        this._contexts = [];
    }

    _detachManager() {
        this._destroyContexts();

        if (!this._manager)
            return;

        for (const id of this._managerSignals) {
            try {
                this._manager.disconnect(id);
            } catch (_) {}
        }

        this._managerSignals = [];
        this._manager = null;
    }
}
