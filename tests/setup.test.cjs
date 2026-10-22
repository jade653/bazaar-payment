'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Wallet = require('../wallet.js');
const Transfer = require('../transfer-core.js');
const UI = require('../payment-ui.js');
const artifact = (() => { const window = {}; vm.runInNewContext(fs.readFileSync(require.resolve('../wmst-artifact.js'), 'utf8'), { window }); return window.WMST_ARTIFACT; })();
const A = '0x' + '1'.repeat(40), TOKEN = '0x' + 'c'.repeat(40), TEST = '0x' + 'ab'.repeat(20);
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const word = value => BigInt(value).toString(16).padStart(64, '0');
function storage() { const data = new Map(); return { getItem:key => data.get(key) || null, setItem:(key, value) => data.set(key, value), removeItem:key => data.delete(key), data }; }
// Gas figures mirror tools/estimate-wmst-gas.cjs; limits are the 1.5x padding MetaMask applies.
const GAS = { deploy:['0x7d7cd', '0xbbb38'], fresh:['0xc8f0', '0x12d68'], existing:['0x8602', '0xc903'], topup:['0x158d6', '0x20541'] };
function mockProvider({ supply = null } = {}) {
  const calls = [], receipts = {}, txs = {}; let sends = 0, transfers = 0, minted = 0n;
  return { calls, count:method => calls.filter(call => call.method === method).length, async request({ method, params }) {
    calls.push({ method, params });
    switch (method) {
      case 'eth_accounts': return [A];
      case 'eth_chainId': return '0x1db1';
      case 'eth_getBalance': return '0x' + (10n ** 18n).toString(16);
      case 'eth_sendTransaction': {
        const tx = params[0], hash = '0x' + (++sends).toString(16).padStart(64, '0');
        const kind = !tx.to ? 'deploy' : tx.data.startsWith(Wallet.TOKEN.selectors.transferWithGas) ? 'topup' : ++transfers === 1 ? 'fresh' : 'existing';
        if (kind === 'deploy') minted = BigInt('0x' + tx.data.slice(-64));
        receipts[hash] = { status:'0x1', blockNumber:'0x64', transactionHash:hash, gasUsed:GAS[kind][0], effectiveGasPrice:'0x6b', contractAddress:kind === 'deploy' ? TOKEN : null };
        txs[hash] = { hash, gas:GAS[kind][1], maxFeePerGas:'0x3e8', maxPriorityFeePerGas:'0x64' };
        return hash;
      }
      case 'eth_getTransactionReceipt': return receipts[params[0]] || null;
      case 'eth_getTransactionByHash': return txs[params[0]] || null;
      case 'eth_call': return '0x' + word(supply ?? minted);
      case 'eth_gasPrice': return '0x6b';
      case 'eth_maxPriorityFeePerGas': return '0x64';
      default: throw new Error('Unexpected method: ' + method);
    }
  } };
}
function page({ provider = mockProvider(), preview = false, noProvider = false, session = storage() } = {}) {
  const events = {}, nodes = new Map(), assigned = []; let controller, copied;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML:'', value:'', textContent:'', hidden:false, querySelector() { return null; }, focus() {}, select() {}, addEventListener(type, fn) { events[id + ':' + type] = fn; } });
    return nodes.get(id);
  };
  const document = { visibilityState:'visible', getElementById:node, querySelector:() => null, addEventListener(type, fn) { events['document:' + type] = fn; }, removeEventListener() {} };
  const diagnostics = Wallet.createDiagnostics({ storage:session });
  const crypto = { getRandomValues(array) { array.fill(0xab); return array; } };
  const window = { document, sessionStorage:session, localStorage:storage(), crypto, navigator:{ clipboard:{ async writeText(value) { copied = value; } } },
    BazaarWallet:{ ...Wallet, diagnosticsFor:() => diagnostics, discover:() => ({ getProvider:async () => noProvider ? null : provider, dispose() {} }), createWallet(options) { controller = Wallet.createWallet({ ...options, diagnostics }); return controller; } },
    BazaarTransfer:Transfer, BazaarUI:UI, WMST_ARTIFACT:artifact,
    fetch:async () => { throw new Error('Unexpected HTTP'); }, addEventListener(type, fn) { events[type] = fn; }, removeEventListener() {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../setup.js'), 'utf8'), { window, document, URL, URLSearchParams, crypto, navigator:window.navigator, setTimeout, clearTimeout, Promise, console,
    location:{ href:'https://bazaar.mustree.kr/setup.html' + (preview ? '?preview=1' : ''), origin:'https://bazaar.mustree.kr', assign:value => assigned.push(String(value)) } });
  return { provider, session, diagnostics, assigned, screen:node('screen') && node('setupScreen'), node, copied:() => copied, controller:() => controller,
    async click(action) { events['setupScreen:click']({ target:{ closest:selector => selector === '[data-transfer]' ? { dataset:{ transfer:action } } : null } }); for (let i = 0; i < 6; i++) await flush(); },
    input(id, value) { events['setupScreen:input']({ target:{ id, value } }); },
    dispose() { events.pagehide?.({ persisted:false }); } };
}
const sends = p => p.provider.calls.filter(call => call.method === 'eth_sendTransaction').map(call => call.params[0]);

