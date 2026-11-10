# 보안 점수 규칙 (초안)

> 상태: **초안 — 리뷰 대기.** 기준: `AGENTS.md` 3.2(보안 판정 정책), `docs/api-contract.md` 3.3(`security_card`), 9(개인정보·외부 전송).
> 이 문서는 URL 하나를 `SAFE` / `WARNING` / `DANGER`로 판정하는 **결정론적 규칙**을 정의한다. 가중치와 목록은 **초기값**이며, 10절의 검증 데이터로 보정한다.

---

## 1. 원칙

1. **판정과 사용자 문구는 모두 코드가 만든다.** 보안 카드의 서술은 코드 템플릿이며(8절) 엑사원은 판정·서술에 관여하지 않는다. Phase 1에서는 AI가 점수에 기여하는 신호도 두지 않는다 (인젝션 경로 차단). 채팅에서 사용자가 질문할 때만 엑사원이 결과 카드를 맥락으로 보고 답한다.
2. **`SAFE`는 "알려진 위협을 확인하지 못함"이다.** 확인 자체가 이루어지지 않았다면(필수 소스 실패) `SAFE`가 될 수 없다.
3. **평판 소스의 적중은 점수와 무관하게 `DANGER`다.** 점수는 평판 정보가 없을 때의 **휴리스틱 보조 수단**이다.
4. **비대칭 비용:** 위험한 링크를 안전하다고 하는 오류(거짓 `SAFE`)가 안전한 링크를 의심하는 오류(거짓 `WARNING`)보다 훨씬 나쁘다. 애매하면 등급을 올린다.
5. **판정 함수는 순수 함수다.** I/O(소스 조회)는 어댑터가 하고, 점수 함수는 `(파싱된 URL, 소스 결과, 규칙 데이터) → 판정`만 계산한다. 같은 입력은 항상 같은 결과이며 단위 테스트로 고정한다.
6. **점수는 사용자에게 숫자로 보여 주지 않는다.** 등급과 이유 문구만 보여 준다 (거짓된 정밀함 방지).

---

## 2. 처리 파이프라인

