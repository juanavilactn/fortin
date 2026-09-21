# Fortin

Fortin is a desktop application and a command line tool for connecting to FortiClient SSL VPN
gateways with SAML authentication (Microsoft Entra ID / Office 365) plus TOTP or push MFA. It is
the same automation as the `forticlient-vpn-cli` project, wrapped in an Electron app with a small
window and a menu bar icon that connects or disconnects with one click.

Fortin is not affiliated with, endorsed by or supported by Fortinet.

The tunnel itself is opened by `openfortivpn` through a restricted privileged helper. The app
drives Chrome with `puppeteer-core` to complete the Microsoft login, captures the `SVPNCOOKIE` and
hands it to the tunnel.

## Install

Homebrew is the shortest path:

```bash
brew tap juanavilactn/tap
brew install --cask fortin
fortin status
```

The cask installs `Fortin.app` in `/Applications` and links the `fortin` command into the `bin`
directory of Homebrew, which a new terminal already searches, so no `cli install` step is needed.
`fortin status` answers from the installed bundle.

The application is signed ad-hoc and it is not notarized, so macOS puts the download in quarantine
and the first start ends with a message about an unidentified developer. Approve it once in System
Settings, Privacy and Security, "Open Anyway", or drop the flag from a terminal:

```bash
xattr -dr com.apple.quarantine "/Applications/Fortin.app"
```

The first start opens the setup assistant, which walks through the gateway, the account, the
authentication method and the privileged helper in eight steps, and leaves the app ready to
connect.

