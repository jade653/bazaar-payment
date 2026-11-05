'use strict';

// Read-load test for the public RPC the site depends on (no keys, no transactions).
// Sends the exact JSON-RPC payloads the pages and MetaMask send, at rising open-loop
// request rates, and reports for each stage the achieved rate, latency percentiles and
// errors. The highest stage that stays within --max-p95-ms and --max-error-rate is the
// sustainable rate; it is converted to concurrent users with the per-page request model
// below (derived from the polling constants in store.js, live.js, dashboard.js,
// transaction-history.js and transfer-core.js).
//
//   node tools/load-test-rpc.cjs --probe-only            # limits only (batch size, log payloads)
//   node tools/load-test-rpc.cjs --rates 10,25,50,100,200 --stage-seconds 20 --yes
//   node tools/load-test-rpc.cjs --url http://127.0.0.1:8545 --rates 50,100,200
//
// The production RPC is shared with real users: run it outside event hours, start low,
// and the run stops at the first stage that breaks the thresholds. --yes is required
// for any non-local URL. Results go to measurements/load-test-rpc.json (git-ignored).
const fs = require('node:fs');
const path = require('node:path');
const { NETWORK, TOKEN } = require('../wallet.js');

const LOG_CHUNK = 50000, HISTORY_WINDOW = 43200;
const pad = value => BigInt(value).toString(16).padStart(64, '0');
const hex = number => '0x' + BigInt(number).toString(16);
const topicOf = address => '0x' + pad(address);

// HTTP requests per minute one open page causes. MetaMask sends its reads one call per HTTP
// request; the site's own public-RPC reads are JSON-RPC batches (one HTTP request each).
const USER_MODEL = Object.freeze({
  // store.html: wallet balance every 5 s through MetaMask (eth_getBalance + eth_call), history once a minute
  // (eth_blockNumber, the two-log batch, block headers, pinned eth_call).
  store: { perMinute: 12 * 2 + 4, note: '가게 화면: 5초마다 잔액(2) + 1분마다 내역(약 4)' },
  // index.html (home view): balance and history once a minute.
  customer: { perMinute: 2 + 4, note: '개인 지갑 화면: 1분마다 잔액(2) + 내역(약 4)' },
  // dashboard.html: eth_blockNumber + eth_getLogs every 10 s, plus occasional header batches.
  dashboard: { perMinute: 6 * 2 + 1, note: '운영 현황: 10초마다 블록 번호·로그(2) + 헤더' },
  // One payment: balance (2), MetaMask estimateGas / nonce / send (3), receipt polls every 1.8 s (~2).
  payment: { perEvent: 7, note: '결제 1건: 잔액(2) + 견적·nonce·전송(3) + 영수증 확인(약 2)' }
});

