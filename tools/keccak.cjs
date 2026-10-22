'use strict';

// Dependency-free Keccak-256 (Ethereum variant, 0x01 padding) for tooling.
// Verified against the standard vectors in tests/token.test.cjs.
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
const ROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
const MASK = (1n << 64n) - 1n;
const rotl = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & MASK;

function keccakF(state) {
  for (let round = 0; round < 24; round++) {
    const c = [];
    for (let x = 0; x < 5; x++) c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    let current = state[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i], next = state[j];
      state[j] = rotl(current, ROT[i]); current = next;
    }
    for (let y = 0; y < 25; y += 5) {
      const row = state.slice(y, y + 5);
      for (let x = 0; x < 5; x++) state[y + x] = row[x] ^ (~row[(x + 1) % 5] & MASK & row[(x + 2) % 5]);
    }
    state[0] ^= RC[round];
  }
}

function keccak256(input) {
  const bytes = typeof input === 'string' ? (input.startsWith('0x') ? Buffer.from(input.slice(2), 'hex') : Buffer.from(input, 'utf8')) : Buffer.from(input);
  const rate = 136, state = new Array(25).fill(0n);
  const padded = Buffer.alloc(Math.ceil((bytes.length + 1) / rate) * rate);
  bytes.copy(padded); padded[bytes.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate / 8; i++) state[i] ^= padded.readBigUInt64LE(offset + i * 8);
    keccakF(state);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) out.writeBigUInt64LE(state[i], i * 8);
  return '0x' + out.toString('hex');
}
module.exports = { keccak256 };
