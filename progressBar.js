import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from 'gi://St';


import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';

export class ProgressBarManager extends Slider {
    _init(messageView) {
        super._init(0);
        
        const DBusIface = loadInterfaceXML('org.freedesktop.DBus');
        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

        this._dbusProxy = new DBusProxy(Gio.DBus.session, 
                             'org.freedesktop.DBus',
                             '/org/freedesktop/DBus',
                             this._onProxyReady.bind(this));


        this._messageView = messageView;

        
        this.signals = [];
        this.bars = {};
    }

    _addProgress(name, owners, newOwner, oldOwner) {
        for (let i of this._messageView.messages) {
            if (i._player._busName === name) {
                if (owners && !newOwner && oldOwner)
                    return;
                    
                if (i.get_child().get_last_child()?.get_n_children() >= 2 && i.get_child().get_last_child().get_child_at_index(1) instanceof ProgressBar) {
                    return;
                }

                let seconds = 0;

                const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
                const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

                let playerProxy = new MprisPlayerProxy(Gio.DBus.session, name, '/org/mpris/MediaPlayer2', () => {
                    try {
                        seconds = playerProxy.get_connection().call_sync(
                            name,
                            "/org/mpris/MediaPlayer2",
                            "org.freedesktop.DBus.Properties",
                            "Get",
                            new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Metadata"]),
                            null,
                            Gio.DBusCallFlags.NONE,
                            50,
                            null
                        ).recursiveUnpack()[0]['mpris:length'] / 1000000;
                    } catch {
                        return;
                    }
                });
                let timestamp1 = new St.Label({
                    style_class: "progressbar-timestamp"
                });
                timestamp1.set_text("0:00");

                let timestamp2 = new St.Label({
                    style_class: "progressbar-timestamp"
                });

                let progressBar = new ProgressBar(0, this, name, [timestamp1, timestamp2]);
                let box = new St.BoxLayout();
                let length = new Date(0);
                length.setSeconds(seconds);
                timestamp2.set_text(length.toISOString().substring(11,19).replace(/^0(?:0:0?)?/, ''));
                box.add_child(timestamp1);
                box.add_child(progressBar);
                box.add_child(timestamp2);
                i.get_child().add_child(box);
                this.bars[name] = progressBar;
            }
        }
    }

    async _onProxyReady() {
        const [names] = await this._dbusProxy.ListNamesAsync().catch();
        names.forEach(name => {
            if (!name.startsWith('org.mpris.MediaPlayer2.'))
                return;

            this._addProgress(name, false);
        });
        this.dbusSignal = this._dbusProxy.connectSignal("NameOwnerChanged", (pproxy, sender, [name, oldOwner, newOwner]) => {
            if (!name.startsWith('org.mpris.MediaPlayer2.'))
                return;
            for (let i in this._messageView._mediaSource.players) {
                if (i._busName == name) {
                    this.signals[name] = i.connect('changed', () => {
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

        for (let i in this._messageView._mediaSource.players) {
            if (i._busName in this.signals)
                i.disconnect(this.signals[i._busName]);
        }

        this._dbusProxy.disconnectSignal(this.dbusSignal)

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

        this.signals = [];

        this._initProxy();

        this.interval = setInterval(() => {
            if (this._dragging)
                return;
            if (!this.length)
                this._updateInfo();

            let position;
            if (this.getProperty("PlaybackStatus") === "Playing")
                position = this.getProperty("Position");
            else
                position = this.value * this._length;

            this.value = position / this._length;
            position = position / 1000000;
            let text = new Date(0);
            text.setUTCSeconds(position);
            try {
                this.timestamps[0].set_text(text.toISOString().substring(11,19).replace(/^0(?:0:0?)?/, ''));
            } catch {}
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

    _updateInfo() {
        if (!this._playerProxy)
            this._initProxy();
        this._trackId = this.getProperty("Metadata")['mpris:trackid'];
        if (!this._trackId)
            this.reactive = false;
        if (this._trackId !== 0 && this.getProperty("CanSeek"))
            this.reactive = true;
        this._length = this.getProperty("Metadata")['mpris:length'];
        if (!this._length) {
            this.visible = false;
            this.timestamps[0].visible = false;
            this.timestamps[1].visible = false;
            return;
        } else {
            this.visible = true;
            this.timestamps[0].visible = true;
            this.timestamps[1].visible = true;
        }

        let position = this._length / 1000000;
        let text = new Date(0);
        text.setUTCSeconds(position);
        this.timestamps[1].set_text(text.toISOString().substring(11,19).replace(/^0(?:0:0?)?/, ''));
    }

    getProperty(prop) {
        try {
            return this._playerProxy.get_connection().call_sync(
                this._busName,
                "/org/mpris/MediaPlayer2",
                "org.freedesktop.DBus.Properties",
                "Get",
                new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", prop]),
                null,
                Gio.DBusCallFlags.NONE,
                50,
                null
            ).recursiveUnpack()[0];
        } catch {
            return 0;
        }
    }

    setPosition(value) {
        this._playerProxy.get_connection().call_sync(
            this._busName,
            "/org/mpris/MediaPlayer2",
            "org.mpris.MediaPlayer2.Player",
            "SetPosition",
            new GLib.Variant("(ox)", [this._trackId, value.toString()]),
            null,
            Gio.DBusCallFlags.NONE,
            50,
            null
        );
    }
           
    _onPlayerProxyReady() {
        this._playerProxy.connectObject('g-properties-changed', () => this._updateInfo(), this);
        this._updateInfo();
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

            this._playerProxy = MprisPlayerProxy(Gio.DBus.session, this._busName, '/org/mpris/MediaPlayer2', this._onPlayerProxyReady.bind(this));
        } catch {}
    }

    _onDestroy() {
        this.signals.map((i) => {
            this.disconnect(i);
        });
        this._playerProxy.disconnectObject(this);
        St.Settings.get().disconnect(this.updateSignal);
        clearInterval(this.interval);
        this._playerProxy = null;
        if (this.manager.bars[this._busName])
            delete this.manager.bars[this._busName];
    }
}

GObject.registerClass(ProgressBarManager);
GObject.registerClass(ProgressBar);
