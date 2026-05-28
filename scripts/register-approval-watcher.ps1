<#
Registers the Connect AI approval watcher as a Windows Task Scheduler task.

The task is idempotent: if "ConnectAI-ApprovalWatcher" already exists, this
script skips creation and prints the current task state.
#>

[CmdletBinding()]
param(
    [string]$TaskName = 'ConnectAI-ApprovalWatcher',
    [string]$WatcherPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($WatcherPath)) {
    $repoRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
    $WatcherPath = Join-Path $repoRoot 'scripts\approval-watcher.ps1'
}

if (-not (Test-Path -LiteralPath $WatcherPath)) {
    throw "approval watcher not found: $WatcherPath"
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Output "scheduled task already exists: $TaskName"
} else {
    $escapedWatcher = $WatcherPath.Replace('"', '\"')
    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$escapedWatcher`""
    $trigger = New-ScheduledTaskTrigger `
        -Once `
        -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 2) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Description 'Connect AI approval queue one-shot watcher. Runs every 2 minutes.' | Out-Null

    Write-Output "scheduled task registered: $TaskName"
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
$info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    LastRunTime = $info.LastRunTime
    LastTaskResult = $info.LastTaskResult
    NextRunTime = $info.NextRunTime
    Action = ($task.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join '; '
} | Format-List
