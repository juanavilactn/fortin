cask "fortin" do
  version "1.0.0"

  # One disk image per architecture. scripts/update-cask.mjs of the application
  # writes the version and the two checksums, so they follow every release.
  on_arm do
    sha256 "8c444e8bba4aa3e0a2c4d0dcfd3d78c3e188a3f60a9688ae8ccfbb057f4d375d"

    url "https://github.com/juanavilactn/fortin/releases/download/v#{version}/Fortin-#{version}-arm64.dmg"
  end
  on_intel do
    sha256 "07a18a9e4445bb5871d90927252b896c30b295a9f4eff9cb8a5452dcd6257082"

    url "https://github.com/juanavilactn/fortin/releases/download/v#{version}/Fortin-#{version}-x64.dmg"
  end

  name "Fortin"
  desc "VPN client with SAML sign-in, a menu bar control and a CLI"
  homepage "https://github.com/juanavilactn/fortin"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

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
