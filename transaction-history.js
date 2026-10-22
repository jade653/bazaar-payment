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
  // Reproduce latency samples with tools/measure-rpc.cjs.
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
  const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const LOG_CHUNK = 50000;
  // First visit covers one day of two-second blocks; later syncs continue from the cursor.
  const DEFAULT_WINDOW = 43200;
  const hexOK = value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value);
  const topicOf = account => '0x' + account.slice(2).toLowerCase().padStart(64, '0');
  const topicAddress = topic => '0x' + String(topic || '').slice(-40);
  // wMST Transfer events for one account, read from the public RPC log index. Row balances
  // are derived from the pinned head balance and the complete event set, not from historical state.
  async function recentTransfers(fetchImpl, { account, rpcUrl, token, blockWindow = DEFAULT_WINDOW, fromBlock, sent = [], requestTimeout = RPC_TIMEOUT }) {
    if (typeof fetchImpl !== 'function' || !ADDRESS.test(account || '')) throw failure('INVALID_ADDRESS');
    if (!token || !ADDRESS.test(token.address || '')) throw failure('TOKEN_NOT_CONFIGURED');
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
    if (!hexOK(latestHex)) throw failure('HISTORY_UNAVAILABLE');
    const latest = Number(BigInt(latestHex));
    // A cursor is committed only after the entire requested range succeeds.
    const floor = Number.isSafeInteger(token.deployBlock) ? token.deployBlock : 0;
    const lower = Math.max(floor, Number.isSafeInteger(fromBlock) && fromBlock <= latest + 1 ? Math.max(0, fromBlock) : Math.max(0, latest - blockWindow + 1));
    const me = topicOf(account), own = account.toLowerCase(), tokenAddress = token.address.toLowerCase(), topic = token.transferTopic || TRANSFER_TOPIC;
    const found = new Map();
    const rowFrom = (log, hash) => {
      if (!log || log.removed || String(log.address).toLowerCase() !== tokenAddress || log.topics?.[0] !== topic) return null;
      const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
      if (from.toLowerCase() !== own && to.toLowerCase() !== own) return null;
      const direction = from.toLowerCase() === own ? 'out' : 'in';
      return { hash, blockNumber:log.blockNumber, logIndex:Number(BigInt(log.logIndex || '0x0')), direction, counterparty:direction === 'out' ? to : from, valueWei:BigInt(log.data || '0x0') };
    };
    for (let low = lower; low <= latest; low += LOG_CHUNK) {
      const high = Math.min(latest, low + LOG_CHUNK - 1);
      const range = { address:token.address, fromBlock:'0x' + low.toString(16), toBlock:'0x' + high.toString(16) };
      const [outgoing, incoming] = await batch([
        {method:'eth_getLogs',params:[{ ...range, topics:[topic, me] }]},
        {method:'eth_getLogs',params:[{ ...range, topics:[topic, null, me] }]}
      ]);
      for (const log of [...outgoing, ...incoming]) {
        if (!HASH.test(log?.transactionHash || '')) continue;
        const row = rowFrom(log, log.transactionHash);
        if (row) found.set(log.transactionHash.toLowerCase() + ':' + row.logIndex, row);
      }
    }
    const items = [...found.values()];
    const blocks = [...new Set(items.map(item => item.blockNumber))];
    const headers = blocks.length ? await batch(blocks.map(number => ({method:'eth_getBlockByNumber',params:[number,false]}))) : [];
    const timestamps = new Map(blocks.map((number, index) => [number, Number(BigInt(headers[index]?.timestamp || '0x0'))]));
    for (const item of items) item.timestamp = timestamps.get(item.blockNumber);
    // Pin the comparison balance to the same block as the completed scan.
    const [balance] = await batch([{method:'eth_call',params:[{ to:token.address, data:token.selectors.balanceOf + me.slice(2) }, latestHex]}]);
    if (!hexOK(balance) || balance.length < 3) throw failure('HISTORY_UNAVAILABLE');
    items.sort((a, b) => Number(BigInt(b.blockNumber)) - Number(BigInt(a.blockNumber)) || b.logIndex - a.logIndex);
    let running = BigInt(balance);
    for (const item of items) { item.balanceWei = running; running += item.direction === 'in' ? -item.valueWei : item.valueWei; }
    // Known outgoing hashes also recover transfers outside the scanned range.
    const settledHashes = [], seen = new Set(items.map(item => item.hash.toLowerCase()));
    for (const row of sent) {
      const hash = String(row?.hash || '');
      if (!HASH.test(hash)) continue;
      if (seen.has(hash.toLowerCase())) { settledHashes.push(hash); continue; }
      const [receipt] = await batch([{method:'eth_getTransactionReceipt',params:[hash]}], true);
      if (!receipt) continue;
      if (['0x1','0x01',1].includes(receipt.status)) {
        const [header] = await batch([{method:'eth_getBlockByNumber',params:[receipt.blockNumber,false]}], true);
        for (const log of receipt.logs || []) {
          const item = rowFrom(log, receipt.transactionHash || hash);
          if (item) items.push({ ...item, timestamp:Number(BigInt(header?.timestamp || '0x0')), balanceWei:null });
        }
      }
      settledHashes.push(hash);
    }
    return { items, lastScannedBlock:latest, balanceWei:BigInt(balance).toString(), settledHashes };
  }
  // A request belongs to one account. Late responses must never replace another account's history.
  function create({ query, onChange = () => {}, chainId = '', limit = 20, storage, now = Date.now, syncInterval = SYNC_INTERVAL }) {
    let state = { account:null, items:[], loading:false, error:'' }, revision = 0, active = null, activeBalance, activeForce;
    try { if (storage === undefined) storage = globalThis.localStorage; } catch { storage = null; }
    const syncKey = account => 'bazaar-sync-v2:' + chainId + ':' + account;
    const errorKey = account => 'bazaar-history-error-v2:' + chainId + ':' + account;
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
        const items = readMeta(account).items;
        return Array.isArray(items) ? merge(items) : [];
      } catch { return []; }
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
      publish({ account:key, items:merge(changed ? [] : state.items,cached).slice(0,limit), loading:true, error:hadError ? errorMessage : '' });
      activeBalance = balanceWei; activeForce = force;
      active = Promise.resolve().then(async () => {
        // One silent retry; a superseded account must never start another request.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (request !== revision) return;
          try { return await query(account, { fromBlock:validCursor ? meta.lastScannedBlock + 1 : undefined, sent }); }
          catch (error) { if (attempt === 1) throw error; }
        }
      }).then(result => {
        if (request !== revision) return;
        if (!Array.isArray(result.items) || !Number.isSafeInteger(result.lastScannedBlock) || result.lastScannedBlock < 0 || !/^\d+$/.test(result.balanceWei)) throw failure('HISTORY_UNAVAILABLE');
        const merged = merge(result.items, state.items, read(key));
        // The cursor and the items it describes must survive storage failures together.
        const next = {items:merged,lastScannedBlock:result.lastScannedBlock,balanceWei:result.balanceWei,checkedAt:now(),settledHashes:[...new Set([...(meta.settledHashes || []),...(result.settledHashes || [])])].slice(-200)};
        metadata.set(key,next);
        try { storage?.setItem(syncKey(key),JSON.stringify(next, (_key,value) => typeof value === 'bigint' ? value.toString() : value)); } catch {}
        markFailed(key, false);
        publish({ items:merged.slice(0,limit), loading:false, error:'' });
      }).catch(() => {
        if (request === revision) { markFailed(key, true); publish({ loading:false, error:errorMessage }); }
      }).finally(() => { if (request === revision) active = null; });
      return active;
    }
    return { load, clear, snapshot: () => ({ ...state }) };
  }
  return { create, recentTransfers, recordSent, sentTransactions, SYNC_INTERVAL, DEFAULT_WINDOW };
});
