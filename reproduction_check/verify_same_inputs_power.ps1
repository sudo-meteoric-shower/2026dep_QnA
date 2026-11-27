param(
    [ValidateSet('AC','Battery')][string]$Power = 'AC',
    [switch]$PowerCheckOnly,
    [switch]$TeacherFreshOnly,
    [switch]$RequireSaverOff,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$results = Join-Path $PSScriptRoot '静音评测'
$powerTag = $Power.ToLowerInvariant()
if ($RequireSaverOff) { $powerTag += '-saver-off' }
$metadataPath = Join-Path $results "同题-$powerTag-供电.json"

Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class BenchmarkPower {
    [StructLayout(LayoutKind.Sequential)]
    public struct Status {
        public byte AC, Battery, Charge, Saver;
        public uint Remaining, Total;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetSystemPowerStatus(out Status status);
}
'@

function Read-PowerState {
    $status = [BenchmarkPower+Status]::new()
    $plan = [regex]::Match((powercfg /GETACTIVESCHEME) -join ' ', '[a-fA-F0-9-]{36}')
    if (-not [BenchmarkPower]::GetSystemPowerStatus([ref]$status) -or
        $status.AC -gt 1 -or $status.Charge -gt 100 -or $status.Saver -gt 1 -or -not $plan.Success) {
        throw '无法读取 Windows 供电状态'
    }
    @{
        time = (Get-Date).ToString('o')
        ac = $status.AC -eq 1
        chargePercent = [int]$status.Charge
        energySaver = $status.Saver -eq 1
        plan = $plan.Value
    }
}

function Assert-PowerState($state) {
    if ($state.ac -ne ($Power -eq 'AC')) { throw "当前供电状态与 $Power 不符，未启动该组" }
    if ($RequireSaverOff -and $state.energySaver) { throw 'Windows 节能模式仍开启，未启动该组' }
    if ($Power -eq 'Battery' -and $state.chargePercent -lt 35) { throw '电池低于 35%，暂停长时间测试' }
}

$groups = @(
    @{ name='teacher'; comparison='teacher'; options=@() },
    @{ name='06'; comparison='candidate'; options=@('--model=qwen3_06b') },
    @{ name='17-4'; comparison='candidate'; options=@('--model=qwen3_17b','--wasm-threads=4','--monitor-resources') },
    @{ name='17-16'; comparison='candidate'; options=@('--model=qwen3_17b','--wasm-threads=16','--monitor-resources') }
)
$suites = @(@{ name='original'; options=@() }, @{ name='fresh'; options=@('--fresh') })
if ($TeacherFreshOnly) {
    $groups = @($groups[0])
    $suites = @($suites[1])
    $metadataPath = Join-Path $results "老师留出题-$powerTag-供电.json"
}
if ($PowerCheckOnly) {
    $groups = @(@{ name='17-4'; comparison='candidate'; options=@('--model=qwen3_17b','--wasm-threads=4','--monitor-resources','--question=charge,calc') })
    $suites = @(@{ name='power-pair'; options=@() })
    $metadataPath = Join-Path $results "供电短长题-$powerTag.json"
}

$rows = [Collections.Generic.List[object]]::new()
$initial = Read-PowerState
Assert-PowerState $initial
if ($Resume) {
    foreach ($row in (Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json -AsHashtable)) { $rows.Add($row) }
    if ($rows.Count -eq 0 -or $rows[0].before.plan -ne $initial.plan -or
        $rows[0].before.energySaver -ne $initial.energySaver -or $rows[0].before.ac -ne $initial.ac) {
        throw '供电工况与前一轮不一致，无法续跑'
    }
}
$initial | ConvertTo-Json -Compress | Write-Host
Push-Location -LiteralPath $repository
try {
    foreach ($group in $groups) {
        foreach ($suite in $suites) {
            $completed = $rows | Where-Object { $_.group -eq $group.name -and $_.suite -eq $suite.name -and $_.exitCode -eq 0 }
            if ($Resume -and $completed) { continue }
            $before = Read-PowerState
            Assert-PowerState $before
            if ($before.plan -ne $initial.plan -or $before.energySaver -ne $initial.energySaver) {
                throw '本轮电源计划或节能状态已切换，未启动该组'
            }
            $tag = "same-$powerTag-$($group.name)"
            if ($PowerCheckOnly) { $tag += '-power-pair' }
            $arguments = @("--compare=$($group.comparison)", "--result-tag=$tag") + $group.options + $suite.options
            Write-Host "$($before.time) $($group.name) $($suite.name)"
            node (Join-Path $PSScriptRoot 'verify.cjs') @arguments
            $exitCode = $LASTEXITCODE
            $after = Read-PowerState
            $rows.Add(@{group=$group.name;suite=$suite.name;before=$before;after=$after;exitCode=$exitCode})
            ConvertTo-Json -InputObject @($rows.ToArray()) -Depth 6 |
                Set-Content -LiteralPath $metadataPath -Encoding utf8
            if ($after.ac -ne $before.ac -or $after.plan -ne $before.plan -or $after.energySaver -ne $before.energySaver) {
                throw '测试前后供电、电源计划或节能状态不同，停止后续批次'
            }
        }
    }
}
finally { Pop-Location }
