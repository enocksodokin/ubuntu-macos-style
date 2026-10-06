import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Cairo from 'cairo';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : '';
    } catch (_) {
        return '';
    }
}

function readJSON(path) {
    try {
        const text = readText(path);
        return text ? JSON.parse(text) : null;
    } catch (_) {
        return null;
    }
}

function shell(command) {
    try {
        const [ok, out] = GLib.spawn_command_line_sync(command);
        if (!ok || !out)
            return '';
        return decoder.decode(out).trim();
    } catch (_) {
        return '';
    }
}

function clamp(v, min = 0, max = 100) {
    return Math.max(min, Math.min(max, Number(v) || 0));
}

function fmtBytesPerSec(v) {
    const n = Math.max(0, Number(v) || 0);
    if (n >= 1024 * 1024)
        return `${(n / 1024 / 1024).toFixed(1)} MB/s`;
    if (n >= 1024)
        return `${Math.round(n / 1024)} KB/s`;
    return `${Math.round(n)} B/s`;
}

function localDate(iso) {
    if (!iso)
        return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
}

function hhmm(date) {
    if (!date)
        return '--:--';
    return date.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}

class Ring {
    constructor(size = 52) {
        this.value = 0;
        this.area = new St.DrawingArea({
            width: size,
            height: size,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this.area.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const cx = w / 2;
            const cy = h / 2;
            const radius = Math.min(w, h) / 2 - 5;
            const start = -Math.PI / 2;
            const end = start + Math.PI * 2 * clamp(this.value) / 100;

            cr.setLineWidth(5);
            cr.setLineCap(Cairo.LineCap.ROUND);

            cr.setSourceRGBA(1, 1, 1, 0.11);
            cr.arc(cx, cy, radius, 0, Math.PI * 2);
            cr.stroke();

            cr.setSourceRGBA(0.38, 0.73, 1.0, 0.96);
            cr.arc(cx, cy, radius, start, end);
            cr.stroke();
        });
    }

    set(value) {
        this.value = clamp(value);
        this.area.queue_repaint();
    }
}

class Sparkline {
    constructor(width = 118, height = 30) {
        this.values = Array(32).fill(0);
        this.area = new St.DrawingArea({width, height});
        this.area.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            if (this.values.length < 2)
                return;

            cr.setLineWidth(1.8);
            cr.setSourceRGBA(0.28, 0.72, 1, 0.92);

            for (let i = 0; i < this.values.length; i++) {
                const x = (i / (this.values.length - 1)) * w;
                const y = h - (clamp(this.values[i]) / 100) * (h - 3) - 1.5;
                if (i === 0)
                    cr.moveTo(x, y);
                else
                    cr.lineTo(x, y);
            }
            cr.stroke();
        });
    }

    push(value) {
        this.values.push(clamp(value));
        if (this.values.length > 32)
            this.values.shift();
        this.area.queue_repaint();
    }
}

function label(text, cls) {
    return new St.Label({text, style_class: cls});
}

function icon(name, cls = 'bento-icon') {
    return new St.Icon({icon_name: name, style_class: cls});
}

