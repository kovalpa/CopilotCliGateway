import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface WhatsAppConfig {
  enabled: boolean;
  phoneNumber: string;
  allowedNumbers: string[];
  authDir: string;
}

export interface CopilotConfig {
  timeout: number;
  additionalArgs: string[];
  workingDirectory: string;
  /** If true, use "gh copilot" instead of "copilot" directly. Defaults to false. */
  useGh: boolean;
  /** Communication backend: "cli" (spawn per request) or "acp" (persistent ACP server). Defaults to "cli". */
  backend: "cli" | "acp";
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

    return {
      whatsapp: { ...DEFAULT_CONFIG.whatsapp, ...parsed.whatsapp },
      telegram: { ...DEFAULT_CONFIG.telegram, ...(parsed as any).telegram },
      copilot: { ...DEFAULT_CONFIG.copilot, ...parsed.copilot },
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
