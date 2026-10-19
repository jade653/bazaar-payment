(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarPayment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const HASH = /^0x[0-9a-f]{64}$/i;
  const WEI_PER_WON = 10n ** 15n;
  function failure(code) { return Object.assign(new Error(code), { code }); }
  function address(value) { return typeof value === 'string' && ADDRESS.test(value) ? value : null; }
  function parseMerchant(value, base = 'https://bazaar.mustree.kr') {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (address(text)) return text;
    try {
      const url = new URL(text, base);
      if (!['bazaar.mustree.kr', 'localhost', '127.0.0.1'].includes(url.hostname)) return null;
      const pathMatch = url.pathname.match(/^\/pay\/(0x[0-9a-f]{40})(?:\/\d+)?\/?$/i);
      if (pathMatch) return pathMatch[1];
      if (url.pathname.endsWith('/pay.html')) return address(url.searchParams.get('to'));
    } catch {}
    return null;
  }
  function amountFromWon(value) {
    const text = String(value ?? '').replace(/[\s,원]/g, '');
    if (!/^\d+$/.test(text)) throw failure('INVALID_AMOUNT');
    const won = BigInt(text);
    if (won <= 0n || won > 10000000n) throw failure('INVALID_AMOUNT');
    const wei = won * WEI_PER_WON;
    const whole = won / 1000n, remainder = won % 1000n;
    const mstText = whole.toString() + (remainder ? '.' + remainder.toString().padStart(3, '0').replace(/0+$/, '') : '');
    return { won, wei, mstText, valueHex: '0x' + wei.toString(16) };
  }
  function sameChain(a, b) { try { return BigInt(a) === BigInt(b); } catch { return false; } }
  async function prepare(provider, { account, recipient, won, chainId, readBalanceFromRpc = null }) {
    const to = address(recipient);
    if (!to) throw failure('INVALID_ADDRESS');
    if (!address(account)) throw failure('NO_ACCOUNT');
    const amount = amountFromWon(won);
    const [accounts, chain] = await Promise.all([
      provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })
    ]);
    if (!address(accounts?.[0]) || accounts[0].toLowerCase() !== account.toLowerCase()) throw failure('ACCOUNT_CHANGED');
    if (!sameChain(chain, chainId)) throw failure('WRONG_CHAIN');
    let balanceHex;
    try { balanceHex = await provider.request({ method: 'eth_getBalance', params: [account, 'latest'] }); }
    catch (error) { if (!readBalanceFromRpc) throw error; balanceHex = await readBalanceFromRpc(account); }
    const [latestAccounts, latestChain] = await Promise.all([
      provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })
    ]);
    if (!address(latestAccounts?.[0]) || latestAccounts[0].toLowerCase() !== account.toLowerCase()) throw failure('ACCOUNT_CHANGED');
    if (!sameChain(latestChain, chainId)) throw failure('WRONG_CHAIN');
    let balance; try { balance = BigInt(balanceHex); } catch { throw failure('INVALID_BALANCE'); }
    if (balance <= amount.wei) throw failure('INSUFFICIENT_BALANCE');
    return { amount, transaction: { from: account, to, value: amount.valueHex } };
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
  function paymentPath(recipient, won) {
    const to = address(recipient), amount = amountFromWon(won);
    if (!to) throw failure('INVALID_ADDRESS');
    return `/pay/${to}/${amount.won}`;
  }
  return { parseMerchant, amountFromWon, prepare, waitForReceipt, paymentPath, WEI_PER_WON };
});
