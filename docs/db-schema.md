# D1 스키마 · 캐시 · 바인딩 (초안)

> 상태: **초안 — 리뷰 반영 완료, 확정 대기.** 기준: `docs/api-contract.md`(카드·엔드포인트), `docs/llm-budget.md`(AI 사용량 통제), `AGENTS.md` Section 5(저장 규칙)·7.
> DB는 Cloudflare D1(SQLite). 시각은 epoch **밀리초(UTC)** 정수, ID는 ULID(시간순 정렬 가능)다. 실제 마이그레이션 파일(`schema.sql`)은 로드맵 Step 1에서 이 문서를 기준으로 만든다.

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
  color_hex   TEXT NOT NULL CHECK (color_hex GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
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

### 쓰기량 점검 (D1 무료 일 10만 행 기준)
- 스캔 1회 = `messages` 2행 (+ AI 서술 캐시 미스일 때 `llm_usage` 3~4행, `narration_cache` 1행). 채팅 1회 = `messages` 2행 + `llm_usage` 3~4행. QR 생성 1회 = 카드 메시지 + `qr_assets` 1행.
- 일 1만 스캔이어도 기본 쓰기는 2만 행 수준이고, 캐시 덕분에 AI 관련 쓰기는 그보다 훨씬 적다. 세션 `last_seen_at` 갱신은 하루 1회로 제한한다.
- 일 쓰기가 5만 행에 근접하면 `llm_usage` 카운터를 Durable Object로 옮기는 것을 검토한다.

---

## 3. 주요 쿼리 패턴

| 용도 | 쿼리 |
| --- | --- |
| 세션 조회 | `SELECT id, expires_at FROM sessions WHERE token_hash = ?` |
| 이력 페이지 | `SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?` (첫 페이지는 `id < ?` 생략) |
| 엑사원 맥락 | 같은 쿼리로 최근 8개 (`LIMIT 8`), 카드 메시지는 facts 요약만 모델에 전달 |
| AI 호출 획득 | `llm_usage`의 원자적 upsert (`docs/llm-budget.md` 4절) |
| narration 캐시 조회 | `SELECT narration FROM narration_cache WHERE cache_key = ? AND expires_at > ?` |
| 전체 삭제 | ① `SELECT r2_key FROM qr_assets WHERE session_id = ?` → ② R2 객체 삭제 → ③ `DELETE FROM sessions WHERE id = ?` (CASCADE) |

- 한 요청에서 `messages`(사용자 + assistant) 쓰기는 `db.batch([...])`로 묶어 원자적으로 처리한다.
- 카드 저장은 응답을 내려보내는 것과 **병행**한다(`ctx.waitUntil`). 저장 실패 시에도 사용자 응답은 정상으로 보내고 오류를 로그로 남긴다.

---

## 4. 보관·삭제 정책

- **보관 기간:** 세션 마지막 사용 후 90일(슬라이딩, `expires_at`). 사용자가 `DELETE /api/history`로 즉시 삭제할 수 있다.
- **만료 정리:** Cron Trigger가 매일 새벽 1회 실행한다.
  1. `expires_at < now`인 세션의 `qr_assets.r2_key`를 조회해 R2 객체 삭제
  2. 만료 `qr_assets`(세션은 살아 있어도 `expires_at` 경과) 삭제
  3. 만료 세션 삭제 (messages·qr_assets는 CASCADE)
  4. 이틀 지난 `llm_usage` 윈도우, 만료된 `narration_cache` 삭제
- **민감 정보:** 비-URL QR 원문은 저장하지 않으며 로그에도 남기지 않는다. IP는 해시로만 사용한다.

---

## 5. KV 캐시 (`CACHE` 바인딩)

| 키 | 값 | TTL(초안) | 비고 |
| --- | --- | --- | --- |
| `gtin:{gtin13}` | 제품 조회 결과(found/not_found, source) | found 7일 / not_found 1일 | Open Food Facts 조회 한도(IP당 분당 15회) 보호 |
| `sec:{sha256(normalized_url)}` | 외부 보안 소스 응답(신호 목록) | 1시간 | Safe Browsing 캐시 유효 시간 준수 |
| `rdap:{domain}` | 등록일·레지스트라 | 7일 | 등록일은 거의 변하지 않음 |
| `llm:state` | AI 상태(L0~L3, `pause_until`) | 60초 | 상태 변경 시에만 기록 (`docs/llm-budget.md` 5·6절) |
| `block:ip:{hash}` | 쿨다운 차단 | 24시간 | 반복 한도 도달 IP |

- **일반 요청 레이트 리밋**(스캔·채팅 요청 빈도, 근사치로 충분한 용도)은 Workers Rate Limiting 바인딩을 사용한다. 정확해야 하는 AI 호출 카운터는 D1(`llm_usage`)을 쓴다.
- **URLhaus는 덤프를 동기화하지 않고 조회 API로 호출한다.** 덤프를 KV/D1에 적재하면 수십만 행을 주기적으로 써야 해서 무료 쓰기 한도를 넘는다. 조회 엔드포인트 사양과 한도는 구현 단계에서 확인한다.
- 캐시된 외부 응답에 사용자별 정보가 섞이지 않도록 키에 세션 정보를 넣지 않는다.

---

## 6. 바인딩 · 환경 변수 이름 (제안)

**Cloudflare 바인딩**
| 이름 | 종류 | 용도 |
| --- | --- | --- |
| `DB` | D1 | 세션·메시지·QR 메타·AI 카운터·narration 캐시 |
| `BUCKET` | R2 | 생성된 QR SVG |
| `CACHE` | KV | 외부 조회 캐시, AI 상태, 차단 목록 |
| `REQ_LIMITER` | Rate Limiting | 일반 요청 빈도 제한 (사용 가능 여부는 구현 단계에서 확인) |

**시크릿** (`wrangler secret put`, 로컬은 `.dev.vars`)
| 이름 | 필수 | 용도 |
| --- | --- | --- |
| `EXAONE_API_KEY` | 필수 | K-EXAONE API Bearer 키 |
| `SAFE_BROWSING_API_KEY` | 필수(보안 검증) | Google Safe Browsing / Web Risk |
| `URLHAUS_AUTH_KEY` | 선택 | abuse.ch 인증키 |
| `TURNSTILE_SECRET_KEY` | 선택 | 조건부 봇 방지 (`docs/llm-budget.md` 8절) |
| `UPCITEMDB_USER_KEY` | 선택 | UPCitemdb 유료/개발 키 (무료 trial은 키 없이 호출) |

**일반 변수** (`wrangler.toml`의 `[vars]`, 비밀 아님)
| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `EXAONE_BASE_URL` | `https://api.exaone.ai/v1` | 제공자 교체 대비 |
| `EXAONE_MODEL` | `k-exaone_v2.5` | 모델 ID |
| `EXAONE_REASONING_EFFORT` | `low` | 추론 강도 |
| `EXAONE_RPM_LIMIT`, `EXAONE_RPD_LIMIT` | 콘솔 확인 후 입력 | 제공자 분·일 한도 |
| `LLM_SAFETY_RATIO` 외 `LLM_*` | `docs/llm-budget.md` 9절 | 세션·IP 한도, 타임아웃, 출력 상한 |
| `PUBLIC_TURNSTILE_SITE_KEY` | - | 클라이언트 공개 키 (도입 시) |

**로컬 개발 주의**
- `@sveltejs/adapter-cloudflare` 로컬 개발은 `.env`가 아니라 **`.dev.vars`** 의 `NAME=value` 형식 값을 `platform.env`로 주입한다. `.dev.vars`는 `.gitignore`에 포함돼 있다 (AGENTS.md 8.7).
- 현재 `.env`는 변수 이름 없이 키 문자열만 있어 그대로는 읽을 수 없다. `EXAONE_API_KEY=<키>` 형식의 `.dev.vars`로 옮긴다.

---

## 7. 결정 사항 (열린 질문 정리)

| 질문 | 결정 |
| --- | --- |
| 비-URL QR 원문 저장 | 저장하지 않음 (종류만 기록) |
| `scan_archives` | Phase 1에서 제외, Phase 2로 이관 |
| 세션 만료 방식 | 슬라이딩 90일 |
| 레이트 리밋 구현 | 일반 요청은 Workers Rate Limiting 바인딩(가능하면, 아니면 KV), **AI 호출 카운터는 D1 원자 카운터** |
