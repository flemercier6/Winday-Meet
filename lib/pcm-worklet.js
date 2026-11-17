// AudioWorklet: taps the merged stereo bus (channel 0 = you/mic, channel 1 =
// the meeting) — or, in person, the mono room bus — and emits (interleaved)
// 16-bit PCM (linear16) frames of ~40ms,
// which the recorder streams to Deepgram's live API. Registered as
// "pcm-extractor". Runs off the main thread so it never stalls the UI.
class PCMExtractor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._acc = []; // interleaved Int16 samples awaiting a post
    this._frame = 2048; // samples PER CHANNEL per post (~43ms @ 48kHz)
    // 2 for a call (you | the meeting); 1 for an in-person meeting, whose
    // single room microphone is streamed as it is.
    const ch = options && options.processorOptions && options.processorOptions.channels;
    this._channels = ch === 1 ? 1 : 2;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const l = input[0];
    const n = l ? l.length : 0;
    if (this._channels === 1) {
      for (let i = 0; i < n; i++) this._acc.push(toInt16(l[i]));
    } else {
      const r = input[1] || input[0]; // mono source -> duplicate into both channels
      for (let i = 0; i < n; i++) {
        this._acc.push(toInt16(l[i]), toInt16(r[i]));
      }
    }
    if (this._acc.length >= this._frame * this._channels) {
      const out = new Int16Array(this._acc);
      this._acc.length = 0;
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}

function toInt16(x) {
  const s = x < -1 ? -1 : x > 1 ? 1 : x;
  return s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
}

registerProcessor("pcm-extractor", PCMExtractor);
