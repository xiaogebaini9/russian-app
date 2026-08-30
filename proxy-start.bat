@echo off
cd /d %~dp0
echo ================================================
echo   Russian Learning App Server
echo   Browser: http://localhost:8765
echo   Phone (same WiFi): use the LAN IP printed below
echo   Stop: close this window or press Ctrl+C
echo ================================================
node proxy.js
pause
