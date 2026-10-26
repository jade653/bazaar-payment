# GitHub Pages 배포와 운영

저장소는 https://github.com/jade653/bazaar-payment 이며, 서비스 주소는 https://bazaar.mustree.kr 입니다.
배포 설정은 `.github/workflows/deploy.yml`에서 관리합니다. `main`에 푸시하거나 GitHub Actions에서 `Deploy GitHub Pages`를 수동 실행하면 검증 후 배포합니다.

## 검증과 배포 범위

1. 루트 JavaScript와 tools/의 Node 스크립트 문법을 검사합니다.
2. `node --test "tests/*.test.cjs"`로 테스트합니다.
3. 루트 HTML/CSS/JavaScript, assets/, vendor/, contracts/의 계약 소스와 컴파일 결과를 `_site/`에 복사합니다.
4. 생성한 아티팩트를 GitHub Pages에 배포합니다.

운영 페이지와 `preview.html`은 함께 배포합니다. 운영 지갑은 미리보기 시뮬레이션 코드를 로드하지 않습니다.
문서, tests/, tools/, measurements/는 배포하지 않습니다. 측정 결과는 로컬 생성 파일이며 Git에서도 제외합니다.

## wMST 발행과 수수료 설정 (최초 1회, 운영자)

서비스는 ERC-20 토큰 wMST(1 wMST = 1원, 소수점 없음)로 잔액과 결제를 처리하고, 네이티브 MST는 수수료에만 씁니다. 발행 전에는 모든 지갑 화면이 “서비스 준비가 아직 끝나지 않았어요”를 표시합니다.

1. 운영 지갑(MetaMask)에 수수료용 MST가 충분한지 확인합니다. 배포에 약 51만 gas, 충전 1건에 약 9만 gas가 들며 체인 수수료는 107 wei/gas 수준입니다(2026-10-22 기준). 1 MST면 사실상 무제한입니다.
2. MetaMask 앱 브라우저에서 https://bazaar.mustree.kr/setup.html 을 엽니다. 운영 지갑을 연결합니다.
3. **발행하기**: 발행량(기본 1,000,000,000 wMST)을 확인하고 누릅니다. 발행량 전체가 운영 지갑으로 한 번에 발행되며 추가 발행 기능은 없습니다. 화면에 컨트랙트 주소와 배포 블록 번호가 표시됩니다.
4. **측정 시작**: MetaMask가 실제로 보낸 전송 3건(새 지갑 전송, 기존 지갑 전송, 충전)의 영수증으로 수수료를 측정합니다. 테스트 수신 지갑을 비워 두면 임의 주소로 wMST 3개와 소량의 MST가 보내지고 되돌릴 수 없으니, 가능하면 운영자의 두 번째 지갑 주소를 넣습니다.
5. 결과 화면의 **설정 복사**로 받은 값을 `wallet.js`의 `TOKEN`(`address`, `deployBlock`, `gasPolicy`)에 붙여넣습니다. **기록 복사**의 JSON은 `contracts/wmst-gas-measurement.json`으로 저장해 함께 커밋합니다.
6. `node --test "tests/*.test.cjs"`가 통과하는지 확인하고 `main`에 푸시합니다. 배포 후 https://bazaar.mustree.kr/dashboard.html 에서 발행 내역이 보이는지, 소액 충전과 결제가 되는지 확인합니다.

체인의 수수료 시장이 바뀌거나 MetaMask 동작이 달라지면 setup.html에서 **측정할 wMST 컨트랙트 주소**에 기존 주소를 넣고 다시 측정한 뒤 `gasPolicy`만 갱신합니다. 컨트랙트 소스를 수정했다면 `npm install --no-save solc@0.8.28` 후 `node tools/compile-wmst.cjs`로 `contracts/wMST.artifact.json`과 `wmst-artifact.js`를 다시 생성합니다(테스트가 소스 해시를 검사합니다). 배포 없이 수수료를 가늠하려면 `node tools/estimate-wmst-gas.cjs`를 실행합니다.

## 운영자 페이지 비밀번호

`operator.html`, `setup.html`은 비밀번호를 입력해야 화면이 보입니다. 맞게 입력한 기기는 12시간 동안 다시 묻지 않습니다. 운영 현황(`dashboard.html`)은 operator 화면의 **대시보드** 버튼으로 들어가며 비밀번호를 묻지 않습니다.

1. `operator-gate.js`의 `GATE`에서 `hash`가 비어 있으면 두 페이지 모두 잠긴 채로 **설정값 만들기** 화면을 보여줍니다.
2. 새 비밀번호(8자 이상)를 두 번 입력하면 `const GATE = { ... };` 한 줄이 나옵니다. 이 줄로 `operator-gate.js`의 `GATE` 줄을 바꾸고 `main`에 푸시합니다. 비밀번호를 바꿀 때도 `hash`를 비우고 같은 과정을 거치면 되고, 바꾸면 기존 기기의 기억도 풀립니다.
3. 저장소에는 비밀번호가 아니라 PBKDF2 해시만 들어갑니다. 다만 검사는 브라우저에서 하므로 우회할 수 있는 가림막일 뿐이고, 충전·발행은 여전히 운영 지갑의 MetaMask 서명으로 보호됩니다. 추측하기 어려운 긴 비밀번호를 쓰세요.

## 저장소 설정 확인

- **Settings → Pages → Build and deployment → Source**: GitHub Actions
- **Settings → Pages → Custom domain**: bazaar.mustree.kr
- 인증서 발급 후 **Enforce HTTPS** 활성화
- `github-pages` 환경의 보호 규칙을 사용하는 경우 배포 승인 정책 확인

도메인의 DNS CNAME은 `jade653.github.io`를 대상으로 설정합니다. DNS 상태와 Pages 설정은 GitHub 및 DNS 관리 화면에서 확인합니다.
Actions 기반 배포는 Pages 설정에서 도메인을 관리하므로 별도 CNAME 파일을 배포물에 추가하지 않습니다.

## 배포 확인과 복구

Actions 실행에서 검증·아티팩트 업로드·배포 단계가 모두 성공했는지 확인합니다.
배포 후 지갑 연결, 결제·충전 QR, 수동 잔액 갱신, 운영 현황(dashboard.html)을 확인합니다. 실제 송금 검증은 소액으로 수행합니다.
문제가 있으면 원인 커밋을 되돌린 변경을 `main`에 반영해 다시 배포합니다. 토큰 컨트랙트는 되돌릴 수 없으므로 `TOKEN.address`만 유지하면 기존 잔액은 그대로 남습니다.

## 참고 문서

- [GitHub Pages 사용자 지정 워크플로](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [사용자 지정 도메인 관리](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
