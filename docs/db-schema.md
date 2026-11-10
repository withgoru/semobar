# D1 스키마 · 캐시 · 바인딩 (초안)

> 상태: **초안 — 리뷰 반영 완료, 확정 대기.** 기준: `docs/api-contract.md`(카드·엔드포인트), `docs/llm-budget.md`(AI 사용량 통제), `AGENTS.md` Section 5(저장 규칙)·7.
> DB는 Cloudflare D1(SQLite). 시각은 epoch **밀리초(UTC)** 정수, ID는 ULID(시간순 정렬 가능)다. 실제 마이그레이션은 `migrations/0001_init.sql`이며 이 문서의 DDL과 같아야 한다 (아래 '마이그레이션' 참고).

---

## 1. 설계 결정

1. **카드 JSON은 `messages.content`에 통째로 저장한다.** 카드 필드는 아직 바뀔 수 있으므로 컬럼으로 풀지 않는다. 이력 API는 저장된 JSON을 그대로 돌려준다.
2. **Phase 1에는 `scan_archives` 테이블을 두지 않는다.** UI가 채팅 스크롤뿐이라 `messages`로 충분하다. 아카이브 화면(필터·검색), "이미 스캔한 상품" 안내는 Phase 2에서 추가한다.
3. **비-URL QR 원문(Wi-Fi 비밀번호, 전화번호 등)은 저장하지 않는다.** 응답에서만 보여 주고 DB에는 종류(`kind`)만 남긴다.
4. **캐시와 카운터의 저장소를 구분한다.** 정확해야 하는 카운터와 공유 narration 캐시는 D1(강한 일관성, 쓰기 일 10만 행), 읽기 위주 외부 조회 캐시는 KV(쓰기 일 1,000건 한도)에 둔다.
5. **세션 토큰은 해시로만 저장한다.** DB가 유출돼도 쿠키를 위조할 수 없다.
6. **R2 객체와 DB 행의 삭제 순서를 지킨다.** `ON DELETE CASCADE`가 `qr_assets` 행을 지우면 R2 키를 잃으므로, 항상 **R2 객체 삭제 → DB 삭제** 순서로 처리한다.

---

## 2. 테이블 (DDL 초안)

```sql
PRAGMA foreign_keys = ON;

-- 익명 세션 (쿠키 sid의 SHA-256 해시만 저장)
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,                -- ULID
  token_hash   TEXT NOT NULL UNIQUE,            -- hex(SHA-256(cookie token))
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL                 -- last_seen_at + 90일 (슬라이딩, 갱신은 하루 1회까지)
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- 대화 메시지 (사용자 입력 + assistant 카드)
CREATE TABLE messages (
  id           TEXT PRIMARY KEY,                -- ULID (커서 기준)
  session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_type TEXT NOT NULL CHECK (content_type IN
                 ('text', 'scan', 'product_card', 'security_card', 'qr_card')),
  content      TEXT NOT NULL CHECK (json_valid(content)),   -- API의 Message.content (비-URL QR은 raw 제외)
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_session_id ON messages (session_id, id DESC);

-- 생성된 QR 이미지 (R2 객체 추적·만료·삭제용)
CREATE TABLE qr_assets (
  id          TEXT PRIMARY KEY,                 -- UUIDv4, URL(/q/<id>.svg)과 R2 키에 사용
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  message_id  TEXT REFERENCES messages (id) ON DELETE SET NULL,
  r2_key      TEXT NOT NULL UNIQUE,             -- 예: qr/<id>.svg
  target_url  TEXT NOT NULL,
  color_hex   TEXT NOT NULL CHECK (length(color_hex) = 7 AND substr(color_hex, 1, 1) = '#'
                                   AND substr(color_hex, 2) NOT GLOB '*[^0-9A-Fa-f]*'),   -- #RRGGBB (D1은 복잡한 GLOB 패턴을 거부한다)
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                  -- 기본 created_at + 90일
);
CREATE INDEX idx_qr_assets_expires ON qr_assets (expires_at);
CREATE INDEX idx_qr_assets_session ON qr_assets (session_id);

-- AI 호출 사용량 카운터 (정확한 한도 통제용, 상세는 docs/llm-budget.md)
CREATE TABLE llm_usage (
  scope        TEXT    NOT NULL,                -- 'global:min' | 'global:day' | 'session:chat:day' | 'ip:chat:day' ...
  key          TEXT    NOT NULL,                -- 'all' | session id | SHA-256(IP) 앞 16자
  window_start INTEGER NOT NULL,                -- 윈도우 시작 epoch ms (일 윈도우는 KST 자정 기준)
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, key, window_start)
);

-- 제공자 호출 간격 게이트 (초당 1회 한도를 지키는 마지막 호출 시각, docs/llm-budget.md 4절)
CREATE TABLE llm_gate (
  key          TEXT PRIMARY KEY,                -- 'global'
  last_call_ms INTEGER NOT NULL
);

-- narration 전역 캐시 (같은 facts → 같은 서술을 전체 사용자가 재사용)
CREATE TABLE narration_cache (
  cache_key   TEXT PRIMARY KEY,                 -- sha256(카드 타입 + 프롬프트 버전 + 서술용 facts)
  card_type   TEXT NOT NULL,
  narration   TEXT NOT NULL CHECK (json_valid(narration)),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                  -- 기본 created_at + 30일 (프롬프트 버전이 바뀌면 키가 달라져 자동 무효화)
);
CREATE INDEX idx_narration_cache_expires ON narration_cache (expires_at);
```

