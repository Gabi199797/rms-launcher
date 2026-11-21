; Instalare doar pentru utilizatorul curent: fereastra "Anyone who uses this computer / Only for me" nu mai apare.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; La dezinstalarea launcherului (nu și la update) se scoate blocarea atributelor de pe fișierele RMS, ca să nu rămână blocate fără launcher.
; Se șterge și Scheduled Task-ul de watchdog (pornit la login cât timp RMS era instalat), ca să nu rămână un proces fantomă fără launcher.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\unlock-rms.ps1" 0 +2
      nsExec::Exec 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\unlock-rms.ps1" -List "$APPDATA\rms-launcher\locked-files.json" -Mode remove'
    nsExec::Exec 'schtasks /Delete /F /TN "RMSGraphicsWatchdog"'
  ${endIf}
!macroend
