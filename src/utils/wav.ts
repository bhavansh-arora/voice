export interface DecodedWav {
  sampleRate: number;
  /** Always mono - stereo input is downmixed. */
  samples: Int16Array;
}

/** Parses a canonical PCM16 WAV buffer (as written by Python's `wave` module). */
export function parseWav(buffer: Buffer): DecodedWav {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a valid WAV file");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === "fmt ") {
      channels = buffer.readUInt16LE(bodyStart + 2);
      sampleRate = buffer.readUInt32LE(bodyStart + 4);
      bitsPerSample = buffer.readUInt16LE(bodyStart + 14);
    } else if (chunkId === "data") {
      dataStart = bodyStart;
      // Some encoders (e.g. OpenAI's TTS API, which can generate the
      // response via internal streaming) write a placeholder/max size here
      // (seen as 0xFFFFFFFF) rather than the real byte count, since the
      // final length isn't known when the header is written. Clamp to
      // what's actually in the buffer instead of trusting this field
      // blindly -- otherwise this can try to allocate a multi-GB
      // Int16Array below and crash with "Array buffer allocation failed".
      dataLength = Math.min(chunkSize, buffer.length - bodyStart);
    }

    // Chunks are word-aligned - an odd-sized chunk has a padding byte after it.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (dataStart === -1 || sampleRate === 0) {
    throw new Error("Malformed WAV: missing fmt or data chunk");
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample} (expected 16)`);
  }

  const totalSamples = Math.floor(dataLength / 2);
  const raw = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    raw[i] = buffer.readInt16LE(dataStart + i * 2);
  }

  if (channels === 1) {
    return { sampleRate, samples: raw };
  }

  const frames = Math.floor(totalSamples / channels);
  const mono = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += raw[f * channels + c];
    mono[f] = Math.round(sum / channels);
  }
  return { sampleRate, samples: mono };
}

/** Builds a canonical mono PCM16 WAV buffer - the inverse of `parseWav`. */
export function encodeWavPcm16Mono(samples: Int16Array, sampleRate: number): Buffer {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }
  return buffer;
}
