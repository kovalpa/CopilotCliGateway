import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { normalizePath, type ICopilotBackend, type CopilotResponse, type PermissionsMode, type ProgressCallback } from "./copilot-backend.js";

export interface CopilotAcpOptions {
  timeout: number;
  additionalArgs: string[];
  workingDirectory?: string;
  useGh?: boolean;
  /** Initial user-selected model. Null = use Copilot's default. */
  model?: string | null;
  /** Initial permission mode (defaults to "ask"). */
  permissions?: PermissionsMode;
  /** Initial allowed tools (used when permissions mode is "ask"). */
  allowedTools?: string[];
  /** Initial denied tools (always enforced, takes precedence over allowed). */
  deniedTools?: string[];
}

/**
 * ACP backend — spawns `copilot --acp` as a long-running subprocess
 * and communicates via the Agent Client Protocol (NDJSON over stdio).
 *
 * Benefits over the CLI backend:
 * - Persistent process (no spawn-per-request overhead)
 * - Structured streaming responses
 * - Native session management via the protocol
 */
export class CopilotAcpService implements ICopilotBackend {
  private readonly timeout: number;
  private readonly additionalArgs: string[];
  readonly useGh: boolean;
  readonly workingDirectory: string | undefined;

  private _model: string | null = null;
  private _permissions: PermissionsMode = "ask";
  private _allowedTools: string[] = [];
  private _deniedTools: string[] = [];

  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  /** ACP session IDs mapped from our gateway session IDs. */
  private acpSessions = new Map<string, string>();
  private _busy = false;
  private cancelSessionId: string | null = null;
  /** Accumulated response text chunks from sessionUpdate notifications. */
  private _responseChunks: string[] = [];
  /** Model ID reported by the ACP server. */
  private _reportedModel: string | null = null;
  /** Tools rejected during the current execution (for user feedback). */
  private _rejectedTools: Set<string> = new Set();

