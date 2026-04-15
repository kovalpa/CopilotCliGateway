import { spawn, execFile, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { normalizePath, type ICopilotBackend, type CopilotResponse, type PermissionsMode, type ProgressCallback } from "./copilot-backend.js";

export type { CopilotResponse, PermissionsMode, ProgressCallback };

export interface CopilotCliOptions {
  timeout: number;
  additionalArgs: string[];
  workingDirectory?: string;
  /** If true, use "gh copilot" instead of "copilot" directly. */
  useGh?: boolean;
  /** Interval in seconds to send stdout progress updates. 0 disables. */
  stdoutIntervalSeconds?: number;
}

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}



/**
 * Read the current model from ~/.copilot/config.json (if configured).
 * Returns null if no model is explicitly set (Copilot uses its server default).
 */
async function detectConfiguredModel(): Promise<string | null> {
  try {
    const configPath = join(homedir(), ".copilot", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    return typeof config.model === "string" ? config.model : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the list of available models by parsing `copilot help config`.
 */
export function fetchAvailableModels(useGh = false): Promise<string[]> {
  const command = useGh ? "gh" : "copilot";
  const args = useGh ? ["copilot", "--", "help", "config"] : ["--", "help", "config"];
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn("[Gateway] Failed to fetch models from Copilot CLI:", err.message);
        resolve([]);
        return;
      }

      const output = stdout || stderr;
      // Find the `model` section and extract quoted model names
      const modelSection = output.match(/`model`[\s\S]*?(?=\n\n {2}`|\n\nHelp Topics:)/);
      if (!modelSection) {
        console.warn("[Gateway] Could not find model section in Copilot CLI help output.");
        resolve([]);
        return;
      }

      const models = [...modelSection[0].matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
      resolve(models);
    });
  });
}

export class CopilotCliService implements ICopilotBackend {
  private readonly timeout: number;
  private readonly additionalArgs: string[];
  readonly useGh: boolean;
  readonly workingDirectory: string | undefined;
  readonly stdoutIntervalSeconds: number;
  private _model: string | null = null;
  private _permissions: PermissionsMode = "ask";
  private _allowedTools: string[] = [];
  private _deniedTools: string[] = [];
  private _activeChild: ChildProcess | null = null;

  constructor(options: CopilotCliOptions) {
    this.timeout = options.timeout;
    this.additionalArgs = options.additionalArgs;
    this.useGh = options.useGh ?? false;
    this.workingDirectory = options.workingDirectory || undefined;
    this.stdoutIntervalSeconds = options.stdoutIntervalSeconds ?? 60;
  }

  // ── lifecycle ──

  async start(): Promise<void> {
    // Detect the configured model from ~/.copilot/config.json if not already set
    if (!this._model) {
      const detected = await detectConfiguredModel();
      if (detected) {
        this._model = detected;
        console.log(`[Copilot] Detected configured model: ${detected}`);
      }
    }
  }

  async stop(): Promise<void> { this.abort(); }

  // ── model ──

  get model(): string | null {
    return this._model;
  }

  set model(value: string | null) {
    this._model = value;
  }

  // ── permissions mode ──

  get permissions(): PermissionsMode {
    return this._permissions;
  }

  set permissions(value: PermissionsMode) {
    this._permissions = value;
  }

  // ── tool allow / deny lists ──

  get allowedTools(): readonly string[] {
    return this._allowedTools;
  }

  get deniedTools(): readonly string[] {
    return this._deniedTools;
  }

  addAllowedTool(tool: string): boolean {
    const normalized = tool.trim();
    if (!normalized) return false;
    // Remove from denied if present
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
    // Remove from allowed if present
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

  // ── abort ──

  /** Whether a Copilot process is currently running. */
  get isRunning(): boolean {
    return this._activeChild !== null;
  }

  /**
   * Kill the currently running Copilot process (if any).
   * Returns true if a process was killed, false if nothing was running.
   */
  abort(): boolean {
    if (!this._activeChild) return false;
    console.log("[Copilot] Aborting running process...");
    this._activeChild.kill("SIGTERM");
    // On Windows, SIGTERM doesn't always work — force kill after a short delay
    const child = this._activeChild;
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, 2000);
    this._activeChild = null;
    return true;
  }

  // ── execution ──

  execute(prompt: string, sessionId?: string, cwd?: string, _acpSessionId?: string, onProgress?: ProgressCallback): Promise<CopilotResponse> {
    return new Promise((resolve, reject) => {
      const permArgs = this.buildPermissionArgs();

      const args = [
        ...(this.useGh ? ["copilot"] : []),
        "-p",
        prompt,
        ...(sessionId ? ["--resume", sessionId] : []),
        ...permArgs,
        ...(this._model ? ["--model", this._model] : []),
        ...this.additionalArgs,
      ];

      const command = this.useGh ? "gh" : "copilot";

      console.log(`[Copilot] Executing: ${command} ${args.join(" ").slice(0, 120)}...`);

      const child: ChildProcess = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: normalizePath(cwd ?? this.workingDirectory),
        env: { ...process.env },
      });

      this._activeChild = child;

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let lastSentIndex = 0;

      // Progress interval — send new stdout delta to the caller periodically
      let progressHandle: ReturnType<typeof setInterval> | null = null;
      if (onProgress && this.stdoutIntervalSeconds > 0) {
        progressHandle = setInterval(() => {
          if (stdout.length > lastSentIndex) {
            const delta = stripAnsi(stdout.slice(lastSentIndex)).trim();
            if (delta) {
              onProgress(delta);
            }
            lastSentIndex = stdout.length;
          }
        }, this.stdoutIntervalSeconds * 1000);
      }

      // Manual timeout — spawn() does not support the timeout option
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        console.log(`[Copilot] Process timed out after ${this.timeout / 1000}s, killing...`);
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
      }, this.timeout);

      child.stdout!.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr!.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", (err) => {
        if (progressHandle) clearInterval(progressHandle);
        this._activeChild = null;
        reject(new Error(`Failed to start Copilot CLI: ${err.message}`));
      });

      // We need both "exit" (for code/signal) and stderr "end" (for complete
      // stderr data) before resolving.  "close" waits for ALL stdio which can
      // hang if MCP child processes keep stdout open, so we track stderr
      // independently with a safety timeout.
      let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      let stderrDone = false;
      let resolved = false;

      const tryResolve = () => {
        if (resolved || !exitInfo || !stderrDone) return;
        resolved = true;

        clearTimeout(timeoutHandle);
        if (progressHandle) clearInterval(progressHandle);
        this._activeChild = null;

        // Detach stdio so lingering child processes don't block garbage collection
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();

        const { code, signal } = exitInfo;

        if (timedOut) {
          reject(new Error(`Copilot CLI timed out after ${Math.round(this.timeout / 1000)} seconds.`));
          return;
        }

        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(new Error("ABORTED"));
          return;
        }

        if (code !== 0 && code !== null) {
          console.error(`[Copilot] CLI exited with code ${code}. stderr: ${stderr}`);
          reject(new Error(`Copilot CLI exited with code ${code}`));
          return;
        }

        const remaining = lastSentIndex > 0 ? stdout.slice(lastSentIndex) : stdout;
        const text = stripAnsi(remaining).trim();
        // Pass raw stderr as stats — the gateway sends it as a separate message
        const rawStats = stripAnsi(stderr).trim() || undefined;

        if (!text && lastSentIndex === 0) {
          resolve({ text: "(No response from Copilot CLI)", model: null, stats: rawStats });
        } else {
          resolve({ text: text || "", model: null, stats: rawStats });
        }
      };

      child.stderr!.on("end", () => {
        stderrDone = true;
        tryResolve();
      });

      child.on("exit", (code, signal) => {
        exitInfo = { code, signal };
        // Safety: if stderr "end" doesn't fire within 2s (e.g. lingering
        // child processes keeping the pipe open), resolve anyway.
        setTimeout(() => {
          if (!stderrDone) {
            console.log("[Copilot] stderr did not close in time, resolving with partial data.");
            stderrDone = true;
            tryResolve();
          }
        }, 2000);
        tryResolve();
      });

      child.stdin?.end();
    });
  }

  private buildPermissionArgs(): string[] {
    // allow-all mode: single blanket flag
    if (this._permissions === "allow-all") {
      return ["--allow-all"];
    }

    // ask mode: pass individual --allow-tool / --deny-tool flags
    const args: string[] = [];

    for (const tool of this._allowedTools) {
      args.push("--allow-tool", tool);
    }

    for (const tool of this._deniedTools) {
      args.push("--deny-tool", tool);
    }

    return args;
  }
}
