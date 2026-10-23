'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Gate = require('../operator-gate.js');
const root = path.join(__dirname, '..');
const { subtle } = globalThis.crypto;

test('derive is PBKDF2-HMAC-SHA256 with a hex salt', async () => {
  const salt = Buffer.from('salt').toString('hex');
  assert.equal(await Gate.derive('password', { salt, iterations:1 }, subtle), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
  assert.equal(await Gate.derive('password', { salt, iterations:2 }, subtle), 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43');
});

test('a generated config verifies only its own password and prints a pasteable GATE line', async () => {
  const config = await Gate.createConfig('바자회 운영 2026', { crypto:globalThis.crypto, iterations:1000 });
  assert.match(config.salt, /^[0-9a-f]{32}$/); assert.match(config.hash, /^[0-9a-f]{64}$/);
  assert.equal(await Gate.verify('바자회 운영 2026', config, subtle), true);
  assert.equal(await Gate.verify('바자회 운영 2025', config, subtle), false);
  assert.equal(await Gate.verify('', { ...config, hash:'' }, subtle), false, 'an empty hash never unlocks');
  assert.equal(Gate.snippet(config), `const GATE = { iterations:1000, salt:'${config.salt}', hash:'${config.hash}' };`);
  const other = await Gate.createConfig('바자회 운영 2026', { crypto:globalThis.crypto, iterations:1000 });
  assert.notEqual(other.salt, config.salt, 'every config gets a fresh salt');
});

test('an unlock is remembered for 12 hours and dropped when the password changes', () => {
  const saved = new Map(), storage = { getItem:key => saved.get(key) ?? null, setItem:(key, value) => saved.set(key, value) };
  const config = { iterations:1000, salt:'00', hash:'ab'.repeat(32) };
  assert.equal(Gate.remembered(storage, config, 0), false);
  Gate.remember(storage, config, 1000);
  assert.equal(Gate.remembered(storage, config, 1000 + Gate.REMEMBER_MS - 1), true);
  assert.equal(Gate.remembered(storage, config, 1000 + Gate.REMEMBER_MS), false);
  assert.equal(Gate.remembered(storage, { ...config, hash:'cd'.repeat(32) }, 2000), false);
  saved.set(Gate.STORAGE_KEY, '{broken'); assert.equal(Gate.remembered(storage, config, 2000), false);
  assert.equal(Gate.remembered(null, config, 2000), false);
});

function page({ crypto = globalThis.crypto, saved = new Map() } = {}) {
  const classes = new Set(), children = [];
  const element = () => {
    const parts = new Map(), listeners = {};
    return {
      className:'', innerHTML:'', parts, listeners,
      querySelector(selector) { if (!parts.has(selector)) parts.set(selector, { value:'', hidden:selector === '.operator-gate-error' || selector === '.operator-gate-result', textContent:'', disabled:false, focused:0, focus() { this.focused++; } }); return parts.get(selector); },
      addEventListener(type, fn) { listeners[type] = fn; },
      remove() { children.splice(children.indexOf(this), 1); }
    };
  };
  const body = { classList:{ add:name => classes.add(name), contains:name => classes.has(name) }, append:node => children.push(node) };
  const root = { crypto, document:{ body, createElement:element }, localStorage:{ getItem:key => saved.get(key) ?? null, setItem:(key, value) => saved.set(key, value) } };
  const submit = async () => children[0].listeners.submit({ preventDefault() {} });
  return { root, body, children, saved, submit, part:selector => children[0].querySelector(selector), open:() => classes.has('gate-open') };
}

test('the login gate hides the page until the right password, then remembers the device', async () => {
  const config = await Gate.createConfig('correct horse', { crypto:globalThis.crypto, iterations:1000 });
  const view = page();
  assert.equal(Gate.mount({ root:view.root, config, now:() => 5000 }).mode, 'login');
  assert.equal(view.open(), false); assert.equal(view.children.length, 1);
  assert.match(view.children[0].innerHTML, /운영자 전용/); assert.match(view.children[0].innerHTML, /autocomplete="current-password"/);
  assert.equal(view.part('#gatePassword').focused, 1);
  view.part('#gatePassword').value = 'wrong horse';
  await view.submit();
  assert.equal(view.open(), false);
  assert.equal(view.part('.operator-gate-error').hidden, false); assert.equal(view.part('.operator-gate-error').textContent, '비밀번호가 맞지 않아요.');
  assert.equal(view.part('#gatePassword').value, '', 'a wrong password is cleared');
  assert.equal(view.part('button').disabled, false);
  view.part('#gatePassword').value = 'correct horse';
  await view.submit();
  assert.equal(view.open(), true); assert.equal(view.children.length, 0, 'the gate is removed');
  const again = page({ saved:view.saved });
  assert.equal(Gate.mount({ root:again.root, config, now:() => 6000 }).mode, 'open');
  assert.equal(again.open(), true); assert.equal(again.children.length, 0, 'a remembered device skips the prompt');
});

test('without a configured hash the gate stays closed and generates the GATE line for a new password', async () => {
  const view = page();
  assert.equal(Gate.mount({ root:view.root, config:{ iterations:1000, salt:'', hash:'' } }).mode, 'setup');
  assert.equal(view.open(), false);
  view.part('#gatePassword').value = 'short'; view.part('#gateConfirm').value = 'short';
  await view.submit();
  assert.match(view.part('.operator-gate-error').textContent, /8자 이상/);
  view.part('#gatePassword').value = 'long enough 1'; view.part('#gateConfirm').value = 'long enough 2';
  await view.submit();
  assert.equal(view.part('.operator-gate-error').textContent, '두 비밀번호가 달라요.');
  view.part('#gateConfirm').value = 'long enough 1';
  await view.submit();
  assert.equal(view.part('.operator-gate-result').hidden, false);
  const [, iterations, salt, hash] = view.part('#gateSnippet').value.match(/^const GATE = \{ iterations:(\d+), salt:'([0-9a-f]{32})', hash:'([0-9a-f]{64})' \};$/);
  assert.equal(await Gate.verify('long enough 1', { iterations:Number(iterations), salt, hash }, subtle), true);
  assert.equal(view.open(), false, 'generating a config never opens the page');
});

test('a browser without WebCrypto keeps the page closed', () => {
  const view = page({ crypto:{} });
  assert.equal(Gate.mount({ root:view.root, config:{ iterations:1, salt:'00', hash:'ab'.repeat(32) } }).mode, 'unsupported');
  assert.equal(view.open(), false); assert.match(view.children[0].innerHTML, /https 주소로 다시 열어/);
});

test('only the operator pages are gated and they load the gate before any page script', () => {
  for (const file of ['operator.html', 'dashboard.html', 'setup.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(html, /<body class="operator-body" data-operator-gate>/, file);
    assert.match(html, /<link rel="stylesheet" href="operator-gate\.css\?v=[^"]+">/, file);
    assert.match(html.match(/<script src="([^"?]+)/)[1], /^operator-gate\.js$/, file + ': the gate runs first');
  }
  for (const file of ['index.html', 'pay.html', 'store.html', 'merchant.html', 'start.html', 'preview.html']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /operator-gate|data-operator-gate/, file);
  }
  assert.match(fs.readFileSync(path.join(root, 'operator-gate.css'), 'utf8'), /body\[data-operator-gate\]:not\(\.gate-open\) \.operator-app\{display:none\}/);
});
