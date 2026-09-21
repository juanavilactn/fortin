#!/bin/bash
set -euo pipefail

# Instala el helper restringido y la regla de sudoers que permite invocarlo sin
# contrasena. Es idempotente: se puede repetir sin efectos secundarios.
#
# Uso: install-linux-helper.sh [--gui] [usuario]

HELPER_NAME='fortin-helper'
INSTALL_PATH='/usr/local/libexec/fortin-helper'
SUDOERS_PATH='/etc/sudoers.d/fortin'

fail() {
    printf 'install-linux-helper: %s\n' "$1" >&2
    exit 1
}

usage() {
    printf 'Uso: install-linux-helper.sh [--gui] [usuario]\n'
}

script_path="$0"
script_dir="$(cd "$(dirname "$(readlink -f "$script_path" 2>/dev/null || echo "$script_path")")" && pwd)"

use_gui=0
target_user=''

for arg in "$@"; do
    case "$arg" in
        --gui) use_gui=1 ;;
        -h|--help) usage; exit 0 ;;
        -*) fail "unknown option: $arg" ;;
        *)
            [ -z "$target_user" ] || fail 'only one target user is allowed'
            target_user="$arg"
            ;;
    esac
done

if [ "$(/usr/bin/id -u)" -ne 0 ]; then
    pkexec_path="$(command -v pkexec || true)"
    sudo_path="$(command -v sudo || true)"
    install_script="$script_dir/$(basename "$script_path")"

    if [ "$use_gui" -eq 1 ] && [ -n "$pkexec_path" ]; then
        exec "$pkexec_path" /bin/bash "$install_script" "$@"
    elif [ -t 0 ] && [ -n "$sudo_path" ]; then
        exec "$sudo_path" /bin/bash "$install_script" "$@"
    elif [ -n "$pkexec_path" ]; then
        exec "$pkexec_path" /bin/bash "$install_script" "$@"
    elif [ -n "$sudo_path" ]; then
        exec "$sudo_path" /bin/bash "$install_script" "$@"
    else
        fail 'root privileges are required and neither pkexec nor sudo is available'
    fi
fi

source_helper="$script_dir/$HELPER_NAME"
[ -f "$source_helper" ] || fail "helper not found: $source_helper"

if [ -z "$target_user" ]; then
    if [ -n "${PKEXEC_UID:-}" ]; then
        target_user="$(/usr/bin/id -un "$PKEXEC_UID")"
    elif [ -n "${SUDO_USER:-}" ]; then
        target_user="$SUDO_USER"
    else
        target_user="$(/usr/bin/id -un)"
    fi
fi

[[ "$target_user" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'invalid user name'
/usr/bin/id -u "$target_user" >/dev/null 2>&1 || fail "user does not exist: $target_user"

openfortivpn_path="$(command -v openfortivpn || true)"
[ -n "$openfortivpn_path" ] || fail 'openfortivpn is not installed (install it, for example: sudo apt install openfortivpn)'

install_bin="$(command -v install || true)"
[ -n "$install_bin" ] || fail 'the install tool is not available'

visudo_bin="$(command -v visudo || true)"
[ -n "$visudo_bin" ] || fail 'visudo is not available, cannot validate the sudoers rule'

"$install_bin" -d -o root -g root -m 755 /usr/local/libexec
"$install_bin" -o root -g root -m 755 "$source_helper" "$INSTALL_PATH"

sudoers_tmp="$(mktemp)"
trap 'rm -f "$sudoers_tmp"' EXIT

printf '%s ALL=(root:root) NOSETENV: NOPASSWD: %s\n' "$target_user" "$INSTALL_PATH" > "$sudoers_tmp"
chmod 440 "$sudoers_tmp"
"$visudo_bin" -cf "$sudoers_tmp" >/dev/null
"$install_bin" -o root -g root -m 440 "$sudoers_tmp" "$SUDOERS_PATH"
"$visudo_bin" -cf /etc/sudoers >/dev/null

printf 'Autonomous VPN helper installed for %s.\n' "$target_user"
printf 'openfortivpn: %s\n' "$openfortivpn_path"
