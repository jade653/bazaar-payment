'use strict';
document.getElementById('makeQr').onclick = function () {
  const address = BazaarTransfer.parseRecipient(document.getElementById('merchantAddress').value);
  const error = document.getElementById('merchantError'), qr = document.getElementById('merchantQr'), url = document.getElementById('merchantUrl');
  error.hidden = Boolean(address); qr.hidden = !address;
  if (!address) { error.textContent = '올바른 지갑 주소를 입력해 주세요.'; url.textContent = ''; return; }
  const link = BazaarTransfer.paymentLink(address);
  BazaarUI.renderQr(qr, link);
  url.textContent = link;
};
