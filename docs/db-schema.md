# D1 스키마 · 캐시 · 바인딩 (초안)

> 상태: **초안 — 리뷰 대기.** 기준: `docs/api-contract.md`(카드·엔드포인트), `AGENTS.md` Section 5(저장 규칙)·7.
> DB는 Cloudflare D1(SQLite). 시각은 epoch **밀리초(UTC)** 정수, ID는 ULID(시간순 정렬 가능)다. 실제 마이그레이션 파일(`schema.sql`)은 로드맵 Step 1에서 이 문서를 기준으로 만든다.

---

## 1. 설계 결정

1. **카드 JSON은 `messages.content`에 통째로 저장한다.** 카드 필드는 아직 바뀔 수 있으므로 컬럼으로 풀지 않는다. 이력 API는 저장된 JSON을 그대로 돌려준다.
2. **조회·집계에 쓰는 값만 `scan_archives`에 비정규화한다** (목록 표시용 제목, 상태, 정규화된 GTIN/URL). 아카이브 화면·재스캔 중복 확인·삭제에 쓴다.
3. **캐시는 D1이 아니라 KV에 둔다.** D1 무료 쓰기 한도(일 10만 행)와 KV 무료 쓰기(일 1,000건)를 구분해, 읽기 위주 캐시는 KV로 보낸다.
4. **세션 토큰은 해시로만 저장한다.** DB가 유출돼도 쿠키를 위조할 수 없다.
5. **R2 객체와 DB 행의 삭제 순서를 지킨다.** `ON DELETE CASCADE`가 `qr_assets` 행을 지우면 R2 키를 잃으므로, 항상 **R2 객체 삭제 → DB 삭제** 순서로 처리한다.

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
  expires_at   INTEGER NOT NULL                 -- last_seen_at + 90일 (갱신은 하루 1회까지)
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- 대화 메시지 (사용자 입력 + assistant 카드)
CREATE TABLE messages (
  id           TEXT PRIMARY KEY,                -- ULID (커서 기준)
  session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content_type TEXT NOT NULL CHECK (content_type IN
                 ('text', 'scan', 'product_card', 'security_card', 'qr_card')),
  content      TEXT NOT NULL CHECK (json_valid(content)),   -- API의 Message.content 그대로
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_session_id ON messages (session_id, id DESC);

-- 스캔 아카이브 (목록·중복 확인용 비정규화 인덱스)
CREATE TABLE scan_archives (
  id          TEXT PRIMARY KEY,                 -- ULID
  session_id  TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,   -- 결과 카드 메시지
  kind        TEXT NOT NULL CHECK (kind IN ('product', 'url', 'other')),
  format      TEXT NOT NULL,                    -- EAN_13, QR_CODE ...
  raw         TEXT NOT NULL,                    -- 스캔 원문 (최대 2048자)
  normalized  TEXT,                             -- product: GTIN-13 / url: 정규화 URL
  status      TEXT,                             -- product: found|not_found / url: SAFE|WARNING|DANGER
  title       TEXT,                             -- 제품명 또는 final_domain (목록 표시)
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_scan_archives_session_created ON scan_archives (session_id, created_at DESC);
CREATE INDEX idx_scan_archives_session_normalized ON scan_archives (session_id, normalized);

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
```

### 쓰기량 점검 (D1 무료 일 10만 행 기준)
- 스캔 1회 = `messages` 2행 + `scan_archives` 1행 = 3행. 채팅 1회 = 2행. QR 생성 1회 = 카드 메시지 + `qr_assets` 1행.
- 일 1만 스캔이어도 약 3만 행이라 여유가 있다. 세션 `last_seen_at` 갱신은 하루 1회로 제한해 쓰기를 줄인다.

---

## 3. 주요 쿼리 패턴

| 용도 | 쿼리 |
| --- | --- |
| 세션 조회 | `SELECT id, expires_at FROM sessions WHERE token_hash = ?` |
| 이력 페이지 | `SELECT id, role, content, created_at FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?` (첫 페이지는 `id < ?` 생략) |
| 엑사원 맥락 | 같은 쿼리로 최근 12개 (`LIMIT 12`) |
| 스캔 중복 확인 | `SELECT id FROM scan_archives WHERE session_id = ? AND normalized = ? ORDER BY created_at DESC LIMIT 1` |
| 전체 삭제 | ① `SELECT r2_key FROM qr_assets WHERE session_id = ?` → ② R2 객체 삭제 → ③ `DELETE FROM sessions WHERE id = ?` (CASCADE) |

- 한 요청에서 `messages`(사용자 + assistant) + `scan_archives` 쓰기는 `db.batch([...])`로 묶어 원자적으로 처리한다.
- 카드 저장은 응답을 내려보내는 것과 **병행**한다(`ctx.waitUntil`). 저장 실패 시에도 사용자 응답은 정상으로 보내고 오류를 로그로 남긴다.

---

## 4. 보관·삭제 정책

- **보관 기간:** 세션 마지막 사용 후 90일 (`expires_at`). 사용자가 `DELETE /api/history`로 즉시 삭제할 수 있다.
- **만료 정리:** Cron Trigger가 매일 새벽 1회 실행한다.
  1. `expires_at < now`인 세션의 `qr_assets.r2_key`를 조회해 R2 객체 삭제
  2. 만료 `qr_assets`(세션은 살아 있어도 `expires_at` 경과) 삭제
  3. 만료 세션 삭제 (messages·scan_archives·qr_assets는 CASCADE)
- 스캔 원문(`raw`)에는 개인 정보가 들어갈 수 있다 (Wi-Fi 비밀번호, 전화번호 등 비-URL QR). **비-URL QR 원문은 `messages.content`에 저장하되 로그에는 남기지 않는다.** 저장 자체를 막을지는 열린 질문으로 둔다.

---

## 5. KV 캐시 (`CACHE` 바인딩)

| 키 | 값 | TTL(초안) | 비고 |
| --- | --- | --- | --- |
| `gtin:{gtin13}` | 제품 조회 결과(found/not_found, source) | found 7일 / not_found 1일 | Open Food Facts 조회 한도(IP당 분당 15회) 보호 |
| `sec:{sha256(normalized_url)}` | 외부 보안 소스 응답(신호 목록) | 1시간 | Safe Browsing 캐시 유효 시간 준수 |
| `rdap:{domain}` | 등록일·레지스트라 | 7일 | 등록일은 거의 변하지 않음 |
| `rl:{scope}:{id}` | 레이트 리밋 카운터 | 분/일 단위 | Workers Rate Limiting 바인딩을 쓸 수 있으면 대체 |

- **URLhaus는 덤프를 동기화하지 않고 조회 API로 호출한다.** (스파이크 보고서의 "덤프 동기화" 안을 수정) 덤프를 KV/D1에 적재하면 수십만 행을 주기적으로 써야 해서 무료 쓰기 한도(KV 일 1,000건)를 넘는다. 조회 엔드포인트 사양과 한도는 구현 단계에서 확인한다.
- 캐시된 외부 응답이 사용자별로 달라지는 데이터를 포함하지 않도록, 키에는 세션 정보를 넣지 않는다.

---

## 6. 바인딩 · 환경 변수 이름 (제안)

**Cloudflare 바인딩**
| 이름 | 종류 | 용도 |
| --- | --- | --- |
| `DB` | D1 | 세션·메시지·아카이브·QR 메타 |
| `BUCKET` | R2 | 생성된 QR SVG |
| `CACHE` | KV | 외부 조회 캐시, 레이트 리밋 |

**시크릿** (`wrangler secret put`, 로컬은 `.dev.vars`)
| 이름 | 필수 | 용도 |
| --- | --- | --- |
| `EXAONE_API_KEY` | 필수 | K-EXAONE API Bearer 키 |
| `SAFE_BROWSING_API_KEY` | 필수(보안 검증) | Google Safe Browsing / Web Risk |
| `URLHAUS_AUTH_KEY` | 선택 | abuse.ch 인증키 |
| `TURNSTILE_SECRET_KEY` | 선택 | 신규 세션 봇 방지 (도입 시) |
| `UPCITEMDB_USER_KEY` | 선택 | UPCitemdb 유료/개발 키 (무료 trial은 키 없이 호출) |

**일반 변수** (`wrangler.toml`의 `[vars]`, 비밀 아님)
| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `EXAONE_BASE_URL` | `https://api.exaone.ai/v1` | 제공자 교체 대비 |
| `EXAONE_MODEL` | `k-exaone_v2.5` | 모델 ID |
| `EXAONE_REASONING_EFFORT` | `low` | 추론 강도 |
| `EXAONE_DAILY_CALL_LIMIT` | (비용 한도에 맞춰 설정) | 일일 호출 상한 |
| `PUBLIC_TURNSTILE_SITE_KEY` | - | 클라이언트 공개 키 (도입 시) |

**로컬 개발 주의**
- `@sveltejs/adapter-cloudflare` 로컬 개발은 `.env`가 아니라 **`.dev.vars`** 의 `NAME=value` 형식 값을 `platform.env`로 주입한다. `.dev.vars`는 반드시 `.gitignore`에 포함한다 (AGENTS.md 8.7).
- 현재 `.env`는 변수 이름 없이 키 문자열만 있어 그대로는 읽을 수 없다. `EXAONE_API_KEY=<키>` 형식의 `.dev.vars`로 옮긴다.

---

## 7. 열린 질문 (리뷰 요청)

1. **비-URL QR 원문 저장:** Wi-Fi 비밀번호 같은 민감 정보를 포함할 수 있다. 저장하지 않고 "비-URL QR은 기록하지 않음"으로 둘지, 90일 보관할지.
2. **`scan_archives` 필요성:** Phase 1 UI는 채팅 스크롤이 전부라 `messages`만으로 충분하다. 아카이브 화면(필터·검색)을 Phase 2로 미루면 이 테이블도 미룰 수 있다. 중복 스캔 안내를 Phase 1에 넣을지에 따라 결정.
3. **세션 만료 방식:** 슬라이딩 90일(제안)과 고정 90일 중 선택.
4. **레이트 리밋 구현:** Workers Rate Limiting 바인딩 vs KV 카운터 (KV 쓰기 한도 고려, 구현 단계에서 확정).
