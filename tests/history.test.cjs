'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../transaction-history.js');
const UI = require('../payment-ui.js');
const { TEST_TOKEN, topicOf, transferLog } = require('./fixtures.cjs');
const token = TEST_TOKEN;
const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const result = (items = []) => ({items,lastScannedBlock:1,balanceWei:'0',settledHashes:[]});
const timestamp = () => Math.floor(Date.now()/1000);

test('a balance refresh can reload history for the same account', async () => {
  let calls = 0;
  const history = History.create({ query:async () => result([row(++calls,timestamp())]) });
  await history.load(a); await history.load(a);
  assert.equal(calls, 2);
  assert.deepEqual(history.snapshot().items.map(item => item.hash).sort(), [row(1,timestamp()).hash,row(2,timestamp()).hash]);
});
test('late responses cannot expose the previous account history', async () => {
  const first = deferred(), second = deferred();
  const history = History.create({ query:account => account === a ? first.promise : second.promise });
  const pendingA = history.load(a), pendingB = history.load(b);
  second.resolve(result([row(2,timestamp())])); await pendingB;
  first.resolve(result([row(1,timestamp())])); await pendingA;
  assert.equal(history.snapshot().account, b);
  assert.equal(history.snapshot().items[0].hash,row(2,timestamp()).hash);
});
test('disconnect clears history and invalidates in-flight responses', async () => {
  const response = deferred(), history = History.create({ query:() => response.promise });
  const task = history.load(a); history.clear(); response.resolve(result([row(1,timestamp())])); await task;
  assert.deepEqual(history.snapshot(), { account:null, items:[], loading:false, error:'' });
});
test('history failure is distinct from empty history and remains retryable', async () => {
  let failed = true;
  const history = History.create({ query:async () => { if (failed) throw new Error('RPC'); return result(); } });
  await history.load(a);
  assert.match(UI.history(history.snapshot()), /불러오지 못했어요/);
  assert.doesNotMatch(UI.history(history.snapshot()), /아직 거래 내역이 없어요/);
  failed = false; await history.load(a);
  assert.equal(history.snapshot().error, '');
  assert.match(UI.history(history.snapshot()), /아직 거래 내역이 없어요/);
});

// Minimal JSON-RPC mock for the log reader: logs keyed by direction, headers, head balance.
function rpcMock({ latest = '0x2', outgoing = [], incoming = [], balance = '0x5', headers = {}, receipts = {}, calls = [] } = {}) {
  return async (_url, { body }) => ({ ok:true, json:async () => JSON.parse(body).map(call => {
    calls.push(call);
    let result = null;
    if (call.method === 'eth_blockNumber') result = latest;
    else if (call.method === 'eth_getLogs') result = call.params[0].topics[1] ? outgoing : incoming;
    else if (call.method === 'eth_getBlockByNumber') result = { number:call.params[0], timestamp:headers[call.params[0]] || call.params[0] };
    else if (call.method === 'eth_call') result = balance;
    else if (call.method === 'eth_getTransactionReceipt') result = receipts[call.params[0]] ?? null;
    return { id:call.id, result };
  }) });
}

test('wMST history reads Transfer logs for both directions and derives every row balance from the head balance', async () => {
  const calls = [];
  const fetchImpl = rpcMock({ calls, latest:'0x3', balance:'0x5',
    outgoing:[transferLog({ from:a, to:b, value:1, blockNumber:'0x3', hash:'0x'+'1'.repeat(64) })],
    incoming:[transferLog({ from:b, to:a, value:5, blockNumber:'0x1', hash:'0x'+'2'.repeat(64) }), transferLog({ from:b, to:a, value:2, blockNumber:'0x2', hash:'0x'+'3'.repeat(64) })] });
  const loaded = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', token, blockWindow:3 });
  assert.deepEqual(loaded.items.map(item => [item.direction, item.valueWei, item.balanceWei, item.timestamp]), [['out',1n,5n,3],['in',2n,6n,2],['in',5n,4n,1]]);
  assert.equal(loaded.items[0].counterparty, b);
  assert.equal(loaded.balanceWei, '5');
  assert.equal(loaded.lastScannedBlock, 3);
  const logCalls = calls.filter(call => call.method === 'eth_getLogs');
  assert.equal(logCalls.length, 2);
  assert.deepEqual(logCalls.map(call => call.params[0].topics), [[token.transferTopic, topicOf(a)], [token.transferTopic, null, topicOf(a)]]);
  assert.equal(logCalls[0].params[0].address, token.address);
  assert.deepEqual([logCalls[0].params[0].fromBlock, logCalls[0].params[0].toBlock], ['0x1', '0x3']);
  const pinned = calls.find(call => call.method === 'eth_call');
  assert.equal(pinned.params[1], '0x3');
  assert.equal(pinned.params[0].data, token.selectors.balanceOf + a.slice(2).padStart(64, '0'));
  assert.match(UI.history(loaded), /\+5 MST/);
  assert.doesNotMatch(UI.history(loaded), /<span>—<\/span>/);
});

