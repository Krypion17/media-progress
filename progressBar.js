import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import { Slider } from "resource:///org/gnome/shell/ui/slider.js";
import { loadInterfaceXML } from "resource:///org/gnome/shell/misc/fileUtils.js";

const LOG_PREFIX = "media-progress";

const DBUS_NAME = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const DBUS_INTERFACE = "org.freedesktop.DBus";
const DBUS_PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties";
const DBUS_PROPERTIES_GET_METHOD = "Get";

const MPRIS_BUS_PREFIX = "org.mpris.MediaPlayer2.";
const MPRIS_PATH = "/org/mpris/MediaPlayer2";
const MPRIS_PLAYER_INTERFACE = "org.mpris.MediaPlayer2.Player";
const MPRIS_SET_POSITION_METHOD = "SetPosition";

const NAME_OWNER_DEBOUNCE_MS = 500;
const DBUS_CALL_TIMEOUT_MS = 1000;
const POLL_INTERVAL_MS = 1000;
const MICROSECONDS_PER_SECOND = 1000000;
const ZERO_TIMESTAMP = "0:00";
const MIN_SLIDER_VALUE = 0;
const MAX_SLIDER_VALUE = 1;
const TIME_START_INDEX = 11;
const TIME_END_INDEX = 19;

const TRANSIENT_DBUS_ERROR_FRAGMENTS = [
    "org.freedesktop.DBus.Error.NameHasNoOwner",
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.UnknownObject",
    "org.freedesktop.DBus.Error.UnknownMethod",
    "org.freedesktop.DBus.Error.NoReply",
    "Gio.IOErrorEnum.CANCELLED",
    "The connection is closed",
];

const DBUS_PROXY_WRAPPER = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML(DBUS_INTERFACE));
const MPRIS_PLAYER_PROXY_WRAPPER = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML(MPRIS_PLAYER_INTERFACE));

function _errorToString(error) {
    if (!error)
        return "unknown error";
    if (error.message)
        return error.message;
    return String(error);
}

function _isTransientDbusError(error) {
    const message = _errorToString(error);
    return TRANSIENT_DBUS_ERROR_FRAGMENTS.some(fragment => message.includes(fragment));
}

function _reportError(context, error, { ignoreTransientDbus = false } = {}) {
    if (ignoreTransientDbus && _isTransientDbusError(error))
        return;

    const detail = `[${LOG_PREFIX}] ${context}`;
    if (error && typeof logError === "function") {
        logError(error, detail);
        return;
    }

    log(`${detail}: ${_errorToString(error)}`);
}

export class ProgressBarManager extends Slider {
    _init(mediaSource, messages) {
        super._init(0);

        this._dbusProxy = new DBUS_PROXY_WRAPPER(
            Gio.DBus.session,
            DBUS_NAME,
            DBUS_PATH,
            this._onProxyReady.bind(this)
        );

        this._mediaSource = mediaSource;
        this._messages = messages;
        this.signals = {};
        this.bars = {};
    }

    _addProgress(name, owners, newOwner, oldOwner) {
        for (const message of this._messages ?? []) {
            try {
                if (message?._player?._busName !== name)
                    continue;

                if (owners && !newOwner && oldOwner)
                    return;

                const messageChild = message?.get_child?.();
                const lastChild = messageChild?.get_last_child?.();
                if (lastChild?.get_n_children?.() >= 2 && lastChild.get_child_at_index?.(1) instanceof ProgressBar)
                    return;

                if (!messageChild?.add_child)
                    continue;

                const timestamp1 = new St.Label({ style_class: "progressbar-timestamp" });
                const timestamp2 = new St.Label({ style_class: "progressbar-timestamp" });
                timestamp1.set_text(ZERO_TIMESTAMP);
                timestamp2.set_text(ZERO_TIMESTAMP);

                const progressBar = new ProgressBar(0, this, name, [timestamp1, timestamp2]);
                const box = new St.BoxLayout();
                box.add_child(timestamp1);
                box.add_child(progressBar);
                box.add_child(timestamp2);
                messageChild.add_child(box);

                this.bars[name] = progressBar;
                void this._updateInitialLength(name, timestamp2);
                return;
            } catch (error) {
                _reportError(`Failed to add progress bar for ${name}`, error);
                return;
            }
        }
    }

    _formatDuration(seconds) {
        const text = new Date(0);
        text.setUTCSeconds(Math.max(0, seconds));
        return text.toISOString().substring(TIME_START_INDEX, TIME_END_INDEX).replace(/^0(?:0:0?)?/, "");
    }

    _setTimestampText(timestamp, seconds) {
        if (!timestamp?.get_parent() || !Number.isFinite(seconds) || seconds <= 0)
            return;

        try {
            timestamp.set_text(this._formatDuration(seconds));
        } catch (error) {
            _reportError("Failed to update initial duration label", error);
        }
    }

