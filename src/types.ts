export type MonsterKind = 'crawler' | 'stalker' | 'wailer';
export type PickupKind = 'fuse' | 'medkit' | 'battery';

export interface Monster {
  id: string;
  kind: MonsterKind;
  x: number;
  y: number;
  /** Interpolation target used by non-host clients. */
  tx: number;
  ty: number;
  hp: number;
  maxHp: number;
  flash: number;
  hunt: boolean;
  phase: number;
  attackCd: number;
  screamCd: number;
  targetId: string | null;
}

export interface Pickup {
  id: string;
  kind: PickupKind;
  x: number;
  y: number;
  taken: boolean;
}

export interface RemotePlayer {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  facing: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  moving: boolean;
  sprinting: boolean;
  attack: number;
  flashlight: boolean;
  lastSeen: number;
}

export interface PeerPresence {
  id: string;
  name: string;
  color: string;
  joinedAt: number;
  floor: number;
  seed: number;
  hp: number;
  dead: boolean;
  host?: boolean;
  fuses?: number;
}

export interface PartyMember {
  id: string;
  name: string;
  color: string;
  hp: number;
  maxHp: number;
  dead: boolean;
  isSelf: boolean;
  isHost: boolean;
}

export interface HudState {
  hp: number;
  maxHp: number;
  stamina: number;
  battery: number;
  dread: number;
  fuses: number;
  floor: number;
  prompt: string;
  dead: boolean;
  flashlight: boolean;
  descending: number;
  party: PartyMember[];
  spectating: boolean;
}

export interface GameResult {
  floor: number;
  seconds: number;
  fuses: number;
  cause: string;
}

export interface GameHooks {
  hud: (state: HudState) => void;
  toast: (text: string, tone?: 'info' | 'warn' | 'blood') => void;
  ended: (result: GameResult) => void;
  presence: (patch: Partial<PeerPresence>) => void;
}
