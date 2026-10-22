'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness() {
  const events = {}, nodes = new Map(), location = { search:'?preview=1', hash:'#pay-manual' };
  let scannerOptions;
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { innerHTML:'', textContent:'', querySelector(){return null;}, append(){}, insertAdjacentHTML(){}, focus(){}, setSelectionRange(){}, addEventListener(type, handler){ events[id + ':' + type] = handler; } });
    return nodes.get(id);
  }
  const context = {
    BazaarUI:require('../payment-ui.js'), BazaarTransfer:require('../transfer-core.js'),
    BazaarScanner:{ create(options){ scannerOptions=options; return { start(){}, stop(){} }; } },
    location, URL, URLSearchParams, illustration:() => '', setTimeout:() => 1, clearTimeout(){},
    history:{ replaceState(_state, _title, hash){ location.hash = hash; } },
    document:{ body:{ classList:{ toggle(){} } }, getElementById:node, createElement:() => node(Symbol()), querySelectorAll:() => [], addEventListener(type,handler){ events['document:' + type] = handler; } },
    window:{ addEventListener(){} }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../preview.js'),'utf8'), context);
  const click = dataset => events['document:click']({ target:{ closest:() => ({ disabled:false, dataset }) } });
  const amount = value => events['appScreen:input']({ target:{ id:'transferAmount', value:String(value), selectionStart:String(value).length } });
  return { click, amount, scan:raw=>scannerOptions.onAccept(raw), scanExample:()=>scannerOptions.onPreview(), next:() => events['continueFlow:click'](), location, screen:node('appScreen'), cancel:() => events['cancelDemo:click'](), missing:() => events['missingDemo:click']() };
}

test('scanning a named store QR displays its name and clears it when another QR has no name', () => {
  const page=harness(), recipient='0x'+'2'.repeat(40);
  page.click({transfer:'scan'});
  page.scan(require('../transfer-core.js').receiveLink(recipient,{name:'사랑 분식'}));
  assert.match(page.screen.innerHTML, /<strong>사랑 분식<\/strong>/);
  page.amount(7500);
  assert.match(page.screen.innerHTML, /<strong>사랑 분식<\/strong>/);
  page.scan(recipient);
  assert.doesNotMatch(page.screen.innerHTML, /사랑 분식/);
});
test('preview cancellation returns to the form with the amount and recipient preserved', () => {
  const page = harness();
  page.click({ transfer:'scan' }); page.scanExample(); page.amount(7500); page.click({ transfer:'submit' }); page.cancel();
  assert.equal(page.location.hash, '#payment-cancelled');
  assert.match(page.screen.innerHTML, /value="7500"/);
  assert.match(page.screen.innerHTML, /0x2222222222222222222222222222222222222222/);
  assert.match(page.screen.innerHTML, /송금이 취소됐어요/);
});
test('preview top-up returns to the original payment instead of onboarding', () => {
  const page = harness();
  page.click({ state:'insufficient' }); page.amount(7500); page.click({ transfer:'topup' });
  page.next(); page.next();
  assert.equal(page.location.hash, '#pay-manual');
  assert.match(page.screen.innerHTML, /value="7500"/);
  assert.match(page.screen.innerHTML, /14,000 MST/);
  assert.match(page.screen.innerHTML, /0x2222222222222222222222222222222222222222/);
});
test('the insufficient preview uses the shared dialog and closes without losing the payment', () => {
  const page=harness();
  page.click({state:'insufficient'});
  assert.match(page.screen.innerHTML, /<dialog class="balance-dialog"/);
  assert.match(page.screen.innerHTML, /현재 잔액: <strong>3,000 MST<\/strong>/);
  assert.doesNotMatch(page.screen.innerHTML, /class="operator-alert"/);
  page.click({transfer:'dismiss-insufficient'});
  assert.doesNotMatch(page.screen.innerHTML, /<dialog/);
  assert.match(page.screen.innerHTML, /value="5000"/);
  assert.match(page.screen.innerHTML, /0x2222222222222222222222222222222222222222/);
  page.click({state:'receive'});
  assert.match(page.screen.innerHTML, /충전할 금액 입금 후 직원에게<br>이 QR을 보여주세요\./);
  assert.match(page.screen.innerHTML, /<code class="receive-address">0x111111…111111<\/code>/);
});
test('missing approval in preview exposes a usable retry action', () => {
  const page = harness();
  page.click({ transfer:'scan' }); page.scanExample(); page.click({ transfer:'submit' }); page.missing();
  assert.match(page.screen.innerHTML, /확인 창 다시 열기/);
  page.click({ transfer:'retry' });
  assert.equal(page.location.hash, '#payment-approval');
  assert.doesNotMatch(page.screen.innerHTML, /확인 창 다시 열기/);
});