    async _updateInitialLength(name, timestamp) {
        try {
            const reply = await Gio.DBus.session.call(
                name,
                MPRIS_PATH,
                DBUS_PROPERTIES_INTERFACE,
                DBUS_PROPERTIES_GET_METHOD,
                new GLib.Variant("(ss)", [MPRIS_PLAYER_INTERFACE, "Metadata"]),
                null,
                Gio.DBusCallFlags.NONE,
                DBUS_CALL_TIMEOUT_MS,
                null
            );
            const metadata = reply.recursiveUnpack()[0];
            const seconds = Number(metadata?.["mpris:length"] ?? 0) / MICROSECONDS_PER_SECOND;
            this._setTimestampText(timestamp, seconds);
        } catch (error) {
            _reportError(`Failed to fetch initial metadata for ${name}`, error, { ignoreTransientDbus: true });
        }
    }

    async _onProxyReady() {
        let names = [];
        try {
            [names] = await this._dbusProxy.ListNamesAsync();
        } catch (error) {
            _reportError("Failed to list MPRIS DBus names", error, { ignoreTransientDbus: true });
            return;
        }

        for (const name of names) {
            if (!name.startsWith(MPRIS_BUS_PREFIX))
                continue;

            this._addProgress(name, false);
        }

        this.dbusSignal = this._dbusProxy.connectSignal("NameOwnerChanged", (_proxy, _sender, [name, oldOwner, newOwner]) => {
            if (!name.startsWith(MPRIS_BUS_PREFIX))
                return;

            for (const player of this._mediaSource?.players ?? []) {
                if (!player?._busName || player._busName !== name)
                    continue;

                if (this.signals[name]) {
                    try {
                        player.disconnect(this.signals[name]);
                    } catch (error) {
                        _reportError(`Failed to disconnect old media signal for ${name}`, error);
                    }
                }

                this.signals[name] = player.connect("changed", () => {
                    this._addProgress(name, true, newOwner, oldOwner);
                });
            }

            clearTimeout(this.timeout);
            this.timeout = setTimeout(() => {
                this._addProgress(name, true, newOwner, oldOwner);
            }, NAME_OWNER_DEBOUNCE_MS);
        });
    }

    destroy() {
        clearTimeout(this.timeout);

        for (const [name, bar] of Object.entries(this.bars)) {
            if (!bar)
                continue;
            try {
                bar.get_parent()?.destroy();
            } catch (error) {
                _reportError(`Failed to destroy progress bar actor for ${name}`, error);
            }
            delete this.bars[name];
        }

        for (const player of this._mediaSource?.players ?? []) {
            if (!player?._busName)
                continue;

            const signalId = this.signals[player._busName];
            if (!signalId)
                continue;

            try {
                player.disconnect(signalId);
            } catch (error) {
                _reportError(`Failed to disconnect player signal for ${player._busName}`, error);
            }
            delete this.signals[player._busName];
        }

        if (this.dbusSignal) {
            try {
                this._dbusProxy.disconnectSignal(this.dbusSignal);
            } catch (error) {
                _reportError("Failed to disconnect DBus NameOwnerChanged signal", error);
            }
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
        this.updateSignal = St.Settings.get().connect("notify", () => this._updateSettings());
        this._length = 0;
        this._requestTimeoutMs = DBUS_CALL_TIMEOUT_MS;
        this._refreshInProgress = false;
        this._updateInProgress = false;
        this._destroyed = false;

        this.signals = [];

        this._initProxy();

        this.interval = setInterval(() => {
            void this._refresh();
        }, POLL_INTERVAL_MS);

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
        const text = new Date(0);
        text.setUTCSeconds(Math.max(0, seconds));
        return text.toISOString().substring(TIME_START_INDEX, TIME_END_INDEX).replace(/^0(?:0:0?)?/, "");
    }

    _coerceNumber(value) {
        if (typeof value === "number")
            return value;
        if (typeof value === "bigint")
            return Number(value);
        const number = Number(value ?? 0);
        return Number.isFinite(number) ? number : 0;
    }

    _microsToSeconds(value) {
        return this._coerceNumber(value) / MICROSECONDS_PER_SECOND;
    }

    _setTimestampText(index, text) {
        if (this._destroyed || !this.get_parent?.())
            return;

        const label = this.timestamps?.[index];
        if (!label?.get_parent())
            return;

        try {
            label.set_text(text);
        } catch (error) {
            _reportError(`Failed to update timestamp label ${index} for ${this._busName}`, error);
        }
    }

    _setTimestampsVisible(visible) {
        if (this._destroyed || !this.get_parent?.())
            return;

        for (const label of this.timestamps ?? []) {
            if (label)
                label.visible = visible;
        }
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

            this.value = Math.max(MIN_SLIDER_VALUE, Math.min(MAX_SLIDER_VALUE, position / this._length));
            this._setTimestampText(0, this._formatDuration(this._microsToSeconds(position)));
        } catch (error) {
            _reportError(`Failed to refresh progress for ${this._busName}`, error, { ignoreTransientDbus: true });
        } finally {
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
            this._trackId = metadata?.["mpris:trackid"] ?? 0;
            const canSeek = Boolean(await this.getProperty("CanSeek"));
            this.reactive = Boolean(this._trackId) && canSeek;

            this._length = this._coerceNumber(metadata?.["mpris:length"] ?? 0);
            if (!this._length) {
                this.visible = false;
                this._setTimestampsVisible(false);
                return;
            }

            this.visible = true;
            this._setTimestampsVisible(true);
            this._setTimestampText(1, this._formatDuration(this._microsToSeconds(this._length)));
        } catch (error) {
            _reportError(`Failed to update metadata for ${this._busName}`, error, { ignoreTransientDbus: true });
        } finally {
            this._updateInProgress = false;
        }
    }

