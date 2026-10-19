'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const Operator = require('../operator-core.js');

const account = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const hash = '0x' + 'a'.repeat(64);

test('accepts only a wallet address or an ethereum URI', () => {
  assert.equal(Operator.parseAddress(recipient), recipient);
  assert.equal(Operator.parseAddress(`ethereum:${recipient}@7601`), recipient);
  assert.equal(Operator.parseAddress(`pay this ${recipient}`), null);
  assert.equal(Operator.parseAddress('javascript:alert(1)'), null);
});

test('adds a 10% bonus and converts whole 1,000 won units to exact native MST wei', () => {
  const result = Operator.amountFromWon('20,000원');
  assert.equal(result.won, 20000n);
  assert.equal(result.baseMst, 20n);
  assert.equal(result.mstText, '22.0');
  assert.equal(result.wei, 22n * 10n ** 18n);
  assert.equal(result.valueHex, '0x1314fb37062980000');
  assert.throws(() => Operator.amountFromWon('1500'), { code: 'INVALID_AMOUNT' });
  assert.throws(() => Operator.amountFromWon('0'), { code: 'INVALID_AMOUNT' });
});

test('rechecks account, chain and balance before building a transaction', async () => {
  const provider = { request: async ({ method }) => ({
    eth_accounts: [account], eth_chainId: '0x1db1', eth_getBalance: '0x' + (100n * 10n ** 18n).toString(16)
  })[method] };
  const prepared = await Operator.prepareTransaction(provider, { account, recipient, won: 5000, chainId: '0x1db1' });
  assert.deepEqual(prepared.transaction, { from: account, to: recipient, value: '0x4c53ecdc18a60000' });
});

test('blocks a changed operator account and an insufficient balance', async () => {
  const changed = { request: async ({ method }) => ({ eth_accounts: [recipient], eth_chainId: '0x1db1', eth_getBalance: '0xffff' })[method] };
  await assert.rejects(Operator.prepareTransaction(changed, { account, recipient, won: 1000, chainId: '0x1db1' }), { code: 'ACCOUNT_CHANGED' });
  const poor = { request: async ({ method }) => ({ eth_accounts: [account], eth_chainId: '0x1db1', eth_getBalance: '0x0' })[method] };
  await assert.rejects(Operator.prepareTransaction(poor, { account, recipient, won: 1000, chainId: '0x1db1' }), { code: 'INSUFFICIENT_BALANCE' });
});

test('sends once on repeated taps and waits for a successful receipt', async () => {
  let sends = 0, receipts = 0;
  const provider = { request: async ({ method }) => {
    if (method === 'eth_accounts') return [account];
    if (method === 'eth_chainId') return '0x1db1';
    if (method === 'eth_getBalance') return '0x' + (100n * 10n ** 18n).toString(16);
    if (method === 'eth_sendTransaction') { sends++; return hash; }
    if (method === 'eth_getTransactionReceipt') return ++receipts === 1 ? null : { status: '0x1', transactionHash: hash };
  }};
  const sender = Operator.createSender({ provider, chainId: '0x1db1', pollInterval: 0, wait: async () => {} });
  const first = sender.send({ account, recipient, won: 5000 });
  const second = sender.send({ account, recipient, won: 5000 });
  assert.equal(first, second);
  const result = await first;
  assert.equal(sends, 1);
  assert.equal(result.hash, hash);
  assert.equal(result.receipt.status, '0x1');
});

test('reports a reverted transaction and receipt timeout without resending', async () => {
  const failedProvider = { request: async ({ method }) => method === 'eth_getTransactionReceipt' ? { status: '0x0' } : null };
  const failed = Operator.createSender({ provider: failedProvider, chainId: '0x1db1' });
  await assert.rejects(failed.waitForReceipt(hash), { code: 'TRANSACTION_FAILED' });
  const pendingProvider = { request: async () => null };
  const pending = Operator.createSender({ provider: pendingProvider, chainId: '0x1db1', maxPolls: 2, pollInterval: 0, wait: async () => {} });
  await assert.rejects(pending.waitForReceipt(hash), { code: 'RECEIPT_TIMEOUT' });
});
