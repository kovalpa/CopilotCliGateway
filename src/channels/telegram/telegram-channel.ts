import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { IChannel, ChannelMessage, MessageHandler, MessageButtons } from "../channel.js";
import type { TelegramConfig } from "../../config.js";

export class TelegramChannel implements IChannel {
  readonly name = "telegram";

  private bot: Bot | null = null;
  private readonly config: TelegramConfig;
  private readonly messageHandlers: MessageHandler[] = [];

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.bot = new Bot(this.config.botToken);

    // Catch errors in handlers so they don't crash the bot
    this.bot.catch((err) => {
      console.error("[Gateway] [Telegram] Bot error:", err.message ?? err);
    });

    this.bot.on("message:text", (ctx) => this.handleTextMessage(ctx));
    this.bot.on("message:photo", (ctx) => this.handlePhotoMessage(ctx));
    this.bot.on("message:voice", (ctx) => this.handleVoiceMessage(ctx));
    this.bot.on("message:audio", (ctx) => this.handleAudioMessage(ctx));
    this.bot.on("message:document", (ctx) => this.handleDocumentMessage(ctx));

    // Handle inline keyboard button taps
    this.bot.on("callback_query:data", (ctx) => this.handleCallbackQuery(ctx));

    // Verify bot token first
    const me = await this.bot.api.getMe();
    console.log(`[Gateway] [Telegram] Bot @${me.username} verified, starting long polling...`);

    // Register bot commands so they appear in the "/" menu
    await this.bot.api.setMyCommands([
      { command: "help", description: "📋 Show available commands" },
      { command: "model", description: "🤖 Show or switch AI model" },
      { command: "session", description: "📁 Manage chat sessions" },
      { command: "folder", description: "📂 Show or change working directory" },
      { command: "permissions", description: "🔐 Show or change permissions mode" },
      { command: "allow", description: "✅ Pre-approve a tool" },
      { command: "deny", description: "❌ Block a tool" },
      { command: "instructions", description: "📝 Re-inject instructions" },
      { command: "stop", description: "⛔ Abort running Copilot process" },
    ]);
    console.log("[Gateway] [Telegram] Bot commands registered.");

