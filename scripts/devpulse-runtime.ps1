<#
.SYNOPSIS
  DevPulse production runtime launcher (Windows V1).

.DESCRIPTION
  Runs DevPulse as one persistent Node/Next.js process:

      npm run build     once, beforehand
      npm run start     long-lived, supervised by this script

  `next dev` is never used: development mode is not a supported persistent
  runtime. What this script is responsible for:

    - resolve the project root from this file's own location (never from the
      caller's working directory) and make it the working directory before Next
      starts, so the SQLite file really is <project>\.devpulse\telemetry.db
    - refuse to start a second instance while one is already running
    - recover automatically from a lock file left behind by a crash
    - keep a small, bounded runtime log under .devpulse\logs
    - remove its own lock on exit

  It never reads, prints or writes a secret, and never kills a process it did
  not start (see -Action Stop).

.EXAMPLE
  npm run runtime
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\devpulse-runtime.ps1 -Action Check
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\devpulse-runtime.ps1 -Action Status
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\devpulse-runtime.ps1 -Action Stop
#>
[CmdletBinding()]
param(
  [ValidateSet('Run', 'Stop', 'Status', 'Check')]
  [string]$Action = 'Run',

  # 0 = take $env:DEVPULSE_PORT, else 3000.
  [int]$Port = 0,

  # '' = take $env:DEVPULSE_HOST, else 127.0.0.1 (loopback only).
  [string]$BindAddress = '',

  # Send server output to .devpulse\logs instead of the console. The logon task
  # uses this, because a scheduled task has no console to write to.
  [switch]$Detached
)

$ErrorActionPreference = 'Stop'

# Next.js 16 requires Node 20.9+; the launcher refuses to start below that.
$MinNodeVersion = [version]'20.9.0'

# Bounded logging: one rotation, no growth without limit.
$MaxLogBytes = 5MB

# A server that dies within this window is reported as a startup failure.
$StartupGraceSeconds = 15

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $ProjectRoot '.devpulse'
$LockPath = Join-Path $DataDir 'runtime.lock'
$LogDir = Join-Path $DataDir 'logs'
$RuntimeLog = Join-Path $LogDir 'runtime.log'

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

function Write-RuntimeLog {
  param([string]$Message, [switch]$Quiet)

  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
  if (-not $Quiet) { Write-Host $line }
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    Add-Content -LiteralPath $RuntimeLog -Value $line -Encoding UTF8
  } catch {
    # Logging must never be the reason DevPulse fails to start.
  }
}

function Write-RuntimeError {
  param([string]$Message)
  Write-RuntimeLog "ERROR: $Message"
  [Console]::Error.WriteLine("DevPulse runtime: $Message")
}

# A warning is informational: it is recorded and shown, and never blocks startup.
function Write-RuntimeWarning {
  param([string]$Message)
  Write-RuntimeLog "WARNING: $Message"
  [Console]::Error.WriteLine("DevPulse runtime: WARNING: $Message")
}

function Invoke-LogRotation {
  try {
    if ((Test-Path $RuntimeLog) -and ((Get-Item $RuntimeLog).Length -gt $MaxLogBytes)) {
      Move-Item -LiteralPath $RuntimeLog -Destination "$RuntimeLog.1" -Force
    }
    foreach ($name in @('server.out.log', 'server.err.log')) {
      $p = Join-Path $LogDir $name
      if ((Test-Path $p) -and ((Get-Item $p).Length -gt $MaxLogBytes)) {
        Move-Item -LiteralPath $p -Destination "$p.1" -Force
      }
    }
  } catch {
    # Rotation is best effort.
  }
}

function Resolve-Setting {
  param([string]$Explicit, [string]$EnvName, [string]$Default)
  if ($Explicit) { return $Explicit }
  $v = [Environment]::GetEnvironmentVariable($EnvName)
  if ($v -and $v.Trim()) { return $v.Trim() }
  return $Default
}

<#
  Mirrors src/lib/db/path.ts:
    DEVPULSE_DB_PATH -> DEVPULSE_DB_DIR\telemetry.db -> <cwd>\.devpulse\telemetry.db
  Relative values therefore depend on the working directory, which is why the
  caller sets it (Set-Location $ProjectRoot) before calling this.
