@echo off
cd /d %~dp0
node gen-codes.js 8
node gen-codes.js list
pause
