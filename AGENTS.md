# AGENTS.md - 세모바 (세상 모든 바코드 / Semoba)

## 1. Project Overview
- **서비스명:** 세모바 (세상 모든 바코드)
- **한 줄 정의:** 바코드/QR 코드 스캔(Read)부터 맞춤형 코드 생성(Write)까지 아우르는 대화형 AI 에이전트(CUI) 기반의 메신저형 PWA 웹 서비스.
- **핵심 가치:**
  1. **글로벌 프로덕트 인텔리전스:** 해외/국내 상품 바코드 스캔 시 제품 상세 정보(성분, 용도, 특징)를 한글로 번역·요약하고, 제품명으로 **구글 검색 링크**를 제공해 가격·구매처 탐색은 외부로 연결. (가격 검색·최저가 비교·크롤링은 Phase 2)
  2. **큐싱(Qshing) 안심 방패:** QR 코드(URL) 스캔 시 브라우저 즉시 이동을 막고, 보안 DB 조회 및 URL 규칙 분석(코드 판정)으로 위험도를 선제 브리핑. 엑사원은 확정된 결과를 설명.
  3. **양방향 QR 생성(부가 기능):** 자연어 명령으로 URL의 보안 검증(SAFE)을 거친 맞춤형 컬러 QR 코드를 생성 및 R2 호스팅.
- **Phase 1 범위:** "바코드 → 한글 제품 요약(+ 구글 검색 링크)", "QR 위험 브리핑"이 핵심. QR 생성은 부가 기능. **가격 검색·최저가 비교·크롤링은 Phase 1에서 제외(Phase 2).** UI 언어는 한글 단일.

---

## 2. Tech Stack & Architecture (Phase 1: Serverless MVP)
- **Framework:** SvelteKit (Svelte 5 Runes 문법 권장), TypeScript
- **App Format:** PWA (Progressive Web App - Manifest & Service Worker 필수)
- **Deployment / Compute:** Cloudflare Workers (`@sveltejs/adapter-cloudflare`)
- **Database:** Cloudflare D1 (Edge SQLite) - 채팅 내역 및 스캔 아카이브 저장
- **Object Storage:** Cloudflare R2 - 생성된 QR 코드 이미지 및 상품 썸네일 호스팅
- **AI Engine:** LG AI연구원 **K-EXAONE 2.5** API
  - Context: 512K / Features: Chat, Tool Calling, Structured Outputs
- **Client Libraries:**
  - Barcode/QR Reader: 클라이언트 사이드 디코딩. 라이브러리 **미정** (`html5-qrcode` / `zxing-wasm` / `BarcodeDetector` 중 스파이크로 결정 — Section 7)
  - QR Generator: `qrcode` (Workers 서버 사이드 SVG/PNG 버퍼 생성 후 R2 업로드)

---

## 3. Core Agent Workflows & Tool Definitions

### 3.0 역할 분담 원칙 (Division of Responsibility) — 최우선 규칙
- **코드(결정론적)가 하는 일:** 바코드/QR 디코딩, 입력 유형 분기, 외부 DB·API 조회, **보안 등급 판정**, QR 이미지 생성, 저장.
- **엑사원(K-EXAONE 2.5)이 하는 일:** 코드가 수집·확정한 데이터를 한글로 **설명·요약·번역**하고, 사용자와 **대화**(꼬리 질문 응답, 다음 행동 안내)한다.
- **엑사원은 사실을 만들지 않는다.** 코드가 조회한 JSON 컨텍스트 안에서만 답하고, 데이터에 없는 항목(성분, 가격, 부작용 등)은 추측하지 않고 "정보 없음"으로 답한다.
- **엑사원은 보안 등급을 결정하지 않는다.** 코드가 확정한 등급을 설명만 한다 (3.2 참조).