  constructor(options: CopilotAcpOptions) {
    this.timeout = options.timeout;
    this.additionalArgs = options.additionalArgs;
    this.useGh = options.useGh ?? false;
    this.workingDirectory = options.workingDirectory || undefined;
    if (options.model) this._model = options.model;
    if (options.permissions) this._permissions = options.permissions;
    if (options.allowedTools) this._allowedTools = [...options.allowedTools];
    if (options.deniedTools) this._deniedTools = [...options.deniedTools];
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    if (this.connection) return;

    const args = [
      ...(this.useGh ? ["copilot", "--"] : []),
      "--acp",
      ...this.additionalArgs,
    ];

    const command = this.useGh ? "gh" : "copilot";

    console.log(`[ACP] Starting: ${command} ${args.join(" ")}`);

    this.child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: normalizePath(this.workingDirectory),
      env: { ...process.env },
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[ACP stderr] ${line}`);
    });

    this.child.on("exit", (code, signal) => {
      console.log(`[ACP] Process exited (code=${code}, signal=${signal})`);
      this.connection = null;
      this.child = null;
    });

    // Create NDJSON streams over stdio
    const input = Writable.toWeb(this.child.stdin!) as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.child.stdout!) as ReadableStream<Uint8Array>;

    const stream = ndJsonStream(input, output);

    // Accumulated response text for the current prompt
    this._responseChunks = [];

    const self = this;

    const client = {
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const toolName = params.toolCall.title ?? "";

        // Check denied list first — always reject denied tools
        if (self._deniedTools.some((t) => toolName.includes(t))) {
          const rejectOption = params.options.find((o) => o.kind === "reject_always")
            ?? params.options.find((o) => o.kind === "reject_once")
            ?? params.options[0];
          console.log(`[ACP] Permission denied for: ${toolName}`);
          return { outcome: { outcome: "selected" as const, optionId: rejectOption.optionId } };
        }

        // allow-all mode or tool is in the allowed list — approve
        if (self._permissions === "allow-all"
          || self._allowedTools.some((t) => toolName.includes(t))) {
          const allowOption = params.options.find((o) => o.kind === "allow_always")
            ?? params.options.find((o) => o.kind === "allow_once")
            ?? params.options[0];
          return { outcome: { outcome: "selected" as const, optionId: allowOption.optionId } };
        }

        // ask mode, tool not in either list — reject (can't prompt user mid-execution)
        const rejectUnknown = params.options.find((o) => o.kind === "reject_once")
          ?? params.options.find((o) => o.kind === "reject_always")
          ?? params.options[0];
        console.log(`[ACP] Permission rejected (ask mode, not in allowed list): ${toolName}`);
        if (toolName) self._rejectedTools.add(toolName);
        return { outcome: { outcome: "selected" as const, optionId: rejectUnknown.optionId } };
      },

      async sessionUpdate(params: SessionNotification): Promise<void> {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          if (update.content.type === "text") {
            self._responseChunks.push(update.content.text);
          }
        } else if (update.sessionUpdate === "tool_call") {
          console.log(`[ACP] Tool call: ${update.title} (${update.status})`);
        } else if (update.sessionUpdate === "tool_call_update") {
          console.log(`[ACP] Tool update: ${update.toolCallId} → ${update.status}`);
        }
      },

      async writeTextFile(_params: WriteTextFileRequest): Promise<WriteTextFileResponse> { return {}; },
      async readTextFile(_params: ReadTextFileRequest): Promise<ReadTextFileResponse> { return { content: "" }; },
    };

    this.connection = new ClientSideConnection(() => client, stream);

    // Initialize the ACP connection
    const initResult = await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    console.log(`[ACP] Connected (protocol v${initResult.protocolVersion})`);
  }

  async stop(): Promise<void> {
    if (this.child) {
      console.log("[ACP] Stopping...");
      this.child.kill("SIGTERM");
      setTimeout(() => {
        try { this.child?.kill("SIGKILL"); } catch { /* already dead */ }
      }, 2000);
      this.child = null;
      this.connection = null;
    }
  }

  // ── execution ──

  get isRunning(): boolean {
    return this._busy;
  }

  abort(): boolean {
    if (!this._busy || !this.connection || !this.cancelSessionId) return false;
    console.log("[ACP] Aborting current prompt...");
    this.connection.cancel({ sessionId: this.cancelSessionId });
    return true;
  }

  async execute(prompt: string, sessionId?: string, cwd?: string, acpSessionId?: string, _onProgress?: ProgressCallback): Promise<CopilotResponse> {
    if (!this.connection) {
      throw new Error("ACP backend not started. Call start() first.");
    }

    this._busy = true;

    // Reset response accumulator and rejected tools tracker
    this._responseChunks.length = 0;
    this._rejectedTools.clear();

    try {
      // Get or create ACP session for this gateway session
      const resolvedAcpSessionId = await this.getOrCreateSession(sessionId ?? "default", cwd, acpSessionId);
      this.cancelSessionId = resolvedAcpSessionId;

      // Set model if configured
      if (this._model) {
        try {
          await this.connection.unstable_setSessionModel({
            sessionId: resolvedAcpSessionId,
            model: this._model,
          });
        } catch {
          // Model setting may not be supported — continue anyway
          console.log(`[ACP] Could not set model to ${this._model}, continuing with default.`);
        }
      }

      // Send prompt with timeout
      const promptPromise = this.connection.prompt({
        sessionId: resolvedAcpSessionId,
        prompt: [{ type: "text", text: prompt }],
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`ACP prompt timed out after ${Math.round(this.timeout / 1000)} seconds.`)), this.timeout);
      });

      const result = await Promise.race([promptPromise, timeoutPromise]);

      const text = this._responseChunks.join("").trim();

      if (result.stopReason === "cancelled") {
        throw new Error("ABORTED");
      }

      return {
        text: text || "(No response from Copilot ACP)",
        model: this._model ?? this._reportedModel,
        acpSessionId: resolvedAcpSessionId,
        rejectedTools: this._rejectedTools.size > 0 ? [...this._rejectedTools] : undefined,
      };
    } finally {
      this._busy = false;
      this.cancelSessionId = null;
    }
  }

  private async getOrCreateSession(gatewaySessionId: string, cwd?: string, storedAcpSessionId?: string): Promise<string> {
    // ACP sessions stay alive for the lifetime of the process — just reuse the ID
    const existing = this.acpSessions.get(gatewaySessionId);
    if (existing) return existing;

    const workDir = normalizePath(cwd ?? this.workingDirectory ?? process.cwd())!;

    // Try to restore a previous session from disk (survives gateway restarts)
    if (storedAcpSessionId) {
      try {
        const loaded = await this.connection!.loadSession({
          sessionId: storedAcpSessionId,
          cwd: workDir,
          mcpServers: [],
        });
        if (loaded.models?.currentModelId) {
          this._reportedModel = loaded.models.currentModelId;
        }
        console.log(`[ACP] Loaded previous session: ${storedAcpSessionId} (gateway: ${gatewaySessionId.slice(0, 8)}...)`);
        this.acpSessions.set(gatewaySessionId, storedAcpSessionId);
        return storedAcpSessionId;
      } catch (err) {
        console.log(`[ACP] Could not load session ${storedAcpSessionId}, creating new.`);
      }
    }

    const result = await this.connection!.newSession({
      cwd: workDir,
      mcpServers: [],
    });

    // Capture the model reported by the server
    if (result.models?.currentModelId) {
      this._reportedModel = result.models.currentModelId;
      console.log(`[ACP] Model: ${this._reportedModel}`);
    }

    console.log(`[ACP] Created session: ${result.sessionId} (gateway: ${gatewaySessionId.slice(0, 8)}...)`);
    this.acpSessions.set(gatewaySessionId, result.sessionId);
    return result.sessionId;
  }

  // ── model ──

  get model(): string | null {
    // User override takes precedence; otherwise fall back to whatever the
    // ACP server reported via newSession / loadSession / setSessionModel.
    return this._model ?? this._reportedModel;
  }
  set model(value: string | null) { this._model = value; }
  /** Only the user override — excludes server-reported fallback so persistence doesn't pin observed defaults. */
  get selectedModel(): string | null { return this._model; }

  // ── permissions ──

  get permissions(): PermissionsMode { return this._permissions; }
  set permissions(value: PermissionsMode) { this._permissions = value; }

  get allowedTools(): readonly string[] { return this._allowedTools; }
  get deniedTools(): readonly string[] { return this._deniedTools; }

  addAllowedTool(tool: string): boolean {
    const normalized = tool.trim();
    if (!normalized) return false;
    this._deniedTools = this._deniedTools.filter((t) => t !== normalized);
    if (!this._allowedTools.includes(normalized)) {
      this._allowedTools.push(normalized);
    }
    return true;
  }

  removeAllowedTool(tool: string): boolean {
    const normalized = tool.trim();
    const before = this._allowedTools.length;
    this._allowedTools = this._allowedTools.filter((t) => t !== normalized);
    return this._allowedTools.length < before;
  }

  addDeniedTool(tool: string): boolean {
    const normalized = tool.trim();
    if (!normalized) return false;
    this._allowedTools = this._allowedTools.filter((t) => t !== normalized);
    if (!this._deniedTools.includes(normalized)) {
      this._deniedTools.push(normalized);
    }
    return true;
  }

  removeDeniedTool(tool: string): boolean {
    const normalized = tool.trim();
    const before = this._deniedTools.length;
    this._deniedTools = this._deniedTools.filter((t) => t !== normalized);
    return this._deniedTools.length < before;
  }

  resetToolLists(): void {
    this._allowedTools = [];
    this._deniedTools = [];
  }
}
