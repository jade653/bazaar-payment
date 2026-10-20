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
    async function batch(calls) {
      const payload = calls.map(call => ({ jsonrpc:'2.0', id:nextId++, method:call.method, params:call.params }));
      const response = await fetchImpl(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      if (!response.ok) throw failure('HISTORY_UNAVAILABLE');
      const body = await response.json();
      if (!Array.isArray(body)) throw failure('HISTORY_UNAVAILABLE');
      const byId = new Map(body.map(item => [item.id,item]));
      return payload.map(item => {
        const response = byId.get(item.id);
        if (!response || response.error || response.result == null) throw failure('HISTORY_UNAVAILABLE');
        return response.result;
      });
    }
    const [latestHex] = await batch([{method:'eth_blockNumber',params:[]}]);
    if (!latestHex) throw failure('HISTORY_UNAVAILABLE');
    const latest = Number(BigInt(latestHex)), lower = Math.max(0, latest - blockWindow + 1), found = [];
    scan: for (let high = latest; high >= lower && found.length < limit; high -= 100) {
      const low = Math.max(lower, high - 99), calls = [];
      for (let number = high; number >= low; number--) calls.push({method:'eth_getBlockByNumber',params:['0x'+number.toString(16),true]});
      const blocks = await batch(calls);
      for (const block of blocks) for (const tx of [...(block?.transactions || [])].reverse()) {
        const from = String(tx.from || '').toLowerCase(), to = String(tx.to || '').toLowerCase(), own = account.toLowerCase();
        if (from !== own && to !== own) continue;
        found.push({ hash:tx.hash, blockNumber:tx.blockNumber || block.number, timestamp:Number(BigInt(block.timestamp)), direction:to===own?'in':'out', valueWei:BigInt(tx.value || '0x0') });
        if (found.length >= limit) break scan;
      }
    }
    if (!found.length) return [];
    const balances = await batch(found.map(item => ({method:'eth_getBalance',params:[account,item.blockNumber]})));
    return found.map((item,index) => ({...item,balanceWei:BigInt(balances[index])}));
  }
  // A request belongs to one account. Late responses must never replace another account's history.
  function create({ query, onChange = () => {} }) {
    let state = { account:null, items:[], loading:false, error:'' }, revision = 0, active = null;
    const publish = next => { state = { ...state, ...next }; onChange({ ...state }); };
    function clear() { revision++; active = null; publish({ account:null, items:[], loading:false, error:'' }); }
    function load(account) {
      if (!account) { clear(); return Promise.resolve(); }
      const key = account.toLowerCase();
      if (state.account === key && active) return active;
      const request = ++revision, changed = state.account !== key;
      publish({ account:key, items:changed ? [] : state.items, loading:true, error:'' });
      active = Promise.resolve().then(() => query(account)).then(items => {
        if (request === revision) publish({ items, loading:false });
      }, () => {
        if (request === revision) publish({ loading:false, error:'거래 내역을 불러오지 못했어요. 다시 확인해 주세요.' });
      }).finally(() => { if (request === revision) active = null; });
      return active;
    }
    return { load, clear, snapshot: () => ({ ...state }) };
  }
  return { create, recentTransfers };
});
