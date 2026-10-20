'use strict';

// This file owns preview mode. Live wallet behavior is isolated in live.js/wallet.js.
const preview = new URLSearchParams(location.search).has('preview');
const UI = BazaarUI;
const previewAccount = '0x' + '1'.repeat(40);
const previewRecipient = '0x' + '2'.repeat(40);
const toWei = value => BigInt(Math.round(value * 1000)) * 10n ** 15n;
document.body.classList.toggle('is-preview', preview);
const mainStates = [
  {id:'welcome',title:'01 시작',description:'앱 설치와 계정 생성 후 바자회로 돌아오는 방법을 안내합니다.'},
  {id:'opening',title:'02 앱 열기',description:'설치와 계정 생성을 마친 뒤 바자회 이어하기로 돌아옵니다.'},
  {id:'connect',title:'03 준비 중',description:'기존 5~7번을 같은 화면으로 통합했습니다. 진입 즉시 요청 대기, Confirm만 누르면 다음 단계로 이어집니다.'},
  {id:'home',title:'04 내 지갑',description:'잔액과 충전·결제만 표시합니다.'},
  {id:'receive',title:'05 충전',description:'직원에게 QR을 보여줍니다. 수령하면 잔액으로 돌아갑니다.'},
  {id:'pay-manual',title:'06 결제',description:'가게 주소가 없으면 같은 화면에서 QR을 촬영하고 결제 금액을 입력합니다.'},
  {id:'payment-success',title:'07 완료',description:'거래 성공을 확인한 다음에만 완료 화면을 표시합니다.'},
];
const extraStates = [
  {id:'network-add',title:'추가 승인 대기',description:'준비 화면에서 네트워크 추가 요청을 보낸 상황.'},
  {id:'network-switch',title:'전환 승인 대기',description:'준비 화면에서 네트워크 전환 요청을 보낸 상황.'},
  {id:'setup-cancelled',title:'준비 취소',description:'같은 준비 화면에 다시 요청 버튼만 표시합니다.'},
  {id:'connection-error',title:'확인 창이 안 뜸',description:'요청을 다시 보낼 수 있습니다. 이미 대기 중이면 중복 요청하지 않습니다.'},
  {id:'empty',title:'잔액 0',description:'잔액 화면에서 충전 버튼을 강조합니다.'},
  {id:'balance-error',title:'잔액 조회 실패',description:'잔액을 0으로 표시하지 않고 같은 화면에서 재시도합니다.'},
  {id:'topup-waiting',title:'충전 대기',description:'충전 화면에서 수령을 기다립니다.'},
  {id:'payment-prepare',title:'결제 전 준비 필요',description:'가게·금액을 유지한 채 준비 후 결제 화면으로 돌아옵니다.'},
  {id:'insufficient',title:'잔액 부족',description:'결제 화면 안에서 충전 안내를 표시합니다.'},
  {id:'payment-approval',title:'결제 승인 대기',description:'결제 요청 후 사용자는 MetaMask Confirm만 누릅니다.'},
  {id:'payment-cancelled',title:'결제 취소',description:'가게·금액을 유지한 채 다시 결제할 수 있습니다.'},
  {id:'payment-pending',title:'결제 처리 중',description:'새 송금 버튼 없이 결과를 기다립니다.'},
  {id:'payment-unknown',title:'결과 확인 지연',description:'새 송금 대신 기존 거래 결과만 다시 확인합니다.'},
  {id:'payment-failed',title:'결제 실패',description:'실패 확인 후에만 다시 결제할 수 있습니다.'},
];
const allStates=[...mainStates,...extraStates];
const phaseStates=['connect','network-add','network-switch'];
const paymentStates=['pay','pay-manual','payment-prepare','insufficient','payment-approval','payment-cancelled','payment-pending','payment-unknown','payment-failed'];
const aliases={install:'welcome',create:'welcome',pay:'pay-manual',scan:'pay-manual','balance-loading':'connect'};
const appScreen=document.getElementById('appScreen');
const stateSelect=document.getElementById('stateSelect');
let currentId='welcome';
let phase='connect';
let amount=5000;
let balance=0;
let paymentIntent=false;
let requestPending=false;
let showRetry=false;
let retryReason='';
let requestTimer;
let progressTimer;
let paymentCompleted=false;
let chargeCompleted=false;
let merchantReady=false;
let previewManual=false, previewManualAddress='', previewTarget=previewRecipient, previewStatus='';
let previewScanner;
const points=()=>amount/1000;
const action=(label,kind='primary',data='')=>`<button type="button" class="${kind}" ${data}>${label}</button>`;
const goButton=(label,id,kind='primary')=>action(label,kind,`data-go="${id}"`);
const actions=(...items)=>`<div class="actions">${items.join('')}</div>`;
const title=(text,description='')=>`<h1 class="screen-title">${text}</h1>${description?`<p class="screen-description">${description}</p>`:''}`;
const spinner='<span class="spinner" aria-hidden="true"></span>';

