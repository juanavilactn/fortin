#!/bin/bash
# Collects Fortin credentials through native macOS dialogs (osascript).
#
# The answers never touch the terminal, the shell history or any transcript: each
# value is typed by the user into the system dialog and written straight into a
# JSON config file with mode 0600. The script prints only the path of that file.
#
# Usage:
#   scripts/ask-credentials.sh [output.json]
#
# Default output: $TMPDIR/fortin-credentials.json
set -euo pipefail

readonly TITLE='Fortin credentials'
readonly DIALOG_TIMEOUT_SECONDS=600

[ "$(/usr/bin/uname -s)" = 'Darwin' ] || {
    printf 'This script needs macOS (osascript).\n' >&2
    exit 64
}

output="${1:-${TMPDIR:-/tmp}/fortin-credentials.json}"

dialog() {
    local prompt="$1" default="$2" mode="${3:-plain}"

    osascript - "$prompt" "$default" "$mode" "$TITLE" <<'APPLESCRIPT'
on run argv
    set thePrompt to item 1 of argv
    set theDefault to item 2 of argv
    set theMode to item 3 of argv
    set theTitle to item 4 of argv

    if theMode is "hidden" then
        set theDialog to display dialog thePrompt default answer theDefault with hidden answer ¬
            buttons {"Cancel", "Continue"} default button "Continue" with title theTitle with icon caution
    else
        set theDialog to display dialog thePrompt default answer theDefault ¬
            buttons {"Cancel", "Continue"} default button "Continue" with title theTitle
    end if

    return text returned of theDialog
end run
APPLESCRIPT
}

chooseMethod() {
    osascript - "$TITLE" <<'APPLESCRIPT'
on run argv
    set theTitle to item 1 of argv
    set theChoice to choose from list {"push", "totp"} with title theTitle ¬
        with prompt "Authentication method" default items {"push"}
    if theChoice is false then error number -128
    return item 1 of theChoice
end run
APPLESCRIPT
}

trap 'printf "Cancelled.\n" >&2; exit 130' INT

server=$(dialog 'VPN server (hostname only)' '')
port=$(dialog 'VPN port' '443')
realm=$(dialog 'VPN realm (leave empty if not used)' '')
username=$(dialog 'Microsoft username (email)' '')
password=$(dialog 'Password' '' hidden)
auth_method=$(chooseMethod)

totp_secret=''
if [ "$auth_method" = 'totp' ]; then
    totp_secret=$(dialog 'TOTP secret (base32 key from your authenticator)' '' hidden)
fi

# openfortivpn rejects "any": it needs the sha256 fingerprint of the gateway
# certificate. Reuse the one already stored, when there is one.
default_cert=$(/usr/bin/python3 -c '
import json, os
try:
    with open(os.path.expanduser("~/.fortin/config.json")) as handle:
        print(json.load(handle).get("trustedCert", "") or "")
except Exception:
    print("")
')
[ -n "$default_cert" ] || default_cert='any'
trusted_cert=$(dialog 'Trusted certificate (sha256 fingerprint, or any)' "$default_cert")

printf '%s\0' \
    "$server" "$port" "$realm" "$username" "$password" "$totp_secret" "$auth_method" "$trusted_cert" \
    | /usr/bin/python3 -c '
import json
import sys

fields = [
    "vpnServer",
    "vpnPort",
    "vpnRealm",
    "username",
    "password",
    "totpSecret",
    "authMethod",
    "trustedCert",
]

values = sys.stdin.buffer.read().split(b"\0")
record = dict(zip(fields, (value.decode("utf-8") for value in values)))
record["headless"] = True

json.dump(record, sys.stdout, indent=2, ensure_ascii=False)
' > "$output"

/bin/chmod 600 "$output"

printf '%s\n' "$output"