class DashboardExtension extends Extension {
    enable() {
        this._cpuPrevTotal = null;
        this._cpuPrevIdle = null;
        this._netPrev = null;
        this._authNotified = false;
        this._notifSource = null;
        this._weatherPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.cache', 'pro-dashboard', 'weather.json'
        ]);
        this._epitechPath = GLib.build_filenamev([
            GLib.get_home_dir(), '.cache', 'pro-dashboard', 'epitech.json'
        ]);

        this._root = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });

        const bg = Main.layoutManager._backgroundGroup;
        if (bg)
            bg.add_child(this._root);
        else
            Main.layoutManager.uiGroup.add_child(this._root);

        this._buildLeft();
        this._buildRight();
        this._right?.hide(); // PHASE11_HIDE_OLD_RIGHT

        // La carte agenda Epitech sort de la colonne cachée et s'affiche seule.
        if (this._agendaCard) {
            this._agendaCard.get_parent()?.remove_child(this._agendaCard);
            this._root.add_child(this._agendaCard);
        }

        this._position();

        this._monitorId = Main.layoutManager.connect(
            'monitors-changed', () => this._position()
        );

        this._overviewShowing = Main.overview.connect('showing', () => this._root.hide());
        this._overviewHidden = Main.overview.connect('hidden', () => this._root.show());

        this._updateSystem();
        this._updateExternal();
        this._updateMusic();

        this._systemTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._updateSystem();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this._externalTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 30, () => {
                this._updateExternal();
                return GLib.SOURCE_CONTINUE;
            }
        );

        this._musicTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 2, () => {
                this._updateMusic();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    disable() {
        for (const id of ['_systemTimer', '_externalTimer', '_musicTimer']) {
            if (this[id]) {
                GLib.Source.remove(this[id]);
                this[id] = 0;
            }
        }

        if (this._monitorId)
            Main.layoutManager.disconnect(this._monitorId);
        if (this._overviewShowing)
            Main.overview.disconnect(this._overviewShowing);
        if (this._overviewHidden)
            Main.overview.disconnect(this._overviewHidden);

        this._notifSource?.destroy();
        this._notifSource = null;

        this._root?.destroy();
        this._root = null;
    }

    _card(cls, reactive = false) {
        return new St.BoxLayout({
            vertical: true,
            style_class: `bento-card ${cls}`,
            reactive,
            can_focus: reactive,
            track_hover: reactive,
        });
    }

    _buildLeft() {
        this._left = new St.BoxLayout({
            vertical: true,
            style_class: 'bento-left',
        });
        this._root.add_child(this._left);

        // Row 1: large CPU + compact GPU
        const r1 = new St.BoxLayout({style_class: 'bento-row'});
        this._left.add_child(r1);

        this._cpuCard = this._card('cpu-card');
        r1.add_child(this._cpuCard);

        const cpuTop = new St.BoxLayout({style_class: 'metric-row'});
        this._cpuRing = new Ring(58);
        cpuTop.add_child(this._cpuRing.area);

        const cpuText = new St.BoxLayout({vertical: true, style_class: 'metric-text'});
        cpuText.add_child(label('CPU', 'bento-title'));
        this._cpuValue = label('--%', 'bento-value-big');
        cpuText.add_child(this._cpuValue);
        this._cpuSub = label('PROCESSOR', 'bento-subtitle');
        cpuText.add_child(this._cpuSub);
        cpuTop.add_child(cpuText);
        this._cpuCard.add_child(cpuTop);

        this._cpuSpark = new Sparkline(150, 28);
        this._cpuCard.add_child(this._cpuSpark.area);

        this._gpuCard = this._card('square-card');
        r1.add_child(this._gpuCard);
        this._gpuCard.add_child(label('GPU / SoC', 'bento-title'));
        this._gpuValue = label('--°C', 'square-value');
        this._gpuCard.add_child(this._gpuValue);
        this._gpuSub = label('THERMAL', 'bento-subtitle');
        this._gpuCard.add_child(this._gpuSub);

        // Row 2: wide RAM+storage + small battery
        const r2 = new St.BoxLayout({style_class: 'bento-row'});
        this._left.add_child(r2);

        this._ramCard = this._card('wide-card');
        r2.add_child(this._ramCard);

        const ramHeader = new St.BoxLayout({style_class: 'between-row'});
        ramHeader.add_child(label('RAM + STORAGE', 'bento-title'));
        this._ramValue = label('--%', 'bento-value');
        ramHeader.add_child(this._ramValue);
        this._ramCard.add_child(ramHeader);

        this._ramBar = new St.Widget({style_class: 'progress-track'});
        this._ramFill = new St.Widget({style_class: 'progress-fill ram-fill'});
        this._ramBar.add_child(this._ramFill);
        this._ramCard.add_child(this._ramBar);

        this._diskText = label('Disk --', 'bento-detail');
        this._ramCard.add_child(this._diskText);

        this._batteryCard = this._card('square-card');
        r2.add_child(this._batteryCard);
        this._batteryCard.add_child(label('BATTERY', 'bento-title'));
        this._batteryValue = label('--%', 'square-value');
        this._batteryCard.add_child(this._batteryValue);
        this._batterySub = label('POWER', 'bento-subtitle');
        this._batteryCard.add_child(this._batterySub);

        // Row 3: network long + temp compact
        const r3 = new St.BoxLayout({style_class: 'bento-row'});
        this._left.add_child(r3);

        this._networkCard = this._card('network-card');
        r3.add_child(this._networkCard);
        this._networkCard.add_child(label('NETWORK', 'bento-title'));
        this._networkDown = label('↓ --', 'network-value');
        this._networkUp = label('↑ --', 'network-value secondary');
        this._networkCard.add_child(this._networkDown);
        this._networkCard.add_child(this._networkUp);

        this._thermalCard = this._card('mini-card');
        r3.add_child(this._thermalCard);
        this._thermalCard.add_child(icon('temperature-symbolic'));
        this._thermalValue = label('--°', 'mini-value');
        this._thermalCard.add_child(this._thermalValue);
        this._thermalCard.add_child(label('SYSTEM', 'bento-subtitle'));
    }

    _buildRight() {
        this._right = new St.BoxLayout({
            vertical: true,
            style_class: 'bento-right',
        });
        this._root.add_child(this._right);

        const top = new St.BoxLayout({style_class: 'right-top-row'});
        this._right.add_child(top);

        // Large agenda — no giant clock.
        this._agendaCard = this._card('agenda-card', true);
        this._agendaCard.connect('button-press-event', () => {
            Gio.AppInfo.launch_default_for_uri(
                'https://my.epitech.eu/planning',
                null
            );
            return Clutter.EVENT_STOP;
        });
        top.add_child(this._agendaCard);

        const agendaHead = new St.BoxLayout({style_class: 'between-row'});
        agendaHead.add_child(label('EPITECH · TODAY', 'agenda-title'));
        this._agendaStatus = label('SYNC', 'agenda-status');
        agendaHead.add_child(this._agendaStatus);
        this._agendaCard.add_child(agendaHead);

        this._agendaContent = new St.BoxLayout({
            vertical: true,
            style_class: 'agenda-content',
        });
        this._agendaCard.add_child(this._agendaContent);

        // Small side column: weather + next class.
        const side = new St.BoxLayout({
            vertical: true,
            style_class: 'right-side',
        });
        top.add_child(side);

        this._weatherCard = this._card('weather-card');
        side.add_child(this._weatherCard);
        this._weatherIcon = label('☁', 'weather-icon');
        this._weatherTemp = label('--°', 'weather-temp');
        this._weatherCity = label('WEATHER', 'weather-city');
        this._weatherRange = label('H --  ·  L --', 'bento-detail');
        this._weatherCard.add_child(this._weatherIcon);
        this._weatherCard.add_child(this._weatherTemp);
        this._weatherCard.add_child(this._weatherCity);
        this._weatherCard.add_child(this._weatherRange);

        this._nextCard = this._card('next-card');
        side.add_child(this._nextCard);
        this._nextCard.add_child(label('NEXT', 'bento-title'));
        this._nextTime = label('--:--', 'next-time');
        this._nextCard.add_child(this._nextTime);
        this._nextTitle = label('No activity', 'next-title');
        this._nextCard.add_child(this._nextTitle);
        this._nextCountdown = label('', 'bento-detail');
        this._nextCard.add_child(this._nextCountdown);

        // Dynamic music: hidden when nothing plays.
        this._musicCard = this._card('music-card');
        this._right.add_child(this._musicCard);

        const musicRow = new St.BoxLayout({style_class: 'music-row'});
        this._musicCard.add_child(musicRow);
        musicRow.add_child(icon('audio-x-generic-symbolic', 'music-icon'));

        const musicText = new St.BoxLayout({vertical: true, style_class: 'music-text'});
        this._musicTitle = label('', 'music-title');
        this._musicArtist = label('', 'music-artist');
        musicText.add_child(this._musicTitle);
        musicText.add_child(this._musicArtist);
        musicRow.add_child(musicText);

        this._musicState = label('▶', 'music-state');
        musicRow.add_child(this._musicState);

        this._musicCard.hide();
    }

    _position() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._root)
            return;

        this._root.set_position(m.x, m.y);
        this._root.set_size(m.width, m.height);

        this._left.set_position(24, 96);

        const rightWidth = 505;
        this._right.set_position(
            Math.max(24, m.width - rightWidth - 24),
            82
        );

        this._positionAgenda();
    }

    // Carte agenda : sous le bloc Activité / Météo / Focus de smart-phase11, alignée à droite.
    _positionAgenda() {
        const m = Main.layoutManager.primaryMonitor;
        if (!m || !this._agendaCard)
            return;

        const bg = Main.layoutManager._backgroundGroup;
        const dash = bg?.get_children().find(c => c.has_style_class_name?.('p11-dashboard'));

        const [, naturalWidth] = this._agendaCard.get_preferred_width(-1);
        const width = Math.max(this._agendaCard.width, naturalWidth);

        let x = m.width - width - 24;
        let y = 82 + 326 + 12;

        if (dash && dash.width > 0) {
            x = dash.x - m.x + dash.width - width;
            y = dash.y - m.y + dash.height + 12;
        }

        this._agendaCard.set_position(Math.round(x), Math.round(y));
    }

    _cpuUsage() {
        const text = readText('/proc/stat');
        const line = (text.split('\n')[0] || '').trim().split(/\s+/).slice(1);
        const values = line.map(Number);
        if (values.length < 4 || values.some(v => !Number.isFinite(v)))
            return 0;

        const idle = (values[3] || 0) + (values[4] || 0);
        const total = values.reduce((a, b) => a + b, 0);

        if (this._cpuPrevTotal === null) {
            this._cpuPrevTotal = total;
            this._cpuPrevIdle = idle;
            return 0;
        }

        const td = total - this._cpuPrevTotal;
        const id = idle - this._cpuPrevIdle;
        this._cpuPrevTotal = total;
        this._cpuPrevIdle = idle;

        return td > 0 ? Math.round((1 - id / td) * 100) : 0;
    }

    _memory() {
        const mem = {};
        for (const line of readText('/proc/meminfo').split('\n')) {
            const m = line.match(/^([A-Za-z_()]+):\s+(\d+)/);
            if (m)
                mem[m[1]] = Number(m[2]);
        }
        const total = mem.MemTotal || 0;
        const avail = mem.MemAvailable || 0;
        const used = Math.max(0, total - avail);
        return {
            percent: total ? Math.round(used / total * 100) : 0,
            usedGiB: used / 1024 / 1024,
            totalGiB: total / 1024 / 1024,
        };
    }

    _battery() {
        for (const name of ['BAT0', 'BAT1']) {
            const base = `/sys/class/power_supply/${name}`;
            const cap = Number(readText(`${base}/capacity`));
            if (Number.isFinite(cap)) {
                return {
                    percent: cap,
                    status: readText(`${base}/status`) || 'POWER',
                };
            }
        }
        return {percent: 0, status: 'N/A'};
    }

    _disk() {
        const helper = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'libexec', 'pro-dashboard-disk'
        ]);

        if (!GLib.file_test(helper, GLib.FileTest.EXISTS))
            return {percent: 0, text: 'Disk N/A'};

        const raw = shell(GLib.shell_quote(helper));
        if (!raw)
            return {percent: 0, text: 'Disk N/A'};

        try {
            const data = JSON.parse(raw);
            if (!data?.ok)
                return {percent: 0, text: 'Disk N/A'};

            return {
                percent: Number(data.percent) || 0,
                text: `Disk ${Number(data.used_gib).toFixed(0)} / ${Number(data.total_gib).toFixed(0)} GiB · ${Number(data.percent) || 0}%`,
            };
        } catch (_) {
            return {percent: 0, text: 'Disk N/A'};
        }
    }

    _network() {
        let rx = 0, tx = 0;
        const lines = readText('/proc/net/dev').split('\n').slice(2);
        for (const line of lines) {
            const parts = line.trim().split(/[:\s]+/);
            if (parts.length < 10)
                continue;
            const iface = parts[0];
            if (iface === 'lo')
                continue;
            rx += Number(parts[1]) || 0;
            tx += Number(parts[9]) || 0;
        }

        const now = GLib.get_monotonic_time() / 1e6;
        if (!this._netPrev) {
            this._netPrev = {rx, tx, t: now};
            return {rx: 0, tx: 0};
        }

        const dt = Math.max(0.1, now - this._netPrev.t);
        const result = {
            rx: Math.max(0, (rx - this._netPrev.rx) / dt),
            tx: Math.max(0, (tx - this._netPrev.tx) / dt),
        };
        this._netPrev = {rx, tx, t: now};
        return result;
    }

    _temperature() {
        const helper = GLib.build_filenamev([
            GLib.get_home_dir(), '.local', 'libexec', 'pro-desktop-temperature'
        ]);

        if (!GLib.file_test(helper, GLib.FileTest.EXISTS))
            return null;

        const out = shell(GLib.shell_quote(helper)).trim();

        if (!out)
            return null;

        const v = Number(out);

        if (!Number.isFinite(v) || v <= -10 || v >= 130)
            return null;

        return Math.round(v);
    }

    _updateSystem() {
        const cpu = this._cpuUsage();
        this._cpuValue.text = `${cpu}%`;
        this._cpuRing.set(cpu);
        this._cpuSpark.push(cpu);

        const mem = this._memory();
        this._ramValue.text = `${mem.percent}%`;
        this._ramFill.set_width(Math.round(250 * clamp(mem.percent) / 100));

        const disk = this._disk();
        this._diskText.text =
            `${mem.usedGiB.toFixed(1)} / ${mem.totalGiB.toFixed(1)} GiB RAM  ·  ${disk.text}`;

        const bat = this._battery();
        this._batteryValue.text = `${bat.percent}%`;
        this._batterySub.text = bat.status.toUpperCase();

        const net = this._network();
        this._networkDown.text = `↓ ${fmtBytesPerSec(net.rx)}`;
        this._networkUp.text = `↑ ${fmtBytesPerSec(net.tx)}`;

        const temp = this._temperature();
        const tempText = temp === null ? 'N/A' : `${temp}°`;
        this._gpuValue.text = tempText;
        this._thermalValue.text = tempText;
    }

    _weatherGlyph(code) {
        const c = Number(code);
        if (c === 0) return '☀';
        if ([1, 2].includes(c)) return '⛅';
        if (c === 3) return '☁';
        if ([45, 48].includes(c)) return '🌫';
        if ([51,53,55,56,57,61,63,65,66,67,80,81,82].includes(c)) return '🌧';
        if ([71,73,75,77,85,86].includes(c)) return '❄';
        if ([95,96,99].includes(c)) return '⛈';
        return '☁';
    }

    _updateWeather() {
        const data = readJSON(this._weatherPath);
        if (!data?.ok) {
            this._weatherIcon.text = '☁';
            this._weatherTemp.text = '--°';
            this._weatherCity.text = data?.status === 'setup_required'
                ? 'CONFIGURE WEATHER'
                : 'WEATHER';
            this._weatherRange.text = '';
            return;
        }

        this._weatherIcon.text = this._weatherGlyph(data.code);
        this._weatherTemp.text =
            data.temperature === null || data.temperature === undefined
                ? '--°'
                : `${Math.round(data.temperature)}°C`;
        this._weatherCity.text =
            `${data.display_name || data.city || ''}`.toUpperCase();

        const hi = data.high === null || data.high === undefined ? '--' : Math.round(data.high);
        const lo = data.low === null || data.low === undefined ? '--' : Math.round(data.low);
        this._weatherRange.text = `H ${hi}°  ·  L ${lo}°`;
    }

    _clearAgenda() {
        for (const child of this._agendaContent.get_children())
            child.destroy();
    }

    _eventRow(event, isNext = false) {
        const box = new St.BoxLayout({
            vertical: false,
            style_class: `agenda-event accent-${event.accent || 'blue'} ${isNext ? 'agenda-next-event' : ''}`,
        });

        const times = new St.BoxLayout({
            vertical: true,
            style_class: 'agenda-timebox',
        });
        const s = localDate(event.start);
        const e = localDate(event.end);
        times.add_child(label(hhmm(s), 'agenda-time'));
        times.add_child(label(e ? hhmm(e) : '', 'agenda-end'));
        box.add_child(times);

        const txt = new St.BoxLayout({vertical: true, style_class: 'agenda-event-text'});
        const modulePrefix = event.module ? `${event.module} · ` : '';
        txt.add_child(label(`${modulePrefix}${event.title || 'Activity'}`, 'agenda-event-title'));

        const details = [];
        if (event.type && event.type !== event.title)
            details.push(event.type);
        if (event.room)
            details.push(event.room);
        txt.add_child(label(details.join(' · '), 'agenda-event-detail'));
        box.add_child(txt);

        return box;
    }

    _reconnectEpitech() {
        try {
            Gio.Subprocess.new(
                [GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'epitech-agenda-reconnect'])],
                Gio.SubprocessFlags.NONE
            );
        } catch (error) {
            console.error(`[ProDashboard] reconnexion Epitech impossible: ${error}`);
        }
    }

    _notifyEpitechExpired() {
        if (this._authNotified)
            return;

        this._authNotified = true;

        try {
            if (!this._notifSource) {
                this._notifSource = new MessageTray.Source({
                    title: 'Epitech',
                    iconName: 'dialog-warning-symbolic',
                });
                this._notifSource.connect('destroy', () => {
                    this._notifSource = null;
                });
                Main.messageTray.add(this._notifSource);
            }

            const notification = new MessageTray.Notification({
                source: this._notifSource,
                title: 'Epitech : session expirée',
                body: 'Ton planning n\u2019est plus à jour. Reconnecte-toi dans Firefox.',
                urgency: MessageTray.Urgency.HIGH,
            });
            notification.addAction('Reconnecter', () => this._reconnectEpitech());
            this._notifSource.addNotification(notification);
        } catch (error) {
            console.error(`[ProDashboard] notification Epitech: ${error}`);
            Main.notify('Epitech : session expirée', 'Reconnecte-toi dans Firefox.');
        }
    }

    _updateAgenda() {
        const data = readJSON(this._epitechPath);
        this._clearAgenda();

        if (!data?.ok) {
            this._agendaStatus.text = 'LOGIN';
            this._agendaContent.add_child(label('Planning Epitech non connecté', 'agenda-empty-title'));
            this._agendaContent.add_child(
                label('Session expirée. Clique sur « Reconnecter »,\npuis connecte-toi dans Firefox.', 'agenda-empty')
            );

            const reconnect = new St.Button({
                label: 'Reconnecter',
                style_class: 'agenda-reconnect',
                reactive: true,
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
            });
            reconnect.connect('clicked', () => {
                this._reconnectEpitech();
                return Clutter.EVENT_STOP;
            });
            this._agendaContent.add_child(reconnect);

            if (data?.status === 'auth_required')
                this._notifyEpitechExpired();

            this._nextTime.text = '--:--';
            this._nextTitle.text = 'Connexion Epitech';
            this._nextCountdown.text = '';
            return;
        }

        this._authNotified = false;
        this._agendaStatus.text = 'LIVE';
        const events = Array.isArray(data.events) ? data.events : [];
        const now = new Date();

        const today = events.filter(ev => {
            const d = localDate(ev.start);
            return d &&
                d.getFullYear() === now.getFullYear() &&
                d.getMonth() === now.getMonth() &&
                d.getDate() === now.getDate();
        });

        let visible = today.slice(0, 3);
        if (visible.length === 0)
            visible = events.slice(0, 3);

        if (visible.length === 0) {
            this._agendaContent.add_child(label('Aucune activité à venir', 'agenda-empty-title'));
            this._agendaContent.add_child(label('Ton planning est à jour.', 'agenda-empty'));
            this._nextTime.text = 'FREE';
            this._nextTitle.text = 'No activity';
            this._nextCountdown.text = '';
            return;
        }

        visible.forEach((ev, i) => {
            this._agendaContent.add_child(this._eventRow(ev, i === 0));
        });

        const sourceCount = today.length ? today.length : events.length;
        if (sourceCount > 3) {
            this._agendaContent.add_child(
                label(`+ ${sourceCount - 3} activité${sourceCount - 3 > 1 ? 's' : ''}`, 'agenda-more')
            );
        }

        const next = events.find(ev => {
            const end = localDate(ev.end) || localDate(ev.start);
            return end && end >= now;
        }) || events[0];

        if (next) {
            const start = localDate(next.start);
            const end = localDate(next.end);
            this._nextTime.text = hhmm(start);
            this._nextTitle.text = (next.module || next.title || 'Activity').slice(0, 18);

            if (start) {
                const minutes = Math.round((start - now) / 60000);
                if (minutes > 0) {
                    if (minutes >= 60)
                        this._nextCountdown.text = `dans ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
                    else
                        this._nextCountdown.text = `dans ${minutes} min`;
                } else if (end && end > now) {
                    const remain = Math.max(1, Math.round((end - now) / 60000));
                    this._nextCountdown.text = `EN COURS · ${remain} min`;
                } else {
                    this._nextCountdown.text = '';
                }
            }
        }
    }

    _updateExternal() {
        this._updateWeather();
        this._updateAgenda();
        this._positionAgenda();
    }

    _updateMusic() {
        const status = shell("playerctl status 2>/dev/null");
        if (!status) {
            this._musicCard.hide();
            return;
        }

        const title = shell("playerctl metadata --format '{{title}}' 2>/dev/null");
        const artist = shell("playerctl metadata --format '{{artist}}' 2>/dev/null");

        if (!title && !artist) {
            this._musicCard.hide();
            return;
        }

        this._musicTitle.text = title || 'Now Playing';
        this._musicArtist.text = artist || '';
        this._musicState.text = status === 'Playing' ? '❚❚' : '▶';
        this._musicCard.show();
    }
}

export default DashboardExtension;
