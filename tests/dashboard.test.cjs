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
const treasury = '0x' + 'a'.repeat(40), operator2 = '0x' + 'b'.repeat(40), alice = '0x' + '1'.repeat(40), bob = '0x' + '2'.repeat(40), store = '0x' + '5'.repeat(40);
const tokenAddress = '0x' + 'c'.repeat(40);
const TOKEN = { ...Wallet.TOKEN, address:tokenAddress, deployBlock:100, operatorWallets:[operator2] };
const pad = address => '0x' + address.slice(2).padStart(64, '0');
const hex = number => '0x' + number.toString(16);
function log(block, index, from, to, value, removed = false) {
  return { address:tokenAddress, blockNumber:hex(block), logIndex:hex(index), transactionHash:'0x' + (block * 10 + index).toString(16).padStart(64, '0'), removed, topics:[TOPIC, pad(from), pad(to)], data:'0x' + value.toString(16).padStart(64, '0') };
}
const logs = [
  log(100, 0, ZERO, treasury, 1000000000n),
  log(105, 0, treasury, operator2, 100000n),
  log(110, 0, treasury, alice, 20000n),
  log(112, 0, operator2, bob, 50000n),
  log(120, 0, alice, store, 7500n),
  log(125, 0, bob, store, 12000n),
  log(128, 0, store, treasury, 19500n),
  log(130, 0, bob, operator2, 38000n),
  log(131, 0, treasury, alice, 10000n),
  log(132, 0, treasury, bob, 99999n, true)
];

test('aggregate numbers wallets by first top-up and tracks top-ups, usage and recoveries against every operator wallet', () => {
  const summary = Dashboard.aggregate(logs, { operators:[operator2], stores:[store] });
  assert.equal(summary.treasury, treasury);
  assert.deepEqual(summary.operators, [treasury, operator2]);
  assert.equal(summary.totalSupply, 1000000000n);
  assert.equal(summary.toppedUp, 80000n); assert.equal(summary.topUpCount, 3);
  assert.equal(summary.recovered, 57500n); assert.equal(summary.recoveryCount, 2);
  assert.equal(summary.paymentCount, 2);
  assert.equal(summary.storeCount, 1);
  assert.deepEqual(summary.wallets.map(item => [item.address, item.number, item.isOperator, item.isStore]), [[treasury, null, true, false], [operator2, null, true, false], [store, null, false, true], [alice, 1, false, false], [bob, 2, false, false]], 'operators first, then stores, then customers in first top-up order');
  assert.equal(summary.walletCount, 3, 'operator wallets are listed but not counted as wallets');
  const byAddress = Object.fromEntries(summary.wallets.map(item => [item.address, item]));
  assert.equal(byAddress[alice].balance, 22500n); assert.equal(byAddress[alice].toppedUp, 30000n); assert.equal(byAddress[alice].sent, 7500n); assert.equal(byAddress[alice].recoveredFlag, false); assert.equal(byAddress[alice].lastBlock, 131);
  assert.equal(byAddress[bob].balance, 0n); assert.equal(byAddress[bob].sent, 50000n); assert.equal(byAddress[bob].recovered, 38000n); assert.equal(byAddress[bob].recoveredFlag, true); assert.equal(byAddress[bob].transferCount, 3);
  assert.equal(byAddress[treasury].balance, 999889500n); assert.equal(byAddress[treasury].sent, 130000n); assert.equal(byAddress[treasury].received, 19500n); assert.equal(byAddress[treasury].transferCount, 4);
  assert.equal(byAddress[operator2].balance, 88000n); assert.equal(byAddress[operator2].sent, 50000n); assert.equal(byAddress[operator2].received, 138000n); assert.equal(byAddress[operator2].lastBlock, 130);
  assert.equal(byAddress[store].received, 19500n); assert.equal(byAddress[store].sent, 19500n); assert.equal(byAddress[store].recoveredFlag, true); assert.equal(byAddress[store].lastBlock, 128);
  assert.deepEqual(summary.transfers.map(item => item.type), ['충전', '회수', '회수', '송금', '송금', '충전', '충전', '이동'], 'operator-to-operator moves are listed as 이동');
  assert.equal(summary.toppedUp, 80000n, 'moves between operators are not top-ups');
  assert.ok(!summary.transfers.some(item => item.value === 99999n), 'removed logs are ignored');
  // 회수 needs the send to an operator to empty the wallet, and a later top-up or receipt clears it.
  const carol = '0x' + '3'.repeat(40), dave = '0x' + '4'.repeat(40);
  const later = Dashboard.aggregate([...logs,
    log(140, 0, treasury, carol, 5000n), log(141, 0, carol, treasury, 2000n),
    log(142, 0, treasury, dave, 3000n), log(143, 0, dave, operator2, 3000n), log(144, 0, treasury, dave, 1000n),
    log(145, 0, alice, store, 1000n)
  ], { operators:[operator2], stores:[store] });
  const flag = address => later.wallets.find(item => item.address === address).recoveredFlag;
  assert.equal(flag(carol), false, 'a partial send to the operator leaves a balance, so no tag');
  assert.equal(later.wallets.find(item => item.address === carol).recovered, 2000n);
  assert.equal(flag(dave), false, 'a top-up after an emptying send clears the tag');
  assert.equal(flag(bob), true, 'an emptied wallet with no later incoming keeps the tag');
  assert.equal(flag(store), false, 'receiving wMST after an emptying send clears the tag');
  const unmarked = Dashboard.aggregate(logs, { operators:[operator2] });
  assert.deepEqual(unmarked.wallets.map(item => [item.address, item.number]), [[treasury, null], [operator2, null], [alice, 1], [bob, 2], [store, null]], 'wallets without a top-up follow the numbered ones');
});

