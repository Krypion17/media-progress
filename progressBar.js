import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from 'gi://St';


import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';

export class ProgressBarManager extends Slider {
    _init(mediaSource, messages) {
        super._init(0);
        
        const DBusIface = loadInterfaceXML('org.freedesktop.DBus');
        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

        this._dbusProxy = new DBusProxy(Gio.DBus.session, 
                             'org.freedesktop.DBus',
                             '/org/freedesktop/DBus',
                             this._onProxyReady.bind(this));


        this._mediaSource = mediaSource;
        this._messages = messages;

        
        this.signals = {};
        this.bars = {};
    }

    _addProgress(name, owners, newOwner, oldOwner) {
        for (let i of this._messages) {
            if (i._player._busName === name) {
                if (owners && !newOwner && oldOwner)
                    return;
                    
                if (i.get_child().get_last_child()?.get_n_children() >= 2 && i.get_child().get_last_child().get_child_at_index(1) instanceof ProgressBar) {
                    return;
                }

                let timestamp1 = new St.Label({
                    style_class: "progressbar-timestamp"
                });
                timestamp1.set_text("0:00");

                let timestamp2 = new St.Label({
                    style_class: "progressbar-timestamp"
                });
                timestamp2.set_text("0:00");

                let progressBar = new ProgressBar(0, this, name, [timestamp1, timestamp2]);
                let box = new St.BoxLayout();
                box.add_child(timestamp1);
                box.add_child(progressBar);
                box.add_child(timestamp2);
                i.get_child().add_child(box);
                this.bars[name] = progressBar;
                void this._updateInitialLength(name, timestamp2);
            }
        }
    }

    async _updateInitialLength(name, timestamp) {
        try {
            const reply = await Gio.DBus.session.call(
                name,
                "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Metadata"]),
                null,
                Gio.DBusCallFlags.NONE,
                1000,
                null
            );
            const metadata = reply.recursiveUnpack()[0];
            const seconds = Number(metadata?.['mpris:length'] ?? 0) / 1000000;

            if (!timestamp.get_parent() || !seconds)
                return;

            let length = new Date(0);
            length.setSeconds(seconds);
            timestamp.set_text(length.toISOString().substring(11, 19).replace(/^0(?:0:0?)?/, ''));
        } catch {}
    }

    async _onProxyReady() {
        let names = [];
        try {
            [names] = await this._dbusProxy.ListNamesAsync();
        } catch {
            return;
        }

        names.forEach(name => {
            if (!name.startsWith('org.mpris.MediaPlayer2.'))
                return;

            this._addProgress(name, false);
        });
        this.dbusSignal = this._dbusProxy.connectSignal("NameOwnerChanged", (pproxy, sender, [name, oldOwner, newOwner]) => {
            if (!name.startsWith('org.mpris.MediaPlayer2.'))
                return;
            for (const player of this._mediaSource.players) {
                if (player._busName == name) {
                    this.signals[name] = player.connect('changed', () => {
                        this._addProgress(name, true, newOwner, oldOwner);
                    });
                }
            }

            this.timeout = setTimeout(() => {
                this._addProgress(name, true, newOwner, oldOwner);
            }, 500);
        });
    }

    destroy() {
        clearTimeout(this.timeout);

        for (let i in this.bars) {
            if (!this.bars[i])
                continue;
            this.bars[i].get_parent().destroy();
            delete this.bars[i];
        }

        for (const player of this._mediaSource.players) {
            const _id = this.signals[player._busName];
            if (_id) {
                try { player.disconnect(_id); } catch (e) {}
                delete this.signals[player._busName];
            }
        }

        if (this.dbusSignal) {
            try { this._dbusProxy.disconnectSignal(this.dbusSignal); } catch (e) {}
            this.dbusSignal = null;
        }

        super.destroy();
    }
}

export class ProgressBar extends Slider {
    _init(value, manager, busName, timestamps) {
        super._init(value);

        this._busName = busName;
        this.manager = manager;
        this.timestamps = timestamps;
        this._updateSettings();
        this.updateSignal = St.Settings.get().connect('notify', () => this._updateSettings());
        this._length = 1;
        this._requestTimeoutMs = 1000;
        this._refreshInProgress = false;
        this._updateInProgress = false;
        this._destroyed = false;

        this.signals = [];

        this._initProxy();

        this.interval = setInterval(() => {
            void this._refresh();
        }, 1000);

        this.signals.push(
            this.connect("drag-end", () => {
                if (this._dragging)
                    return;
                this.setPosition(this.value * this._length);
            }),
            this.connect("destroy", this._onDestroy.bind(this))
        );
    }

    _formatDuration(seconds) {
        let text = new Date(0);
        text.setUTCSeconds(Math.max(0, seconds));
        return text.toISOString().substring(11, 19).replace(/^0(?:0:0?)?/, '');
    }

