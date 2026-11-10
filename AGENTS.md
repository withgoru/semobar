# AGENTS.md - 세모바 (세상 모든 바코드 / Semoba)

## 1. Project Overview
- **서비스명:** 세모바 (세상 모든 바코드)
- **한 줄 정의:** 바코드/QR 코드 스캔(Read)부터 맞춤형 코드 생성(Write)까지 아우르는 대화형 AI 에이전트(CUI) 기반의 메신저형 PWA 웹 서비스.
- **핵심 가치:**
  1. **글로벌 프로덕트 인텔리전스:** 해외/국내 상품 바코드 스캔 시 제품 상세 정보(성분, 용도, 특징)를 한글로 번역·요약하고, 제품명으로 **구글 검색 링크**를 제공해 가격·구매처 탐색은 외부로 연결. (가격 검색·최저가 비교·크롤링은 Phase 2)
  2. **큐싱(Qshing) 안심 방패:** QR 코드(URL) 스캔 시 브라우저 즉시 이동을 막고, 보안 DB 조회 및 URL 규칙 분석(코드 판정)으로 위험도를 선제 브리핑. 판정과 사용자 문구는 모두 코드(템플릿)가 만든다.
  3. **양방향 QR 생성(부가 기능):** 자연어 명령으로 URL의 보안 검증(SAFE)을 거친 맞춤형 컬러 QR 코드를 생성 및 R2 호스팅.
- **Phase 1 범위:** "바코드 → 한글 제품 요약(+ 구글 검색 링크)", "QR 위험 브리핑"이 핵심. QR 생성은 부가 기능. **가격 검색·최저가 비교·크롤링은 Phase 1에서 제외(Phase 2).** UI 언어는 한글 단일.

### 관련 설계 문서 (상세 계약은 `docs/`가 기준)
| 문서 | 내용 |
| --- | --- |
| `initiative.md` | 서비스 기획·기능·아키텍처 개요 |
| `docs/api-contract.md` | 카드 스키마(facts/narration), 엔드포인트, 오류·쿼터 형식, 엑사원 호출 규약, 개인정보·PWA 규칙 |
| `docs/db-schema.md` | D1 DDL, KV 캐시, 바인딩·환경 변수 이름 |
| `docs/llm-budget.md` | 엑사원 호출 한도 통제 (실측 한도, 호출 간격 게이트, 단계적 축소, 개발 모드 해제) |
| `docs/security-scoring.md` | 보안 점수 규칙(신호·가중치·등급), 사용자 문구 템플릿, 골든 케이스 |
| `docs/test-strategy.md` | 테스트 계층과 우선순위 |

이 문서(AGENTS.md)는 원칙·로드맵·결정 사항의 요약이며, 세부 계약이 충돌하면 `docs/`가 우선한다.

---

## 2. Tech Stack & Architecture (Phase 1: Serverless MVP)
- **Framework:** SvelteKit (Svelte 5 Runes 문법 권장), TypeScript
- **App Format:** PWA (Manifest & Service Worker 필수). Service Worker는 정적 자산만 precache하고 `/api/*`·`/q/*`는 network-only (`docs/api-contract.md` 10절).
- **Deployment / Compute:** Cloudflare Workers (`@sveltejs/adapter-cloudflare`)
- **Database:** Cloudflare D1 (Edge SQLite) — 세션·메시지(카드 JSON)·QR 메타·AI 카운터·호출 간격 게이트·narration 캐시 (`docs/db-schema.md`)
- **Cache / Rate limit:** Cloudflare KV `CACHE`(외부 조회 캐시, `pause_until`, 차단 목록), 일반 요청 빈도는 Workers Rate Limiting 바인딩(사용 가능 시)
- **Object Storage:** Cloudflare R2 `BUCKET` — **생성된 QR SVG 전용**. 상품 이미지는 R2에 복사하지 않고 출처 URL을 hotlink + 출처 표기 (Open Food Facts 이미지는 CC BY-SA).
- **AI Engine:** LG AI연구원 **K-EXAONE 2.5** API (`k-exaone_v2.5`, OpenAI 호환 `https://api.exaone.ai/v1/chat/completions`)
  - **제공자 한도(실측): 초당 1회, 분당 60회.** 지연은 단순 호출 1.4~5초, 서술·도구 호출 9.5~27.4초. 추론을 끌 수 없고 `max_tokens`에 추론 토큰이 포함된다.
  - **Tool Calling: 사용** (동작 확인). **`response_format`(Structured Outputs)은 사용하지 않는다** (`json_schema` 52초, `json_object`는 스키마 무시). 구조화 출력은 도구 강제 호출(`tool_choice`)로 받는다.
  - 호출 시 `reasoning_effort=low`, 서버 측 응답 검증·재시도, 제공자 교체 가능한 추상화. 키는 `EXAONE_API_KEY`(시크릿).
- **Client Libraries:**
  - Barcode/QR Reader: 클라이언트 디코딩. **`BarcodeDetector` 우선 + `zxing-wasm` 폴백** (지연 로딩). `html5-qrcode`는 사용하지 않는다.
  - QR Generator: 의존성 없는 SVG 생성 라이브러리(`uqr` / `qrcode-svg` 중 선정)로 Workers에서 **SVG만** 생성해 R2에 업로드. PNG는 클라이언트 canvas 변환.
