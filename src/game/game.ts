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
  private lastPresenceTime = 0;
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

    for (const id of [...this.remote.keys()]) {
      if (!peers.some((p) => p.id === id)) this.remote.delete(id);
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
      monster.hunt = raw[6] === 1;
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
    this.spawnBlood(this.player.x, this.player.y, 3);
    this.splats.push({
      x: this.player.x,
      y: this.player.y,
      r: 0.6,
      rot: Math.random() * Math.PI,
      alpha: 0.6,
    });
    this.audio.death();
    this.hooks.presence({ dead: true, hp: 0 });
    this.hooks.toast('You died in the dark.', 'blood');
    this.lastState = -1;
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

    // Network state.
    if (this.multiplayer && this.sendFn) {
      const others = this.peers.some((peer) => peer.id !== this.playerId);
      if (others && this.time - this.lastState > SYNC_HZ) {
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
      if (this.isHost && others && this.time - this.lastMonsters > MONSTER_HZ) {
        this.lastMonsters = this.time;
        this.sendMonsters();
      }
      if (this.time - this.lastPresenceTime > 2) {
        this.lastPresenceTime = this.time;
        this.hooks.presence({
          hp: Math.round(p.hp),
          dead: p.dead,
          floor: this.floor,
          seed: this.baseSeed,
        });
      }
    }

    // HUD.
    if (this.time - this.lastHud > 0.1) {
      this.lastHud = this.time;
      this.hooks.hud(this.buildHud());
    }

    if (p.dead && !this.ended) {
      if (!this.multiplayer) {
        if (this.time - this.deadAt > 1.8) this.endRun('The dark took you.');
      } else {
        const others = this.peers.filter((peer) => peer.id !== this.playerId);
        const known = others.filter((peer) => this.remote.has(peer.id));
        const allDead =
          others.length === 0 ||
          (known.length === others.length && known.every((peer) => this.remote.get(peer.id)?.dead));
        if (allDead && this.time - this.deadAt > 2.2) this.endRun('Your whole party is gone.');
      }
    }
  }

  private updateRemote(dt: number): void {
    for (const rp of this.remote.values()) {
      rp.x = lerp(rp.x, rp.tx, Math.min(1, dt * 11));
      rp.y = lerp(rp.y, rp.ty, Math.min(1, dt * 11));
      rp.attack = Math.max(0, rp.attack - dt);
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
      spectating: this.player.dead && this.multiplayer,
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
    const targetX = clamp(view.x * TILE - w / 2, 0, Math.max(0, this.dungeon.w * TILE - w));
    const targetY = clamp(view.y * TILE - h / 2, 0, Math.max(0, this.dungeon.h * TILE - h));
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
    const camX = this.cam.x + shakeX;
    const camY = this.cam.y + shakeY;

    ctx.save();
    ctx.translate(-camX, -camY);

    this.drawTiles(ctx, camX, camY, w, h);
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

    this.renderLighting(ctx, camX, camY, view);
    this.renderScreenEffects(ctx, w, h);
  }

  private drawTiles(ctx: CanvasRenderingContext2D, camX: number, camY: number, w: number, h: number): void {
    const d = this.dungeon;
    const startX = Math.max(0, Math.floor(camX / TILE) - 1);
    const startY = Math.max(0, Math.floor(camY / TILE) - 1);
    const endX = Math.min(d.w - 1, Math.floor((camX + w) / TILE) + 1);
    const endY = Math.min(d.h - 1, Math.floor((camY + h) / TILE) + 1);

    for (let ty = startY; ty <= endY; ty++) {
      for (let tx = startX; tx <= endX; tx++) {
        const index = ty * d.w + tx;
        const explored = this.explored[index] === 1;
        const visible = this.visible.has(index);
        if (!explored && !visible) continue;
        const tile = d.tiles[index];
        const noise = (hash2(tx * 13 + this.floor * 71, ty * 17 + this.baseSeed) & 255) / 255;
        const px = tx * TILE;
        const py = ty * TILE;
        ctx.globalAlpha = visible ? 1 : 0.26;

        if (tile === WALL) {
          ctx.fillStyle = '#090808';
          ctx.fillRect(px, py, TILE + 1, TILE + 1);
          ctx.fillStyle = `hsl(26 11% ${17 + noise * 7}%)`;
          ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4);
          ctx.fillStyle = `hsla(34 16% ${30 + noise * 10}% / 0.8)`;
          ctx.fillRect(px + 2, py + 2, TILE - 4, 3);
          ctx.fillStyle = 'rgba(0,0,0,0.36)';
          ctx.fillRect(px + 2, py + TILE - 5, TILE - 4, 3);
          if (noise > 0.72) {
            ctx.strokeStyle = 'rgba(0,0,0,0.4)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px + 9 + noise * 8, py + 9);
            ctx.lineTo(px + 15 + noise * 5, py + 23);
            ctx.lineTo(px + 11 + noise * 4, py + 31);
            ctx.stroke();
          }
          if (noise < 0.16) {
            ctx.fillStyle = 'rgba(84, 70, 52, 0.24)';
            ctx.fillRect(px + 6, py + 10, 3, 24);
          }
        } else {
          ctx.fillStyle = `hsl(29 10% ${15 + noise * 5}%)`;
          ctx.fillRect(px, py, TILE + 1, TILE + 1);
          ctx.strokeStyle = 'rgba(0,0,0,0.22)';
          ctx.lineWidth = 1;
          ctx.strokeRect(px + 0.5, py + 0.5, TILE, TILE);
          if (noise > 0.84) {
            ctx.strokeStyle = 'rgba(53, 44, 36, 0.5)';
            ctx.beginPath();
            ctx.moveTo(px + 7, py + 9);
            ctx.lineTo(px + 26, py + 30);
            ctx.stroke();
          } else if (noise < 0.1) {
            ctx.fillStyle = 'rgba(30, 25, 21, 0.6)';
            ctx.fillRect(px + 12, py + 20, 10, 6);
          }
          if (visible) {
            ctx.fillStyle = 'rgba(210, 170, 110, 0.035)';
            ctx.fillRect(px, py, TILE, TILE);
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
      ctx.fillStyle = `rgba(74, 16, 13, ${splat.alpha})`;
      ctx.beginPath();
      ctx.ellipse(0, 0, splat.r * TILE, splat.r * TILE * 0.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(103, 24, 18, ${splat.alpha * 0.7})`;
      ctx.beginPath();
      ctx.ellipse(splat.r * 20, splat.r * 9, splat.r * 8, splat.r * 4, 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
    ctx.rotate(Math.PI / 2.6);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.ellipse(0, 3, 15, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(64, 20, 17, 0.6)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2e2924';
    ctx.beginPath();
    ctx.ellipse(3, -2, 11, 6, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8e8578';
    ctx.beginPath();
    ctx.arc(12, -6, 4.5, 0, Math.PI * 2);
    ctx.fill();
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
    ctx.save();
    ctx.translate(x * TILE, y * TILE);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.beginPath();
    ctx.ellipse(0, 5, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    if (self) {
      ctx.strokeStyle = 'rgba(210, 161, 95, 0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.rotate(facing + Math.PI / 2);
    const stride = walk * 4;

    ctx.strokeStyle = '#171310';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-4, 2);
    ctx.lineTo(-4 + stride * 0.4, 10);
    ctx.moveTo(4, 2);
    ctx.lineTo(4 - stride * 0.4, 10);
    ctx.stroke();

    ctx.fillStyle = '#171310';
    ctx.beginPath();
    ctx.ellipse(0, 0, 9.5, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(0, -1, 8.6, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath();
    ctx.ellipse(0, 2.5, 6.8, 7.5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#211c17';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-7, -3);
    ctx.lineTo(-10 + stride * 0.5, 5);
    ctx.moveTo(7, -3);
    ctx.lineTo(10 - stride * 0.5, 5);
    ctx.stroke();

    ctx.fillStyle = '#c9bca7';
    ctx.beginPath();
    ctx.arc(0, -10, 5.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#29221c';
    ctx.beginPath();
    ctx.arc(0, -11.4, 5.4, Math.PI * 0.98, Math.PI * 2.02);
    ctx.fill();

    if (attack > 0) {
      ctx.strokeStyle = 'rgba(222, 190, 138, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(7 - walk * 2, -22);
      ctx.stroke();
    }
    ctx.restore();

    if (self) {
      ctx.fillStyle = 'rgba(210, 161, 95, 0.9)';
      ctx.beginPath();
      ctx.arc(x * TILE, y * TILE - 3, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawMonster(ctx: CanvasRenderingContext2D, monster: Monster): void {
    const px = monster.x * TILE;
    const py = monster.y * TILE;
    const sway = Math.sin(monster.phase);
    const hunting = monster.hunt;

    ctx.save();
    ctx.translate(px, py);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(0, 6, 17, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    if (monster.kind === 'crawler') {
      ctx.strokeStyle = '#1a1512';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      for (let i = 0; i < 4; i++) {
        const side = i < 2 ? -1 : 1;
        const off = i % 2 === 0 ? -5 : 5;
        ctx.beginPath();
        ctx.moveTo(side * 6, off);
        ctx.lineTo(side * 15, off + sway * 3 + (i % 2 === 0 ? -4 : 4));
        ctx.stroke();
      }
      ctx.fillStyle = '#231d19';
      ctx.beginPath();
      ctx.ellipse(0, 0, 14, 10, sway * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#3a2e26';
      ctx.beginPath();
      ctx.ellipse(6, sway * 1.5, 7, 6, 0.2, 0, Math.PI * 2);
      ctx.fill();
      const eyeGlow = hunting ? 0.9 : 0.55;
      ctx.fillStyle = `rgba(214, 62, 42, ${eyeGlow})`;
      ctx.shadowColor = 'rgba(214, 62, 42, 0.9)';
      ctx.shadowBlur = hunting ? 9 : 4;
      ctx.beginPath();
      ctx.arc(10, -2 + sway, 1.8, 0, Math.PI * 2);
      ctx.arc(11, 3 + sway, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'rgba(140, 60, 45, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(17, 3);
      ctx.moveTo(12, 2);
      ctx.lineTo(16, 6);
      ctx.stroke();
    } else if (monster.kind === 'stalker') {
      ctx.fillStyle = '#0f0d0c';
      ctx.beginPath();
      ctx.moveTo(-8, 16);
      ctx.quadraticCurveTo(-11, -6, -3, -18);
      ctx.quadraticCurveTo(0, -21, 3, -18);
      ctx.quadraticCurveTo(11, -6, 8, 16);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#0b0a09';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-7, -8);
      ctx.quadraticCurveTo(-18, -2 + sway * 2, -14, 14);
      ctx.moveTo(7, -8);
      ctx.quadraticCurveTo(18, -2 - sway * 2, 14, 14);
      ctx.stroke();
      ctx.fillStyle = '#c6baa4';
      ctx.beginPath();
      ctx.ellipse(0, -15, 5.6, 7.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#100d0b';
      ctx.beginPath();
      ctx.ellipse(-2.2, -15.6, 1.4, 2.2, 0, 0, Math.PI * 2);
      ctx.ellipse(2.2, -15.6, 1.4, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20, 15, 12, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-1.8, -11);
      ctx.lineTo(1.8, -11);
      ctx.stroke();
      ctx.fillStyle = 'rgba(190, 60, 40, 0.18)';
      ctx.beginPath();
      ctx.ellipse(0, -15, 6, 8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const float = Math.sin(monster.phase * 0.8) * 3;
      ctx.translate(0, -4 + float);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.beginPath();
      ctx.ellipse(0, 16 - float, 15, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c1916';
      ctx.beginPath();
      ctx.moveTo(-13, 14);
      ctx.quadraticCurveTo(-14, -12, 0, -20);
      ctx.quadraticCurveTo(14, -12, 13, 14);
      ctx.lineTo(9, 9 + sway * 2);
      ctx.lineTo(5, 15);
      ctx.lineTo(1, 9 - sway * 2);
      ctx.lineTo(-3, 15);
      ctx.lineTo(-7, 9 + sway);
      ctx.lineTo(-10, 14);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#cec0aa';
      ctx.beginPath();
      ctx.ellipse(0, -13, 5.4, 6.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0a0908';
      ctx.beginPath();
      ctx.ellipse(-1.9, -14, 1.2, 1.6, 0, 0, Math.PI * 2);
      ctx.ellipse(1.9, -14, 1.2, 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, -10.4, 1.6, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (monster.flash > 0) {
      ctx.globalAlpha = Math.min(0.7, monster.flash * 5);
      ctx.fillStyle = '#f2e7d5';
      ctx.beginPath();
      ctx.arc(0, -4, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
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
    lc.fillStyle = 'rgba(2, 2, 3, 0.87)';
    lc.fillRect(0, 0, w, h);
    lc.globalCompositeOperation = 'destination-out';

    const px = view.x * TILE - camX;
    const py = view.y * TILE - camY;
    const lightOn = !this.player.dead && this.player.flashlight && this.player.battery > 0;
    const flicker = this.reducedFx
      ? 0.9
      : 0.84 +
        Math.sin(this.time * 10.7) * 0.035 +
        Math.sin(this.time * 26.3) * 0.025 +
        (this.player.dread > 72 ? Math.random() * 0.12 : 0);
    const radius = (lightOn ? 11 : 3.8) * TILE * flicker;

    const ambient = lc.createRadialGradient(px, py, 0, px, py, radius);
    ambient.addColorStop(0, 'rgba(255,255,255,1)');
    ambient.addColorStop(0.55, 'rgba(255,255,255,0.9)');
    ambient.addColorStop(1, 'rgba(255,255,255,0)');
    lc.fillStyle = ambient;
    lc.fillRect(0, 0, w, h);

    if (lightOn) {
      lc.save();
      lc.beginPath();
      lc.moveTo(px, py);
      lc.arc(px, py, radius * 1.7, this.player.facing - 0.42, this.player.facing + 0.42);
      lc.closePath();
      lc.clip();
      const cone = lc.createRadialGradient(px, py, 0, px, py, radius * 1.7);
      cone.addColorStop(0, 'rgba(255,255,255,0.98)');
      cone.addColorStop(0.45, 'rgba(255,255,255,0.78)');
      cone.addColorStop(1, 'rgba(255,255,255,0)');
      lc.fillStyle = cone;
      lc.fillRect(px - radius * 1.8, py - radius * 1.8, radius * 3.6, radius * 3.6);
      lc.restore();
    }

    lc.globalCompositeOperation = 'source-over';
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.drawImage(this.lightCanvas, 0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const warm = ctx.createRadialGradient(px, py, 0, px, py, radius * 0.8);
    warm.addColorStop(0, lightOn ? 'rgba(255, 206, 140, 0.16)' : 'rgba(150, 170, 205, 0.045)');
    warm.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = warm;
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private renderScreenEffects(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    const lowHp = this.player.hp < 35 && !this.player.dead;
    if (this.flashTimer > 0 && !this.reducedFx) {
      ctx.fillStyle = `rgba(120, 16, 12, ${Math.min(0.3, this.flashTimer * 0.9)})`;
      ctx.fillRect(0, 0, w, h);
    }

    const vignette = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.22,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.75
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    if (lowHp) {
      const pulse = 0.12 + Math.sin(this.time * 4) * 0.05;
      const red = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.72);
      red.addColorStop(0, 'rgba(90, 8, 8, 0)');
      red.addColorStop(1, `rgba(110, 10, 8, ${pulse})`);
      ctx.fillStyle = red;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.grainPattern) {
      ctx.save();
      ctx.globalAlpha = 0.16;
      ctx.translate(Math.random() * 60, Math.random() * 60);
      ctx.fillStyle = this.grainPattern;
      ctx.fillRect(-60, -60, w + 120, h + 120);
      ctx.restore();
    }

    if (!this.reducedFx && this.player.dread > 68 && this.player.dead === false) {
      const glitchChance = (this.player.dread - 68) / 900;
      if (Math.random() < glitchChance) {
        const y = Math.random() * h;
        const height = 1 + Math.random() * 3;
        ctx.fillStyle = `rgba(160, 40, 30, ${0.08 + Math.random() * 0.12})`;
        ctx.fillRect(0, y, w, height);
      }
    }

    if (this.player.dead && !this.ended) {
      ctx.fillStyle = 'rgba(3, 3, 4, 0.35)';
      ctx.fillRect(0, 0, w, h);
    }
  }
}
