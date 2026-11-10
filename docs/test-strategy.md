# 테스트 전략 (초안)

> 상태: **초안.** 로드맵 Step 1~4와 함께 도입한다. 도구는 예시이며 구현 단계에서 확정한다 (예: Vitest, `@cloudflare/vitest-pool-workers`, Playwright).

## 1. 원칙
- 보안 판정·한도·정규화처럼 **틀리면 피해가 큰 로직은 순수 함수로 분리**해 단위 테스트로 먼저 고정한다.
- 엑사원 호출은 기본적으로 **목(mock)** 으로 테스트하고, 실호출 테스트는 별도 명령으로만 실행한다 (한도·비용 보호, 개발 모드에서도 동일).
- 개발 모드의 한도 해제(`docs/llm-budget.md` 10절)와 별개로, 한도·단계 로직은 **설정을 주입해 `enforce`로 검증**한다.

## 2. 계층별 테스트
| 계층 | 대상 | 방법 |
| --- | --- | --- |
| 단위 | GTIN 체크디지트·UPC-E 확장·접두사 분기(20~29, 978/979), URL 정규화(쿼리·프래그먼트 제거, punycode), 보안 점수·등급 경계, 단축 URL → 최소 WARNING, 색상 대비 계산, `color_hex` 검증, 금지 패턴 검사 | Vitest |
| 계약 | 카드 4종·`ChatIntent` JSON Schema 검증, **facts 덮어쓰기**(엑사원 출력이 사실 필드를 바꾸지 못함), `narration_status`(ok/skipped/unavailable), `stale` 덧씌우기 | 스키마 검증 + 스냅샷 |
| 카운터 | `llm_usage` 원자 upsert(한도 도달 시 행 없음, 윈도우 전환, 환불), 세션·IP·전역 일괄 획득 | 로컬 D1(miniflare) 또는 SQLite |
| 통합 | `/api/scan`·`/api/chat`·`/api/history`·`DELETE /api/history`·`/q/:id.svg` 흐름, 삭제 시 R2 → DB 순서, 만료 정리 | `wrangler dev` 로컬 D1/R2/KV |
| 보안 수용 기준 | 개발 모드 해제 조건 5가지(`docs/llm-budget.md` 10절), `/q/*` 보안 헤더, SVG 주입 방지, 인젝션 문자열이 담긴 제품명 처리 | 자동 테스트 |
| LLM(옵트인) | 실제 엑사원으로 `ChatIntent`·narration 스키마 준수율, `reasoning_effort=low` 지연 측정 | 수동 실행 스크립트, 결과를 이슈에 기록 |
| 수동 | iOS/Android 실기기 스캔(저조도, 1D), PWA 설치·오프라인 안내 | 체크리스트 |

## 3. 먼저 만들 테스트 (우선순위)
1. 보안 점수 규칙의 등급 경계와 "소스 실패 시 SAFE 금지" 케이스
2. 한도 카운터와 개발 모드 해제 조건 (운영 누수 방지)
3. facts 덮어쓰기와 카드 스키마 검증
4. URL 정규화와 외부 전송 규칙 (쿼리·프래그먼트가 나가지 않는지)

## 4. CI 연계
- PR 검증 CI(AGENTS.md 8.8)에 단위·계약·카운터 테스트와 타입체크·린트를 포함한다. 실호출 LLM 테스트는 CI에서 실행하지 않는다.
