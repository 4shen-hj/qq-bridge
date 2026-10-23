$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bridge-process.psm1') -Force
$root = 'C:\fixture project\qq-bridge'
$created = [datetime]'2026-10-23T01:00:00.123456Z'
function Fixture($id, $name, $command, $createdAt = $created) {
  $exe = if ($name -eq 'node.exe') { 'C:\Program Files\nodejs\node.exe' } else { 'C:\Windows\System32\cmd.exe' }
  return [pscustomobject]@{ ProcessId=$id; Name=$name; ExecutablePath=$exe; CommandLine=$command; CreationDate=$createdAt }
}
function Check($condition, $message) { if (-not $condition) { throw $message } }
function Refuses([scriptblock]$action, [string]$expected) {
  try { & $action; throw 'Expected refusal was missing' } catch { if ($_.Exception.Message -notmatch $expected) { throw } }
}
$bridge = Fixture 101 'node.exe' '"C:\Program Files\nodejs\node.exe" "C:\fixture project\qq-bridge\src\bridge.js"'
$guard = Fixture 102 'cmd.exe' 'C:\Windows\System32\cmd.exe /d /s /c ""C:\fixture project\qq-bridge\start.bat""'
$other = @(
  (Fixture 201 'node.exe' 'node.exe C:\unrelated\bridge.js'),
  (Fixture 202 'cmd.exe' 'cmd.exe /c C:\unrelated\start.bat'),
  (Fixture 203 'node.exe' 'node.exe C:\unrelated\app.js "C:\fixture project\qq-bridge\src\bridge.js"'),
  (Fixture 204 'cmd.exe' 'cmd.exe /c echo "C:\unrelated\start.bat"')
)
$lock = [pscustomobject]@{ Content='101'; LastWriteTimeUtc=$created.AddSeconds(1) }
$plan = @(Get-BridgeRestartPlan $root (@($bridge, $guard) + $other) $lock)
Check ($plan.Count -eq 2 -and $plan[0].ProcessId -eq 102 -and $plan[1].ProcessId -eq 101) 'Only exact project guard and bridge are selected, guard first'
Check ((Get-BridgeProcessKind (Fixture 101 'node.exe' 'node "C:\fixture project\qq-bridge\src\bridge.js"') $root) -eq 'bridge') 'start.bat uses extensionless node command'
Check (@(Get-BridgeRestartPlan $root $other $null).Count -eq 0) 'Unrelated same-name processes must be ignored'
Refuses { Get-BridgeRestartPlan $root $other ([pscustomobject]@{ Content='201'; LastWriteTimeUtc=$created.AddSeconds(1) }) } 'does not identify'
Refuses { Get-BridgeRestartPlan $root @($bridge) ([pscustomobject]@{ Content='101'; LastWriteTimeUtc=$created.AddSeconds(-1) }) } 'PID was reused'
Refuses { Get-BridgeRestartPlan $root @($bridge) ([pscustomobject]@{ Content='garbage'; LastWriteTimeUtc=$created }) } 'Invalid bridge.lock'
Check (@(Get-BridgeRestartPlan $root $other ([pscustomobject]@{ Content='999'; LastWriteTimeUtc=$created })).Count -eq 0) 'Dead stale PID does not select another process'
foreach ($command in @('node.exe src\bridge.js', '"C:\Program Files\nodejs\node.exe" src\bridge.js', 'cmd.exe /c start.bat')) {
  Refuses { Get-BridgeRestartPlan $root @((Fixture 301 $(if ($command -like '*node*') { 'node.exe' } else { 'cmd.exe' }) $command)) $null } 'Cannot identify'
}
Refuses { Get-BridgeRestartPlan $root @((Fixture 302 'node.exe' 'node.exe "C:\fixture project\qq-bridge\src\bridge.js" --extra')) $null } 'Cannot identify'
$missing = Fixture 101 'node.exe' $null
Refuses { Get-BridgeRestartPlan $root @($missing) $lock } 'does not identify'
$target = $plan[1]
function FakeHandle($started) {
  $value = [pscustomobject]@{ Handle=123; StartTime=$started; Killed=$false; Disposed=$false }
  $value | Add-Member ScriptMethod Kill { $this.Killed=$true }
  $value | Add-Member ScriptMethod WaitForExit { param($timeout) return $true }
  $value | Add-Member ScriptMethod Dispose { $this.Disposed=$true }
  return $value
}
$handle = FakeHandle ($created.AddTicks(3))
Stop-VerifiedBridgeProcess $target -Query { $bridge } -Open { $handle }
Check ($handle.Killed -and $handle.Disposed) 'Verified retained handle is terminated and disposed'
$handle = FakeHandle ($created.AddSeconds(10))
Refuses { Stop-VerifiedBridgeProcess $target -Query { $bridge } -Open { $handle } } 'identity changed'
Check (-not $handle.Killed -and $handle.Disposed) 'Reused PID handle is never terminated'
$handle = FakeHandle $created
Refuses { Stop-VerifiedBridgeProcess $target -Query { $other[0] } -Open { $handle } } 'identity changed'
Check (-not $handle.Killed -and $handle.Disposed) 'Changed command identity is never terminated'
Write-Host 'PASS restart safety: exact paths, unrelated names, stale/reused PID, legacy ambiguity, retained-handle race'
