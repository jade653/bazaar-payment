'use strict';
const icons = {
  phone:`<rect x="43" y="15" width="67" height="118" rx="15" fill="#fff" stroke="#8ca47a" stroke-width="2"/><path d="M65 25h23" stroke="#cad7bf" stroke-width="3" stroke-linecap="round"/><circle cx="76" cy="119" r="3" fill="#cad7bf"/><rect x="55" y="45" width="43" height="43" rx="13" fill="#f7e7cf"/><path d="m64 57 12 5 13-5-3 20-10 7-10-7Z" fill="#dca063"/><path d="m67 69 5 3m9 0 4-3" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
  coin:`<ellipse cx="75" cy="103" rx="37" ry="12" fill="#e4ebdb"/><rect x="38" y="80" width="74" height="21" fill="#d9ab6d"/><ellipse cx="75" cy="81" rx="37" ry="13" fill="#edc997"/><ellipse cx="75" cy="101" rx="37" ry="13" fill="none" stroke="#c59d68" stroke-width="1.5"/><ellipse cx="75" cy="65" rx="37" ry="13" fill="#f1d5ae"/><path d="M38 65v16M112 65v16" stroke="#c59d68" stroke-width="1.5"/><ellipse cx="75" cy="65" rx="37" ry="13" fill="none" stroke="#c59d68" stroke-width="1.5"/><path d="M75 57v16m-8-12c0-6 16-5 16 0s-16 4-16 8 16 5 16 0" fill="none" stroke="#bf925b" stroke-width="1.5"/><path d="M116 30v16m-8-8h16M31 40v10m-5-5h10" stroke="#9db588" stroke-width="2" stroke-linecap="round"/>`,
};

const illustration = name => `<div class="illustration" aria-hidden="true"><svg viewBox="0 0 152 152" fill="none">${icons[name]}</svg></div>`;

