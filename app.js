'use strict';

// This file owns preview mode. Live wallet behavior is isolated in live.js/wallet.js.
const preview = new URLSearchParams(location.search).has('preview');
document.body.classList.toggle('is-preview', preview);
const mainStates = [
  {id:'welcome',title:'01 시작',description:'설치 안내는 한 화면만. 기술 설명 없이 시작합니다.'},
  {id:'opening',title:'02 앱 열기',description:'앱으로 넘어가는 화면. 이동하지 못하면 눌러서 이동합니다.'},
  {id:'connect',title:'03 준비 중',description:'기존 5~7번을 같은 화면으로 통합했습니다. 진입 즉시 요청 대기, Confirm만 누르면 다음 단계로 이어집니다.'},
  {id:'home',title:'04 내 달란트',description:'잔액과 충전·결제만 표시합니다.'},
  {id:'receive',title:'05 충전',description:'직원에게 QR을 보여줍니다. 수령하면 잔액으로 돌아갑니다.'},
  {id:'pay',title:'06 결제',description:'받는 곳과 금액만 확인합니다. 승인·처리 중도 같은 화면입니다.'},
  {id:'payment-success',title:'07 완료',description:'성공을 확인한 다음에만 완료 화면을 표시합니다.'},
];
const extraStates = [
  {id:'network-add',title:'추가 승인 대기',description:'준비 화면에서 네트워크 추가 요청을 보낸 상황.'},
  {id:'network-switch',title:'전환 승인 대기',description:'준비 화면에서 네트워크 전환 요청을 보낸 상황.'},
  {id:'setup-cancelled',title:'준비 취소',description:'같은 준비 화면에 다시 요청 버튼만 표시합니다.'},
  {id:'connection-error',title:'확인 창이 안 뜸',description:'요청을 다시 보낼 수 있습니다. 이미 대기 중이면 중복 요청하지 않습니다.'},
  {id:'empty',title:'잔액 0',description:'잔액 화면에서 충전 버튼을 강조합니다.'},
  {id:'balance-error',title:'잔액 조회 실패',description:'잔액을 0으로 표시하지 않고 같은 화면에서 재시도합니다.'},
  {id:'topup-waiting',title:'충전 대기',description:'충전 화면에서 수령을 기다립니다.'},
  {id:'pay-manual',title:'금액 입력',description:'금액 없는 부스 QR을 읽은 상황입니다.'},
  {id:'payment-prepare',title:'결제 전 준비 필요',description:'부스·금액을 유지한 채 준비 후 결제 화면으로 돌아옵니다.'},
  {id:'insufficient',title:'잔액 부족',description:'결제 화면 안에서 충전 안내를 표시합니다.'},
  {id:'payment-approval',title:'결제 승인 대기',description:'결제 요청 후 사용자는 MetaMask Confirm만 누릅니다.'},
  {id:'payment-cancelled',title:'결제 취소',description:'부스·금액을 유지한 채 다시 결제할 수 있습니다.'},
  {id:'payment-pending',title:'결제 처리 중',description:'새 송금 버튼 없이 결과를 기다립니다.'},
  {id:'payment-unknown',title:'결과 확인 지연',description:'새 송금 대신 기존 거래 결과만 다시 확인합니다.'},
  {id:'payment-failed',title:'결제 실패',description:'실패 확인 후에만 다시 결제할 수 있습니다.'},
];
const allStates=[...mainStates,...extraStates];
const phaseStates=['connect','network-add','network-switch'];
const paymentStates=['pay','pay-manual','payment-prepare','insufficient','payment-approval','payment-cancelled','payment-pending','payment-unknown','payment-failed'];
const aliases={install:'welcome',create:'welcome',scan:'pay','balance-loading':'connect'};
const appScreen=document.getElementById('appScreen');
const stateSelect=document.getElementById('stateSelect');
const format=value=>new Intl.NumberFormat('ko-KR',{maximumFractionDigits:3}).format(value);
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
const points=()=>amount/1000;
const action=(label,kind='primary',data='')=>`<button type="button" class="${kind}" ${data}>${label}</button>`;
const goButton=(label,id,kind='primary')=>action(label,kind,`data-go="${id}"`);
const actions=(...items)=>`<div class="actions">${items.join('')}</div>`;
const title=(text,description='')=>`<h1 class="screen-title">${text}</h1>${description?`<p class="screen-description">${description}</p>`:''}`;
const spinner='<span class="spinner" aria-hidden="true"></span>';
const line=(label,value)=>`<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`;
const merchant='<div class="merchant"><img class="merchant-icon" src="assets/talent-mark.svg" alt=""><strong>사랑의 먹거리 부스</strong></div>';

function prepareScreen(){
  const loading=phase==='query';
  return `<div class="center-state">${illustration('phone')}${title(loading?'잔액을 확인하고 있어요.':'잠깐만요,<br>사용할 준비 중이에요.',loading?'곧 보여드릴게요.':'MetaMask에서 확인을 눌러주세요.')}<div class="waiting-indicator">${spinner}<span>${loading?'확인 중':'확인 기다리는 중'}</span></div></div>`+
    (showRetry?actions(`<p class="retry-message">${retryReason||'확인 창이 보이지 않나요?'}</p>`,action('다시 요청','secondary','data-action="retry-prepare"')):'');
}

function balanceScreen(){
  const failed=currentId==='balance-error';
  return title('내 달란트')+`<div class="balance-panel"><div class="balance-caption">사용 가능한 금액</div><div class="balance-number">${failed?'—':format(balance)}${failed?'':'<span>달란트</span>'}</div><div class="balance-krw">${failed?'잔액을 확인하지 못했어요.':format(balance*1000)+'원 상당'}</div></div>`+
    (failed?actions(action('다시 확인','primary','data-action="retry-balance"')):actions(balance>0?goButton('결제하기','pay'):'',goButton('충전하기','receive',balance>0?'secondary':'primary')));
}

