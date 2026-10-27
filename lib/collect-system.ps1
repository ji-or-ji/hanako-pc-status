param()

# 开关通过环境变量传入，避免 -EncodedCommand 无法携带脚本参数的限制
$__flags = @(("$env:HANA_PC_STATUS_FLAGS" -split ',') | Where-Object { $_ })
$WithBatteryHealth = ($__flags -contains 'battery-health')
$AllSchemes = ($__flags -contains 'all-schemes')

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ── 供电状态：kernel32 比 WMI 快且准 ──
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
$nativeOk = [HanaPc.PowerNative]::GetSystemPowerStatus([ref]$sp)

$now = Get-Date

# ── 电池：一次 WMI 查询补足名称与估算时间 ──
$bat = Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1
$battery = $null
if ($bat) {
  $percent = $null
  if ($nativeOk -and $sp.BatteryLifePercent -ne 255) { $percent = [int]$sp.BatteryLifePercent }
  elseif ($bat.EstimatedChargeRemaining -ne $null) { $percent = [int]$bat.EstimatedChargeRemaining }

  $flag = $null
  if ($nativeOk) { $flag = [int]$sp.BatteryFlag }
  $charging = $false
  if ($flag -ne $null) { $charging = (($flag -band 8) -ne 0) }

  # 剩余可用时间：kernel32 秒 → WMI 分钟 → 放电速率推算
  $minutesLeft = $null
  $minutesSource = $null
  if ($nativeOk -and $sp.BatteryLifeTime -gt 0 -and $sp.BatteryLifeTime -lt 100000000) {
    $minutesLeft = [int][math]::Round($sp.BatteryLifeTime / 60, 0)
    $minutesSource = 'kernel32'
  }
  if (-not $minutesLeft) {
    $rt = 0
    [void][int]::TryParse([string]$bat.EstimatedRunTime, [ref]$rt)
    if ($rt -gt 0 -and $rt -lt 100000) { $minutesLeft = $rt; $minutesSource = 'wmi-estimate' }
  }
  if (-not $minutesLeft -and -not $charging) {
    $bs = Get-CimInstance -Namespace 'root/wmi' -ClassName 'BatteryStatus' | Select-Object -First 1
    if ($bs -and $bs.Rate -gt 0 -and $bs.RemainingCapacity -gt 0) {
      $minutesLeft = [int][math]::Round(($bs.RemainingCapacity / $bs.Rate) * 60, 0)
      $minutesSource = 'discharge-rate'
    }
  }

  $design = $null
  $full = $null
  $health = $null
  if ($WithBatteryHealth) {
    $staticData = Get-CimInstance -Namespace 'root/wmi' -ClassName 'BatteryStaticData' | Select-Object -First 1
    $fullData = Get-CimInstance -Namespace 'root/wmi' -ClassName 'BatteryFullChargedCapacity' | Select-Object -First 1
    if ($staticData -and $fullData -and $staticData.DesignedCapacity -gt 0 -and $fullData.FullChargedCapacity -gt 0) {
      $design = [int]$staticData.DesignedCapacity
      $full = [int]$fullData.FullChargedCapacity
      $health = [math]::Round((100.0 * $full / $design), 1)
    }
  }

  $battery = [ordered]@{
    present               = $true
    name                  = $bat.Name
    percent               = $percent
    charging              = $charging
    low                   = $(if ($flag -ne $null) { (($flag -band 2) -ne 0) } else { $false })
    critical              = $(if ($flag -ne $null) { (($flag -band 4) -ne 0) } else { $false })
    statusCode            = $(if ($flag -ne $null) { $flag } else { [int]$bat.BatteryStatus })
    minutesLeft           = $minutesLeft
    minutesLeftSource     = $minutesSource
    designCapacityMWh     = $design
    fullChargeCapacityMWh = $full
    healthPercent         = $health
  }
} else {
  $battery = [ordered]@{ present = $false }
}

$acLine = 'unknown'
if ($nativeOk) {
  if ($sp.ACLineStatus -eq 1) { $acLine = 'online' }
  elseif ($sp.ACLineStatus -eq 0) { $acLine = 'offline' }
}