// One operation = one HTTP request, weighted by how often the pages send it.
function operations({ token, account, latest, receiptHash }) {
  const me = topicOf(account), tokenAddress = token.address;
  const balance = [{ method:'eth_getBalance', params:[account, 'latest'] }, { method:'eth_call', params:[{ to:tokenAddress, data:token.selectors.balanceOf + pad(account) }, 'latest'] }];
  const historyRange = from => ({ address:tokenAddress, fromBlock:hex(Math.max(token.deployBlock, from)), toBlock:hex(latest) });
  return [
    { name:'balance', weight:40, calls:balance },
    { name:'blockNumber', weight:15, calls:[{ method:'eth_blockNumber', params:[] }] },
    { name:'history-incremental', weight:12, calls:[{ method:'eth_getLogs', params:[{ ...historyRange(latest - 30), topics:[token.transferTopic, me] }] }, { method:'eth_getLogs', params:[{ ...historyRange(latest - 30), topics:[token.transferTopic, null, me] }] }] },
    { name:'balance-pinned', weight:8, calls:[{ method:'eth_call', params:[{ to:tokenAddress, data:token.selectors.balanceOf + pad(account) }, hex(latest)] }] },
    { name:'dashboard-incremental', weight:6, calls:[{ method:'eth_getLogs', params:[{ address:tokenAddress, fromBlock:hex(latest - 5), toBlock:hex(latest), topics:[token.transferTopic] }] }] },
    { name:'estimate-transfer', weight:6, calls:[{ method:'eth_estimateGas', params:[{ from:account, to:tokenAddress, data:token.selectors.transfer + pad(account) + pad(1) }] }] },
    { name:'receipt', weight:6, calls:[{ method:'eth_getTransactionReceipt', params:[receiptHash || '0x' + '0'.repeat(64)] }] },
    { name:'headers-10', weight:3, calls:Array.from({ length:10 }, (_, index) => ({ method:'eth_getBlockByNumber', params:[hex(latest - index), false] })) },
    // First visit to a wallet page: one day of logs for one account.
    { name:'history-initial', weight:3, calls:[{ method:'eth_getLogs', params:[{ ...historyRange(latest - HISTORY_WINDOW + 1), topics:[token.transferTopic, me] }] }, { method:'eth_getLogs', params:[{ ...historyRange(latest - HISTORY_WINDOW + 1), topics:[token.transferTopic, null, me] }] }] },
    // Opening the dashboard reads every Transfer log since deployment, 50,000 blocks per request.
    { name:'dashboard-full-chunk', weight:1, calls:[{ method:'eth_getLogs', params:[{ address:tokenAddress, fromBlock:hex(Math.max(token.deployBlock, latest - LOG_CHUNK + 1)), toBlock:hex(latest), topics:[token.transferTopic] }] }] }
  ];
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
function summarize(samples, seconds) {
  const ok = samples.filter(sample => sample.ok), times = ok.map(sample => sample.ms).sort((a, b) => a - b);
  const errors = {};
  for (const sample of samples) if (!sample.ok) errors[sample.error] = (errors[sample.error] || 0) + 1;
  const round = value => value == null ? null : Math.round(value * 10) / 10;
  return {
    requests:samples.length, ok:ok.length, failed:samples.length - ok.length,
    errorRate:samples.length ? (samples.length - ok.length) / samples.length : 0,
    achievedRps:round(ok.length / seconds),
    p50Ms:round(percentile(times, .5)), p95Ms:round(percentile(times, .95)), p99Ms:round(percentile(times, .99)), maxMs:round(times.at(-1) ?? null),
    errors
  };
}
// Highest stage that met both thresholds, stopping at the first one that did not.
function sustainable(stages, { maxP95Ms, maxErrorRate }) {
  let best = null;
  for (const stage of stages) {
    if (stage.errorRate > maxErrorRate || stage.p95Ms == null || stage.p95Ms > maxP95Ms) break;
    best = stage;
  }
  return best;
}
// Requests per second converted into concurrently open pages, per page type and for a mixed crowd.
function capacity(rps, { stores = 0, dashboards = 0, paymentsPerMinute = 0 } = {}) {
  if (!(rps > 0)) return null;
  const perMinute = rps * 60;
  const fixed = stores * USER_MODEL.store.perMinute + dashboards * USER_MODEL.dashboard.perMinute + paymentsPerMinute * USER_MODEL.payment.perEvent;
  return {
    sustainableRps:rps,
    onlyStores:Math.floor(perMinute / USER_MODEL.store.perMinute),
    onlyCustomers:Math.floor(perMinute / USER_MODEL.customer.perMinute),
    paymentsPerMinute:Math.floor(perMinute / USER_MODEL.payment.perEvent),
    mixed:{ stores, dashboards, paymentsPerMinute, customersWithAppOpen:Math.max(0, Math.floor((perMinute - fixed) / USER_MODEL.customer.perMinute)) }
  };
}

function parseArgs(argv) {
  const args = { url:NETWORK.rpcUrls[0], rates:[10, 25, 50, 100, 200], stageSeconds:20, maxP95Ms:2000, maxErrorRate:.01, timeoutMs:8000, maxInFlight:2000, account:null, yes:false, probe:true, probeOnly:false, stores:30, dashboards:2, paymentsPerMinute:60 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], next = () => argv[++i];
    if (flag === '--url') args.url = next();
    else if (flag === '--rates') args.rates = next().split(',').map(Number).filter(value => value > 0);
    else if (flag === '--stage-seconds') args.stageSeconds = Number(next());
    else if (flag === '--max-p95-ms') args.maxP95Ms = Number(next());
    else if (flag === '--max-error-rate') args.maxErrorRate = Number(next());
    else if (flag === '--timeout-ms') args.timeoutMs = Number(next());
    else if (flag === '--account') args.account = next();
    else if (flag === '--token') args.token = next();
    else if (flag === '--deploy-block') args.deployBlock = Number(next());
    else if (flag === '--stores') args.stores = Number(next());
    else if (flag === '--dashboards') args.dashboards = Number(next());
    else if (flag === '--payments-per-minute') args.paymentsPerMinute = Number(next());
    else if (flag === '--no-probe') args.probe = false;
    else if (flag === '--probe-only') args.probeOnly = true;
    else if (flag === '--output') args.output = next();
    else if (flag === '--yes') args.yes = true;
    else throw new Error('Unknown option ' + flag);
  }
  return args;
}
const isLocal = url => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\b/.test(url);

