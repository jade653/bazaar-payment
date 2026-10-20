'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const UI = require('../payment-ui.js');
const Transfer = require('../transfer-core.js');
const account = '0x' + '1'.repeat(40), recipient = '0x' + '2'.repeat(40), hash = '0x' + 'a'.repeat(64);
function harness({ kind = 'payment', preview = false, name = '', to = recipient, value = '5000', mst = '5', autoScan = false, balanceWei = 100n * 10n ** 18n, delayProvider = false, noProvider = false, refreshFails = false, receipt = { status:'0x1' } } = {}) {
  const events = {}, nodes = new Map(), assigned = [], requests = [], saved = new Map();
  const storage = {getItem:key => saved.get(key) || null,setItem:(key,value) => saved.set(key,value)};
  const History = require('../transaction-history.js');
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML:'', hidden:false, textContent:'', querySelector(){return null;}, focus(){}, setSelectionRange(){}, addEventListener(type, handler) { events[id + ':' + type] = handler; } });
    return nodes.get(id);
  };
  const provider = { request:async request => {
    requests.push(request);
    if (request.method === 'eth_getTransactionReceipt') assert.equal(JSON.parse(saved.get('bazaar-sent-v1:0x1db1:' + account))[0].hash,hash);
    return ({ eth_accounts:[account], eth_chainId:'0x1db1', eth_getBalance:'0x' + balanceWei.toString(16), eth_sendTransaction:hash, eth_getTransactionReceipt:receipt })[request.method];
  } };
  let walletState, resolveProvider, scannerOptions, setups = 0, scannerStarts = 0;
  const providerTask = delayProvider ? new Promise(resolve => { resolveProvider = resolve; }) : Promise.resolve(noProvider ? null : provider);
  const wallet = {
    NETWORK:{ chainId:'0x1db1' },
    discover() { assert.equal(preview, false); return { getProvider:() => providerTask, dispose() {} }; },
    createRpcBalanceReader() { assert.equal(preview, false); return async () => '0x0'; },
    createWallet({ onState }) {
      assert.equal(preview, false); walletState = onState;
      const ready = () => onState({ status:'ready', account, balanceWei:'100000000000000000000' });
      return { restore:() => noProvider ? onState({status:'unavailable'}) : ready(), setup() { setups++; ready(); }, refresh() { if (refreshFails) throw new Error('balance refresh'); ready(); }, dispose() {} };
    }
  };
  const window = {
    BazaarHistory:{recordSent:options => History.recordSent({...options,storage})},
    BazaarWallet:wallet, BazaarTransfer:{ ...Transfer, createSender:options => Transfer.createSender({ ...options, maxPolls:1 }) }, BazaarUI:UI,
    BazaarScanner:{create(options){scannerOptions=options;return {start(){scannerStarts++;},stop(){}};}},
    fetch:async () => { throw new Error('Unexpected network'); }, addEventListener() {}
  };
  const params = new URLSearchParams({ to, won:value, mst, ...(kind === 'transfer' ? { mode:'transfer' } : {}), ...(preview ? { preview:'1' } : {}), ...(autoScan ? {scan:'1'} : {}) });
  if (name) params.set('name',name);
  node('screen').dataset = { transferKind:kind === 'topup' ? 'topup' : 'payment' };
  const context = { window, document:{ visibilityState:'visible', getElementById:node, querySelector:selector => selector === '[data-transfer-kind]' ? node('screen') : node('heading'), addEventListener() {} }, URL, location:{ href:'https://bazaar.mustree.kr/' + (kind === 'topup' ? 'operator.html' : 'pay.html') + '?' + params, origin:'https://bazaar.mustree.kr', assign:value => assigned.push(value) } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../transfer-page.js'), 'utf8'), context);
  const click = async action => { events['screen:click']({ target:{ closest:selector => selector === '[data-transfer]' ? { dataset:{ transfer:action } } : null } }); await new Promise(setImmediate); };
  return { saved, setups:() => setups, requests, assigned, screen:node('screen'), click, scan:raw=>scannerOptions.onAccept(raw), scannerStarts:()=>scannerStarts, input:value=>events['screen:input']({target:{id:'transferAmount',value,selectionStart:value.length,selectionEnd:value.length}}), walletState:value => walletState(value), resolveProvider:() => resolveProvider(provider) };
}

