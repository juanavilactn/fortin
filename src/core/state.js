import fs from 'node:fs';
import { getPaths } from './config.js';
import { getProvider } from './platform/index.js';

export function readPid() {
  const { pidFile } = getPaths();
  if (!fs.existsSync(pidFile)) return null;
  try {
    return parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

export function savePid(pid) {
  const paths = getPaths();
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.pidFile, String(pid), { mode: 0o600 });
}

export function clearPid() {
  const { pidFile } = getPaths();
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // No habia pid guardado.
  }
}

export function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function isVpnRunning() {
  try {
    return await getProvider().isVpnRunning();
  } catch {
    // Plataforma no soportada o herramienta ausente: no hay tunel que reportar.
    return false;
  }
}

/**
 * Records that a tunnel was stopped on purpose, before it is taken down.
 *
 * The tunnel may belong to another process (the window, or a terminal that
 * started it), and that one only sees its own process exit: without this the
 * exit of a deliberate stop is the same thing as a dropped connection, and it
 * reconnects. The request names the tunnel it stopped, so it is never about a
 * later one.
 */
export function requestStop({ pid = null, reason = 'stop' } = {}) {
  const paths = getPaths();
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const record = { pid: Number.isInteger(pid) ? pid : null, reason: String(reason), at: Date.now() };
  fs.writeFileSync(paths.stopFile, JSON.stringify(record), { mode: 0o600 });
}

/** The stop request in flight, or null when there is none. */
export function readStopRequest() {
  const { stopFile } = getPaths();
  try {
    const record = JSON.parse(fs.readFileSync(stopFile, 'utf8'));
    if (!record || typeof record !== 'object') return null;
    return {
      pid: Number.isInteger(record.pid) ? record.pid : null,
      reason: typeof record.reason === 'string' ? record.reason : 'stop',
      at: Number(record.at) || 0,
    };
  } catch {
    // Sin peticion guardada, o fichero ilegible.
    return null;
  }
}

/** Forgets the stop request: it is used once, and a new tunnel starts clean. */
export function clearStopRequest() {
  const { stopFile } = getPaths();
  try {
    fs.unlinkSync(stopFile);
  } catch {
    // No habia peticion guardada.
  }
}
