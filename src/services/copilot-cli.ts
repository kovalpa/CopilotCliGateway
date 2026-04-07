import { spawn, execFile, type ChildProcess } from "node:child_process";
import type { ICopilotBackend, CopilotResponse, PermissionsMode } from "./copilot-backend.js";

export type { CopilotResponse, PermissionsMode };

export interface CopilotCliOptions {
  timeout: number;
  additionalArgs: string[];
  workingDirectory?: string;
  /** If true, use "gh copilot" instead of "copilot" directly. */
  useGh?: boolean;
}

const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function extractModel(stderr: string): string | null {
  // Copilot CLI outputs lines like: " claude-opus-4.6  21.4k in, 17 out"
  const match = stderr.match(/^\s+([\w.-]+)\s+[\d.]+k?\s+in,/m);
  return match?.[1] ?? null;
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
  }

  // ── lifecycle (no-op for CLI mode) ──

  async start(): Promise<void> {}
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

  execute(prompt: string, sessionId?: string, cwd?: string, _acpSessionId?: string): Promise<CopilotResponse> {
    return new Promise((resolve, reject) => {
      const permArgs = this.buildPermissionArgs();

      const command = this.useGh ? "gh" : "copilot";
      const args = [
        ...(this.useGh ? ["copilot"] : []),
        "-p",
        prompt,
        ...(sessionId ? ["--resume", sessionId] : []),
        ...permArgs,
        ...(this._model ? ["--model", this._model] : []),
        ...this.additionalArgs,
      ];

      console.log(`[Copilot] Executing: ${command} ${args.join(" ").slice(0, 120)}...`);

      const child: ChildProcess = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: cwd ?? this.workingDirectory,
        env: { ...process.env },
      });

      this._activeChild = child;

      let stdout = "";
      let stderr = "";
      let timedOut = false;

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
        this._activeChild = null;
        reject(new Error(`Failed to start Copilot CLI: ${err.message}`));
      });

      // Use "exit" instead of "close" — "close" waits for ALL stdio streams
      // to close, which can be delayed if child processes (e.g. Playwright MCP
      // servers, browser instances) keep them open after Copilot itself finishes.
      // "exit" fires as soon as the main process exits.
      child.on("exit", (code, signal) => {
        clearTimeout(timeoutHandle);
        this._activeChild = null;

        // Detach stdio so lingering child processes don't block garbage collection
        child.stdout?.removeAllListeners();
        child.stderr?.removeAllListeners();

        // Process timed out
        if (timedOut) {
          reject(new Error(`Copilot CLI timed out after ${Math.round(this.timeout / 1000)} seconds.`));
          return;
        }

        // Process was killed (abort via /stop)
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(new Error("ABORTED"));
          return;
        }

        if (code !== 0 && code !== null) {
          reject(new Error(`Copilot CLI exited with code ${code}\n${stderr}`));
          return;
        }

        const text = stripAnsi(stdout).trim();
        const model = extractModel(stripAnsi(stderr));

        if (!text) {
          resolve({ text: "(No response from Copilot CLI)", model });
        } else {
          resolve({ text, model });
        }
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
