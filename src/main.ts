import './style.css';
import { Game } from './game/game';
import { GameAudio } from './game/audio';
import { Net, type NetStatus } from './net';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from './config';
import type { GameResult, HudState, PartyMember, PeerPresence } from './types';

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing DOM element: ${selector}`);
  return element;
};

const NAME_KEY = 'hollow.name';
const FX_KEY = 'hollow.reducedFx';
const MUTE_KEY = 'hollow.muted';
const CONFIG_KEY = 'hollow.supabase';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#b98a5c', '#7f9e94', '#a97b8b', '#8d9a6a', '#9c8577', '#7d8bab', '#b08a6d'];

// ── DOM ─────────────────────────────────────────────────────────

const menu = $('#menu');
const gameSection = $('#game');
const canvas = $<HTMLCanvasElement>('#game-canvas');
const hud = $('#hud');
const ageCheck = $<HTMLInputElement>('#age-check');
const fxCheck = $<HTMLInputElement>('#fx-check');
const nameInput = $<HTMLInputElement>('#name');
const joinInput = $<HTMLInputElement>('#join-code');
const btnSolo = $<HTMLButtonElement>('#btn-solo');
const btnHost = $<HTMLButtonElement>('#btn-host');
const btnJoin = $<HTMLButtonElement>('#btn-join');
const btnSetup = $<HTMLButtonElement>('#btn-setup');
const mpStatus = $('#mp-status');

const setupModal = $('#setup');
const sbUrl = $<HTMLInputElement>('#sb-url');
const sbKey = $<HTMLInputElement>('#sb-key');
const setupSave = $<HTMLButtonElement>('#setup-save');
const setupClose = $<HTMLButtonElement>('#setup-close');
const setupClear = $<HTMLButtonElement>('#setup-clear');
const setupMsg = $('#setup-msg');

const connecting = $('#connecting');
const connectingText = $('#connecting-text');
const connectingSub = $('#connecting-sub');
const connectingCancel = $<HTMLButtonElement>('#connecting-cancel');

const floorNum = $('#floor-num');
const objective = $('#objective');
const roomCodeEl = $('#room-code');
const netStatusEl = $('#net-status');
const netText = $('#net-text');
const partyEl = $('#party');
const hpFill = $('#hp-fill');
const hpText = $('#hp-text');
const staminaFill = $('#stamina-fill');
const batteryFill = $('#battery-fill');
const batteryText = $('#battery-text');
const dreadFill = $('#dread-fill');
const promptEl = $('#prompt');
const toasts = $('#toasts');
const descendEl = $('#descend');
const descendCount = $('#descend-count');
const deathBanner = $('#death-banner');
const controlsHint = $('#controls-hint');

const pauseModal = $('#pause');
const btnResume = $<HTMLButtonElement>('#btn-resume');
const btnLeave = $<HTMLButtonElement>('#btn-leave');
const btnMute = $<HTMLButtonElement>('#btn-mute');
const muteBtn = $<HTMLButtonElement>('#mute-btn');
const pauseBtn = $<HTMLButtonElement>('#pause-btn');

const endModal = $('#end');
const endTitle = $('#end-title');
const endCause = $('#end-cause');
const endStats = $('#end-stats');
const btnAgain = $<HTMLButtonElement>('#btn-again');
const btnMenu = $<HTMLButtonElement>('#btn-menu');

// ── State ───────────────────────────────────────────────────────

interface SupabaseConfig {
  url: string;
  key: string;
}

type Mode = 'solo' | 'host' | 'join';

const audio = new GameAudio();
let game: Game | null = null;
let net: Net | null = null;
let currentPeers: PeerPresence[] = [];
let hostId = '';
let myId = '';
let sessionCode = '';
let sessionMode: Mode = 'solo';
let netState: NetStatus = 'connected';
let busy = false;
let attempt = 0;
let cancelConnect = false;
let lastPartyKey = '';
let lastPrompt = '';
let lastDescend = -1;
let muted = readFlag(MUTE_KEY);
let dropNoticeShown = false;
let currentSessionPlayer: PeerPresence | null = null;
let lastNetLabel = '';

// ── Small helpers ───────────────────────────────────────────────

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage may be unavailable */
  }
}

function sanitizeName(raw: string): string {
  return raw.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 14);
}

function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function randomCode(length = 4): string {
  const values = new Uint32Array(length);
  crypto.getRandomValues(values);
  let code = '';
  for (const value of values) code += ALPHABET[value % ALPHABET.length];
  return code;
}

function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Supabase configuration ──────────────────────────────────────

function isConfig(value: unknown): value is SupabaseConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SupabaseConfig>;
  return (
    typeof candidate.url === 'string' &&
    /^https?:\/\/[^\s]+$/i.test(candidate.url) &&
    typeof candidate.key === 'string' &&
    candidate.key.length >= 20 &&
    !/\s/.test(candidate.key)
  );
}

function loadConfig(): SupabaseConfig | null {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (isConfig(parsed)) return { url: parsed.url.replace(/\/+$/, ''), key: parsed.key };
    }
  } catch {
    /* fall through to build-time env */
  }
  const url = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;
  if (url && key && isConfig({ url, key })) {
    return { url: String(url).replace(/\/+$/, ''), key: String(key) };
  }
  return null;
}

function menuMessage(text: string, tone: 'ok' | 'bad' | 'plain' = 'plain'): void {
  mpStatus.textContent = text;
  mpStatus.className = `mp-status ${tone === 'plain' ? '' : tone}`;
}

function refreshConfigUi(forceMessage = false): void {
  const config = loadConfig();
  if (config) {
    let host = config.url;
    try {
      host = new URL(config.url).hostname;
    } catch {
      /* keep raw */
    }
    if (forceMessage || !mpStatus.textContent?.includes('ready')) {
      menuMessage(`Multiplayer ready — ${host} · Realtime via Supabase`, 'ok');
    }
    btnHost.disabled = !ageCheck.checked || busy;
    btnJoin.disabled = !ageCheck.checked || joinInput.value.trim().length < 3 || busy;
  } else {
    menuMessage('Multiplayer is not connected — solo works offline, or add your Supabase keys.', 'bad');
    btnHost.disabled = true;
    btnJoin.disabled = true;
  }
  btnSolo.disabled = !ageCheck.checked || busy;
}

function openSetup(): void {
  const config = loadConfig();
  sbUrl.value = config?.url ?? '';
  sbKey.value = config?.key ?? '';
  setupMsg.textContent = '';
  setupMsg.className = 'setup-msg';
  setupModal.classList.remove('hidden');
  setTimeout(() => sbUrl.focus(), 50);
}

function closeSetup(): void {
  setupModal.classList.add('hidden');
}

async function saveSetup(): Promise<void> {
  const url = sbUrl.value.trim().replace(/\/+$/, '');
  const key = sbKey.value.trim();
  if (!isConfig({ url, key })) {
    setupMsg.textContent =
      'That does not look valid. Use the full https://…supabase.co URL and the public anon/publishable key.';
    setupMsg.className = 'setup-msg bad';
    return;
  }
  setupMsg.textContent = 'Testing the Realtime connection…';
  setupMsg.className = 'setup-msg';
  setupSave.disabled = true;

  let testNet: Net | null = null;
  try {
    testNet = new Net(
      url,
      key,
      `TEST${randomCode()}`,
      {
        id: crypto.randomUUID(),
        name: 'connection-test',
        color: '#b6a68e',
        joinedAt: Date.now(),
        floor: 1,
        seed: 1,
        hp: 100,
        dead: false,
      },
      {
        onPeers: () => undefined,
        onMessage: () => undefined,
        onStatus: () => undefined,
      }
    );
    await testNet.connect();
    await testNet.leave();
    testNet = null;

    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify({ url, key }));
    } catch {
      throw new Error('Connected, but this browser refused to save the keys.');
    }
    setupMsg.textContent = 'Connected. Multiplayer is ready.';
    setupMsg.className = 'setup-msg ok';
    refreshConfigUi(true);
    setTimeout(closeSetup, 800);
  } catch (error) {
    setupMsg.textContent =
      error instanceof Error
        ? `Could not connect: ${error.message}`
        : 'Could not connect. Check the URL, key and Realtime settings.';
    setupMsg.className = 'setup-msg bad';
    if (testNet) void testNet.leave();
  } finally {
    setupSave.disabled = false;
  }
}

// ── Menu / age gate ─────────────────────────────────────────────

function updateGate(): void {
  refreshConfigUi();
  if (ageCheck.checked) {
    menuMessage(
      loadConfig()
        ? 'Multiplayer ready — someone else can join with your room code.'
        : 'Solo is ready. Multiplayer needs your Supabase URL and public anon key.',
      loadConfig() ? 'ok' : 'plain'
    );
  }
  updateJoinState();
}

function updateJoinState(): void {
  const code = joinInput.value.trim();
  const config = loadConfig();
  btnJoin.disabled = !ageCheck.checked || busy || !config || code.length < 3;
  btnHost.disabled = !ageCheck.checked || busy || !config;
  btnSolo.disabled = !ageCheck.checked || busy;
}

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
  updateJoinState();
});

ageCheck.addEventListener('change', () => {
  updateGate();
});

nameInput.addEventListener('input', () => {
  nameInput.value = nameInput.value.slice(0, 14);
  try {
    localStorage.setItem(NAME_KEY, nameInput.value);
  } catch {
    /* ignore */
  }
});

fxCheck.addEventListener('change', () => {
  writeFlag(FX_KEY, fxCheck.checked);
});

btnSetup.addEventListener('click', openSetup);
setupClose.addEventListener('click', closeSetup);
setupSave.addEventListener('click', () => void saveSetup());
setupClear.addEventListener('click', () => {
  try {
    localStorage.removeItem(CONFIG_KEY);
  } catch {
    /* ignore */
  }
  setupMsg.textContent = 'Saved keys removed.';
  setupMsg.className = 'setup-msg ok';
  refreshConfigUi(true);
});

setupModal.addEventListener('click', (event) => {
  if (event.target === setupModal) closeSetup();
});

// ── Session boot ────────────────────────────────────────────────

function showConnecting(title: string, sub: string): void {
  connectingText.textContent = title;
  connectingSub.textContent = sub;
  connecting.classList.remove('hidden');
}

function updateConnecting(title: string, sub: string): void {
  connectingText.textContent = title;
  connectingSub.textContent = sub;
}

function hideConnecting(): void {
  connecting.classList.add('hidden');
}

function showGameUi(): void {
  menu.classList.add('hidden');
  gameSection.classList.remove('hidden');
  hud.classList.remove('hidden');
  endModal.classList.add('hidden');
  pauseModal.classList.add('hidden');
  deathBanner.classList.add('hidden');
  descendEl.classList.add('hidden');
  promptEl.classList.add('hidden');
  partyEl.innerHTML = '';
  lastPartyKey = '';
  lastPrompt = '';
  lastDescend = -1;
}

function showMenuUi(): void {
  gameSection.classList.add('hidden');
  menu.classList.remove('hidden');
  endModal.classList.add('hidden');
  pauseModal.classList.add('hidden');
  connecting.classList.add('hidden');
  toasts.innerHTML = '';
  busy = false;
  updateJoinState();
}

function cleanupSession(): void {
  if (game) {
    game.stop();
    game = null;
  }
  if (net) {
    const doomed = net;
    net = null;
    void doomed.leave();
  }
  currentSessionPlayer = null;
  currentPeers = [];
  hostId = '';
  netState = 'connected';
  dropNoticeShown = false;
  lastNetLabel = '';
  partyEl.innerHTML = '';
  toasts.innerHTML = '';
  lastPartyKey = '';
  roomCodeEl.textContent = '';
}

function handlePeers(peers: PeerPresence[]): void {
  currentPeers = peers;
  const sorted = peers
    .slice()
    .sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
  hostId = sorted[0]?.id ?? myId;
  if (game) game.setPeers(peers);
}

function handleNetStatus(status: NetStatus): void {
  netState = status;
  if (!net) return;
  if (status === 'error' && !dropNoticeShown) {
    dropNoticeShown = true;
    showToast('Connection trouble. The dark continues without the others.', 'warn');
  }
  paintNetStatus();
}

function paintNetStatus(): void {
  if (!net) {
    if (lastNetLabel !== 'SOLO') {
      netText.textContent = 'SOLO';
      netStatusEl.className = 'net-status';
      lastNetLabel = 'SOLO';
    }
    return;
  }
  let label = 'LIVE';
  let tone = 'live';
  if (netState === 'connecting') {
    label = 'LINKING';
    tone = '';
  } else if (netState === 'reconnecting') {
    label = 'RECONNECTING';
    tone = 'bad';
  } else if (netState === 'error') {
    label = 'OFFLINE';
    tone = 'bad';
  }
  if (lastNetLabel !== `${label}|${tone}`) {
    netText.textContent = label;
    netStatusEl.className = `net-status ${tone}`;
    lastNetLabel = `${label}|${tone}`;
  }
}

async function startSession(mode: Mode, requestedCode?: string): Promise<void> {
  if (busy) return;
  if (!ageCheck.checked) {
    showToast('Confirm you are 15 or older first.', 'warn');
    return;
  }
  const name = sanitizeName(nameInput.value) || 'Wanderer';
  nameInput.value = name;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  const config = loadConfig();
  if (mode !== 'solo' && !config) {
    openSetup();
    return;
  }

  busy = true;
  updateJoinState();
  const myAttempt = ++attempt;
  cancelConnect = false;
  await audio.start();
  if (myAttempt !== attempt) return;

  cleanupSession();
  const color = colorFor(name);
  myId = crypto.randomUUID();
  sessionMode = mode;

  try {
    if (mode === 'solo') {
      sessionCode = '';
      const seed = randomSeed();
      const me: PeerPresence = {
        id: myId,
        name,
        color,
        joinedAt: Date.now(),
        floor: 1,
        seed,
        hp: 100,
        dead: false,
        host: true,
      };
      currentSessionPlayer = me;
      currentPeers = [];
      hostId = myId;
      startGame({
        mode,
        code: '',
        seed,
        floor: 1,
        name,
        color,
        peers: [],
        multiplayer: false,
      });
      busy = false;
      updateJoinState();
      return;
    }

    if (!config) throw new Error('Supabase is not configured.');
    const code = mode === 'host' ? randomCode(4) : (requestedCode ?? '').trim().toUpperCase();
    if (code.length < 3) throw new Error('Enter the room code you were given.');
    const seed = mode === 'host' ? randomSeed() : 0;
    const me: PeerPresence = {
      id: myId,
      name,
      color,
      joinedAt: Date.now(),
      floor: 1,
      seed,
      hp: 100,
      dead: false,
      host: mode === 'host',
    };
    currentSessionPlayer = me;
    sessionCode = code;

    showConnecting(
      mode === 'host' ? 'Opening a room…' : `Looking for room ${code}…`,
      mode === 'host'
        ? 'Listening for other footsteps.'
        : 'If nobody answers, the room may be empty.'
    );

    net = new Net(config.url, config.key, code, me, {
      onPeers: handlePeers,
      onMessage: (type, data, from) => game?.receive(type, data, from),
      onStatus: handleNetStatus,
    });
    await net.connect();
    if (myAttempt !== attempt || cancelConnect) throw new Error('cancelled');
    const found = await net.waitForPeers(3500);
    if (myAttempt !== attempt || cancelConnect) throw new Error('cancelled');

    if (mode === 'join') {
      const others = found.filter((peer) => peer.id !== myId);
      if (others.length === 0) {
        throw new Error(`No party answered in room ${code}. Check the code, or create a new room.`);
      }
      const host = found
        .slice()
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (!host || !host.seed) {
        throw new Error('That room is still forming. Wait a moment and try the code again.');
      }
      updateConnecting(`Joining ${host.name}'s descent…`, `Depth ${host.floor || 1}`);
      await delay(500);
      if (myAttempt !== attempt || cancelConnect) throw new Error('cancelled');
      startGame({
        mode,
        code,
        seed: host.seed >>> 0,
        floor: host.floor || 1,
        name,
        color,
        peers: net.peers,
        multiplayer: true,
      });
    } else {
      updateConnecting('Room open.', `Share the code ${code} with your party.`);
      await delay(500);
      if (myAttempt !== attempt || cancelConnect) throw new Error('cancelled');
      startGame({
        mode,
        code,
        seed,
        floor: 1,
        name,
        color,
        peers: net.peers,
        multiplayer: true,
      });
    }
    busy = false;
    updateJoinState();
  } catch (error) {
    if (myAttempt !== attempt && !cancelConnect) return;
    cleanupSession();
    hideConnecting();
    showMenuUi();
    busy = false;
    if (!(error instanceof Error && error.message === 'cancelled')) {
      menuMessage(error instanceof Error ? error.message : 'Could not start the session.', 'bad');
    }
  }
}

