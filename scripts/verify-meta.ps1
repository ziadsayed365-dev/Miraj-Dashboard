# ============================================================
#  Checks the Meta credentials in .env.local against the real
#  Graph API, before wiring up any sync.
#
#    powershell -ExecutionPolicy Bypass -File scripts\verify-meta.ps1
#
#  Verifies the token can see EVERY configured ad account
#  (retail + wholesale) and can read insights from each.
#
#  Read-only: fetches account metadata and one day of spend.
#  Nothing is written to Meta or to the database.
# ============================================================
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Must match META_API_VERSION in src/lib/meta.ts.
$apiVersion = 'v21.0'

$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.local'
if (-not (Test-Path $envFile)) { Write-Host "No .env.local found at $envFile" -ForegroundColor Red; exit 1 }

$envMap = @{}
Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Z_0-9]+)\s*=\s*(.*)$') { $envMap[$matches[1]] = $matches[2].Trim() }
}
$token = $envMap['META_ACCESS_TOKEN']
$since = $envMap['META_SPEND_SINCE']

function Fail($m) { Write-Host "  FAIL  $m" -ForegroundColor Red }
function Pass($m) { Write-Host "  ok    $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  warn  $m" -ForegroundColor Yellow }

# Mirrors parseIds() in src/lib/meta-accounts.ts.
function Parse-Ids($raw) {
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    return @($raw.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } |
             ForEach-Object { if ($_.StartsWith('act_')) { $_.Substring(4) } else { $_ } })
}

Write-Host "`nMeta credentials check ($apiVersion)`n"

$retail    = Parse-Ids $envMap['META_RETAIL_AD_ACCOUNT_IDS']
$wholesale = Parse-Ids $envMap['META_WHOLESALE_AD_ACCOUNT_IDS']

$accounts = @()
foreach ($id in $retail)    { $accounts += [pscustomobject]@{ Id = $id; Segment = 'retail' } }
foreach ($id in $wholesale) { $accounts += [pscustomobject]@{ Id = $id; Segment = 'wholesale' } }

# --- config checks, before spending a request -----------------
$stop = $false
if ([string]::IsNullOrWhiteSpace($token)) { Fail 'META_ACCESS_TOKEN is empty'; $stop = $true }
elseif ($token -eq 'TODO') { Fail 'META_ACCESS_TOKEN is still the literal "TODO"'; $stop = $true }
else { Pass "META_ACCESS_TOKEN present ($($token.Length) chars)" }

if ($accounts.Count -eq 0) {
    Fail 'No ad accounts set (META_RETAIL_AD_ACCOUNT_IDS / META_WHOLESALE_AD_ACCOUNT_IDS)'
    $stop = $true
} else {
    Pass "$($retail.Count) retail + $($wholesale.Count) wholesale account(s) configured"
}

$bad = @($accounts | Where-Object { $_.Id -notmatch '^\d+$' })
foreach ($b in $bad) { Fail "ad account id is not numeric: '$($b.Id)'"; $stop = $true }

$overlap = @($retail | Where-Object { $wholesale -contains $_ })
foreach ($o in $overlap) { Fail "account $o is listed as BOTH retail and wholesale"; $stop = $true }

$dupes = @($accounts.Id | Group-Object | Where-Object { $_.Count -gt 1 })
foreach ($d in $dupes) { Fail "account $($d.Name) is listed twice"; $stop = $true }

if ($stop) { Write-Host "`nFix the above in .env.local, then re-run.`n"; exit 1 }

function Invoke-Graph($url) {
    try { return Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 30 }
    catch {
        $resp = $_.Exception.Response
        if ($resp) {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $raw = $reader.ReadToEnd()
            $j = $null
            try { $j = $raw | ConvertFrom-Json } catch { }
            if ($j -and $j.error) { throw "$($j.error.type) ($($j.error.code)): $($j.error.message)" }
            throw $raw
        }
        throw $_.Exception.Message
    }
}

$base = "https://graph.facebook.com/$apiVersion"
$day = (Get-Date).AddDays(-1).ToString('yyyy-MM-dd')
$failed = 0

foreach ($a in $accounts) {
    Write-Host "`n--- act_$($a.Id)  [$($a.Segment)] ---"

    try {
        $info = Invoke-Graph "$base/act_$($a.Id)?fields=name,account_status,currency,timezone_name&access_token=$token"
        Pass "name: $($info.name)"
        if ($info.account_status -ne 1) { Warn "account_status = $($info.account_status) (1 = ACTIVE)" }

        # src/lib/sync/meta-spend.ts hardcodes currency 'EGP' on every ad_spend row,
        # so a non-EGP account would be stored under the wrong currency.
        if ($info.currency -ne 'EGP') {
            Warn "currency is $($info.currency), but the sync writes ad_spend.currency = 'EGP'"
            Warn "  -> fix src/lib/sync/meta-spend.ts before the first sync"
        } else { Pass 'currency: EGP' }
        if ($info.timezone_name -notlike '*Cairo*') {
            Warn "timezone is $($info.timezone_name); spend days are bucketed in the account's timezone"
        }
    } catch {
        Fail "cannot read the account: $_"
        $failed++
        continue
    }

    try {
        $range = (@{ since = $day; until = $day } | ConvertTo-Json -Compress)
        $q = "level=campaign&fields=campaign_id,campaign_name,spend&time_increment=1&limit=100"
        $ins = Invoke-Graph "$base/act_$($a.Id)/insights?$q&time_range=$([uri]::EscapeDataString($range))&access_token=$token"
        $rows = @($ins.data)
        Pass "insights readable - $($rows.Count) campaign row(s) for $day"
        foreach ($r in $rows | Select-Object -First 3) {
            Write-Host ("        {0,-12} {1}" -f $r.spend, $r.campaign_name)
        }
        if ($rows.Count -eq 0) { Warn "no spend on $day - not an error, but try a day you know had spend" }
    } catch {
        Fail "insights call failed: $_  (token most likely lacks ads_read on this account)"
        $failed++
    }
}

Write-Host ''
if ($failed -gt 0) {
    Write-Host "$failed account check(s) failed." -ForegroundColor Red
    Write-Host "Usual causes: the System User has no role on that ad account, ads_read"
    Write-Host "is missing, or the account belongs to a different Business Manager.`n"
    exit 1
}

if ($since) { Write-Host "  note  first sync backfills every account from META_SPEND_SINCE=$since" }
Write-Host "`nAll $($accounts.Count) Meta account(s) verified.`n" -ForegroundColor Green