### 3.1 요청 처리 흐름
**A. 스캔 입력 (`POST /api/scan`, 결정론적 분기, LLM 라우팅 없음)**
```
스캔 문자열 → 코드가 유형 분기(숫자 바코드 / URL / 기타)
  → 해당 도구를 코드가 직접 실행 → 결과 JSON 확보
  → 결과 JSON을 엑사원에 전달 → 엑사원이 카드·설명 생성(Structured Output)
  → D1 비동기 저장 + 클라이언트 렌더링
```
**B. 채팅 텍스트 입력 (`POST /api/chat`: 꼬리 질문, QR 생성 요청 등)**
```
POST /api/chat → 엑사원(대화 맥락 + 필요 시 Tool Calling) → 도구 실행 → 결과를 엑사원에 전달 → 응답
```
- **Tool Calling은 채팅 경로에서만** 사용한다 (자유 텍스트 의도 파악이 필요한 경우: 꼬리 질문, QR 생성 요청, 링크 안전성 문의).
- 스캔 경로는 LLM 호출 1회(설명 생성)를 원칙으로 한다.
- **맥락 공유:** 스캔 결과(코드가 만든 사실 JSON + 설명)는 대화 메시지로 저장되어 이후 `/api/chat`의 맥락이 된다.
- **응답 범위(Phase 1):** 채팅은 현재 대화에서 스캔한 상품·링크에 대한 질문만 처리한다. 스캔 맥락 없는 텍스트 상품 검색 등 범위 밖 질문은 정중히 안내한다.

### 3.1.1 카드 생성 규칙 (사실 필드 vs 설명 필드)
- 카드 JSON의 **사실 필드는 코드가 채운다**: 보안 등급, 근거 신호, 이동 버튼 활성 여부, QR 이미지 URL, 뱃지 상태, 제품 메타데이터, 구글 검색 링크.
- 엑사원은 카드의 **설명 필드만 채운다**: 한글 요약, 해설, 다음 행동 안내 텍스트. 사실 필드를 수정·생성하지 못하며, 서버가 응답을 병합할 때 사실 필드는 코드 값으로 덮어쓴다.

### Tool 1: `search_global_product`
- **Trigger:** 1D 바코드(EAN-13, UPC, ISBN 등) 스캔(코드 직접 호출) 또는 채팅에서 스캔한 상품에 대한 후속 질문(Tool Calling, 스캔 맥락 한정).
- **Parameters:** `barcode` (string, optional), `query` (string)
- **Execution:**
  1. 글로벌 바코드 DB를 조회해 제품 메타데이터(제품명, 브랜드, 성분, 이미지 등)를 수집한다. 소스 우선순위는 Open Food Facts → UPCitemdb(폴백)이며, 소스별 출처·라이선스 표기 필드를 결과에 포함한다 (Open Food Facts는 ODbL: 출처 표기·동일 조건 공유 의무).
  2. **가격 조회·쇼핑 API 호출·크롤링은 하지 않는다 (Phase 2).** 대신 코드가 제품명(+브랜드)으로 **구글 검색 URL**(`https://www.google.com/search?q=...`)을 만들어 사실 필드로 담는다. 구글은 API·스크래핑 없이 링크로만 사용하며 새 탭으로 연다.
- **AI Output:** 수집된 데이터만을 근거로 한 한글 제품 요약(제품명, 주성분/특징, 사용법)과 구글 검색 링크를 Rich UI Card JSON으로 구성. **DB 미적중 시 제품 정보를 생성하지 않고 "정보 없음" 카드를 반환**하며, 이때는 제품명이 없으므로 **바코드 번호로 만든 구글 검색 링크**를 함께 제공한다.

### Tool 2: `verify_url_security`
- **Trigger:** QR로 URL이 스캔되었을 때(코드 직접 호출) 또는 사용자가 채팅에서 링크 안전성을 물어볼 때(Tool Calling).
- **Parameters:** `url` (string)
- **Execution (전부 코드, 결정론적):**
  1. 보안 DB 조회 (Google Safe Browsing / Web Risk 약관·한도 확인 필요, 한국 신고 DB 가용성은 스파이크로 확인).
  2. URL 규칙 검사: 펀니코드·유사 도메인, 의심 TLD, IP 직접 접속, 과도한 서브도메인, 단축 URL 여부, 도메인 연령 등.
  3. 신호를 점수로 합산하여 `SAFE` / `WARNING` / `DANGER` 확정.
- **AI Output:** 엑사원은 **확정된 등급과 근거 신호를 한글로 설명**할 뿐, 등급을 바꾸지 못한다.
- **등급별 이동 정책:** `SAFE` → 이동 버튼 활성(최종 도메인 크게 표시). `WARNING` → 경고 확인 단계(위험 신호 안내 + 사용자 재확인)를 거친 뒤에만 이동 허용. `DANGER` → 이동 버튼 비활성(차단).

