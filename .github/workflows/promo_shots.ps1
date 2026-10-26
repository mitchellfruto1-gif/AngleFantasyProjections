# Promo images for the morning emails (run by .github/workflows/promo-emails.yml).
# Opens the site in headless Chrome with the access code from the ANGLE_CODE secret, renders each promo card
# (index.html?promo=...), saves it as a 2160x2700 PNG and writes the email body with ready-to-post text.
# Daily: top 10 of the night (9-cat, points). Weekly: top 25 of the week (9-cat, points) and the Angle Market's movers.
param(
  [ValidateSet("daily", "weekly")][string]$Mode = "daily",
  [string]$Base = "http://127.0.0.1:8000",
  [string]$OutDir = "promo-out",
  [string]$Site = "",
  [string]$Browser = "",
  [int]$Port = 9333
)
$ErrorActionPreference = "Stop"
$code = $env:ANGLE_CODE
if (-not $code) { throw "The ANGLE_CODE secret is not set." }
$kinds = if ($Mode -eq "weekly") { @("week-cat", "week-pts", "week-mkt") } else { @("day-cat", "day-pts") }
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
  $url = "$Base/index.html?promo=$k" + $(if ($Site) { "&site=" + [Uri]::EscapeDataString($Site) } else { "" })
  [void](SendRaw "Page.navigate" @{ url = $url })
  $txt = ""; for ($i = 0; $i -lt 120 -and -not $txt; $i++) { Start-Sleep -Milliseconds 500; $txt = Eval "(document.getElementById('promo-ready')||{}).textContent||''" }
  if (-not $txt) { $results += [pscustomobject]@{ kind = $k; error = "timed out" }; continue }
  $r = $txt | ConvertFrom-Json
  if ($r.error) { $results += $r; Write-Host "$($k): $($r.error)"; continue }
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
$label = @{ "day-cat" = "Top 10 of the night - 9-Cat"; "day-pts" = "Top 10 of the night - Points"; "week-cat" = "Top 25 of the week - 9-Cat"; "week-pts" = "Top 25 of the week - Points"; "week-mkt" = "Angle Market - the week's gainers and losers" }
$range = if ($ok.Count) { $ok[0].range } else { "" }
$subject = if ($Mode -eq "weekly") { "Angle weekly promo: top 25 + Market movers ($range)" } else { "Angle daily promo: top 10 performers ($range)" }
$html = New-Object Text.StringBuilder
[void]$html.Append("<div style=`"font-family:Arial,sans-serif;max-width:640px;color:#1E0F24`"><h2 style=`"color:#7D1D98;margin:0 0 6px`">$(& $enc $subject)</h2><p style=`"color:#6E5A72;margin:0 0 18px`">The images are attached. Each one has suggested post text below; swap in your links before posting.</p>")
foreach ($r in $results) {
  [void]$html.Append("<h3 style=`"margin:22px 0 6px`">$(& $enc $label[$r.kind])</h3>")
  if ($r.error) { [void]$html.Append("<p style=`"color:#C41E3A`">Not made: $(& $enc $r.error)</p>"); continue }
  [void]$html.Append("<p style=`"margin:0 0 6px;color:#6E5A72;font-size:13px`">Image: $(& $enc $r.file)</p><pre style=`"white-space:pre-wrap;font-family:Arial,sans-serif;font-size:15px;background:#F7EEE3;border:1px solid #E3D3C2;border-radius:8px;padding:12px`">$(& $enc $r.caption)</pre>")
}
[void]$html.Append("<p style=`"color:#6E5A72;font-size:12px;margin-top:24px`">Sent by the Promo emails workflow. Real game data from the site's morning update.</p></div>")
[IO.File]::WriteAllText((Join-Path (Resolve-Path $OutDir) "email.html"), $html.ToString(), (New-Object Text.UTF8Encoding $false))
# a day with no new games (or a missed data update) sends nothing rather than repeating yesterday
$last = if ($ok.Count) { $ok[0].last } else { "" }
$fresh = $last -and ([datetime]::ParseExact($last, "yyyy-MM-dd", $null) -ge [datetime]::UtcNow.Date.AddDays(-2))
$send = $ok.Count -gt 0 -and ($Mode -eq "weekly" -or $fresh)
Write-Host "subject: $subject | images: $($ok.Count) | latest game day: $last | send: $send"
if ($env:GITHUB_OUTPUT) { Add-Content $env:GITHUB_OUTPUT "subject=$subject"; Add-Content $env:GITHUB_OUTPUT "send=$($send.ToString().ToLower())" }
if (-not $ok.Count) { exit 1 }
