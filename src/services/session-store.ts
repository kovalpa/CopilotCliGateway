import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type BackendType = "cli" | "acp";

export interface SessionEntry {
  id: string;
  name: string;
  createdAt: string;
  workingDirectory?: string;
  /** Which backend created this session. */
  backend?: BackendType;
  /** ACP session ID (persisted so sessions can be restored after restart). */
  acpSessionId?: string;
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
    await writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  private ensureUser(senderId: string): UserSessions {
    if (!this.data[senderId]) {
      this.data[senderId] = { activeSessionId: null, sessions: [] };
    }
    return this.data[senderId];
  }

  getActiveSession(senderId: string, backend?: BackendType): SessionEntry | null {
    const user = this.data[senderId];
    if (!user?.activeSessionId) return null;
    const session = user.sessions.find((s) => s.id === user.activeSessionId) ?? null;
    if (!session) return null;
    // If backend is specified, only return the session if it matches
    if (backend && session.backend && session.backend !== backend) return null;
    return session;
  }

  getAllSessions(senderId: string, backend?: BackendType): SessionEntry[] {
    const sessions = this.data[senderId]?.sessions ?? [];
    if (!backend) return sessions;
    return sessions.filter((s) => !s.backend || s.backend === backend);
  }

  async createSession(senderId: string, name?: string, backend?: BackendType): Promise<SessionEntry> {
    const user = this.ensureUser(senderId);
    const sessionName = name ?? this.getNextSessionName(senderId, backend);
    const entry: SessionEntry = {
      id: randomUUID(),
      name: sessionName,
      createdAt: new Date().toISOString(),
      backend,
    };
    user.sessions.push(entry);
    user.activeSessionId = entry.id;
    await this.save();
    return entry;
  }

  async setActiveSession(senderId: string, nameOrId: string, backend?: BackendType): Promise<SessionEntry | null> {
    const user = this.data[senderId];
    if (!user) return null;

    const candidates = backend
      ? user.sessions.filter((s) => !s.backend || s.backend === backend)
      : user.sessions;

    const match = candidates.find(
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

  async setAcpSessionId(senderId: string, sessionId: string, acpSessionId: string): Promise<void> {
    const user = this.data[senderId];
    if (!user) return;
    const session = user.sessions.find((s) => s.id === sessionId);
    if (session) {
      session.acpSessionId = acpSessionId;
      await this.save();
    }
  }

  private getNextSessionName(senderId: string, backend?: BackendType): string {
    const all = this.data[senderId]?.sessions ?? [];
    const sessions = backend ? all.filter((s) => !s.backend || s.backend === backend) : all;
    return `session-${sessions.length + 1}`;
  }
}
