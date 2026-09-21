/**
 * The contract of the core, written once.
 *
 * Every operation the core offers is listed here with the channel the window
 * uses for it (`ipc`) and the command the terminal uses (`cli`). The adapters
 * are thin translations of this table: src/main/ipc.js registers one
 * `ipcMain.handle` per channel, src/main/preload.cjs exposes one method per
 * channel and src/cli.js dispatches one command per entry. Nothing in the core
 * imports this file to do work; it exists so both adapters, and the parity test
 * in test/parity.test.js, read the same source.
 *
 * A channel without an equivalent in the terminal has to be listed in
 * WINDOW_ONLY_CHANNELS with the reason why the terminal has none. The parity
 * test reads the channel lists of src/main/preload.cjs and fails when a channel
 * is in neither place: that is how the window and the CLI stay in step.
 */

/**
 * Operations of the core.
 *
 *   name     the operation, named after what it does; most of them are a method
 *            of VpnSession (src/core/session.js), and a few name the command of
 *            the terminal that drives several session calls (`vpnConnect`,
 *            `vpnCancel`, `vpnDisconnect`, `vpnState`, `vpnStatus`, `watch`)
 *   ipc      channel of the window, or null when the terminal is the only
 *            caller that needs it
 *   cli      command of src/cli.js, or the command that answers the operation
 *            from a terminal when there is no dedicated one
 *   note     what the terminal does differently, when it does
 */
export const OPERATIONS = Object.freeze([
  { name: 'appInfo', ipc: 'app:info', cli: 'info' },
  { name: 'configGet', ipc: 'config:get', cli: 'config get' },
  { name: 'configSave', ipc: 'config:save', cli: 'config set' },
  { name: 'vpnConnect', ipc: 'vpn:connect', cli: 'start' },
  {
    name: 'vpnCancel',
    ipc: 'vpn:cancel',
    cli: 'start',
    note: 'Ctrl-C during start cancels the attempt in flight; there is no cancel command because a terminal process owns its own attempt',
  },
  { name: 'vpnDisconnect', ipc: 'vpn:disconnect', cli: 'stop' },
  { name: 'vpnState', ipc: 'vpn:state', cli: 'status' },
  { name: 'vpnStatus', ipc: 'vpn:status', cli: 'status' },
  { name: 'logsRecent', ipc: 'logs:recent', cli: 'logs' },
  { name: 'helperStatus', ipc: 'helper:status', cli: 'helper status' },
  { name: 'helperInstall', ipc: 'helper:install', cli: 'helper install' },
  { name: 'setupStatus', ipc: 'setup:status', cli: 'setup status' },
  { name: 'setupComplete', ipc: 'setup:complete', cli: 'setup complete' },
  { name: 'setupSkip', ipc: 'setup:skip', cli: 'setup skip' },
  {
    name: 'setupReset',
    ipc: null,
    cli: 'setup reset',
    note: 'the window repeats the assistant from the tray menu, which changes no state; a terminal needs one command that forgets the answer so the assistant appears again',
  },
  {
    name: 'commandLineStatus',
    ipc: 'command-line:status',
    cli: 'cli status',
    note: 'the window asks the launcher of the bundle, exactly as the command does, and reports the same fields',
  },
  {
    name: 'commandLineInstall',
    ipc: 'command-line:install',
    cli: 'cli install',
    note: 'the window links the command into the directory the tool picks, never with administrator rights and never replacing an entry of another program; the terminal adds --dir and --force',
  },

  // Terminal only: the window reaches the same core operations through the
  // settings form and the status card, but it has no channel of its own for
  // them. They are listed so the CLI has one name per core capability.
  { name: 'secretsStatus', ipc: null, cli: 'secrets status' },
  { name: 'secretSet', ipc: null, cli: 'secrets set' },
  { name: 'secretDelete', ipc: null, cli: 'secrets delete' },
  { name: 'loginItemStatus', ipc: null, cli: 'login-item status' },
  { name: 'loginItemSet', ipc: null, cli: 'login-item enable' },
  { name: 'doctor', ipc: null, cli: 'doctor' },
  { name: 'watch', ipc: null, cli: 'watch' },
]);

/**
 * Channels of the window that carry no core operation: they exist because the
 * window is a window (a modal, a folder picker, a focus hint) or because the
 * desktop application owns its own lifetime. Every entry needs a reason,
 * because the parity test treats this list as the only excuse for a channel
 * without a terminal equivalent.
 */
export const WINDOW_ONLY_CHANNELS = Object.freeze({
  'shell:open-logs': 'opens the log folder in the file manager of the desktop; the CLI prints the path instead (info, logs, doctor)',
  'shell:open-screenshots': 'same for the screenshots folder; the CLI prints the path in info and doctor',
  'credentials:answer': 'half of the credentials modal protocol (credentials:request is the other half); the CLI answers its own terminal prompt',
  'app:quit': 'the desktop application quits as one unit (tray, window, tunnel policy); a terminal process ends when its command ends',
});

/**
 * Events of the core, with the terminal surface that answers each one.
 * `emit` is the event name of VpnSession; `ipc` is the channel the window
 * subscribes to; `cli` is what a terminal does with it.
 */
export const EVENTS = Object.freeze([
  { name: 'state', ipc: 'state:changed', cli: 'status, watch' },
  { name: 'log', ipc: 'log:line', cli: 'the logger mirror of every command writes them' },
  { name: 'progress', ipc: 'progress', cli: 'start and watch print them' },
  { name: 'credentials:request', ipc: 'credentials:request', cli: 'start and watch prompt on the terminal' },
  { name: 'helper:changed', ipc: 'helper:changed', cli: 'helper status' },
]);

/** Events that only the window consumes. */
export const WINDOW_ONLY_EVENTS = Object.freeze({
  'ui:focus': 'a section of the window to open; a terminal has no sections',
});

/** The invoke channel of an operation, or null when the window has none. */
export function ipcChannel(operation) {
  return OPERATIONS.find((entry) => entry.name === operation)?.ipc ?? null;
}

/** The command of an operation, or null when the core does not list one. */
export function cliCommand(operation) {
  return OPERATIONS.find((entry) => entry.name === operation)?.cli ?? null;
}