# ── 电源计划 ──
$powercfg = "$env:SystemRoot\System32\powercfg.exe"
$schemeRaw = (& $powercfg /getactivescheme) -join ' '
$schemeGuid = $null
$schemeName = $null
if ($schemeRaw -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})') {
  $schemeGuid = $matches[1]
}
if ($schemeRaw -match '[（(]\s*([^（）()]+?)\s*[)）]') {
  $schemeName = $matches[1].Trim()
}

$schemeList = @()
if ($AllSchemes) {
  foreach ($line in (& $powercfg /list)) {
    if ($line -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\s*[（(]\s*(.+?)\s*[)）]') {
      $schemeList += [ordered]@{
        guid   = $matches[1]
        name   = $matches[2].Trim()
        active = ($matches[1] -eq $schemeGuid)
      }
    }
  }
}

# ── 内存与运行时长 ──
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$uptimeSeconds = $null
$memTotalGB = $null
$memUsedGB = $null
$memUsedPercent = $null
if ($os) {
  if ($os.LastBootUpTime) { $uptimeSeconds = [int](((Get-Date) - $os.LastBootUpTime).TotalSeconds) }
  if ($os.TotalVisibleMemorySize -gt 0) {
    $memTotalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    $memFreeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    $memUsedGB = [math]::Round($memTotalGB - $memFreeGB, 1)
    $memUsedPercent = [math]::Round((100.0 * $memUsedGB / $memTotalGB), 1)
  }
}

# ── CPU 瞬时负载 ──
$cpuAvg = (Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$cpuLoad = $null
if ($cpuAvg -ne $null) { $cpuLoad = [int][math]::Round($cpuAvg, 0) }

# ── 磁盘：.NET DriveInfo，比 WMI 快得多 ──
$disks = @()
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
  if (-not $d.IsReady) { continue }
  if ($d.DriveType -ne [System.IO.DriveType]::Fixed) { continue }
  $totalGB = [math]::Round($d.TotalSize / 1GB, 1)
  $freeGB = [math]::Round($d.TotalFreeSpace / 1GB, 1)
  $usedPercent = $null
  if ($d.TotalSize -gt 0) { $usedPercent = [math]::Round((100.0 * ($d.TotalSize - $d.TotalFreeSpace) / $d.TotalSize), 1) }
  $disks += [ordered]@{
    name        = $d.Name.Substring(0, 2)
    totalGB     = $totalGB
    freeGB      = $freeGB
    usedPercent = $usedPercent
  }
}

# ── Hana 自身进程：hana-server 才是真正的后端 ──
function Read-ProcessGroup($name) {
  $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    return [ordered]@{ name = $name; running = $false; processCount = 0 }
  }
  $sum = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
  $started = ($procs | Sort-Object -Property StartTime | Select-Object -First 1).StartTime
  return [ordered]@{
    name        = $name
    running     = $true
    processCount = $procs.Count
    memoryMB    = [math]::Round($sum / 1MB, 1)
    startedAt   = $(if ($started) { $started.ToString('yyyy-MM-dd HH:mm:ss') } else { $null })
    uptimeSeconds = $(if ($started) { [int](((Get-Date) - $started).TotalSeconds) } else { $null })
  }
}

$hanaProcesses = @(
  Read-ProcessGroup 'hana-server'
  Read-ProcessGroup 'hana-win-sandbox'
  Read-ProcessGroup 'HanaAgent'
)

$topProcesses = @()
foreach ($p in (Get-Process | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 5)) {
  if ($p.WorkingSet64 -gt 0) {
    $topProcesses += [ordered]@{
      name     = $p.ProcessName
      memoryMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
    }
  }
}

$result = [ordered]@{
  collectedAt = $now.ToString('yyyy-MM-dd HH:mm:ss')
  offset      = $now.ToString('zzz')
  weekday     = $now.DayOfWeek.ToString()
  timeZone    = (Get-TimeZone).Id
  acLine      = $acLine
  battery     = $battery
  powerScheme = [ordered]@{
    guid = $schemeGuid
    name = $schemeName
    raw  = $schemeRaw.Trim()
    all  = $schemeList
  }
  system = [ordered]@{
    uptimeSeconds     = $uptimeSeconds
    cpuLoadPercent    = $cpuLoad
    memoryTotalGB     = $memTotalGB
    memoryUsedGB      = $memUsedGB
    memoryUsedPercent = $memUsedPercent
    disks             = $disks
  }
  hana      = $hanaProcesses
  topMemoryProcesses = $topProcesses
}

$result | ConvertTo-Json -Depth 8 -Compress
