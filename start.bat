@echo off
chcp 65001 >nul
title DeepSeek Bridge
mode con: cols=170 lines=45 >nul 2>&1
cd /d "%~dp0"
node bin\deepseek-bridge.js %*
pause
