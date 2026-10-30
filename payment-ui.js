(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const short = value => value ? `${value.slice(0, 8)}…${value.slice(-6)}` : '—';
  // Amounts are whole wMST units (1 wMST = 1 won), shown to participants under the MST brand name.
  function mst(value, suffix = true) {
    if (value == null) return suffix ? '— MST' : '—';
    return BigInt(value).toLocaleString('ko-KR') + (suffix ? ' MST' : '');
  }
  const won = value => BigInt(value).toLocaleString('ko-KR');
  const button = (text, action, { secondary = false, disabled = false } = {}) => `<button type="button" class="${secondary ? 'operator-secondary' : 'operator-primary'}" data-transfer="${action}"${disabled ? ' disabled' : ''}>${esc(text)}</button>`;
  const alert = text => text ? `<p class="operator-alert" role="status">${esc(text)}</p>` : '';
  const receiveTitle = '충전할 금액 입금 후 직원에게<br>이 QR을 보여주세요.';
  const labels = {
    payment: { title:'얼마를 결제할까요?', recipient:'받는 가게', amount:'결제 금액', verb:'결제', done:'내 지갑으로' },
    topup: { title:'받은 현금을 입력해 주세요.', recipient:'받는 손님', amount:'현금 금액', verb:'충전', done:'다음 손님' },
    transfer: { title:'얼마를 송금할까요?', recipient:'받는 지갑', amount:'송금 금액', verb:'송금', done:'운영 화면으로' }
  };
  function transfer(state, { kind = 'payment', amount = null, appUrl = '' } = {}) {
    const copy = labels[kind], unit = kind === 'transfer' ? 'MST' : '원';
    // Transaction hashes stay in the diagnostics panel; participant screens never show chain details.
    if (state.step === 'sending') {
      return `<div class="operator-center"><span class="operator-spinner"></span><h1>${state.hash ? `${copy.verb}를 확인하고 있어요.` : 'MetaMask에서 확인을 눌러주세요.'}</h1><p>${esc(state.status || `같은 ${copy.verb}를 다시 요청하지 마세요.`)}</p></div>${state.hash && state.status ? button('결과 다시 확인', 'check', { disabled:state.busy }) : !state.hash && state.retry ? button('확인 창 다시 열기', 'retry', { secondary:true }) : ''}`;
    }
    if (state.step === 'success') {
      return `<div class="operator-success"><div class="success-mark">✓</div><span>${copy.verb} 완료</span><h1>${amount ? mst(amount.units) : '—'}</h1>${amount?.won ? `<p>${won(amount.won)}원${kind === 'topup' ? ' 충전' : ''}</p>` : ''}<p>${esc(short(state.recipient))} 지갑으로 보냈어요.</p></div>${button(copy.done, 'done')}`;
    }
    const recipient = state.manual
      ? `<label for="transferRecipient">${copy.recipient} 주소</label><div class="manual-entry"><div><input id="transferRecipient" type="text" value="${esc(state.manualAddress || '')}" placeholder="0x 지갑 주소 붙여넣기" autocomplete="off"><button type="button" data-transfer="accept">확인</button></div></div>`
      : `<small>${copy.recipient}</small><strong>${esc(state.recipientName || (state.recipient ? short(state.recipient) : 'QR을 스캔해 주세요.'))}</strong>${state.recipient ? `<code>${esc(state.recipient)}</code>` : ''}`;
    const total = amount ? mst(amount.units) : '0 MST';
    if (appUrl) return `<div><div class="operator-title"><h1>앱에서 ${copy.verb}${kind === 'payment' ? '를' : '을'}<br>이어가세요.</h1></div><div class="recipient-card">${recipient}</div>${state.value ? `<p class="screen-description">입력한 금액: ${esc(state.value)} ${unit}</p>` : ''}<p class="screen-description">MetaMask가 설치되어 있으면 아래 버튼을 눌러주세요.<br>앱 안에서 지갑 연결과 Mustree 네트워크 추가·전환을 승인해 주세요.</p><a class="operator-primary app-handoff" href="${esc(appUrl)}">앱에서 ${copy.verb} 이어하기</a><p class="screen-description">앱이 없나요? 앱을 설치하고 지갑을 생성하거나 기존 지갑을 가져와 주세요.<br><strong>설치·계정 생성 후 이 브라우저의 현재 탭으로 돌아와 위의 이어하기 버튼을 눌러주세요.</strong><br>받는 주소와 입력한 금액을 그대로 이어갑니다. 이 탭을 닫지 마세요.</p><a class="operator-secondary" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">MetaMask 설치하기</a><p class="screen-description">앱이 열리지 않으면 Safari 또는 Chrome에서 이 페이지를 열고 다시 눌러주세요.</p></div>`;
    const insufficient = state.insufficient && kind === 'payment';
    const form = `<fieldset class="transfer-fields"${state.busy ? ' disabled' : ''}><div class="operator-title"><h1>${copy.title}</h1></div><div class="recipient-card">${recipient}<div class="store-inline-actions"><button type="button" data-transfer="scan">${state.recipient ? 'QR 다시 스캔' : 'QR 스캔하기'}</button><button type="button" data-transfer="manual">주소 직접 입력</button></div></div>${kind === 'topup' ? `<div class="preset-grid">${[5000,10000,30000,50000].map(value => `<button type="button" data-transfer-won="${value}">${won(value)}원</button>`).join('')}</div>` : ''}<label class="amount-input"><span>${copy.amount}</span><div><input id="transferAmount" type="text" inputmode="numeric" value="${esc(state.value || '')}" placeholder="0" autocomplete="off"><b>${unit}</b></div></label><div class="payment-details pay-transfer-details"><div class="detail-row"><span>내 잔액</span><strong>${mst(state.balanceWei)}</strong></div><div class="detail-row total"><span>${copy.verb}할 MST</span><strong>${total}</strong></div></div>${insufficient ? '' : alert(state.status)}${button(!state.recipient ? '받는 QR을 스캔해 주세요.' : !amount ? '금액을 입력해 주세요.' : `${total} ${copy.verb}하기`, 'submit', { disabled:!state.recipient || !amount || state.busy })}</fieldset>`;
    return form + (state.walletBlocked ? button('지갑 연결 다시 시도', 'connect', { secondary:true, disabled:state.busy }) : '') + (insufficient ? `<dialog class="balance-dialog" aria-labelledby="balanceDialogTitle" aria-describedby="balanceDialogAmount"><h2 id="balanceDialogTitle">잔액이 부족합니다.</h2><p id="balanceDialogAmount">현재 잔액: <strong>${mst(state.balanceWei)}</strong></p>${button('충전하기', 'topup')}<button type="button" class="balance-dialog-close" data-transfer="dismiss-insufficient" aria-label="닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></dialog>` : '');
  }
  function showBalanceDialog(container, onDismiss) {
    const dialog = container.querySelector('.balance-dialog');
    if (!dialog) return;
    dialog.addEventListener('cancel', event => { event.preventDefault(); onDismiss(); });
    dialog.showModal();
  }
  function history({ items = [], loading = false, error = '' } = {}, { compact = false } = {}) {
    let content;
    if (items.length) content = `<div class="store-history-list">${items.map(item => `<div class="store-history-row"><time>${new Date(item.timestamp * 1000).toLocaleString('ko-KR', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}</time><strong class="${item.direction === 'in' ? 'in' : 'out'}">${item.direction === 'in' ? '+' : '−'}${mst(item.valueWei)}</strong><span>${item.balanceWei == null ? '—' : mst(item.balanceWei)}</span></div>`).join('')}</div>`;
    else content = !loading && !error ? '<p class="store-empty">아직 거래 내역이 없어요.</p>' : '';
    if (loading) content += `<p class="${items.length ? 'history-status' : 'store-empty'}" role="status">${items.length ? '최근 내역을 확인하고 있어요.' : '거래 내역을 불러오고 있어요.'}</p>`;
    if (error) content += `<p class="history-status" role="status">${esc(error)}</p><button type="button" class="text-button" data-history-refresh${loading ? ' disabled' : ''}>다시 확인</button>`;
    return `<section class="store-history${compact ? ' home-history' : ''}"><h2>최근 거래</h2><div class="store-history-head"><span>시간</span><span>금액</span><span>잔액</span></div>${content}</section>`;
  }
  function balance({ account, balanceWei, failed = false, copyAttributes = '', refreshAttributes = '' }) {
    return `<div class="balance-panel"><div class="balance-wallet-row"><code>${esc(short(account))}</code><button type="button" ${copyAttributes}>복사하기</button></div><div class="balance-amount-row"><div class="balance-number">${failed ? '—' : mst(balanceWei, false)}${failed ? '' : '<span>MST</span>'}</div><button type="button" class="balance-refresh" aria-label="잔액 새로고침" title="잔액 새로고침" ${refreshAttributes}><svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/></svg></button></div><div class="balance-krw">${failed ? '잔액을 확인하지 못했어요.' : (balanceWei == null ? '—' : won(balanceWei)) + '원 상당'}</div></div>`;
  }
  function qrMarkup(id, caption = '받기 QR') {
    return `<div id="${esc(id)}" class="live-qr" role="img" aria-label="${esc(caption)}"></div>`;
  }
  function receiveAddress(value) {
    if (!value) return '';
    return `<div class="live-address"><code class="receive-address">${esc(short(value))}</code></div>`;
  }
  function renderQr(target, text, { preview = false, QRCode = globalThis.QRCode } = {}) {
    if (!target) return;
    target.innerHTML = '';
    if (preview) { target.innerHTML = '<div class="qr-skeleton-content"><span></span><strong>미리보기 QR</strong><small>실제 송금에 사용할 수 없어요</small></div>'; return; }
    if (!text || typeof QRCode !== 'function') { target.textContent = 'QR을 표시하지 못했어요.'; return; }
    new QRCode(target, { text, width:210, height:210, colorDark:'#233d35', colorLight:'#fff', correctLevel:QRCode.CorrectLevel.M });
  }
  // Error texts identify the failure for testing; the top-up (operator) variants may name chain concepts.
  function errorText(code, kind = 'payment') {
    const operator = kind === 'topup';
    return ({ 4001:'송금이 취소됐어요. 준비되면 다시 시도해 주세요.', '-32002':'MetaMask에 대기 중인 승인 요청을 확인해 주세요.', 4900:'MetaMask 연결이 끊겼어요. 지갑 연결 다시 시도를 눌러주세요.', 4901:'현재 네트워크에 연결하지 못했어요. 지갑 연결 다시 시도를 눌러주세요.', READ_TIMEOUT:'지갑 응답이 지연되고 있어요. 진단 기록을 확인해 주세요.', INVALID_RECEIPT:'거래 결과를 확인하지 못했어요. 기존 거래 결과를 다시 확인해 주세요.', INVALID_ADDRESS:'받는 지갑 주소를 확인해 주세요.', INVALID_AMOUNT:'송금할 금액을 확인해 주세요.', NO_ACCOUNT:'지갑을 연결해 주세요.', ACCOUNT_CHANGED:'지갑 계정이 바뀌었어요. 다시 확인해 주세요.', WRONG_CHAIN:'Mustree 네트워크로 다시 연결해 주세요.',
      INSUFFICIENT_BALANCE:operator ? '충전 지갑의 wMST 잔액이 부족해요. 운영 지갑에서 wMST를 보충해 주세요.' : '잔액이 부족해요.',
      RPC_UNAVAILABLE:'지갑 통신이 불안정해요. 와이파이·모바일 데이터를 바꾼 뒤 다시 시도해 주세요.',
      INSUFFICIENT_GAS:operator ? '충전 지갑의 수수료용 MST가 부족해요. 운영 지갑에서 MST를 보충해 주세요.' : '수수료 잔액이 부족해요. 직원에게 충전을 요청해 주세요.',
      TOKEN_NOT_CONFIGURED:operator ? '발행된 wMST 주소가 아직 설정되지 않았어요. setup 페이지의 설정값을 반영해 주세요.' : '서비스 준비가 아직 끝나지 않았어요. 직원에게 문의해 주세요. (설정 없음)',
      TRANSACTION_FAILED:'송금이 완료되지 않았어요. 다시 시도해 주세요.', RECEIPT_TIMEOUT:'확인이 지연되고 있어요. 기존 거래 결과를 다시 확인해 주세요.', PENDING_TRANSACTION:'기존 거래 결과를 먼저 확인해 주세요.' })[code] || '처리하지 못했어요. 다시 확인해 주세요.';
  }
  return { esc, short, mst, won, button, alert, receiveTitle, transfer, showBalanceDialog, history, balance, qrMarkup, receiveAddress, renderQr, errorText };
});