function receiveScreen(){
  return title('현금 결제 후 직원에게<br>이 QR을 보여주세요.')+sampleQR()+
    (currentId==='topup-waiting'?`<div class="incoming">${spinner}<span>충전을 확인하고 있어요.</span></div>`:'')+
    actions(goButton('내 달란트로',balance>0?'home':'empty','secondary'));
}

function paymentScreen(){
  const waiting=currentId==='payment-approval';
  const pending=currentId==='payment-pending';
  const unknown=currentId==='payment-unknown';
  const busy=waiting||pending||unknown;
  const manual=currentId==='pay-manual';
  let content=title(pending||unknown?'결제를 확인하고 있어요.':waiting?'확인을 눌러주세요.':'얼마를 결제할까요?',waiting?'MetaMask에서 확인해 주세요.':'')+merchant()+
    (manual?`<label class="amount-label" for="amountInput">결제 금액</label><div class="amount-input-wrap"><input id="amountInput" type="number" inputmode="numeric" min="1" step="1" placeholder="0" value="${amount||''}"><span>원</span></div>`:`<div class="payment-amount">${format(amount)}<span>원</span></div>`)+
    `<div class="payment-details">${line('사용할 달란트',`<span id="pointAmount">${format(points())}</span> 달란트`)}${line('내 잔액',format(balance)+' 달란트')}</div>`;
  if(busy){
    content+=`<div class="waiting-indicator">${spinner}<span>${waiting?'확인 기다리는 중':'결제 확인 중'}</span></div>`;
    if(unknown)content+=actions(action('결과 다시 확인','secondary','data-action="check-payment"'));
    else if(waiting&&showRetry)content+=actions(action('확인 창 다시 열기','secondary','data-action="retry-payment"'));
    return content;
  }
  if(currentId==='payment-prepare')return content+actions(action('준비하고 계속하기','primary','data-action="prepare-payment"'));
  if(currentId==='insufficient')return content+'<p class="inline-status">달란트가 부족해요.</p>'+actions(action('충전하기','primary','data-action="topup-payment"'),goButton('돌아가기','home','plain-button'));
  if(currentId==='payment-cancelled')content+='<p class="inline-status">결제를 취소했어요.</p>';
  if(currentId==='payment-failed')content+='<p class="inline-status">결제하지 못했어요. 다시 시도해 주세요.</p>';
  return content+actions(action(amount?format(amount)+'원 결제하기':'금액을 입력해 주세요.','primary',`id="payButton" data-action="pay" ${amount?'':'disabled'}`),goButton('돌아가기','home','plain-button'));
}

function renderScreen(){
  if(phaseStates.includes(currentId)||['setup-cancelled','connection-error'].includes(currentId))return prepareScreen();
  if(['home','empty','balance-error'].includes(currentId))return balanceScreen();
  if(['receive','topup-waiting'].includes(currentId))return receiveScreen();
  if(paymentStates.includes(currentId))return paymentScreen();
  if(currentId==='opening')return `<div class="center-state">${illustration('phone')}${title('앱으로 이동할게요.','화면이 바뀌지 않으면 눌러주세요.')}</div>`+actions(goButton('눌러서 이동','connect'),goButton('앱 설치하기','welcome','plain-button'));
  if(currentId==='payment-success')return `<div class="center-state">${illustration('check')}${title('결제했어요!','직원에게 이 화면을 보여주세요.')}</div><div class="simple-receipt"><strong>${format(amount)}원</strong><span>사랑의 먹거리 부스</span><small>예시 결제 · PREVIEW-001</small></div>`+actions(action('내 달란트로','primary','data-action="finish-payment"'));
  return title('달란트로<br>즐거운 바자회.', '충전하고 간편하게 사용하세요.')+illustration('coin')+actions(goButton('설치하고 시작하기','opening'),goButton('이미 설치했어요 · 시작하기','opening','plain-button'));
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
function paint(){appScreen.innerHTML=renderScreen();updateLab();}
function beginRequest(){
  requestPending=true;showRetry=false;retryReason='';
  paint();
  requestTimer=setTimeout(()=>{showRetry=true;paint();},8000);
}
function go(id){
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
  if(!Number.isSafeInteger(amount)||amount<=0)return;
  if(currentId==='payment-prepare'){paymentIntent=true;go('connect');return;}
  if(currentId==='payment-unknown'){go('payment-pending');return;}
  if(points()>=balance){go('insufficient');return;}
  paymentCompleted=false;go('payment-approval');
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
  if(b.dataset.go){go(b.dataset.go);return;}
  switch(b.dataset.action){
    case'retry-prepare':case'retry-payment':retry();break;
    case'retry-balance':queryBalance();break;
    case'pay':requestPayment();break;
    case'prepare-payment':paymentIntent=true;go('connect');break;
    case'topup-payment':paymentIntent=true;chargeCompleted=false;go('receive');break;
    case'check-payment':go('payment-pending');break;
    case'finish-payment':finishPayment();break;
  }
});
appScreen.addEventListener('input',event=>{
  if(!preview)return;
  if(event.target.id!=='amountInput')return;
  const value=Number(event.target.value);amount=Number.isSafeInteger(value)&&value>0?value:0;
  document.getElementById('pointAmount').textContent=format(points());
  const button=document.getElementById('payButton');button.textContent=amount?format(amount)+'원 결제하기':'금액을 입력해 주세요.';button.disabled=!amount;
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
if(preview){if(location.hash)selectState(location.hash.slice(1));else go('welcome');}
else BazaarLive.create({Wallet:BazaarWallet,illustration}).init();
