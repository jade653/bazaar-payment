'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Signer = require('../tools/eth-signer.cjs');
const Rpc = require('../tools/load-test-rpc.cjs');
const Tx = require('../tools/load-test-tx.cjs');
const { keccak256 } = require('../tools/keccak.cjs');

test('the load-test signer derives addresses and signs EIP-155 transactions exactly as the published vectors', () => {
  assert.equal(Signer.addressOf('0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'), '0x2c7536e3605d9c16a7a3d7b1898e529396a65c23');
  // EIP-155 example transaction (chain 1, nonce 9, 20 gwei, 21000 gas, 1 ether to 0x3535…).
  const raw = Signer.signLegacy({ chainId:1, nonce:9, gasPrice:20000000000n, gas:21000, to:'0x' + '35'.repeat(20), value:10n ** 18n }, '0x' + '46'.repeat(32));
  assert.equal(raw, '0xf86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83');
});

test('RLP encodes the canonical examples and EIP-1559 transactions are typed, low-s and hashed over the envelope', () => {
  assert.equal(Signer.rlp(Buffer.from('dog')).toString('hex'), '83646f67');
  assert.equal(Signer.rlp([Buffer.from('cat'), Buffer.from('dog')]).toString('hex'), 'c88363617483646f67');
  assert.equal(Signer.rlp(0n).toString('hex'), '80');
  assert.equal(Signer.rlp(1024).toString('hex'), '820400');
  assert.equal(Signer.rlp(Buffer.from('Lorem ipsum dolor sit amet, consectetur adipisicing elit')).toString('hex').slice(0, 4), 'b838');
  const signed = Signer.sign1559({ chainId:7601, nonce:0, maxPriorityFeePerGas:100, maxFeePerGas:1000, gas:65000, to:'0x' + '11'.repeat(20), data:'0xa9059cbb' }, '0x' + '46'.repeat(32));
  assert.match(signed.raw, /^0x02/);
  assert.equal(signed.hash, keccak256(signed.raw));
  const { s } = Signer.sign(keccak256('abc'), '0x' + '46'.repeat(32));
  assert.ok(s <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n);
  assert.notEqual(Signer.randomPrivateKey(), Signer.randomPrivateKey());
});

test('the read-load report keeps the last stage within thresholds and converts it to open pages', () => {
  assert.equal(Rpc.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], .95), 10);
  assert.equal(Rpc.percentile([1, 2, 3, 4], .5), 2);
  const stage = (rps, p95Ms, errorRate = 0) => ({ achievedRps:rps, p95Ms, errorRate });
  const limits = { maxP95Ms:2000, maxErrorRate:.01 };
  assert.equal(Rpc.sustainable([stage(10, 100), stage(50, 400), stage(100, 2500), stage(200, 300)], limits).achievedRps, 50);
  assert.equal(Rpc.sustainable([stage(10, 100, .05)], limits), null);
  const capacity = Rpc.capacity(100, { stores:30, dashboards:2, paymentsPerMinute:60 });
  assert.equal(capacity.onlyCustomers, Math.floor(6000 / Rpc.USER_MODEL.customer.perMinute));
  assert.equal(capacity.onlyStores, Math.floor(6000 / Rpc.USER_MODEL.store.perMinute));
  const fixed = 30 * Rpc.USER_MODEL.store.perMinute + 2 * Rpc.USER_MODEL.dashboard.perMinute + 60 * Rpc.USER_MODEL.payment.perEvent;
  assert.equal(capacity.mixed.customersWithAppOpen, Math.floor((6000 - fixed) / Rpc.USER_MODEL.customer.perMinute));
  assert.equal(Rpc.capacity(0), null);
});

test('load tests refuse remote targets without --yes and size enough wallets for the top rate', () => {
  assert.equal(Rpc.isLocal('http://127.0.0.1:8545'), true);
  assert.equal(Rpc.isLocal('http://localhost:8545'), true);
  assert.equal(Rpc.isLocal('https://block.mustree.kr'), false);
  assert.equal(Rpc.parseArgs([]).yes, false);
  assert.deepEqual(Rpc.parseArgs(['--rates', '5,10']).rates, [5, 10]);
  assert.throws(() => Rpc.parseArgs(['--bogus']), /Unknown option/);
  assert.equal(Tx.parseArgs(['--rates', '1,20']).wallets, 120);
  assert.equal(Tx.parseArgs(['--rates', '1']).wallets, 10);
  const passed = { submitted:100, included:100, inclusionP95Ms:4000 };
  assert.equal(Tx.stagePassed(passed, { maxP95Ms:10000, minIncluded:.99 }), true);
  assert.equal(Tx.stagePassed({ ...passed, included:90 }, { maxP95Ms:10000, minIncluded:.99 }), false);
  assert.equal(Tx.stagePassed({ ...passed, inclusionP95Ms:12000 }, { maxP95Ms:10000, minIncluded:.99 }), false);
});
