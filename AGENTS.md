# AGENTS.md

Instructions for an AI agent that installs, configures or drives Fortin on a machine, and for an
agent that changes this repository. The window and the terminal run the same session, so every step
below has a command and no step needs the graphical interface.

Fortin connects a machine to a FortiClient SSL VPN gateway. It completes the Microsoft sign-in (SAML
with Entra ID) in a real Chrome window, keeps the resulting session cookie and hands it to
`openfortivpn`, which owns the tunnel. Push notification and TOTP both work as the second factor.
Fortin is not affiliated with Fortinet.

## Install the application

```bash
brew install --cask juanavilactn/tap/fortin
fortin doctor
```

The cask puts `Fortin.app` in `/Applications` and links the `fortin` command into the `bin` directory
of Homebrew, which a new terminal already searches. Two details matter:

- Homebrew 7 refuses the cask of a third-party tap by its bare name until the tap is trusted. Use the
  qualified name above, or run `brew tap juanavilactn/tap` and `brew trust juanavilactn/tap` first.
- The application is signed ad-hoc and it is not notarized, so macOS keeps the download in quarantine
  and blocks the first start. Clear the flag once:
  `xattr -dr com.apple.quarantine "/Applications/Fortin.app"`.

Without Homebrew, install the disk image from the
[releases page](https://github.com/juanavilactn/fortin/releases) and link the tool of the bundle:

```bash
"/Applications/Fortin.app/Contents/Resources/cli/fortin" cli install
```

`cli install` picks a directory of the `PATH` that takes new files; `--dir DIR` names one and
`--force` replaces an existing command. `fortin cli status` reports what a new terminal finds. Linux
and Windows have build targets in this repository, but no published build yet.

## Configure a machine without the window

A machine that has just installed the application cannot connect: it has no configuration file, no
secret and no privileged helper. The window answers that with an eight-step assistant. A terminal
reaches the same state in this order:

```bash
# 1. The VPN client. On macOS the helper installer copies the binary it finds in the PATH.
brew install openfortivpn          # Debian and Ubuntu: sudo apt install openfortivpn

# 2. The privileged helper: installs the client in /usr/local/libexec/fortin and writes the sudoers
#    rule that opens the tunnel without a password. One administrator confirmation, once.
fortin setup

# 3. The gateway and the account, with the values of the user.
fortin config set vpnServer vpn.example.com username me@example.com authMethod totp

# 4. The secrets. They come from the standard input and no command prints them.
printf '%s\n' "$VPN_PASSWORD" | fortin secrets set password
printf '%s\n' "$TOTP_SECRET" | fortin secrets set totpSecret

# 5. Record the answer of the assistant, so the window stops asking for it.
fortin setup complete

# 6. Connect, then read the state.
fortin start --json
fortin status --json
```

`config set` refuses `password` and `totpSecret` on purpose: an argument is visible in `ps` and in a
shell history. `secrets set` takes the first line of the input, or the whole input when the pipe
closes without a newline, so `printf '%s\n' "$VALUE"` and `printf %s "$VALUE"` both work.

The secrets live in the system store (the macOS Keychain, `secret-tool` on Linux) or, on a machine
without one, in `~/.fortin/config.json` with mode 0600. `fortin secrets status` says which secrets
exist and where, never their values. `FORTIN_SECRET_STORE=file` forces the file, which is useful for
a throwaway profile.

## The two steps that need a person

- The privileged helper. `fortin setup` asks for the administrator password in the terminal, or opens
  the administrator dialog of macOS when the command has no terminal. Once per machine.
- The second factor. `authMethod: "push"` sends the approval to the phone and waits two minutes for
  it. `authMethod: "totp"` with a stored `totpSecret` asks nobody. Prefer `push` unless the user wants
  the unattended flow.

## Drive it from a script

`--json` writes one JSON object on `stdout` and nothing else: `{ok, command, result}` when the
command worked and `{ok: false, command, error: {message, code?}}` when it did not, with exit code 0
or 1. Every log line goes to `stderr`. Do not parse the human output; only the JSON is a contract.

| Command | What it answers |
| --- | --- |
| `start` | Connects and returns with the tunnel up. `-f` follows the tunnel in the terminal. |
| `stop` | Disconnects, whoever opened the tunnel. |
| `status` | `state`, `message`, `pid`, `owner`, `logFile`, `backgroundPid`. |
| `watch --interval N` | The state and the progress lines, in the foreground, until Ctrl-C. |
| `config get` | Configuration, fields, secret store, paths, answer of the assistant. |
| `config set <key> <value> ...` | Changes one or more values. Booleans take true/false/1/0/yes/no/on/off. |
| `secrets status` | Which secrets exist and where. |
| `secrets set <name>` | Stores `password`, `totpSecret` or `svpnCookie`, value from the standard input. |
| `secrets delete <name>` | Removes one from the store and from the configuration file. |
| `helper status`, `helper install` | The privileged helper and the client, with the exit code. |
| `setup status`, `setup complete`, `setup skip`, `setup reset` | The answer of the initial assistant. `setup` alone is `helper install`. |
| `login-item enable`, `disable`, `status` | Start at login. |
| `logs -n N` | The last lines of the current log, 200 by default. |
| `doctor` | One read-only report of all of the above. Start here when something fails. |
| `info`, `version`, `cli status` | Build, platform, paths, provider, secret store, launcher of the PATH. |
| `help` | The whole list, with every flag. |

The state is one of `disconnected`, `connecting`, `connected`, `disconnecting` and `error`. On macOS
the tunnel is the `ppp0` interface.

```bash
fortin status --json | jq -r '.result.state'
```

`start` takes `--push`, `--totp`, `--headless`, `--no-headless`, `--debug-screenshots`,
`-s/--server`, `-p/--port`, `-u/--username`, `-P/--password`, `-t/--totp-secret` and `-r/--realm`
for one run. The stored configuration and the stored secrets are the normal path.

The tunnel stays up until somebody disconnects it. `autoReconnect` reopens a tunnel that died on its
own, with waits of 5, 10, 20, 30, 60 and 60 seconds, and gives up after six failures. `keepAwake`
holds the machine awake while the tunnel is up. Both are on by default and both are settings.

## Paths and environment

| Path | Contents |
| --- | --- |
| `~/.fortin/config.json` | Settings, mode 0600, secrets only when the machine has no store. |
| `~/.fortin/logs/latest.log` | The application log. `tunnel.log` holds the failing start of `openfortivpn`. |
| `~/.fortin/screenshots/` | PNG and HTML of the sign-in, with the debug switch on. |
| `~/.fortin/vpn.pid` | The background process of `start`. |
| `/usr/local/libexec/fortin-helper` | The privileged helper, owned by root. |
| `/etc/sudoers.d/fortin` | The rule that lets the user run the helper without a password. |

Environment variables override the file: `VPN_SERVER`, `VPN_PORT`, `VPN_REALM`, `VPN_USERNAME`,
`VPN_PASSWORD`, `VPN_TOTP_SECRET`, `VPN_AUTH_METHOD`, `VPN_HEADLESS`, `VPN_TRUSTED_CERT`,
`CHROME_PATH`, `VPN_DEBUG_SCREENSHOTS`, `VPN_KEEP_AWAKE`, `VPN_AUTO_RECONNECT`,
`VPN_START_AT_LOGIN`. `FORTIN_CONFIG` points the application at another `config.json`, which keeps a
test away from the real configuration.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `command not found: fortin` | `fortin cli status`, then `cli install --dir DIR`, or call the launcher of the bundle by its full path. |
| The helper is not ready | `fortin helper status`, then `fortin setup` with an administrator. |
| `openfortivpn is not installed` | `brew install openfortivpn`, or `sudo apt install openfortivpn` on Linux. On macOS install it before `fortin setup`. |
| Chrome not found | Install Google Chrome or set `chromePath` (`CHROME_PATH` in the environment). |
| `Gateway certificate validation failed` | Read the digest from the log line `--trusted-cert <digest>` and store it: `fortin config set trustedCert <digest>`. |
| Password rejected | Three attempts and the run stops. Connect with `--no-headless --debug-screenshots` and read `~/.fortin/screenshots/`. |
| Push notification timeout | The application waits two minutes. Check the phone, or switch to `authMethod: "totp"`. |
| The tunnel is down and should be up | `fortin status`, `fortin logs -n 100`, and `ifconfig ppp0` on macOS. |

## Work in this repository

- Node.js 22.15 or newer. The tests use `module.registerHooks()`.
- `npm install`, then `node node_modules/electron/install.js` (the npm lifecycle scripts are off on
  purpose), then `npm start` for the window.
- `npm test` runs the whole suite against the doubles of the three platforms: no Electron, no
  network, no real Keychain. The same command runs in CI on ubuntu-24.04 with Node 22.15.0, with every
  action pinned to the commit of a release.
- The command line works from a checkout: `node src/cli.js help`. Point `FORTIN_CONFIG` at a temporary
  file and set `FORTIN_SECRET_STORE=file` to try a flow without touching the real profile.
- `npm run dist:mac` builds the two disk images and the two zips. A change of the icon needs
  `dist/.icon-icns` removed first.
- `node scripts/update-cask.mjs` writes the version and the two checksums of `dist/` into
  `packaging/homebrew/Casks/fortin.rb`, and `--check` reports drift. The cask of the tap is a copy of
  that file. Never write a checksum before its asset exists in the release.
- `SPEC.md` and `PARITY.md` are development documents of the checkout and stay out of the published
  repository.

## Rules

- A secret never appears in an argument, a log line, a commit or an issue. `-P/--password` exists for
  one run and shows the value in the process list: prefer the store, `secrets set` or the environment
  of the process.
- Read the state with `--json`, and run `fortin doctor` first when something fails.
- `fortin stop` ends a tunnel a person may be using. Run it when it is asked for.
