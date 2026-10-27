$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not ('HanaPc.PowerNative' -as [type])) {
  Add-Type -Namespace HanaPc -Name PowerNative -MemberDefinition @"
[StructLayout(LayoutKind.Sequential)]
public struct SYSTEM_POWER_STATUS {
  public byte ACLineStatus;
  public byte BatteryFlag;
  public byte BatteryLifePercent;
  public byte SystemStatusFlag;
  public int BatteryLifeTime;
  public int BatteryFullLifeTime;
}
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
"@
}

$sp = [HanaPc.PowerNative+SYSTEM_POWER_STATUS]::new()
$ok = [HanaPc.PowerNative]::GetSystemPowerStatus([ref]$sp)
$now = Get-Date

$acLine = 'unknown'
$percent = $null
$charging = $false
$low = $false
$critical = $false
$minutesLeft = $null

if ($ok) {
  if ($sp.ACLineStatus -eq 1) { $acLine = 'online' }
  elseif ($sp.ACLineStatus -eq 0) { $acLine = 'offline' }
  if ($sp.BatteryLifePercent -ne 255) { $percent = [int]$sp.BatteryLifePercent }
  $flag = [int]$sp.BatteryFlag
  if (($flag -band 128) -eq 0) {
    $charging = (($flag -band 8) -ne 0)
    $low = (($flag -band 2) -ne 0)
    $critical = (($flag -band 4) -ne 0)
    if ($sp.BatteryLifeTime -gt 0 -and $sp.BatteryLifeTime -lt 100000000) {
      $minutesLeft = [int][math]::Round($sp.BatteryLifeTime / 60, 0)
    }
  } else {
    $percent = $null
  }
}

[ordered]@{
  collectedAt = $now.ToString('yyyy-MM-dd HH:mm:ss')
  offset      = $now.ToString('zzz')
  weekday     = $now.DayOfWeek.ToString()
  acLine      = $acLine
  batteryPresent = (-not $ok) -or (($sp.BatteryFlag -band 128) -eq 0)
  batteryPercent = $percent
  charging    = $charging
  low         = $low
  critical    = $critical
  minutesLeft = $minutesLeft
} | ConvertTo-Json -Compress
