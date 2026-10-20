'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('../transaction-history.js');
const UI = require('../payment-ui.js');
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

test('RPC history keeps transactions when historical balances are missing', async () => {
  let missing = false;
  const fetchImpl = async (_url, { body }) => ({ ok:true, json:async () => JSON.parse(body).map(call => ({
    id:call.id, result:call.method === 'eth_blockNumber' ? '0x2'
      : call.method === 'eth_getBlockByNumber' ? { number:call.params[0], timestamp:'0x1', transactions:[{ hash:call.params[0], from:a, to:b, value:'0x1' }] }
      : call.method === 'eth_getTransactionReceipt' ? {status:'0x1'} : missing && JSON.parse(body).length === 2 ? null : '0x5'
  })) });
  const loaded = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', blockWindow:2 });
  assert.equal(loaded.items.length, 2);
  assert.equal(loaded.items[0].balanceWei, 5n);
  missing = true;
  const unavailable = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', blockWindow:2 });
  assert.equal(unavailable.items.length,2);
  assert.equal(unavailable.items[0].balanceWei,null);
  assert.match(UI.history(unavailable), /<span>—<\/span>/);
  assert.doesNotMatch(UI.history(unavailable), /불러오지 못했어요/);
});

test('missing trie node on one historical balance keeps every confirmed transfer visible', async () => {
  const hashes=['0x'+'a'.repeat(64),'0x'+'b'.repeat(64)];
  const fetchImpl=async(_url,{body})=>({ok:true,json:async()=>JSON.parse(body).map(call=>{
    if(call.method==='eth_getBalance' && call.params[1]==='0x1')return {id:call.id,error:{code:-32000,message:'missing trie node'}};
    return {id:call.id,result:call.method==='eth_blockNumber'?'0x2':call.method==='eth_getBlockByNumber'
      ?{number:call.params[0],timestamp:call.params[0],transactions:[{hash:hashes[Number(BigInt(call.params[0]))-1],from:a,to:b,value:'0x1'}]}
      :call.method==='eth_getTransactionReceipt'?{status:'0x1'}:'0x9'};
  })});
  const {items}=await History.recentTransfers(fetchImpl,{account:b,rpcUrl:'mock',blockWindow:2});
  assert.equal(items.length,2);
  assert.equal(items[0].balanceWei,9n);
  assert.equal(items[1].balanceWei,null);
});

test('reverted transactions are excluded while the entire block range is scanned', async () => {
  let readBlocks=0;
  const failed='0x'+'a'.repeat(64), confirmed='0x'+'b'.repeat(64);
  const fetchImpl=async(_url,{body})=>({ok:true,json:async()=>JSON.parse(body).map(call=>{
    let result;
    if(call.method==='eth_blockNumber')result='0x65';
    else if(call.method==='eth_getBlockByNumber'){
      readBlocks++;
      const height=Number(BigInt(call.params[0]));
      result={number:call.params[0],timestamp:call.params[0],transactions:[101,1].includes(height)?[{hash:height===101?failed:confirmed,from:a,to:b,value:'0x1'}]:[]};
    }else if(call.method==='eth_getTransactionReceipt')result={status:call.params[0]===failed?'0x0':'0x1'};
    else result='0x0';
    return {id:call.id,result};
  })});
  const {items}=await History.recentTransfers(fetchImpl,{account:b,rpcUrl:'mock',blockWindow:101});
  assert.equal(readBlocks,101);
  assert.equal(items.length,1);
  assert.equal(items[0].hash,confirmed);
  assert.equal(items[0].balanceWei,0n);
});

function memoryStorage(){
  const data=new Map();
  return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),data};
}
const row=(id,timestamp)=>({hash:'0x'+id.toString(16).padStart(64,'0'),blockNumber:'0x1',timestamp,direction:'in',valueWei:5500000000000000000n,balanceWei:6500000000000000000n});

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
  assert.equal(reopened.snapshot().items[0].valueWei,5500000000000000000n);
  assert.match(UI.history(reopened.snapshot()),/\+5\.5 MST/);
  assert.match(UI.history(reopened.snapshot()),/최근 내역을 확인/);
  pending.resolve(result([row(2,timestamp),{...row(1,timestamp-100),balanceWei:null}]));
  await task;
  assert.deepEqual(reopened.snapshot().items.map(item=>item.hash),[row(2,timestamp).hash,row(1,timestamp).hash]);
  assert.equal(reopened.snapshot().items[1].balanceWei,6500000000000000000n);
  const offline=History.create({...options,query:async()=>{throw new Error('offline');}});
  await offline.load(a);
  assert.equal(offline.snapshot().items.length,2);
  assert.match(UI.history(offline.snapshot()),/\+5\.5 MST/);
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

