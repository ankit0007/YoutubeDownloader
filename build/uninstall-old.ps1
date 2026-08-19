# Runs from the new installer before files are copied.
# Silently removes previous NSIS + MSI installs. Does not delete user data (queue/downloads).

$ErrorActionPreference = "SilentlyContinue"

Get-Process -Name "YouTube Downloader Pro","electron" -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

function Invoke-UninstallCommand([string]$command) {
  if ([string]::IsNullOrWhiteSpace($command)) { return }
  $trimmed = $command.Trim()
  if ($trimmed -match 'msiexec') {
    if ($trimmed -notmatch '/X' -and $trimmed -notmatch '/x' -and $trimmed -match '\{[0-9A-Fa-f-]{36}\}') {
      $guid = [regex]::Match($trimmed, '\{[0-9A-Fa-f-]{36}\}').Value
      Start-Process -FilePath "msiexec.exe" -ArgumentList @("/x", $guid, "/qn", "/norestart") -Wait -WindowStyle Hidden
      return
    }
    $args = $trimmed
    if ($args -notmatch '/qn') { $args = "$args /qn /norestart" }
    if ($args -notmatch '/x' -and $args -notmatch '/X') { $args = $args -replace '/I', '/x' -replace '/i', '/x' }
    cmd.exe /c $args
    return
  }

  if ($trimmed.StartsWith('"')) {
    $end = $trimmed.IndexOf('"', 1)
    $exe = $trimmed.Substring(1, $end - 1)
    $rest = $trimmed.Substring($end + 1).Trim()
  } else {
    $parts = $trimmed.Split(' ', 2)
    $exe = $parts[0]
    $rest = $(if ($parts.Length -gt 1) { $parts[1] } else { "" })
  }
  if (-not (Test-Path $exe)) { return }
  if ($rest -notmatch '/S') { $rest = ($rest + " /S").Trim() }
  Start-Process -FilePath $exe -ArgumentList $rest -Wait -WindowStyle Hidden
}

$uninstallRoots = @(
  "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)

foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $item = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
    if (-not $item) { return }
    $display = [string]$item.DisplayName
    $keyName = $_.PSChildName
    $isOurs =
      $display -eq "YouTube Downloader Pro" -or
      $display -like "YouTube Downloader Pro*" -or
      $keyName -eq "com.youtubedownloader.pro" -or
      $keyName -eq "youtube-downloader-queue-app"
    if (-not $isOurs) { return }

    $cmd = [string]$item.QuietUninstallString
    if ([string]::IsNullOrWhiteSpace($cmd)) {
      $cmd = [string]$item.UninstallString
    }
    Invoke-UninstallCommand $cmd
  }
}
