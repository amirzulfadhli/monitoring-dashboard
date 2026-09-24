<#
.SYNOPSIS
  Install, inspect or remove DevPulse auto-start for the current Windows user.

.DESCRIPTION
  Registers one Task Scheduler task ("DevPulse" by default) that runs the
  runtime launcher at logon, so DevPulse comes back after a reboot without
  anyone remembering to start it.

  Properties that matter:

    - At logon, in the current user's interactive session. DevPulse desktop
      notifications (Task 27) need an interactive session, so this is never a
      SYSTEM / service / background-session task.
    - RunLevel Limited: the task runs unelevated. Creating it normally needs no
      administrator rights; if the machine's policy refuses, the script says so
      and asks for an elevated shell.
    - WorkingDirectory is the project root, so the SQLite path the app resolves
      is the same one a manual `npm run runtime` uses.
    - The task argument line contains a script path and switch names only.
      No environment variable, no token, no API key is ever placed in it; the
      launcher inherits the user's environment and Next.js reads .env.local.
    - Installing is always an explicit action. Nothing in `npm install`, the
      build, or application startup registers a task.

.EXAMPLE
  npm run autostart:install
  npm run autostart:status
  npm run autostart:remove

.EXAMPLE
  # Show exactly what would be registered, without registering it.
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\devpulse-autostart.ps1 -Action Install -DryRun
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Status', 'Remove')]
  [string]$Action,

  [string]$TaskName = 'DevPulse',

  # Print the registration that would be performed (or the action that would be
  # taken) and change nothing.
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot 'devpulse-runtime.ps1'

# The launcher runs detached: a scheduled task has no console, and the launcher
# redirects server output to .devpulse\logs in that mode.
$LauncherArguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Detached' -f $Launcher

function Get-TaskPrincipalName {
  if ($env:USERDOMAIN -and $env:USERNAME) { return "$env:USERDOMAIN\$env:USERNAME" }
  return $env:USERNAME
}

function Assert-TaskSupport {
  if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
    throw 'the ScheduledTasks PowerShell module is unavailable; DevPulse auto-start needs Windows Task Scheduler'
  }
  if (-not (Test-Path $Launcher)) {
    throw "launcher not found: $Launcher"
  }
  if ($Launcher.Contains('"')) {
    # A quote in the path cannot be expressed in a task action argument.
    throw "the project path contains a double quote and cannot be registered: $Launcher"
  }
}

function Get-TaskSpec {
  return [pscustomobject]@{
    TaskName         = $TaskName
    Execute          = 'powershell.exe'
    Arguments        = $LauncherArguments
    WorkingDirectory = $ProjectRoot
    UserId           = Get-TaskPrincipalName
    Trigger          = 'AtLogOn'
    RunLevel         = 'Limited'
    LogonType        = 'Interactive'
  }
}

function Show-TaskSpec {
  param($Spec)
  Write-Host 'task registration:'
  Write-Host ('  name         : {0}' -f $Spec.TaskName)
  Write-Host ('  execute      : {0}' -f $Spec.Execute)
  Write-Host ('  arguments    : {0}' -f $Spec.Arguments)
  Write-Host ('  working dir  : {0}' -f $Spec.WorkingDirectory)
  Write-Host ('  user         : {0}' -f $Spec.UserId)
  Write-Host ('  trigger      : {0}' -f $Spec.Trigger)
  Write-Host ('  run level    : {0}' -f $Spec.RunLevel)
  Write-Host ('  logon type   : {0}' -f $Spec.LogonType)
}

function Invoke-Install {
  Assert-TaskSupport
  $spec = Get-TaskSpec

  if ($DryRun) {
    Write-Host 'dry run - nothing is registered'
    Show-TaskSpec -Spec $spec
    return 0
  }

  $action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Arguments -WorkingDirectory $spec.WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $spec.UserId
  $principal = New-ScheduledTaskPrincipal -UserId $spec.UserId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

  try {
    Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force | Out-Null
  } catch {
    Write-Host ('failed to register the task: {0}' -f $_.Exception.Message)
    Write-Host 'if this is an access-denied error, re-run this command from an elevated PowerShell.'
    return 1
  }

  Write-Host ('installed: task ''{0}'' will start DevPulse at logon for {1}.' -f $spec.TaskName, $spec.UserId)
  Write-Host 'start it now, without logging off, with: npm run runtime'
  return 0
}

function Invoke-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host ('DevPulse auto-start is NOT installed (no task named ''{0}'').' -f $TaskName)
    return 1
  }

  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host ('DevPulse auto-start is installed: ''{0}'' [{1}]' -f $TaskName, $task.State)
  foreach ($a in $task.Actions) {
    Write-Host ('  execute      : {0}' -f $a.Execute)
    Write-Host ('  arguments    : {0}' -f $a.Arguments)
    Write-Host ('  working dir  : {0}' -f $a.WorkingDirectory)
  }
  if ($task.Principal) {
    Write-Host ('  user         : {0} ({1}, {2})' -f $task.Principal.UserId, $task.Principal.LogonType, $task.Principal.RunLevel)
  }
  if ($info) {
    Write-Host ('  last run     : {0}' -f $info.LastRunTime)
    Write-Host ('  last result  : {0}' -f $info.LastTaskResult)
    Write-Host ('  next run     : {0}' -f $info.NextRunTime)
  }
  return 0
}

function Invoke-Remove {
  if ($DryRun) {
    Write-Host ('dry run - would remove the scheduled task ''{0}''' -f $TaskName)
    return 0
  }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) {
    Write-Host ('nothing to remove: no task named ''{0}''.' -f $TaskName)
    return 0
  }

  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host ('removed: task ''{0}''.' -f $TaskName)
  Write-Host 'a running DevPulse process is not stopped by this; use: npm run runtime:stop'
  return 0
}

# --------------------------------------------------------------------------

try {
  if (-not $DryRun) {
    if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
      throw "no package.json next to scripts\; expected the DevPulse project at $ProjectRoot"
    }
    if ($Action -ne 'Status' -and -not $TaskName.Trim()) {
      throw 'a non-empty task name is required'
    }
  }

  switch ($Action) {
    'Install' { exit (Invoke-Install) }
    'Status' { exit (Invoke-Status) }
    'Remove' { exit (Invoke-Remove) }
  }
} catch {
  [Console]::Error.WriteLine("DevPulse auto-start: $($_.Exception.Message)")
  exit 1
}
