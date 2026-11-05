'use strict';

// Dependency-free transaction signing for the load-test tools: secp256k1 ECDSA with
// RFC 6979 nonces and low-s, RLP, and legacy (EIP-155) / EIP-1559 transactions.
// Only for tools/ — never loaded by the site. Verified against published vectors in
// tests/load-test.test.cjs and end to end against a local EVM node.
const crypto = require('node:crypto');
const { keccak256 } = require('./keccak.cjs');

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m = P) {
  let [x, y, r0, r1] = [1n, 0n, mod(a, m), m];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [x, y] = [y, x - q * y]; }
  return mod(x, m);
}
// Jacobian coordinates; null is the point at infinity.
function double(pt) {
  if (!pt) return null;
  const [X, Y, Z] = pt;
  if (Y === 0n) return null;
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X), X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * Y ** 4n), mod(2n * Y * Z)];
}
function add(p1, p2) {
  if (!p1) return p2; if (!p2) return p1;
  const [X1, Y1, Z1] = p1, [X2, Y2, Z2] = p2;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1), S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? double(p1) : null;
  const H = mod(U2 - U1), R = mod(S2 - S1), H2 = mod(H * H), H3 = mod(H * H2);
  const X3 = mod(R * R - H3 - 2n * U1 * H2);
  return [X3, mod(R * (U1 * H2 - X3) - S1 * H3), mod(H * Z1 * Z2)];
}
function multiply(k, point = G) {
  let result = null, addend = [point[0], point[1], 1n];
  for (let n = k; n > 0n; n >>= 1n) { if (n & 1n) result = add(result, addend); addend = double(addend); }
  if (!result) return null;
  const zi = inv(result[2]), zi2 = mod(zi * zi);
  return [mod(result[0] * zi2), mod(result[1] * zi2 * zi)];
}
const toBytes32 = value => Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
const fromBytes = bytes => BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
function hexToBuffer(value) {
  const text = String(value || '').replace(/^0x/, '');
  return Buffer.from(text.length % 2 ? '0' + text : text, 'hex');
}

function privateKeyOf(value) {
  const key = typeof value === 'bigint' ? value : fromBytes(hexToBuffer(value));
  if (key <= 0n || key >= N) throw new Error('INVALID_PRIVATE_KEY');
  return key;
}
function addressOf(privateKey) {
  const [x, y] = multiply(privateKeyOf(privateKey));
  return '0x' + keccak256(Buffer.concat([toBytes32(x), toBytes32(y)])).slice(-40);
}
function randomPrivateKey() {
  for (;;) {
    const key = fromBytes(crypto.randomBytes(32));
    if (key > 0n && key < N) return '0x' + key.toString(16).padStart(64, '0');
  }
}

// RFC 6979 deterministic k (HMAC-SHA256), then low-s as Ethereum requires.
function sign(hashHex, privateKey) {
  const d = privateKeyOf(privateKey), hash = hexToBuffer(hashHex);
  const z = mod(fromBytes(hash), N);
  const x = toBytes32(d), h1 = toBytes32(z);
  const hmac = (key, ...parts) => crypto.createHmac('sha256', key).update(Buffer.concat(parts)).digest();
  let V = Buffer.alloc(32, 1), K = Buffer.alloc(32, 0);
  K = hmac(K, V, Buffer.from([0]), x, h1); V = hmac(K, V);
  K = hmac(K, V, Buffer.from([1]), x, h1); V = hmac(K, V);
  for (;;) {
    V = hmac(K, V);
    const k = fromBytes(V);
    if (k > 0n && k < N) {
      const R = multiply(k), r = mod(R[0], N);
      if (r !== 0n) {
        let s = mod(inv(k, N) * (z + r * d), N), recovery = Number(R[1] & 1n) | (R[0] >= N ? 2 : 0);
        if (s > N / 2n) { s = N - s; recovery ^= 1; }
        if (s !== 0n) return { r, s, recovery };
      }
    }
    K = hmac(K, V, Buffer.from([0])); V = hmac(K, V);
  }
}

// RLP: items are Buffers, bigints/numbers (minimal big-endian, 0 -> empty), hex strings, or arrays.
function rlp(item) {
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlp));
    return Buffer.concat([lengthPrefix(body.length, 0xc0), body]);
  }
  let bytes;
  if (Buffer.isBuffer(item)) bytes = item;
  else if (typeof item === 'bigint' || typeof item === 'number') {
    const value = BigInt(item);
    bytes = value === 0n ? Buffer.alloc(0) : hexToBuffer(value.toString(16));
  } else bytes = hexToBuffer(item);
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return Buffer.concat([lengthPrefix(bytes.length, 0x80), bytes]);
}
function lengthPrefix(length, offset) {
  if (length < 56) return Buffer.from([offset + length]);
  const encoded = hexToBuffer(length.toString(16));
  return Buffer.concat([Buffer.from([offset + 55 + encoded.length]), encoded]);
}

// EIP-155 legacy transaction (used here only to check the signer against the EIP's vector).
function signLegacy({ chainId, nonce, gasPrice, gas, to, value = 0n, data = '0x' }, privateKey) {
  const fields = [BigInt(nonce), BigInt(gasPrice), BigInt(gas), hexToBuffer(to), BigInt(value), hexToBuffer(data)];
  const { r, s, recovery } = sign(keccak256(rlp([...fields, BigInt(chainId), 0n, 0n])), privateKey);
  return '0x' + rlp([...fields, BigInt(chainId) * 2n + 35n + BigInt(recovery & 1), r, s]).toString('hex');
}
// EIP-1559 (type 2) transaction, the format MetaMask sends for the site's transfers.
function sign1559({ chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value = 0n, data = '0x' }, privateKey) {
  const fields = [BigInt(chainId), BigInt(nonce), BigInt(maxPriorityFeePerGas), BigInt(maxFeePerGas), BigInt(gas), to ? hexToBuffer(to) : Buffer.alloc(0), BigInt(value), hexToBuffer(data), []];
  const { r, s, recovery } = sign(keccak256(Buffer.concat([Buffer.from([2]), rlp(fields)])), privateKey);
  const raw = Buffer.concat([Buffer.from([2]), rlp([...fields, BigInt(recovery & 1), r, s])]);
  return { raw:'0x' + raw.toString('hex'), hash:keccak256(raw) };
}

module.exports = { addressOf, randomPrivateKey, sign, rlp, signLegacy, sign1559 };
