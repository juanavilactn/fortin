# Stops the openfortivpn tunnel.
#
# The tunnel runs elevated, so terminating it raises one UAC confirmation.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$inner = @'
$ErrorActionPreference = 'Continue'
$processes = Get-Process -Name 'openfortivpn' -ErrorAction SilentlyContinue
if (-not $processes) { exit 3 }
$processes | Stop-Process -Force
exit 0
'@

$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))

try {
    $process = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) `
        -Verb RunAs -PassThru -WindowStyle Hidden -Wait
} catch {
    [Console]::Error.WriteLine("fortin-helper: could not stop openfortivpn: $($_.Exception.Message)")
    exit 64
}

# 3 means "no tunnel was running": the caller treats that as already stopped.
if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 3) { exit 0 }
exit $process.ExitCode

