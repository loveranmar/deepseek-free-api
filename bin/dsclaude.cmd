@echo off
rem Launch Claude Code on DeepSeek (via the local DeepSeek Bridge).
rem Starts the bridge in its own window if it is not already running.
setlocal
set "ROOT=%~dp0.."
set "PORT=8787"

curl -s -m 2 http://localhost:%PORT%/health >nul 2>&1
if errorlevel 1 (
  echo Starting DeepSeek Bridge...
  start "DeepSeek Bridge" /min cmd /c ""%ROOT%\start.bat""
  for /l %%i in (1,1,20) do (
    curl -s -m 1 http://localhost:%PORT%/health >nul 2>&1 && goto :up
    timeout /t 1 /nobreak >nul
  )
  echo Bridge did not start. Run start.bat to see the error.
  exit /b 1
)
:up

for /f "delims=" %%k in ('node -e "console.log(require(process.argv[1]).apiKey)" "%ROOT%\data\config.json"') do set "DSKEY=%%k"

set "NO_COLOR="
set "FORCE_COLOR=1"
set "ANTHROPIC_BASE_URL=http://localhost:%PORT%"
set "ANTHROPIC_AUTH_TOKEN=%DSKEY%"
set "ANTHROPIC_MODEL=deepseek-chat"
set "ANTHROPIC_DEFAULT_MODEL=deepseek-chat"
rem Make every built-in alias (background tasks, subagents, plan mode) resolve to DeepSeek, never real Claude ids.
set "ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-chat"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-reasoner"
set "ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-chat"
set "ANTHROPIC_DEFAULT_FABLE_MODEL=deepseek-reasoner"
set "CLAUDE_CODE_SUBAGENT_MODEL=deepseek-chat"
set "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"

rem assets\claude-settings.json defines the /model picker (exactly the 4 DeepSeek models).
rem --allow-dangerously-skip-permissions only makes "bypass permissions" available in the Shift+Tab cycle; it does not start in it.
claude --allow-dangerously-skip-permissions --settings "%ROOT%\assets\claude-settings.json" %*
