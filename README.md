# CopilotCliGateway

A gateway that bridges [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) to messaging platforms, letting you interact with Copilot from **WhatsApp** and **Telegram**.

Send a message in your chat app, get a response from Copilot — complete with session management, voice transcription, image analysis, interactive menus, and file delivery.

## Features

- **Multi-channel support** — WhatsApp (via Baileys) and Telegram (via grammY), running simultaneously
- **Session management** — Create, switch, and list named sessions; context persists across restarts
- **Per-session working directories** — Each session can target a different project folder
- **Voice messages** — Automatic transcription via OpenAI Whisper, then forwarded to Copilot
- **File input** — Send any file (documents, PDFs, spreadsheets, etc.) to Copilot; files are saved to `%TEMP%/in_<project>/`, images to `%TEMP%/in_<project>/images/`
- **Image input** — Send photos to Copilot for analysis (saved to the system temp input folder, read by Copilot via absolute path)
- **File output** — Copilot saves files to `%TEMP%/out_<project>/` and they're automatically delivered to your chat (images, videos, documents)
- **Model switching** — Change the AI model on the fly with `/model`
- **Permission controls** — Toggle between `ask` and `allow-all` modes; allow or deny specific tools
- **MCP server support** — Automatically discovers configured [MCP servers](https://modelcontextprotocol.io/)
- **Interactive menus** — Telegram inline keyboard buttons for all commands
- **System instructions** — Inject custom instructions from `instructions.md` into every session
- **Abort support** — Stop a long-running Copilot process mid-execution with `/stop`

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/github-copilot-in-the-cli) installed and authenticated (`gh copilot` or standalone `copilot`)
- A Telegram Bot Token (from [@BotFather](https://t.me/BotFather)) and/or a WhatsApp account for QR authentication

## Installation

```bash
git clone https://github.com/fromkoval/CopilotCliGateway.git
cd CopilotCliGateway
npm install
```

## Configuration

Edit `config.json` to set up your channels and services:

```jsonc
{
  "whatsapp": {
    "enabled": true,
    "phoneNumber": "",          // Your WhatsApp phone number
    "allowedNumbers": [],       // Allowed sender IDs (whitelist)
    "authDir": "./auth_state"   // Where auth state is stored
  },
  "telegram": {
    "enabled": true,
    "botToken": "",             // Bot token from @BotFather
    "allowedUsers": []          // Allowed @usernames or user IDs
  },
  "copilot": {
    "timeout": 1200000,         // Max execution time in ms (20 minutes)
    "additionalArgs": [],       // Extra CLI arguments
    "useGh": true               // Use "gh copilot" vs standalone "copilot"
  },
  "openai": {
    "apiKey": "",               // For Whisper voice transcription
    "whisperModel": "whisper-1",
    "language": ""              // Optional language hint for Whisper
  }
}
```

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
│       ├── copilot-cli.ts       # Copilot CLI process management
│       ├── session-store.ts     # Session persistence
│       ├── mcp-config.ts        # MCP server discovery
│       └── whisper.ts           # OpenAI Whisper transcription
├── config.json                  # Runtime configuration
├── instructions.md              # System instructions injected into sessions
├── package.json
└── tsconfig.json
```

## How It Works

1. The gateway starts one or both messaging channels (WhatsApp / Telegram)
2. Incoming messages are filtered by the allowed users/numbers whitelist
3. Voice messages are transcribed via Whisper; images and files are saved to the system temp directory (`%TEMP%/in_<project>/`)
4. The message (or transcription) is sent to Copilot CLI as a prompt via `spawn()`, with absolute file paths included
5. Copilot's response is delivered back to the user in chat
6. Any files Copilot saves to `%TEMP%/out_<project>/` are automatically sent to the user
7. Sessions persist across restarts, so you can pick up where you left off

## License

[MIT](LICENSE)
