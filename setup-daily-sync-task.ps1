# ============================================================
#  Registers a Windows Scheduled Task that runs daily-sync.ps1
#  every morning at 6:00 AM. Re-run this to update the schedule.
#  (The app must be running at localhost:3000 when it fires.)
# ============================================================
$taskName = 'Miraj Daily Sync'
$script   = Join-Path $PSScriptRoot 'daily-sync.ps1'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $script)
$trigger = New-ScheduledTaskTrigger -Daily -At 6:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Runs the Miraj dashboard daily data sync (Shopify + Meta + engine).' -Force | Out-Null

Write-Host "Registered scheduled task '$taskName' - runs daily at 6:00 AM."
