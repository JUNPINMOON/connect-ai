# es-search.ps1 — Everything (es.exe) wrapper for agents. READ-ONLY disk search.
# Backend: C:\Users\mjb58\Scripts\es.exe  (Everything.exe must be running)
# Note: indexes NTFS only. WSL ext4 paths (e.g. ~/.hermes) are NOT indexed — use `wsl find` for those.
# Design artifact by Claude (brain). Codex migrates to connect-ai/tools and registers in tool-registry.
#
# Examples:
#   .\es-search.ps1 "env-policy"                       # find anything named env-policy
#   .\es-search.ps1 "hooks" -Ext ts -Path connect-ai   # .ts named hooks under any connect-ai path
#   .\es-search.ps1 "" -Ext json -Sort date -Limit 10  # 10 most recently modified json files
#   .\es-search.ps1 "report" -Sort size -Limit 5       # 5 biggest files named report
#   .\es-search.ps1 "SKILL.md" -Count                  # how many SKILL.md exist
#   .\es-search.ps1 "\.pipeline\.json$" -Regex         # regex over full path

param(
  [Parameter(Mandatory=$true, Position=0)][string]$Query,
  [string]$Ext,                                  # extension filter, e.g. ts, json, md
  [string]$Path,                                 # limit to a path fragment, e.g. connect-ai\src
  [int]$Limit = 30,                              # max results (ignored with -Count)
  [ValidateSet('name','date','size')][string]$Sort = 'name',
  [switch]$Regex,                                # treat Query as a regex (do NOT combine with -Ext/-Path)
  [switch]$Count,                                # return only the number of matches
  [switch]$Json                                  # emit results as a JSON array
)

$es = 'C:\Users\mjb58\Scripts\es.exe'
if (-not (Test-Path $es)) { Write-Error "es.exe not found at $es (is Everything installed/running?)"; exit 1 }

$esArgs = @()
if ($Count) {
  $esArgs += '-get-result-count'
} else {
  $esArgs += @('-n', $Limit)
  switch ($Sort) {
    'date' { $esArgs += @('-sort','date-modified-descending','-date-modified') }
    'size' { $esArgs += @('-sort','size-descending','-size') }
  }
}
if ($Regex) { $esArgs += '-r' }

$q = @()
if (-not $Regex) {
  if ($Ext)  { $q += "ext:$Ext" }
  if ($Path) { $q += "path:$Path" }
}
if ($Query) { $q += $Query }

$out = & $es @esArgs @q
if ($Json -and -not $Count) { ,@($out) | ConvertTo-Json -Compress } else { $out }
