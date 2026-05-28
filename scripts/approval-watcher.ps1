<# 
Connect AI approval watcher (one-shot)

Usage examples:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\approval-watcher.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\approval-watcher.ps1 -NoToast

Schedule this as a periodic one-shot from n8n or Windows Task Scheduler.
Do not run it as an infinite loop. It reads approval-queue.jsonl once, sends
notifications for newly seen unused approvals, writes watcher state, and exits.
#>

[CmdletBinding()]
param(
    [string]$QueuePath = (Join-Path $env:APPDATA 'Code\User\globalStorage\connectailab.connect-ai-lab\phase2\approval-queue.jsonl'),
    [string]$ApprovalPacketDir = '',
    [string]$StatePath = '',
    [switch]$NoToast
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($StatePath)) {
    $StatePath = Join-Path (Split-Path -Parent $QueuePath) 'approval-watcher.state.json'
}
if ([string]::IsNullOrWhiteSpace($ApprovalPacketDir)) {
    $ApprovalPacketDir = Join-Path (Split-Path -Parent $QueuePath) 'vault-writer\approval-packets'
}

function Read-WatcherState {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return [pscustomobject]@{
            lastWriteTimeUtc = $null
            lineCount = 0
            seenTokens = @()
        }
    }
    try {
        return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    } catch {
        return [pscustomobject]@{
            lastWriteTimeUtc = $null
            lineCount = 0
            seenTokens = @()
        }
    }
}

function Save-WatcherState {
    param(
        [string]$Path,
        [string]$LastWriteTimeUtc,
        [int]$LineCount,
        [string[]]$SeenTokens
    )
    $dir = Split-Path -Parent $Path
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [pscustomobject]@{
        lastWriteTimeUtc = $LastWriteTimeUtc
        lineCount = $LineCount
        seenTokens = @($SeenTokens | Sort-Object -Unique)
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Send-ApprovalToast {
    param(
        [string]$Title,
        [string]$Body
    )
    if ($NoToast) { return $false }

    $burntToast = Get-Command -Name New-BurntToastNotification -ErrorAction SilentlyContinue
    if ($burntToast) {
        New-BurntToastNotification -Text $Title, $Body | Out-Null
        return $true
    }

    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

        $escapedTitle = [System.Security.SecurityElement]::Escape($Title)
        $escapedBody = [System.Security.SecurityElement]::Escape($Body)
        $xml = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>$escapedTitle</text>
      <text>$escapedBody</text>
    </binding>
  </visual>
</toast>
"@
        $doc = [Windows.Data.Xml.Dom.XmlDocument]::new()
        $doc.LoadXml($xml)
        $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Connect AI').Show($toast)
        return $true
    } catch {
        Write-Warning "toast unavailable: $($_.Exception.Message)"
        return $false
    }
}

function Get-JsonProperty {
    param(
        [object]$Object,
        [string]$Name,
        [object]$Default = $null
    )
    if ($null -eq $Object) { return $Default }
    if ($Object.PSObject.Properties.Name -contains $Name) {
        return $Object.$Name
    }
    return $Default
}

$state = Read-WatcherState -Path $StatePath
$seenTokens = @((Get-JsonProperty -Object $state -Name 'seenTokens' -Default @()))
$usedTokens = New-Object 'System.Collections.Generic.HashSet[string]'
$approvals = New-Object 'System.Collections.Generic.List[object]'
$lineCount = 0
$lastWrite = ''

if (Test-Path -LiteralPath $QueuePath) {
    $queueItem = Get-Item -LiteralPath $QueuePath
    $lines = @(Get-Content -LiteralPath $QueuePath -ErrorAction Stop)
    $lineCount = $lines.Count
    $lastWrite = $queueItem.LastWriteTimeUtc.ToString('o')

    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try {
            $record = $line | ConvertFrom-Json
        } catch {
            Write-Warning "skipping invalid approval queue line"
            continue
        }
        $recordType = Get-JsonProperty -Object $record -Name 'type' -Default ''
        $recordToken = Get-JsonProperty -Object $record -Name 'token' -Default ''
        if ($recordType -eq 'approval_used' -and $recordToken) {
            [void]$usedTokens.Add([string]$recordToken)
            continue
        }
        if ($recordToken) {
            [void]$approvals.Add($record)
        }
    }
} else {
    Write-Output "approval queue missing: $QueuePath"
}

