import { select, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { GatewayConfig } from "./config.js";
import { saveConfig } from "./config.js";

export interface MenuResult {
  action: "start" | "exit";
  config: GatewayConfig;
  /** Channels the user freshly configured during this menu session. */
  freshlyConfigured: string[];
}

export { isWhatsAppConfigured, isTelegramConfigured };

// --------------- Status display ---------------

function isWhatsAppConfigured(config: GatewayConfig): boolean {
  return config.whatsapp.enabled && existsSync(resolve(config.whatsapp.authDir, "creds.json"));
}

function isTelegramConfigured(config: GatewayConfig): boolean {
  return config.telegram.enabled && !!config.telegram.botToken;
}

function displayStatus(config: GatewayConfig): void {
  console.log();
  console.log(chalk.bold("Channel Status:"));

  const waStatus = isWhatsAppConfigured(config);
  const tgStatus = isTelegramConfigured(config);

  console.log(
    waStatus
      ? chalk.green("  \u2705 WhatsApp  \u2014 Configured")
      : chalk.red("  \u274C WhatsApp  \u2014 Not configured"),
  );
  console.log(
    tgStatus
      ? chalk.green("  \u2705 Telegram  \u2014 Configured")
      : chalk.red("  \u274C Telegram  \u2014 Not configured"),
  );

  const backend = config.copilot.backend ?? "cli";
  const backendLabel = backend === "acp" ? "ACP (persistent server)" : "CLI (spawn per request)";
  console.log(chalk.blue(`  \u2699  Backend   \u2014 ${backendLabel}`));
  console.log();
}

// --------------- Telegram token validation ---------------

async function validateTelegramToken(
  token: string,
): Promise<{ ok: boolean; botUsername?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) {
      return { ok: true, botUsername: data.result.username };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// --------------- Configure flows ---------------

async function configureWhatsApp(config: GatewayConfig): Promise<void> {
  if (isWhatsAppConfigured(config)) {
    const proceed = await confirm({
      message: chalk.yellow(
        "WhatsApp is already configured. Reconfiguring will delete the auth state and require scanning a new QR code. Continue?",
      ),
      default: false,
    });
    if (!proceed) return;

    // Delete auth state
    const authDir = resolve(config.whatsapp.authDir);
    await rm(authDir, { recursive: true, force: true });
    console.log(chalk.gray("  Auth state cleared."));
  }

  config.whatsapp.enabled = true;
  await saveConfig(config);

  console.log(
    chalk.green("\n  WhatsApp configured. A QR code will be shown when the gateway starts.\n"),
  );
}

async function configureTelegram(config: GatewayConfig): Promise<void> {
  if (isTelegramConfigured(config)) {
    const masked = config.telegram.botToken.slice(-6);
    const proceed = await confirm({
      message: chalk.yellow(
        `Telegram is already configured (token ending in ...${masked}). Reconfiguring will replace it. Continue?`,
      ),
      default: false,
    });
    if (!proceed) return;
  }

  const token = await input({
    message: "Enter your Telegram Bot Token (from @BotFather):",
    validate: (val) => (val.trim().length > 0 ? true : "Token cannot be empty"),
  });

  console.log(chalk.gray("  Validating token..."));
  const result = await validateTelegramToken(token.trim());

  if (!result.ok) {
    console.log(chalk.red("  Invalid bot token. Please check and try again.\n"));
    return;
  }

  console.log(chalk.green(`  Bot validated: @${result.botUsername}`));

  const allowedRaw = await input({
    message: "Allowed users (comma-separated IDs or @usernames, leave empty for all):",
  });

  const allowedUsers = allowedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  config.telegram.enabled = true;
  config.telegram.botToken = token.trim();
  config.telegram.allowedUsers = allowedUsers;
  await saveConfig(config);

  console.log(chalk.green(`\n  Telegram bot @${result.botUsername} configured successfully!\n`));
}

// --------------- Main menu ---------------

export async function showStartupMenu(config: GatewayConfig): Promise<MenuResult> {
  console.log(chalk.bold.cyan("\n=== Copilot CLI Gateway ==="));

  const freshlyConfigured: string[] = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    displayStatus(config);

    const waConfigured = isWhatsAppConfigured(config);
    const tgConfigured = isTelegramConfigured(config);

    const choice = await select({
      message: "What would you like to do?",
      choices: [
        {
          name: chalk.green("Start Gateway"),
          value: "start",
          description: "Launch all configured channels",
        },
        {
          name: waConfigured
            ? "Configure WhatsApp (reset current config)"
            : "Configure WhatsApp",
          value: "configure-whatsapp",
        },
        {
          name: tgConfigured
            ? "Configure Telegram (reset current config)"
            : "Configure Telegram",
          value: "configure-telegram",
        },
        {
          name: chalk.gray("Exit"),
          value: "exit",
        },
      ],
    });

    switch (choice) {
      case "start":
        return { action: "start", config, freshlyConfigured };

      case "configure-whatsapp":
        await configureWhatsApp(config);
        if (config.whatsapp.enabled && !freshlyConfigured.includes("whatsapp")) {
          freshlyConfigured.push("whatsapp");
        }
        break;

      case "configure-telegram":
        await configureTelegram(config);
        if (config.telegram.enabled && !freshlyConfigured.includes("telegram")) {
          freshlyConfigured.push("telegram");
        }
        break;

      case "exit":
        return { action: "exit", config, freshlyConfigured };
    }
  }
}
