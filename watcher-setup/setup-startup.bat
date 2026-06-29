@echo off
:: Add Hariom Invoice Watcher to Windows Startup
:: Run this once as Administrator

set "BAT_PATH=%~dp0start-watcher.bat"
set "SHORTCUT=%USERPROFILE%\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\HariomWatcher.lnk"

echo Creating startup shortcut...
powershell -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%SHORTCUT%'); $Shortcut.TargetPath = '%BAT_PATH%'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.WindowStyle = 7; $Shortcut.Description = 'Hariom Invoice Watcher'; $Shortcut.Save()"

if exist "%SHORTCUT%" (
    echo Startup shortcut created.
    echo Watcher will start automatically when you log in.
) else (
    echo Failed. Try running as Administrator.
)
pause
