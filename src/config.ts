import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface WhatsAppConfig {
  enabled: boolean;
  phoneNumber: string;
  allowedNumbers: string[];
  authDir: string;
}

export interface CopilotPermissions {
  /** Permission mode. "allow-all" overrides tools.allowed/denied at runtime. */
  mode: "ask" | "allow-all";
}

export interface CopilotTools {
  /** Tools pre-approved when mode is "ask" (e.g. "Read", "shell(git:*)"). */
  allowed: string[];
  /** Tools always blocked (takes precedence over allowed). */
  denied: string[];
}

export interface CopilotConfig {
  timeout: number;
  additionalArgs: string[];
  workingDirectory: string;
  /** If true, use "gh copilot" instead of "copilot" directly. Defaults to false. */
  useGh: boolean;
  /** Communication backend: "cli" (spawn per request) or "acp" (persistent ACP server). Defaults to "cli". */
  backend: "cli" | "acp";
  /** Interval in seconds to send stdout progress updates to the user. 0 disables. Defaults to 60. */
  stdoutIntervalSeconds: number;
  /** Show CLI stats (tokens, requests, changes) after each response. Defaults to true. */
  showStats: boolean;
  /** User-selected model (persisted across restarts). Empty string = use Copilot's default. */
  model: string;
  /** Permission mode — persisted across restarts. */
  permissions: CopilotPermissions;
  /** Granular tool allow/deny lists — persisted even when mode is "allow-all". */
  tools: CopilotTools;
}

export interface OpenAIConfig {
  apiKey: string;
  whisperModel: string;
  language: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  allowedUsers: string[];
}

export interface GatewayConfig {
  whatsapp: WhatsAppConfig;
  telegram: TelegramConfig;
  copilot: CopilotConfig;
  openai: OpenAIConfig;
}

const DEFAULT_CONFIG: GatewayConfig = {
  whatsapp: {
    enabled: false,
    phoneNumber: "",
    allowedNumbers: [],
    authDir: "./auth_state",
  },
  telegram: {
    enabled: false,
    botToken: "",
    allowedUsers: [],
  },
  copilot: {
    timeout: 1_200_000,
    additionalArgs: [],
    workingDirectory: "",
    useGh: false,
    backend: "cli",
    stdoutIntervalSeconds: 60,
    showStats: true,
    model: "",
    permissions: {
      mode: "ask",
    },
    tools: {
      allowed: [],
      denied: [],
    },
  },
  openai: {
    apiKey: "",
    whisperModel: "whisper-1",
    language: "",
  },
};

export async function loadConfig(configPath?: string): Promise<GatewayConfig> {
  const filePath = resolve(configPath ?? "config.json");

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GatewayConfig>;

    // Support old "whisper" key for backward compatibility
    const legacyWhisper = (parsed as any).whisper as Partial<OpenAIConfig> | undefined;

    // Merge copilot with nested-section defaults + light validation
    const parsedCopilot = parsed.copilot ?? {};
    const parsedPermissions = (parsedCopilot as any).permissions as Partial<CopilotPermissions> | undefined;
    const parsedTools = (parsedCopilot as any).tools as Partial<CopilotTools> | undefined;

    const mode: CopilotPermissions["mode"] =
      parsedPermissions?.mode === "allow-all" || parsedPermissions?.mode === "ask"
        ? parsedPermissions.mode
        : DEFAULT_CONFIG.copilot.permissions.mode;

    const filterStringList = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((t): t is string => typeof t === "string" && t.length > 0) : [];

    const model = typeof (parsedCopilot as any).model === "string"
      ? (parsedCopilot as any).model
      : DEFAULT_CONFIG.copilot.model;

    return {
      whatsapp: { ...DEFAULT_CONFIG.whatsapp, ...parsed.whatsapp },
      telegram: { ...DEFAULT_CONFIG.telegram, ...(parsed as any).telegram },
      copilot: {
        ...DEFAULT_CONFIG.copilot,
        ...parsedCopilot,
        model,
        permissions: { mode },
        tools: {
          allowed: filterStringList(parsedTools?.allowed),
          denied: filterStringList(parsedTools?.denied),
        },
      },
      openai: { ...DEFAULT_CONFIG.openai, ...legacyWhisper, ...parsed.openai },
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`No config file found at ${filePath}, using defaults.`);
      return DEFAULT_CONFIG;
    }
    throw err;
  }
}

export async function saveConfig(config: GatewayConfig, configPath?: string): Promise<void> {
  const filePath = resolve(configPath ?? "config.json");
  await writeFile(filePath, JSON.stringify(config, null, 2), "utf-8");
}
