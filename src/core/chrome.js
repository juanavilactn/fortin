import fs from 'node:fs';
import path from 'node:path';

// Rutas habituales de Google Chrome. El CLI original cubria macOS y Linux; se
// anaden las de Windows.
export function chromeCandidates() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];

  if (process.platform === 'win32') {
    for (const base of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  }

  return candidates;
}

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function findInPath(names) {
  const pathValue = process.env.PATH || '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Devuelve la ruta de Chrome, o null si no se encuentra.
 *
 * Orden: ruta configurada en la app, variable CHROME_PATH, rutas habituales del
 * sistema (macOS, Linux, Windows) y finalmente PATH.
 */
export function detectChromePath({ configured = '', env = process.env.CHROME_PATH } = {}) {
  for (const candidate of [configured, env]) {
    if (candidate && isFile(candidate)) return candidate;
  }

  for (const candidate of chromeCandidates()) {
    if (isFile(candidate)) return candidate;
  }

  const names = process.platform === 'win32'
    ? ['chrome.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium'];
  return findInPath(names);
}
