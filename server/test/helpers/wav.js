import fs from 'node:fs';

// Build a minimal valid PCM WAV whose duration music-metadata can read, so the
// importer's duration-matching logic can be exercised with real audio files.
export function wavBuffer(seconds, sampleRate = 8000) {
  const numSamples = Math.round(seconds * sampleRate);
  const dataLen = numSamples * 2; // 16-bit mono
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  return buf;
}

export function writeWav(filePath, seconds) {
  fs.writeFileSync(filePath, wavBuffer(seconds));
}
