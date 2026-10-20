'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const UI=require('../payment-ui.js');
const Transfer=require('../transfer-core.js');

test('saving and reopening a store preserves its name in the receiving QR', () => {
  const storage=new Map();
  function openStore(){
    const nodes=new Map(), events={}; let qrLink;
    const node=id=>{
      if(!nodes.has(id)) nodes.set(id,{innerHTML:'',value:'',querySelector:()=>node('balanceValue'),addEventListener(type,fn){events[id+':'+type]=fn;}});
      return nodes.get(id);
    };
    const context={
      URL, location:{href:'https://bazaar.mustree.kr/store.html?preview=1'},
      localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},
      document:{getElementById:node,addEventListener(){}},
      window:{BazaarWallet:{NETWORK:{chainId:'0x1db1'}},BazaarTransfer:Transfer,BazaarUI:{...UI,renderQr:(_target,link)=>{qrLink=link;}},BazaarHistory:require('../transaction-history.js'),addEventListener(){}}
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../store.js'),'utf8'),context);
    return {
      qr:()=>qrLink,
      save(name){node('storeName').value=name;events['storeScreen:click']({target:{closest:selector=>selector==='[data-store]'?{dataset:{store:'save-name'}}:null}});}
    };
  }
  const store=openStore();
  store.save(' 사랑 분식 ');
  assert.equal(new URL(store.qr()).searchParams.get('name'),'사랑 분식');
  assert.equal(Transfer.parseRecipient(store.qr())?.address,'0x'+'1'.repeat(40));
  const reopened=openStore();
  assert.equal(new URL(reopened.qr()).searchParams.get('name'),'사랑 분식');
  reopened.save('');
  assert.equal(new URL(reopened.qr()).searchParams.has('name'),false);
});
test('store entry opens the app synchronously after missing-wallet detection without rediscovery', () => {
  const nodes=new Map(), events={}, assigned=[];
  const node=id=>{
    if(!nodes.has(id)) nodes.set(id,{innerHTML:'',querySelector:()=>node('balanceValue'),addEventListener(type,fn){events[id+':'+type]=fn;}});
    return nodes.get(id);
  };
  const Wallet={
    NETWORK:{rpcUrls:[]}, createRpcBalanceReader(){return async()=>{};},
    discover(){return {getProvider(){throw new Error('Unnecessary provider rediscovery');}};},
    createWallet({onState}){return {restore(){onState({status:'unavailable'});}};}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../store.js'),'utf8'),{
    URL, location:{href:'https://bazaar.mustree.kr/store.html',assign:value=>assigned.push(value)},
    localStorage:{getItem:()=>null},document:{getElementById:node,addEventListener(){}},
    window:{BazaarWallet:Wallet,BazaarTransfer:Transfer,BazaarUI:UI,BazaarHistory:require('../transaction-history.js'),fetch:async()=>{throw new Error('Unexpected network');},addEventListener(){}}
  });
  events['storeScreen:click']({target:{closest:selector=>selector==='[data-store]'?{dataset:{store:'connect'}}:null}});
  assert.deepEqual(assigned,['https://link.metamask.io/dapp/bazaar.mustree.kr/store.html']);
});

