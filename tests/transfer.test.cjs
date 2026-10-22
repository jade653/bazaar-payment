'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Transfer = require('../transfer-core.js');
const UI = require('../payment-ui.js');
const { TEST_TOKEN, hex } = require('./fixtures.cjs');
const account = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
const balance = hex(100000), gas = hex(10n ** 15n);
const details = { account, recipient, value:'5000', chainId:'0x1db1', token:TEST_TOKEN };
const provider = { request:async ({ method }) => ({ eth_accounts:[account], eth_chainId:'0x1db1', eth_getBalance:gas, eth_call:balance })[method] };
const fees = { maxFeePerGas:hex(TEST_TOKEN.gasPolicy.maxFeePerGasWei), maxPriorityFeePerGas:hex(TEST_TOKEN.gasPolicy.maxPriorityFeePerGasWei) };
const word = value => BigInt(value).toString(16).padStart(64, '0');

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
test('every amount is whole won and maps one to one onto wMST units', () => {
  assert.deepEqual(Transfer.parseAmount('5,000원'), { won:5000n, units:5000n });
  assert.deepEqual(Transfer.parseAmount('20,000원', 'topup'), { won:20000n, units:20000n });
  assert.deepEqual(Transfer.parseAmount('1', 'topup'), { won:1n, units:1n });
  assert.deepEqual(Transfer.parseAmount('12,345', 'transfer'), { won:12345n, units:12345n });
  assert.equal(Transfer.parseAmount('10000000').units, 10000000n);
  for (const value of ['0','-1','1.5','10000001','']) assert.throws(() => Transfer.parseAmount(value), { code:'INVALID_AMOUNT' });
  for (const value of ['0','1.5','0.001','']) assert.throws(() => Transfer.parseAmount(value, 'topup'), { code:'INVALID_AMOUNT' });
  for (const value of ['0','1.0001','12.345']) assert.throws(() => Transfer.parseAmount(value, 'transfer'), { code:'INVALID_AMOUNT' });
  assert.equal(Transfer.parseAmount('20000000', 'topup').units, 20000000n, 'top-ups have no per-transaction cap');
});
test('gas allowance policy derives from the measured per-transfer reserve', () => {
  const policy = TEST_TOKEN.gasPolicy;
  assert.equal(Transfer.gasSupportWei(TEST_TOKEN), BigInt(policy.transferReserveWei) * BigInt(policy.transfersPerTopUp));
  assert.equal(Transfer.topUpCostWei(TEST_TOKEN), Transfer.gasSupportWei(TEST_TOKEN) + BigInt(policy.topUpReserveWei));
  assert.equal(Transfer.transfersAffordable(Transfer.gasSupportWei(TEST_TOKEN).toString(), TEST_TOKEN), policy.transfersPerTopUp);
  assert.equal(Transfer.transfersAffordable('0', TEST_TOKEN), 0);
  assert.equal(Transfer.transfersAffordable(null, TEST_TOKEN), null);
  assert.equal(Transfer.topUpsAffordable((Transfer.topUpCostWei(TEST_TOKEN) * 3n + 1n).toString(), TEST_TOKEN), 3);
});
test('payments and direct transfers call transfer() on the token with the wallet fee caps and no native value', async () => {
  for (const [kind, value] of [['payment','5000'], ['transfer','12345']]) {
    const result = await Transfer.prepare(provider, { ...details, kind, value });
    assert.deepEqual(result.transaction, { from:account, to:TEST_TOKEN.address, data:TEST_TOKEN.selectors.transfer + word(recipient) + word(value), value:'0x0', ...fees });
    assert.equal(result.gasSupportWei, 0n);
    assert.equal(result.recipient, recipient);
  }
});
test('top-ups call transferWithGas() and hand out the full configured gas allowance every time', async () => {
  const support = Transfer.gasSupportWei(TEST_TOKEN);
  for (const recipientGas of [0n, support / 2n, support * 10n]) {
    const wallet = { request:async request => request.method === 'eth_getBalance' && request.params[0] === recipient ? hex(recipientGas) : provider.request(request) };
    const result = await Transfer.prepare(wallet, { ...details, kind:'topup' });
    assert.equal(result.gasSupportWei, support);
    assert.deepEqual(result.transaction, { from:account, to:TEST_TOKEN.address, data:TEST_TOKEN.selectors.transferWithGas + word(recipient) + word(5000), value:hex(support), ...fees });
  }
});
test('preflight blocks changed accounts, wrong networks, missing wMST, missing fee MST and unconfigured tokens', async () => {
  for (const [method, result, code] of [['eth_accounts',[recipient],'ACCOUNT_CHANGED'], ['eth_chainId','0x1','WRONG_CHAIN'], ['eth_call','0x0','INSUFFICIENT_BALANCE'], ['eth_getBalance','0x0','INSUFFICIENT_GAS']]) {
    const wallet = { request:async request => request.method === method ? result : provider.request(request) };
    await assert.rejects(Transfer.prepare(wallet, details), { code });
  }
  const short = { request:async request => request.method === 'eth_getBalance' ? hex(BigInt(TEST_TOKEN.gasPolicy.transferReserveWei) - 1n) : provider.request(request) };
  await assert.rejects(Transfer.prepare(short, details), { code:'INSUFFICIENT_GAS' });
  const enough = { request:async request => request.method === 'eth_getBalance' ? hex(TEST_TOKEN.gasPolicy.transferReserveWei) : provider.request(request) };
  assert.ok((await Transfer.prepare(enough, details)).transaction);
  const operatorShort = { request:async request => request.method === 'eth_getBalance' ? hex(Transfer.topUpCostWei(TEST_TOKEN) - 1n) : provider.request(request) };
  await assert.rejects(Transfer.prepare(operatorShort, { ...details, kind:'topup' }), { code:'INSUFFICIENT_GAS' });
  await assert.rejects(Transfer.prepare(provider, { ...details, token:{ ...TEST_TOKEN, address:null } }), { code:'TOKEN_NOT_CONFIGURED' });
  const insufficient = await Transfer.prepare({ request:async request => request.method === 'eth_call' ? hex(4999) : provider.request(request) }, details).catch(error => error);
  assert.equal(insufficient.balanceWei, '4999');
});
test('preflight revalidates both account and network after a delayed balance read', async () => {
  for (const code of ['ACCOUNT_CHANGED','WRONG_CHAIN']) {
    let changed = false;
    const wallet = { request:async request => {
      if (request.method === 'eth_call') { changed = true; return balance; }
      if (changed && request.method === 'eth_accounts' && code === 'ACCOUNT_CHANGED') return [recipient];
      if (changed && request.method === 'eth_chainId' && code === 'WRONG_CHAIN') return '0x1';
      return provider.request(request);
    } };
    await assert.rejects(Transfer.prepare(wallet, details), { code });
  }
});
test('RPC balance fallback retains every amount policy and rejects malformed balances', async () => {
  const wallet = { request:async request => { if (request.method === 'eth_call') throw new Error('provider unavailable'); return provider.request(request); } };
  for (const kind of ['payment','topup','transfer']) {
    const result = await Transfer.prepare(wallet, { ...details, kind, value:'5000', readBalanceFromRpc:async () => ({ balanceWei:balance, gasWei:gas }) });
    assert.ok(result.amount.units > 0n);
  }
  await assert.rejects(Transfer.prepare(wallet, { ...details, readBalanceFromRpc:async () => ({ balanceWei:'invalid', gasWei:gas }) }), { code:'INVALID_BALANCE' });
  await assert.rejects(Transfer.prepare(wallet, { ...details, readBalanceFromRpc:async () => balance }), { code:'INVALID_BALANCE' });
});
test('repeated sends share one request and unknown transactions stay locked until resolved', async () => {
  let sends = 0, confirmed = false;
  const wallet = { request:async request => {
    if (request.method === 'eth_sendTransaction') { sends++; return hash; }
    if (request.method === 'eth_getTransactionReceipt') return confirmed ? { status:'0x1' } : null;
    return provider.request(request);
  } };
  const sender = Transfer.createSender({ provider:wallet, chainId:'0x1db1', token:TEST_TOKEN, maxPolls:1 });
  const first = sender.send(details), second = sender.send(details);
  assert.equal(first, second);
  await assert.rejects(first, { code:'RECEIPT_TIMEOUT' });
  await assert.rejects(sender.send(details), { code:'PENDING_TRANSACTION' });
  assert.equal(sends, 1);
  confirmed = true;
  await sender.check(hash); await sender.send(details);
  assert.equal(sends, 2);
});
test('the sender adds the chain id to the token transaction it submits', async () => {
  const sent = [];
  const wallet = { request:async request => {
    if (request.method === 'eth_sendTransaction') { sent.push(request.params[0]); return hash; }
    if (request.method === 'eth_getTransactionReceipt') return { status:'0x1' };
    return provider.request(request);
  } };
  const sender = Transfer.createSender({ provider:wallet, chainId:'0x1db1', token:TEST_TOKEN, maxPolls:1 });
  const result = await sender.send(details);
  assert.equal(sent[0].chainId, '0x1db1');
  assert.equal(sent[0].to, TEST_TOKEN.address);
  assert.equal(sent[0].data, TEST_TOKEN.selectors.transfer + word(recipient) + word(5000));
  assert.equal(result.hash, hash);
});
test('receipt polling distinguishes success, revert, timeout and invalid hashes', async () => {
  let calls = 0;
  assert.equal((await Transfer.waitForReceipt({ request:async () => ++calls === 1 ? null : { status:'0x1' } }, hash, { wait:async () => {} })).status, '0x1');
  await assert.rejects(Transfer.waitForReceipt({ request:async () => ({ status:'0x0' }) }, hash), { code:'TRANSACTION_FAILED' });
  await assert.rejects(Transfer.waitForReceipt({ request:async () => null }, hash, { attempts:1 }), { code:'RECEIPT_TIMEOUT' });
  await assert.rejects(Transfer.waitForReceipt(provider, 'invalid'), { code:'INVALID_TX_HASH' });
});
test('balances display whole wMST units with thousands separators and no rounding', () => {
  assert.equal(UI.mst('1999'), '1,999 MST');
  assert.equal(UI.mst('0'), '0 MST');
  assert.equal(UI.mst(null), '— MST');
  assert.equal(UI.mst(9007199254740993n * 1000n), '9,007,199,254,740,993,000 MST');
  assert.equal(UI.mst('1500', false), '1,500');
  assert.equal(UI.won('1500'), '1,500');
});
test('participant screens never show transaction hashes or chain wording while error texts stay distinct', () => {
  const sending = UI.transfer({ step:'sending', hash, status:'확인 중' }, { kind:'payment' });
  const success = UI.transfer({ step:'success', hash, recipient }, { kind:'topup', amount:Transfer.parseAmount('5000', 'topup') });
  for (const html of [sending, success]) {
    assert.doesNotMatch(html, new RegExp(hash));
    assert.doesNotMatch(html, /가스|보너스|wMST|블록|체인|트랜잭션/);
  }
  assert.match(success, /충전 완료/);
  assert.match(success, /5,000 MST/);
  assert.notEqual(UI.errorText('INSUFFICIENT_BALANCE'), UI.errorText('INSUFFICIENT_GAS'));
  assert.notEqual(UI.errorText('INSUFFICIENT_GAS'), UI.errorText('INSUFFICIENT_GAS', 'topup'));
  assert.match(UI.errorText('INSUFFICIENT_GAS', 'topup'), /MST/);
  assert.match(UI.errorText('TOKEN_NOT_CONFIGURED', 'topup'), /wMST/);
  assert.doesNotMatch(UI.errorText('INSUFFICIENT_BALANCE'), /가스/);
});
test('unrecognized receipts and receipt read timeouts never release a sent transaction', async () => {
  for (const result of [{}, 'hang']) {
    let sends=0;
    const wallet={request:async request=>{
      if(request.method==='eth_sendTransaction'){sends++;return hash;}
      if(request.method==='eth_getTransactionReceipt')return result==='hang'?new Promise(()=>{}):result;
      return provider.request(request);
    }};
    const sender=Transfer.createSender({provider:wallet,chainId:'0x1db1',token:TEST_TOKEN,maxPolls:1,readTimeout:5});
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
  const sender=Transfer.createSender({provider:wallet,chainId:'0x1db1',token:TEST_TOKEN,maxPolls:1});
  await assert.rejects(sender.send(details,{onHash(){chain='0x1';}}),{code:'WRONG_CHAIN'});
  await assert.rejects(sender.send(details),{code:'PENDING_TRANSACTION'});
  chain='0x1db1';await sender.check(hash);assert.equal(sends,1);
});
