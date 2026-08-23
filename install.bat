@echo off
setlocal EnableExtensions

set "ARG=%~1"
if "%ARG%"=="" set "ARG=--global"
if /i "%ARG%"=="--global" goto :scope_ok
if /i "%ARG%"=="-g" goto :scope_ok
if /i "%ARG%"=="--local" goto :scope_ok
if /i "%ARG%"=="-l" goto :scope_ok
if /i "%ARG%"=="-h" goto :usage
if /i "%ARG%"=="--help" goto :usage
goto :usage

:scope_ok
if not "%~2"=="" goto :usage
set "SCOPE=%ARG%"
set "SCRIPT_DIR=%~dp0"
set "SRC_PLUGINS=%SCRIPT_DIR%.opencode\plugins"
set "SRC_TUI=%SCRIPT_DIR%.opencode\tui.json"

if not exist "%SRC_PLUGINS%\usage-tracker.ts" (
  echo install.bat: cannot find .opencode\plugins and .opencode\tui.json next to the script.
  echo Run this batch file from the repository checkout.
  exit /b 1
)

if "%SCOPE%"=="global" (set "TARGET=%USERPROFILE%\.config\opencode") else set "TARGET=%CD%\.opencode"

echo Installing usage-counter plugins (%SCOPE%)
echo   from: %SCRIPT_DIR%.opencode
echo   to:   %TARGET%

where robocopy >nul 2>nul && set "ROBO=yes"
if defined ROBO goto :copy_robocopy

xcopy "%SRC_PLUGINS%" "%TARGET%\plugins\" /E /I /Y /Q >nul
if errorlevel 1 goto :copy_fail
goto :copy_done

:copy_robocopy
robocopy "%SRC_PLUGINS%" "%TARGET%\plugins" /E /NFL /NDL /NJH /NJS /NP >nul
if %errorlevel% geq 8 goto :copy_fail

:copy_done
if not exist "%TARGET%\tui.json" (
  copy /y "%SRC_TUI%" "%TARGET%\tui.json" >nul || goto :write_fail
  goto :tui_done
)

findstr /c:"usage-tui" "%TARGET%\tui.json" >nul 2>&1
if %errorlevel%==0 (
  echo tui.json already declares the TUI plugin.
  goto :tui_done
)

call :merge_tui
if %errorlevel% neq 0 goto :merge_fail
goto :tui_done

:tui_done
echo Done. Restart OpenCode; the server plugin backfills history for this folder on first launch.
exit /b 0

:copy_fail
echo install.bat: failed to copy plugins directory.
exit /b 1

:write_fail
echo install.bat: failed to write tui.json.
exit /b 1

:merge_fail
echo WARNING: could not update "%TARGET%\tui.json" automatically.
echo Add the TUI plugin declaration manually:
echo   "plugin": ["./plugins/lib/usage-tui.ts"]
exit /b 1

:merge_tui
set "PS1=%TEMP%\usage-counter-merge-%RANDOM%.ps1"
> "%PS1%" echo param([string]$Target, [string]$Source)
>> "%PS1%" echo $ErrorActionPreference = 'Stop'
>> "%PS1%" echo try {
>> "%PS1%" echo   $entry = './plugins/lib/usage-tui.ts'
>> "%PS1%" echo   if (-not (Test-Path -LiteralPath $Target)) { Copy-Item -LiteralPath $Source -Destination $Target; exit 0 }
>> "%PS1%" echo   $json = Get-Content -LiteralPath $Target -Raw ^| ConvertFrom-Json
>> "%PS1%" echo   if (-not $json.PSObject.Properties['plugin']) { $json ^| Add-Member -NotePropertyName plugin -NotePropertyValue @($entry) -Force }
>> "%PS1%" echo   elseif ($json.plugin -is [array]) { if ($json.plugin -notcontains $entry) { $json.plugin = @($entry) + @($json.plugin) } }
>> "%PS1%" echo   else { if ($json.plugin -ne $entry) { $json.plugin = @($entry) + @($json.plugin) } }
>> "%PS1%" echo   $text = ConvertTo-Json -InputObject $json -Depth 10
>> "%PS1%" echo   [System.IO.File]::WriteAllText($Target, $text)
>> "%PS1%" echo   exit 0
>> "%PS1%" echo } catch {
>> "%PS1%" echo   Write-Error $_
>> "%PS1%" echo   exit 1
>> "%PS1%" echo }
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Target "%TARGET%\tui.json" -Source "%SRC_TUI%" >nul 2>&1
set "RC=%errorlevel%"
del "%PS1%" >nul 2>&1
exit /b %RC%

:usage
echo Usage: install.bat [--global ^| --local]
echo.
echo Install the opencode usage-counter plugins (server tracker + /usage TUI command).
echo.
echo   --global   install to %%USERPROFILE%%\.config\opencode (default)
echo   --local    install into %%CD%%\.opencode of the current directory
echo   -h, --help show this help
exit /b 2
