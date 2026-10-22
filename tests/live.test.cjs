'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const UI = require('../payment-ui.js');
const History = require('../transaction-history.js');
const { TEST_TOKEN } = require('./fixtures.cjs');

function liveHarness({ query = async () => ({items:[],lastScannedBlock:0,balanceWei:'0'}), hash = '#welcome', provider = null, storage } = {}) {
  const listeners = {};
  const screen = { innerHTML: '', addEventListener(type, handler) { listeners[type] = handler; } };
  const qrNode = {};
  const footer = {};
  const pill = {};
  const assigned = [];
  const location = { href: 'https://bazaar.mustree.kr/' + hash, hash, assign(value) { assigned.push(String(value)); } };
  const historyCalls = [];
  let backCount = 0;
  const setLocation = value => {
    const url = new URL(String(value), location.href);
    location.href = url.href;
    location.hash = url.hash;
  };
  const history = {
    replaceState(_state, _title, value) { historyCalls.push(['replace', String(value)]); setLocation(value); },
    pushState(_state, _title, value) { historyCalls.push(['push', String(value)]); setLocation(value); },
    back() { backCount += 1; },
  };
  const document = {
    visibilityState: 'visible',
    getElementById(id) { if (id === 'appScreen') return screen; if (id === 'liveQr' && screen.innerHTML.includes('id="liveQr"')) return qrNode; return null; },
    querySelector(selector) { if (selector === '.app-footer') return footer; if (selector === '.event-pill') return pill; return null; },
    addEventListener(type, handler) { listeners['document:' + type] = handler; },
  };
  let walletState;
  let controller;
  let qrOptions;
  function QRCode(_target, options) { qrOptions = options; }
  QRCode.CorrectLevel = { M: 0 };
  const Wallet = {
    NETWORK:{ rpcUrls:['https://rpc.test'] }, TOKEN:TEST_TOKEN,
    createRpcBalanceReader() { return async () => ({ balanceWei:'0x0', gasWei:'0x0' }); },
    discover() { return { getProvider:async()=>provider, dispose() {} }; },
    createWallet(options) {
      walletState = options.onState;
      controller = provider ? require('../wallet.js').createWallet({ ...options, token:TEST_TOKEN }) : { setup() {}, refresh() {}, restore() {}, dispose() {} };
      return controller;
    },
  };

  const window = { document, location, history, QRCode, setInterval(handler, interval) { assert.equal(interval,60000); listeners.tick = handler; return 1; }, clearInterval() { delete listeners.tick; }, BazaarTransfer:require('../transfer-core.js'), fetch: async () => ({ ok: true, json: async () => ({ result: '0x0' }) }), addEventListener(type, handler) { listeners[type] = handler; } };
  const context = { window, document, location, history, QRCode, URL, navigator: {}, setTimeout, clearTimeout, Promise, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'live.js'), 'utf8'), context);
  window.BazaarLive.create({ Wallet, UI, History:{ ...History, create:options => History.create({...options,storage}), recentTransfers:query }, illustration: () => '' }).init();
  const click = action => listeners.click({ target: { closest: selector => selector === '[data-live]' ? ({ disabled: false, dataset: { live: action } }) : null } });
  return { document, screen, location, historyCalls, listeners, click, state: value => walletState(value), qr: () => qrOptions, backCount: () => backCount, assigned, dispose:()=>controller.dispose() };
}

test('wallet screen skips unchanged history, forces manual/periodic checks and stops timers on exit', async () => {
  let calls = 0;
  const data = new Map(), storage = {getItem:key => data.get(key) || null,setItem:(key,value) => data.set(key,value)};
  const app = liveHarness({storage,query:async () => ({items:[],lastScannedBlock:++calls,balanceWei:'10'})});
  const ready = {status:'ready',account:'0x'+'1'.repeat(40),balanceWei:'10'};
  app.state(ready); await new Promise(setImmediate);
  app.state(ready); await new Promise(setImmediate);
  assert.equal(calls,1);
  app.click('refresh'); app.state(ready); await new Promise(setImmediate);
  assert.equal(calls,2);
  app.listeners.tick(); app.state(ready); await new Promise(setImmediate);
  assert.equal(calls,3);
  app.document.visibilityState = 'hidden';
  app.listeners.tick(); app.state(ready); await new Promise(setImmediate);
  assert.equal(calls,3);
  app.listeners.pagehide({persisted:false});
  assert.equal(app.listeners.tick,undefined);
});

