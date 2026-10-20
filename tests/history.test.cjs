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
      : call.method === 'eth_getTransactionReceipt' ? {status:'0x1'} : missing ? null : '0x5'
  })) });
  const result = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', blockWindow:2, limit:1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].balanceWei, 5n);
  missing = true;
  const unavailable = await History.recentTransfers(fetchImpl, { account:a, rpcUrl:'mock', blockWindow:2, limit:1 });
  assert.equal(unavailable.length,1);
  assert.equal(unavailable[0].balanceWei,null);
  assert.match(UI.history({items:unavailable}), /<span>—<\/span>/);
  assert.doesNotMatch(UI.history({items:unavailable}), /불러오지 못했어요/);
});

test('missing trie node on one historical balance keeps every confirmed transfer visible', async () => {
  const hashes=['0x'+'a'.repeat(64),'0x'+'b'.repeat(64)];
  const fetchImpl=async(_url,{body})=>({ok:true,json:async()=>JSON.parse(body).map(call=>{
    if(call.method==='eth_getBalance' && call.params[1]==='0x1')return {id:call.id,error:{code:-32000,message:'missing trie node'}};
    return {id:call.id,result:call.method==='eth_blockNumber'?'0x2':call.method==='eth_getBlockByNumber'
      ?{number:call.params[0],timestamp:call.params[0],transactions:[{hash:hashes[Number(BigInt(call.params[0]))-1],from:a,to:b,value:'0x1'}]}
      :call.method==='eth_getTransactionReceipt'?{status:'0x1'}:'0x9'};
  })});
  const items=await History.recentTransfers(fetchImpl,{account:b,rpcUrl:'mock',blockWindow:2});
  assert.equal(items.length,2);
  assert.equal(items[0].balanceWei,9n);
  assert.equal(items[1].balanceWei,null);
});

test('reverted transactions do not occupy the history limit or get cached as money received', async () => {
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
  const items=await History.recentTransfers(fetchImpl,{account:b,rpcUrl:'mock',blockWindow:101,limit:1});
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
  const original=History.create({...options,query:async()=>[row(1,timestamp-100)]});
  await original.load(a);
  assert.equal(storage.data.size,1);
  assert.equal(typeof JSON.parse([...storage.data.values()][0])[0].valueWei,'string');
  const pending=deferred();
  const reopened=History.create({...options,query:()=>pending.promise});
  const task=reopened.load(a);
  assert.equal(reopened.snapshot().loading,true);
  assert.equal(reopened.snapshot().items[0].valueWei,5500000000000000000n);
  assert.match(UI.history(reopened.snapshot()),/\+5\.5 MST/);
  assert.match(UI.history(reopened.snapshot()),/최근 내역을 확인/);
  pending.resolve([row(2,timestamp),{...row(1,timestamp-100),balanceWei:null}]);
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
  const history=History.create({...options,query:async()=>Array.from({length:205},(_,index)=>row(index+1,milliseconds/1000-index))});
  await history.load(a);
  assert.equal(history.snapshot().items.length,5);
  assert.equal(JSON.parse([...storage.data.values()][0]).length,200);
  const other=History.create({...options,query:async()=>[]});
  await other.load(b); assert.deepEqual(other.snapshot().items,[]);
  const otherChain=History.create({...options,chainId:'0x1',query:async()=>[]});
  await otherChain.load(a); assert.deepEqual(otherChain.snapshot().items,[]);
  milliseconds+=86401000;
  const expired=History.create({...options,query:async()=>[]});
  await expired.load(a); assert.deepEqual(expired.snapshot().items,[]);
});

test('corrupt or disabled local storage cannot break RPC history or mix accounts', async () => {
  const options={chainId:'0x1db1',now:()=>2000000000000,query:async()=>[row(1,2000000000)]};
  for(const storage of [{getItem:()=>'{broken',setItem(){}},{getItem(){throw new Error('blocked');},setItem(){throw new Error('quota');}}]){
    const history=History.create({...options,storage});
    await history.load(a);
    assert.equal(history.snapshot().items.length,1);
    assert.equal(history.snapshot().error,'');
  }
});
