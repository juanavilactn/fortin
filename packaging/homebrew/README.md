# Fortin, Homebrew tap

The cask of [Fortin](https://github.com/juanavilactn/fortin), a desktop application and a command
line tool that connects to FortiClient SSL VPN gateways with SAML authentication.

```bash
brew tap juanavilactn/tap
brew install --cask fortin
fortin status
```

The cask installs `Fortin.app` into `/Applications` and links the `fortin` command of the bundle
into the `bin` directory of Homebrew, so the command is in the `PATH` without an extra step. The
first start opens the setup assistant, which installs the privileged helper and asks for the
administrator password once.

The application is signed ad-hoc and it is not notarized. macOS therefore keeps it in quarantine
and the first start ends with a message about an unidentified developer: approve it in System
Settings, Privacy and Security, "Open Anyway", or drop the attribute with
`xattr -dr com.apple.quarantine "/Applications/Fortin.app"`.

## Removing it

`brew uninstall --cask fortin` removes the application and the link. The privileged helper is
system state, so the cask leaves it alone. Remove it on purpose:

```bash
sudo rm -rf /usr/local/libexec/fortin /usr/local/libexec/fortin-helper /etc/sudoers.d/fortin
```

`brew uninstall --cask --zap fortin` also removes the configuration directory and the login item of
the user.

## Updating the cask after a release

The cask names a version and the sha256 of each disk image, and the disk images only exist once the
release is published. From the checkout of the application:

```bash
# 1. bump the version in package.json, then build the two disk images
npm run dist:mac

# 2. publish the release with those images
gh release create v1.0.0 dist/Fortin-1.0.0-arm64.dmg dist/Fortin-1.0.0-x64.dmg

# 3. write the version and the real checksums into the cask
node scripts/update-cask.mjs

# 4. copy the cask into this tap, commit and push
```

`scripts/update-cask.mjs --check` reports whether the cask still matches the images of the build
directory, without writing anything.