test('store polls every five seconds and updates deposits without replacing QR or name input', async () => {
  const History=require('../transaction-history.js');
  const account='0x'+'1'.repeat(40), nodes=new Map(), events={}, windowEvents={}, documentEvents={};
  let now=Date.now(), balance='1000000000000000000', queries=0, refreshes=0, qrRenders=0, interval, intervalMs, cleared, disposed=false;
  let notify, historyModel, finishQuery;
  const node=id=>{
    if(!nodes.has(id)) {
      let html='';
      nodes.set(id,{
        writes:0, value:'', textContent:'', hidden:false,
        get innerHTML(){return html;},
        set innerHTML(value){html=value;this.writes++;},
        querySelector:()=>node('balanceValue'),
        addEventListener(type,fn){events[id+':'+type]=fn;}
      });
    }
    return nodes.get(id);
  };
  const document={visibilityState:'visible',getElementById:node,addEventListener(type,fn){documentEvents[type]=fn;}};
  const result=()=>({
    items:balance==='1000000000000000000'?[]:[{hash:'0x'+'a'.repeat(64),blockNumber:'0x2',timestamp:Math.floor(now/1000),direction:'in',valueWei:1000000000000000000n,balanceWei:BigInt(balance)}],
    lastScannedBlock:queries,balanceWei:balance,settledHashes:[]
  });
  const ready=()=>notify({status:'ready',account,balanceWei:balance});
  const Wallet={
    NETWORK:{chainId:'0x1db1',rpcUrls:[]},createRpcBalanceReader(){return ()=>{};},
    discover(){return {dispose(){}};},
    createWallet({onState}){
      notify=onState;
      return {restore:ready,refresh(){refreshes++;notify({status:'querying'});ready();},dispose(){disposed=true;}};
    }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../store.js'),'utf8'),{
    URL, location:{href:'https://bazaar.mustree.kr/store.html'},localStorage:{getItem:()=>null,setItem(){}},document,
    window:{BazaarWallet:Wallet,BazaarTransfer:Transfer,BazaarUI:{...UI,renderQr(){qrRenders++;}},
      BazaarHistory:{...History,create(options){
        historyModel=History.create({...options,storage:null,now:()=>now,query:async()=>{queries++;if(finishQuery)await new Promise(resolve=>{finishQuery=resolve;});return result();}});
        return historyModel;
      }},fetch:async()=>{},addEventListener(type,fn){windowEvents[type]=fn;},
      setInterval(fn,ms){interval=fn;intervalMs=ms;return 42;},clearInterval(id){cleared=id;}}
  });
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  await flush();
  assert.equal(intervalMs,5000);
  assert.equal(queries,1);
  const screenWrites=node('storeScreen').writes, initialHistoryWrites=node('storeHistory').writes;
  node('storeName').value='아직 저장하지 않은 이름';
  now+=5000;interval();await flush();
  assert.equal(refreshes,1);
  assert.equal(queries,1,'unchanged balance skips recent history RPC before sixty seconds');
  assert.equal(node('storeHistory').writes,initialHistoryWrites,'unchanged history does not touch the DOM');
  balance='2000000000000000000';finishQuery=true;
  now+=5000;interval();await flush();
  assert.equal(queries,2,'deposit starts a history query on the next balance poll');
  assert.equal(node('storeHistory').writes,initialHistoryWrites,'background query keeps existing markup still');
  finishQuery();finishQuery=null;await flush();
  assert.match(node('storeHistory').innerHTML,/\+1 MST/);
  assert.equal(node('balanceValue').textContent,'2 MST');
  assert.equal(node('storeScreen').writes,screenWrites);
  assert.equal(qrRenders,1);
  assert.equal(node('storeName').value,'아직 저장하지 않은 이름');
  now+=60000;interval();await flush();
  assert.equal(queries,3,'periodic history scan also catches transfers with no net balance change');
  document.visibilityState='hidden';interval();await flush();
  assert.equal(refreshes,3,'hidden pages do not poll');
  document.visibilityState='visible';documentEvents.visibilitychange();await flush();
  assert.equal(refreshes,4,'returning to the page refreshes immediately');
  events['storeBalance:click']();await flush();
  assert.equal(queries,4,'manual refresh forces history even at the same balance');
  notify({status:'querying'});
  notify({status:'error',duringBalance:true});
  assert.equal(node('storeScreen').writes,screenWrites);
  assert.equal(qrRenders,1,'temporary balance failures keep the receiving QR');
  assert.equal(node('storeName').value,'아직 저장하지 않은 이름');
  assert.match(node('storeStatus').innerHTML,/잔액을 확인하지 못했어요/);
  interval();await flush();
  assert.equal(node('storeStatus').hidden,true,'the next successful poll clears the error');
  notify({status:'idle'});
  assert.equal(historyModel.snapshot().account,null);
  assert.equal(node('storeBalance').hidden,true);
  assert.match(node('storeScreen').innerHTML,/가게 지갑 연결하기/);
  windowEvents.pagehide({persisted:false});
  assert.equal(cleared,42);
  assert.equal(disposed,true);
});
