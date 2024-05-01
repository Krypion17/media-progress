import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
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

        log(this.media_section._messages);
        for (let i of this.media_section._messages) {
            clearInterval(timeout);
            // this.media_section._messages.remove_actor(progressBar).catch(() => log("not removed"));
            for (let j of i.get_child().get_children()) {
                if (j.get_children()[1] instanceof ProgressBar) {
                    i.get_child().remove_child(j);
                    j.destroy();
                }
            }
        }
        this.progressBarManager = null;
        this.media_section = null;
    }
}
