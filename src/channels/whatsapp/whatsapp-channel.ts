import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  DisconnectReason,
  WASocket,
  proto,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { createRequire } from "node:module";
import type { Boom } from "@hapi/boom";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as { generate(text: string, opts: { small: boolean }): void };
import type { IChannel, ChannelMessage, MessageHandler } from "../channel.js";
import type { WhatsAppConfig } from "../../config.js";

const APP_VERSION = "1.0.0";

export class WhatsAppChannel implements IChannel {
  readonly name = "whatsapp";

  private socket: WASocket | null = null;
  private messageHandlers: MessageHandler[] = [];
  private readonly config: WhatsAppConfig;
  private shouldReconnect = true;
  private sentMessageIds = new Set<string>();
  private static readonly MAX_SENT_IDS = 1000;

  constructor(config: WhatsAppConfig) {
    this.config = config;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.shouldReconnect = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.socket?.end(undefined);
    this.socket = null;
    console.log("[Gateway] [WhatsApp] Disconnected.");
  }

  async sendMessage(recipientId: string, text: string): Promise<void> {
    if (!this.socket) {
      throw new Error("[Gateway] [WhatsApp] Not connected.");
    }

    console.log(`[Gateway] [WhatsApp] Sending message to ${recipientId} (${text.length} chars)`);
    const sent = await this.socket.sendMessage(recipientId, { text });
    if (sent?.key?.id) {
      this.trackSentMessage(sent.key.id);
    }
  }

  async sendImage(recipientId: string, image: Buffer, caption?: string): Promise<void> {
    if (!this.socket) {
      throw new Error("[Gateway] [WhatsApp] Not connected.");
    }
    console.log(`[Gateway] [WhatsApp] Sending image to ${recipientId} (${image.length} bytes)`);
    const sent = await this.socket.sendMessage(recipientId, {
      image,
      caption: caption ?? undefined,
    });
    if (sent?.key?.id) {
      this.trackSentMessage(sent.key.id);
    }
  }

  async sendVideo(recipientId: string, video: Buffer, caption?: string): Promise<void> {
    if (!this.socket) {
      throw new Error("[Gateway] [WhatsApp] Not connected.");
    }
    console.log(`[Gateway] [WhatsApp] Sending video to ${recipientId} (${video.length} bytes)`);
    const sent = await this.socket.sendMessage(recipientId, {
      video,
      caption: caption ?? undefined,
    });
    if (sent?.key?.id) {
      this.trackSentMessage(sent.key.id);
    }
  }

  async sendFile(recipientId: string, file: Buffer, filename: string, caption?: string): Promise<void> {
    if (!this.socket) {
      throw new Error("[Gateway] [WhatsApp] Not connected.");
    }
    console.log(`[Gateway] [WhatsApp] Sending file to ${recipientId}: ${filename} (${file.length} bytes)`);
    const sent = await this.socket.sendMessage(recipientId, {
      document: file,
      mimetype: mimetypeFromFilename(filename),
      fileName: filename,
      caption: caption ?? undefined,
    });
    if (sent?.key?.id) {
      this.trackSentMessage(sent.key.id);
    }
  }

