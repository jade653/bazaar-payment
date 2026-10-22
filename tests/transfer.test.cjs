'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Transfer = require('../transfer-core.js');
const UI = require('../payment-ui.js');
const account = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
const balance = '0x' + (100n * 10n ** 18n).toString(16);
const details = { account, recipient, value:'5000', chainId:'0x1db1' };
const provider = { request:async ({ method }) => ({ eth_accounts:[account], eth_chainId:'0x1db1', eth_getBalance:balance })[method] };

test('recipient parser accepts wallet addresses, Ethereum URIs and payment links and rejects foreign destinations', () => {
  for (const value of [recipient, `ethereum:${recipient}@7601`, `https://bazaar.mustree.kr/pay.html?to=${recipient}`]) assert.deepEqual(Transfer.parseRecipient(value), {address:recipient, name:''});
  for (const value of [`https://other.test/pay.html?to=${recipient}`, 'javascript:alert(1)', `ethereum:${recipient}@1`, `pay this ${recipient}`]) assert.equal(Transfer.parseRecipient(value), null);
});
test('parser reads and limits the store name in payment and MetaMask QR links', () => {
  for (const raw of [Transfer.receiveLink(recipient, {name:'  사랑 분식  '}), 'https://bazaar.mustree.kr/pay.html?to='+recipient+'&name='+encodeURIComponent('  사랑 분식  ')]) {
    assert.deepEqual(Transfer.parseRecipient(raw), {address:recipient, name:'사랑 분식'});
  }
  const longName = '가'.repeat(50);
  assert.equal(Transfer.parseRecipient('https://bazaar.mustree.kr/pay.html?to='+recipient+'&name='+encodeURIComponent(longName)).name.length, 30);
});
test('store QR opens the payment document directly inside MetaMask and remains scannable in the app', () => {
  const link = Transfer.receiveLink(account, {name:'사랑 분식'});
  const url = new URL(link);
  assert.equal(url.origin, 'https://link.metamask.io');
  assert.equal(url.pathname, '/dapp/bazaar.mustree.kr/pay.html');
  assert.equal(url.searchParams.get('to'), account);
  assert.equal(url.searchParams.get('name'), '사랑 분식');
  assert.equal(Transfer.parseRecipient(link)?.address, account);
  assert.equal(new URL(Transfer.receiveLink(account)).searchParams.has('name'), false);
  for (const bad of [link.replace('link.metamask.io', 'fake.test'), link.replace('bazaar.mustree.kr/', 'bazaar.mustree.kr.fake.test/'), link.replace('https:', 'http:')]) assert.equal(Transfer.parseRecipient(bad), null);
});
test('receive QR targets the top-up document and rejects foreign deep link destinations', () => {
  const link = Transfer.receiveLink(account, {topup:true});
  const url = new URL(link);
  assert.equal(url.origin, 'https://link.metamask.io');
  assert.equal(url.pathname, '/dapp/bazaar.mustree.kr/operator.html');
  assert.equal(url.searchParams.get('to'), account);
  assert.equal(Transfer.parseRecipient(link)?.address, account);
  assert.equal(Transfer.parseRecipient('https://bazaar.mustree.kr/operator.html?to='+account)?.address, account);
  assert.equal(Transfer.parseRecipient(link.replace('bazaar.mustree.kr/', 'other.test/')), null);
  assert.throws(() => Transfer.receiveLink('invalid', {topup:true}), {code:'INVALID_ADDRESS'});
});
test('payment amounts have exact won conversion without a top-up bonus', () => {
  assert.deepEqual(Transfer.parseAmount('5,000원'), { won:5000n, wei:5n * 10n ** 18n });
  assert.equal(Transfer.parseAmount('500').wei, 5n * 10n ** 17n);
  for (const value of ['0','-1','1.5','10000001']) assert.throws(() => Transfer.parseAmount(value), { code:'INVALID_AMOUNT' });
});
test('top-up accepts whole won amounts from 1 won and keeps the exact 10% bonus', () => {
  assert.deepEqual(Transfer.parseAmount('20,000원', 'topup'), { won:20000n, wei:22n * 10n ** 18n });
  assert.deepEqual(Transfer.parseAmount('1,500원', 'topup'), { won:1500n, wei:1650000000000000000n });
  assert.deepEqual(Transfer.parseAmount('1505', 'topup'), { won:1505n, wei:1655500000000000000n });
  assert.deepEqual(Transfer.parseAmount('1', 'topup'), { won:1n, wei:1100000000000000n });
  assert.equal(UI.mst(Transfer.parseAmount('1505', 'topup').wei), '1.656 MST');
  for (const value of ['0','-1','1.5','']) assert.throws(() => Transfer.parseAmount(value, 'topup'), { code:'INVALID_AMOUNT' });
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


test('unrecognized receipts and receipt read timeouts never release a sent transaction', async () => {
  for (const result of [{}, 'hang']) {
    let sends=0;
    const wallet={request:async request=>{
      if(request.method==='eth_sendTransaction'){sends++;return hash;}
      if(request.method==='eth_getTransactionReceipt')return result==='hang'?new Promise(()=>{}):result;
      return provider.request(request);
    }};
    const sender=Transfer.createSender({provider:wallet,chainId:'0x1db1',maxPolls:1,readTimeout:5});
    await assert.rejects(sender.send(details),{code:result==='hang'?'READ_TIMEOUT':'INVALID_RECEIPT'});
    await assert.rejects(sender.send(details),{code:'PENDING_TRANSACTION'});
    assert.equal(sends,1);
  }
});
test('receipt checks on a different chain retain the hash until the original chain returns',async()=>{
  let chain='0x1db1',sends=0;
  const wallet={request:async request=>{
    if(request.method==='eth_chainId')return chain;
    if(request.method==='eth_sendTransaction'){sends++;return hash;}
    if(request.method==='eth_getTransactionReceipt')return {status:'0x1'};
    return provider.request(request);
  }};
  const sender=Transfer.createSender({provider:wallet,chainId:'0x1db1',maxPolls:1});
  await assert.rejects(sender.send(details,{onHash(){chain='0x1';}}),{code:'WRONG_CHAIN'});
  await assert.rejects(sender.send(details),{code:'PENDING_TRANSACTION'});
  chain='0x1db1';await sender.check(hash);assert.equal(sends,1);
});
