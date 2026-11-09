/**
 * All audio is synthesized at runtime with the Web Audio API, so the game ships
 * without any sound assets. Everything is wrapped defensively: audio failure
 * must never stop the game.
 */
export class GameAudio {
  private ac: AudioContext | null = null;
  private master: GainNode | null = null;
  private droneFilter: BiquadFilterNode | null = null;
  private droneGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private beatTimer = 0.4;
  private whisperTimer = 5;
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
    delay = 0
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
      g.connect(this.master);
      osc.start(t);
      osc.stop(t + dur + 0.03);
    } catch {
      /* ignore */
    }
  }

  private noise(
    dur: number,
    freq: number,
    vol: number,
    type: BiquadFilterType = 'lowpass',
    delay = 0,
    slideTo?: number
  ): void {
    const ac = this.ac;
    if (!ac || !this.master || !this.noiseBuffer) return;
    try {
      const t = ac.currentTime + delay;
      const src = ac.createBufferSource();
      src.buffer = this.noiseBuffer;
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
      g.connect(this.master);
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
      this.droneFilter.frequency.setTargetAtTime(150 + tension * 300, now, 0.5);
      this.droneGain.gain.setTargetAtTime(0.045 + tension * 0.045, now, 0.6);
    } catch {
      /* ignore */
    }

    this.beatTimer -= dt;
    if (this.beatTimer <= 0 && tension > 0.18) {
      this.heartbeat(tension);
      this.beatTimer = 1.15 - tension * 0.62;
    }

    this.whisperTimer -= dt;
    if (this.whisperTimer <= 0) {
      if (tension > 0.55) this.whisper();
      this.whisperTimer = 6 + Math.random() * 10;
    }
  }

  heartbeat(tension: number): void {
    const vol = 0.16 + tension * 0.22;
    this.tone(46, 0.15, 'sine', vol);
    this.tone(38, 0.19, 'sine', vol * 0.7, 30, 0.19);
  }

  step(): void {
    this.noise(0.055, 430, 0.045, 'lowpass');
  }

  swing(): void {
    this.noise(0.13, 2200, 0.14, 'bandpass', 0, 400);
  }

  hit(): void {
    this.noise(0.13, 700, 0.22, 'lowpass');
    this.tone(78, 0.16, 'sine', 0.3, 38);
  }

  hurt(): void {
    this.tone(150, 0.32, 'sawtooth', 0.2, 62);
    this.noise(0.24, 520, 0.16, 'lowpass');
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
    this.noise(0.5, 1700, 0.035, 'bandpass');
    this.tone(1400, 0.4, 'sine', 0.012, 900, 0.15);
  }

  glass(): void {
    this.tone(1600, 0.1, 'square', 0.03, 700);
    this.noise(0.2, 3200, 0.06, 'highpass');
  }
}
