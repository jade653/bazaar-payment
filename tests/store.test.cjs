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
