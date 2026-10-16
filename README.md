# 바자회 달란트

빌드·외부 라이브러리 없이 동작하는 HTML/CSS/JavaScript 서비스입니다.

## 실제 연결

- 서비스: https://bazaar.mustree.kr/
- 시작하기 → MetaMask 계정 연결 → Mustree 추가/전환 → 잔액 자동 조회
- 모바일 일반 브라우저에서는 MetaMask 내부 브라우저로 이동해 이어갑니다.
- 이미 허용된 계정과 올바른 네트워크는 추가 승인 없이 잔액을 표시합니다.
- 최초 방문에서는 사용자 행동 없이 계정 접근 승인을 요청하지 않습니다.
- 승인 취소·조회 오류·네트워크 변경·계정 변경·중복 요청을 처리합니다.
- 잔액은 실제 네이티브 MST 잔액입니다. UI에서는 1 MST를 1 달란트, 1,000원 상당으로 표시합니다.

네트워크 설정은 `wallet.js`의 `NETWORK`에서 관리합니다.
RPC: `https://block.mustree.kr`, Chain ID: `7601` (`0x1db1`), 기호: `MST`, decimals: `18`.

**실제 결제·서명·송금은 구현하지 않았습니다.** 실제 모드에서는 결제 버튼과 예시 영수증을 표시하지 않습니다.
충전 안내에는 연결된 실제 주소와 복사 버튼만 제공합니다. QR 생성은 아직 연결하지 않았습니다.

## UI 미리보기

https://bazaar.mustree.kr/?preview=1

이 모드는 실제 지갑과 완전히 분리된 예시입니다. Confirm/취소/충전/결제를 재현할 수 있으며,
진짜 계정 주소나 잔액을 읽지 않습니다. 미리보기 QR은 스캔할 수 없는 샘플입니다.

## 로컬 실행과 테스트

```powershell
python -m http.server 8001 --bind 127.0.0.1
node --test tests/wallet.test.cjs
```

http://localhost:8001/ 에서 실행합니다. 휴대폰의 MetaMask는 PC localhost에 접속할 수 없어,
로컬 페이지에서 앱 열기를 누르면 실제 배포 주소로 안내합니다.

기기에서 확인할 항목:
1. 첫 연결·Mustree 미등록: 필요한 승인 후 실제 잔액까지 표시되는지
2. 재방문: 불필요한 계정 연결 승인이 반복되지 않는지
3. 승인 취소: 재요청으로 미완료 단계부터 이어지는지
4. 계정/네트워크 변경: 이전 잔액이 표시되지 않는지
5. iPhone Safari / Galaxy Chrome → MetaMask 앱 이동

## 배포

저장소: https://github.com/jade653/bazaar-payment
main 변경 시 테스트 후 GitHub Actions로 Pages에 배포합니다.
자세한 초기 설정은 [DEPLOY.md](DEPLOY.md)를 참고하세요.