test('removed logs, other contracts and foreign topics are ignored; long ranges are read in chunks', async () => {
  const calls = [];
  const other = transferLog({ from:b, to:a, value:9, address:'0x'+'d'.repeat(40) });
  const removed = transferLog({ from:b, to:a, value:9, removed:true, hash:'0x'+'4'.repeat(64) });
  const foreign = { ...transferLog({ from:b, to:a, value:9, hash:'0x'+'5'.repeat(64) }), topics:['0x'+'e'.repeat(64), topicOf(b), topicOf(a)] };
  const fetchImpl = rpcMock({ calls, latest:'0x186a1', balance:'0x1', incoming:[other, removed, foreign, transferLog({ from:b, to:a, value:1, hash:'0x'+'6'.repeat(64) })] });
  const loaded = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', token:{ ...token, deployBlock:0 }, fromBlock:0 });
  assert.equal(loaded.items.length, 1);
  const ranges = calls.filter(call => call.method === 'eth_getLogs' && !call.params[0].topics[1]).map(call => [Number(BigInt(call.params[0].fromBlock)), Number(BigInt(call.params[0].toBlock))]);
  assert.deepEqual(ranges, [[0,49999],[50000,99999],[100000,100001]]);
});

test('the scan never starts before the token deployment block and refuses an unconfigured token', async () => {
  const calls = [];
  await History.recentTransfers(rpcMock({ calls, latest:'0x64' }), { account:a, rpcUrl:'mock', token:{ ...token, deployBlock:90 }, blockWindow:50 });
  assert.equal(calls.find(call => call.method === 'eth_getLogs').params[0].fromBlock, '0x5a');
  await assert.rejects(History.recentTransfers(rpcMock(), { account:a, rpcUrl:'mock', token:{ ...token, address:null } }), { code:'TOKEN_NOT_CONFIGURED' });
  await assert.rejects(History.recentTransfers(rpcMock({ balance:'0x' }), { account:a, rpcUrl:'mock', token }), { code:'HISTORY_UNAVAILABLE' });
});

function memoryStorage(){
  const data=new Map();
  return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),data};
}
const row=(id,timestamp)=>({hash:'0x'+id.toString(16).padStart(64,'0'),blockNumber:'0x1',timestamp,direction:'in',valueWei:5500n,balanceWei:6500n});

test('local history survives reload, stays visible during RPC loading/errors and merges without duplicates', async () => {
  const storage=memoryStorage(), now=()=>2000000000000, timestamp=now()/1000;
  const options={storage,chainId:'0x1db1',now,limit:5};
  const original=History.create({...options,query:async()=>result([row(1,timestamp-100)])});
  await original.load(a);
  assert.equal(storage.data.size,1);
  assert.equal(typeof JSON.parse([...storage.data.values()][0]).items[0].valueWei,'string');
  const pending=deferred();
  const reopened=History.create({...options,query:()=>pending.promise});
  const task=reopened.load(a);
  assert.equal(reopened.snapshot().loading,true);
  assert.equal(reopened.snapshot().items[0].valueWei,5500n);
  assert.match(UI.history(reopened.snapshot()),/\+5,500 MST/);
  assert.match(UI.history(reopened.snapshot()),/최근 내역을 확인/);
  pending.resolve(result([row(2,timestamp),{...row(1,timestamp-100),balanceWei:null}]));
  await task;
  assert.deepEqual(reopened.snapshot().items.map(item=>item.hash),[row(2,timestamp).hash,row(1,timestamp).hash]);
  assert.equal(reopened.snapshot().items[1].balanceWei,6500n);
  const offline=History.create({...options,query:async()=>{throw new Error('offline');}});
  await offline.load(a);
  assert.equal(offline.snapshot().items.length,2);
  assert.match(UI.history(offline.snapshot()),/\+5,500 MST/);
  assert.match(UI.history(offline.snapshot()),/불러오지 못했어요/);
});

