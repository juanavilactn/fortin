@echo off
@rem Fortin command line tool.
@rem
@rem Runs src/cli.js of this application with the Electron binary that ships
@rem inside it, in Node mode. electron-builder copies this file into the build
@rem (electron-builder.yml) as <application folder>\resources\cli\fortin.cmd.
@rem
@rem Users run it through a copy that "cli install" writes into a directory of
@rem the PATH; that copy calls this file with the path of the application.

setlocal
set "CLI_DIR=%~dp0"
for %%I in ("%CLI_DIR%..\..") do set "APP_DIR=%%~fI"
set "ENTRY=%CLI_DIR%..\app.asar\src\cli.js"
set "EXE=%APP_DIR%\Fortin.exe"
if not exist "%EXE%" (
  echo fortin: cannot find the application this command belongs to 1>&2
  echo   application: %APP_DIR% 1>&2
  exit /b 1
)
if not exist "%ENTRY%" (
  echo fortin: cannot find the command line tool of the application 1>&2
  echo   cli entry: %ENTRY% 1>&2
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
"%EXE%" "%ENTRY%" %*
exit /b %ERRORLEVEL%
