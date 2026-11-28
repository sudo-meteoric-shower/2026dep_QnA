$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class PowerCrossTest {
    [DllImport("kernel32.dll")] public static extern bool GetSystemPowerStatus([Out, MarshalAs(UnmanagedType.LPArray, SizeConst=12)] byte[] data);
}
'@
function Read-AC {
    $s=[byte[]]::new(12)
    if (-not [PowerCrossTest]::GetSystemPowerStatus($s)) {throw '供电读取失败'}
    return ($s[0] -eq 1 -and $s[3] -eq 0)
}
$repository = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $PSScriptRoot '静音评测'
$tag='cross-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
$fields='Name','ProcessorFrequency','PercentProcessorPerformance','PercentProcessorTime','PercentPerformanceLimit','PerformanceLimitFlags'
$plan=(powercfg /GETACTIVESCHEME) -join ' '
if(-not (Read-AC)) {throw '当前未处在接电且节能关闭的工况'}
$probe=Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Property $fields
if(-not ($probe | Where-Object Name -eq '_Total')) {throw '缺少性能计数器'}
$step=0
foreach ($threads in 4,16,8,8,16,4) {
    if(-not (Read-AC)) {throw '供电已切换，暂停对照'}
    $step++
    $label="$tag-$step-t$threads"
    $argsList=@('reproduction_check/verify.cjs','--compare=candidate','--model=qwen3_17b','--monitor-resources','--fresh','--question=new-lock,new-cycle',"--wasm-threads=$threads","--result-tag=$label")
    $info=[Diagnostics.ProcessStartInfo]::new()
    $info.FileName=(Get-Command node -CommandType Application | Select-Object -First 1).Source
    $info.UseShellExecute=$false
    $info.CreateNoWindow=$true
    $info.WorkingDirectory=$repository
    foreach ($arg in $argsList){$info.ArgumentList.Add($arg)}
    $samples=[Collections.Generic.List[object]]::new()
    $start=(Get-Date).ToString('o')
    Write-Host "Starting $label $start"
    $proc=[Diagnostics.Process]::Start($info)
    try {
        while(-not $proc.WaitForExit(2500)){
            $cpu=Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Property $fields
            $total=$cpu | Where-Object Name -eq '_Total'
            $cores=@($cpu | Where-Object Name -Match '^\d+,\d+$' | ForEach-Object {
                ,@($_.Name,$_.ProcessorFrequency,$_.PercentProcessorPerformance,$_.PercentProcessorTime)
            })
            $samples.Add(@{time=(Get-Date).ToString('o');acSaverOff=(Read-AC);mhz=$total.ProcessorFrequency;performance=$total.PercentProcessorPerformance;load=$total.PercentProcessorTime;limit=$total.PercentPerformanceLimit;limitFlags=$total.PerformanceLimitFlags;cores=$cores})
        }
        $end=(Get-Date).ToString('o')
        $valid=(Read-AC) -and -not @($samples | Where-Object { -not $_.acSaverOff }).Count -and $plan -eq ((powercfg /GETACTIVESCHEME) -join ' ')
        @{tag=$label;start=$start;end=$end;plan=$plan;validPower=$valid;exitCode=$proc.ExitCode;samples=$samples.ToArray()} | ConvertTo-Json -Depth 6 -Compress | Set-Content -Encoding utf8 -LiteralPath (Join-Path $dir "$label-cpu.json")
        if($proc.ExitCode -ne 0 -or -not $valid){throw "本组异常 $label exit=$($proc.ExitCode) power=$valid"}
        Write-Host "Completed $label $end"
    } finally {
        if (-not $proc.HasExited) { $proc.Kill($true); $proc.WaitForExit() }
        $proc.Dispose()
    }
}