test('local history is isolated by account and chain, expires after 24 hours and stays bounded', async () => {
  const storage=memoryStorage(); let milliseconds=2000000000000;
  const options={storage,chainId:'0x1db1',now:()=>milliseconds,limit:5};
  const history=History.create({...options,query:async()=>result(Array.from({length:205},(_,index)=>row(index+1,milliseconds/1000-index)))});
  await history.load(a);
  assert.equal(history.snapshot().items.length,5);
  assert.equal(JSON.parse([...storage.data.values()][0]).items.length,200);
  const other=History.create({...options,query:async()=>result()});
  await other.load(b); assert.deepEqual(other.snapshot().items,[]);
  const otherChain=History.create({...options,chainId:'0x1',query:async()=>result()});
  await otherChain.load(a); assert.deepEqual(otherChain.snapshot().items,[]);
  milliseconds+=86401000;
  const expired=History.create({...options,query:async()=>result()});
  await expired.load(a); assert.deepEqual(expired.snapshot().items,[]);
});

test('corrupt or disabled local storage cannot break RPC history or mix accounts', async () => {
  const options={chainId:'0x1db1',now:()=>2000000000000,query:async()=>result([row(1,2000000000)])};
  for(const storage of [{getItem:()=>'{broken',setItem(){}},{getItem(){throw new Error('blocked');},setItem(){throw new Error('quota');}}]){
    const history=History.create({...options,storage});
    await history.load(a);
    assert.equal(history.snapshot().items.length,1);
    assert.equal(history.snapshot().error,'');
  }
});

test('native-era caches from the previous storage version are ignored and left untouched', async () => {
  const storage = memoryStorage(), now = () => 2000000000000;
  const legacy = JSON.stringify({items:[row(1,now()/1000)],lastScannedBlock:1,balanceWei:'1000000000000000000',checkedAt:now(),settledHashes:[]}, (_key,value) => typeof value === 'bigint' ? value.toString() : value);
  storage.setItem('bazaar-sync-v1:0x1db1:' + a, legacy);
  storage.setItem('bazaar-history-v1:0x1db1:' + a, '[]');
  const history = History.create({storage,now,chainId:'0x1db1',query:async (_account, request) => { assert.equal(request.fromBlock, undefined); return result([row(2,now()/1000)]); }});
  const task = history.load(a);
  assert.deepEqual(history.snapshot().items, []);
  await task;
  assert.deepEqual(history.snapshot().items.map(item => item.hash), [row(2,now()/1000).hash]);
  assert.equal(storage.getItem('bazaar-sync-v1:0x1db1:' + a), legacy);
  assert.equal(JSON.parse(storage.getItem('bazaar-sync-v2:0x1db1:' + a)).items.length, 1);
});

test('unchanged balances skip history across reloads; changed, timed and manual checks use the cursor', async () => {
  const storage = memoryStorage(); let time = 2000000000000, calls = [];
  const options = {storage, chainId:'0x1db1', now:() => time, query:async (_account, request) => {
    calls.push(request);
    return {items:[row(calls.length,time/1000)],lastScannedBlock:100 + calls.length,balanceWei:calls.length === 1 ? '10' : '20'};
  }};
  const first = History.create(options);
  await first.load(a,{balanceWei:'10'});
  const reopened = History.create(options);
  await reopened.load(a,{balanceWei:'10'});
  assert.equal(calls.length,1);
  assert.equal(reopened.snapshot().items.length,1);
  await reopened.load(a,{balanceWei:'20'});
  assert.equal(calls[1].fromBlock,102);
  time += 60000;
  await reopened.load(a,{balanceWei:'20'});
  assert.equal(calls[2].fromBlock,103);
  await reopened.load(a,{balanceWei:'20',force:true});
  assert.equal(calls[3].fromBlock,104);
});

