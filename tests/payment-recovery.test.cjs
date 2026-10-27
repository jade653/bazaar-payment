const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const Wallet = require('../wallet.js');
const Transfer = require('../transfer-core.js');
const UI = require('../payment-ui.js');
const { TEST_TOKEN } = require('./fixtures.cjs');
const A = '0x'+'1'.repeat(40), B = '0x'+'2'.repeat(40), C = '0x'+'3'.repeat(40), hash = '0x'+'a'.repeat(64);
const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const feeMismatch = () => ({code:-32602,message:'Invalid transaction params: params specify an EIP-1559 transaction but the current network does not support EIP-1559'});
function storage() { const data = new Map(); return { getItem:key=>data.get(key)||null, setItem:(key,value)=>data.set(key,value), removeItem:key=>data.delete(key) }; }
class Provider extends EventEmitter {
  constructor() { super(); this.chain='0x1'; this.accounts=[A]; this.calls=[]; this.hooks={}; this.registered=false; this.receipt={status:'0x1'}; }
  async request(request) {
    const {method,params}=request; this.calls.push(request);
    if(this.hooks[method]) return this.hooks[method](params);
    if(method==='eth_accounts') return this.accounts;
    if(method==='eth_chainId') return this.chain;
    if(method==='eth_getBalance') return '0x56bc75e2d63100000';
    if(method==='eth_call') return '0x186a0';
    if(method==='eth_requestAccounts') { this.accounts=[A]; this.emit('accountsChanged',this.accounts); return this.accounts; }
    if(method==='wallet_addEthereumChain') { this.registered=true; return null; }
    if(method==='wallet_switchEthereumChain') { if(!this.registered)throw {code:4902,message:'Unknown chain'}; this.chain=params[0].chainId; this.emit('chainChanged',this.chain); return null; }
    if(method==='eth_sendTransaction') return hash;
    if(method==='eth_getTransactionReceipt') return this.receipt;
    throw new Error(method);
  }
  count(method) { return this.calls.filter(call=>call.method===method).length; }
}
function page({provider = new Provider(), local = storage(), session = storage(), kind = 'payment', fetchImpl} = {}) {
  const events={}, nodes=new Map(); let controller;
  const node=id=>{ if(!nodes.has(id))nodes.set(id,{innerHTML:'',dataset:{},querySelector(){return null;},focus(){},setSelectionRange(){},addEventListener(type,fn){events[id+':'+type]=fn;}});return nodes.get(id); };
  node('screen').dataset.transferKind=kind;
  const document={visibilityState:'visible',getElementById:node,querySelector:selector=>selector==='[data-transfer-kind]'?node('screen'):node('heading'),addEventListener(type,fn){events['document:'+type]=fn;},removeEventListener(){}};
  const diagnostics=Wallet.createDiagnostics({storage:session});
  const window={ document, localStorage:local,sessionStorage:session,
    BazaarWallet:{...Wallet,TOKEN:TEST_TOKEN,diagnosticsFor:()=>diagnostics,discover:()=>({getProvider:async()=>provider,dispose(){}}),
      createWallet(options){controller=Wallet.createWallet({...options,token:TEST_TOKEN,diagnostics});return controller;}},
    BazaarUI:UI,BazaarTransfer:{...Transfer,createSender:options=>Transfer.createSender({...options,maxPolls:1,readTimeout:20})},
    BazaarHistory:{recordSent(){}},BazaarScanner:{create(){return {start(){},stop(){},dispose(){}};}},
    fetch:fetchImpl || (async()=>{throw new Error('Unexpected HTTP');}),addEventListener(type,fn){events[type]=fn;},removeEventListener(){}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../transfer-page.js'),'utf8'),{window,document,URL,location:{href:'https://bazaar.mustree.kr/pay.html?to='+B+'&won=5000',origin:'https://bazaar.mustree.kr',assign(){}}});
  return {provider,local,session,diagnostics,events,screen:node('screen'),controller:()=>controller,
    async click(action){events['screen:click']({target:{closest:selector=>selector==='[data-transfer]'?{dataset:{transfer:action}}:null}});await flush();},
    dispose(){events.pagehide({persisted:false});}};
}

test('wrong-network entry automatically adds/switches then sends a payment on Mustree',async t=>{
  const p=page();t.after(()=>p.dispose());await flush();
  assert.equal(p.controller().getSnapshot().status,'ready');assert.equal(p.provider.count('wallet_addEthereumChain'),1);
  await p.click('submit');assert.match(p.screen.innerHTML,/결제 완료/);
  assert.equal(p.provider.count('eth_sendTransaction'),1);
  assert.equal(p.provider.calls.find(call=>call.method==='eth_sendTransaction').params[0].chainId,Wallet.NETWORK.chainId);
});
test('send failure followed by manual network selection and account change revalidates on every retry',async t=>{
  const p=page();t.after(()=>p.dispose());await flush();
  p.provider.hooks.eth_sendTransaction=()=>{throw {code:-32603,message:'Original provider failure'};};
  await p.click('submit');assert.match(p.screen.innerHTML,/처리하지 못했어요/);
  p.provider.chain=Wallet.NETWORK.chainId;p.provider.accounts=[C]; // No events: button must not trust its cached account.
  delete p.provider.hooks.eth_sendTransaction;
  await p.click('submit');assert.match(p.screen.innerHTML,/결제 완료/);
  assert.equal(p.provider.calls.filter(call=>call.method==='eth_sendTransaction').at(-1).params[0].from,C);
  const failure=p.diagnostics.snapshot().find(row=>row.stage==='transfer:eth_sendTransaction:failure');
  assert.equal(failure.chainId,Wallet.NETWORK.chainId);assert.equal(failure.errors[0].code,'-32603');assert.equal(failure.errors[0].message,'Original provider failure');
});
for(const code of [4001,-32002])test(`approval ${code} is held across resume/events/navigation and explicit retry recovers`,async t=>{
  const provider=new Provider();provider.hooks.wallet_switchEthereumChain=()=>{throw {code,message:'Approval blocked'};};
  let p=page({provider});t.after(()=>p.dispose());await flush();const calls=provider.count('wallet_switchEthereumChain');
  p.events.focus();p.events['document:visibilitychange']();p.events.pageshow({persisted:true});provider.emit('chainChanged',provider.chain);await flush();
  assert.equal(provider.count('wallet_switchEthereumChain'),calls);
  assert.equal(p.controller().getSnapshot().status,code===4001?'cancelled':'pending');
  const {local,session}=p;p.dispose();p=page({provider,local,session});await flush();
  assert.equal(provider.count('wallet_switchEthereumChain'),calls,'navigation preserves the approval hold');
  delete provider.hooks.wallet_switchEthereumChain;await p.click('connect');assert.equal(p.controller().getSnapshot().status,'ready');
});
test('result failure keeps hash, survives reload and checks the original payment instead of sending again',async t=>{
  const provider=new Provider();provider.hooks.eth_getTransactionReceipt=()=>{throw {code:-32000,message:'Receipt RPC unavailable'};};
  let p=page({provider});t.after(()=>p.dispose());await flush();await p.click('submit');
  assert.match(p.screen.innerHTML,/결과 다시 확인/);assert.doesNotMatch(p.screen.innerHTML,new RegExp(hash),'participants never see transaction hashes');
  assert.equal(provider.count('eth_sendTransaction'),1);
  assert.ok(p.diagnostics.snapshot().some(row=>row.stage==='receipt:failure'&&row.hash===hash&&row.errors[0].code==='-32000'));
  const {local,session}=p;p.dispose();p=page({provider,local,session});await flush();await p.click('submit');
  assert.equal(provider.count('eth_sendTransaction'),1);assert.match(p.screen.innerHTML,/결과 다시 확인/);
  delete provider.hooks.eth_getTransactionReceipt;await p.click('check');assert.match(p.screen.innerHTML,/결제 완료/);
  assert.equal(provider.count('eth_sendTransaction'),1);
});
test('focus/visibility/BFCache return and account/network events always verify current state',async t=>{
  const p=page();t.after(()=>p.dispose());await flush();
  p.provider.chain='0x1';p.events.focus();p.events['document:visibilitychange']();await flush();assert.equal(p.provider.chain,Wallet.NETWORK.chainId);
  p.provider.accounts=[C];p.provider.emit('accountsChanged',[C]);await flush();assert.equal(p.controller().getSnapshot().account,C);
  p.provider.chain='0x1';p.events.pageshow({persisted:true});await flush();assert.equal(p.provider.chain,Wallet.NETWORK.chainId);
  p.provider.accounts=[];p.provider.emit('accountsChanged',[]);await flush();assert.equal(p.provider.count('eth_requestAccounts'),1);
});
for(const kind of ['payment','topup'])test(`${kind} installs the shared wallet lifecycle controller`,async t=>{
  const p=page({kind});t.after(()=>p.dispose());await flush();assert.equal(p.controller().getSnapshot().status,'ready');assert.equal(typeof p.events.focus,'function');assert.equal(typeof p.events.pageshow,'function');
});


test('failed network approval followed by manual Mustree selection allows payment without another switch',async t=>{
  const provider=new Provider();provider.hooks.wallet_switchEthereumChain=()=>{throw {code:4001,message:'User cancelled network switch'};};
  const p=page({provider});t.after(()=>p.dispose());await flush();assert.equal(p.controller().getSnapshot().status,'cancelled');
  const switches=provider.count('wallet_switchEthereumChain');provider.chain=Wallet.NETWORK.chainId;
  await p.click('submit');assert.match(p.screen.innerHTML,/결제 완료/);assert.equal(provider.count('wallet_switchEthereumChain'),switches);assert.equal(provider.count('eth_sendTransaction'),1);
});
test('an unresolved approval is shared by entry, resume and repeated payment clicks',async t=>{
  const provider=new Provider();let resolve;
  provider.hooks.wallet_switchEthereumChain=()=>new Promise(done=>{resolve=()=>{provider.chain=Wallet.NETWORK.chainId;done(null);};});
  const p=page({provider});t.after(()=>p.dispose());await flush();
  p.events.focus();p.events['document:visibilitychange']();
  const first=p.click('submit'),second=p.click('submit');await flush();assert.equal(provider.count('wallet_switchEthereumChain'),1);assert.equal(provider.count('eth_sendTransaction'),0);
  resolve();await Promise.all([first,second]);await flush();assert.equal(provider.count('eth_sendTransaction'),1);assert.match(p.screen.innerHTML,/결제 완료/);
});

for (const kind of ['payment','topup']) test(`${kind} recovers Android RPC-read backoff and exact EIP-1559 rejection with one approved legacy transaction`, async t => {
  const provider = new Provider();
  provider.hooks.eth_getBalance = () => { throw {code:-32002,message:'RPC endpoint returned too many errors, retrying in 0.3 minutes.'}; };
  let approvals = 0;
  provider.hooks.eth_sendTransaction = ([tx]) => {
    if (tx.maxFeePerGas) throw {code:-32603,data:{originalError:feeMismatch()}};
    approvals++;
    assert.equal(tx.gasPrice, '0x3e8');
    assert.equal(tx.maxFeePerGas, undefined);
    assert.equal(tx.maxPriorityFeePerGas, undefined);
    assert.equal(tx.chainId, Wallet.NETWORK.chainId);
    assert.equal(tx.to, TEST_TOKEN.address);
    assert.equal(BigInt(tx.value), kind === 'topup' ? Transfer.gasSupportWei(TEST_TOKEN) : 0n);
    return hash;
  };
  const p = page({provider, kind, fetchImpl:async () => ({ok:true,json:async () => [{id:1,result:'0x56bc75e2d63100000'},{id:2,result:'0x186a0'}]})});
  t.after(() => p.dispose());
  await flush();
  await Promise.all([p.click('submit'), p.click('submit')]);
  assert.equal(approvals, 1);
  assert.equal(provider.count('eth_sendTransaction'), 2, 'only the rejected validation and one approval request');
  assert.match(p.screen.innerHTML, kind === 'topup' ? /충전 완료/ : /결제 완료/);
  assert.ok(p.diagnostics.snapshot().some(row => row.stage === 'payment:legacy-fee-fallback'));
});

test('fee fallback revalidates the account before requesting another transaction', async t => {
  const provider = new Provider();
  provider.hooks.eth_sendTransaction = () => { provider.accounts = [C]; throw feeMismatch(); };
  const p = page({provider}); t.after(() => p.dispose()); await flush();
  await p.click('submit');
  assert.equal(provider.count('eth_sendTransaction'), 1);
  assert.match(p.screen.innerHTML, /지갑 계정이 바뀌었어요/);
});

test('a second fee rejection stops after one compatibility fallback', async t => {
  const provider = new Provider(); provider.hooks.eth_sendTransaction = () => { throw feeMismatch(); };
  const p = page({provider}); t.after(() => p.dispose()); await flush(); await p.click('submit');
  assert.equal(provider.count('eth_sendTransaction'), 2);
  assert.doesNotMatch(p.screen.innerHTML, /결제 완료/);
});

for (const error of [{code:4001}, {code:-32002}, {code:-32602,message:'Invalid recipient'}, {code:-32603,message:'Unknown send outcome'}]) {
  test(`fee fallback never retries an unrelated send failure ${error.code}`, async t => {
    const provider = new Provider(); provider.hooks.eth_sendTransaction = () => { throw error; };
    const p = page({provider}); t.after(() => p.dispose()); await flush(); await p.click('submit');
    assert.equal(provider.count('eth_sendTransaction'), 1);
  });
}
