'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function liveHarness() {
  const listeners = {};
  const screen = { innerHTML: '', addEventListener(type, handler) { listeners[type] = handler; } };
  const qrNode = {};
  const footer = {};
  const pill = {};
  const assigned = [];
  const location = { href: 'https://bazaar.mustree.kr/#welcome', hash: '#welcome', assign(value) { assigned.push(String(value)); } };
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
  let qrOptions;
  function QRCode(_target, options) { qrOptions = options; }
  QRCode.CorrectLevel = { M: 0 };
  const Wallet = {
    createRpcBalanceReader() { return async () => '0x0'; },
    discover() { return { getProvider() {}, dispose() {} }; },
    createWallet({ onState }) { walletState = onState; return { setup() {}, refresh() {}, restore() {}, dispose() {} }; },
  };
  const window = { document, location, history, QRCode, fetch: async () => ({ ok: true, json: async () => ({ result: '0x0' }) }), addEventListener(type, handler) { listeners[type] = handler; } };
  const context = { window, document, location, history, QRCode, URL, navigator: {}, setTimeout, clearTimeout, Promise, console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'live.js'), 'utf8'), context);
  window.BazaarLive.create({ Wallet, illustration: () => '' }).init();
  const click = action => listeners.click({ target: { closest: () => ({ disabled: false, dataset: { live: action } }) } });
  return { screen, location, historyCalls, listeners, click, state: value => walletState(value), qr: () => qrOptions, backCount: () => backCount, assigned };
}

test('top-up opens a locally generated address QR and survives balance refresh races', () => {
  const app = liveHarness();
  const address = '0x1111111111111111111111111111111111111111';
  app.state({ status: 'ready', account: address, balanceWei: '0' });
  assert.match(app.screen.innerHTML, /충전하기/);

  app.click('receive');
  assert.match(app.screen.innerHTML, /현금 결제 후 직원에게/);
  assert.equal(app.qr().text, address);
  assert.deepEqual(app.historyCalls.at(-1), ['push', '#receive']);

  app.state({ status: 'querying' });
  app.state({ status: 'error', duringBalance: true });
  assert.match(app.screen.innerHTML, /현금 결제 후 직원에게/);
  assert.doesNotMatch(app.screen.innerHTML, /잔액을 확인하지 못했어요/);

  app.state({ status: 'ready', account: address, balanceWei: '0' });
  assert.match(app.screen.innerHTML, /현금 결제 후 직원에게/);
});

test('top-up participates in browser history and returns home on Back', () => {
  const app = liveHarness();
  app.state({ status: 'ready', account: '0x2222222222222222222222222222222222222222', balanceWei: '0' });
  app.click('receive');

  app.location.hash = '#home';
  app.location.href = 'https://bazaar.mustree.kr/#home';
  app.listeners.popstate();
  assert.match(app.screen.innerHTML, /내 달란트/);
  assert.doesNotMatch(app.screen.innerHTML, /현금 결제 후 직원에게/);
});

test('MetaMask handoff uses a simple start path and store payment opens its scanner', () => {
  const handoff = liveHarness();
  handoff.click('start');
  handoff.state({ status: 'unavailable' });
  assert.equal(handoff.assigned.at(-1), 'https://link.metamask.io/dapp/bazaar.mustree.kr/start.html');

  const payment = liveHarness();
  payment.state({ status: 'ready', account: '0x3333333333333333333333333333333333333333', balanceWei: '1000000000000000000' });
  assert.match(payment.screen.innerHTML, /매장 결제하기/);
  payment.click('pay');
  assert.equal(payment.assigned.at(-1), '/pay.html?scan=1');
});
