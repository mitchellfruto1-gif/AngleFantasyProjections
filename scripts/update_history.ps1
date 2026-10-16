<#
  Weekly fantasy rank history for the Angle projections site.
  Runs in GitHub Actions every morning after the previous night's games are final (see .github/workflows/weekly-ranks.yml), or by hand.

  1. Pulls completed NBA games from ESPN's public scoreboard/box-score feeds into data/games.csv
     (only new games are fetched; the CSV is the running game log).
  2. For every completed fantasy week (week 1 = opening night through the first Sunday, then Mon-Sun),
     ranks players on season-to-date PER-GAME value:
       - 9-cat: sum of z-scores (FG%/FT% weighted by attempts), pool = top 200
       - Yahoo Points: PTS 1, REB 1.2, AST 1.5, STL 3, BLK 3, TO -1
       - ESPN Points: PTS 1, 3PM 1, FGM 2, FGA -1, FTM 1, FTA -1, REB 1, AST 2, STL 4, BLK 4, TO -2
  3. Writes data/gamelogs/{espnId}.json: every regular-season game for the player card's Games Log tab.
  4. Writes history.json, keyed by ESPN athlete id: weekly ranks and weekly totals for the Trend graphs (completed weeks only),
     plus "latest" = season-to-date totals through last night, which the page uses for the daily Real / Blend ranks.
#>
param(
  [string]$Root = (Split-Path $PSScriptRoot -Parent),
  [string]$SeasonStart = '2026-10-20',
  [int]$SeasonType = 2,          # 2 = regular season (1 = preseason, for testing)
  [string]$Through = ''          # last date to include (yyyy-MM-dd); default = yesterday, US Eastern
)
$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture
$start = [datetime]::ParseExact($SeasonStart, 'yyyy-MM-dd', $inv)
$last = if ($Through) { [datetime]::ParseExact($Through, 'yyyy-MM-dd', $inv) } else { [datetime]::UtcNow.AddHours(-5).Date.AddDays(-1) }
$dataDir = Join-Path $Root 'data'; if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory $dataDir | Out-Null }
$gamesCsv = Join-Path $dataDir 'games.csv'
$headers = @{ 'User-Agent' = 'Mozilla/5.0 (compatible; angle-fantasy-ranks/1.0)' }

# ---------- 1. game log ----------
$rows = [Collections.Generic.List[object]]::new()
$haveGame = @{}
if (Test-Path $gamesCsv) { foreach ($r in (Import-Csv $gamesCsv)) { $rows.Add($r); $haveGame[$r.game] = 1 } }
$fetchFrom = $start
if ($rows.Count) { $maxDate = ($rows | ForEach-Object { $_.date } | Sort-Object | Select-Object -Last 1); $fetchFrom = [datetime]::ParseExact($maxDate, 'yyyy-MM-dd', $inv).AddDays(-1); if ($fetchFrom -lt $start) { $fetchFrom = $start } }
$newGames = 0; $failures = @()
if ($last -lt $start) { "Regular season starts $SeasonStart; no games to pull yet (preseason games are never counted)." }
for ($d = $fetchFrom; $d -le $last; $d = $d.AddDays(1)) {
  $ds = $d.ToString('yyyyMMdd', $inv)
  try { $sb = Invoke-RestMethod -Headers $headers -Uri "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=$ds&seasontype=$SeasonType" -TimeoutSec 60 }
  catch { Write-Warning "scoreboard $ds failed: $($_.Exception.Message)"; $failures += "scoreboard $ds"; continue }
  foreach ($ev in @($sb.events)) {
    if (-not $ev.status.type.completed -or $haveGame.ContainsKey([string]$ev.id)) { continue }
    try { $g = Invoke-RestMethod -Headers $headers -Uri "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=$($ev.id)" -TimeoutSec 60 }
    catch { Write-Warning "game $($ev.id) failed: $($_.Exception.Message)"; $failures += "game $($ev.id) on $ds"; continue }
    # final score and home/away for each side (for the Games Log)
    $side = @{}; foreach ($c in @($g.header.competitions[0].competitors)) { $side[[string]$c.team.abbreviation] = $c }
    foreach ($tm in @($g.boxscore.players)) {
      $me = $side[[string]$tm.team.abbreviation]; $op = @($side.Values | Where-Object { $_ -ne $me })[0]
      $st = $tm.statistics[0]; $keys = @($st.keys)
      $ix = @{}; for ($i = 0; $i -lt $keys.Count; $i++) { $ix[$keys[$i]] = $i }
      foreach ($a in @($st.athletes)) {
        if ($a.didNotPlay -or -not $a.stats -or @($a.stats).Count -eq 0) { continue }
        $s = @($a.stats)
        $num = { param($k) $v = 0.0; [void][double]::TryParse([string]$s[$ix[$k]], [Globalization.NumberStyles]::Float, $inv, [ref]$v); $v }
        $pair = { param($k) $p = ([string]$s[$ix[$k]]).Split('-'); $m = 0.0; $t = 0.0; [void][double]::TryParse($p[0], [Globalization.NumberStyles]::Float, $inv, [ref]$m); if ($p.Count -gt 1) { [void][double]::TryParse($p[1], [Globalization.NumberStyles]::Float, $inv, [ref]$t) }; @($m, $t) }
        $min = & $num 'minutes'; if ($min -le 0) { continue }
        $fg = & $pair 'fieldGoalsMade-fieldGoalsAttempted'; $tp = & $pair 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'; $ft = & $pair 'freeThrowsMade-freeThrowsAttempted'
        $rows.Add([pscustomobject]@{ game = [string]$ev.id; date = $d.ToString('yyyy-MM-dd', $inv); id = [string]$a.athlete.id; name = $a.athlete.displayName; team = $tm.team.abbreviation; pos = [string]$a.athlete.position.abbreviation
          opp = $(if ($op) { [string]$op.team.abbreviation } else { "" }); ha = $(if ($me) { [string]$me.homeAway } else { "" }); tsc = $(if ($me) { [string]$me.score } else { "" }); osc = $(if ($op) { [string]$op.score } else { "" })
          min = $min; pts = (& $num 'points'); fgm = $fg[0]; fga = $fg[1]; tpm = $tp[0]; ftm = $ft[0]; fta = $ft[1]
          reb = (& $num 'rebounds'); ast = (& $num 'assists'); stl = (& $num 'steals'); blk = (& $num 'blocks'); to = (& $num 'turnovers') })
      }
    }
    $haveGame[[string]$ev.id] = 1; $newGames++
    Start-Sleep -Milliseconds 250
  }
}
$rows | Select-Object game, date, id, name, team, pos, opp, ha, tsc, osc, min, pts, fgm, fga, tpm, ftm, fta, reb, ast, stl, blk, to | Export-Csv -NoTypeInformation -Encoding UTF8 $gamesCsv
"game log: $($haveGame.Count) games ($newGames new), $($rows.Count) player lines"