- **Cron:** 만료 데이터 정리용. `adapter-cloudflare`가 `scheduled` 핸들러를 직접 노출하지 않을 수 있어 Step 1에서 확인하고, 불가하면 정리 전용 별도 Worker로 분리한다.

---

## 3. Core Agent Workflows & Tool Definitions
상세 계약(타입·엔드포인트·오류)은 `docs/api-contract.md`가 기준이다.

### 3.0 역할 분담 원칙 (Division of Responsibility) — 최우선 규칙
- **코드(결정론적)가 하는 일:** 바코드/QR 디코딩, 입력 유형·도구 분기, 외부 DB·API 조회, **보안 등급 판정과 보안·QR 카드 문구(템플릿)**, QR 이미지 생성, 저장, 한도 통제.
- **엑사원(K-EXAONE 2.5)이 하는 일:** (a) **제품 서술**(한글 요약·번역)과 (b) **채팅 답변·파라미터 추출**만 한다. 보안 판정·보안 카드·QR 카드에는 관여하지 않는다.
- **엑사원은 사실을 만들지 않는다.** 코드가 조회한 데이터 안에서만 답하고, 데이터에 없는 항목(성분, 가격, 부작용 등)은 추측하지 않고 "정보 없음"/`null`로 둔다.
- **코어는 AI 없이 동작한다.** 스캔·보안 검증·QR 생성은 엑사원이 막혀도(한도·장애) 계속 동작한다 (`docs/llm-budget.md`).

### 3.1 요청 처리 흐름
**A. 스캔 입력 (`POST /api/scan`, 코드 분기, LLM 라우팅 없음)**
```
스캔 문자열 → 코드가 유형 분기(1D 바코드 / URL / 기타 QR)
  → 코드가 도구를 직접 실행 → facts 카드 구성 → D1 저장 → 즉시 응답
  → 제품 카드만: narration_status="pending"이면 클라이언트가
    POST /api/messages/:id/narration 호출 → 엑사원(도구 강제 호출)이 서술 생성 → 카드에 기록
```
- 보안 카드·QR 카드는 서술이 코드 템플릿이라 엑사원을 부르지 않는다.
- 제품 서술은 narration 전역 캐시(D1)를 먼저 조회한다 (같은 상품은 호출 1회).

**B. 채팅 텍스트 입력 (`POST /api/chat`: 꼬리 질문, QR 생성, 링크 질문)**
```
메시지 → 코드 선분기(URL + QR 키워드 → QR 생성 / URL + 안전·검사 키워드 → 링크 검사)
  → 그 외 → 엑사원(맥락 + tool_choice=auto, 도구 2개: generate_custom_qr, verify_url_security)
  → 서버가 도구 인자 검증·정규화 후 코드가 실행 → 보안/QR 카드(템플릿) 또는 모델 답변 텍스트
```
- **도구 선택은 코드가 먼저 확정한다** (실측: 모델이 "QR 만들어줘"에 링크 검사 도구를 호출한 오류). 모델은 파라미터 추출과 일반 답변을 맡는다.
- 서버가 파라미터를 정규화한다: 색 이름 → `#RRGGBB`, 변환 불가 시 기본색 `#001F3F`, `bg_transparent`는 사용자가 "투명"을 말한 때만 인정.
- `search_global_product`는 **채팅에서 제공하지 않는다** (스캔 경로 전용). 제품 꼬리 질문은 맥락의 카드 facts로 답한다.
- **맥락 공유:** 스캔 결과(facts + 서술)는 대화 메시지로 저장되어 이후 `/api/chat`의 맥락이 된다 (최근 8개 메시지, 카드는 facts 요약만).
- **응답 범위(Phase 1):** 스캔한 상품·링크에 대한 질문만 처리하고, 범위 밖 질문은 정중히 안내한다.
- 채팅은 스트리밍하지 않는다 (중앙값 4.7초, 최대 14.9초 → "입력 중" 표시, 타임아웃 20초).

### 3.1.1 카드 생성 규칙 (사실 필드 vs 서술 필드)
- 모든 assistant 카드는 `facts`(코드가 채움)와 `narration`으로 나뉜다. **서버가 응답을 병합할 때 `facts`는 항상 코드 값으로 덮어쓴다.**
- `narration`의 출처: 제품 카드 = 엑사원(비동기), **보안·QR 카드 = 코드 템플릿**.
- `narration_status`: `ok` / `pending`(제품 서술 대기) / `skipped`(템플릿으로 충분해 의도적으로 생략, UI 문구 없음) / `unavailable`(실패·한도 초과, "AI 설명은 잠시 제공되지 않아요" 표시).
- 엑사원 출력은 **서버 검증을 통과한 것만** 저장·캐시한다 (스키마, 길이, 금지 패턴, 한글 포함). 실패 시 1회 재시도.
- DB·외부 유래 문자열(제품명, 성분)은 신뢰할 수 없는 데이터다: 엑사원에는 `<data>`로 감싸 전달하고, 서술은 일반 텍스트로만 렌더링한다.

### Tool 1: `search_global_product` (스캔 경로 전용)
- **Trigger:** 1D 바코드 스캔(코드가 직접 호출). 채팅에서는 호출하지 않는다.
- **Parameters:** `barcode` (string)
- **Execution (전부 코드):**
  1. 체크디지트 검증 후 GTIN-13 정규화. 접두사 `20`~`29`(매장 자체 코드)는 조회하지 않고, `978`/`979`(도서)는 UPCitemdb만 조회한다.
  2. KV 캐시(`gtin:`) 조회 후 글로벌 바코드 DB 조회: Open Food Facts → UPCitemdb(폴백). 소스별 출처·라이선스를 결과에 포함한다 (Open Food Facts는 ODbL: 출처 표기·동일 조건 공유 의무).
  3. **가격 조회·쇼핑 API·크롤링은 하지 않는다 (Phase 2).** 코드가 제품명(+브랜드)으로 **구글 검색 URL**(`https://www.google.com/search?q=...`)을 만들어 사실 필드로 담는다 (API·스크래핑 없이 링크, 새 탭).
