(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const HASH = /^0x[0-9a-f]{64}$/i;
  const SYNC_INTERVAL = 60000;
  // Keep an 8s HTTP budget to allow extra headroom for mobile latency.
  // Reproduce with tools/measure-rpc.cjs; measurements/rpc-latency.json records the sample.
  const RPC_TIMEOUT = 8000;
  const sentKey = (chainId, account) => 'bazaar-sent-v1:' + chainId + ':' + account.toLowerCase();
  function getStorage(storage) {
    try { return storage === undefined ? globalThis.localStorage : storage; } catch { return null; }
  }
  function sentTransactions({ chainId, account, storage, now = Date.now }) {
    try {
      const rows = JSON.parse(getStorage(storage)?.getItem(sentKey(chainId, account)) || '[]');
      return Array.isArray(rows) ? rows.filter(row => HASH.test(row.hash || '') && Number.isFinite(row.savedAt) && row.savedAt > now() - 86400000).slice(-200) : [];
    } catch { return []; }
  }
  function recordSent({ chainId, account, hash, storage, now = Date.now }) {
    if (!ADDRESS.test(account || '') || !HASH.test(hash || '')) return;
    const rows = sentTransactions({ chainId, account, storage, now });
    if (!rows.some(row => row.hash.toLowerCase() === hash.toLowerCase())) rows.push({ hash, savedAt:now() });
    try { getStorage(storage)?.setItem(sentKey(chainId, account), JSON.stringify(rows.slice(-200))); } catch {}
  }
  const failure = code => Object.assign(new Error(code), { code });
  async function recentTransfers(fetchImpl, { account, rpcUrl, blockWindow = 600, limit = 20, fromBlock, sync = false, sent = [], requestTimeout = RPC_TIMEOUT }) {
    if (typeof fetchImpl !== 'function' || !ADDRESS.test(account || '')) throw failure('INVALID_ADDRESS');
    let nextId = 1;
    async function batch(calls, optional = false) {
      const payload = calls.map(call => ({ jsonrpc:'2.0', id:nextId++, method:call.method, params:call.params }));
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload), ...(controller ? {signal:controller.signal} : {}) });
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
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => { reject(failure('HISTORY_TIMEOUT')); controller?.abort(); }, requestTimeout);
          })
        ]);
      } finally { clearTimeout(timer); }
    }
    const [latestHex] = await batch([{method:'eth_blockNumber',params:[]}]);
    if (!latestHex) throw failure('HISTORY_UNAVAILABLE');
    const latest = Number(BigInt(latestHex));
    // A cursor is committed only after the entire requested range succeeds.
    const lower = Number.isSafeInteger(fromBlock) && fromBlock <= latest + 1 ? Math.max(0, fromBlock) : Math.max(0, latest - blockWindow + 1);
    const found = [], settledHashes = [];
    const readLimit = sync ? Infinity : limit;
    for (let high = latest; high >= lower && found.length < readLimit; high -= 100) {
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
      for (let index = 0; index < candidates.length && found.length < readLimit; index++) {
        if (['0x1','0x01',1].includes(receipts[index].status)) found.push(candidates[index]);
      }
    }
    // Known outgoing hashes also recover transactions outside the initial block window.
    for (const row of sent) {
      if (!HASH.test(row.hash || '')) continue;
      const [receipt] = await batch([{method:'eth_getTransactionReceipt',params:[row.hash]}], true);
      if (!receipt || !receipt.blockNumber || BigInt(receipt.blockNumber) > BigInt(latestHex)) continue;
      if (!['0x0','0x00',0,'0x1','0x01',1].includes(receipt.status)) throw failure('HISTORY_UNAVAILABLE');
      settledHashes.push(row.hash.toLowerCase());
      if (!['0x1','0x01',1].includes(receipt.status) || found.some(item => item.hash.toLowerCase() === row.hash.toLowerCase())) continue;
      const [tx, block] = await batch([{method:'eth_getTransactionByHash',params:[row.hash]}, {method:'eth_getBlockByNumber',params:[receipt.blockNumber,false]}]);
      if (String(tx.from).toLowerCase() !== account.toLowerCase()) throw failure('HISTORY_UNAVAILABLE');
      found.push({hash:row.hash,blockNumber:receipt.blockNumber,timestamp:Number(BigInt(block.timestamp)),direction:String(tx.to).toLowerCase() === account.toLowerCase() ? 'in' : 'out',valueWei:BigInt(tx.value || '0x0')});
    }
    let balances;
    try { balances = found.length ? await batch(found.map(item => ({method:'eth_getBalance',params:[account,item.blockNumber]})), true) : []; }
    catch { balances = []; }
    const items = found.map((item,index) => ({...item,balanceWei:/^0x[0-9a-f]+$/i.test(balances[index] || '') ? BigInt(balances[index]) : null}));
    if (!sync) return items;
    // Pin the comparison balance to the same block as the completed scan.
    const [balance] = await batch([{method:'eth_getBalance',params:[account,latestHex]}]);
    if (!/^0x[0-9a-f]+$/i.test(balance)) throw failure('HISTORY_UNAVAILABLE');
    return { items, lastScannedBlock:latest, balanceWei:BigInt(balance).toString(), settledHashes };
  }
  // A request belongs to one account. Late responses must never replace another account's history.
  function create({ query, onChange = () => {}, chainId = '', limit = 20, storage, now = Date.now, syncInterval = SYNC_INTERVAL }) {
    let state = { account:null, items:[], loading:false, error:'' }, revision = 0, active = null, activeBalance, activeForce;
    try { if (storage === undefined) storage = globalThis.localStorage; } catch { storage = null; }
    const storageKey = account => 'bazaar-history-v1:' + chainId + ':' + account;
    const syncKey = account => 'bazaar-sync-v1:' + chainId + ':' + account;
    const errorKey = account => 'bazaar-history-error-v1:' + chainId + ':' + account;
    const failedAccounts = new Map();
    const errorMessage = '최신 거래 내역을 불러오지 못했어요. 다시 확인해 주세요.';
    function previouslyFailed(account) {
      if (failedAccounts.has(account)) return failedAccounts.get(account);
      try { return storage?.getItem(errorKey(account)) === '1'; } catch { return false; }
    }
    function markFailed(account, failed) {
      if (failed || previouslyFailed(account)) {
        try { storage?.setItem(errorKey(account), failed ? '1' : '0'); } catch {}
      }
      failedAccounts.set(account, failed);
    }
    const metadata = new Map();
    function readMeta(account) {
      if (metadata.has(account)) return metadata.get(account);
      try {
        const value = JSON.parse(storage?.getItem(syncKey(account)) || 'null');
        if (!value || !Number.isSafeInteger(value.lastScannedBlock) || value.lastScannedBlock < 0
          || !/^\d+$/.test(value.balanceWei) || !Number.isFinite(value.checkedAt) || !Array.isArray(value.items)
          || !Array.isArray(value.settledHashes)) return {};
        return value;
      } catch { return {}; }
    }
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
        const items = readMeta(account).items || JSON.parse(storage?.getItem(storageKey(account)) || '[]');
        return Array.isArray(items) ? merge(items) : [];
      } catch { return []; }
    }
    function save(account, items) {
      try { storage?.setItem(storageKey(account), JSON.stringify(items, (_key,value) => typeof value === 'bigint' ? value.toString() : value)); } catch {}
    }
    const publish = next => { state = { ...state, ...next }; onChange({ ...state }); };
    function clear() { revision++; active = null; publish({ account:null, items:[], loading:false, error:'' }); }
    function load(account, { balanceWei, force = false } = {}) {
      if (!account) { clear(); return Promise.resolve(); }
      const key = account.toLowerCase();
      if (state.account === key && active) {
        if ((!force || activeForce) && (balanceWei == null || balanceWei === activeBalance)) return active;
        const queuedRevision = revision;
        return active.then(() => { if (revision === queuedRevision && state.account === key) return load(account, { balanceWei, force }); });
      }
      const request = ++revision, changed = state.account !== key;
      const cached = read(key);
      const meta = readMeta(key);
      const sent = sentTransactions({chainId,account:key,storage,now}).filter(row => !(meta.settledHashes || []).includes(row.hash.toLowerCase()));
      const validCursor = Number.isSafeInteger(meta.lastScannedBlock) && meta.lastScannedBlock >= 0;
      const due = !Number.isFinite(meta.checkedAt) || now() < meta.checkedAt || now() - meta.checkedAt >= syncInterval;
      const hadError = previouslyFailed(key);
      if (!force && !hadError && balanceWei != null && validCursor && !due && !sent.length && String(balanceWei) === meta.balanceWei) {
        publish({account:key,items:merge(state.account === key ? state.items : [],cached).slice(0,limit),loading:false,error:''});
        return Promise.resolve();
      }
      publish({ account:key, items:changed ? cached.slice(0,limit) : storage ? merge(state.items,cached).slice(0,limit) : state.items, loading:true, error:hadError ? errorMessage : '' });
      activeBalance = balanceWei; activeForce = force;
      active = Promise.resolve().then(async () => {
        // One silent retry; a superseded account must never start another request.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (request !== revision) return;
          try { return await query(account, { fromBlock:validCursor ? meta.lastScannedBlock + 1 : undefined, sync:true, sent }); }
          catch (error) { if (attempt === 1) throw error; }
        }
      }).then(result => {
        if (request !== revision) return;
        const items = Array.isArray(result) ? result : result.items;
        const merged = storage || !Array.isArray(result) ? merge(items, state.items, read(key)) : items;
        if (Array.isArray(result)) save(key, merged);
        if (!Array.isArray(result) && Number.isSafeInteger(result.lastScannedBlock)) {
          // The cursor and the items it describes must survive storage failures together.
          const next = {items:merged,lastScannedBlock:result.lastScannedBlock,balanceWei:result.balanceWei,checkedAt:now(),settledHashes:[...new Set([...(meta.settledHashes || []),...(result.settledHashes || [])])].slice(-200)};
          metadata.set(key,next);
          try { storage?.setItem(syncKey(key),JSON.stringify(next, (_key,value) => typeof value === 'bigint' ? value.toString() : value)); } catch {}
        }
        markFailed(key, false);
        publish({ items:merged.slice(0,limit), loading:false, error:'' });
      }).catch(() => {
        if (request === revision) { markFailed(key, true); publish({ loading:false, error:errorMessage }); }
      }).finally(() => { if (request === revision) active = null; });
      return active;
    }
    return { load, clear, snapshot: () => ({ ...state }) };
  }
  return { create, recentTransfers, recordSent, sentTransactions, SYNC_INTERVAL };
});