    // Fire-and-forget — bot.start() blocks until stopped
    this.bot.start().catch((err) => {
      console.error("[Gateway] [Telegram] Polling error:", err);
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
      console.log("[Gateway] [Telegram] Bot stopped.");
    }
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    if (!this.bot) return;

    const chatId = Number(recipientId);
    const MAX_LENGTH = 4096;

    if (text.length <= MAX_LENGTH) {
      await this.bot.api.sendMessage(chatId, text);
      return;
    }

    // Split long messages at newline boundaries
    const chunks = splitTextIntoChunks(text, MAX_LENGTH);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(chatId, chunk);
    }
  }

  async sendMessageWithButtons(recipientId: string, text: string, buttons: MessageButtons): Promise<void> {
    if (!this.bot) return;

    const chatId = Number(recipientId);
    const keyboard = new InlineKeyboard();

    for (let r = 0; r < buttons.length; r++) {
      for (const btn of buttons[r]) {
        keyboard.text(btn.label, btn.callbackData);
      }
      if (r < buttons.length - 1) {
        keyboard.row();
      }
    }

    await this.bot.api.sendMessage(chatId, text, { reply_markup: keyboard });
  }

  async sendImage(recipientId: string, image: Buffer, caption?: string): Promise<void> {
    if (!this.bot) return;
    const chatId = Number(recipientId);
    await this.bot.api.sendPhoto(chatId, new InputFile(image, caption ?? "image.png"), {
      caption: caption ?? undefined,
    });
  }

  async sendVideo(recipientId: string, video: Buffer, caption?: string): Promise<void> {
    if (!this.bot) return;
    const chatId = Number(recipientId);
    await this.bot.api.sendVideo(chatId, new InputFile(video, caption ?? "video.mp4"), {
      caption: caption ?? undefined,
    });
  }

  async sendFile(recipientId: string, file: Buffer, filename: string, caption?: string): Promise<void> {
    if (!this.bot) return;
    const chatId = Number(recipientId);
    await this.bot.api.sendDocument(chatId, new InputFile(file, filename), {
      caption: caption ?? undefined,
    });
  }

  async sendTyping(recipientId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(Number(recipientId), "typing");
    } catch {
      // Typing indicator is best-effort
    }
  }

  async stopTyping(_recipientId: string): Promise<void> {
    // Telegram typing indicator expires automatically
  }

  // --------------- Private helpers ---------------

  private isAllowed(ctx: Context): boolean {
    const filteredUsers = this.config.allowedUsers.filter((u) => u.trim());
    if (filteredUsers.length === 0) return true;

    const userId = String(ctx.from?.id ?? "");
    const username = (ctx.from?.username ?? "").toLowerCase();
    const chatId = String(ctx.chat?.id ?? "");

    return filteredUsers.some((entry) => {
      const normalized = entry.replace(/^@/, "").toLowerCase();
      return normalized === userId || normalized === username || normalized === chatId;
    });
  }

  private buildSenderName(ctx: Context): string {
    const first = ctx.from?.first_name ?? "";
    const last = ctx.from?.last_name ?? "";
    return last ? `${first} ${last}` : first;
  }

  private async downloadFile(fileId: string): Promise<Buffer> {
    const file = await this.bot!.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      // Wrap to avoid leaking the bot token from the URL in stack traces
      throw new Error(`Failed to download Telegram file: network error`);
    }
    if (!resp.ok) {
      throw new Error(`Failed to download Telegram file: ${resp.status} ${resp.statusText}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  private emit(msg: ChannelMessage): void {
    for (const handler of this.messageHandlers) {
      // Fire-and-forget: don't await so new messages are processed concurrently
      // (allows /stop and /help to work while Copilot is running)
      handler(msg).catch((err) => {
        console.error("[Gateway] [Telegram] Handler error:", err);
      });
    }
  }

  // --------------- Message handlers ---------------

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;

    const data = ctx.callbackQuery?.data;
    const chatId = ctx.callbackQuery?.message?.chat?.id;
    if (!data || !chatId) return;

    // Acknowledge the button tap immediately (removes the loading spinner)
    await ctx.answerCallbackQuery();

    console.log(`[Gateway] [Telegram] Button tapped: "${data}" by ${this.buildSenderName(ctx)}`);

    // Emit the callback data as a regular message so the gateway processes it
    this.emit({
      channelName: "telegram",
      senderId: String(chatId),
      senderName: this.buildSenderName(ctx),
      body: data,
      messageId: String(ctx.callbackQuery!.id),
      timestamp: new Date(),
    });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;
    if (!ctx.message?.text) return;

    await this.emit({
      channelName: "telegram",
      senderId: String(ctx.chat!.id),
      senderName: this.buildSenderName(ctx),
      body: ctx.message.text,
      messageId: String(ctx.message.message_id),
      timestamp: new Date(ctx.message.date * 1000),
    });
  }

  private async handlePhotoMessage(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;
    if (!ctx.message?.photo?.length) return;

    // Highest resolution is the last element
    const photo = ctx.message.photo[ctx.message.photo.length - 1];

    try {
      const buffer = await this.downloadFile(photo.file_id);
      console.log(`[Gateway] [Telegram] Downloaded photo: ${buffer.length} bytes`);

      await this.emit({
        channelName: "telegram",
        senderId: String(ctx.chat!.id),
        senderName: this.buildSenderName(ctx),
        body: ctx.message.caption ?? "",
        messageId: String(ctx.message.message_id),
        timestamp: new Date(ctx.message.date * 1000),
        image: {
          buffer,
          mimetype: "image/jpeg",
        },
      });
    } catch (err) {
      console.error("[Gateway] [Telegram] Failed to download photo:", err);
    }
  }

  private async handleVoiceMessage(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;
    if (!ctx.message?.voice) return;

    const voice = ctx.message.voice;

    try {
      const buffer = await this.downloadFile(voice.file_id);
      console.log(`[Gateway] [Telegram] Downloaded voice: ${buffer.length} bytes, ${voice.duration}s`);

      await this.emit({
        channelName: "telegram",
        senderId: String(ctx.chat!.id),
        senderName: this.buildSenderName(ctx),
        body: ctx.message.caption ?? "",
        messageId: String(ctx.message.message_id),
        timestamp: new Date(ctx.message.date * 1000),
        audio: {
          buffer,
          mimetype: voice.mime_type ?? "audio/ogg",
          seconds: voice.duration,
        },
      });
    } catch (err) {
      console.error("[Gateway] [Telegram] Failed to download voice:", err);
    }
  }

  private async handleAudioMessage(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;
    if (!ctx.message?.audio) return;

    const audio = ctx.message.audio;

    try {
      const buffer = await this.downloadFile(audio.file_id);
      console.log(`[Gateway] [Telegram] Downloaded audio: ${buffer.length} bytes, ${audio.duration}s`);

      await this.emit({
        channelName: "telegram",
        senderId: String(ctx.chat!.id),
        senderName: this.buildSenderName(ctx),
        body: ctx.message.caption ?? "",
        messageId: String(ctx.message.message_id),
        timestamp: new Date(ctx.message.date * 1000),
        audio: {
          buffer,
          mimetype: audio.mime_type ?? "audio/mpeg",
          seconds: audio.duration,
        },
      });
    } catch (err) {
      console.error("[Gateway] [Telegram] Failed to download audio:", err);
    }
  }
  private async handleDocumentMessage(ctx: Context): Promise<void> {
    if (!this.isAllowed(ctx)) return;
    if (!ctx.message?.document) return;

    const doc = ctx.message.document;

    try {
      const buffer = await this.downloadFile(doc.file_id);
      console.log(`[Gateway] [Telegram] Downloaded document: ${doc.file_name ?? "unknown"} (${buffer.length} bytes)`);

      await this.emit({
        channelName: "telegram",
        senderId: String(ctx.chat!.id),
        senderName: this.buildSenderName(ctx),
        body: ctx.message.caption ?? "",
        messageId: String(ctx.message.message_id),
        timestamp: new Date(ctx.message.date * 1000),
        file: {
          buffer,
          mimetype: doc.mime_type ?? "application/octet-stream",
          filename: doc.file_name ?? `file-${Date.now()}`,
        },
      });
    } catch (err) {
      console.error("[Gateway] [Telegram] Failed to download document:", err);
    }
  }
}

// --------------- Utility ---------------

function splitTextIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx <= 0) {
      // No newline found, split at space
      splitIdx = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIdx <= 0) {
      // No good break point, hard split
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
