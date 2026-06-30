# HeyAgent

**Talk to Claude Code, Codex, or Grok from Telegram — fully local, no server required.**

HeyAgent is a bidirectional Telegram bridge for AI coding agents. Send prompts from your phone (or CarPlay), get responses back in the same chat, switch providers, pick sessions, and keep coding while away from your desk.

- Works with [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [OpenAI Codex CLI](https://github.com/openai/codex), and [Grok CLI](https://x.ai)
- Voice notes transcribed locally with Whisper (hands-free, no Siri dictation)
- Numbered session picker for voice and CarPlay (`go to project myapp` → reply `2`)
- Session and project pickers across all local projects
- Sleep prevention while the bridge runs
- One-time Telegram bot pairing; config stored at `~/.heyagent/config.json`

Fully free, open source, and local — no hosted backend, no message storage in the cloud.

## Quick start

Install from this repository (not the older `heyagent` package on npm — that is upstream without Grok, voice notes, or the hands-free session picker):

```bash
npm install -g github:appfabriek/heyagent

# Pick your default agent (all three work the same way)
hey claude
hey codex
hey grok
```

Alternative from a local clone:

```bash
git clone https://github.com/appfabriek/heyagent.git
cd heyagent
npm install -g .
```

On first run, HeyAgent walks you through Telegram bot setup (phone QR flow or manual token paste). Then send any message in Telegram to talk to your agent.

## Prerequisites

| Requirement              | Used for                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| Node.js 18+              | HeyAgent runtime                                                  |
| `claude` on PATH         | Claude Code provider                                              |
| `codex` on PATH          | Codex provider                                                    |
| `grok` on PATH           | Grok provider                                                     |
| `ffmpeg` + `whisper-cli` | Voice note transcription (optional)                               |
| `cloudflared`            | Phone onboarding tunnel (optional; manual setup works without it) |

Install voice transcription (macOS example):

```bash
brew install ffmpeg whisper-cpp
```

The multilingual Whisper model (`ggml-base.bin`, ~140 MB) downloads automatically on the first voice note to `~/.heyagent/models/`.

## CLI usage

```bash
# Resume latest session for the current directory (default)
hey claude
hey codex
hey grok

# Start a fresh session
hey claude --new
hey grok --new

# Resume a specific session
hey claude --session <session-id>
hey grok --session <session-id>

# Pass provider flags (saved per provider in config)
hey grok --always-approve
hey claude --model sonnet
hey codex --full-auto

# Show pairing and session status
hey status

# Reset Telegram bot token and chat pairing
hey reset
hey reset --yes   # non-interactive
```

### Default execution flags

HeyAgent runs agents non-interactively. Unless you pass explicit permission flags, it applies safe defaults for unattended use:

| Provider | Default flag                                 |
| -------- | -------------------------------------------- |
| Claude   | `--dangerously-skip-permissions`             |
| Codex    | `--dangerously-bypass-approvals-and-sandbox` |
| Grok     | `--always-approve`                           |

Override anytime, e.g. `hey claude --permission-mode acceptEdits` or `hey codex --full-auto`.

## Telegram commands

| Command                    | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `/help`                    | List commands                                          |
| `/new`                     | Next message starts a fresh session                    |
| `/claude` `/codex` `/grok` | Switch active provider                                 |
| `/projects`                | Pick a project, then resume or start a session         |
| `/sessions` or `/sessies`  | Pick one of the 10 most recent sessions                |
| `/status`                  | Provider, directory, bot, session, voice transcription |
| `/stop`                    | Stop current run and clear queued messages             |

Any other text is forwarded to the active agent.

### Voice-friendly session picker

Designed for hands-free use (CarPlay, voice notes, no inline keyboard taps):

1. Send a voice note or text: `go to project myapp` (also: `ga naar project myapp`, `project myapp`)
2. HeyAgent replies with a numbered list of sessions in that project
3. Reply with `2`, `new`, or `cancel` (also: `nieuw`, `annuleer`)

Example flow:

```
You:  go to project heyagent
Bot:  Sessions in heyagent:
      1 Add Grok provider support
      2 Fix session picker bug
      Which session? Reply with a number, "new", or "cancel".
You:  2
Bot:  Switched to session ...
```

### Voice notes (recommended for hands-free input)

Send a Telegram **voice note** (hold the mic button). HeyAgent:

1. Replies `Transcribing voice note...`
2. Transcribes locally with ffmpeg + whisper-cli
3. Shows the transcript in quotes
4. Routes the text through the normal message handler (commands, session picker, agent prompts)

No Siri dictation required. Works well from CarPlay via the Telegram app.

**Tip:** Add your bot as a Telegram contact (e.g. "HeyAgent") for one-tap access from CarPlay.

Voice transcription env overrides:

```bash
export HEYAGENT_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg
export HEYAGENT_WHISPER_CLI_PATH=/opt/homebrew/bin/whisper-cli
export HEYAGENT_WHISPER_MODEL=~/.heyagent/models/ggml-base.bin
```

## Setup and pairing

Start with `hey claude`, `hey codex`, or `hey grok`.

**Phone setup (recommended)**

1. Scan the QR code shown in the terminal
2. Create a bot via BotFather and submit the token
3. Open your bot chat and press START
4. HeyAgent stores the bot token and chat ID locally

**Manual fallback**

1. Create a bot in BotFather
2. Paste the token in the terminal
3. Open the bot link/QR and press START

If phone onboarding fails, install `cloudflared` (`brew install cloudflared`) or use manual fallback.

## Managing the background service (macOS launchd)

HeyAgent is commonly run as a persistent background service via macOS `launchd`. This keeps the Telegram bridge available for phone/CarPlay use even with no terminal open. Sleep prevention (`caffeinate`) is active while the service runs.

### Current setup on this machine

- **Label**: `com.heyagent.bridge`
- **Runs**: `/Users/geert/.local/bin/hey grok`
- **Working directory**: `/Users/geert/code/heyagent`
- **Plist**: `~/Library/LaunchAgents/com.heyagent.bridge.plist`
- **Logs**: `~/.heyagent/logs/service-stdout.log` and `service-stderr.log`

### Important: reboot / login behavior

The plist contains `<key>RunAtLoad</key><true/>`.  
As long as the plist file exists in `~/Library/LaunchAgents/`, macOS launchd will automatically load it at login (and after a reboot). Combined with `KeepAlive: true`, the service will start again.

- `launchctl load` / `unload` only affect the **current session**.
- After a reboot the service will come back **unless** it is explicitly disabled.

### Start / stop for current session

**Always use `launchctl` to control the service.**  
Directly killing the node process (`kill` / `pkill`) will **not** stop it for long — the plist has `KeepAlive: true`, so launchd will immediately respawn it.

```bash
# Start for this session only
launchctl load ~/Library/LaunchAgents/com.heyagent.bridge.plist

# Stop for this session only
launchctl unload ~/Library/LaunchAgents/com.heyagent.bridge.plist

# Restart (if running)
launchctl kickstart -k gui/$(id -u)/com.heyagent.bridge
```

### Persistently turn off (stays off after reboot)

```bash
launchctl bootout gui/$(id -u)/com.heyagent.bridge 2>/dev/null || true
launchctl disable gui/$(id -u)/com.heyagent.bridge
```

### Turn back on persistently

```bash
launchctl enable gui/$(id -u)/com.heyagent.bridge
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.heyagent.bridge.plist
```

### Check status + verify

```bash
# Is it disabled (survives reboot)?
launchctl print-disabled gui/$(id -u) | grep -E 'heyagent|bridge' || echo "not explicitly disabled"

# Currently loaded/running?
launchctl list | grep -E 'hey|bridge' || echo "no job"
launchctl list com.heyagent.bridge 2>/dev/null || echo "job not loaded"

ps -eo pid,ppid,lstart,command | grep -E '[n]ode .*/\.local/bin/hey ' || echo "no process"

# Logs
tail -f ~/.heyagent/logs/service-stdout.log
```

### AI agents / automation

When the user asks things like "start heyagent", "turn heyagent back on", "stop heyagent", "turn the bridge off", etc.:

- Use the **persistent** commands (`disable` + `bootout` to turn off, `enable` + `bootstrap` to turn on) so the state survives reboot.
- Always verify with the check commands.
- Report clearly, including whether it is disabled.

`load`/`unload` are only for temporary session control.

The generic plist template is included below for reference.

### Generic plist template (for other setups)

```xml
<!-- ~/Library/LaunchAgents/com.heyagent.bridge.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.heyagent.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOU/.local/bin/hey</string>
    <string>grok</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOU/code/my-project</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/YOU/.grok/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/YOU/.heyagent/logs/service-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/.heyagent/logs/service-stderr.log</string>
</dict>
</plist>
```

```bash
mkdir -p ~/.heyagent/logs
launchctl load ~/Library/LaunchAgents/com.heyagent.bridge.plist
```

Adjust paths for your environment. See the "AI agents" paragraph above for how coding agents should handle start/stop requests.

## Local terminal input

When running interactively, the terminal also accepts commands:

| Input                                    | Action                                          |
| ---------------------------------------- | ----------------------------------------------- |
| Plain text                               | Run through provider, send response to Telegram |
| `/ask <prompt>`                          | Same as plain text                              |
| `/say <text>`                            | Send raw message to Telegram                    |
| `/new` `/stop` `/status` `/help` `/exit` | Same as documented above                        |
| `/claude` `/codex` `/grok`               | Switch provider                                 |
| `/projects` `/sessions`                  | Send pickers to Telegram                        |

## How it works

- **Polling only** — no webhooks or public server
- **One chat per process** — paired to a single Telegram chat
- **Message queue** — new messages while a prompt runs are batched into the next run
- **Sessions** — reads local session indexes from `~/.claude`, `~/.codex`, and `~/.grok/sessions`
- **Attachments** — documents, images, and video are forwarded to the agent; voice/audio is transcribed first
- **Sleep prevention** — enabled while the bridge runs (macOS: `caffeinate`)

## Important notes

- **One bot token per process.** Do not run another Telegram integration (e.g. the Claude Code Telegram plugin) on the same bot — Telegram returns 409 Conflict and HeyAgent stops receiving messages.
- **Closed-lid Mac:** app-level sleep prevention does not override lid-close sleep. Use clamshell mode (power + display + input) for closed-lid operation.
- **Config location:** `~/.heyagent/config.json`

## Development

```bash
git clone https://github.com/appfabriek/heyagent.git
cd heyagent
npm install
npm test
npm run check
```

## License

MIT — see [LICENSE](LICENSE).
