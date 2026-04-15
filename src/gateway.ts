import { readdir, readFile, writeFile, unlink, mkdir, access } from "node:fs/promises";
import { resolve, extname, isAbsolute, join, basename, sep } from "node:path";
import { tmpdir } from "node:os";
import type { IChannel, ChannelMessage, MessageButtons } from "./channels/channel.js";
import type { ICopilotBackend } from "./services/copilot-backend.js";
import { type PermissionsMode, fetchAvailableModels } from "./services/copilot-cli.js";
import type { McpServerEntry } from "./services/mcp-config.js";
import type { OpenAIConfig } from "./config.js";
import { transcribe } from "./services/whisper.js";
import type { SessionStore, SessionEntry, BackendType } from "./services/session-store.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);
const TEMP_BASE = tmpdir();

// Security limits
const MAX_PROMPT_LENGTH = 100_000;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25 MB (Whisper API limit)
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB
const LOG_MESSAGE_TRUNCATE = 80;

/** Strip directory components and dangerous characters from user-supplied filenames. */
function sanitizeFilename(name: string): string {
  // Take only the final path component to prevent traversal
  let safe = basename(name);
  // Remove any remaining path separator characters
  safe = safe.replace(/[/\\]/g, "_");
  // Collapse leading dots to prevent hidden files / traversal
  safe = safe.replace(/^\.+/, "");
  return safe || `file-${Date.now()}`;
}

