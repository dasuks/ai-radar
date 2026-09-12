@echo off
REM AI Radar daily run wrapper for Windows Task Scheduler.
REM Logs go to data\store\logs\<yyyy-mm-dd>.log. Exit code propagates from the pipeline.
setlocal
cd /d "%~dp0.."
if not exist "data\store\logs" mkdir "data\store\logs"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set TODAY=%%i
echo [%date% %time%] AI Radar daily start >> "data\store\logs\%TODAY%.log"
call npm run --silent daily -- %* >> "data\store\logs\%TODAY%.log" 2>&1
set EXITCODE=%ERRORLEVEL%
echo [%date% %time%] AI Radar daily exit %EXITCODE% >> "data\store\logs\%TODAY%.log"
endlocal & exit /b %EXITCODE%
