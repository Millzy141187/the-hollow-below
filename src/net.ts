import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { PeerPresence } from './types';

export type NetStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface NetHandlers {
  onPeers: (peers: PeerPresence[]) => void;
  onMessage: (type: string, data: Record<string, unknown>, from: string) => void;
  onStatus: (status: NetStatus, detail?: string) => void;
}

/**
 * One Supabase Realtime channel per room. Broadcast carries game messages,
 * presence carries the party roster (and the host's current depth/seed).
 * No database tables are needed.
 */
export class Net {
  readonly me: PeerPresence;
  readonly code: string;
  private client: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private handlers: NetHandlers;
  private closed = false;
  private lastTrack = 0;
  peers: PeerPresence[] = [];

  constructor(url: string, key: string, code: string, me: PeerPresence, handlers: NetHandlers) {
    this.code = code;
    this.me = me;
    this.handlers = handlers;
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 30 } },
    });
  }

  connect(): Promise<void> {
    this.handlers.onStatus('connecting');
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error('Could not reach Supabase Realtime. Check your URL, key and network.')),
        12000
      );

      const channel = this.client.channel(`hollow:${this.code}`, {
        config: {
          presence: { key: this.me.id },
          broadcast: { self: false, ack: false },
        },
      });
      this.channel = channel;

      channel.on('presence', { event: 'sync' }, () => this.emitPeers());
      channel.on('presence', { event: 'join' }, () => this.emitPeers());
      channel.on('presence', { event: 'leave' }, () => this.emitPeers());
      channel.on('broadcast', { event: 'msg' }, (message) => {
        const payload = (message as { payload?: unknown } | null)?.payload;
        this.handleMessage(payload);
      });

      channel.subscribe((status, err) => {
        if (this.closed) return;
        if (status === 'SUBSCRIBED') {
          this.handlers.onStatus('connected');
          channel
            .track({ ...this.me })
            .then(() => {
              this.emitPeers();
              finish();
            })
            .catch(() => {
              finish(new Error('Joined the channel but presence failed. Enable Realtime in Supabase.'));
            });
        } else if (status === 'CHANNEL_ERROR') {
          const error = new Error(
            "Could not join the room. Check the Supabase URL/key and that Realtime is enabled."
          );
          this.handlers.onStatus('error', err?.message);
          finish(error);
        } else if (status === 'TIMED_OUT') {
          this.handlers.onStatus('reconnecting');
        } else if (status === 'CLOSED') {
          this.handlers.onStatus('reconnecting');
        }
      });
    });
  }

  private handleMessage(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as { t?: unknown; d?: unknown; f?: unknown };
    if (typeof p.t !== 'string' || p.t.length === 0 || p.t.length > 24) return;
    if (typeof p.f !== 'string' || p.f === this.me.id) return;
    const data = p.d && typeof p.d === 'object' ? (p.d as Record<string, unknown>) : {};
    this.handlers.onMessage(p.t, data, p.f);
  }

  private emitPeers(): void {
    if (!this.channel) return;
    const state = this.channel.presenceState<PeerPresence>();
    const list: PeerPresence[] = [];
    for (const key of Object.keys(state)) {
      const metas = state[key];
      if (!Array.isArray(metas)) continue;
      for (const meta of metas) {
        if (!meta || typeof meta.id !== 'string' || meta.id.length === 0) continue;
        if (typeof meta.name !== 'string' || typeof meta.joinedAt !== 'number') continue;
        list.push({
          id: meta.id,
          name: meta.name.slice(0, 14),
          color: typeof meta.color === 'string' ? meta.color.slice(0, 16) : '#b6a68e',
          joinedAt: meta.joinedAt,
          floor: Number.isFinite(meta.floor) ? Number(meta.floor) : 1,
          seed: Number.isFinite(meta.seed) ? Number(meta.seed) >>> 0 : 0,
          hp: Number.isFinite(meta.hp) ? Number(meta.hp) : 100,
          dead: Boolean(meta.dead),
          host: Boolean(meta.host),
          fuses: Number.isFinite(meta.fuses) ? Number(meta.fuses) : 0,
        });
      }
    }
    list.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    this.peers = list;
    this.handlers.onPeers(list);
  }

  async updatePresence(patch: Partial<PeerPresence>): Promise<void> {
    Object.assign(this.me, patch);
    if (!this.channel || this.closed) return;
    const now = performance.now();
    if (now - this.lastTrack < 700) return;
    this.lastTrack = now;
    try {
      await this.channel.track({ ...this.me });
    } catch {
      /* presence will retry on the next patch */
    }
  }

  send(type: string, data: unknown): void {
    if (!this.channel || this.closed) return;
    try {
      void this.channel.send({
        type: 'broadcast',
        event: 'msg',
        payload: { t: type, d: data, f: this.me.id },
      });
    } catch {
      /* transient send failures are non-fatal */
    }
  }

  async waitForPeers(timeoutMs: number): Promise<PeerPresence[]> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      if (this.peers.length > 0) return this.peers;
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.peers;
  }

  async leave(): Promise<void> {
    this.closed = true;
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      try {
        await channel.untrack();
      } catch {
        /* ignore */
      }
      try {
        await this.client.removeChannel(channel);
      } catch {
        /* ignore */
      }
    }
  }
}
