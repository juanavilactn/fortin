#!/bin/bash
set -euo pipefail

[ "$(/usr/bin/id -u)" -eq 0 ] || {
    printf 'This installer must run as root.\n' >&2
    exit 1
}

[ "$#" -eq 9 ] || {
    printf 'Invalid installer arguments.\n' >&2
    exit 64
}

target_user="$1"
target_home="$2"
source_helper="$3"
source_openfortivpn="$4"
source_ssl="$5"
source_crypto="$6"
openfortivpn_ssl_name="$7"
openfortivpn_crypto_name="$8"
source_ssl_crypto_name="$9"

[[ "$target_user" =~ ^[A-Za-z0-9._-]+$ ]] || {
    printf 'Invalid user name.\n' >&2
    exit 64
}

[[ "$target_home" == /Users/* ]] && [ -d "$target_home" ] || {
    printf 'Invalid home directory.\n' >&2
    exit 64
}

[ "$(/usr/bin/stat -f '%Su' "$target_home")" = "$target_user" ] || {
    printf 'Home directory owner does not match target user.\n' >&2
    exit 64
}

for source_file in "$source_helper" "$source_openfortivpn" "$source_ssl" "$source_crypto"; do
    [ -f "$source_file" ] || {
        printf 'Required source file not found: %s\n' "$source_file" >&2
        exit 1
    }
done

install_root='/usr/local/libexec/fortin'
helper_path='/usr/local/libexec/fortin-helper'
sudoers_path='/etc/sudoers.d/fortin'

/bin/mkdir -p "$install_root"
/usr/sbin/chown root:wheel "$install_root"
/bin/chmod 755 "$install_root"

/usr/bin/install -o root -g wheel -m 755 "$source_openfortivpn" "$install_root/openfortivpn"
/usr/bin/install -o root -g wheel -m 755 "$source_ssl" "$install_root/libssl.3.dylib"
/usr/bin/install -o root -g wheel -m 755 "$source_crypto" "$install_root/libcrypto.3.dylib"

/usr/bin/install_name_tool \
    -change "$openfortivpn_ssl_name" '@loader_path/libssl.3.dylib' \
    -change "$openfortivpn_crypto_name" '@loader_path/libcrypto.3.dylib' \
    "$install_root/openfortivpn"

/usr/bin/install_name_tool \
    -change "$source_ssl_crypto_name" '@loader_path/libcrypto.3.dylib' \
    "$install_root/libssl.3.dylib"

/usr/bin/codesign --force --sign - "$install_root/libcrypto.3.dylib"
/usr/bin/codesign --force --sign - "$install_root/libssl.3.dylib"
/usr/bin/codesign --force --sign - "$install_root/openfortivpn"

/usr/bin/install -o root -g wheel -m 755 "$source_helper" "$helper_path"

sudoers_tmp="$(/usr/bin/mktemp /tmp/fortin-sudoers.XXXXXX)"
trap '/bin/rm -f "$sudoers_tmp"' EXIT
/usr/bin/printf '%s ALL=(root:wheel) NOSETENV: NOPASSWD: %s\n' "$target_user" "$helper_path" > "$sudoers_tmp"
/bin/chmod 440 "$sudoers_tmp"
/usr/sbin/visudo -cf "$sudoers_tmp" >/dev/null
/usr/bin/install -o root -g wheel -m 440 "$sudoers_tmp" "$sudoers_path"
/usr/sbin/visudo -cf /etc/sudoers >/dev/null

config_dir="$target_home/.fortin"
if [ -d "$config_dir" ]; then
    target_group="$(/usr/bin/id -gn "$target_user")"
    /usr/sbin/chown -R -h "$target_user:$target_group" "$config_dir"
    /usr/bin/find "$config_dir" -type d -exec /bin/chmod 700 {} +
    /usr/bin/find "$config_dir" -type f -exec /bin/chmod 600 {} +
fi

printf 'Autonomous VPN helper installed for %s.\n' "$target_user"
