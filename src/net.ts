import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import type { PeerPresence } from './types';

export type NetStatus = 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface NetHandlers {
  onPeers: (peers: PeerPresence[]) => void;
  onMessage: (type: string, data: Record<string, unknown>, from: string) => void;
  onStatus: (status: NetStatus, detail?: string) => void;
}

const PRESENCE_WINDOW_MS = 30_000;
const PRESENCE_MIN_INTERVAL_MS = 10_000;
// Supabase allows 5 track/untrack calls per client per 30 seconds and closes
// the channel at the 6th. Stay well under it: three routine updates leave room
// for the initial track and a reconnect track.
const MAX_PRESENCE_TRACKS = 3;
const CONNECT_TIMEOUT_MS = 12_000;
const MAX_RECONNECT_DELAY_MS = 15_000;

/**
 * One Supabase Realtime channel per room. Broadcast carries game messages,
 * presence carries the party roster (and the host's current depth/seed).
 * No database tables are needed.
 *
 * Presence is deliberately slow: Supabase permits only five track/untrack
 * calls per client in a 30 second window, and closes the channel if that is
 * exceeded. The game loop updates the roster frequently, so those updates are
 * coalesced and rate-limited here.
 */
export class Net {
  readonly me: PeerPresence;
  readonly code: string;
  peers: PeerPresence[] = [];

