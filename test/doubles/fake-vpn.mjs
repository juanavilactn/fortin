/**
 * Tunnel controller double, with the same surface as VpnController.
 *
 * It never spawns a process. connect() writes the credentials and the settings
 * it sees to the file named by FCVPN_FAKE_DUMP, so a test can check which
 * password won between the command line, the store and the file, and then
 * reports the tunnel as connected. Without FCVPN_FAKE_DUMP nothing is written.
 *
 * It is loaded by test/doubles/hook.mjs (FCVPN_FAKE_PROVIDER=1) inside a child
 * process, and imported directly by the tests that build a session in this one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export * from '../../src/core/vpn.js';

function dumpFile() {
  return String(process.env.FCVPN_FAKE_DUMP ?? '').trim();
}

export class VpnController extends EventEmitter {
  constructor({ config = {}, logger = null, provider = null, screenshotsDir = null, debugScreenshots = false } = {}) {
    super();
    this.config = config;
    this.logger = logger;
    this.provider = provider;
    this.screenshotsDir = screenshotsDir;
    this.debugScreenshots = debugScreenshots;
    this.state = 'disconnected';
    this.message = '';
    this.connectCalls = 0;
    this.disconnectCalls = 0;
    this.releaseForQuitCalls = 0;
  }

  getState() {
    return this.state;
  }

  getStateInfo() {
    return { state: this.state, message: this.message, since: Date.now(), pid: null };
  }

  isHolding() {
    return false;
  }

  /** Emits the same sequence of states as the real controller, without a tunnel. */
  async connect({ authMethod = 'push', foreground = false } = {}) {
    this.connectCalls += 1;
    this.#setState('connecting');

    const effect = {
      password: this.config.password ?? '',
      totpSecret: this.config.totpSecret ?? '',
      server: this.config.vpnServer ?? '',
      port: this.config.vpnPort ?? '',
      authMethod,
      foreground: Boolean(foreground),
      headless: this.config.headless !== false,
    };
    const file = dumpFile();
    if (file !== '') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(effect, null, 2)}\n`);
    }

    this.#setState('connected');
    return { pid: null };
  }

  async disconnect() {
    this.disconnectCalls += 1;
    this.#setState('disconnected');
    return true;
  }

  async cancel() {
    this.#setState('disconnected');
    return true;
  }

  async refreshStatus() {
    return this.getStateInfo();
  }

  handleSuspend() {}

  async handleResume() {
    return this.getStateInfo();
  }

  releaseForQuit() {
    this.releaseForQuitCalls += 1;
  }

  dispose() {}

  #setState(state, message = '') {
    this.state = state;
    this.message = message;
    this.emit('state', { state, message, since: Date.now(), pid: null });
  }
}
