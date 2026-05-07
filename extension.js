import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ProgressBarManager } from "./progressBar.js";
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const SESSION_MODE_USER = "user";
const SESSION_MODE_UNLOCK_DIALOG = "unlock-dialog";
const SESSION_UPDATED_SIGNAL = "updated";
const CHILD_ADDED_SIGNAL = "child-added";

export default class mediaProgress extends Extension {
    constructor(metadata) {
        super(metadata);

        this.message_view = null;
        this._unlockSignalId = null;
        this._unlockNotificationBox = null;
    }

    _user() {
        this.unlockManager?.destroy();
        this.unlockManager = null;
        this.notifBox = null;
        if (!this.message_view?._mediaSource || !this.message_view?.messages)
            return;

        this.progressBarManager = new ProgressBarManager(this.message_view._mediaSource, this.message_view.messages);
    }

    _unlockDialog() {
        this.progressBarManager?.destroy();
        this.progressBarManager = null;
        this.notifBox = Main.screenShield?._dialog?._notificationsBox;
        if (!this.notifBox?._notificationBox)
            return;

        if (this._unlockSignalId && this._unlockNotificationBox) {
            this._unlockNotificationBox.disconnect(this._unlockSignalId);
            this._unlockSignalId = null;
            this._unlockNotificationBox = null;
        }

        this._unlockNotificationBox = this.notifBox._notificationBox;
        this._unlockSignalId = this._unlockNotificationBox.connect(CHILD_ADDED_SIGNAL, () => {
            try {
                this._unlockNotificationBox?.disconnect(this._unlockSignalId);
            } catch {}
            this._unlockSignalId = null;
            this._unlockNotificationBox = null;
            // The messages are loaded in slightly late
            // So we wait for the first one to get added and initialise
            if (!this.notifBox?._mediaSource || !this.notifBox?._notificationBox)
                return;
            this.unlockManager = new ProgressBarManager(this.notifBox._mediaSource, this.notifBox._notificationBox);
        });
    }

    _onSessionModeChange(session) {
        if (!session)
            return;

        if (session.currentMode === SESSION_MODE_USER || session.parentMode === SESSION_MODE_USER)
            this._user();
        else if (session.currentMode === SESSION_MODE_UNLOCK_DIALOG)
            this._unlockDialog();
    }

    enable() {
        this.message_view = Main.panel?.statusArea?.dateMenu?._messageList?._messageView ?? null;
        this._onSessionModeChange(Main.sessionMode);

        this._sessionId = Main.sessionMode.connect(SESSION_UPDATED_SIGNAL, this._onSessionModeChange.bind(this));
    }

    disable() {
        // unlock-dialog session mode use required to add progress bar to lockscreen media message

        if (this._sessionId) {
            Main.sessionMode.disconnect(this._sessionId);
            this._sessionId = null;
        }

        if (this._unlockSignalId && this._unlockNotificationBox) {
            try {
                this._unlockNotificationBox.disconnect(this._unlockSignalId);
            } catch {}
            this._unlockSignalId = null;
            this._unlockNotificationBox = null;
        }

        this.progressBarManager?.destroy();
        this.unlockManager?.destroy();
        this.progressBarManager = null;
        this.unlockManager = null;
        this.message_view = null;
        this.notifBox = null;
    }
}
