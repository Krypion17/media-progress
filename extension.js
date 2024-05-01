import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { ProgressBarManager as ProgressBarManager, timeout as timeout, ProgressBar as ProgressBar } from "./progressBar.js";
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class extension extends Extension {
    constructor(metadata) {
        super(metadata);
    }

    enable() {
        this.media_section = Main.panel.statusArea.dateMenu._messageList._mediaSection;
        this.progressBarManager = new ProgressBarManager(this.media_section);
    }

    disable() {
        if (this.media_section._messages.length == 0)
            return;

        for (let i of this.progressBarManager.signals) {
            this.progressBarManager.disconnect(i);
        }

        for (let i of this.media_section._messages) {
            clearInterval(timeout);
            for (let j of i.get_child().get_children()) {
                if (j.get_children()[1] instanceof ProgressBar) {
                    i.get_child().remove_child(j);
                    for (let k of j.get_children()[1].signals) {
                        j.get_children()[1].disconnect(k);
                    }
                    j.get_children()[1].destroy();
                    j.destroy();
                }
            }
        }
        this.progressBarManager = null;
        this.media_section = null;
    }
}
