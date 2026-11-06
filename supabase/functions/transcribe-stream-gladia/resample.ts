// Streaming PCM down-sampler for the Gladia live relay.
//
// Gladia's live API now only accepts 8 kHz or 16 kHz (it answered every
// 48 kHz session with "sample_rate must be one of the following values: 8000,
// 16000" from 6 Nov 2026 on, and the relay closed every few seconds — no live
// caption for a whole call). The extension pins its audio graph to 48 kHz, so
// the relay converts here: the fix reaches every installed extension at once,
// with no reinstall.
//
// Input/output: interleaved signed 16-bit little-endian PCM (the extension's
// linear16 frames), any channel count. State carries across frames so frame
// boundaries are seamless.
//
// Integer ratios (48k→16k, 32k→16k, 96k→16k): a short windowed-sinc low-pass
// evaluated ONLY at the output positions (cheap — the edge runtime has a CPU
// budget per connection). Other ratios (44.1k): linear interpolation.

export const GLADIA_LIVE_RATES = [8000, 16000];

/** The rate to open the Gladia session at for a given input rate. */
export function targetRate(inRate: number): number {
  return GLADIA_LIVE_RATES.includes(inRate) ? inRate : 16000;
}

export class PcmDownsampler {
  readonly inRate: number;
  readonly outRate: number;
  readonly channels: number;
  private readonly factor: number;      // integer decimation factor, or 0
  private readonly taps: Float32Array;  // FIR, DC gain 1
  private hist: Float32Array[];         // last taps-1 input samples per channel
  private phase = 0;                    // next output index, relative to the next block
  private pos = 0;                      // linear path: fractional input position
  private last: Float32Array;           // linear path: previous block's last sample
  private work = new Float32Array(0);   // reused per-channel scratch (no per-frame garbage)

  constructor(inRate: number, outRate: number, channels: number) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.channels = Math.max(1, channels | 0);
    const ratio = inRate / outRate;
    this.factor = Number.isInteger(ratio) && ratio >= 1 ? ratio : 0;
    this.taps = this.factor > 1 ? lowpass(4 * this.factor + 1, (0.45 * outRate) / inRate) : new Float32Array([1]);
    this.hist = Array.from({ length: this.channels }, () => new Float32Array(this.taps.length - 1));
    this.last = new Float32Array(this.channels);
  }

  /** Converts one frame. Returns the resampled frame (may be empty). */
  process(buf: ArrayBuffer): ArrayBuffer {
    const usable = buf.byteLength - (buf.byteLength % (2 * this.channels));
    if (usable <= 0) return new ArrayBuffer(0);
    const input = new Int16Array(buf, 0, usable / 2);
    if (this.inRate === this.outRate) return input.slice().buffer;
    return this.factor ? this.decimate(input) : this.interpolate(input);
  }

  private decimate(input: Int16Array): ArrayBuffer {
    const C = this.channels;
    const n = input.length / C;
    const H = this.taps.length - 1;
    const D = this.factor;
    const h = this.taps;
    const total = H + n;
    const first = H + this.phase;
    const count = first < total ? Math.floor((total - 1 - first) / D) + 1 : 0;
    const out = new Int16Array(count * C);

    for (let c = 0; c < C; c++) {
      // x = history ++ this block (float), per channel.
      if (this.work.length < total) this.work = new Float32Array(total);
      const x = this.work;
      x.set(this.hist[c], 0);
      for (let i = 0; i < n; i++) x[H + i] = input[i * C + c];
      let o = 0;
      for (let i = first; i < total; i += D) {
        let acc = 0;
        for (let k = 0; k <= H; k++) acc += h[k] * x[i - k];
        out[o * C + c] = clamp16(acc);
        o++;
      }
      this.hist[c].set(x.subarray(total - H, total));
    }
    const next = first + count * D;  // first output index not yet produced
    this.phase = next - total;       // relative to the next block (0 ≤ phase < D)
    return out.buffer;
  }

  private interpolate(input: Int16Array): ArrayBuffer {
    const C = this.channels;
    const n = input.length / C;
    const step = this.inRate / this.outRate;
    // Positions are in "block" coordinates where index -1 is the previous
    // block's last sample and 0..n-1 are this block's samples.
    const outFrames: number[] = [];
    let p = this.pos;
    while (p <= n - 1) { outFrames.push(p); p += step; }
    const out = new Int16Array(outFrames.length * C);
    for (let o = 0; o < outFrames.length; o++) {
      const t = outFrames[o];
      const i0 = Math.floor(t);
      const frac = t - i0;
      for (let c = 0; c < C; c++) {
        const a = i0 < 0 ? this.last[c] : input[i0 * C + c];
        const b = i0 + 1 <= n - 1 ? input[(i0 + 1) * C + c] : a;
        out[o * C + c] = clamp16(a + (b - a) * frac);
      }
    }
    for (let c = 0; c < C; c++) this.last[c] = input[(n - 1) * C + c];
    this.pos = p - n; // next position relative to the next block
    return out.buffer;
  }
}

/** Hamming-windowed sinc low-pass, `n` taps, cutoff in cycles/sample. */
function lowpass(n: number, cutoff: number): Float32Array {
  const h = new Float32Array(n);
  const m = (n - 1) / 2;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = i - m;
    const sinc = t === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * t) / (Math.PI * t);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}

function clamp16(v: number): number {
  const r = Math.round(v);
  return r > 32767 ? 32767 : r < -32768 ? -32768 : r;
}
