!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "YouTube Downloader Pro.exe" /T'
  Sleep 800

  ; Extract helper next to the installer temp files, then silently uninstall any old copy
  ; (NSIS per-user, NSIS per-machine, or MSI) before this version is copied.
  SetOutPath "$TEMP"
  File "/oname=$TEMP\yd-uninstall-old.ps1" "${BUILD_RESOURCES_DIR}\uninstall-old.ps1"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\yd-uninstall-old.ps1"'
!macroend

!macro customInstall
  ; Force desktop + start-menu shortcuts to use the real app icon file
  ; (avoids Windows keeping a cached Electron icon for the .exe path).
  CreateShortCut "$DESKTOP\YouTube Downloader Pro.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\app-icon.ico" 0
  CreateShortCut "$SMPROGRAMS\YouTube Downloader Pro.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\app-icon.ico" 0
!macroend
