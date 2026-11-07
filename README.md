# DeepSeek Bridge

Turns your logged-in **chat.deepseek.com** session into a local API that speaks both **OpenAI** (`/v1/chat/completions`) and **Anthropic** (`/v1/messages`), with a dashboard for setup, a playground and a request log. Zero npm dependencies; needs Node 18+.

> Unofficial. It talks to DeepSeek's private web API, which can change or block you at any time, and it likely violates DeepSeek's terms. Personal use only. For anything important use the official API (platform.deepseek.com).

## Run

```
start.bat                       # Windows
node bin/deepseek-bridge.js     # anywhere (or `deepseek-bridge` once linked onto your PATH)
```

The dashboard opens at <http://localhost:8787>. Follow the 3 steps to paste your token (one console line copies it), then copy the generated API key.

Options: `--port`, `--host 0.0.0.0` (LAN), `--token`, `--no-open`, `--no-banner`. Env: `PORT`, `HOST`, `DEEPSEEK_TOKEN`.

## Terminal edition

`deepseek` (`bin/deepseek.js`) is the same bridge without the dashboard: an interactive terminal app.

```
deepseek                 open the app (menu: Claude Code, chat, log in, details, request log)
deepseek claude [args]   launch Claude Code on DeepSeek
deepseek chat            chat in the terminal
deepseek login           log in (--google, or --token <t>)
deepseek status | logout | serve
```

**Log in** walks you through it in four steps:

1. chat.deepseek.com opens in your normal browser. Log in there as usual (captcha included).
2. Press `F12` (`Cmd+Option+J` on macOS) and open the **Console** tab.
3. Paste the line the app already put on your clipboard and press Enter:
   `copy(JSON.parse(localStorage.userToken).value)`
   If the browser blocks pasting, type `allow pasting`, press Enter, and paste again.
4. That copies your session token. The app watches the clipboard, checks the token with DeepSeek and logs you in. You can also paste the token into the app yourself.

Only the token is saved (in `data/config.json`), and it is wiped from the clipboard afterwards. Logging out on the website ends the session.

`deepseek login --browser` still offers the automatic sign-in (a Chrome window that fills in your email and password, or Google), but DeepSeek usually answers that with a captcha.

The terminal app serves the API on port 8788 by default (the next free port if that's taken), so it can run next to the dashboard version.

## Clients

```powershell
# Claude Code
$env:ANTHROPIC_BASE_URL="http://localhost:8787"; $env:ANTHROPIC_AUTH_TOKEN="<key>"; $env:ANTHROPIC_MODEL="deepseek-chat"; claude
```
```python
OpenAI(base_url="http://localhost:8787/v1", api_key="<key>")
```

Models: `deepseek-chat`, `deepseek-reasoner` (returns `reasoning_content` / thinking blocks), plus `-search` variants. Any other name (`gpt-*`, `claude-*`) maps to `deepseek-chat`.

## How it works / limits

- Each request runs in a throwaway DeepSeek chat (deleted afterwards); the whole conversation is flattened into one prompt.
- Tool calling is **emulated** through the prompt (`<tool_call>` tags), so reliability depends on the model following the format.
- Images are not supported (replaced by a placeholder). Token counts are estimates.
- Config (token, API key) lives in `data/config.json`. The dashboard is loopback-only.

## Credits

Protocol knowledge and PoW approach adapted from [ForgetMeAI/FreeDeepseekAPI](https://github.com/ForgetMeAI/FreeDeepseekAPI) (MIT), cross-checked against [NIyueeE/ds-free-api](https://github.com/NIyueeE/ds-free-api) and [iidamie/deepseek2api](https://github.com/iidamie/deepseek2api). They are not included here.

## Launching Claude Code on DeepSeek (Windows)

`bin\dsclaude.cmd` starts the bridge if needed, sets the environment (including a `/model` picker with the 4 DeepSeek models from `assets\claude-settings.json`) and runs `claude`. Add `bin` to your PATH to run `dsclaude` anywhere.

## Launching Claude Code on DeepSeek (Linux / macOS)

`bin/dsclaude` does the same: starts the bridge in the background if needed (log in `data/bridge.log`), sets the environment and execs `claude`. Link it onto your PATH:

```sh
ln -s "$PWD/bin/dsclaude" ~/.local/bin/dsclaude
ln -s "$PWD/bin/deepseek-bridge.js" ~/.local/bin/deepseek-bridge
```

## Debugging

The latest tool-enabled raw model reply is written to `data/last-raw.txt` (git-ignored).

## Tests

`npm test` runs unit tests, tool-call repair tests, and an end-to-end test against a mock DeepSeek server. The end-to-end test needs `sha3_wasm_bg.*.wasm` from a reference clone at `refs/deepseek2api/` and is skipped when it is absent; the PoW solver itself is stubbed there.