#>
function Resolve-DbPath {
  $file = [Environment]::GetEnvironmentVariable('DEVPULSE_DB_PATH')
  if ($file -and $file.Trim()) { return [System.IO.Path]::GetFullPath($file.Trim()) }
  $dir = [Environment]::GetEnvironmentVariable('DEVPULSE_DB_DIR')
  if ($dir -and $dir.Trim()) {
    return [System.IO.Path]::Combine([System.IO.Path]::GetFullPath($dir.Trim()), 'telemetry.db')
  }
  return [System.IO.Path]::Combine($ProjectRoot, '.devpulse', 'telemetry.db')
}

function Get-DisplayUrl {
  $hostName = $BindAddress
  if ($hostName -in @('0.0.0.0', '::', '*', '[::]')) { $hostName = '127.0.0.1' }
  return "http://${hostName}:$Port"
}

<#
  The bind address is handed to `next start -H` as a separate argument, and
  Start-Process joins an argument array into one command line without quoting
  any element. A value containing whitespace or a quote could therefore append
  flags of its own, so only an IP literal or a hostname - which is all `-H`
  documents - is accepted, and a leading '-' is refused so the value can never
  be read as an option.
#>
function Test-BindAddress {
  param([string]$Address)

  if (-not $Address) { return $false }
  if ($Address.Length -gt 253) { return $false }
  if ($Address.StartsWith('-')) { return $false }
  return [bool]($Address -match '^[A-Za-z0-9:._%\[\]-]+$')
}

<# True for the addresses that keep DevPulse on this machine only. #>
function Test-LoopbackBind {
  param([string]$Address)
  return $Address -in @('127.0.0.1', '::1', '[::1]', 'localhost')
}

function Read-Lock {
  if (-not (Test-Path $LockPath)) { return $null }
  try { return (Get-Content -LiteralPath $LockPath -Raw | ConvertFrom-Json) } catch { return $null }
}

<#
  A lock is stale when the process it names is gone, is unreadable, or is some
  unrelated program that inherited a recycled PID. A stale lock is ignored and
  removed, so a crash can never make DevPulse permanently unstartable.
#>
function Test-LockStale {
  param($Lock)

  if (-not $Lock) { return $true }
  $raw = [string]$Lock.pid
  if (-not $raw) { return $true }

  $lockPid = 0
  if (-not [int]::TryParse($raw, [ref]$lockPid)) { return $true }

  $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
  if (-not $proc) { return $true }
  if (@('node', 'npm', 'cmd', 'powershell', 'pwsh') -notcontains $proc.ProcessName) { return $true }

  return $false
}

function Write-Lock {
  param([int]$ProcessId, [string]$DatabasePath)

  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
  # The database path is recorded because the launcher cannot re-derive it later:
  # the server loads .env.local itself, so a DEVPULSE_DB_PATH / DEVPULSE_DB_DIR
  # configured there is set on the server's environment but never on this
  # script's. Resolving it once, where it is actually known, is what keeps
  # -Action Status reporting the file the running instance opened.
  [pscustomobject]@{
    pid       = $ProcessId
    startedAt = (Get-Date).ToString('o')
    port      = $Port
    host      = $BindAddress
    dbPath    = $DatabasePath
  } | ConvertTo-Json | Set-Content -LiteralPath $LockPath -Encoding UTF8
}

<# Removes the lock only when it still belongs to the pid we recorded. #>
function Remove-OwnLock {
  param([int]$ProcessId)

  $lock = Read-Lock
  if (-not $lock) { return }
  if ([string]$lock.pid -ne [string]$ProcessId) { return }
  Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
}

