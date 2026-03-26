import { nanoid } from 'nanoid';

export interface VendorSession {
  sessionId: string;
  slug: string;
  containerUrl: string;
  mcpPath: string;
  headers: Record<string, string>;
}

export interface AggregatedSession {
  id: string;
  userId: string;
  orgId?: string;
  vendors: Map<string, VendorSession>;
  lastUsed: number;
}

export class AggregatedSessionStore {
  private sessions = new Map<string, AggregatedSession>();
  private readonly ttlMs: number;
  private readonly pruneTimer: ReturnType<typeof setInterval>;

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.pruneTimer = setInterval(() => this.prune(), 5 * 60 * 1000);
    this.pruneTimer.unref();
  }

  create(userId: string, orgId?: string): AggregatedSession {
    const session: AggregatedSession = {
      id: `agg-${nanoid()}`,
      userId,
      orgId,
      vendors: new Map(),
      lastUsed: Date.now(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): AggregatedSession | undefined {
    const session = this.sessions.get(id);
    if (session) {
      session.lastUsed = Date.now();
    }
    return session;
  }

  delete(id: string): void {
    this.sessions.delete(id);
  }

  addVendor(id: string, vendor: VendorSession): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.vendors.set(vendor.slug, vendor);
    session.lastUsed = Date.now();
  }

  prune(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsed > this.ttlMs) {
        this.sessions.delete(id);
      }
    }
  }
}
