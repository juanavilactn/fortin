# Security

Fortin keeps the VPN password, the TOTP secret and the last session cookie in the secret store of
the operating system (the macOS Keychain, `secret-tool` on Linux), never in the configuration file.
It drives a real Chrome profile to complete the Microsoft sign-in and hands the resulting
`SVPNCOOKIE` to a privileged helper that opens the tunnel. Treat all of that as sensitive.

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the Security tab of this repository and select
Report a vulnerability. Do not open a public issue for a vulnerability, and do not paste a real
`SVPNCOOKIE`, a password or a TOTP secret into an issue, a pull request or a log.

## Scope

The helper scripts in `resources/helper/` run with administrator rights, and the sudoers rule they
install allows a fixed set of commands. Reports about privilege escalation through that rule, about
secrets reaching disk or the process list, and about the browser automation are in scope.