test('a scanned store QR displays its name and an unnamed replacement clears it', async () => {
  const page=harness({preview:true});
  await page.click('scan');
  page.scan(Transfer.receiveLink(recipient,{name:'사랑 분식'}));
  assert.match(page.screen.innerHTML, /<strong>사랑 분식<\/strong>/);
  assert.match(page.screen.innerHTML, /value="5000"/);
  page.scan(recipient);
  assert.doesNotMatch(page.screen.innerHTML, /사랑 분식/);
});
test('insufficient payment shows one top-up dialog with the latest checked balance and sends nothing', async () => {
  const page=harness({name:'사랑 분식', balanceWei:10n ** 18n});
  await page.click('submit');
  assert.match(page.screen.innerHTML, /<dialog class="balance-dialog"/);
  assert.match(page.screen.innerHTML, /잔액이 부족합니다\./);
  assert.match(page.screen.innerHTML, /현재 잔액: <strong>1 MST<\/strong>/);
  assert.equal((page.screen.innerHTML.match(/data-transfer="topup"/g)||[]).length, 1);
  assert.doesNotMatch(page.screen.innerHTML, /class="operator-alert"/);
  assert.equal(page.requests.filter(item=>item.method==='eth_sendTransaction').length, 0);
  await page.click('dismiss-insufficient');
  assert.doesNotMatch(page.screen.innerHTML, /<dialog/);
  assert.match(page.screen.innerHTML, /<strong>사랑 분식<\/strong>/);
  assert.match(page.screen.innerHTML, /value="5000"/);
  await page.click('submit');
  await page.click('topup');
  assert.equal(page.assigned.at(-1), '/#receive');
});
test('the top-up scanner accepts a receive deep link and keeps the top-up bonus', async () => {
  const page = harness({kind:'topup', preview:true});
  await page.click('connect');
  await page.click('scan');
  assert.equal(page.scan(Transfer.receiveLink(recipient, {topup:true})), true);
  assert.match(page.screen.innerHTML, new RegExp(recipient));
  assert.match(page.screen.innerHTML, /value="5000"/);
  await page.click('submit');
  assert.match(page.screen.innerHTML, /충전 완료 · 10% 보너스 포함/);
  assert.match(page.screen.innerHTML, /5\.5 MST/);
  assert.equal(page.requests.length, 0);
});
for (const [value, displayed, expectedWei] of [['1','0.001',1100000000000000n],['1505','1.656',1655500000000000000n]]) {
  test(`${value} won top-up enables submission and sends the exact bonus while rounding only its display`, async () => {
    const page = harness({kind:'topup', value});
    assert.ok(page.screen.innerHTML.includes('data-transfer="submit">'+displayed+' MST 충전하기</button>'));
    await page.click('submit');
    const sends = page.requests.filter(request=>request.method==='eth_sendTransaction');
    assert.equal(sends.length,1);
    assert.equal(BigInt(sends[0].params[0].value),expectedWei+50000000n);
    assert.match(page.screen.innerHTML,/충전 완료 · 10% 보너스 포함/);
  });
}
for (const kind of ['payment', 'topup', 'transfer']) {
  test(`${kind} offers the same direct app entry without requiring an amount`, () => {
    const page = harness({kind, noProvider:true, to:'', value:'', mst:'', autoScan:true});
    assert.match(page.screen.innerHTML, /class="operator-primary app-handoff"/);
    assert.doesNotMatch(page.screen.innerHTML, /id="transferAmount"|data-transfer="submit"/);
    const url = new URL(page.screen.innerHTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
    assert.equal(url.pathname, '/dapp/bazaar.mustree.kr/' + (kind === 'topup' ? 'operator.html' : 'pay.html'));
    assert.equal(url.searchParams.has('to'), false);
    assert.equal(url.searchParams.has('won'), false);
    assert.equal(url.searchParams.has('mst'), false);
    assert.equal(url.searchParams.get('mode'), kind === 'transfer' ? 'transfer' : null);
    assert.equal(page.scannerStarts(), 0);
    assert.equal(page.requests.length, 0);
  });
  test(`${kind} handoff uses the edited QR recipient, name and amount rather than initial URL data`, async () => {
    const page = harness({kind});
    const changed = '0x' + '3'.repeat(40);
    await page.click('scan');
    page.scan(Transfer.receiveLink(changed, {name:'새 가게'}));
    page.input(kind === 'transfer' ? '12.345' : '10000');
    page.walletState({status:'unavailable'});
    const url = new URL(page.screen.innerHTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
    assert.equal(url.searchParams.get('to'), changed);
    assert.equal(url.searchParams.get('name'), '새 가게');
    assert.equal(url.searchParams.get(kind === 'transfer' ? 'mst' : 'won'), kind === 'transfer' ? '12.345' : '10000');
    assert.equal(page.requests.length, 0);
  });
  test(`${kind} uses the shared UI and sender and retains success after balance refresh`, async () => {
    const page = harness({ kind });
    assert.match(page.screen.innerHTML, /id="transferAmount"/);
    await page.click('submit');
    assert.equal(page.requests.filter(item => item.method === 'eth_sendTransaction').length, 1);
    assert.equal(JSON.parse(page.saved.get('bazaar-sent-v1:0x1db1:' + account))[0].hash,hash);
    assert.match(page.screen.innerHTML, /class="operator-success"/);
    assert.match(page.screen.innerHTML, kind === 'topup' ? /5\.5 MST/ : /5 MST/);
  });
  test(`${kind} preview cannot discover a wallet or send real transactions`, async () => {
    const page = harness({ kind, preview:true });
    if (kind === 'topup') await page.click('connect');
    await page.click('submit');
    assert.match(page.screen.innerHTML, /class="operator-success"/);
    assert.equal(page.requests.length, 0);
    assert.equal(page.saved.size,0);
  });
}
test('automatic scanning starts once the wallet is available and never launches a camera in an external browser', () => {
  const external = harness({noProvider:true, autoScan:true});
  assert.equal(external.scannerStarts(), 0);
  const app = harness({autoScan:true});
  assert.equal(app.scannerStarts(), 1);
  app.walletState({status:'ready', account, balanceWei:'0'});
  assert.equal(app.scannerStarts(), 1);
});
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
test('mobile payment handoff targets the payment document without a 404 redirect', () => {
  const page = harness({ noProvider:true });
  const url = new URL(page.screen.innerHTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(url.pathname, '/dapp/bazaar.mustree.kr/pay.html');
  assert.equal(url.searchParams.get('to'), recipient);
  assert.equal(url.searchParams.get('won'), '5000');
});

test('an external browser offers a direct app link before an amount or payment is required', () => {
  const page = harness({noProvider:true, value:'', name:'사랑 분식'});
  assert.match(page.screen.innerHTML, /앱에서 결제 이어하기<\/a>/);
  assert.doesNotMatch(page.screen.innerHTML, /id="transferAmount"|data-transfer="submit"/);
  const href = page.screen.innerHTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&');
  const url = new URL(href);
  assert.equal(url.searchParams.get('to'), recipient);
  assert.equal(url.searchParams.get('name'), '사랑 분식');
  assert.equal(url.searchParams.has('won'), false);
  assert.equal(page.requests.length, 0);
  assert.deepEqual(page.assigned, []);
  page.walletState({status:'ready', account, balanceWei:'100000000000000000000'});
  assert.match(page.screen.innerHTML, /id="transferAmount"/);
  assert.doesNotMatch(page.screen.innerHTML, /앱에서 결제 이어하기/);
});

test('mobile payment handoff preserves the store name', () => {
  const page=harness({noProvider:true,name:'사랑 분식'});
  assert.match(page.screen.innerHTML, /<strong>사랑 분식<\/strong>/);
  const url = new URL(page.screen.innerHTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(url.searchParams.get('name'),'사랑 분식');
  assert.equal(url.searchParams.get('won'),'5000');
});
test('mobile direct transfer handoff retains the MST amount and mode', () => {
  const page = harness({ kind:'transfer', noProvider:true });
  const url = new URL(page.screen.innerHTML.match(/href="([^"]+)"/)[1].replaceAll('&amp;', '&'));
  assert.equal(url.searchParams.get('mode'), 'transfer');
  assert.equal(url.searchParams.get('mst'), '5');
  assert.equal(url.searchParams.get('to'), recipient);
});