test('existing v1 cache is migrated without writing the old storage format', async () => {
  const storage = memoryStorage(), now = () => 2000000000000;
  const legacyKey = 'bazaar-history-v1:0x1db1:' + a;
  const old = JSON.stringify([row(1,now()/1000)], (_key,value) => typeof value === 'bigint' ? value.toString() : value);
  storage.setItem(legacyKey,old);
  const history = History.create({storage,now,chainId:'0x1db1',query:async () => result([row(2,now()/1000)])});
  const task = history.load(a);
  assert.equal(history.snapshot().items[0].hash,row(1,now()/1000).hash);
  await task;
  assert.equal(history.snapshot().items.length,2);
  assert.equal(storage.getItem(legacyKey),old);
  const saved = JSON.parse(storage.getItem('bazaar-sync-v1:0x1db1:' + a));
  assert.equal(saved.items.length,2);
  assert.equal(saved.lastScannedBlock,1);
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

test('incremental scans cover every new block despite display limits and pin the balance', async () => {
  const blocks = [], balanceBlocks = [];
  const fetchImpl = async (_url,{body}) => ({ok:true,json:async () => JSON.parse(body).map(call => {
    let result;
    if (call.method === 'eth_blockNumber') result = '0x67';
    if (call.method === 'eth_getBlockByNumber') {
      blocks.push(Number(BigInt(call.params[0])));
      result = {number:call.params[0],timestamp:'0x1',transactions:[{hash:'0x'+BigInt(call.params[0]).toString(16).padStart(64,'0'),from:a,to:b,value:'0x1'}]};
    }
    if (call.method === 'eth_getTransactionReceipt') result = {status:'0x1'};
    if (call.method === 'eth_getBalance') { balanceBlocks.push(call.params[1]); result = '0xa'; }
    return {id:call.id,result};
  })});
  const result = await History.recentTransfers(fetchImpl,{account:a,rpcUrl:'mock',fromBlock:101});
  assert.deepEqual(blocks,[103,102,101]);
  assert.equal(result.items.length,3);
  assert.equal(result.lastScannedBlock,103);
  assert.equal(result.balanceWei,'10');
  assert.equal(balanceBlocks.at(-1),'0x67');
});

test('known outgoing hashes recover older confirmed transfers and keep pending hashes unresolved', async () => {
  const hash = row(1,1).hash, pending = row(2,1).hash;
  const fetchImpl = async (_url,{body}) => ({ok:true,json:async () => JSON.parse(body).map(call => {
    const result = call.method === 'eth_blockNumber' ? '0x64'
      : call.method === 'eth_getTransactionReceipt' ? call.params[0] === pending ? null : {status:'0x1',blockNumber:'0x1'}
      : call.method === 'eth_getTransactionByHash' ? {hash,from:a,to:b,value:'0x5'}
      : call.method === 'eth_getBlockByNumber' ? {number:'0x1',timestamp:'0x1',transactions:[]}
      : '0xa';
    return {id:call.id,result};
  })});
  const result = await History.recentTransfers(fetchImpl,{account:a,rpcUrl:'mock',fromBlock:101,sent:[{hash},{hash:pending}]});
  assert.deepEqual(result.settledHashes,[hash]);
  assert.equal(result.items[0].valueWei,5n);
  assert.equal(result.lastScannedBlock,100);
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
    await assert.rejects(History.recentTransfers(fetchImpl,{account:a,rpcUrl:'mock',requestTimeout:5}),{code:'HISTORY_TIMEOUT'});
    assert.equal(signal.aborted,true);
  });
}

test('two timed-out attempts release the active request so manual retry can succeed', async () => {
  let calls = 0, available = false;
  const history = History.create({query:() => {
    calls++;
    if (available) return result();
    return History.recentTransfers(async () => new Promise(() => {}),{account:a,rpcUrl:'mock',requestTimeout:5});
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
