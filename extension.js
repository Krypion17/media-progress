import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ProgressBarManager as ProgressBarManager, ProgressBar as ProgressBar } from "./progressBar.js";
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class mediaProgress extends Extension {
    constructor(metadata) {
        super(metadata);

        this.message_view = Main.panel.statusArea.dateMenu._messageList._messageView;
    }

    _user() {
        this.unlockManager?.destroy();
        this.unlockManager = null;
        this.notifBox = null;
        this.progressBarManager = new ProgressBarManager(this.message_view._mediaSource, this.message_view.messages);
    }

    _unlockDialog() {
        this.progressBarManager?.destroy();
        this.progressBarManager = null;
        this.notifBox = Main.screenShield._dialog._notificationsBox;
        const loadSignal = this.notifBox._notificationBox.connect("child-added", () => {
            this.notifBox._notificationBox.disconnect(loadSignal);
            // The messages are loaded in slightly late
            // So we wait for the first one to get added and initialise
            this.unlockManager = new ProgressBarManager(this.notifBox._mediaSource, this.notifBox._notificationBox);
        });
    }

    _onSessionModeChange(session) {
        if (session.currentMode === "user" || session.parentMode === "user")
            this._user();
        else if (session.currentMode === "unlock-dialog")
            this._unlockDialog();
    }

    enable() {
        this._onSessionModeChange(Main.sessionMode);

        this._sessionId = Main.sessionMode.connect('updated', this._onSessionModeChange.bind(this));
    }

    disable() {
        // unlock-dialog session mode use required to add progress bar to lockscreen media message 

        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = null;
        }

        this.progressBarManager?.destroy();
        this.unlockManager?.destroy();
        this.progressBarManager = null;
        this.unlockManager = null;
        this.message_view = null;
        this.notifBox = null;
    }
}
