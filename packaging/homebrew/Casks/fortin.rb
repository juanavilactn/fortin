cask "fortin" do
  version "1.0.0"

  # One disk image per architecture. scripts/update-cask.mjs of the application
  # writes the version and the two checksums, so they follow every release.
  on_arm do
    sha256 "7e5c7d3d743bdd194aeb7a365144831390ecc0b01430fd1e2f7ad0aea0f4f688"

    url "https://github.com/juanavilactn/fortin/releases/download/v#{version}/Fortin-#{version}-arm64.dmg"
  end

  on_intel do
    sha256 "997854d5e69c5fb1c6ab0d387e2047b5d80a8baa1a0029b20446eb311211467f"

    url "https://github.com/juanavilactn/fortin/releases/download/v#{version}/Fortin-#{version}-x64.dmg"
  end

  name "Fortin"
  desc "VPN client with SAML sign-in, a menu bar control and a CLI"
  homepage "https://github.com/juanavilactn/fortin"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :ventura"

  app "Fortin.app"
  binary "#{appdir}/Fortin.app/Contents/Resources/cli/fortin"

  uninstall quit: "com.juanavilactn.fortin"

  # Every path the application writes for the user: the configuration directory
  # (config.json, logs, screenshots, the tunnel pid and the last session cookie),
  # the Electron state directory, the login item and the preferences file. The
  # privileged helper and its sudoers rule belong to the system, so they are not
  # here: only root removes them (see the README of the tap).
  zap trash: [
    "~/.fortin",
    "~/Library/Application Support/Fortin",
    "~/Library/LaunchAgents/com.juanavilactn.fortin.plist",
    "~/Library/Preferences/com.juanavilactn.fortin.plist",
  ]

  caveats <<~EOS
    The first start opens the setup assistant. It installs a privileged helper in
    /usr/local/libexec/fortin-helper with a sudoers rule, and it asks for the
    administrator password once.

    The application is signed ad-hoc and it is not notarized, so macOS keeps it in
    quarantine: approve the first start in System Settings, Privacy and Security.
  EOS
end
