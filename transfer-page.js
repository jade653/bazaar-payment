(function () {
  'use strict';
  const screen = document.querySelector('[data-transfer-kind]');
  if (!screen) return;
  const params = new URL(location.href).searchParams;
  const kind = screen.dataset.transferKind === 'payment' && params.get('mode') === 'transfer' ? 'transfer' : screen.dataset.transferKind;
  const preview = params.has('preview'), isTopup = kind === 'topup';
  if (kind === 'transfer') {
    document.title = 'MST 송금';
    document.querySelector('.operator-brand strong').textContent = 'MST 송금';
  }
  const Wallet = window.BazaarWallet, Transfer = window.BazaarTransfer, UI = window.BazaarUI;
  const diagnostics = preview ? null : Wallet.diagnosticsFor?.(window);
  const log = (stage, error, hash) => diagnostics?.record({ stage, error, hash, chainId:sender?.getChainId?.() ?? controller?.getSnapshot?.().chainId });
  const initialRecipient = Transfer.parseRecipient(location.href);
  let state = { step:isTopup ? 'connect' : 'form', account:null, balanceWei:null, gasWei:null, topUpsLeft:null, recipient:initialRecipient?.address || null, recipientName:initialRecipient?.name || '', value:params.get(kind === 'transfer' ? 'mst' : 'won') || '', manual:false, status:'', hash:null, busy:false };
  let discovery, controller, provider, sender, senderProvider, scanner, submitted = null, disposed = false;
  let autoScan = params.get('scan') === '1' && !isTopup;
  let appOpenAttempted = false;
  const readBalanceFromRpc = preview ? null : Wallet.createRpcBalanceReader({ fetchImpl:window.fetch.bind(window) });
  const returnUrl = (kind === 'transfer' ? '/store.html' : '/') + (preview ? '?preview=1' : '');
  function amountFor(value, amountKind = kind) { try { return Transfer.parseAmount(value, amountKind); } catch { return null; } }
  function render() {
    if (disposed) return;
    if (state.needsApp && ['connect','form'].includes(state.step)) {
      screen.innerHTML = UI.transfer(state, { kind, appUrl:metaMaskUrl() });
    } else if (state.step === 'connect') {
      screen.innerHTML = `<div class="operator-hero"><h1>충전 지갑을<br>연결해 주세요.</h1><p>현금을 받고 손님 지갑에 MST를 보냅니다.</p>${UI.alert(state.status)}</div>${UI.button('충전 지갑 연결하기', 'connect', { disabled:state.busy })}`;
    } else {
      const display = ['sending','success'].includes(state.step) && submitted ? { ...state, recipient:submitted.recipient, value:submitted.value } : state;
      const displayKind = ['sending','success'].includes(state.step) ? submitted?.kind || kind : kind;
      screen.innerHTML = UI.transfer(display, { kind:displayKind, amount:amountFor(display.value, displayKind) });
    }
    const balanceText = document.getElementById('balanceText'), balanceButton = document.getElementById('balanceButton');
    if (balanceText) balanceText.textContent = UI.mst(state.balanceWei);
    if (balanceButton) balanceButton.hidden = !state.account && !preview;
    UI.showBalanceDialog(screen, dismissInsufficient);
  }
  function dismissInsufficient() { set({ insufficient:false, status:'' }); document.getElementById('transferAmount')?.focus(); }
  function set(next) { state = { ...state, ...next }; render(); }
  function onWallet(snapshot) {
    if (snapshot.status === 'ready') {
      set({ walletBlocked:false, needsApp:false, account:snapshot.account, balanceWei:snapshot.balanceWei, gasWei:snapshot.gasWei ?? null, topUpsLeft:isTopup && snapshot.gasWei != null ? Transfer.topUpsAffordable(snapshot.gasWei, Wallet.TOKEN) : null, step:state.step === 'connect' ? 'form' : state.step, status:state.step === 'sending' ? state.status : '' });
    } else {
      const invalid = ['idle','needs-network','disconnected','unavailable'].includes(snapshot.status);
      const message = snapshot.status === 'cancelled' ? '연결이 취소됐어요. 지갑 연결 다시 시도를 눌러주세요.'
        : snapshot.status === 'pending' ? 'MetaMask의 기존 승인 요청을 확인한 뒤 지갑 연결 다시 시도를 눌러주세요.'
        : ['connecting','adding','switching','pending'].includes(snapshot.status) ? 'MetaMask에서 확인을 눌러주세요.'
        : snapshot.status === 'querying' ? '잔액을 확인하고 있어요.'
        : invalid ? '지갑을 연결해 주세요.' : '지갑을 연결하지 못했어요.';
      set({ walletBlocked:['pending','cancelled','needs-network','error','disconnected'].includes(snapshot.status), needsApp:snapshot.status === 'unavailable', account:null, balanceWei:null, gasWei:null, topUpsLeft:null, status:state.step === 'sending' ? state.status : message });
      // Keep this destination page open behind the app, including after installation.
      // Browsers may require a second, explicit tap to launch a custom scheme.
      if (snapshot.status === 'unavailable' && params.get('open') === '1' && !appOpenAttempted) {
        appOpenAttempted = true;
        openMetaMask();
      }
    }
    if (autoScan && ['ready','idle','needs-network'].includes(snapshot.status)) { autoScan = false; scan(); }
  }
  function accept(raw) {
    const recipient = Transfer.parseRecipient(raw, location.origin);
    if (!recipient) { set({ status:UI.errorText('INVALID_ADDRESS') }); return false; }
    scanner?.stop(); set({ recipient:recipient.address, recipientName:recipient.name, manual:false, status:'' }); return true;
  }
  function openManual() { scanner?.stop(); set({ manual:true, manualAddress:'', recipient:null, recipientName:'', status:'' }); }
  function scan() {
    void getScanner().start();
  }
  function getScanner() {
    return scanner ||= window.BazaarScanner.create({ onAccept:accept, onError:status => set({ status }), onManual:openManual, preview, onPreview:() => accept('0x' + '2'.repeat(40)) });
  }
  function metaMaskUrl() {
    const amount = amountFor(state.value);
    return Transfer.appLink(isTopup ? '/operator.html' : '/pay.html', {
      to:state.recipient, name:state.recipientName,
      mode:kind === 'transfer' ? 'transfer' : '',
      [kind === 'transfer' ? 'mst' : 'won']:amount ? amount.won.toString() : '',
      scan:!state.recipient && params.get('scan') === '1' ? '1' : ''
    }).replace('https://link.metamask.io/', 'metamask://');
  }
  function openMetaMask() {
    try { location.assign(metaMaskUrl()); }
    catch {
      // An unavailable scheme must leave the install/continue instructions visible.
      set({ needsApp:true });
    }
  }
  async function connect() {
    if (preview) { set({ step:'form', balanceWei:'500000', topUpsLeft:isTopup ? 120 : null, status:'' }); return; }
    provider ||= await discovery.getProvider();
    if (!provider) { openMetaMask(); return; }
    await controller.setup();
  }
  function handleError(error) {
    const terminal = error?.code === 'TRANSACTION_FAILED';
    log('payment:failure', error, error?.hash || state.hash);
    controller?.suspendPrompts?.(Wallet.errorCode?.(error) ?? error?.code);
    if (error?.hash && !state.hash) state.hash = error.hash;
    set({ step:state.hash && !terminal ? 'sending' : 'form', hash:terminal ? null : state.hash, status:UI.errorText(Wallet.errorCode?.(error) ?? error?.code, kind), insufficient:error?.code === 'INSUFFICIENT_BALANCE', balanceWei:error?.balanceWei ?? state.balanceWei, gasWei:error?.gasWei ?? state.gasWei });
  }
  async function refreshBalance() {
    // A balance refresh failure must not change a confirmed transfer back to pending.
    try { await controller.refresh(); } catch {}
  }
  async function submit() {
    if (state.busy || state.step !== 'form' || !state.recipient || !amountFor(state.value)) return;
    set({ busy:true, status:'', insufficient:false });
    try {
      if (!preview) {
        provider ||= await discovery.getProvider();
        if (!provider) { openMetaMask(); return; }
        log('payment:wallet-validation');
        await controller.setup();
        if (!state.account) return;
        provider = await discovery.getProvider();
      }
      submitted = { account:state.account, recipient:state.recipient, value:state.value, kind };
      set({ step:'sending', hash:null, status:'' });
      if (preview) {
        set({ step:'success', hash:'0x' + 'a'.repeat(64) });
        return;
      }
      if (!sender || senderProvider !== provider) {
        sender = Transfer.createSender({ provider, chainId:Wallet.NETWORK.chainId, token:Wallet.TOKEN, diagnostics, storage:window.localStorage });
        senderProvider = provider;
      }
      controller.pauseAutoPrompts?.(true);
      const pendingHash = sender.pending?.(submitted.account);
      if (pendingHash) {
        submitted = sender.pendingDetails?.() || submitted;
        set({ hash:pendingHash, status:'이전에 보낸 거래 결과를 먼저 확인하고 있어요.' });
        await sender.check(pendingHash);
        set({ step:'success', status:'' }); await refreshBalance(); return;
      }
      await sender.send({ ...submitted, kind, readBalanceFromRpc }, { onHash:hash => {
        set({ hash });
        log('payment:hash-received', null, hash);
        window.BazaarHistory.recordSent({ chainId:Wallet.NETWORK.chainId, account:submitted.account, hash });
      } });
      set({ step:'success', status:'' });
      await refreshBalance();
    } catch (error) { handleError(error); }
    finally { controller?.pauseAutoPrompts?.(state.step === 'sending'); set({ busy:false }); }
  }
  async function check() {
    if (state.busy || !state.hash || preview) return;
    set({ busy:true, status:'' });
    try {
      await controller.setup();
      if (!state.account) return;
      const nextProvider = await discovery.getProvider();
      if (senderProvider !== nextProvider) {
        sender = Transfer.createSender({ provider:nextProvider, chainId:Wallet.NETWORK.chainId, token:Wallet.TOKEN, diagnostics, storage:window.localStorage });
        senderProvider = nextProvider; sender.pending?.(submitted.account);
      }
      await sender.check(state.hash); set({ step:'success' }); await refreshBalance(); }
    catch (error) { handleError(error); }
    finally { controller?.pauseAutoPrompts?.(state.step === 'sending'); set({ busy:false }); }
  }
  function click(event) {
    const preset = event.target.closest('[data-transfer-won]');
    if (preset && !state.busy) { set({ value:preset.dataset.transferWon, status:'' }); return; }
    const target = event.target.closest('[data-transfer]');
    if (!target || target.disabled || state.busy) return;
    switch (target.dataset.transfer) {
      case 'connect': void connect(); break;
      case 'scan': scan(); break;
      case 'manual': openManual(); break;
      case 'accept': accept(document.getElementById('transferRecipient')?.value || ''); break;
      case 'submit': void submit(); break;
      case 'check': void check(); break;
      case 'topup': location.assign('/' + (preview ? '?preview=1' : '') + '#receive'); break;
      case 'dismiss-insufficient': dismissInsufficient(); break;
      case 'done':
        if (isTopup) { submitted = null; set({ step:'form', recipient:null, recipientName:'', value:'', hash:null, status:'', manual:false }); }
        else location.assign(returnUrl);
        break;
    }
  }
  function input(event) {
    if (state.busy || state.step === 'sending') return;
    if (event.target.id === 'transferRecipient') { state.manualAddress = event.target.value; return; }
    if (event.target.id !== 'transferAmount') return;
    const start = event.target.selectionStart, end = event.target.selectionEnd;
    const value = event.target.value.replace(/[^0-9]/g, '');
    set({ value, status:'', insufficient:false });
    const field = document.getElementById('transferAmount'); field?.focus(); field?.setSelectionRange(start, end);
  }
  screen.addEventListener('click', click); screen.addEventListener('input', input);
  if (!preview) {
    discovery = Wallet.discover(window);
    controller = Wallet.createWallet({ lifecycle:window, getProvider:() => discovery.getProvider(), onState:onWallet, readBalanceFromRpc });
    void controller.restore();
  } else state.balanceWei = '500000';
  const refresh = () => { if (!preview && !state.busy && document.visibilityState === 'visible') void controller.refresh(); };
  document.getElementById('balanceButton')?.addEventListener('click', refresh);

  window.addEventListener('pagehide', event => { scanner?.stop(); if (!event.persisted) { disposed = true; scanner?.dispose(); controller?.dispose(); discovery?.dispose(); } });
  render();
  if (preview && autoScan) scan();
})();
