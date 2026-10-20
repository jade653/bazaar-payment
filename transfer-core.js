(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarTransfer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
  const WEI_PER_MST = 10n ** 18n, WEI_PER_WON = 10n ** 15n;
  const failure = code => Object.assign(new Error(code), { code });
  const address = value => typeof value === 'string' && ADDRESS.test(value) ? value : null;
  function parseRecipient(value, base = 'https://bazaar.mustree.kr') {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (address(text)) return text;
    const uri = text.match(/^ethereum:(0x[0-9a-f]{40})(?:@7601)?(?:[/?].*)?$/i);
    if (uri) return uri[1];
    try {
      const url = new URL(text, base);
      if (!['http:', 'https:'].includes(url.protocol) || !['bazaar.mustree.kr', 'localhost', '127.0.0.1'].includes(url.hostname)) return null;
      return url.pathname.match(/^\/pay\/(0x[0-9a-f]{40})(?:\/\d+)?\/?$/i)?.[1]
        || (url.pathname === '/pay.html' ? address(url.searchParams.get('to')) : null);
    } catch { return null; }
  }
  function paymentLink(account, name = '', origin = 'https://bazaar.mustree.kr') {
    if (!address(account)) throw failure('INVALID_ADDRESS');
    const url = new URL(`/pay/${account}`, origin), cleanName = String(name).trim().slice(0, 30);
    if (cleanName) url.searchParams.set('name', cleanName);
    return url.href;
  }
  function parseAmount(value, kind = 'payment') {
    if (!['payment', 'topup', 'transfer'].includes(kind)) throw failure('INVALID_AMOUNT');
    const text = String(value ?? '').trim().replace(kind === 'transfer' ? /,/g : /[\s,원]/g, '');
    if (kind !== 'transfer') {
      if (!/^\d+$/.test(text)) throw failure('INVALID_AMOUNT');
      const won = BigInt(text);
      if (won <= 0n || (kind === 'topup' ? won % 1000n !== 0n : won > 10000000n)) throw failure('INVALID_AMOUNT');
      return { won, wei:won * WEI_PER_WON * (kind === 'topup' ? 110n : 100n) / 100n };
    }
    if (!/^\d+(?:\.\d{1,3})?$/.test(text)) throw failure('INVALID_AMOUNT');
    const [whole, fraction = ''] = text.split('.');
    const wei = BigInt(whole) * WEI_PER_MST + BigInt(fraction.padEnd(3, '0')) * WEI_PER_WON;
    if (wei <= 0n) throw failure('INVALID_AMOUNT');
    return { wei };
  }
  const sameChain = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
  async function prepare(provider, { account, recipient, value, kind = 'payment', chainId, readBalanceFromRpc }) {
    const to = parseRecipient(recipient);
    if (!to) throw failure('INVALID_ADDRESS');
    if (!address(account)) throw failure('NO_ACCOUNT');
    const amount = parseAmount(value, kind);
    async function verify() {
      const [accounts, chain] = await Promise.all([
        provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })
      ]);
      if (!address(accounts?.[0]) || accounts[0].toLowerCase() !== account.toLowerCase()) throw failure('ACCOUNT_CHANGED');
      if (!sameChain(chain, chainId)) throw failure('WRONG_CHAIN');
    }
    async function readBalance(target) {
      let raw;
      try { raw = await provider.request({ method: 'eth_getBalance', params: [target, 'latest'] }); }
      catch (error) { if (!readBalanceFromRpc) throw error; raw = await readBalanceFromRpc(target); }
      if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) throw failure('INVALID_BALANCE');
      return BigInt(raw);
    }
    await verify();
    const [balance, recipientBalance] = await Promise.all([readBalance(account), kind === 'topup' ? readBalance(to) : 0n]);
    await verify();
    const fraction = recipientBalance % WEI_PER_MST;
    const gasTopUpWei = kind === 'topup' && fraction < 50_000_000n ? 50_000_000n - fraction : 0n;
    const payoutWei = amount.wei + gasTopUpWei;
    if (balance <= payoutWei) throw failure('INSUFFICIENT_BALANCE');
    return { amount, gasTopUpWei, payoutWei, transaction: { from: account, to, value: '0x' + payoutWei.toString(16) } };
  }
  async function waitForReceipt(provider, hash, { interval = 1800, attempts = 70, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    if (!HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
    for (let i = 0; i < attempts; i++) {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (receipt) {
        if (receipt.status === '0x1' || receipt.status === '0x01' || receipt.status === 1) return receipt;
        throw failure('TRANSACTION_FAILED');
      }
      if (i + 1 < attempts) await wait(interval);
    }
    throw failure('RECEIPT_TIMEOUT');
  }
  function createSender({ provider, chainId, pollInterval = 1800, maxPolls = 70, wait }) {
    let active = null, pendingHash = null;
    async function check(hash = pendingHash) {
      try {
        const receipt = await waitForReceipt(provider, hash, { interval: pollInterval, attempts: maxPolls, wait });
        if (pendingHash === hash) pendingHash = null;
        return receipt;
      } catch (error) {
        if (error.code === 'TRANSACTION_FAILED' && pendingHash === hash) pendingHash = null;
        throw error;
      }
    }
    function send(details, { onHash = () => {} } = {}) {
      if (active) return active;
      if (pendingHash) return Promise.reject(Object.assign(failure('PENDING_TRANSACTION'), { hash: pendingHash }));
      active = (async () => {
        const prepared = await prepare(provider, { ...details, chainId });
        const hash = await provider.request({ method: 'eth_sendTransaction', params: [prepared.transaction] });
        if (!HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
        pendingHash = hash;
        onHash(hash);
        return { ...prepared, hash, receipt: await check(hash) };
      })().finally(() => { active = null; });
      return active;
    }
    return { send, check };
  }
  return { parseRecipient, paymentLink, parseAmount, prepare, waitForReceipt, createSender };
});
