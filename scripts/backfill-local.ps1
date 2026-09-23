# Start the dev server, wait for it, run the backfill, stop the server.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backfill-local.ps1
#
# One command instead of two, because the backfill is long and gets restarted a
# lot. Every step checkpoints its cursor, so re-running always resumes rather
# than starting over - it is safe to kill this at any point and run it again.
$ErrorActionPreference = 'Stop'

# Node is installed outside the usual location on this machine and is not on PATH.
$nodeDir = 'D:\Visual SC'
if (Test-Path "$nodeDir\node.exe") { $env:Path = "$nodeDir;$env:Path" }

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$log = Join-Path $env:TEMP "miraj-dev-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
Write-Host "starting dev server (log: $log)"
$dev = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "npm run dev > `"$log`" 2>&1" -PassThru -WindowStyle Hidden

try {
    $port = $null
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 1
        if (-not (Test-Path $log)) { continue }
        $text = Get-Content $log -Raw -ErrorAction SilentlyContinue
        if ($text -match 'localhost:(\d+)') { $port = $matches[1] }
        if ($text -match 'Ready in' -and $port) { break }
    }
    if (-not $port) { throw "dev server never reported a port; see $log" }
    Write-Host "dev server ready on port $port`n"

    node scripts/backfill.mjs --base "http://localhost:$port"
    $code = $LASTEXITCODE
} finally {
    Write-Host "`nstopping dev server..."
    # The npm/next processes are children of the cmd wrapper, so kill the tree.
    try { taskkill /PID $dev.Id /T /F | Out-Null } catch { }
}

exit $code
