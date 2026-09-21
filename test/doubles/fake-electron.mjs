/**
 * Electron, replaced by a recording double.
 *
 * src/main/tray.js and src/main/ipc.js are the only modules of the application
 * that run inside Electron, and this double is what lets `node --test` import
 * them with no Electron process, no window and no tray. It mirrors the call
 * surface of those two modules and nothing else:
 *
 *   Menu.buildFromTemplate      the template comes back as the items of a menu
 *   Tray                        an EventEmitter with the tooltip, the images and
 *                               the menus the module handed it
 *   nativeImage.createFromPath  empty when the file is not there, as Electron is
 *   screen.getPrimaryDisplay    a display of scale factor 1
 *   ipcMain.handle              the listeners, by channel, removed by removeHandler
 *   shell.openPath              answers no error and records the folder
 *
 * test/tray.test.js maps the 'electron' specifier to this file with
 * registerHooks() before it imports the modules under test, so the test and the
 * two modules share this one instance.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';

/** Every tray the module created, oldest first. */
export const trays = [];

/** The tray icon, as much of it as src/main/tray.js uses. */
export class Tray extends EventEmitter {
  constructor(image) {
    super();
    this.image = image;
    this.images = [image];
    this.tooltip = '';
    this.contextMenus = [];
    this.poppedMenus = [];
    this.destroyed = false;
    trays.push(this);
  }

  setToolTip(text) {
    this.tooltip = text;
  }

  setImage(image) {
    this.image = image;
    this.images.push(image);
  }

  setContextMenu(menu) {
    this.contextMenus.push(menu);
  }

  popUpContextMenu(menu) {
    this.poppedMenus.push(menu);
  }

  destroy() {
    this.destroyed = true;
  }
}

export const Menu = {
  buildFromTemplate(template) {
    return { items: template };
  },
};

export const nativeImage = {
  createFromPath(target) {
    const image = {
      path: target,
      templateImage: null,
      isEmpty: () => !fs.existsSync(target),
      setTemplateImage(value) {
        image.templateImage = value;
      },
    };
    return image;
  },
};

export const screen = {
  getPrimaryDisplay: () => ({ scaleFactor: 1 }),
};

export const ipcMain = {
  handlers: new Map(),
  handle(channel, listener) {
    ipcMain.handlers.set(channel, listener);
  },
  removeHandler(channel) {
    ipcMain.handlers.delete(channel);
  },
};

export const shell = {
  opened: [],
  async openPath(folder) {
    shell.opened.push(folder);
    return '';
  },
};
