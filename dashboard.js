(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarDashboard = api;
  // Browser entry: the operator dashboard page mounts itself once the DOM is parsed.
  if (root.document && root.document.getElementById && root.document.getElementById('dashboardScreen') && root.BazaarWallet) {
    api.active = api.create({ root, Wallet:root.BazaarWallet, Transfer:root.BazaarTransfer, UI:root.BazaarUI });
    api.active.start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const HASH = /^0x[0-9a-f]{64}$/i, ADDRESS = /^0x[0-9a-f]{40}$/i;
  const LOG_CHUNK = 50000, HEADER_BATCH = 100, HEADER_CAP = 300;
  const REFRESH_INTERVAL = 10000, RPC_TIMEOUT = 8000, RECENT_LIMIT = 50;
  const STORES_KEY = 'bazaar-dashboard-stores-v1';
  const failure = code => Object.assign(new Error(code), { code });
  const topicAddress = topic => '0x' + String(topic || '').slice(-40).toLowerCase();
  const blockOf = value => Number(BigInt(value || '0x0'));
  const hex = number => '0x' + Number(number).toString(16);
  const key = log => String(log.transactionHash).toLowerCase() + ':' + blockOf(log.logIndex);
  const shortAddress = address => address ? address.slice(0, 7) + '…' + address.slice(-5) : '—';

  // Drops removed logs, dedupes by hash+logIndex and keeps chain order.
  function mergeLogs(existing = [], incoming = []) {
    const unique = new Map();
    for (const log of [...existing, ...incoming]) {
      if (!log || log.removed || !HASH.test(log.transactionHash || '') || !Array.isArray(log.topics) || log.topics.length < 3) continue;
      unique.set(key(log), log);
    }
    return [...unique.values()].sort((a, b) => blockOf(a.blockNumber) - blockOf(b.blockNumber) || blockOf(a.logIndex) - blockOf(b.logIndex));
  }

  // Pure view of the token: operator wallets hand out (충전) and take back (회수) wMST; everything
  // between other wallets is a 송금. Customer wallets are numbered in order of their first top-up.
  function aggregate(logs, { treasury = null, operators = [], stores = [] } = {}) {
    const rows = mergeLogs([], logs).map(log => ({
      hash:log.transactionHash, blockNumber:blockOf(log.blockNumber), logIndex:blockOf(log.logIndex),
      from:topicAddress(log.topics[1]), to:topicAddress(log.topics[2]), value:BigInt(log.data || '0x0')
    }));
    let treasuryAddress = treasury ? treasury.toLowerCase() : null, totalSupply = 0n;
    for (const row of rows) if (row.from === ZERO) { totalSupply += row.value; if (!treasuryAddress) treasuryAddress = row.to; }
    const operatorSet = new Set([treasuryAddress, ...operators.map(item => String(item).toLowerCase())].filter(Boolean));
    const storeSet = new Set(stores.map(item => String(item).toLowerCase()));
    const balances = new Map(), wallets = new Map(), transfers = [];
    let toppedUp = 0n, recovered = 0n, topUpCount = 0, recoveryCount = 0, paymentCount = 0, nextNumber = 1, order = 0;
    const wallet = address => {
      if (!wallets.has(address)) wallets.set(address, { address, number:null, order:order++, isStore:storeSet.has(address), balance:0n, toppedUp:0n, sent:0n, received:0n, recovered:0n, recoveredFlag:false, lastBlock:0, transferCount:0 });
      return wallets.get(address);
    };
    const touch = (address, row) => { const entry = wallet(address); entry.lastBlock = Math.max(entry.lastBlock, row.blockNumber); entry.transferCount++; return entry; };
    for (const row of rows) {
      if (row.from !== ZERO) balances.set(row.from, (balances.get(row.from) || 0n) - row.value);
      balances.set(row.to, (balances.get(row.to) || 0n) + row.value);
      if (row.from === ZERO) continue;
      const fromOperator = operatorSet.has(row.from), toOperator = operatorSet.has(row.to);
      let type;
      if (fromOperator && toOperator) continue;
      if (fromOperator) {
        type = '충전'; toppedUp += row.value; topUpCount++;
        const entry = touch(row.to, row); entry.toppedUp += row.value;
        if (entry.number == null) entry.number = nextNumber++;
      } else if (toOperator) {
        type = '회수'; recovered += row.value; recoveryCount++;
        const entry = touch(row.from, row); entry.sent += row.value; entry.recovered += row.value; entry.recoveredFlag = true;
      } else {
        type = '송금'; paymentCount++;
        touch(row.from, row).sent += row.value;
        touch(row.to, row).received += row.value;
      }
      transfers.push({ ...row, type });
    }
    for (const entry of wallets.values()) entry.balance = balances.get(entry.address) || 0n;
    const treasuryBalance = treasuryAddress ? balances.get(treasuryAddress) || 0n : 0n;
    transfers.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    const list = [...wallets.values()].sort((a, b) => (b.isStore - a.isStore) || ((a.number ?? Infinity) - (b.number ?? Infinity)) || a.order - b.order);
    return {
      treasury:treasuryAddress, operators:[...operatorSet], totalSupply, treasuryBalance, circulating:totalSupply - treasuryBalance,
      toppedUp, recovered, topUpCount, recoveryCount, paymentCount, storeCount:list.filter(item => item.isStore).length,
      wallets:list, transfers
    };
  }

  // Column sorts for the wallet table; the default order is the numbered list from aggregate().
  function sortWallets(wallets, { key = 'number', direction = 'desc' } = {}) {
    if (key === 'number') return [...wallets];
    const sign = direction === 'asc' ? 1 : -1;
    const value = item => key === 'recent' ? BigInt(item.lastBlock) : item[key];
    return [...wallets].sort((a, b) => { const x = value(a), y = value(b); return x === y ? 0 : (x > y ? sign : -sign); });
  }

  function relativeTime(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp)) return '—';
    const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
    if (seconds < 60) return '방금 전';
    if (seconds < 3600) return Math.floor(seconds / 60) + '분 전';
    if (seconds < 86400) return Math.floor(seconds / 3600) + '시간 전';
    return Math.floor(seconds / 86400) + '일 전';
  }
  const exactTime = timestamp => Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';

  function createRpc({ fetchImpl, url, timeout = RPC_TIMEOUT }) {
    let nextId = 1;
    return async function rpc(calls) {
      if (!calls.length) return [];
      const payload = calls.map(call => ({ jsonrpc:'2.0', id:nextId++, method:call.method, params:call.params }));
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload), ...(controller ? { signal:controller.signal } : {}) });
            if (!response.ok) throw failure('RPC_HTTP_ERROR');
            const body = await response.json();
            if (!Array.isArray(body)) throw failure('RPC_INVALID');
            const byId = new Map(body.map(item => [item.id, item]));
            return payload.map(item => {
              const reply = byId.get(item.id);
              if (!reply || reply.error || reply.result === undefined) throw failure('RPC_INVALID');
              return reply.result;
            });
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { reject(failure('RPC_TIMEOUT')); controller?.abort(); }, timeout); })
        ]);
      } finally { clearTimeout(timer); }
    };
  }

  function sampleData(now) {
    const treasury = '0x' + 'a'.repeat(40), customerA = '0x' + '1'.repeat(40), customerB = '0x' + '2'.repeat(40), store = '0x' + '5'.repeat(40);
    const pad = address => '0x' + address.slice(2).padStart(64, '0');
    const log = (block, index, from, to, value) => ({ address:'0x' + 'c'.repeat(40), blockNumber:hex(block), logIndex:hex(index), transactionHash:'0x' + (block * 10 + index).toString(16).padStart(64, '0'), removed:false, topics:['0x' + 'd'.repeat(64), pad(from), pad(to)], data:'0x' + value.toString(16).padStart(64, '0') });
    const logs = [log(100, 0, ZERO, treasury, 1000000000n), log(110, 0, treasury, customerA, 20000n), log(112, 0, treasury, customerB, 50000n), log(120, 0, customerA, store, 7500n), log(125, 0, customerB, store, 12000n), log(130, 0, customerB, treasury, 38000n), log(131, 0, treasury, customerA, 10000n)];
    const timestamps = new Map([[100, now - 7200], [110, now - 3600], [112, now - 3000], [120, now - 1500], [125, now - 900], [130, now - 300], [131, now - 40]]);
    return { logs, latest:140, timestamps, stores:[store] };
  }

  function create({ root, Wallet, Transfer, UI, fetchImpl = root.fetch ? root.fetch.bind(root) : null, now = () => Date.now(), interval = REFRESH_INTERVAL }) {
    const doc = root.document, token = Wallet.TOKEN;
    const preview = (() => { try { return new URL(root.location.href).searchParams.has('preview'); } catch { return false; } })();
    const node = id => doc.getElementById(id);
    const rpc = preview || !fetchImpl ? null : createRpc({ fetchImpl, url:Wallet.NETWORK.rpcUrls[0] });
    let storage = null; try { storage = root.localStorage || null; } catch {}
    let logs = [], cursor = null, summary = null, timestamps = new Map();
    let search = '', sort = { key:'number', direction:'desc' }, error = '', loading = false, updatedAt = null, timer = null, stopped = false;
    let selected = null, selectedFee = null;
    let stores = []; try { const saved = JSON.parse(storage?.getItem(STORES_KEY) || '[]'); if (Array.isArray(saved)) stores = saved.filter(item => ADDRESS.test(item)).map(item => item.toLowerCase()); } catch {}
    const rendered = {};
    const won = value => UI.won(value);
    const timeOf = block => timestamps.get(block);
    const write = (id, html) => { const target = node(id); if (target && rendered[id] !== html) { target.innerHTML = html; rendered[id] = html; } };
    const summarize = () => { summary = aggregate(logs, { operators:token.operatorWallets || [], stores }); };
    const partyLabel = address => summary?.operators.includes(address) ? '운영' : summary?.wallets.find(item => item.address === address)?.isStore ? '가게' : '';
    function render() {
      if (stopped) return;
      const status = node('dashboardStatus');
      if (status) { status.hidden = !error; status.textContent = error; }
      const updated = node('dashboardUpdated');
      if (updated) updated.textContent = loading ? '확인 중…' : updatedAt ? '갱신 ' + new Date(updatedAt).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
      if (!summary) { write('dashboardStats', loading ? '<p class="dashboard-empty">현황을 불러오고 있어요.</p>' : ''); write('dashboardWallets', ''); write('dashboardTransfers', ''); return; }
      const card = (title, value, sub = '') => `<div class="dashboard-card"><span>${UI.esc(title)}</span><strong>${value}</strong>${sub ? `<small>${UI.esc(sub)}</small>` : ''}</div>`;
      write('dashboardStats', [
        card('충전 합계', won(summary.toppedUp), `${summary.topUpCount.toLocaleString('ko-KR')}건`),
        card('결제', `${summary.paymentCount.toLocaleString('ko-KR')}건`, '지갑 간 송금'),
        card('지갑 수', `${summary.wallets.length.toLocaleString('ko-KR')}개`, `가게 ${summary.storeCount}개`),
        card('회수 합계', won(summary.recovered), `${summary.recoveryCount.toLocaleString('ko-KR')}건`)
      ].join(''));
      const query = search.trim().toLowerCase();
      const wallets = sortWallets(summary.wallets.filter(item => !query || item.address.includes(query)), sort);
      const head = (label, keyName, numeric = true) => `<th${numeric ? ' class="num"' : ''}><button type="button" data-sort="${keyName}"${sort.key === keyName ? ' class="active"' : ''}>${label}${sort.key === keyName && keyName !== 'number' ? (sort.direction === 'desc' ? ' ↓' : ' ↑') : ''}</button></th>`;
      const rows = wallets.map(item => {
        const time = timeOf(item.lastBlock);
        return `<tr data-wallet="${item.address}" tabindex="0" role="button"><td class="num">${item.isStore ? '<span class="dashboard-chip store">가게</span>' : item.number ?? '—'}</td><td><code>${UI.esc(shortAddress(item.address))}</code>${item.recoveredFlag ? '<span class="dashboard-chip recovered">회수</span>' : ''}</td><td class="num">${won(item.balance)}</td><td class="num">${won(item.sent)}</td><td class="num">${won(item.toppedUp)}</td><td class="time" title="${UI.esc(exactTime(time))}">${UI.esc(relativeTime(time, now()))}</td></tr>`;
      }).join('');
      write('dashboardWallets', wallets.length
        ? `<table class="dashboard-table"><thead><tr>${head('#', 'number', true)}<th>지갑 주소</th>${head('잔액', 'balance')}${head('사용 금액', 'sent')}${head('충전', 'toppedUp')}${head('최근 사용', 'recent', false)}</tr></thead><tbody>${rows}</tbody></table>`
        : `<p class="dashboard-empty">${query ? '검색 결과가 없어요.' : '아직 충전된 지갑이 없어요.'}</p>`);
      const recent = summary.transfers.slice(0, RECENT_LIMIT);
      write('dashboardTransfers', recent.length ? recent.map(item => {
        const time = timeOf(item.blockNumber), topup = item.type === '충전';
        const party = address => { const label = partyLabel(address); return `<span><code>${UI.esc(shortAddress(address))}</code>${label ? `<em>${label}</em>` : ''}</span>`; };
        return `<div class="dashboard-transfer"><time title="${UI.esc(exactTime(time))}">${UI.esc(relativeTime(time, now()))}</time><span class="dashboard-chip ${topup ? 'type-topup' : 'type-payment'}">${topup ? '충전' : '송금'}</span><div class="dashboard-parties">${party(item.from)}<i>→</i>${party(item.to)}</div><strong>${won(item.value)}</strong></div>`;
      }).join('') : '<p class="dashboard-empty">아직 거래가 없어요.</p>');
      renderDialog();
    }
    function renderDialog() {
      const dialog = node('dashboardDialog');
      if (!dialog) return;
      const item = selected && summary?.wallets.find(entry => entry.address === selected);
      if (!item) { if (dialog.open) dialog.close?.(); write('dashboardDialog', ''); return; }
      const time = timeOf(item.lastBlock);
      const fee = selectedFee === undefined ? '확인 중…' : selectedFee == null ? '—' : selectedFee >= 100000 ? '충분' : `약 ${selectedFee.toLocaleString('ko-KR')}회`;
      write('dashboardDialog', `<div class="dashboard-dialog-head"><strong>${item.isStore ? '가게' : item.number ? `#${item.number}` : '지갑'}</strong>${item.recoveredFlag ? '<span class="dashboard-chip recovered">회수</span>' : ''}<button type="button" class="dashboard-dialog-close" data-dialog="close" aria-label="닫기">×</button></div><code>${UI.esc(item.address)}</code><button type="button" class="dashboard-copy" data-dialog="copy">주소 복사</button><dl><dt>잔액</dt><dd>${won(item.balance)}</dd><dt>충전</dt><dd>${won(item.toppedUp)}</dd><dt>사용 금액</dt><dd>${won(item.sent)}</dd><dt>받은 금액</dt><dd>${won(item.received)}</dd><dt>운영자에게 보냄</dt><dd>${won(item.recovered)}</dd><dt>거래 수</dt><dd>${item.transferCount}건</dd><dt>최근 사용</dt><dd>${UI.esc(exactTime(time))}</dd><dt>남은 수수료</dt><dd>${fee}</dd></dl><button type="button" class="operator-primary" data-dialog="toggle-store">${item.isStore ? '가게 해제' : '가게로 설정'}</button>`);
      if (!dialog.open) dialog.showModal?.();
    }
    async function loadTimestamps() {
      const wanted = new Set();
      for (const item of summary.transfers.slice(0, RECENT_LIMIT)) wanted.add(item.blockNumber);
      for (const item of summary.wallets) wanted.add(item.lastBlock);
      const missing = [...wanted].filter(block => block > 0 && !timestamps.has(block)).sort((a, b) => b - a).slice(0, HEADER_CAP);
      for (let offset = 0; offset < missing.length; offset += HEADER_BATCH) {
        const blocks = missing.slice(offset, offset + HEADER_BATCH);
        const headers = await rpc(blocks.map(block => ({ method:'eth_getBlockByNumber', params:[hex(block), false] })));
        blocks.forEach((block, index) => { if (headers[index]?.timestamp) timestamps.set(block, blockOf(headers[index].timestamp)); });
      }
    }
    async function loadFee(address) {
      selectedFee = undefined;
      if (!rpc) { selectedFee = null; return; }
      try {
        const [raw] = await rpc([{ method:'eth_getBalance', params:[address, 'latest'] }]);
        if (selected === address) selectedFee = /^0x[0-9a-f]+$/i.test(raw || '') ? Transfer.transfersAffordable(BigInt(raw), token) : null;
      } catch { if (selected === address) selectedFee = null; }
      render();
    }
    async function refresh() {
      if (loading || stopped) return;
      loading = true; render();
      try {
        if (preview) {
          const sample = sampleData(Math.floor(now() / 1000));
          logs = mergeLogs([], sample.logs); timestamps = sample.timestamps; cursor = sample.latest;
          if (!stores.length) stores = sample.stores;
          summarize();
        } else {
          if (!token || !ADDRESS.test(token.address || '')) throw failure('TOKEN_NOT_CONFIGURED');
          const [latestHex] = await rpc([{ method:'eth_blockNumber', params:[] }]);
          const latest = blockOf(latestHex);
          let incoming = [];
          for (let low = cursor == null ? Math.max(0, token.deployBlock || 0) : cursor + 1; low <= latest; low += LOG_CHUNK) {
            const high = Math.min(latest, low + LOG_CHUNK - 1);
            const [chunk] = await rpc([{ method:'eth_getLogs', params:[{ address:token.address, fromBlock:hex(low), toBlock:hex(high), topics:[token.transferTopic] }] }]);
            incoming = incoming.concat(chunk);
          }
          logs = mergeLogs(logs, incoming); cursor = latest; summarize();
          await loadTimestamps();
        }
        error = ''; updatedAt = now();
      } catch (problem) {
        error = problem?.code === 'TOKEN_NOT_CONFIGURED' ? '발행된 wMST 주소가 아직 설정되지 않았어요. setup 페이지에서 발행 후 설정값을 반영해 주세요.'
          : '현황을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.';
      } finally { loading = false; render(); }
    }
    function open(address) { selected = address; void loadFee(address); render(); }
    function close() { selected = null; selectedFee = null; render(); }
    function toggleStore() {
      if (!selected) return;
      stores = stores.includes(selected) ? stores.filter(item => item !== selected) : [...stores, selected];
      try { storage?.setItem(STORES_KEY, JSON.stringify(stores)); } catch {}
      summarize(); render();
    }
    function onTableClick(event) {
      const sortButton = event.target.closest?.('[data-sort]');
      if (sortButton) {
        const keyName = sortButton.dataset.sort;
        sort = keyName === 'number' ? { key:'number', direction:'desc' } : sort.key === keyName ? { key:keyName, direction:sort.direction === 'desc' ? 'asc' : 'desc' } : { key:keyName, direction:'desc' };
        render(); return;
      }
      const row = event.target.closest?.('[data-wallet]');
      if (row) open(row.dataset.wallet);
    }
    function onDialogClick(event) {
      const action = event.target.closest?.('[data-dialog]')?.dataset.dialog;
      if (action === 'close') close();
      else if (action === 'toggle-store') toggleStore();
      else if (action === 'copy') {
        const button = event.target.closest('[data-dialog]');
        if (root.navigator?.clipboard) root.navigator.clipboard.writeText(selected).then(() => { button.textContent = '복사했어요'; }).catch(() => { button.textContent = '길게 눌러 복사'; });
        else button.textContent = '길게 눌러 복사';
      }
    }
    function start() {
      node('dashboardRefresh')?.addEventListener('click', () => { void refresh(); });
      node('dashboardSearch')?.addEventListener('input', event => { search = event.target.value || ''; render(); });
      node('dashboardWallets')?.addEventListener('click', onTableClick);
      node('dashboardWallets')?.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { const row = event.target.closest?.('[data-wallet]'); if (row) { event.preventDefault?.(); open(row.dataset.wallet); } } });
      const dialog = node('dashboardDialog');
      dialog?.addEventListener('click', event => { if (event.target === dialog) close(); else onDialogClick(event); });
      dialog?.addEventListener('cancel', event => { event.preventDefault?.(); close(); });
      if (!preview) {
        timer = root.setInterval?.(() => { if (doc.visibilityState === 'visible') void refresh(); }, interval);
        doc.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'visible') void refresh(); });
        root.addEventListener?.('pagehide', event => { if (!event.persisted) stop(); });
      }
      void refresh();
      return instance;
    }
    function stop() { stopped = true; if (timer != null) root.clearInterval?.(timer); timer = null; }
    const instance = { start, stop, refresh, open, close, snapshot:() => ({ summary, cursor, error, loading, updatedAt, stores:[...stores], sort:{ ...sort }, selected, timestamps:new Map(timestamps) }) };
    return instance;
  }
  return { aggregate, mergeLogs, sortWallets, relativeTime, shortAddress, createRpc, sampleData, create, REFRESH_INTERVAL, STORES_KEY };
});
