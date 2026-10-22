'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

const entryDependencies = {
  'app.js':['BazaarLive','BazaarWallet','illustration'],
  'preview.js':['BazaarUI','BazaarTransfer','BazaarScanner','illustration'],
  'transfer-page.js':['BazaarWallet','BazaarTransfer','BazaarUI','BazaarHistory','BazaarScanner'],
  'store.js':['BazaarWallet','BazaarTransfer','BazaarUI','BazaarHistory','QRCode'],
  'merchant.js':['BazaarTransfer','BazaarUI','QRCode'],
  'dashboard.js':['BazaarWallet','BazaarTransfer','BazaarUI'],
  'setup.js':['BazaarWallet','BazaarTransfer','BazaarUI','WMST_ARTIFACT']
};

test('entry pages load all dependencies before executing their actual controllers', async () => {
  for (const file of ['index.html','preview.html','operator.html','pay.html','store.html','merchant.html','dashboard.html','setup.html']) {
    const html = fs.readFileSync(path.join(root,file),'utf8');
    const nodes = new Map();
    function node() {
      return {innerHTML:'',textContent:'',hidden:false,style:{},dataset:{},classList:{toggle(){}},append(){},insertAdjacentHTML(){},setAttribute(){},addEventListener(){},querySelector(){return null;}};
    }
    for (const [,id] of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(id,node());
    const transferScreen = node();
    const transferKind = html.match(/data-transfer-kind="([^"]+)"/)?.[1];
    if (transferKind) transferScreen.dataset.transferKind = transferKind;
    const document = {
      visibilityState:'visible',documentElement:{tagName:'HTML'},body:node(),
      getElementById:id => nodes.get(id) || null,
      createElement:node,querySelectorAll:() => [],addEventListener(){},
      querySelector:selector => selector === '[data-transfer-kind]' ? transferKind ? transferScreen : null : node()
    };
    if (nodes.has('storeBalance')) nodes.get('storeBalance').querySelector = () => node();
    const context = {
      URL,URLSearchParams,Promise,console,document,
      location:{href:'https://bazaar.mustree.kr/'+file,search:'',hash:''},
      history:{replaceState(){},pushState(){}},navigator:{userAgent:'test'},
      Event:class Event {},dispatchEvent(){},addEventListener(){},removeEventListener(){},
      setTimeout:() => 1,clearTimeout(){},setInterval:() => 1,clearInterval(){},
      localStorage:{getItem:() => null,setItem(){}},
      ethereum:{isMetaMask:true,on(){},removeListener(){},request:async ({method}) => method === 'eth_accounts' ? [] : '0x1db1'},
      fetch:async () => { throw new Error('Entry smoke tests must not make network requests'); }
    };
    context.window = context; context.self = context;
    const sandbox = vm.createContext(context);
    for (const [tag,source] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) {
      const filename = source.split('?')[0];
      assert.match(tag,/\bdefer\b/,file+': scripts need the parsed DOM');
      assert.ok(fs.existsSync(path.join(root,filename)),file+': '+source);
      for (const name of entryDependencies[filename] || []) {
        assert.notEqual(vm.runInContext('typeof '+name,sandbox),'undefined',file+': '+filename+' requires '+name+' first');
      }
      assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(root,filename),'utf8'),sandbox),file+': '+filename);
    }
    await new Promise(setImmediate);
    if (file === 'index.html' || file === 'preview.html') assert.match(nodes.get('appScreen').innerHTML,/바자회를 이용하려면/);
  }
});

test('wallet entry redirects preview links without starting a real wallet session', () => {
  let destination;
  vm.runInNewContext(fs.readFileSync(path.join(root,'app.js'),'utf8'), {
    URLSearchParams,location:{search:'?preview=1',hash:'#insufficient',replace:value => { destination = value; }},
    BazaarLive:{create(){throw new Error('Preview must not initialize the wallet');}}
  });
  assert.equal(destination,'/preview.html?preview=1#insufficient');
  const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.doesNotMatch(html,/preview\.js|id="stateSelect"|id="approveDemo"/);
});
