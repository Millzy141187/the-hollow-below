import type { Pickup, PickupKind } from '../types';
import { mulberry32 } from './rng';

export const WALL = 1;
export const FLOOR = 0;

export interface Vec {
  x: number;
  y: number;
}

export interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Decal {
  x: number;
  y: number;
  r: number;
  rot: number;
  kind: number;
  alpha: number;
}

export interface Candle {
  x: number;
  y: number;
  phase: number;
}

/** Something written on the masonry in something that is not paint. */
export interface Scrawl {
  x: number;
  y: number;
  rot: number;
  text: string;
  alpha: number;
}

export interface Dungeon {
  w: number;
  h: number;
  tiles: Uint8Array;
  rooms: Room[];
  spawn: Vec;
  stairs: Vec;
  pickups: Pickup[];
  decals: Decal[];
  candles: Candle[];
  scrawls: Scrawl[];
  spawnPoints: Vec[];
}

export function tileAt(d: Dungeon, tx: number, ty: number): number {
  const x = Math.floor(tx);
  const y = Math.floor(ty);
  if (x < 0 || y < 0 || x >= d.w || y >= d.h) return WALL;
  return d.tiles[y * d.w + x];
}

export function isSolidTile(d: Dungeon, tx: number, ty: number): boolean {
  return tileAt(d, tx, ty) === WALL;
}

/** Continuous-position collision against the tile grid. */
export function isBlocked(d: Dungeon, x: number, y: number, radius: number): boolean {
  const x0 = Math.floor(x - radius);
  const x1 = Math.floor(x + radius);
  const y0 = Math.floor(y - radius);
  const y1 = Math.floor(y + radius);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (isSolidTile(d, tx, ty)) return true;
    }
  }
  return false;
}

/** Bresenham line of sight on the tile grid. Walls block, but the target wall is visible. */
export function lineOfSight(d: Dungeon, x0: number, y0: number, x1: number, y1: number): boolean {
  let ax = Math.floor(x0);
  let ay = Math.floor(y0);
  const bx = Math.floor(x1);
  const by = Math.floor(y1);
  const dx = Math.abs(bx - ax);
  const dy = -Math.abs(by - ay);
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 256; guard++) {
    if (ax === bx && ay === by) return true;
    if (tileAt(d, ax, ay) === WALL) return false;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      ax += sx;
    }
    if (e2 <= dx) {
      err += dx;
      ay += sy;
    }
  }
  return false;
}

