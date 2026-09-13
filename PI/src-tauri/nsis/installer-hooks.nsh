!macro NSIS_HOOK_PREINSTALL
  ; Close the previous app before the default Tauri running-process check.
  ; /T also closes the bundled node.exe sidecar started by Pi-My.
  nsExec::ExecToLog 'taskkill /IM "${MAINBINARYNAME}.exe" /T /F'
  Sleep 700
!macroend
