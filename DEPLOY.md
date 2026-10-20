# GitHub Pages 배포와 운영

저장소는 https://github.com/jade653/bazaar-payment 이며, 서비스 주소는 https://bazaar.mustree.kr 입니다.
배포 설정은 `.github/workflows/deploy.yml`에서 관리합니다. `main`에 푸시하거나 GitHub Actions에서 `Deploy GitHub Pages`를 수동 실행하면 검증 후 배포합니다.

## 검증과 배포 범위

1. 루트 JavaScript와 tools/의 Node 스크립트 문법을 검사합니다.
2. `node --test "tests/*.test.cjs"`로 테스트합니다.
3. 루트 HTML/CSS/JavaScript, assets/, vendor/를 `_site/`에 복사합니다.
4. 생성한 아티팩트를 GitHub Pages에 배포합니다.

운영 페이지와 `preview.html`은 함께 배포합니다. 운영 지갑은 미리보기 시뮬레이션 코드를 로드하지 않습니다.
문서, tests/, tools/, measurements/는 배포하지 않습니다. 측정 결과는 로컬 생성 파일이며 Git에서도 제외합니다.

## 저장소 설정 확인

- **Settings → Pages → Build and deployment → Source**: GitHub Actions
- **Settings → Pages → Custom domain**: bazaar.mustree.kr
- 인증서 발급 후 **Enforce HTTPS** 활성화
- `github-pages` 환경의 보호 규칙을 사용하는 경우 배포 승인 정책 확인

도메인의 DNS CNAME은 `jade653.github.io`를 대상으로 설정합니다. DNS 상태와 Pages 설정은 GitHub 및 DNS 관리 화면에서 확인합니다.
Actions 기반 배포는 Pages 설정에서 도메인을 관리하므로 별도 CNAME 파일을 배포물에 추가하지 않습니다.

## 배포 확인과 복구

Actions 실행에서 검증·아티팩트 업로드·배포 단계가 모두 성공했는지 확인합니다.
배포 후 지갑 연결, 결제·충전 QR, 수동 잔액 갱신을 확인합니다. 실제 송금 검증은 소액으로 수행합니다.
문제가 있으면 원인 커밋을 되돌린 변경을 `main`에 반영해 다시 배포합니다.

## 참고 문서

- [GitHub Pages 사용자 지정 워크플로](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [사용자 지정 도메인 관리](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)