```
스캔 문자열
 → ① 스킴 검사 (http/https 외 → 보안 카드 대상이 아님, 9절)
 → ② 파싱·정규화 (호스트 소문자·IDN→punycode 병기·끝 점 제거·기본 포트 제거·IP 표기 통일)
 → ③ 로컬 규칙 분석 (신호 생성, I/O 없음)
 → ④ 소스 조회 (병렬, 개별 타임아웃 3초 / 전체 5초) — 외부에는 scheme://host/path만 전송 (api-contract 9절)
 → ⑤ 점수·등급 결정 (5절)
 → ⑥ 카드 구성: facts(signals, sources, rules_version, checked_at, actions) + 템플릿 서술(8절)
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
| 16 | `javascript:alert(1)` | (스킴 검사에서 중단) | - | 보안 카드 없음, 9절 |

---

## 8. 사용자 문구 템플릿

보안 카드(`security_card.narration`)와 QR 카드의 문구는 **엑사원 없이 코드 템플릿**으로 만든다. 판정 문구는 일관되고 예측 가능해야 하고, 실호출 측정에서 엑사원이 내부 신호 코드(`GSB_MATCH` 등)를 노출하거나 출력이 깨지는 경우가 있었다. 문구는 평범한 한국어 해요체이며 신호 코드·점수·내부 필드명을 노출하지 않는다.

**구성 규칙**
- `headline`(등급별 1줄) + `explanation`(이유 목록) + `advice`(등급별 행동 안내). `explanation`은 `• `로 시작하는 줄을 `\n`으로 이은 일반 텍스트다 (UI는 일반 텍스트로 렌더링).
- **이유는 점수가 큰 신호 순으로 최대 3개**를 보여 주고 나머지는 "그 외 N가지 주의 신호가 있어요"로 묶는다. 단, `SOURCE_UNAVAILABLE`과 `redirect_unknown` 문구는 개수 제한과 무관하게 항상 표시한다.
- 신호가 없는 `SAFE`는 이유 대신 "확인한 곳: {소스 이름 목록}"을 보여 준다. 소스에 Google이 포함되면 "Advisory provided by Google"을 함께 표기한다.
- 치환 변수(`{tld}`, `{display_domain}`)는 일반 텍스트로 이스케이프한다.

**등급별**
| 등급 | `headline` | `advice` |
| --- | --- | --- |
| SAFE | 알려진 위협은 확인하지 못했어요 (안전을 보증하는 것은 아니에요) | 링크를 열기 전에 주소(도메인)가 맞는지 한 번 더 확인해 주세요. 개인정보나 결제 정보 입력은 신중하게 해 주세요. |
| WARNING | 주의가 필요한 링크예요 | 꼭 필요한 링크가 아니라면 열지 않는 것이 좋아요. 열기 전에 믿을 수 있는 주소인지 확인해 주세요. |
| DANGER | 위험한 링크로 판단했어요 | 이 링크는 열지 마세요. 이미 열었다면 정보를 입력하지 말고 창을 닫아 주세요. 입력했다면 비밀번호를 바꾸고 관련 기관에 문의해 주세요. |

**신호별 이유 문구**
| 신호 | 문구 |
| --- | --- |
| `GSB_MATCH` | 구글 세이프 브라우징에 위험한 사이트로 등록된 주소예요. |
| `URLHAUS_MATCH` | 악성 파일을 퍼뜨리는 주소로 신고된 곳이에요. |
| `KISA_MATCH` | 피싱 사이트로 신고된 주소예요. |
| `IP_HOST` | 도메인 이름 대신 숫자 주소(IP)로 되어 있어요. |
| `USERINFO` | 주소 앞부분에 다른 사이트처럼 보이는 이름이 섞여 있어 실제 접속지를 속일 수 있어요. |
| `MIXED_SCRIPT` | 서로 다른 문자가 섞여 있어 다른 사이트처럼 꾸민 주소일 수 있어요. |
| `PUNYCODE_IDN` | 특수 문자가 들어간 도메인이에요. 비슷한 글자로 다른 사이트를 흉내 낼 수 있어요. |
| `BRAND_LOOKALIKE` | 유명 서비스 이름을 흉내 낸 주소로 보여요. |
| `BRAND_LURE` | 유명 서비스를 사칭하며 로그인·인증을 유도하는 형태예요. |
| `SHORTENER` | 줄임 주소라서 실제로 어디로 연결되는지 확인하지 못했어요. |
| `SHORTENER_FIRST_PARTY` | 서비스 자체 줄임 주소예요. 실제 도착 주소는 확인하지 못했어요. |
| `PRIVATE_HOST` | 인터넷에 공개된 주소가 아니라 내부 네트워크 주소예요. |
| `NEW_DOMAIN_7D` | 만들어진 지 일주일도 안 된 도메인이에요. |
| `NEW_DOMAIN_30D` | 만들어진 지 한 달도 안 된 도메인이에요. |
| `NEW_DOMAIN_90D` | 만들어진 지 3개월이 안 된 도메인이에요. |
| `NEW_DOMAIN_LURE` | 새로 만든 도메인에서 로그인·결제를 유도하는 표현이 보여요. |
| `SUSPICIOUS_TLD` | 악용이 잦은 주소 끝부분({tld})을 쓰고 있어요. |
| `LURE_KEYWORD` | 인증·결제·택배처럼 정보를 입력하게 만드는 단어가 들어 있어요. |
| `NON_HTTPS` | 암호화되지 않은 연결(http)이에요. |
| `NONSTANDARD_PORT` | 일반적이지 않은 접속 포트를 사용해요. |
| `EXCESS_SUBDOMAINS` | 하위 주소가 많아 주소가 비정상적으로 복잡해요. |
| `HOST_HYPHENS` | 주소에 하이픈이 많아요. |
| `LONG_URL` | 주소가 매우 길어요. |
| `SOURCE_UNAVAILABLE` | 일부 보안 정보를 확인하지 못했어요. 그래서 안전하다고 단정할 수 없어요. |
| `redirect_unknown` | 실제 도착 주소는 확인하지 못했어요. |

**QR 카드 문구**
| 상태 | 문구 |
| --- | --- |
| 생성됨 | QR 코드를 만들었어요. 만든 시점({checked_at})에 알려진 위협은 확인하지 못했어요. 이후 링크 내용은 바뀔 수 있어요. |
| 거부: `WARNING` | 주의가 필요한 링크라 QR 코드를 만들지 않았어요. |
| 거부: `DANGER` | 위험한 링크라 QR 코드를 만들 수 없어요. |
| 거부: `UNSUPPORTED_PAYLOAD` | 지금은 웹 주소(URL)만 QR 코드로 만들 수 있어요. |
| 거부: `LOW_CONTRAST` | 선택한 색은 QR 코드가 인식되기 어려워요. 더 진한 색을 골라 주세요. |

- 위 문구는 **초기안**이며 사용성 확인 후 다듬는다. 골든 케이스(7절)의 문구 출력도 스냅샷 테스트로 고정한다.

---

## 9. 스킴·페이로드 처리

- **`http`/`https`만** 보안 카드 대상이다.
- `javascript:`, `data:`, `file:`, `vbscript:`는 **열 수 없는 형식**이다. `text` 카드로 "실행할 수 없는 형식이에요"를 안내하고, 원문은 코드 블록으로 보여 주되 링크로 만들지 않으며 저장하지 않는다.
- `intent://`, `market://`, 앱 딥링크 등 기타 스킴은 비-URL QR과 동일하게 `text` 카드(원문 표시, 자동 실행 안 함)로 처리한다.
- 정규화 후 길이가 2048자를 넘으면 처리하지 않고 재스캔을 안내한다.

