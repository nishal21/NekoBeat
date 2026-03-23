!macro customInstall
  DetailPrint "NekoBeat: Relocating GStreamer DLLs to application root..."
  CopyFiles /SILENT "$INSTDIR\resources\gstreamer\bin\*.dll" "$INSTDIR"
!macroend