test('deploy sends bytecode plus the 32-byte supply, verifies totalSupply and records the contract address and block', async t => {
  const p = page(); t.after(p.dispose); await flush();
  assert.equal(p.controller().getSnapshot().status, 'ready');
  assert.match(p.screen.innerHTML, /value="1000000000"/);
  p.input('setupSupply', '2,000,000');
  await p.click('deploy');
  const [tx] = sends(p);
  assert.equal(tx.to, undefined);
  assert.equal(tx.data, artifact.bytecode + word(2000000));
  assert.equal(tx.value, '0x0');
  assert.equal(tx.chainId, Wallet.NETWORK.chainId);
  assert.equal(tx.maxFeePerGas, '0x3e8'); assert.equal(tx.maxPriorityFeePerGas, '0x64');
  assert.match(p.screen.innerHTML, new RegExp(TOKEN));
  assert.match(p.screen.innerHTML, /배포 블록<\/span><strong>100</);
  assert.match(p.screen.innerHTML, /2,000,000 wMST/);
  assert.match(p.screen.innerHTML, /value="0xcccccccccccccccccccccccccccccccccccccccc"/, 'measure input is prefilled');
  const saved = JSON.parse(p.session.getItem('bazaar-setup-token-v1'));
  assert.equal(saved.address, TOKEN); assert.equal(saved.deployBlock, 100); assert.equal(saved.supply, '2000000');
  assert.equal(p.provider.calls.find(call => call.method === 'eth_call').params[0].data, Wallet.TOKEN.selectors.totalSupply);
});
test('a totalSupply mismatch is reported without recording the deployment', async t => {
  const p = page({ provider:mockProvider({ supply:5n }) }); t.after(p.dispose); await flush();
  await p.click('deploy');
  assert.match(p.screen.innerHTML, /총 발행량이 입력값과 달라요/);
  assert.equal(p.session.getItem('bazaar-setup-token-v1'), null);
});
test('measurement sends the three transactions in order and derives the reserves from receipts and tx objects', async t => {
  const p = page(); t.after(p.dispose); await flush();
  await p.click('deploy');
  await p.click('measure');
  const txs = sends(p).slice(1);
  assert.equal(txs.length, 3);
  const token = { ...Wallet.TOKEN, address:TOKEN };
  assert.deepEqual(txs.map(tx => tx.to), [TOKEN, TOKEN, TOKEN]);
  assert.equal(txs[0].data, Transfer.abi.transfer(token, TEST, 1n));
  assert.equal(txs[1].data, Transfer.abi.transfer(token, TEST, 1n));
  assert.equal(txs[2].data, Transfer.abi.transferWithGas(token, TEST, 1n));
  assert.deepEqual(txs.map(tx => tx.value), ['0x0', '0x0', '0x' + Transfer.gasSupportWei(Wallet.TOKEN).toString(16)]);
  assert.ok(txs.every(tx => tx.from === A && tx.chainId === Wallet.NETWORK.chainId && tx.maxFeePerGas === '0x3e8'));
  const html = p.screen.innerHTML.replace(/&#39;/g, "'");
  // transfer reserve = max(gas limit x max fee) over the two transfers = 77,160 x 1,000; top-up reserve = 132,417 x 1,000.
  assert.match(html, /transferReserveWei: '77160000'/);
  assert.match(html, /topUpReserveWei: '132417000'/);
  assert.match(html, /maxFeePerGasWei: '1000'/);
  assert.match(html, /maxPriorityFeePerGasWei: '100'/);
  assert.match(html, /transfersPerTopUp: 20/);
  assert.match(html, new RegExp("address: '" + TOKEN + "'"));
  assert.match(html, /deployBlock: 100/);
  const json = JSON.parse(p.node('setupScreen').innerHTML.match(/<textarea id="setupJson"[^>]*>([\s\S]*?)<\/textarea>/)[1].replace(/&quot;/g, '"'));
  assert.equal(json.derived.gasSupportWei, (20n * 77160000n).toString());
  assert.equal(json.derived.actualTransferCostWei, (51440n * 107n).toString());
  assert.equal(json.derived.actualTopUpCostWei, (88278n * 107n).toString());
  assert.equal(json.derived.topUpsAffordable, (10n ** 18n / (20n * 77160000n + 132417000n)).toString());
  assert.equal(json.chain.gasPriceWei, '107'); assert.equal(json.token, TOKEN); assert.equal(json.deployBlock, 100);
  assert.deepEqual(json.transactions.map(tx => tx.kind), ['transfer-fresh', 'transfer-existing', 'topup']);
  assert.ok(p.diagnostics.snapshot().some(row => row.stage === 'measure:topup:confirmed'));
  // Mock nodes do not derive value from markup; copy reads the textarea value the browser would hold.
  p.node('setupConfig').value = html.match(/<textarea id="setupConfig"[^>]*>([\s\S]*?)<\/textarea>/)[1];
  await p.click('copy-config');
  assert.match(p.copied(), /transferReserveWei: '77160000'/);
  assert.match(p.copied(), /^address: '0xcccccccccccccccccccccccccccccccccccccccc',\ndeployBlock: 100,\ngasPolicy: Object\.freeze\(\{\n/);
});
test('measuring a typed address works without a deployment and flags the unknown deploy block', async t => {
  const p = page(); t.after(p.dispose); await flush();
  p.input('setupToken', TOKEN); p.input('setupTestWallet', '0x' + '2'.repeat(40));
  await p.click('measure');
  assert.equal(sends(p).length, 3);
  assert.equal(sends(p)[0].data, Transfer.abi.transfer({ ...Wallet.TOKEN, address:TOKEN }, '0x' + '2'.repeat(40), 1n));
  assert.match(p.screen.innerHTML, /deployBlock: 0/);
  assert.match(p.screen.innerHTML, /배포 블록 번호를 모릅니다/);
});
test('invalid addresses and supplies are rejected before anything is sent', async t => {
  const p = page(); t.after(p.dispose); await flush();
  p.input('setupToken', 'abc'); await p.click('measure');
  assert.match(p.screen.innerHTML, /컨트랙트 주소를 확인해 주세요/);
  p.input('setupToken', TOKEN); p.input('setupTestWallet', 'nope'); await p.click('measure');
  assert.match(p.screen.innerHTML, /테스트 수신 지갑 주소를 확인해 주세요/);
  p.input('setupSupply', '0'); await p.click('deploy');
  assert.match(p.screen.innerHTML, /발행량은 1 이상/);
  assert.equal(p.provider.count('eth_sendTransaction'), 0);
});
test('preview and a missing wallet never send transactions', async t => {
  const preview = page({ preview:true }); t.after(preview.dispose);
  await preview.click('deploy'); await preview.click('measure');
  assert.equal(preview.provider.calls.length, 0);
  assert.match(preview.screen.innerHTML, /미리보기에서는/);
  const missing = page({ noProvider:true }); t.after(missing.dispose); await flush();
  assert.match(missing.screen.innerHTML, /MetaMask 앱에서 열기/);
  await missing.click('deploy');
  assert.equal(missing.provider.count('eth_sendTransaction'), 0);
  assert.deepEqual(missing.assigned, ['https://link.metamask.io/dapp/bazaar.mustree.kr/setup.html']);
});
test('a saved deployment survives reload through sessionStorage', async t => {
  const session = storage();
  const first = page({ session }); t.after(first.dispose); await flush(); await first.click('deploy');
  const second = page({ session }); t.after(second.dispose); await flush();
  assert.match(second.screen.innerHTML, /다시 발행하기/);
  assert.match(second.screen.innerHTML, new RegExp('value="' + TOKEN + '"'));
});