    async getProperty(prop) {
        if (!this._playerProxy)
            return null;

        try {
            return (await this._playerProxy.get_connection().call(
                this._busName,
                MPRIS_PATH,
                DBUS_PROPERTIES_INTERFACE,
                DBUS_PROPERTIES_GET_METHOD,
                new GLib.Variant("(ss)", [MPRIS_PLAYER_INTERFACE, prop]),
                null,
                Gio.DBusCallFlags.NONE,
                this._requestTimeoutMs,
                null
            )).recursiveUnpack()[0];
        } catch (error) {
            _reportError(`Failed to read ${prop} for ${this._busName}`, error, { ignoreTransientDbus: true });
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
                MPRIS_PATH,
                MPRIS_PLAYER_INTERFACE,
                MPRIS_SET_POSITION_METHOD,
                new GLib.Variant("(ox)", [this._trackId, Math.round(this._coerceNumber(value))]),
                null,
                Gio.DBusCallFlags.NONE,
                this._requestTimeoutMs,
                null
            );
        } catch (error) {
            _reportError(`Failed to set position for ${this._busName}`, error, { ignoreTransientDbus: true });
        }
    }

    _onPlayerProxyReady() {
        if (!this._playerProxy || this._destroyed)
            return;

        this._playerProxy.connectObject("g-properties-changed", () => void this._updateInfo(), this);
        void this._updateInfo();
    }

    _updateSettings() {
        if (this._destroyed || !this.get_parent?.())
            return;

        const osName = GLib.get_os_info("NAME") ?? "";
        const isUbuntu = osName.includes("Ubuntu");
        if (isUbuntu)
            this.add_style_class_name("progress-bar-ubuntu");
        else
            this.remove_style_class_name("progress-bar-ubuntu");

        if ((St.Settings.get().color_scheme === 0 && isUbuntu) || St.Settings.get().color_scheme === 2) {
            this.remove_style_class_name("progress-bar");
            this.add_style_class_name("progress-bar-light");
            return;
        }

        this.remove_style_class_name("progress-bar-light");
        this.add_style_class_name("progress-bar");
    }

    _initProxy() {
        try {
            this._playerProxy = new MPRIS_PLAYER_PROXY_WRAPPER(
                Gio.DBus.session,
                this._busName,
                MPRIS_PATH,
                this._onPlayerProxyReady.bind(this)
            );
        } catch (error) {
            _reportError(`Failed to initialize MPRIS proxy for ${this._busName}`, error, { ignoreTransientDbus: true });
        }
    }

    _onDestroy() {
        this._destroyed = true;
        for (const signalId of this.signals) {
            try {
                this.disconnect(signalId);
            } catch (error) {
                _reportError(`Failed to disconnect local signal ${signalId} for ${this._busName}`, error);
            }
        }

        if (this._playerProxy) {
            try {
                this._playerProxy.disconnectObject(this);
            } catch (error) {
                _reportError(`Failed to disconnect proxy object for ${this._busName}`, error);
            }
        }

        if (this.updateSignal) {
            try {
                St.Settings.get().disconnect(this.updateSignal);
            } catch (error) {
                _reportError(`Failed to disconnect settings signal for ${this._busName}`, error);
            }
            this.updateSignal = null;
        }

        clearInterval(this.interval);
        this._playerProxy = null;

        if (this.manager?.bars?.[this._busName])
            delete this.manager.bars[this._busName];
    }
}

GObject.registerClass(ProgressBarManager);
GObject.registerClass(ProgressBar);
