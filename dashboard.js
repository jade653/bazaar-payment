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
  const HASH = /^0x[0-9a-f]{64}$/i;
  const LOG_CHUNK = 50000, BALANCE_BATCH = 200, HEADER_BATCH = 100, HEADER_CAP = 300;
  const REFRESH_INTERVAL = 10000, RPC_TIMEOUT = 8000, LOW_FEE_TRANSFERS = 3, RECENT_LIMIT = 50;
  const failure = code => Object.assign(new Error(code), { code });
  const topicAddress = topic => '0x' + String(topic || '').slice(-40).toLowerCase();
  const blockOf = value => Number(BigInt(value || '0x0'));
  const hex = number => '0x' + Number(number).toString(16);
  const key = log => String(log.transactionHash).toLowerCase() + ':' + blockOf(log.logIndex);

  // Drops removed logs, dedupes by hash+logIndex and keeps chain order.
  function mergeLogs(existing = [], incoming = []) {
    const unique = new Map();
    for (const log of [...existing, ...incoming]) {
      if (!log || log.removed || !HASH.test(log.transactionHash || '') || !Array.isArray(log.topics) || log.topics.length < 3) continue;
      unique.set(key(log), log);
    }
    return [...unique.values()].sort((a, b) => blockOf(a.blockNumber) - blockOf(b.blockNumber) || blockOf(a.logIndex) - blockOf(b.logIndex));
  }

  // Pure view of the whole token: who holds what, what left the treasury and what came back.
  function aggregate(logs, { treasury = null } = {}) {
    const rows = mergeLogs([], logs).map(log => ({
      hash:log.transactionHash, blockNumber:blockOf(log.blockNumber), logIndex:blockOf(log.logIndex),
      from:topicAddress(log.topics[1]), to:topicAddress(log.topics[2]), value:BigInt(log.data || '0x0')
    }));
    let treasuryAddress = treasury ? treasury.toLowerCase() : null, totalSupply = 0n;
    for (const row of rows) if (row.from === ZERO) { totalSupply += row.value; if (!treasuryAddress) treasuryAddress = row.to; }
    const balances = new Map(), wallets = new Map(), transfers = [];
    let toppedUp = 0n, recovered = 0n, topUpCount = 0, recoveryCount = 0, paymentCount = 0;
    const wallet = address => {
      if (!wallets.has(address)) wallets.set(address, { address, balance:0n, toppedUp:0n, receivedPayments:0n, sentPayments:0n, recovered:0n, label:'손님', lastBlock:0, transferCount:0 });
      return wallets.get(address);
    };
    const touch = (address, row) => { const entry = wallet(address); entry.lastBlock = Math.max(entry.lastBlock, row.blockNumber); entry.transferCount++; };
    for (const row of rows) {
      if (row.from !== ZERO) balances.set(row.from, (balances.get(row.from) || 0n) - row.value);
      balances.set(row.to, (balances.get(row.to) || 0n) + row.value);
      if (row.from === ZERO) continue;
      let type;
      if (row.from === treasuryAddress && row.to === treasuryAddress) type = '회수';
      else if (row.from === treasuryAddress) { type = '충전'; toppedUp += row.value; topUpCount++; wallet(row.to).toppedUp += row.value; touch(row.to, row); }
      else if (row.to === treasuryAddress) { type = '회수'; recovered += row.value; recoveryCount++; wallet(row.from).recovered += row.value; touch(row.from, row); }
      else {
        type = '결제'; paymentCount++;
        wallet(row.from).sentPayments += row.value; touch(row.from, row);
        const receiver = wallet(row.to); receiver.receivedPayments += row.value; receiver.label = '가게'; touch(row.to, row);
      }
      transfers.push({ ...row, type });
    }
    for (const entry of wallets.values()) entry.balance = balances.get(entry.address) || 0n;
    const treasuryBalance = treasuryAddress ? balances.get(treasuryAddress) || 0n : 0n;
    transfers.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
    return {
      treasury:treasuryAddress, totalSupply, treasuryBalance, circulating:totalSupply - treasuryBalance,
      toppedUp, recovered, topUpCount, recoveryCount, paymentCount,
      wallets:[...wallets.values()].sort((a, b) => (b.balance > a.balance) - (b.balance < a.balance) || b.lastBlock - a.lastBlock),
      transfers
    };
  }

  function relativeTime(timestamp, now = Date.now()) {
    if (!Number.isFinite(timestamp)) return '—';
    const seconds = Math.max(0, Math.floor(now / 1000 - timestamp));
    if (seconds < 60) return '방금 전';
    if (seconds < 3600) return Math.floor(seconds / 60) + '분 전';
    if (seconds < 86400) return Math.floor(seconds / 3600) + '시간 전';
    return Math.floor(seconds / 86400) + '일 전';
  }
  const exactTime = timestamp => Number.isFinite(timestamp) ? new Date(timestamp * 1000).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';

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
    const logs = [log(100, 0, ZERO, treasury, 1000000000n), log(110, 0, treasury, customerA, 20000n), log(112, 0, treasury, customerB, 50000n), log(120, 0, customerA, store, 7500n), log(125, 0, customerB, store, 12000n), log(130, 0, store, treasury, 19500n), log(131, 0, treasury, customerA, 10000n)];
    const timestamps = new Map([[100, now - 7200], [110, now - 3600], [112, now - 3000], [120, now - 1500], [125, now - 900], [130, now - 300], [131, now - 40]].map(([block, time]) => [block, time]));
    const gas = new Map([[treasury, 40n * 10n ** 15n], [customerA, 1543200000n * 2n], [customerB, 78000000n * 2n], [store, 0n]]);
    return { logs, latest:140, timestamps, gas };
  }

  function create({ root, Wallet, Transfer, UI, fetchImpl = root.fetch ? root.fetch.bind(root) : null, now = () => Date.now(), interval = REFRESH_INTERVAL }) {
    const doc = root.document, token = Wallet.TOKEN;
    const preview = (() => { try { return new URL(root.location.href).searchParams.has('preview'); } catch { return false; } })();
    const node = id => doc.getElementById(id);
    const rpc = preview || !fetchImpl ? null : createRpc({ fetchImpl, url:Wallet.NETWORK.rpcUrls[0] });
    let logs = [], cursor = null, summary = null, gas = new Map(), timestamps = new Map();
    let search = '', sort = 'balance', expanded = null, error = '', loading = false, updatedAt = null, timer = null, stopped = false;
    const rendered = {};
    const affordable = (address, treasury) => {
      const wei = gas.get(address);
      if (wei == null) return null;
      return address === treasury ? Transfer.topUpsAffordable(wei, token) : Transfer.transfersAffordable(wei, token);
    };
    const timeOf = block => timestamps.get(block);
    const write = (id, html) => { const target = node(id); if (target && rendered[id] !== html) { target.innerHTML = html; rendered[id] = html; } };
    // Very large counts only mean "plenty"; keep the cards readable on a phone.
    const AMPLE = 100000;
    const countText = count => count >= AMPLE ? '10만회 이상' : `${count.toLocaleString('ko-KR')}회`;
    const feeText = count => count == null ? '수수료 —' : count < LOW_FEE_TRANSFERS ? `수수료 부족 · ${count}회` : count >= AMPLE ? '수수료 충분' : `수수료 ${count.toLocaleString('ko-KR')}회`;
    const label = (address, treasury) => address === treasury ? '운영' : summary?.wallets.find(item => item.address === address)?.label || '손님';
    function render() {
      if (stopped) return;
      const status = node('dashboardStatus');
      if (status) { status.hidden = !error; status.textContent = error; }
      const updated = node('dashboardUpdated');
      if (updated) updated.textContent = loading ? '확인 중…' : updatedAt ? '갱신 ' + new Date(updatedAt).toLocaleTimeString('ko-KR', { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
      const sortButton = node('dashboardSort');
      if (sortButton) sortButton.textContent = sort === 'balance' ? '잔액순' : '최근순';
      if (!summary) { write('dashboardStats', loading ? '<p class="dashboard-empty">현황을 불러오고 있어요.</p>' : ''); write('dashboardWallets', ''); write('dashboardTransfers', ''); return; }
      const treasury = summary.treasury;
      const lowFee = summary.wallets.filter(item => { const count = affordable(item.address, treasury); return count != null && count < LOW_FEE_TRANSFERS; }).length;
      const treasuryTopUps = affordable(treasury, treasury);
      const card = (title, value, sub = '', tone = '') => `<div class="dashboard-card${tone ? ' ' + tone : ''}"><span>${UI.esc(title)}</span><strong>${value}</strong>${sub ? `<small>${UI.esc(sub)}</small>` : ''}</div>`;
      write('dashboardStats', [
        card('유통 중', UI.mst(summary.circulating), '손님·가게가 보유한 wMST'),
        card('운영 지갑 보유', UI.mst(summary.treasuryBalance), '충전 가능 wMST'),
        card('충전 합계', UI.mst(summary.toppedUp), `${summary.topUpCount.toLocaleString('ko-KR')}건`),
        card('회수 합계', UI.mst(summary.recovered), `${summary.recoveryCount.toLocaleString('ko-KR')}건`),
        card('결제', `${summary.paymentCount.toLocaleString('ko-KR')}건`, '손님 → 가게 송금'),
        card('지갑 수', `${summary.wallets.length.toLocaleString('ko-KR')}개`, `가게 ${summary.wallets.filter(item => item.label === '가게').length}개`),
        card('수수료 부족 지갑', `${lowFee.toLocaleString('ko-KR')}개`, `${LOW_FEE_TRANSFERS}회 미만 남은 지갑`, lowFee ? 'warn' : ''),
        card('운영 지갑 수수료', treasuryTopUps == null ? '—' : `약 ${countText(treasuryTopUps)}`, '충전 가능 횟수', treasuryTopUps != null && treasuryTopUps < 20 ? 'warn' : '')
      ].join(''));
      const query = search.trim().toLowerCase();
      const wallets = summary.wallets.filter(item => !query || item.address.includes(query));
      if (sort === 'recent') wallets.sort((a, b) => b.lastBlock - a.lastBlock);
      write('dashboardWallets', wallets.length ? wallets.map(item => {
        const count = affordable(item.address, treasury), time = timeOf(item.lastBlock), open = expanded === item.address;
        return `<div class="dashboard-wallet${open ? ' open' : ''}" data-wallet="${item.address}"><button type="button" class="dashboard-wallet-row" data-wallet-toggle="${item.address}"><div><code>${UI.esc(UI.short(item.address))}</code><span class="dashboard-chip${item.label === '가게' ? ' store' : ''}">${item.label}</span></div><div><strong>${UI.mst(item.balance)}</strong><small class="${count != null && count < LOW_FEE_TRANSFERS ? 'warn' : ''}">${UI.esc(feeText(count))}</small><time title="${UI.esc(exactTime(time))}">${UI.esc(relativeTime(time, now()))}</time></div></button>${open ? `<div class="dashboard-wallet-detail"><code>${UI.esc(item.address)}</code><button type="button" data-wallet-copy="${item.address}">주소 복사</button><dl><dt>충전받음</dt><dd>${UI.mst(item.toppedUp)}</dd><dt>결제 보냄</dt><dd>${UI.mst(item.sentPayments)}</dd><dt>결제 받음</dt><dd>${UI.mst(item.receivedPayments)}</dd><dt>회수함</dt><dd>${UI.mst(item.recovered)}</dd><dt>거래 수</dt><dd>${item.transferCount}건</dd></dl></div>` : ''}</div>`;
      }).join('') : `<p class="dashboard-empty">${query ? '검색 결과가 없어요.' : '아직 충전된 지갑이 없어요.'}</p>`);
      const recent = summary.transfers.slice(0, RECENT_LIMIT);
      write('dashboardTransfers', recent.length ? recent.map(item => {
        const time = timeOf(item.blockNumber);
        const party = address => `<span><code>${UI.esc(UI.short(address))}</code><em>${label(address, treasury)}</em></span>`;
        return `<div class="dashboard-transfer"><time title="${UI.esc(exactTime(time))}">${UI.esc(relativeTime(time, now()))}</time><span class="dashboard-chip type-${item.type === '충전' ? 'topup' : item.type === '회수' ? 'recovery' : 'payment'}">${item.type}</span><div class="dashboard-parties">${party(item.from)}<i>→</i>${party(item.to)}</div><strong>${UI.mst(item.value)}</strong></div>`;
      }).join('') : '<p class="dashboard-empty">아직 거래가 없어요.</p>');
    }
    async function loadTimestamps(latest) {
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
    async function loadBalances() {
      const addresses = [summary.treasury, ...summary.wallets.map(item => item.address)].filter(Boolean);
      const next = new Map();
      for (let offset = 0; offset < addresses.length; offset += BALANCE_BATCH) {
        const slice = addresses.slice(offset, offset + BALANCE_BATCH);
        const results = await rpc(slice.map(address => ({ method:'eth_getBalance', params:[address, 'latest'] })));
        slice.forEach((address, index) => { if (/^0x[0-9a-f]+$/i.test(results[index] || '')) next.set(address, BigInt(results[index])); });
      }
      gas = next;
    }
    async function refresh() {
      if (loading || stopped) return;
      loading = true; render();
      try {
        if (preview) {
          const sample = sampleData(Math.floor(now() / 1000));
          logs = mergeLogs([], sample.logs); summary = aggregate(logs); gas = sample.gas; timestamps = sample.timestamps; cursor = sample.latest;
        } else {
          if (!token || !/^0x[0-9a-f]{40}$/i.test(token.address || '')) throw failure('TOKEN_NOT_CONFIGURED');
          const [latestHex] = await rpc([{ method:'eth_blockNumber', params:[] }]);
          const latest = blockOf(latestHex);
          let incoming = [];
          for (let low = cursor == null ? Math.max(0, token.deployBlock || 0) : cursor + 1; low <= latest; low += LOG_CHUNK) {
            const high = Math.min(latest, low + LOG_CHUNK - 1);
            const [chunk] = await rpc([{ method:'eth_getLogs', params:[{ address:token.address, fromBlock:hex(low), toBlock:hex(high), topics:[token.transferTopic] }] }]);
            incoming = incoming.concat(chunk);
          }
          logs = mergeLogs(logs, incoming); cursor = latest; summary = aggregate(logs);
          await loadBalances(); await loadTimestamps(latest);
        }
        error = ''; updatedAt = now();
      } catch (failure) {
        error = failure?.code === 'TOKEN_NOT_CONFIGURED' ? '발행된 wMST 주소가 아직 설정되지 않았어요. setup 페이지에서 발행 후 설정값을 반영해 주세요.'
          : '현황을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.';
      } finally { loading = false; render(); }
    }
    function onClick(event) {
      const copy = event.target.closest?.('[data-wallet-copy]');
      if (copy) {
        const address = copy.dataset.walletCopy;
        if (root.navigator?.clipboard) root.navigator.clipboard.writeText(address).then(() => { copy.textContent = '복사했어요'; }).catch(() => { copy.textContent = '길게 눌러 복사'; });
        else copy.textContent = '길게 눌러 복사';
        return;
      }
      const toggle = event.target.closest?.('[data-wallet-toggle]');
      if (toggle) { expanded = expanded === toggle.dataset.walletToggle ? null : toggle.dataset.walletToggle; render(); }
    }
    function start() {
      node('dashboardRefresh')?.addEventListener('click', () => { void refresh(); });
      node('dashboardSort')?.addEventListener('click', () => { sort = sort === 'balance' ? 'recent' : 'balance'; render(); });
      node('dashboardSearch')?.addEventListener('input', event => { search = event.target.value || ''; render(); });
      node('dashboardWallets')?.addEventListener('click', onClick);
      if (!preview) {
        timer = root.setInterval?.(() => { if (doc.visibilityState === 'visible') void refresh(); }, interval);
        doc.addEventListener?.('visibilitychange', () => { if (doc.visibilityState === 'visible') void refresh(); });
        root.addEventListener?.('pagehide', event => { if (!event.persisted) stop(); });
      }
      void refresh();
      return instance;
    }
    function stop() { stopped = true; if (timer != null) root.clearInterval?.(timer); timer = null; }
    const instance = { start, stop, refresh, snapshot:() => ({ summary, cursor, error, loading, updatedAt, gas:new Map(gas), timestamps:new Map(timestamps) }) };
    return instance;
  }
  return { aggregate, mergeLogs, relativeTime, createRpc, sampleData, create, LOW_FEE_TRANSFERS, REFRESH_INTERVAL };
});
