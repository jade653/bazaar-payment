'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Dashboard = require('../dashboard.js');
const Transfer = require('../transfer-core.js');
const UI = require('../payment-ui.js');
const Wallet = require('../wallet.js');

const ZERO = '0x' + '0'.repeat(40), TOPIC = Wallet.TOKEN.transferTopic;
const treasury = '0x' + 'a'.repeat(40), alice = '0x' + '1'.repeat(40), bob = '0x' + '2'.repeat(40), store = '0x' + '5'.repeat(40);
const tokenAddress = '0x' + 'c'.repeat(40);
const TOKEN = { ...Wallet.TOKEN, address:tokenAddress, deployBlock:100 };
const pad = address => '0x' + address.slice(2).padStart(64, '0');
const hex = number => '0x' + number.toString(16);
function log(block, index, from, to, value, removed = false) {
  return { address:tokenAddress, blockNumber:hex(block), logIndex:hex(index), transactionHash:'0x' + (block * 10 + index).toString(16).padStart(64, '0'), removed, topics:[TOPIC, pad(from), pad(to)], data:'0x' + value.toString(16).padStart(64, '0') };
}
const logs = [
  log(100, 0, ZERO, treasury, 1000000000n),
  log(110, 0, treasury, alice, 20000n),
  log(112, 0, treasury, bob, 50000n),
  log(120, 0, alice, store, 7500n),
  log(125, 0, bob, store, 12000n),
  log(130, 0, store, treasury, 19500n),
  log(131, 0, treasury, alice, 10000n),
  log(132, 0, treasury, bob, 99999n, true)
];

test('aggregate derives supply, circulation, top-ups, recoveries, labels and transfer types from logs', () => {
  const summary = Dashboard.aggregate(logs);
  assert.equal(summary.treasury, treasury);
  assert.equal(summary.totalSupply, 1000000000n);
  assert.equal(summary.toppedUp, 80000n); assert.equal(summary.topUpCount, 3);
  assert.equal(summary.recovered, 19500n); assert.equal(summary.recoveryCount, 1);
  assert.equal(summary.paymentCount, 2);
  assert.equal(summary.treasuryBalance, 1000000000n - 80000n + 19500n);
  assert.equal(summary.circulating, 80000n - 19500n);
  const byAddress = Object.fromEntries(summary.wallets.map(item => [item.address, item]));
  assert.deepEqual(Object.keys(byAddress).sort(), [alice, bob, store].sort());
  assert.equal(byAddress[alice].balance, 22500n); assert.equal(byAddress[alice].toppedUp, 30000n); assert.equal(byAddress[alice].sentPayments, 7500n); assert.equal(byAddress[alice].label, '손님'); assert.equal(byAddress[alice].lastBlock, 131);
  assert.equal(byAddress[store].balance, 0n); assert.equal(byAddress[store].receivedPayments, 19500n); assert.equal(byAddress[store].recovered, 19500n); assert.equal(byAddress[store].label, '가게');
  assert.equal(byAddress[bob].transferCount, 2);
  assert.equal(summary.wallets[0].address, bob, 'sorted by balance');
  assert.deepEqual(summary.transfers.map(item => item.type), ['충전', '회수', '결제', '결제', '충전', '충전']);
  assert.equal(summary.transfers[0].value, 10000n);
  assert.ok(!summary.transfers.some(item => item.value === 99999n), 'removed logs are ignored');
});

test('mergeLogs dedupes by hash and log index, drops removed logs and keeps chain order', () => {
  const merged = Dashboard.mergeLogs(logs.slice(0, 4), [logs[3], logs[2], log(131, 0, treasury, alice, 10000n), log(133, 0, treasury, alice, 1n, true)]);
  assert.equal(merged.length, 5);
  assert.deepEqual(merged.map(item => Number(BigInt(item.blockNumber))), [100, 110, 112, 120, 131]);
  assert.equal(Dashboard.aggregate(merged).toppedUp, 80000n);
});