function Test-PortFree {
  param([string]$Address, [int]$PortNumber)

  $ip = $null
  # A hostname cannot be probed without a connection attempt; report unknown.
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$ip)) { return $null }

  try {
    $listener = New-Object System.Net.Sockets.TcpListener($ip, $PortNumber)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Get-NodeVersion {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try {
    $raw = (& $cmd.Source -v) 2>$null
    if (-not $raw) { return $null }
    return [version]($raw.Trim().TrimStart('v'))
  } catch {
    return $null
  }
}

function Get-NpmPath {
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  return $cmd.Source
}

function Get-BuildMarker {
  return (Join-Path $ProjectRoot '.next\BUILD_ID')
}

<#
  Shared preflight. Returns an object with the resolved runtime shape plus a
  list of problems; used by both -Action Check and -Action Run so the two can
  never disagree about what is required.
#>
function Invoke-Preflight {
  $problems = New-Object System.Collections.ArrayList

  $node = Get-NodeVersion
  if (-not $node) {
    [void]$problems.Add('node.exe was not found on PATH')
  } elseif ($node -lt $MinNodeVersion) {
    [void]$problems.Add("node $node is too old (Next.js 16 needs $MinNodeVersion or newer)")
  }

  $npm = Get-NpmPath
  if (-not $npm) { [void]$problems.Add('npm.cmd was not found on PATH') }

  $buildMarker = Get-BuildMarker
  if (-not (Test-Path $buildMarker)) {
    [void]$problems.Add('no production build in .next - run: npm run build')
  }

  $dbPath = Resolve-DbPath
  $dbDir = Split-Path -Parent $dbPath
  try {
    if (-not (Test-Path $dbDir)) { New-Item -ItemType Directory -Path $dbDir -Force | Out-Null }
    $probe = Join-Path $dbDir '.write-probe'
    Set-Content -LiteralPath $probe -Value 'ok' -Encoding ASCII
    Remove-Item -LiteralPath $probe -Force
  } catch {
    [void]$problems.Add("database directory is not writable: $dbDir")
  }

  $lock = Read-Lock
  $lockStale = Test-LockStale $lock
  if ($lock -and -not $lockStale) {
    [void]$problems.Add("another DevPulse instance is already running (pid $($lock.pid))")
  }

  return [pscustomobject]@{
    Node        = $node
    Npm         = $npm
    BuildMarker = $buildMarker
    DbPath      = $dbPath
    Lock        = $lock
    LockStale   = $lockStale
    Problems    = @($problems)
  }
}

function Invoke-Check {
  Set-Location $ProjectRoot

  $report = Invoke-Preflight
  $envFile = Join-Path $ProjectRoot '.env.local'
  $portFree = Test-PortFree -Address $BindAddress -PortNumber $Port

  Write-Host 'DevPulse runtime check'
  Write-Host ('  project root : {0}' -f $ProjectRoot)
  Write-Host ('  node         : {0}' -f ($(if ($report.Node) { $report.Node } else { 'not found' })))
  Write-Host ('  npm          : {0}' -f ($(if ($report.Npm) { $report.Npm } else { 'not found' })))
  Write-Host ('  build        : {0}' -f ($(if (Test-Path $report.BuildMarker) { 'present' } else { 'MISSING - run: npm run build' })))
  Write-Host ('  env file     : {0}' -f ($(if (Test-Path $envFile) { '.env.local present' } else { '.env.local absent (optional; integrations stay disabled)' })))
  Write-Host ('  database     : {0}' -f $report.DbPath)
  $exposure = $(if (Test-LoopbackBind -Address $BindAddress) { 'loopback only' } else { 'REACHABLE FROM OTHER MACHINES - no authentication' })
  Write-Host ('  bind         : {0} ({1})' -f (Get-DisplayUrl), $exposure)
  if ($portFree -eq $true) { Write-Host ('  port {0}      : free' -f $Port) }
  elseif ($portFree -eq $false) { Write-Host ('  port {0}      : IN USE' -f $Port) }
  else { Write-Host ('  port {0}      : not probed (non-IP bind address)' -f $Port) }
  Write-Host ('  runtime log  : {0}' -f $RuntimeLog)

  if ($report.Lock -and $report.LockStale) {
    Write-Host ('  lock         : stale (pid {0} is gone) - Run will clear it' -f $report.Lock.pid)
  } elseif ($report.Lock) {
    Write-Host ('  lock         : held by pid {0} (running)' -f $report.Lock.pid)
  } else {
    Write-Host '  lock         : none'
  }

  if ($portFree -eq $false) { $report.Problems += "port $Port is already in use" }

  if ($report.Problems.Count -eq 0) {
    Write-Host 'result       : ready'
    return 0
  }

  Write-Host 'problems:'
  foreach ($p in $report.Problems) { Write-Host ('  - {0}' -f $p) }
  return 1
}

function Get-SchedulerSummary {
  param([string]$Url)

  try {
    $status = Invoke-RestMethod -Uri "$Url/api/system/status" -TimeoutSec 5 -UseBasicParsing
  } catch {
    return 'http         : no response (server may still be starting)'
  }

  # jobs is a name -> status map; keep the key as the collector's name.
  $entries = @($status.jobs.PSObject.Properties | ForEach-Object {
    [pscustomobject]@{ name = $_.Name; job = $_.Value }
  })
  $unhealthy = @($entries | Where-Object { $_.job.state -ne 'healthy' })
  $expectedTimers = $entries.Count * 2

  $lines = @()
  $lines += 'http         : ok'
  if ($status.running) {
    $since = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$status.startedAt).LocalDateTime
    $lines += ('scheduler    : running since {0} ({1} min uptime)' -f $since, [int]([int64]$status.uptimeMs / 60000))
  } else {
    $lines += 'scheduler    : NOT running'
  }
  # Two timers per job is the shape one scheduler produces (see the scheduler
  # model); anything higher means a second one exists in this process.
  $lines += ('timers       : {0} for {1} jobs ({2})' -f $status.timers, $entries.Count, $(if ($status.timers -eq $expectedTimers) { 'one scheduler' } else { 'UNEXPECTED - possible duplicate scheduler' }))
  $lines += ('collectors   : {0} total, {1} not healthy' -f $entries.Count, $unhealthy.Count)
  foreach ($e in $unhealthy) {
    $reason = $(if ($e.job.inactiveReason) { $e.job.inactiveReason } else { $e.job.state })
    $lines += ('               - {0}: {1}' -f $e.name, $reason)
  }
  return ($lines -join [Environment]::NewLine)
}

