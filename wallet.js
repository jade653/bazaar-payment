(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarWallet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NETWORK = Object.freeze({
    chainId: '0x1db1', chainName: 'Mustree',
    nativeCurrency: Object.freeze({ name: 'MST', symbol: 'MST', decimals: 18 }),
    rpcUrls: Object.freeze(['https://block.mustree.kr'])
  });
  const ALLOWED = new Set(['eth_accounts', 'eth_requestAccounts', 'eth_chainId',
    'eth_getBalance', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
  const addressOK = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
  const sameChain = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
  function errorCode(error) {
    const queue = [error];
    for (let i = 0; i < queue.length && i < 12; i++) {
      const item = queue[i];
      if (!item || typeof item !== 'object') continue;
      const code = Number(item.code);
      if ([4001, 4902, -32002].includes(code)) return code;
      queue.push(item.data, item.originalError, item.error, item.cause);
    }
    return error && error.code;
  }
  function failure(code) { return Object.assign(new Error(code), { code }); }
  // Same 8s HTTP budget as history; injected MetaMask reads retain their own timeout.
  function createRpcBalanceReader({ fetchImpl, network = NETWORK, timeout = 8000 }) {
    return async function readRpcBalance(account) {
      if (!addressOK(account) || typeof fetchImpl !== 'function') throw failure('RPC_UNAVAILABLE');
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
      try {
        const response = await fetchImpl(network.rpcUrls[0], {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [account, 'latest'] }),
          ...(controller ? { signal: controller.signal } : {})
        });
        if (!response.ok) throw failure('RPC_HTTP_ERROR');
        const body = await response.json();
        if (body.error) throw Object.assign(new Error(body.error.message || 'RPC balance query failed'), { code:body.error.code });
        if (typeof body.result !== 'string' || !/^0x[0-9a-f]+$/i.test(body.result)) throw failure('INVALID_BALANCE');
        return body.result;
      } finally { if (timer) clearTimeout(timer); }
    };
  }

  function discover(win) {
    let announced;
    const listener = event => {
      if (event.detail && event.detail.info && event.detail.info.rdns === 'io.metamask' &&
          typeof event.detail.provider?.request === 'function') announced = event.detail.provider;
    };
    win.addEventListener('eip6963:announceProvider', listener);
    const injected = () => {
      if (announced) return announced;
      const provider = win.ethereum;
      if (provider?.providers) return provider.providers.find(p => p.isMetaMask);
      return provider?.isMetaMask && typeof provider.request === 'function' ? provider : null;
    };
    win.dispatchEvent(new win.Event('eip6963:requestProvider'));
    return {
      async getProvider() {
        const immediate = injected();
        if (immediate) return immediate;
        win.dispatchEvent(new win.Event('eip6963:requestProvider'));
        const deadline = Date.now() + 1500;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (injected()) return injected();
        }
        return null;
      },
      dispose() { win.removeEventListener('eip6963:announceProvider', listener); }
    };
  }

  // Only allowlisted metadata is retained; request parameters and error data are never logged.
  function createDiagnostics({ storage = null, now = () => new Date().toISOString() } = {}) {
    const key = 'bazaar-wallet-diagnostics-v1';
    const clean = value => String(value ?? '').replace(/\b(?:0x)?[0-9a-f]{64,}\b/gi, '[redacted hex]')
      .replace(/(?:private[ _-]?key|mnemonic|seed[ _-]?phrase|secret|signature|authorization)[^\n]*/gi, '[redacted sensitive text]').slice(0, 500);
    let records = [], notify = () => {};
    const sanitize = item => {
      const entry = { time:clean(item.time || now()), stage:clean(item.stage), chainId:null };
      if (typeof item.chainId === 'string' && /^0x[0-9a-f]+$/i.test(item.chainId)) entry.chainId = item.chainId;
      if (typeof item.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(item.hash)) entry.hash = item.hash;
      if (item.error) {
        const queue = [item.error], seen = new Set(); entry.errors = [];
        for (let i = 0; i < queue.length && i < 12; i++) {
          const error = queue[i];
          if (!error || typeof error !== 'object' || seen.has(error)) continue;
          seen.add(error);
          if (error.code != null || error.message) entry.errors.push({ code:clean(error.code), message:clean(error.message) });
          queue.push(error.data, error.originalError, error.error, error.cause);
        }
      } else if (Array.isArray(item.errors)) {
        entry.errors = item.errors.slice(0, 12).map(error => ({ code:clean(error.code), message:clean(error.message) }));
      }
      return entry;
    };
    try { records = JSON.parse(storage?.getItem(key) || '[]').slice(-200).map(sanitize); } catch {}
    return {
      record(item) {
        records.push(sanitize(item)); records = records.slice(-200);
        try { storage?.setItem(key, JSON.stringify(records)); } catch {}
        notify();
      },
      snapshot:() => JSON.parse(JSON.stringify(records)),
      text:() => JSON.stringify({ version:1, expectedChainId:NETWORK.chainId, records }, null, 2),
      subscribe(fn) { notify = fn; }
    };
  }
  function diagnosticsFor(win) {
    if (win.__bazaarDiagnostics) return win.__bazaarDiagnostics;
    let storage; try { storage = win.sessionStorage; } catch {}
    const diagnostics = createDiagnostics({ storage });
    win.__bazaarDiagnostics = diagnostics;
    const doc = win.document;
    if (doc?.body && doc.createElement) {
      const panel = doc.createElement('details'); panel.className = 'wallet-diagnostics';
      panel.innerHTML = '<summary>지갑 연결 · 진단 기록</summary><p data-wallet-status role="status"></p><button type="button" data-wallet-retry>지갑 연결 다시 시도</button> <button type="button" data-wallet-copy>진단 기록 복사</button><textarea readonly aria-label="지갑 진단 기록"></textarea>';
      const host = doc.querySelector?.('.operator-app') || doc.querySelector?.('.device') || doc.body;
      host.append(panel);
      const field = panel.querySelector('textarea'), copy = panel.querySelector('[data-wallet-copy]');
      diagnostics.subscribe(() => { if (field) field.value = diagnostics.text(); });
      if (field) field.value = diagnostics.text();
      copy?.addEventListener('click', async () => {
        try { await win.navigator.clipboard.writeText(diagnostics.text()); copy.textContent = '복사했어요'; }
        catch { if (field) { field.value = diagnostics.text(); field.focus(); field.select(); } copy.textContent = '아래 기록을 길게 눌러 복사해 주세요'; }
      });
      diagnostics.panel = panel;
    }
    return diagnostics;
  }

  function createWallet({ getProvider, onState = () => {}, network = NETWORK, readTimeout = 12000,
    readBalanceFromRpc = null, lifecycle = null, diagnostics = lifecycle ? diagnosticsFor(lifecycle) : null }) {
    let provider, activeTask, generation = 0, disposed = false, promptHold = '', actualChainId = null;
    let eventTimer, syncAgain = false, autoPaused = false;
    let state = { status:'idle', account:null, balanceWei:null };
    let storage; try { storage = lifecycle?.sessionStorage; const saved = storage?.getItem('bazaar-wallet-prompt-hold');
      if (['cancelled','pending','error','needs-network'].includes(saved)) promptHold = saved; } catch {}
    function hold(value) { promptHold = value; try { storage?.setItem('bazaar-wallet-prompt-hold', value); } catch {} }
    const log = (stage, error) => diagnostics?.record({ stage, chainId:actualChainId, error });
    const emit = (status, data = {}) => {
      if (disposed) return;
      state = { status, account:null, balanceWei:null, chainId:actualChainId, ...data };
      const panel = diagnostics?.panel, label = panel?.querySelector('[data-wallet-status]');
      if (label) label.textContent = status === 'ready' ? 'Mustree 연결됨'
        : status === 'cancelled' ? '연결을 취소했어요. 준비되면 지갑 연결 다시 시도를 눌러주세요.'
        : status === 'pending' ? 'MetaMask의 기존 승인 요청을 확인한 뒤 지갑 연결 다시 시도를 눌러주세요.'
        : status === 'error' || status === 'needs-network' ? '연결을 완료하지 못했어요. 지갑 연결 다시 시도를 눌러주세요.'
        : status === 'unavailable' ? 'MetaMask 앱에서 열어주세요.' : '지갑 연결 상태를 확인하고 있어요.';
      if (panel && ['cancelled','pending','error','needs-network'].includes(status)) panel.open = true;
      onState({ ...state });
    };
    async function call(method, params) {
      if (!ALLOWED.has(method)) throw failure('METHOD_NOT_ALLOWED');
      let timer;
      if (!['eth_accounts','eth_chainId','eth_getBalance'].includes(method)) log(method + ':request');
      try {
        const request = Promise.resolve().then(() => provider.request({ method, ...(params ? { params } : {}) }));
        const result = ['eth_accounts','eth_chainId','eth_getBalance'].includes(method)
          ? await Promise.race([request, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('READ_TIMEOUT')), readTimeout); })])
          : await request;
        if (method === 'eth_chainId') actualChainId = result;
        if (method !== 'eth_accounts' && method !== 'eth_getBalance') log(method + ':success'); return result;
      } catch (error) { log(method + ':failure', error); throw error; }
      finally { clearTimeout(timer); }
    }
    function scheduleSync() {
      if (disposed) return;
      if (activeTask) { syncAgain = true; return; }
      clearTimeout(eventTimer); eventTimer = setTimeout(() => { void restore(); }, 0);
    }
    function changed() {
      // Events emitted by an in-flight add/switch are revalidated by that operation.
      // Events during balance reads invalidate the response and queue a fresh check.
      if (activeTask && ['connecting','adding','switching'].includes(state.status)) { syncAgain = true; return; }
      generation++; emit('querying'); scheduleSync();
    }
    function disconnected(error) { generation++; log('provider:disconnect', error); emit('disconnected'); scheduleSync(); }
    async function attach() {
      const next = await getProvider();
      if (!next) throw failure('NO_PROVIDER');
      if (next === provider) return;
      unbind(); provider = next;
      provider.on?.('accountsChanged', changed); provider.on?.('chainChanged', changed);
      provider.on?.('connect', changed); provider.on?.('disconnect', disconnected);
    }
    function unbind() {
      provider?.removeListener?.('accountsChanged', changed); provider?.removeListener?.('chainChanged', changed);
      provider?.removeListener?.('connect', changed); provider?.removeListener?.('disconnect', disconnected);
    }
    function assertCurrent(revision) { if (disposed || generation !== revision) throw failure('STALE'); }
    async function readBalance(revision) {
      emit('querying');
      const accounts = await call('eth_accounts'); assertCurrent(revision);
      if (!addressOK(accounts?.[0])) throw failure('NO_ACCOUNT');
      const chain = await call('eth_chainId'); assertCurrent(revision);
      if (!sameChain(chain, network.chainId)) throw failure('WRONG_CHAIN');
      let raw;
      try { raw = await call('eth_getBalance', [accounts[0], 'latest']); }
      catch (error) {
        assertCurrent(revision); if (!readBalanceFromRpc) throw error;
        log('balance:rpc-fallback');
        try { raw = await readBalanceFromRpc(accounts[0]); } catch (rpcError) { log('balance:rpc-failure', rpcError); throw rpcError; }
      }
      assertCurrent(revision);
      if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) throw failure('INVALID_BALANCE');
      const [latestAccounts, latestChain] = await Promise.all([call('eth_accounts'), call('eth_chainId')]);
      assertCurrent(revision);
      if (latestAccounts?.[0]?.toLowerCase() !== accounts[0].toLowerCase()) throw failure('STALE_ACCOUNT');
      if (!sameChain(latestChain, network.chainId)) throw failure('WRONG_CHAIN');
      hold(''); emit('ready', { account:accounts[0], balanceWei:BigInt(raw).toString() });
    }
    function report(error, revision) {
      if (disposed || generation !== revision || error?.code === 'STALE') return;
      log('wallet:failure', error);
      const code = errorCode(error);
      if (code === -32002) { hold('pending'); emit('pending'); }
      else if (code === 4001) { hold('cancelled'); emit('cancelled'); }
      else if (code === 'NO_PROVIDER') emit('unavailable');
      else if (code === 'NO_ACCOUNT') emit('idle');
      else if (code === 'WRONG_CHAIN') { hold('needs-network'); emit('needs-network'); }
      else { hold('error'); emit('error', { code, duringBalance:state.status === 'querying' }); }
    }
    async function run(explicit) {
      const revision = ++generation;
      try {
        await attach(); assertCurrent(revision);
        // Read both on every entry/resume/retry, even when account access is absent.
        let [accounts, chain] = await Promise.all([call('eth_accounts'), call('eth_chainId')]); assertCurrent(revision);
        if ((!addressOK(accounts?.[0]) || !sameChain(chain, network.chainId)) && (promptHold || autoPaused) && !explicit) { emit(promptHold || 'pending'); return; }
        if (!addressOK(accounts?.[0])) {
          emit('connecting'); accounts = await call('eth_requestAccounts'); assertCurrent(revision);
          if (!addressOK(accounts?.[0])) throw failure('NO_ACCOUNT');
          chain = await call('eth_chainId'); assertCurrent(revision);
        }
        if (!sameChain(chain, network.chainId)) {
          emit('switching');
          try { await call('wallet_switchEthereumChain', [{ chainId:network.chainId }]); }
          catch (error) {
            assertCurrent(revision); if (errorCode(error) !== 4902) throw error;
            emit('adding');
            await call('wallet_addEthereumChain', [{ ...network, nativeCurrency:{ ...network.nativeCurrency }, rpcUrls:[...network.rpcUrls] }]);
            assertCurrent(revision); chain = await call('eth_chainId'); assertCurrent(revision);
            if (!sameChain(chain, network.chainId)) { emit('switching'); await call('wallet_switchEthereumChain', [{ chainId:network.chainId }]); }
          }
          assertCurrent(revision);
        }
        await readBalance(revision);
      } catch (error) { report(error, revision); }
      return { ...state };
    }
    function reconcile(explicit = false) {
      if (disposed) return Promise.resolve({ ...state });
      if (activeTask) return activeTask;
      // Coalesce focus, visibility and provider events into one operation.
      syncAgain = false;
      activeTask = run(explicit).finally(() => {
        activeTask = null;
        if (syncAgain) { syncAgain = false; scheduleSync(); }
      });
      return activeTask;
    }
    function setup() { return reconcile(true); }
    function restore() { return reconcile(false); }
    const resume = () => { if (lifecycle?.document?.visibilityState !== 'hidden') void restore(); };
    const pageshow = event => { if (event.persisted) resume(); };
    const retry = () => { void setup(); };
    lifecycle?.addEventListener('focus', resume); lifecycle?.addEventListener('pageshow', pageshow);
    lifecycle?.document?.addEventListener('visibilitychange', resume);
    diagnostics?.panel?.querySelector('[data-wallet-retry]')?.addEventListener('click', retry);
    return {
      setup, restore, refresh:restore, getSnapshot:() => ({ ...state }), diagnostics,
      pauseAutoPrompts(value) { autoPaused = value; },
      suspendPrompts(code) { if ([4001,-32002].includes(Number(code))) hold(Number(code) === 4001 ? 'cancelled' : 'pending'); },
      dispose() {
        disposed = true; generation++; clearTimeout(eventTimer); unbind();
        lifecycle?.removeEventListener?.('focus', resume); lifecycle?.removeEventListener?.('pageshow', pageshow);
        lifecycle?.document?.removeEventListener?.('visibilitychange', resume);
        diagnostics?.panel?.querySelector('[data-wallet-retry]')?.removeEventListener?.('click', retry);
      }
    };
  }
  return { NETWORK, createWallet, createRpcBalanceReader, discover, errorCode, createDiagnostics, diagnosticsFor };
});
