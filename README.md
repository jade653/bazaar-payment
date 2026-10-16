# 바자회 달란트

설치 안내 → 준비 → 충전·잔액 → 결제로 이어지는 가벼운 UI 시안입니다.
HTML/CSS/JavaScript만 사용하며 외부 라이브러리와 빌드 과정이 없습니다.
실제 지갑·카메라·송금은 아직 연결하지 않았습니다.

## 로컬 확인

이 저장소 루트에서 실행합니다.

```powershell
python -m http.server 8001 --bind 127.0.0.1
```

- 사용자 화면: http://localhost:8001/
- 테스트 패널: http://localhost:8001/?preview=1

기본 화면은 7개입니다. 예외 상황은 ‘다른 상황 테스트’에서 고릅니다.
준비 화면에 들어가면 즉시 승인 대기로 바뀝니다.
테스트 패널의 **Confirm 누름**으로 MetaMask 동작을 재현하면 연결 → 추가/전환 → 잔액 자동 조회가 이어집니다.
사용자 화면에는 별도 승인 버튼이 없습니다.

취소·확인 창 미표시·8초간 응답 없음 상황에만 재요청 버튼을 표시합니다.
이미 대기 중인 요청은 중복 생성하지 않습니다. 실제 provider 요청은 보내지 않는 시뮬레이션입니다.
QR과 금액, 충전 보너스, 결제 결과는 모두 예시입니다.

## 배포

- 저장소: https://github.com/jade653/bazaar-payment
- 연결할 도메인: bazaar.mustree.kr
- main 변경 시 GitHub Actions로 Pages 배포
- 최초 Pages 설정과 DNS 연결 절차: [DEPLOY.md](DEPLOY.md)
