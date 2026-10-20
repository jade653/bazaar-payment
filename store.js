(function () {
  'use strict';
  const Wallet = window.BazaarWallet, Transfer = window.BazaarTransfer, UI = window.BazaarUI;
  const screen = document.getElementById('storeScreen'), balanceNode = document.getElementById('storeBalance');
  const preview = new URL(location.href).searchParams.has('preview');
  let discovery, controller, disposed = false;
  let state = { account:null, balanceWei:null, name:localStorage.getItem('bazaar-store-name') || '', status:'' };
  const history = window.BazaarHistory.create({
    query:account => preview ? Promise.resolve([
      { timestamp:Date.now()/1000-180, direction:'in', valueWei:55n*10n**18n, balanceWei:1255n*10n**17n },
      { timestamp:Date.now()/1000-720, direction:'out', valueWei:10n*10n**18n, balanceWei:705n*10n**17n }
    ]) : window.BazaarHistory.recentTransfers(window.fetch.bind(window), { account, rpcUrl:Wallet.NETWORK.rpcUrls[0], blockWindow:1200, limit:20 }),
    onChange:render
  });
  function render() {
    if (disposed) return;
    balanceNode.hidden = !state.account;
    balanceNode.querySelector('span').textContent = UI.mst(state.balanceWei);
    if (!state.account) {
      screen.innerHTML = `<div class="operator-hero"><h1>가게 지갑을<br>연결해 주세요.</h1><p>받기 QR과 잔액, 거래 내역을 확인합니다.</p>${UI.alert(state.status)}</div><button class="operator-primary" data-store="connect" type="button">가게 지갑 연결하기</button>`;
      return;
    }
    screen.innerHTML = `<div class="store-name-row"><label for="storeName">가게 이름 <small>(선택)</small></label><div><input id="storeName" maxlength="30" value="${UI.esc(state.name)}" placeholder="예: 사랑 분식"><button type="button" data-store="save-name">저장</button></div></div><section class="store-card"><div class="store-card-title"><span>받기 QR</span><strong>${UI.esc(state.name || '우리 가게')}</strong></div>${UI.qrMarkup('storeQr', '가게 받기 QR')}</section><a class="operator-secondary pay-link-button" href="/pay.html?mode=transfer${preview ? '&preview=1' : ''}">송금하기</a>${UI.history(history.snapshot())}${UI.alert(state.status)}`;
    UI.renderQr(document.getElementById('storeQr'), Transfer.paymentLink(state.account, state.name), { preview });
  }
  function set(next) { state = { ...state, ...next }; render(); }
  function onWallet(snapshot) {
    if (snapshot.status === 'ready') {
      set({ account:snapshot.account, balanceWei:snapshot.balanceWei, status:'' });
      void history.load(snapshot.account);
    } else if (['connecting','adding','switching','pending','querying'].includes(snapshot.status)) {
      set({ status:snapshot.status === 'querying' ? '잔액을 확인하고 있어요.' : 'MetaMask에서 확인을 눌러주세요.' });
    } else {
      history.clear();
      set({ account:null, balanceWei:null, status:snapshot.status === 'idle' ? '' : snapshot.status === 'cancelled' ? '연결이 취소됐어요.' : '가게 지갑을 다시 연결해 주세요.' });
    }
  }
  async function connect() {
    const provider = await discovery.getProvider();
    if (!provider) { location.assign('https://link.metamask.io/dapp/bazaar.mustree.kr/store.html'); return; }
    await controller.setup();
  }
  screen.addEventListener('click', event => {
    if (event.target.closest('[data-history-refresh]')) { if (state.account) void history.load(state.account); return; }
    const target = event.target.closest('[data-store]');
    if (!target || target.disabled) return;
    if (target.dataset.store === 'connect') void connect();
    else if (target.dataset.store === 'save-name') {
      state.name = document.getElementById('storeName').value.trim().slice(0, 30);
      localStorage.setItem('bazaar-store-name', state.name); render();
    }
  });
  const refresh = () => { if (!preview && document.visibilityState === 'visible') void controller.refresh(); };
  balanceNode.addEventListener('click', refresh);
  window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
  window.addEventListener('pagehide', event => { if (!event.persisted) { disposed = true; controller?.dispose(); discovery?.dispose(); history.clear(); } });
  if (preview) {
    state.account = '0x' + '1'.repeat(40); state.balanceWei = '125500000005000000000';
    void history.load(state.account);
  } else {
    discovery = Wallet.discover(window);
    controller = Wallet.createWallet({ getProvider:() => discovery.getProvider(), onState:onWallet, readBalanceFromRpc:Wallet.createRpcBalanceReader({ fetchImpl:window.fetch.bind(window) }) });
    void controller.restore();
  }
  render();
})();