test('column sorts order by balance, usage, top-up or recency and the number sort restores the default list', () => {
  const summary = Dashboard.aggregate(logs, { operators:[operator2], stores:[store] });
  const by = options => Dashboard.sortWallets(summary.wallets, options).map(item => item.address);
  assert.deepEqual(by({ key:'balance', direction:'desc' }), [treasury, operator2, alice, store, bob]);
  assert.deepEqual(by({ key:'balance', direction:'asc' }), [store, bob, alice, operator2, treasury], 'ties keep the default order');
  assert.deepEqual(by({ key:'sent', direction:'desc' }), [treasury, operator2, bob, store, alice]);
  assert.deepEqual(by({ key:'toppedUp', direction:'desc' }), [bob, alice, treasury, operator2, store]);
  assert.deepEqual(by({ key:'recent', direction:'desc' }), [treasury, alice, operator2, bob, store]);
  assert.deepEqual(by({ key:'number' }), [treasury, operator2, store, alice, bob]);
});

test('mergeLogs dedupes by hash and log index, drops removed logs and keeps chain order', () => {
  const merged = Dashboard.mergeLogs(logs.slice(0, 4), [logs[3], logs[2], log(131, 0, treasury, alice, 10000n), log(133, 0, treasury, alice, 1n, true)]);
  assert.equal(merged.length, 5);
  assert.deepEqual(merged.map(item => Number(BigInt(item.blockNumber))), [100, 105, 110, 112, 131]);
  assert.equal(Dashboard.relativeTime(1000, 1000 * 1000 + 200000), '3분 전');
  assert.equal(Dashboard.relativeTime(undefined), '—');
  assert.equal(Dashboard.usedAt(new Date(2026, 9, 23, 14, 5, 59).getTime() / 1000), '23일 14:05', 'seconds are dropped, not rounded');
  assert.equal(Dashboard.usedAt(new Date(2026, 10, 3, 9, 7).getTime() / 1000), '3일 09:07');
  assert.equal(Dashboard.usedAt(undefined), '—');
  assert.equal(Dashboard.shortAddress(alice), '0x11111…11111');
});

