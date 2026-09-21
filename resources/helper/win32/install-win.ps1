# Prepares the Windows client: installs openfortivpn.exe under ProgramData and
# checks the TAP driver that the tunnel needs.
#
# Run once with administrator rights (the app launches it with a UAC prompt):
#
#   powershell -ExecutionPolicy Bypass -File install-win.ps1
#
# If openfortivpn.exe ships next to this script it is copied; otherwise the
# script explains what to install and fails without touching the system.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$installRoot = Join-Path $env:ProgramData 'fortin'
$source = Join-Path $PSScriptRoot 'openfortivpn.exe'
$target = Join-Path $installRoot 'openfortivpn.exe'

if (-not (Test-Path -LiteralPath $installRoot)) {
    New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
}

if (Test-Path -LiteralPath $source) {
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Output "Installed openfortivpn.exe in $installRoot"
} elseif (Test-Path -LiteralPath $target) {
    Write-Output "openfortivpn.exe is already installed in $installRoot"
} else {
    $onPath = Get-Command 'openfortivpn.exe' -ErrorAction SilentlyContinue
    if ($onPath) {
        Write-Output "openfortivpn.exe found on PATH: $($onPath.Source)"
    } else {
        [Console]::Error.WriteLine('openfortivpn.exe was not found next to this script or on PATH.')
        [Console]::Error.WriteLine('Windows needs openfortivpn for Windows and a TAP-Windows adapter:')
        [Console]::Error.WriteLine('  1. Install the TAP-Windows driver (tap-windows, shipped with OpenVPN).')
        [Console]::Error.WriteLine('  2. Build or download openfortivpn.exe and copy it next to this script.')
        [Console]::Error.WriteLine('  3. Run this installer again.')
        exit 1
    }
}

$adapter = Get-NetAdapter -ErrorAction SilentlyContinue |
    Where-Object { $_.InterfaceDescription -match 'TAP-Windows|Fortinet' }
if (-not $adapter) {
    [Console]::Error.WriteLine('No TAP-Windows or Fortinet adapter was found. Install the TAP driver before connecting.')
    exit 2
}

Write-Output "VPN adapter found: $($adapter[0].Name) ($($adapter[0].InterfaceDescription))"
Write-Output 'Windows client ready.'
