# Fortin, Homebrew tap

The cask of [Fortin](https://github.com/juanavilactn/fortin), a desktop application and a command
line tool that connects to FortiClient SSL VPN gateways with SAML authentication.

```bash
brew install --cask juanavilactn/tap/fortin
fortin status
```

The cask installs `Fortin.app` into `/Applications` and links the `fortin` command of the bundle
into the `bin` directory of Homebrew, so the command is in the `PATH` without an extra step. The
first start opens the setup assistant, which installs the privileged helper and asks for the
administrator password once.

Homebrew 7 refuses to load the cask of a third-party tap by its bare name until the tap is trusted.
Tap first and then run `brew trust juanavilactn/tap`, or install with the fully qualified name of
the command above.

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

## Automatic releases and cask updates

The application workflow, [`.github/workflows/tests.yml`](../../.github/workflows/tests.yml),
publishes when a push to `main` changes `package.json.version` to a stable `X.Y.Z` version. Run
`npm version patch --no-git-tag-version --ignore-scripts` in the application checkout, or use
`minor` or `major`, and include both `package.json` and `package-lock.json` in the change.

The `prepare-release` job checks the version change. After the tests pass, the `release` job
checks for an existing release, builds the macOS Apple Silicon and Intel DMG and ZIP files, creates
the `vX.Y.Z` tag at the tested commit, and publishes the release only when all four downloads and
`SHA256SUMS` are uploaded.
Until then, the release stays a draft. Builds use ad-hoc signing without notarization.

The `homebrew` job downloads both disk images from the public release, runs
`scripts/update-cask.mjs` to generate `packaging/homebrew/Casks/fortin.rb`, and commits the result
to `main` in the application repository. It also updates `Casks/fortin.rb` in
[`juanavilactn/homebrew-tap`](https://github.com/juanavilactn/homebrew-tap). The tap update uses the
checksums of the published downloads.

## Release setup

Create a dedicated SSH deploy key for `juanavilactn/homebrew-tap` and enable write access. Add
the public key under that repository's Settings, Deploy keys. Store the private key as the
`HOMEBREW_TAP_DEPLOY_KEY` Actions secret in `juanavilactn/fortin`. This key is used only to update
the tap; the application release and its own cask use the workflow's `GITHUB_TOKEN`.

From a private temporary directory, the equivalent CLI setup is:

```bash
ssh-keygen -t ed25519 -N '' -C fortin-release-ci -f ./tap-deploy-key
gh repo deploy-key add ./tap-deploy-key.pub --repo juanavilactn/homebrew-tap \
  --title 'Fortin release CI' --allow-write
gh secret set HOMEBREW_TAP_DEPLOY_KEY --repo juanavilactn/fortin < ./tap-deploy-key
```

Remove the temporary private key after storing it and verifying access. Do not reuse a personal
SSH key, put the private key in the repository or pass it as a command argument. The workflow
checks out the tap using this deploy key and pushes only the generated cask, without force.

If the secret is missing, the Homebrew job fails with a message identifying it. The application
release may already be public. Add the secret and rerun the failed GitHub Actions execution,
keeping the same version. A retry skips the build and publication for an already public release,
preserves its assets, and retries the tap update. If the tap already contains the generated cask,
no new commit is needed. The same applies to the cask in the application repository.

To inspect a cask locally, download both published disk images into `dist/` for the version in
`package.json`, then run `node scripts/update-cask.mjs --check`. It reports whether the checkout's
cask matches the downloads without changing it. Omitting `--check` updates the local cask.
