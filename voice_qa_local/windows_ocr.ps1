$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
[void][Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
    } | Select-Object -First 1

function Wait-WinRt($operation, [Type]$resultType) {
    $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
    return $task.GetAwaiter().GetResult()
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (!$engine) {
    $language = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Select-Object -First 1
    if ($language) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language) }
}
if (!$engine) { throw 'No Windows OCR recognition language is installed.' }

$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$memory = [IO.MemoryStream]::new($bytes)
$stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
try {
    $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $dimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    if ($decoder.PixelWidth -gt $dimension -or $decoder.PixelHeight -gt $dimension) { throw 'Image exceeds the OCR input size.' }
    $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync('Bgra8','Ignore')) ([Windows.Graphics.Imaging.SoftwareBitmap])
    try {
        $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $lines = @(
            foreach ($line in $result.Lines) {
                if (!$line.Text.Trim()) { continue }
                $words = @(foreach ($word in $line.Words) {
                    $box = $word.BoundingRect
                    @{
                        text = $word.Text
                        x = [math]::Round($box.X)
                        y = [math]::Round($box.Y)
                        width = [math]::Round($box.Width)
                        height = [math]::Round($box.Height)
                    }
                })
                @{ text = $line.Text; words = $words }
            }
        )
        @{
            width = $bitmap.PixelWidth
            height = $bitmap.PixelHeight
            language = $engine.RecognizerLanguage.LanguageTag
            lines = $lines
        } | ConvertTo-Json -Depth 6 -Compress
    } finally { $bitmap.Dispose() }
} finally {
    $stream.Dispose()
    $memory.Dispose()
}