test('fee affordability counts whole transfers and flags fewer than three as low', () => {
  const reserve = BigInt(TOKEN.gasPolicy.transferReserveWei);
  assert.equal(Transfer.transfersAffordable(reserve * 2n + 1n, TOKEN), 2);
  assert.equal(Transfer.transfersAffordable(reserve * 3n, TOKEN), 3);
  assert.equal(Transfer.transfersAffordable(0n, TOKEN), 0);
  assert.equal(Transfer.transfersAffordable(null, TOKEN), null);
  assert.equal(Transfer.topUpsAffordable(Transfer.topUpCostWei(TOKEN) * 5n, TOKEN), 5);
  assert.ok(2 < Dashboard.LOW_FEE_TRANSFERS && 3 >= Dashboard.LOW_FEE_TRANSFERS);
  assert.equal(Dashboard.relativeTime(1000, 1000 * 1000 + 200000), '3분 전');
  assert.equal(Dashboard.relativeTime(undefined), '—');
});

function harness({ preview = false, token = TOKEN, fail = false } = {}) {
  const nodes = new Map(), events = {}, requests = [], chain = { latest:140 };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML:'', textContent:'', hidden:false, value:'', addEventListener(type, fn) { events[id + ':' + type] = fn; } });
    return nodes.get(id);
  };
  const gas = { [treasury]:Transfer.topUpCostWei(token) * 40n, [alice]:BigInt(token.gasPolicy.transferReserveWei) * 20n, [bob]:BigInt(token.gasPolicy.transferReserveWei) * 2n, [store]:0n };
  const fetch = async (_url, { body }) => {
    const calls = JSON.parse(body); requests.push(...calls.map(call => call.method));
    if (fail) return { ok:false };
    return { ok:true, json:async () => calls.map(call => {
      let result;
      if (call.method === 'eth_blockNumber') result = hex(chain.latest);
      else if (call.method === 'eth_getLogs') { const [filter] = call.params; assert.equal(filter.address, tokenAddress); const low = Number(BigInt(filter.fromBlock)), high = Number(BigInt(filter.toBlock)); result = logs.filter(item => { const block = Number(BigInt(item.blockNumber)); return block >= low && block <= high; }); }
      else if (call.method === 'eth_getBalance') result = '0x' + (gas[call.params[0]] ?? 0n).toString(16);
      else if (call.method === 'eth_getBlockByNumber') result = { number:call.params[0], timestamp:hex(1700000000 - (140 - Number(BigInt(call.params[0]))) * 2) };
      return { id:call.id, result };
    }) };
  };
  const context = {
    URL, Promise, console, setTimeout, clearTimeout, AbortController,
    location:{ href:'https://bazaar.mustree.kr/dashboard.html' + (preview ? '?preview=1' : '') },
    document:{ visibilityState:'visible', getElementById:node, addEventListener(type, fn) { events['document:' + type] = fn; } },
    navigator:{}, fetch, addEventListener(type, fn) { events[type] = fn; },
    setInterval(fn, ms) { events.tick = fn; events.tickMs = ms; return 7; }, clearInterval(id) { events.cleared = id; },
    BazaarWallet:{ ...Wallet, TOKEN:token }, BazaarTransfer:Transfer, BazaarUI:UI
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dashboard.js'), 'utf8'), context);
  return { context, node, events, requests, chain, dashboard:() => context.BazaarDashboard.active };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

test('the dashboard page loads logs, balances and headers from the RPC and renders totals, wallets and transfers', async () => {
  const page = harness();
  await flush();
  const snapshot = page.dashboard().snapshot();
  assert.equal(snapshot.error, ''); assert.equal(snapshot.cursor, 140);
  const stats = page.node('dashboardStats').innerHTML;
  assert.match(stats, /유통 중<\/span><strong>60,500 MST/);
  assert.match(stats, /운영 지갑 보유<\/span><strong>999,939,500 MST/);
  assert.match(stats, /충전 합계<\/span><strong>80,000 MST<\/strong><small>3건/);
  assert.match(stats, /회수 합계<\/span><strong>19,500 MST<\/strong><small>1건/);
  assert.match(stats, /결제<\/span><strong>2건/);
  assert.match(stats, /지갑 수<\/span><strong>3개<\/strong><small>가게 1개/);
  assert.match(stats, /수수료 부족 지갑<\/span><strong>2개/);
  assert.match(stats, /운영 지갑 수수료<\/span><strong>약 40회/);
  const wallets = page.node('dashboardWallets').innerHTML;
  assert.match(wallets, /0x222222…222222/); assert.match(wallets, /가게/); assert.match(wallets, /수수료 부족 · 2회/); assert.match(wallets, /수수료 20회/);
  assert.match(wallets, /22,500 MST/);
  assert.ok(wallets.indexOf(bob) < wallets.indexOf(alice), 'balance sort first');
  const transfers = page.node('dashboardTransfers').innerHTML;
  assert.match(transfers, /type-topup">충전/); assert.match(transfers, /type-recovery">회수/); assert.match(transfers, /type-payment">결제/);
  assert.match(transfers, /<em>운영<\/em>/); assert.match(transfers, /<em>가게<\/em>/); assert.match(transfers, /10,000 MST/);
  assert.match(transfers, /분 전|시간 전|방금 전|일 전/);
  assert.ok(!/eth_|RPC|_ERROR/.test(stats + wallets + transfers), 'no code-level identifiers in the UI');
  assert.equal(page.events.tickMs, Dashboard.REFRESH_INTERVAL);
  assert.equal(page.requests.filter(method => method === 'eth_getLogs').length, 1);
  assert.equal(page.requests.filter(method => method === 'eth_getBalance').length, 4);
  // Interactions: search, sort, expand with full address, incremental refresh.
  page.node('dashboardSearch').value = '5555';
  page.events['dashboardSearch:input']({ target:page.node('dashboardSearch') });
  assert.doesNotMatch(page.node('dashboardWallets').innerHTML, /0x111111/);
  assert.match(page.node('dashboardWallets').innerHTML, /0x555555…555555/);
  page.node('dashboardSearch').value = ''; page.events['dashboardSearch:input']({ target:page.node('dashboardSearch') });
  page.events['dashboardSort:click']();
  assert.equal(page.node('dashboardSort').textContent, '최근순');
  assert.ok(page.node('dashboardWallets').innerHTML.indexOf(alice) < page.node('dashboardWallets').innerHTML.indexOf(bob));
  page.events['dashboardWallets:click']({ target:{ closest:selector => selector === '[data-wallet-toggle]' ? { dataset:{ walletToggle:alice } } : null } });
  assert.match(page.node('dashboardWallets').innerHTML, new RegExp('<code>' + alice + '</code>'));
  assert.match(page.node('dashboardWallets').innerHTML, /충전받음<\/dt><dd>30,000 MST/);
  const before = page.requests.length;
  page.events.tick(); await flush();
  assert.equal(page.requests.slice(before).filter(method => method === 'eth_getLogs').length, 0, 'no new blocks, no log query');
  page.chain.latest = 150; page.events.tick(); await flush();
  const added = page.requests.slice(before);
  assert.equal(page.dashboard().snapshot().cursor, 150);
  assert.equal(added.filter(method => method === 'eth_getLogs').length, 1);
  assert.equal(added.filter(method => method === 'eth_getBlockByNumber').length, 0, 'cached headers are not fetched again');
  page.events.pagehide({ persisted:false });
  assert.equal(page.events.cleared, 7);
});

test('preview mode renders sample data without any network request', async () => {
  const page = harness({ preview:true });
  await flush();
  assert.equal(page.requests.length, 0);
  assert.equal(page.events.tick, undefined);
  assert.match(page.node('dashboardStats').innerHTML, /유통 중/);
  assert.match(page.node('dashboardWallets').innerHTML, /가게/);
  assert.match(page.node('dashboardTransfers').innerHTML, /회수/);
});

test('a missing token address and an RPC failure show plain operator messages', async () => {
  const unconfigured = harness({ token:{ ...TOKEN, address:null } });
  await flush();
  assert.equal(unconfigured.requests.length, 0);
  assert.equal(unconfigured.node('dashboardStatus').hidden, false);
  assert.match(unconfigured.node('dashboardStatus').textContent, /발행된 wMST 주소가 아직 설정되지 않았어요/);
  const failing = harness({ fail:true });
  await flush();
  assert.match(failing.node('dashboardStatus').textContent, /현황을 불러오지 못했어요/);
  assert.doesNotMatch(failing.node('dashboardStatus').textContent, /RPC|eth_/);
});