#### 3.2 보안 판정 정책 (Qshing Policy)
1. **판정은 코드가 한다.** 외부 페이지 소스·응답 본문은 엑사원 프롬프트에 넣지 않는 것이 기본이다 (프롬프트 인젝션 차단).
2. **비대칭 규칙:** AI 신호는 등급을 **올릴 수만** 있고 내릴 수 없다. 코드가 `DANGER`로 판정하면 AI 결과와 무관하게 유지한다.
3. **표기:** `SAFE`는 "안전 보증"이 아니라 **"알려진 위협 없음"** 으로 표기한다. `SAFE`여도 이동 버튼 근처에 최종 도메인을 크게 보여준다.
4. **소스 분석(선택, 필요 시에만 도입):** 격리된 별도 LLM 호출로 하며, 도구 접근 권한 없이 고정 스키마의 **사실 신호**(예: `has_login_form`, `asks_password`, `brand_impersonation`)만 출력받아 코드가 점수에 합산한다. 이 호출은 `SAFE`/`DANGER` 등 판정 자체를 출력하지 않는다. 소스 fetch 시 SSRF(내부 주소) 차단 필수.
5. **Phase 2 이관:** 헤드리스 브라우저 렌더링 분석(리다이렉션 체인, 가짜 로그인 폼). Cloudflare Browser Rendering 사용 가능성을 우선 검토하고 Python 백엔드는 최후 수단으로 둔다.
6. **URL이 아닌 QR 페이로드**(Wi-Fi, vCard, 앱 인텐트 등)는 보안 카드 대신 내용 그대로 안내하고 자동 실행하지 않는다.

### Tool 3: `generate_custom_qr`
- **Trigger:** 사용자가 채팅에서 특정 **URL**을 QR 코드로 만들어달라고 요청할 때(Tool Calling). Phase 1은 URL만 지원하며, 텍스트·Wi-Fi 등 다른 페이로드는 지원하지 않는다고 안내한다.
- **Parameters:** `url` (string), `color_hex` (string, default: `#001F3F`), `bg_transparent` (boolean)
- **Execution:**
  1. `verify_url_security` 로직을 선행 실행. **`SAFE`일 때만 생성**하고, `WARNING`/`DANGER`는 생성을 거부한다(사유 안내).
  2. 통과 시 QR 이미지를 생성(**SVG 우선**, PNG는 Workers 런타임 동작 확인 후)하고, 전경/배경 **명도 대비를 검증**해 인식 불가 색상 조합은 거부하거나 보정한다.
  3. R2에 업로드. 객체 키는 추측 불가능한 랜덤 ID(예: UUID)를 사용한다.
- **AI Output:** R2 이미지 URL, 검증 결과 뱃지 상태, 다운로드/공유 메타데이터가 담긴 Rich UI Card JSON.
- **뱃지 문구 주의:** "세모바 안심 인증"은 **생성 시점에 알려진 위협이 없었다**는 의미일 뿐, 이후 링크 내용의 안전을 보증하지 않는다. UI에 검증 시각을 함께 표기하고 과도한 안심 표현을 피한다.

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

---

## 5. Data & Storage Rules (Client Load Prevention)
- **No Heavy LocalStorage:** 브라우저 `localStorage`나 클라이언트 메모리에 무거운 리치 데이터(이미지, 전체 로그)를 쌓지 않는다.
- **Cloud Sync & Pagination:**
  - 화면에는 최근 메시지 20~30개만 유지.
  - 모든 대화와 스캔 결과 JSON은 비동기로 **Cloudflare D1**에 즉시 `INSERT`하고, 이전 내역은 위로 스크롤 시 커서 기반 페이지네이션(`GET /api/history?cursor=...`)으로 불러온다.
- **Structured Outputs:** 서버가 프론트엔드에 내려보내는 최종 응답은 말풍선 컴포넌트가 즉시 분기 렌더링할 수 있도록 정해진 JSON 스키마(`type: "text" | "product_card" | "security_card" | "qr_card"`)를 엄격히 준수해야 한다. 엑사원은 이 중 **설명 필드만** 생성하고 사실 필드는 코드가 채운다 (Section 3.1.1).
- **Session & Retention (Phase 1):**
  - 로그인 없이 **익명 세션(쿠키)** 으로 동작하며, 아카이브는 **해당 기기·브라우저 한정**으로 보관 기간 내 유지된다 (쿠키 삭제·기기 변경 시 복구 불가). 로그인·기기 간 동기화는 Phase 2.
  - 스캔 기록 보관 기간은 기본 **90일**, 생성한 QR 이미지(R2) 만료 정책을 함께 정의한다. 사용자 요청 시 기록 삭제 기능을 제공한다.

