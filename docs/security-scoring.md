# 보안 점수 규칙 (초안)

> 상태: **초안 — 리뷰 대기.** 기준: `AGENTS.md` 3.2(보안 판정 정책), `docs/api-contract.md` 3.3(`security_card`), 9(개인정보·외부 전송).
> 이 문서는 URL 하나를 `SAFE` / `WARNING` / `DANGER`로 판정하는 **결정론적 규칙**을 정의한다. 가중치와 목록은 **초기값**이며, 9절의 검증 데이터로 보정한다.

---

## 1. 원칙

1. **판정은 코드가 한다.** 엑사원은 확정된 등급·신호를 설명할 뿐 등급을 바꾸지 못한다. Phase 1에서는 AI가 점수에 기여하는 신호도 두지 않는다 (인젝션 경로 차단).
2. **`SAFE`는 "알려진 위협을 확인하지 못함"이다.** 확인 자체가 이루어지지 않았다면(필수 소스 실패) `SAFE`가 될 수 없다.
3. **평판 소스의 적중은 점수와 무관하게 `DANGER`다.** 점수는 평판 정보가 없을 때의 **휴리스틱 보조 수단**이다.
4. **비대칭 비용:** 위험한 링크를 안전하다고 하는 오류(거짓 `SAFE`)가 안전한 링크를 의심하는 오류(거짓 `WARNING`)보다 훨씬 나쁘다. 애매하면 등급을 올린다.
5. **판정 함수는 순수 함수다.** I/O(소스 조회)는 어댑터가 하고, 점수 함수는 `(파싱된 URL, 소스 결과, 규칙 데이터) → 판정`만 계산한다. 같은 입력은 항상 같은 결과이며 단위 테스트로 고정한다.
6. **점수는 사용자에게 숫자로 보여 주지 않는다.** 등급과 이유 문구만 보여 준다 (거짓된 정밀함 방지).

---

## 2. 처리 파이프라인

```
스캔 문자열
 → ① 스킴 검사 (http/https 외 → 보안 카드 대상이 아님, 8절)
 → ② 파싱·정규화 (호스트 소문자·IDN→punycode 병기·끝 점 제거·기본 포트 제거·IP 표기 통일)
 → ③ 로컬 규칙 분석 (신호 생성, I/O 없음)
 → ④ 소스 조회 (병렬, 개별 타임아웃 3초 / 전체 5초) — 외부에는 scheme://host/path만 전송 (api-contract 9절)
 → ⑤ 점수·등급 결정 (5절)
 → ⑥ 카드 facts 구성 (signals, sources, rules_version, checked_at, actions)
```

- 같은 정규화 URL은 KV 캐시(`sec:{hash}`, TTL 1시간)를 먼저 조회한다. 캐시에는 **소스 응답**만 저장하고, 등급은 매번 현재 규칙으로 다시 계산한다 (규칙 업데이트가 즉시 반영됨).
- 단축 URL 등 도착 주소를 모르는 경우 `redirect_unknown=true`로 표기한다 (리다이렉션을 따라가지 않음, Phase 2의 헤드리스 분석 대상).

---

## 3. 소스와 커버리지 정책

| 소스 | 구분 | 확인하는 것 | 실패(타임아웃·4xx/5xx·한도) 시 |
| --- | --- | --- | --- |
| Google Safe Browsing | **필수** | 악성·피싱·원치 않는 소프트웨어 | **등급 하한 `WARNING`** + 신호 `SOURCE_UNAVAILABLE` |
| URLhaus | 선택 | 멀웨어 배포 URL | 신호만 남김(`SOURCE_UNAVAILABLE`, info). 점수 영향 없음 |
| RDAP (도메인 연령) | 선택 | 등록일 | 신호만 남김. `NEW_DOMAIN_*` 미적용 |
| KISA 피싱 차단 목록 | 선택 (Phase 1 가용 시) | 국내 신고된 피싱 URL | 신호만 남김 |

- **필수 소스가 실패하면 평판 확인이 없었던 것이므로 `SAFE`를 낼 수 없다.** 점수와 무관하게 `WARNING` 이상이며, 카드에 "일부 확인하지 못했어요"를 표시한다.
- 필수 소스 실패 + 점수 ≥ 70이면 그대로 `DANGER`다 (하한은 올리기만 한다).
- 카드의 `sources`에는 **실제로 확인한 소스만** 담는다 (확인 못 한 소스를 확인한 것처럼 표기하지 않는다).
- 소스 호출 429·한도 초과는 실패와 동일하게 취급한다. 개발 중에는 `SOURCES_MODE=mock`으로 소스를 모킹할 수 있다 (실제 필수 소스 실패와 구분해 로그에 `MOCK` 표기).

