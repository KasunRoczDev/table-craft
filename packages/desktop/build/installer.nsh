; Lists TableCraft under Open with for .sql files without taking the default handler (plan 163,
; decision 168). electron-builder's own fileAssociations writes the extension's default value, which
; would take .sql away from whatever editor the user already opens it with.
; https://learn.microsoft.com/en-us/windows/win32/shell/how-to-include-an-application-on-the-open-with-dialog-box

!define TABLE_CRAFT_SQL_PROG_ID "TableCraft.sql"
!define TABLE_CRAFT_SQL_TYPE_NAME "SQL File"
!define TABLE_CRAFT_SQL_EXTENSION ".sql"
!define TABLE_CRAFT_SQL_CLASS_KEY "Software\Classes\${TABLE_CRAFT_SQL_PROG_ID}"
!define TABLE_CRAFT_SQL_OPEN_WITH_KEY "Software\Classes\${TABLE_CRAFT_SQL_EXTENSION}\OpenWithProgids"
!define TABLE_CRAFT_APPLICATION_KEY "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
; SHCNE_ASSOCCHANGED and SHCNF_IDLIST: Explorer rereads the associations.
!define TABLE_CRAFT_SHCNE_ASSOCCHANGED 0x08000000
!define TABLE_CRAFT_SHCNF_IDLIST 0

!macro customInstall
  WriteRegStr SHELL_CONTEXT "${TABLE_CRAFT_SQL_CLASS_KEY}" "" "${TABLE_CRAFT_SQL_TYPE_NAME}"
  WriteRegStr SHELL_CONTEXT "${TABLE_CRAFT_SQL_CLASS_KEY}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${TABLE_CRAFT_SQL_CLASS_KEY}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "${TABLE_CRAFT_SQL_OPEN_WITH_KEY}" "${TABLE_CRAFT_SQL_PROG_ID}" ""
  WriteRegStr SHELL_CONTEXT "${TABLE_CRAFT_APPLICATION_KEY}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegStr SHELL_CONTEXT "${TABLE_CRAFT_APPLICATION_KEY}\SupportedTypes" "${TABLE_CRAFT_SQL_EXTENSION}" ""
  System::Call 'shell32::SHChangeNotify(i ${TABLE_CRAFT_SHCNE_ASSOCCHANGED}, i ${TABLE_CRAFT_SHCNF_IDLIST}, i 0, i 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "${TABLE_CRAFT_SQL_OPEN_WITH_KEY}" "${TABLE_CRAFT_SQL_PROG_ID}"
  DeleteRegKey /ifempty SHELL_CONTEXT "${TABLE_CRAFT_SQL_OPEN_WITH_KEY}"
  DeleteRegKey SHELL_CONTEXT "${TABLE_CRAFT_SQL_CLASS_KEY}"
  DeleteRegKey SHELL_CONTEXT "${TABLE_CRAFT_APPLICATION_KEY}"
!macroend
