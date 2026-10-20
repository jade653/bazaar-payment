'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const UI = require('../payment-ui.js');
const Transfer = require('../transfer-core.js');
const account = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
function harness({ kind = 'payment', preview = false, delayProvider = false, noProvider = false, refreshFails = false, receipt = { status:'0x1' } } = {}) {
  const events = {}, nodes = new Map(), assigned = [], requests = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML:'', hidden:false, textContent:'', addEventListener(type, handler) { events[id + ':' + type] = handler; } });
    return nodes.get(id);
  };
  const provider = { request:async request => {
    requests.push(request);
    return ({ eth_accounts:[account], eth_chainId:'0x1db1', eth_getBalance:'0x' + (100n * 10n ** 18n).toString(16), eth_sendTransaction:hash, eth_getTransactionReceipt:receipt })[request.method];
  } };
  let walletState, resolveProvider, setups = 0;
  const providerTask = delayProvider ? new Promise(resolve => { resolveProvider = resolve; }) : Promise.resolve(noProvider ? null : provider);
  const wallet = {
    NETWORK:{ chainId:'0x1db1' },
    discover() { assert.equal(preview, false); return { getProvider:() => providerTask, dispose() {} }; },
    createRpcBalanceReader() { assert.equal(preview, false); return async () => '0x0'; },
    createWallet({ onState }) {
      assert.equal(preview, false); walletState = onState;
      const ready = () => onState({ status:'ready', account, balanceWei:'100000000000000000000' });
      return { restore:ready, setup() { setups++; ready(); }, refresh() { if (refreshFails) throw new Error('balance refresh'); ready(); }, dispose() {} };
    }
  };
  const window = {
    BazaarWallet:wallet, BazaarTransfer:{ ...Transfer, createSender:options => Transfer.createSender({ ...options, maxPolls:1 }) }, BazaarUI:UI,
    fetch:async () => { throw new Error('Unexpected network'); }, addEventListener() {}
  };
  const params = new URLSearchParams({ to:recipient, won:'5000', mst:'5', ...(kind === 'transfer' ? { mode:'transfer' } : {}), ...(preview ? { preview:'1' } : {}) });
  node('screen').dataset = { transferKind:kind === 'topup' ? 'topup' : 'payment' };
  const context = { window, document:{ visibilityState:'visible', getElementById:node, querySelector:selector => selector === '[data-transfer-kind]' ? node('screen') : node('heading'), addEventListener() {} }, URL, location:{ href:'https://bazaar.mustree.kr/pay.html?' + params, origin:'https://bazaar.mustree.kr', assign:value => assigned.push(value) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../transfer-page.js'), 'utf8'), context);
  const click = async action => { events['screen:click']({ target:{ closest:selector => selector === '[data-transfer]' ? { dataset:{ transfer:action } } : null } }); await new Promise(setImmediate); };
  return { setups:() => setups, requests, assigned, screen:node('screen'), click, walletState:value => walletState(value), resolveProvider:() => resolveProvider(provider) };
}
for (const kind of ['payment', 'topup', 'transfer']) {
  test(`${kind} uses the shared UI and sender and retains success after balance refresh`, async () => {
    const page = harness({ kind });
    assert.match(page.screen.innerHTML, /id="transferAmount"/);
    await page.click('submit');
    assert.equal(page.requests.filter(item => item.method === 'eth_sendTransaction').length, 1);
    assert.match(page.screen.innerHTML, /class="operator-success"/);
    assert.match(page.screen.innerHTML, kind === 'topup' ? /5\.5 MST/ : /5 MST/);
  });
  test(`${kind} preview cannot discover a wallet or send real transactions`, async () => {
    const page = harness({ kind, preview:true });
    if (kind === 'topup') await page.click('connect');
    await page.click('submit');
    assert.match(page.screen.innerHTML, /class="operator-success"/);
    assert.equal(page.requests.length, 0);
  });
}
test('repeated submissions during provider discovery send exactly once', async () => {
  const page = harness({ delayProvider:true });
  const first = page.click('submit'), second = page.click('submit');
  page.resolveProvider(); await Promise.all([first, second]);
  assert.equal(page.requests.filter(item => item.method === 'eth_sendTransaction').length, 1);
});
test('revoked accounts require setup before another submission', async () => {
  const page = harness();
  page.walletState({ status:'idle' });
  assert.equal(page.screen.innerHTML.includes('— MST'), true);
  assert.doesNotMatch(page.screen.innerHTML, /100 MST/);
  await page.click('submit');
  assert.equal(page.setups(), 1);
});
test('manual address changes require confirmation and cannot send to the previous recipient', async () => {
  const page = harness();
  await page.click('manual');
  assert.match(page.screen.innerHTML, /disabled>받는 QR을 스캔해 주세요/);
  await page.click('submit');
  assert.equal(page.requests.filter(item => item.method === 'eth_sendTransaction').length, 0);
});
test('unknown receipts keep the sending view and prevent a second transfer', async () => {
  const page = harness({ receipt:null });
  await page.click('submit');
  assert.doesNotMatch(page.screen.innerHTML, /id="transferAmount"/);
  assert.match(page.screen.innerHTML, /결과 다시 확인/);
  await page.click('submit');
  await page.click('check');
  assert.equal(page.requests.filter(item => item.method === 'eth_sendTransaction').length, 1);
});
test('confirmed failures return to the form and permit a new transfer', async () => {
  const page = harness({ receipt:{ status:'0x0' } });
  await page.click('submit');
  assert.match(page.screen.innerHTML, /id="transferAmount"/);
  assert.match(page.screen.innerHTML, /송금이 완료되지 않았어요/);
  await page.click('submit');
  assert.equal(page.requests.filter(item => item.method === 'eth_sendTransaction').length, 2);
});
test('confirmed success remains visible when a balance refresh fails', async () => {
  const page = harness({ refreshFails:true });
  await page.click('submit');
  assert.match(page.screen.innerHTML, /class="operator-success"/);
});
test('mobile payment handoff retains the recipient and exact won amount in a simple path', async () => {
  const page = harness({ noProvider:true });
  await page.click('submit');
  assert.deepEqual(page.assigned, ['https://link.metamask.io/dapp/bazaar.mustree.kr/pay/' + recipient + '/5000']);
});
test('mobile direct transfer handoff retains the MST amount and mode', async () => {
  const page = harness({ kind:'transfer', noProvider:true });
  await page.click('submit');
  const url = new URL(page.assigned[0]);
  assert.equal(url.searchParams.get('mode'), 'transfer');
  assert.equal(url.searchParams.get('mst'), '5');
  assert.equal(url.searchParams.get('to'), recipient);
});