test('receive QR opens the top-up page inside MetaMask and survives balance refresh races', () => {
  const app = liveHarness();
  const address = '0x1111111111111111111111111111111111111111';
  app.state({ status: 'ready', account: address, balanceWei: '0' });
  assert.match(app.screen.innerHTML, /충전하기/);

  app.click('receive');
  assert.match(app.screen.innerHTML, /충전할 금액 입금 후 직원에게/);
  assert.match(app.screen.innerHTML, /<code class="receive-address">0x111111…111111<\/code>/);
  assert.match(UI.transfer({recipient:address}, {kind:'topup'}), /<strong>0x111111…111111<\/strong>/);
  const url = new URL(app.qr().text);
  assert.equal(url.origin, 'https://link.metamask.io');
  assert.equal(url.pathname, '/dapp/bazaar.mustree.kr/operator.html');
  assert.equal(url.searchParams.get('to'), address);
  assert.equal(require('../transfer-core.js').parseRecipient(app.qr().text)?.address, address);
  assert.deepEqual(app.historyCalls.at(-1), ['push', '#receive']);

  app.state({ status: 'querying' });
  app.state({ status: 'error', duringBalance: true });
  assert.match(app.screen.innerHTML, /충전할 금액 입금 후 직원에게/);
  assert.doesNotMatch(app.screen.innerHTML, /잔액을 확인하지 못했어요/);

  app.state({ status: 'ready', account: address, balanceWei: '0' });
  assert.match(app.screen.innerHTML, /충전할 금액 입금 후 직원에게/);
});

test('top-up participates in browser history and returns home on Back', () => {
  const app = liveHarness();
  app.state({ status: 'ready', account: '0x2222222222222222222222222222222222222222', balanceWei: '0' });
  app.click('receive');

  app.location.hash = '#home';
  app.location.href = 'https://bazaar.mustree.kr/#home';
  app.listeners.popstate();
  assert.match(app.screen.innerHTML, /잔액을 확인하고 있어요/);
  app.state({ status: 'ready', account: '0x2222222222222222222222222222222222222222', balanceWei: '0' });
  assert.match(app.screen.innerHTML, /내 지갑/);
  assert.doesNotMatch(app.screen.innerHTML, /충전할 금액 입금 후 직원에게/);
});

for (const route of ['button','back','direct']) {
  test(`returning from receive via ${route} refreshes the real wallet and history without a manual refresh`, async t => {
    const account='0x'+'1'.repeat(40), methods=[];
    let raw='0x1', releaseBalance, historyReads=0;
    const provider={request:async({method})=>{
      methods.push(method);
      if(method==='eth_accounts')return [account];
      if(method==='eth_chainId')return '0x1db1';
      if(method==='eth_getBalance')return '0x0';
      if(method==='eth_call')return raw === null ? new Promise(resolve=>{releaseBalance=resolve;}) : raw;
      throw new Error('Unexpected wallet approval or transaction: '+method);
    }};
    const app=liveHarness({provider,hash:route==='direct'?'#receive':'#home',query:async()=>{
      historyReads++;
      return {items:historyReads===1?[]:[{hash:'0x'+'a'.repeat(64),blockNumber:'0x1',timestamp:Math.floor(Date.now()/1000),direction:'in',valueWei:'5500',balanceWei:'6500'}],lastScannedBlock:historyReads,balanceWei:historyReads===1?'1':'6500'};
    }});
    t.after(app.dispose);
    await new Promise(setImmediate);
    if(route!=='direct'){
      assert.match(app.screen.innerHTML, /1<span>MST/);
      app.click('receive');
    }
    assert.match(app.screen.innerHTML, /이 QR을 보여주세요/);
    raw=null;
    if(route!=='back')app.click('home');
    if(route!=='direct'){
      assert.equal(app.backCount(),route==='button'?1:0);
      app.location.hash='#home';
      app.location.href='https://bazaar.mustree.kr/#home';
      app.listeners.popstate();
    }else assert.equal(app.backCount(),0);
    await new Promise(setImmediate);
    assert.match(app.screen.innerHTML, /잔액을 확인하고 있어요/);
    assert.doesNotMatch(app.screen.innerHTML, /1<span>MST/);
    assert.equal(historyReads,1);
    releaseBalance('0x'+(6500n).toString(16));
    await new Promise(setImmediate);
    assert.match(app.screen.innerHTML, /6,500<span>MST/);
    assert.match(app.screen.innerHTML, /6,500원 상당/);
    assert.match(app.screen.innerHTML, /\+5,500 MST/);
    assert.equal(historyReads,2);
    assert.equal(methods.filter(method=>method==='eth_call').length,2);
    assert.equal(app.location.hash,'#home');
  });
}

