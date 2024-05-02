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

        this.timestamp1 = new St.Label({
            style_class: "progressbar-timestamp"
        });
        this.timestamp1.set_text("0:00");

        this.timestamp2 = new St.Label({
            style_class: "progressbar-timestamp"
        });

        this.signals = [];
    }

    _addProgress(name, owners, newOwner, oldOwner) {
        for (let i of this._mediaSection._messages) {
            if (i._player._busName === name) {
                if (owners && !newOwner && oldOwner)
                    return;
                    
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
    
                for (let j of i.get_child().get_children()) {
                    if (j instanceof ProgressBar)
                        return;
                }
                let progressBar = new ProgressBar(0, this, name);
                let box = new St.BoxLayout();
                let length = playerProxy.Metadata["mpris:length"].deepUnpack() / 60000000;
                playerProxy = null;
                this.timestamp2.set_text(`${Math.floor(length)}:${Math.floor((length - Math.floor(length))*60).toLocaleString('en-US', {minimumIntegerDigits: 2, useGrouping:false})}`);
                box.add_child(this.timestamp1);
                box.add_child(progressBar);
                box.add_child(this.timestamp2);
                i.get_child().add_child(box);

                this.signals.push(i._player.connect('closed', () => {
                    if (timeout)
                        clearInterval(timeout);
                }));
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
    
            this.timeout = setTimeout(() => {
                this._addProgress(name, true, newOwner, oldOwner);
            }, 500);
        }));
    }

    destroy() {
        this.signals.map((i) => {
            this.disconnect(i);
        });

        clearTimeout(this.timeout);

        for (let i of this._mediaSection._messages) {
            for (let j of i.get_child().get_children()) {
                if (j.get_children()[1] instanceof ProgressBar) {
                    i.get_child().remove_child(j);
                    j.get_children()[1]?.destroy();
                    j?.destroy();
                }
            }
        }
    }
}

export class ProgressBar extends Slider {
    _init(value, manager, busName) {
        super._init(value);

        this._busName = busName;
        this.manager = manager;
        this.timestamp = manager.timestamp1;
        this.add_style_class_name('progress-bar');
        this.track_hover = true;

        this.signals = [];

        const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
        const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

        this._playerProxy = new MprisPlayerProxy(Gio.DBus.session, this._busName, '/org/mpris/MediaPlayer2', this._onPlayerProxyReady.bind(this));

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
            this.timestamp.set_text(`${Math.floor(position)}:${Math.floor((position - Math.floor(position))*60).toLocaleString('en-US', {minimumIntegerDigits: 2, useGrouping:false})}`);
        }, 1000);

        this.signals.push(this.connect("drag-end", () => {
            if (this._dragging)
                return;
            this.setPosition(this.value * this._length);
        }));
    }

    _updateInfo() {
        this._trackId = this._playerProxy.Metadata["mpris:trackid"].deepUnpack();
        this._length = this._playerProxy.Metadata["mpris:length"].deepUnpack();
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

    async _onPlayerProxyReady() {
        this._updateInfo();
        this.signals.push(this._playerProxy.connectObject('g-properties-changed', () => this._updateInfo(), this));
    }

    destroy() {
        this.signals.map((i) => {
            this.disconnect(i);
        });
        clearInterval(timeout);
    }
}

GObject.registerClass(ProgressBarManager);
GObject.registerClass(ProgressBar);
