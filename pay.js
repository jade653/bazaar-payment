(function () {
  'use strict';
  const Wallet = window.BazaarWallet, Payment = window.BazaarPayment;
  const screen = document.getElementById('payScreen');
  const scanner = document.getElementById('payScanner'), video = document.getElementById('payVideo'), canvas = document.getElementById('payCanvas');
  const params = new URL(location.href).searchParams;
  let discovery, controller, provider, readBalanceFromRpc, stream, frame, busy = false, intent = false;
  let state = { step: params.get('scan') === '1' ? 'scan' : 'detail', account: null, balanceWei: null, recipient: Payment.parseMerchant(params.get('to')), merchantName: (params.get('name') || '').trim().slice(0,30), won: params.get('won') || '', status: '', hash: null };
  if (!state.recipient && state.step !== 'scan') state.step = 'scan';
  const short = value => value ? `${value.slice(0,8)}…${value.slice(-6)}` : '';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const button = (label, action, secondary = false, disabled = false) => `<button class="${secondary ? 'operator-secondary' : 'operator-primary'}" data-pay="${action}" type="button"${disabled ? ' disabled' : ''}>${label}</button>`;
  function units() {
    if (state.balanceWei === null) return '— MST';
    const step = 10n ** 15n, raw = BigInt(state.balanceWei);
    const rounded = ((raw + step / 2n) / step) * step;
    const value = Wallet.units(rounded), parts = value.split('.');
    return `${Number(parts[0]).toLocaleString('ko-KR')}${parts[1] ? '.' + parts[1].slice(0,3) : ''} MST`;
  }
  function error(code) {
    return ({ INVALID_AMOUNT:'결제 금액을 확인해 주세요.', INVALID_ADDRESS:'올바른 가게 QR이 아니에요.', INSUFFICIENT_BALANCE:'MST가 부족해요.', ACCOUNT_CHANGED:'지갑 계정이 바뀌었어요. 다시 연결해 주세요.', WRONG_CHAIN:'Mustree 네트워크로 다시 연결해 주세요.', TRANSACTION_FAILED:'결제가 완료되지 않았어요.', RECEIPT_TIMEOUT:'확인이 지연되고 있어요. 다시 결제하지 말고 결과를 확인해 주세요.' })[code] || '처리하지 못했어요. 다시 시도해 주세요.';
  }
  function render() {
    if (state.step === 'scan') {
      screen.innerHTML = `<div class="operator-center"><span class="operator-spinner"></span><h1>카메라를 열고 있어요.</h1><p>잠시만 기다려 주세요.</p></div>`;
      return;
    }
    if (state.step === 'manual') {
      screen.innerHTML = `<button class="operator-back" type="button" data-pay="scan">← QR 스캔</button><div class="operator-title"><span>PAYMENT</span><h1>가게 주소를<br>입력해 주세요.</h1></div><div class="manual-entry"><label for="payManualAddress">받는 가게 주소</label><div><input id="payManualAddress" type="text" inputmode="text" placeholder="0x 지갑 주소 붙여넣기" autocomplete="off"><button type="button" data-pay="manual">확인</button></div></div><label class="operator-secondary file-button">QR 이미지 선택<input id="payQrFile" type="file" accept="image/*" hidden></label>${state.status ? `<p class="operator-alert">${state.status}</p>` : ''}<a class="pay-home-link" href="/">내 지갑으로 돌아가기</a>`;
      return;
    }
    if (state.step === 'sending') {
      screen.innerHTML = `<div class="operator-center"><span class="operator-spinner"></span><h1>${state.hash ? '결제를 확인하고 있어요.' : 'MetaMask에서 확인을 눌러주세요.'}</h1><p>${state.status || (state.hash ? '같은 결제를 다시 요청하지 마세요.' : '가게 주소와 금액을 확인해 주세요.')}</p>${state.hash ? `<code>${state.hash}</code>` : ''}</div>${state.hash && state.status ? button('결과 다시 확인','check') : ''}`;
      return;
    }
    if (state.step === 'success') {
      const amount = Payment.amountFromWon(state.won);
      screen.innerHTML = `<div class="operator-success"><div class="success-mark">✓</div><span>결제 완료</span><h1>${Number(amount.won).toLocaleString('ko-KR')}원</h1><p>${amount.mstText} MST를<br>${short(state.recipient)} 가게에 보냈어요.</p><code>${state.hash}</code></div><a class="operator-primary pay-link-button" href="/">내 지갑으로</a>`;
      return;
    }
    let amount = null; try { amount = Payment.amountFromWon(state.won); } catch {}
    screen.innerHTML = `<button class="operator-back" type="button" data-pay="back">← QR 다시 스캔</button><div class="operator-title"><span>PAYMENT</span><h1>얼마를<br>결제할까요?</h1></div><div class="recipient-card"><small>${state.merchantName ? '받는 가게' : '받는 가게 주소'}</small><strong>${state.merchantName ? esc(state.merchantName) : short(state.recipient)}</strong>${state.merchantName ? `<span>${short(state.recipient)}</span>` : ''}<code>${state.recipient}</code></div><label class="amount-input"><span>결제 금액</span><div><input id="payWon" type="text" inputmode="numeric" value="${state.won}" placeholder="0"><b>원</b></div></label><div class="payment-details pay-transfer-details"><div class="detail-row"><span>내 잔액</span><strong>${units()}</strong></div><div class="detail-row total"><span>송금할 MST</span><strong>${amount ? amount.mstText : '0'} MST</strong></div></div>${state.status ? `<p class="operator-alert">${state.status}</p>` : ''}${button(amount ? (state.account ? `${Number(amount.won).toLocaleString('ko-KR')}원 결제하기` : 'MetaMask로 결제하기') : '금액을 입력해 주세요.','submit',false,!amount)}`;
  }
  function set(next) { const previous = state.step; state = { ...state, ...next }; render(); if (state.step === 'scan' && previous !== 'scan') setTimeout(() => void startScan(), 0); }
  function onWallet(snapshot) {
    if (snapshot.status === 'ready') {
      set({ account:snapshot.account, balanceWei:snapshot.balanceWei, status:'' });
      if (intent) { intent = false; void submit(); }
    } else if (['connecting','adding','switching','pending','querying'].includes(snapshot.status)) set({ status:'MetaMask에서 확인을 눌러주세요.' });
    else if (snapshot.status === 'cancelled') { intent=false; set({ status:'연결이 취소됐어요.' }); }
    else if (snapshot.status !== 'idle' && snapshot.status !== 'unavailable') set({ status:'지갑을 연결하지 못했어요.' });
  }
  function accept(raw) {
    const recipient = Payment.parseMerchant(raw, location.origin);
    if (!recipient) { set({ status:'올바른 가게 QR이 아니에요.' }); return false; }
    let merchantName='';try{const url=new URL(raw,location.origin);merchantName=(url.searchParams.get('name')||'').trim().slice(0,30);}catch{}
    stopScan(); set({ step:'detail', recipient, merchantName, status:'' }); return true;
  }
  function scanImage(source) {
    const context=canvas.getContext('2d',{willReadFrequently:true});canvas.width=source.videoWidth||source.naturalWidth;canvas.height=source.videoHeight||source.naturalHeight;context.drawImage(source,0,0,canvas.width,canvas.height);const image=context.getImageData(0,0,canvas.width,canvas.height);return jsQR(image.data,image.width,image.height,{inversionAttempts:'dontInvert'})?.data||null;
  }
  function scanLoop(){if(!stream)return;if(video.readyState>=2){try{const data=scanImage(video);if(data&&accept(data))return;}catch{}}frame=requestAnimationFrame(scanLoop);}
  async function startScan(){if(stream)return;if(!navigator.mediaDevices?.getUserMedia){set({step:'manual',status:'카메라를 열 수 없어요. 주소를 직접 입력해 주세요.'});return;}try{stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}});video.srcObject=stream;scanner.hidden=false;await video.play();scanLoop();}catch{set({step:'manual',status:'카메라 권한을 허용하거나 주소를 직접 입력해 주세요.'});}}
  function stopScan(){if(frame)cancelAnimationFrame(frame);frame=null;stream?.getTracks().forEach(track=>track.stop());stream=null;video.srcObject=null;scanner.hidden=true;}
  async function readFile(file){if(!file)return;try{const image=new Image();image.src=URL.createObjectURL(file);await image.decode();const data=scanImage(image);URL.revokeObjectURL(image.src);if(!data||!accept(data))set({status:'QR에서 가게 주소를 찾지 못했어요.'});}catch{set({status:'QR 이미지를 읽지 못했어요.'});}}
  function openMetaMask(){const path=Payment.paymentPath(state.recipient,state.won);location.assign(`https://link.metamask.io/dapp/bazaar.mustree.kr${path}`);}
  async function submit(){if(busy)return;let amount;try{amount=Payment.amountFromWon(state.won);}catch{set({status:error('INVALID_AMOUNT')});return;}provider=provider||await discovery.getProvider();if(!provider){openMetaMask();return;}if(!state.account){intent=true;await controller.setup();return;}busy=true;set({step:'sending',status:'',hash:null});try{const prepared=await Payment.prepare(provider,{account:state.account,recipient:state.recipient,won:amount.won,chainId:Wallet.NETWORK.chainId,readBalanceFromRpc});const hash=await provider.request({method:'eth_sendTransaction',params:[prepared.transaction]});set({hash});await Payment.waitForReceipt(provider,hash);set({step:'success',hash});await controller.refresh();}catch(e){if(e?.code===4001)set({step:'detail',status:'결제가 취소됐어요.'});else if(state.hash||e?.code==='RECEIPT_TIMEOUT')set({step:'sending',status:error(e?.code)});else set({step:'detail',status:error(e?.code)});}finally{busy=false;}}
  async function check(){if(busy||!state.hash)return;busy=true;set({status:''});try{await Payment.waitForReceipt(provider,state.hash);set({step:'success'});}catch(e){set({step:'sending',status:error(e?.code)});}finally{busy=false;}}
  function openManual(){stopScan();set({step:'manual',recipient:null,won:'',status:''});}
  function click(event){const target=event.target.closest('[data-pay]');if(!target||target.disabled)return;const action=target.dataset.pay;if(action==='scan')set({step:'scan',status:''});else if(action==='manual')accept(document.getElementById('payManualAddress')?.value||'');else if(action==='back')set({step:'scan',recipient:null,won:'',status:''});else if(action==='submit')void submit();else if(action==='check')void check();}
  function init(){discovery=Wallet.discover(window);readBalanceFromRpc=Wallet.createRpcBalanceReader({fetchImpl:window.fetch.bind(window)});controller=Wallet.createWallet({getProvider:()=>discovery.getProvider(),onState:onWallet,readBalanceFromRpc});screen.addEventListener('click',click);screen.addEventListener('input',event=>{if(event.target.id==='payWon'){state.won=event.target.value.replace(/[^0-9]/g,'');render();const input=document.getElementById('payWon');input?.focus();input?.setSelectionRange(input.value.length,input.value.length);}});screen.addEventListener('change',event=>{if(event.target.id==='payQrFile')void readFile(event.target.files?.[0]);});document.getElementById('payScannerClose').onclick=openManual;document.getElementById('payScannerManual').onclick=openManual;window.addEventListener('pagehide',()=>{stopScan();controller.dispose();discovery.dispose();});render();if(state.step==='scan')void startScan();void controller.restore();}
  init();
})();