function harness({ preview = false, token = TOKEN, fail = false, stored = null } = {}) {
  const nodes = new Map(), events = {}, requests = [], chain = { latest:140 }, saved = new Map();
  if (stored) saved.set(Dashboard.STORES_KEY, JSON.stringify(stored));
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, innerHTML:'', textContent:'', hidden:false, value:'', open:false, showModal() { this.open = true; }, close() { this.open = false; }, addEventListener(type, fn) { events[id + ':' + type] = fn; } });
    return nodes.get(id);
  };
  const gas = { [alice]:BigInt(token.gasPolicy.transferReserveWei) * 20n, [bob]:BigInt(token.gasPolicy.transferReserveWei) * 2n };
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
    localStorage:{ getItem:key => saved.get(key) ?? null, setItem:(key, value) => saved.set(key, value) },
    document:{ visibilityState:'visible', getElementById:node, addEventListener(type, fn) { events['document:' + type] = fn; } },
    navigator:{}, fetch, addEventListener(type, fn) { events[type] = fn; },
    setInterval(fn, ms) { events.tick = fn; events.tickMs = ms; return 7; }, clearInterval(id) { events.cleared = id; },
    BazaarWallet:{ ...Wallet, TOKEN:token }, BazaarTransfer:Transfer, BazaarUI:UI
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dashboard.js'), 'utf8'), context);
  const click = (id, dataset) => events[id + ':click']({ target:{ closest:selector => Object.keys(dataset).some(name => selector === `[data-${name}]`) ? { dataset:Object.fromEntries(Object.entries(dataset).map(([name, value]) => [name.replace(/-([a-z])/g, (_m, c) => c.toUpperCase()), value])) } : null } });
  return { context, node, events, requests, chain, saved, click, dashboard:() => context.BazaarDashboard.active };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

