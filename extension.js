import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ProgressBarManager as ProgressBarManager, ProgressBar as ProgressBar } from "./progressBar.js";
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class mediaProgress extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    enable() {
        this.message_view = Main.panel.statusArea.dateMenu._messageList._messageView;
        this.progressBarManager = new ProgressBarManager(this.message_view);
    }

    disable() {
        this.progressBarManager?.destroy();
        this.progressBarManager = null;
        this.message_view = null;
    }
}