Without Homebrew, download the disk image from the
[releases page](https://github.com/juanavilactn/fortin/releases), drag the application into
`Applications` and link the command once:

```bash
"/Applications/Fortin.app/Contents/Resources/cli/fortin" cli install
```

The rest of that route is in
[The tool of the installed application](#the-tool-of-the-installed-application).

On Linux and Windows the same releases page carries the AppImage and the deb, and the NSIS
installer. `openfortivpn` comes from the distribution on Linux, and the Windows installer asks for
`openfortivpn.exe` plus the TAP-Windows driver (see [Requirements](#requirements)).

## Supported platforms

| Platform | Tunnel | Privileged helper |
| --- | --- | --- |
| macOS | bundled `openfortivpn` (installed once by the helper) | root-owned helper in `/usr/local/libexec/fortin-helper` plus a `sudoers` rule, installed with a single admin prompt |
| Linux | `openfortivpn` from the distribution | `/usr/local/libexec/fortin-helper` plus `/etc/sudoers.d/fortin`, installed with `pkexec` (or `sudo` in a terminal) |
| Windows | `openfortivpn.exe` plus a TAP-Windows adapter | none: each connect and disconnect raises one UAC confirmation |

The app reads the same configuration directory as the CLI, `~/.fortin/`, so the two
share `config.json`, logs, PID file and screenshots.
The password, the TOTP secret and the last session cookie do not live in that file: they are items
of the store the operating system provides, the macOS Keychain on macOS and `secret-tool` on Linux.
Settings names the store that holds them.

## Requirements

- Node.js 22.15 or newer to run from source, for the CLI and for the tests, which load the doubles
  of the three platforms with `module.registerHooks()`.
- Google Chrome (or Chromium) installed. The app drives a real browser so the Microsoft login
  looks like a normal browser session. Set `chromePath` in the configuration, or `CHROME_PATH` in
  the environment, when Chrome lives somewhere unusual.
- `openfortivpn`: bundled on macOS by the helper installer, `sudo apt install openfortivpn` on
  Debian and Ubuntu, `openfortivpn.exe` plus a TAP-Windows adapter on Windows.

## Run from source

```bash
npm install
node node_modules/electron/install.js   # npm lifecycle scripts are disabled here on purpose
npm start
```

The second command is needed because `~/.npmrc` sets `ignore-scripts=true` as supply-chain
hardening, which also skips the download of the Electron binary. Run it once, or run
`npx electron --version` and check that it prints a version instead of opening the editor.

The CLI still works from a plain checkout, without Electron, and reaches the same core as the
window:

```bash
node src/cli.js help
node src/cli.js start        # connect
node src/cli.js status
node src/cli.js stop
node src/cli.js setup        # install the privileged helper
```

The full command surface is in [Command line](#command-line).

## Build installers

```bash
npm run dist:mac     # dmg + zip (arm64 and x64)
npm run dist:linux   # AppImage + deb (x64)
npm run dist:win     # nsis installer + portable (x64)
npm run dist:dir     # unpackaged build, useful to inspect the app bundle
```

Artifacts land in `dist/`. The packaged app ships the tray icons, the privileged helper scripts in
`resources/helper/` (outside the asar archive, because they must be executable) and the command
line launcher in `resources/cli/`.

## Using the app

### First run

A machine that has just installed the application has no configuration and no privileged helper, so the
first start opens a setup assistant instead of a window that can only say it is not connected. In the
window, that assistant replaces the panes while it runs and leads through eight steps:

1. Welcome: what is going to be configured, and how many steps it takes.
2. Privileged helper: what it is for and why it asks for the administrator password once. On a machine
   where it is already installed, the step arrives resolved.
3. VPN server, port and realm, with the same validation the Settings form uses, and where each value
   comes from in a FortiClient profile.
4. Microsoft account and authentication method: push notification (the default) or a TOTP code, with the
   TOTP secret when that method is chosen.
5. Password and secrets: masked, written to the system store, and the step says when this machine has no
   store and the values stay in the configuration file with mode 0600.
6. Tunnel behaviour: start at login, keep the machine awake and reconnect by itself, one line each.
7. Terminal command: the optional step that links the command line tool into a directory of the `PATH`.
   A directory that needs administrator rights, `/usr/local/bin` for example, is reported with the
   `sudo` command to run in a terminal.
8. Summary of what is configured, with `Finish` and a `Connect now` button. `Connect now` starts a real
   connection: the app opens the Microsoft sign-in and brings the tunnel up.

`Later` postpones the assistant. It does not open again at the next start; the window keeps a banner that
says what is missing, and that banner opens the assistant again. A start caused by the login item never
takes the focus, so the assistant is simply what you find when you open the window.

The assistant also repeats by hand, on any machine, configured or not: `Run setup` in the tray menu opens
the window on it, and every step arrives with the values this machine already has, so nothing is lost and
nothing is duplicated. From a terminal, `fortin setup status` says where the setup stands,
`setup complete` and `setup skip` record the answer by hand, and `setup reset` forgets it so the assistant
appears again at the next start.

The tray icon is the main control. One left click connects when the tunnel is down and disconnects
when it is up. The right-click menu offers the same action plus the window, the settings and the
log folder. Closing the window keeps the app running in the tray; use `Quit` to stop it.
`Quit` also takes the tunnel down, so a root-owned tunnel never outlives the window.

In the window:

- The status card shows the state, the server, how long the tunnel has been up (live counter) and what
  the app is doing right now: the sign-in step, the push code to approve, or the reconnect attempt in
  progress. A chip appears while the app is holding the machine awake.
- `Connect` and `Disconnect` run the same flow as the tray. While a connection is in progress the
  button turns into a progress state and `Cancel` stops the attempt and leaves the tunnel down.
  Authentication, the tunnel start and the 30 second tunnel timeout are all streamed into the
  activity panel.
- The `Activity` panel lists the log with a short timestamp and the level of each line, a level
  filter, `Copy` for the visible lines and `Clear`. It keeps the last 500 lines, scrolls on its own
  only when you are already at the bottom, and offers `Jump to latest` when you are not.
- The `Settings` panel groups the fields of `config.json` by theme: connection (server, port, realm),
  authentication (username, password, TOTP secret, method), behavior (headless browser, keep the
  machine awake, reconnect automatically, debug screenshots, start at login) and advanced (trusted
  certificate, Chrome path). Fields are validated before saving. Stored passwords and TOTP secrets are shown empty; leave
  them empty to keep the stored value. A line above the fields names the store that holds them, or
  says that this machine has no store and the secrets are only as private as the file.
- When no password is stored, the app asks for it in a modal, and again after a rejected attempt
  (three attempts before it gives up). The modal shows the attempt counter and can reveal the password.
- The system notifies you when the tunnel connects, disconnects or comes back after a drop.
- `Install VPN helper` appears when the platform helper is missing or not authorized. It runs the
  platform installer once: `osascript` admin prompt on macOS, `pkexec` on Linux.
- `Open log folder` and `Open screenshots` open `~/.fortin/logs/` and
  `~/.fortin/screenshots/`.

## Command line

`node src/cli.js` (or `npm run cli -- ...`) runs the same session as the window: one configuration
file, one secret store, one log and one login item. It needs no display and no Electron.
The installed application carries the same tool. See
[The tool of the installed application](#the-tool-of-the-installed-application).

| Command | What it does |
| --- | --- |
| `start` | Connect. It runs in the background by default and returns with the tunnel up; `-f/--foreground` follows the tunnel in the terminal. The connection flags are `--push`, `--totp`, `--headless`, `--no-headless`, `--debug-screenshots`, `-s/--server`, `-p/--port`, `-u/--username`, `-P/--password`, `-t/--totp-secret` and `-r/--realm` |
| `stop` | Disconnect the tunnel, whoever started it. The front end that holds the tunnel takes the stop as deliberate and does not reconnect |
| `status` | State, background PID and the log file in use |
| `watch` | Follow the state and the progress lines until Ctrl-C, without touching the tunnel |
| `config get` | Configuration, secret store, environment overrides, paths and the answer of the initial setup |
| `config set <key> <value>` | Change one or more values. Booleans take true/false/1/0/yes/no/on/off |
| `secrets status` | Which secrets exist and where they live, never their values |
| `secrets set <name>` | Store `password`, `totpSecret` or `svpnCookie`. The value is read from the terminal |
| `secrets delete <name>` | Remove a secret from the store and from the configuration file |
| `login-item status` | What the system holds for start at login |
| `login-item enable` | Register the login item; the entry points at the installed application |
| `login-item disable` | Remove the login item |
| `logs [-n N]` | Last lines of the current log file, 200 by default |
| `helper status` | Privileged helper and `openfortivpn`; the exit code reports both |
| `helper install` | Install the privileged helper once (`setup` is an alias) |
| `setup status` | Where the initial setup stands: whether the assistant is due and what is missing |
| `setup complete` | Record that the initial setup was completed |
| `setup skip` | Postpone it: the window keeps saying what is missing and the assistant stops asking |
| `setup reset` | Forget the answer, so the assistant appears again at the next start |
| `cli status` | Launcher of this build, the state of the link in one directory of the `PATH` and the copy a new terminal runs. It exits 1 when there is no launcher |
| `cli install [--dir DIR]` | Link the launcher of the installed application into a directory of the `PATH`. `--force` replaces what is already there |
| `cli uninstall [--dir DIR]` | Remove that link. Removing a link that is not there is not an error |
| `info` | Version, platform, provider, paths and secret store |
| `version` | The version only |
| `doctor` | Configuration, secrets, login item, helper, client, tunnel, initial setup and log file in one read-only report |
| `help` | The help text |

`--json` writes one object on stdout and nothing else: `{ok, command, result}` when the command
worked, and `{ok:false, command, error:{message, code?}}` when it did not, always with exit code 0
or 1. While the flag is on the log lines move to stderr, so a script can read the answer alone:

```bash
node src/cli.js status --json | jq -r '.result.state'
```

Secrets never come from the command line. `secrets set` reads the value from the terminal, hidden
when there is one, and as the first line of the input when it is a pipe:

```bash
node src/cli.js secrets set password        # hidden prompt
printf %s "$VPN_PASSWORD" | node src/cli.js secrets set password
```

`-P/--password` on `start` still wins over the stored one for that run. No command prints a
secret.

`svpnCookie` is a session secret and only a system store can hold it: without one, `secrets set
svpnCookie` refuses instead of writing it to the configuration file, and the session cookie stays in
the 0600 file the tunnel code writes.

### The tool of the installed application

The build ships the command line tool inside the application:

| Platform | Launcher |
| --- | --- |
| macOS | `<application>.app/Contents/Resources/cli/fortin` |
| Linux | `<application folder>/resources/cli/fortin` |
| Windows | `<application folder>\resources\cli\fortin.cmd` |

The Homebrew cask writes that link for you, so this section is the manual route, for an
installation from the disk image.

The launcher runs `src/cli.js` with the Electron binary of the bundle, in Node mode, so the tool and
the window share the configuration file, the secret store, the log and the login item. Dragging the
application into `Applications` never touches the `PATH`, so one command is enough:

```bash
"/Applications/Fortin.app/Contents/Resources/cli/fortin" cli install
fortin status
```

`cli install` writes the link into `$HOME/.local/bin` or `/usr/local/bin`, the first one that is in
the `PATH` and takes new files, and a `.cmd` shim under `%USERPROFILE%\bin` on Windows. When
neither is in the `PATH`, it takes the one that takes files and warns that the command has no name
yet; when neither takes files, the command fails and prints the `sudo` command to run. `--dir DIR`
names the directory. The command warns when that directory is not in the `PATH`, and when another
copy of the command comes first there: it prints the command that replaces it. `--force` replaces
what a directory already holds under the name of the command: a link is replaced, and a plain file
moves to `<path>.backup-<date>` first.

`cli status` reports the launcher of this build, the state of the link, whether its directory is in
the `PATH` and which copy a new terminal runs. It exits 1 when there is no launcher, with
`reason: "no-application"` from a checkout and `reason: "launcher-missing"` when the path is known
and the file is gone. `cli uninstall` removes the link, and removing a link that is not there is not
an error. The link must point at a copy that stays: from a mounted disk image (`/Volumes/...`) or
from a translocated bundle, `cli install` refuses without `--force`.

`FORTIN_LAUNCHER` names the launcher, so a checkout exercises the link without an installed
application.

## Keeping the tunnel up

The tunnel stays up until you disconnect it. An idle machine does not end the session, and a tunnel
that dies on its own is reopened without you.

While the tunnel is up the app holds the machine awake, so an idle laptop or a closed lid does not
lose the VPN. macOS runs `caffeinate -i -s`, Linux takes a `systemd-inhibit` block on `idle` and
`sleep`, and Windows holds `SetThreadExecutionState`. The app releases the hold when the tunnel goes
down or when you disconnect.

If the tunnel process dies or the point-to-point interface disappears while the connection is
supposed to be up, the app reconnects by itself. It tries the last `SVPNCOOKIE` first and falls back
to a full Microsoft sign-in, and it waits 5, 10, 20, 30, 60 and 60 seconds between attempts. After
six consecutive failures it stops and reports an error instead of retrying forever. A resume from
suspend or an unlock checks the tunnel immediately. A disconnect that you asked for is never
overridden, in either front end: `stop` in the terminal ends a tunnel the window opened, and
`Disconnect` in the window ends one a terminal started. The front end that was holding the tunnel
sees a deliberate stop, not a drop, so it does not bring it back.

The gateway of this deployment refuses a reused cookie (`Could not get VPN configuration`), so the
app tries the cookie once per drop and then signs in again. When a cookie is refused, the app
remembers it and skips the cookie on the following attempts, which saves about fifteen seconds per
recovery.

Both features are settings, `keepAwake` and `autoReconnect`, and both are on by default. The tradeoff
is battery: a machine that is not allowed to sleep drains faster while it is unplugged. Turn
`keepAwake` off when you work on battery and do not need the tunnel.

## Configuration

`~/.fortin/config.json`, mode 0600:

| Field | Description | Required |
| --- | --- | --- |
| `vpnServer` | VPN host, without `https://` and without a path | yes |
| `vpnPort` | Port, default `443` | no |
| `vpnRealm` | VPN realm or group, when the FortiGate requires one | no |
| `username` | Microsoft account (email) | yes |
| `password` | Password. Kept in the system store, not in this file | yes, or the app asks for it |
| `totpSecret` | Base32 TOTP secret, required only for `authMethod: "totp"` | for TOTP |
| `authMethod` | `push` (approve on the phone) or `totp` (code generated locally) | no, default `push` |
| `headless` | `true` hides the browser window, `false` shows it for debugging | no, default `true` |
| `trustedCert` | Certificate fingerprint, or `any` | no, default `any` |
| `chromePath` | Explicit Chrome or Chromium executable | no |
| `keepAwake` | `true` holds the machine awake while the tunnel is up | no, default `true` |
| `autoReconnect` | `true` reconnects by itself after a tunnel that drops unasked | no, default `true` |
| `startAtLogin` | `true` starts the app when you log in, in the tray and without a window | no, default `false` |
| `setupCompleted` | `true` when the setup assistant was walked through | no, written by the assistant |
| `setupSkipped` | `true` when it was postponed, so it stops asking | no, written by the assistant |
| `setupVersion` | Version of the assistant that answered | no, written by the assistant |
| `setupDecidedAt` | When that answer was recorded, in ISO-8601 | no, written by the assistant |

`password` and `totpSecret` are written to the store of the operating system, never to
`config.json`. The file in use, `FORTIN_CONFIG` or `~/.fortin/config.json`, is
migrated on the first start after the update, from the application or from the CLI, and the keys
leave it. A `config.json` next to the application is only read, so remove its secrets by hand. On a
machine without a store (Linux without `secret-tool`, or Windows) the secrets stay in the file with
mode 0600, and the log and the Settings message say that they are not protected by the system.

Environment variables override the file: `VPN_SERVER`, `VPN_PORT`, `VPN_REALM`, `VPN_USERNAME`,
`VPN_PASSWORD`, `VPN_TOTP_SECRET`, `VPN_AUTH_METHOD`, `VPN_HEADLESS`, `VPN_TRUSTED_CERT`,
`CHROME_PATH`, `VPN_DEBUG_SCREENSHOTS`, `VPN_KEEP_AWAKE`, `VPN_AUTO_RECONNECT`,
`VPN_START_AT_LOGIN`.
`FORTIN_CONFIG` points the app at a different `config.json`.
`FORTIN_SECRET_STORE=file` keeps the secrets in that file and leaves the system store alone.

The four `setup*` keys are the memory of the setup assistant. `config set` cannot change them: `setup
complete`, `setup skip` and `setup reset` do, and so does the window when the assistant is finished or
postponed.

## Start at login

Turn on `Start Fortin when I log in` in `Settings` and the app starts with your session,
sits in the tray and opens no window. Open the window from the tray when you want to connect.

The same code answers the switch and the terminal, and each platform writes its own entry:

| Platform | Entry | Where you see it |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.juanavilactn.fortin.plist`, a LaunchAgent with `RunAtLoad` | System Settings, General, Login Items, under "Allow in the background". macOS may report that a background item was added |
| Linux | `~/.config/autostart/fortin.desktop` | The startup applications of the desktop environment |
| Windows | The `Run` value `Fortin` of the user (`HKCU`) | Task Manager, Startup |

`KeepAlive` is false in the LaunchAgent on purpose: quitting the app does not bring it back. Every
entry starts the installed application with `--started-at-login`, which is how the app knows to stay
in the tray without a window.

Saving reports what the system did: "Saved." when the entry is in place, and a warning with the
reason when the system refuses it. A refusal is written to the app log and never discards the rest of
your configuration. The command line sees the system itself: `login-item status` reads the entry,
while the switch shows the stored value of `config.startAtLogin`.

Until this version, macOS registered the login item through Electron. The packaged app removes that
old entry once at startup, so a machine that had the setting on does not start the app twice.

The entry always points at an installed application. A development run would register the Electron
binary of `node_modules` or Node itself, so the app passes `app.isPackaged` to the core and the
command line leaves the resolution to the platform: `node src/cli.js login-item enable` registers
the app installed in `/Applications` or `~/Applications`, and when there is none it writes nothing
and says so. For the same reason the switch stays disabled outside an installed build, and a save
from there leaves the stored value alone.

## Security

- The password and the TOTP secret are keychain items of the service `fortin`, one
  account per field, and the CLI reads the same items. `config.json` keeps the rest of the
  settings with mode 0600 in a 0700 directory, and holds the secrets only when the machine has no
  store.
- The CLI writes and removes the same items: `secrets set` reads the value from the terminal,
  `secrets delete` removes it from the store and from the configuration file, and no command takes
  a secret on the command line or prints one back.
- Check an item without printing its value:
  `security find-generic-password -s fortin -a password` (macOS). Remove it with
  `security delete-generic-password -s fortin -a password`.
- The TOTP secret makes unattended login possible. Prefer `authMethod: "push"` unless you need the
  fully automated flow.
- Cookies are masked in the log (`--cookie=***`). The last successful cookie is kept in the same
  store under the `svpnCookie` item and is removed when you disconnect. The controller reads it
  when it starts; a fresh connection always signs in again, so only the reconnect loop of the run
  that signed in reuses a cookie.
- `scripts/ask-credentials.sh` collects credentials through native macOS dialogs and writes them
  straight to a JSON file, so they never appear in a terminal or a transcript. Pass the file to the
  app or the CLI with `FORTIN_CONFIG`.
- A failed tunnel start is written to `~/.fortin/logs/tunnel.log`, and its last lines are
  copied into the app log. `openfortivpn` explains the real cause there, and without this the
  detached tunnel fails silently.

## Troubleshooting

**Chrome not found.** Install Google Chrome, or set `chromePath` in the settings to the executable
(`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, `/usr/bin/google-chrome`,
`C:\Program Files\Google\Chrome\Application\chrome.exe`).

**Helper not installed.** Click `Install VPN helper` in the window, or run `node src/cli.js setup`.
On macOS and Linux this is a one-time admin confirmation; later connects do not ask again.

**`openfortivpn` missing.** Linux: `sudo apt install openfortivpn`. Windows: the installer stops
with instructions; you need `openfortivpn.exe` and the TAP-Windows driver.

**"Gateway certificate validation failed".** `openfortivpn` does not accept `any`; it wants the
sha256 digest of the gateway certificate. The app log prints the exact value suggested by
`openfortivpn` in the line `--trusted-cert <digest>`. Paste that fingerprint into the
`Trusted certificate` field in settings and connect again.

**Password rejected.** Three attempts are allowed, then the run stops. Debug with
`headless: false` and the debug screenshots switch, and inspect the PNG and HTML files in
`~/.fortin/screenshots/`.

**Push notification timeout.** The app waits two minutes for the approval. Check that the phone has
connectivity, and try `authMethod: "totp"` as an alternative.

**Windows raises a UAC prompt on every connect and disconnect.** Expected: Windows has no
`sudoers` equivalent, so the tunnel is started elevated each time. A passwordless helper through a
SYSTEM scheduled task is possible, but it is not implemented.

## Verification

`npm start` opens the window and the tray, and `node src/cli.js help|status` works from a plain
checkout. `npm test` runs the automated suite: it checks the contract of `src/core/api.js` against
the channel list of `src/main/preload.cjs` and the command table of `src/cli.js`, plus the core
modules that need no network. Authenticating drives a real browser against Microsoft and the tunnel
needs a real gateway, so the end-to-end flow is verified by hand against a live VPN: the pending
evidence of every capability is listed in [PARITY.md](PARITY.md).

A real run, from the app log:

```
openfortivpn: 1.23.1
=== Fortin Auto-Connect ===
Step 1: Entering username...
   Password accepted!
Step 3: Handling MFA (method: totp)...
   TOTP submitted
[OK] Captured auth_id: 1-...
[OK] SVPNCOOKIE fetched successfully
[SUCCESS] Authentication complete
VPN connected and running in background!
```

Closing the window leaves the app running in the tray. `Quit` stops the app and takes the tunnel
down with it; `Disconnect` closes the tunnel and keeps the app running.

The setup assistant was verified against the real application started from the checkout, with the doubles
of `test/doubles` (`FCVPN_FAKE_PROVIDER=1`), a temporary `HOME` and a temporary `FORTIN_CONFIG`, and
the window driven over CDP: a clean profile opens the assistant, the eight steps write what they promise,
the second start does not open it again, `Later` leaves the banner and no assistant after a restart, and
`doctor` reports the answer. The exact steps, the observed output and the screenshots are in
[PARITY.md](PARITY.md).

## Known limits

- macOS is the platform exercised against a real gateway. The Linux and Windows providers ship as
  code plus build targets and were reviewed, not executed, because the test machine is macOS.
- Windows needs `openfortivpn.exe` plus a TAP-Windows adapter, and every connect and disconnect
  raises a UAC prompt.
- Keeping the machine awake costs battery while the tunnel is up, especially on a laptop running
  unplugged.
- The Windows keep-awake helper was reviewed but not executed, because the test machine is macOS.
- Start at login was exercised on macOS against the installed build: the LaunchAgent appears in
  System Settings, General, Login Items under "Allow in the background" and disappears when the
  setting is turned off. The Linux autostart file and the Windows `Run` entry ship as code and were
  reviewed, not executed, because the test machine is macOS. A login start was reproduced by
  launching the app with the argument its login entry passes, not by a real logout and login.

## Layout

```
src/core/          contract, shared session, login item, authentication, tunnel lifecycle, config, logging (no Electron)
src/main/          Electron main process, tray, IPC adapter, preload bridge
src/renderer/      window UI
src/cli.js         command line adapter
resources/helper/  privileged helper scripts per platform (fortin-helper on macOS and Linux, the PowerShell scripts on Windows)
resources/cli/     command line launcher of the installed application (fortin, and fortin.cmd on Windows)
assets/            app icon and tray icons
scripts/           icon generation and credential prompt
```

## License

MIT.
