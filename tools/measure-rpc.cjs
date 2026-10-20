'use strict';

// Read-only, sequential sampling of the same RPC payloads used by the frontend.
const fs = require('node:fs');
const path = require('node:path');
const { NETWORK } = require('../wallet.js');
const samples = [], transactions = new Map();
let nextId = 1;
async function measure(kind, calls, freshConnection = false) {
  const payload = calls.map(call => ({jsonrpc:'2.0',id:nextId++,...call}));
  const started = performance.now();
  const sample = {kind,calls:calls.length};
  try {
    const response = await fetch(NETWORK.rpcUrls[0], {
      method:'POST',headers:{'Content-Type':'application/json',...(freshConnection ? {Connection:'close'} : {})},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)
    });
    const raw = await response.text();
    const body = JSON.parse(raw);
    sample.httpStatus = response.status;
    sample.responseBytes = Buffer.byteLength(raw);
    if (!response.ok || !Array.isArray(body)) throw new Error('Invalid HTTP/RPC response');
    const byId = new Map(body.map(item => [item.id,item]));
    const values = payload.map(call => {
      const item = byId.get(call.id);
      if (!item || item.error || item.result == null) throw new Error(JSON.stringify(item?.error || 'missing result'));
      return item.result;
    });
    sample.ok = true;
    return values;
  } catch (error) {
    sample.ok = false; sample.error = error.message;
    return null;
  } finally {
    sample.elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    samples.push(sample);
  }
}
const hex = number => '0x' + number.toString(16);
async function main() {
  const startedAt = new Date().toISOString();
  const head = await measure('cold-head', [{method:'eth_blockNumber',params:[]}]);
  if (!head) throw new Error('RPC head unavailable');
  const latest = Number(BigInt(head[0]));
  // One initial 1,200-block scan, in the production batch size of 100.
  for (let offset = 0; offset < 1200; offset += 100) {
    const blocks = await measure('blocks-100', Array.from({length:100}, (_,index) => ({method:'eth_getBlockByNumber',params:[hex(latest-offset-index),true]})));
    for (const block of blocks || []) for (const tx of block.transactions) transactions.set(tx.hash,tx);
  }
  const txs = [...transactions.values()];
  const account = txs[0]?.from || '0x0000000000000000000000000000000000000000';
  for (let round = 0; round < 12; round++) {
    await new Promise(resolve => setTimeout(resolve,500));
    await measure('fresh-connection-head', [{method:'eth_blockNumber',params:[]}], true);
    await measure('balance-latest', [{method:'eth_getBalance',params:[account,'latest']}]);
    await measure('blocks-10', Array.from({length:10}, (_,index) => ({method:'eth_getBlockByNumber',params:[hex(latest-index),true]})));
    await measure('balance-pinned', [{method:'eth_getBalance',params:[account,hex(latest)]}]);
    if (txs.length) {
      await measure('receipts', txs.slice(0,20).map(tx => ({method:'eth_getTransactionReceipt',params:[tx.hash]})));
      await measure('balances-historical', txs.slice(0,20).map(tx => ({method:'eth_getBalance',params:[account,tx.blockNumber]})));
    }
  }
  const summary = {};
  for (const kind of new Set(samples.map(sample => sample.kind))) {
    const group = samples.filter(sample => sample.kind === kind), times = group.filter(sample => sample.ok).map(sample => sample.elapsedMs).sort((a,b) => a-b);
    summary[kind] = {requests:group.length,failures:group.filter(sample => !sample.ok).length,minMs:times[0],medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.max(0,Math.ceil(times.length*.95)-1)],maxMs:times.at(-1),maxResponseBytes:Math.max(...group.map(sample => sample.responseBytes || 0))};
  }
  const result = {startedAt,finishedAt:new Date().toISOString(),rpcUrl:NETWORK.rpcUrls[0],environment:'Desktop Node.js fetch; sequential requests; not a mobile-network test',latestBlock:latest,transactionsFound:txs.length,summary,samples};
  const output = path.resolve(__dirname,'../measurements/rpc-latency.json');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({output,transactionsFound:txs.length,summary},null,2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