test('the dashboard renders four totals, the numbered wallet table and recent transfers from the RPC', async () => {
  const page = harness({ stored:[store] });
  await flush();
  const snapshot = page.dashboard().snapshot();
  assert.equal(snapshot.error, ''); assert.equal(snapshot.cursor, 140);
  const stats = page.node('dashboardStats').innerHTML;
  assert.match(stats, /충전 합계<\/span><strong>80,000<\/strong><small>3건/);
  assert.match(stats, /결제<\/span><strong>2건/);
  assert.match(stats, /지갑 수<\/span><strong>3개<\/strong><small>가게 1개/);
  assert.match(stats, /회수 합계<\/span><strong>57,500<\/strong><small>2건/);
  assert.doesNotMatch(stats, /유통 중|운영 지갑|수수료/);
  assert.equal((stats.match(/dashboard-card"/g) || []).length, 4);
  const wallets = page.node('dashboardWallets').innerHTML;
  assert.match(wallets, /<th class="num"><button type="button" data-sort="number" class="active">#<\/button><\/th><th>지갑 주소<\/th>/);
  assert.match(wallets, /data-sort="balance">잔액/); assert.match(wallets, /data-sort="sent">송금<\/button>/); assert.doesNotMatch(wallets, /사용 금액/); assert.match(wallets, /data-sort="toppedUp">충전/); assert.match(wallets, /data-sort="recent">최근 사용/);
  assert.match(wallets, /<th class="num"><button type="button" data-sort="recent">최근 사용/, 'the recency column is right-aligned like the amounts');
  const rows = wallets.match(/<tr data-wallet="[^"]+"[^>]*>.*?<\/tr>/g);
  assert.equal(rows.length, 5);
  assert.match(rows[0], /<span class="dashboard-chip operator">운영자<\/span><\/td><td><code>0xaaaaa…aaaaa<\/code><\/td><td class="num">999,889,500<\/td><td class="num">130,000<\/td>/);
  assert.match(rows[1], /<span class="dashboard-chip operator">운영자<\/span><\/td><td><code>0xbbbbb…bbbbb<\/code>/);
  assert.match(rows[2], /<span class="dashboard-chip store">가게<\/span><\/td><td><code>0x55555…55555<\/code><span class="dashboard-chip recovered">회수<\/span>/);
  assert.match(rows[3], /<td class="num">1<\/td><td><code>0x11111…11111<\/code><\/td><td class="num">22,500<\/td><td class="num">7,500<\/td><td class="num">30,000<\/td>/);
  assert.match(rows[4], /<td class="num">2<\/td><td><code>0x22222…22222<\/code><span class="dashboard-chip recovered">회수<\/span><\/td><td class="num">0<\/td><td class="num">50,000<\/td><td class="num">50,000<\/td>/);
  assert.doesNotMatch(wallets, /손님| MST/);
  assert.match(wallets, /<td class="time" title="[^"]+">\d{1,2}일 \d{2}:\d{2}<\/td>/, 'last use shows the actual day and time without seconds');
  assert.doesNotMatch(wallets, /분 전|시간 전|방금 전|일 전/);
  const transfers = page.node('dashboardTransfers').innerHTML;
  assert.match(transfers, /type-topup">충전/); assert.match(transfers, /type-payment">송금/); assert.doesNotMatch(transfers, /회수|결제/);
  assert.match(transfers, /<button type="button" class="dashboard-operator" data-wallet="0xa{40}" title="0xa{40}">운영자<code>aaaa<\/code><\/button>/); assert.match(transfers, />운영자<code>bbbb<\/code>/);
  assert.doesNotMatch(transfers, /0xaaaaa…|<em>운영<\/em>/, 'operator wallets show only the 운영자 label with four hex digits'); assert.match(transfers, /<em>가게<\/em>/); assert.match(transfers, /<strong>10,000<\/strong>/);
  assert.ok(!/eth_|RPC|_ERROR/.test(stats + wallets + transfers), 'no code-level identifiers in the UI');
  assert.equal(page.events.tickMs, Dashboard.REFRESH_INTERVAL);
  assert.equal(page.requests.filter(method => method === 'eth_getLogs').length, 1);
  assert.equal(page.requests.filter(method => method === 'eth_getBalance').length, 0, 'fee balances are read only for an opened wallet');
  // The magnifier opens the search field; closing it clears the filter.
  const searchInput = page.node('dashboardSearch');
  searchInput.hidden = true;
  page.events['dashboardSearchToggle:click']();
  assert.equal(searchInput.hidden, false);
  searchInput.value = '2222';
  page.events['dashboardSearch:input']({ target:searchInput });
  assert.doesNotMatch(page.node('dashboardWallets').innerHTML, /0x11111/);
  page.events['dashboardSearchToggle:click']();
  assert.equal(searchInput.hidden, true); assert.equal(searchInput.value, '');
  assert.match(page.node('dashboardWallets').innerHTML, /0x11111/);
  // Column sorts.
  page.click('dashboardWallets', { sort:'balance' });
  let order = page.node('dashboardWallets').innerHTML.match(/data-wallet="([^"]+)"/g);
  assert.deepEqual(order.map(item => item.slice(13, -1)), [treasury, operator2, alice, store, bob]);
  assert.match(page.node('dashboardWallets').innerHTML, /data-sort="balance" class="active">잔액 ↓/);
  page.click('dashboardWallets', { sort:'balance' });
  order = page.node('dashboardWallets').innerHTML.match(/data-wallet="([^"]+)"/g);
  assert.deepEqual(order.map(item => item.slice(13, -1)), [store, bob, alice, operator2, treasury]);
  page.click('dashboardWallets', { sort:'number' });
  order = page.node('dashboardWallets').innerHTML.match(/data-wallet="([^"]+)"/g);
  assert.deepEqual(order.map(item => item.slice(13, -1)), [treasury, operator2, store, alice, bob]);
  // Row tap opens the popup with the full address, totals, fee headroom and the store toggle.
  page.click('dashboardWallets', { wallet:alice });
  await flush();
  const dialog = page.node('dashboardDialog');
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /<strong>#1<\/strong>/);
  assert.match(dialog.innerHTML, new RegExp('<div class="dashboard-dialog-address"><code>' + alice + '</code><button type="button" class="dashboard-copy" data-dialog="copy" aria-label="주소 복사">복사</button></div>'));
  assert.match(dialog.innerHTML, /충전<\/dt><dd>30,000<\/dd>/); assert.match(dialog.innerHTML, /송금 금액<\/dt><dd>7,500<\/dd>/);
  assert.doesNotMatch(dialog.innerHTML, /사용 금액|받은 금액|운영자에게 보냄/);
  assert.match(dialog.innerHTML, /남은 수수료<\/dt><dd>약 20회<\/dd>/);
  assert.match(dialog.innerHTML, /<div class="dashboard-dialog-actions"><button type="button" class="operator-primary" data-dialog="toggle-store">가게로 설정<\/button><button type="button" class="operator-secondary" data-dialog="toggle-operator">운영자로 설정<\/button><\/div>/);
  assert.equal(page.requests.filter(method => method === 'eth_getBalance').length, 1);
  page.click('dashboardDialog', { dialog:'toggle-store' });
  assert.deepEqual(JSON.parse(page.saved.get(Dashboard.STORES_KEY)), [store, alice]);
  assert.match(page.node('dashboardDialog').innerHTML, /<strong>가게<\/strong>/);
  assert.match(page.node('dashboardDialog').innerHTML, /가게 해제</);
  order = page.node('dashboardWallets').innerHTML.match(/data-wallet="([^"]+)"/g);
  assert.deepEqual(order.map(item => item.slice(13, -1)), [treasury, operator2, alice, store, bob], 'a newly marked store moves above the numbered wallets');
  assert.match(page.node('dashboardStats').innerHTML, /가게 2개/);
  page.click('dashboardDialog', { dialog:'toggle-store' });
  assert.deepEqual(JSON.parse(page.saved.get(Dashboard.STORES_KEY)), [store]);
  // Marking a wallet as operator moves it out of the table and turns its transfers into 충전/회수.
  page.click('dashboardDialog', { dialog:'toggle-operator' });
  assert.deepEqual(JSON.parse(page.saved.get(Dashboard.OPERATORS_KEY)), [alice]);
  assert.deepEqual([...page.dashboard().snapshot().operators], [alice]);
  assert.match(page.node('dashboardWallets').innerHTML, new RegExp('<tr data-wallet="' + alice + '"[^>]*><td class="num"><span class="dashboard-chip operator">운영자</span>'), 'a marked operator stays in the list with the 운영자 chip');
  assert.match(page.node('dashboardDialog').innerHTML, /<strong>운영자 1111<\/strong>/);
  assert.match(page.node('dashboardDialog').innerHTML, /잔액<\/dt><dd>22,500<\/dd>/);
  assert.match(page.node('dashboardDialog').innerHTML, /data-dialog="toggle-operator">운영자 해제</);
  assert.match(page.node('dashboardTransfers').innerHTML, /data-wallet="0x1{40}"[^>]*>운영자<code>1111<\/code>/);
  assert.match(page.node('dashboardStats').innerHTML, /지갑 수<\/span><strong>2개/);
  page.click('dashboardDialog', { dialog:'toggle-operator' });
  assert.deepEqual(JSON.parse(page.saved.get(Dashboard.OPERATORS_KEY)), []);
  assert.match(page.node('dashboardDialog').innerHTML, /<strong>#1<\/strong>/, 'unmarking restores the numbered wallet');
  // A configured operator opens from 최근 거래 and cannot be unmarked.
  page.click('dashboardTransfers', { wallet:treasury });
  assert.match(page.node('dashboardDialog').innerHTML, /<strong>운영자 aaaa<\/strong>/);
  assert.doesNotMatch(page.node('dashboardDialog').innerHTML, /기본 운영 지갑|dashboard-dialog-note/, 'a configured operator shows no note');
  assert.doesNotMatch(page.node('dashboardDialog').innerHTML, /toggle-operator/);
  page.click('dashboardDialog', { dialog:'close' });
  assert.equal(dialog.open, false);
  // Incremental refresh.
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
  assert.match(page.node('dashboardStats').innerHTML, /충전 합계/);
  assert.match(page.node('dashboardWallets').innerHTML, /dashboard-chip store">가게/);
  assert.match(page.node('dashboardWallets').innerHTML, /dashboard-chip recovered">회수/);
  page.click('dashboardWallets', { wallet:'0x' + '2'.repeat(40) });
  await flush();
  assert.match(page.node('dashboardDialog').innerHTML, /남은 수수료<\/dt><dd>—<\/dd>/);
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
