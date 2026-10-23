Set-StrictMode -Version Latest

function Get-BridgeProcessKind {
  param($Process, [string]$Root)
  $entry = [regex]::Escape([IO.Path]::GetFullPath((Join-Path $Root 'src\bridge.js')))
  $guard = [regex]::Escape([IO.Path]::GetFullPath((Join-Path $Root 'start.bat')))
  $command = [string]$Process.CommandLine
  $executable = [string]$Process.ExecutablePath
  if (-not $command -or -not [IO.Path]::IsPathRooted($executable)) { return $null }
  $exe = '(?:"' + [regex]::Escape($executable) + '"|' + [regex]::Escape($executable) + '|' + [regex]::Escape([IO.Path]::GetFileNameWithoutExtension($executable)) + '(?:\.exe)?)'
  if ($Process.Name -ieq 'node.exe' -and [IO.Path]::GetFileName($executable) -ieq 'node.exe' -and
      $command -imatch ('^\s*' + $exe + '\s+(?:"' + $entry + '"|' + $entry + ')\s*$')) { return 'bridge' }
  if ($Process.Name -ieq 'cmd.exe' -and [IO.Path]::GetFileName($executable) -ieq 'cmd.exe' -and
      $command -imatch ('^\s*' + $exe + '\s+(?:/d\s+)?(?:/s\s+)?/[ck]\s+"{0,2}' + $guard + '"{0,2}\s*$')) { return 'guard' }
  return $null
}

function Get-BridgeRestartPlan {
  param([string]$Root, [array]$Processes, $Lock)
  $targets = @()
  foreach ($process in $Processes) {
    $kind = Get-BridgeProcessKind $process $Root
    $arguments = [string]$process.CommandLine -replace '^\s*(?:"[^"]+"|\S+)\s*', ''
    if ($process.Name -ieq 'cmd.exe') { $arguments = $arguments -replace '(?i)^(?:/d\s+)?(?:/s\s+)?/[ck]\s+', '' }
    $projectEntry = '^"{0,2}' + [regex]::Escape($Root.TrimEnd('\')) + '\\(?:src\\bridge\.js|start\.bat)(?:[\s"]|$)'
    if ($kind) {
      if (-not $process.CreationDate) { throw "Cannot identify creation time for PID $($process.ProcessId)." }
      $targets += [pscustomobject]@{ ProcessId = [int]$process.ProcessId; CreationDate = ([datetime]$process.CreationDate).ToUniversalTime(); CommandLine = [string]$process.CommandLine; ExecutablePath = [string]$process.ExecutablePath; Kind = $kind }
    } elseif ($process.Name -in @('node.exe', 'cmd.exe') -and
        [string]$process.CommandLine -match '(?i)(?:^|[\s"/\\])(?:src[/\\])?(?:bridge\.js|start\.bat)(?:[\s"]|$)' -and
        ($arguments -notmatch '(?i)[a-z]:[/\\]|\\\\' -or $arguments -match $projectEntry)) {
      throw "Cannot identify bridge entry for PID $($process.ProcessId). Stop it manually before restarting."
    }
  }
  if ($Lock) {
    if ([string]$Lock.Content -notmatch '^\d+$' -or [long]$Lock.Content -le 0 -or [long]$Lock.Content -gt [int]::MaxValue) { throw 'Invalid bridge.lock. Restart aborted.' }
    $locked = @($Processes | Where-Object { $_.ProcessId -eq [int]$Lock.Content })
    if ($locked.Count -gt 0) {
      $target = @($targets | Where-Object { $_.ProcessId -eq [int]$Lock.Content -and $_.Kind -eq 'bridge' })
      if ($target.Count -ne 1 -or $target[0].CreationDate -gt ([datetime]$Lock.LastWriteTimeUtc).ToUniversalTime()) {
        throw 'bridge.lock does not identify the running bridge or its PID was reused. Restart aborted.'
      }
    }
  }
  return @($targets | Sort-Object @{ Expression = { if ($_.Kind -eq 'guard') { 0 } else { 1 } } }, ProcessId)
}

function Stop-VerifiedBridgeProcess {
  param($Target, [scriptblock]$Query = { param($id) Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction Stop },
    [scriptblock]$Open = { param($id) [Diagnostics.Process]::GetProcessById($id) })
  $handle = & $Open $Target.ProcessId
  try {
    # Keep the kernel handle open across verification and termination so a recycled PID cannot become the target.
    $null = $handle.Handle
    $current = & $Query $Target.ProcessId
    $started = $handle.StartTime.ToUniversalTime()
    # CIM truncates creation timestamps to microseconds; Process.StartTime retains 100 ns ticks.
    $started = $started.AddTicks(-($started.Ticks % 10))
    if (-not $current -or $started -ne $Target.CreationDate -or
        ([datetime]$current.CreationDate).ToUniversalTime() -ne $Target.CreationDate -or
        $current.CommandLine -cne $Target.CommandLine -or $current.ExecutablePath -ine $Target.ExecutablePath) {
      throw "Process identity changed for PID $($Target.ProcessId). Restart aborted."
    }
    $handle.Kill()
    if (-not $handle.WaitForExit(10000)) { throw "PID $($Target.ProcessId) did not exit. Restart aborted." }
  } finally { $handle.Dispose() }
}

Export-ModuleMember -Function Get-BridgeProcessKind, Get-BridgeRestartPlan, Stop-VerifiedBridgeProcess
