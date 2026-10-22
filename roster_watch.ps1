<#
  Daily roster and injury watch for the Angle projections site.
  Runs in GitHub Actions twice a day (see .github/workflows/roster-watch.yml), or by hand.

  1. Reads every NBA team roster and the league injury report from ESPN's public feeds.
  2. Compares them with the last run (data/rosters.json, data/injuries.json) and lists what changed:
       signed     a player joined an NBA roster
       waived     a player is no longer on any NBA roster
       moved      a player is on a different team
       out        a player was ruled out (or his expected return date moved)
       dtd        a rotation player (15+ minutes a game) went day-to-day
       back       a player came off the injury report
  3. Writes data/rosters.json, data/injuries.json (the site shows injury badges from it) and data/changes.json
     (a running log of the last 30 days of changes).
  4. When something changed, writes report.md for the workflow to open a GitHub issue (GitHub emails the repo owner).
  Only facts are kept (team, status, injury type, expected return date); ESPN's written injury notes are never copied.
#>
param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$Report = '',            # where to write the issue text; empty = <Root>/report.md
  [int]$KeepDays = 30
)
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
$headers = @{ 'User-Agent' = 'Mozilla/5.0 (compatible; angle-fantasy-ranks/1.0)' }
$dataDir = Join-Path $Root 'data'; if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory $dataDir | Out-Null }
if (-not $Report) { $Report = Join-Path $Root 'report.md' }
if (Test-Path $Report) { Remove-Item $Report }
$tz = try { [TimeZoneInfo]::FindSystemTimeZoneById('America/New_York') } catch { [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time') }
$today = [TimeZoneInfo]::ConvertTimeFromUtc([datetime]::UtcNow, $tz).ToString('yyyy-MM-dd', $inv)
$utf8 = New-Object Text.UTF8Encoding $false
function ReadJson($name) { $f = Join-Path $dataDir $name; if (Test-Path $f) { Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null } }
function WriteJson($name, $obj) { [IO.File]::WriteAllText((Join-Path $dataDir $name), ($obj | ConvertTo-Json -Depth 6 -Compress), $utf8) }
$failures = @()

# ---------- 1. rosters ----------
$prevR = ReadJson 'rosters.json'   # { updated, p: { id: [name, team, pos] } }
$prev = @{}; if ($prevR) { foreach ($pp in $prevR.p.PSObject.Properties) { $prev[$pp.Name] = @($pp.Value) } }
$now = @{}; $badTeams = @()
foreach ($tid in 1..30) {
  try { $r = Invoke-RestMethod -Headers $headers -Uri "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/$tid/roster" -TimeoutSec 60 }
  catch { $failures += "roster $tid"; $badTeams += "$tid"; continue }
  $abbr = [string]$r.team.abbreviation; $ath = @($r.athletes)
  if (-not $abbr -or $ath.Count -lt 12) { $failures += "roster $tid looked incomplete ($($ath.Count) players)"; $badTeams += $abbr; continue }
  foreach ($a in $ath) { $now[[string]$a.id] = @([string]$a.fullName, $abbr, [string]$a.position.abbreviation) }
  Start-Sleep -Milliseconds 200
}
# a team whose feed failed keeps yesterday's players, so a bad fetch never looks like a mass release
if ($badTeams.Count) { foreach ($id in $prev.Keys) { if ($badTeams -contains $prev[$id][1] -and -not $now.ContainsKey($id)) { $now[$id] = $prev[$id] } } }
$rosterOk = $now.Count -ge 360 -and $badTeams.Count -le 3

# rotation players (15+ minutes a game this season), from the box-score log the daily ranks job keeps
$mpg = @{}
$gcsv = Join-Path $dataDir 'games.csv'
if (Test-Path $gcsv) { foreach ($g in (Import-Csv $gcsv | Group-Object id)) { $m = ($g.Group | Measure-Object { [double]$_.min } -Average).Average; $mpg[$g.Name] = $m } }

$changes = New-Object System.Collections.ArrayList
function AddChange($k, $id, $n, $t, $x) { [void]$changes.Add([ordered]@{ d = $today; k = $k; id = $id; n = $n; t = $t; x = $x }) }
if ($prevR -and $rosterOk) {
  foreach ($id in $now.Keys) {
    $c = $now[$id]
    if (-not $prev.ContainsKey($id)) { AddChange 'signed' $id $c[0] $c[1] "Joined the $($c[1]) roster" }
    elseif ($prev[$id][1] -ne $c[1]) { AddChange 'moved' $id $c[0] $c[1] "$($prev[$id][1]) to $($c[1])" }
  }
  foreach ($id in $prev.Keys) { if (-not $now.ContainsKey($id)) { $o = $prev[$id]; AddChange 'waived' $id $o[0] $o[1] "No longer on the $($o[1]) roster (waived, released or traded away)" } }
}

# ---------- 2. injuries ----------
$prevI = ReadJson 'injuries.json'   # { updated, p: { id: { n, t, s, r, i } } }
$pi = @{}; if ($prevI) { foreach ($pp in $prevI.p.PSObject.Properties) { $pi[$pp.Name] = $pp.Value } }
$inj = [ordered]@{}; $injOk = $false
try {
  $f = Invoke-RestMethod -Headers $headers -Uri "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries" -TimeoutSec 60
  foreach ($team in @($f.injuries)) {
    foreach ($i in @($team.injuries)) {
      $href = (@($i.athlete.links) | Where-Object { $_.href -match '/id/(\d+)' } | Select-Object -First 1).href
      if (-not $href -or $href -notmatch '/id/(\d+)') { continue }; $id = $Matches[1]
      $d = $i.details
      $what = (@($d.type, $d.detail) | Where-Object { $_ -and $_ -ne 'Not Specified' }) -join ' '
      if ($d.side -and $d.side -ne 'Not Specified' -and $what) { $what = "$($d.side) $what" }; $what = $what.ToLower()
      $t = if ($now.ContainsKey($id)) { $now[$id][1] } else { [string]$i.athlete.team.abbreviation }
      $inj[$id] = [ordered]@{ n = [string]$i.athlete.displayName; t = $t; s = [string]$i.status; r = [string]$d.returnDate; i = $what }
    }
  }
  $injOk = $true
} catch { $failures += "injury report" }

$fmt = { param($ds) if (-not $ds) { return '' }; try { ([datetime]::ParseExact($ds, 'yyyy-MM-dd', $inv)).ToString('MMM d', $inv) } catch { $ds } }
if ($prevI -and $injOk) {
  foreach ($id in $inj.Keys) {
    $c = $inj[$id]; $o = $pi[$id]
    $back = if ($c.r) { ", expected back $(& $fmt $c.r)" } else { '' }
    $why = if ($c.i) { " ($($c.i))" } else { '' }
    if ($c.s -eq 'Out') {
      if (-not $o -or $o.s -ne 'Out') { AddChange 'out' $id $c.n $c.t "Out$why$back" }
      elseif ($c.r -and $o.r -and $c.r -ne $o.r) {
        $shift = ([datetime]::ParseExact($c.r, 'yyyy-MM-dd', $inv) - [datetime]::ParseExact($o.r, 'yyyy-MM-dd', $inv)).TotalDays
        if ([math]::Abs($shift) -ge 5) { AddChange 'out' $id $c.n $c.t "Expected return moved from $(& $fmt $o.r) to $(& $fmt $c.r)" }
      }
    } elseif ((-not $o -or $o.s -eq 'Out') -and ($mpg[$id] -ge 15)) { AddChange 'dtd' $id $c.n $c.t "Day-to-day$why" }
  }
  foreach ($id in $pi.Keys) { if (-not $inj.Contains($id) -and $pi[$id].s -eq 'Out') { $o = $pi[$id]; AddChange 'back' $id $o.n $o.t "Off the injury report" } }
}

# ---------- 3. state files ----------
$stamp = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', $inv)
if ($rosterOk) { $rp = [ordered]@{}; foreach ($id in ($now.Keys | Sort-Object)) { $rp[$id] = $now[$id] }; WriteJson 'rosters.json' ([ordered]@{ updated = $stamp; p = $rp }) }
else { $failures += "rosters not saved ($($now.Count) players, $($badTeams.Count) teams failed)" }
if ($injOk) { WriteJson 'injuries.json' ([ordered]@{ updated = $stamp; p = $inj }) }
$old = @(); $prevC = ReadJson 'changes.json'; if ($prevC) { $old = @($prevC.c) }
$cut = [TimeZoneInfo]::ConvertTimeFromUtc([datetime]::UtcNow, $tz).AddDays(-$KeepDays).ToString('yyyy-MM-dd', $inv)
# the same change seen twice in one day (morning and evening runs) is kept once
$seen = @{}; $all = @(foreach ($x in (@($changes) + $old)) { $key = "$($x.d)|$($x.k)|$($x.id)|$($x.x)"; if ($x.d -ge $cut -and -not $seen.ContainsKey($key)) { $seen[$key] = 1; $x } })
WriteJson 'changes.json' ([ordered]@{ updated = $stamp; c = @($all) })

# ---------- 4. report ----------
"rosters: $($now.Count) players ($(if ($rosterOk) { 'saved' } else { 'NOT saved' })); injury report: $($inj.Count) players; changes: $($changes.Count)"
if ($changes.Count) {
  $LAB = [ordered]@{ waived = 'Waived / released'; signed = 'Signed'; moved = 'Changed teams'; out = 'Ruled out'; dtd = 'Day-to-day (rotation players)'; back = 'Back from injury' }
  $md = @("Changes since the last check (ESPN rosters and injury report), $today.", "", "Rerun the projections if any of these players are on the board.", "")
  foreach ($k in $LAB.Keys) {
    $grp = @($changes | Where-Object { $_.k -eq $k }); if (-not $grp.Count) { continue }
    $md += "### $($LAB[$k]) ($($grp.Count))"; $md += ""; $md += "| Player | Team | Detail |"; $md += "|---|---|---|"
    foreach ($x in ($grp | Sort-Object { $_.t }, { $_.n })) { $md += "| [$($x.n)](https://www.espn.com/nba/player/_/id/$($x.id)) | $($x.t) | $($x.x) |" }
    $md += ""
  }
  if ($env:GITHUB_REPOSITORY_OWNER) { $md += "@$($env:GITHUB_REPOSITORY_OWNER)" }
  [IO.File]::WriteAllText($Report, ($md -join "`n"), $utf8)
  "report: $Report"
}
foreach ($x in $failures) { Write-Host "::warning::$x (it will be retried on the next run)" }
