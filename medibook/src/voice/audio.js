// PCM helpers for telephone audio: 16-bit signed little-endian mono ("slin"), 8 kHz on the phone line.

export const PHONE_RATE = 8000;
export const BYTES_PER_MS = (PHONE_RATE * 2) / 1000; // 16 bytes per ms at 8 kHz

export function rms(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Linear-interpolation resampler for 16-bit mono PCM. Good enough for speech. */
export function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const inLen = Math.floor(pcm.length / 2);
  const outLen = Math.floor((inLen * toRate) / fromRate);
  const out = Buffer.alloc(outLen * 2);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = pos - i0;
    const s = pcm.readInt16LE(i0 * 2) * (1 - frac) + pcm.readInt16LE(i1 * 2) * frac;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

export function encodeWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Parse a PCM WAV file. Returns { pcm, sampleRate, channels }. Mixes stereo down to mono. */
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    let size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt chunk');
      if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('Only 16-bit PCM WAV is supported');
      // Streaming encoders sometimes write 0 or 0xFFFFFFFF as the data size.
      if (size === 0 || body + size > buf.length) size = buf.length - body;
      let pcm = buf.subarray(body, body + size - (size % (2 * fmt.channels)));
      if (fmt.channels === 2) {
        const mono = Buffer.alloc(pcm.length / 2);
        for (let i = 0; i < mono.length / 2; i++) {
          mono.writeInt16LE((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1, i * 2);
        }
        pcm = mono;
      }
      return { pcm: Buffer.from(pcm), sampleRate: fmt.sampleRate, channels: 1 };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

export function chunks(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(i + size, buf.length)));
  return out;
}
