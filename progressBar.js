import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from 'gi://St';


import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import { loadInterfaceXML } from 'resource:///org/gnome/shell/misc/fileUtils.js';

let timeout;

export class ProgressBarManager extends Slider {
    _init(mediaSection) {
        super._init(0);
        
        const DBusIface = loadInterfaceXML('org.freedesktop.DBus');
        const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

        this._dbusProxy = new DBusProxy(Gio.DBus.session, 
                             'org.freedesktop.DBus',
                             '/org/freedesktop/DBus',
                             this._onProxyReady.bind(this));


        this._mediaSection = mediaSection;

        
        this.signals = [];
        this.bars = {};
    }

    _addProgress(name, owners, newOwner, oldOwner) {
        for (let i of this._mediaSection._messages) {
            if (i._player._busName === name) {
                if (owners && !newOwner && oldOwner)
                    return;
                    
                try {
                    if (i.get_child().get_last_child().get_child_at_index(1) instanceof ProgressBar) 
                        return;
                } catch {
                    return;
                }

                let position = true;

                const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
                const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

                let playerProxy = new MprisPlayerProxy(Gio.DBus.session, name, '/org/mpris/MediaPlayer2');
                
                try {
                    playerProxy.Metadata["mpris:length"].deepUnpack();
                } catch (e) {
                    position = false;
                }

                if (!position)
                    return;

                let timestamp1 = new St.Label({
                    style_class: "progressbar-timestamp"
                });
                timestamp1.set_text("0:00");

                let timestamp2 = new St.Label({
                    style_class: "progressbar-timestamp"
                });

                let progressBar = new ProgressBar(0, this, name, [timestamp1, timestamp2]);
                let box = new St.BoxLayout();
                let length = playerProxy.Metadata["mpris:length"].deepUnpack() / 60000000;
                playerProxy = null;
                timestamp2.set_text(`${Math.floor(length)}:${Math.floor((length - Math.floor(length))*60).toLocaleString('en-US', {minimumIntegerDigits: 2, useGrouping:false})}`);
                box.add_child(timestamp1);
                box.add_child(progressBar);
                box.add_child(timestamp2);
                i.get_child().add_child(box);
                this.bars[name] = progressBar;

                this.signals.push(i._player.connect('closed', (() => {
                    if (timeout)
                        clearInterval(timeout);
                    this.bars[name].destroy();
                    delete this.bars[name]
                })));
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
        this.signals.push(this._dbusProxy.connectSignal("NameOwnerChanged", (pproxy, sender, [name, oldOwner, newOwner]) => {
            if (!name.startsWith('org.mpris.MediaPlayer2.'))
                return;
            this.signals.push(this._mediaSection._players.get(name).connect('changed', () => {
                this._addProgress(name, true, newOwner, oldOwner);
            }));

            this.timeout = setTimeout(() => {
                this._addProgress(name, true, newOwner, oldOwner);
            }, 500);
        }));
    }

    destroy() {
        clearTimeout(this.timeout);

        for (let i in this.bars) {
            this.bars[i].destroy();
            delete this.bars[i];
        }

        this.signals.map((i) => {
            this.disconnect(i);
        });

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
        this.track_hover = true;

        this.signals = [];

        const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
        const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

        this._playerProxy = MprisPlayerProxy(Gio.DBus.session, this._busName, '/org/mpris/MediaPlayer2', this._onPlayerProxyReady.bind(this));

        const position = this.getPosition();
        this.value = position / this._length;

        timeout = setInterval(() => {
            if (this._dragging || this._playerProxy.PlaybackStatus !== "Playing")
                return;
            if (!this) {
                clearInterval(timeout);
                return;
            }
            let position = this.getPosition();

            this.value = position / this._length;
            position = position / 60000000;
            this.timestamps[0].set_text(`${Math.floor(position)}:${Math.floor((position - Math.floor(position))*60).toLocaleString('en-US', {minimumIntegerDigits: 2, useGrouping:false})}`);
        }, 1000);

        this.signals.push(this.connect("drag-end", () => {
            if (this._dragging)
                return;
            this.setPosition(this.value * this._length);
        }));
    }

    _updateInfo() {
        try {
            this._trackId = this._playerProxy.Metadata["mpris:trackid"].deepUnpack();
        } catch {
            this._trackId = 0;
            this.reactive = false;
        }
        this._length = this._playerProxy.Metadata["mpris:length"].deepUnpack();
        this.timestamps[1].set_text(`${Math.floor(this._length / 60000000)}:${Math.floor((this._length / 60000000 - Math.floor(this._length / 60000000))*60).toLocaleString('en-US', {minimumIntegerDigits: 2, useGrouping:false})}`);
    }

    getPosition() {
        return this._playerProxy.get_connection().call_sync(
            this._busName,
            "/org/mpris/MediaPlayer2",
            "org.freedesktop.DBus.Properties",
            "Get",
            new GLib.Variant("(ss)", ["org.mpris.MediaPlayer2.Player", "Position"]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
        ).recursiveUnpack();
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
            -1,
            null
        );
    }

    _onPlayerProxyReady() {
        this.signals.push(this._playerProxy.connectObject('g-properties-changed', () => this._updateInfo(), this));
        this._updateInfo();
    }

    _updateSettings() {
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

    destroy() {
        this.signals.map((i) => {
            this.disconnect(i);
        });
        St.Settings.get().disconnect(this.updateSignal);
        clearInterval(timeout);
        this._playerProxy = null;
        this.timestamps[0].destroy();
        this.timestamps[1].destroy();
        delete this.manager.bars[this._busName];
        super.destroy();
    }
}

GObject.registerClass(ProgressBarManager);
GObject.registerClass(ProgressBar);
