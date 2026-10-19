'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Payment=require('../payment-core.js');
const account='0x1111111111111111111111111111111111111111';
const merchant='0x2222222222222222222222222222222222222222';
const hash='0x'+'a'.repeat(64);

test('merchant QR accepts the service URL and raw address but rejects other sites',()=>{
  assert.equal(Payment.parseMerchant(`https://bazaar.mustree.kr/pay/${merchant}`),merchant);
  assert.equal(Payment.parseMerchant(`https://bazaar.mustree.kr/pay/${merchant}/5000`),merchant);
  assert.equal(Payment.parseMerchant(merchant),merchant);
  assert.equal(Payment.parseMerchant(`https://evil.example/pay/${merchant}`),null);
});
test('payment converts won to MST without applying the top-up bonus again',()=>{
  const amount=Payment.amountFromWon('5,000원');
  assert.equal(amount.mstText,'5');assert.equal(amount.wei,5n*10n**18n);
  assert.equal(Payment.amountFromWon('500').mstText,'0.5');
  assert.throws(()=>Payment.amountFromWon('0'),{code:'INVALID_AMOUNT'});
});
test('payment deeplink uses a simple path without query or hash',()=>{
  assert.equal(Payment.paymentPath(merchant,5000),`/pay/${merchant}/5000`);
  assert.doesNotMatch(Payment.paymentPath(merchant,5000),/[?#]/);
});
test('payment revalidates account and chain and builds the exact native transfer',async()=>{
  const provider={request:async({method})=>({eth_accounts:[account],eth_chainId:'0x1db1',eth_getBalance:'0x'+(50n*10n**18n).toString(16)})[method]};
  const result=await Payment.prepare(provider,{account,recipient:merchant,won:5000,chainId:'0x1db1'});
  assert.deepEqual(result.transaction,{from:account,to:merchant,value:'0x4563918244f40000'});
});
test('payment balance read falls back to public RPC and still revalidates wallet state',async()=>{
  let accounts=0,chains=0;
  const provider={request:async({method})=>{if(method==='eth_accounts'){accounts++;return[account];}if(method==='eth_chainId'){chains++;return'0x1db1';}if(method==='eth_getBalance')throw new Error('provider failed');}};
  const result=await Payment.prepare(provider,{account,recipient:merchant,won:5000,chainId:'0x1db1',readBalanceFromRpc:async()=> '0x'+(50n*10n**18n).toString(16)});
  assert.equal(result.amount.mstText,'5');assert.equal(accounts,2);assert.equal(chains,2);
});
test('receipt polling distinguishes success, failure and timeout',async()=>{
  let calls=0;const provider={request:async()=>++calls===1?null:{status:'0x1'}};
  assert.equal((await Payment.waitForReceipt(provider,hash,{interval:0,wait:async()=>{}})).status,'0x1');
  await assert.rejects(Payment.waitForReceipt({request:async()=>({status:'0x0'})},hash),{code:'TRANSACTION_FAILED'});
  await assert.rejects(Payment.waitForReceipt({request:async()=>null},hash,{attempts:1}),{code:'RECEIPT_TIMEOUT'});
});
