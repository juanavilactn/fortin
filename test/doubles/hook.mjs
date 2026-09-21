/**
 * Module hook that replaces two core modules with the doubles of this folder:
 *
 *   src/core/platform/index.js  ->  test/doubles/fake-provider.mjs
 *   src/core/vpn.js             ->  test/doubles/fake-vpn.mjs
 *
 * The replacement is what keeps a test away from the machine: the provider of
 * macOS reads and writes the Keychain and runs sudo, and the controller opens
 * the tunnel. The hook only acts when FCVPN_FAKE_PROVIDER=1, and never for a
 * request that comes from this folder, so a double can re-export the real
 * module with `export *` without replacing itself.
 *
 * Usage, with the working directory at the root of the repository:
 *
 *   node --import ./test/doubles/hook.mjs src/cli.js status --json
 */

import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DOUBLES_DIR = import.meta.dirname;
const CORE_DIR = path.resolve(DOUBLES_DIR, '..', '..', 'src', 'core');

const REPLACEMENTS = new Map([
  [path.join(CORE_DIR, 'platform', 'index.js'), path.join(DOUBLES_DIR, 'fake-provider.mjs')],
  [path.join(CORE_DIR, 'vpn.js'), path.join(DOUBLES_DIR, 'fake-vpn.mjs')],
]);

/** True when the importer is one of the doubles, which must see the real module. */
function isDouble(url) {
  if (!url || !url.startsWith('file:')) return false;
  const file = fileURLToPath(url);
  return file === DOUBLES_DIR || file.startsWith(DOUBLES_DIR + path.sep);
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (process.env.FCVPN_FAKE_PROVIDER !== '1') return resolved;
    if (!resolved?.url?.startsWith('file:')) return resolved;
    if (isDouble(context.parentURL)) return resolved;

    const replacement = REPLACEMENTS.get(fileURLToPath(resolved.url));
    if (!replacement) return resolved;
    return { ...resolved, url: pathToFileURL(replacement).href, shortCircuit: true, format: 'module' };
  },
});
