# GitHub Actions / Pages 배포

`bazaar-ui`의 내용이 새 저장소 루트로 옮겨진 상태를 기준으로 합니다.
저장소: https://github.com/jade653/bazaar-payment
연결할 도메인: bazaar.mustree.kr
워크플로는 준비되었으며 최초 Pages 설정과 DNS 연결이 필요합니다.
현재 화면은 실제 충전·결제가 없는 시안입니다.

1. 새 저장소 이름·소유자·공개 여부를 확정합니다.
2. 이 디렉터리의 내용만 새 저장소 루트에 올립니다. 기본 브랜치는 `main` 기준입니다.
3. 저장소 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 설정합니다.
4. **Actions → Deploy GitHub Pages → Run workflow**로 첫 배포를 실행합니다.
5. 이후 `main`에 변경을 올리면 자동 배포됩니다.

GitHub Free는 공개 저장소에서 Pages를 제공합니다. 비공개 저장소 지원은 계정 플랜에 따라 다릅니다.
실행 파일 4개만 배포하므로 문서와 워크플로 자체는 사이트에 게시되지 않습니다.

## 도메인

도메인이 확정되면 아래 순서로 설정합니다.

1. GitHub 계정/조직에서 도메인 소유권을 검증합니다.
2. 저장소 **Settings → Pages → Custom domain**에 사용할 도메인을 저장합니다.
3. DNS 관리 업체에서 레코드를 맞춥니다.
   - 서브도메인: CNAME 대상을 `<GitHub 소유자>.github.io`로 설정합니다. 저장소 경로는 넣지 않습니다.
   - 루트 도메인: 공식 문서의 A / ALIAS / ANAME 설정을 사용합니다.
4. DNS 검증과 인증서 발급 후 **Enforce HTTPS**를 켭니다.

DNS 값은 저장소 소유자와 최종 도메인이 정해진 뒤 작성합니다.
Actions 배포에서 도메인은 Pages 설정으로 관리하며 CNAME 파일은 필요하지 않습니다.

공식 문서:
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

