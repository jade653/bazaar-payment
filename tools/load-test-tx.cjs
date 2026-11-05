'use strict';

// Transaction load test: how many wMST payments per second the chain actually takes in,
// and how long a customer waits for the receipt as the rate rises.
//
// 1. Deploys a separate test copy of the wMST contract from the funding key, so the test
//    never appears in the real token's history or on the dashboard (pass --token to reuse one).
// 2. Tops up --wallets fresh wallets with transferWithGas, all at once from the one funding
//    key (the same burst an operator wallet sees at the top-up desk).
// 3. Sends transfer() payments from those wallets to a store address at rising rates
//    (open loop, each wallet keeps at most one payment in flight like a person does),
//    with the site's fee caps, and follows every new block to time inclusion.
//
//   LOADTEST_PRIVATE_KEY=0x... node tools/load-test-tx.cjs --rates 1,2,5,10,20 --wallets 100 --yes
//   LOADTEST_PRIVATE_KEY=0x... node tools/load-test-tx.cjs --url http://127.0.0.1:8545 --rates 10,50,100
//
// Use a dedicated test key holding a little native MST, never an operator wallet that is in
// use (its nonce would collide with MetaMask). Wallet keys are written to
// measurements/load-test-wallets-*.json (git-ignored) so leftover MST can be recovered.
const fs = require('node:fs');
const path = require('node:path');
const { NETWORK, TOKEN } = require('../wallet.js');
const artifact = require('../contracts/wMST.artifact.json');
const { addressOf, randomPrivateKey, sign1559 } = require('./eth-signer.cjs');
const { percentile, isLocal } = require('./load-test-rpc.cjs');

const pad = value => BigInt(value).toString(16).padStart(64, '0');
const hex = value => '0x' + BigInt(value).toString(16);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Gas limits with headroom over the measured 51,240 (transfer to a new wallet) and 85,701 (top-up).
const TRANSFER_GAS = 65000n, TOPUP_GAS = 110000n;

function parseArgs(argv) {
  const args = { url:NETWORK.rpcUrls[0], rates:[1, 2, 5, 10], stageSeconds:30, wallets:null, drainSeconds:30, maxP95Ms:10000, minIncluded:.99, yes:false, token:null, store:null, maxFee:BigInt(TOKEN.gasPolicy.maxFeePerGasWei), priorityFee:BigInt(TOKEN.gasPolicy.maxPriorityFeePerGasWei) };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], next = () => argv[++i];
    if (flag === '--url') args.url = next();
    else if (flag === '--rates') args.rates = next().split(',').map(Number).filter(value => value > 0);
    else if (flag === '--stage-seconds') args.stageSeconds = Number(next());
    else if (flag === '--wallets') args.wallets = Number(next());
    else if (flag === '--drain-seconds') args.drainSeconds = Number(next());
    else if (flag === '--max-p95-ms') args.maxP95Ms = Number(next());
    else if (flag === '--token') args.token = next();
    else if (flag === '--store') args.store = next();
    else if (flag === '--max-fee-wei') args.maxFee = BigInt(next());
    else if (flag === '--priority-fee-wei') args.priorityFee = BigInt(next());
    else if (flag === '--output') args.output = next();
    else if (flag === '--yes') args.yes = true;
    else throw new Error('Unknown option ' + flag);
  }
  // Enough wallets that each keeps one payment in flight for ~6 s at the highest rate.
  args.wallets ??= Math.max(10, Math.ceil(Math.max(...args.rates) * 6));
  return args;
}

function rpcClient(url) {
  let id = 1;
  // Network failures (reset keep-alive sockets, timeouts) are retried; every request here is safe
  // to repeat, including eth_sendRawTransaction of the same signed bytes.
  async function post(body, timeoutMs) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body), signal:AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { network:true });
        return await response.json();
      } catch (error) {
        if (attempt >= 3 || error.rpcCode != null) throw Object.assign(error, { network:true });
        await sleep(300 * 2 ** attempt);
      }
    }
  }
  async function call(method, params = [], timeoutMs = 15000) {
    const body = await post({ jsonrpc:'2.0', id:id++, method, params }, timeoutMs);
    if (body.error) throw Object.assign(new Error(method + ': ' + body.error.message), { rpcCode:body.error.code });
    return body.result;
  }
  async function batch(calls, timeoutMs = 20000) {
    if (!calls.length) return [];
    const payload = calls.map(item => ({ jsonrpc:'2.0', id:id++, ...item }));
    const body = await post(payload, timeoutMs);
    const byId = new Map((Array.isArray(body) ? body : [body]).map(item => [item.id, item]));
    return payload.map(item => byId.get(item.id)?.result ?? null);
  }
  return { call, batch };
}

