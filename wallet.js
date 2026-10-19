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
  function units(wei) {
    const n = BigInt(wei), divisor = 10n ** 18n;
    const fraction = (n % divisor).toString().padStart(18, '0').replace(/0+$/, '');
    return (n / divisor).toString() + (fraction ? '.' + fraction : '');
  }
  function failure(code) { return Object.assign(new Error(code), { code }); }
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
        if (body.error || typeof body.result !== 'string' || !/^0x[0-9a-f]+$/i.test(body.result)) throw failure('INVALID_BALANCE');
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

  function createWallet({ getProvider, onState = () => {}, network = NETWORK, readTimeout = 12000, readBalanceFromRpc = null }) {
    let provider, activeTask, generation = 0, disposed = false, externalPending = false;
    let eventTimer, refreshTask, syncAgain = false;
    let state = { status: 'idle', account: null, balanceWei: null };
    const emit = (status, data = {}) => {
      if (disposed) return;
      state = { status, account: null, balanceWei: null, ...data };
      onState({ ...state });
    };
    async function call(method, params) {
      if (!ALLOWED.has(method)) throw failure('METHOD_NOT_ALLOWED');
      const result = provider.request({ method, ...(params ? { params } : {}) });
      if (!['eth_accounts', 'eth_chainId', 'eth_getBalance'].includes(method)) return result;
      let timeout;
      try {
        return await Promise.race([result, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(failure('READ_TIMEOUT')), readTimeout);
        })]);
      } finally { clearTimeout(timeout); }
    }
    function scheduleSync() {
      if (disposed || activeTask) return;
      clearTimeout(eventTimer);
      eventTimer = setTimeout(() => { void restore(); }, 0);
    }
    function accountsChanged(accounts) {
      if (!accounts?.length) {
        generation++; externalPending = false;
        emit('idle');
      } else if (!activeTask) {
        generation++; externalPending = false; syncAgain = true;
        emit('querying'); scheduleSync();
      }
    }
    function chainChanged() {
      if (!activeTask) {
        generation++; externalPending = false; syncAgain = true;
        emit('querying'); scheduleSync();
      }
    }
    function disconnected() { generation++; externalPending = false; emit('disconnected'); }
    async function attach() {
      const next = await getProvider();
      if (!next) throw failure('NO_PROVIDER');
      if (next === provider) return;
      unbind(); provider = next;
      provider.on?.('accountsChanged', accountsChanged);
      provider.on?.('chainChanged', chainChanged);
      provider.on?.('disconnect', disconnected);
    }
    function unbind() {
      provider?.removeListener?.('accountsChanged', accountsChanged);
      provider?.removeListener?.('chainChanged', chainChanged);
      provider?.removeListener?.('disconnect', disconnected);
    }
    function assertCurrent(revision) {
      if (disposed || generation !== revision) throw failure('STALE');
    }
    async function readBalance(revision) {
      emit('querying');
      const accounts = await call('eth_accounts'); assertCurrent(revision);
      if (!addressOK(accounts?.[0])) throw failure('NO_ACCOUNT');
      const chain = await call('eth_chainId'); assertCurrent(revision);
      if (!sameChain(chain, network.chainId)) throw failure('WRONG_CHAIN');
      const account = accounts[0];
      let raw;
      try { raw = await call('eth_getBalance', [account, 'latest']); }
      catch (providerError) {
        assertCurrent(revision);
        if (!readBalanceFromRpc) throw providerError;
        raw = await readBalanceFromRpc(account);
      }
      assertCurrent(revision);
      if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) throw failure('INVALID_BALANCE');
      const [latestAccounts, latestChain] = await Promise.all([call('eth_accounts'), call('eth_chainId')]);
      assertCurrent(revision);
      if (latestAccounts?.[0]?.toLowerCase() !== account.toLowerCase()) throw failure('STALE_ACCOUNT');
      if (!sameChain(latestChain, network.chainId)) throw failure('WRONG_CHAIN');
      emit('ready', { account, balanceWei: BigInt(raw).toString() });
    }
    function report(error, revision) {
      if (disposed || generation !== revision || error.code === 'STALE') return;
      const code = errorCode(error);
      if (code === -32002) { externalPending = true; emit('pending'); }
      else if (code === 4001) emit('cancelled');
      else if (code === 'NO_PROVIDER') emit('unavailable');
      else if (code === 'NO_ACCOUNT') emit('idle');
      else if (code === 'WRONG_CHAIN') emit('needs-network');
      else emit('error', { code, duringBalance: state.status === 'querying' });
    }
    async function runSetup() {
      syncAgain = false;
      const revision = ++generation;
      emit('connecting');
      try {
        await attach(); assertCurrent(revision);
        let accounts = await call('eth_accounts'); assertCurrent(revision);
        if (externalPending) {
          const chain = await call('eth_chainId'); assertCurrent(revision);
          if (!addressOK(accounts?.[0]) || !sameChain(chain, network.chainId)) { emit('pending'); return; }
          externalPending = false;
        }
        if (!addressOK(accounts?.[0])) {
          accounts = await call('eth_requestAccounts'); assertCurrent(revision);
          if (!addressOK(accounts?.[0])) throw failure('NO_ACCOUNT');
        }
        let chain = await call('eth_chainId'); assertCurrent(revision);
        if (!sameChain(chain, network.chainId)) {
          emit('switching');
          try {
            await call('wallet_switchEthereumChain', [{ chainId: network.chainId }]);
          } catch (error) {
            assertCurrent(revision);
            if (errorCode(error) !== 4902) throw error;
            emit('adding');
            await call('wallet_addEthereumChain', [{
              ...network, nativeCurrency: { ...network.nativeCurrency }, rpcUrls: [...network.rpcUrls]
            }]);
            assertCurrent(revision);
            chain = await call('eth_chainId'); assertCurrent(revision);
            if (!sameChain(chain, network.chainId)) {
              emit('switching');
              await call('wallet_switchEthereumChain', [{ chainId: network.chainId }]);
            }
          }
          assertCurrent(revision);
        }
        await readBalance(revision);
      } catch (error) { report(error, revision); }
    }
    function setup() {
      if (disposed) return Promise.resolve();
      if (activeTask) return activeTask;
      activeTask = runSetup().finally(() => { activeTask = null; });
      return activeTask;
    }
    function restore() {
      if (disposed) return Promise.resolve();
      if (activeTask) return activeTask;
      if (refreshTask) return refreshTask;
      syncAgain = false;
      const revision = ++generation;
      refreshTask = (async () => {
        try {
          await attach(); assertCurrent(revision);
          const accounts = await call('eth_accounts'); assertCurrent(revision);
          if (!addressOK(accounts?.[0])) { externalPending = false; emit('idle'); return; }
          await readBalance(revision);
        } catch (error) { report(error, revision); }
      })().finally(() => { refreshTask = null; if (syncAgain) { syncAgain = false; scheduleSync(); } });
      return refreshTask;
    }
    return {
      setup, restore, refresh: restore,
      getSnapshot: () => ({ ...state }),
      dispose() { disposed = true; generation++; clearTimeout(eventTimer); unbind(); }
    };
  }
  return { NETWORK, createWallet, createRpcBalanceReader, discover, units, sameChain, errorCode };
});
