(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const failure = code => Object.assign(new Error(code), { code });
  async function recentTransfers(fetchImpl, { account, rpcUrl, blockWindow = 600, limit = 20 }) {
    if (typeof fetchImpl !== 'function' || !ADDRESS.test(account || '')) throw failure('INVALID_ADDRESS');
    let nextId = 1;
    async function batch(calls, optional = false) {
      const payload = calls.map(call => ({ jsonrpc:'2.0', id:nextId++, method:call.method, params:call.params }));
      const response = await fetchImpl(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      if (!response.ok) throw failure('HISTORY_UNAVAILABLE');
      const body = await response.json();
      if (!Array.isArray(body)) throw failure('HISTORY_UNAVAILABLE');
      const byId = new Map(body.map(item => [item.id,item]));
      return payload.map(item => {
        const response = byId.get(item.id);
        if (!response || response.error || response.result == null) {
          if (optional) return null;
          throw failure('HISTORY_UNAVAILABLE');
        }
        return response.result;
      });
    }
    const [latestHex] = await batch([{method:'eth_blockNumber',params:[]}]);
    if (!latestHex) throw failure('HISTORY_UNAVAILABLE');
    const latest = Number(BigInt(latestHex)), lower = Math.max(0, latest - blockWindow + 1), found = [];
    for (let high = latest; high >= lower && found.length < limit; high -= 100) {
      const low = Math.max(lower, high - 99), calls = [];
      for (let number = high; number >= low; number--) calls.push({method:'eth_getBlockByNumber',params:['0x'+number.toString(16),true]});
      const blocks = await batch(calls);
      const candidates = [];
      for (const block of blocks) for (const tx of [...(block?.transactions || [])].reverse()) {
        const from = String(tx.from || '').toLowerCase(), to = String(tx.to || '').toLowerCase(), own = account.toLowerCase();
        if (from !== own && to !== own) continue;
        candidates.push({ hash:tx.hash, blockNumber:tx.blockNumber || block.number, timestamp:Number(BigInt(block.timestamp)), direction:to===own?'in':'out', valueWei:BigInt(tx.value || '0x0') });
      }
      if (!candidates.length) continue;
      const receipts = await batch(candidates.map(item => ({method:'eth_getTransactionReceipt',params:[item.hash]})));
      for (let index = 0; index < candidates.length && found.length < limit; index++) {
        if (['0x1','0x01',1].includes(receipts[index].status)) found.push(candidates[index]);
      }
    }
    if (!found.length) return [];
    let balances;
    try { balances = await batch(found.map(item => ({method:'eth_getBalance',params:[account,item.blockNumber]})), true); }
    catch { balances = []; }
    return found.map((item,index) => ({...item,balanceWei:/^0x[0-9a-f]+$/i.test(balances[index] || '') ? BigInt(balances[index]) : null}));
  }
  // A request belongs to one account. Late responses must never replace another account's history.
  function create({ query, onChange = () => {}, chainId = '', limit = 20, storage, now = Date.now }) {
    let state = { account:null, items:[], loading:false, error:'' }, revision = 0, active = null;
    try { if (storage === undefined) storage = globalThis.localStorage; } catch { storage = null; }
    const storageKey = account => 'bazaar-history-v1:' + chainId + ':' + account;
    function merge(...groups) {
      const unique = new Map(), currentTime = Math.floor(now() / 1000);
      for (const item of groups.flat()) {
        try {
          if (!/^0x[0-9a-f]{64}$/i.test(item.hash || '') || !Number.isInteger(item.timestamp)
            || item.timestamp < currentTime - 86400 || item.timestamp > currentTime + 60
            || !['in','out'].includes(item.direction) || !/^\d+$/.test(String(item.valueWei))) continue;
          const valueWei = BigInt(item.valueWei), balanceWei = item.balanceWei == null ? null : BigInt(item.balanceWei);
          if (valueWei < 0n || (balanceWei != null && balanceWei < 0n)) continue;
          const existing = unique.get(item.hash.toLowerCase());
          if (existing) { if (existing.balanceWei == null) existing.balanceWei = balanceWei; continue; }
          unique.set(item.hash.toLowerCase(), { hash:item.hash, blockNumber:item.blockNumber, timestamp:item.timestamp, direction:item.direction, valueWei, balanceWei });
        } catch {}
      }
      return [...unique.values()].sort((a,b) => b.timestamp - a.timestamp).slice(0,200);
    }
    function read(account) {
      try {
        const items = JSON.parse(storage?.getItem(storageKey(account)) || '[]');
        return Array.isArray(items) ? merge(items) : [];
      } catch { return []; }
    }
    function save(account, items) {
      try { storage?.setItem(storageKey(account), JSON.stringify(items, (_key,value) => typeof value === 'bigint' ? value.toString() : value)); } catch {}
    }
    const publish = next => { state = { ...state, ...next }; onChange({ ...state }); };
    function clear() { revision++; active = null; publish({ account:null, items:[], loading:false, error:'' }); }
    function load(account) {
      if (!account) { clear(); return Promise.resolve(); }
      const key = account.toLowerCase();
      if (state.account === key && active) return active;
      const request = ++revision, changed = state.account !== key;
      const cached = read(key);
      publish({ account:key, items:changed ? cached.slice(0,limit) : storage ? merge(state.items,cached).slice(0,limit) : state.items, loading:true, error:'' });
      active = Promise.resolve().then(() => query(account)).then(items => {
        if (request !== revision) return;
        const merged = storage ? merge(items, state.items, read(key)) : items;
        save(key, merged);
        publish({ items:merged.slice(0,limit), loading:false });
      }, () => {
        if (request === revision) publish({ loading:false, error:'최신 거래 내역을 불러오지 못했어요. 다시 확인해 주세요.' });
      }).finally(() => { if (request === revision) active = null; });
      return active;
    }
    return { load, clear, snapshot: () => ({ ...state }) };
  }
  return { create, recentTransfers };
});
