-- 0001_init: 세모바 초기 스키마 (Phase 1)
-- 원본 설계: docs/db-schema.md 2절. 설계와 이 파일은 항상 같아야 한다
-- (src/lib/server/schema.spec.ts가 어긋남을 검사한다).
-- Cloudflare D1은 외래 키를 항상 강제하므로 PRAGMA foreign_keys는 쓰지 않는다.

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
