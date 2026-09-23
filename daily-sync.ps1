# ============================================================
#  Miraj daily sync — runs the same pipeline as the in-app
#  "Sync" button: Shopify orders+delivery, products, Meta spend,
#  then the engine (calibration, rates, margins).
#
#  Requires the app to be running at http://localhost:3000
#  (i.e. `npm run dev` — or a deployed URL if you change $base).
#  Registered to run daily by setup-daily-sync-task.ps1.
# ============================================================
$ErrorActionPreference = 'Stop'
$base = 'http://localhost:3000'
$root = $PSScriptRoot
$log  = Join-Path $root 'daily-sync.log'

function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $line
  Write-Host $line
}

# --- read owner credentials from .env.local ---
$envMap = @{}
Get-Content (Join-Path $root '.env.local') | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') { $envMap[$matches[1]] = $matches[2].Trim() }
}
$user = $envMap['OWNER_USERNAME']; $pass = $envMap['OWNER_PASSWORD']

Log 'Daily sync starting...'

# --- confirm the app is up ---
try { Invoke-WebRequest "$base/login" -UseBasicParsing -TimeoutSec 15 | Out-Null }
catch { Log "App not reachable at $base (is it running?). Aborting."; exit 1 }

# --- log in (owner) ---
try {
  Invoke-WebRequest "$base/api/login" -Method Post -Body "username=$user&password=$pass" `
    -ContentType 'application/x-www-form-urlencoded' -SessionVariable sess -UseBasicParsing | Out-Null
} catch { Log "Login failed: $($_.Exception.Message)"; exit 1 }

function Invoke-Step($step) {
  Invoke-RestMethod "$base/api/sync/run?step=$step" -Method Post -WebSession $sess -TimeoutSec 120
}

# Orders + Meta are resumable (cursor) — loop until they report reachedEnd.
function Invoke-StepUntilEnd($step, $max) {
  for ($i = 1; $i -le $max; $i++) {
    $r = Invoke-Step $step
    if (-not $r.ok) { Log "$step FAILED: $($r.error)"; return $false }
    Log ("$step pass $i -> " + ($r | ConvertTo-Json -Compress))
    if ($r.reachedEnd -eq $true) { return $true }
  }
  return $true
}

$okAll = $true
if (-not (Invoke-StepUntilEnd 'shopify' 20)) { $okAll = $false }
$r = Invoke-Step 'shopify-products'; Log ("shopify-products -> " + ($r | ConvertTo-Json -Compress))
if (-not (Invoke-StepUntilEnd 'meta' 20)) { $okAll = $false }
foreach ($s in 'calibrate','monthly-rate','sku-monthly-rate','margins') {
  $r = Invoke-Step $s
  if (-not $r.ok) { $okAll = $false; Log "$s FAILED: $($r.error)" } else { Log ("$s -> " + ($r | ConvertTo-Json -Compress)) }
}

if ($okAll) { Log 'Daily sync DONE (all steps ok).' } else { Log 'Daily sync finished WITH ERRORS (see above).' }