---

## 6. Next Implementation Roadmap (코딩 에이전트 우선 작업 순위)
이 문서를 읽은 에이전트는 아래 순서대로 작업을 이어서 진행한다.

- [ ] **Step 0.1: GitHub 저장소 설정 (Section 8 참조)**
  - [x] 라벨 체계 적용 (기본 라벨 삭제 후 Section 8.5 체계로 재생성)
  - [ ] 마일스톤(`Phase 1 MVP`) 생성, 로드맵 Step을 이슈로 등록
  - [ ] main 브랜치 보호 적용 (저장소는 공개 상태 — 규칙은 Section 8.4)
- [ ] **Step 0: 검증 스파이크 (설계 전 선행, Section 7 참조)**
  - 바코드 DB 적중률, K-EXAONE 2.5 API/Tool Calling 확인, 한국 보안 신고 DB 가용성 조사. (국내 가격 매칭은 Phase 2로 이관되어 제외)
- [ ] **Step 0.5: API 계약 및 응답 스키마 설계** (`docs/` 아래 문서화)
  - 카드 4종(`text`, `product_card`, `security_card`, `qr_card`) 필드 정의, `/api/chat`·`/api/history` 요청·응답 계약. D1 스키마는 이 계약을 기준으로 설계한다.
- [ ] **Step 1: 인프라 및 DB 스키마 설계**
  - `wrangler.toml` 설정 (D1 바인딩 `DB`, R2 바인딩 `BUCKET`, 환경변수 `EXAONE_API_KEY`)
  - D1 마이그레이션용 `schema.sql` 작성 (`sessions`, `messages`, `scan_archives` 테이블)
- [ ] **Step 2: K-EXAONE 2.5 연동 모듈 및 스키마 정의**
  - `src/lib/server/exaone.ts`: EXAONE API 클라이언트, 시스템 프롬프트, 3대 핵심 도구의 JSON Schema(`tools`), 응답용 Structured Output 스키마 정의.
- [ ] **Step 3: 서버리스 API 라우트 구현**
  - 스캔 경로(코드 분기 -> 도구 직접 실행 -> EXAONE 설명 생성)와 채팅 경로(EXAONE Tool Calling -> 도구 실행 -> 응답)를 분리해 구현한다 (Section 3.1).
  - `src/routes/api/scan/+server.ts`: 스캔 문자열 수신 -> 코드 분기 -> 도구 실행 -> EXAONE 설명 생성 -> 카드 병합(사실 필드는 코드 값) -> D1 저장 -> 응답.
  - `src/routes/api/chat/+server.ts`: 메시지 수신 -> EXAONE(Tool Calling) -> 도구 실행 -> D1 저장 -> 응답.
  - 익명 엔드포인트 남용 방지: 두 라우트 모두 레이트 리밋 / Turnstile 적용.
- [ ] **Step 4: 프론트엔드 메신저 UI 및 스캐너 컴포넌트 구현**
  - Navy/Sky Blue 테마 기반 채팅 레이아웃, 유형별 Rich Card 말풍선 컴포넌트, 바텀 시트 카메라 스캐너 연동.

---

## 7. Design Decisions & Open Verification Items (비판적 검토 결과)

### 확정된 설계 결정
| 결정 | 내용 |
| --- | --- |
| 역할 분담 | 조회·판정·생성은 코드, 설명·대화는 엑사원 (Section 3.0) |
| 라우팅 | 스캔은 코드 분기, Tool Calling은 채팅 경로 한정 |
| 보안 판정 | 코드가 확정, AI는 등급 상향만 가능, `SAFE`는 "알려진 위협 없음" (Section 3.2) |
| 환각 방지 | 조회 데이터 밖의 사실 생성 금지, 미적중 시 "정보 없음" |
| 카드 생성 | 사실 필드는 코드, 설명 필드만 엑사원 (Section 3.1.1) |
| 엔드포인트 | 스캔 `POST /api/scan`, 채팅 `POST /api/chat`, 이력 `GET /api/history` |
| 등급별 정책 | `SAFE` 이동 허용 / `WARNING` 재확인 후 이동 허용 / `DANGER` 차단. QR 생성은 `SAFE`만 |
| 채팅 범위 | Phase 1은 스캔 맥락 안의 상품·링크 질문만 처리 |
| QR 생성 | Phase 1은 URL만, 부가 기능 |
| 세션 | 익명 세션(기기 한정), 보관 90일, 로그인은 Phase 2 |
| UI 언어 | 한글 단일 |
| 가격 검색 | **Phase 1 제외** (빠른 MVP). 제품명 기반 구글 검색 링크로 대체. 직접 가격 조회·최저가 비교·크롤링은 Phase 2 (네이버 쇼핑 API 등은 그때 약관·GTIN 매칭 검증) |
| 제품명 검색 링크 | 코드가 생성하는 사실 필드. DB 미적중 시 바코드 번호 검색 링크로 폴백 |
| Phase 2 | 헤드리스 분석은 Cloudflare Browser Rendering 우선 검토. Go/Python/Tabular는 데이터 축적 후 재평가 |