---

## 4. 신호 카탈로그

### 4.1 평판 신호 (하드 규칙 → 즉시 `DANGER`, `risk_score = 100`)
| 코드 | 조건 | 출처 | 사용자 문구(요약) |
| --- | --- | --- | --- |
| `GSB_MATCH` | Safe Browsing에 위협 항목으로 등록 | safe_browsing | 구글이 위험하다고 알려 둔 주소예요 |
| `URLHAUS_MATCH` | URLhaus에 현재 활성(online) 악성 URL로 등록 | urlhaus | 악성 파일 배포 주소로 신고된 곳이에요 |
| `KISA_MATCH` | KISA 피싱 차단 목록에 등록 | kisa | 피싱 사이트로 신고된 주소예요 |

### 4.2 휴리스틱 신호 (점수 합산)
| 코드 | 조건 | 점수 | 심각도 |
| --- | --- | --- | --- |
| `IP_HOST` | 호스트가 IP 주소 (십진·16진·8진 표기 포함) | 50 | warn |
| `USERINFO` | URL에 `사용자@` 형태 userinfo 포함 (예: `https://bank.com@evil.example`) | 70 | danger |
| `MIXED_SCRIPT` | 호스트 라벨 안에 서로 다른 문자 체계 혼용 (예: 라틴 + 키릴) | 70 | danger |
| `PUNYCODE_IDN` | 호스트에 `xn--` 라벨 포함 | 15 | warn |
| `BRAND_LOOKALIKE` | 등록 도메인이 브랜드 목록과 편집거리 ≤ 1이거나, 무관한 도메인에 브랜드명이 결합됨 (예: `naver-login.xyz`) | 40 | warn |
| `SHORTENER` | 알려진 단축 서비스 (`redirect_unknown=true`) | 35 | warn |
| `SHORTENER_FIRST_PARTY` | 서비스 제공사의 자체 단축 도메인 (예: `youtu.be`, `naver.me`) | 10 | info |
| `PRIVATE_HOST` | `localhost`, 사설 IP, `.local`/`.internal` | 40 | warn |
| `NEW_DOMAIN_7D` / `_30D` / `_90D` | RDAP 등록일이 7일 / 30일 / 90일 이내 (가장 큰 것 하나만 적용) | 40 / 25 / 10 | warn |
| `SUSPICIOUS_TLD` | 남용 빈도가 높은 TLD 목록 (`.zip`, `.mov`, `.top`, `.xyz`, `.click` 등) | 15 | warn |
| `LURE_KEYWORD` | 호스트·경로에 유도 키워드 포함 — **분류당 10점, 최대 20점** (6절 분류) | 10~20 | warn |
| `NEW_DOMAIN_LURE` | `NEW_DOMAIN_7D` 또는 `_30D`와 `LURE_KEYWORD`가 함께 있음 (조합 보너스) | +15 | warn |
| `BRAND_LURE` | `BRAND_LOOKALIKE`와 `LURE_KEYWORD`가 함께 있음 (브랜드 사칭 + 유도 문구, 전형적 피싱 조합) | +10 | warn |
| `NON_HTTPS` | `http://` | 15 | warn |
| `NONSTANDARD_PORT` | 80/443 외 포트 | 10 | info |
| `EXCESS_SUBDOMAINS` | 등록 도메인 앞 라벨 4개 이상 | 10 | info |
| `HOST_HYPHENS` | 호스트에 하이픈 3개 이상 | 5 | info |
| `LONG_URL` | 정규화 URL 길이 200자 초과 | 5 | info |

### 4.3 운영 신호 (점수 없음)
| 코드 | 의미 |
| --- | --- |
| `SOURCE_UNAVAILABLE` | 소스 조회 실패. 필수 소스면 등급 하한 `WARNING` (3절) |
| `MOCK_SOURCE` | 개발용 모킹 소스 사용 (운영에서 나타나면 오류) |

- `PUNYCODE_IDN`·`MIXED_SCRIPT`는 화면에 **디코딩된 도메인과 punycode 원형을 함께** 보여 준다.
- 신호의 `severity`는 UI 아이콘·정렬용이며 등급을 결정하지 않는다.

---

## 5. 등급 결정

```
score = min(100, Σ 휴리스틱 신호 점수)            // 평판 적중이 있으면 100
hardDanger = 평판 신호(GSB_MATCH | URLHAUS_MATCH | KISA_MATCH) 존재

scoreGrade = score >= 70 ? DANGER : score >= 30 ? WARNING : SAFE
floorGrade = 필수 소스 실패 ? WARNING : SAFE
grade      = hardDanger ? DANGER : max(scoreGrade, floorGrade)      // 순서: SAFE < WARNING < DANGER
```

