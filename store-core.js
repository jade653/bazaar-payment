(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ADDRESS = /^0x[0-9a-f]{40}$/i;
  const WEI_PER_MST = 10n ** 18n;

  function failure(code) { return Object.assign(new Error(code), { code }); }
  function parseRecipient(value, origin = 'https://bazaar.mustree.kr') {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (ADDRESS.test(text)) return text;
    const ethereum = text.match(/^ethereum:(0x[0-9a-f]{40})(?:@\d+)?(?:[/?].*)?$/i);
    if (ethereum) return ethereum[1];
    try {
      const url = new URL(text, origin);
      if (!['bazaar.mustree.kr','localhost','127.0.0.1'].includes(url.hostname)) return null;
      return url.pathname.match(/^\/pay\/(0x[0-9a-f]{40})(?:\/\d+)?\/?$/i)?.[1] || null;
    } catch { return null; }
  }
  function parseAmount(value) {
    const text = String(value ?? '').trim().replace(/,/g, '');
    if (!/^\d+(?:\.\d{1,3})?$/.test(text)) throw failure('INVALID_AMOUNT');
    const [whole, fraction = ''] = text.split('.');
    const wei = BigInt(whole) * WEI_PER_MST + BigInt(fraction.padEnd(3, '0')) * 10n ** 15n;
    if (wei <= 0n) throw failure('INVALID_AMOUNT');
    return { wei, text: BigInt(whole).toString() + (fraction ? '.' + fraction.replace(/0+$/, '') : ''), valueHex: '0x' + wei.toString(16) };
  }
  async function prepare(provider, { account, recipient, amount, chainId }) {
    if (!ADDRESS.test(account || '') || !ADDRESS.test(recipient || '')) throw failure('INVALID_ADDRESS');
    const parsed = parseAmount(amount);
    const [accounts, chain, balanceHex] = await Promise.all([
      provider.request({ method: 'eth_accounts' }),
      provider.request({ method: 'eth_chainId' }),
      provider.request({ method: 'eth_getBalance', params: [account, 'latest'] })
    ]);
    if (!ADDRESS.test(accounts?.[0] || '') || accounts[0].toLowerCase() !== account.toLowerCase()) throw failure('ACCOUNT_CHANGED');
    try { if (BigInt(chain) !== BigInt(chainId)) throw failure('WRONG_CHAIN'); } catch (error) { if (error.code) throw error; throw failure('WRONG_CHAIN'); }
    let balance; try { balance = BigInt(balanceHex); } catch { throw failure('INVALID_BALANCE'); }
    if (balance <= parsed.wei) throw failure('INSUFFICIENT_BALANCE');
    return { amount: parsed, transaction: { from: account, to: recipient, value: parsed.valueHex } };
  }
  function paymentLink(account, name = '', origin = 'https://bazaar.mustree.kr') {
    if (!ADDRESS.test(account || '')) throw failure('INVALID_ADDRESS');
    const url = new URL(`/pay/${account}`, origin);
    const cleanName = String(name || '').trim().slice(0, 30);
    if (cleanName) url.searchParams.set('name', cleanName);
    return url.href;
  }
  async function recentTransfers(fetchImpl, { account, rpcUrl, blockWindow = 600, limit = 20 }) {
    if (typeof fetchImpl !== 'function' || !ADDRESS.test(account || '')) throw failure('INVALID_ADDRESS');
    let nextId = 1;
    async function batch(calls) {
      const payload = calls.map(call => ({ jsonrpc:'2.0', id:nextId++, method:call.method, params:call.params }));
      const response = await fetchImpl(rpcUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
      if (!response.ok) throw failure('HISTORY_UNAVAILABLE');
      const body = await response.json(), byId = new Map(body.map(item => [item.id,item]));
      return payload.map(item => byId.get(item.id)?.result ?? null);
    }
    const [latestHex] = await batch([{method:'eth_blockNumber',params:[]}]);
    if (!latestHex) throw failure('HISTORY_UNAVAILABLE');
    const latest = Number(BigInt(latestHex)), lower = Math.max(0, latest - blockWindow + 1), found = [];
    for (let high = latest; high >= lower && found.length < limit; high -= 100) {
      const low = Math.max(lower, high - 99), calls = [];
      for (let number = high; number >= low; number--) calls.push({method:'eth_getBlockByNumber',params:['0x'+number.toString(16),true]});
      const blocks = await batch(calls);
      for (const block of blocks) for (const tx of block?.transactions || []) {
        const from = String(tx.from || '').toLowerCase(), to = String(tx.to || '').toLowerCase(), own = account.toLowerCase();
        if (from !== own && to !== own) continue;
        found.push({ hash:tx.hash, blockNumber:tx.blockNumber || block.number, timestamp:Number(BigInt(block.timestamp)), direction:to===own?'in':'out', valueWei:BigInt(tx.value || '0x0') });
        if (found.length >= limit) break;
      }
    }
    if (!found.length) return [];
    const balances = await batch(found.map(item => ({method:'eth_getBalance',params:[account,item.blockNumber]})));
    return found.map((item,index) => ({...item,balanceWei:BigInt(balances[index] || '0x0')}));
  }
  return { parseRecipient, parseAmount, prepare, paymentLink, recentTransfers, WEI_PER_MST };
});
