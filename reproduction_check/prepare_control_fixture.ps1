param([Parameter(Mandatory=$true)][string]$PdfPath)
$ErrorActionPreference='Stop'
$dir=Join-Path $PSScriptRoot '静音评测/local-control-pages'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
& pdftoppm -f 12 -l 20 -scale-to 1350 -jpeg -jpegopt quality=85 (Resolve-Path -LiteralPath $PdfPath).Path (Join-Path $dir 'page')
if ($LASTEXITCODE) { throw 'PDF rendering failed' }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$op=[System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1' } | Select-Object -First 1
function Await-Result($operation,$type) {
    $task=$op.MakeGenericMethod($type).Invoke($null,@($operation))
    $task.Wait()
    $task.Result
}
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if(-not $engine){throw 'Chinese OCR unavailable'}
foreach($image in Get-ChildItem -LiteralPath $dir -Filter 'page-*.jpg'){
    $file=Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($image.FullName)) ([Windows.Storage.StorageFile])
    $stream=Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder=Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap=Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $result=Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $lines=$result.Lines | ForEach-Object { $_.Text -replace '(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])','' }
    $page=[int]$image.BaseName.Substring(5)-10
    $target=Join-Path $dir ('控制工程导论-书页{0:D2}.txt' -f $page)
    [IO.File]::WriteAllText($target,($lines -join [Environment]::NewLine))
    $bitmap.Dispose()
    $stream.Dispose()
    Write-Host "$page $((Get-Item $target).Length)"
}