$pending = @()
foreach ($approval in $approvals) {
    $token = [string](Get-JsonProperty -Object $approval -Name 'token' -Default '')
    if (-not $token) { continue }
    $used = $false
    $usedValue = Get-JsonProperty -Object $approval -Name 'used' -Default $false
    $used = [bool]$usedValue
    if ($used -or $usedTokens.Contains($token)) { continue }
    if ($seenTokens -contains $token) { continue }
    $pending += [pscustomobject]@{
        kind = 'approval_queue'
        marker = $token
        item = $approval
    }
}

if (Test-Path -LiteralPath $ApprovalPacketDir) {
    $packetFiles = @(Get-ChildItem -LiteralPath $ApprovalPacketDir -Filter '*.json' -File -ErrorAction SilentlyContinue)
    foreach ($packetFile in $packetFiles) {
        try {
            $packet = Get-Content -LiteralPath $packetFile.FullName -Raw | ConvertFrom-Json
        } catch {
            Write-Warning "skipping invalid approval packet: $($packetFile.FullName)"
            continue
        }
        $batchId = [string](Get-JsonProperty -Object $packet -Name 'batchId' -Default ([System.IO.Path]::GetFileNameWithoutExtension($packetFile.Name)))
        if (-not $batchId) { continue }
        $marker = "packet:$batchId"
        if ($seenTokens -contains $marker) { continue }
        $ready = [bool](Get-JsonProperty -Object $packet -Name 'readyForApproval' -Default $false)
        $requiresApproval = [bool](Get-JsonProperty -Object $packet -Name 'requiresExplicitHumanApproval' -Default $false)
        $approved = [bool](Get-JsonProperty -Object $packet -Name 'approved' -Default $false)
        if (-not ($ready -and $requiresApproval -and -not $approved)) { continue }
        $counts = Get-JsonProperty -Object $packet -Name 'counts' -Default $null
        $plannedMoves = Get-JsonProperty -Object $counts -Name 'plannedMoves' -Default 'n/a'
        $pending += [pscustomobject]@{
            kind = 'approval_packet'
            marker = $marker
            item = $packet
            body = "root-note-migration / plannedMoves=$plannedMoves / $batchId"
        }
    }
}

if ($pending.Count -eq 0) {
    if ($state.lastWriteTimeUtc -eq $lastWrite -and [int]$state.lineCount -eq $lineCount) {
        Write-Output "no pending approvals (no queue change)"
    } else {
        Write-Output "no pending approvals"
    }
    Save-WatcherState -Path $StatePath -LastWriteTimeUtc $lastWrite -LineCount $lineCount -SeenTokens $seenTokens
    exit 0
}

foreach ($approval in $pending) {
    if ($approval.kind -eq 'approval_packet') {
        $body = [string]$approval.body
        [void](Send-ApprovalToast -Title 'Connect AI 승인 필요' -Body $body)
        Write-Output "pending approval packet: $body"
        $seenTokens += [string]$approval.marker
        continue
    }

    $item = $approval.item
    $request = Get-JsonProperty -Object $item -Name 'request' -Default $null
    $action = [string](Get-JsonProperty -Object $request -Name 'action' -Default 'unknown-action')
    $departmentId = [string](Get-JsonProperty -Object $request -Name 'departmentId' -Default 'n/a')
    $payloadHash = [string](Get-JsonProperty -Object $item -Name 'payloadHash' -Default '')
    $hash = if ($payloadHash) { $payloadHash.Substring(0, [Math]::Min(8, $payloadHash.Length)) } else { 'no-hash' }
    $body = "$action / $departmentId / $hash"
    [void](Send-ApprovalToast -Title 'Connect AI 승인 필요' -Body $body)
    Write-Output "pending approval: $body"
    $seenTokens += [string]$approval.marker
}

Save-WatcherState -Path $StatePath -LastWriteTimeUtc $lastWrite -LineCount $lineCount -SeenTokens $seenTokens
