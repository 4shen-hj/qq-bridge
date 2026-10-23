param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'bridge-process.psm1') -Force
try {
  $Root = [IO.Path]::GetFullPath($Root)
  $lockPath = Join-Path $Root 'state\bridge.lock'
  $lock = $null
  if (Test-Path -LiteralPath $lockPath) {
    $lock = [pscustomobject]@{ Content = (Get-Content -LiteralPath $lockPath -Raw).Trim(); LastWriteTimeUtc = (Get-Item -LiteralPath $lockPath).LastWriteTimeUtc }
  }
  $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $plan = @(Get-BridgeRestartPlan $Root $processes $lock)
  foreach ($target in $plan) { Stop-VerifiedBridgeProcess $target }
  $remaining = @(Get-BridgeRestartPlan $Root @(Get-CimInstance Win32_Process -ErrorAction Stop) $lock)
  if ($remaining.Count) { throw 'A bridge or guard started during restart. Restart aborted.' }
  if (Test-Path -LiteralPath $lockPath) {
    if (-not $lock -or (Get-Content -LiteralPath $lockPath -Raw).Trim() -cne $lock.Content -or
        (Get-Item -LiteralPath $lockPath).LastWriteTimeUtc -ne $lock.LastWriteTimeUtc) { throw 'bridge.lock changed. Restart aborted.' }
    Remove-Item -LiteralPath $lockPath
  }
  Start-Process -FilePath $env:ComSpec -ArgumentList ('/d /s /c ""' + (Join-Path $Root 'start.bat') + '""') -WorkingDirectory $Root -WindowStyle Hidden
  Write-Host 'Bridge guard started.'
} catch {
  Write-Error $_
  exit 1
}
