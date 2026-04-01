import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionEntry {
  id: string;
  name: string;
  createdAt: string;
  workingDirectory?: string;
}

interface UserSessions {
  activeSessionId: string | null;
  sessions: SessionEntry[];
}

type StoreData = Record<string, UserSessions>;

export class SessionStore {
  private readonly filePath: string;
  private data: StoreData = {};

  constructor(filePath?: string) {
    this.filePath = filePath ?? resolve("./sessions.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.data = JSON.parse(raw) as StoreData;
    } catch {
      this.data = {};
    }
  }

  private async save(): Promise<void> {
    // Atomic write: write to a temp file then rename to prevent corruption
    const tmpPath = `${this.filePath}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }

  private ensureUser(senderId: string): UserSessions {
    if (!this.data[senderId]) {
      this.data[senderId] = { activeSessionId: null, sessions: [] };
    }
    return this.data[senderId];
  }

  getActiveSession(senderId: string): SessionEntry | null {
    const user = this.data[senderId];
    if (!user?.activeSessionId) return null;
    return user.sessions.find((s) => s.id === user.activeSessionId) ?? null;
  }

  getAllSessions(senderId: string): SessionEntry[] {
    return this.data[senderId]?.sessions ?? [];
  }

  async createSession(senderId: string, name?: string): Promise<SessionEntry> {
    const user = this.ensureUser(senderId);
    const sessionName = name ?? this.getNextSessionName(senderId);
    const entry: SessionEntry = {
      id: randomUUID(),
      name: sessionName,
      createdAt: new Date().toISOString(),
    };
    user.sessions.push(entry);
    user.activeSessionId = entry.id;
    await this.save();
    return entry;
  }

  async setActiveSession(senderId: string, nameOrId: string): Promise<SessionEntry | null> {
    const user = this.data[senderId];
    if (!user) return null;

    const match = user.sessions.find(
      (s) => s.name === nameOrId || s.id === nameOrId || s.id.startsWith(nameOrId),
    );
    if (!match) return null;

    user.activeSessionId = match.id;
    await this.save();
    return match;
  }

  async setWorkingDirectory(senderId: string, sessionId: string, dir: string): Promise<void> {
    const user = this.data[senderId];
    if (!user) return;
    const session = user.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.workingDirectory = dir;
      await this.save();
    }
  }

  private getNextSessionName(senderId: string): string {
    const sessions = this.data[senderId]?.sessions ?? [];
    return `session-${sessions.length + 1}`;
  }
}
