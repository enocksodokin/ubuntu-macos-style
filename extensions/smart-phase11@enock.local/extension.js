import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {WindowRing} from './ring.js';

const decoder = new TextDecoder();
const DOWN_THRESHOLD = 80;
const COVER_THRESHOLD = 55;
const COVER_DISTANCE = 220;

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : '';
    } catch (_) { return ''; }
}

function readJSON(path) {
    try {
        const text = readText(path);
        return text ? JSON.parse(text) : null;
    } catch (_) { return null; }
}

function shell(command) {
    try {
        const [ok, out] = GLib.spawn_command_line_sync(command);
        return ok && out ? decoder.decode(out).trim() : '';
    } catch (_) { return ''; }
}

function isWindow(win) {
    if (!win) return false;
    try {
        if (win.skip_taskbar) return false;
        const t = win.get_window_type();
        return [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(t);
    } catch (_) { return false; }
}

function label(text, cls) { return new St.Label({text, style_class: cls}); }
function icon(name, cls) { return new St.Icon({icon_name: name, style_class: cls}); }

export default class SmartPhase11 extends Extension {
    enable() {
        this._weatherPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.cache', 'pro-dashboard', 'weather.json'
        ]);

        this._dx = 0;
        this._dy = 0;
        this._tracking = false;
        this._ring = null;
        this._carouselVisible = false;
        this._lastDesktopWindows = [];

        this._focusModeSeconds = 25 * 60;
        this._focusSeconds = this._focusModeSeconds;
        this._focusRunning = false;
        this._focusTimer = 0;

        this._buildDashboard();
        this._positionDashboard();
        this._updateDashboard();
        this._updateFocusUI();

        this._monitorId = Main.layoutManager.connect('monitors-changed', () => this._positionDashboard());
        this._overviewShowingId = Main.overview.connect('showing', () => this._dashboard?.hide());
        this._overviewHiddenId = Main.overview.connect('hidden', () => this._dashboard?.show());

        this._dashboardTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            this._updateDashboard();
            return GLib.SOURCE_CONTINUE;
        });

        this._capturedId = global.stage.connect('captured-event', (_actor, event) => this._onCapturedEvent(event));
        this._keyId = global.stage.connect('key-press-event', (_actor, event) => {
            if (!this._carouselVisible)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closeCarousel();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    disable() {
        if (this._capturedId) global.stage.disconnect(this._capturedId);
        if (this._keyId) global.stage.disconnect(this._keyId);
        if (this._monitorId) Main.layoutManager.disconnect(this._monitorId);
        if (this._overviewShowingId) Main.overview.disconnect(this._overviewShowingId);
        if (this._overviewHiddenId) Main.overview.disconnect(this._overviewHiddenId);
        if (this._dashboardTimer) GLib.Source.remove(this._dashboardTimer);
        if (this._focusTimer) GLib.Source.remove(this._focusTimer);
        this._closeCarousel(true);
        this._dashboard?.destroy();
        this._dashboard = null;
    }

    _card(cls, reactive = false) {
        return new St.BoxLayout({
            vertical: true,
            style_class: `p11-card ${cls}`,
            reactive,
            can_focus: reactive,
            track_hover: reactive,
        });
    }

    _buildDashboard() {
        this._dashboard = new St.BoxLayout({vertical: true, style_class: 'p11-dashboard', reactive: true});
        this._dashboard.connect('notify::width', () => this._positionDashboard());
        const bg = Main.layoutManager._backgroundGroup;
        if (bg) bg.add_child(this._dashboard);
        else Main.layoutManager.uiGroup.add_child(this._dashboard);

        const top = new St.BoxLayout({style_class: 'p11-top-row'});
        this._dashboard.add_child(top);

        this._activity = this._card('p11-activity');
        top.add_child(this._activity);

        const head = new St.BoxLayout({style_class: 'p11-between'});
        head.add_child(label('ACTIVITY', 'p11-title'));
        this._activityLive = label('LIVE', 'p11-live');
        head.add_child(this._activityLive);
        this._activity.add_child(head);

        const appRow = new St.BoxLayout({style_class: 'p11-app-row'});
        this._appIcon = icon('application-x-executable-symbolic', 'p11-app-icon');
        appRow.add_child(this._appIcon);

        const appText = new St.BoxLayout({vertical: true, style_class: 'p11-app-text'});
        this._appName = label('Desktop', 'p11-app-name');
        this._windowTitle = label('Everything quiet', 'p11-detail');
        appText.add_child(this._appName);
        appText.add_child(this._windowTitle);
        appRow.add_child(appText);
        this._activity.add_child(appRow);

        const meta = new St.BoxLayout({style_class: 'p11-between'});
        this._workspace = label('Workspace 1 / 1', 'p11-meta');
        this._windowCount = label('0 windows', 'p11-meta-accent');
        meta.add_child(this._workspace);
        meta.add_child(this._windowCount);
        this._activity.add_child(meta);

        this._activity.add_child(new St.Widget({style_class: 'p11-divider', height: 1}));

        const media = new St.BoxLayout({style_class: 'p11-media-row'});
        media.add_child(icon('audio-x-generic-symbolic', 'p11-media-icon'));
        const mediaText = new St.BoxLayout({vertical: true, style_class: 'p11-media-text'});
        this._mediaTitle = label('No media playing', 'p11-media-title');
        this._mediaArtist = label('', 'p11-detail');
        mediaText.add_child(this._mediaTitle);
        mediaText.add_child(this._mediaArtist);
        media.add_child(mediaText);
        this._mediaState = label('—', 'p11-media-state');
        media.add_child(this._mediaState);
        this._activity.add_child(media);

        const side = new St.BoxLayout({vertical: true, style_class: 'p11-side'});
        top.add_child(side);

        this._weather = this._card('p11-weather');
        side.add_child(this._weather);
        this._weatherIcon = label('☁', 'p11-weather-icon');
        this._weatherTemp = label('--°', 'p11-weather-temp');
        this._weatherCity = label('WEATHER', 'p11-weather-city');
        this._weatherRange = label('H --  ·  L --', 'p11-detail');
        this._weather.add_child(this._weatherIcon);
        this._weather.add_child(this._weatherTemp);
        this._weather.add_child(this._weatherCity);
        this._weather.add_child(this._weatherRange);

        this._focus = this._card('p11-focus', true);
        side.add_child(this._focus);
        const fHead = new St.BoxLayout({style_class: 'p11-focus-head'});
        fHead.add_child(icon('alarm-symbolic', 'p11-focus-icon'));
        fHead.add_child(label('FOCUS', 'p11-title'));
        this._focus.add_child(fHead);

        const modes = new St.BoxLayout({style_class: 'p11-focus-modes'});
        this._mode25 = this._focusModeButton('25', 25);
        this._mode5 = this._focusModeButton('5', 5);
        this._mode15 = this._focusModeButton('15', 15);
        modes.add_child(this._mode25);
        modes.add_child(this._mode5);
        modes.add_child(this._mode15);
        this._focus.add_child(modes);

        this._focusTime = label('25:00', 'p11-focus-time');
        this._focus.add_child(this._focusTime);

        const controls = new St.BoxLayout({style_class: 'p11-focus-controls'});
        const reset = new St.Button({label: '↺', style_class: 'p11-focus-btn', reactive: true});
        reset.connect('clicked', () => this._resetFocus());
        this._play = new St.Button({label: '▶', style_class: 'p11-focus-btn primary', reactive: true});
        this._play.connect('clicked', () => this._toggleFocus());
        controls.add_child(reset);
        controls.add_child(this._play);
        this._focus.add_child(controls);
    }

    _positionDashboard() {
        if (!this._dashboard) return;
        const m = Main.layoutManager.primaryMonitor;
        if (!m) return;
        // Largeur réelle du bloc (et non 560 px fixes) : il ne dépasse plus de l'écran.
        const [, naturalWidth] = this._dashboard.get_preferred_width(-1);
        const width = Math.max(this._dashboard.width, naturalWidth);
        this._dashboard.set_position(Math.max(m.x + 24, m.x + m.width - width - 24), m.y + 82);
    }

    _focusModeButton(text, minutes) {
        const b = new St.Button({label: text, style_class: 'p11-focus-mode', reactive: true});
        b.connect('clicked', () => {
            this._focusModeSeconds = minutes * 60;
            this._focusSeconds = this._focusModeSeconds;
            this._focusRunning = false;
            if (this._focusTimer) {
                GLib.Source.remove(this._focusTimer);
                this._focusTimer = 0;
            }
            this._updateFocusUI();
        });
        return b;
    }

    _toggleFocus() {
        if (this._focusRunning) {
            this._focusRunning = false;
            if (this._focusTimer) {
                GLib.Source.remove(this._focusTimer);
                this._focusTimer = 0;
            }
            this._updateFocusUI();
            return;
        }

        this._focusRunning = true;
        this._updateFocusUI();
        this._focusTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (!this._focusRunning) return GLib.SOURCE_REMOVE;
            this._focusSeconds = Math.max(0, this._focusSeconds - 1);
            this._updateFocusUI();
            if (this._focusSeconds <= 0) {
                this._focusRunning = false;
                this._focusTimer = 0;
                Main.notify('Focus', 'Session terminée.');
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _resetFocus() {
        this._focusRunning = false;
        this._focusSeconds = this._focusModeSeconds;
        if (this._focusTimer) {
            GLib.Source.remove(this._focusTimer);
            this._focusTimer = 0;
        }
        this._updateFocusUI();
    }

    _updateFocusUI() {
        if (!this._focusTime) return;
        const min = Math.floor(this._focusSeconds / 60);
        const sec = this._focusSeconds % 60;
        this._focusTime.text = `${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
        this._play.label = this._focusRunning ? 'Ⅱ' : '▶';

        for (const b of [this._mode25, this._mode5, this._mode15])
            b.remove_style_class_name('active');
        if (this._focusModeSeconds === 25 * 60) this._mode25.add_style_class_name('active');
        else if (this._focusModeSeconds === 5 * 60) this._mode5.add_style_class_name('active');
        else this._mode15.add_style_class_name('active');
    }

    _weatherGlyph(code) {
        const c = Number(code);
        if (c === 0) return '☀';
        if ([1,2].includes(c)) return '⛅';
        if (c === 3) return '☁';
        if ([45,48].includes(c)) return '🌫';
        if ([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(c)) return '🌧';
        if ([71,73,75,77,85,86].includes(c)) return '❄';
        if ([95,96,99].includes(c)) return '⛈';
        return '☁';
    }

    _updateDashboard() {
        this._updateActivity();
        this._updateWeather();
    }

    _updateActivity() {
        const tracker = Shell.WindowTracker.get_default();
        const win = global.display.focus_window;

        if (win && isWindow(win)) {
            let app = null;
            try { app = tracker.get_window_app(win); } catch (_) {}
            let appName = '';
            let title = '';
            try {
                appName = app?.get_name() || win.get_wm_class() || 'Application';
                title = win.get_title() || '';
            } catch (_) {}
            this._appName.text = appName;
            this._windowTitle.text = title.length > 42 ? `${title.slice(0,39)}…` : (title || 'Active');
            try {
                const gicon = app?.get_app_info()?.get_icon();
                if (gicon) {
                    this._appIcon.gicon = gicon;
                    this._appIcon.icon_name = null;
                } else {
                    this._appIcon.gicon = null;
                    this._appIcon.icon_name = 'application-x-executable-symbolic';
                }
            } catch (_) {}
        } else {
            this._appName.text = 'Desktop';
            this._windowTitle.text = 'Everything quiet';
            this._appIcon.gicon = null;
            this._appIcon.icon_name = 'computer-symbolic';
        }

        const wm = global.workspace_manager;
        const idx = wm.get_active_workspace_index();
        const total = wm.get_n_workspaces();
        const ws = wm.get_active_workspace();
        let windows = [];
        try { windows = ws.list_windows().filter(isWindow); } catch (_) {}
        this._workspace.text = `Workspace ${idx + 1} / ${total}`;
        this._windowCount.text = `${windows.length} window${windows.length === 1 ? '' : 's'}`;

        const status = shell("playerctl status 2>/dev/null");
        const title = shell("playerctl metadata --format '{{title}}' 2>/dev/null");
        const artist = shell("playerctl metadata --format '{{artist}}' 2>/dev/null");
        if (status && (title || artist)) {
            this._mediaTitle.text = title || 'Now Playing';
            this._mediaArtist.text = artist || '';
            this._mediaState.text = status === 'Playing' ? '●' : 'Ⅱ';
        } else {
            this._mediaTitle.text = 'No media playing';
            this._mediaArtist.text = '';
            this._mediaState.text = '—';
        }
    }

    _updateWeather() {
        const data = readJSON(this._weatherPath);
        if (!data?.ok) {
            this._weatherIcon.text = '☁';
            this._weatherTemp.text = '--°';
            this._weatherCity.text = data?.status === 'setup_required' ? 'CONFIGURE' : 'WEATHER';
            this._weatherRange.text = '';
            return;
        }
        this._weatherIcon.text = this._weatherGlyph(data.code);
        this._weatherTemp.text = data.temperature == null ? '--°' : `${Math.round(data.temperature)}°C`;
        this._weatherCity.text = `${data.display_name || data.city || data.resolved_name || ''}`.toUpperCase();
        const hi = data.high == null ? '--' : Math.round(data.high);
        const lo = data.low == null ? '--' : Math.round(data.low);
        this._weatherRange.text = `H ${hi}°  ·  L ${lo}°`;
    }

    _onCapturedEvent(event) {
        let type;
        try { type = event.type(); } catch (_) { return Clutter.EVENT_PROPAGATE; }
        if (type !== Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        let fingers = 0;
        try { fingers = event.get_touchpad_gesture_finger_count(); } catch (_) {}
        if (fingers !== 3)
            return Clutter.EVENT_PROPAGATE;

        if (Main.overview.visible || Main.overview.visibleTarget)
            return Clutter.EVENT_PROPAGATE;

        let phase;
        try { phase = event.get_gesture_phase(); } catch (_) { return Clutter.EVENT_PROPAGATE; }

        if (phase === Clutter.TouchpadGesturePhase.BEGIN) {
            this._tracking = true;
            this._dx = 0;
            this._dy = 0;
            return this._carouselVisible ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        if (!this._tracking)
            return Clutter.EVENT_PROPAGATE;

        if (phase === Clutter.TouchpadGesturePhase.UPDATE) {
            let dx = 0, dy = 0;
            try { [dx, dy] = event.get_gesture_motion_delta(); } catch (_) {}
            this._dx += dx;
            this._dy += dy;

            if (this._carouselVisible) {
                if (Math.abs(this._dx) > Math.abs(this._dy))
                    this._ring?.drag(this._dx / COVER_DISTANCE);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        if (phase === Clutter.TouchpadGesturePhase.END || phase === Clutter.TouchpadGesturePhase.CANCEL) {
            this._tracking = false;

            if (this._carouselVisible) {
                if (phase === Clutter.TouchpadGesturePhase.END &&
                    Math.abs(this._dx) > COVER_THRESHOLD &&
                    Math.abs(this._dx) > Math.abs(this._dy)) {
                    this._ring?.select(this._dx < 0 ? 1 : -1);
                } else {
                    this._ring?.release();
                }
                this._dx = 0;
                this._dy = 0;
                return Clutter.EVENT_STOP;
            }

            if (this._dy > DOWN_THRESHOLD && Math.abs(this._dy) > Math.abs(this._dx) * 0.8) {
                this._handleDownSwipe();
                this._dx = 0;
                this._dy = 0;
                return Clutter.EVENT_STOP;
            }

            this._dx = 0;
            this._dy = 0;
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _workspaceWindows(includeMinimized = false) {
        const ws = global.workspace_manager.get_active_workspace();
        if (!ws) return [];
        let windows = [];
        try { windows = ws.list_windows(); } catch (_) { return []; }
        return windows.filter(win => isWindow(win) && (includeMinimized || !win.minimized));
    }

    _handleDownSwipe() {
        const visible = this._workspaceWindows(false);
        if (visible.length > 0) {
            this._lastDesktopWindows = visible.slice();
            for (const win of visible) {
                try { win.minimize(); } catch (_) {}
            }
            return;
        }
        this._openCarousel();
    }

    _candidateWindows() {
        const ws = global.workspace_manager.get_active_workspace();
        const all = this._workspaceWindows(true);
        const remembered = this._lastDesktopWindows.filter(win => {
            try { return isWindow(win) && win.get_workspace() === ws; } catch (_) { return false; }
        });
        const out = [];
        const seen = new Set();
        for (const win of [...remembered, ...all]) {
            let id;
            try { id = win.get_stable_sequence(); } catch (_) { id = String(win); }
            if (seen.has(id)) continue;
            seen.add(id);
            out.push(win);
        }
        return out;
    }

    _openCarousel() {
        if (this._carouselVisible) return;
        const windows = this._candidateWindows();
        if (!windows.length) {
            Main.notify('Fenêtres', 'Aucune fenêtre ouverte sur cet espace de travail.');
            return;
        }

        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor) return;

        const ring = new WindowRing({
            windows,
            monitor,
            onActivate: win => this._activateWindow(win),
            onClose: () => {
                if (this._ring === ring) {
                    this._ring = null;
                    this._carouselVisible = false;
                }
            },
        });

        if (!ring.open())
            return;

        this._ring = ring;
        this._carouselVisible = true;
    }

    _activateWindow(win) {
        this._ring = null;
        this._carouselVisible = false;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
            try {
                if (win.minimized) win.unminimize();
                win.activate(global.get_current_time());
            } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _closeCarousel(immediate = false) {
        const ring = this._ring;
        this._ring = null;
        this._carouselVisible = false;
        ring?.close(immediate);
    }
}