function Invoke-Status {
  Set-Location $ProjectRoot

  $lock = Read-Lock
  if (-not $lock) {
    Write-Host 'DevPulse is not running (no lock file).'
    Write-Host ('start it with: npm run runtime')
    return 1
  }

  if (Test-LockStale $lock) {
    Write-Host ('DevPulse is not running (stale lock from pid {0}).' -f $lock.pid)
    Write-Host 'the next Run clears it automatically.'
    return 1
  }

  $proc = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
  Write-Host ('DevPulse is running: pid {0} ({1}), started {2}' -f $lock.pid, $proc.ProcessName, $lock.startedAt)
  Write-Host ('url          : http://{0}:{1}' -f $lock.host, $lock.port)
  # Recorded when this instance started. Re-resolving here would report the
  # default whenever the caller's shell does not carry the environment the
  # server was given. A lock written by an older build has no dbPath, so that
  # case falls back to the same resolution everything else uses.
  $dbPath = [string]$lock.dbPath
  if (-not $dbPath.Trim()) { $dbPath = Resolve-DbPath }
  Write-Host ('database     : {0}' -f $dbPath)
  Write-Host ('runtime log  : {0}' -f $RuntimeLog)
  Write-Host (Get-SchedulerSummary -Url ('http://{0}:{1}' -f $(if ($lock.host -in @('0.0.0.0', '::', '*')) { '127.0.0.1' } else { $lock.host }), $lock.port))
  return 0
}

function Invoke-Stop {
  Set-Location $ProjectRoot

  $lock = Read-Lock
  if (-not $lock) {
    Write-RuntimeLog 'stop requested, but DevPulse is not running (no lock file)'
    return 0
  }

  if (Test-LockStale $lock) {
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
    Write-RuntimeLog ('stop requested, but pid {0} is gone; stale lock removed' -f $lock.pid)
    return 0
  }

  $lockPid = [int]$lock.pid
  Write-RuntimeLog "stopping DevPulse (pid $lockPid and its children)"
  # Only the process this launcher recorded is touched, and only its own child
  # tree: /T is what stops the node process npm started. Never a wildcard kill.
  & taskkill.exe /PID $lockPid /T /F | Out-Null

  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }

  Remove-OwnLock -ProcessId $lockPid
  if (Get-Process -Id $lockPid -ErrorAction SilentlyContinue) {
    Write-RuntimeError "pid $lockPid did not exit; stop it from Task Manager if needed"
    return 1
  }

  Write-RuntimeLog 'stopped'
  return 0
}

