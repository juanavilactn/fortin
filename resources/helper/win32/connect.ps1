# Starts the openfortivpn tunnel elevated.
#
# Windows has no sudoers equivalent, so every tunnel start raises one UAC
# confirmation. The script prints exactly one line on success:
#
#   PID=<process id>
#
# Any failure writes a message to stderr and exits with a non-zero code.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$Port,
    [Parameter(Mandatory = $true)][string]$Cookie,
    [string]$TrustedCert = 'any',
    [string]$Realm = ''
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    [Console]::Error.WriteLine("fortin-helper: $Message")
    exit 64
}

if ($Server -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$') { Fail 'invalid VPN server' }
if ($Port -notmatch '^[0-9]+$') { Fail 'invalid VPN port' }
$portNumber = [int]$Port
if ($portNumber -lt 1 -or $portNumber -gt 65535) { Fail 'invalid VPN port' }
if ([string]::IsNullOrEmpty($Cookie) -or $Cookie.Length -gt 16384) { Fail 'invalid VPN cookie' }
# The cookie travels through Start-Process argument quoting, so refuse anything
# that could break out of it instead of trying to escape it.
if ($Cookie -match '[\s"''`]') { Fail 'invalid VPN cookie' }
if ($TrustedCert -ne 'any' -and $TrustedCert -notmatch '^[A-Fa-f0-9]{64}$') { Fail 'invalid trusted certificate' }
if ($Realm.Length -gt 256 -or $Realm -match '[\s"''`]') { Fail 'invalid VPN realm' }

$client = Join-Path $PSScriptRoot 'openfortivpn.exe'
if (-not (Test-Path -LiteralPath $client)) {
    $client = Join-Path $env:ProgramData 'fortin\openfortivpn.exe'
}
if (-not (Test-Path -LiteralPath $client)) {
    $onPath = Get-Command 'openfortivpn.exe' -ErrorAction SilentlyContinue
    if ($onPath) { $client = $onPath.Source }
}
if (-not (Test-Path -LiteralPath $client)) {
    Fail 'openfortivpn.exe not found'
}

$arguments = @(
    "$Server`:$Port"
    "--cookie=$Cookie"
    "--trusted-cert=$TrustedCert"
)
if (-not [string]::IsNullOrEmpty($Realm)) {
    $arguments += "--realm=$Realm"
}

$quoted = foreach ($argument in $arguments) { '"' + $argument + '"' }

try {
    $process = Start-Process -FilePath $client -ArgumentList ($quoted -join ' ') -Verb RunAs -PassThru -WindowStyle Hidden
} catch {
    Fail "could not start openfortivpn elevated: $($_.Exception.Message)"
}

Write-Output "PID=$($process.Id)"

