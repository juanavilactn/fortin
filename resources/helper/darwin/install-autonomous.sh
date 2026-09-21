#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")" && pwd)"
ROOT_INSTALLER="$SCRIPT_DIR/install-autonomous-root.sh"
SOURCE_HELPER="$SCRIPT_DIR/fortin-helper"
TARGET_USER="$(/usr/bin/id -un)"
TARGET_HOME="$HOME"

OPENFORTIVPN_LINK="$(command -v openfortivpn || true)"
[ -n "$OPENFORTIVPN_LINK" ] || {
    printf 'openfortivpn is not installed. Install it first with Homebrew.\n' >&2
    exit 1
}

OPENFORTIVPN_BIN="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$OPENFORTIVPN_LINK")"
OPENFORTIVPN_SSL_NAME="$(/usr/bin/otool -L "$OPENFORTIVPN_BIN" | /usr/bin/awk '/libssl\.3\.dylib/ { print $1; exit }')"
OPENFORTIVPN_CRYPTO_NAME="$(/usr/bin/otool -L "$OPENFORTIVPN_BIN" | /usr/bin/awk '/libcrypto\.3\.dylib/ { print $1; exit }')"
SSL_LIB="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$OPENFORTIVPN_SSL_NAME")"
CRYPTO_LIB="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$OPENFORTIVPN_CRYPTO_NAME")"
SSL_CRYPTO_NAME="$(/usr/bin/otool -L "$SSL_LIB" | /usr/bin/awk '/libcrypto\.3\.dylib/ { print $1; exit }')"

for required_file in "$ROOT_INSTALLER" "$SOURCE_HELPER" "$OPENFORTIVPN_BIN" "$SSL_LIB" "$CRYPTO_LIB"; do
    [ -f "$required_file" ] || {
        printf 'Required file not found: %s\n' "$required_file" >&2
        exit 1
    }
done

STAGING_DIR="$(/usr/bin/mktemp -d /tmp/fortin-install.XXXXXX)"
trap '/bin/rm -rf "$STAGING_DIR"' EXIT

/usr/bin/install -m 700 "$ROOT_INSTALLER" "$STAGING_DIR/install-autonomous-root.sh"
/usr/bin/install -m 755 "$SOURCE_HELPER" "$STAGING_DIR/fortin-helper"
/usr/bin/install -m 755 "$OPENFORTIVPN_BIN" "$STAGING_DIR/openfortivpn"
/usr/bin/install -m 755 "$SSL_LIB" "$STAGING_DIR/libssl.3.dylib"
/usr/bin/install -m 755 "$CRYPTO_LIB" "$STAGING_DIR/libcrypto.3.dylib"

installer_args=(
    "$STAGING_DIR/install-autonomous-root.sh"
    "$TARGET_USER"
    "$TARGET_HOME"
    "$STAGING_DIR/fortin-helper"
    "$STAGING_DIR/openfortivpn"
    "$STAGING_DIR/libssl.3.dylib"
    "$STAGING_DIR/libcrypto.3.dylib"
    "$OPENFORTIVPN_SSL_NAME"
    "$OPENFORTIVPN_CRYPTO_NAME"
    "$SSL_CRYPTO_NAME"
)

if [ "${1:-}" = '--gui' ]; then
    /usr/bin/osascript - "${installer_args[@]}" <<'APPLESCRIPT'
on run argv
    set commandText to "/bin/bash " & quoted form of item 1 of argv
    repeat with i from 2 to count of argv
        set commandText to commandText & " " & quoted form of item i of argv
    end repeat
    do shell script commandText with prompt "Fortin necesita instalar un helper limitado para iniciar el túnel sin pedir la contraseña en cada ejecución." with administrator privileges
end run
APPLESCRIPT
else
    exec /usr/bin/sudo /bin/bash "${installer_args[@]}"
fi

/usr/bin/sudo -n /usr/local/libexec/fortin-helper version >/dev/null
printf 'Autonomous mode is ready. Use: fortin start\n'
