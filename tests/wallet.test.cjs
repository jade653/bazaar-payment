const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {createWallet, createRpcBalanceReader, NETWORK, TOKEN, discover} = require('../wallet.js');
const {TEST_TOKEN} = require('./fixtures.cjs');
const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
const wait = () => new Promise(resolve => setTimeout(resolve, 15));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};}
class Provider extends EventEmitter {
  constructor(options={}){
    super();this.accounts=options.accounts??[A];this.chain=options.chain??NETWORK.chainId;
    this.added=options.added??true;this.autoSwitch=options.autoSwitch??false;
    this.raw=options.raw??'0x989680';this.gas=options.gas??'0x2386f26fc10000';this.calls=[];this.hooks={};
  }
  async request({method,params}){
    this.calls.push({method,params});
    if(this.hooks[method])return this.hooks[method](params);
    switch(method){
      case'eth_accounts':return [...this.accounts];
      case'eth_requestAccounts':this.accounts=[A];this.emit('accountsChanged',this.accounts);return [...this.accounts];
      case'eth_chainId':return this.chain;
      case'wallet_switchEthereumChain':
        if(!this.added)throw{code:4902};this.chain=params[0].chainId;this.emit('chainChanged',this.chain);return null;
      case'wallet_addEthereumChain':this.added=true;if(this.autoSwitch){this.chain=params[0].chainId;this.emit('chainChanged',this.chain);}return null;
      case'eth_getBalance':return this.gas;
      case'eth_call':return this.raw;
      default:throw new Error('Unexpected method: '+method);
    }
  }
}
function fixture(provider,options={}){
  const snapshots=[];
  const wallet=createWallet({getProvider:async()=>provider,onState:s=>snapshots.push(s),token:TEST_TOKEN,...options});
  return{wallet,snapshots,methods:()=>provider.calls.map(c=>c.method)};
}