// Follows the chain head and records when each block (and the hashes in it) was first seen.
function blockWatcher(rpc, startBlock) {
  const seen = new Map(), blocks = [];
  let next = startBlock + 1, stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const latest = Number(BigInt(await rpc.call('eth_blockNumber')));
        for (; next <= latest; next++) {
          const block = await rpc.call('eth_getBlockByNumber', [hex(next), false]);
          if (!block) break;
          const at = performance.now();
          blocks.push({ number:next, timestamp:Number(BigInt(block.timestamp)), seenAt:at, txs:block.transactions.length, gasUsed:Number(BigInt(block.gasUsed)), gasLimit:Number(BigInt(block.gasLimit)) });
          for (const hash of block.transactions) seen.set(String(hash).toLowerCase(), { block:next, at });
        }
      } catch {}
      await sleep(250);
    }
  })();
  return { seen, blocks, stop:async () => { stopped = true; await loop; } };
}

async function waitReceipts(rpc, hashes, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs, receipts = new Map();
  while (Date.now() < deadline) {
    const missing = hashes.filter(hash => !receipts.has(hash));
    if (!missing.length) break;
    for (let offset = 0; offset < missing.length; offset += 100) {
      const slice = missing.slice(offset, offset + 100);
      const results = await rpc.batch(slice.map(hash => ({ method:'eth_getTransactionReceipt', params:[hash] }))).catch(() => []);
      slice.forEach((hash, index) => { if (results[index]) receipts.set(hash, results[index]); });
    }
    if (hashes.every(hash => receipts.has(hash))) break;
    await sleep(1000);
  }
  return receipts;
}

