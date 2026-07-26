/**
 * All sound is synthesised at runtime -- there are no audio files in this
 * project. The rolling sound in particular has to track speed and surface
 * continuously, which a sample loop does badly.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  private rollSource: AudioBufferSourceNode | null = null;
  private rollFilter: BiquadFilterNode | null = null;
  private rollGain: GainNode | null = null;

  muted = false;

  /** Must be called from a user gesture; iOS will not start audio otherwise. */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return;

    const ctx: AudioContext = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    // --- rolling noise bed ---------------------------------------------------
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Brown-ish noise: integrating white noise puts the energy low, which is
    // what a heavy ball on stone actually sounds like.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }

    this.rollSource = ctx.createBufferSource();
    this.rollSource.buffer = buffer;
    this.rollSource.loop = true;

    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'bandpass';
    this.rollFilter.frequency.value = 300;
    this.rollFilter.Q.value = 1.1;

    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;

    this.rollSource.connect(this.rollFilter);
    this.rollFilter.connect(this.rollGain);
    this.rollGain.connect(this.master);
    this.rollSource.start();

    if (ctx.state === 'suspended') await ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
    }
  }

  /** Continuously shapes the rolling bed. `grip` is 0 on ice, 1 on stone. */
  setRolling(speed: number, grounded: boolean, grip: number): void {
    if (!this.ctx || !this.rollGain || !this.rollFilter) return;
    const t = this.ctx.currentTime;

    const norm = Math.min(speed / 18, 1);
    const target = grounded ? Math.min(0.03 + norm * 0.34, 0.4) * (0.35 + grip * 0.65) : 0;

    this.rollGain.gain.setTargetAtTime(target, t, 0.06);
    this.rollFilter.frequency.setTargetAtTime(160 + norm * 950, t, 0.06);
  }

  /** A struck-object transient: noise burst through a resonant filter. */
  impact(strength: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || strength <= 0) return;

    const t = ctx.currentTime;
    const amp = Math.min(strength / 14, 1);
    if (amp < 0.04) return;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(120 + amp * 180, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.12);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(amp * 0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.18);
  }

  /** A pitched blip. The building block for every UI/event sound below. */
  private tone(
    freq: number, duration: number, type: OscillatorType = 'square',
    volume = 0.25, sweepTo?: number, delay = 0,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    osc.connect(gain);
    gain.connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  jump(): void { this.tone(420, 0.14, 'square', 0.16, 780); }
  boost(): void { this.tone(200, 0.34, 'sawtooth', 0.22, 1100); }
  bumper(): void { this.tone(880, 0.16, 'square', 0.2, 1400); }

  checkpoint(): void {
    this.tone(660, 0.12, 'square', 0.2);
    this.tone(990, 0.2, 'square', 0.2, undefined, 0.1);
  }

  goal(): void {
    // Major arpeggio, then the octave.
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      this.tone(f, 0.28, 'square', 0.22, undefined, i * 0.09);
    });
  }

  death(): void {
    this.tone(340, 0.5, 'sawtooth', 0.24, 60);
    this.tone(170, 0.55, 'square', 0.14, 40);
  }

  countdown(): void { this.tone(880, 0.08, 'square', 0.16); }

  dispose(): void {
    this.rollSource?.stop();
    this.ctx?.close();
    this.ctx = null;
  }
}
