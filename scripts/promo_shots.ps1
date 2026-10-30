# Promo images for the morning emails (run by .github/workflows/promo-emails.yml).
# Opens the site in headless Chrome with the access code from the ANGLE_CODE secret, renders each promo card
# (index.html?promo=...), saves it as a 2160x2700 PNG and writes the email body with ready-to-post text.
# Daily: top 10 of the night (9-cat, points), the Angle Market's buy lows and sell highs (with each player's Market card),
# and on Wed/Thu that day's Monday-changelog post. Weekly (Monday): saves the encrypted Monday snapshot
# (data/monday/YYYY-MM-DD.json, committed by the workflow), then the Monday thread and images, plus the weekly top 25 and Market movers.
# Snapshot: only saves the snapshot (run once to start the week-to-week diff). Nothing is posted anywhere.
param(
  [ValidateSet("daily", "weekly", "snapshot")][string]$Mode = "daily",
  [string]$Base = "http://127.0.0.1:8000",
  [string]$OutDir = "promo-out",
  [string]$Site = "",
  [string]$Browser = "",
  [int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$code = $env:ANGLE_CODE
if (-not $code) { throw "The ANGLE_CODE secret is not set." }
$pt = $null; foreach ($tz in "America/Los_Angeles", "Pacific Standard Time") { if (-not $pt) { try { $pt = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([datetime]::UtcNow, $tz) } catch {} } }
$midweek = @{ Wednesday = "monday-wed"; Thursday = "monday-thu" }[$pt.DayOfWeek.ToString()]
$kinds = switch ($Mode) { "weekly" { @("monday-snap", "monday", "week-cat", "week-pts", "week-mkt") } "snapshot" { @("monday-snap") } default { @("day-cat", "day-pts", "mkt-picks") + @($midweek | Where-Object { $_ }) } }
$extra = $(if ($env:MONDAY_SAFE -eq "true") { "&safe=1" } else { "" })
if (-not $Browser) { foreach ($c in "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium", "C:\Program Files\Google\Chrome\Application\chrome.exe", "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe") { if (Test-Path $c) { $Browser = $c; break } } }
if (-not $Browser) { throw "No Chrome or Edge found." }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$prof = Join-Path ([IO.Path]::GetTempPath()) "angle-promo-$Port"; Remove-Item -Recurse -Force $prof -ErrorAction SilentlyContinue
$proc = Start-Process $Browser -ArgumentList "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--user-data-dir=$prof", "--remote-debugging-port=$Port", "--window-size=1080,1350", "about:blank" -PassThru
$tgt = $null; for ($i = 0; $i -lt 60 -and -not $tgt; $i++) { Start-Sleep -Milliseconds 300; try { $tgt = (Invoke-RestMethod "http://127.0.0.1:$Port/json") | Where-Object { $_.type -eq "page" } | Select-Object -First 1 } catch {} }
if (-not $tgt) { throw "The browser did not start." }
$ws = New-Object Net.WebSockets.ClientWebSocket; $ct = [Threading.CancellationToken]::None; $ws.ConnectAsync([Uri]$tgt.webSocketDebuggerUrl, $ct).Wait()
$script:id = 0
# returns the raw JSON reply (screenshots are too big for ConvertFrom-Json in Windows PowerShell)
function SendRaw($method, $params) {
  $script:id++; $msg = @{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
  $b = [Text.Encoding]::UTF8.GetBytes($msg); $ws.SendAsync([ArraySegment[byte]]$b, "Text", $true, $ct).Wait()
  $buf = New-Object byte[] 1048576
  while ($true) { $sb = New-Object Text.StringBuilder; do { $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, $ct).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)) } while (-not $r.EndOfMessage)
    $s = $sb.ToString(); if ($s.StartsWith("{`"id`":$($script:id),")) { return $s } }
}
function Eval($js) { ((SendRaw "Runtime.evaluate" @{ expression = $js; returnByValue = $true }) | ConvertFrom-Json).result.result.value }
[void](SendRaw "Emulation.setDeviceMetricsOverride" @{ width = 1080; height = 1350; deviceScaleFactor = 2; mobile = $false })
[void](SendRaw "Emulation.setTimezoneOverride" @{ timezoneId = "America/Los_Angeles" })
# store the access code the same way the site's unlock form does
[void](SendRaw "Page.navigate" @{ url = "$Base/index.html" }); Start-Sleep 3
$codeJs = ($code.Trim().ToUpper() | ConvertTo-Json)
[void](Eval "localStorage.setItem('angle-access-code', $codeJs); localStorage.setItem('angle-a2hs-dismissed', '1'); 1")
$results = @()
foreach ($k in $kinds) {
  $url = "$Base/index.html?promo=$k$extra" + $(if ($Site) { "&site=" + [Uri]::EscapeDataString($Site) } else { "" })
  [void](SendRaw "Page.navigate" @{ url = $url })
  $txt = ""; for ($i = 0; $i -lt 120 -and -not $txt; $i++) { Start-Sleep -Milliseconds 500; $txt = Eval "(document.getElementById('promo-ready')||{}).textContent||''" }
  if (-not $txt) { $results += [pscustomobject]@{ kind = $k; error = "timed out" }; continue }
  $r = $txt | ConvertFrom-Json
  if ($r.error) { $results += $r; Write-Host "$($k): $($r.error)"; continue }
  # the Monday snapshot: saved into the checkout (the workflow commits it); the Monday thread right after reads it from the local server
  if ($r.snapshot) {
    $dir = "data/monday"; New-Item -ItemType Directory -Force $dir | Out-Null
    [IO.File]::WriteAllText((Join-Path (Resolve-Path $dir) "$($r.last).json"), ($r.snapshot | ConvertTo-Json -Compress -Depth 4), (New-Object Text.UTF8Encoding $false))
    $idx = Join-Path (Resolve-Path $dir) "index.json"; $dates = @(); if (Test-Path $idx) { $dates = @((Get-Content $idx -Raw | ConvertFrom-Json).dates) }
    $dates = @($dates + $r.last | Where-Object { $_ } | Sort-Object -Unique)
    [IO.File]::WriteAllText($idx, (@{ dates = $dates } | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    $r | Add-Member file "data/monday/$($r.last).json"; $results += $r; Write-Host "$($k): snapshot $($r.last) ($($r.players) players)"; continue
  }
  # kinds that draw their own PNGs (Monday images, Market cards): read them one at a time
  if ($r.files) {
    $fl = @($r.files); for ($i = 0; $i -lt $fl.Count; $i++) {
      $raw = SendRaw "Runtime.evaluate" @{ expression = "window.__promoImgs[$i].data"; returnByValue = $true }
      $i0 = $raw.IndexOf('"value":"') + 9; $data = $raw.Substring($i0, $raw.IndexOf('"', $i0) - $i0)
      [IO.File]::WriteAllBytes((Join-Path (Resolve-Path $OutDir) $fl[$i]), [Convert]::FromBase64String($data))
    }
    $results += $r; Write-Host "$($k): $($fl -join ', ')"; continue
  }
  Start-Sleep -Milliseconds 600
  $s = SendRaw "Page.captureScreenshot" @{ format = "png"; clip = @{ x = 0; y = 0; width = 1080; height = 1350; scale = 1 } }
  $i0 = $s.IndexOf('"data":"') + 8; $data = $s.Substring($i0, $s.IndexOf('"', $i0) - $i0)
  $file = "angle-$k-$($r.last).png"
  [IO.File]::WriteAllBytes((Join-Path (Resolve-Path $OutDir) $file), [Convert]::FromBase64String($data))
  $r | Add-Member file $file; $results += $r; Write-Host "$($k): $file"
}
$ws.Dispose(); Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue

$ok = @($results | Where-Object { -not $_.error })
$enc = { param($s) [Net.WebUtility]::HtmlEncode($s) }
$label = @{ "monday-snap" = "Monday snapshot saved"; "monday" = "ANGLE MONDAY UPDATE - the thread (post in order, images attached)"; "monday-wed" = "Wednesday post - punt impact (injured players left out)"; "monday-thu" = "Thursday post - what didn't change"; "mkt-picks" = "Angle Market - buy lows and sell highs (one card per pick)"; "day-cat" = "Top 10 of the night - 9-Cat"; "day-pts" = "Top 10 of the night - Points"; "week-cat" = "Top 25 of the week - 9-Cat"; "week-pts" = "Top 25 of the week - Points"; "week-mkt" = "Angle Market - the week's gainers and losers" }
$range = @($ok | Where-Object { $_.range } | Select-Object -First 1 | ForEach-Object { $_.range })[0]
$subject = switch ($Mode) { "weekly" { "ANGLE MONDAY UPDATE thread + weekly promo ($range)" } "snapshot" { "Angle Monday snapshot saved" } default { "Angle daily promo: top 10, Market buy lows / sell highs$(if ($midweek) { ' + changelog post' }) ($range)" } }
$html = New-Object Text.StringBuilder
[void]$html.Append("<div style=`"font-family:Arial,sans-serif;max-width:640px;color:#1E0F24`"><h2 style=`"color:#7D1D98;margin:0 0 6px`">$(& $enc $subject)</h2><p style=`"color:#6E5A72;margin:0 0 18px`">The images are attached. Each one has suggested post text below; swap in your links before posting.</p>")
foreach ($r in $results) {
  [void]$html.Append("<h3 style=`"margin:22px 0 6px`">$(& $enc $label[$r.kind])</h3>")
  if ($r.error) { [void]$html.Append("<p style=`"color:#C41E3A`">Not made: $(& $enc $r.error)</p>"); continue }
  if ($r.snapshot) { [void]$html.Append("<p style=`"margin:0;color:#6E5A72;font-size:13px`">$(& $enc $r.file): $($r.players) players, encrypted with the access code.</p>"); continue }
  if ($r.posts) {
    if ($r.range) { [void]$html.Append("<p style=`"margin:0 0 8px;color:#6E5A72;font-size:13px`">$(& $enc $r.range)</p>") }
    foreach ($p in $r.posts) { $note = "$($p.len)/280" + $(if ($p.img) { " - attach $($p.img)" } else { "" })
      [void]$html.Append("<pre style=`"white-space:pre-wrap;font-family:Arial,sans-serif;font-size:15px;background:#F7EEE3;border:1px solid #E3D3C2;border-radius:8px;padding:12px;margin:0 0 4px`">$(& $enc $p.text)</pre><p style=`"margin:0 0 12px;color:$(if ($p.len -gt 280) { '#C41E3A' } else { '#6E5A72' });font-size:12px`">$(& $enc $note)</p>") }
    if ($r.files) { [void]$html.Append("<p style=`"margin:0 0 6px;color:#6E5A72;font-size:13px`">Images: $(& $enc ($r.files -join ', '))</p>") }
    continue
  }
  [void]$html.Append("<p style=`"margin:0 0 6px;color:#6E5A72;font-size:13px`">Image: $(& $enc $r.file)</p><pre style=`"white-space:pre-wrap;font-family:Arial,sans-serif;font-size:15px;background:#F7EEE3;border:1px solid #E3D3C2;border-radius:8px;padding:12px`">$(& $enc $r.caption)</pre>")
}
[void]$html.Append("<p style=`"color:#6E5A72;font-size:12px;margin-top:24px`">Sent by the Promo emails workflow. Real game data from the site's morning update.</p></div>")
[IO.File]::WriteAllText((Join-Path (Resolve-Path $OutDir) "email.html"), $html.ToString(), (New-Object Text.UTF8Encoding $false))
# a day with no new games (or a missed data update) sends nothing rather than repeating yesterday
$last = if ($ok.Count) { $ok[0].last } else { "" }
$fresh = $last -and ([datetime]::ParseExact($last, "yyyy-MM-dd", $null) -ge [datetime]::UtcNow.Date.AddDays(-2))
$send = $ok.Count -gt 0 -and $Mode -ne "snapshot" -and ($Mode -eq "weekly" -or $fresh)
Write-Host "subject: $subject | images: $($ok.Count) | latest game day: $last | send: $send"
if ($env:GITHUB_OUTPUT) { Add-Content $env:GITHUB_OUTPUT "subject=$subject"; Add-Content $env:GITHUB_OUTPUT "send=$($send.ToString().ToLower())" }
if (-not $ok.Count) { exit 1 }
