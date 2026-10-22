(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i, HEX = /^0x[0-9a-f]+$/i;
  const failure = code => Object.assign(new Error(code), { code });
  const address = value => typeof value === 'string' && ADDRESS.test(value) ? value : null;
  // Minimal ABI helpers for the wMST contract. Amounts are whole wMST units (1 wMST = 1 won).
  const word = value => BigInt(value).toString(16).padStart(64, '0');
  const abi = {
    word,
    addressWord: value => value.slice(2).toLowerCase().padStart(64, '0'),
    call: (selector, ...words) => selector + words.join(''),
    transfer: (token, to, units) => abi.call(token.selectors.transfer, abi.addressWord(to), word(units)),
    transferWithGas: (token, to, units) => abi.call(token.selectors.transferWithGas, abi.addressWord(to), word(units)),
    balanceOf: (token, account) => abi.call(token.selectors.balanceOf, abi.addressWord(account)),
    decodeUint: value => { if (!HEX.test(value || '') || value.length < 3) throw failure('INVALID_BALANCE'); return BigInt(value); },
    topicAddress: topic => '0x' + String(topic).slice(-40)
  };
  const tokenReady = token => Boolean(token && address(token.address) && token.selectors && token.gasPolicy);
  // Native MST handed to a customer with every top-up: enough for transfersPerTopUp wMST transfers.
  const gasSupportWei = token => BigInt(token.gasPolicy.transferReserveWei) * BigInt(token.gasPolicy.transfersPerTopUp);
  // Native MST the operator wallet spends per top-up: the hand-out plus its own fee reserve.
  const topUpCostWei = token => gasSupportWei(token) + BigInt(token.gasPolicy.topUpReserveWei);
  const transfersAffordable = (gasWei, token) => gasWei == null ? null : Number(BigInt(gasWei) / BigInt(token.gasPolicy.transferReserveWei));
  const topUpsAffordable = (gasWei, token) => gasWei == null ? null : Number(BigInt(gasWei) / topUpCostWei(token));
  function parseRecipient(value, base = 'https://bazaar.mustree.kr') {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (address(text)) return { address:text, name:'' };
    const uri = text.match(/^ethereum:(0x[0-9a-f]{40})(?:@7601)?(?:[/?].*)?$/i);
    if (uri) return { address:uri[1], name:'' };
    try {
      let url = new URL(text, base);
      if (url.origin === 'https://link.metamask.io' && url.pathname.startsWith('/dapp/bazaar.mustree.kr/')) {
        url = new URL('https://' + url.pathname.slice('/dapp/'.length) + url.search);
      }
      if (!['http:', 'https:'].includes(url.protocol) || !['bazaar.mustree.kr', 'localhost', '127.0.0.1'].includes(url.hostname)) return null;
      const recipient = ['/pay.html', '/operator.html'].includes(url.pathname) ? address(url.searchParams.get('to')) : null;
      return recipient ? { address:recipient, name:(url.searchParams.get('name') || '').trim().slice(0, 30) } : null;
    } catch { return null; }
  }
  function appLink(path, params = {}) {
    const url = new URL(path, 'https://bazaar.mustree.kr');
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') url.searchParams.set(key, value);
    }
    return 'https://link.metamask.io/dapp/bazaar.mustree.kr' + url.pathname + url.search + url.hash;
  }
  function receiveLink(account, { name = '', topup = false } = {}) {
    if (!address(account)) throw failure('INVALID_ADDRESS');
    return appLink(topup ? '/operator.html' : '/pay.html', { to:account, name:String(name).trim().slice(0, 30) });
  }
  // Every kind takes whole won; 1 won = 1 wMST, so units equal won. Payments are capped per transaction.
  function parseAmount(value, kind = 'payment') {
    if (!['payment', 'topup', 'transfer'].includes(kind)) throw failure('INVALID_AMOUNT');
    const text = String(value ?? '').trim().replace(/[\s,원]/g, '');
    if (!/^\d+$/.test(text)) throw failure('INVALID_AMOUNT');
    const units = BigInt(text);
    if (units <= 0n || (kind === 'payment' && units > 10000000n)) throw failure('INVALID_AMOUNT');
    return { won:units, units };
  }
  const sameChain = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
  async function prepare(provider, { account, recipient, value, kind = 'payment', chainId, token, readBalanceFromRpc }) {
    const to = parseRecipient(recipient)?.address;
    if (!to) throw failure('INVALID_ADDRESS');
    if (!address(account)) throw failure('NO_ACCOUNT');
    if (!tokenReady(token)) throw failure('TOKEN_NOT_CONFIGURED');
    const amount = parseAmount(value, kind);
    async function verify() {
      const [accounts, chain] = await Promise.all([
        provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })
      ]);
      if (!address(accounts?.[0]) || accounts[0].toLowerCase() !== account.toLowerCase()) throw failure('ACCOUNT_CHANGED');
      if (!sameChain(chain, chainId)) throw failure('WRONG_CHAIN');
    }
    async function readBalances(target) {
      let raw;
      try {
        raw = { gasWei: await provider.request({ method: 'eth_getBalance', params: [target, 'latest'] }),
          balanceWei: await provider.request({ method: 'eth_call', params: [{ to:token.address, data:abi.balanceOf(token, target) }, 'latest'] }) };
      } catch (error) { if (!readBalanceFromRpc) throw error; raw = await readBalanceFromRpc(target); }
      if (!raw || !HEX.test(raw.gasWei || '') || !HEX.test(raw.balanceWei || '')) throw failure('INVALID_BALANCE');
      return { balance:BigInt(raw.balanceWei), gas:BigInt(raw.gasWei) };
    }
    await verify();
    const { balance, gas } = await readBalances(account);
    await verify();
    const policy = token.gasPolicy, topup = kind === 'topup';
    const supportWei = topup ? gasSupportWei(token) : 0n;
    const reserveWei = supportWei + BigInt(topup ? policy.topUpReserveWei : policy.transferReserveWei);
    if (balance < amount.units) throw Object.assign(failure('INSUFFICIENT_BALANCE'), { balanceWei:balance.toString(), gasWei:gas.toString() });
    if (gas < reserveWei) throw Object.assign(failure('INSUFFICIENT_GAS'), { balanceWei:balance.toString(), gasWei:gas.toString() });
    const transaction = {
      from: account, to: token.address,
      data: topup ? abi.transferWithGas(token, to, amount.units) : abi.transfer(token, to, amount.units),
      value: '0x' + supportWei.toString(16),
      maxFeePerGas: '0x' + BigInt(policy.maxFeePerGasWei).toString(16),
      maxPriorityFeePerGas: '0x' + BigInt(policy.maxPriorityFeePerGasWei).toString(16)
    };
    return { amount, recipient:to, gasSupportWei:supportWei, transaction };
  }
  async function waitForReceipt(provider, hash, { interval = 1800, attempts = 70, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
    for (let i = 0; i < attempts; i++) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (receipt) {
        if (receipt.status === '0x1' || receipt.status === '0x01' || receipt.status === 1) return receipt;
        if (receipt.status === '0x0' || receipt.status === '0x00' || receipt.status === 0) throw failure('TRANSACTION_FAILED');
        throw failure('INVALID_RECEIPT');
      }
      if (i + 1 < attempts) await wait(interval);
    }
    throw failure('RECEIPT_TIMEOUT');
  }
  function createSender({ provider, chainId, token, pollInterval = 1800, maxPolls = 70, wait,
    readTimeout = 12000, storage = null, diagnostics = null }) {
    let active = null, pendingHash = null, pendingAccount = null, pendingDetails = null, actualChainId = null;
    const key = account => 'bazaar-payment-pending-v1:' + chainId + ':' + account.toLowerCase();
    const log = (stage, error, hash = pendingHash) => diagnostics?.record({ stage, error, hash, chainId:actualChainId });
    async function request(request) {
      const method = request.method;
      let timer;
      try {
        // Receipt reads must stay on the original chain, including after app return.
        if (method === 'eth_getTransactionReceipt') {
          const chain = await rpc.request({ method:'eth_chainId' });
          if (!sameChain(chain, chainId)) throw failure('WRONG_CHAIN');
        }
        const task = Promise.resolve().then(() => provider.request(request));
        const result = method === 'eth_sendTransaction' ? await task : await Promise.race([
          task, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('READ_TIMEOUT')), readTimeout); })
        ]);
        if (method === 'eth_chainId') actualChainId = result;
        log('transfer:' + method + ':success', null, method === 'eth_sendTransaction' ? result : pendingHash);
        return result;
      } catch (error) { log('transfer:' + method + ':failure', error); throw error; }
      finally { clearTimeout(timer); }
    }
    const rpc = { request };
    function pending(account) {
      if (pendingHash) return pendingHash;
      try {
        const entry = JSON.parse(storage?.getItem(key(account)) || 'null');
        if (HASH.test(entry?.hash || '')) {
          pendingHash = entry.hash; pendingAccount = account;
          if (address(entry.details?.recipient) && entry.details.account?.toLowerCase() === account.toLowerCase()) pendingDetails = entry.details;
        }
      } catch {}
      return pendingHash;
    }
    function clearPending(hash) {
      if (pendingHash !== hash) return;
      try { storage?.removeItem(key(pendingAccount)); } catch {}
      pendingHash = null; pendingAccount = null; pendingDetails = null;
    }
    async function check(hash = pendingHash) {
      log('receipt:checking', null, hash);
      try {
        const receipt = await waitForReceipt(rpc, hash, { interval:pollInterval, attempts:maxPolls, wait });
        log('receipt:confirmed', null, hash); clearPending(hash); return receipt;
      } catch (error) {
        log('receipt:failure', error, hash);
        // Only an explicit failed receipt makes a new payment safe.
        if (error.code === 'TRANSACTION_FAILED') clearPending(hash);
        throw error;
      }
    }
    function send(details, { onHash = () => {} } = {}) {
      if (active) return active;
      if (pending(details.account)) return Promise.reject(Object.assign(failure('PENDING_TRANSACTION'), { hash:pendingHash }));
      active = (async () => {
        log('payment:prepare');
        let prepared;
        try { prepared = await prepare(rpc, { ...details, chainId, token }); }
        catch (error) { log('payment:prepare:failure', error); throw error; }
        // Include chainId so the wallet can also reject a network change at approval time.
        const hash = await rpc.request({ method:'eth_sendTransaction', params:[{ ...prepared.transaction, chainId }] });
        if (!HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
        pendingHash = hash; pendingAccount = details.account;
        pendingDetails = { account:details.account, recipient:details.recipient, value:details.value, kind:details.kind || 'payment' };
        // Persist before callbacks or receipt reads, so a reload cannot discard a sent hash.
        try { storage?.setItem(key(pendingAccount), JSON.stringify({ hash, details:pendingDetails })); }
        catch (error) { log('payment:pending-storage-failure', error); }
        log('payment:hash-received');
        onHash(hash);
        return { ...prepared, hash, receipt:await check(hash) };
      })().finally(() => { active = null; });
      return active;
    }
    return { send, check, pending, getChainId:() => actualChainId, pendingDetails:() => pendingDetails && ({ ...pendingDetails }) };
  }
  return { abi, tokenReady, gasSupportWei, topUpCostWei, transfersAffordable, topUpsAffordable, parseRecipient, appLink, receiveLink, parseAmount, prepare, waitForReceipt, createSender };
});
