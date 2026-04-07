import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { ICopilotBackend } from "./services/copilot-backend.js";
import { CopilotCliService } from "./services/copilot-cli.js";
import { CopilotAcpService } from "./services/copilot-acp.js";
import { loadMcpServers } from "./services/mcp-config.js";
import { SessionStore } from "./services/session-store.js";
import { WhatsAppChannel } from "./channels/whatsapp/whatsapp-channel.js";
import { TelegramChannel } from "./channels/telegram/telegram-channel.js";
import { Gateway } from "./gateway.js";
import { showStartupMenu, isWhatsAppConfigured, isTelegramConfigured } from "./menu.js";
import type { IChannel } from "./channels/channel.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noMenu = args.includes("--no-menu");
  const resetAuth = args.includes("--reset");

  let config = await loadConfig();

  let freshlyConfigured: string[] = [];

  // Interactive startup menu (skip with --no-menu)
  if (!noMenu) {
    const result = await showStartupMenu(config);
    if (result.action === "exit") {
      process.exit(0);
    }
    config = result.config;
    freshlyConfigured = result.freshlyConfigured;
  } else {
    console.log("=== Copilot CLI Gateway ===\n");
  }

  if (resetAuth) {
    const authDir = resolve(config.whatsapp.authDir);
    console.log(`[Gateway] Resetting WhatsApp auth (deleting ${authDir})...`);
    await rm(authDir, { recursive: true, force: true });
    console.log("[Gateway] Auth state cleared. QR code will be shown on connect.\n");
  }

  const backendType = config.copilot.backend ?? "cli";
  let copilot: ICopilotBackend;

  if (backendType === "acp") {
    console.log("[Gateway] Using ACP backend (persistent Agent Client Protocol server).");
    copilot = new CopilotAcpService({
      timeout: config.copilot.timeout,
      additionalArgs: config.copilot.additionalArgs,
      workingDirectory: config.copilot.workingDirectory,
      useGh: config.copilot.useGh,
    });
  } else {
    console.log("[Gateway] Using CLI backend (spawn per request).");
    copilot = new CopilotCliService({
      timeout: config.copilot.timeout,
      additionalArgs: config.copilot.additionalArgs,
      workingDirectory: config.copilot.workingDirectory,
      useGh: config.copilot.useGh,
    });
  }

  // Start the backend (no-op for CLI, starts ACP server for ACP)
  await copilot.start();

  if (config.copilot.workingDirectory) {
    console.log(`[Gateway] Copilot working directory: ${config.copilot.workingDirectory}`);
  }

  const channels: IChannel[] = [];

  // Only start WhatsApp if it has existing auth state OR the user just configured it via menu
  if (config.whatsapp.enabled && (isWhatsAppConfigured(config) || freshlyConfigured.includes("whatsapp"))) {
    channels.push(new WhatsAppChannel(config.whatsapp));
  }

  // Only start Telegram if it's been configured OR the user just configured it via menu
  if (config.telegram.enabled && config.telegram.botToken && (isTelegramConfigured(config) || freshlyConfigured.includes("telegram"))) {
    channels.push(new TelegramChannel(config.telegram));
  }

  if (channels.length === 0) {
    console.error("No channels enabled. Please configure at least one channel.");
    process.exit(1);
  }

  console.log(`[Gateway] Starting with channels: ${channels.map((c) => c.name).join(", ")}`);

  // Discover configured MCP servers
  const mcpServers = await loadMcpServers();
  if (mcpServers.length > 0) {
    console.log(`[Gateway] Found ${mcpServers.length} MCP server(s): ${mcpServers.map((s) => s.name).join(", ")}`);
  } else {
    console.log("[Gateway] No MCP servers configured.");
  }

  // OpenAI services (Whisper voice-to-text + Vision image description)
  if (config.openai.apiKey) {
    console.log("[Gateway] OpenAI services enabled (Whisper + Vision).");
  } else {
    console.log("[Gateway] OpenAI services disabled (no API key).");
  }

  // Load session store
  const sessionStore = new SessionStore();
  await sessionStore.load();
  console.log("[Gateway] Session store loaded.");

  const gateway = new Gateway(channels, copilot, mcpServers, config.openai, sessionStore);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Gateway] Shutting down...");
    await gateway.stop();
    await copilot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await gateway.start();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
