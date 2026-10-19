(function (root) {
  'use strict';
  root.BazaarLive = { create };
  function create({ Wallet, Store, illustration }) {
    const screen = document.getElementById('appScreen');
    let controller, discovery, view = 'welcome', phase = 'connect';
    let account = null, balanceWei = null, retryVisible = false, problem = '';
    let retryTimer, pending = false, disconnected = false, intent = false, externalPending = false;
    let allowAppOpen = false, historyItems = [], historyLoading = false, historyAccount = null;
    const button = (text, action, secondary = false) => `<button type="button" class="${secondary ? 'secondary' : 'primary'}" data-live="${action}">${text}</button>`;
    const actions = (...content) => `<div class="actions">${content.join('')}</div>`;
    const heading = (text, sub = '') => `<h1 class="screen-title">${text}</h1>${sub ? `<p class="screen-description">${sub}</p>` : ''}`;
    const spinner = '<span class="spinner" aria-hidden="true"></span>';
    const DISPLAY_STEP_WEI = 10n ** 15n;
    function displayWei() {
      if (balanceWei === null) return null;
      const wei = BigInt(balanceWei);
      return ((wei + DISPLAY_STEP_WEI / 2n) / DISPLAY_STEP_WEI) * DISPLAY_STEP_WEI;
    }
    function balanceText() {
      if (balanceWei === null) return '—';
      const wei = displayWei(), divisor = 10n ** 18n;
      const fraction = (wei % divisor).toString().padStart(18, '0').slice(0, 3).replace(/0+$/, '');
      return (wei / divisor).toLocaleString('ko-KR') + (fraction ? '.' + fraction : '');
    }
    function formattedWei(value) {
      const step = 10n ** 15n, raw = BigInt(value), rounded = ((raw + step / 2n) / step) * step;
      const parts = Wallet.units(rounded).split('.');
      return `${Number(parts[0]).toLocaleString('ko-KR')}${parts[1] ? '.' + parts[1].slice(0, 3) : ''} MST`;
    }
    function shortAccount() { return account ? `${account.slice(0,7)}...${account.slice(-5)}` : '—'; }
    function historyHtml() {
      if (historyLoading) return '<p class="store-empty">거래 내역을 불러오고 있어요.</p>';
      if (!historyItems.length) return '<p class="store-empty">아직 거래 내역이 없어요.</p>';
      return `<div class="store-history-list">${historyItems.map(item => `<div class="store-history-row"><time>${new Date(item.timestamp * 1000).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time><strong class="${item.direction}">${item.direction === 'in' ? '+' : '−'}${formattedWei(item.valueWei)}</strong><span>${formattedWei(item.balanceWei)}</span></div>`).join('')}</div>`;
    }
    async function loadHistory(nextAccount) {
      if (!nextAccount || historyLoading || historyAccount === nextAccount) return;
      historyAccount = nextAccount; historyLoading = true; historyItems = []; if (view === 'home') paint();
      try { historyItems = await Store.recentTransfers(window.fetch.bind(window), { account:nextAccount, rpcUrl:Wallet.NETWORK.rpcUrls[0], blockWindow:1200, limit:5 }); }
      catch { historyItems = []; }
      finally { historyLoading = false; if (view === 'home' && account === nextAccount) paint(); }
    }
    function render() {
      if (view === 'opening') return `<div class="center-state">${illustration('phone')}${heading('앱으로 이동할게요.', '화면이 바뀌지 않으면 눌러주세요.')}</div>` + actions(button('눌러서 이동', 'open-app'), button('앱 설치하기', 'install', true));
      if (view === 'connect') {
        const querying = phase === 'query';
        return `<div class="center-state">${illustration('phone')}${heading(querying ? '잔액을 확인하고 있어요.' : '잠깐만요,<br>사용할 준비 중이에요.', querying ? '곧 보여드릴게요.' : problem || 'MetaMask에서 확인을 눌러주세요.')}<div class="waiting-indicator">${pending || querying ? spinner : ''}<span>${querying ? '확인 중' : pending ? '확인 기다리는 중' : ''}</span></div></div>` + (retryVisible ? actions(button('다시 요청', 'retry', true)) : '');
      }
      if (view === 'home' || view === 'balance-error') {
        const failed = view === 'balance-error';
        const krw = balanceWei === null ? '—' : (displayWei() / DISPLAY_STEP_WEI).toLocaleString('ko-KR');
        return heading('내 지갑') + `<div class="balance-panel"><div class="balance-wallet-row"><code>${shortAccount()}</code><button type="button" data-live="copy-address">복사하기</button></div><div class="balance-number">${failed ? '—' : balanceText()}${failed ? '' : '<span>MST</span>'}</div><div class="balance-krw">${failed ? '잔액을 확인하지 못했어요.' : krw + '원 상당'}</div></div>` + (failed ? `<div class="balance-actions single">${button('다시 확인', 'refresh')}</div>` : `<div class="balance-actions">${button('충전하기', 'receive')}${button('가게 결제하기', 'pay', true)}<button type="button" class="home-store-link" data-live="store">내 가게</button></div><section class="store-history home-history"><h2>최근 거래</h2><div class="store-history-head"><span>시간</span><span>금액</span><span>잔액</span></div>${historyHtml()}</section>`);
      }
      if (view === 'receive') return heading('현금 결제 후 직원에게<br>이 QR을 보여주세요.') + `<div id="liveQr" class="live-qr" role="img" aria-label="내 지갑 주소 QR 코드"></div><div class="live-address"><code>${account || ''}</code></div>` + actions(button('주소 복사하기', 'copy'), button('내 지갑으로', 'home', true));
      return heading('MST로<br>즐거운 바자회.', '충전하고 간편하게 사용하세요.') + illustration('coin') + actions(button('시작하기', 'start'), button('앱 설치하기', 'install', true));
    }
    function renderReceiveQr() {
      const target = document.getElementById('liveQr');
      if (!target || !account) return;
      if (typeof QRCode !== 'function') { target.textContent = 'QR을 표시하지 못했어요.'; return; }
      new QRCode(target, { text: account, width: 210, height: 210, colorDark: '#233d35', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
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
      clearTimeout(retryTimer); problem = ''; retryVisible = false; pending = false;
      if (snapshot.status !== 'ready') balanceWei = null;
      switch (snapshot.status) {
        case 'ready':
          account = snapshot.account; balanceWei = snapshot.balanceWei;
          intent = false; allowAppOpen = false; externalPending = false;
          if (view === 'receive') { paint(); return; }
          show('home'); void loadHistory(account); return;
        case 'idle': account = null; intent = false; allowAppOpen = false; show('welcome'); return;
        case 'unavailable':
          account = null; show(intent ? 'opening' : 'welcome');
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
          if (intent && externalPending) { externalPending = false; void Promise.resolve().then(() => controller.setup()); return; }
          problem = '다시 확인을 눌러주세요.'; break;
        case 'disconnected': disconnected = true; problem = '연결이 끊겼어요. 다시 연결해 주세요.'; break;
        case 'error':
          if (snapshot.duringBalance) { if (view === 'receive') return; show('balance-error'); return; }
          problem = '연결하지 못했어요. 잠시 후 다시 시도해 주세요.'; break;
      }
      if (snapshot.status === 'pending') problem = 'MetaMask에 열린 요청을 확인해 주세요.';
      phase = 'connect'; retryVisible = true; show('connect');
    }
    function openApp() {
      show('opening');
      location.assign('https://link.metamask.io/dapp/bazaar.mustree.kr/start.html');
    }
    function start() {
      intent = true; allowAppOpen = true;
      void controller.setup();
    }
    function onClick(event) {
      const target = event.target.closest('[data-live]');
      if (!target || target.disabled) return;
      switch (target.dataset.live) {
        case 'start': start(); break;
        case 'retry':
          if (disconnected) { const url = new URL(location.href); url.searchParams.set('start', '1'); location.assign(url.href); }
          else start(); break;
        case 'open-app': openApp(); break;
        case 'install': location.assign('https://metamask.io/download/'); break;
        case 'home':
          if (view === 'receive' && location.hash === '#receive') history.back();
          else show('home', 'push');
          break;
        case 'receive': if (account) show('receive', 'push'); break;
        case 'pay': if (account) location.assign('/pay.html?scan=1'); break;
        case 'store': location.assign('/store.html'); break;
        case 'copy-address':
          if (account && navigator.clipboard) navigator.clipboard.writeText(account).then(() => { target.textContent = '복사했어요'; }).catch(() => { target.textContent = '길게 눌러 복사'; });
          else target.textContent = '길게 눌러 복사'; break;
        case 'refresh': void controller.refresh(); break;
        case 'copy':
          if (account && navigator.clipboard) navigator.clipboard.writeText(account).then(() => { target.textContent = '복사했어요'; }).catch(() => { target.textContent = '주소를 길게 눌러 복사해 주세요'; });
          else target.textContent = '주소를 길게 눌러 복사해 주세요'; break;
      }
    }
    function init() {
      document.querySelector('.app-footer').textContent = '우리 교회 바자회 · 결제 기능 준비 중';
      document.querySelector('.event-pill').hidden = true;
      discovery = Wallet.discover(window);
      const readBalanceFromRpc = Wallet.createRpcBalanceReader({ fetchImpl: window.fetch.bind(window) });
      controller = Wallet.createWallet({ getProvider: () => discovery.getProvider(), onState, readBalanceFromRpc });
      screen.addEventListener('click', onClick);
      window.addEventListener('popstate', () => show(location.hash.slice(1), 'none'));
      const url = new URL(location.href), autoStart = url.searchParams.get('start') === '1';
      url.searchParams.delete('start'); history.replaceState(null, '', url.href);
      show('welcome');
      if (autoStart) { intent = true; void controller.setup(); } else void controller.restore();
      const refresh = () => { if (view === 'home' && account && !pending && document.visibilityState === 'visible') void controller.refresh(); };
      window.addEventListener('focus', refresh);
      document.addEventListener('visibilitychange', refresh);
      window.addEventListener('pagehide', event => { if (!event.persisted) { clearTimeout(retryTimer); controller.dispose(); discovery.dispose(); } });
    }
    return { init };
  }
})(window);
