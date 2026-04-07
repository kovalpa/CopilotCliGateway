# CopilotCliGateway

A gateway that bridges [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) to messaging platforms, letting you interact with Copilot from **WhatsApp** and **Telegram**.

Send a message in your chat app, get a response from Copilot — complete with session management, voice transcription, file exchange, interactive menus, and dual backend support.

## Features

- **Multi-channel support** — WhatsApp (via Baileys) and Telegram (via grammY), running simultaneously
- **Dual backend support** — Choose between CLI (spawn per request) or ACP (persistent [Agent Client Protocol](https://agentclientprotocol.com/) server)
- **Session management** — Create, switch, and list named sessions; context persists across restarts
- **Backend-typed sessions** — Sessions are tagged by backend type (CLI/ACP) and filtered accordingly, preventing cross-backend interference
- **Per-session working directories** — Each session can target a different project folder
- **Voice messages** — Automatic transcription via OpenAI Whisper, then forwarded to Copilot
- **File input** — Send any file to Copilot; files are saved to `%TEMP%/in_<project>/`, images to `%TEMP%/in_<project>/images/`
- **File output** — Copilot saves files to `%TEMP%/out_<project>/` and they're automatically delivered to your chat
- **Progress updates** — Periodic stdout updates during long-running CLI requests (configurable interval)
- **Model switching** — Change the AI model on the fly with `/model`
- **Permission controls** — Toggle between `ask` and `allow-all` modes; allow or deny specific tools. In ACP `ask` mode, blocked tools are reported back to the user
- **MCP server support** — Automatically discovers configured [MCP servers](https://modelcontextprotocol.io/)
- **Interactive menus** — Telegram inline keyboard buttons for all commands
- **System instructions** — Inject custom instructions from `instructions.md` into every session
- **Abort support** — Stop a long-running Copilot process mid-execution with `/stop`

### Security

- **Upload size limits** — Audio (25 MB), images (20 MB), generic files (50 MB)
- **Filename sanitization** — Path traversal protection on all uploaded and output files
- **Prompt length limit** — Messages capped at 100,000 characters
- **Safe error messages** — Internal paths and stack traces are never exposed to the user
- **Log truncation** — User messages are truncated in logs to avoid leaking sensitive content
- **Allowed-user filtering** — Whitelist by phone number (WhatsApp) or username/ID (Telegram); empty entries are ignored
- **Atomic session writes** — Session store uses temp-file-then-rename to prevent corruption

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and authenticated (`gh copilot` or standalone `copilot`)
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather)) and/or a WhatsApp account for QR authentication

## Installation

```bash
git clone https://github.com/kovalpa/CopilotCliGateway.git
cd CopilotCliGateway
npm install
```

## Configuration

Copy `config.example.json` to `config.json` and fill in your values:

```bash
cp config.example.json config.json
```

```jsonc
{
  "whatsapp": {
    "enabled": true,
    "phoneNumber": "",              // Your WhatsApp phone number
    "allowedNumbers": [],           // Allowed sender IDs (whitelist)
    "authDir": "./auth_state"       // Where auth state is stored
  },
  "telegram": {
    "enabled": true,
    "botToken": "",                 // Bot token from @BotFather
    "allowedUsers": ["@yourname"]   // Allowed @usernames or user IDs
  },
  "copilot": {
    "timeout": 2400000,             // Max execution time in ms (40 minutes)
    "additionalArgs": [],           // Extra CLI arguments
    "backend": "cli",               // "cli" (spawn per request) or "acp" (persistent ACP server)
    "useGh": true,                  // Use "gh copilot" vs standalone "copilot"
    "stdoutIntervalSeconds": 60     // Progress update interval (0 to disable, CLI backend only)
  },
  "openai": {
    "apiKey": "",                   // For Whisper voice transcription
    "whisperModel": "whisper-1",
    "language": ""                  // Optional language hint for Whisper
  }
}
```

> **Note:** `config.json` is gitignored to protect secrets. Only `config.example.json` is tracked.

You can also configure everything interactively via the startup menu.

## Usage

**Development:**
```bash
npm run dev
```

**Production:**
```bash
npm run build
npm start
```

**CLI flags:**
- `--no-menu` — Skip the interactive startup menu
- `--reset` — Clear WhatsApp auth state (forces new QR scan)

On first launch, the interactive menu will guide you through channel setup. For WhatsApp, scan the QR code displayed in the terminal.

## Commands

All commands work in both WhatsApp and Telegram:

| Command | Description |
|---|---|
| `/help` | Show all available commands |
| `/model [name]` | View or switch the AI model |
| `/permissions [mode]` | View or switch between `ask` and `allow-all` |
| `/allow <tool>` | Pre-approve a tool (e.g. `/allow shell(git:*)`) |
| `/deny <tool>` | Block a tool |
| `/allow reset` | Clear all allow/deny lists |
| `/session` | Show current session info |
| `/session new [name]` | Create a new session |
| `/session list` | List all sessions |
| `/session <name>` | Switch to a session |
| `/folder [path]` | View or change the working directory |
| `/instructions` | Re-inject system instructions |
| `/stop` | Abort the running Copilot process |

On Telegram, most commands also show interactive inline buttons.

## Backends

The gateway supports two communication backends with Copilot CLI, configured via `copilot.backend` in `config.json`:

| Backend | Config value | How it works | Best for |
|---|---|---|---|
| **CLI** | `"cli"` (default) | Spawns `copilot -p` as a new process per request | Simplicity, compatibility |
| **ACP** | `"acp"` | Starts a persistent `copilot --acp` server and communicates via the [Agent Client Protocol](https://agentclientprotocol.com/) (NDJSON over stdio) | Lower latency, persistent sessions without re-spawning |

Both backends support the same feature set (sessions, model switching, permissions, file I/O, abort). The active backend is shown on the startup menu.

**ACP-specific behavior:**
- Sessions persist in-process and are restored via `loadSession` after gateway restart (ACP session IDs are stored in `sessions.json`)
- Permission requests that can't be interactively prompted are rejected in `ask` mode, and the list of blocked tools is included in the response so users can `/allow` them
- Streaming responses arrive via `sessionUpdate` notifications (no progress interval needed)

**CLI-specific behavior:**
- Each request spawns a fresh `copilot -p` process
- Progress updates are sent to the user at the configured `stdoutIntervalSeconds` interval during long-running requests

## Project Structure

```
CopilotCliGateway/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Configuration loading/saving
│   ├── gateway.ts               # Main orchestrator & command handlers
│   ├── menu.ts                  # Interactive startup menu
│   ├── channels/
│   │   ├── channel.ts           # Channel interface & types
│   │   ├── whatsapp/
│   │   │   └── whatsapp-channel.ts
│   │   └── telegram/
│   │       └── telegram-channel.ts
│   └── services/
│       ├── copilot-backend.ts   # ICopilotBackend interface & shared types
│       ├── copilot-cli.ts       # CLI backend (spawn per request)
│       ├── copilot-acp.ts       # ACP backend (persistent server)
│       ├── session-store.ts     # Session persistence (backend-typed, atomic writes)
│       ├── mcp-config.ts        # MCP server discovery
│       └── whisper.ts           # OpenAI Whisper transcription
├── config.example.json          # Configuration template (copy to config.json)
├── instructions.md              # System instructions injected into sessions
├── package.json
└── tsconfig.json
```

## How It Works

1. The gateway starts one or both messaging channels (WhatsApp / Telegram)
2. Incoming messages are filtered by the allowed users/numbers whitelist
3. Voice messages are transcribed via Whisper; images and files are saved to the system temp directory (`%TEMP%/in_<project>/`) with size limits and filename sanitization
4. The message (or transcription) is sent to Copilot via the configured backend:
   - **CLI** spawns `copilot -p` per request, with periodic progress updates sent back to the chat
   - **ACP** uses a persistent `copilot --acp` server over the Agent Client Protocol, streaming responses via session notifications
5. Copilot's response is delivered back to the user in chat, along with any blocked tool notifications (ACP `ask` mode)
6. Any files Copilot saves to `%TEMP%/out_<project>/` are automatically sent to the user
7. Sessions persist across restarts — CLI sessions via session store, ACP sessions via stored session IDs and `loadSession` restoration

## License

[MIT](LICENSE)
