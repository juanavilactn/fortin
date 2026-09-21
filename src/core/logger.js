import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
const SECRET_PATTERNS = [
  [/(SVPNCOOKIE\s*=\s*)[^\s;'"]+/gi, '$1***'],
  [/(--cookie=)[^\s'"]+/gi, '$1***'],
];

export function sanitizeLine(message) {
  let clean = String(message).replace(ANSI_PATTERN, '');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
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
  #stream = null;
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
    if (this.#stream) {
      try {
        this.#stream.end();
      } catch {
        // El stream ya estaba cerrado.
      }
      this.#stream = null;
    }
    this.removeAllListeners();
  }

  #openLogFile() {
    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.#filePath = path.join(this.logDir, `vpn-${timestamp}.log`);
    this.#stream = fs.createWriteStream(this.#filePath, { flags: 'a', mode: 0o600 });
    this.#refreshLatestLog();
  }

  #refreshLatestLog() {
    const latestLog = path.join(this.logDir, 'latest.log');
    try {
      fs.unlinkSync(latestLog);
    } catch {
      // No habia latest.log previo.
    }
    try {
      // fs.symlinkSync requiere privilegios en Windows, asi que ahi se copia.
      if (process.platform === 'win32') {
        fs.copyFileSync(this.#filePath, latestLog);
      } else {
        fs.symlinkSync(this.#filePath, latestLog);
      }
    } catch {
      // latest.log solo es una comodidad para el usuario.
    }
  }

  #write(level, args) {
    if (this.#disposed) return;

    const message = sanitizeLine(args.map(formatArgument).join(' '));
    const time = new Date().toISOString();

    if (this.#stream) {
      const prefix = level === 'error' ? `[${time}] [ERROR]` : `[${time}]`;
      this.#stream.write(`${prefix} ${message}\n`);
    }

    if (this.mirror !== 'none') {
      const stream = level === 'error' ? process.stderr : (this.mirror === 'stderr' ? process.stderr : process.stdout);
      stream.write(`${message}\n`);
    }

    this.emit('line', { level, message, time });
  }
}
