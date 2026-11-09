import type {
  GameHooks,
  GameResult,
  HudState,
  Monster,
  MonsterKind,
  PartyMember,
  PeerPresence,
  Pickup,
  RemotePlayer,
} from '../types';
import { GameAudio } from './audio';
import {
  generateDungeon,
  isBlocked,
  lineOfSight,
  tileAt,
  WALL,
  type Dungeon,
  type Vec,
} from './dungeon';
import { angleDiff, clamp, hash2, lerp, mulberry32 } from './rng';
import { drawCaughtCutscene, type CaughtScene } from './cinematic';

const TILE = 40;
const BODY_RADIUS = 0.3;
const SYNC_HZ = 0.085;
const MONSTER_HZ = 0.1;

interface Player {
  x: number;
  y: number;
  facing: number;
  hp: number;
  maxHp: number;
  stamina: number;
  battery: number;
  attackCd: number;
  attackT: number;
  flashlight: boolean;
  dead: boolean;
  stepT: number;
  walk: number;
  dread: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  gravity: number;
  glow: boolean;
}

interface Splat {
  x: number;
  y: number;
  r: number;
  rot: number;
  alpha: number;
}

interface Ripple {
  x: number;
  y: number;
  t: number;
  life: number;
}

/** A shape at the edge of the light that is never there when you look again. */
interface Ghost {
  x: number;
  y: number;
  t: number;
  life: number;
  seed: number;
}

interface GameOptions {
  canvas: HTMLCanvasElement;
  playerId: string;
  name: string;
  color: string;
  seed: number;
  floor: number;
  multiplayer: boolean;
  reducedFx: boolean;
  audio: GameAudio;
  hooks: GameHooks;
  peers?: PeerPresence[];
  send?: (type: string, data: unknown) => void;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isMonsterKind(value: unknown): value is MonsterKind {
  return value === 'crawler' || value === 'stalker' || value === 'wailer';
}

function monsterStats(kind: MonsterKind, floor: number): {
  hp: number;
  speed: number;
  damage: number;
  sight: number;
  attackCd: number;
} {
  if (kind === 'crawler') {
    return {
      hp: 24 + floor * 6,
      speed: 2.55 + Math.min(1.1, floor * 0.07),
      damage: 7 + floor,
      sight: 8,
      attackCd: 1.05,
    };
  }
  if (kind === 'stalker') {
    return {
      hp: 62 + floor * 12,
      speed: 2.05 + Math.min(0.8, floor * 0.05),
      damage: 14 + floor * 1.6,
      sight: 9.5,
      attackCd: 1.35,
    };
  }
  return {
    hp: 44 + floor * 8,
    speed: 1.35 + Math.min(0.4, floor * 0.03),
    damage: 5 + floor,
    sight: 11,
    attackCd: 1.6,
  };
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private lightCanvas: HTMLCanvasElement;
  private lightCtx: CanvasRenderingContext2D;
  private audio: GameAudio;
  private hooks: GameHooks;
  private sendFn: ((type: string, data: unknown) => void) | null;
  private multiplayer: boolean;
  private reducedFx: boolean;
  private playerId: string;
  private name: string;
  private color: string;

  private baseSeed: number;
  private floor: number;
  private dungeon: Dungeon;
  private explored: Uint8Array;
  private visible = new Set<number>();
  private pickups: Pickup[];
  private fuses = 0;

  private player: Player;
  private remote = new Map<string, RemotePlayer>();
  private monsters = new Map<string, Monster>();
  private particles: Particle[] = [];
  private splats: Splat[] = [];
  private ripples: Ripple[] = [];
  private ghost: Ghost | null = null;
  private fogPattern: CanvasPattern | null = null;
  private ambientClock = 6;
  private dripClock = 1.6;
  private scareClock = 22;
  private stingClock = 8;
  private breathClock = 3;
  private buzzClock = 2;
  private monsterCueClock = 3;

  private peers: PeerPresence[] = [];
  private hostId = '';
  private wasHost = false;

  private time = 0;
  private elapsed = 0;
  private running = false;
  private paused = false;
  private ended = false;
  private endedCause = '';
  private deadAt = 0;
  private deathScene: CaughtScene | null = null;
  private raf = 0;
  private lastFrame = 0;
  private startedAt = 0;

  private keys = new Set<string>();
  private aimAngle = 0;
  private mouseActive = false;
  private mouseX = 0;
  private mouseY = 0;
  private cam = { x: 0, y: 0 };
  private camReady = false;
  private shake = 0;
  private flashTimer = 0;
  private descendTimer = 0;
  private spectateId: string | null = null;

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private grainPattern: CanvasPattern | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private lastHud = 0;
  private lastState = 0;
  private lastMonsters = 0;
  private stepSound = 0;
  private lowLightWarned = false;
  private lowHpWarned = false;

  constructor(options: GameOptions) {
    this.canvas = options.canvas;
    this.audio = options.audio;
    this.hooks = options.hooks;
    this.sendFn = options.send ?? null;
    this.multiplayer = options.multiplayer;
    this.reducedFx = options.reducedFx;
    this.playerId = options.playerId;
    this.name = options.name;
    this.color = options.color;
    this.baseSeed = options.seed >>> 0;
    this.floor = clamp(Math.floor(options.floor), 1, 60);
    this.dungeon = generateDungeon(this.baseSeed, this.floor);
    this.explored = new Uint8Array(this.dungeon.w * this.dungeon.h);
    this.pickups = this.dungeon.pickups;
    this.peers = options.peers ?? [];

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('This browser does not support canvas 2D.');
    this.ctx = ctx;

    this.lightCanvas = document.createElement('canvas');
    const lightCtx = this.lightCanvas.getContext('2d');
    if (!lightCtx) throw new Error('This browser does not support canvas 2D.');
    this.lightCtx = lightCtx;

    this.player = {
      x: this.dungeon.spawn.x,
      y: this.dungeon.spawn.y,
      facing: 0,
      hp: 100,
      maxHp: 100,
      stamina: 100,
      battery: 100,
      attackCd: 0,
      attackT: 0,
      flashlight: true,
      dead: false,
      stepT: 0,
      walk: 0,
      dread: 0,
    };

    this.makeGrain();
    this.makeFog();
    this.resize();
    this.hooks.presence({ hp: 100, dead: false, floor: this.floor, seed: this.baseSeed });
    this.setPeers(this.peers);
    this.hostId = this.hostId || this.playerId;
    this.wasHost = this.isHost;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = performance.now();
    this.lastFrame = this.startedAt;
    if (this.isHost && this.monsters.size === 0) this.spawnMonsters();
    this.wasHost = this.isHost;

    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('resize', this.onResize);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);

    this.raf = requestAnimationFrame(this.loop);
    this.hooks.toast('Recover three fuses. Then find the stairwell.', 'info');
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.resizeObserver?.disconnect();
  }

  setPaused(paused: boolean): void {
    this.paused = paused || this.ended;
    if (!paused) this.lastFrame = performance.now();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  // ── Networking ────────────────────────────────────────────────

  get isHost(): boolean {
    if (!this.multiplayer) return true;
    return !this.hostId || this.hostId === this.playerId;
  }

  setPeers(peers: PeerPresence[]): void {
    const previous = new Set(this.peers.map((p) => p.id));
    this.peers = peers.slice();
    const sorted = peers
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    const declaredHost = peers.find((peer) => peer.host && peer.id)?.id;
    this.hostId = declaredHost ?? sorted[0]?.id ?? this.playerId;

    // Presence can flicker during a reconnect. Keep a recently seen player in
    // the world until their messages have been silent for a while.
    const present = new Set(peers.map((p) => p.id));
    for (const [id, rp] of [...this.remote]) {
      if (!present.has(id) && this.time - rp.lastSeen > 12) this.remote.delete(id);
    }

    if (this.multiplayer && this.running) {
      if (this.isHost) {
        if (this.monsters.size === 0) this.spawnMonsters();
        if (!this.wasHost) {
          this.sendMonsters();
          this.wasHost = true;
        }
        for (const p of peers) {
          if (p.id !== this.playerId && !previous.has(p.id)) {
            this.sendFn?.('sync', {
              to: p.id,
              seed: this.baseSeed,
              floor: this.floor,
              fuses: this.fuses,
            });
          }
        }
      } else {
        this.wasHost = false;
      }
    }
  }

  receive(type: string, data: Record<string, unknown>, from: string): void {
    if (from === this.playerId || this.ended) return;
    switch (type) {
      case 'ps':
        this.receivePlayer(data, from);
        break;
      case 'ms':
        if (!this.isHost) this.receiveMonsters(data);
        break;
      case 'hit':
        if (this.isHost) this.receiveRemoteHit(data, from);
        break;
      case 'hurt':
        if (data.target === this.playerId) {
          const amount = clamp(num(data.amount), 1, 40);
          this.damagePlayer(amount, num(data.x), num(data.y));
        }
        break;
      case 'scream': {
        const kind = data.kind;
        this.audio.scream(isMonsterKind(kind) ? kind : 'wailer');
        this.shake = Math.min(1, this.shake + 0.22);
        break;
      }
      case 'take':
        if (this.isHost && typeof data.id === 'string') this.grantPickup(data.id, from);
        break;
      case 'grant':
        if (!this.isHost) this.applyGrant(data);
        break;
      case 'descend':
        if (this.isHost) this.beginDescend();
        break;
      case 'desc':
        if (!this.isHost && this.descendTimer <= 0 && this.fuses >= 3) {
          this.descendTimer = 4;
          this.audio.descend();
        }
        break;
      case 'floor':
        this.advanceFloor(clamp(num(data.floor, this.floor + 1), 2, 99));
        break;
      case 'sync':
        if (data.to === this.playerId) this.applySync(data);
        break;
      case 'mhit':
        // visual only acknowledgement from the host
        break;
      default:
        break;
    }
  }

  private receivePlayer(data: Record<string, unknown>, from: string): void {
    const x = num(data.x, NaN);
    const y = num(data.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < 0 || y < 0 || x > this.dungeon.w || y > this.dungeon.h) return;
    let rp = this.remote.get(from);
    const name =
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim().slice(0, 14)
        : rp?.name ?? 'Wanderer';
    const color =
      typeof data.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(data.color)
        ? data.color
        : rp?.color ?? '#b6a68e';
    if (!rp) {
      rp = {
        id: from,
        name,
        color,
        x,
        y,
        tx: x,
        ty: y,
        facing: num(data.facing),
        hp: clamp(num(data.hp, 100), 0, 100),
        maxHp: clamp(num(data.maxHp, 100), 1, 100),
        dead: Boolean(data.dead),
        moving: Boolean(data.mv),
        sprinting: Boolean(data.sp),
        attack: 0,
        flashlight: Boolean(data.fl),
        lastSeen: this.time,
      };
      this.remote.set(from, rp);
    }
    rp.tx = x;
    rp.ty = y;
    rp.facing = num(data.facing, rp.facing);
    rp.hp = clamp(num(data.hp, rp.hp), 0, rp.maxHp);
    rp.maxHp = clamp(num(data.maxHp, rp.maxHp), 1, 100);
    rp.dead = Boolean(data.dead);
    rp.moving = Boolean(data.mv);
    rp.sprinting = Boolean(data.sp);
    rp.flashlight = Boolean(data.fl);
    rp.name = name;
    rp.color = color;
    rp.lastSeen = this.time;
    if (num(data.at) > 0) rp.attack = 0.18;
  }

  private receiveMonsters(data: Record<string, unknown>): void {
    const list = data.m;
    if (!Array.isArray(list)) return;
    const seen = new Set<string>();
    for (const raw of list.slice(0, 40)) {
      if (!Array.isArray(raw) || raw.length < 7) continue;
      const id = typeof raw[0] === 'string' ? raw[0].slice(0, 40) : '';
      const kind = raw[1];
      if (!id || !isMonsterKind(kind)) continue;
      const x = num(raw[2], NaN);
      const y = num(raw[3], NaN);
      const hp = num(raw[4], NaN);
      const maxHp = clamp(num(raw[5], 1), 1, 500);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(hp)) continue;
      if (x < 0 || y < 0 || x > this.dungeon.w || y > this.dungeon.h) continue;
      let monster = this.monsters.get(id);
      if (!monster) {
        monster = {
          id,
          kind,
          x,
          y,
          tx: x,
          ty: y,
          hp: clamp(hp, 0, maxHp),
          maxHp,
          flash: 0,
          hunt: raw[6] === 1,
          phase: Math.random() * 7,
          attackCd: 1,
          screamCd: 2,
          attackT: 0,
          targetId: null,
        };
        this.monsters.set(id, monster);
      }
      monster.kind = kind;
      monster.tx = x;
      monster.ty = y;
      monster.maxHp = maxHp;
      if (hp < monster.hp) monster.flash = 0.14;
      monster.hp = clamp(hp, 0, maxHp);
      const wasHunting = monster.hunt;
      monster.hunt = raw[6] === 1;
      if (monster.hunt && !wasHunting) {
        this.audio.scream(kind);
        if (!this.reducedFx) this.shake = Math.min(1, this.shake + 0.16);
      }
      if (raw.length > 7) monster.attackT = Math.max(monster.attackT, clamp(num(raw[7], 0), 0, 0.32));
      seen.add(id);
    }
    for (const id of [...this.monsters.keys()]) {
      if (!seen.has(id)) {
        const m = this.monsters.get(id);
        if (m) this.spawnBlood(m.x, m.y, 0.5);
        this.monsters.delete(id);
      }
    }
  }

  private receiveRemoteHit(data: Record<string, unknown>, from: string): void {
    if (typeof data.id !== 'string') return;
    const monster = this.monsters.get(data.id);
    const attacker = this.remote.get(from);
    if (!monster || !attacker) return;
    if (Math.hypot(attacker.x - monster.x, attacker.y - monster.y) > 2.6) return;
    const damage = clamp(num(data.dmg, 30), 8, 70);
    this.damageMonster(monster, damage);
  }