// A stage passes when nearly every payment was included and the slow ones still arrived in time.
function stagePassed(stage, { maxP95Ms, minIncluded }) {
  return stage.submitted > 0 && stage.included / stage.submitted >= minIncluded && stage.inclusionP95Ms != null && stage.inclusionP95Ms <= maxP95Ms;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = process.env.LOADTEST_PRIVATE_KEY;
  if (!key) throw new Error('LOADTEST_PRIVATE_KEY 환경 변수에 테스트 전용 지갑의 비밀키를 넣어 주세요.');
  if (!isLocal(args.url) && !args.yes) {
    console.error(`${args.url} 체인에 실제 거래를 보냅니다: 테스트 토큰 배포 1건, 충전 ${args.wallets}건, 결제 단계 ${args.rates.join(', ')} tx/s × ${args.stageSeconds}s.\n행사 시간을 피해 실행하고, 확인했다면 --yes 를 붙여 다시 실행하세요.`);
    process.exitCode = 2; return;
  }
  const rpc = rpcClient(args.url), funder = addressOf(key), startedAt = new Date().toISOString();
  const chainId = BigInt(await rpc.call('eth_chainId'));
  const head = await rpc.call('eth_getBlockByNumber', ['latest', false]);
  const blockGasLimit = Number(BigInt(head.gasLimit)), baseFee = BigInt(head.baseFeePerGas || '0x0');
  if (baseFee + args.priorityFee > args.maxFee) console.warn(`경고: base fee ${baseFee} + priority ${args.priorityFee} 가 상한 ${args.maxFee} wei 보다 큽니다. --max-fee-wei 를 올리세요.`);
  const fee = { maxFeePerGas:args.maxFee, maxPriorityFeePerGas:args.priorityFee };
  const plannedPayments = args.rates.reduce((sum, rate) => sum + Math.round(rate * args.stageSeconds), 0);
  const perWallet = Math.ceil(plannedPayments / args.wallets) + 2;
  const gasPerWallet = BigInt(perWallet) * TRANSFER_GAS * args.maxFee;
  const needWei = BigInt(args.wallets) * (gasPerWallet + TOPUP_GAS * args.maxFee) + 2_000_000n * args.maxFee;
  const funderWei = BigInt(await rpc.call('eth_getBalance', [funder, 'latest']));
  console.log('대상', JSON.stringify({ url:args.url, chainId:Number(chainId), funder, blockGasLimit, baseFeeWei:baseFee.toString(), wallets:args.wallets, plannedPayments, needWei:needWei.toString(), funderWei:funderWei.toString() }));
  if (funderWei < needWei) throw new Error(`테스트 지갑의 MST가 부족합니다: 필요 ${needWei} wei, 보유 ${funderWei} wei`);

  let nonce = BigInt(await rpc.call('eth_getTransactionCount', [funder, 'pending']));
  // A resend after a lost response is answered "already known"; the hash is the signed one either way.
  const sendRaw = async (tx, privateKey) => {
    const signed = sign1559({ chainId, ...fee, ...tx }, privateKey);
    try { return { hash:await rpc.call('eth_sendRawTransaction', [signed.raw]), signed }; }
    catch (error) { if (/already known|already imported|known transaction/i.test(error.message)) return { hash:signed.hash, signed }; throw error; }
  };

  // 1. Test token
  let token = args.token;
  if (!token) {
    const data = artifact.bytecode + pad(10n ** 12n);
    const gas = BigInt(Math.ceil(Number(BigInt(await rpc.call('eth_estimateGas', [{ from:funder, data }]))) * 1.2));
    const { hash } = await sendRaw({ nonce:nonce++, gas, to:null, data }, key);
    const receipt = (await waitReceipts(rpc, [hash])).get(hash);
    if (!receipt || receipt.status !== '0x1') throw new Error('테스트 토큰 배포 실패 ' + hash);
    token = receipt.contractAddress;
    console.log('테스트 토큰 배포', token);
  }
  const store = (args.store || addressOf(randomPrivateKey())).toLowerCase();

  // 2. Top-up burst from one key
  const wallets = Array.from({ length:args.wallets }, () => { const privateKey = randomPrivateKey(); return { privateKey, address:addressOf(privateKey), nonce:0n, busy:false }; });
  const keyFile = path.resolve(__dirname, `../measurements/load-test-wallets-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(keyFile), { recursive:true });
  fs.writeFileSync(keyFile, JSON.stringify({ url:args.url, chainId:Number(chainId), token, funder, wallets:wallets.map(({ privateKey, address }) => ({ address, privateKey })) }, null, 2) + '\n', { mode:0o600 });
  const watchStart = Number(BigInt(await rpc.call('eth_blockNumber')));
  const watcher = blockWatcher(rpc, watchStart);
  const topUpStarted = performance.now(), topUps = [];
  for (const wallet of wallets) {
    const sentAt = performance.now();
    try {
      const { hash } = await sendRaw({ nonce:nonce++, gas:TOPUP_GAS, to:token, value:gasPerWallet, data:TOKEN.selectors.transferWithGas + pad(wallet.address) + pad(perWallet * 10) }, key);
      topUps.push({ hash:hash.toLowerCase(), sentAt });
    } catch (error) { topUps.push({ error:error.message, sentAt }); if (error.rpcCode != null) nonce--; }
  }
  const topUpReceipts = await waitReceipts(rpc, topUps.filter(item => item.hash).map(item => item.hash));
  const topUpLatency = topUps.filter(item => watcher.seen.has(item.hash)).map(item => watcher.seen.get(item.hash).at - item.sentAt).sort((a, b) => a - b);
  const topUpSummary = {
    sent:topUps.length, accepted:topUps.filter(item => item.hash).length, succeeded:[...topUpReceipts.values()].filter(receipt => receipt.status === '0x1').length,
    burstSubmitMs:Math.round(topUps.at(-1).sentAt - topUpStarted), inclusionP50Ms:Math.round(percentile(topUpLatency, .5)), inclusionMaxMs:Math.round(topUpLatency.at(-1) ?? 0),
    errors:[...new Set(topUps.filter(item => item.error).map(item => item.error))].slice(0, 5)
  };
  console.log('충전 연속 전송', JSON.stringify(topUpSummary));
  const funded = wallets.filter((wallet, index) => topUpReceipts.get(topUps[index]?.hash)?.status === '0x1');
  if (!funded.length) throw new Error('충전된 지갑이 없습니다.');

  // 3. Payment stages
  const stages = [];
  for (const rate of args.rates) {
    const count = Math.round(rate * args.stageSeconds), records = [], started = performance.now(), inFlight = [];
    let waiting = [];
    let cursor = 0, noWallet = 0;
    for (let i = 0; i < count; i++) {
      const wait = started + (i / rate) * 1000 - performance.now();
      if (wait > 0) await sleep(wait);
      let wallet = null;
      for (let tries = 0; tries < funded.length && !wallet; tries++) { const candidate = funded[cursor++ % funded.length]; if (!candidate.busy) wallet = candidate; }
      if (!wallet) { noWallet++; continue; }
      wallet.busy = true;
      const record = { sentAt:performance.now() };
      records.push(record);
      inFlight.push(sendRaw({ nonce:wallet.nonce, gas:TRANSFER_GAS, to:token, data:TOKEN.selectors.transfer + pad(store) + pad(1) }, wallet.privateKey)
        .then(({ hash }) => { record.hash = hash.toLowerCase(); record.acceptedMs = performance.now() - record.sentAt; wallet.nonce++; })
        .catch(error => { record.error = error.message.slice(0, 120); })
        .finally(() => { if (record.error) wallet.busy = false; else waiting.push({ record, wallet }); }));
      // Free a wallet once its payment is in a block, as a customer would wait for the receipt.
      waiting = waiting.filter(({ record, wallet }) => watcher.seen.has(record.hash) ? (wallet.busy = false) : true);
    }
    await Promise.all(inFlight);
    const deadline = performance.now() + args.drainSeconds * 1000;
    while (performance.now() < deadline && records.some(item => item.hash && !watcher.seen.has(item.hash))) await sleep(250);
    for (const { wallet } of waiting) wallet.busy = false;
    const accepted = records.filter(item => item.hash), included = accepted.filter(item => watcher.seen.has(item.hash));
    const latencies = included.map(item => watcher.seen.get(item.hash).at - item.sentAt).sort((a, b) => a - b);
    const submitMs = accepted.map(item => item.acceptedMs).sort((a, b) => a - b);
    const blockNumbers = new Set(included.map(item => watcher.seen.get(item.hash).block));
    const spanBlocks = watcher.blocks.filter(block => blockNumbers.has(block.number));
    const lastSeen = included.length ? Math.max(...included.map(item => watcher.seen.get(item.hash).at)) : started;
    const errors = {};
    for (const item of records) if (item.error) errors[item.error] = (errors[item.error] || 0) + 1;
    const stage = {
      targetTps:rate, submitted:records.length, skippedNoFreeWallet:noWallet, accepted:accepted.length, included:included.length,
      includedTps:Math.round(included.length / Math.max(args.stageSeconds, (lastSeen - started) / 1000) * 100) / 100,
      submitP95Ms:Math.round(percentile(submitMs, .95) ?? 0),
      inclusionP50Ms:latencies.length ? Math.round(percentile(latencies, .5)) : null, inclusionP95Ms:latencies.length ? Math.round(percentile(latencies, .95)) : null, inclusionMaxMs:latencies.length ? Math.round(latencies.at(-1)) : null,
      maxTxPerBlock:Math.max(0, ...spanBlocks.map(block => block.txs)), maxBlockGasUsedPct:Math.round(Math.max(0, ...spanBlocks.map(block => block.gasUsed / block.gasLimit)) * 1000) / 10,
      errors
    };
    stage.passed = stagePassed(stage, args);
    stages.push(stage);
    console.log(`${String(rate).padStart(4)} tx/s 목표 → 포함 ${stage.includedTps} tx/s (${stage.included}/${stage.submitted}), 블록 포함까지 p50 ${stage.inclusionP50Ms}ms p95 ${stage.inclusionP95Ms}ms 최대 ${stage.inclusionMaxMs}ms, 블록당 최대 ${stage.maxTxPerBlock}건 (gas ${stage.maxBlockGasUsedPct}%)` + (noWallet ? `, 지갑 부족으로 건너뜀 ${noWallet}` : '') + (Object.keys(errors).length ? ' ' + JSON.stringify(errors) : ''));
    if (!stage.passed) { console.log('기준을 넘어 이 단계에서 멈춥니다.'); break; }
  }
  await watcher.stop();
  // Every included payment must also have succeeded (status 1).
  const sample = stages.length ? [...watcher.seen.keys()].slice(-200) : [];
  const receipts = await waitReceipts(rpc, sample, 30000);
  const failedReceipts = [...receipts.values()].filter(receipt => receipt.status !== '0x1').length;
  const blockTimes = watcher.blocks.slice(1).map((block, index) => block.timestamp - watcher.blocks[index].timestamp);
  const avgBlockSeconds = blockTimes.length ? blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length : null;
  const best = [...stages].reverse().find(stage => stage.passed) || null;
  const result = {
    url:args.url, chainId:Number(chainId), token, store, funder, startedAt, finishedAt:new Date().toISOString(),
    chain:{ blockGasLimit, avgBlockSeconds, theoreticalTransfersPerSecond:avgBlockSeconds ? Math.floor(blockGasLimit / 51240) / avgBlockSeconds : null },
    thresholds:{ maxP95Ms:args.maxP95Ms, minIncluded:args.minIncluded }, topUpBurst:topUpSummary, stages,
    sustainableTps:best?.includedTps ?? null, receiptsChecked:receipts.size, failedReceipts, walletKeys:keyFile
  };
  const output = path.resolve(args.output || path.join(__dirname, '../measurements/load-test-tx.json'));
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log('결과', JSON.stringify({ chain:result.chain, sustainableTps:result.sustainableTps, failedReceipts }, null, 2));
  console.log('저장', output);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { parseArgs, stagePassed, TRANSFER_GAS, TOPUP_GAS };
