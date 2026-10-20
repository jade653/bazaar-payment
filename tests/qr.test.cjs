'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness(getUserMedia) {
  const errors = [], video = { srcObject:null, play:async () => {} }, canvas = {};
  const overlay = { hidden:true, querySelector:selector => selector === 'video' ? video : selector === 'canvas' ? canvas : {}, remove() {} };
  let manual = 0, revoked = 0;
  const window = {};
  const context = { window, document:{ createElement:() => overlay, body:{ append() {} } }, navigator:{ mediaDevices:{ getUserMedia } }, cancelAnimationFrame() {}, requestAnimationFrame:() => 1, URL:{ createObjectURL:() => 'blob:test', revokeObjectURL() { revoked++; } }, Image:class { async decode() { throw new Error('invalid image'); } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../qr-scanner.js'), 'utf8'), context);
  const scanner = window.BazaarScanner.create({ onAccept:() => false, onError:text => errors.push(text), onManual:() => manual++ });
  return { scanner, overlay, video, errors, manual:() => manual, revoked:() => revoked };
}
test('closing a scanner while camera permission is pending releases late media tracks', async () => {
  let resolve, stops = 0;
  const page = harness(() => new Promise(r => { resolve = r; }));
  const pending = page.scanner.start();
  page.scanner.stop();
  resolve({ getTracks:() => [{ stop() { stops++; } }] });
  await pending;
  assert.equal(stops, 1);
  assert.equal(page.video.srcObject, null);
  assert.equal(page.overlay.hidden, true);
});
test('camera errors return every role to the common manual input', async () => {
  const page = harness(async () => { throw new Error('camera denied'); });
  await page.scanner.start();
  assert.equal(page.manual(), 1);
  assert.match(page.errors[0], /주소를 직접 입력/);
});
test('failed QR image decoding always releases its object URL', async () => {
  const page = harness(async () => {});
  await page.scanner.readFile({});
  assert.equal(page.revoked(), 1);
  assert.match(page.errors[0], /읽지 못했어요/);
});
