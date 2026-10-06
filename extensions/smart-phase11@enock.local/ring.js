/*
 * Sélecteur de fenêtres en anneau : les fenêtres sont posées sur une ellipse
 * centrée à l'écran. La fenêtre choisie est devant (grande), les autres
 * tournent derrière (plus petites, plus transparentes).
 *
 * Tout le style est en ligne (pas de dépendance à la feuille de style).
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PREVIEW_W = 416;
const PREVIEW_H = 244;
const HEADER_H = 22;
const CARD_PAD = 12;
const CARD_W = PREVIEW_W + CARD_PAD * 2;
const CARD_H = HEADER_H + 10 + PREVIEW_H + CARD_PAD * 2;

const MIN_SCALE = 0.5;
const MIN_OPACITY = 80;

const TICK_MS = 16;
const FOLLOW_TAU = 75;      // ms : rotation de l'anneau
const DRAG_TAU = 35;        // ms : pendant le glissement des doigts
const INTRO_TAU = 85;       // ms : ouverture / fermeture
const REST_EPSILON = 0.002;

const STYLE_CARD =
    'background-color: rgba(26,30,40,0.80);' +
    'border: 2px solid rgba(255,255,255,0.14);' +
    'border-radius: 20px;' +
    `padding: ${CARD_PAD}px;` +
    'box-shadow: 0 18px 44px rgba(0,0,0,0.45);';

const STYLE_CARD_SELECTED =
    'background-color: rgba(30,36,50,0.92);' +
    'border: 2px solid rgba(73,181,255,0.95);' +
    'border-radius: 20px;' +
    `padding: ${CARD_PAD}px;` +
    'box-shadow: 0 0 0 4px rgba(73,181,255,0.20), 0 24px 56px rgba(0,0,0,0.55);';

function ellipsize(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nowMs() {
    return GLib.get_monotonic_time() / 1000;
}

export class WindowRing {
    /*
     * windows    : liste de Meta.Window
     * monitor    : {x, y, width, height}
     * onActivate : (win) => void, appelé quand on choisit une fenêtre
     * onClose    : () => void, appelé dès que la fermeture commence
     */
    constructor({windows, monitor, onActivate, onClose}) {
        this._windows = windows.slice();
        this._monitor = monitor;
        this._onActivate = onActivate;
        this._onClose = onClose;
        this._closeNotified = false;

        this._items = [];
        this._overlay = null;
        this._backdrop = null;

        this._pos = 0;          // position continue de l'anneau (en « places »)
        this._target = 0;       // position visée
        this._drag = 0;         // décalage en cours de glissement (en places)
        this._intro = 0;        // 0 = replié au centre, 1 = déployé
        this._introTarget = 1;
        this._closing = false;
        this._tickId = 0;
        this._last = 0;
        this._shownIndex = -1;
        this._scrollAcc = 0;
        this._destroyed = false;
    }

    get visible() {
        return Boolean(this._overlay) && !this._closing;
    }

    open() {
        const m = this._monitor;

        this._overlay = new St.Widget({
            reactive: true,
            can_focus: true,
            layout_manager: new Clutter.FixedLayout(),
            x: m.x,
            y: m.y,
            width: m.width,
            height: m.height,
        });

        this._backdrop = new St.Widget({
            style: 'background-color: rgba(8,10,16,0.55);',
            x: 0,
            y: 0,
            width: m.width,
            height: m.height,
            opacity: 0,
        });

        try {
            this._backdrop.add_effect(new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius: 30,
                brightness: 0.8,
            }));
        } catch (_) {
            /* Pas de flou disponible : l'assombrissement suffit. */
        }

        this._overlay.add_child(this._backdrop);

        for (const win of this._windows) {
            const card = this._buildCard(win);

            if (!card)
                continue;

            this._items.push({win, card});
            this._overlay.add_child(card);
        }

        if (!this._items.length) {
            this.destroy();
            return false;
        }

        const centered = (text, style, y) => {
            const label = new St.Label({text, style, x_align: Clutter.ActorAlign.CENTER, x_expand: true});
            const row = new St.BoxLayout({width: m.width, x: 0, y});

            row.add_child(label);
            this._overlay.add_child(row);

            return {row, label};
        };

        const title = centered('', 'color: white; font-size: 22px; font-weight: 700;', 0);
        const subtitle = centered('', 'color: rgba(255,255,255,0.65); font-size: 13px;', 0);
        const hint = centered(
            'Trois doigts ◀ ▶  ·  Entrée : ouvrir  ·  Suppr : fermer la fenêtre  ·  Échap : quitter',
            'color: rgba(255,255,255,0.45); font-size: 12px;',
            m.height - 64
        );

        this._titleRow = title.row;
        this._titleLabel = title.label;
        this._subtitleRow = subtitle.row;
        this._subtitleLabel = subtitle.label;
        this._hintRow = hint.row;
        this._hintLabel = hint.label;

        this._overlay.connect('key-press-event', (_a, event) => this._onKey(event));
        this._overlay.connect('scroll-event', (_a, event) => this._onScroll(event));
        this._overlay.connect('button-press-event', (_a, event) => {
            const source = event.get_source();

            if (source === this._overlay || source === this._backdrop)
                this.close();

            return Clutter.EVENT_STOP;
        });

        Main.uiGroup.add_child(this._overlay);
        Main.uiGroup.set_child_above_sibling(this._overlay, null);
        Main.uiGroup.queue_relayout();

        try {
            global.stage.set_key_focus(this._overlay);
        } catch (_) {}

        this._updateLabels(true);
        this._layout();
        this._startTicking();

        return true;
    }

    /* ------------------------------------------------------------ */
    /* Construction d'une carte                                        */
    /* ------------------------------------------------------------ */

    _buildCard(win) {
        const card = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: CARD_W,
            height: CARD_H,
            style: STYLE_CARD,
        });
        card.set_pivot_point(0.5, 0.5);

        const box = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            style: 'spacing: 10px;',
        });

        let app = null;

        try {
            app = Shell.WindowTracker.get_default().get_window_app(win);
        } catch (_) {}

        const header = new St.BoxLayout({style: 'spacing: 8px;', height: HEADER_H});

        try {
            const appIcon = app?.create_icon_texture(HEADER_H);

            if (appIcon)
                header.add_child(appIcon);
        } catch (_) {}

        let title = '';

        try {
            title = win.get_title() || app?.get_name() || win.get_wm_class() || 'Fenêtre';
        } catch (_) {
            title = 'Fenêtre';
        }

        header.add_child(new St.Label({
            text: ellipsize(title, 42),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'color: rgba(255,255,255,0.95); font-size: 13px; font-weight: 650;',
        }));
        box.add_child(header);

        const preview = new St.Bin({
            width: PREVIEW_W,
            height: PREVIEW_H,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'background-color: rgba(0,0,0,0.30); border-radius: 12px;',
        });

        try {
            const actor = win.get_compositor_private();
            const [aw, ah] = actor.get_size();

            if (aw > 0 && ah > 0) {
                const k = Math.min((PREVIEW_W - 8) / aw, (PREVIEW_H - 8) / ah);
                const clone = new Clutter.Clone({source: actor, reactive: false});

                clone.set_size(Math.round(aw * k), Math.round(ah * k));
                preview.set_child(clone);
            }
        } catch (_) {}

        box.add_child(preview);
        card.set_child(box);

        card.connect('clicked', () => this._activate(win));

        card._title = title;
        card._appName = app?.get_name?.() ?? '';

        return card;
    }

    /* ------------------------------------------------------------ */
    /* Géométrie de l'anneau                                          */
    /* ------------------------------------------------------------ */

    _selectedIndex() {
        const n = this._items.length;

        if (!n)
            return 0;

        return ((Math.round(this._target) % n) + n) % n;
    }

    _layout() {
        if (!this._overlay)
            return;

        const m = this._monitor;
        const n = this._items.length;

        if (!n)
            return;

        const cx = m.width / 2;
        const cy = m.height * 0.43;
        const rx = Math.min(m.width * 0.31, 580);
        const ry = Math.min(m.height * 0.12, 110);

        const spacing = (2 * Math.PI) / n;
        const k = this._intro;
        const selected = this._selectedIndex();
        const order = [];

        this._items.forEach((item, i) => {
            let rel = i - this._pos;

            if (n > 1) {
                rel = ((rel % n) + n) % n;

                if (rel > n / 2)
                    rel -= n;
            }

            const theta = rel * spacing;
            const depth = Math.cos(theta);       // 1 = devant, -1 = derrière
            const f = (depth + 1) / 2;           // 0..1

            const scale = (MIN_SCALE + (1 - MIN_SCALE) * Math.pow(f, 0.9)) * (0.55 + 0.45 * k);
            const x = cx + rx * Math.sin(theta) * k;
            const y = cy + ry * depth * k + (1 - k) * 40;

            const card = item.card;

            card.set_position(Math.round(x - CARD_W / 2), Math.round(y - CARD_H / 2));
            card.set_scale(scale, scale);
            card.opacity = Math.round(k * (MIN_OPACITY + (255 - MIN_OPACITY) * Math.pow(f, 1.2)));

            try {
                card.rotation_angle_y = -Math.sin(theta) * 14;
            } catch (_) {}

            const isSelected = i === selected;

            if (card._selected !== isSelected) {
                card._selected = isSelected;
                card.set_style(isSelected ? STYLE_CARD_SELECTED : STYLE_CARD);
            }

            order.push([depth, card]);
        });

        /* Les cartes de devant se dessinent par-dessus celles de derrière. */
        order.sort((a, b) => a[0] - b[0]);

        for (const [, card] of order)
            this._overlay.set_child_above_sibling(card, null);

        for (const row of [this._titleRow, this._subtitleRow, this._hintRow])
            this._overlay.set_child_above_sibling(row, null);

        const labelsY = cy + ry + (CARD_H / 2) + 26;

        this._titleRow.y = Math.round(labelsY);
        this._subtitleRow.y = Math.round(labelsY + 34);

        const fade = Math.min(1, k * 1.2);

        this._backdrop.opacity = Math.round(255 * fade);
        this._titleRow.opacity = Math.round(255 * fade);
        this._subtitleRow.opacity = Math.round(255 * fade);
        this._hintRow.opacity = Math.round(255 * fade);

        this._updateLabels(false);
    }

    _updateLabels(force) {
        const index = this._selectedIndex();

        if (!force && index === this._shownIndex)
            return;

        this._shownIndex = index;

        const item = this._items[index];

        if (!item)
            return;

        this._titleLabel.text = ellipsize(item.card._title, 64);
        this._subtitleLabel.text =
            `${item.card._appName ? `${item.card._appName}  ·  ` : ''}${index + 1} / ${this._items.length}`;
    }

    /* ------------------------------------------------------------ */
    /* Animation                                                       */
    /* ------------------------------------------------------------ */

    _startTicking() {
        if (this._tickId || this._destroyed)
            return;

        this._last = nowMs();

        this._tickId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            TICK_MS,
            () => this._tick()
        );
    }

    _tick() {
        if (this._destroyed || !this._overlay) {
            this._tickId = 0;
            return GLib.SOURCE_REMOVE;
        }

        const now = nowMs();
        const dt = Math.min(50, Math.max(1, now - this._last));
        this._last = now;

        const effective = this._target - this._drag;
        const posTau = this._drag !== 0 ? DRAG_TAU : FOLLOW_TAU;

        this._pos += (effective - this._pos) * (1 - Math.exp(-dt / posTau));
        this._intro += (this._introTarget - this._intro) * (1 - Math.exp(-dt / INTRO_TAU));

        const atRest =
            Math.abs(effective - this._pos) < REST_EPSILON &&
            Math.abs(this._introTarget - this._intro) < REST_EPSILON;

        if (atRest) {
            this._pos = effective;
            this._intro = this._introTarget;
        }

        this._layout();

        if (!atRest)
            return GLib.SOURCE_CONTINUE;

        this._tickId = 0;

        if (this._closing)
            this.destroy();

        return GLib.SOURCE_REMOVE;
    }

    /* ------------------------------------------------------------ */
    /* Commandes                                                       */
    /* ------------------------------------------------------------ */

    /* Glissement des doigts : offset en « places » (+ = vers la droite). */
    drag(offset) {
        if (this._closing)
            return;

        this._drag = Math.max(-1.25, Math.min(1.25, offset));
        this._startTicking();
    }

    release() {
        this._drag = 0;
        this._startTicking();
    }

    select(delta) {
        if (this._closing || !this._items.length)
            return;

        this._target += delta;
        this._drag = 0;
        this._startTicking();
    }

    _activate(win) {
        this.close();
        this._onActivate?.(win);
    }

    activateSelected() {
        const item = this._items[this._selectedIndex()];

        if (item)
            this._activate(item.win);
    }

    closeSelectedWindow() {
        const index = this._selectedIndex();
        const item = this._items[index];

        if (!item)
            return;

        try {
            item.win.delete(global.get_current_time());
        } catch (_) {}

        try {
            item.card.destroy();
        } catch (_) {}

        this._items.splice(index, 1);

        if (!this._items.length) {
            this.close();
            return;
        }

        const next = Math.min(index, this._items.length - 1);

        this._pos = this._target = next;
        this._drag = 0;
        this._updateLabels(true);
        this._startTicking();
    }

    _notifyClose() {
        if (this._closeNotified)
            return;

        this._closeNotified = true;
        this._onClose?.();
    }

    close(immediate = false) {
        this._notifyClose();

        if (this._destroyed)
            return;

        if (immediate || !this._overlay) {
            this.destroy();
            return;
        }

        if (this._closing)
            return;

        this._closing = true;
        this._introTarget = 0;
        this._drag = 0;
        this._startTicking();
    }

    destroy() {
        if (this._destroyed)
            return;

        this._notifyClose();
        this._destroyed = true;

        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }

        try {
            this._overlay?.destroy();
        } catch (_) {}

        this._overlay = null;
        this._backdrop = null;
        this._items = [];
    }

    /* ------------------------------------------------------------ */
    /* Clavier et molette                                              */
    /* ------------------------------------------------------------ */

    _onKey(event) {
        const symbol = event.get_key_symbol();
        const shift = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);

        switch (symbol) {
        case Clutter.KEY_Left:
        case Clutter.KEY_a:
            this.select(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Right:
        case Clutter.KEY_d:
            this.select(1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Tab:
            this.select(shift ? -1 : 1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_ISO_Left_Tab:
            this.select(-1);
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
        case Clutter.KEY_space:
            this.activateSelected();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Delete:
            this.closeSelectedWindow();
            return Clutter.EVENT_STOP;

        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;

        default:
            return Clutter.EVENT_STOP;
        }
    }

    _onScroll(event) {
        let step = 0;

        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            step = -1;
            break;

        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            step = 1;
            break;

        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();

            this._scrollAcc += Math.abs(dx) > Math.abs(dy) ? dx : dy;

            if (Math.abs(this._scrollAcc) >= 1.5) {
                step = this._scrollAcc > 0 ? 1 : -1;
                this._scrollAcc = 0;
            }

            break;
        }

        default:
            break;
        }

        if (step)
            this.select(step);

        return Clutter.EVENT_STOP;
    }
}