  private applySync(data: Record<string, unknown>): void {
    const seed = num(data.seed, this.baseSeed) >>> 0;
    const floor = clamp(num(data.floor, this.floor), 1, 60);
    const fuses = clamp(num(data.fuses, this.fuses), 0, 3);
    if (seed !== this.baseSeed || floor !== this.floor) {
      this.baseSeed = seed;
      this.floor = floor;
      this.rebuildFloor(false);
    }
    this.fuses = fuses;
    this.hooks.presence({ floor: this.floor, seed: this.baseSeed, fuses });
  }

  // ── Input ─────────────────────────────────────────────────────

  private onKeyDown = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (
      key === ' ' ||
      key === 'arrowup' ||
      key === 'arrowdown' ||
      key === 'arrowleft' ||
      key === 'arrowright'
    ) {
      event.preventDefault();
    }
    if (event.repeat) return;
    this.keys.add(key);
    if (this.paused || this.ended) return;
    if (key === 'f') this.toggleFlashlight();
    if (key === 'e') this.interact();
    if (key === ' ') this.attack();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.key.toLowerCase());
  };

  private onBlur = (): void => {
    this.keys.clear();
  };

  private onResize = (): void => {
    this.resize();
  };

  private onMouseMove = (event: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = event.clientX - rect.left;
    this.mouseY = event.clientY - rect.top;
    this.mouseActive = true;
    this.updateAim();
  };

  private onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (this.paused || this.ended) return;
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = event.clientX - rect.left;
    this.mouseY = event.clientY - rect.top;
    this.mouseActive = true;
    this.updateAim();
    this.attack();
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private updateAim(): void {
    const wx = (this.mouseX + this.cam.x) / TILE;
    const wy = (this.mouseY + this.cam.y) / TILE;
    this.aimAngle = Math.atan2(wy - this.player.y, wx - this.player.x);
  }

  private toggleFlashlight(): void {
    if (this.player.dead) return;
    if (!this.player.flashlight && this.player.battery <= 0) {
      this.audio.deny();
      this.hooks.toast('The battery is dead. Find a cell.', 'warn');
      return;
    }
    this.player.flashlight = !this.player.flashlight;
    this.audio.glass();
  }

  private nearestPickup(): Pickup | null {
    if (this.player.dead) return null;
    let best: Pickup | null = null;
    let bestDist = 1.15;
    for (const pickup of this.pickups) {
      if (pickup.taken) continue;
      const dist = Math.hypot(pickup.x - this.player.x, pickup.y - this.player.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = pickup;
      }
    }
    return best;
  }

  private nearStairs(): boolean {
    return (
      Math.hypot(this.dungeon.stairs.x - this.player.x, this.dungeon.stairs.y - this.player.y) <
      1.5
    );
  }

  private get stairOpen(): boolean {
    return this.fuses >= 3;
  }

  private getPrompt(): string {
    if (this.player.dead || this.ended || this.descendTimer > 0) return '';
    if (this.nearStairs()) {
      if (this.stairOpen) return 'Descend the stairwell';
      const missing = 3 - this.fuses;
      return `The stairwell is sealed — ${missing} fuse${missing === 1 ? '' : 's'} missing`;
    }
    const pickup = this.nearestPickup();
    if (pickup) {
      if (pickup.kind === 'fuse') return 'Take the fuse';
      if (pickup.kind === 'medkit') return 'Take the medical kit';
      return 'Take the battery cell';
    }
    return '';
  }

  private interact(): void {
    if (this.player.dead || this.ended) return;
    if (this.nearStairs()) {
      if (!this.stairOpen) {
        this.audio.deny();
        const missing = 3 - this.fuses;
        this.hooks.toast(
          `The seal holds. ${missing} fuse${missing === 1 ? '' : 's'} still lost below.`,
          'warn'
        );
        return;
      }
      if (this.isHost) this.beginDescend();
      else this.sendFn?.('descend', {});
      return;
    }
    const pickup = this.nearestPickup();
    if (!pickup) return;
    if (this.isHost) this.grantPickup(pickup.id, this.playerId);
    else this.sendFn?.('take', { id: pickup.id });
  }

  // ── Combat ────────────────────────────────────────────────────

  private attack(): void {
    if (this.player.dead || this.player.attackCd > 0 || this.paused) return;
    this.player.attackCd = 0.48;
    this.player.attackT = 0.2;
    this.audio.swing();
    const facing = this.player.facing;
    let hit = false;
    for (const monster of this.monsters.values()) {
      const dx = monster.x - this.player.x;
      const dy = monster.y - this.player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.7) continue;
      if (Math.abs(angleDiff(Math.atan2(dy, dx), facing)) > 1.08) continue;
      hit = true;
      this.spawnBlood(monster.x, monster.y, 0.8);
      if (this.isHost) {
        this.damageMonster(monster, 34);
      } else {
        this.sendFn?.('hit', { id: monster.id, dmg: 34 });
      }
    }
    if (hit) {
      this.audio.hit();
      this.shake = Math.min(1, this.shake + 0.12);
    }
  }

  private damageMonster(monster: Monster, damage: number): void {
    if (this.ended) return;
    if (!this.monsters.has(monster.id)) return;
    monster.hp -= damage;
    monster.flash = 0.16;
    monster.hunt = true;
    if (monster.hp > 0) return;
    this.monsters.delete(monster.id);
    this.spawnBlood(monster.x, monster.y, 2.4);
    this.splats.push({
      x: monster.x,
      y: monster.y,
      r: 0.4 + Math.random() * 0.35,
      rot: Math.random() * Math.PI,
      alpha: 0.5,
    });
    this.audio.monsterDie();
    this.shake = Math.min(1, this.shake + 0.16);
    if (this.isHost && this.multiplayer) this.sendMonsters();
  }

  private damagePlayer(amount: number, sourceX: number, sourceY: number): void {
    if (this.player.dead || this.ended) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.flashTimer = 0.3;
    this.shake = Math.min(1.2, this.shake + 0.3 + amount / 120);
    this.spawnBlood(
      this.player.x + (sourceX - this.player.x) * 0.15,
      this.player.y + (sourceY - this.player.y) * 0.15,
      0.9
    );
    this.audio.hurt();
    if (this.player.hp <= 0) this.die();
  }

  private die(): void {
    if (this.player.dead) return;
    this.player.dead = true;
    this.player.flashlight = false;
    this.player.attackT = 0;
    this.deadAt = this.time;
    const killer = this.killerKind();
    this.deathScene = {
      t: 0,
      duration: 5.2,
      kind: killer,
      seed: (Math.random() * 0xffffffff) >>> 0,
      playerName: this.name,
    };
    this.shake = 1.2;
    this.spawnBlood(this.player.x, this.player.y, 3);
    this.splats.push({
      x: this.player.x,
      y: this.player.y,
      r: 0.6,
      rot: Math.random() * Math.PI,
      alpha: 0.6,
    });
    this.audio.caught(killer);
    this.hooks.presence({ dead: true, hp: 0 });
    this.hooks.toast('You died in the dark.', 'blood');
    this.lastState = -1;
  }

  private killerKind(): MonsterKind {
    let best: MonsterKind = 'stalker';
    let bestDist = Infinity;
    for (const monster of this.monsters.values()) {
      const dist = Math.hypot(monster.x - this.player.x, monster.y - this.player.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = monster.kind;
      }
    }
    return best;
  }

  private hurtTarget(targetId: string, amount: number, x: number, y: number): void {
    if (targetId === this.playerId) {
      this.damagePlayer(amount, x, y);
    } else {
      this.sendFn?.('hurt', { target: targetId, amount, x, y });
    }
  }

  // ── Pickups and floors ────────────────────────────────────────

  private grantPickup(id: string, byId: string): void {
    if (!this.isHost) return;
    const pickup = this.pickups.find((p) => p.id === id && !p.taken);
    if (!pickup) return;
    if (byId !== this.playerId) {
      const rp = this.remote.get(byId);
      if (!rp || rp.dead) return;
      if (Math.hypot(rp.x - pickup.x, rp.y - pickup.y) > 2.5) return;
    }
    const grant = {
      id,
      kind: pickup.kind,
      by: byId,
      fuses: Math.min(3, this.fuses + (pickup.kind === 'fuse' ? 1 : 0)),
    };
    this.applyGrant(grant);
    this.sendFn?.('grant', grant);
  }

  private applyGrant(data: Record<string, unknown>): void {
    const id = typeof data.id === 'string' ? data.id : '';
    const pickup = this.pickups.find((p) => p.id === id);
    if (!pickup || pickup.taken) return;
    pickup.taken = true;
    const kind = data.kind;
    const previousFuses = this.fuses;
    if (kind === 'fuse') {
      this.fuses = clamp(num(data.fuses, this.fuses + 1), 0, 3);
      this.hooks.presence({ fuses: this.fuses });
    }
    const bySelf = data.by === this.playerId;
    if (bySelf) {
      if (kind === 'medkit') {
        this.player.hp = Math.min(this.player.maxHp, this.player.hp + 35);
        this.hooks.toast('Medical kit used. +35 vitals.', 'info');
      } else if (kind === 'battery') {
        this.player.battery = Math.min(100, this.player.battery + 60);
        this.hooks.toast('Battery cell fitted. +60% light.', 'info');
      }
      this.audio.pickup();
    }
    if (kind === 'fuse') {
      this.audio.fuse();
      if (this.fuses >= 3 && previousFuses < 3) {
        this.hooks.toast('The stairwell seal breaks. Get to the stairs.', 'info');
        this.audio.descend();
      } else if (bySelf) {
        this.hooks.toast(`Fuse recovered — ${this.fuses}/3.`, 'info');
      } else {
        this.hooks.toast(`A companion recovered a fuse — ${this.fuses}/3.`, 'info');
      }
    }
  }

  private beginDescend(): void {
    if (!this.isHost || this.ended || this.descendTimer > 0) return;
    if (!this.stairOpen) return;
    this.descendTimer = 4;
    this.audio.descend();
    this.sendFn?.('desc', {});
  }

  private advanceFloor(floor: number): void {
    if (this.ended) return;
    this.floor = clamp(floor, 2, 99);
    this.rebuildFloor(true);
    this.hooks.presence({ floor: this.floor, hp: Math.round(this.player.hp), dead: false });
    if (this.isHost) {
      this.spawnMonsters();
      this.sendMonsters();
    }
    this.hooks.toast(`DEPTH ${this.floor} — the air changes. Something knows you are here.`, 'warn');
    this.audio.floorArrive();
  }

  private rebuildFloor(advance: boolean): void {
    this.dungeon = generateDungeon(this.baseSeed, this.floor);
    this.explored = new Uint8Array(this.dungeon.w * this.dungeon.h);
    this.pickups = this.dungeon.pickups;
    this.monsters.clear();
    this.particles = [];
    this.splats = [];
    this.ripples = [];
    this.ghost = null;
    this.ambientClock = 5;
    this.dripClock = 1.6;
    this.scareClock = 18;
    this.stingClock = 6;
    this.monsterCueClock = 3;
    this.fuses = 0;
    this.descendTimer = 0;

    const wasDead = this.player.dead;
    this.player.x = this.dungeon.spawn.x;
    this.player.y = this.dungeon.spawn.y;
    this.player.facing = 0;
    this.player.dead = false;
    this.player.attackCd = 0;
    this.player.attackT = 0;
    this.player.stamina = 100;
    if (advance) {
      this.player.hp = wasDead ? 50 : Math.min(this.player.maxHp, this.player.hp + 20);
      this.player.battery = Math.min(100, this.player.battery + 25);
      if (this.player.battery <= 0) this.player.flashlight = false;
    }
    this.deadAt = 0;
    this.spectateId = null;
    this.camReady = false;
    this.visible.clear();
    for (const rp of this.remote.values()) {
      rp.tx = this.dungeon.spawn.x;
      rp.ty = this.dungeon.spawn.y;
      rp.x = rp.tx;
      rp.y = rp.ty;
      rp.dead = false;
    }
  }

  // ── Monsters ──────────────────────────────────────────────────

  private spawnMonsters(): void {
    if (!this.isHost) return;
    const rand = mulberry32(hash2(this.baseSeed, this.floor * 131 + 17));
    const count = Math.min(26, 5 + Math.floor(this.floor * 2.6));
    const kinds: MonsterKind[] = ['crawler', 'crawler', 'stalker'];
    if (this.floor >= 2) kinds.push('wailer');
    if (this.floor >= 3) kinds.push('stalker', 'crawler');
    for (let i = 0; i < count; i++) {
      const kind = kinds[Math.floor(rand() * kinds.length) % kinds.length];
      let pos: Vec | null = null;
      for (let tries = 0; tries < 30; tries++) {
        const point = this.dungeon.spawnPoints[Math.floor(rand() * this.dungeon.spawnPoints.length)];
        if (!point) break;
        const dist = Math.hypot(point.x - this.dungeon.spawn.x, point.y - this.dungeon.spawn.y);
        if (dist < 6.5) continue;
        if (isBlocked(this.dungeon, point.x, point.y, 0.3)) continue;
        pos = point;
        break;
      }
      if (!pos) continue;
      const stats = monsterStats(kind, this.floor);
      this.monsters.set(`m${this.floor}-${i}`, {
        id: `m${this.floor}-${i}`,
        kind,
        x: pos.x,
        y: pos.y,
        tx: pos.x,
        ty: pos.y,
        hp: stats.hp,
        maxHp: stats.hp,
        flash: 0,
        hunt: false,
        phase: rand() * Math.PI * 2,
        attackCd: 1 + rand(),
        screamCd: 3 + rand() * 5,
        attackT: 0,
        targetId: null,
      });
    }
    this.lastMonsters = this.time;
  }

  private updateMonsters(dt: number): void {
    if (!this.isHost) {
      for (const monster of this.monsters.values()) {
        monster.x = lerp(monster.x, monster.tx, Math.min(1, dt * 10));
        monster.y = lerp(monster.y, monster.ty, Math.min(1, dt * 10));
        monster.phase += dt * (monster.hunt ? 4.5 : 1.4);
        monster.flash = Math.max(0, monster.flash - dt);
        monster.attackT = Math.max(0, monster.attackT - dt);
      }
      return;
    }

    interface Target {
      id: string;
      x: number;
      y: number;
    }
    const targets: Target[] = [];
    if (!this.player.dead) {
      targets.push({ id: this.playerId, x: this.player.x, y: this.player.y });
    }
    for (const rp of this.remote.values()) {
      if (!rp.dead) targets.push({ id: rp.id, x: rp.x, y: rp.y });
    }
    if (targets.length === 0) return;

    for (const monster of this.monsters.values()) {
      monster.flash = Math.max(0, monster.flash - dt);
      monster.attackCd -= dt;
      monster.screamCd -= dt;
      monster.attackT = Math.max(0, monster.attackT - dt);
      const stats = monsterStats(monster.kind, this.floor);

      let target: Target | null = null;
      let targetDist = Infinity;
      for (const candidate of targets) {
        const dist = Math.hypot(candidate.x - monster.x, candidate.y - monster.y);
        if (dist < targetDist) {
          targetDist = dist;
          target = candidate;
        }
      }
      if (!target) continue;

      const sees =
        targetDist < stats.sight &&
        lineOfSight(this.dungeon, monster.x, monster.y, target.x, target.y);
      if (sees) {
        if (!monster.hunt) {
          this.audio.scream(monster.kind);
          if (!this.reducedFx) this.shake = Math.min(1, this.shake + 0.18);
        }
        monster.hunt = true;
        monster.targetId = target.id;
      } else if (targetDist > stats.sight + 5) {
        monster.hunt = false;
        monster.targetId = null;
      }

      monster.phase += dt * (monster.hunt ? 6 : 1.5);

      if (monster.hunt) {
        const dx = target.x - monster.x;
        const dy = target.y - monster.y;
        const dist = Math.max(0.001, Math.hypot(dx, dy));
        let mx = dx / dist;
        let my = dy / dist;

        for (const other of this.monsters.values()) {
          if (other === monster) continue;
          const ox = monster.x - other.x;
          const oy = monster.y - other.y;
          const od = Math.hypot(ox, oy);
          if (od > 0.001 && od < 0.85) {
            mx += (ox / od) * 0.7;
            my += (oy / od) * 0.7;
          }
        }
        const speed = stats.speed * (1 + Math.min(0.35, (this.floor - 1) * 0.03));
        const step = speed * dt;
        let moved = false;
        const nx = monster.x + mx * step;
        const ny = monster.y + my * step;
        if (!isBlocked(this.dungeon, nx, monster.y, 0.26)) {
          monster.x = nx;
          moved = true;
        }
        if (!isBlocked(this.dungeon, monster.x, ny, 0.26)) {
          monster.y = ny;
          moved = true;
        }
        if (!moved) {
          const angle = Math.atan2(my, mx) + (Math.random() < 0.5 ? 1.1 : -1.1);
          const sx = monster.x + Math.cos(angle) * step;
          const sy = monster.y + Math.sin(angle) * step;
          if (!isBlocked(this.dungeon, sx, sy, 0.26)) {
            monster.x = sx;
            monster.y = sy;
          }
        }

        if (dist < 1.0 && monster.attackCd <= 0) {
          monster.attackCd = stats.attackCd;
          monster.attackT = 0.32;
          this.hurtTarget(target.id, Math.round(stats.damage), monster.x, monster.y);
          this.shake = Math.min(1, this.shake + 0.08);
        }

        if (monster.kind === 'wailer' && monster.screamCd <= 0 && dist < 12) {
          monster.screamCd = 8 + Math.random() * 5;
          this.audio.scream('wailer');
          this.sendFn?.('scream', { x: monster.x, y: monster.y, kind: 'wailer' });
          this.shake = Math.min(1, this.shake + 0.2);
          for (const other of this.monsters.values()) {
            if (other === monster) continue;
            if (Math.hypot(other.x - monster.x, other.y - monster.y) < 11) {
              other.hunt = true;
              other.targetId = target.id;
            }
          }
        }
      } else if (Math.random() < dt * 0.3) {
        const angle = Math.random() * Math.PI * 2;
        const nx = monster.x + Math.cos(angle) * 0.35;
        const ny = monster.y + Math.sin(angle) * 0.35;
        if (!isBlocked(this.dungeon, nx, ny, 0.26)) {
          monster.x = nx;
          monster.y = ny;
        }
      }
    }
  }

  private sendMonsters(): void {
    if (!this.multiplayer || !this.sendFn) return;
    const list = [...this.monsters.values()].map((m) => [
      m.id,
      m.kind,
      round2(m.x),
      round2(m.y),
      Math.max(0, Math.round(m.hp)),
      Math.round(m.maxHp),
      m.hunt ? 1 : 0,
      round2(m.attackT),
    ]);
    this.sendFn('ms', { m: list });
  }

  // ── Simulation ────────────────────────────────────────────────

  private loop = (now: number): void => {
    if (!this.running) return;
    const raw = (now - this.lastFrame) / 1000;
    const dt = clamp(raw > 0 ? raw : 0.016, 0.001, 0.05);
    this.lastFrame = now;
    if (!this.paused && !this.ended) {
      this.time += dt;
      this.elapsed += dt;
      this.update(dt);
      this.render(dt);
    } else if (this.ended) {
      this.time += dt;
      this.updateParticles(dt);
      this.render(dt);
    } else {
      this.render(0);
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private update(dt: number): void {
    const p = this.player;
    if (this.deathScene) {
      this.deathScene.t += dt;
      if (this.deathScene.t >= this.deathScene.duration) this.deathScene = null;
    }
    p.attackCd = Math.max(0, p.attackCd - dt);
    p.attackT = Math.max(0, p.attackT - dt);
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.shake = Math.max(0, this.shake - dt * 1.9);

    if (this.descendTimer > 0) {
      this.descendTimer -= dt;
      if (this.descendTimer <= 0) {
        this.descendTimer = 0;
        if (this.isHost) {
          const nextFloor = this.floor + 1;
          this.sendFn?.('floor', { floor: nextFloor });
          this.advanceFloor(nextFloor);
        }
      }
    }

    if (!p.dead && this.descendTimer <= 0) {
      let ix = 0;
      let iy = 0;
      if (this.keys.has('w') || this.keys.has('arrowup')) iy -= 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) iy += 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) ix -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) ix += 1;
      const moving = ix !== 0 || iy !== 0;
      const wantsSprint = this.keys.has('shift') && p.stamina > 2;
      const sprinting = moving && wantsSprint;
      const speed = sprinting ? 5.3 : 3.2;

      if (moving) {
        const len = Math.hypot(ix, iy);
        const dx = (ix / len) * speed * dt;
        const dy = (iy / len) * speed * dt;
        if (!isBlocked(this.dungeon, p.x + dx, p.y, BODY_RADIUS)) p.x += dx;
        if (!isBlocked(this.dungeon, p.x, p.y + dy, BODY_RADIUS)) p.y += dy;
        p.walk += dt * (sprinting ? 15 : 9);
        if (!this.mouseActive) p.facing = Math.atan2(iy, ix);
        p.stepT -= dt;
        if (p.stepT <= 0) {
          p.stepT = sprinting ? 0.24 : 0.36;
          this.audio.step();
          if (Math.random() < 0.3) {
            this.spawnParticle({
              x: p.x + (Math.random() - 0.5) * 0.4,
              y: p.y + 0.1,
              vx: (Math.random() - 0.5) * 0.3,
              vy: -Math.random() * 0.2,
              life: 0.5,
              max: 0.5,
              size: 1.5,
              color: 'rgba(82,72,60,0.5)',
              gravity: 0,
              glow: false,
            });
          }
        }
        p.stamina = Math.max(0, p.stamina - 26 * dt);
      } else {
        p.stamina = Math.min(100, p.stamina + 16 * dt);
      }

      if (p.flashlight) {
        p.battery = Math.max(0, p.battery - dt * 0.7);
        if (p.battery <= 0) {
          p.flashlight = false;
          this.audio.deny();
          this.hooks.toast('Your flashlight dies.', 'warn');
        } else if (p.battery < 15 && !this.lowLightWarned) {
          this.lowLightWarned = true;
          this.hooks.toast('The light is failing. Find a battery cell.', 'warn');
        }
      }

      if (this.mouseActive) p.facing = this.aimAngle;

      if (p.hp < 30 && !this.lowHpWarned) {
        this.lowHpWarned = true;
        this.hooks.toast('You are badly hurt. Find a medical kit.', 'blood');
      } else if (p.hp > 50) {
        this.lowHpWarned = false;
      }

      if (this.mouseX || this.mouseY) this.updateAim();
    }

    this.updateMonsters(dt);
    this.updateRemote(dt);
    this.updateParticles(dt);
    this.updateAtmosphere(dt);

    // Dread rises near unseen things and in the dark.
    let nearest = 40;
    for (const monster of this.monsters.values()) {
      const dist = Math.hypot(monster.x - p.x, monster.y - p.y);
      if (dist < nearest) nearest = dist;
    }
    let dreadTarget = 0;
    if (!p.dead) {
      if (nearest < 11) dreadTarget += (11 - nearest) * 5.6;
      if (!p.flashlight) dreadTarget += 9;
      if (p.hp < 35) dreadTarget += 14;
      if (p.battery < 15) dreadTarget += 8;
    }
    p.dread = lerp(p.dread, clamp(dreadTarget, 0, 100), Math.min(1, dt * 0.5));

    const tension = clamp(
      Math.max(
        nearest < 13 ? (13 - nearest) / 13 : 0,
        p.dread / 130,
        p.hp < 30 && !p.dead ? 0.5 : 0
      ),
      0,
      1
    );
    this.audio.update(tension, dt);

    const viewPos = this.getViewTarget();
    this.computeVisibility(viewPos.x, viewPos.y);

    // Network state. Broadcast regardless of the presence roster: presence can
    // lag through a reconnect, and gating on it used to stop the host's player
    // from moving for everyone else.
    if (this.multiplayer && this.sendFn) {
      if (this.time - this.lastState > SYNC_HZ) {
        this.lastState = this.time;
        this.sendFn('ps', {
          x: round2(p.x),
          y: round2(p.y),
          facing: round2(p.facing),
          hp: Math.round(p.hp),
          maxHp: p.maxHp,
          dead: p.dead,
          mv: this.keys.has('w') || this.keys.has('a') || this.keys.has('s') || this.keys.has('d'),
          sp: this.keys.has('shift'),
          at: p.attackT > 0 ? 1 : 0,
          fl: p.flashlight,
          name: this.name,
          color: this.color,
        });
      }
      if (this.isHost && this.time - this.lastMonsters > MONSTER_HZ) {
        this.lastMonsters = this.time;
        this.sendMonsters();
      }
    }

    // HUD.
    if (this.time - this.lastHud > 0.1) {
      this.lastHud = this.time;
      this.hooks.hud(this.buildHud());
    }

    if (p.dead && !this.ended) {
      if (!this.multiplayer) {
        if (this.time - this.deadAt > 5.5) this.endRun('The dark took you.');
      } else {
        const others = this.peers.filter((peer) => peer.id !== this.playerId);
        const known = others.filter((peer) => this.remote.has(peer.id));
        const allDead =
          others.length === 0 ||
          (known.length === others.length && known.every((peer) => this.remote.get(peer.id)?.dead));
        if (allDead && this.time - this.deadAt > 5.7) this.endRun('Your whole party is gone.');
      }
    }
  }

  private updateAtmosphere(dt: number): void {
    for (const ripple of this.ripples) ripple.t += dt;
    this.ripples = this.ripples.filter((ripple) => ripple.t < ripple.life);

    if (this.ghost) {
      this.ghost.t += dt;
      if (this.ghost.t >= this.ghost.life) this.ghost = null;
    }
    if (this.player.dead) return;

    // Water finding its way down from somewhere you cannot see.
    this.dripClock -= dt;
    if (this.dripClock <= 0) {
      this.dripClock = 1.2 + Math.random() * 3.4;
      this.spawnDrip();
    }

    this.ambientClock -= dt;
    if (this.ambientClock <= 0) {
      this.ambientClock = 6 + Math.random() * 9;
      const pan = Math.random() * 1.6 - 0.8;
      const roll = Math.random();
      this.audio.ambient(roll < 0.42 ? 'drip' : roll < 0.72 ? 'creak' : 'distantStep', pan);
    }

    this.breathClock -= dt;
    if (this.breathClock <= 0 && (this.player.stamina < 34 || this.player.dread > 78)) {
      this.breathClock = this.player.stamina < 24 ? 1.7 : 2.8;
      this.audio.catchBreath();
    }

    if (this.player.flashlight && this.player.battery < 18) {
      this.buzzClock -= dt;
      if (this.buzzClock <= 0) {
        this.buzzClock = 2.2 + Math.random() * 4;
        this.audio.lightBuzz();
      }
    }

    // It steps into the beam, and is gone before you can be sure.
    this.scareClock -= dt;
    if (this.scareClock <= 0) {
      this.scareClock = Math.max(16, 38 - this.player.dread * 0.14) + Math.random() * 14;
      if (this.player.dread > 26 && !this.ghost) this.spawnGhost();
    }

    this.stingClock -= dt;
    if (this.stingClock <= 0) {
      let closest: Monster | null = null;
      let closestDist = Infinity;
      for (const monster of this.monsters.values()) {
        if (!this.isVisibleAt(monster.x, monster.y)) continue;
        const dist = Math.hypot(monster.x - this.player.x, monster.y - this.player.y);
        if (dist < closestDist) {
          closestDist = dist;
          closest = monster;
        }
      }
      if (closest && closestDist < 3.8) {
        this.stingClock = 10 + Math.random() * 5;
        this.audio.sting();
        if (!this.reducedFx) this.shake = Math.min(1, this.shake + 0.22);
      } else {
        this.stingClock = 1.5;
      }
    }

    this.monsterCueClock -= dt;
    if (this.monsterCueClock <= 0) {
      this.monsterCueClock = 2.8 + Math.random() * 3.4;
      let nearest: Monster | null = null;
      let nearestDist = Infinity;
      for (const monster of this.monsters.values()) {
        const dist = Math.hypot(monster.x - this.player.x, monster.y - this.player.y);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = monster;
        }
      }
      if (nearest && nearestDist < 13) {
        const angle = Math.atan2(nearest.y - this.player.y, nearest.x - this.player.x);
        const pan = Math.sin(angleDiff(angle, this.player.facing)) * 0.85;
        const intensity = clamp(1 - nearestDist / 15, 0.12, 1);
        this.audio.monsterCue(nearest.kind, pan, intensity);
      }
    }
  }

  private spawnDrip(): void {
    for (let tries = 0; tries < 18; tries++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 1.6 + Math.random() * 7.5;
      const x = this.player.x + Math.cos(angle) * dist;
      const y = this.player.y + Math.sin(angle) * dist;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (tx < 0 || ty < 0 || tx >= this.dungeon.w || ty >= this.dungeon.h) continue;
      if (this.dungeon.tiles[ty * this.dungeon.w + tx] === WALL) continue;
      if (!this.explored[ty * this.dungeon.w + tx]) continue;
      this.ripples.push({ x, y, t: 0, life: 0.8 });
      for (let i = 0; i < 3; i++) {
        this.spawnParticle({
          x: x + (Math.random() - 0.5) * 0.12,
          y: y + (Math.random() - 0.5) * 0.12,
          vx: (Math.random() - 0.5) * 0.5,
          vy: -0.4 - Math.random() * 0.6,
          life: 0.25 + Math.random() * 0.2,
          max: 0.45,
          size: 1.2,
          color: 'rgba(150, 170, 176, 0.4)',
          gravity: 2.4,
          glow: false,
        });
      }
      this.audio.ambient('drip', Math.sin(angleDiff(angle, this.player.facing)) * 0.7);
      return;
    }
  }

  private spawnGhost(): void {
    if (this.ghost) return;
    const facing = this.player.facing;
    for (let tries = 0; tries < 26; tries++) {
      const angle = facing + (Math.random() - 0.5) * 1.35;
      const dist = 5.4 + Math.random() * 4.2;
      const x = this.player.x + Math.cos(angle) * dist;
      const y = this.player.y + Math.sin(angle) * dist;
      if (isBlocked(this.dungeon, x, y, 0.2)) continue;
      if (!lineOfSight(this.dungeon, this.player.x, this.player.y, x, y)) continue;
      this.ghost = { x, y, t: 0, life: 1.8 + Math.random() * 0.6, seed: Math.random() * 100 };
      this.audio.ambient('whisper', Math.sin(angleDiff(angle, facing)) * 0.6);
      if (!this.reducedFx) this.shake = Math.min(1, this.shake + 0.1);
      return;
    }
  }

  private updateRemote(dt: number): void {
    const present = new Set(this.peers.map((peer) => peer.id));
    for (const [id, rp] of [...this.remote]) {
      rp.x = lerp(rp.x, rp.tx, Math.min(1, dt * 11));
      rp.y = lerp(rp.y, rp.ty, Math.min(1, dt * 11));
      rp.attack = Math.max(0, rp.attack - dt);
      if (!present.has(id) && this.time - rp.lastSeen > 20) this.remote.delete(id);
    }
  }

  private computeVisibility(cx: number, cy: number): void {
    this.visible.clear();
    const radius = !this.player.dead && this.player.flashlight ? 11 : 4;
    const r = Math.ceil(radius);
    const ix = Math.floor(cx);
    const iy = Math.floor(cy);
    for (let ty = iy - r; ty <= iy + r; ty++) {
      for (let tx = ix - r; tx <= ix + r; tx++) {
        if (tx < 0 || ty < 0 || tx >= this.dungeon.w || ty >= this.dungeon.h) continue;
        const dist = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy);
        if (dist > radius) continue;
        if (!lineOfSight(this.dungeon, cx, cy, tx + 0.5, ty + 0.5)) continue;
        const index = ty * this.dungeon.w + tx;
        this.visible.add(index);
        this.explored[index] = 1;
      }
    }
  }

  private isVisibleAt(x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.dungeon.w || ty >= this.dungeon.h) return false;
    return this.visible.has(ty * this.dungeon.w + tx);
  }

  private buildHud(): HudState {
    const party: PartyMember[] = [];
    const sortedPeers = this.peers
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
    const hasSelf = sortedPeers.some((p) => p.id === this.playerId);
    if (!hasSelf) {
      party.push({
        id: this.playerId,
        name: this.name,
        color: this.color,
        hp: this.player.hp,
        maxHp: this.player.maxHp,
        dead: this.player.dead,
        isSelf: true,
        isHost: this.isHost,
      });
    }
    for (const peer of sortedPeers) {
      const self = peer.id === this.playerId;
      const rp = this.remote.get(peer.id);
      party.push({
        id: peer.id,
        name: self ? `${this.name}` : peer.name,
        color: self ? this.color : peer.color,
        hp: self ? this.player.hp : rp?.hp ?? peer.hp,
        maxHp: self ? this.player.maxHp : rp?.maxHp ?? 100,
        dead: self ? this.player.dead : rp?.dead ?? peer.dead,
        isSelf: self,
        isHost: peer.id === this.hostId,
      });
    }
    return {
      hp: this.player.hp,
      maxHp: this.player.maxHp,
      stamina: this.player.stamina,
      battery: this.player.battery,
      dread: this.player.dread,
      fuses: this.fuses,
      floor: this.floor,
      prompt: this.getPrompt(),
      dead: this.player.dead,
      flashlight: this.player.flashlight,
      descending: this.descendTimer,
      party,
      spectating: this.player.dead && this.multiplayer && !this.deathScene,
    };
  }

  private getResult(cause: string): GameResult {
    return {
      floor: this.floor,
      seconds: Math.max(1, Math.round(this.elapsed)),
      fuses: this.fuses,
      cause,
    };
  }

  private endRun(cause: string): void {
    if (this.ended) return;
    this.ended = true;
    this.endedCause = cause;
    if (!this.player.dead) {
      this.player.dead = true;
      this.audio.death();
    }
    this.hooks.presence({ hp: Math.round(this.player.hp), dead: true, floor: this.floor });
    this.hooks.ended(this.getResult(cause));
  }

  // ── Particles ─────────────────────────────────────────────────

  private spawnBlood(x: number, y: number, amount: number): void {
    const count = Math.floor(6 + amount * 7);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2.4 * amount;
      this.spawnParticle({
        x,
        y,
        vx: Math.cos(angle) * speed * 0.45,
        vy: Math.sin(angle) * speed * 0.45,
        life: 0.35 + Math.random() * 0.5,
        max: 0.85,
        size: 1.5 + Math.random() * 2.8,
        color: Math.random() < 0.5 ? '#6d1713' : '#8f251c',
        gravity: 5.5,
        glow: false,
      });
    }
    this.splats.push({
      x: x + (Math.random() - 0.5) * 0.3,
      y: y + (Math.random() - 0.5) * 0.3,
      r: 0.18 + Math.random() * 0.3 * amount,
      rot: Math.random() * Math.PI,
      alpha: 0.28 + Math.random() * 0.25,
    });
    if (this.splats.length > 180) this.splats.splice(0, this.splats.length - 180);
  }

  private spawnParticle(p: Particle): void {
    if (this.particles.length > 340) this.particles.shift();
    this.particles.push(p);
  }

  private updateParticles(dt: number): void {
    for (const particle of this.particles) {
      particle.life -= dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += particle.gravity * dt;
      particle.vx *= 0.94;
      particle.vy *= 0.96;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    if (this.player.flashlight && Math.random() < dt * 8) {
      this.spawnParticle({
        x: this.player.x + (Math.random() - 0.5) * 6,
        y: this.player.y + (Math.random() - 0.5) * 6,
        vx: (Math.random() - 0.5) * 0.15,
        vy: -0.05 - Math.random() * 0.08,
        life: 1.6 + Math.random() * 2,
        max: 4,
        size: 0.8,
        color: 'rgba(196,178,150,0.28)',
        gravity: 0,
        glow: true,
      });
    }
  }

  // ── Rendering ─────────────────────────────────────────────────

  private makeGrain(): void {
    const grain = document.createElement('canvas');
    grain.width = 160;
    grain.height = 160;
    const gctx = grain.getContext('2d');
    if (!gctx) return;
    const image = gctx.createImageData(160, 160);
    for (let i = 0; i < image.data.length; i += 4) {
      const v = Math.random() * 255;
      image.data[i] = v;
      image.data[i + 1] = v;
      image.data[i + 2] = v;
      image.data[i + 3] = Math.random() * 26;
    }
    gctx.putImageData(image, 0, 0);
    this.grainPattern = this.ctx.createPattern(grain, 'repeat');
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
    this.cssW = w;
    this.cssH = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.lightCanvas.width = w;
    this.lightCanvas.height = h;
  }

  private getViewTarget(): Vec {
    if (!this.player.dead) return { x: this.player.x, y: this.player.y };
    const alive = [...this.remote.values()].filter((rp) => !rp.dead);
    if (alive.length > 0) {
      let target = alive.find((rp) => rp.id === this.spectateId) ?? alive[0];
      this.spectateId = target.id;
      return { x: target.x, y: target.y };
    }
    return { x: this.player.x, y: this.player.y };
  }

  private render(dt: number): void {
    this.resize();
    const ctx = this.ctx;
    const w = this.cssW;
    const h = this.cssH;
    if (w <= 1 || h <= 1) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#040405';
    ctx.fillRect(0, 0, w, h);

    const view = this.getViewTarget();
    const lookAhead = !this.player.dead ? (this.reducedFx ? 12 : 30) : 0;
    const targetX = clamp(
      view.x * TILE - w / 2 + Math.cos(this.player.facing) * lookAhead,
      0,
      Math.max(0, this.dungeon.w * TILE - w)
    );
    const targetY = clamp(
      view.y * TILE - h / 2 + Math.sin(this.player.facing) * lookAhead,
      0,
      Math.max(0, this.dungeon.h * TILE - h)
    );
    if (!this.camReady) {
      this.cam.x = targetX;
      this.cam.y = targetY;
      this.camReady = true;
    } else {
      const follow = Math.min(1, Math.max(0.001, dt * 7));
      this.cam.x = lerp(this.cam.x, targetX, follow);
      this.cam.y = lerp(this.cam.y, targetY, follow);
    }

    const shakeAmount = this.reducedFx ? 0 : this.shake;
    const shakeX = shakeAmount ? (Math.random() - 0.5) * 22 * shakeAmount : 0;
    const shakeY = shakeAmount ? (Math.random() - 0.5) * 22 * shakeAmount : 0;
    // A body does not hold a camera still. Fear makes it worse.
    const unease = this.reducedFx ? 0 : 1 + (1 - this.player.hp / this.player.maxHp) * 0.7;
    const swayX = Math.sin(this.time * 1.7) * 1.1 * unease + Math.sin(this.player.walk * 2) * 0.6;
    const swayY = Math.cos(this.time * 1.35) * 0.8 * unease;
    const camX = this.cam.x + shakeX + swayX;
    const camY = this.cam.y + shakeY + swayY;

    ctx.save();
    ctx.translate(-camX, -camY);

    this.drawTiles(ctx, camX, camY, w, h);
    this.drawDecals(ctx);
    this.drawScrawls(ctx);
    this.drawCandles(ctx);
    this.drawRipples(ctx);
    this.drawSplats(ctx);
    this.drawStairs(ctx);
    for (const pickup of this.pickups) {
      if (!pickup.taken) this.drawPickup(ctx, pickup);
    }

    interface Drawable {
      y: number;
      draw: () => void;
    }
    const drawables: Drawable[] = [];
    for (const monster of this.monsters.values()) {
      if (!this.isVisibleAt(monster.x, monster.y)) continue;
      drawables.push({ y: monster.y, draw: () => this.drawMonster(ctx, monster) });
    }
    for (const rp of this.remote.values()) {
      if (!this.isVisibleAt(rp.x, rp.y)) continue;
      drawables.push({ y: rp.y, draw: () => this.drawRemote(ctx, rp) });
    }
    if (this.ghost) {
      drawables.push({ y: this.ghost.y, draw: () => this.drawGhost(ctx) });
    }
    if (!this.player.dead) {
      drawables.push({ y: this.player.y, draw: () => this.drawLocalPlayer(ctx) });
    } else {
      drawables.push({ y: this.player.y, draw: () => this.drawCorpse(ctx, this.player.x, this.player.y) });
    }
    drawables.sort((a, b) => a.y - b.y);
    for (const drawable of drawables) drawable.draw();

    for (const particle of this.particles) {
      const alpha = clamp(particle.life / particle.max, 0, 1);
      ctx.globalAlpha = alpha * (particle.glow ? 0.7 : 1);
      ctx.fillStyle = particle.color;
      if (particle.glow) {
        ctx.shadowColor = particle.color;
        ctx.shadowBlur = 7;
      }
      ctx.fillRect(
        particle.x * TILE - particle.size / 2,
        particle.y * TILE - particle.size / 2,
        particle.size,
        particle.size
      );
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    this.drawFog(ctx, w, h);
    this.renderLighting(ctx, camX, camY, view);
    this.renderScreenEffects(ctx, w, h);
    if (this.deathScene) {
      drawCaughtCutscene(ctx, w, h, this.deathScene, this.reducedFx);
    }
  }

  private drawTiles(ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number): void {
    const d = this.dungeon;
    const startX = Math.max(0, Math.floor(camX / TILE) - 1);
    const startY = Math.max(0, Math.floor(camY / TILE) - 1);
    const endX = Math.min(d.w - 1, Math.floor((camX + w) / TILE) + 1);
    const endY = Math.min(d.h - 1, Math.floor((camY + h) / TILE) + 1);
    const isWall = (tx: number, ty: number): boolean =>
      tx < 0 || ty < 0 || tx >= d.w || ty >= d.h || d.tiles[ty * d.w + tx] === WALL;

    for (let ty = startY; ty <= endY; ty++) {
      for (let tx = startX; tx <= endX; tx++) {
        const index = ty * d.w + tx;
        const explored = this.explored[index] === 1;
        const visible = this.visible.has(index);
        if (!explored && !visible) continue;
        const tile = d.tiles[index];
        const n1 = (hash2(tx * 13 + this.floor * 71, ty * 17 + this.baseSeed) & 255) / 255;
        const n2 = (hash2(tx * 31 + this.floor * 19, ty * 7 + this.baseSeed + 91) & 255) / 255;
        const px = tx * TILE;
        const py = ty * TILE;
        ctx.globalAlpha = visible ? 1 : 0.24;

        if (tile === WALL) {
          // Damp, stacked masonry instead of a flat square.
          ctx.fillStyle = '#080706';
          ctx.fillRect(px, py, TILE + 1, TILE + 1);
          const rowH = TILE / 3;
          for (let row = 0; row < 3; row++) {
            const offset = (row % 2 ? 9 : 0) + (n2 > 0.55 ? 3 : 0);
            const y = py + row * rowH;
            for (let block = -1; block < 3; block++) {
              const x = px + block * 19 + offset;
              const bn = (hash2(
                tx * 41 + block * 13 + row * 5,
                ty * 29 + row * 17 + this.baseSeed
              ) & 255) / 255;
              const blockW = 18;
              const blockH = rowH - 2;
              ctx.fillStyle = `hsl(${24 + bn * 9} ${9 + n1 * 7}% ${14 + bn * 9}%)`;
              ctx.fillRect(x + 1, y + 1, blockW - 1, blockH - 1);
              ctx.fillStyle = `rgba(224, 205, 174, ${0.035 + bn * 0.05})`;
              ctx.fillRect(x + 1, y + 1, blockW - 1, 1);
              ctx.fillStyle = 'rgba(0,0,0,0.34)';
              ctx.fillRect(x + 1, y + blockH - 2, blockW - 1, 2);
              if (bn > 0.78) {
                ctx.strokeStyle = 'rgba(0,0,0,0.38)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x + 4, y + 3);
                ctx.lineTo(x + 9, y + blockH * 0.55);
                ctx.lineTo(x + 6, y + blockH - 3);
                ctx.stroke();
              }
            }
          }
          if (n1 > 0.52) {
            ctx.fillStyle = `rgba(44, 56, 38, ${0.08 + n2 * 0.1})`;
            ctx.fillRect(px + 2, py + TILE - 9, TILE - 4, 7);
          }
          ctx.fillStyle = 'rgba(0,0,0,0.34)';
          ctx.fillRect(px, py + TILE - 2, TILE, 2);
        } else {
          // Uneven flagstones, grout, wall shadows and old stains.
          ctx.fillStyle = `hsl(28 11% ${12 + n1 * 4}%)`;
          ctx.fillRect(px, py, TILE + 1, TILE + 1);
          for (let sy = 0; sy < 2; sy++) {
            for (let sx = 0; sx < 2; sx++) {
              const bn = (hash2(
                tx * 53 + sx * 17,
                ty * 37 + sy * 19 + this.baseSeed
              ) & 255) / 255;
              const inset = 1 + (bn > 0.5 ? 1 : 0);
              const x = px + sx * 20 + inset;
              const y = py + sy * 20 + inset;
              const sw = 20 - inset * 2 - (bn > 0.7 ? 1 : 0);
              const sh = 20 - inset * 2;
              ctx.fillStyle = `hsl(${26 + bn * 7} ${8 + n1 * 6}% ${14 + bn * 5}%)`;
              ctx.fillRect(x, y, sw, sh);
              ctx.fillStyle = `rgba(216, 196, 165, ${0.018 + bn * 0.025})`;
              ctx.fillRect(x, y, sw, 1);
              ctx.fillStyle = 'rgba(0,0,0,0.26)';
              ctx.fillRect(x, y + sh - 1, sw, 1);
              if (bn < 0.16) {
                ctx.fillStyle = 'rgba(9, 8, 7, 0.4)';
                ctx.fillRect(x + 4, y + 6, 7, 3);
              }
            }
          }
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + 20.5, py + 1);
          ctx.lineTo(px + 20.5, py + TILE - 1);
          ctx.moveTo(px + 1, py + 20.5);
          ctx.lineTo(px + TILE - 1, py + 20.5);
          ctx.stroke();
          ctx.fillStyle = 'rgba(0,0,0,0.24)';
          if (isWall(tx, ty - 1)) ctx.fillRect(px, py, TILE, 7);
          if (isWall(tx, ty + 1)) ctx.fillRect(px, py + TILE - 7, TILE, 7);
          if (isWall(tx - 1, ty)) ctx.fillRect(px, py, 7, TILE);
          if (isWall(tx + 1, ty)) ctx.fillRect(px + TILE - 7, py, 7, TILE);
          ctx.fillStyle = 'rgba(0,0,0,0.16)';
          if (isWall(tx, ty - 1)) ctx.fillRect(px, py + 7, TILE, 5);
          if (isWall(tx - 1, ty)) ctx.fillRect(px + 7, py, 5, TILE);
          if (n2 > 0.74) {
            ctx.strokeStyle = 'rgba(9, 7, 6, 0.42)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px + 7 + n1 * 15, py + 4);
            ctx.lineTo(px + 13 + n2 * 12, py + 17);
            ctx.lineTo(px + 9 + n1 * 8, py + 30);
            ctx.lineTo(px + 15 + n2 * 10, py + 36);
            ctx.stroke();
          }
          if (n1 > 0.87) {
            ctx.fillStyle = 'rgba(91, 44, 34, 0.18)';
            ctx.beginPath();
            ctx.ellipse(
              px + 10 + n2 * 20,
              py + 11 + n1 * 14,
              5 + n2 * 4,
              2 + n1 * 2,
              n2 * 2,
              0,
              Math.PI * 2
            );
            ctx.fill();
          }
          if (n2 < 0.12) {
            ctx.fillStyle = 'rgba(118, 98, 74, 0.28)';
            ctx.fillRect(px + 8, py + 26, 2, 1);
            ctx.fillRect(px + 11, py + 24, 1, 3);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawSplats(ctx: CanvasRenderingContext2D): void {
    for (const splat of this.splats) {
      if (!this.isVisibleAt(splat.x, splat.y)) continue;
      ctx.save();
      ctx.translate(splat.x * TILE, splat.y * TILE);
      ctx.rotate(splat.rot);
      ctx.fillStyle = `rgba(46, 8, 7, ${splat.alpha * 0.94})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, splat.r * TILE, splat.r * TILE * 0.52, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(112, 25, 18, ${splat.alpha * 0.52})`;
      ctx.beginPath();
      ctx.ellipse(splat.r * 8, splat.r * 5, splat.r * TILE * 0.62, splat.r * TILE * 0.3, 0.35, 0, Math.PI * 2);
      ctx.fill();
      const droplets = 3 + Math.floor(splat.r * 10);
      for (let i = 0; i < droplets; i++) {
        const angle = splat.rot * 2.3 + i * 2.1;
        const dist = splat.r * TILE * (0.65 + ((i * 37) % 10) / 18);
        const size = 1 + ((i * 13) % 5) * 0.8 * splat.r;
        ctx.fillStyle = `rgba(60, 10, 8, ${splat.alpha * 0.7})`;
        ctx.beginPath();
        ctx.ellipse(
          Math.cos(angle) * dist,
          Math.sin(angle) * dist * 0.55,
          size,
          size * 0.55,
          angle,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
      ctx.fillStyle = `rgba(205, 130, 112, ${splat.alpha * 0.13})`;
      ctx.beginPath();
      ctx.ellipse(-splat.r * 8, -splat.r * 5, splat.r * 9, splat.r * 3, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawDecals(ctx: CanvasRenderingContext2D): void {
    const w = this.dungeon.w;
    for (const decal of this.dungeon.decals) {
      const tx = Math.floor(decal.x);
      const ty = Math.floor(decal.y);
      const index = ty * w + tx;
      if (!this.explored[index]) continue;
      const visible = this.visible.has(index);
      const r = decal.r * TILE;
      ctx.save();
      ctx.globalAlpha = visible ? 1 : 0.3;
      ctx.translate(decal.x * TILE, decal.y * TILE);
      ctx.rotate(decal.rot);
      switch (decal.kind) {
        case 0: {
          ctx.fillStyle = `rgba(24, 18, 14, ${decal.alpha * 0.72})`;
          ctx.beginPath();
          ctx.ellipse(0, 0, r, r * 0.45, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(58, 44, 31, ${decal.alpha * 0.32})`;
          ctx.beginPath();
          ctx.ellipse(r * 0.2, -r * 0.05, r * 0.6, r * 0.3, 0.3, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 1: {
          ctx.fillStyle = `rgba(52, 8, 7, ${decal.alpha * 0.9})`;
          ctx.beginPath();
          ctx.ellipse(0, 0, r, r * 0.52, 0, 0, Math.PI * 2);
          ctx.fill();
          for (let i = 0; i < 6; i++) {
            ctx.fillStyle = `rgba(63, 10, 8, ${decal.alpha * 0.75})`;
            ctx.beginPath();
            ctx.arc(Math.cos(i * 1.7) * r * 1.2, Math.sin(i * 1.3) * r * 0.72, 1 + (i % 3), 0, Math.PI * 2);
            ctx.fill();
          }
          break;
        }
        case 2: {
          ctx.strokeStyle = `rgba(46, 9, 8, ${decal.alpha * 0.8})`;
          for (let i = 0; i < 5; i++) {
            ctx.lineWidth = 2 + (i % 3);
            ctx.beginPath();
            ctx.moveTo(-r, -r * 0.45 + i * r * 0.22);
            ctx.quadraticCurveTo(0, -r * 0.2 + i * r * 0.18, r, -r * 0.55 + i * r * 0.24);
            ctx.stroke();
          }
          break;
        }
        case 3: {
          ctx.strokeStyle = `rgba(154, 142, 120, ${decal.alpha})`;
          ctx.fillStyle = `rgba(168, 157, 134, ${decal.alpha})`;
          for (let i = 0; i < 4; i++) {
            const bx = (i - 1.5) * r * 0.3;
            const by = (i % 2 ? 1 : -1) * r * 0.18;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.moveTo(bx - 4, by);
            ctx.lineTo(bx + 4, by + 1);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(bx, by - 1.5, 1.4, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.beginPath();
          ctx.ellipse(0, -r * 0.3, 3.4, 3, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = 'rgba(20, 14, 11, 0.85)';
          ctx.beginPath();
          ctx.arc(-1.2, -r * 0.32, 0.8, 0, Math.PI * 2);
          ctx.arc(1.2, -r * 0.32, 0.8, 0, Math.PI * 2);
          ctx.fill();
          break;
        }
        case 4: {
          ctx.strokeStyle = `rgba(186, 188, 176, ${decal.alpha * 0.62})`;
          ctx.lineWidth = 0.7;
          for (let i = 0; i < 5; i++) {
            const a = 0.08 + (i / 5) * (Math.PI / 2);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.quadraticCurveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.2, Math.cos(a) * r, Math.sin(a) * r);
            ctx.stroke();
          }
          for (let ring = 1; ring <= 3; ring++) {
            ctx.beginPath();
            ctx.arc(0, 0, (r / 3) * ring, 0.05, Math.PI / 2 - 0.05);
            ctx.stroke();
          }
          break;
        }
        case 5: {
          for (let i = 0; i < 5; i++) {
            const bx = Math.cos(i * 2.1) * r * 0.8;
            const by = Math.sin(i * 1.7) * r * 0.45;
            ctx.fillStyle = `rgba(${52 + i * 7}, ${48 + i * 5}, ${40 + i * 4}, ${decal.alpha})`;
            ctx.save();
            ctx.translate(bx, by);
            ctx.rotate(i * 1.2);
            ctx.fillRect(-3, -1.5, 6, 3);
            ctx.restore();
          }
          break;
        }
        case 6: {
          const wet = ctx.createRadialGradient(0, 0, 1, 0, 0, r);
          wet.addColorStop(0, `rgba(38, 48, 50, ${decal.alpha * 0.62})`);
          wet.addColorStop(0.7, `rgba(22, 28, 30, ${decal.alpha * 0.48})`);
          wet.addColorStop(1, 'rgba(12, 16, 18, 0)');
          ctx.fillStyle = wet;
          ctx.beginPath();
          ctx.ellipse(0, 0, r, r * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = `rgba(150, 158, 150, ${decal.alpha * 0.18})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.ellipse(-r * 0.15, -r * 0.1, r * 0.45, r * 0.14, 0.1, 0, Math.PI * 2);
          ctx.stroke();
          break;
        }
        default: {
          ctx.strokeStyle = `rgba(34, 26, 20, ${decal.alpha * 0.9})`;
          ctx.lineWidth = 1.2;
          for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.moveTo(-r, -r * 0.3 + i * r * 0.16);
            ctx.lineTo(r, -r * 0.2 + i * r * 0.16);
            ctx.stroke();
          }
          break;
        }
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  private drawScrawls(ctx: CanvasRenderingContext2D): void {
    for (const scrawl of this.dungeon.scrawls) {
      const tx = Math.floor(scrawl.x);
      const ty = Math.floor(scrawl.y);
      const index = ty * this.dungeon.w + tx;
      if (index < 0 || !this.explored[index]) continue;
      const visible = this.visible.has(index);
      ctx.save();
      ctx.translate(scrawl.x * TILE, scrawl.y * TILE);
      ctx.rotate(scrawl.rot);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '7px ui-monospace, monospace';
      ctx.fillStyle = `rgba(112, 24, 19, ${scrawl.alpha * (visible ? 1 : 0.48)})`;
      ctx.fillText(scrawl.text, 0, 0);
      ctx.fillStyle = `rgba(74, 16, 13, ${scrawl.alpha * 0.5})`;
      ctx.fillText(scrawl.text, 0.7, 0.8);
      ctx.restore();
    }
  }

  private drawCandles(ctx: CanvasRenderingContext2D): void {
    for (const candle of this.dungeon.candles) {
      const tx = Math.floor(candle.x);
      const ty = Math.floor(candle.y);
      const index = ty * this.dungeon.w + tx;
      if (!this.explored[index]) continue;
      const visible = this.visible.has(index);
      const flick = 0.7 + Math.sin(this.time * 9.3 + candle.phase) * 0.16 + Math.sin(this.time * 21.7 + candle.phase) * 0.08;
      ctx.save();
      ctx.translate(candle.x * TILE, candle.y * TILE);
      ctx.globalAlpha = visible ? 1 : 0.28;
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 34 * flick);
      glow.addColorStop(0, `rgba(255, 184, 104, ${0.22 * flick})`);
      glow.addColorStop(1, 'rgba(255, 150, 70, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-40, -40, 80, 80);

      ctx.fillStyle = '#2a221b';
      ctx.beginPath();
      ctx.ellipse(0, 2, 3.2, 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#b7a78b';
      ctx.fillRect(-1.8, -3, 3.6, 6);
      ctx.fillStyle = '#8d7f68';
      ctx.fillRect(-1.8, -3, 1.1, 6);

      ctx.fillStyle = `rgba(255, 208, 128, ${0.85 * flick})`;
      ctx.beginPath();
      ctx.ellipse(0, -6.5, 1.5, 3.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 246, 206, 0.95)';
      ctx.beginPath();
      ctx.ellipse(0, -6, 0.7, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 170, 84, ${0.2 * flick})`;
      ctx.beginPath();
      ctx.arc(0, -6, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawRipples(ctx: CanvasRenderingContext2D): void {
    for (const ripple of this.ripples) {
      if (!this.isVisibleAt(ripple.x, ripple.y)) continue;
      const p = ripple.t / ripple.life;
      ctx.save();
      ctx.strokeStyle = `rgba(158, 176, 180, ${(1 - p) * 0.3})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(ripple.x * TILE, ripple.y * TILE + 3, 2 + p * 13, 1 + p * 5, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (p < 0.55) {
        ctx.strokeStyle = `rgba(158, 176, 180, ${(1 - p) * 0.18})`;
        ctx.beginPath();
        ctx.ellipse(ripple.x * TILE, ripple.y * TILE + 3, 1 + p * 6, 0.6 + p * 2.4, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawGhost(ctx: CanvasRenderingContext2D): void {
    const ghost = this.ghost;
    if (!ghost) return;
    const p = Math.min(1, ghost.t / ghost.life);
    const alpha = Math.sin(p * Math.PI) * 0.72;
    if (alpha <= 0.01) return;
    const jitter = Math.sin(ghost.t * 28 + ghost.seed) * 1.3;
    ctx.save();
    ctx.translate(ghost.x * TILE + jitter, ghost.y * TILE);
    ctx.globalAlpha = alpha;
    const shade = ctx.createRadialGradient(0, 4, 1, 0, 6, 28);
    shade.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
    shade.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.ellipse(0, 6, 26, 10, 0, 0, Math.PI * 2);
    ctx.fill();

    const body = ctx.createLinearGradient(0, -34, 0, 8);
    body.addColorStop(0, 'rgba(3, 3, 4, 0.98)');
    body.addColorStop(0.72, 'rgba(2, 2, 3, 0.94)');
    body.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(-7, 6);
    ctx.quadraticCurveTo(-10, -14, -4, -26);
    ctx.quadraticCurveTo(0, -31, 4, -26);
    ctx.quadraticCurveTo(10, -14, 7, 6);
    ctx.lineTo(2, 2);
    ctx.lineTo(-1, 7);
    ctx.lineTo(-4, 1);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(168, 156, 132, ${alpha * 0.3})`;
    ctx.beginPath();
    ctx.ellipse(0, -24, 3.6, 4.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(208, 66, 44, ${alpha * 0.5})`;
    ctx.beginPath();
    ctx.arc(-1.4, -24, 0.8, 0, Math.PI * 2);
    ctx.arc(1.4, -24, 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private makeFog(): void {
    const fog = document.createElement('canvas');
    fog.width = 256;
    fog.height = 256;
    const fctx = fog.getContext('2d');
    if (!fctx) return;
    for (let i = 0; i < 46; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const r = 18 + Math.random() * 60;
      const g = fctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(180, 190, 186, ${0.03 + Math.random() * 0.055})`);
      g.addColorStop(1, 'rgba(180, 190, 186, 0)');
      fctx.fillStyle = g;
      fctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    this.fogPattern = this.ctx.createPattern(fog, 'repeat');
  }

  private drawFog(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.fogPattern) return;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const drift = this.reducedFx ? 0 : this.time;
    const ox = (-this.cam.x * 0.35 - drift * 7) % 256;
    const oy = (-this.cam.y * 0.35 + drift * 3) % 256;
    ctx.globalAlpha = 0.055;
    ctx.translate(ox, oy);
    ctx.fillStyle = this.fogPattern;
    ctx.fillRect(0, 0, w + 256, h + 256);
    ctx.globalAlpha = 0.035;
    ctx.translate(48, 96);
    ctx.fillRect(0, 0, w + 256, h + 256);
    ctx.restore();
  }

  private drawStairs(ctx: CanvasRenderingContext2D): void {
    const stairs = this.dungeon.stairs;
    const tx = Math.floor(stairs.x);
    const ty = Math.floor(stairs.y);
    if (!this.explored[ty * this.dungeon.w + tx] && !this.isVisibleAt(stairs.x, stairs.y)) return;
    const px = stairs.x * TILE;
    const py = stairs.y * TILE;
    const open = this.stairOpen;
    const pulse = 0.5 + Math.sin(this.time * 2.2) * 0.25;

    ctx.save();
    ctx.translate(px, py);
    if (open) {
      const glow = ctx.createRadialGradient(0, 0, 2, 0, 0, 54);
      glow.addColorStop(0, `rgba(182, 136, 74, ${0.42 * pulse})`);
      glow.addColorStop(1, 'rgba(182, 136, 74, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-60, -60, 120, 120);
    }
    ctx.fillStyle = '#050505';
    ctx.fillRect(-17, -15, 34, 30);
    ctx.strokeStyle = open ? 'rgba(210, 161, 95, 0.75)' : 'rgba(126, 40, 32, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-17, -15, 34, 30);
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = `rgba(80, 72, 60, ${0.34 - i * 0.06})`;
      ctx.fillRect(-12, -11 + i * 6, 24, 2);
    }
    if (!open) {
      ctx.strokeStyle = 'rgba(169, 56, 47, 0.75)';
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-8, -8);
      ctx.lineTo(8, 8);
      ctx.moveTo(8, -8);
      ctx.lineTo(-8, 8);
      ctx.stroke();
    } else {
      ctx.fillStyle = `rgba(210, 161, 95, ${0.65 * pulse})`;
      ctx.beginPath();
      ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawPickup(ctx: CanvasRenderingContext2D, pickup: Pickup): void {
    const tx = Math.floor(pickup.x);
    const ty = Math.floor(pickup.y);
    const index = ty * this.dungeon.w + tx;
    if (!this.explored[index]) return;
    const visible = this.visible.has(index);
    const px = pickup.x * TILE;
    const py = pickup.y * TILE;
    const pulse = 0.6 + Math.sin(this.time * 2.6 + pickup.x * 2) * 0.3;

    ctx.save();
    ctx.translate(px, py);
    ctx.globalAlpha = visible ? 1 : 0.35;
    if (visible) {
      const color =
        pickup.kind === 'fuse' ? '210, 161, 95' : pickup.kind === 'medkit' ? '188, 92, 80' : '120, 168, 172';
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
      glow.addColorStop(0, `rgba(${color}, ${0.4 * pulse})`);
      glow.addColorStop(1, `rgba(${color}, 0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(-34, -34, 68, 68);
    }

    if (pickup.kind === 'fuse') {
      ctx.fillStyle = '#3a2d1c';
      ctx.fillRect(-8, -5, 16, 10);
      ctx.fillStyle = '#c9a25c';
      ctx.fillRect(-8, -5, 16, 2);
      ctx.fillStyle = '#8e6f3e';
      ctx.fillRect(-10, -4, 2, 8);
      ctx.fillRect(8, -4, 2, 8);
      ctx.fillStyle = '#e5c27c';
      ctx.fillRect(-2, -1, 4, 2);
    } else if (pickup.kind === 'medkit') {
      ctx.fillStyle = '#b9b3a6';
      ctx.fillRect(-8, -6, 16, 12);
      ctx.fillStyle = '#8c2b23';
      ctx.fillRect(-2, -4, 4, 8);
      ctx.fillRect(-5, -1, 10, 2);
      ctx.fillStyle = '#5b241f';
      ctx.fillRect(-8, -6, 16, 1);
    } else {
      ctx.fillStyle = '#272321';
      ctx.fillRect(-4, -8, 8, 16);
      ctx.fillStyle = '#b68f55';
      ctx.fillRect(-3, -8, 6, 2);
      ctx.fillStyle = '#5f7f80';
      ctx.fillRect(-2, -5, 4, 9);
    }
    ctx.restore();
  }

  private drawLocalPlayer(ctx: CanvasRenderingContext2D): void {
    const p = this.player;
    const walk = Math.sin(p.walk);
    this.drawHuman(ctx, p.x, p.y, p.facing, this.color, walk, p.attackT, !p.dead, true);
    if (p.attackT > 0) {
      const progress = 1 - p.attackT / 0.2;
      ctx.save();
      ctx.translate(p.x * TILE, p.y * TILE);
      ctx.rotate(p.facing);
      ctx.strokeStyle = `rgba(226, 190, 134, ${0.7 - progress * 0.7})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 25 + progress * 9, -0.9, 0.9);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawRemote(ctx: CanvasRenderingContext2D, rp: RemotePlayer): void {
    const walk = rp.moving ? Math.sin(this.time * 9 + rp.x) : 0;
    if (rp.dead) {
      this.drawCorpse(ctx, rp.x, rp.y);
    } else {
      this.drawHuman(ctx, rp.x, rp.y, rp.facing, rp.color, walk, rp.attack, rp.flashlight, false);
      if (rp.attack > 0.05) {
        ctx.save();
        ctx.translate(rp.x * TILE, rp.y * TILE);
        ctx.rotate(rp.facing);
        ctx.strokeStyle = 'rgba(210, 190, 150, 0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 24, -0.9, 0.9);
        ctx.stroke();
        ctx.restore();
      }
    }
    if (!rp.dead && this.isVisibleAt(rp.x, rp.y)) {
      ctx.save();
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(6, 6, 7, 0.65)';
      const label = rp.name.toUpperCase();
      const width = ctx.measureText(label).width + 10;
      ctx.fillRect(rp.x * TILE - width / 2, rp.y * TILE - 42, width, 13);
      ctx.fillStyle = 'rgba(206, 196, 178, 0.82)';
      ctx.fillText(label, rp.x * TILE, rp.y * TILE - 32);
      ctx.restore();
    }
    if (rp.dead && this.isVisibleAt(rp.x, rp.y)) {
      ctx.save();
      ctx.font = '8px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(169, 56, 47, 0.7)';
      ctx.fillText(`${rp.name.toUpperCase()} — DEAD`, rp.x * TILE, rp.y * TILE - 20);
      ctx.restore();
    }
  }

  private drawCorpse(ctx: CanvasRenderingContext2D, x: number, y: number): void {
    ctx.save();
    ctx.translate(x * TILE, y * TILE);
    const shadow = ctx.createRadialGradient(0, 5, 1, 0, 5, 25);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.58)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(0, 6, 25, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(45, 8, 7, 0.68)';
    ctx.beginPath();
    ctx.ellipse(4, 5, 24, 14, 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(103, 22, 16, 0.36)';
    ctx.beginPath();
    ctx.ellipse(10, 5, 15, 8, 0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(Math.PI / 2.6);
    ctx.lineCap = 'round';
    // Sprawled legs.
    ctx.strokeStyle = '#19130f';
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.moveTo(-4, 5);
    ctx.lineTo(-10, 13);
    ctx.lineTo(-18, 16);
    ctx.moveTo(4, 5);
    ctx.lineTo(10, 14);
    ctx.lineTo(17, 11);
    ctx.stroke();
    ctx.strokeStyle = '#0d0b09';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-18, 16);
    ctx.lineTo(-22, 15);
    ctx.moveTo(17, 11);
    ctx.lineTo(21, 9);
    ctx.stroke();

    // Ruined coat and chest.
    ctx.fillStyle = '#2c241e';
    ctx.beginPath();
    ctx.ellipse(1, 0, 12, 7, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#43372d';
    ctx.beginPath();
    ctx.ellipse(3, -2, 9, 5, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(157, 137, 109, 0.25)';
    ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 3, -5);
      ctx.lineTo(i * 3 + 2, 2);
      ctx.stroke();
    }

    // Arms reaching the wrong way.
    ctx.strokeStyle = '#241c17';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-7, -3);
    ctx.lineTo(-15, -8);
    ctx.lineTo(-19, -4);
    ctx.moveTo(7, 3);
    ctx.lineTo(14, 8);
    ctx.lineTo(18, 4);
    ctx.stroke();
    ctx.fillStyle = '#a2927d';
    ctx.beginPath();
    ctx.ellipse(-19, -4, 2.4, 1.6, 0.4, 0, Math.PI * 2);
    ctx.ellipse(18, 4, 2.4, 1.6, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // Head, hair and a little exposed bone.
    ctx.fillStyle = '#8e8578';
    ctx.beginPath();
    ctx.arc(12, -6, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#241c16';
    ctx.beginPath();
    ctx.arc(13, -7, 5.1, Math.PI * 0.85, Math.PI * 2.1);
    ctx.fill();
    ctx.fillStyle = 'rgba(22, 16, 13, 0.75)';
    ctx.beginPath();
    ctx.ellipse(14, -4, 2.2, 1.2, 0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c9bda8';
    ctx.fillRect(15, -10, 2, 5);
    ctx.fillStyle = '#7d2019';
    ctx.fillRect(15, -10, 2, 1);

    // Wet blood streaks.
    ctx.strokeStyle = 'rgba(109, 25, 18, 0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(7, 5);
    ctx.lineTo(13, 12);
    ctx.moveTo(-2, 6);
    ctx.lineTo(-7, 13);
    ctx.stroke();
    ctx.restore();
  }

  private drawHuman(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    facing: number,
    color: string,
    walk: number,
    attack: number,
    alive: boolean,
    self: boolean
  ): void {
    if (!alive) {
      this.drawCorpse(ctx, x, y);
      return;
    }
    const px = x * TILE;
    const py = y * TILE;
    const bob = Math.sin(this.time * 2.1 + x * 2.7) * 0.55;
    const stride = walk * 4;
    const attackProgress = attack > 0 ? 1 - attack / 0.2 : 0;

    // Soft contact shadow.
    ctx.save();
    const shadow = ctx.createRadialGradient(px, py + 7, 1, px, py + 7, 23);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.56)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(px, py + 7, 23, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(px, py + bob);
    if (self) {
      ctx.strokeStyle = 'rgba(210, 161, 95, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 19, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.rotate(facing + Math.PI / 2);
    ctx.scale(1.12, 1.12);
    ctx.lineCap = 'round';

    // Legs and boots.
    ctx.strokeStyle = '#15100d';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-4, 5);
    ctx.lineTo(-4 + stride * 0.32, 11);
    ctx.lineTo(-5 - stride * 0.42, 17);
    ctx.moveTo(4, 5);
    ctx.lineTo(4 - stride * 0.32, 11);
    ctx.lineTo(5 + stride * 0.42, 17);
    ctx.stroke();
    ctx.strokeStyle = '#0d0b09';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-5 - stride * 0.42, 17);
    ctx.lineTo(-8 - stride * 0.3, 18);
    ctx.moveTo(5 + stride * 0.42, 17);
    ctx.lineTo(8 + stride * 0.3, 18);
    ctx.stroke();

    // Long coat, with a wet-looking falloff into the dark.
    const coat = ctx.createLinearGradient(0, -13, 0, 12);
    coat.addColorStop(0, color);
    coat.addColorStop(0.62, color);
    coat.addColorStop(1, 'rgba(18, 14, 12, 0.96)');
    ctx.fillStyle = coat;
    ctx.beginPath();
    ctx.moveTo(-8, -8);
    ctx.quadraticCurveTo(-11, 0, -7, 10);
    ctx.lineTo(7, 10);
    ctx.quadraticCurveTo(11, 0, 8, -8);
    ctx.quadraticCurveTo(0, -13, -8, -8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.26)';
    ctx.beginPath();
    ctx.ellipse(-3, 2, 4.5, 8, 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 240, 215, 0.12)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-6, -7);
    ctx.quadraticCurveTo(-9, 0, -6, 7);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(16, 12, 10, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-7, 3);
    ctx.lineTo(7, 3);
    ctx.stroke();

    // Arms; one holds the flashlight, the other a length of pipe.
    ctx.strokeStyle = '#211a15';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-7, -5);
    ctx.quadraticCurveTo(-11, -1, -9, 4);
    ctx.moveTo(7, -5);
    ctx.quadraticCurveTo(11, -1, 9, 3);
    ctx.stroke();

    ctx.save();
    ctx.translate(-9, 2);
    ctx.rotate(-0.2);
    ctx.fillStyle = '#2b2924';
    ctx.fillRect(-1.5, -4, 3, 7);
    ctx.fillStyle = '#d8b574';
    ctx.fillRect(-1.5, -4, 3, 1.4);
    ctx.restore();

    // Head and hair.
    ctx.fillStyle = '#c7b9a4';
    ctx.beginPath();
    ctx.ellipse(0, -12, 5.2, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(70, 54, 44, 0.38)';
    ctx.beginPath();
    ctx.ellipse(-1.5, -11, 2, 3.8, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#241c16';
    ctx.beginPath();
    ctx.arc(0, -13.5, 5.2, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fill();
    ctx.fillStyle = '#9c8d7a';
    ctx.fillRect(-1.8, -8, 3.6, 3);

    const pipe = ctx.createLinearGradient(0, -18, 0, 0);
    pipe.addColorStop(0, '#b1a693');
    pipe.addColorStop(1, '#5f584e');
    ctx.save();
    ctx.translate(8.5, 1);
    ctx.rotate(-0.5 + attackProgress * 1.7);
    ctx.strokeStyle = pipe;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -18);
    ctx.stroke();
    ctx.restore();

    if (attack > 0) {
      ctx.strokeStyle = `rgba(226, 190, 134, ${0.45 * (1 - attackProgress)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 20 + attackProgress * 10, -1.15 + attackProgress * 1.7, 0.25 + attackProgress * 1.7);
      ctx.stroke();
    }
    ctx.restore();

    if (self) {
      ctx.save();
      const glow = ctx.createRadialGradient(px, py, 1, px, py, 16);
      glow.addColorStop(0, 'rgba(210, 161, 95, 0.17)');
      glow.addColorStop(1, 'rgba(210, 161, 95, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(px, py, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawMonster(ctx: CanvasRenderingContext2D, monster: Monster): void {
    const px = monster.x * TILE;
    const py = monster.y * TILE;
    const sway = Math.sin(monster.phase);
    const hunting = monster.hunt;
    const view = this.getViewTarget();
    let targetX = view.x;
    let targetY = view.y;
    if (monster.targetId && monster.targetId !== this.playerId) {
      const remote = this.remote.get(monster.targetId);
      if (remote) {
        targetX = remote.x;
        targetY = remote.y;
      }
    }
    const facing = Math.atan2(targetY - monster.y, targetX - monster.x);
    const lunge =
      monster.attackT > 0 ? Math.sin((1 - monster.attackT / 0.32) * Math.PI) * 6 : 0;
    const twitch = Math.sin(monster.phase * 2.7) * 0.022;

    ctx.save();
    const shadow = ctx.createRadialGradient(px, py + 7, 1, px, py + 7, 31);
    shadow.addColorStop(0, 'rgba(0, 0, 0, 0.62)');
    shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(px, py + 7, 30, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(px + Math.cos(facing) * lunge, py + Math.sin(facing) * lunge);
    ctx.rotate(facing + Math.PI / 2 + twitch);
    const breathe = 1 + Math.sin(monster.phase * 1.7 + monster.x) * 0.018;
    ctx.scale(1.1 * breathe, 1.1 / breathe);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (monster.kind === 'crawler') {
      // Too many joints; skin pulled tight over a borrowed skeleton.
      ctx.strokeStyle = '#1c1512';
      ctx.lineWidth = 3.2;
      for (let i = 0; i < 4; i++) {
        const side = i < 2 ? -1 : 1;
        const front = i % 2 === 0;
        const shoulderY = front ? -4 : 8;
        const elbowX = side * (13 + (front ? 1 : 3));
        const elbowY = shoulderY + (front ? -5 : 6) + sway * (front ? 2.5 : -1.5);
        const clawX = side * (20 + (front ? 2 : 0));
        const clawY = shoulderY + (front ? -10 : 12) + sway * 2;
        ctx.beginPath();
        ctx.moveTo(side * 7, shoulderY);
        ctx.lineTo(elbowX, elbowY);
        ctx.lineTo(clawX, clawY);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(169, 141, 112, 0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(elbowX, elbowY);
        ctx.lineTo(clawX + side * 3, clawY + (front ? -3 : 3));
        ctx.stroke();
        ctx.strokeStyle = '#1c1512';
        ctx.lineWidth = 3.2;
      }

      const body = ctx.createRadialGradient(-5, -2, 2, 0, 4, 20);
      body.addColorStop(0, '#514036');
      body.addColorStop(0.55, '#2b211c');
      body.addColorStop(1, '#120e0c');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.ellipse(0, 4, 14, 10, sway * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(185, 149, 113, 0.32)';
      ctx.lineWidth = 1.2;
      for (let i = -2; i <= 2; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 3 + i * 2.8, 10 - Math.abs(i), 4, 0, Math.PI * 0.15, Math.PI * 0.85);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(212, 181, 146, 0.22)';
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(0, 14);
      ctx.stroke();

      // Skull and split jaw.
      const jaw = 1.5 + (hunting ? 2.5 : 0) + Math.abs(sway) * 1.2 + (monster.attackT > 0 ? 3 : 0);
      ctx.fillStyle = '#382c24';
      ctx.beginPath();
      ctx.ellipse(0, -10, 8.5, 6.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0807';
      ctx.beginPath();
      ctx.ellipse(0, -7, 6, jaw, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(213, 196, 168, 0.85)';
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 1.8, -7 - jaw);
        ctx.lineTo(i * 1.8, -7 - jaw + 2.4);
        ctx.lineTo(i * 1.8 + 0.8, -7 - jaw);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(126, 27, 20, 0.62)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-3, -4);
      ctx.lineTo(-5, 4);
      ctx.moveTo(2, -3);
      ctx.lineTo(4, 5);
      ctx.stroke();

      const eyeGlow = hunting ? 0.92 : 0.55;
      ctx.save();
      ctx.fillStyle = `rgba(222, 63, 40, ${eyeGlow})`;
      ctx.shadowColor = 'rgba(232, 58, 36, 0.95)';
      ctx.shadowBlur = hunting ? 11 : 5;
      ctx.beginPath();
      ctx.arc(-3.2, -11, 1.55, 0, Math.PI * 2);
      ctx.arc(3.2, -11, 1.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (monster.kind === 'stalker') {
      // A person that kept growing after it should have stopped.
      const skin = ctx.createLinearGradient(-12, -22, 10, 18);
      skin.addColorStop(0, '#2d241e');
      skin.addColorStop(0.55, '#171210');
      skin.addColorStop(1, '#090807');
      ctx.fillStyle = skin;
      ctx.beginPath();
      ctx.moveTo(-9, 18);
      ctx.quadraticCurveTo(-12, -2, -6, -16);
      ctx.quadraticCurveTo(-3, -22, 0, -23);
      ctx.quadraticCurveTo(3, -22, 6, -16);
      ctx.quadraticCurveTo(12, -2, 9, 18);
      ctx.lineTo(4, 13);
      ctx.lineTo(1, 19);
      ctx.lineTo(-4, 14);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = 'rgba(187, 163, 133, 0.22)';
      ctx.lineWidth = 1;
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 1 + i * 3.5, 7.5 - Math.abs(i) * 0.7, 3, 0, Math.PI * 0.1, Math.PI * 0.9);
        ctx.stroke();
      }

      // Long arms and extra joints.
      ctx.strokeStyle = '#100d0b';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(-7, -10);
      ctx.quadraticCurveTo(-20, -4 + sway * 2, -17 - lunge * 0.4, 16);
      ctx.moveTo(7, -10);
      ctx.quadraticCurveTo(20, -4 - sway * 2, 17 + lunge * 0.4, 16);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(162, 141, 116, 0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-18, 14);
      ctx.lineTo(-21, 18);
      ctx.moveTo(18, 14);
      ctx.lineTo(21, 18);
      ctx.stroke();

      // Pale head, no eyes left to speak of.
      ctx.fillStyle = '#c8bba5';
      ctx.beginPath();
      ctx.ellipse(0, -19, 5.6, 7.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(62, 47, 37, 0.4)';
      ctx.beginPath();
      ctx.ellipse(-2.4, -17.5, 2.2, 4.2, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#080606';
      ctx.beginPath();
      ctx.ellipse(-1.9, -20, 1.4, 2.5, 0.08, 0, Math.PI * 2);
      ctx.ellipse(1.9, -20, 1.4, 2.5, -0.08, 0, Math.PI * 2);
      ctx.fill();
      const mouth = 1.2 + (hunting ? 1.4 : 0) + (monster.attackT > 0 ? 1.2 : 0);
      ctx.strokeStyle = 'rgba(30, 22, 18, 0.9)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-1.7, -14);
      ctx.lineTo(1.7, -14);
      ctx.stroke();
      ctx.fillStyle = '#120d0b';
      ctx.beginPath();
      ctx.ellipse(0, -13.5, 1.5, mouth, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160, 33, 24, 0.4)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-2.4, -17);
      ctx.lineTo(-3.4, -13);
      ctx.moveTo(2.1, -18);
      ctx.lineTo(3, -14);
      ctx.stroke();
    } else {
      // A shroud with nothing human left underneath.
      const float = Math.sin(monster.phase * 0.8) * 3;
      ctx.translate(0, -4 + float);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      ctx.beginPath();
      ctx.ellipse(0, 20 - float, 16, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(28, 24, 22, 0.97)';
      ctx.beginPath();
      ctx.moveTo(-13, 16);
      ctx.quadraticCurveTo(-16, -8, -5, -19);
      ctx.quadraticCurveTo(0, -24, 5, -19);
      ctx.quadraticCurveTo(16, -8, 13, 16);
      ctx.lineTo(9, 9 + sway * 2);
      ctx.lineTo(5, 17);
      ctx.lineTo(1, 9 - sway * 2);
      ctx.lineTo(-3, 17);
      ctx.lineTo(-7, 9 + sway);
      ctx.lineTo(-10, 15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(156, 173, 170, 0.2)';
      ctx.lineWidth = 0.9;
      for (let i = -4; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo(i * 2, -18);
        ctx.quadraticCurveTo(i * 4 + Math.sin(monster.phase + i) * 3, -2, i * 6, 17);
        ctx.stroke();
      }

      ctx.fillStyle = '#cec0aa';
      ctx.beginPath();
      ctx.ellipse(0, -12, 5.6, 7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#080606';
      ctx.beginPath();
      ctx.ellipse(-1.9, -13, 1.3, 1.9, 0.08, 0, Math.PI * 2);
      ctx.ellipse(1.9, -13, 1.3, 1.9, -0.08, 0, Math.PI * 2);
      ctx.fill();
      const open = 1.6 + (hunting ? 1.8 : 0) + (monster.attackT > 0 ? 1.4 : 0);
      ctx.fillStyle = '#0b0807';
      ctx.beginPath();
      ctx.ellipse(0, -7.8, 1.4, open, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(178, 164, 143, 0.45)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(0, -7.8, 1.8, open + 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(180, 196, 192, 0.08)';
      ctx.beginPath();
      ctx.ellipse(0, 2, 17, 24, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (monster.flash > 0) {
      ctx.globalAlpha = Math.min(0.5, monster.flash * 4);
      ctx.fillStyle = '#f2e7d5';
      ctx.beginPath();
      ctx.ellipse(0, -3, 16, 22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Wet skin and eyeshine: the only parts of it the torch can really hold.
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    const sheen = ctx.createRadialGradient(-4, -8, 1, -4, -8, 22);
    sheen.addColorStop(0, 'rgba(226, 205, 170, 0.13)');
    sheen.addColorStop(0.55, 'rgba(190, 150, 110, 0.035)');
    sheen.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = sheen;
    ctx.beginPath();
    ctx.ellipse(-3, -7, 13, 18, -0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (monster.kind !== 'crawler') {
      const eyeY = monster.kind === 'wailer' ? -12 : -19;
      const eyeX = monster.kind === 'wailer' ? 2.4 : 1.9;
      const glint = 0.4 + Math.sin(this.time * 7.3 + monster.phase * 3) * 0.22;
      ctx.fillStyle = `rgba(255, 244, 220, ${glint * (hunting ? 0.85 : 0.45)})`;
      ctx.shadowColor = 'rgba(255, 220, 180, 0.75)';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(-eyeX, eyeY, 0.55, 0, Math.PI * 2);
      ctx.arc(eyeX, eyeY, 0.55, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    ctx.restore();
  }

  private renderLighting(
    ctx: CanvasRenderingContext2D,
    camX: number,
    camY: number,
    view: Vec
  ): void {
    const lc = this.lightCtx;
    const w = this.cssW;
    const h = this.cssH;
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, w, h);
    lc.fillStyle = 'rgba(2, 2, 3, 0.91)';
    lc.fillRect(0, 0, w, h);
    lc.globalCompositeOperation = 'destination-out';

    const sway = this.reducedFx ? 0 : 1;
    const px = view.x * TILE - camX + Math.sin(this.time * 1.9) * 0.8 * sway;
    const py = view.y * TILE - camY + Math.cos(this.time * 1.5) * 0.6 * sway;
    const lightOn = !this.player.dead && this.player.flashlight && this.player.battery > 0;
    const low = this.player.battery < 18;
    const lowDip = low
      ? Math.max(0, Math.sin(this.time * 7.9)) ** 3 * Math.max(0, Math.sin(this.time * 29.3)) * -0.24
      : 0;
    const dreadShiver = this.player.dread > 72 ? Math.sin(this.time * 23.7) * 0.04 : 0;
    const flicker = this.reducedFx
      ? 0.92
      : clamp(
          0.85 +
            Math.sin(this.time * 10.7) * 0.045 +
            Math.sin(this.time * 26.3) * 0.025 +
            lowDip +
            dreadShiver,
          0.45,
          1.05
        );
    const radius = (lightOn ? 14 : 4) * TILE * flicker;
    const halfAngle = 0.7;
    const facing = this.player.facing;

    // Cut holes in the dark. Clip to a polygon traced by rays that stop at
    // masonry, so light never leaks through a wall.
    const hole = (
      points: Array<[number, number]>,
      radiusPx: number,
      stops: Array<[number, number]>
    ): void => {
      if (points.length < 2) return;
      lc.save();
      lc.beginPath();
      lc.moveTo(points[0]![0] - camX, points[0]![1] - camY);
      for (let i = 1; i < points.length; i++) {
        lc.lineTo(points[i]![0] - camX, points[i]![1] - camY);
      }
      lc.closePath();
      lc.clip();
      const g = lc.createRadialGradient(px, py, 0, px, py, Math.max(1, radiusPx));
      for (const [at, alpha] of stops) g.addColorStop(at, `rgba(255,255,255,${alpha})`);
      lc.fillStyle = g;
      lc.fillRect(0, 0, w, h);
      lc.restore();
    };

    // Your own presence: close, unsteady, hemmed in by stone.
    const ambientPoints = this.lightPolygon(view, 2.8, 0, Math.PI * 2, 64);
    hole(ambientPoints, 2.8 * TILE, [[0, 0.9], [0.45, 0.72], [0.78, 0.32], [1, 0]]);

    if (lightOn) {
      const beamPoints = this.lightPolygon(
        view,
        14 * flicker,
        facing - halfAngle,
        facing + halfAngle,
        72
      );
      hole(beamPoints, radius, [[0, 1], [0.28, 0.99], [0.56, 0.84], [0.82, 0.42], [1, 0]]);
      // A wider, weaker wash makes the edge of the cone feel like air.
      const spillPoints = this.lightPolygon(
        view,
        10.5 * flicker,
        facing - 1.08,
        facing + 1.08,
        56
      );
      hole(spillPoints, 10.5 * TILE, [[0, 0.36], [0.5, 0.2], [1, 0]]);
    }

    // Candles are the only warm thing left down here.
    for (const candle of this.dungeon.candles) {
      const tx = Math.floor(candle.x);
      const ty = Math.floor(candle.y);
      if (!this.explored[ty * this.dungeon.w + tx]) continue;
      const flick =
        0.72 +
        Math.sin(this.time * 9.3 + candle.phase) * 0.16 +
        Math.sin(this.time * 21.7 + candle.phase) * 0.08;
      const cx = candle.x * TILE - camX;
      const cy = candle.y * TILE - camY;
      const r = 46 * flick;
      const g = lc.createRadialGradient(cx, cy, 1, cx, cy, r);
      g.addColorStop(0, `rgba(255,255,255,${0.55 * flick})`);
      g.addColorStop(0.5, `rgba(255,255,255,${0.22 * flick})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      lc.fillStyle = g;
      lc.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    // Partners carry their own light into the room.
    if (this.multiplayer) {
      for (const remote of this.remote.values()) {
        if (remote.dead || !remote.flashlight) continue;
        if (!this.isVisibleAt(remote.x, remote.y)) continue;
        const r = 4.2 * TILE;
        const cx = remote.x * TILE - camX;
        const cy = remote.y * TILE - camY;
        const g = lc.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, 'rgba(255,255,255,0.52)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.3)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        lc.fillStyle = g;
        lc.fillRect(cx - r, cy - r, r * 2, r * 2);
      }
    }

    lc.globalCompositeOperation = 'source-over';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.lightCanvas, 0, 0, w, h);

    // Colour the light: warm through the lens, cold at the edges of the beam.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.beginPath();
    ctx.moveTo(ambientPoints[0]![0] - camX, ambientPoints[0]![1] - camY);
    for (let i = 1; i < ambientPoints.length; i++) {
      ctx.lineTo(ambientPoints[i]![0] - camX, ambientPoints[i]![1] - camY);
    }
    ctx.closePath();
    ctx.clip();
    const warm = ctx.createRadialGradient(px, py, 0, px, py, radius * 0.95);
    warm.addColorStop(0, lightOn ? 'rgba(255, 206, 142, 0.2)' : 'rgba(128, 150, 184, 0.03)');
    warm.addColorStop(0.5, lightOn ? 'rgba(225, 160, 96, 0.06)' : 'rgba(90, 110, 140, 0.012)');
    warm.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = warm;
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.95, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (lightOn) {
      const beamPoints = this.lightPolygon(
        view,
        14 * flicker,
        facing - halfAngle,
        facing + halfAngle,
        72
      );
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.beginPath();
      ctx.moveTo(beamPoints[0]![0] - camX, beamPoints[0]![1] - camY);
      for (let i = 1; i < beamPoints.length; i++) {
        ctx.lineTo(beamPoints[i]![0] - camX, beamPoints[i]![1] - camY);
      }
      ctx.closePath();
      ctx.clip();
      const beamGlow = ctx.createRadialGradient(px, py, 0, px, py, radius);
      beamGlow.addColorStop(0, 'rgba(255, 216, 164, 0.035)');
      beamGlow.addColorStop(0.2, 'rgba(255, 208, 150, 0.17)');
      beamGlow.addColorStop(0.6, 'rgba(255, 185, 118, 0.07)');
      beamGlow.addColorStop(1, 'rgba(255, 170, 100, 0)');
      ctx.fillStyle = beamGlow;
      ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
      // The wall the beam ends on catches a thin warm rim.
      ctx.strokeStyle = 'rgba(255, 190, 126, 0.12)';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const candle of this.dungeon.candles) {
      const tx = Math.floor(candle.x);
      const ty = Math.floor(candle.y);
      if (!this.explored[ty * this.dungeon.w + tx]) continue;
      const flick =
        0.72 +
        Math.sin(this.time * 9.3 + candle.phase) * 0.16 +
        Math.sin(this.time * 21.7 + candle.phase) * 0.08;
      const cx = candle.x * TILE - camX;
      const cy = candle.y * TILE - camY;
      const r = 74 * flick;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(255, 180, 92, ${0.16 * flick})`);
      g.addColorStop(0.5, `rgba(235, 145, 70, ${0.05 * flick})`);
      g.addColorStop(1, 'rgba(200, 120, 60, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Cast a fan of rays to the first wall so light cannot bleed through stone. */
  private lightPolygon(
    view: Vec,
    radius: number,
    from: number,
    to: number,
    rays: number
  ): Array<[number, number]> {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= rays; i++) {
      const angle = from + ((to - from) * i) / rays;
      const hit = this.castRay(view.x, view.y, angle, radius);
      points.push([hit.x * TILE, hit.y * TILE]);
    }
    return points;
  }

  private castRay(x: number, y: number, angle: number, maxDist: number): Vec {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const step = 0.16;
    const w = this.dungeon.w;
    const h = this.dungeon.h;
    for (let d = step; d <= maxDist; d += step) {
      const tx = Math.floor(x + dx * d);
      const ty = Math.floor(y + dy * d);
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) {
        return { x: x + dx * (d - step), y: y + dy * (d - step) };
      }
      if (this.dungeon.tiles[ty * w + tx] === WALL) {
        // Carry a little way into the masonry so the wall face itself catches
        // the light instead of ending at a black silhouette.
        return { x: x + dx * (d + 0.3), y: y + dy * (d + 0.3) };
      }
    }
    return { x: x + dx * maxDist, y: y + dy * maxDist };
  }

  private renderScreenEffects(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const lowHp = this.player.hp < 35 && !this.player.dead;
    const dread = this.player.dread;
    if (this.flashTimer > 0 && !this.reducedFx) {
      ctx.fillStyle = `rgba(120, 16, 12, ${Math.min(0.34, this.flashTimer * 0.95)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Blood on the lens after a bad hit or at death's door.
    const lensAlpha = lowHp ? 0.16 + Math.sin(this.time * 2.4) * 0.04 : this.flashTimer > 0 ? 0.14 : 0;
    if (lensAlpha > 0) {
      const drops: Array<[number, number, number, number]> = [
        [0.06, 0.2, 0.035, 0.011],
        [0.11, 0.31, 0.018, 0.007],
        [0.92, 0.17, 0.045, 0.014],
        [0.87, 0.42, 0.018, 0.009],
        [0.03, 0.62, 0.024, 0.008],
        [0.97, 0.73, 0.032, 0.01],
      ];
      for (const [dx, dy, rx, ry] of drops) {
        ctx.fillStyle = `rgba(72, 8, 7, ${lensAlpha})`;
        ctx.beginPath();
        ctx.ellipse(w * dx, h * (dy + Math.sin(this.time * 0.8 + dx * 9) * 0.004), w * rx, h * ry, 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(190, 85, 68, ${lensAlpha * 0.22})`;
        ctx.beginPath();
        ctx.ellipse(w * dx - w * rx * 0.2, h * dy - h * ry * 0.2, w * rx * 0.24, h * ry * 0.18, 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const vignette = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.18,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.76
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(0.6, 'rgba(0,0,0,0.18)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.88)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    // When the shape is in the beam, the edges of the world close in.
    if (this.ghost) {
      const p = Math.min(1, this.ghost.t / this.ghost.life);
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.sin(p * Math.PI) * 0.16})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (lowHp) {
      const pulse = 0.14 + Math.sin(this.time * 4) * 0.06;
      const red = ctx.createRadialGradient(
        w / 2,
        h / 2,
        Math.min(w, h) * 0.28,
        w / 2,
        h / 2,
        Math.max(w, h) * 0.74
      );
      red.addColorStop(0, 'rgba(90, 8, 8, 0)');
      red.addColorStop(1, `rgba(110, 10, 8, ${pulse})`);
      ctx.fillStyle = red;
      ctx.fillRect(0, 0, w, h);
    }

    // Eyes at the edge of the light. They are not always attached to a body.
    if (!this.reducedFx && !this.player.dead && dread > 48) {
      const strength = (dread - 48) / 52;
      for (let i = 0; i < 4; i++) {
        const blink = Math.max(0, Math.sin(this.time * 0.9 + i * 2.1));
        const alpha = strength * blink * 0.42;
        if (alpha < 0.01) continue;
        const side = i % 2 === 0 ? -1 : 1;
        const x = w * (side < 0 ? 0.055 + i * 0.012 : 0.945 - i * 0.012);
        const y = h * (0.18 + ((i * 29) % 60) / 100);
        ctx.save();
        ctx.fillStyle = `rgba(218, 54, 35, ${alpha})`;
        ctx.shadowColor = 'rgba(230, 50, 32, 0.9)';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.ellipse(x - 5, y, 1.7, 1.1, 0.1, 0, Math.PI * 2);
        ctx.ellipse(x + 5, y, 1.7, 1.1, -0.1, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    if (!this.reducedFx && dread > 62 && !this.player.dead) {
      const edge = ctx.createLinearGradient(0, 0, w, 0);
      edge.addColorStop(0, `rgba(150, 20, 16, ${(dread - 62) / 500})`);
      edge.addColorStop(0.04, 'rgba(150, 20, 16, 0)');
      edge.addColorStop(0.96, 'rgba(20, 80, 86, 0)');
      edge.addColorStop(1, `rgba(20, 80, 86, ${(dread - 62) / 600})`);
      ctx.fillStyle = edge;
      ctx.fillRect(0, 0, w, h);
    }

    // Vertical scanlines keep the camera feeling like found footage.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.055)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

    if (this.grainPattern) {
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.translate(Math.random() * 60, Math.random() * 60);
      ctx.fillStyle = this.grainPattern;
      ctx.fillRect(-60, -60, w + 120, h + 120);
      ctx.restore();
    }

    if (!this.reducedFx && dread > 58 && !this.player.dead) {
      const glitchChance = (dread - 58) / 650;
      if (Math.random() < glitchChance) {
        const y = Math.random() * h;
        const height = 1 + Math.random() * 4;
        ctx.fillStyle = `rgba(160, 40, 30, ${0.08 + Math.random() * 0.14})`;
        ctx.fillRect(0, y, w, height);
        ctx.fillStyle = `rgba(40, 110, 115, ${0.04 + Math.random() * 0.06})`;
        ctx.fillRect(0, y + 1, w, Math.max(1, height - 1));
      }
    }

    if (this.player.dead && !this.deathScene && !this.ended) {
      ctx.fillStyle = 'rgba(3, 3, 4, 0.4)';
      ctx.fillRect(0, 0, w, h);
    }
  }
}
