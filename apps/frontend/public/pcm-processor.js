/**
 * PCM AudioWorklet Processor
 * Captures raw audio from the microphone, converts Float32 → Int16,
 * calculates RMS for VAD barge-in detection, and posts chunks to the main thread.
 *
 * Served as a static file from /public so Next.js can load it via audioWorklet.addModule().
 */
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Accumulate samples into chunks of this size before posting (128 * 4 = 512 samples ≈ 32ms @ 16kHz)
    this._chunkSize = 512;
    this._accumulator = new Float32Array(this._chunkSize);
    this._accOffset = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const samples = input[0]; // Float32Array, 128 samples per call

    let i = 0;
    while (i < samples.length) {
      const remaining = this._chunkSize - this._accOffset;
      const toCopy = Math.min(remaining, samples.length - i);

      this._accumulator.set(samples.subarray(i, i + toCopy), this._accOffset);
      this._accOffset += toCopy;
      i += toCopy;

      if (this._accOffset >= this._chunkSize) {
        this._flush();
      }
    }

    return true;
  }

  _flush() {
    const chunk = this._accumulator.subarray(0, this._accOffset);

    // RMS for VAD / barge-in detection
    let sumSq = 0;
    for (let j = 0; j < chunk.length; j++) {
      sumSq += chunk[j] * chunk[j];
    }
    const rms = Math.sqrt(sumSq / chunk.length);

    // Convert Float32 → Int16
    const int16 = new Int16Array(chunk.length);
    for (let j = 0; j < chunk.length; j++) {
      const clamped = Math.max(-1, Math.min(1, chunk[j]));
      int16[j] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }

    // Transfer the underlying buffer (zero-copy)
    this.port.postMessage({ audio: int16.buffer, rms }, [int16.buffer]);

    this._accOffset = 0;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