### 미결정 (제품 성격)
- **포트폴리오/기술 데모 vs 서비스:** 미정. Phase 1은 포트폴리오 수준 범위로 진행하되, 서비스화 시 (1) 수익 모델(예: 제휴 링크)과 (2) 차별점(예: 한국 특화 큐싱 DB)을 재검토한다.

### 미검증 가정 (스파이크로 확인 후 설계 확정)
1. **바코드 DB 적중률:** 실제 해외 상품(특히 드럭스토어·화장품) 20~30개로 후보 DB(Open Food Facts, UPCitemdb 등) 조회 테스트.
2. **국내 가격 매칭 (Phase 2로 이관):** 쇼핑 API가 바코드가 아닌 키워드 검색이므로 동일 상품 매칭 가능성, 직구 최저가·배송비·관세 데이터 출처, 약관(가격 표시·캐싱) 확인. Phase 1에서는 구글 검색 링크로 대체한다.
3. **K-EXAONE 2.5 API:** 존재·접근 방법·인증, Tool Calling 및 Structured Outputs 지원과 제약(스키마 중첩 깊이 등) 확인. *(문서상 기재일 뿐 아직 미확인)*
4. **보안 DB:** Google Safe Browsing은 비상업 용도 제한(→ Web Risk 유료) 여부 확인. KISA/경찰청 등 한국 신고 데이터 접근 가능성 조사.
5. **클라이언트 스캐너:** `html5-qrcode`의 유지보수·iOS Safari 1D 바코드 성능 문제 → `zxing-wasm` / `BarcodeDetector` 대안 비교.
6. **QR 생성:** `qrcode`의 PNG 출력이 Workers 런타임에서 동작하는지 확인 (불가 시 SVG 전용).

### 알려진 리스크 및 정책
- **비용/남용:** 인프라 비용은 Cloudflare가 아니라 LLM 호출이 주도한다. 익명 `/api/chat` 레이트 리밋 필수.
- **개인정보:** 스캔 기록은 구매·위치 맥락을 담는 개인정보다. 보관 기간과 삭제 방법을 정의한다.
- **R2 악용:** 검증 우회 시 피싱 QR 호스팅으로 악용될 수 있으므로 키 비추측성, `DANGER` 거부, 업로드 제한을 유지한다.
- **MVP 범위:** 핵심은 "바코드 → 한글 제품 요약(+ 구글 검색 링크)"과 "QR 위험 브리핑". 가격 검색·최저가 비교·크롤링은 Phase 2, QR 생성은 부가 기능으로 취급한다.
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
- 설계 결정이 바뀌면 **같은 PR에서** `AGENTS.md`(필요 시 `initiative.md`)를 함께 수정한다.
- 코드가 Section 3(역할 분담·도구 정의), 4(컬러), 5(데이터 규칙)와 충돌하면 문서를 먼저 고치거나 이슈로 논의한 뒤 진행한다.

### 8.7 보안·시크릿
- `.env`, API 키(`EXAONE_API_KEY` 등)는 커밋하지 않는다. 커밋 전 `git status`/`git diff --staged`로 확인한다.
- Workers 시크릿은 `wrangler secret`(배포)과 `.dev.vars`(로컬)를 사용한다.
- 로그에 API 키나 사용자 스캔 데이터를 출력하지 않는다.

### 8.8 CI/CD (향후)
- 현재는 CI가 없다. 코드가 생기면 `.github/workflows/`에 PR 검증(lint·typecheck·test·build)을 추가한다.
- 배포 방식(Cloudflare Workers Builds vs GitHub Actions)은 구현 단계에서 확정한다.

### 8.9 작업 흐름 요약
이슈 확인 → 브랜치 생성 → 변경 → 로컬 검증 → PR 작성(템플릿) → Squash merge → 이슈 종료 및 문서 갱신
