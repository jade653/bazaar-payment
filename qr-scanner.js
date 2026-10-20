(function (root) {
  'use strict';
  root.BazaarScanner = { create };
  function create({ onAccept, onError, onManual, preview = false, onPreview }) {
    const overlay = document.createElement('div');
    overlay.className = 'scanner'; overlay.hidden = true;
    overlay.innerHTML = '<div class="scanner-bar"><strong>받는 지갑 QR을 비춰주세요</strong><button type="button" data-close aria-label="닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div><video playsinline muted></video><div class="scanner-frame" aria-hidden="true"></div><p data-message role="status">QR이 사각형 안에 오도록 맞춰주세요.</p><div class="scanner-actions">' + (preview ? '<button type="button" data-preview>예시 QR 인식</button>' : '') + '<div class="scanner-options"><button type="button" data-image><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8" cy="8" r="1.5"/><path d="m3 16 5-5 4 4 4-4 5 5"/></svg><span>이미지 선택</span></button><button type="button" data-manual><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 15h8"/></svg><span>주소 직접 입력</span></button></div></div><input type="file" accept="image/*" data-file hidden><canvas hidden></canvas>';
    document.body.append(overlay);
    const video = overlay.querySelector('video'), canvas = overlay.querySelector('canvas'), fileInput = overlay.querySelector('[data-file]'), message = overlay.querySelector('[data-message]');
    let stream = null, frame = null, generation = 0;
    function report(text) { message.textContent = text; onError(text); }
    function stop() {
      generation++;
      if (frame) cancelAnimationFrame(frame); frame = null;
      stream?.getTracks().forEach(track => track.stop()); stream = null;
      video.srcObject = null; overlay.hidden = true;
    }
    function scanImage(source) {
      if (typeof jsQR !== 'function') throw new Error('QR_READER_MISSING');
      const context = canvas.getContext('2d', { willReadFrequently:true });
      canvas.width = source.videoWidth || source.naturalWidth; canvas.height = source.videoHeight || source.naturalHeight;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      return jsQR(image.data, image.width, image.height, { inversionAttempts:'dontInvert' })?.data;
    }
    function loop() {
      if (!stream) return;
      if (video.readyState >= 2) {
        try { const data = scanImage(video); if (data && onAccept(data)) { stop(); return; } } catch {}
      }
      frame = requestAnimationFrame(loop);
    }
    async function start() {
      stop(); const revision = generation;
      overlay.hidden = false;
      message.textContent = 'QR이 사각형 안에 오도록 맞춰주세요.';
      if (preview) return;
      if (!navigator.mediaDevices?.getUserMedia) { report('카메라를 사용할 수 없어요. 이미지 선택이나 주소 직접 입력을 이용해 주세요.'); return; }
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:'environment' } } });
        if (revision !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired; video.srcObject = stream; overlay.hidden = false;
        await video.play(); if (revision === generation) loop();
      } catch { if (revision === generation) { stop(); overlay.hidden = false; report('카메라를 사용할 수 없어요. 이미지 선택이나 주소 직접 입력을 이용해 주세요.'); } }
    }
    async function readFile(file) {
      if (!file) return;
      const revision = generation;
      const url = URL.createObjectURL(file);
      try {
        const image = new Image(); image.src = url; await image.decode();
        if (revision !== generation) return;
        const data = scanImage(image);
        if (data && onAccept(data)) stop();
        else report('QR에서 지갑 주소를 찾지 못했어요.');
      } catch { if (revision === generation) report('QR 이미지를 읽지 못했어요.'); }
      finally { URL.revokeObjectURL(url); }
    }
    overlay.querySelector('[data-close]').onclick = stop;
    overlay.querySelector('[data-manual]').onclick = () => { stop(); onManual(); };
    overlay.querySelector('[data-image]').onclick = () => fileInput.click();
    fileInput.onchange = async () => { await readFile(fileInput.files?.[0]); fileInput.value = ''; };
    if (preview) overlay.querySelector('[data-preview]').onclick = () => { stop(); onPreview(); };
    return { start, stop, dispose() { stop(); overlay.remove(); } };
  }
})(window);
