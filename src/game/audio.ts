/**
 * All audio is synthesized at runtime with the Web Audio API, so the game ships
 * without any sound assets. Everything is wrapped defensively: audio failure
 * must never stop the game.
 *
 * The mix is deliberately physical: a generated stone-room impulse gives every
 * sound a tail, and one-shots can be panned so the thing making them has a
 * direction. Silence is treated as a resource — the drone sits just under the
 * threshold of noticing until dread pushes it up.
 */
import type { MonsterKind } from '../types';

export class GameAudio {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private wet: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private droneSub: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private beatTimer = 0.4;
  private whisperTimer = 5;
  private ambienceTimer = 4;
  muted = false;

  async start(): Promise<void> {
    if (this.ac) {
      try {
        await this.ac.resume();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ac = new Ctor();
      this.ac = ac;

      const master = ac.createGain();
      master.gain.value = this.muted ? 0 : 0.55;
      master.connect(ac.destination);
      this.master = master;

      // A generated stone corridor: two channels of decaying noise give the
      // whole mix a place without shipping an impulse response file.
      const convolver = ac.createConvolver();
      convolver.buffer = this.makeImpulse(ac);
      const wet = ac.createGain();
      wet.gain.value = 0.19;
      master.connect(convolver);
      convolver.connect(wet);
      wet.connect(ac.destination);
      this.reverb = convolver;
      this.wet = wet;

      const len = Math.floor(ac.sampleRate * 2);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;

      const filter = ac.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 170;
      filter.Q.value = 2.5;
      const gain = ac.createGain();
      gain.gain.value = 0.05;
      filter.connect(gain);
      gain.connect(master);
      this.droneFilter = filter;
      this.droneGain = gain;

      const layers: Array<[number, OscillatorType, number]> = [
        [24.4, 'sine', 0],
        [36.7, 'sine', -6],
        [55, 'triangle', 4],
        [73.4, 'sine', 9],
      ];
      for (const [freq, type, detune] of layers) {
        const osc = ac.createOscillator();
        osc.type = type;
        osc.frequency.value = freq;
        osc.detune.value = detune;
        osc.connect(filter);
        osc.start();
      }

      // Sub-bass presence, felt rather than heard.
      const sub = ac.createGain();
      sub.gain.value = 0.018;
      const subOsc = ac.createOscillator();
      subOsc.type = 'sine';
      subOsc.frequency.value = 18.5;
      subOsc.connect(sub);
      sub.connect(master);
      subOsc.start();
      this.droneSub = sub;

      const lfo = ac.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ac.createGain();
      lfoGain.gain.value = 36;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();

      await ac.resume();
    } catch {
      this.ac = null;
    }
  }

  private makeImpulse(ac: AudioContext): AudioBuffer {
    const seconds = 1.9;
    const len = Math.floor(ac.sampleRate * seconds);
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buf.getChannelData(channel);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const noise = Math.random() * 2 - 1;
        // Very gentle low-pass turns the tail into a wet stone reflection.
        last = last * 0.62 + noise * 0.38;
        data[i] = last * Math.pow(1 - t, 3.1) * (channel === 0 ? 0.9 : 0.75);
      }
    }
    return buf;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ac) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ac.currentTime, 0.04);
    }
  }

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    slideTo?: number,
    delay = 0,
    pan = 0
  ): void {
    const ac = this.ac;
    if (!ac || !this.master) return;
    try {
      const t = ac.currentTime + delay;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(20, freq), t);
      if (slideTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      this.connectOut(g, pan);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    } catch {
      /* ignore */
    }
  }

  private connectOut(node: AudioNode, pan: number): void {
    const ac = this.ac;
    if (!ac || !this.master) return;
    if (Math.abs(pan) < 0.01) {
      node.connect(this.master);
      return;
    }
    const panner = ac.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(panner);
    panner.connect(this.master);
  }

  private noise(
    dur: number,
    freq: number,
    vol: number,
    type: BiquadFilterType = 'lowpass',
    delay = 0,
    slideTo?: number,
    pan = 0
  ): void {
    const ac = this.ac;
    if (!ac || !this.master || !this.noiseBuffer) return;
    try {
      const t = ac.currentTime + delay;
      const src = ac.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = ac.createBiquadFilter();
      filter.type = type;
      filter.frequency.setValueAtTime(Math.max(40, freq), t);
      if (slideTo !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t + dur);
      }
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(filter);
      filter.connect(g);
      this.connectOut(g, pan);
      src.start(t);
      src.stop(t + dur + 0.03);
    } catch {
      /* ignore */
    }
  }

  update(tension: number, dt: number): void {
    if (!this.ac || !this.droneFilter || !this.droneGain) return;
    const now = this.ac.currentTime;
    try {
      this.droneFilter.frequency.setTargetAtTime(134 + tension * 380, now, 0.5);
      this.droneGain.gain.setTargetAtTime(0.042 + tension * 0.055, now, 0.6);
      this.droneSub?.gain.setTargetAtTime(0.014 + tension * 0.03, now, 0.8);
    } catch {
      /* ignore */
    }

    this.beatTimer -= dt;
    if (this.beatTimer <= 0 && tension > 0.16) {
      this.heartbeat(tension);
      this.beatTimer = 1.2 - tension * 0.66;
    }

    this.whisperTimer -= dt;
    if (this.whisperTimer <= 0) {
      if (tension > 0.4 && Math.random() < 0.7) this.whisper();
      this.whisperTimer = 7 + Math.random() * 12;
    }

    // Something in the dark is always settling, far away.
    this.ambienceTimer -= dt;
    if (this.ambienceTimer <= 0) {
      this.ambienceTimer = 6 + Math.random() * 11;
      if (tension > 0.12) {
        const pan = Math.random() * 1.8 - 0.9;
        const roll = Math.random();
        if (roll < 0.42) this.ambient('drip', pan);
        else if (roll < 0.72) this.ambient('creak', pan);
        else this.ambient('distantStep', pan);
      }
    }
  }

  heartbeat(tension: number): void {
    const vol = 0.16 + tension * 0.24;
    this.tone(46, 0.15, 'sine', vol);
    this.tone(38, 0.19, 'sine', vol * 0.7, 30, 0.19);
  }

  step(): void {
    const scuff = Math.random();
    this.noise(0.055, 360 + scuff * 190, 0.036 + scuff * 0.02, 'lowpass', 0, undefined, (Math.random() - 0.5) * 0.28);
    if (scuff > 0.74) this.noise(0.09, 1500, 0.014, 'highpass', 0.015);
  }

  swing(): void {
    this.noise(0.13, 2200, 0.14, 'bandpass', 0, 400);
  }

  hit(): void {
    this.noise(0.13, 700, 0.22, 'lowpass');
    this.tone(78, 0.16, 'sine', 0.3, 38);
    this.noise(0.1, 2400, 0.05, 'highpass', 0.01);
  }

  hurt(): void {
    this.tone(150, 0.32, 'sawtooth', 0.2, 62);
    this.noise(0.24, 520, 0.16, 'lowpass');
    this.noise(0.4, 260, 0.07, 'bandpass', 0.05);
  }

  pickup(): void {
    this.tone(520, 0.1, 'sine', 0.11);
    this.tone(780, 0.17, 'sine', 0.09, undefined, 0.09);
  }

  fuse(): void {
    [392, 523, 659].forEach((f, i) => this.tone(f, 0.26, 'sine', 0.09, undefined, i * 0.1));
    this.noise(0.5, 600, 0.06, 'bandpass');
  }

  deny(): void {
    this.tone(112, 0.2, 'square', 0.07, 88);
  }

  monsterDie(): void {
    this.noise(0.42, 900, 0.2, 'bandpass', 0, 180);
    this.tone(180, 0.5, 'sawtooth', 0.09, 42);
  }

  scream(kind: 'crawler' | 'stalker' | 'wailer'): void {
    if (kind === 'wailer') {
      this.tone(660, 1.15, 'sawtooth', 0.11, 170);
      this.tone(990, 0.9, 'sine', 0.05, 240, 0.05);
      this.noise(1.2, 1400, 0.1, 'bandpass', 0, 400);
    } else if (kind === 'stalker') {
      this.tone(120, 0.75, 'sawtooth', 0.12, 60);
      this.noise(0.7, 320, 0.16, 'lowpass');
    } else {
      this.noise(0.42, 2600, 0.12, 'highpass');
      this.tone(880, 0.32, 'square', 0.045, 280);
    }
  }

  descend(): void {
    this.noise(1.7, 130, 0.3, 'lowpass', 0, 40);
    this.tone(50, 1.7, 'sine', 0.26, 26);
    this.tone(74, 1.2, 'triangle', 0.1, 38, 0.2);
  }

  floorArrive(): void {
    this.noise(0.8, 220, 0.14, 'lowpass');
    this.tone(90, 0.9, 'sine', 0.12, 48);
  }

  death(): void {
    this.tone(210, 1.7, 'sawtooth', 0.17, 32);
    this.noise(1.5, 500, 0.16, 'lowpass', 0, 60);
  }

  /** The sound of being caught: a sub-bass impact, bones, and a scream. */
  caught(kind: 'crawler' | 'stalker' | 'wailer'): void {
    this.noise(1.9, 1700, 0.3, 'lowpass', 0, 55);
    this.tone(42, 2.3, 'sine', 0.36, 21);
    this.tone(96, 1.5, 'sawtooth', 0.14, 34, 0.02);
    this.tone(31, 1.2, 'triangle', 0.22, 18, 0.12);
    this.noise(0.15, 3800, 0.25, 'highpass', 0.02);
    this.noise(0.22, 900, 0.2, 'bandpass', 0.1, 180);
    this.tone(290, 0.42, 'square', 0.05, 54, 0.06);
    this.scream(kind);
    this.noise(0.95, 500, 0.08, 'bandpass', 0.35, 1600);
    this.tone(28, 0.85, 'sine', 0.3, 20, 1.9);
  }

  whisper(): void {
    this.noise(0.48, 1650, 0.028, 'bandpass', 0, 900, -0.45);
    this.tone(1420, 0.36, 'sine', 0.01, 880, 0.14, -0.45);
    this.noise(0.52, 1250, 0.022, 'bandpass', 0.3, 1900, 0.55);
    this.tone(980, 0.3, 'sine', 0.008, 1500, 0.44, 0.55);
  }

  glass(): void {
    this.tone(1600, 0.1, 'square', 0.03, 700);
    this.noise(0.2, 3200, 0.06, 'highpass');
  }

  /** Small, close sounds that make the room feel occupied. */
  ambient(kind: 'drip' | 'creak' | 'distantStep' | 'whisper' | 'groan' | 'breath', pan = 0): void {
    switch (kind) {
      case 'drip':
        this.tone(1180 + Math.random() * 320, 0.1, 'sine', 0.05, 420, 0, pan);
        this.noise(0.13, 3400, 0.026, 'highpass', 0.01, undefined, pan);
        this.tone(620, 0.16, 'sine', 0.012, 300, 0.07, pan);
        break;
      case 'creak': {
        const base = 58 + Math.random() * 34;
        this.tone(base, 0.65, 'sawtooth', 0.026, base * 0.62, 0, pan);
        this.noise(0.8, 280, 0.04, 'bandpass', 0.05, 140, pan);
        break;
      }
      case 'distantStep':
        this.tone(58, 0.24, 'sine', 0.075, 42, 0, pan);
        this.noise(0.3, 260, 0.035, 'lowpass', 0.02, 120, pan);
        break;
      case 'whisper':
        this.whisper();
        break;
      case 'groan':
        this.tone(66, 1.4, 'sawtooth', 0.05, 41, 0, pan);
        this.tone(98, 1.1, 'triangle', 0.025, 61, 0.1, pan);
        this.noise(1.5, 190, 0.035, 'lowpass', 0.1, 90, pan);
        break;
      case 'breath':
        this.noise(0.55, 620, 0.035, 'bandpass', 0, 380, pan);
        this.noise(0.4, 480, 0.022, 'bandpass', 0.62, 320, pan);
        break;
      default:
        break;
    }
  }

  /** A directional reminder that something knows where you are. */
  monsterCue(kind: 'crawler' | 'stalker' | 'wailer', pan: number, intensity: number): void {
    const i = Math.max(0.12, Math.min(1, intensity));
    if (kind === 'crawler') {
      const beats = 3 + Math.floor(Math.random() * 3);
      for (let b = 0; b < beats; b++) {
        this.noise(0.045, 2100 + Math.random() * 900, 0.03 * i, 'highpass', b * 0.075, undefined, pan);
        this.tone(300 + Math.random() * 220, 0.05, 'square', 0.015 * i, 160, b * 0.075, pan);
      }
    } else if (kind === 'stalker') {
      this.noise(0.85, 340, 0.05 * i, 'bandpass', 0, 520, pan);
      this.tone(52, 1.1, 'sawtooth', 0.045 * i, 38, 0, pan);
      this.noise(0.5, 900, 0.022 * i, 'bandpass', 0.4, 700, pan);
    } else {
      this.tone(420 + Math.random() * 160, 1.5, 'sine', 0.045 * i, 180, 0, pan);
      this.noise(1.4, 900, 0.03 * i, 'bandpass', 0.1, 420, pan);
      this.tone(210, 1.2, 'triangle', 0.02 * i, 160, 0.25, pan);
    }
  }

  /** A close brush with something that noticed you. */
  sting(): void {
    this.tone(1320, 0.42, 'sawtooth', 0.11, 260);
    this.noise(0.55, 2400, 0.11, 'highpass', 0, 500);
    this.tone(41, 0.9, 'sine', 0.25, 26, 0.02);
    this.noise(0.7, 340, 0.09, 'lowpass', 0.05);
  }

  /** A full-body flinch: impact first, then the thing behind it. */
  jumpScare(kind: MonsterKind, source: 'monster' | 'apparition' | 'fuse', pan = 0): void {
    const soft = source !== 'monster';
    this.noise(0.1, 5200, soft ? 0.12 : 0.28, 'highpass', 0, undefined, pan);
    this.tone(soft ? 62 : 44, 0.6, 'sine', soft ? 0.18 : 0.32, 24, 0, pan);
    this.noise(0.48, soft ? 1700 : 1100, soft ? 0.1 : 0.16, 'bandpass', 0.02, 220, pan);
    if (source === 'monster') {
      this.scream(kind);
    } else {
      this.whisper();
      this.noise(0.7, 540, 0.05, 'bandpass', 0.1, 280, -pan);
      this.tone(820, 0.2, 'sine', 0.018, 380, 0.1, pan);
    }
    this.tone(31, 1.0, 'triangle', 0.18, 20, 0.04, pan);
    this.noise(0.3, 280, 0.1, 'lowpass', 0.16, 90, pan);
  }

  /** Ragged breathing after a sprint, also used when fear peaks. */
  catchBreath(): void {
    this.noise(0.5, 680, 0.035, 'bandpass', 0, 420, -0.18);
    this.noise(0.42, 520, 0.026, 'bandpass', 0.58, 360, 0.16);
    this.noise(0.3, 900, 0.014, 'bandpass', 0.32, 700, 0);
  }

  lightBuzz(): void {
    this.tone(118, 0.07, 'square', 0.009, 96);
    this.noise(0.05, 4400, 0.012, 'highpass');
  }
}