| 점수 | 점수 등급 |
| --- | --- |
| 0 – 29 | SAFE |
| 30 – 69 | WARNING |
| 70 – 100 | DANGER |

- **하한은 올리기만 한다.** 어떤 규칙도 등급을 내리지 못한다.
- 신호가 0개이고 필수 소스가 정상이면 `SAFE` (점수 0).
- `actions`는 등급에서 파생한다: `SAFE` → 이동 허용, `WARNING` → 재확인 후 이동, `DANGER` → 차단. QR 생성은 `SAFE`일 때만 허용 (AGENTS.md 3.2). `SHORTENER`(35)는 점수만으로 `WARNING`이 되어 "단축 URL은 최소 `WARNING`" 규칙을 만족한다. `SHORTENER_FIRST_PARTY`(10)는 `SAFE`일 수 있으나 `redirect_unknown`은 그대로 `true`다.

---

## 6. 규칙 데이터 파일

규칙 데이터는 코드와 분리해 버전 관리한다 (`data/security/*.json`, 구현 단계에서 생성).

| 파일 | 내용 |
| --- | --- |
| `shorteners.json` | 단축 서비스 도메인 (예: `bit.ly`, `tinyurl.com`, `t.co`, `is.gd`, `ow.ly`, `cutt.ly`, `me2.do`, `vo.la`, `url.kr`) |
| `first_party_shorteners.json` | 서비스 자체 단축 도메인 (예: `youtu.be`, `naver.me`, `kko.to`, `amzn.to`) |
| `suspicious_tlds.json` | 남용 TLD 목록 |
| `brands.json` | 브랜드명과 정식 등록 도메인 (예: 네이버, 카카오, 토스, 쿠팡, 주요 은행, 정부·공공 기관, 택배사, 애플·구글·마이크로소프트·아마존 등) |
| `lure_keywords.json` | 유도 키워드 분류 (아래) |

**`lure_keywords` 분류 (분류당 10점):**
- 인증: `login`, `signin`, `verify`, `auth`, `인증`, `본인확인`
- 금융: `bank`, `wallet`, `pay`, `환급`, `대출`, `입금`
- 배송·공공: `택배`, `배송`, `parcel`, `tracking`, `경찰`, `검찰`, `국세청`, `건강보험`
- 긴급: `urgent`, `suspend`, `expire`, `locked`, `긴급`, `정지`

- 데이터는 **초기 목록**이며 오탐·미탐이 보고되면 갱신한다. 판정 결과(`security_card.facts`)에는 `rules_version`(규칙 코드 + 데이터 버전 해시)을 기록해 어떤 규칙으로 판정했는지 재현할 수 있게 한다.
- 신뢰 도메인 허용 목록(allowlist)으로 신호를 면제하지 않는다. 구글 폼·사용자 콘텐츠 호스팅 같은 신뢰 도메인 안의 피싱을 놓치게 되기 때문이다 (Phase 2에서 재검토).

---

## 7. 골든 케이스 (단위 테스트로 고정)

소스는 모두 정상(필수 소스 응답 있음), RDAP는 별도 표기가 없으면 미적용으로 가정한다.

| # | 입력 | 신호 | 점수 | 등급 |
| --- | --- | --- | --- | --- |
| 1 | `https://www.naver.com/` | - | 0 | SAFE |
| 2 | `https://naver.me/abc` | `SHORTENER_FIRST_PARTY` | 10 | SAFE (`redirect_unknown`) |
| 3 | `https://bit.ly/3xYz` | `SHORTENER` | 35 | WARNING |
| 4 | `http://203.0.113.5/login` | `IP_HOST` 50 + `NON_HTTPS` 15 + `LURE_KEYWORD` 10 | 75 | DANGER |
| 5 | `https://bank.com@evil.example/` | `USERINFO` | 70 | DANGER |
| 6 | `https://naver-login.xyz/verify` | `BRAND_LOOKALIKE` 40 + `SUSPICIOUS_TLD` 15 + `LURE_KEYWORD` 10 + `BRAND_LURE` 10 | 75 | DANGER |
| 7 | 6번 + 등록 7일 | + `NEW_DOMAIN_7D` 40 + `NEW_DOMAIN_LURE` 15 (합 120 → 상한 100) | 100 | DANGER |
| 8 | `https://kakao-pay-refund.top/환급` | `BRAND_LOOKALIKE` 40 + `SUSPICIOUS_TLD` 15 + `LURE_KEYWORD`(금융) 10 + `BRAND_LURE` 10 | 75 | DANGER |
| 8b | `https://naver-login.com/verify` (남용 TLD 아님) | `BRAND_LOOKALIKE` 40 + `LURE_KEYWORD` 10 + `BRAND_LURE` 10 | 60 | WARNING (등록 7일 이내면 DANGER) |
| 9 | 8번 + 등록 30일 | + `NEW_DOMAIN_30D` 25 + `NEW_DOMAIN_LURE` 15 (합 115 → 상한 100) | 100 | DANGER |
| 10 | Safe Browsing 적중 (`https://example.test/`) | `GSB_MATCH` | 100 | DANGER |
| 11 | `https://www.naver.com/` + Safe Browsing 장애 | `SOURCE_UNAVAILABLE` | 0 | WARNING (하한) |
| 12 | `http://example.com/` | `NON_HTTPS` | 15 | SAFE |
| 13 | `https://a.b.c.d.e.example.com/` | `EXCESS_SUBDOMAINS` | 10 | SAFE |
| 14 | `https://example.zip/` | `SUSPICIOUS_TLD` | 15 | SAFE |
| 15 | `http://localhost:3000/` | `PRIVATE_HOST` 40 + `NON_HTTPS` 15 + `NONSTANDARD_PORT` 10 | 65 | WARNING |
| 16 | `javascript:alert(1)` | (스킴 검사에서 중단) | - | 보안 카드 없음, 8절 |

