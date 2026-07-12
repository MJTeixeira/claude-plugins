# Windows Task Scheduler registration for the Factory (run in PowerShell as your user).
# NOTE: untested on a real Windows machine — see FACTORY.md "First run on Windows".
# Usage: .\register-tasks.ps1 -Project "C:\path\to\project" [-DevTime 09:00] [-TriageTime 08:30] [-ReportTime 13:30]

param(
    [Parameter(Mandatory = $true)][string]$Project,
    [string]$DevTime = "09:00",
    [string]$TriageTime = "08:30",
    [string]$ReportTime = "13:30"
)

$node = (Get-Command node -ErrorAction Stop).Source
$driver = Join-Path $env:USERPROFILE ".factory\runtime\factory\driver\factory.mjs"
if (-not (Test-Path $driver)) { throw "Runtime not found: $driver — bootstrap it: git clone <repo-url> $env:USERPROFILE\.factory\runtime" }

$modes = @(
    @{ Name = "Factory Triage"; Mode = "triage"; Time = $TriageTime },
    @{ Name = "Factory Dev";    Mode = "dev";    Time = $DevTime },
    @{ Name = "Factory Report"; Mode = "report"; Time = $ReportTime }
)

foreach ($m in $modes) {
    $action = New-ScheduledTaskAction -Execute $node `
        -Argument "`"$driver`" $($m.Mode) --project `"$Project`"" `
        -WorkingDirectory $Project
    $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $m.Time
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 8) -StartWhenAvailable:$false
    Register-ScheduledTask -TaskName $m.Name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Write-Host "Registered '$($m.Name)' ($($m.Mode)) at $($m.Time) Mon-Fri"
}

Write-Host "Test one now:  Start-ScheduledTask -TaskName 'Factory Dev'"
Write-Host "Remove all:    'Factory Triage','Factory Dev','Factory Report' | ForEach-Object { Unregister-ScheduledTask -TaskName `$_ -Confirm:`$false }"
