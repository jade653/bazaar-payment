'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const Store=require('../store-core.js');
const account='0x1111111111111111111111111111111111111111';
const recipient='0x2222222222222222222222222222222222222222';

test('store QR links open the customer payment route and keep an optional name',()=>{
  assert.equal(Store.paymentLink(account),'https://bazaar.mustree.kr/pay/'+account);
  assert.equal(Store.paymentLink(account,'사랑 분식'),'https://bazaar.mustree.kr/pay/'+account+'?name=%EC%82%AC%EB%9E%91+%EB%B6%84%EC%8B%9D');
});
test('store recipient accepts customer wallet QR formats',()=>{
  assert.equal(Store.parseRecipient(recipient),recipient);
  assert.equal(Store.parseRecipient(`ethereum:${recipient}@7601`),recipient);
  assert.equal(Store.parseRecipient(`https://bazaar.mustree.kr/pay/${recipient}`),recipient);
  assert.equal(Store.parseRecipient(`https://evil.example/pay/${recipient}`),null);
});
test('store transfer accepts at most three MST decimals',()=>{
  assert.equal(Store.parseAmount('12.345').wei,12345n*10n**15n);
  assert.throws(()=>Store.parseAmount('1.0001'),{code:'INVALID_AMOUNT'});
  assert.throws(()=>Store.parseAmount('0'),{code:'INVALID_AMOUNT'});
});
test('store transfer rechecks wallet state and preserves exact wei',async()=>{
  const provider={request:async({method})=>({eth_accounts:[account],eth_chainId:'0x1db1',eth_getBalance:'0x'+(50n*10n**18n).toString(16)})[method]};
  const result=await Store.prepare(provider,{account,recipient,amount:'12.345',chainId:'0x1db1'});
  assert.deepEqual(result.transaction,{from:account,to:recipient,value:'0xab524017e8328000'});
});
