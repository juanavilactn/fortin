import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const SECRET_PATTERNS = [
  [/(SVPNCOOKIE\s*=\s*)[^\s;'"]+/gi, '$1***'],
  [/(--cookie=)[^\s'"]+/gi, '$1***'],
  [/(\bauth_id(?: from URL)?\s*:\s*)[^\s,;]+/gi, '$1***'],
  [/(\bTOTP(?: code)?\s*[:=]\s*)\d{6,8}\b/gi, '$1***'],
];

export function sanitizeLine(message) {
  let clean = String(message).replace(ANSI_PATTERN, '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  // Browser URLs can contain SAML assertions, auth IDs and OAuth tokens. The
  // endpoint identifies the sign-in step without retaining its credentials.
  clean = clean.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/([?#]).*$/, '$1***'));
  return clean;
}

function formatArgument(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export class Logger extends EventEmitter {
  #filePath = null;
  #disposed = false;

  /**
   * `mirror` names the stream the lines are copied to: 'stdout' (default),
   * 'stderr' when the standard output carries machine readable output, or
   * 'none'. Error lines always go to stderr. `mirrorToStdout` is the older
   * boolean form and is kept for the callers that predate it.
   */
  constructor({ logDir, toFile = true, mirrorToStdout = true, mirror = null } = {}) {
    super();
    this.logDir = logDir || null;
    this.toFile = Boolean(toFile) && Boolean(this.logDir);
    this.mirror = mirror ?? (mirrorToStdout ? 'stdout' : 'none');
    this.mirrorToStdout = this.mirror === 'stdout';
    if (this.toFile) {
      this.#openLogFile();
    }
  }

  get filePath() {
    return this.#filePath;
  }

  log(...args) {
    this.#write('info', args);
  }

  error(...args) {
    this.#write('error', args);
  }

  dispose() {
    this.#disposed = true;
    this.removeAllListeners();
  }

  #openLogFile() {
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.logDir, 0o700);
    const latestLog = path.join(this.logDir, 'latest.log');
    // Append through the symlink older versions created. Replacing it would
    // hide that history and split the GUI from an already running CLI process.
    const file = fs.openSync(latestLog, 'a', 0o600);
    try {
      fs.fchmodSync(file, 0o600);
      this.#filePath = fs.realpathSync(latestLog);
    } finally {
      fs.closeSync(file);
    }
  }

  #write(level, args) {
    if (this.#disposed) return;

    const message = sanitizeLine(args.map(formatArgument).join(' '));
    const time = new Date().toISOString();

    if (this.#filePath) {
      const prefix = level === 'error' ? `[${time}] [ERROR]` : `[${time}]`;
      // One append per record keeps independent processes on the same history.
      // Synchronous writes also survive a short CLI command's process.exit().
      const file = fs.openSync(this.#filePath, 'a', 0o600);
      try {
        fs.writeSync(file, `${prefix} ${message}\n`);
      } finally {
        fs.closeSync(file);
      }
    }

    if (this.mirror !== 'none') {
      const stream = level === 'error' ? process.stderr : (this.mirror === 'stderr' ? process.stderr : process.stdout);
      stream.write(`${message}\n`);
    }

    this.emit('line', { level, message, time });
  }
}
