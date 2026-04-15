/**
 * Normalize a Windows path to forward slashes so that Node's child_process
 * APIs work reliably when the path is used as `cwd` in spawn/execFile.
 *
 * On Windows (especially under Git Bash / MSYS2), backslash paths passed
 * as `cwd` cause ENOENT even though the directory exists.  Forward slashes
 * work fine for both the cwd and the command lookup via PATH.
 */
export function normalizePath(p: string | undefined): string | undefined {
  return p?.replace(/\\/g, "/");
}

export interface CopilotResponse {
  text: string;
  model: string | null;
  /** Stats block from CLI stderr (Tokens, Requests, Changes lines). */
  stats?: string;
  /** ACP session ID (returned by ACP backend so the gateway can persist it). */
  acpSessionId?: string;
  /** Tool names that were rejected during this execution (ACP ask mode). */
  rejectedTools?: string[];
}

export type PermissionsMode = "ask" | "allow-all";

/** Callback that receives new stdout text since the last progress tick. */
export type ProgressCallback = (delta: string) => void;

/**
 * Common interface for interacting with GitHub Copilot CLI.
 *
 * Two implementations:
 * - **cli** — spawns `copilot -p` per request (headless mode)
 * - **acp** — long-running `copilot --acp` server via Agent Client Protocol
 */
export interface ICopilotBackend {
  // ── lifecycle ──

  /** Start the backend (e.g. spawn ACP server). No-op for CLI mode. */
  start(): Promise<void>;

  /** Shut down the backend cleanly. */
  stop(): Promise<void>;

  // ── execution ──

  execute(prompt: string, sessionId?: string, cwd?: string, acpSessionId?: string, onProgress?: ProgressCallback): Promise<CopilotResponse>;
  abort(): boolean;
  get isRunning(): boolean;

  // ── model ──

  get model(): string | null;
  set model(value: string | null);

  // ── permissions ──

  get permissions(): PermissionsMode;
  set permissions(value: PermissionsMode);

  get allowedTools(): readonly string[];
  get deniedTools(): readonly string[];

  addAllowedTool(tool: string): boolean;
  removeAllowedTool(tool: string): boolean;
  addDeniedTool(tool: string): boolean;
  removeDeniedTool(tool: string): boolean;
  resetToolLists(): void;

  // ── config ──

  readonly useGh: boolean;
  readonly workingDirectory: string | undefined;
}
