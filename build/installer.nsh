!macro customInstall
  ; Force desktop + start-menu shortcuts to use the real app icon file
  ; (avoids Windows keeping a cached Electron icon for the .exe path).
  CreateShortCut "$DESKTOP\YouTube Downloader Pro.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\app-icon.ico" 0
  CreateShortCut "$SMPROGRAMS\YouTube Downloader Pro.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\app-icon.ico" 0
!macroend
