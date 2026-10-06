$ErrorActionPreference = 'Stop'
$name = 'Farhan-APIWILD-Autonomous-Maintenance'
$homePath = 'C:\Users\farha\.claude\it-team\apiwild-autonomy'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$jobPath = Join-Path $homePath 'job.mjs'
if (-not (Test-Path -LiteralPath $jobPath) -or -not (Test-Path -LiteralPath (Join-Path $homePath 'config.json'))) { throw 'Reviewed controller and config must exist first.' }
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing) { Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $homePath 'previous-task.xml') -Encoding UTF8 }
$action = New-ScheduledTaskAction -Execute $nodePath -Argument ('"' + $jobPath + '"') -WorkingDirectory $homePath
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'API WILD: quiet5min site checks/hourly repo+CI; confirmed failures native Paperclip repair+independent review+GitHub CI+deployment verification.' -Force | Out-Null
Start-ScheduledTask -TaskName $name
$task = Get-ScheduledTask -TaskName $name
[pscustomobject]@{ Name=$task.TaskName; State=$task.State.ToString(); Interval=$task.Triggers[0].Repetition.Interval; Execute=$task.Actions[0].Execute; Arguments=$task.Actions[0].Arguments; MultipleInstances=$task.Settings.MultipleInstances.ToString(); AwakeHostRequired=$true } | ConvertTo-Json -Compress
