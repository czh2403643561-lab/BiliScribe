$ErrorActionPreference = 'Stop'
$fixtureDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'fixtures'
$wavPath = Join-Path $fixtureDirectory 'automation-sample.wav'
$mp4Path = Join-Path $fixtureDirectory 'automation-sample.mp4'
$text = Get-Content -LiteralPath (Join-Path $fixtureDirectory 'expected-transcript.txt') -Raw -Encoding UTF8

Add-Type -AssemblyName System.Speech
$synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $chineseVoice = $synthesizer.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (-not $chineseVoice) { throw 'No Chinese Windows speech voice is installed.' }
  $synthesizer.SelectVoice($chineseVoice.VoiceInfo.Name)
  $synthesizer.Rate = 0
  $synthesizer.SetOutputToWaveFile($wavPath)
  $synthesizer.Speak($text)
} finally {
  $synthesizer.Dispose()
}

$ffmpeg = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) { throw 'FFmpeg executable is missing from PATH.' }
& $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'color=c=0x182b3b:s=640x360:r=24' -i $wavPath -map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -tune stillimage -pix_fmt yuv420p -c:a aac -b:a 64k -shortest $mp4Path
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $mp4Path)) { throw 'FFmpeg failed to generate the test video.' }
Remove-Item -LiteralPath $wavPath -Force
Write-Output "Generated the local test fixture: $mp4Path"
