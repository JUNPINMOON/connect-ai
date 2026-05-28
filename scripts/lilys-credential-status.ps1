<#
Check Lilys DPAPI credential status without printing secrets or username.

Usage:
  powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lilys-credential-status.ps1
#>

[CmdletBinding()]
param(
    [string]$SecretPath = "$env:LOCALAPPDATA\ConnectAI\secrets\lilys-login.dpapi.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'


$result = [ordered]@{
    ok = $true
    status = 'missing'
    exists = $false
    secret_path = $SecretPath
    username_present = $false
    password_dpapi_present = $false
    decrypt_check = $false
    acl_owner = $null
    acl_rules_count = 0
    error = $null
}

try {
    if (-not (Test-Path -LiteralPath $SecretPath)) {
        $result.status = 'setup_required'
        $result | ConvertTo-Json -Depth 4
        exit 0
    }

    $result.exists = $true
    $secret = Get-Content -LiteralPath $SecretPath -Raw | ConvertFrom-Json
    $result.username_present = -not [string]::IsNullOrWhiteSpace([string]$secret.username)
    $result.password_dpapi_present = -not [string]::IsNullOrWhiteSpace([string]$secret.passwordDpapi)

    if ($result.password_dpapi_present) {
        $secure = $secret.passwordDpapi | ConvertTo-SecureString
        $plain = [System.Net.NetworkCredential]::new('', $secure).Password
        $result.decrypt_check = -not [string]::IsNullOrEmpty($plain)
        $plain = $null
    }

    try {
        $acl = Get-Acl -LiteralPath $SecretPath
        $result.acl_owner = $acl.Owner
        $result.acl_rules_count = @($acl.Access).Count
    } catch {
        $result.acl_owner = 'unavailable'
    }

    if ($result.username_present -and $result.password_dpapi_present -and $result.decrypt_check) {
        $result.status = 'ready'
    } else {
        $result.status = 'invalid'
        $result.ok = $false
    }
} catch {
    $result.ok = $false
    $result.status = 'error'
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 4
if ($result.ok) { exit 0 }
exit 1
