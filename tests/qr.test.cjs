'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function harness(getUserMedia, { decode = async () => { throw new Error('invalid image'); }, accept = () => false, preview = false } = {}) {
  const errors = [], video = { srcObject:null, play:async () => {} };
  const canvas = { getContext:() => ({ drawImage(){}, getImageData:() => ({ data:[], width:1, height:1 }) }) };
  const nodes = new Map([['video',video],['canvas',canvas]]);
  const overlay = { hidden:true, querySelector(selector) { if(!nodes.has(selector)) nodes.set(selector,{}); return nodes.get(selector); }, remove() {} };
  let manual = 0, revoked = 0;
  const window = {};
  const context = { window, document:{ createElement:() => overlay, body:{ append() {} } }, navigator:{ mediaDevices:{ getUserMedia } }, cancelAnimationFrame() {}, requestAnimationFrame:() => 1, URL:{ createObjectURL:() => 'blob:test', revokeObjectURL() { revoked++; } }, Image:class { decode = decode; naturalWidth=1; naturalHeight=1; }, jsQR:() => ({data:'sample QR'}) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../qr-scanner.js'), 'utf8'), context);
  const scanner = window.BazaarScanner.create({ onAccept:accept, onError:text => errors.push(text), onManual:() => manual++, preview, onPreview(){} });
  const chooseFile = () => { const input=nodes.get('[data-file]'); input.files=[{}]; input.value='sample.png'; return input.onchange(); };
  return { scanner, overlay, video, errors, nodes, chooseFile, manual:() => manual, revoked:() => revoked };
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
test('camera errors keep image selection and manual entry available', async () => {
  const page = harness(async () => { throw new Error('camera denied'); });
  await page.scanner.start();
  assert.equal(page.overlay.hidden, false);
  assert.match(page.errors[0], /이미지 선택/);
  page.nodes.get('[data-manual]').onclick();
  assert.equal(page.manual(), 1);
  assert.equal(page.overlay.hidden, true);
  assert.match(page.errors[0], /주소 직접 입력/);
});
test('failed QR image decoding always releases its object URL', async () => {
  const page = harness(async () => {});
  await page.chooseFile();
  assert.equal(page.revoked(), 1);
  assert.match(page.errors[0], /읽지 못했어요/);
  assert.equal(page.nodes.get('[data-file]').value, '');
});

test('image selection accepts a QR and stops the active camera', async () => {
  let stops=0, accepted;
  const page=harness(async () => ({getTracks:()=>[{stop(){stops++;}}]}), {decode:async()=>{},accept:data=>{accepted=data;return true;}});
  await page.scanner.start();
  await page.chooseFile();
  assert.equal(accepted,'sample QR');
  assert.equal(stops,1);
  assert.equal(page.overlay.hidden,true);
  assert.equal(page.revoked(),1);
});

test('closing during image decoding discards its result and releases the image URL', async () => {
  let finish, accepted=0;
  const page=harness(async()=>{}, {decode:()=>new Promise(resolve=>{finish=resolve;}),accept:()=>{accepted++;return true;}});
  const pending=page.chooseFile();
  page.scanner.stop();finish();await pending;
  assert.equal(accepted,0);
  assert.equal(page.revoked(),1);
});

test('scanner preview never requests camera access', async () => {
  const page=harness(()=>{throw new Error('Unexpected camera access');},{preview:true});
  await page.scanner.start();
  assert.equal(page.overlay.hidden,false);
  assert.equal(page.errors.length,0);
});
