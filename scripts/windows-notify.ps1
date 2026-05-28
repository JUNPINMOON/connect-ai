<#
Connect AI one-shot Windows notification bridge.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-notify.ps1 -Title "Connect AI" -Body "Action needed"
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows-notify.ps1 -Title "Connect AI" -Body "Action needed" -NoToast

This script must not receive secrets. Keep title/body short and non-sensitive.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [string]$Body,

    [switch]$NoToast
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Limit-Text {
    param(
        [string]$Text,
        [int]$Max = 180
    )
    $clean = ($Text -replace '[\r\n]+', ' ').Trim()
    if ($clean.Length -le $Max) { return $clean }
    return $clean.Substring(0, $Max)
}

function Send-Toast {
    param(
        [string]$ToastTitle,
        [string]$ToastBody
    )

    if ($NoToast) { return $false }

    $burntToast = Get-Command -Name New-BurntToastNotification -ErrorAction SilentlyContinue
    if ($burntToast) {
        New-BurntToastNotification -Text $ToastTitle, $ToastBody | Out-Null
        return $true
    }

    try {
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

        $escapedTitle = [System.Security.SecurityElement]::Escape($ToastTitle)
        $escapedBody = [System.Security.SecurityElement]::Escape($ToastBody)
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

$safeTitle = Limit-Text -Text $Title -Max 80
$safeBody = Limit-Text -Text $Body -Max 180
$sent = Send-Toast -ToastTitle $safeTitle -ToastBody $safeBody

[pscustomobject]@{
    ok = $true
    toast_sent = [bool]$sent
    title = $safeTitle
    body = $safeBody
} | ConvertTo-Json -Depth 3
