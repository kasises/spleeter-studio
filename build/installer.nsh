!macro customInstall
  CreateShortCut "$DESKTOP\Spleeter Studio.lnk" "$INSTDIR\Spleeter Studio.exe" "" "$INSTDIR\resources\studio\app\icon.ico" 0 SW_SHOWNORMAL "" "Spleeter Studio"
  CreateShortCut "$SMPROGRAMS\Spleeter Studio.lnk" "$INSTDIR\Spleeter Studio.exe" "" "$INSTDIR\resources\studio\app\icon.ico" 0 SW_SHOWNORMAL "" "Spleeter Studio"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Spleeter Studio.lnk"
  Delete "$SMPROGRAMS\Spleeter Studio.lnk"
!macroend
