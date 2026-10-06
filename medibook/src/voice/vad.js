import { BYTES_PER_MS, rms } from './audio.js';

// Energy-based voice activity detector for 8 kHz phone audio.
// Tracks the background noise level and cuts the stream into utterances:
// speech starts after a short run of loud frames and ends after a pause.

const FRAME_MS = 20;
const FRAME_BYTES = FRAME_MS * BYTES_PER_MS;

export class Vad {
  constructor({
    onSpeechStart = () => {},
    onUtterance = () => {},
    minThreshold = 400, // RMS on the int16 scale; quiet line noise is usually < 150
    noiseMultiplier = 3,
    startMs = 100, // loud audio needed to count as speech
    bargeInStartMs = 240, // stricter while the assistant is talking
    endSilenceMs = 750, // pause that ends an utterance
    preRollMs = 300, // audio kept from just before speech started
    maxUtteranceMs = 15000,
    minUtteranceMs = 250,
  } = {}) {
    Object.assign(this, {
      onSpeechStart, onUtterance, minThreshold, noiseMultiplier, startMs, bargeInStartMs,
      endSilenceMs, preRollMs, maxUtteranceMs, minUtteranceMs,
    });
    this.noise = 150;
    this.pending = Buffer.alloc(0);
    this.preRoll = [];
    this.speaking = false;
    this.loudMs = 0;
    this.silentMs = 0;
    this.utterance = [];
    this.utteranceMs = 0;
    this.assistantTalking = false; // set by the call while the assistant's audio is playing
  }

  get threshold() {
    return Math.max(this.minThreshold, this.noise * this.noiseMultiplier) * (this.assistantTalking ? 1.5 : 1);
  }

  push(pcm) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    while (this.pending.length >= FRAME_BYTES) {
      const frame = this.pending.subarray(0, FRAME_BYTES);
      this.pending = this.pending.subarray(FRAME_BYTES);
      this.#frame(Buffer.from(frame));
    }
  }

  #frame(frame) {
    const level = rms(frame);
    const loud = level > this.threshold;

    if (!this.speaking) {
      if (!loud) this.noise = this.noise * 0.95 + level * 0.05;
      this.preRoll.push(frame);
      if (this.preRoll.length > this.preRollMs / FRAME_MS) this.preRoll.shift();
      this.loudMs = loud ? this.loudMs + FRAME_MS : 0;
      const needed = this.assistantTalking ? this.bargeInStartMs : this.startMs;
      if (this.loudMs >= needed) {
        this.speaking = true;
        this.silentMs = 0;
        this.utterance = [...this.preRoll];
        this.utteranceMs = this.utterance.length * FRAME_MS;
        this.preRoll = [];
        this.onSpeechStart();
      }
      return;
    }

    this.utterance.push(frame);
    this.utteranceMs += FRAME_MS;
    this.silentMs = loud ? 0 : this.silentMs + FRAME_MS;
    if (this.silentMs >= this.endSilenceMs || this.utteranceMs >= this.maxUtteranceMs) this.#finish();
  }

  #finish() {
    const audio = Buffer.concat(this.utterance);
    const speechMs = this.utteranceMs - this.silentMs;
    this.speaking = false;
    this.loudMs = 0;
    this.silentMs = 0;
    this.utterance = [];
    this.utteranceMs = 0;
    if (speechMs >= this.minUtteranceMs) this.onUtterance(audio);
  }
}