function client(url, timeoutMs) {
  let id = 1;
  return async function send(calls) {
    const payload = calls.map(call => ({ jsonrpc:'2.0', id:id++, ...call }));
    const started = performance.now();
    try {
      const response = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(payload), signal:AbortSignal.timeout(timeoutMs) });
      const raw = await response.text();
      if (!response.ok) return { ok:false, ms:performance.now() - started, error:'HTTP ' + response.status, bytes:raw.length };
      let body; try { body = JSON.parse(raw); } catch { return { ok:false, ms:performance.now() - started, error:'invalid JSON', bytes:raw.length }; }
      const items = Array.isArray(body) ? body : [body];
      const failed = items.find(item => item?.error);
      // An execution revert from eth_estimateGas is a normal answer for a read test; count it as served.
      if (failed && !/revert/i.test(failed.error.message || '')) return { ok:false, ms:performance.now() - started, error:'RPC ' + failed.error.code + ' ' + String(failed.error.message).slice(0, 80), bytes:raw.length };
      return { ok:true, ms:performance.now() - started, bytes:raw.length, results:items };
    } catch (error) {
      return { ok:false, ms:performance.now() - started, error:error.name === 'TimeoutError' ? 'timeout' : (error.cause?.code || error.message).slice(0, 80) };
    }
  };
}

// Server limits that break the pages long before raw request rate does.
async function probeLimits(send, { token, latest }) {
  const result = {};
  for (const size of [100, 1000, 1001]) {
    const reply = await send(Array.from({ length:size }, () => ({ method:'eth_blockNumber', params:[] })));
    result['batch' + size] = reply.ok ? 'accepted' : reply.error;
  }
  const chunks = [];
  for (let low = Math.max(0, token.deployBlock); low <= latest; low += LOG_CHUNK) {
    const high = Math.min(latest, low + LOG_CHUNK - 1);
    const reply = await send([{ method:'eth_getLogs', params:[{ address:token.address, fromBlock:hex(low), toBlock:hex(high), topics:[token.transferTopic] }] }]);
    chunks.push({ fromBlock:low, toBlock:high, ok:reply.ok, ms:Math.round(reply.ms), bytes:reply.bytes || 0, logs:reply.ok ? reply.results[0].result?.length ?? 0 : null, error:reply.error });
  }
  const logs = chunks.reduce((sum, chunk) => sum + (chunk.logs || 0), 0), bytes = chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
  result.dashboardFullScan = { requests:chunks.length, totalLogs:logs, totalBytes:bytes, bytesPerLog:logs ? Math.round(bytes / logs) : null, totalMs:chunks.reduce((sum, chunk) => sum + chunk.ms, 0), failedChunks:chunks.filter(chunk => !chunk.ok).length, chunks };
  return result;
}

