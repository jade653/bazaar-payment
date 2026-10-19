(function () {
  'use strict';
  const Wallet = window.BazaarWallet;
  const Core = window.BazaarOperator;
  const screen = document.getElementById('operatorScreen');
  const balanceButton = document.getElementById('balanceButton');
  const balanceText = document.getElementById('balanceText');
  const scanner = document.getElementById('scanner');
  const video = document.getElementById('scannerVideo');
  const canvas = document.getElementById('scannerCanvas');
  const scannerMessage = document.getElementById('scannerMessage');
  const preview = new URL(location.href).searchParams.get('preview') === '1';
  let discovery, controller, provider, sender, stream, frame;
  let state = { step: 'connect', account: null, balanceWei: null, recipient: null, won: '', status: '', tx: null, manualOpen: false, manualAddress: '' };

  const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const button = (label, action, className = 'operator-primary', disabled = false) => `<button class="${className}" type="button" data-action="${action}"${disabled ? ' disabled' : ''}>${label}</button>`;
  function formattedBalance() {
    if (state.balanceWei === null) return '— MST';
    const raw = Wallet.units(state.balanceWei);
    const [whole, decimal = ''] = raw.split('.');
    return `${Number(whole).toLocaleString('ko-KR')}${decimal ? '.' + decimal.slice(0, 2) : ''} MST`;
  }
  function errorText(code) {
    const messages = {
      INVALID_ADDRESS: '올바른 손님 QR이 아니에요.', INVALID_AMOUNT: '1,000원 단위로 입력해 주세요.',
      ACCOUNT_CHANGED: '지급 지갑이 바뀌었어요. 다시 연결해 주세요.', WRONG_CHAIN: 'Mustree 네트워크로 다시 연결해 주세요.',
      INSUFFICIENT_BALANCE: '수수료를 포함한 지급 잔액이 부족해요.', TRANSACTION_FAILED: '송금이 완료되지 않았어요.',
      RECEIPT_TIMEOUT: '처리가 길어지고 있어요. 같은 금액을 다시 보내지 말고 거래 내역을 확인해 주세요.'
    };
    return messages[code] || '처리하지 못했어요. 다시 확인해 주세요.';
  }
  function render() {
    balanceButton.hidden = !state.account;
    balanceText.textContent = formattedBalance();
    if (state.step === 'connect') {
      screen.innerHTML = `<div class="operator-hero"><span class="operator-kicker">STAFF ONLY</span><h1>MST를<br>지급해 주세요.</h1><p>지급용 MetaMask를 연결하면 바로 시작할 수 있어요.</p></div>${state.status ? `<p class="operator-alert">${state.status}</p>` : ''}${button('지급 지갑 연결하기', 'connect')}`;
      return;
    }
    if (state.step === 'amount') {
      let amount = null;
      try { amount = Core.amountFromWon(state.won); } catch {}
      const recipient = state.manualOpen
        ? `<div class="operator-recipient-entry"><small>받는 손님</small><div><input id="manualAddress" type="text" inputmode="text" value="${esc(state.manualAddress)}" placeholder="0x 지갑 주소 붙여넣기" autocomplete="off"><button type="button" data-action="manual">확인</button></div></div>`
        : state.recipient
        ? `<div><small>받는 손님</small><strong>${short(state.recipient)}</strong><code>${state.recipient}</code></div><button type="button" data-action="scan">변경</button>`
        : `<div><small>받는 손님</small><strong>손님 QR을 스캔해 주세요.</strong></div><button type="button" data-action="scan">QR 스캔하기</button>`;
      screen.innerHTML = `<div class="operator-title"><span>01</span><h1>받은 현금을<br>입력해 주세요.</h1></div><div class="recipient-card operator-recipient">${recipient}</div><div class="preset-grid">${[5000,10000,30000,50000].map(v => `<button type="button" data-won="${v}">${v.toLocaleString('ko-KR')}원</button>`).join('')}</div><label class="amount-input"><span>현금 금액</span><div><input id="wonInput" type="text" inputmode="numeric" value="${state.won}" placeholder="0"><b>원</b></div></label><div class="payout-total"><span>지급할 MST <small>10% 보너스 포함</small></span><strong>${amount ? amount.mstText : '0'} MST</strong></div>${state.status ? `<p class="operator-alert">${state.status}</p>` : ''}${button(!state.recipient ? '손님 QR을 스캔해 주세요' : amount ? `${amount.mstText} MST 지급하기` : '금액을 입력해 주세요', 'send', 'operator-primary', !state.recipient || !amount)}`;
      return;
    }
    if (state.step === 'sending') {
      screen.innerHTML = `<div class="operator-center"><span class="operator-spinner"></span><h1>${state.tx ? '송금 완료를 확인하고 있어요.' : 'MetaMask에서 확인을 눌러주세요.'}</h1><p>${state.status || (state.tx ? '이 화면을 닫거나 다시 송금하지 마세요.' : '받는 주소와 금액을 확인해 주세요.')}</p>${state.tx ? `<code>${state.tx}</code>` : ''}</div>${state.tx && state.status ? button('완료 다시 확인', 'check') : ''}`;
      return;
    }
    screen.innerHTML = `<div class="operator-success"><div class="success-mark">✓</div><span>지급 완료 · 10% 보너스 포함</span><h1>${Core.amountFromWon(state.won).mstText} MST</h1><p>${short(state.recipient)} 손님에게<br>MST를 지급했어요.</p><code>${state.tx}</code></div>${button('다음 손님', 'next')}`;
  }
  function setState(next) { state = { ...state, ...next }; render(); }
  function onWallet(snapshot) {
    if (snapshot.status === 'ready') {
      setState({ account: snapshot.account, balanceWei: snapshot.balanceWei, step: state.step === 'connect' ? 'amount' : state.step, status: '' });
      return;
    }
    if (['connecting', 'adding', 'switching', 'querying', 'pending'].includes(snapshot.status)) {
      setState({ status: snapshot.status === 'querying' ? '잔액을 확인하고 있어요.' : 'MetaMask에서 확인을 눌러주세요.' });
      return;
    }
    if (snapshot.status === 'unavailable') setState({ status: 'MetaMask 앱 안에서 이 페이지를 열어주세요.' });
    else if (snapshot.status === 'cancelled') setState({ status: '연결이 취소됐어요. 다시 눌러주세요.' });
    else if (snapshot.status !== 'idle') setState({ status: '지갑을 연결하지 못했어요. 다시 시도해 주세요.' });
  }
  async function connect() {
    if (preview) { setState({ step: 'amount', account: null, balanceWei: (500n * 10n ** 18n).toString(), status: '' }); return; }
    provider = await discovery.getProvider();
    if (!provider) {
      const destination = `${location.host}${location.pathname}`;
      location.assign(`https://link.metamask.io/dapp/${destination}`);
      return;
    }
    sender = Core.createSender({ provider, chainId: Wallet.NETWORK.chainId });
    await controller.setup();
  }
  function acceptAddress(raw) {
    const address = Core.parseAddress(raw);
    if (!address) { setState({ status: '올바른 손님 QR이 아니에요.' }); return false; }
    stopScanner();
    setState({ step: 'amount', recipient: address, status: '', manualOpen: false, manualAddress: '' });
    return true;
  }
  async function scanImage(source) {
    if (typeof jsQR !== 'function') throw new Error('QR_READER_MISSING');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = source.videoWidth || source.naturalWidth || source.width;
    canvas.height = source.videoHeight || source.naturalHeight || source.height;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
    return result?.data || null;
  }
  async function scanLoop() {
    if (!stream) return;
    if (video.readyState >= 2) {
      try { const data = await scanImage(video); if (data && acceptAddress(data)) return; } catch {}
    }
    frame = requestAnimationFrame(scanLoop);
  }
  async function startScanner() {
    if (preview) { setState({ step: 'amount', manualOpen: true, status: '화면 테스트에서는 주소 입력 상태를 표시합니다.' }); return; }
    if (stream) return;
    if (!navigator.mediaDevices?.getUserMedia) { setState({ step: 'amount', manualOpen: true, status: '카메라를 열 수 없어요. 주소를 직접 입력해 주세요.' }); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      video.srcObject = stream; scanner.hidden = false; await video.play(); scanLoop();
    } catch { setState({ step: 'amount', manualOpen: true, status: '카메라 권한을 허용하거나 주소를 직접 입력해 주세요.' }); }
  }
  function stopScanner() {
    if (frame) cancelAnimationFrame(frame); frame = null;
    stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; scanner.hidden = true;
  }
  async function readFile(file) {
    if (!file) return;
    try {
      const image = new Image(); image.src = URL.createObjectURL(file); await image.decode();
      const data = await scanImage(image); URL.revokeObjectURL(image.src);
      if (!data || !acceptAddress(data)) setState({ status: 'QR에서 지갑 주소를 찾지 못했어요.' });
    } catch { setState({ status: 'QR 이미지를 읽지 못했어요.' }); }
  }
  async function send() {
    if (preview) {
      setState({ step: 'sending', status: '', tx: null });
      setTimeout(() => setState({ step: 'success', tx: '0x' + 'a'.repeat(64) }), 650);
      return;
    }
    if (!sender || sender.isSending()) return;
    const details = { account: state.account, recipient: state.recipient, won: state.won };
    setState({ step: 'sending', status: '', tx: null });
    try {
      const prepared = await Core.prepareTransaction(provider, { ...details, chainId: Wallet.NETWORK.chainId });
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [prepared.transaction] });
      setState({ tx: hash });
      const receipt = await sender.waitForReceipt(hash);
      if (!receipt) throw Object.assign(new Error('TRANSACTION_FAILED'), { code: 'TRANSACTION_FAILED' });
      setState({ step: 'success', tx: hash });
      await controller.refresh();
    } catch (error) {
      if (error?.code === 4001) setState({ step: 'amount', status: '송금이 취소됐어요.' });
      else if (state.tx || error?.code === 'RECEIPT_TIMEOUT') setState({ step: 'sending', status: errorText(error?.code) });
      else setState({ step: 'amount', status: errorText(error?.code) });
    }
  }
  async function checkReceipt() {
    if (!state.tx || !sender) return;
    const hash = state.tx;
    setState({ status: '' });
    try {
      await sender.waitForReceipt(hash);
      setState({ step: 'success', tx: hash });
      await controller.refresh();
    } catch (error) { setState({ step: 'sending', tx: hash, status: errorText(error?.code) }); }
  }
  function onClick(event) {
    const preset = event.target.closest('[data-won]');
    if (preset) { setState({ won: preset.dataset.won, status: '' }); return; }
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const action = target.dataset.action;
    if (action === 'connect') void connect();
    else if (action === 'scan') void startScanner();
    else if (action === 'manual') acceptAddress(document.getElementById('manualAddress').value);
    else if (action === 'send') void send();
    else if (action === 'check') void checkReceipt();
    else if (action === 'next') setState({ step: 'amount', recipient: null, won: '', tx: null, status: '', manualOpen: false, manualAddress: '' });
  }
  function init() {
    screen.addEventListener('click', onClick);
    screen.addEventListener('input', event => { if (event.target.id === 'wonInput') { state.won = event.target.value.replace(/[^0-9]/g, ''); render(); const input = document.getElementById('wonInput'); input?.focus(); input?.setSelectionRange(input.value.length,input.value.length); } else if (event.target.id === 'manualAddress') state.manualAddress = event.target.value; });
    screen.addEventListener('change', event => { if (event.target.id === 'qrFile') void readFile(event.target.files?.[0]); });
    const openManual = () => { stopScanner(); setState({ step: 'amount', manualOpen: true, status: '' }); setTimeout(() => document.getElementById('manualAddress')?.focus(), 0); };
    document.getElementById('closeScanner').addEventListener('click', stopScanner);
    document.getElementById('scannerManual').addEventListener('click', openManual);
    balanceButton.addEventListener('click', () => controller?.refresh());
    window.addEventListener('pagehide', () => { stopScanner(); controller?.dispose(); discovery?.dispose(); });
    if (!preview) {
      discovery = Wallet.discover(window);
      const readBalanceFromRpc = Wallet.createRpcBalanceReader({ fetchImpl: window.fetch.bind(window) });
      controller = Wallet.createWallet({ getProvider: () => discovery.getProvider(), onState: onWallet, readBalanceFromRpc });
      void controller.restore();
    }
    render();
  }
  init();
})();