interface StartGameOptions {
  mode: Mode;
  code: string;
  seed: number;
  floor: number;
  name: string;
  color: string;
  peers: PeerPresence[];
  multiplayer: boolean;
}

function startGame(options: StartGameOptions): void {
  hideConnecting();
  showGameUi();
  sessionMode = options.mode;
  sessionCode = options.code;
  roomCodeEl.textContent = options.code;
  netState = 'connected';
  lastNetLabel = '';
  paintNetStatus();
  const peers = options.peers.length ? options.peers : currentPeers;
  const activeNet = net;
  const hooks = {
    hud: applyHud,
    toast: showToast,
    ended: handleEnd,
    presence: (patch: Partial<PeerPresence>) => {
      void activeNet?.updatePresence(patch);
    },
  };
  game = new Game({
    canvas,
    playerId: myId,
    name: options.name,
    color: options.color,
    seed: options.seed,
    floor: options.floor,
    multiplayer: options.multiplayer,
    reducedFx: fxCheck.checked,
    audio,
    hooks,
    peers,
    send: activeNet ? (type, data) => activeNet.send(type, data) : undefined,
  });
  game.start();
  busy = false;
  updateJoinState();
  canvas.focus();
}

// ── HUD ─────────────────────────────────────────────────────────

function updateParty(party: PartyMember[]): void {
  if (!net) {
    if (lastPartyKey !== 'solo') {
      partyEl.innerHTML = '';
      lastPartyKey = 'solo';
    }
    return;
  }
  const key = party
    .map(
      (member) =>
        `${member.id.slice(0, 8)}:${Math.round(member.hp)}:${member.dead ? 1 : 0}:${member.isHost ? 1 : 0}`
    )
    .join('|');
  if (key === lastPartyKey) return;
  lastPartyKey = key;
  partyEl.innerHTML = party
    .map((member) => {
      const classes = ['party-member'];
      if (member.isSelf) classes.push('self');
      if (member.dead) classes.push('dead');
      return `<div class="${classes.join(' ')}">
        <span class="swatch" style="background:${escapeHtml(member.color)}"></span>
        <span class="p-name">${escapeHtml(member.name)}${member.isSelf ? ' (you)' : ''}${
        member.isHost ? '<span class="host-mark">HOST</span>' : ''
      }</span>
        <span class="p-hp">${Math.max(0, Math.round(member.hp))}</span>
      </div>`;
    })
    .join('');
}