    _coerceNumber(value) {
        if (typeof value === "number")
            return value;
        if (typeof value === "bigint")
            return Number(value);
        let number = Number(value ?? 0);
        return Number.isFinite(number) ? number : 0;
    }

    async _refresh() {
        if (this._destroyed || this._refreshInProgress)
            return;

        this._refreshInProgress = true;
        try {
            if (this._dragging)
                return;

            if (!this._length)
                await this._updateInfo();

            if (!this._length)
                return;

            let position = this.value * this._length;
            const playbackStatus = await this.getProperty("PlaybackStatus");
            if (playbackStatus === "Playing") {
                const remotePosition = await this.getProperty("Position");
                if (remotePosition !== null)
                    position = this._coerceNumber(remotePosition);
            }

            if (!this._length)
                return;

            this.value = Math.max(0, Math.min(1, position / this._length));
            try {
                this.timestamps[0].set_text(this._formatDuration(position / 1000000));
            } catch {}
        } catch {}
        finally {
            this._refreshInProgress = false;
        }
    }

    async _updateInfo() {
        if (this._destroyed || this._updateInProgress)
            return;

        this._updateInProgress = true;
        try {
            if (!this._playerProxy)
                this._initProxy();

            if (!this._playerProxy)
                return;

            const metadata = await this.getProperty("Metadata");
            this._trackId = metadata?.['mpris:trackid'] ?? 0;
            const canSeek = Boolean(await this.getProperty("CanSeek"));
            this.reactive = Boolean(this._trackId) && canSeek;

            this._length = this._coerceNumber(metadata?.['mpris:length'] ?? 0);
            if (!this._length) {
                this.visible = false;
                this.timestamps[0].visible = false;
                this.timestamps[1].visible = false;
                return;
            }

            this.visible = true;
            this.timestamps[0].visible = true;
            this.timestamps[1].visible = true;

            try {
                this.timestamps[1].set_text(this._formatDuration(this._length / 1000000));
            } catch {}
        } catch {}
        finally {
            this._updateInProgress = false;
        }
    }

    async getProperty(prop) {
        if (!this._playerProxy)
            return null;

        try {
            return (await this._playerProxy.get_connection().call(
                this._busName,
                "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", prop]),
                null,
                Gio.DBusCallFlags.NONE,
                this._requestTimeoutMs,
                null
            )).recursiveUnpack()[0];
        } catch {
            return null;
        }
    }

    setPosition(value) {
        void this._setPositionAsync(value);
    }

    async _setPositionAsync(value) {
        if (!this._playerProxy || !this._trackId)
            return;

        try {
            await this._playerProxy.get_connection().call(
                this._busName,
                "/org/mpris/MediaPlayer2",
                "org.mpris.MediaPlayer2.Player",
                "SetPosition",
                new GLib.Variant("(ox)", [this._trackId, Math.round(this._coerceNumber(value))]),
                null,
                Gio.DBusCallFlags.NONE,
                this._requestTimeoutMs,
                null
            );
        } catch {}
    }
           
    _onPlayerProxyReady() {
        this._playerProxy.connectObject('g-properties-changed', () => void this._updateInfo(), this);
        void this._updateInfo();
    }

    _updateSettings() {
        if (GLib.get_os_info("NAME").includes("Ubuntu"))
            this.add_style_class_name("progress-bar-ubuntu");
        else
            this.remove_style_class_name("progress-bar-ubuntu");

        if (St.Settings.get().color_scheme === 0 && GLib.get_os_info("NAME").includes("Ubuntu")) {
            this.remove_style_class_name('progress-bar');
            this.add_style_class_name('progress-bar-light');
        } else if (St.Settings.get().color_scheme === 2) {
            this.remove_style_class_name('progress-bar');
            this.add_style_class_name('progress-bar-light');
        } else {
            this.remove_style_class_name('progress-bar-light');
            this.add_style_class_name('progress-bar');
        }
    }

    _initProxy() {
        try {
            const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
            const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

            this._playerProxy = new MprisPlayerProxy(Gio.DBus.session, this._busName, '/org/mpris/MediaPlayer2', this._onPlayerProxyReady.bind(this));
        } catch {}
    }

    _onDestroy() {
        this._destroyed = true;
        this.signals.map((i) => {
            this.disconnect(i);
        });
        if (this._playerProxy) {
            try { this._playerProxy.disconnectObject(this); } catch {}
        }
        if (this.updateSignal) { try { St.Settings.get().disconnect(this.updateSignal); } catch (e) {} this.updateSignal = null; }
        clearInterval(this.interval);
        this._playerProxy = null;
        if (this.manager.bars[this._busName])
            delete this.manager.bars[this._busName];
    }
}

GObject.registerClass(ProgressBarManager);
GObject.registerClass(ProgressBar);
