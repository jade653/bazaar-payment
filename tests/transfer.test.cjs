'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Transfer = require('../transfer-core.js');
const UI = require('../payment-ui.js');
const account = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
const balance = '0x' + (100n * 10n ** 18n).toString(16);
const details = { account, recipient, value:'5000', chainId:'0x1db1' };
const provider = { request:async ({ method }) => ({ eth_accounts:[account], eth_chainId:'0x1db1', eth_getBalance:balance })[method] };

test('one recipient parser accepts wallet/URI/service QR formats and rejects foreign destinations', () => {
  for (const value of [recipient, `ethereum:${recipient}@7601`, `https://bazaar.mustree.kr/pay/${recipient}`, `https://bazaar.mustree.kr/pay/${recipient}/5000`, `https://bazaar.mustree.kr/pay.html?to=${recipient}`]) assert.equal(Transfer.parseRecipient(value), recipient);
  for (const value of [`https://other.test/pay/${recipient}`, 'javascript:alert(1)', `ethereum:${recipient}@1`, `pay this ${recipient}`]) assert.equal(Transfer.parseRecipient(value), null);
});
test('receiving QR links preserve an optional store name', () => {
  assert.equal(Transfer.paymentLink(account), 'https://bazaar.mustree.kr/pay/' + account);
  assert.equal(Transfer.paymentLink(account, '사랑 분식'), 'https://bazaar.mustree.kr/pay/' + account + '?name=%EC%82%AC%EB%9E%91+%EB%B6%84%EC%8B%9D');
});
test('payment amounts have exact won conversion without a top-up bonus', () => {
  assert.deepEqual(Transfer.parseAmount('5,000원'), { won:5000n, wei:5n * 10n ** 18n });
  assert.equal(Transfer.parseAmount('500').wei, 5n * 10n ** 17n);
  for (const value of ['0','-1','1.5','10000001']) assert.throws(() => Transfer.parseAmount(value), { code:'INVALID_AMOUNT' });
});
test('top-up retains 1,000 won increments and the 10% bonus', () => {
  assert.deepEqual(Transfer.parseAmount('20,000원', 'topup'), { won:20000n, wei:22n * 10n ** 18n });
  for (const value of ['0','1500']) assert.throws(() => Transfer.parseAmount(value, 'topup'), { code:'INVALID_AMOUNT' });
});
test('direct transfers retain exact MST values and at most three decimals', () => {
  assert.equal(Transfer.parseAmount('12.345', 'transfer').wei, 12345n * 10n ** 15n);
  assert.equal(Transfer.parseAmount('1.000', 'transfer').wei, 10n ** 18n);
  for (const value of ['0','1.0001']) assert.throws(() => Transfer.parseAmount(value, 'transfer'), { code:'INVALID_AMOUNT' });
});
for (const [kind, value, expected] of [['payment','5000','0x4563918244f40000'], ['topup','5000','0x4c53ecdc1ba0f080'], ['transfer','12.345','0xab524017e8328000']]) {
  test(`${kind} builds the exact native transaction through the common engine`, async () => {
    const result = await Transfer.prepare(provider, { ...details, kind, value });
    assert.deepEqual(result.transaction, { from:account, to:recipient, value:expected });
  });
}
test('top-up sends only the missing recipient gas reserve', async () => {
  for (const [recipientBalance, expected] of [[0n,50000000n], [20000000n,30000000n], [50000000n,0n], [500000000000000000n,0n]]) {
    const wallet = { request:async request => request.method === 'eth_getBalance' && request.params[0] === recipient ? '0x' + recipientBalance.toString(16) : provider.request(request) };
    const result = await Transfer.prepare(wallet, { ...details, kind:'topup' });
    assert.equal(result.gasTopUpWei, expected);
  }
});
test('preflight blocks changed accounts, wrong networks and insufficient funds', async () => {
  for (const [method, result, code] of [['eth_accounts',[recipient],'ACCOUNT_CHANGED'], ['eth_chainId','0x1','WRONG_CHAIN'], ['eth_getBalance','0x0','INSUFFICIENT_BALANCE']]) {
    const wallet = { request:async request => request.method === method ? result : provider.request(request) };
    await assert.rejects(Transfer.prepare(wallet, details), { code });
  }
});
test('preflight revalidates both account and network after a delayed balance read', async () => {
  for (const code of ['ACCOUNT_CHANGED','WRONG_CHAIN']) {
    let changed = false;
    const wallet = { request:async request => {
      if (request.method === 'eth_getBalance') { changed = true; return balance; }
      if (changed && request.method === 'eth_accounts' && code === 'ACCOUNT_CHANGED') return [recipient];
      if (changed && request.method === 'eth_chainId' && code === 'WRONG_CHAIN') return '0x1';
      return provider.request(request);
    } };
    await assert.rejects(Transfer.prepare(wallet, details), { code });
  }
});
test('RPC balance fallback retains every amount policy and rejects malformed balances', async () => {
  const wallet = { request:async request => { if (request.method === 'eth_getBalance') throw new Error('provider unavailable'); return provider.request(request); } };
  for (const kind of ['payment','topup','transfer']) {
    const result = await Transfer.prepare(wallet, { ...details, kind, value:kind === 'transfer' ? '5' : '5000', readBalanceFromRpc:async () => balance });
    assert.ok(result.amount.wei > 0n);
  }
  await assert.rejects(Transfer.prepare(wallet, { ...details, readBalanceFromRpc:async () => 'invalid' }), { code:'INVALID_BALANCE' });
});
test('repeated sends share one request and unknown transactions stay locked until resolved', async () => {
  let sends = 0, confirmed = false;
  const wallet = { request:async request => {
    if (request.method === 'eth_sendTransaction') { sends++; return hash; }
    if (request.method === 'eth_getTransactionReceipt') return confirmed ? { status:'0x1' } : null;
    return provider.request(request);
  } };
  const sender = Transfer.createSender({ provider:wallet, chainId:'0x1db1', maxPolls:1 });
  const first = sender.send(details), second = sender.send(details);
  assert.equal(first, second);
  await assert.rejects(first, { code:'RECEIPT_TIMEOUT' });
  await assert.rejects(sender.send(details), { code:'PENDING_TRANSACTION' });
  assert.equal(sends, 1);
  confirmed = true;
  await sender.check(hash); await sender.send(details);
  assert.equal(sends, 2);
});
test('receipt polling distinguishes success, revert, timeout and invalid hashes', async () => {
  let calls = 0;
  assert.equal((await Transfer.waitForReceipt({ request:async () => ++calls === 1 ? null : { status:'0x1' } }, hash, { wait:async () => {} })).status, '0x1');
  await assert.rejects(Transfer.waitForReceipt({ request:async () => ({ status:'0x0' }) }, hash), { code:'TRANSACTION_FAILED' });
  await assert.rejects(Transfer.waitForReceipt({ request:async () => null }, hash, { attempts:1 }), { code:'RECEIPT_TIMEOUT' });
  await assert.rejects(Transfer.waitForReceipt(provider, 'invalid'), { code:'INVALID_TX_HASH' });
});
test('balance displays share rounding while preserving large integer precision', () => {
  assert.equal(UI.mst('1999999999995506000'), '2 MST');
  assert.equal(UI.mst('50000000'), '0 MST');
  assert.equal(UI.mst(9007199254740993n * 10n ** 18n), '9,007,199,254,740,993 MST');
});
