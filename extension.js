import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ProgressBarManager as ProgressBarManager, ProgressBar as ProgressBar } from "./progressBar.js";
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class mediaProgress extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    enable() {
        this.media_section = Main.panel.statusArea.dateMenu._messageList._mediaSection;
        this.progressBarManager = new ProgressBarManager(this.media_section);
    }

    disable() {
        this.progressBarManager?.destroy();
        this.progressBarManager = null;

        for (let i of this.media_section._messages) {
            for (let j of i.get_child().get_children()) {
                if (j.get_children()[1] instanceof ProgressBar) {
                    i.get_child().remove_child(j);
                    j.get_children()[1]?.destroy();
                    j?.destroy();
                }
            }
        }
        this.media_section = null;
    }
}