test('network uses the verified RPC and 18-decimal MST currency',()=>{
  assert.equal(NETWORK.chainId,'0x1db1');assert.deepEqual(NETWORK.rpcUrls,['https://block.mustree.kr']);
  assert.equal(NETWORK.nativeCurrency.decimals,18);
});
test('ready state carries the wMST balance read from the token and the native fee balance',async t=>{
  const p=new Provider({raw:'0x1388',gas:'0x5'}),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().balanceWei,'5000');assert.equal(f.wallet.getSnapshot().gasWei,'5');
  const read=p.calls.find(c=>c.method==='eth_call');
  assert.equal(read.params[0].to,TEST_TOKEN.address);assert.equal(read.params[0].data,TEST_TOKEN.selectors.balanceOf+A.slice(2).padStart(64,'0'));assert.equal(read.params[1],'latest');
});
test('an unconfigured token is reported as an error instead of a fake balance, and token:null reads only native MST',async t=>{
  const p=new Provider(),f=fixture(p,{token:TOKEN});t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'error');assert.equal(f.wallet.getSnapshot().code,'TOKEN_NOT_CONFIGURED');assert.ok(!p.calls.some(c=>c.method==='eth_call'));
  const q=new Provider({gas:'0x7'}),g=fixture(q,{token:null});t.after(()=>g.wallet.dispose());await g.wallet.setup();
  assert.equal(g.wallet.getSnapshot().status,'ready');assert.equal(g.wallet.getSnapshot().balanceWei,null);assert.equal(g.wallet.getSnapshot().gasWei,'7');assert.ok(!q.calls.some(c=>c.method==='eth_call'));
});
test('new user connects, adds, switches after add, then reads the real balance',async t=>{
  const p=new Provider({accounts:[],chain:'0x1',added:false,raw:'0x98a7d9b8314c0000'}),f=fixture(p);t.after(()=>f.wallet.dispose());
  await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'ready');
  assert.equal(f.wallet.getSnapshot().balanceWei,BigInt(p.raw).toString());
  assert.equal(f.methods().filter(x=>x==='eth_requestAccounts').length,1);
  assert.equal(f.methods().filter(x=>x==='wallet_addEthereumChain').length,1);
  assert.equal(f.methods().filter(x=>x==='wallet_switchEthereumChain').length,2);
  assert.deepEqual(p.calls.find(x=>x.method==='wallet_addEthereumChain').params[0],NETWORK);
});
test('adding a chain that automatically switches does not ask to switch again',async t=>{
  const p=new Provider({chain:'0x1',added:false,autoSwitch:true}),f=fixture(p);t.after(()=>f.wallet.dispose());
  await f.wallet.setup();assert.equal(f.wallet.getSnapshot().status,'ready');
  assert.equal(f.methods().filter(x=>x==='wallet_switchEthereumChain').length,1);
});
test('already permitted user on Mustree receives no approval prompts',async t=>{
  const p=new Provider(),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'ready');
  assert.ok(!f.methods().some(x=>x.startsWith('wallet_')||x==='eth_requestAccounts'));
});
test('page entry requests account access and switches to Mustree automatically',async t=>{
  const p=new Provider({accounts:[],chain:'0x1'}),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.restore();
  assert.equal(f.wallet.getSnapshot().status,'ready');assert.ok(f.methods().includes('eth_requestAccounts'));assert.ok(f.methods().includes('wallet_switchEthereumChain'));
});
test('account approval rejection stops the rest of onboarding',async t=>{
  const p=new Provider({accounts:[]});p.hooks.eth_requestAccounts=()=>Promise.reject({code:4001});
  const f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'cancelled');assert.ok(!f.methods().includes('eth_getBalance'));
});
test('network rejection is not treated as an unregistered chain',async t=>{
  const p=new Provider({chain:'0x1'});p.hooks.wallet_switchEthereumChain=()=>Promise.reject({code:4001});
  const f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'cancelled');assert.ok(!f.methods().includes('wallet_addEthereumChain'));
});
test('nested 4902 errors trigger chain addition',async t=>{
  const p=new Provider({chain:'0x1',autoSwitch:true});
  p.hooks.wallet_switchEthereumChain=()=>Promise.reject({code:-32603,data:{originalError:{code:4902}}});
  const f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();assert.equal(f.wallet.getSnapshot().status,'ready');
});
test('repeated clicks reuse a pending approval request',async t=>{
  const p=new Provider({accounts:[]}),approval=deferred();p.hooks.eth_requestAccounts=()=>approval.promise;
  const f=fixture(p);t.after(()=>f.wallet.dispose());const first=f.wallet.setup();await wait();const second=f.wallet.setup();
  assert.equal(first,second);assert.equal(f.methods().filter(x=>x==='eth_requestAccounts').length,1);
  p.accounts=[A];approval.resolve([A]);await first;assert.equal(f.wallet.getSnapshot().status,'ready');
});
test('external -32002 remains pending; retry only polls and does not create another prompt',async t=>{
  const p=new Provider({accounts:[]});p.hooks.eth_requestAccounts=()=>Promise.reject({code:-32002});
  const f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();await f.wallet.restore();await f.wallet.refresh();
  assert.equal(f.wallet.getSnapshot().status,'pending');assert.equal(f.methods().filter(x=>x==='eth_requestAccounts').length,1);
  p.accounts=[A];await f.wallet.setup();assert.equal(f.wallet.getSnapshot().status,'ready');
});
test('successful switch RPC without a real chain change cannot display a balance',async t=>{
  const p=new Provider({chain:'0x1'});p.hooks.wallet_switchEthereumChain=()=>null;
  const f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'needs-network');assert.ok(!f.methods().includes('eth_getBalance'));
});
test('zero balance is a successful query and query failure is not rendered as zero',async t=>{
  const p=new Provider({raw:'0x0'}),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().balanceWei,'0');
  p.hooks.eth_call=()=>Promise.reject(new Error('RPC unavailable'));await f.wallet.refresh();
  assert.equal(f.wallet.getSnapshot().status,'error');assert.equal(f.wallet.getSnapshot().balanceWei,null);
  assert.equal(f.wallet.getSnapshot().duringBalance,true);
});
test('read timeouts permit retry without pretending the balance is zero',async t=>{
  const p=new Provider();p.hooks.eth_getBalance=()=>new Promise(()=>{});
  const f=fixture(p,{readTimeout:5});t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().code,'READ_TIMEOUT');assert.equal(f.wallet.getSnapshot().balanceWei,null);
});
test('provider balance failure falls back to the public RPC after wallet and chain verification',async t=>{
  const p=new Provider();p.hooks.eth_getBalance=()=>Promise.reject(new Error('MetaMask RPC failed'));
  const requests=[];
  const readBalanceFromRpc=createRpcBalanceReader({token:TEST_TOKEN,fetchImpl:async(url,options)=>{
    requests.push({url,body:JSON.parse(options.body)});
    return{ok:true,json:async()=>([{jsonrpc:'2.0',id:1,result:'0x7'},{jsonrpc:'2.0',id:2,result:'0x2a'}])};
  }});
  const f=fixture(p,{readBalanceFromRpc});t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'ready');assert.equal(f.wallet.getSnapshot().balanceWei,'42');assert.equal(f.wallet.getSnapshot().gasWei,'7');
  assert.equal(requests[0].url,NETWORK.rpcUrls[0]);assert.deepEqual(requests[0].body[0].params,[A,'latest']);assert.equal(requests[0].body[1].params[0].to,TEST_TOKEN.address);
  assert.equal(f.methods().filter(x=>x==='eth_accounts').length,3);
  assert.equal(f.methods().filter(x=>x==='eth_chainId').length,3);
});
test('invalid public RPC fallback never renders a fake zero balance',async t=>{
  const p=new Provider();p.hooks.eth_getBalance=()=>Promise.reject(new Error('MetaMask RPC failed'));
  const readBalanceFromRpc=createRpcBalanceReader({token:TEST_TOKEN,fetchImpl:async()=>({ok:true,json:async()=>({error:{code:-1}})})});
  const f=fixture(p,{readBalanceFromRpc});t.after(()=>f.wallet.dispose());await f.wallet.setup();
  assert.equal(f.wallet.getSnapshot().status,'error');assert.equal(f.wallet.getSnapshot().balanceWei,null);
});
test('account changed while balance loads discards the stale account response',async t=>{
  const p=new Provider(),oldBalance=deferred();const f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  p.hooks.eth_call=()=>oldBalance.promise;
  const refresh=f.wallet.refresh();await wait();p.accounts=[B];p.emit('accountsChanged',[B]);await wait();
  delete p.hooks.eth_call;p.raw='0x1';oldBalance.resolve('0xffff');await refresh;await wait();
  assert.equal(f.wallet.getSnapshot().account,B);assert.equal(f.wallet.getSnapshot().balanceWei,'1');
  assert.ok(!f.snapshots.some(s=>s.status==='ready'&&s.balanceWei==='65535'));
});
test('network change automatically switches back to Mustree and verifies the balance',async t=>{
  const p=new Provider(),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  p.chain='0x1';p.emit('chainChanged','0x1');await wait();
  assert.equal(f.wallet.getSnapshot().status,'ready');assert.equal(p.chain,NETWORK.chainId);
  assert.ok(f.methods().includes('wallet_switchEthereumChain'));
});
test('revoked permission and disconnected provider clear account data',async t=>{
  const p=new Provider(),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();
  p.accounts=[];p.emit('accountsChanged',[]);assert.equal(f.wallet.getSnapshot().account,null);
  p.emit('disconnect');assert.equal(f.wallet.getSnapshot().status,'disconnected');assert.equal(f.wallet.getSnapshot().balanceWei,null);
});
test('missing provider is handled without any wallet request',async t=>{
  const f=fixture(null);t.after(()=>f.wallet.dispose());await f.wallet.setup();assert.equal(f.wallet.getSnapshot().status,'unavailable');
});
test('EIP-6963 selects MetaMask instead of another injected wallet',async()=>{
  const listeners=new Map(),metamask=new Provider();
  const win={ethereum:{isMetaMask:false},Event:class{constructor(type){this.type=type;}},
    addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type),
    dispatchEvent:event=>{if(event.type==='eip6963:requestProvider')listeners.get('eip6963:announceProvider')?.({detail:{info:{rdns:'io.metamask'},provider:metamask}});}};
  const detection=discover(win);assert.equal(await detection.getProvider(),metamask);detection.dispose();
});
test('wallet request methods never include signing or sending a transaction',async t=>{
  const p=new Provider({accounts:[],chain:'0x1',added:false}),f=fixture(p);t.after(()=>f.wallet.dispose());await f.wallet.setup();await f.wallet.refresh();
  assert.ok(f.methods().every(method=>['eth_accounts','eth_requestAccounts','eth_chainId','eth_getBalance','eth_call','wallet_switchEthereumChain','wallet_addEthereumChain'].includes(method)));
});