---

## 8. 스킴·페이로드 처리

- **`http`/`https`만** 보안 카드 대상이다.
- `javascript:`, `data:`, `file:`, `vbscript:`는 **열 수 없는 형식**이다. `text` 카드로 "실행할 수 없는 형식이에요"를 안내하고, 원문은 코드 블록으로 보여 주되 링크로 만들지 않으며 저장하지 않는다.
- `intent://`, `market://`, 앱 딥링크 등 기타 스킴은 비-URL QR과 동일하게 `text` 카드(원문 표시, 자동 실행 안 함)로 처리한다.
- 정규화 후 길이가 2048자를 넘으면 처리하지 않고 재스캔을 안내한다.

---

## 9. 보정·검증 계획

1. **라벨링된 테스트 세트**를 만든다: 정상 URL 100개 이상(국내 주요 서비스, QR 메뉴·결제·택배 조회 실제 사례, 단축 링크 포함)과 악성·피싱 URL 100개 이상(URLhaus 등 공개 피드의 최근 항목, 합성 유사 도메인). 악성 URL은 **접속하지 않고 문자열로만** 다룬다.
2. **목표(초안):** 정상 URL 중 `DANGER` 0건, `WARNING` 10% 이하. 악성 URL 중 `WARNING` 이상 95% 이상 (평판 소스 없이 휴리스틱만으로도 70% 이상).
3. 7절 골든 케이스는 자동 테스트로 고정하고, 가중치를 바꾸면 골든 케이스와 테스트 세트를 모두 다시 실행한다.
4. **운영 중 보정:** 오탐·미탐 신고를 이슈로 받아 규칙 데이터를 갱신하고 `rules_version`을 올린다.

---

## 10. Phase 2 확장

- 헤드리스 렌더링으로 리다이렉션 체인·로그인 폼 탐지 → `redirect_unknown=false`, 새 신호 추가 (`REDIRECT_CHAIN`, `LOGIN_FORM_ON_NEW_DOMAIN`).
- 격리된 AI 소스 분석: **사실 신호만 출력**하고 가중치 상한(예: +20)을 두며, 등급을 낮추지 못한다 (AGENTS.md 3.2 4번).
- 신뢰 도메인 처리(허용 목록의 안전한 형태), 사용자 신고 기반 피드백, 한국 신고 데이터 정식 연동.

---

## 11. 열린 질문

1. **KISA 피싱 차단 목록**을 Phase 1에서 쓸 수 있는가 (data.go.kr 등록 여부·갱신 주기·이용 조건은 아직 미확인). 쓸 수 없으면 `KISA_MATCH`는 Phase 2로 미룬다.
2. **Safe Browsing 필수 소스 지정**의 부작용: 키 발급이 안 되거나 상업 전환 전 한도가 부족하면 모든 URL이 `WARNING`이 된다. 대안 필수 소스(예: URLhaus 단독 허용)를 허용할지.
3. **가중치와 임계값(30/70)** 은 테스트 세트(9절) 결과로 조정한다. 특히 **8b처럼 브랜드 사칭 + 유도 문구인데 남용 TLD가 아니고 RDAP 정보가 없으면 `WARNING`에 그친다.** `WARNING`은 재확인 후 이동할 수 있으므로, `BRAND_LURE` 가중치를 더 올리거나 RDAP 실패 시 신규 도메인으로 간주할지 검토한다.
4. **RDAP `.kr` 지원 여부**를 확인해야 한다 (`NEW_DOMAIN_*`가 국내 도메인에 적용되는지).