function prepareScreen(){
  const loading=phase==='query';
  return `<div class="center-state">${illustration('phone')}${title(loading?'잔액을 확인하고 있어요.':'잠깐만요,<br>사용할 준비 중이에요.',loading?'곧 보여드릴게요.':'MetaMask에서 확인을 눌러주세요.')}<div class="waiting-indicator">${spinner}<span>${loading?'확인 중':'확인 기다리는 중'}</span></div></div>`+
    (showRetry?actions(`<p class="retry-message">${retryReason||'확인 창이 보이지 않나요?'}</p>`,action('다시 요청','secondary','data-action="retry-prepare"')):'');
}

function balanceScreen(){
  const failed=currentId==='balance-error';
  return title('내 지갑')+UI.balance({account:previewAccount,balanceWei:toWei(balance),failed,copyAttributes:'data-action="copy-preview-wallet"'})+
    (failed?`<div class="balance-actions single">${action('다시 확인','primary','data-action="retry-balance"')}</div>`:`<div class="balance-actions">${goButton('충전하기','receive')}${goButton('가게 결제하기','pay-manual','secondary')}<a class="home-store-link" href="store.html?preview=1">내 가게</a></div>${UI.history({items:[{timestamp:Date.now()/1000-300,direction:'out',valueWei:toWei(2),balanceWei:toWei(11)},{timestamp:Date.now()/1000-600,direction:'in',valueWei:toWei(5.5),balanceWei:toWei(13)}]},{compact:true})}`);
}

function receiveScreen(){
  return title('현금 결제 후 직원에게<br>이 QR을 보여주세요.')+UI.qrMarkup('previewQr','내 지갑 주소 QR 코드')+
    (currentId==='topup-waiting'?`<div class="incoming">${spinner}<span>충전을 확인하고 있어요.</span></div>`:'')+
    actions(goButton('내 지갑으로',balance>0?'home':'empty','secondary'));
}

function paymentScreen(){
  const sending=['payment-approval','payment-pending','payment-unknown'].includes(currentId);
  let parsed=null;try{parsed=BazaarTransfer.parseAmount(amount);}catch{}
  const status=currentId==='payment-cancelled'?UI.errorText(4001):currentId==='payment-failed'?UI.errorText('TRANSACTION_FAILED'):currentId==='payment-unknown'?UI.errorText('RECEIPT_TIMEOUT'):currentId==='insufficient'?UI.errorText('INSUFFICIENT_BALANCE'):previewStatus;
  return UI.transfer({step:sending?'sending':'form',recipient:merchantReady?previewTarget:null,manual:previewManual,manualAddress:previewManualAddress,value:String(amount||''),balanceWei:toWei(balance),hash:sending&&currentId!=='payment-approval'?'0x'+'a'.repeat(64):null,status:currentId==='payment-approval'&&showRetry?retryReason:status,retry:currentId==='payment-approval'&&showRetry,insufficient:currentId==='insufficient'},{kind:'payment',amount:parsed});
}

function renderScreen(){
  if(phaseStates.includes(currentId)||['setup-cancelled','connection-error'].includes(currentId))return prepareScreen();
  if(['home','empty','balance-error'].includes(currentId))return balanceScreen();
  if(['receive','topup-waiting'].includes(currentId))return receiveScreen();
  if(paymentStates.includes(currentId))return paymentScreen();
  if(currentId==='opening')return `<div class="center-state">${illustration('phone')}${title('준비되면 이어가세요.','계정 생성 후 이 페이지로 돌아와<br>‘바자회 이어하기’를 눌러주세요.')}</div>`+actions(goButton('바자회 이어하기','connect'),goButton('앱 설치하기','opening','secondary'));
  if(currentId==='payment-success')return UI.transfer({step:'success',recipient:previewTarget,value:String(amount),hash:'0x'+'a'.repeat(64)},{kind:'payment',amount:BazaarTransfer.parseAmount(amount)});
  return title('MST로<br>즐거운 바자회.')+illustration('coin')+actions('<p class="screen-description center-state">바자회를 이용하려면<br>앱 설치가 필요해요.</p>',goButton('1. 앱 설치하기','opening','secondary'),goButton('2. 바자회 이어하기','opening'),'<p class="screen-description center-state">계정 생성 후 이 페이지로 돌아와<br>이어하기 버튼을 눌러주세요.</p>');
}