function setFill(element: HTMLElement, value: number): void {
  const pct = Math.max(0, Math.min(100, value));
  element.style.width = `${pct}%`;
}

function applyHud(state: HudState): void {
  setFill(hpFill, (state.hp / state.maxHp) * 100);
  hpText.textContent = String(Math.max(0, Math.round(state.hp)));
  setFill(staminaFill, state.stamina);
  setFill(batteryFill, state.battery);
  batteryText.textContent = state.flashlight
    ? `${Math.round(state.battery)}%`
    : state.battery <= 0
      ? 'DEAD'
      : 'OFF';
  setFill(dreadFill, state.dread);
  floorNum.textContent = String(state.floor).padStart(2, '0');
  objective.textContent =
    state.fuses >= 3 ? 'The stairwell is open — descend' : `Recover the three fuses · ${state.fuses}/3`;
  updateParty(state.party);

  const hpBar = hpFill.parentElement?.parentElement;
  if (hpBar) hpBar.classList.toggle('low', state.hp < 30);

  if (state.prompt !== lastPrompt) {
    lastPrompt = state.prompt;
    if (state.prompt) {
      promptEl.innerHTML = `<kbd>E</kbd><span>${escapeHtml(state.prompt)}</span>`;
      promptEl.classList.remove('hidden');
    } else {
      promptEl.classList.add('hidden');
    }
  }

  deathBanner.classList.toggle('hidden', !(state.dead && state.spectating));
  if (state.dead && state.spectating) {
    deathBanner.querySelector('span')!.textContent =
      'Your body joins the hollow. Watch your companions.';
  }

  const descending = Math.ceil(state.descending);
  if (descending !== lastDescend) {
    lastDescend = descending;
    if (descending > 0) {
      descendCount.textContent = String(descending);
      descendEl.classList.remove('hidden');
    } else {
      descendEl.classList.add('hidden');
    }
  }

  controlsHint.textContent = state.flashlight
    ? 'WASD move · Shift sprint · Mouse aim · LMB strike · F light · E use · Esc pause'
    : 'WASD move · Shift sprint · Mouse aim · LMB strike · F light off · E use · Esc pause';

  // Let the caught scene play as a clean cinematic; the HUD returns if a
  // multiplayer session moves on to spectating.
  hud.classList.toggle('hidden', state.dead && !state.spectating);

  paintNetStatus();
}

