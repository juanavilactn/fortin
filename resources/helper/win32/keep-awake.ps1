# Holds the system awake while the tunnel is up.
#
# The assertion belongs to the thread that sets it, so this script keeps one
# thread alive for as long as the app lets it run. Killing the process drops the
# assertion, which is what has to happen on disconnect.
Add-Type -Namespace Fortin -Name Power -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@

$ES_CONTINUOUS = 0x80000000
$ES_SYSTEM_REQUIRED = 0x00000001

try {
    [void][Fortin.Power]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED)
    Write-Output 'Keep-awake assertion held.'
    while ($true) { Start-Sleep -Seconds 30 }
} finally {
    [void][Fortin.Power]::SetThreadExecutionState($ES_CONTINUOUS)
}