- **카드:** `product_card`. **DB 미적중 시 제품 정보를 만들지 않고 "정보 없음" 카드(`skipped`)** 를 반환하며 **바코드 번호로 만든 구글 검색 링크**를 함께 제공한다 (실측: 화장품·의약품 적중률 0%이므로 핵심 경로).
- **서술:** 엑사원이 `write_product_narration` 도구 강제 호출로 `{ name_ko, summary, usage|null, ingredients_note|null, caution|null }`을 작성 (`docs/api-contract.md` 6.1). 외국어 성분·제품명은 한국어로 옮기고 없는 정보는 `null`.

### Tool 2: `verify_url_security`
- **Trigger:** QR로 `http(s)` URL이 스캔되었을 때(코드 직접 호출) 또는 채팅에서 링크 안전성 질문이 코드 선분기/모델 도구 호출로 확정되었을 때.
- **Parameters:** `url` (string)
- **Execution (전부 코드, 결정론적, 상세는 `docs/security-scoring.md`):**
  1. 로컬 규칙 분석: 펀니코드·혼합 문자, 유사 브랜드, 단축 URL, IP 호스트, userinfo 속임수, 신규 도메인 등 신호 생성.
  2. 소스 조회(병렬, 개별 3초): **필수 = Google Safe Browsing**(수익화 전 Lookup, 상업 전환 시 Web Risk), 선택 = URLhaus **조회 API**, RDAP 도메인 연령, KISA(가용 시). 외부에는 `scheme://host/path`만 보낸다 (쿼리·프래그먼트 제거).
  3. 평판 소스 적중은 즉시 `DANGER`, 휴리스틱 신호는 점수 합산(0–29 `SAFE`, 30–69 `WARNING`, 70+ `DANGER`). **필수 소스가 실패하면 등급 하한 `WARNING`** (`SAFE` 불가).
- **카드:** `security_card`. `narration`(headline/explanation/advice)은 **코드 템플릿** — 신호 코드·점수를 노출하지 않는다.
- **등급별 정책:** `SAFE` → 이동 허용(`display_domain` 크게 표시). `WARNING` → 경고 확인 단계(위험 신호 안내 + 사용자 재확인) 후 이동 허용. `DANGER` → 이동 차단. QR 생성은 `SAFE`만.

#### 3.2 보안 판정 정책 (Qshing Policy)
1. **판정과 문구는 코드가 만든다.** 외부 페이지 소스·응답 본문은 엑사원 프롬프트에 넣지 않는다. Phase 1에서는 AI가 점수에 기여하는 신호도 두지 않는다 (프롬프트 인젝션 차단).
2. **비대칭 규칙:** 어떤 규칙도 등급을 내리지 못한다 (소스 실패 하한도 올리기만 한다). Phase 2에 AI 신호가 도입되더라도 등급을 **올릴 수만** 있다.
3. **표기:** `SAFE`는 "안전 보증"이 아니라 **"알려진 위협을 확인하지 못함"** 이다. 카드에는 `display_domain`(URL의 호스트)을 크게 보여 준다. **리다이렉션을 따라가지 않으므로 "최종 도착 주소"가 아니다** — 단축 URL은 최소 `WARNING`이며 "실제 도착 주소는 확인하지 못했어요"를 표기한다 (`redirect_unknown`).
4. **낡은 판정 재사용 금지:** 보안 카드는 `checked_at`이 24시간을 넘기면 이력 조회 시 이동 버튼을 끄고 "다시 검사"로 바꾼다 (`stale`).
5. **외부 전송·저장 최소화:** 외부 소스와 DB에는 쿼리·프래그먼트를 제거한 URL만 보내고 저장한다 (`docs/api-contract.md` 9절). 엑사원에는 URL을 보내지 않는다.
6. **Phase 2 이관:** 헤드리스 브라우저 렌더링(리다이렉션 체인, 가짜 로그인 폼), 격리된 AI 소스 분석(사실 신호만 출력, 소스 fetch 시 SSRF 차단). Cloudflare Browser Rendering을 우선 검토하되 무료 한도(하루 10분)로는 부족해 유료 전제.
7. **URL이 아닌 QR 페이로드**(Wi-Fi, vCard, 앱 인텐트)와 `javascript:`/`data:` 등 비-`http(s)` 스킴은 보안 카드 대신 `text` 카드로 안내하며 자동 실행하지 않고 **원문을 저장하지 않는다**.