function showToast(text: string, tone: 'info' | 'warn' | 'blood' = 'info'): void {
  const toast = document.createElement('div');
  toast.className = `toast${tone === 'info' ? '' : ` ${tone}`}`;
  toast.textContent = text;
  toasts.appendChild(toast);
  while (toasts.children.length > 4) toasts.firstElementChild?.remove();
  setTimeout(() => toast.remove(), 3300);
}

// ── End / pause / mute ──────────────────────────────────────────

function handleEnd(result: GameResult): void {
  if (!game) return;
  game.setPaused(true);
  endTitle.textContent = result.floor >= 5 ? 'The hollow keeps you' : 'You are lost';
  endCause.textContent = result.cause;
  endStats.innerHTML = `
    <div><b>${result.floor}</b><span>Depth</span></div>
    <div><b>${formatTime(result.seconds)}</b><span>Survived</span></div>
    <div><b>${result.fuses}<em>/3</em></b><span>Fuses</span></div>
  `;
  endModal.classList.remove('hidden');
}

function togglePause(): void {
  if (!game || endModal.classList.contains('hidden') === false) return;
  const paused = game.isPaused;
  if (paused) {
    game.setPaused(false);
    pauseModal.classList.add('hidden');
  } else {
    game.setPaused(true);
    pauseModal.classList.remove('hidden');
  }
}

