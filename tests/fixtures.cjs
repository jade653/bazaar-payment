'use strict';
// Shared wMST test configuration: the real TOKEN shape with a deployed address.
const { TOKEN } = require('../wallet.js');
const TEST_TOKEN = Object.freeze({ ...TOKEN, address:'0x' + 'c'.repeat(40), deployBlock:0 });
const topicOf = account => '0x' + account.slice(2).toLowerCase().padStart(64, '0');
const hex = value => '0x' + BigInt(value).toString(16);
// A Transfer log as returned by eth_getLogs / receipts.
function transferLog({ from, to, value, blockNumber = '0x1', hash = '0x' + 'a'.repeat(64), logIndex = '0x0', address = TEST_TOKEN.address, removed = false }) {
  return { address, topics:[TEST_TOKEN.transferTopic, topicOf(from), topicOf(to)], data:'0x' + BigInt(value).toString(16).padStart(64, '0'), blockNumber, transactionHash:hash, logIndex, removed };
}
module.exports = { TEST_TOKEN, topicOf, hex, transferLog };
