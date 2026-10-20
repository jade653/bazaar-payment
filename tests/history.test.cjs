'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../transaction-history.js');
const UI = require('../payment-ui.js');
const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('a balance refresh can reload history for the same account', async () => {
  let calls = 0;
  const history = History.create({ query:async () => [++calls] });
  await history.load(a); await history.load(a);
  assert.equal(calls, 2);
  assert.deepEqual(history.snapshot().items, [2]);
});
test('late responses cannot expose the previous account history', async () => {
  const first = deferred(), second = deferred();
  const history = History.create({ query:account => account === a ? first.promise : second.promise });
  const pendingA = history.load(a), pendingB = history.load(b);
  second.resolve(['B']); await pendingB;
  first.resolve(['A']); await pendingA;
  assert.equal(history.snapshot().account, b);
  assert.deepEqual(history.snapshot().items, ['B']);
});
test('disconnect clears history and invalidates in-flight responses', async () => {
  const response = deferred(), history = History.create({ query:() => response.promise });
  const task = history.load(a); history.clear(); response.resolve(['old']); await task;
  assert.deepEqual(history.snapshot(), { account:null, items:[], loading:false, error:'' });
});
test('history failure is distinct from empty history and remains retryable', async () => {
  let failed = true;
  const history = History.create({ query:async () => { if (failed) throw new Error('RPC'); return []; } });
  await history.load(a);
  assert.match(UI.history(history.snapshot()), /불러오지 못했어요/);
  assert.doesNotMatch(UI.history(history.snapshot()), /아직 거래 내역이 없어요/);
  failed = false; await history.load(a);
  assert.equal(history.snapshot().error, '');
  assert.match(UI.history(history.snapshot()), /아직 거래 내역이 없어요/);
});

test('RPC history respects the row limit and does not turn missing balances into zero', async () => {
  let missing = false;
  const fetchImpl = async (_url, { body }) => ({ ok:true, json:async () => JSON.parse(body).map(call => ({
    id:call.id, result:call.method === 'eth_blockNumber' ? '0x2'
      : call.method === 'eth_getBlockByNumber' ? { number:call.params[0], timestamp:'0x1', transactions:[{ hash:call.params[0], from:a, to:b, value:'0x1' }] }
      : missing ? null : '0x5'
  })) });
  const result = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', blockWindow:2, limit:1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].balanceWei, 5n);
  missing = true;
  await assert.rejects(History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', blockWindow:2, limit:1 }), { code:'HISTORY_UNAVAILABLE' });
});