### Tool 3: `generate_custom_qr`
- **Trigger:** 사용자가 채팅에서 **URL**을 QR 코드로 만들어달라고 요청할 때 (코드 선분기 또는 모델 도구 호출). Phase 1은 URL만 지원하며 텍스트·Wi-Fi 등은 지원하지 않는다고 안내한다.
- **Parameters:** `url` (string), `color_hex` (string, default `#001F3F`), `bg_transparent` (boolean) — 서버가 정규화·검증한다 (위 3.1 B).
- **Execution (전부 코드):**
  1. `verify_url_security`를 선행 실행. **`SAFE`일 때만 생성**하고 `WARNING`/`DANGER`는 거부한다(사유 안내).
  2. QR을 **SVG로 생성**하고 전경/배경 **명도 대비를 검증**한다 (인식 불가 조합은 거부 또는 보정). `color_hex`는 `/^#[0-9A-Fa-f]{6}$/`만 허용 (SVG 주입 방지).
  3. R2에 업로드. 객체 키는 UUIDv4, 이미지는 Worker 경로 `/q/:id.svg`로 서빙 (보안 헤더·CSP 포함).
- **카드:** `qr_card`. `narration`은 코드 템플릿. 거부 시에는 사유와 함께 `security_card`를 덧붙일 수 있다.
- **뱃지 문구 주의:** "세모바 안심 인증"은 **생성 시점에 알려진 위협이 없었다**는 의미일 뿐 이후 링크 내용의 안전을 보증하지 않는다. 검증 시각을 함께 표기하고 과도한 안심 표현을 피한다.

---

## 4. UI/UX & Styling Guidelines (Strict Constraints)
- **레이아웃:** 모바일 퍼스트 메신저 채팅창 UI (카카오톡/ChatGPT 스타일).
  - 하단 입력바 우측에 `[📷 스캔]` 버튼을 배치하고, 클릭 시 화면 하단 절반을 덮는 **바텀 시트(Bottom Sheet)** 형태로 웹캠 스캐너를 띄움.
- **컬러 팔레트 (엄격 준수):**
  - **Primary Color:** Navy Blue (`#001F3F`)
  - **Secondary / Accent Color:** Sky Blue (`#00BFFF`)
  - **절대 금지 규칙 (Banned Colors):** 브랜드 테마, 버튼, 일반 UI 배지, 기본 QR 생성 컬러 등 디자인 전반에서 **빨간색(Red)과 초록색(Green) 사용을 엄격히 금지**함.
  - *보안 상태 표시 대안 컬러:*
    - 안전 (`SAFE`): Sky Blue (`#00BFFF`) 또는 Navy Blue (`#001F3F`)
    - 주의 (`WARNING`): Amber / Gold (`#F59E0B`)
    - 위험 (`DANGER`): Dark Purple (`#581C87`) 또는 High-Contrast Charcoal/Black (`#18181B`) + 경고 아이콘으로 직관성 확보.
- **카드 상태 표현:**
  - 제품 카드가 `pending`이면 facts를 먼저 보여 주고 서술 영역에 "설명 작성 중…" 스켈레톤을 표시한다 (최대 약 30초).
  - `skipped`는 안내 문구를 띄우지 않고, `unavailable`만 "AI 설명은 잠시 제공되지 않아요"를 작게 표시한다.
  - 보안 카드: `display_domain`을 크게, 단축 URL 등은 "도착 주소 확인 불가" 표기, `stale`이면 이동 대신 "다시 검사" 버튼. 점수 숫자는 노출하지 않는다.
  - 채팅 입력 근처에 "오늘 AI 대화 N/M"(`quota`)을 표시하고 `degraded`면 배너, 한도 도달 시 입력 비활성 + 재개 시각. 스캔은 계속 가능하다고 안내한다.
  - 개발 모드(`quota.debug`)에서는 "개발 모드: 제한 없음"을 표시한다.

---

## 5. Data & Storage Rules (Client Load Prevention)
- **No Heavy LocalStorage:** 브라우저 `localStorage`나 클라이언트 메모리에 무거운 리치 데이터(이미지, 전체 로그)를 쌓지 않는다.
- **Cloud Sync & Pagination:**
  - 화면에는 최근 메시지 20~30개만 유지.
  - 모든 대화와 카드 JSON은 **Cloudflare D1** `messages`에 저장하고(응답과 병행), 이전 내역은 위로 스크롤 시 커서 기반 페이지네이션(`GET /api/history?cursor=...`)으로 불러온다. Phase 1에는 `scan_archives` 테이블이 없다 (Phase 2).
- **카드 응답 형식:** `type: "text" | "product_card" | "security_card" | "qr_card"` (사용자 메시지는 `text` | `scan`). 말풍선 컴포넌트가 즉시 분기 렌더링할 수 있도록 `docs/api-contract.md`의 스키마를 엄격히 준수한다. 엑사원 출력은 서술 필드만이며 서버가 검증한다 (Section 3.1.1).
- **Session & Retention (Phase 1):**
  - 로그인 없이 **익명 세션(쿠키 `sid`, 토큰은 SHA-256 해시로만 저장)**. 아카이브는 **해당 기기·브라우저 한정**이며 쿠키 삭제·기기 변경 시 복구 불가. 로그인·기기 간 동기화는 Phase 2.
  - 보관 기간은 마지막 사용 후 **슬라이딩 90일**, QR 이미지(R2)도 만료 정리. `DELETE /api/history`로 사용자가 즉시 전체 삭제 (R2 객체 삭제 → DB 삭제 순서).
  - **개인정보:** 비-URL QR 원문은 저장하지 않는다. URL은 쿼리·프래그먼트를 제거해 저장한다. IP는 해시로만 사용한다. 개인정보 처리 안내(외부 보안 조회로 URL 전달 가능성 등)를 서비스에 둔다.

---