function clearTimers(){clearTimeout(requestTimer);clearTimeout(progressTimer);}
function updateLab(){
  const state=allStates.find(s=>s.id===currentId)||mainStates[0];
  document.getElementById('stateTitle').textContent=state.title;
  document.getElementById('stateDescription').textContent=state.description;
  document.querySelectorAll('[data-state]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.state===currentId)));
  stateSelect.value=currentId;
  const index=allStates.indexOf(state);
  document.getElementById('stateCounter').textContent=`${index+1} / ${allStates.length}`;
  document.getElementById('previousState').disabled=index===0;
  document.getElementById('nextState').disabled=index===allStates.length-1;
  const approval=phase!=='query'&&(phaseStates.includes(currentId)||['setup-cancelled','connection-error','payment-approval'].includes(currentId));
  document.getElementById('approvalControls').hidden=!approval;
  document.getElementById('approveDemo').disabled=!requestPending;
  document.getElementById('continueFlow').hidden=approval;
  document.getElementById('continueFlow').textContent=currentId==='topup-waiting'?'충전 완료로 보기':'다음 단계로 보기';
  // Request phase is visible only in the developer panel, never in participant copy.
  if(approval)document.getElementById('stateDescription').textContent=state.description+' 현재 요청: '+(currentId==='payment-approval'?'결제':phase==='connect'?'계정 연결':phase==='network-switch'?'네트워크 전환':'네트워크 추가');
}
function paint(){appScreen.innerHTML=renderScreen();if(['receive','topup-waiting'].includes(currentId))UI.renderQr(document.getElementById('previewQr'),null,{preview:true});updateLab();}
function beginRequest(){
  requestPending=true;showRetry=false;retryReason='';
  paint();
  requestTimer=setTimeout(()=>{showRetry=true;paint();},8000);
}
function go(id){
  previewScanner?.stop();
  clearTimers();currentId=aliases[id]||id;
  if(!allStates.some(s=>s.id===currentId))currentId='welcome';
  showRetry=false;retryReason='';requestPending=false;
  if(currentId==='empty')balance=0;
  if(phaseStates.includes(currentId)){phase=currentId;beginRequest();}
  else if(currentId==='setup-cancelled'||currentId==='connection-error'){
    phase='connect';showRetry=true;retryReason=currentId==='setup-cancelled'?'이어서 준비할 수 있어요.':'확인 창이 보이지 않나요?';paint();
  }else if(currentId==='payment-approval')beginRequest();
  else paint();
  history.replaceState(null,'','#'+currentId);
}
function queryBalance(){
  clearTimers();requestPending=false;currentId='connect';phase='query';showRetry=false;paint();
  progressTimer=setTimeout(()=>go(paymentIntent?'pay':balance>0?'home':'empty'),700);
}
function approve(){
  if(!requestPending)return;
  if(currentId==='payment-approval'){go('payment-pending');return;}
  if(phase==='connect')go('network-add');else queryBalance();
}
function cancelApproval(missing=false){
  if(currentId==='payment-approval'&&!missing){go('payment-cancelled');return;}
  clearTimers();requestPending=false;showRetry=true;retryReason=missing?'확인 창이 보이지 않나요?':'이어서 진행할 수 있어요.';paint();
}
function retry(){
  if(requestPending){retryReason='MetaMask에서 확인을 눌러주세요.';paint();return;}
  go(currentId==='payment-approval'?'payment-approval':phaseStates.includes(phase)?phase:'connect');
}
function finishPayment(){
  if(!paymentCompleted){balance=Math.max(0,balance-points());paymentCompleted=true;}
  paymentIntent=false;go(balance>0?'home':'empty');
}
function selectState(id){
  amount=5000;balance=id==='empty'?0:id==='insufficient'?3:11;
  previewManual=false;previewManualAddress='';previewTarget=previewRecipient;previewStatus='';
  merchantReady=id!=='pay-manual';
  paymentIntent=false;paymentCompleted=false;chargeCompleted=false;go(id);
}
function nextFlow(){
  switch(currentId){
    case'welcome':go('opening');break;
    case'opening':go('connect');break;
    case'home':case'empty':go('receive');break;
    case'receive':go('topup-waiting');break;
    case'topup-waiting':if(!chargeCompleted){balance+=11;chargeCompleted=true;}go(paymentIntent?'pay':'home');break;
    case'payment-pending':case'payment-unknown':go('payment-success');break;
    case'payment-success':finishPayment();break;
    case'balance-error':queryBalance();break;
    default:if(paymentStates.includes(currentId))requestPayment();break;
  }
}
function requestPayment(){
  if(!merchantReady||!Number.isSafeInteger(amount)||amount<=0)return;
  try{BazaarTransfer.parseAmount(amount);}catch{return;}
  if(currentId==='payment-prepare'){paymentIntent=true;go('connect');return;}
  if(currentId==='payment-unknown'){go('payment-pending');return;}
  if(points()>=balance){go('insufficient');return;}
  paymentCompleted=false;go('payment-approval');
}

function openPreviewManual(){merchantReady=false;previewManual=true;previewManualAddress='';previewStatus='';paint();}
function acceptPreviewRecipient(raw){
  const recipient=BazaarTransfer.parseRecipient(raw);
  if(!recipient){previewStatus=UI.errorText('INVALID_ADDRESS');paint();return false;}
  previewTarget=recipient;merchantReady=true;previewManual=false;previewStatus='';previewScanner?.stop();paint();return true;
}

for(const [list,target] of [[mainStates,'stateNav'],[extraStates,'extraStates']]){
  const group=document.createElement('optgroup');group.label=target==='stateNav'?'기본 화면':'다른 상황';
  for(const state of list){
    document.getElementById(target).insertAdjacentHTML('beforeend',`<button class="state-item" data-state="${state.id}" type="button" aria-current="false">${state.title}</button>`);
    const option=document.createElement('option');option.value=state.id;option.textContent=state.title;group.append(option);
  }
  stateSelect.append(group);
}
document.addEventListener('click',event=>{
  if(!preview)return;
  const b=event.target.closest('button');if(!b||b.disabled)return;
  if(b.dataset.state){selectState(b.dataset.state);return;}
  if(b.dataset.go){if(b.dataset.go==='pay-manual')merchantReady=false;go(b.dataset.go);return;}
  if(b.dataset.transfer){
    switch(b.dataset.transfer){
      case'scan':
        previewScanner ||= BazaarScanner.create({preview:true,onAccept:acceptPreviewRecipient,onPreview:()=>acceptPreviewRecipient(previewRecipient),onManual:openPreviewManual,onError:status=>{previewStatus=status;paint();}});
        void previewScanner.start();break;
      case'manual':openPreviewManual();break;
      case'accept':acceptPreviewRecipient(previewManualAddress);break;
      case'submit':requestPayment();break;
      case'check':go('payment-pending');break;
      case'retry':retry();break;
      case'done':finishPayment();break;
      case'topup':paymentIntent=true;chargeCompleted=false;go('receive');break;
    }
    return;
  }
  switch(b.dataset.action){
    case'retry-prepare':retry();break;
    case'retry-balance':queryBalance();break;
    case'copy-preview-wallet':b.textContent='복사했어요';break;
  }
});
appScreen.addEventListener('input',event=>{
  if(!preview)return;
  if(event.target.id==='transferRecipient'){previewManualAddress=event.target.value;return;}
  if(event.target.id!=='transferAmount')return;
  const cursor=event.target.selectionStart;
  const value=Number(event.target.value.replace(/[^0-9]/g,''));amount=Number.isSafeInteger(value)&&value>0?value:0;
  paint();const input=document.getElementById('transferAmount');input?.focus();input?.setSelectionRange(cursor,cursor);
});
stateSelect.addEventListener('change',()=>selectState(stateSelect.value));
document.getElementById('approveDemo').addEventListener('click',approve);
document.getElementById('cancelDemo').addEventListener('click',()=>cancelApproval());
document.getElementById('missingDemo').addEventListener('click',()=>cancelApproval(true));
document.getElementById('continueFlow').addEventListener('click',nextFlow);
document.getElementById('previousState').addEventListener('click',()=>selectState(allStates[Math.max(0,allStates.findIndex(s=>s.id===currentId)-1)].id));
document.getElementById('nextState').addEventListener('click',()=>selectState(allStates[Math.min(allStates.length-1,allStates.findIndex(s=>s.id===currentId)+1)].id));
document.getElementById('resetButton').addEventListener('click',()=>{selectState('welcome');balance=0;});
window.addEventListener('hashchange',()=>{if(preview)selectState(location.hash.slice(1));});
if(preview){window.addEventListener('pagehide',()=>previewScanner?.stop());if(location.hash)selectState(location.hash.slice(1));else go('welcome');}
else BazaarLive.create({Wallet:BazaarWallet,illustration}).init();