  async sendTyping(recipientId: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.presenceSubscribe(recipientId);
      await this.socket.sendPresenceUpdate("composing", recipientId);
      console.log(`[Gateway] [WhatsApp] Typing indicator ON for ${recipientId}`);
    } catch (err) {
      console.warn(`[Gateway] [WhatsApp] Failed to send typing indicator:`, err);
    }
  }

  async stopTyping(recipientId: string): Promise<void> {
    if (!this.socket) return;
    try {
      await this.socket.sendPresenceUpdate("paused", recipientId);
    } catch (err) {
      // ignore
    }
  }

  /** Track sent message IDs and prune old entries to prevent memory leaks. */
  private trackSentMessage(id: string): void {
    this.sentMessageIds.add(id);
    if (this.sentMessageIds.size > WhatsAppChannel.MAX_SENT_IDS) {
      // Drop the oldest half
      const ids = [...this.sentMessageIds];
      this.sentMessageIds = new Set(ids.slice(ids.length / 2));
    }
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

    const logger = pino({ level: "silent" }) as any;

    // Fetch the latest WhatsApp Web version (critical for avoiding 405 errors)
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[Gateway] [WhatsApp] Using WA Web version: ${version.join(".")}`);

    this.socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      version,
      logger,
      browser: ["CopilotCliGateway", "Desktop", APP_VERSION],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.socket.ev.on("creds.update", saveCreds);

    this.socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n[Gateway] [WhatsApp] Scan this QR code with WhatsApp on your phone:");
        console.log("           (WhatsApp → Settings → Linked Devices → Link a Device)\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("[Gateway] [WhatsApp] Connected successfully!");
      }

      if (connection === "close") {
        const reason = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.log("[Gateway] [WhatsApp] Logged out. Please delete auth_state and restart.");
          return;
        }

        if (this.shouldReconnect) {
          console.log(`[Gateway] [WhatsApp] Disconnected (reason: ${reason}). Reconnecting...`);
          setTimeout(() => this.connect(), 3000);
        }
      }
    });

    this.socket.ev.on("messages.upsert", async ({ messages, type }) => {
      console.log(`[Gateway] [WhatsApp] messages.upsert event: type=${type}, count=${messages.length}`);

      for (const msg of messages) {
        const from = msg.key?.remoteJid ?? "unknown";
        const fromMe = msg.key?.fromMe ?? false;
        const text = extractMessageText(msg);
        console.log(`[Gateway] [WhatsApp] Raw message: from=${from}, fromMe=${fromMe}, type=${type}, text=${text ?? "(no text)"}`);
        await this.handleIncomingMessage(msg);
      }
    });
  }

  private async handleIncomingMessage(msg: proto.IWebMessageInfo): Promise<void> {
    if (!msg.key) return;

    // Skip messages sent by this gateway (our own replies)
    if (msg.key.id && this.sentMessageIds.has(msg.key.id)) {
      this.sentMessageIds.delete(msg.key.id);
      return;
    }

    const body = extractMessageText(msg);
    const audioMsg = msg.message?.audioMessage;
    const imageMsg = msg.message?.imageMessage;
    const documentMsg = msg.message?.documentMessage;

    // Skip messages with no processable content
    if (!body && !audioMsg && !imageMsg && !documentMsg) {
      console.log("[Gateway] [WhatsApp] Skipping message with no text, audio, image, or file.");
      return;
    }

    const senderId = msg.key.remoteJid;
    if (!senderId) return;

    // Skip status broadcasts
    if (senderId === "status@broadcast") return;

    if (this.config.allowedNumbers.length > 0) {
      const senderNumber = senderId.replace(/@.*$/, "");
      const allowedNumbers = this.config.allowedNumbers.filter((n) => n.trim());
      if (allowedNumbers.length > 0 && !allowedNumbers.includes(senderNumber)) {
        console.log(`[Gateway] [WhatsApp] Ignored message from unauthorized number: ${senderNumber}`);
        return;
      }
    }

    const senderName = msg.pushName ?? undefined;
    const messageId = msg.key!.id ?? `${Date.now()}`;
    const timestamp = msg.messageTimestamp
      ? new Date(Number(msg.messageTimestamp) * 1000)
      : new Date();

    const channelMessage: ChannelMessage = {
      channelName: this.name,
      senderId,
      senderName,
      body: body ?? "",
      messageId,
      timestamp,
    };

    // Download audio if present
    if (audioMsg) {
      try {
        const buffer = await downloadMediaMessage(
          msg as any,
          "buffer",
          {},
        ) as Buffer;
        channelMessage.audio = {
          buffer,
          mimetype: audioMsg.mimetype ?? "audio/ogg",
          seconds: audioMsg.seconds ?? undefined,
        };
        console.log(`[Gateway] [WhatsApp] Downloaded audio: ${buffer.length} bytes, ${audioMsg.seconds ?? "?"}s`);
      } catch (err) {
        console.error("[Gateway] [WhatsApp] Failed to download audio:", err);
      }
    }

    // Download image if present
    if (imageMsg) {
      try {
        const buffer = await downloadMediaMessage(
          msg as any,
          "buffer",
          {},
        ) as Buffer;
        channelMessage.image = {
          buffer,
          mimetype: imageMsg.mimetype ?? "image/jpeg",
        };
        console.log(`[Gateway] [WhatsApp] Downloaded image: ${buffer.length} bytes, ${imageMsg.mimetype ?? "image/jpeg"}`);
      } catch (err) {
        console.error("[Gateway] [WhatsApp] Failed to download image:", err);
      }
    }

    // Download document if present
    if (documentMsg) {
      try {
        const buffer = await downloadMediaMessage(
          msg as any,
          "buffer",
          {},
        ) as Buffer;
        channelMessage.file = {
          buffer,
          mimetype: documentMsg.mimetype ?? "application/octet-stream",
          filename: documentMsg.fileName ?? `file-${Date.now()}`,
        };
        console.log(`[Gateway] [WhatsApp] Downloaded file: ${documentMsg.fileName ?? "unknown"} (${buffer.length} bytes)`);
      } catch (err) {
        console.error("[Gateway] [WhatsApp] Failed to download file:", err);
      }
    }

    for (const handler of this.messageHandlers) {
      // Fire-and-forget: don't await so new messages are processed concurrently
      // (allows /stop and /help to work while Copilot is running)
      handler(channelMessage).catch((err) => {
        console.error("[Gateway] [WhatsApp] Message handler error:", err);
      });
    }
  }
}

function mimetypeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    csv: "text/csv",
    txt: "text/plain",
    json: "application/json",
    zip: "application/zip",
    mp4: "video/mp4",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    webm: "video/webm",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };
  return map[ext] ?? "application/octet-stream";
}

function extractMessageText(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;

  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