async function runStage(send, ops, { rate, seconds, maxInFlight }) {
  const total = ops.reduce((sum, op) => sum + op.weight, 0), samples = [], pending = new Set();
  const pick = () => { let roll = Math.random() * total; for (const op of ops) if ((roll -= op.weight) < 0) return op; return ops[0]; };
  const started = performance.now(), count = Math.round(rate * seconds);
  let dropped = 0;
  for (let i = 0; i < count; i++) {
    const due = started + (i / rate) * 1000, wait = due - performance.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    if (pending.size >= maxInFlight) { dropped++; samples.push({ ok:false, ms:0, error:'client in-flight cap', op:'-' }); continue; }
    const op = pick();
    const task = send(op.calls).then(sample => { samples.push({ ...sample, results:undefined, op:op.name }); pending.delete(task); });
    pending.add(task);
  }
  await Promise.all(pending);
  const elapsed = Math.max(seconds, (performance.now() - started) / 1000);
  const byOp = {};
  for (const op of ops) byOp[op.name] = summarize(samples.filter(sample => sample.op === op.name), elapsed);
  return { targetRps:rate, seconds:Math.round(elapsed * 10) / 10, ...summarize(samples, elapsed), dropped, byOp };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!isLocal(args.url) && !args.yes && !args.probeOnly) {
    console.error(`${args.url} 은(는) 실제 사용자와 함께 쓰는 RPC입니다. 단계별 요청률 ${args.rates.join(', ')} req/s × ${args.stageSeconds}s 를 보냅니다.\n행사 시간을 피해 실행하고, 확인했다면 --yes 를 붙여 다시 실행하세요. (--probe-only 는 한도 확인만 합니다)`);
    process.exitCode = 2; return;
  }
  const token = { ...TOKEN, ...(args.token ? { address:args.token } : {}), ...(Number.isSafeInteger(args.deployBlock) ? { deployBlock:args.deployBlock } : {}) };
  const send = client(args.url, args.timeoutMs);
  const head = await send([{ method:'eth_blockNumber', params:[] }, { method:'eth_chainId', params:[] }, { method:'eth_getBlockByNumber', params:['latest', false] }]);
  if (!head.ok) throw new Error('RPC unavailable: ' + head.error);
  const [latestHex, chainId, block] = head.results.map(item => item.result);
  const latest = Number(BigInt(latestHex));
  const account = (args.account || token.operatorWallets?.[0] || '0x' + '0'.repeat(40)).toLowerCase();
  const recent = await send([{ method:'eth_getLogs', params:[{ address:token.address, fromBlock:hex(Math.max(token.deployBlock, latest - HISTORY_WINDOW)), toBlock:latestHex, topics:[token.transferTopic] }] }]);
  const receiptHash = recent.ok ? recent.results[0].result?.at(-1)?.transactionHash : null;
  const info = { url:args.url, chainId, latestBlock:latest, blockGasLimit:block?.gasLimit ? Number(BigInt(block.gasLimit)) : null, token:token.address, account, startedAt:new Date().toISOString() };
  console.log('대상', JSON.stringify(info));

  const limits = args.probe || args.probeOnly ? await probeLimits(send, { token, latest }) : null;
  if (limits) console.log('한도 확인', JSON.stringify({ ...limits, dashboardFullScan:{ ...limits.dashboardFullScan, chunks:undefined } }));

  const stages = [];
  if (!args.probeOnly) {
    const ops = operations({ token, account, latest, receiptHash });
    for (const rate of args.rates) {
      const stage = await runStage(send, ops, { rate, seconds:args.stageSeconds, maxInFlight:args.maxInFlight });
      stages.push(stage);
      console.log(`${String(rate).padStart(5)} req/s 목표 → 처리 ${stage.achievedRps} req/s, p50 ${stage.p50Ms}ms, p95 ${stage.p95Ms}ms, p99 ${stage.p99Ms}ms, 실패 ${(stage.errorRate * 100).toFixed(2)}%` + (Object.keys(stage.errors).length ? ' ' + JSON.stringify(stage.errors) : ''));
      if (stage.errorRate > args.maxErrorRate || stage.p95Ms == null || stage.p95Ms > args.maxP95Ms) { console.log('기준을 넘어 이 단계에서 멈춥니다.'); break; }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  const best = sustainable(stages, args);
  const result = {
    ...info, finishedAt:new Date().toISOString(), environment:'Node.js fetch from one machine; MetaMask background polling is not included',
    thresholds:{ maxP95Ms:args.maxP95Ms, maxErrorRate:args.maxErrorRate }, userModel:USER_MODEL, limits, stages,
    sustainableRps:best?.achievedRps ?? null,
    capacity:best ? capacity(best.achievedRps, args) : null
  };
  const output = path.resolve(args.output || path.join(__dirname, '../measurements/load-test-rpc.json'));
  fs.mkdirSync(path.dirname(output), { recursive:true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  if (!args.probeOnly) console.log('결과', JSON.stringify({ sustainableRps:result.sustainableRps, capacity:result.capacity }, null, 2));
  console.log('저장', output);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { USER_MODEL, operations, percentile, summarize, sustainable, capacity, parseArgs, isLocal };