## 6. Next Implementation Roadmap (코딩 에이전트 우선 작업 순위)
이 문서를 읽은 에이전트는 아래 순서대로 작업을 이어서 진행한다. 구현은 항상 이슈 → 브랜치 → PR 규칙(Section 8)을 따른다.

- [ ] **Step 0.1: GitHub 저장소 설정 (Section 8 참조)**
  - [x] 라벨 체계 적용 (기본 라벨 삭제 후 Section 8.5 체계로 재생성)
  - [ ] 마일스톤(`Phase 1 MVP`) 생성, 로드맵 Step을 이슈로 등록
  - [ ] main 브랜치 보호 적용 (저장소는 공개 상태 — 규칙은 Section 8.4)
- [ ] **Step 0: 검증 스파이크 (Section 7 참조)**
  - [x] 웹 조사, 바코드 DB 적중률 1차 측정, **EXAONE 실호출 측정 완료** (2026-11-10, 결과: Section 7)
  - [ ] 남은 검증: 실제 해외 상품 바코드 재측정, 실기기 스캔, KISA 데이터셋, SVG QR 라이브러리의 Workers 동작, Safe Browsing 약관·Web Risk 가격, ODbL 파생 DB 해당 여부 (Section 7 "남은 검증")
  - 국내 가격 매칭은 Phase 2로 이관되어 제외
- [x] **Step 0.5: API 계약·응답 스키마·DB·한도·보안 점수 설계** — `docs/` 참조 (카드 스키마, 엔드포인트, D1 DDL, 호출 한도 통제, 보안 점수 규칙, 테스트 전략)
- [ ] **Step 1: 프로젝트 초기화와 인프라**
  - SvelteKit 초기화(`adapter-cloudflare`, TypeScript, PWA), 린트·타입체크·Vitest 설정
  - `wrangler.toml`: 바인딩 `DB`(D1), `BUCKET`(R2), `CACHE`(KV), `REQ_LIMITER`(Rate Limiting, 가능 시), `[vars]`(기본 `APP_ENV=production`, `LIMITS_MODE=enforce`, `EXAONE_*`, `LLM_*` — `docs/db-schema.md` 6절, `docs/llm-budget.md` 9절). 로컬은 `.dev.vars`(`EXAONE_API_KEY`, 개발 시 `APP_ENV=development`, `LIMITS_MODE=off`).
  - `schema.sql`: `docs/db-schema.md`의 DDL (`sessions`, `messages`, `qr_assets`, `llm_usage`, `llm_gate`, `narration_cache`). Cron 구현 방식 확인(`scheduled` 지원 여부, 불가 시 별도 Worker).
- [ ] **Step 2: AI 연동·한도 통제 모듈**
  - `src/lib/server/exaone.ts`: 클라이언트(`reasoning_effort=low`, 타임아웃 20/30초, `reasoning_content` 폐기), 도구 정의 2개(채팅) + `write_product_narration`(서술), 프롬프트 v1, 서버 검증·재시도, 제공자 교체 추상화.
  - `src/lib/server/llm-budget.ts`: D1 원자 카운터, **호출 간격 게이트(1.2초)**, 단계적 축소(L0~L3), 429·서킷 브레이커, **개발 모드 해제(3중 조건)** 및 디버그 헤더. 수용 기준 테스트 포함 (`docs/llm-budget.md` 10절).
- [ ] **Step 3: 보안 판정 모듈** (`docs/security-scoring.md`)
  - 규칙 데이터 `data/security/*.json`, 신호 생성·점수·등급 **순수 함수**, 소스 어댑터(Safe Browsing, URLhaus 조회, RDAP), 문구 템플릿. 골든 케이스 단위 테스트, `SOURCES_MODE=mock`.
- [ ] **Step 4: 서버리스 API 라우트** (`docs/api-contract.md`)
  - `POST /api/scan`, `POST /api/chat`, `POST /api/messages/:id/narration`, `GET`·`DELETE /api/history`, `GET /q/:id.svg`, 세션 쿠키, 요청 레이트 리밋, narration 캐시, QR 생성(SVG)·R2 업로드.
- [ ] **Step 5: 프론트엔드 메신저 UI 및 스캐너 컴포넌트**
  - Navy/Sky Blue 테마 채팅 레이아웃, 카드 4종 + 서술 `pending` 처리, 바텀 시트 스캐너(`BarcodeDetector` + `zxing-wasm` 폴백), 쿼터 표시, PWA 설정.
- [ ] **Step 6: CI와 마무리**
  - `.github/workflows/` PR 검증(lint·typecheck·test·build), 배포 방식 확정, 비공개 베타 배포, 실기기 테스트.

---

## 7. Design Decisions & Open Verification Items

