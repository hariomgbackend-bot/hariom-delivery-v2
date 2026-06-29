@echo off
:: Hariom Invoice Watcher — Add to Windows Startup
:: Run this ONCE as Administrator to auto-start the watcher when PC boots.

set "SCRIPT_DIR=%~dp0"
set "BAT_PATH=%SCRIPT_DIR%start-watcher.bat"
set "SHORTCUT_PATH=%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\HariomWatcher.lnk"

echo Creating startup shortcut...

powershell -Command ^
  "$WshShell = New-Object -ComObject WScript.Shell; ^
  $Shortcut = $WshShell.CreateShortcut('%SHORTCUT_PATH%'); ^
  $Shortcut.TargetPath = '%BAT_PATH%'; ^
  $Shortcut.WorkingDirectory = '%SCRIPT_DIR%'; ^
  $Shortcut.WindowStyle = 7; ^
  $Shortcut.Description = 'Hariom Invoice Watcher'; ^
  $Shortcut.Save()"

if exist "%SHORTCUT_PATH%" (
    echo.
    echo Startup shortcut created successfully!
    echo The watcher will start automatically when you log in.
) else (
    echo.
    echo Failed to create shortcut. Try running as Administrator.
)

pause
