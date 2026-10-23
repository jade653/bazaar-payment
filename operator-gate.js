(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BazaarGate = api;
  // Browser entry: pages marked data-operator-gate stay hidden until the operator password is entered.
  if (root.document && root.document.body && root.document.body.hasAttribute && root.document.body.hasAttribute('data-operator-gate')) api.active = api.mount({ root });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // PBKDF2-SHA256 of the operator password. While hash is empty the gate shows a form that generates this line.
  // This only keeps casual visitors out: the check runs in the browser, so wallet signatures remain the real protection.
  const GATE = { iterations:600000, salt:'', hash:'' };
  const STORAGE_KEY = 'bazaar-operator-gate-v1', REMEMBER_MS = 12 * 60 * 60 * 1000, MIN_LENGTH = 8;
  const toHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const fromHex = hex => new Uint8Array((String(hex).match(/../g) || []).map(pair => parseInt(pair, 16)));

  async function derive(password, { salt, iterations }, subtle) {
    const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return toHex(await subtle.deriveBits({ name:'PBKDF2', hash:'SHA-256', salt:fromHex(salt), iterations }, key, 256));
  }
  async function verify(password, config, subtle) { return !!config.hash && await derive(password, config, subtle) === config.hash; }
  async function createConfig(password, { crypto, iterations = GATE.iterations }) {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return { iterations, salt, hash:await derive(password, { salt, iterations }, crypto.subtle) };
  }
  const snippet = config => `const GATE = { iterations:${config.iterations}, salt:'${config.salt}', hash:'${config.hash}' };`;

  // A correct password is remembered on this device for 12 hours; changing the password invalidates it.
  function remembered(storage, config, now) {
    try { const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null'); return !!config.hash && saved?.hash === config.hash && saved.until > now; } catch { return false; }
  }
  function remember(storage, config, now) { try { storage?.setItem(STORAGE_KEY, JSON.stringify({ hash:config.hash, until:now + REMEMBER_MS })); } catch {} }

  function markup(mode) {
    const head = `<img src="assets/talent-mark.svg" alt=""><h1 id="gateTitle">운영자 전용</h1>`;
    if (mode === 'unsupported') return `${head}<p>이 브라우저에서는 비밀번호를 확인할 수 없어요. https 주소로 다시 열어 주세요.</p>`;
    if (mode === 'setup') return `${head}<p>아직 비밀번호가 설정되지 않았어요. 새 비밀번호를 정하면 설정값을 만들어 드려요.</p><input id="gatePassword" type="password" autocomplete="new-password" placeholder="새 비밀번호 (${MIN_LENGTH}자 이상)" aria-label="새 비밀번호" required><input id="gateConfirm" type="password" autocomplete="new-password" placeholder="한 번 더 입력" aria-label="새 비밀번호 확인" required><p class="operator-gate-error" role="alert" hidden></p><button class="operator-primary" type="submit">설정값 만들기</button><div class="operator-gate-result" hidden><label for="gateSnippet">operator-gate.js의 GATE 줄을 이 값으로 바꾸고 배포하세요.</label><textarea id="gateSnippet" readonly></textarea></div>`;
    return `${head}<p>비밀번호를 입력해 주세요.</p><input id="gatePassword" type="password" autocomplete="current-password" aria-label="비밀번호" required><p class="operator-gate-error" role="alert" hidden></p><button class="operator-primary" type="submit">들어가기</button>`;
  }

  function mount({ root, config = GATE, now = () => Date.now() }) {
    const doc = root.document, body = doc.body, crypto = root.crypto;
    let storage = null; try { storage = root.localStorage || null; } catch {}
    let overlay = null;
    const open = () => { body.classList.add('gate-open'); overlay?.remove(); overlay = null; };
    if (remembered(storage, config, now())) { open(); return { mode:'open' }; }
    const mode = !crypto?.subtle ? 'unsupported' : config.hash ? 'login' : 'setup';
    overlay = doc.createElement('div');
    overlay.className = 'operator-gate';
    overlay.innerHTML = `<form class="operator-gate-card" role="dialog" aria-modal="true" aria-labelledby="gateTitle" novalidate>${markup(mode)}</form>`;
    body.append(overlay);
    const find = selector => overlay.querySelector(selector);
    const password = find('#gatePassword'), error = find('.operator-gate-error'), button = find('button');
    const fail = text => { error.textContent = text; error.hidden = false; button.disabled = false; };
    password?.focus();
    overlay.addEventListener('submit', async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true; error.hidden = true;
      if (mode === 'login') {
        let ok = false; try { ok = await verify(password.value, config, crypto.subtle); } catch {}
        if (ok) { remember(storage, config, now()); open(); return; }
        password.value = ''; password.focus(); fail('비밀번호가 맞지 않아요.');
      } else if (mode === 'setup') {
        const confirm = find('#gateConfirm');
        if (password.value.length < MIN_LENGTH) { fail(`비밀번호는 ${MIN_LENGTH}자 이상이어야 해요.`); return; }
        if (password.value !== confirm.value) { fail('두 비밀번호가 달라요.'); return; }
        let created = null; try { created = await createConfig(password.value, { crypto, iterations:config.iterations }); } catch {}
        if (!created) { fail('설정값을 만들지 못했어요. 다시 시도해 주세요.'); return; }
        find('#gateSnippet').value = snippet(created); find('.operator-gate-result').hidden = false; button.disabled = false;
      }
    });
    return { mode };
  }
  return { GATE, STORAGE_KEY, REMEMBER_MS, derive, verify, createConfig, snippet, remembered, remember, mount };
});
