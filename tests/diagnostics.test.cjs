const test=require('node:test');
const assert=require('node:assert/strict');
const {createDiagnostics,diagnosticsFor,createRpcBalanceReader}=require('../wallet.js');
const {TEST_TOKEN}=require('./fixtures.cjs');
const hash='0x'+'a'.repeat(64);
function storage(){const data=new Map();return {getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value)};}
test('diagnostics preserve failure stage, chain, nested original errors and received hash across navigation',()=>{
  const store=storage(),d=createDiagnostics({storage:store,now:()=> '2026-10-20T00:00:00.000Z'});
  d.record({stage:'transfer:eth_sendTransaction:failure',chainId:'0x1',hash,error:{code:-32603,message:'Outer RPC error',data:{originalError:{code:4901,message:'Original chain disconnected'}}}});
  const row=createDiagnostics({storage:store}).snapshot()[0];
  assert.equal(row.stage,'transfer:eth_sendTransaction:failure');assert.equal(row.chainId,'0x1');assert.equal(row.hash,hash);
  assert.deepEqual(row.errors,[{code:'-32603',message:'Outer RPC error'},{code:'4901',message:'Original chain disconnected'}]);
});
test('diagnostics never serialize parameters, error data, signatures or private keys and bound retained records',()=>{
  const d=createDiagnostics(),secret='0x'+'b'.repeat(64),signature='0x'+'c'.repeat(130),phrase='alpha beta gamma delta';
  const error={code:-32000,message:'RPC failed '+secret+' '+signature+'; seed phrase: '+phrase,data:{privateKey:secret,signature,mnemonic:phrase}};
  error.cause=error;
  d.record({stage:'send:failure',hash,error,params:[secret,signature,phrase],privateKey:secret});
  assert.ok(!d.text().includes(secret));assert.ok(!d.text().includes(signature));assert.ok(!d.text().includes(phrase));assert.ok(d.text().includes(hash));
  for(let i=0;i<250;i++)d.record({stage:'read'});
  assert.equal(d.snapshot().length,200);
});
function ui({denied=false}={}){
  const events={},nodes=new Map();let copied,selected=false;
  const node=selector=>{if(!nodes.has(selector))nodes.set(selector,{value:'',querySelector:node,addEventListener(type,fn){events[selector+':'+type]=fn;},focus(){},select(){selected=true;}});return nodes.get(selector);};
  const win={sessionStorage:storage(),document:{body:{append(){}},createElement:()=>node('panel')},navigator:{clipboard:{async writeText(value){if(denied)throw Error('Clipboard denied');copied=value;}}}};
  return {win,events,node,copied:()=>copied,selected:()=>selected};
}
test('diagnostic copy button copies actual records and only mounts one panel',async()=>{
  const u=ui(),d=diagnosticsFor(u.win);assert.equal(diagnosticsFor(u.win),d);
  d.record({stage:'receipt:failure',chainId:'0x1db1',hash,error:{code:-32000,message:'Receipt unavailable'}});
  await u.events['[data-wallet-copy]:click']();assert.deepEqual(JSON.parse(u.copied()),JSON.parse(d.text()));
  assert.equal(u.node('textarea').value,d.text());
});
test('denied clipboard access exposes selectable diagnostic text',async()=>{
  const u=ui({denied:true}),d=diagnosticsFor(u.win);d.record({stage:'wallet:failure'});
  await u.events['[data-wallet-copy]:click']();assert.equal(u.selected(),true);assert.equal(u.node('textarea').value,d.text());
});
test('public balance RPC retains its original error code/message',async()=>{
  const read=createRpcBalanceReader({token:TEST_TOKEN,fetchImpl:async()=>({ok:true,json:async()=>({error:{code:-32000,message:'Original upstream error'}})})});
  await assert.rejects(read('0x'+'1'.repeat(40)),{code:-32000,message:'Original upstream error'});
});