### 확정된 설계 결정
| 결정 | 내용 |
| --- | --- |
| 역할 분담 | 조회·판정·생성·보안/QR 문구는 코드, **엑사원은 제품 서술과 채팅 답변만** (Section 3.0) |
| 라우팅 | 스캔은 코드 분기. 채팅은 **코드 선분기 + Tool Calling(파라미터 추출)**, 도구 인자는 서버가 정규화 |
| 구조화 출력 | `response_format` 미사용 (실측 52초). **도구 강제 호출**로 받고 서버 검증·재시도 |
| 제품 서술 | **비동기**: facts 즉시 → `POST /api/messages/:id/narration`. narration 전역 캐시, 한글 포함 검증 |
| 보안 판정 | 코드가 확정, 보안·QR 카드 문구는 **코드 템플릿**. `SAFE`는 "알려진 위협을 확인하지 못함", 필수 소스(Safe Browsing) 실패 시 하한 `WARNING` (`docs/security-scoring.md`) |
| 환각 방지 | 조회 데이터 밖의 사실 생성 금지, 미적중 시 "정보 없음" |
| 카드 생성 | `facts`는 코드(항상 덮어씀), `narration_status`는 ok/pending/skipped/unavailable (Section 3.1.1) |
| 엔드포인트 | `POST /api/scan`, `POST /api/chat`, `POST /api/messages/:id/narration`, `GET`·`DELETE /api/history`, `GET /q/:id.svg` |
| 등급별 정책 | `SAFE` 이동 허용 / `WARNING` 재확인 후 이동 / `DANGER` 차단. QR 생성은 `SAFE`만. 단축 URL은 최소 `WARNING`. 24시간 지난 카드는 재검사 |
| AI 호출 한도 | 제공자 **초당 1회·분당 60회**(실측) → 호출 간격 게이트 1.2초, 전역 분당 48회, 세션 채팅 일 20회(제안). 사용자 한도 = 메시지 1건당 1, 전역 = 실제 호출 수 (`docs/llm-budget.md`) |
| 개발 모드 | `APP_ENV=development` + `LIMITS_MODE=off` + 로컬 호스트일 때만 앱 한도 해제 (제공자 429·호출 간격 게이트는 유지) |
| 채팅 범위 | Phase 1은 스캔 맥락 안의 상품·링크 질문만 처리 |
| QR 생성 | Phase 1은 URL만, 부가 기능, 서버는 SVG만 |
| 세션·보관 | 익명 세션(기기 한정), 슬라이딩 90일, 로그인은 Phase 2 |
| 개인정보 | 쿼리·프래그먼트 제거 후 외부 전송·저장, 비-URL QR 원문 미저장, IP 해시 |
| 상품 이미지 | hotlink + 출처 표기 (R2 복사 안 함) |
| 스트리밍 | Phase 1 비스트리밍 |
| UI 언어 | 한글 단일 |
| 가격 검색 | **Phase 1 제외**, 제품명 구글 검색 링크로 대체 (미적중 시 바코드 번호 링크). 가격 조회·최저가·크롤링은 Phase 2 |
| Phase 2 | 헤드리스 분석(Browser Rendering, 유료 전제), 가격 검색, AI 소스 분석, `scan_archives`·아카이브 화면, 로그인. Go/Python/Tabular는 데이터 축적 후 재평가 |

### 미결정 (제품 성격)
- **포트폴리오/기술 데모 vs 서비스:** 미정. Phase 1은 포트폴리오 수준 범위로 진행하되, 서비스화 시 (1) 수익 모델(예: 제휴 링크)과 (2) 차별점(예: 한국 특화 큐싱 DB)을 재검토한다. 제공자 한도(분당 60회)상 공개 서비스에는 증설이 필요하다.

### 스파이크 결과 (2026-11-10: 웹 조사 + 직접 측정)
웹 조사 항목은 조사 에이전트 보고 기준이며, "남은 검증"에 적은 것은 직접 확인 전까지 가정으로 취급한다.

1. **바코드 DB 적중률 (직접 측정):** 28개 샘플 중 12개 적중 — 식품 9/11, 한국 식품 1/2, **화장품 0/8, 의약품 0/4**, 일반 전자 1/2, 도서 1/1. 소스별로는 Open Food Facts 10건, UPCitemdb 6건, Open Beauty/Products Facts 0건.
   - 한계: 샘플은 기억에 의존한 바코드라 일부가 잘못된 코드일 수 있고(UPCitemdb 400 응답 2건), UPCitemdb는 무료 한도(429, 16건)에 걸려 과소 측정됐다.
   - **결론:** 식품은 Open Food Facts로 상당수 커버되지만 화장품·의약품은 무료 DB로 기대하기 어렵다. **"정보 없음" 카드 + 검색 링크 폴백 UX를 핵심 경로로 설계한다.**
2. **국내 가격 매칭:** Phase 2로 이관 (네이버 쇼핑 API의 GTIN 검색 지원·약관은 확인하지 못함). 해외 가격 API는 무료 한도가 작고(UPCitemdb 일 100건) 유료는 월 $75~.
3. **K-EXAONE 2.5 (실호출 27회로 측정, 상세: `docs/llm-budget.md` 0절, `docs/api-contract.md` 4.2·6):**
   - **한도:** 응답 헤더 기준 **초당 1회, 분당 60회, 일 86,400회** (사실상 분당 60회). 429 응답 자체는 유발해 보지 않았다.
   - **지연:** 단순 호출 1.4~5초, 서술·도구 호출 9.5~27.4초, 채팅 도구 분류 중앙값 4.7초·최대 14.9초. `reasoning_effort=low`는 받아들이지만 추론 토큰 수는 크게 줄지 않는다(77 vs 96). **`max_tokens`에 추론 토큰이 포함**되어 300이면 content가 비어 온다.
   - **Tool Calling: 동작.** OpenAI 호환, `tool_choice`로 강제 가능. 채팅 의도 12건 중 10건 정확 (오류: "QR 만들어줘"에 링크 검사 도구 선택, 색상 `"navy"` 형식 오류 + `bg_transparent` 임의 지정). 인젝션 시도와 범위 밖 질문은 거절.
   - **Structured Outputs(`response_format`): 사용하지 않음.** `json_schema`는 결과는 맞지만 52초(추론 1,044토큰), `json_object`는 스키마 무시.
   - **서술 품질:** 정보가 없을 때 지어내지 않음(3/3), 인젝션 제품명 무시(1/1). 단 출력 깨짐 1/6, 영어 성분을 번역하지 않고 복사, 보안 설명에 내부 신호 코드 노출 → 제품 서술 프롬프트 v1·서버 검증으로 대응하고 **보안 카드 문구는 템플릿으로 확정**.
   - 응답 형식: `content`가 `\n\n`으로 시작하고 `reasoning_content`가 별도로 온다. 무료 공개(2026-11-09) 직후라 한도·무료 기간·상업 이용 조건은 변경 가능하며 확인하지 못했다.