test('failed scans and balance-only checks never advance the completed cursor', async () => {
  const storage = memoryStorage(), calls = []; let fail = false;
  const history = History.create({storage,chainId:'0x1db1',query:async (_account,request) => {
    calls.push(request);
    if (fail) throw new Error('interrupted range');
    return {items:[],lastScannedBlock:100,balanceWei:'10'};
  }});
  await history.load(a,{balanceWei:'10'});
  await history.load(a,{balanceWei:'10'});
  assert.equal(calls.length,1);
  fail = true;
  await history.load(a,{balanceWei:'11'});
  await history.load(a,{balanceWei:'11'});
  assert.equal(calls[1].fromBlock,101);
  assert.equal(calls[2].fromBlock,101);
  assert.match(history.snapshot().error,/불러오지/);
});

test('outgoing hashes survive reload and trigger history even when balance is unchanged', async () => {
  const storage = memoryStorage(), now = () => 2000000000000;
  const hash = row(1,now()/1000).hash; let calls = 0;
  const options = {storage,chainId:'0x1db1',now,query:async (_account,request) => {
    calls++;
    if (calls > 1) assert.deepEqual(request.sent.map(item => item.hash),[hash]);
    return {items:[],lastScannedBlock:100,balanceWei:'10',settledHashes:calls > 1 ? [hash] : []};
  }};
  await History.create(options).load(a,{balanceWei:'10'});
  History.recordSent({storage,chainId:'0x1db1',account:a,hash,now});
  History.recordSent({storage,chainId:'0x1db1',account:a,hash,now});
  assert.equal(History.sentTransactions({storage,chainId:'0x1db1',account:a,now}).length,1);
  assert.equal(History.sentTransactions({storage,chainId:'0x1',account:a,now}).length,0);
  assert.equal(History.sentTransactions({storage,chainId:'0x1db1',account:b,now}).length,0);
  const reopened = History.create(options);
  await reopened.load(a,{balanceWei:'10'});
  await reopened.load(a,{balanceWei:'10'});
  assert.equal(calls,2);
});

test('incremental scans continue from the cursor and pin the balance to the scanned head block', async () => {
  const calls = [];
  const incoming = [101,102,103].map(number => transferLog({ from:b, to:a, value:1, blockNumber:'0x'+number.toString(16), hash:'0x'+number.toString(16).padStart(64,'0') }));
  const result = await History.recentTransfers(rpcMock({ calls, latest:'0x67', balance:'0xa', incoming }), { account:a, rpcUrl:'mock', token, fromBlock:101 });
  const range = calls.find(call => call.method === 'eth_getLogs').params[0];
  assert.deepEqual([range.fromBlock, range.toBlock], ['0x65','0x67']);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items.map(item => item.balanceWei), [10n, 9n, 8n]);
  assert.equal(result.lastScannedBlock, 103);
  assert.equal(result.balanceWei, '10');
  assert.equal(calls.find(call => call.method === 'eth_call').params[1], '0x67');
});

test('known outgoing hashes recover older confirmed transfers from receipts and keep pending hashes unresolved', async () => {
  const hash = row(1,1).hash, pending = row(2,1).hash, failed = row(3,1).hash;
  const receipts = {
    [hash]:{ status:'0x1', blockNumber:'0x1', transactionHash:hash, logs:[transferLog({ from:a, to:b, value:5, blockNumber:'0x1', hash })] },
    [failed]:{ status:'0x0', blockNumber:'0x1', transactionHash:failed, logs:[] }
  };
  const result = await History.recentTransfers(rpcMock({ latest:'0x64', balance:'0xa', receipts }), { account:a, rpcUrl:'mock', token, fromBlock:101, sent:[{hash},{hash:pending},{hash:failed}] });
  assert.deepEqual(result.settledHashes, [hash, failed]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].valueWei, 5n);
  assert.equal(result.items[0].direction, 'out');
  assert.equal(result.items[0].balanceWei, null);
  assert.equal(result.lastScannedBlock, 100);
});

test('queued refreshes cannot restore an account that was switched away', async () => {
  const pending = deferred(); let calls = 0;
  const history = History.create({query:account => { calls++; return account === a ? pending.promise : result(); }});
  const first = history.load(a,{balanceWei:'1'});
  await new Promise(setImmediate);
  const queued = history.load(a,{balanceWei:'2'});
  await history.load(b,{balanceWei:'0'});
  pending.resolve(result()); await first; await queued;
  assert.equal(history.snapshot().account,b);
  assert.equal(calls,2);
});

