(function () {
  'use strict';
  // Operator-only page: deploy the wMST contract from the MetaMask treasury wallet and measure
  // what MetaMask really charges and reserves for wMST transfers. Its output is the TOKEN config
  // for wallet.js and a JSON record for measurements/wmst-gas.json. No private keys are handled.
  const screen = document.getElementById('setupScreen');
  if (!screen) return;
  const Wallet = window.BazaarWallet, Transfer = window.BazaarTransfer, UI = window.BazaarUI, artifact = window.WMST_ARTIFACT;
  const params = new URL(location.href).searchParams, preview = params.has('preview');
  const diagnostics = preview ? null : Wallet.diagnosticsFor?.(window);
  const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
  const policy = Wallet.TOKEN.gasPolicy, chainId = Wallet.NETWORK.chainId;
  const hex = value => '0x' + BigInt(value).toString(16);
  const big = (value, fallback = null) => { try { return value == null ? fallback : BigInt(value); } catch { return fallback; } };
  const esc = UI.esc;
  let session; try { session = window.sessionStorage; } catch {}
  const STORAGE_KEY = 'bazaar-setup-token-v1';
  let saved = null; try { saved = JSON.parse(session?.getItem(STORAGE_KEY) || 'null'); } catch {}
  if (!saved || !ADDRESS.test(saved.address || '')) saved = null;
  let state = { account:null, gasWei:null, walletMessage:'지갑 연결 상태를 확인하고 있어요.', walletBlocked:false, needsApp:false,
    busy:false, step:'', progress:'', error:'', supply:'1000000000', tokenInput:saved?.address || '', testWallet:'',
    deployed:saved, measurement:null };
  let discovery, controller, provider, disposed = false;
  const log = (stage, error, hash) => diagnostics?.record({ stage, error, hash, chainId:controller?.getSnapshot?.().chainId });
  const steps = [
    { kind:'transfer-fresh', label:'새 지갑으로 wMST 전송 (최악 조건)' },
    { kind:'transfer-existing', label:'기존 지갑으로 wMST 전송' },
    { kind:'topup', label:'충전 (wMST + 수수료 동시 전송)' }
  ];
  function mstText(wei) {
    if (wei == null) return '—';
    const value = BigInt(wei), whole = value / 10n ** 18n;
    const digits = (value % 10n ** 18n).toString().padStart(18, '0');
    const match = digits.match(/^(0*)(\d*)$/), fraction = (match[1] + match[2].slice(0, 6)).replace(/0+$/, '');
    return whole.toLocaleString('ko-KR') + (fraction ? '.' + fraction : '') + ' MST';
  }
  const number = value => value == null ? '—' : BigInt(value).toLocaleString('ko-KR');
  function randomAddress() {
    const bytes = new Uint8Array(20);
    (window.crypto || globalThis.crypto).getRandomValues(bytes);
    return '0x' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function describe(error) {
    const code = Wallet.errorCode?.(error) ?? error?.code;
    const known = { 4001:'요청이 취소됐어요. 준비되면 다시 눌러주세요.', '-32002':'MetaMask에 대기 중인 요청을 먼저 처리해 주세요.', READ_TIMEOUT:'지갑 응답이 지연되고 있어요. 진단 기록을 확인해 주세요.',
      INVALID_TX_HASH:'거래 접수 결과를 받지 못했어요.', TRANSACTION_FAILED:'거래가 체인에서 실패했어요. 잔액과 주소를 확인해 주세요.', RECEIPT_TIMEOUT:'거래 확인이 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
      INVALID_RECEIPT:'거래 결과를 읽지 못했어요.', WRONG_CHAIN:'Mustree 네트워크로 다시 연결해 주세요.', ACCOUNT_CHANGED:'지갑 계정이 바뀌었어요. 다시 확인해 주세요.',
      INVALID_SUPPLY:'발행량은 1 이상의 정수로 입력해 주세요.', INVALID_TOKEN:'측정할 wMST 컨트랙트 주소를 확인해 주세요.', INVALID_TEST_WALLET:'테스트 수신 지갑 주소를 확인해 주세요.',
      NO_CONTRACT:'배포 결과에 컨트랙트 주소가 없어요. 진단 기록을 확인해 주세요.', SUPPLY_MISMATCH:'배포된 컨트랙트의 총 발행량이 입력값과 달라요.', NO_TX:'전송된 거래 정보를 읽지 못했어요.' };
    return known[code] || '처리하지 못했어요. 진단 기록을 확인해 주세요.';
  }
  const failure = code => Object.assign(new Error(code), { code });
  async function read(method, params, timeout = 12000) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => provider.request({ method, ...(params ? { params } : {}) })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(failure('READ_TIMEOUT')), timeout); })
      ]);
    } finally { clearTimeout(timer); }
  }
  const rpc = { request:request => read(request.method, request.params) };
  async function sendAndWait(transaction, stage) {
    log(stage + ':send');
    const hash = await provider.request({ method:'eth_sendTransaction', params:[{ ...transaction, maxFeePerGas:hex(policy.maxFeePerGasWei), maxPriorityFeePerGas:hex(policy.maxPriorityFeePerGasWei), chainId }] });
    if (!HASH.test(hash || '')) throw failure('INVALID_TX_HASH');
    log(stage + ':hash', null, hash);
    set({ progress:state.progress + ' 거래를 보냈어요. 확인 중…' });
    const receipt = await Transfer.waitForReceipt(rpc, hash);
    log(stage + ':confirmed', null, hash);
    return { hash, receipt };
  }
  function render() {
    if (disposed) return;
    const deployed = state.deployed, measurement = state.measurement;
    const wallet = `<div class="setup-step"><h2>1. 운영 지갑 연결</h2><p>발행과 측정은 연결한 MetaMask 지갑(운영 지갑)이 서명합니다. 비밀키는 이 페이지에서 다루지 않아요.</p>${state.account ? `<div class="setup-facts"><div><span>지갑</span><strong>${esc(state.account)}</strong></div><div><span>MST 잔액(수수료용)</span><strong>${mstText(state.gasWei)}</strong></div></div>` : UI.alert(state.walletMessage)}${state.needsApp ? `<a class="operator-primary app-handoff" href="${esc(Transfer.appLink('/setup.html'))}">MetaMask 앱에서 열기</a>` : !state.account || state.walletBlocked ? UI.button('지갑 연결', 'connect', { disabled:state.busy }) : ''}</div>`;
    const deploy = `<div class="setup-step"><h2>2. wMST 발행</h2><p>고정 발행량 전체를 운영 지갑으로 한 번에 발행합니다(추가 발행 없음, 1 wMST = 1원, 소수점 없음). 이미 발행했다면 이 단계는 건너뛰세요.</p><label for="setupSupply">발행량 (wMST)</label><input id="setupSupply" type="text" inputmode="numeric" value="${esc(state.supply)}" autocomplete="off">${deployed ? `<div class="setup-facts"><div><span>컨트랙트 주소</span><strong>${esc(deployed.address)}</strong></div><div><span>배포 블록</span><strong>${number(deployed.deployBlock)}</strong></div><div><span>발행량</span><strong>${number(deployed.supply)} wMST</strong></div>${deployed.gasUsed ? `<div><span>배포 가스 · 비용</span><strong>${number(deployed.gasUsed)} · ${mstText(BigInt(deployed.gasUsed) * BigInt(deployed.effectiveGasPriceWei || 0))}</strong></div>` : ''}</div>` : ''}${state.step === 'deploy' ? `<div class="setup-progress"><span class="operator-spinner"></span><span>${esc(state.progress)}</span></div>` : ''}${UI.button(deployed ? '다시 발행하기' : '발행하기', 'deploy', { disabled:state.busy || !state.account })}</div>`;
    const measure = `<div class="setup-step"><h2>3. 수수료 측정</h2><p>MetaMask가 실제로 보낸 거래 3건의 영수증으로 전송 1회당 지갑이 확보해야 하는 MST와 실제 비용을 측정합니다. 충전 시 손님에게 주는 수수료는 전송 ${policy.transfersPerTopUp}회분으로 계산합니다.</p><label for="setupToken">측정할 wMST 컨트랙트 주소</label><input id="setupToken" type="text" value="${esc(state.tokenInput)}" placeholder="0x 컨트랙트 주소" autocomplete="off"><label for="setupTestWallet">테스트 수신 지갑 (선택)</label><input id="setupTestWallet" type="text" value="${esc(state.testWallet)}" placeholder="비우면 임의의 새 주소를 사용" autocomplete="off"><div class="setup-note">측정 중 wMST 3개와 소량의 MST를 테스트 지갑으로 보냅니다. 비워 두면 임의의 새 주소로 보내며 되돌릴 수 없어요. 운영자의 두 번째 지갑 주소를 넣으면 그 지갑에서 그대로 확인할 수 있어요.</div>${state.step === 'measure' ? `<div class="setup-progress"><span class="operator-spinner"></span><span>${esc(state.progress)}</span></div>` : ''}${UI.button(measurement ? '다시 측정하기' : '측정 시작', 'measure', { disabled:state.busy || !state.account })}</div>`;
    let result = '';
    if (measurement) {
      const rows = measurement.transactions.map(tx => `<tr><td>${esc(tx.label)}</td><td>${number(tx.gasUsed)}</td><td>${number(tx.gasLimit)}</td><td>${number(tx.maxFeePerGasWei)} wei</td><td>${mstText(tx.costWei)}</td></tr>`).join('');
      const derived = measurement.derived;
      result = `<div class="setup-step"><h2>4. 결과</h2><table class="setup-table"><thead><tr><th>거래</th><th>사용 가스</th><th>가스 한도</th><th>최대 수수료</th><th>실제 비용</th></tr></thead><tbody>${rows}</tbody></table><div class="setup-facts"><div><span>전송 1회 확보 금액</span><strong>${mstText(derived.transferReserveWei)}</strong></div><div><span>충전 1회 운영 지갑 확보 금액</span><strong>${mstText(derived.topUpReserveWei)}</strong></div><div><span>충전 시 손님에게 주는 수수료 (${policy.transfersPerTopUp}회분)</span><strong>${mstText(derived.gasSupportWei)}</strong></div><div><span>전송 1회 실제 비용</span><strong>${mstText(derived.actualTransferCostWei)}</strong></div><div><span>충전 1회 실제 비용 (수수료 지급 제외)</span><strong>${mstText(derived.actualTopUpCostWei)}</strong></div><div><span>현재 운영 지갑 MST로 가능한 충전</span><strong>${derived.topUpsAffordable == null ? '—' : '약 ' + Number(derived.topUpsAffordable).toLocaleString('ko-KR') + '회'}</strong></div></div><p class="setup-done">wallet.js의 TOKEN에 붙여넣고 커밋·배포하세요.</p>${!measurement.deployBlock ? '<div class="setup-note">직접 입력한 주소라 배포 블록 번호를 모릅니다. 배포 당시 블록 번호를 deployBlock에 넣어주세요(0이면 전체 블록을 조회합니다).</div>' : ''}<label>wallet.js TOKEN 설정</label><textarea id="setupConfig" readonly aria-label="TOKEN 설정">${esc(measurement.snippet)}</textarea>${UI.button('설정 복사', 'copy-config', { secondary:true })}<label>measurements/wmst-gas.json</label><textarea id="setupJson" readonly aria-label="측정 기록 JSON">${esc(measurement.json)}</textarea>${UI.button('기록 복사', 'copy-json', { secondary:true })}</div>`;
    }
    screen.innerHTML = `<div class="operator-title"><span>SETUP</span><h1>wMST 발행과<br>수수료 측정</h1></div>${preview ? UI.alert('미리보기에서는 실제 거래를 보내지 않아요.') : ''}${UI.alert(state.error)}${wallet}${deploy}${measure}${result}`;
    const balanceText = document.getElementById('balanceText'), balanceButton = document.getElementById('balanceButton');
    if (balanceText) balanceText.textContent = mstText(state.gasWei);
    if (balanceButton) balanceButton.hidden = !state.account;
  }
  function set(next) { state = { ...state, ...next }; render(); }
  function onWallet(snapshot) {
    if (snapshot.status === 'ready') { set({ walletBlocked:false, needsApp:false, account:snapshot.account, gasWei:snapshot.gasWei, walletMessage:'' }); return; }
    const message = snapshot.status === 'cancelled' ? '연결이 취소됐어요. 지갑 연결을 다시 눌러주세요.'
      : snapshot.status === 'pending' ? 'MetaMask의 기존 승인 요청을 확인한 뒤 지갑 연결을 눌러주세요.'
      : ['connecting','adding','switching'].includes(snapshot.status) ? 'MetaMask에서 확인을 눌러주세요.'
      : snapshot.status === 'querying' ? '잔액을 확인하고 있어요.'
      : snapshot.status === 'unavailable' ? 'MetaMask 앱에서 열어주세요.' : '운영 지갑을 연결해 주세요.';
    set({ walletBlocked:['pending','cancelled','needs-network','error','disconnected'].includes(snapshot.status), needsApp:snapshot.status === 'unavailable', account:null, gasWei:null, walletMessage:message });
  }
  async function ensureWallet() {
    provider ||= await discovery.getProvider();
    if (!provider) { location.assign(Transfer.appLink('/setup.html')); return false; }
    await controller.setup();
    if (!state.account) return false;
    provider = await discovery.getProvider();
    return true;
  }
  async function connect() {
    if (preview) return;
    try { await ensureWallet(); } catch (error) { set({ error:describe(error) }); }
  }
  async function deploy() {
    if (state.busy) return;
    if (preview) { set({ error:'미리보기에서는 발행하지 않아요.' }); return; }
    set({ busy:true, step:'deploy', error:'', progress:'지갑을 확인하고 있어요.' });
    try {
      const supplyText = String(state.supply || '').replace(/[\s,]/g, '');
      if (!/^\d+$/.test(supplyText) || BigInt(supplyText) <= 0n) throw failure('INVALID_SUPPLY');
      const supply = BigInt(supplyText);
      if (!(await ensureWallet())) return;
      controller.pauseAutoPrompts?.(true);
      set({ progress:'MetaMask에서 배포 거래를 확인해 주세요.' });
      const { hash, receipt } = await sendAndWait({ from:state.account, data:artifact.bytecode + Transfer.abi.word(supply), value:'0x0' }, 'deploy');
      if (!ADDRESS.test(receipt.contractAddress || '')) throw failure('NO_CONTRACT');
      set({ progress:'발행량을 확인하고 있어요.' });
      const total = await read('eth_call', [{ to:receipt.contractAddress, data:Wallet.TOKEN.selectors.totalSupply }, 'latest']);
      if (big(total) !== supply) throw failure('SUPPLY_MISMATCH');
      const deployed = { address:receipt.contractAddress, deployBlock:Number(BigInt(receipt.blockNumber)), supply:supply.toString(), hash, gasUsed:big(receipt.gasUsed, 0n).toString(), effectiveGasPriceWei:big(receipt.effectiveGasPrice, 0n).toString() };
      try { session?.setItem(STORAGE_KEY, JSON.stringify(deployed)); } catch {}
      set({ deployed, tokenInput:deployed.address, measurement:null, progress:'' });
      void controller.refresh();
    } catch (error) { log('deploy:failure', error); set({ error:describe(error) }); }
    finally { controller?.pauseAutoPrompts?.(false); set({ busy:false, step:'', progress:'' }); }
  }
  function derive(transactions, gasWei) {
    const transfers = transactions.filter(tx => tx.kind !== 'topup'), topUp = transactions.find(tx => tx.kind === 'topup');
    const max = values => values.reduce((best, value) => value > best ? value : best, 0n);
    const transferReserveWei = max(transfers.map(tx => tx.reserveWei));
    const topUpReserveWei = topUp ? topUp.reserveWei : 0n;
    const gasSupportWei = transferReserveWei * BigInt(policy.transfersPerTopUp);
    const topUpCostWei = gasSupportWei + topUpReserveWei;
    return {
      maxFeePerGasWei:max(transactions.map(tx => tx.maxFeePerGasWei)), maxPriorityFeePerGasWei:max(transactions.map(tx => tx.maxPriorityFeePerGasWei)),
      transfersPerTopUp:policy.transfersPerTopUp, transferReserveWei, topUpReserveWei, gasSupportWei,
      actualTransferCostWei:max(transfers.map(tx => tx.costWei)), actualTopUpCostWei:topUp ? topUp.costWei : 0n,
      topUpsAffordable:gasWei == null || topUpCostWei === 0n ? null : (BigInt(gasWei) / topUpCostWei).toString()
    };
  }
  function snippetFor(address, deployBlock, derived) {
    return `address: '${address}',\ndeployBlock: ${deployBlock || 0},\ngasPolicy: Object.freeze({\n  maxFeePerGasWei: '${derived.maxFeePerGasWei}',\n  maxPriorityFeePerGasWei: '${derived.maxPriorityFeePerGasWei}',\n  transfersPerTopUp: ${derived.transfersPerTopUp},\n  transferReserveWei: '${derived.transferReserveWei}',\n  topUpReserveWei: '${derived.topUpReserveWei}'\n})`;
  }
  async function measure() {
    if (state.busy) return;
    if (preview) { set({ error:'미리보기에서는 측정하지 않아요.' }); return; }
    set({ busy:true, step:'measure', error:'', progress:'지갑을 확인하고 있어요.' });
    try {
      const tokenAddress = String(state.tokenInput || '').trim();
      if (!ADDRESS.test(tokenAddress)) throw failure('INVALID_TOKEN');
      const typed = String(state.testWallet || '').trim();
      if (typed && !ADDRESS.test(typed)) throw failure('INVALID_TEST_WALLET');
      if (!(await ensureWallet())) return;
      controller.pauseAutoPrompts?.(true);
      const token = { ...Wallet.TOKEN, address:tokenAddress };
      const testWallet = typed || randomAddress(), topUpWallet = randomAddress();
      const supportWei = Transfer.gasSupportWei(Wallet.TOKEN);
      const plan = [
        { ...steps[0], to:testWallet, data:Transfer.abi.transfer(token, testWallet, 1n), value:'0x0' },
        { ...steps[1], to:testWallet, data:Transfer.abi.transfer(token, testWallet, 1n), value:'0x0' },
        { ...steps[2], to:topUpWallet, data:Transfer.abi.transferWithGas(token, topUpWallet, 1n), value:hex(supportWei) }
      ];
      const transactions = [];
      for (let index = 0; index < plan.length; index++) {
        const item = plan[index];
        set({ progress:`${index + 1}/${plan.length} ${item.label} — MetaMask에서 확인해 주세요.` });
        const { hash, receipt } = await sendAndWait({ from:state.account, to:tokenAddress, data:item.data, value:item.value }, 'measure:' + item.kind);
        const tx = await read('eth_getTransactionByHash', [hash]);
        if (!tx || tx.gas == null) throw failure('NO_TX');
        const gasUsed = big(receipt.gasUsed, 0n), gasLimit = big(tx.gas, 0n);
        const maxFeePerGasWei = big(tx.maxFeePerGas) ?? big(tx.gasPrice, 0n);
        const maxPriorityFeePerGasWei = big(tx.maxPriorityFeePerGas) ?? big(tx.gasPrice, 0n);
        const effectiveGasPriceWei = big(receipt.effectiveGasPrice) ?? big(tx.gasPrice, 0n);
        transactions.push({ kind:item.kind, label:item.label, hash, to:item.to, valueWei:BigInt(item.value), gasUsed, gasLimit, maxFeePerGasWei, maxPriorityFeePerGasWei, effectiveGasPriceWei, reserveWei:gasLimit * maxFeePerGasWei, costWei:gasUsed * effectiveGasPriceWei });
      }
      set({ progress:'체인 수수료 정보를 읽고 있어요.' });
      let gasPriceWei = null, priorityWei = null;
      try { gasPriceWei = big(await read('eth_gasPrice')); } catch (error) { log('measure:gasPrice:failure', error); }
      try { priorityWei = big(await read('eth_maxPriorityFeePerGas')); } catch (error) { log('measure:priority:failure', error); }
      let gasWei = state.gasWei;
      try { gasWei = big(await read('eth_getBalance', [state.account, 'latest']), null)?.toString() ?? gasWei; } catch (error) { log('measure:balance:failure', error); }
      const derived = derive(transactions, gasWei);
      const deployBlock = state.deployed?.address?.toLowerCase() === tokenAddress.toLowerCase() ? state.deployed.deployBlock : 0;
      const record = { measuredAt:new Date().toISOString(), chainId, token:tokenAddress, deployBlock, method:'Receipts of transactions sent by MetaMask from setup.html',
        chain:{ gasPriceWei:gasPriceWei?.toString() ?? null, maxPriorityFeePerGasWei:priorityWei?.toString() ?? null }, transactions, derived };
      const json = JSON.stringify(record, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2);
      set({ measurement:{ transactions, derived, deployBlock, snippet:snippetFor(tokenAddress, deployBlock, derived), json }, gasWei, progress:'' });
    } catch (error) { log('measure:failure', error); set({ error:describe(error) }); }
    finally { controller?.pauseAutoPrompts?.(false); set({ busy:false, step:'', progress:'' }); }
  }
  async function copy(id, button) {
    const field = document.getElementById(id);
    if (!field) return;
    try { await window.navigator.clipboard.writeText(field.value); button.textContent = '복사했어요'; }
    catch { field.focus?.(); field.select?.(); button.textContent = '아래 내용을 길게 눌러 복사해 주세요'; }
  }
  function click(event) {
    const target = event.target.closest('[data-transfer]');
    if (!target || target.disabled) return;
    switch (target.dataset.transfer) {
      case 'connect': void connect(); break;
      case 'deploy': void deploy(); break;
      case 'measure': void measure(); break;
      case 'copy-config': void copy('setupConfig', target); break;
      case 'copy-json': void copy('setupJson', target); break;
    }
  }
  function input(event) {
    if (event.target.id === 'setupSupply') state.supply = event.target.value;
    else if (event.target.id === 'setupToken') state.tokenInput = event.target.value;
    else if (event.target.id === 'setupTestWallet') state.testWallet = event.target.value;
  }
  screen.addEventListener('click', click); screen.addEventListener('input', input);
  if (!preview) {
    discovery = Wallet.discover(window);
    controller = Wallet.createWallet({ lifecycle:window, getProvider:() => discovery.getProvider(), onState:onWallet, token:null });
    void controller.restore();
  }
  document.getElementById('balanceButton')?.addEventListener('click', () => { if (!preview && !state.busy) void controller.refresh(); });
  window.addEventListener('pagehide', event => { if (!event.persisted) { disposed = true; controller?.dispose(); discovery?.dispose(); } });
  render();
})();
