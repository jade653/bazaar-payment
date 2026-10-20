'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
test('every entry page loads its shared dependencies in browser order', () => {
  for (const file of ['index.html','operator.html','pay.html','store.html','merchant.html']) {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const context = { URL, URLSearchParams, document:{ querySelector:() => null } };
    context.window = context;
    const sandbox = vm.createContext(context);
    for (const [, source] of html.matchAll(/<script src="([^"]+)"/g)) {
      const filename = source.split('?')[0];
      assert.equal(fs.existsSync(path.join(root, filename)), true, file + ': ' + source);
      if (filename.startsWith('vendor/') || ['app.js','store.js','merchant.js'].includes(filename)) continue;
      assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(root, filename), 'utf8'), sandbox), file + ': ' + source);
    }
    assert.ok(context.BazaarUI, file + ' must load common UI');
    if (['operator.html','pay.html'].includes(file)) assert.match(html, /data-transfer-kind="(?:payment|topup)"/, file + ' must configure the common controller');
  }
});
