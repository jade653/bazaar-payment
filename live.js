(function (root) {
  'use strict';
  root.BazaarLive = { create };
  function create({ Wallet, UI = root.BazaarUI, History = root.BazaarHistory, illustration }) {
    const screen = document.getElementById('appScreen');
    let controller, discovery, view = 'welcome', phase = 'connect';
    let account = null, balanceWei = null, retryVisible = false, problem = '';
    let retryTimer, pending = false, disconnected = false, intent = false, externalPending = false;
    let allowAppOpen = false;
    let needsApp = false;
    let receiveFromHome = false;
    const requestedView = location.hash === '#receive' ? 'receive' : null;
    let initialView = true;
    let forceHistory = false;
    const transferHistory = History.create({
      chainId:Wallet.NETWORK.chainId, limit:5,
      query:(account, options) => History.recentTransfers(root.fetch.bind(root), { account, rpcUrl:Wallet.NETWORK.rpcUrls[0], token:Wallet.TOKEN, ...options }),
      onChange:() => { if (view === 'home') paint(); }
    });
    const button = (text, action, secondary = false) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-live="${action}">${text}</button>`;
    const actions = (...content) => `<div class="actions">${content.join('')}</div>`;
    const heading = (text, sub = '') => `<h1 class="screen-title">${text}</h1>${sub ? `<p class="screen-description">${sub}</p>` : ''}`;
    const spinner = '<span class="spinner" aria-hidden="true"></span>';
    function render() {
      if (view === 'opening') return `<div class="center-state">${illustration('phone')}${heading('준비되면 이어가세요.', '계정 생성 후 이 페이지로 돌아와<br>‘바자회 이어하기’를 눌러주세요.')}</div>` + actions(button('바자회 이어하기', 'open-app'), button('앱 설치하기', 'install', true));
      if (view === 'connect') {
        const querying = phase === 'query';
        return `<div class="center-state">${illustration('phone')}${heading(querying ? '잔액을 확인하고 있어요.' : '잠깐만요,<br>사용할 준비 중이에요.', querying ? '곧 보여드릴게요.' : problem || 'MetaMask에서 확인을 눌러주세요.')}<div class="waiting-indicator">${pending || querying ? spinner : ''}<span>${querying ? '확인 중' : pending ? '확인 기다리는 중' : ''}</span></div></div>` + (retryVisible ? actions(button('다시 요청', 'retry', true)) : '');
      }
      if (view === 'home' || view === 'balance-error') {
        const failed = view === 'balance-error';
        return heading('내 지갑') + UI.balance({ account, balanceWei, failed, copyAttributes:'data-live="copy-address"', refreshAttributes:'data-live="refresh"' }) + (failed ? `<div class="balance-actions single">${button('다시 확인', 'refresh')}</div>` : `<div class="balance-actions">${button('충전하기', 'receive')}${button('가게 결제하기', 'pay', true)}<button type="button" class="home-store-link" data-live="store">내 가게</button></div>${UI.history(transferHistory.snapshot(), { compact:true })}`);
      }
      if (view === 'receive') return heading(UI.receiveTitle) + UI.qrMarkup('liveQr', '내 지갑 주소 QR 코드') + UI.receiveAddress(account) + actions(button('주소 복사하기', 'copy'), button('내 지갑으로', 'home', true));
      return heading('MST로<br>즐거운 바자회.') + illustration('coin') + actions('<p class="screen-description center-state">바자회를 이용하려면<br>앱 설치가 필요해요.</p>', button('1. 앱 설치하기', 'install', true), button('2. 바자회 이어하기', 'start'), '<p class="screen-description center-state">계정 생성 후 이 페이지로 돌아와<br>이어하기 버튼을 눌러주세요.</p>');
    }
    function renderReceiveQr() {
      const target = document.getElementById('liveQr');
      if (!target || !account) return;
      UI.renderQr(target, root.BazaarTransfer.receiveLink(account, { topup:true }), { QRCode:root.QRCode });
    }
    function paint() { screen.innerHTML = render(); if (view === 'receive') renderReceiveQr(); }
    function show(next, historyMode = 'replace') {
      view = ['welcome', 'opening', 'connect', 'home', 'balance-error', 'receive'].includes(next) ? next : account ? 'home' : 'welcome';
      if (['home', 'receive'].includes(view) && !account) view = 'welcome';
      if (view === 'home' && balanceWei === null && account) view = 'connect';
      paint();
      const nextHash = '#' + view;
      if (historyMode !== 'none' && location.hash !== nextHash) history[historyMode === 'push' ? 'pushState' : 'replaceState'](null, '', nextHash);
    }
    function onState(snapshot) {
      needsApp = snapshot.status === 'unavailable';
      clearTimeout(retryTimer); problem = ''; retryVisible = false; pending = false;
      if (snapshot.status !== 'ready') balanceWei = null;
      switch (snapshot.status) {
        case 'ready':
          account = snapshot.account; balanceWei = snapshot.balanceWei;
          intent = false; allowAppOpen = false; externalPending = false;
          void transferHistory.load(account, { balanceWei, force:forceHistory });
          forceHistory = false;
          if (view === 'receive') { paint(); initialView = false; return; }
          show(initialView && requestedView ? requestedView : 'home'); initialView = false; return;
        case 'idle': transferHistory.clear(); account = null; intent = false; allowAppOpen = false; show('welcome'); return;
        case 'unavailable':
          transferHistory.clear(); account = null; show(intent ? 'opening' : 'welcome');
          if (allowAppOpen) { allowAppOpen = false; openApp(); } return;
        case 'querying':
          if (view === 'receive') return;
          phase = 'query'; show('connect'); return;
        case 'connecting': case 'adding': case 'switching':
          phase = snapshot.status; pending = true; show('connect');
          retryTimer = setTimeout(() => { retryVisible = true; paint(); }, 8000); return;
        case 'pending': externalPending = true; pending = true; problem = 'MetaMask에 열린 요청을 확인해 주세요.'; break;
        case 'cancelled': intent = false; allowAppOpen = false; externalPending = false; problem = '이어서 준비할 수 있어요.'; break;
        case 'needs-network':
          // Only an explicit retry may reopen a cancelled or pending approval.
          problem = '다시 확인을 눌러주세요.'; break;
        case 'disconnected': transferHistory.clear(); account = null; disconnected = true; problem = '연결이 끊겼어요. 다시 연결해 주세요.'; break;
        case 'error':
          if (snapshot.duringBalance) { if (view === 'receive') return; show('balance-error'); return; }
          problem = '연결하지 못했어요. 잠시 후 다시 시도해 주세요.'; break;
      }
      if (snapshot.status === 'pending') problem = 'MetaMask에 열린 요청을 확인해 주세요.';
      phase = 'connect'; retryVisible = true; show('connect');
    }
    function openApp() {
      show('opening');
      location.assign(root.BazaarTransfer.appLink('/start.html'));
    }
    function start() {
      intent = true; allowAppOpen = true;
      if (needsApp) { allowAppOpen = false; openApp(); return; }
      void controller.setup();
    }
    function refreshHome(historyMode, force = false) {
      forceHistory ||= force;
      balanceWei = null; phase = 'query';
      show('home', historyMode);
      void controller.refresh();
    }
    function onClick(event) {
      if (event.target.closest('[data-history-refresh]')) { if (account) void transferHistory.load(account, { force:true }); return; }
      const target = event.target.closest('[data-live]');
      if (!target || target.disabled) return;
      switch (target.dataset.live) {
        case 'start': start(); break;
        case 'retry':
          if (disconnected) { const url = new URL(location.href); url.searchParams.set('start', '1'); location.assign(url.href); }
          else start(); break;
        case 'open-app': case 'install': openApp(); break;
        case 'home':
          if (view === 'receive' && receiveFromHome && location.hash === '#receive') { receiveFromHome = false; history.back(); }
          else refreshHome('replace');
          break;
        case 'receive': if (account) { receiveFromHome = true; show('receive', 'push'); } break;
        case 'pay': if (account) location.assign('/pay.html?scan=1'); break;
        case 'store': location.assign('/store.html'); break;
        case 'copy': case 'copy-address':
          if (account && navigator.clipboard) navigator.clipboard.writeText(account).then(() => { target.textContent = '복사했어요'; }).catch(() => { target.textContent = '길게 눌러 복사'; });
          else target.textContent = '길게 눌러 복사'; break;
        case 'refresh': refreshHome('replace', true); break;
      }
    }
    function init() {
      document.querySelector('.app-footer').textContent = 'MST 파운데이션 달란트';
      discovery = Wallet.discover(window);
      const readBalanceFromRpc = Wallet.createRpcBalanceReader({ fetchImpl: window.fetch.bind(window) });
      controller = Wallet.createWallet({ lifecycle:window, getProvider: () => discovery.getProvider(), onState, readBalanceFromRpc });
      screen.addEventListener('click', onClick);
      window.addEventListener('popstate', () => {
        const next = location.hash.slice(1);
        if (next === 'home' && account) refreshHome('none');
        else show(next, 'none');
      });
      const url = new URL(location.href), autoStart = url.searchParams.get('start') === '1';
      url.searchParams.delete('start'); history.replaceState(null, '', url.href);
      show('welcome');
      if (autoStart) { intent = true; void controller.setup(); } else void controller.restore();
      const refresh = () => { if (view === 'home' && account && !pending && document.visibilityState === 'visible') void controller.refresh(); };

      const syncTimer = root.setInterval?.(() => {
        if (view === 'home' && account && document.visibilityState === 'visible') { forceHistory = true; refresh(); }
      }, History.SYNC_INTERVAL);
      window.addEventListener('pagehide', event => { if (!event.persisted) { root.clearInterval?.(syncTimer); clearTimeout(retryTimer); controller.dispose(); discovery.dispose(); } });
    }
    return { init };
  }
})(window);