  private client: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private handlers: NetHandlers;
  private closed = false;
  private lastTrack = 0;
  private presenceTimes: number[] = [];
  private lastTrackedKey = '';
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private connectTimer: number | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((error: Error) => void) | null = null;

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
    if (this.closed) return Promise.reject(new Error('This session is already closed.'));
    this.handlers.onStatus('connecting');
    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      this.connectTimer = window.setTimeout(() => {
        this.connectTimer = null;
        this.failConnect(new Error('Could not reach Supabase Realtime. Check your URL, key and network.'));
      }, CONNECT_TIMEOUT_MS);
      this.openChannel();
    });
  }

  private openChannel(): void {
    if (this.closed) return;
    const channel = this.client.channel(`hollow:${this.code}`, {
      config: {
        presence: { key: this.me.id },
        broadcast: { self: false, ack: false },
      },
    });
    this.channel = channel;
    this.lastTrackedKey = '';

    channel.on('presence', { event: 'sync' }, () => this.emitPeers());
    channel.on('presence', { event: 'join' }, () => this.emitPeers());
    channel.on('presence', { event: 'leave' }, () => this.emitPeers());
    channel.on('broadcast', { event: 'msg' }, (message) => {
      const payload = (message as { payload?: unknown } | null)?.payload;
      this.handleMessage(payload);
    });

    channel.subscribe((status, err) => this.handleStatus(channel, status, err));
  }

  private handleStatus(channel: RealtimeChannel, status: string, err?: Error): void {
    if (this.closed || channel !== this.channel) return;

    if (status === 'SUBSCRIBED') {
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      void this.onSubscribed(channel);
      return;
    }

    if (status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT' && status !== 'CLOSED') return;

    if (this.resolveConnect) {
      const message =
        status === 'CHANNEL_ERROR'
          ? 'Could not join the room. Check the Supabase URL/key and that Realtime is enabled.'
          : 'The Realtime connection timed out. Check your network and try again.';
      this.failConnect(new Error(message));
      return;
    }

    this.scheduleReconnect(err);
  }

  private async onSubscribed(channel: RealtimeChannel): Promise<void> {
    await this.waitForPresenceSlot();
    if (this.closed || channel !== this.channel) return;
    const tracked = await this.trackNow(channel, true);
    if (this.closed || channel !== this.channel) return;

    if (!tracked) {
      if (this.resolveConnect) {
        this.failConnect(
          new Error(
            'Joined the channel but presence failed. Check that Realtime is enabled for this Supabase project.'
          )
        );
      } else {
        this.scheduleReconnect();
      }
      return;
    }

    this.handlers.onStatus('connected');
    this.emitPeers();

    if (this.resolveConnect) {
      const resolve = this.resolveConnect;
      this.resolveConnect = null;
      this.rejectConnect = null;
      if (this.connectTimer !== null) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      resolve();
    }
  }

  private failConnect(error: Error): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const reject = this.rejectConnect;
    this.resolveConnect = null;
    this.rejectConnect = null;
    if (reject) reject(error);
  }

  private scheduleReconnect(err?: Error): void {
    if (this.closed || this.reconnectTimer !== null) return;
    this.handlers.onStatus('reconnecting', err?.message);
    const attempt = this.reconnectAttempt++;
    const presenceRateLimited = /presence|rate.?limit/i.test(err?.message ?? '');
    const delay = presenceRateLimited
      ? PRESENCE_WINDOW_MS + 1_000
      : Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** Math.min(attempt, 4)) +
        Math.floor(Math.random() * 350);

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      const old = this.channel;
      this.channel = null;
      const open = (): void => {
        if (!this.closed) this.openChannel();
      };
      if (old) {
        void this.client
          .removeChannel(old)
          .then(open)
          .catch(open);
      } else {
        open();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /** Never start a fresh channel's presence over an exhausted window. */
  private async waitForPresenceSlot(): Promise<void> {
    while (!this.closed) {
      const now = performance.now();
      this.presenceTimes = this.presenceTimes.filter((at) => now - at < PRESENCE_WINDOW_MS);
      if (this.presenceTimes.length < MAX_PRESENCE_TRACKS) return;
      const oldest = this.presenceTimes[0] ?? now;
      const wait = Math.max(400, PRESENCE_WINDOW_MS - (now - oldest) + 50);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  private async trackNow(channel: RealtimeChannel, force: boolean): Promise<boolean> {
    if (this.closed || channel !== this.channel) return false;
    const now = performance.now();
    this.presenceTimes = this.presenceTimes.filter((at) => now - at < PRESENCE_WINDOW_MS);

    if (!force) {
      if (now - this.lastTrack < PRESENCE_MIN_INTERVAL_MS) return false;
      if (this.presenceTimes.length >= MAX_PRESENCE_TRACKS) return false;
    }

    this.presenceTimes.push(now);
    this.lastTrack = now;
    try {
      const result = await channel.track({ ...this.me });
      if (result !== 'ok') {
        this.lastTrack = 0;
        return false;
      }
      this.lastTrackedKey = JSON.stringify(this.me);
      return true;
    } catch {
      this.lastTrack = 0;
      return false;
    }
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
    if (this.closed || !this.channel) return;

    const key = JSON.stringify(this.me);
    if (key === this.lastTrackedKey) return;

    const now = performance.now();
    this.presenceTimes = this.presenceTimes.filter((at) => now - at < PRESENCE_WINDOW_MS);
    if (now - this.lastTrack < PRESENCE_MIN_INTERVAL_MS) return;
    if (this.presenceTimes.length >= MAX_PRESENCE_TRACKS) return;

    await this.trackNow(this.channel, false);
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

  /**
   * Wait for presence to settle. A joining client must wait for somebody
   * other than itself; its own presence is always in the state first. With
   * requireSeed it keeps waiting for a peer that carries a room seed, which
   * is the host rather than another joiner.
   */
  async waitForPeers(timeoutMs: number, requireOther = false, requireSeed = false): Promise<PeerPresence[]> {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const hasOther = this.peers.some(
        (peer) => peer.id !== this.me.id && (!requireSeed || peer.seed > 0)
      );
      if (this.peers.length > 0 && (!requireOther || hasOther)) return this.peers;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return this.peers;
  }

  async leave(): Promise<void> {
    this.closed = true;
    this.clearReconnectTimer();
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.resolveConnect = null;
    this.rejectConnect = null;

    const channel = this.channel;
    this.channel = null;
    if (!channel) return;
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
