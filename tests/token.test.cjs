'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { keccak256 } = require('../tools/keccak.cjs');
const { TOKEN } = require('../wallet.js');
const Transfer = require('../transfer-core.js');
const artifact = require('../contracts/wMST.artifact.json');
const root = path.join(__dirname, '..');

test('keccak-256 matches the reference vectors used for selectors and topics', () => {
  assert.equal(keccak256(''), '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256('abc'), '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(keccak256('The quick brown fox jumps over the lazy dog'), '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15');
  assert.equal(keccak256('0x' + 'ff'.repeat(200)).length, 66);
});
test('the committed artifact matches the contract source, targets Paris and exposes the expected interface', () => {
  const source = fs.readFileSync(path.join(root, 'contracts/wMST.sol'), 'utf8');
  assert.equal(artifact.sourceSha256, crypto.createHash('sha256').update(source).digest('hex'), 'run node tools/compile-wmst.cjs after editing the contract');
  assert.equal(artifact.compiler.evmVersion, 'paris', 'chain 7601 rejects PUSH0');
  assert.match(artifact.bytecode, /^0x[0-9a-f]+$/);
  assert.match(artifact.deployedBytecode, /^0x[0-9a-f]+$/);
  const names = artifact.abi.filter(item => item.type === 'function').map(item => item.name).sort();
  assert.deepEqual(names, ['allowance','approve','balanceOf','decimals','name','symbol','totalSupply','transfer','transferFrom','transferWithGas']);
  assert.equal(artifact.abi.find(item => item.name === 'transferWithGas').stateMutability, 'payable');
  assert.deepEqual(artifact.abi.find(item => item.type === 'constructor').inputs.map(input => input.type), ['uint256']);
  assert.ok(!artifact.abi.some(item => ['mint','burn','owner','pause'].includes(item.name)), 'fixed supply, no admin surface');
  const browser = fs.readFileSync(path.join(root, 'wmst-artifact.js'), 'utf8');
  assert.ok(browser.includes(artifact.bytecode), 'wmst-artifact.js must carry the same bytecode');
});
test('token configuration selectors and topic match the compiled contract', () => {
  for (const [name, selector] of [['transfer(address,uint256)', TOKEN.selectors.transfer], ['transferWithGas(address,uint256)', TOKEN.selectors.transferWithGas], ['balanceOf(address)', TOKEN.selectors.balanceOf], ['totalSupply()', TOKEN.selectors.totalSupply]]) {
    assert.equal(selector, '0x' + artifact.methodIdentifiers[name]);
    assert.equal(selector, keccak256(name).slice(0, 10));
  }
  assert.equal(TOKEN.transferTopic, keccak256('Transfer(address,address,uint256)'));
  assert.equal(TOKEN.decimals, 0);
  assert.equal(TOKEN.symbol, 'wMST');
  assert.equal(TOKEN.gasPolicy.transfersPerTopUp, 20);
  for (const key of ['maxFeePerGasWei','maxPriorityFeePerGasWei','transferReserveWei','topUpReserveWei']) assert.match(TOKEN.gasPolicy[key], /^\d+$/);
  assert.ok(BigInt(TOKEN.gasPolicy.maxFeePerGasWei) >= 107n, 'max fee must cover the chain gas price of 107 wei');
});
test('ABI helpers encode calls and decode balances exactly', () => {
  const to = '0x' + 'AB'.repeat(20);
  const token = { ...TOKEN, address:'0x' + 'c'.repeat(40) };
  assert.equal(Transfer.abi.transfer(token, to, 5000n), '0xa9059cbb' + 'ab'.repeat(20).padStart(64, '0') + (5000).toString(16).padStart(64, '0'));
  assert.equal(Transfer.abi.transferWithGas(token, to, 1n).slice(0, 10), '0xf620de7c');
  assert.equal(Transfer.abi.balanceOf(token, to), '0x70a08231' + 'ab'.repeat(20).padStart(64, '0'));
  assert.equal(Transfer.abi.decodeUint('0x' + '1'.padStart(64, '0')), 1n);
  assert.throws(() => Transfer.abi.decodeUint('0x'), { code:'INVALID_BALANCE' });
  assert.equal(Transfer.abi.topicAddress('0x' + 'ab'.repeat(20).padStart(64, '0')), '0x' + 'ab'.repeat(20));
  assert.equal(Transfer.tokenReady(TOKEN), false, 'address is filled in only after deployment');
  assert.equal(Transfer.tokenReady(token), true);
});
