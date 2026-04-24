!macro NSIS_HOOK_POSTINSTALL
  ; Copy non-delay-loadable GStreamer DLLs next to the exe
  ; gobject-2.0-0.dll can't be delay-loaded (data symbol exports)
  ; so the OS loader needs it in the exe directory at startup
  CopyFiles /SILENT "$INSTDIR\gstreamer\bin\gobject-2.0-0.dll" "$INSTDIR"
  CopyFiles /SILENT "$INSTDIR\gstreamer\bin\glib-2.0-0.dll" "$INSTDIR"
  CopyFiles /SILENT "$INSTDIR\gstreamer\bin\ffi-7.dll" "$INSTDIR"
  CopyFiles /SILENT "$INSTDIR\gstreamer\bin\intl-8.dll" "$INSTDIR"
  CopyFiles /SILENT "$INSTDIR\gstreamer\bin\pcre2-8-0.dll" "$INSTDIR"
!macroend
