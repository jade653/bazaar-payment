(function () {
  'use strict';
  const Wallet = window.BazaarWallet, Transfer = window.BazaarTransfer, UI = window.BazaarUI;
  const screen = document.getElementById('storeScreen'), balanceNode = document.getElementById('storeBalance');
  const preview = new URL(location.href).searchParams.has('preview');
  let discovery, controller, disposed = false;
  let forceHistory = false;
  let renderedAccount, renderedName, renderedQr, settledHistoryAccount;
  let state = { account:null, balanceWei:null, name:localStorage.getItem('bazaar-store-name') || '', status:'' };
  const history = window.BazaarHistory.create({
    chainId:Wallet.NETWORK.chainId, limit:20, storage:preview ? null : undefined,
    query:(account, options) => preview ? Promise.resolve({
      items:[
        { hash:'0x'+'a'.repeat(64), blockNumber:'0x0', timestamp:Math.floor(Date.now()/1000)-180, direction:'in', valueWei:55000n, balanceWei:125500n },
        { hash:'0x'+'b'.repeat(64), blockNumber:'0x0', timestamp:Math.floor(Date.now()/1000)-720, direction:'out', valueWei:10000n, balanceWei:70500n }
      ], lastScannedBlock:0, balanceWei:'125500', settledHashes:[]
    }) : window.BazaarHistory.recentTransfers(window.fetch.bind(window), { account, rpcUrl:Wallet.NETWORK.rpcUrls[0], token:Wallet.TOKEN, ...options }),
    onChange:render
  });
  function render() {
    if (disposed) return;
    balanceNode.hidden = !state.account;
    const balanceText = UI.mst(state.balanceWei), balanceValue = balanceNode.querySelector('span');
    if (balanceValue.textContent !== balanceText) balanceValue.textContent = balanceText;
    if (!state.account) {
      const markup = `<div class="operator-hero"><h1>가게 지갑을<br>연결해 주세요.</h1><p>받기 QR과 잔액, 거래 내역을 확인합니다.</p>${UI.alert(state.status)}</div><button class="operator-primary" data-store="connect" type="button">가게 지갑 연결하기</button>`;
      if (screen.innerHTML !== markup) screen.innerHTML = markup;
      renderedAccount = null; renderedName = undefined; renderedQr = undefined; settledHistoryAccount = undefined;
      return;
    }
    const accountKey = state.account.toLowerCase();
    if (renderedAccount !== accountKey) {
      screen.innerHTML = `<div class="store-name-row"><div><input id="storeName" maxlength="30" value="${UI.esc(state.name)}" aria-label="가게 이름 (선택)" placeholder="가게 이름 (선택)"><button type="button" data-store="save-name">저장</button></div></div><section class="store-card"><div class="store-card-title"><span>받기 QR</span><strong id="storeQrName"></strong></div>${UI.qrMarkup('storeQr', '가게 받기 QR')}</section><a class="operator-secondary pay-link-button" href="/pay.html?mode=transfer${preview ? '&preview=1' : ''}">송금하기</a><div id="storeHistory"></div><div id="storeStatus" hidden></div>`;
      renderedAccount = accountKey; renderedName = undefined; renderedQr = undefined; settledHistoryAccount = undefined;
    }
    if (renderedName !== state.name) {
      document.getElementById('storeQrName').textContent = state.name || '우리 가게';
      renderedName = state.name;
    }
    const qrLink = Transfer.receiveLink(state.account, { name:state.name });
    if (renderedQr !== qrLink) {
      UI.renderQr(document.getElementById('storeQr'), qrLink, { preview });
      renderedQr = qrLink;
    }
    const snapshot = history.snapshot();
    if (snapshot.account === accountKey && !snapshot.loading && !snapshot.error) settledHistoryAccount = accountKey;
    // Keep existing rows still during background reads, including their height.
    const historyMarkup = UI.history({ ...snapshot, loading:snapshot.loading && (settledHistoryAccount !== accountKey || !!snapshot.error) });
    const historyNode = document.getElementById('storeHistory');
    if (historyNode.innerHTML !== historyMarkup) historyNode.innerHTML = historyMarkup;
    const statusNode = document.getElementById('storeStatus'), statusMarkup = UI.alert(state.status);
    statusNode.hidden = !state.status;
    if (statusNode.innerHTML !== statusMarkup) statusNode.innerHTML = statusMarkup;
  }
  function set(next) { state = { ...state, ...next }; render(); }
  function onWallet(snapshot) {
    if (snapshot.status === 'ready') {
      set({ needsApp:false, account:snapshot.account, balanceWei:snapshot.balanceWei, status:'' });
      void history.load(snapshot.account, { balanceWei:snapshot.balanceWei, force:forceHistory });
      forceHistory = false;
    } else if (['connecting','adding','switching','pending','querying'].includes(snapshot.status)) {
      if (snapshot.status === 'querying' && state.account) return;
      set({ status:snapshot.status === 'querying' ? '잔액을 확인하고 있어요.' : 'MetaMask에서 확인을 눌러주세요.' });
    } else if (snapshot.status === 'error' && snapshot.duringBalance && state.account) {
      set({ status:'잔액을 확인하지 못했어요. 잠시 후 자동으로 다시 확인합니다.' });
    } else {
      history.clear();
      set({ needsApp:snapshot.status === 'unavailable', account:null, balanceWei:null, status:snapshot.status === 'idle' ? '' : snapshot.status === 'cancelled' ? '연결이 취소됐어요.' : '가게 지갑을 다시 연결해 주세요.' });
    }
  }
  async function connect() {
    if (state.needsApp) { location.assign(Transfer.appLink('/store.html')); return; }
    const provider = await discovery.getProvider();
    if (!provider) { location.assign(Transfer.appLink('/store.html')); return; }
    await controller.setup();
  }
  screen.addEventListener('click', event => {
    if (event.target.closest('[data-history-refresh]')) { if (state.account) void history.load(state.account, { force:true }); return; }
    const target = event.target.closest('[data-store]');
    if (!target || target.disabled) return;
    if (target.dataset.store === 'connect') void connect();
    else if (target.dataset.store === 'save-name') {
      state.name = document.getElementById('storeName').value.trim().slice(0, 30);
      document.getElementById('storeName').value = state.name;
      localStorage.setItem('bazaar-store-name', state.name); render();
    }
  });
  const refresh = () => { if (!preview && document.visibilityState === 'visible') void controller.refresh(); };
  balanceNode.addEventListener('click', () => { forceHistory = true; refresh(); });

  const syncTimer = preview ? null : window.setInterval?.(() => {
    if (state.account && document.visibilityState === 'visible') refresh();
  }, 5000);
  window.addEventListener('pagehide', event => { if (!event.persisted) { window.clearInterval?.(syncTimer); disposed = true; controller?.dispose(); discovery?.dispose(); history.clear(); } });
  if (preview) {
    state.account = '0x' + '1'.repeat(40); state.balanceWei = '125500';
    void history.load(state.account);
  } else {
    discovery = Wallet.discover(window);
    controller = Wallet.createWallet({ lifecycle:window, getProvider:() => discovery.getProvider(), onState:onWallet, readBalanceFromRpc:Wallet.createRpcBalanceReader({ fetchImpl:window.fetch.bind(window) }) });
    void controller.restore();
  }
  render();
})();