function closePause(): void {
  if (!game) return;
  game.setPaused(false);
  pauseModal.classList.add('hidden');
}

function toggleMute(): void {
  muted = !muted;
  audio.setMuted(muted);
  writeFlag(MUTE_KEY, muted);
  const icon = muted ? '×' : '♪';
  muteBtn.textContent = icon;
  muteBtn.setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
  btnMute.textContent = muted ? 'Audio: muted' : 'Toggle audio';
}

btnResume.addEventListener('click', closePause);
pauseBtn.addEventListener('click', togglePause);
muteBtn.addEventListener('click', toggleMute);
btnMute.addEventListener('click', toggleMute);
btnLeave.addEventListener('click', () => {
  cleanupSession();
  showMenuUi();
});

btnMenu.addEventListener('click', () => {
  cleanupSession();
  showMenuUi();
  refreshConfigUi(true);
});

btnAgain.addEventListener('click', () => {
  const mode = sessionMode;
  const code = sessionCode;
  cleanupSession();
  showMenuUi();
  if (mode === 'join') {
    void startSession('join', code);
  } else if (mode === 'host') {
    void startSession('host');
  } else {
    void startSession('solo');
  }
});

connectingCancel.addEventListener('click', () => {
  attempt++;
  cancelConnect = true;
  cleanupSession();
  hideConnecting();
  showMenuUi();
});