# ---------- 2. weekly ranks ----------
# week 1 runs from opening night through the first Sunday; after that, Monday-Sunday
$firstSun = $start; while ($firstSun.DayOfWeek -ne [DayOfWeek]::Sunday) { $firstSun = $firstSun.AddDays(1) }
$weeks = @(); $n = 1
for ($e = $firstSun; $e -le $last; $e = $e.AddDays(7)) { $weeks += [pscustomobject]@{ n = $n; end = $e.ToString('yyyy-MM-dd', $inv) }; $n++ }
function Stats($vals) { $c = @($vals).Count; if (-not $c) { return @(0, 1) }; $m = ($vals | Measure-Object -Average).Average; $v = (($vals | ForEach-Object { ($_ - $m) * ($_ - $m) }) | Measure-Object -Sum).Sum / $c; @($m, [math]::Max([math]::Sqrt($v), 1e-9)) }
$sorted = @($rows | Sort-Object date)
$tot = @{}; $names = @{}; $ri = 0
$ranks = @{}   # id -> @{ cat = [..]; yahoo = [..]; espn = [..] }
$wk = @{}; $teamOf = @{}; $posOf = @{}   # id -> per-week box-score totals [gp, min, pts, fgm, fga, tpm, ftm, fta, reb, ast, stl, blk, to] (public stats; the page blends them with projections)
$FIELDS = @('min','pts','fgm','fga','tpm','ftm','fta','reb','ast','stl','blk','to')   # not $K: PowerShell names are case-insensitive, so $k loops would overwrite it
for ($w = 0; $w -lt $weeks.Count; $w++) {
  $end = $weeks[$w].end
  while ($ri -lt $sorted.Count -and $sorted[$ri].date -le $end) {
    $r = $sorted[$ri]; $ri++
    if (-not $tot.ContainsKey($r.id)) { $h = @{ gp = 0 }; foreach ($k in $FIELDS) { $h[$k] = 0.0 }; $tot[$r.id] = $h }
    $h = $tot[$r.id]; $h.gp++; foreach ($k in $FIELDS) { $h[$k] += [double]$r.$k }; $names[$r.id] = $r.name
    if (-not $wk.ContainsKey($r.id)) { $wk[$r.id] = New-Object 'object[]' $weeks.Count }
    if ($null -eq $wk[$r.id][$w]) { $wk[$r.id][$w] = New-Object 'double[]' 13 }
    $acc = $wk[$r.id][$w]; $acc[0]++; for ($j = 0; $j -lt $FIELDS.Count; $j++) { $acc[$j + 1] += [double]$r.($FIELDS[$j]) }
    $teamOf[$r.id] = $r.team; if ($r.pos) { $posOf[$r.id] = $r.pos }
  }
  # qualify: at least 40% of the most games anyone has played so far, and 8+ minutes a game
  $maxGp = ($tot.Values | ForEach-Object { $_.gp } | Measure-Object -Maximum).Maximum
  $minGp = [math]::Max(1, [math]::Ceiling(0.4 * $maxGp))
  $pl = @(foreach ($id in $tot.Keys) {
    $h = $tot[$id]; if ($h.gp -lt $minGp -or ($h.min / $h.gp) -lt 8) { continue }
    $g = $h.gp; $o = [ordered]@{ id = $id; gp = $g }; foreach ($k in $FIELDS) { $o[$k] = $h[$k] / $g }
    $o.fgp = if ($h.fga -gt 0) { $h.fgm / $h.fga } else { 0 }; $o.ftp = if ($h.fta -gt 0) { $h.ftm / $h.fta } else { 0 }
    $o.yahoo = $o.pts + 1.2 * $o.reb + 1.5 * $o.ast + 3 * $o.stl + 3 * $o.blk - $o.to
    $o.espn = $o.pts + $o.tpm + 2 * $o.fgm - $o.fga + $o.ftm - $o.fta + $o.reb + 2 * $o.ast + 4 * $o.stl + 4 * $o.blk - 2 * $o.to
    [pscustomobject]$o
  })
  if (-not $pl.Count) { continue }
  # 9-cat per-game value: z-scores against the top-200 pool (two passes, like the projections)
  $pool = $pl
  for ($pass = 0; $pass -lt 2; $pass++) {
    $lgFG = ($pool | Measure-Object fgm -Sum).Sum / [math]::Max(($pool | Measure-Object fga -Sum).Sum, 1)
    $lgFT = ($pool | Measure-Object ftm -Sum).Sum / [math]::Max(($pool | Measure-Object fta -Sum).Sum, 1)
    $fgI = Stats ($pool | ForEach-Object { ($_.fgp - $lgFG) * $_.fga }); $ftI = Stats ($pool | ForEach-Object { ($_.ftp - $lgFT) * $_.fta })
    $S = @{}; foreach ($k in 'tpm','pts','reb','ast','stl','blk','to') { $S[$k] = Stats ($pool | ForEach-Object { $_.$k }) }
    foreach ($p in $pl) {
      $v = ((($p.fgp - $lgFG) * $p.fga - $fgI[0]) / $fgI[1]) + ((($p.ftp - $lgFT) * $p.fta - $ftI[0]) / $ftI[1])
      foreach ($k in 'tpm','pts','reb','ast','stl','blk') { $v += ($p.$k - $S[$k][0]) / $S[$k][1] }
      $v -= ($p.to - $S.to[0]) / $S.to[1]
      $p | Add-Member -Force cat $v
    }
    $pool = @($pl | Sort-Object cat -Descending | Select-Object -First 200)
  }
  foreach ($key in 'cat', 'yahoo', 'espn') {
    $i = 0
    foreach ($p in ($pl | Sort-Object $key -Descending)) {
      $i++; if ($i -gt 400) { break }
      if (-not $ranks.ContainsKey($p.id)) { $ranks[$p.id] = @{ cat = @($null) * $weeks.Count; yahoo = @($null) * $weeks.Count; espn = @($null) * $weeks.Count } }
      $ranks[$p.id][$key][$w] = $i
    }
  }
}

