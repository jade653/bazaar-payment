(function (root) {
  'use strict';
  root.BazaarScanner = { create };
  function create({ onAccept, onError, onManual }) {
    const overlay = document.createElement('div');
    overlay.className = 'scanner'; overlay.hidden = true;
    overlay.innerHTML = '<div class="scanner-bar"><strong>받는 지갑 QR을 비춰주세요</strong><button type="button" data-close>닫기</button></div><video playsinline muted></video><div class="scanner-frame" aria-hidden="true"></div><div class="scanner-actions"><p>QR이 사각형 안에 오도록 맞춰주세요.</p><button type="button" data-manual>주소 직접 입력</button></div><canvas hidden></canvas>';
    document.body.append(overlay);
    const video = overlay.querySelector('video'), canvas = overlay.querySelector('canvas');
    let stream = null, frame = null, generation = 0;
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
      if (!navigator.mediaDevices?.getUserMedia) { onManual(); onError('카메라를 열 수 없어요. 주소를 직접 입력해 주세요.'); return; }
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio:false, video:{ facingMode:{ ideal:'environment' } } });
        if (revision !== generation) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired; video.srcObject = stream; overlay.hidden = false;
        await video.play(); if (revision === generation) loop();
      } catch { if (revision === generation) { stop(); onManual(); onError('카메라 권한을 허용하거나 주소를 직접 입력해 주세요.'); } }
    }
    async function readFile(file) {
      if (!file) return;
      const url = URL.createObjectURL(file);
      try { const image = new Image(); image.src = url; await image.decode(); const data = scanImage(image); if (!data || !onAccept(data)) onError('QR에서 지갑 주소를 찾지 못했어요.'); }
      catch { onError('QR 이미지를 읽지 못했어요.'); }
      finally { URL.revokeObjectURL(url); }
    }
    const manual = () => { stop(); onManual(); };
    overlay.querySelector('[data-close]').onclick = manual;
    overlay.querySelector('[data-manual]').onclick = manual;
    return { start, stop, readFile, dispose() { stop(); overlay.remove(); } };
  }
})(window);