/** Truncate a string for safe logging (avoid leaking full user messages). */
function truncateForLog(text: string, max = LOG_MESSAGE_TRUNCATE): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/** Produce a user-safe error message (no internal paths or stack traces). */
function safeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "An unexpected error occurred.";
  const msg = err.message;
  if (msg.includes("ENOENT")) return "A required file or directory was not found.";
  if (msg.includes("EACCES") || msg.includes("EPERM")) return "Permission denied.";
  if (msg.includes("ENOSPC")) return "No disk space available.";
  if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) return "The operation timed out.";
  if (msg.includes("ECONNREFUSED")) return "Connection refused.";
  // Generic fallback — strip anything that looks like a file path
  const sanitized = msg.replace(/[A-Z]:[\\\/][^\s'",)]+/gi, "[path]")
    .replace(/\/(?:home|usr|tmp|etc|var)[^\s'",)]+/g, "[path]");
  return sanitized.split("\n")[0].slice(0, 200);
}

/** Map common image MIME types to file extensions. */
function extensionFromMimetype(mimetype: string): string {
  const base = mimetype.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
  };
  return map[base] ?? "png";
}

// Sessions are shared across all channels so switching between
// WhatsApp and Telegram continues the same conversation.
const SESSION_KEY = "shared";

export class Gateway {
  private readonly channels: IChannel[];
  private readonly copilot: ICopilotBackend;
  private readonly mcpServers: McpServerEntry[];
  private readonly openaiConfig: OpenAIConfig;
  private readonly sessionStore: SessionStore;
  private readonly backendType: BackendType;
  private readonly showStats: boolean;
  private availableModels: string[] = [];
  private instructions: string | null = null;
  /** Tracks whether the gateway is waiting for the user to provide a working directory. */
  private awaitingDirectory = false;
  /** Path pending user confirmation to create (when the folder doesn't exist). */
  private pendingDirectoryCreate: string | null = null;
  /** Whether a Copilot call is currently in progress. */
  private copilotBusy = false;
  /** Whether the current Copilot call is injecting system instructions (vs. a user prompt). */
  private copilotInitializing = false;
  /** Serialization queue for Copilot calls — ensures one-at-a-time execution. */
  private copilotQueue: Promise<void> = Promise.resolve();
  /** Tools rejected during instruction injection — forwarded to the next user response. */
  private pendingRejectedTools: string[] = [];

  constructor(
    channels: IChannel[],
    copilot: ICopilotBackend,
    mcpServers: McpServerEntry[] = [],
    openaiConfig?: OpenAIConfig,
    sessionStore?: SessionStore,
    backendType: BackendType = "cli",
    showStats = true,
  ) {
    this.channels = channels;
    this.copilot = copilot;
    this.mcpServers = mcpServers;
    this.openaiConfig = openaiConfig ?? { apiKey: "", whisperModel: "whisper-1", language: "" };
    this.sessionStore = sessionStore!;
    this.backendType = backendType;
    this.showStats = showStats;
  }

  /** Resolve the input (upload) directory: %TEMP%/in_<projectFolderName> */
  private inDir(workingDirectory: string): string {
    return join(TEMP_BASE, `in_${basename(workingDirectory)}`);
  }

  /** Resolve the output directory: %TEMP%/out_<projectFolderName> */
  private outDir(workingDirectory: string): string {
    return join(TEMP_BASE, `out_${basename(workingDirectory)}`);
  }

  get openaiEnabled(): boolean {
    return !!this.openaiConfig.apiKey;
  }

  /**
   * Send a message, optionally with inline buttons.
   * Channels that don't support buttons (e.g. WhatsApp) fall back to plain text.
   */
  private async reply(
    channel: IChannel,
    recipientId: string,
    text: string,
    buttons?: MessageButtons,
  ): Promise<void> {
    if (buttons?.length && channel.sendMessageWithButtons) {
      await channel.sendMessageWithButtons(recipientId, text, buttons);
    } else {
      await channel.sendMessage(recipientId, text);
    }
  }

  async start(): Promise<void> {
    // Load available models from Copilot CLI
    this.availableModels = await fetchAvailableModels(this.copilot.useGh);
    if (this.availableModels.length > 0) {
      console.log(`[Gateway] Loaded ${this.availableModels.length} available models from Copilot CLI.`);
    } else {
      console.warn("[Gateway] Could not load models from Copilot CLI. /model validation disabled.");
    }

    for (const channel of this.channels) {
      channel.onMessage((msg) => this.handleMessage(channel, msg));
      await channel.start();
      console.log(`[Gateway] Channel "${channel.name}" started.`);
    }

    // If there is an existing session with a working directory, inject instructions now
    const existingSession = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
    if (existingSession?.workingDirectory) {
      const dirExists = await access(existingSession.workingDirectory).then(() => true, () => false);
      if (dirExists) {
        console.log(`[Gateway] Resuming session "${existingSession.name}" — injecting instructions...`);
        this.instructedSessions.add(existingSession.id);
        const ok = await this.injectInstructions(existingSession);
        if (!ok) {
          // Session is likely stale/expired — create a fresh one with the same working directory
          console.log("[Gateway] Creating fresh session after failed resume...");
          const wd = existingSession.workingDirectory;
          const fresh = await this.sessionStore.createSession(SESSION_KEY, undefined, this.backendType);
          await this.sessionStore.setWorkingDirectory(SESSION_KEY, fresh.id, wd);
          fresh.workingDirectory = wd;
          this.instructedSessions.add(fresh.id);
          await this.injectInstructions(fresh);
        }
      } else {
        console.warn(`[Gateway] Working directory no longer exists: ${existingSession.workingDirectory}`);
        existingSession.workingDirectory = undefined;
        await this.sessionStore.setWorkingDirectory(SESSION_KEY, existingSession.id, undefined);
        this.awaitingDirectory = true;
      }
    }

    console.log("[Gateway] All channels started. Waiting for messages...");
  }

  /** Load instructions.md from disk (once). */
  private async loadInstructions(): Promise<string | null> {
    if (this.instructions !== null) return this.instructions || null;
    const instructionsPath = resolve("./instructions.md");
    try {
      this.instructions = (await readFile(instructionsPath, "utf-8")).trim();
    } catch {
      this.instructions = "";
      console.log("[Gateway] No instructions.md found, skipping instruction injection.");
    }
    return this.instructions || null;
  }

  /** Load cli-instructions.md from the project's working directory (if it exists). */
  private async loadCliInstructions(workingDirectory: string): Promise<string | null> {
    const cliInstructionsPath = join(workingDirectory, "cli-instructions.md");
    try {
      return (await readFile(cliInstructionsPath, "utf-8")).trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Send the contents of instructions.md as the first message in a session
   * so the agent has context about the gateway environment.
   */
  private async injectInstructions(session: SessionEntry): Promise<boolean> {
    let text = await this.loadInstructions();

    // Merge cli-instructions.md from the working directory if present
    if (session.workingDirectory) {
      const cliInstructions = await this.loadCliInstructions(session.workingDirectory);
      if (cliInstructions) {
        text = text
          ? `${text}\n\n---\n\n${cliInstructions}`
          : cliInstructions;
        console.log("[Gateway] Merged cli-instructions.md from working directory.");
      }
    }

    if (!text) return true;

    // Append actual temp folder paths so the agent knows where to read/write files
    if (session.workingDirectory) {
      text += `\n\n## Current Paths\n- File input folder: ${this.inDir(session.workingDirectory)}\n- File output folder: ${this.outDir(session.workingDirectory)}`;
    }

    console.log(`[Gateway] Injecting instructions into session ${session.id}...`);
    this.copilotInitializing = true;
    try {
      const response = await this.copilot.execute(text, session.id, session.workingDirectory, session.acpSessionId);
      // Persist ACP session ID
      if (response.acpSessionId && response.acpSessionId !== session.acpSessionId) {
        await this.sessionStore.setAcpSessionId(SESSION_KEY, session.id, response.acpSessionId);
        session.acpSessionId = response.acpSessionId;
      }
      // Carry over rejected tools so the next user-facing response includes them
      if (response.rejectedTools?.length) {
        this.pendingRejectedTools.push(...response.rejectedTools);
      }
      console.log("[Gateway] Instructions injected successfully.");
      return true;
    } catch (err) {
      console.error("[Gateway] Failed to inject instructions:", err);
      return false;
    } finally {
      this.copilotInitializing = false;
    }
  }

  async stop(): Promise<void> {
    for (const channel of this.channels) {
      await channel.stop();
    }
    console.log("[Gateway] All channels stopped.");
  }

  private async handleMessage(channel: IChannel, msg: ChannelMessage): Promise<void> {
    const sender = msg.senderName ?? msg.senderId;
    console.log(`[Gateway] [${channel.name}] Message from ${sender}: ${truncateForLog(msg.body)}`);

    const trimmed = msg.body.trim();

    // Handle /model command
    if (trimmed.startsWith("/model")) {
      await this.handleModelCommand(channel, msg, trimmed);
      return;
    }

    // Handle /permissions command
    if (trimmed.startsWith("/permissions")) {
      await this.handlePermissionsCommand(channel, msg, trimmed);
      return;
    }

    // Handle /allow command
    if (trimmed.startsWith("/allow")) {
      await this.handleAllowCommand(channel, msg, trimmed);
      return;
    }

    // Handle /deny command
    if (trimmed.startsWith("/deny")) {
      await this.handleDenyCommand(channel, msg, trimmed);
      return;
    }

    // Handle /session command
    if (trimmed.startsWith("/session")) {
      await this.handleSessionCommand(channel, msg, trimmed);
      return;
    }

    // Handle /instructions command
    if (trimmed === "/instructions") {
      await this.handleInstructionsCommand(channel, msg);
      return;
    }

    // Handle /folder command
    if (trimmed.startsWith("/folder")) {
      await this.handleFolderCommand(channel, msg, trimmed);
      return;
    }

    // Handle /stop command
    if (trimmed === "/stop") {
      const wasRunning = this.copilot.abort();
      const stopButtons: MessageButtons = [[{ label: "📋 Menu", callbackData: "/help" }]];
      if (wasRunning) {
        console.log(`[Gateway] [${channel.name}] ${sender} aborted running Copilot process.`);
        await this.reply(channel, msg.senderId, "⛔ Copilot process stopped.", stopButtons);
      } else {
        await this.reply(channel, msg.senderId, "Nothing is running.", stopButtons);
      }
      return;
    }

    // Telegram /start — show help menu instead of ignoring
    if (trimmed === "/start") {
      await this.handleMessage(channel, { ...msg, body: "/help" });
      return;
    }

    // Handle /help command
    if (trimmed === "/help") {
      const lines = [
        "[ Copilot CLI Gateway - Commands ]",
        "",
        "/model — show current model",
        "/model <name> — switch model",
        "",
        "/session — show current session",
        "/session new [name] — start new session",
        "/session list — list all sessions",
        "/session <name> — switch session",
        "",
        "/permissions — show mode & allowed tools",
        "/permissions <mode> — switch mode (ask | allow-all)",
        "",
        "/allow <tool> — pre-approve a tool",
        "/allow reset — clear all allowed/denied tools",
        "/deny <tool> — block a tool",
        "",
        "/folder — show current working directory",
        "/folder <path> — change working directory",
        "",
        "/instructions — re-inject instructions.md and cli-instructions.md into current session",
        "",
        "/stop — abort the currently running Copilot process",
        "",
        "/help — show this help",
        "",
        "Tool examples:",
        "  /allow write",
        "  /allow shell(git:*)",
        "  /allow Read",
        "  /deny shell(rm)",
      ];

      if (this.mcpServers.length > 0) {
        lines.push("");
        lines.push("MCP servers:");
        for (const mcp of this.mcpServers) {
          lines.push(`  • ${mcp.name}`);
        }
        lines.push("");
        lines.push("To allow all tools from an MCP:");
        lines.push("  /allow <ServerName>");
        lines.push("To allow a specific tool:");
        lines.push("  /allow <ServerName>(<tool_name>)");
      }

      lines.push("");
      lines.push("Everything else is forwarded to GitHub Copilot CLI.");

      const buttons: MessageButtons = [
        [
          { label: "📋 Model", callbackData: "/model" },
          { label: "📁 Session", callbackData: "/session" },
        ],
        [
          { label: "🔐 Permissions", callbackData: "/permissions" },
          { label: "📂 Folder", callbackData: "/folder" },
        ],
        [
          { label: "✅ Allow", callbackData: "/allow" },
          { label: "❌ Deny", callbackData: "/deny" },
        ],
        [
          { label: "📝 Instructions", callbackData: "/instructions" },
          { label: "⛔ Stop", callbackData: "/stop" },
        ],
      ];

      await this.reply(channel, msg.senderId, lines.join("\n"), buttons);
      return;
    }

    // Reject new messages while Copilot is busy
    if (this.copilotBusy) {
      const busyMsg = this.copilotInitializing
        ? "⏳ Copilot is initializing the current session, please wait."
        : "⏳ Copilot is busy processing a request. Please wait and re-send your message after receiving a response.";
      await channel.sendMessage(msg.senderId, busyMsg);
      return;
    }

    // Queue Copilot work so prompts are processed one at a time,
    // while commands above execute immediately even during a running call.
    this.copilotQueue = this.copilotQueue.then(() =>
      this.processCopilotMessage(channel, msg, trimmed, sender)
    );
  }

  /**
   * Process a non-command message through Copilot CLI.
   * Always called through the serial queue so only one runs at a time.
   */
  private async processCopilotMessage(
    channel: IChannel,
    msg: ChannelMessage,
    trimmed: string,
    sender: string,
  ): Promise<void> {
    this.copilotBusy = true;
    this.copilotInitializing = false;
    try {
      // Resolve the prompt: transcribe audio or use text body
      let prompt = trimmed;

      if (msg.audio) {
        if (!this.openaiEnabled) {
          await channel.sendMessage(
            msg.senderId,
            "Voice messages are not supported (no OpenAI API key configured).",
          );
          return;
        }

        if (msg.audio.buffer.length > MAX_AUDIO_SIZE) {
          await channel.sendMessage(msg.senderId, `Audio too large (${(msg.audio.buffer.length / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_AUDIO_SIZE / 1024 / 1024} MB.`);
          return;
        }

        console.log(`[Gateway] [Whisper] Transcribing audio (${msg.audio.buffer.length} bytes, ${msg.audio.mimetype})...`);
        await channel.sendTyping?.(msg.senderId);

        const transcription = await transcribe(
          msg.audio.buffer,
          msg.audio.mimetype,
          this.openaiConfig,
        );

        console.log(`[Gateway] [Whisper] Transcription result: ${transcription}`);
        await channel.sendMessage(msg.senderId, `🎤 ${transcription}`);
        prompt = transcription;
      }

      // Handle image messages — save to %TEMP%/in_<project>/images/ so Copilot can read the file
      if (msg.image) {
        if (msg.image.buffer.length > MAX_IMAGE_SIZE) {
          await channel.sendMessage(msg.senderId, `Image too large (${(msg.image.buffer.length / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_IMAGE_SIZE / 1024 / 1024} MB.`);
          return;
        }
        const ext = extensionFromMimetype(msg.image.mimetype);
        const filename = `image-${Date.now()}.${ext}`;

        const peekSession = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
        const workDir = peekSession?.workingDirectory;
        if (!workDir) {
          if (prompt) {
            prompt = `${prompt}\n\n(An image was attached but cannot be processed until a working directory is set.)`;
          }
        } else {
          const imagesPath = join(this.inDir(workDir), "images");
          await mkdir(imagesPath, { recursive: true });
          const filePath = join(imagesPath, filename);
          await writeFile(filePath, msg.image.buffer);
          console.log(`[Gateway] Saved image to ${filePath} (${msg.image.buffer.length} bytes)`);

          if (prompt) {
            prompt = `${prompt}\n\nI've attached an image at ${filePath} — please read and analyze it.`;
          } else {
            prompt = `I've attached an image at ${filePath} — please read and analyze it.`;
          }
        }
      }

      // Handle file messages — save to %TEMP%/in_<project>/ so Copilot can access the file
      if (msg.file) {
        if (msg.file.buffer.length > MAX_FILE_SIZE) {
          await channel.sendMessage(msg.senderId, `File too large (${(msg.file.buffer.length / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_FILE_SIZE / 1024 / 1024} MB.`);
          return;
        }
        const peekSession = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
        const workDir = peekSession?.workingDirectory;
        if (!workDir) {
          if (prompt) {
            prompt = `${prompt}\n\n(A file was attached but cannot be processed until a working directory is set.)`;
          }
        } else {
          const inPath = this.inDir(workDir);
          await mkdir(inPath, { recursive: true });
          const safeFilename = sanitizeFilename(msg.file.filename);
          const filePath = resolve(inPath, safeFilename);
          // Ensure the resolved path is still within the input directory
          if (!filePath.startsWith(inPath + sep)) {
            console.warn(`[Gateway] Blocked path traversal attempt in filename: ${msg.file.filename}`);
          } else {
            await writeFile(filePath, msg.file.buffer);
            console.log(`[Gateway] Saved file to ${filePath} (${msg.file.buffer.length} bytes)`);

            if (prompt) {
              prompt = `${prompt}\n\nI've attached a file at ${filePath} — please read and process it.`;
            } else {
              prompt = `I've attached a file at ${filePath} — please read and process it.`;
            }
          }
        }
      }

      if (!prompt) {
        return;
      }

      // Enforce prompt length limit
      if (prompt.length > MAX_PROMPT_LENGTH) {
        await channel.sendMessage(msg.senderId, `Message too long (${prompt.length} chars). Max: ${MAX_PROMPT_LENGTH.toLocaleString()} chars.`);
        return;
      }

      // Resolve shared session (same session across all channels)
      let session = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
      if (!session) {
        session = await this.sessionStore.createSession(SESSION_KEY, undefined, this.backendType);
        console.log(`[Gateway] Created new session "${session.name}" (${session.id}) for ${sender}`);
      }

      // ── Directory creation confirmation ──
      if (this.pendingDirectoryCreate) {
        await this.handlePendingDirectoryCreate(channel, msg, session, prompt);
        return;
      }

      // ── Working directory setup gate ──
      // If we're waiting for the user to provide a directory path, treat this message as the path.
      if (this.awaitingDirectory) {
        await this.applyWorkingDirectory(channel, msg, session, prompt);
        return;
      }

      // If the session has no working directory, or the directory no longer exists, ask for one.
      if (session.workingDirectory) {
        const dirExists = await access(session.workingDirectory).then(() => true, () => false);
        if (!dirExists) {
          const oldDir = session.workingDirectory;
          session.workingDirectory = undefined;
          await this.sessionStore.setWorkingDirectory(SESSION_KEY, session.id, undefined);
          this.awaitingDirectory = true;
          await channel.sendMessage(msg.senderId, [
            `The working directory no longer exists:`,
            oldDir,
            "",
            "Please provide a new working directory path.",
            "Send the full path (e.g. C:\\Projects\\MyApp or /home/user/myapp).",
          ].join("\n"));
          return;
        }
      }
      if (!session.workingDirectory) {
        this.awaitingDirectory = true;
        await channel.sendMessage(msg.senderId, [
          "Before we start, please provide a working directory path for this session.",
          "",
          "Send the full path (e.g. C:\\Projects\\MyApp or /home/user/myapp).",
        ].join("\n"));
        return;
      }

      // Inject instructions on first Copilot call (session exists but instructions not yet sent)
      await this.ensureInstructionsInjected(session);

      // Respond to the user that we Copilot is working, it may take a bit...
      await channel.sendMessage(msg.senderId, `🤖 processing...`);

      // Show typing indicator
      await channel.sendTyping?.(msg.senderId);

      // Build progress callback for CLI backend (ACP streams natively)
      const onProgress = this.backendType === "cli"
        ? (delta: string) => {
            const progressModel = this.copilot.model ?? "processing";
            const progressHeader = `[ Copilot CLI - ${progressModel} ]`;
            channel.sendMessage(msg.senderId, `${progressHeader}\n\n${delta}`).catch((err) => {
              console.error(`[Gateway] Failed to send progress update: ${err}`);
            });
          }
        : undefined;

      const response = await this.copilot.execute(prompt, session.id, session.workingDirectory, session.acpSessionId, onProgress);

      // Persist ACP session ID so it survives gateway restarts
      if (response.acpSessionId && response.acpSessionId !== session.acpSessionId) {
        await this.sessionStore.setAcpSessionId(SESSION_KEY, session.id, response.acpSessionId);
        session.acpSessionId = response.acpSessionId;
      }

      // Stop typing
      await channel.stopTyping?.(msg.senderId);

      // Collect all rejected tools (from instruction injection + this prompt)
      const allRejected = [...this.pendingRejectedTools, ...(response.rejectedTools ?? [])];
      this.pendingRejectedTools = [];

      // Build response with header
      const modelTag = this.copilot.model ?? "default";
      const header = `[ Copilot CLI - ${modelTag} ]`;
      let fullResponse = header;

      // Append response text if present (skip empty filler)
      if (response.text.trim()) {
        fullResponse += `\n\n${response.text}`;
      }

      if (allRejected.length > 0) {
        const unique = [...new Set(allRejected)];
        const toolList = unique.map((t) => `• ${t}`).join("\n");
        fullResponse += `\n\n⚠️ The following tools were blocked (permissions: ask):\n${toolList}\n\nUse /allow <tool> to grant access, or /permissions allow-all to allow everything.`;
      }

      console.log(`[Gateway] [${channel.name}] Responding to ${sender} (${response.text.length} chars, model: ${modelTag})`);
      await channel.sendMessage(msg.senderId, fullResponse);

      // Send CLI stats as a separate footer message (like the terminal does)
      if (this.showStats && response.stats) {
        await channel.sendMessage(msg.senderId, response.stats);
      }

      // Send any output files the agent saved during this call
      await this.sendOutputFiles(channel, msg.senderId, session.workingDirectory);
    } catch (err) {
      await channel.stopTyping?.(msg.senderId);
      const errorMsg = err instanceof Error ? err.message : String(err);

      // If aborted via /stop, don't send an error — the /stop handler already replied
      if (errorMsg === "ABORTED") {
        console.log(`[Gateway] [${channel.name}] Request from ${sender} was aborted.`);
        return;
      }

      console.error(`[Gateway] Error processing message: ${errorMsg}`);
      await channel.sendMessage(
        msg.senderId,
        `Sorry, an error occurred:\n${safeErrorMessage(err)}`
      );
    } finally {
      this.copilotBusy = false;
      this.copilotInitializing = false;
    }
  }

  /**
   * Validate the path the user sent. If the directory exists, apply it.
   * If it doesn't, ask the user whether to create it.
   */
  private async applyWorkingDirectory(
    channel: IChannel,
    msg: ChannelMessage,
    session: SessionEntry,
    dirPath: string,
  ): Promise<void> {
    const trimmedPath = dirPath.trim();

    if (!trimmedPath) {
      await channel.sendMessage(msg.senderId, "Please send a valid directory path.");
      return;
    }

    const resolvedPath = isAbsolute(trimmedPath) ? resolve(trimmedPath) : resolve(process.cwd(), trimmedPath);

    const exists = await access(resolvedPath).then(() => true, () => false);

    if (!exists) {
      this.pendingDirectoryCreate = resolvedPath;
      await this.reply(channel, msg.senderId, [
        `The folder does not exist:`,
        `${resolvedPath}`,
        "",
        `Would you like to create it? (yes/no)`,
      ].join("\n"), [
        [{ label: "✅ Yes, create it", callbackData: "yes" }, { label: "❌ No", callbackData: "no" }],
      ]);
      return;
    }

    await this.commitWorkingDirectory(channel, msg, session, resolvedPath, true);
  }

  /**
   * Handle the user's yes/no response to the pending directory creation prompt.
   */
  private async handlePendingDirectoryCreate(
    channel: IChannel,
    msg: ChannelMessage,
    session: SessionEntry,
    answer: string,
  ): Promise<void> {
    const resolvedPath = this.pendingDirectoryCreate!;
    const normalized = answer.trim().toLowerCase();

    if (normalized === "yes" || normalized === "y") {
      this.pendingDirectoryCreate = null;
      try {
        await mkdir(resolvedPath, { recursive: true });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await channel.sendMessage(msg.senderId, `Failed to create directory:\n${errMsg}\n\nPlease send a different path.`);
        return;
      }
      await this.commitWorkingDirectory(channel, msg, session, resolvedPath, this.awaitingDirectory);
    } else if (normalized === "no" || normalized === "n") {
      this.pendingDirectoryCreate = null;
      await channel.sendMessage(msg.senderId, "OK, directory not created. Please send a different path.");
    } else {
      await this.reply(channel, msg.senderId, `Please reply yes or no. Create folder?\n${resolvedPath}`, [
        [{ label: "✅ Yes, create it", callbackData: "yes" }, { label: "❌ No", callbackData: "no" }],
      ]);
    }
  }

  /**
   * Finalize the working directory — ensure temp folders exist, persist on session,
   * and optionally inject instructions.
   */
  private async commitWorkingDirectory(
    channel: IChannel,
    msg: ChannelMessage,
    session: SessionEntry,
    resolvedPath: string,
    injectInstructions: boolean,
  ): Promise<void> {
    try {
      await mkdir(this.inDir(resolvedPath), { recursive: true });
      await mkdir(this.outDir(resolvedPath), { recursive: true });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await channel.sendMessage(msg.senderId, `Failed to create temp directories:\n${errMsg}`);
      return;
    }

    await this.sessionStore.setWorkingDirectory(SESSION_KEY, session.id, resolvedPath);
    session.workingDirectory = resolvedPath;
    this.awaitingDirectory = false;

    console.log(`[Gateway] Working directory set to: ${resolvedPath}`);

    if (injectInstructions) {
      this.instructedSessions.add(session.id);
      await this.injectInstructions(session);
    }

    await channel.sendMessage(msg.senderId, [
      `Working directory set to:\n${resolvedPath}`,
      "",
      "You can now send messages to GitHub Copilot CLI.",
      "Use /folder to view or change the directory later.",
    ].join("\n"));
  }

  /** Track which sessions have already had instructions injected. */
  private instructedSessions = new Set<string>();

  private async ensureInstructionsInjected(session: SessionEntry): Promise<void> {
    if (this.instructedSessions.has(session.id)) return;
    this.instructedSessions.add(session.id);
    await this.injectInstructions(session);
  }

  // ── output files ──

  /**
   * Send all files found in the outputs directory via the channel,
   * then delete them. Supports images, videos, and generic documents.
   */
  private async sendOutputFiles(
    channel: IChannel,
    recipientId: string,
    workingDirectory: string,
  ): Promise<void> {
    const dir = this.outDir(workingDirectory);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }

    const files = entries.filter((f) => !f.startsWith(".")).sort();
    if (files.length === 0) return;

    for (const file of files) {
      const filePath = resolve(dir, file);
      // Prevent path traversal — ensure file stays within the outputs directory
      if (!filePath.startsWith(dir + sep)) {
        console.warn(`[Gateway] Blocked path traversal in output file: ${file}`);
        continue;
      }
      const ext = extname(file).toLowerCase();
      try {
        const buffer = await readFile(filePath);
        console.log(`[Gateway] [${channel.name}] Sending output file to ${recipientId}: ${file} (${buffer.length} bytes)`);

        if (IMAGE_EXTENSIONS.has(ext)) {
          await channel.sendImage(recipientId, buffer, file);
        } else if (VIDEO_EXTENSIONS.has(ext) && channel.sendVideo) {
          await channel.sendVideo(recipientId, buffer, file);
        } else if (channel.sendFile) {
          await channel.sendFile(recipientId, buffer, file);
        } else {
          // Fallback: notify user the file type isn't supported for delivery
          await channel.sendMessage(recipientId, `📎 File generated: ${file} (${buffer.length} bytes) — file type not supported for delivery on this channel.`);
        }

        console.log(`[Gateway] [${channel.name}] Output file delivered: ${file}`);
        await unlink(filePath);
      } catch (err) {
        console.error(`[Gateway] Failed to send output file ${file}:`, err);
      }
    }
  }

  // ── /instructions ──

  private async handleInstructionsCommand(channel: IChannel, msg: ChannelMessage): Promise<void> {
    let session = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
    if (!session) {
      session = await this.sessionStore.createSession(SESSION_KEY, undefined, this.backendType);
    }

    // Force re-read from disk so edits are picked up
    this.instructions = null;

    const baseText = await this.loadInstructions();
    const cliText = session.workingDirectory
      ? await this.loadCliInstructions(session.workingDirectory)
      : null;

    if (!baseText && !cliText) {
      await channel.sendMessage(msg.senderId, "No instructions.md or cli-instructions.md found.");
      return;
    }

    await channel.sendMessage(msg.senderId, "Injecting instructions...");
    await this.injectInstructions(session);
    await this.reply(channel, msg.senderId, "Instructions injected into current session.", [
      [{ label: "📋 Menu", callbackData: "/help" }],
    ]);
  }

  // ── /folder ──

  private async handleFolderCommand(channel: IChannel, msg: ChannelMessage, text: string): Promise<void> {
    const arg = text.slice("/folder".length).trim();

    const session = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);

    // /folder — show current directory
    if (!arg) {
      const folderButtons: MessageButtons = [
        [{ label: "📋 Menu", callbackData: "/help" }],
      ];
      if (!session?.workingDirectory) {
        await this.reply(channel, msg.senderId, [
          "No working directory set for the current session.",
          "",
          "Send /folder <path> to set one.",
        ].join("\n"), folderButtons);
      } else {
        await this.reply(channel, msg.senderId, `Current working directory:\n${session.workingDirectory}`, folderButtons);
      }
      return;
    }

    // /folder <path> — change directory
    if (!session) {
      await channel.sendMessage(msg.senderId, "No active session. Send any message first to start one.");
      return;
    }

    const resolvedPath = isAbsolute(arg) ? resolve(arg) : resolve(process.cwd(), arg);

    const exists = await access(resolvedPath).then(() => true, () => false);

    if (!exists) {
      this.pendingDirectoryCreate = resolvedPath;
      await this.reply(channel, msg.senderId, [
        `The folder does not exist:`,
        `${resolvedPath}`,
        "",
        `Would you like to create it? (yes/no)`,
      ].join("\n"), [
        [{ label: "✅ Yes, create it", callbackData: "yes" }, { label: "❌ No", callbackData: "no" }],
      ]);
      return;
    }

    try {
      await mkdir(this.inDir(resolvedPath), { recursive: true });
      await mkdir(this.outDir(resolvedPath), { recursive: true });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await channel.sendMessage(msg.senderId, `Failed to create temp directories:\n${errMsg}`);
      return;
    }

    await this.sessionStore.setWorkingDirectory(SESSION_KEY, session.id, resolvedPath);
    session.workingDirectory = resolvedPath;
    this.awaitingDirectory = false;

    console.log(`[Gateway] Working directory changed to: ${resolvedPath}`);
    await this.reply(channel, msg.senderId, `Working directory changed to:\n${resolvedPath}`, [
      [{ label: "📂 Folder", callbackData: "/folder" }, { label: "📋 Menu", callbackData: "/help" }],
    ]);
  }

  // ── /model ──

  private async handleModelCommand(channel: IChannel, msg: ChannelMessage, text: string): Promise<void> {
    const parts = text.split(/\s+/);
    const requestedModel = parts[1];

    // No argument — show current model and list available ones
    if (!requestedModel) {
      const current = this.copilot.model ?? "default (set by Copilot CLI)";
      const modelButtons: MessageButtons = [];
      // Arrange models in rows of 2
      for (let i = 0; i < this.availableModels.length; i += 2) {
        const row = [{ label: this.availableModels[i], callbackData: `/model ${this.availableModels[i]}` }];
        if (i + 1 < this.availableModels.length) {
          row.push({ label: this.availableModels[i + 1], callbackData: `/model ${this.availableModels[i + 1]}` });
        }
        modelButtons.push(row);
      }
      modelButtons.push([{ label: "↩️ Default", callbackData: "/model default" }]);
      modelButtons.push([{ label: "📋 Menu", callbackData: "/help" }]);

      await this.reply(channel, msg.senderId, [
        `Current model: ${current}`,
        "",
        "Available models:",
        ...this.availableModels.map((m) => `  • ${m}`),
      ].join("\n"), modelButtons);
      return;
    }

    // Reset to default
    if (requestedModel === "default") {
      this.copilot.model = null;
      console.log(`[Gateway] Model reset to CLI default`);
      await this.reply(channel, msg.senderId, "Model reset to CLI default.", [
        [{ label: "📋 Model", callbackData: "/model" }, { label: "📋 Menu", callbackData: "/help" }],
      ]);
      return;
    }

    // Validate model name (skip if models couldn't be loaded)
    if (this.availableModels.length > 0 && !this.availableModels.includes(requestedModel)) {
      const modelButtons: MessageButtons = [];
      for (let i = 0; i < this.availableModels.length; i += 2) {
        const row = [{ label: this.availableModels[i], callbackData: `/model ${this.availableModels[i]}` }];
        if (i + 1 < this.availableModels.length) {
          row.push({ label: this.availableModels[i + 1], callbackData: `/model ${this.availableModels[i + 1]}` });
        }
        modelButtons.push(row);
      }
      await this.reply(channel, msg.senderId, [
        `Unknown model: ${requestedModel}`,
        "",
        "Available models:",
        ...this.availableModels.map((m) => `  • ${m}`),
      ].join("\n"), modelButtons);
      return;
    }

    this.copilot.model = requestedModel;
    console.log(`[Gateway] Model changed to: ${requestedModel}`);
    await this.reply(channel, msg.senderId, `Model changed to: ${requestedModel}`, [
      [{ label: "📋 Model", callbackData: "/model" }, { label: "📋 Menu", callbackData: "/help" }],
    ]);
  }

  // ── /permissions ──

  private async handlePermissionsCommand(channel: IChannel, msg: ChannelMessage, text: string): Promise<void> {
    const AVAILABLE_MODES: PermissionsMode[] = ["ask", "allow-all"];
    const parts = text.split(/\s+/);
    const requestedMode = parts[1];

    // No argument — show current mode + tool lists
    if (!requestedMode) {
      const allowed = this.copilot.allowedTools;
      const denied = this.copilot.deniedTools;

      const lines = [
        `Current permissions mode: ${this.copilot.permissions}`,
      ];

      if (this.copilot.permissions === "ask") {
        lines.push("");
        if (allowed.length > 0) {
          lines.push("Allowed tools:");
          for (const t of allowed) lines.push(`  ✅ ${t}`);
        } else {
          lines.push("No tools pre-approved (all will be denied).");
        }
        if (denied.length > 0) {
          lines.push("");
          lines.push("Denied tools:");
          for (const t of denied) lines.push(`  ❌ ${t}`);
        }
        lines.push("");
        lines.push("Use /allow <tool> or /deny <tool> to configure.");
      }

      const permButtons: MessageButtons = [
        [
          { label: "🔒 ask", callbackData: "/permissions ask" },
          { label: "🔓 allow-all", callbackData: "/permissions allow-all" },
        ],
        [{ label: "📋 Menu", callbackData: "/help" }],
      ];

      await this.reply(channel, msg.senderId, lines.join("\n"), permButtons);
      return;
    }

    if (!AVAILABLE_MODES.includes(requestedMode as PermissionsMode)) {
      await this.reply(channel, msg.senderId, [
        `Unknown mode: ${requestedMode}`,
        "",
        "Available modes:",
        "  • ask — selective tool approval",
        "  • allow-all — all tools allowed automatically",
      ].join("\n"), [
        [
          { label: "🔒 ask", callbackData: "/permissions ask" },
          { label: "🔓 allow-all", callbackData: "/permissions allow-all" },
        ],
      ]);
      return;
    }

    this.copilot.permissions = requestedMode as PermissionsMode;
    console.log(`[Gateway] Permissions mode changed to: ${requestedMode}`);
    await this.reply(channel, msg.senderId, `Permissions mode changed to: ${requestedMode}`, [
      [{ label: "🔐 Permissions", callbackData: "/permissions" }, { label: "📋 Menu", callbackData: "/help" }],
    ]);
  }

  // ── /allow ──

  private async handleAllowCommand(channel: IChannel, msg: ChannelMessage, text: string): Promise<void> {
    const arg = text.slice("/allow".length).trim();

    if (!arg) {
      const allowed = this.copilot.allowedTools;
      const isAllowAll = this.copilot.permissions === "allow-all";
      const allowButtons: MessageButtons = [
        [{ label: "🔄 Reset All", callbackData: "/allow reset" }],
        [{ label: "📋 Menu", callbackData: "/help" }],
      ];
      if (isAllowAll) {
        await this.reply(channel, msg.senderId, [
          "Permissions mode is allow-all — all tools are allowed automatically.",
          "",
          "Switch to ask mode to manage individual tools:",
          "  /permissions ask",
        ].join("\n"), [
          [{ label: "🔒 Switch to ask", callbackData: "/permissions ask" }],
          [{ label: "📋 Menu", callbackData: "/help" }],
        ]);
      } else if (allowed.length === 0) {
        await this.reply(channel, msg.senderId, [
          "No tools currently allowed.",
          "",
          "Usage: /allow <tool>",
          "Examples:",
          "  /allow write",
          "  /allow shell(git:*)",
          "  /allow Read",
        ].join("\n"), allowButtons);
      } else {
        await this.reply(channel, msg.senderId, [
          "Allowed tools:",
          ...allowed.map((t) => `  ✅ ${t}`),
          "",
          "Send /allow <tool> to add more.",
        ].join("\n"), allowButtons);
      }
      return;
    }

    // Reset all
    if (arg === "reset") {
      this.copilot.resetToolLists();
      console.log(`[Gateway] Tool allow/deny lists cleared`);
      await this.reply(channel, msg.senderId, "Tool allow/deny lists cleared.", [
        [{ label: "✅ Allow", callbackData: "/allow" }, { label: "📋 Menu", callbackData: "/help" }],
      ]);
      return;
    }

    this.copilot.addAllowedTool(arg);
    console.log(`[Gateway] Tool allowed: ${arg}`);
    await this.reply(channel, msg.senderId, `✅ Tool allowed: ${arg}`, [
      [{ label: "✅ Allow", callbackData: "/allow" }, { label: "📋 Menu", callbackData: "/help" }],
    ]);
  }

  // ── /deny ──

  private async handleDenyCommand(channel: IChannel, msg: ChannelMessage, text: string): Promise<void> {
    const arg = text.slice("/deny".length).trim();

    if (!arg) {
      const denied = this.copilot.deniedTools;
      const isAllowAll = this.copilot.permissions === "allow-all";
      const denyButtons: MessageButtons = [
        [{ label: "🔄 Reset All", callbackData: "/allow reset" }],
        [{ label: "📋 Menu", callbackData: "/help" }],
      ];
      if (isAllowAll) {
        await this.reply(channel, msg.senderId, [
          "Permissions mode is allow-all — no tools are denied.",
          "",
          "Switch to ask mode to manage individual tools:",
          "  /permissions ask",
        ].join("\n"), [
          [{ label: "🔒 Switch to ask", callbackData: "/permissions ask" }],
          [{ label: "📋 Menu", callbackData: "/help" }],
        ]);
      } else if (denied.length === 0) {
        await this.reply(channel, msg.senderId, [
          "No tools currently denied.",
          "",
          "Usage: /deny <tool>",
          "Examples:",
          "  /deny shell(rm)",
          "  /deny shell(git push)",
        ].join("\n"), denyButtons);
      } else {
        await this.reply(channel, msg.senderId, [
          "Denied tools:",
          ...denied.map((t) => `  ❌ ${t}`),
          "",
          "Send /deny <tool> to add more.",
        ].join("\n"), denyButtons);
      }
      return;
    }

    this.copilot.addDeniedTool(arg);
    console.log(`[Gateway] Tool denied: ${arg}`);
    await this.reply(channel, msg.senderId, `❌ Tool denied: ${arg}`, [
      [{ label: "❌ Deny", callbackData: "/deny" }, { label: "📋 Menu", callbackData: "/help" }],
    ]);
  }

  // ── /session ──

  private async handleSessionCommand(channel: IChannel, msg: ChannelMessage, text: string): Promise<void> {
    const arg = text.slice("/session".length).trim();

    // /session — show current session
    if (!arg) {
      const session = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
      const sessionButtons: MessageButtons = [
        [
          { label: "📋 List Sessions", callbackData: "/session list" },
          { label: "➕ New Session", callbackData: "/session new" },
        ],
        [{ label: "📋 Menu", callbackData: "/help" }],
      ];
      if (!session) {
        await this.reply(channel, msg.senderId, [
          "No active session.",
          "",
          "Send any message to start a new session.",
        ].join("\n"), sessionButtons);
      } else {
        const created = new Date(session.createdAt).toLocaleString();
        const dir = session.workingDirectory ?? "(not set)";
        await this.reply(channel, msg.senderId, [
          `Active session: ${session.name}`,
          `ID: ${session.id}`,
          `Created: ${created}`,
          `Working directory: ${dir}`,
        ].join("\n"), sessionButtons);
      }
      return;
    }

    // /session new [name]
    if (arg === "new" || arg.startsWith("new ")) {
      const name = arg.slice("new".length).trim() || undefined;
      const session = await this.sessionStore.createSession(SESSION_KEY, name, this.backendType);
      this.awaitingDirectory = false;
      console.log(`[Gateway] New session "${session.name}" (${session.id}) for ${msg.senderName ?? msg.senderId}`);

      await this.reply(channel, msg.senderId, [
        `New session created: ${session.name}`,
        `ID: ${session.id}`,
        "",
        "Please send a working directory path to start using Copilot.",
      ].join("\n"), [
        [{ label: "📁 Session", callbackData: "/session" }, { label: "📋 Menu", callbackData: "/help" }],
      ]);
      return;
    }

    // /session list
    if (arg === "list") {
      const sessions = this.sessionStore.getAllSessions(SESSION_KEY, this.backendType);
      if (sessions.length === 0) {
        await this.reply(channel, msg.senderId, [
          "No sessions yet.",
          "",
          "Send any message to start one.",
        ].join("\n"), [
          [{ label: "➕ New Session", callbackData: "/session new" }],
          [{ label: "📋 Menu", callbackData: "/help" }],
        ]);
        return;
      }

      const active = this.sessionStore.getActiveSession(SESSION_KEY, this.backendType);
      const lines = ["Your sessions:"];
      for (const s of sessions) {
        const marker = s.id === active?.id ? " [active]" : "";
        const prefix = s.id === active?.id ? "►" : " ";
        const created = new Date(s.createdAt).toLocaleString();
        lines.push(`  ${prefix} ${s.name}  (${s.id.slice(0, 6)}...) — ${created}${marker}`);
      }

      // Build buttons for each session (rows of 2) + new session
      const listButtons: MessageButtons = [];
      for (let i = 0; i < sessions.length; i += 2) {
        const row = [{ label: sessions[i].id === active?.id ? `► ${sessions[i].name}` : sessions[i].name, callbackData: `/session ${sessions[i].name}` }];
        if (i + 1 < sessions.length) {
          row.push({ label: sessions[i + 1].id === active?.id ? `► ${sessions[i + 1].name}` : sessions[i + 1].name, callbackData: `/session ${sessions[i + 1].name}` });
        }
        listButtons.push(row);
      }
      listButtons.push([{ label: "➕ New Session", callbackData: "/session new" }]);
      listButtons.push([{ label: "📋 Menu", callbackData: "/help" }]);

      await this.reply(channel, msg.senderId, lines.join("\n"), listButtons);
      return;
    }

    // /session <name-or-id> — switch to existing session
    const session = await this.sessionStore.setActiveSession(SESSION_KEY, arg, this.backendType);
    if (!session) {
      await this.reply(channel, msg.senderId, [
        `No session found matching: ${arg}`,
      ].join("\n"), [
        [{ label: "📋 List Sessions", callbackData: "/session list" }],
        [{ label: "📋 Menu", callbackData: "/help" }],
      ]);
      return;
    }

    this.awaitingDirectory = false;
    console.log(`[Gateway] Switched to session "${session.name}" (${session.id}) for ${msg.senderName ?? msg.senderId}`);

    const dirInfo = session.workingDirectory
      ? `Working directory: ${session.workingDirectory}`
      : "No working directory set — send a path to start using Copilot.";

    await this.reply(channel, msg.senderId, [
      `Switched to session: ${session.name} (${session.id.slice(0, 8)}...)`,
      dirInfo,
    ].join("\n"), [
      [{ label: "📁 Session", callbackData: "/session" }, { label: "📋 Menu", callbackData: "/help" }],
    ]);
  }
}