window.addEventListener('keydown', (event) => {
  if (menu.classList.contains('hidden') === false) return;
  const key = event.key.toLowerCase();
  if (key === 'escape') {
    if (!endModal.classList.contains('hidden')) return;
    event.preventDefault();
    togglePause();
  } else if (key === 'm') {
    if (event.repeat) return;
    toggleMute();
  }
});

window.addEventListener('beforeunload', () => {
  if (net) void net.leave();
});

// ── Boot ────────────────────────────────────────────────────────

try {
  nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
} catch {
  /* ignore */
}
fxCheck.checked = readFlag(FX_KEY);
muted = readFlag(MUTE_KEY);
audio.setMuted(muted);
muteBtn.textContent = muted ? '×' : '♪';
btnMute.textContent = muted ? 'Audio: muted' : 'Toggle audio';

const urlParams = new URLSearchParams(window.location.search);
const roomParam = urlParams.get('room');
if (roomParam) {
  joinInput.value = roomParam.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

refreshConfigUi();
updateJoinState();
paintNetStatus();

btnSolo.addEventListener('click', () => void startSession('solo'));
btnHost.addEventListener('click', () => void startSession('host'));
btnJoin.addEventListener('click', () => void startSession('join', joinInput.value));
joinInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !btnJoin.disabled) {
    event.preventDefault();
    void startSession('join', joinInput.value);
  }
});

// Keep the menu buttons honest when keys change in another tab.
window.addEventListener('storage', () => refreshConfigUi());