export function roomCenter(r: Room): Vec {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function overlaps(a: Room, b: Room, pad: number): boolean {
  return (
    a.x - pad < b.x + b.w &&
    a.x + a.w + pad > b.x &&
    a.y - pad < b.y + b.h &&
    a.y + a.h + pad > b.y
  );
}

/** Deterministic dungeon for a given room seed + depth. Every co-op client builds the same map. */
export function generateDungeon(seed: number, floor: number): Dungeon {
  const rand = mulberry32(((seed >>> 0) ^ Math.imul(floor + 7, 0x9e3779b1)) >>> 0);
  const w = 58;
  const h = 58;
  const tiles = new Uint8Array(w * h).fill(WALL);

  const set = (x: number, y: number, v: number): void => {
    if (x > 0 && y > 0 && x < w - 1 && y < h - 1) tiles[y * w + x] = v;
  };

  const rooms: Room[] = [];
  for (let attempt = 0; attempt < 420 && rooms.length < 11; attempt++) {
    const rw = 5 + Math.floor(rand() * 7);
    const rh = 5 + Math.floor(rand() * 5);
    const rx = 2 + Math.floor(rand() * (w - rw - 4));
    const ry = 2 + Math.floor(rand() * (h - rh - 4));
    const next: Room = { x: rx, y: ry, w: rw, h: rh };
    if (rooms.some((r) => overlaps(r, next, 2))) continue;
    rooms.push(next);
  }

  // Extremely defensive fallback: guarantee enough rooms for a valid run.
  if (rooms.length < 4) {
    rooms.length = 0;
    const fixed: Room[] = [
      { x: 3, y: 3, w: 8, h: 7 },
      { x: 44, y: 4, w: 8, h: 7 },
      { x: 5, y: 44, w: 8, h: 7 },
      { x: 43, y: 43, w: 8, h: 7 },
      { x: 25, y: 24, w: 8, h: 8 },
    ];
    rooms.push(...fixed);
  }

  for (const r of rooms) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) set(x, y, FLOOR);
    }
  }

  // Room centers can land on half-tiles. Typed-array writes at fractional
  // indices are silently ignored, so corridors must iterate over whole tiles
  // or most rooms end up isolated.
  const carveH = (x1: number, x2: number, y: number): void => {
    const a = Math.floor(Math.min(x1, x2));
    const b = Math.ceil(Math.max(x1, x2));
    for (let x = a; x <= b; x++) set(x, Math.round(y), FLOOR);
  };
  const carveV = (y1: number, y2: number, x: number): void => {
    const a = Math.floor(Math.min(y1, y2));
    const b = Math.ceil(Math.max(y1, y2));
    for (let y = a; y <= b; y++) set(Math.round(x), y, FLOOR);
  };

  for (let i = 1; i < rooms.length; i++) {
    const a = roomCenter(rooms[i - 1]);
    const b = roomCenter(rooms[i]);
    if (rand() < 0.5) {
      carveH(a.x, b.x, a.y);
      carveV(a.y, b.y, b.x);
    } else {
      carveV(a.y, b.y, a.x);
      carveH(a.x, b.x, b.y);
    }
  }

  // Extra loops make the dungeon less linear and give escape routes.
  const extra = 2 + Math.floor(rand() * 2);
  for (let i = 0; i < extra; i++) {
    const a = roomCenter(rooms[Math.floor(rand() * rooms.length)]);
    const b = roomCenter(rooms[Math.floor(rand() * rooms.length)]);
    carveH(a.x, b.x, a.y);
    carveV(a.y, b.y, b.x);
  }

  // Line corridors with one-block walls automatically (the array was filled with walls).

  const spawnRoom = rooms[0];
  const stairsRoom = rooms[rooms.length - 1];
  const spawn = roomCenter(spawnRoom);
  const stairs = roomCenter(stairsRoom);

  const pickups: Pickup[] = [];
  const used = new Set<number>();
  const usedKey = (x: number, y: number): number => Math.floor(y) * w + Math.floor(x);

  const roomPick = (r: Room, salt: number): Vec => {
    for (let tries = 0; tries < 44; tries++) {
      const x = r.x + 1 + Math.floor(rand() * Math.max(1, r.w - 2));
      const y = r.y + 1 + Math.floor(rand() * Math.max(1, r.h - 2));
      const key = usedKey(x + 0.5, y + 0.5);
      if (used.has(key)) continue;
      used.add(key);
      return { x: x + 0.5 + (salt % 2) * 0.1, y: y + 0.5 };
    }
    return roomCenter(r);
  };

  const makePickup = (kind: PickupKind, room: Room, salt: number): void => {
    const pos = roomPick(room, salt);
    pickups.push({ id: `${floor}-${kind}-${salt}`, kind, x: pos.x, y: pos.y, taken: false });
  };

  const candidateRooms = rooms.filter((r) => r !== spawnRoom);
  const fuseRooms = candidateRooms.slice().sort(() => rand() - 0.5).slice(0, 3);
  fuseRooms.forEach((room, i) => makePickup('fuse', room, i));
  const supportRooms = candidateRooms.slice().sort(() => rand() - 0.5);
  makePickup('medkit', supportRooms[0] ?? stairsRoom, 10);
  makePickup('medkit', supportRooms[1] ?? spawnRoom, 11);
  makePickup('battery', supportRooms[2] ?? stairsRoom, 12);
  makePickup('battery', supportRooms[3] ?? spawnRoom, 13);

  // 0 stain · 1 blood · 2 drag mark · 3 bones · 4 cobweb · 5 rubble · 6 puddle · 7 scratches
  const decals: Decal[] = [];
  for (const r of rooms) {
    const count = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < count; i++) {
      const x = r.x + 0.6 + rand() * Math.max(0.5, r.w - 1.2);
      const y = r.y + 0.6 + rand() * Math.max(0.5, r.h - 1.2);
      const roll = rand();
      const kind = roll < 0.34 ? 0 : roll < 0.47 ? 1 : roll < 0.57 ? 2 : roll < 0.67 ? 3 : roll < 0.82 ? 5 : roll < 0.94 ? 6 : 7;
      decals.push({
        x,
        y,
        r: 0.18 + rand() * 0.5,
        rot: rand() * Math.PI * 2,
        kind,
        alpha: 0.18 + rand() * 0.35,
      });
    }
    // Cobwebs live in the corners, where nobody has swept for a long time.
    if (rand() < 0.6) {
      decals.push({ x: r.x + 0.15, y: r.y + 0.15, r: 0.55, rot: rand() * Math.PI, kind: 4, alpha: 0.22 });
      if (rand() < 0.5) {
        decals.push({ x: r.x + r.w - 0.15, y: r.y + 0.15, r: 0.55, rot: rand() * Math.PI, kind: 4, alpha: 0.2 });
      }
    }
  }

  const candles: Candle[] = [];
  for (const r of rooms) {
    if (rand() < 0.62) {
      candles.push({
        x: r.x + 0.7 + rand() * Math.max(0.4, r.w - 1.4),
        y: r.y + 0.7 + rand() * Math.max(0.4, r.h - 1.4),
        phase: rand() * Math.PI * 2,
      });
      if (rand() < 0.28) {
        candles.push({
          x: r.x + 0.7 + rand() * Math.max(0.4, r.w - 1.4),
          y: r.y + 0.7 + rand() * Math.max(0.4, r.h - 1.4),
          phase: rand() * Math.PI * 2,
        });
      }
    }
  }

  const scrawlText = [
    'IT HEARS THE LIGHT',
    'DONT LOOK BACK',
    'TURN BACK',
    'THEY ARE STILL HERE',
    '3 FUSES 3 OF US',
    'DONT SPLIT UP',
    'IT WEARS FACES',
    'THE STAIRS LIE',
    'KEEP THE LIGHT ON',
    'WE TRIED',
    'IIIII IIIII I',
    'NOBODY CAME',
  ];
  const scrawls: Scrawl[] = [];
  const scrawlRounds = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < scrawlRounds; i++) {
    const room = rooms[Math.floor(rand() * rooms.length)];
    if (!room) continue;
    const side = Math.floor(rand() * 4);
    let x = 0;
    let y = 0;
    let rot = 0;
    if (side === 0) {
      x = (room.x + 0.5 + rand() * Math.max(0.5, room.w - 1));
      y = (room.y - 0.55);
      rot = 0;
    } else if (side === 1) {
      x = (room.x + room.w + 0.45);
      y = (room.y + 0.5 + rand() * Math.max(0.5, room.h - 1));
      rot = Math.PI / 2;
    } else if (side === 2) {
      x = (room.x + 0.5 + rand() * Math.max(0.5, room.w - 1));
      y = (room.y + room.h + 0.45);
      rot = 0;
    } else {
      x = (room.x - 0.55);
      y = (room.y + 0.5 + rand() * Math.max(0.5, room.h - 1));
      rot = Math.PI / 2;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    scrawls.push({
      x,
      y,
      rot,
      text: scrawlText[Math.floor(rand() * scrawlText.length)] ?? 'TURN BACK',
      alpha: 0.16 + rand() * 0.2,
    });
  }

  const spawnPoints: Vec[] = [];
  for (const r of candidateRooms) {
    for (let i = 0; i < 3; i++) {
      spawnPoints.push({
        x: r.x + 1 + rand() * Math.max(1, r.w - 2),
        y: r.y + 1 + rand() * Math.max(1, r.h - 2),
      });
    }
  }
  if (spawnPoints.length === 0) spawnPoints.push({ x: spawn.x + 2, y: spawn.y });

  return { w, h, tiles, rooms, spawn, stairs, pickups, decals, candles, scrawls, spawnPoints };
}