4. **보안 DB:**
   - Google Safe Browsing(v4)은 **비상업 용도 한정**이며 상업 이용은 Web Risk(월 10만 건 무료, 2차 출처). Google 데이터 기반 경고에는 **"Advisory provided by Google" 표기**가 필요하다. Lookup API는 전체 URL을 Google에 보내므로 쿼리·프래그먼트를 제거해 전송한다 (프라이버시가 더 필요하면 Update API).
   - URLhaus: 무료·인증키 필요·멀웨어 위주. PhishTank: 신규 가입 불가. VirusTotal 무료: 상업 이용 금지(제외).
   - 한국 소스: KISA 피싱 차단 목록이 data.go.kr에 있다는 것은 제3자 문서 기준 추정. 더치트·경찰청은 공개 API 없음.
   - 도메인 연령은 RDAP를 Workers에서 호출하고 KV로 캐시한다 (`.kr` 지원 여부 미확인).
   - **MVP 조합:** Safe Browsing(필수) + URLhaus **조회 API**(덤프 동기화는 KV·D1 쓰기 한도 때문에 쓰지 않음) + RDAP + 자체 규칙 점수. 소스는 어댑터로 분리하고 출처·라이선스 플래그를 응답에 담는다.
5. **클라이언트 스캐너:** `html5-qrcode`는 2023-04 이후 릴리스가 없고 maintenance mode라 **제외**. iOS Safari는 `BarcodeDetector`가 기본 비활성이다. **채택: `BarcodeDetector` 우선 + `zxing-wasm` 폴백**(iOS는 폴백이 주 경로, 번들 약 1~1.5MiB → 지연 로딩·PWA 캐시).
6. **QR 생성·인프라:** 서버는 **SVG만 생성**(의존성 없는 `uqr`/`qrcode-svg` 계열)하고 PNG는 클라이언트 canvas에서 변환한다. Workers 무료 플랜 CPU 시간은 10ms. Cloudflare Browser Rendering 무료는 하루 10분이라 **Phase 2 헤드리스 분석은 유료 플랜을 전제**로 한다.

### 남은 검증 (직접 확인 필요)
1. **실제 해외 상품 바코드 재측정:** 보유 상품 10~30개의 바코드로 적중률을 다시 측정 (특히 화장품·의약품).
2. **실기기 스캔 테스트:** iOS/Android에서 저조도·1D 바코드 인식률.
3. **KISA 피싱 차단 목록:** data.go.kr 실제 등록 여부, 갱신 주기, 이용 조건. RDAP `.kr` 지원 여부.
4. **QR 라이브러리:** 선택한 SVG 라이브러리의 Workers(`wrangler dev`) 동작·CPU 시간.
5. **Safe Browsing 약관 원문**과 Web Risk 가격 재확인, **EXAONE 이용약관(상업 이용)** 과 429 실제 동작(복구 시간).
6. **ODbL:** Open Food Facts 조회 결과를 KV·`narration_cache`에 저장하는 것이 "파생 데이터베이스"(동일 조건 공유 의무)에 해당하는지.
7. **SvelteKit Cron:** `adapter-cloudflare`에서 `scheduled` 핸들러 지원 여부(Step 1).
8. **제품 서술 프롬프트 v1**의 실호출 재측정(번역·한글 포함·깨짐률)과 **보안 문구 템플릿** 사용성 확인.
9. **보안 점수 보정:** 정상·악성 URL 테스트 세트로 가중치·임계값 보정 (`docs/security-scoring.md` 10절).

### 알려진 리스크 및 정책
- **비용/남용/용량:** 제공자 한도가 분당 60회라 전역 AI 호출은 분당 48회가 상한이다. 캐시·템플릿·비동기 서술이 필수이며 익명 엔드포인트 레이트 리밋과 세션·IP 한도를 둔다. 초기에는 링크 공유 한정 비공개 베타를 권장한다.
- **지연:** 서술·채팅이 최대 27초까지 걸릴 수 있어 facts를 먼저 보여 주고 서술은 비동기로 채운다.
- **개인정보:** 스캔 URL이 외부 보안 소스로 나갈 수 있다. 쿼리·프래그먼트 제거, 고지, 보관 기간·삭제 기능으로 관리한다.
- **R2 악용:** 검증 우회 시 피싱 QR 호스팅으로 악용될 수 있으므로 키 비추측성, `DANGER`/`WARNING` 거부, 업로드 제한, 보안 헤더를 유지한다.
- **캐시 오염:** 공유 narration 캐시는 검증을 통과한 서술만 저장하고 키에 facts 해시를 포함하며, 프롬프트 버전으로 일괄 무효화한다.
- **MVP 범위:** 핵심은 "바코드 → 한글 제품 요약(+ 구글 검색 링크)"과 "QR 위험 브리핑". 가격 검색·최저가·크롤링은 Phase 2, QR 생성은 부가 기능.
- **보안 등급 색상:** 적색·녹색 금지 규칙(Section 4)에 따라 `DANGER`의 직관성은 아이콘·문구로 보강한다.

