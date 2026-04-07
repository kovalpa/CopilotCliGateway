export interface CopilotResponse {
  text: string;
  model: string | null;
  /** ACP session ID (returned by ACP backend so the gateway can persist it). */
  acpSessionId?: string;
  /** Tool names that were rejected during this execution (ACP ask mode). */
  rejectedTools?: string[];
}

export type PermissionsMode = "ask" | "allow-all";

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

  execute(prompt: string, sessionId?: string, cwd?: string, acpSessionId?: string): Promise<CopilotResponse>;
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
