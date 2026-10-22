'use strict';

// Key-free gas estimate for the wMST contract against the live RPC, using Geth
// state overrides: the compiled runtime code is placed at a scratch address and
// a balance slot is filled, so eth_estimateGas can run real transfers without
// deploying anything or spending MST. The authoritative numbers come from
// setup.html after deployment (receipts of MetaMask-sent transactions); this
// script only sizes the initial configuration and documents the derivation.
// Usage: node tools/estimate-wmst-gas.cjs
const fs = require('node:fs');
const path = require('node:path');
const { keccak256 } = require('./keccak.cjs');
const { NETWORK, TOKEN } = require('../wallet.js');
const artifact = require('../contracts/wMST.artifact.json');

const pad = value => BigInt(value).toString(16).padStart(64, '0');
const selector = name => '0x' + artifact.methodIdentifiers[name];
const CONTRACT = '0x00000000000000000000000000000000000c0ffe';
const OPERATOR = '0x00000000000000000000000000000000000a11ce';
const FRESH = '0x00000000000000000000000000000000000b0b01';
const EXISTING = '0x00000000000000000000000000000000000b0b02';
const slot = account => keccak256('0x' + pad(account) + pad(0)); // balanceOf is storage slot 0
const overrides = {
  [CONTRACT]: { code: artifact.deployedBytecode, stateDiff: { [slot(OPERATOR)]: '0x' + pad(1_000_000_000n), [slot(EXISTING)]: '0x' + pad(5n) } },
  [OPERATOR]: { balance: '0x' + (10n ** 18n).toString(16) },
  [EXISTING]: { balance: '0x' + (10n ** 15n).toString(16) }
};
let id = 1;
async function rpc(method, params) {
  const response = await fetch(NETWORK.rpcUrls[0], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }), signal: AbortSignal.timeout(20000) });
  const body = await response.json();
  if (body.error) throw new Error(method + ': ' + body.error.message);
  return body.result;
}
const estimate = (tx, withOverrides = true) => rpc('eth_estimateGas', withOverrides ? [tx, 'latest', overrides] : [tx]).then(hex => Number(BigInt(hex)));
async function main() {
  const gasPrice = BigInt(await rpc('eth_gasPrice', []));
  const priority = BigInt(await rpc('eth_maxPriorityFeePerGas', []));
  const baseFee = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
  const deployData = artifact.bytecode + pad(1_000_000_000n);
  const gas = {
    deploy: await estimate({ from: OPERATOR, data: deployData }, false),
    transferToFreshWallet: await estimate({ from: OPERATOR, to: CONTRACT, data: selector('transfer(address,uint256)') + pad(FRESH) + pad(1000) }),
    transferToExistingWallet: await estimate({ from: OPERATOR, to: CONTRACT, data: selector('transfer(address,uint256)') + pad(EXISTING) + pad(1000) }),
    transferWithGasToFreshWallet: await estimate({ from: OPERATOR, to: CONTRACT, value: '0x' + (10n ** 12n).toString(16), data: selector('transferWithGas(address,uint256)') + pad(FRESH) + pad(1000) }),
    transferWithGasToExistingWallet: await estimate({ from: OPERATOR, to: CONTRACT, value: '0x' + (10n ** 12n).toString(16), data: selector('transferWithGas(address,uint256)') + pad(EXISTING) + pad(1000) })
  };
  const policy = TOKEN.gasPolicy;
  const worstTransfer = Math.max(gas.transferToFreshWallet, gas.transferToExistingWallet);
  // MetaMask reserves gasLimit x maxFeePerGas before it lets a transfer through, and
  // pads contract calls by about 1.5x, so the allowance is sized on that reserve.
  const maxFee = BigInt(policy.maxFeePerGasWei);
  const worstTopUp = Math.max(gas.transferWithGasToFreshWallet, gas.transferWithGasToExistingWallet);
  const transferReserveWei = BigInt(Math.ceil(worstTransfer * 1.5)) * maxFee;
  const topUpReserveWei = BigInt(Math.ceil(worstTopUp * 1.5)) * maxFee;
  const gasSupportWei = transferReserveWei * BigInt(policy.transfersPerTopUp);
  const result = {
    measuredAt: new Date().toISOString(), rpcUrl: NETWORK.rpcUrls[0], method: 'eth_estimateGas with state overrides (no deployment, no key)',
    chain: { gasPriceWei: gasPrice.toString(), maxPriorityFeePerGasWei: priority.toString(), baseFeePerGasWei: baseFee.toString() },
    gas,
    policy: { maxFeePerGasWei: policy.maxFeePerGasWei, maxPriorityFeePerGasWei: policy.maxPriorityFeePerGasWei, transfersPerTopUp: policy.transfersPerTopUp },
    derivation: {
      worstTransferGas: worstTransfer, worstTopUpGas: worstTopUp, walletGasPadding: 1.5,
      transferReserveWei: transferReserveWei.toString(), topUpReserveWei: topUpReserveWei.toString(), gasSupportWei: gasSupportWei.toString(),
      deployCostWei: (BigInt(gas.deploy) * (baseFee + priority)).toString(),
      actualTransferCostWei: (BigInt(worstTransfer) * (baseFee + priority)).toString()
    },
    configured: { transferReserveWei: policy.transferReserveWei, topUpReserveWei: policy.topUpReserveWei }
  };
  const output = path.resolve(__dirname, '../measurements/wmst-gas-estimate.json');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