test('a failed balance refresh on return shows retry instead of the old balance', async t => {
  let raw='0x1';
  const provider={request:async({method})=>({eth_accounts:['0x'+'1'.repeat(40)],eth_chainId:'0x1db1',eth_getBalance:'0x0',eth_call:raw})[method]};
  const app=liveHarness({provider,hash:'#receive'});
  t.after(app.dispose);
  await new Promise(setImmediate);
  raw='invalid';
  app.click('home');
  await new Promise(setImmediate);
  assert.match(app.screen.innerHTML,/잔액을 확인하지 못했어요/);
  assert.doesNotMatch(app.screen.innerHTML,/1<span>MST/);
  raw='0x'+(6500n).toString(16);
  app.click('refresh');
  await new Promise(setImmediate);
  assert.match(app.screen.innerHTML,/6,500<span>MST/);
});

test('the wallet screen shows whole wMST units as MST with the identical won value and no fee balance', () => {
  const app = liveHarness();
  const address = '0x2222222222222222222222222222222222222222';
  app.state({ status: 'ready', account: address, balanceWei: '1999', gasWei: '123456789' });
  assert.match(app.screen.innerHTML, /1,999<span>MST/);
  assert.match(app.screen.innerHTML, /1,999원 상당/);
  assert.doesNotMatch(app.screen.innerHTML, /123456789|수수료|가스/);
  app.state({ status: 'ready', account: address, balanceWei: '0', gasWei: '0' });
  assert.match(app.screen.innerHTML, /0<span>MST/);
  assert.match(app.screen.innerHTML, /0원 상당/);
});

test('MetaMask handoff uses a simple start path and store payment opens its scanner', () => {
  const handoff = liveHarness();
  handoff.click('start');
  handoff.state({ status: 'unavailable' });
  assert.equal(handoff.assigned.at(-1), 'https://link.metamask.io/dapp/bazaar.mustree.kr/start.html');
  const installation = liveHarness();
  installation.click('install');
  assert.equal(installation.assigned.at(-1), handoff.assigned.at(-1));
  assert.match(installation.screen.innerHTML, /바자회 이어하기/);
  installation.click('open-app');
  assert.equal(installation.assigned.at(-1), handoff.assigned.at(-1));

  const payment = liveHarness();
  payment.state({ status: 'ready', account: '0x3333333333333333333333333333333333333333', balanceWei: '1000' });
  assert.match(payment.screen.innerHTML, /가게 결제하기/);
  payment.click('pay');
  assert.equal(payment.assigned.at(-1), '/pay.html?scan=1');
});
test('continuing after missing-wallet detection opens the app synchronously in the user click', () => {
  const app = liveHarness();
  app.state({status:'unavailable'});
  app.click('start');
  assert.equal(app.assigned.at(-1), 'https://link.metamask.io/dapp/bazaar.mustree.kr/start.html');
});

test('wallet ready refreshes the shared history and honors a top-up deep link', async () => {
  let calls = 0;
  const app = liveHarness({ hash:'#receive', query:async () => { calls++; return {items:[],lastScannedBlock:calls,balanceWei:'0'}; } });
  const snapshot = { status:'ready', account:'0x' + '1'.repeat(40), balanceWei:'0' };
  app.state(snapshot);
  await new Promise(setImmediate);
  assert.match(app.screen.innerHTML, /충전할 금액 입금 후 직원에게/);
  app.state({ ...snapshot, balanceWei:'1000' });
  await new Promise(setImmediate);
  assert.equal(calls, 2);
});