### 마이그레이션
- 이 DDL은 `migrations/0001_init.sql`로 적용한다 (`PRAGMA foreign_keys`는 D1이 항상 강제하므로 마이그레이션에서 뺀다). **설계 DDL과 마이그레이션은 `src/lib/server/schema.spec.ts`가 같음을 검사한다** — 스키마를 바꿀 때는 이 문서와 마이그레이션을 같은 PR에서 고친다.
- 배포된 마이그레이션 파일은 수정하지 않고 `0002_*.sql`처럼 새 파일을 추가한다 (아직 배포 전이라 `0001`은 수정할 수 있다).
- 로컬: `npm run db:migrate:local`(적용), `npm run db:reset:local`(로컬 D1 초기화 후 적용). 원격 적용(`wrangler d1 migrations apply DB --remote`)은 배포 이슈(#42)에서 다룬다.
- **D1 제약:** 복잡한 `GLOB`/`LIKE` 패턴은 `LIKE or GLOB pattern too complex`로 거부된다. 그래서 `color_hex` 검증은 대괄호 6개를 반복하는 패턴이 아니라 `length` + `substr` + 단일 부정 패턴으로 쓴다 (실제 D1에서 확인).

### 쓰기량 점검 (D1 무료 일 10만 행 기준)
- 스캔 1회 = `messages` 2행 (+ AI 서술 캐시 미스일 때 `llm_usage` 3~4행 + `llm_gate` 1행, `narration_cache` 1행). 채팅 1회 = `messages` 2행 + `llm_usage` 3~4행. QR 생성 1회 = 카드 메시지 + `qr_assets` 1행.
- 일 1만 스캔이어도 기본 쓰기는 2만 행 수준이고, 캐시 덕분에 AI 관련 쓰기는 그보다 훨씬 적다. 세션 `last_seen_at` 갱신은 하루 1회로 제한한다.
- 일 쓰기가 5만 행에 근접하면 `llm_usage` 카운터를 Durable Object로 옮기는 것을 검토한다.

---

## 3. 주요 쿼리 패턴

| 용도 | 쿼리 |
| --- | --- |
| 세션 조회 | `SELECT id, expires_at FROM sessions WHERE token_hash = ?` |
| 이력 페이지 | `SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?` (첫 페이지는 `id < ?` 생략) |
| 엑사원 맥락 | 같은 쿼리로 최근 8개 (`LIMIT 8`), 카드 메시지는 facts 요약만 모델에 전달 |
| AI 호출 획득 | `llm_usage`의 원자적 upsert와 `llm_gate`의 호출 간격 게이트 (`docs/llm-budget.md` 4절) |
| narration 캐시 조회 | `SELECT narration FROM narration_cache WHERE cache_key = ? AND expires_at > ?` |
| 서술 갱신 | `UPDATE messages SET content = json_set(content, '$.narration_status', ?, '$.narration', json(?)) WHERE id = ? AND session_id = ?` (서술 엔드포인트가 카드에 결과를 기록, `docs/api-contract.md` 4.6) |
| 전체 삭제 | ① `SELECT r2_key FROM qr_assets WHERE session_id = ?` → ② R2 객체 삭제 → ③ `DELETE FROM sessions WHERE id = ?` (CASCADE) |

- 한 요청에서 `messages`(사용자 + assistant) 쓰기는 `db.batch([...])`로 묶어 원자적으로 처리한다.
- 카드 저장은 응답을 내려보내는 것과 **병행**한다(`ctx.waitUntil`). 저장 실패 시에도 사용자 응답은 정상으로 보내고 오류를 로그로 남긴다.

---

## 4. 보관·삭제 정책

- **보관 기간:** 세션 마지막 사용 후 90일(슬라이딩, `expires_at`). 사용자가 `DELETE /api/history`로 즉시 삭제할 수 있다.
- **만료 정리:** Cron Trigger가 매일 새벽 1회 실행한다.
  1. `expires_at < now`인 세션의 `qr_assets.r2_key`를 조회해 R2 객체 삭제
  2. 만료 `qr_assets`(세션은 살아 있어도 `expires_at` 경과) 삭제
  3. 만료 세션 삭제 (messages·qr_assets는 CASCADE). 대량 삭제가 D1 쿼리 시간 제한에 걸리지 않도록 **1,000행 단위 배치**로 반복한다
  4. 이틀 지난 `llm_usage` 윈도우, 만료된 `narration_cache` 삭제
- **민감 정보:** 비-URL QR 원문은 저장하지 않으며 로그에도 남기지 않는다. IP는 해시로만 사용한다. URL 스캔은 **쿼리·프래그먼트를 제거한 정규화 URL**만 저장한다 (`docs/api-contract.md` 9절).
- **Cron 구현 주의:** `@sveltejs/adapter-cloudflare`가 `scheduled` 핸들러를 직접 노출하지 않을 수 있다. Step 1에서 확인하고, 불가하면 정리 작업 전용 별도 Worker(같은 D1·R2 바인딩 공유)로 분리한다.

---

## 5. KV 캐시 (`CACHE` 바인딩)

| 키 | 값 | TTL(초안) | 비고 |
| --- | --- | --- | --- |
| `gtin:{gtin13}` | 제품 조회 결과(found/not_found, source) | found 7일 / not_found 1일 | Open Food Facts 조회 한도(IP당 분당 15회) 보호 |
| `sec:{sha256(normalized_url)}` | 외부 보안 소스 응답(신호 목록) | 1시간 | Safe Browsing 캐시 유효 시간 준수 |
| `rdap:{domain}` | 등록일·레지스트라 | 7일 | 등록일은 거의 변하지 않음 |
| `llm:pause_until` | 제공자 429·서킷 브레이커로 AI 호출을 멈추는 시각 | `retry-after`(5초~5분) | 단계(L0~L3)는 KV가 아니라 D1 카운터에서 계산 (`docs/llm-budget.md` 5·6절) |
| `block:ip:{hash}` | 쿨다운 차단 | 24시간 | 반복 한도 도달 IP |

- **일반 요청 레이트 리밋**(스캔·채팅 요청 빈도, 근사치로 충분한 용도)은 Workers Rate Limiting 바인딩을 사용한다. 정확해야 하는 AI 호출 카운터는 D1(`llm_usage`)을 쓴다.
- **URLhaus는 덤프를 동기화하지 않고 조회 API로 호출한다.** 덤프를 KV/D1에 적재하면 수십만 행을 주기적으로 써야 해서 무료 쓰기 한도를 넘는다. 조회 엔드포인트 사양과 한도는 구현 단계에서 확인한다.
- 캐시된 외부 응답에 사용자별 정보가 섞이지 않도록 키에 세션 정보를 넣지 않는다.
- **ODbL 확인 필요:** Open Food Facts 조회 결과를 KV·`narration_cache`에 저장하는 것이 ODbL의 "파생 데이터베이스"(동일 조건 공유 의무)에 해당하는지 확인한다. 해당하면 출처 표기와 공유 의무를 이행하거나 저장 범위를 줄인다. (AGENTS.md "남은 검증"에 추가 예정)

---

## 6. 바인딩 · 환경 변수 이름 (제안)

**Cloudflare 바인딩**
| 이름 | 종류 | 용도 |
| --- | --- | --- |
| `DB` | D1 (`semoba-db`, 마이그레이션 `migrations/`) | 세션·메시지·QR 메타·AI 카운터·narration 캐시 |
| `BUCKET` | R2 (`semoba-qr`) | 생성된 QR SVG |
| `CACHE` | KV | 외부 조회 캐시, `pause_until`, 차단 목록 |
| `REQ_LIMITER` | Rate Limiting (분당 30) | 스캔 등 일반 요청 빈도 제한 |
| `CHAT_LIMITER` | Rate Limiting (분당 10) | 채팅 요청 빈도 제한 |

- Rate Limiting 바인딩은 기간을 **10초 또는 60초**만 지원하고 바인딩마다 한도가 하나다. 그래서 채팅용 `CHAT_LIMITER`를 따로 두고, **시간당 신규 세션 제한(IP당 20회)은 D1 카운터**(`ip:newsession:hour`, `docs/llm-budget.md` 3절)로 처리한다. 한도는 키(세션 ID 또는 IP 해시)마다 적용되며 데이터센터별 근사치다.
- 리소스 ID(D1 `database_id`, KV `id`)는 `wrangler.jsonc`에 두지 않는다. 로컬(`wrangler dev`)은 시뮬레이션하고, 배포 시 자동 프로비저닝한다 (이슈 #42).

**시크릿** (`wrangler secret put`, 로컬은 `.dev.vars`)
| 이름 | 필수 | 용도 |
| --- | --- | --- |
| `EXAONE_API_KEY` | 필수 | K-EXAONE API Bearer 키 |
| `SAFE_BROWSING_API_KEY` | 필수(보안 검증) | Google Safe Browsing / Web Risk |
| `URLHAUS_AUTH_KEY` | 선택 | abuse.ch 인증키 |
| `TURNSTILE_SECRET_KEY` | 선택 | 조건부 봇 방지 (`docs/llm-budget.md` 8절) |
| `UPCITEMDB_USER_KEY` | 선택 | UPCitemdb 유료/개발 키 (무료 trial은 키 없이 호출) |

**일반 변수** (`wrangler.jsonc`의 `vars`, 비밀 아님)
| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `EXAONE_BASE_URL` | `https://api.exaone.ai/v1` | 제공자 교체 대비 |
| `EXAONE_MODEL` | `k-exaone_v2.5` | 모델 ID |
| `EXAONE_REASONING_EFFORT` | `low` | 추론 강도 |
| `EXAONE_RPM_LIMIT`, `EXAONE_RPD_LIMIT`, `EXAONE_MIN_INTERVAL_MS` | `60`, `86400`, `1200` | 제공자 분·일 한도와 호출 시작 간격 (2026-11-10 실측) |
| `LLM_SAFETY_RATIO` 외 `LLM_*` | `docs/llm-budget.md` 9절 | 세션·IP 한도, 타임아웃, 출력 상한 |
| `APP_ENV`, `LIMITS_MODE` | `production`, `enforce` | 개발 중에는 `.dev.vars`에서만 `development`, `off`로 덮어써 한도를 해제 (`docs/llm-budget.md` 10절) |
| `PUBLIC_TURNSTILE_SITE_KEY` | - | 클라이언트 공개 키 (도입 시) |

**시크릿 등록 절차**
- **로컬:** `.dev.vars.example`을 `.dev.vars`로 복사해 값을 채운다. `NAME=value` 형식이며 `.dev.vars`는 git에 올리지 않는다 (AGENTS.md 8.7). `.dev.vars`의 `APP_ENV`·`LIMITS_MODE`는 `wrangler.jsonc`의 운영 기본값을 로컬에서만 덮어쓴다.
- **운영:** 시크릿마다 `npx wrangler secret put EXAONE_API_KEY`처럼 등록한다 (값은 프롬프트에 직접 입력, 명령줄 인자나 파일로 넘기지 않는다). `npx wrangler secret list`로 이름만 확인한다. 필수는 `EXAONE_API_KEY`, `SAFE_BROWSING_API_KEY`이고 나머지는 선택이다.
- **타입:** `wrangler types`는 `.dev.vars`에 있는 이름만 `Env`에 넣어 로컬과 CI의 결과가 달라지므로, 시크릿 이름은 `src/app.d.ts`에서 `Env`에 직접 선언한다. 코드에서는 `secret(env, 'NAME')`(`src/lib/server/config.ts`)로 읽으며 값이 비어 있으면 `null`이다. 생성 타입 파일(`worker-configuration.d.ts`)은 커밋하지 않는다 (`npm run gen`).
- **설정 읽기:** 일반 변수는 모두 문자열이며 `loadConfig(env)`가 숫자·열거형으로 해석한다. 알 수 없는 `APP_ENV`·`LIMITS_MODE`는 운영·한도 적용으로 대체되고, 숫자 오류는 변수 이름만 담은 `ConfigError`로 알린다.

---

## 7. 결정 사항 (열린 질문 정리)

| 질문 | 결정 |
| --- | --- |
| 비-URL QR 원문 저장 | 저장하지 않음 (종류만 기록) |
| `scan_archives` | Phase 1에서 제외, Phase 2로 이관 |
| 세션 만료 방식 | 슬라이딩 90일 |
| 레이트 리밋 구현 | 일반 요청은 Workers Rate Limiting 바인딩(가능하면, 아니면 KV), **AI 호출 카운터는 D1 원자 카운터** |
