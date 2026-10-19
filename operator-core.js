(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarOperator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const TX_HASH = /^0x[0-9a-f]{64}$/i;
  const WON_PER_MST = 1000n;
  const WEI_PER_MST = 10n ** 18n;
  const BONUS_PERCENT = 10n;
  const TARGET_GAS_RESERVE_WEI = 50_000_000n;

  function failure(code, message = code) {
    return Object.assign(new Error(message), { code });
  }
  function parseAddress(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (ADDRESS.test(text)) return text;
    const match = text.match(/^ethereum:(0x[0-9a-f]{40})(?:@\d+)?(?:[/?].*)?$/i);
    return match ? match[1] : null;
  }
  function parseWon(value) {
    const text = String(value ?? '').replace(/[\s,원]/g, '');
    if (!/^\d+$/.test(text)) throw failure('INVALID_AMOUNT');
    const won = BigInt(text);
    if (won < WON_PER_MST || won % WON_PER_MST !== 0n) throw failure('INVALID_AMOUNT');
    return won;
  }
  function amountFromWon(value) {
    const won = parseWon(value);
    const baseMst = won / WON_PER_MST;
    const mstTenths = baseMst * 11n;
    const wei = mstTenths * (WEI_PER_MST / 10n);
    const mstText = `${mstTenths / 10n}.${mstTenths % 10n}`;
    return { won, baseMst, bonusTenths: baseMst, mstTenths, mstText, wei, valueHex: '0x' + wei.toString(16) };
  }
  function sameChain(a, b) {
    try { return BigInt(a) === BigInt(b); } catch { return false; }
  }
  function gasTopUpFor(balanceWei) {
    let balance;
    try { balance = BigInt(balanceWei); } catch { throw failure('INVALID_BALANCE'); }
    const fractionalWei = ((balance % WEI_PER_MST) + WEI_PER_MST) % WEI_PER_MST;
    return fractionalWei >= TARGET_GAS_RESERVE_WEI ? 0n : TARGET_GAS_RESERVE_WEI - fractionalWei;
  }
  async function prepareTransaction(provider, { account, recipient, won, chainId }) {
    const to = parseAddress(recipient);
    if (!to) throw failure('INVALID_ADDRESS');
    if (!ADDRESS.test(account || '')) throw failure('NO_ACCOUNT');
    const amount = amountFromWon(won);
    const [accounts, activeChain, balanceHex, recipientBalanceHex] = await Promise.all([
      provider.request({ method: 'eth_accounts' }),
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_getBalance', params: [account, 'latest'] }),
      provider.request({ method: 'eth_getBalance', params: [to, 'latest'] })
    ]);
    if (!ADDRESS.test(accounts?.[0] || '') || accounts[0].toLowerCase() !== account.toLowerCase()) throw failure('ACCOUNT_CHANGED');
    if (!sameChain(activeChain, chainId)) throw failure('WRONG_CHAIN');
    let balance;
    try { balance = BigInt(balanceHex); } catch { throw failure('INVALID_BALANCE'); }
    const gasTopUpWei = gasTopUpFor(recipientBalanceHex);
    const payoutWei = amount.wei + gasTopUpWei;
    if (balance <= payoutWei) throw failure('INSUFFICIENT_BALANCE');
    return { amount, gasTopUpWei, payoutWei, transaction: { from: account, to, value: '0x' + payoutWei.toString(16) } };
  }
  function createSender({ provider, chainId, pollInterval = 1800, maxPolls = 70, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    let active = null;
    async function waitForReceipt(hash) {
      if (!TX_HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
      for (let i = 0; i < maxPolls; i++) {
        const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (receipt) {
          if (receipt.status === '0x1' || receipt.status === 1 || receipt.status === '0x01') return receipt;
          throw failure('TRANSACTION_FAILED');
        }
        if (i + 1 < maxPolls) await wait(pollInterval);
      }
      throw failure('RECEIPT_TIMEOUT');
    }
    function send(details) {
      if (active) return active;
      active = (async () => {
        const prepared = await prepareTransaction(provider, { ...details, chainId });
        const hash = await provider.request({ method: 'eth_sendTransaction', params: [prepared.transaction] });
        if (!TX_HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
        return { ...prepared, hash, receipt: await waitForReceipt(hash) };
      })().finally(() => { active = null; });
      return active;
    }
    return { send, waitForReceipt, isSending: () => Boolean(active) };
  }
  return { parseAddress, parseWon, amountFromWon, gasTopUpFor, prepareTransaction, createSender, WON_PER_MST, WEI_PER_MST, BONUS_PERCENT, TARGET_GAS_RESERVE_WEI };
});