---

## 8. Work Rules (GitHub Workflow)
저장소: `withgoru/semobar`. 사람과 코딩 에이전트 모두 아래 규칙을 따른다.

### 8.1 브랜치 전략 (GitHub Flow)
- `main`은 항상 배포 가능한 상태를 유지하며 **직접 푸시하지 않는다.**
- 모든 작업은 이슈 → 브랜치 → PR → 머지 순서로 진행한다.
- 브랜치명: `<type>/<이슈번호>-<짧은-설명>` (예: `feat/12-scan-api`, `docs/3-work-rules`). `type`은 커밋 type과 동일하게 쓴다.

### 8.2 커밋 규칙 (Conventional Commits)
- 형식: `<type>(<scope>): <요약>` — scope는 선택 (예: `feat(scan): 바코드 분기 로직 추가`).
- type: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
- 제목은 명령형으로 간결하게, 본문에는 *왜* 바꿨는지를 적는다. 커밋 하나는 하나의 논리적 변경만 담는다.

### 8.3 PR 규칙
- 작은 단위로 올린다 (로드맵 Step 또는 그 하위 작업 하나).
- PR 템플릿(`.github/PULL_REQUEST_TEMPLATE.md`)을 채우고, 관련 이슈는 `Closes #N`으로 연결한다.
- **Squash merge만 사용**하고 머지 후 브랜치를 삭제한다. PR 제목은 Conventional Commits 형식이어야 한다 (squash 커밋 메시지가 된다).

### 8.4 main 브랜치 보호
- 직접 푸시, force push, 브랜치 삭제를 금지하고 PR을 필수로 한다.
- 1인 개발이므로 승인 리뷰는 필수가 아니며 셀프 머지를 허용한다.
- CI가 도입되면 상태 체크 통과를 머지 조건으로 추가한다.

### 8.5 이슈 관리
- 로드맵 Step(Section 6)을 GitHub Issue로 등록하고 마일스톤 `Phase 1 MVP`에 묶는다.
- 라벨 (저장소에 적용 완료, 이슈 하나에 `type:*` 1개 + `area:*` 1개 이상을 붙인다):
  - `type:*`: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci` (Conventional Commits type과 동일)
  - `area:*`: `frontend`, `api`, `db`, `ai`, `security`, `infra`
  - 작업 성격: `spike`
  - 우선순위: `priority:high`, `priority:low` (라벨 없음 = 보통)
  - 상태: `blocked`, `needs-info`, `duplicate`, `wontfix`
- 작업 시작 전에 해당 이슈가 있는지 확인하고, 범위가 바뀌면 이슈에 기록한다.
- 스파이크 결과는 이슈에 남기고, 확정된 내용은 Section 7에 반영한다.
- 템플릿: `task`(로드맵 Step), `bug`, `spike`. 빈 이슈는 비활성화한다.

### 8.6 문서 동기화
- 설계 결정이 바뀌면 **같은 PR에서** `AGENTS.md`(필요 시 `initiative.md`)와 해당 `docs/*.md`를 함께 수정한다. 계약(카드·엔드포인트)은 `docs/api-contract.md`, 스키마는 `docs/db-schema.md`, 한도는 `docs/llm-budget.md`, 보안 규칙은 `docs/security-scoring.md`가 기준이다.
- 코드가 Section 3(역할 분담·도구 정의), 4(컬러), 5(데이터 규칙) 또는 `docs/`와 충돌하면 문서를 먼저 고치거나 이슈로 논의한 뒤 진행한다.
- 엑사원 실호출 측정 스크립트는 `scripts/livetest/`에 두고 초당 1회 간격을 지켜 실행한다 (구현 단계에서 추가).

### 8.7 보안·시크릿
- `.env`, `.dev.vars`, API 키(`EXAONE_API_KEY` 등)는 커밋하지 않는다 (`.gitignore`에 포함). 커밋 전 `git status`/`git diff --staged`로 확인한다.
- Workers 시크릿은 `wrangler secret`(배포)과 `.dev.vars`(로컬, `NAME=value` 형식)를 사용한다. `.env`는 사용하지 않는다.
- **키가 든 파일을 `cat`·`cut` 등으로 화면에 출력하지 않는다.** 변수 이름·형식만 확인할 때도 값이 출력되지 않는 방식(예: `grep -c`, 이름 부분만 비교)을 쓴다. 키가 출력되면 즉시 재발급한다.
- 로그에 API 키, 스캔 원문·URL, IP 원문을 출력하지 않는다.

### 8.8 CI/CD (향후)
- 현재는 CI가 없다. 코드가 생기면 `.github/workflows/`에 PR 검증(lint·typecheck·test·build)을 추가한다 (테스트 계층은 `docs/test-strategy.md`, 실호출 LLM 테스트는 CI에서 실행하지 않는다).
- 배포 방식(Cloudflare Workers Builds vs GitHub Actions)은 구현 단계에서 확정한다.

### 8.9 작업 흐름 요약
이슈 확인 → 브랜치 생성 → 변경 → 로컬 검증 → PR 작성(템플릿) → Squash merge → 이슈 종료 및 문서 갱신