function Invoke-Run {
  param([switch]$DetachedMode)

  # Order matters: the working directory decides where a relative
  # DEVPULSE_DB_PATH / DEVPULSE_DB_DIR (and the default) resolves.
  Set-Location $ProjectRoot

  $report = Invoke-Preflight
  if ($report.Problems.Count -gt 0) {
    foreach ($p in $report.Problems) { Write-RuntimeError $p }
    Write-RuntimeError 'startup aborted; run -Action Check for the full picture'
    return 1
  }

  if ($report.Lock -and $report.LockStale) {
    Write-RuntimeLog ('clearing stale lock from pid {0}' -f $report.Lock.pid)
    Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue
  }

  Invoke-LogRotation

  # DevPulse V1 has no authentication. Loopback is the only bind that is safe by
  # default, so anything else says so plainly before the server starts.
  if (-not (Test-LoopbackBind -Address $BindAddress)) {
    Write-RuntimeWarning "binding to $BindAddress is reachable from other machines - DevPulse has NO authentication. Do not expose DevPulse directly to an untrusted network."
  }

  $url = Get-DisplayUrl
  $startArgs = @{
    FilePath     = $report.Npm
    ArgumentList = @('run', 'start', '--', '-H', $BindAddress, '-p', "$Port")
    WorkingDirectory = $ProjectRoot
    NoNewWindow  = $true
    PassThru     = $true
  }
  if ($DetachedMode) {
    $startArgs.RedirectStandardOutput = Join-Path $LogDir 'server.out.log'
    $startArgs.RedirectStandardError = Join-Path $LogDir 'server.err.log'
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  }

  $started = Get-Date
  Write-RuntimeLog "starting DevPulse: $url (database $($report.DbPath))"

  $proc = Start-Process @startArgs
  Write-Lock -ProcessId $proc.Id -DatabasePath $report.DbPath
  Write-RuntimeLog "running: pid $($proc.Id); logs in $LogDir"

  try {
    Wait-Process -Id $proc.Id
  } finally {
    $aliveSeconds = [int]((Get-Date) - $started).TotalSeconds
    Remove-OwnLock -ProcessId $proc.Id
    $tail = ''
    if ($aliveSeconds -lt $StartupGraceSeconds) {
      $tail = Get-ServerErrorTail
      Write-RuntimeError "server exited after ${aliveSeconds}s - see $RuntimeLog"
    } else {
      Write-RuntimeLog "server exited after ${aliveSeconds}s"
    }
    if ($tail) { Write-RuntimeLog $tail }
  }

  return 0
}

<# Last lines of the server's stderr, for a failed startup. Never logs env. #>
function Get-ServerErrorTail {
  $path = Join-Path $LogDir 'server.err.log'
  if (-not (Test-Path $path)) { return '' }
  $lines = @(Get-Content -LiteralPath $path -Tail 15 -ErrorAction SilentlyContinue)
  if ($lines.Count -eq 0) { return '' }
  return "--- server.err.log (tail) ---`n" + ($lines -join "`n")
}

# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

try {
  if (-not (Test-Path (Join-Path $ProjectRoot 'package.json'))) {
    throw "no package.json next to scripts\; expected the DevPulse project at $ProjectRoot"
  }

  if ($Port -le 0) {
    $portText = Resolve-Setting -Explicit '' -EnvName 'DEVPULSE_PORT' -Default '3000'
    $parsed = 0
    if (-not [int]::TryParse($portText, [ref]$parsed) -or $parsed -lt 1 -or $parsed -gt 65535) {
      throw "DEVPULSE_PORT is not a valid port: '$portText'"
    }
    $Port = $parsed
  }
  $BindAddress = Resolve-Setting -Explicit $BindAddress -EnvName 'DEVPULSE_HOST' -Default '127.0.0.1'
  if (-not (Test-BindAddress -Address $BindAddress)) {
    throw "DEVPULSE_HOST is not a valid bind address: '$BindAddress' (expected an IP address or hostname)"
  }

  switch ($Action) {
    'Check' { exit (Invoke-Check) }
    'Status' { exit (Invoke-Status) }
    'Stop' { exit (Invoke-Stop) }
    'Run' { exit (Invoke-Run -DetachedMode:$Detached) }
  }
} catch {
  Write-RuntimeError $_.Exception.Message
  exit 1
}