# ---------- 2b. season-to-date totals through last night (daily Real / Blend ranks) ----------
$latest = @{}; $latInfo = @{}
foreach ($r in $sorted) {
  if (-not $latest.ContainsKey($r.id)) { $latest[$r.id] = New-Object 'double[]' 13 }
  $acc = $latest[$r.id]; $acc[0]++; for ($j = 0; $j -lt $FIELDS.Count; $j++) { $acc[$j + 1] += [double]$r.($FIELDS[$j]) }
  $latInfo[$r.id] = @{ n = $r.name; t = $r.team; pos = $(if ($r.pos) { $r.pos } elseif ($latInfo[$r.id]) { $latInfo[$r.id].pos } else { $null }) }
}

# ---------- 3. game logs (one small file per player; the card loads it when the Games Log tab opens) ----------
$glDir = Join-Path $dataDir "gamelogs"; if (-not (Test-Path $glDir)) { New-Item -ItemType Directory $glDir | Out-Null }
$num = { param($v) $x = 0.0; if ([double]::TryParse([string]$v, [Globalization.NumberStyles]::Float, $inv, [ref]$x)) { $x } else { 0 } }
foreach ($grp in ($sorted | Group-Object id)) {
  $games = @(foreach ($r in ($grp.Group | Sort-Object date, game)) {
    # [date, opp, home(1)/away(0), team score, opp score, min, pts, reb, ast, stl, blk, 3pm, fgm, fga, ftm, fta, to]
    ,@($r.date, [string]$r.opp, $(if ($r.ha -eq "home") { 1 } else { 0 }), (& $num $r.tsc), (& $num $r.osc), [math]::Round((& $num $r.min), 0),
      (& $num $r.pts), (& $num $r.reb), (& $num $r.ast), (& $num $r.stl), (& $num $r.blk), (& $num $r.tpm), (& $num $r.fgm), (& $num $r.fga), (& $num $r.ftm), (& $num $r.fta), (& $num $r.to))
  })
  $last1 = $grp.Group[-1]
  $doc = [ordered]@{ n = $last1.name; t = $last1.team; updated = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", $inv); g = $games }
  [IO.File]::WriteAllText((Join-Path $glDir "$($grp.Name).json"), ($doc | ConvertTo-Json -Depth 5 -Compress), (New-Object Text.UTF8Encoding $false))
}
"game logs: $(@($sorted | Group-Object id).Count) players"

# ---------- 4. history.json ----------
$out = [ordered]@{ updated = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ', $inv); seasonStart = $SeasonStart; basis = 'season-to-date per-game value'; weeks = @($weeks); ranks = [ordered]@{} }
foreach ($id in ($ranks.Keys | Sort-Object)) { $out.ranks[$id] = [ordered]@{ n = $names[$id]; cat = @($ranks[$id].cat); yahoo = @($ranks[$id].yahoo); espn = @($ranks[$id].espn) } }
$out.stats = [ordered]@{}
foreach ($id in ($wk.Keys | Sort-Object)) {
  $out.stats[$id] = [ordered]@{ n = $names[$id]; t = $teamOf[$id]; pos = $posOf[$id]; w = @(foreach ($a in $wk[$id]) { if ($null -eq $a) { 0 } else { ,@($a | ForEach-Object { [math]::Round($_, 1) }) } }) }
}
$lp = [ordered]@{}
foreach ($id in ($latest.Keys | Sort-Object)) { $lp[$id] = [ordered]@{ n = $latInfo[$id].n; t = $latInfo[$id].t; pos = $latInfo[$id].pos; s = @($latest[$id] | ForEach-Object { [math]::Round($_, 1) }) } }
$out.latest = [ordered]@{ through = $last.ToString('yyyy-MM-dd', $inv); games = $haveGame.Count; p = $lp }
$json = $out | ConvertTo-Json -Depth 6 -Compress
[IO.File]::WriteAllText((Join-Path $Root 'history.json'), $json, (New-Object Text.UTF8Encoding $false))
"history: $($weeks.Count) completed weeks, $($out.ranks.Count) players ranked; season-to-date through $($out.latest.through) for $($lp.Count) players"

# ---------- 5. schedule.json (full regular season; refreshed weekly so NBA Cup knockout games and reschedules appear) ----------
try {
  $tz = try { [TimeZoneInfo]::FindSystemTimeZoneById('America/New_York') } catch { [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time') }
  $season = $start.Year + 1; $sched = @{}
  foreach ($tid in 1..30) {
    $ts = Invoke-RestMethod -Headers $headers -Uri "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/$tid/schedule?season=$season&seasontype=2" -TimeoutSec 60
    foreach ($ev in @($ts.events)) {
      if ($sched.ContainsKey([string]$ev.id)) { continue }
      $c = $ev.competitions[0]
      $hm = ($c.competitors | Where-Object { $_.homeAway -eq 'home' }).team.abbreviation; $aw = ($c.competitors | Where-Object { $_.homeAway -eq 'away' }).team.abbreviation
      if (-not $hm -or -not $aw) { continue }
      $utc = [datetime]::Parse($ev.date, $inv, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
      $sched[[string]$ev.id] = [ordered]@{ d = [TimeZoneInfo]::ConvertTimeFromUtc($utc, $tz).ToString('yyyy-MM-dd', $inv); h = $hm; a = $aw }
    }
    Start-Sleep -Milliseconds 250
  }
  if ($sched.Count -ge 1000) {
    $sl = @($sched.Values | Sort-Object { $_.d }, { $_.h })
    [IO.File]::WriteAllText((Join-Path $Root 'schedule.json'), ($sl | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    "schedule: $($sl.Count) games"
  } else { Write-Warning "schedule looked incomplete ($($sched.Count) games); kept the previous file" }
} catch { Write-Warning "schedule refresh failed: $($_.Exception.Message)" }

if ($failures.Count) {
  foreach ($x in $failures) { Write-Host "::warning::ESPN fetch failed: $x (it will be retried on the next run)" }
  "fetch failures: $($failures.Count)"
}