---

## 10. 보정·검증 계획

1. **라벨링된 테스트 세트**를 만든다: 정상 URL 100개 이상(국내 주요 서비스, QR 메뉴·결제·택배 조회 실제 사례, 단축 링크 포함)과 악성·피싱 URL 100개 이상(URLhaus 등 공개 피드의 최근 항목, 합성 유사 도메인). 악성 URL은 **접속하지 않고 문자열로만** 다룬다.
2. **목표(초안):** 정상 URL 중 `DANGER` 0건, `WARNING` 10% 이하. 악성 URL 중 `WARNING` 이상 95% 이상 (평판 소스 없이 휴리스틱만으로도 70% 이상).
3. 7절 골든 케이스는 자동 테스트로 고정하고, 가중치를 바꾸면 골든 케이스와 테스트 세트를 모두 다시 실행한다.
4. **운영 중 보정:** 오탐·미탐 신고를 이슈로 받아 규칙 데이터를 갱신하고 `rules_version`을 올린다.

---

## 11. Phase 2 확장

- 헤드리스 렌더링으로 리다이렉션 체인·로그인 폼 탐지 → `redirect_unknown=false`, 새 신호 추가 (`REDIRECT_CHAIN`, `LOGIN_FORM_ON_NEW_DOMAIN`).
- 격리된 AI 소스 분석: **사실 신호만 출력**하고 가중치 상한(예: +20)을 두며, 등급을 낮추지 못한다 (AGENTS.md 3.2 4번).
- 신뢰 도메인 처리(허용 목록의 안전한 형태), 사용자 신고 기반 피드백, 한국 신고 데이터 정식 연동.

---

## 12. 열린 질문

1. **KISA 피싱 차단 목록**을 Phase 1에서 쓸 수 있는가 (data.go.kr 등록 여부·갱신 주기·이용 조건은 아직 미확인). 쓸 수 없으면 `KISA_MATCH`는 Phase 2로 미룬다.
2. **Safe Browsing 필수 소스 지정**의 부작용: 키 발급이 안 되거나 상업 전환 전 한도가 부족하면 모든 URL이 `WARNING`이 된다. 대안 필수 소스(예: URLhaus 단독 허용)를 허용할지.
3. **가중치와 임계값(30/70)** 은 테스트 세트(10절) 결과로 조정한다. 특히 **8b처럼 브랜드 사칭 + 유도 문구인데 남용 TLD가 아니고 RDAP 정보가 없으면 `WARNING`에 그친다.** `WARNING`은 재확인 후 이동할 수 있으므로, `BRAND_LURE` 가중치를 더 올리거나 RDAP 실패 시 신규 도메인으로 간주할지 검토한다.
4. **RDAP `.kr` 지원 여부**를 확인해야 한다 (`NEW_DOMAIN_*`가 국내 도메인에 적용되는지).