test('first history failure retries silently and only the second failure exposes retry UI', async () => {
  let rejectSecond, calls = 0;
  const second = new Promise((_, reject) => { rejectSecond = reject; });
  const snapshots = [];
  const history = History.create({onChange:state => snapshots.push(state),query:() => {
    calls++;
    if (calls === 1) return Promise.reject(new Error('first failure'));
    return second;
  }});
  const pending = history.load(a);
  await new Promise(setImmediate);
  assert.equal(calls,2);
  assert.equal(history.snapshot().loading,true);
  assert.ok(snapshots.every(state => !state.error));
  assert.doesNotMatch(UI.history(history.snapshot()),/data-history-refresh/);
  rejectSecond(new Error('second failure'));
  await pending;
  assert.equal(calls,2);
  assert.equal(history.snapshot().loading,false);
  assert.match(UI.history(history.snapshot()),/data-history-refresh>다시 확인/);
});

test('a successful silent retry publishes new history without exposing an error', async () => {
  let calls = 0; const snapshots = [];
  const history = History.create({onChange:state => snapshots.push(state),query:async () => {
    if (++calls === 1) throw new Error('temporary failure');
    return result();
  }});
  await history.load(a);
  assert.equal(calls,2);
  assert.ok(snapshots.every(state => !state.error));
  assert.equal(history.snapshot().loading,false);
});

test('failed refresh keeps cache and cursor, survives reload and cannot be skipped for equal balances', async () => {
  const storage = memoryStorage(), now = () => 2000000000000;
  const original = History.create({storage,now,chainId:'0x1db1',query:async () => ({items:[row(1,now()/1000)],lastScannedBlock:100,balanceWei:'10'})});
  await original.load(a,{balanceWei:'10'});
  const key = 'bazaar-sync-v1:0x1db1:' + a, before = storage.data.get(key);
  let calls = 0;
  const failing = History.create({storage,now,chainId:'0x1db1',query:async () => { calls++; throw new Error('offline'); }});
  await failing.load(a,{balanceWei:'10',force:true});
  assert.equal(calls,2);
  assert.equal(storage.data.get(key),before);
  assert.equal(failing.snapshot().items.length,1);
  const response = deferred(); let request;
  const reopened = History.create({storage,now,chainId:'0x1db1',query:async (_account,options) => { request = options; return response.promise; }});
  const task = reopened.load(a,{balanceWei:'10'});
  await new Promise(setImmediate);
  assert.equal(request.fromBlock,101);
  assert.match(reopened.snapshot().error,/불러오지/);
  assert.match(UI.history(reopened.snapshot()),/data-history-refresh disabled/);
  response.resolve({items:[],lastScannedBlock:101,balanceWei:'10'});
  await task;
  assert.equal(reopened.snapshot().error,'');
  assert.doesNotMatch(UI.history(reopened.snapshot()),/data-history-refresh/);
});

for (const stage of ['fetch','body']) {
  test(`history request times out during ${stage} even if the request ignores abort`, async () => {
    let signal;
    const fetchImpl = async (_url, options) => {
      signal = options.signal;
      if (stage === 'fetch') return new Promise(() => {});
      return {ok:true,json:() => new Promise(() => {})};
    };
    await assert.rejects(History.recentTransfers(fetchImpl,{account:a,rpcUrl:'mock',token,requestTimeout:5}),{code:'HISTORY_TIMEOUT'});
    assert.equal(signal.aborted,true);
  });
}

test('two timed-out attempts release the active request so manual retry can succeed', async () => {
  let calls = 0, available = false;
  const history = History.create({query:() => {
    calls++;
    if (available) return result();
    return History.recentTransfers(async () => new Promise(() => {}),{account:a,rpcUrl:'mock',token,requestTimeout:5});
  }});
  await history.load(a);
  assert.equal(calls,2);
  assert.match(history.snapshot().error,/불러오지/);
  available = true;
  await history.load(a,{force:true});
  assert.equal(calls,3);
  assert.equal(history.snapshot().error,'');
});

test('switching accounts after a failure cancels the old account silent retry', async () => {
  let rejectFirst; const calls = [];
  const first = new Promise((_,reject) => { rejectFirst = reject; });
  const history = History.create({query:account => { calls.push(account); return account === a ? first : result(); }});
  const pending = history.load(a);
  await new Promise(setImmediate);
  await history.load(b);
  rejectFirst(new Error('old account failure'));
  await pending;
  assert.deepEqual(calls,[a,b]);
  assert.equal(history.snapshot().account,b);
  assert.equal(history.snapshot().error,'');
});
