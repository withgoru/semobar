import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * D1 스키마(migrations/0001_init.sql) 검증.
 * D1은 SQLite 기반이라 Node 내장 SQLite로 같은 SQL을 실행해 제약 조건과 핵심 쿼리를 확인한다.
 * (실제 D1 동작은 `npm run db:migrate:local`로 wrangler 로컬 D1에서 따로 확인한다.)
 */

const root = new URL('../../../', import.meta.url);
const migration = readFileSync(new URL('migrations/0001_init.sql', root), 'utf8');

function normalizeSql(sql: string): string {
	return sql
		.replace(/--[^\n]*/g, '')
		.replace(/\s+/g, ' ')
		.replace(/\s*([(),])\s*/g, '$1')
		.trim();
}

function createDb(): DatabaseSync {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON'); // D1은 외래 키를 항상 강제한다
	db.exec(migration);
	return db;
}

function addSession(db: DatabaseSync, id = 'S1', tokenHash = `hash-${id}`) {
	db.prepare(
		'INSERT INTO sessions (id, token_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, 100)'
	).run(id, tokenHash);
}

function addMessage(
	db: DatabaseSync,
	o: { id: string; session?: string; role?: string; type?: string; content?: string; at?: number }
) {
	db.prepare(
		'INSERT INTO messages (id, session_id, role, content_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
	).run(
		o.id,
		o.session ?? 'S1',
		o.role ?? 'assistant',
		o.type ?? 'product_card',
		o.content ?? '{"type":"product_card"}',
		o.at ?? 1
	);
}

function addQr(
	db: DatabaseSync,
	o: { id: string; color?: string; message?: string | null; key?: string }
) {
	db.prepare(
		`INSERT INTO qr_assets (id, session_id, message_id, r2_key, target_url, color_hex, created_at, expires_at)
		 VALUES (?, 'S1', ?, ?, 'https://example.test/', ?, 1, 100)`
	).run(o.id, o.message ?? null, o.key ?? `qr/${o.id}.svg`, o.color ?? '#001F3F');
}

const count = (db: DatabaseSync, table: string) =>
	(db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migrations/0001_init.sql', () => {
	it('is identical to the DDL in docs/db-schema.md (no drift)', () => {
		const doc = readFileSync(new URL('docs/db-schema.md', root), 'utf8');
		const ddl = /```sql\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? '';
		const withoutPragma = ddl
			.split('\n')
			.filter((line) => !/^\s*PRAGMA\s+foreign_keys/i.test(line))
			.join('\n');
		expect(normalizeSql(migration)).toBe(normalizeSql(withoutPragma));
	});

	it('does not set PRAGMA foreign_keys (D1 always enforces them)', () => {
		expect(migration).not.toMatch(/^\s*PRAGMA\s+foreign_keys/im);
	});

	it('creates the documented tables and indexes', () => {
		const db = createDb();
		const names = (type: string) =>
			(
				db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name"
					)
					.all(type) as { name: string }[]
			).map((r) => r.name);
		expect(names('table')).toEqual([
			'llm_gate',
			'llm_usage',
			'messages',
			'narration_cache',
			'qr_assets',
			'sessions'
		]);
		expect(names('index')).toEqual(
			expect.arrayContaining([
				'idx_messages_session_id',
				'idx_qr_assets_expires',
				'idx_qr_assets_session',
				'idx_sessions_expires',
				'idx_narration_cache_expires'
			])
		);
		expect(() => db.exec('SELECT * FROM scan_archives')).toThrow(); // Phase 1에는 없다
	});
});

describe('constraints', () => {
	let db: DatabaseSync;
	beforeEach(() => {
		db = createDb();
		addSession(db);
	});

	it('rejects messages for a missing session (foreign key)', () => {
		expect(() => addMessage(db, { id: 'M1', session: 'NOPE' })).toThrow(/FOREIGN KEY/);
	});

	it('rejects invalid role, content_type and non-JSON content', () => {
		expect(() => addMessage(db, { id: 'M1', role: 'system' })).toThrow(/CHECK/);
		expect(() => addMessage(db, { id: 'M2', type: 'unknown_card' })).toThrow(/CHECK/);
		expect(() => addMessage(db, { id: 'M3', content: 'not json' })).toThrow(/CHECK/);
		expect(count(db, 'messages')).toBe(0);
	});

	it('accepts every documented content_type', () => {
		['text', 'scan', 'product_card', 'security_card', 'qr_card'].forEach((type, i) =>
			addMessage(db, {
				id: `M${i}`,
				type,
				role: type === 'text' || type === 'scan' ? 'user' : 'assistant'
			})
		);
		expect(count(db, 'messages')).toBe(5);
	});

	it('enforces unique session tokens and R2 keys', () => {
		expect(() => addSession(db, 'S2', 'hash-S1')).toThrow(/UNIQUE/);
		addQr(db, { id: 'Q1', key: 'qr/same.svg' });
		expect(() => addQr(db, { id: 'Q2', key: 'qr/same.svg' })).toThrow(/UNIQUE/);
	});

	it('accepts only #RRGGBB for color_hex', () => {
		for (const ok of ['#001F3F', '#00bfff', '#FFFFFF', '#abcDEF']) {
			expect(() => addQr(db, { id: `ok-${ok}`, color: ok }), ok).not.toThrow();
		}
		for (const bad of [
			'red',
			'#12345',
			'#1234567',
			'001F3F',
			'#GG1F3F',
			'#00 F3F',
			'',
			"#00'F3F"
		]) {
			expect(() => addQr(db, { id: `bad-${bad}`, color: bad }), bad).toThrow(/CHECK/);
		}
	});

	it('rejects non-JSON narration in the cache', () => {
		const insert = (narration: string) =>
			db
				.prepare(
					"INSERT INTO narration_cache (cache_key, card_type, narration, created_at, expires_at) VALUES ('k', 'product_card', ?, 1, 2)"
				)
				.run(narration);
		expect(() => insert('oops')).toThrow(/CHECK/);
		expect(() => insert('{"summary":"ok"}')).not.toThrow();
	});
});

describe('delete behaviour (cascade)', () => {
	it('cascades session deletion to messages and QR rows', () => {
		const db = createDb();
		addSession(db);
		addMessage(db, { id: 'M1' });
		addQr(db, { id: 'Q1', message: 'M1' });
		db.prepare('DELETE FROM sessions WHERE id = ?').run('S1');
		expect(count(db, 'messages')).toBe(0);
		expect(count(db, 'qr_assets')).toBe(0);
	});

	it('keeps the QR row (message_id = NULL) when only its message is deleted', () => {
		const db = createDb();
		addSession(db);
		addMessage(db, { id: 'M1' });
		addQr(db, { id: 'Q1', message: 'M1' });
		db.prepare('DELETE FROM messages WHERE id = ?').run('M1');
		expect(db.prepare('SELECT message_id FROM qr_assets WHERE id = ?').get('Q1')).toEqual({
			message_id: null
		});
	});

	it('lets the R2 keys be read before the session is deleted (delete order: R2 → DB)', () => {
		const db = createDb();
		addSession(db);
		addQr(db, { id: 'Q1' });
		addQr(db, { id: 'Q2' });
		const keys = db
			.prepare('SELECT r2_key FROM qr_assets WHERE session_id = ? ORDER BY id')
			.all('S1');
		expect(keys).toEqual([{ r2_key: 'qr/Q1.svg' }, { r2_key: 'qr/Q2.svg' }]);
		db.prepare('DELETE FROM sessions WHERE id = ?').run('S1');
		expect(db.prepare('SELECT r2_key FROM qr_assets').all()).toEqual([]); // 이후에는 키를 잃는다
	});
});

describe('queries from docs/db-schema.md', () => {
	it('paginates history newest-first with a ULID cursor', () => {
		const db = createDb();
		addSession(db);
		addSession(db, 'S2');
		for (const id of ['01A', '01B', '01C', '01D', '01E'])
			addMessage(db, { id, role: 'user', type: 'text', content: '{"type":"text"}' });
		addMessage(db, { id: '01Z', session: 'S2' }); // 다른 세션은 보이지 않는다
		const page = db.prepare(
			'SELECT id FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?'
		);
		expect(page.all('S1', '~', 2)).toEqual([{ id: '01E' }, { id: '01D' }]);
		expect(page.all('S1', '01D', 2)).toEqual([{ id: '01C' }, { id: '01B' }]);
		expect(page.all('S1', '01B', 2)).toEqual([{ id: '01A' }]);
	});

	it('updates narration inside the stored card JSON', () => {
		const db = createDb();
		addSession(db);
		addMessage(db, {
			id: 'M1',
			content: '{"type":"product_card","narration_status":"pending","narration":null}'
		});
		const narration = JSON.stringify({ name_ko: '오레오', summary: '쿠키예요' });
		const result = db
			.prepare(
				"UPDATE messages SET content = json_set(content, '$.narration_status', ?, '$.narration', json(?)) WHERE id = ? AND session_id = ?"
			)
			.run('ok', narration, 'M1', 'S1');
		expect(result.changes).toBe(1);
		const row = db.prepare('SELECT content FROM messages WHERE id = ?').get('M1') as {
			content: string;
		};
		expect(JSON.parse(row.content)).toEqual({
			type: 'product_card',
			narration_status: 'ok',
			narration: { name_ko: '오레오', summary: '쿠키예요' }
		});
		// 다른 세션 ID로는 갱신되지 않는다
		expect(
			db
				.prepare(
					"UPDATE messages SET content = json_set(content, '$.narration_status', 'x') WHERE id = ? AND session_id = ?"
				)
				.run('M1', 'S2').changes
		).toBe(0);
	});
});

describe('llm_usage atomic counter (docs/llm-budget.md 4절)', () => {
	const ACQUIRE = `INSERT INTO llm_usage (scope, key, window_start, count) VALUES (?1, ?2, ?3, 1)
		ON CONFLICT (scope, key, window_start) DO UPDATE SET count = count + 1 WHERE count < ?4
		RETURNING count`;
	const REFUND =
		'UPDATE llm_usage SET count = count - 1 WHERE scope = ? AND key = ? AND window_start = ? AND count > 0';

	it('increments until the limit, then returns no row', () => {
		const db = createDb();
		const acquire = db.prepare(ACQUIRE);
		const results = [1, 2, 3, 4, 5].map(
			() => acquire.all('session:chat:day', 'S1', 1000, 3).length
		);
		expect(results).toEqual([1, 1, 1, 0, 0]);
		expect(db.prepare('SELECT count FROM llm_usage').get()).toEqual({ count: 3 });
	});

	it('returns the new count', () => {
		const db = createDb();
		const acquire = db.prepare(ACQUIRE);
		expect(acquire.all('global:min', 'all', 60, 48)).toEqual([{ count: 1 }]);
		expect(acquire.all('global:min', 'all', 60, 48)).toEqual([{ count: 2 }]);
	});

	it('starts fresh in a new window and keeps scopes and keys separate', () => {
		const db = createDb();
		const acquire = db.prepare(ACQUIRE);
		for (let i = 0; i < 3; i++) acquire.all('session:chat:day', 'S1', 1000, 3);
		expect(acquire.all('session:chat:day', 'S1', 1000, 3)).toEqual([]); // 같은 윈도우: 한도 도달
		expect(acquire.all('session:chat:day', 'S1', 2000, 3)).toEqual([{ count: 1 }]); // 다음 날
		expect(acquire.all('session:chat:day', 'S2', 1000, 3)).toEqual([{ count: 1 }]); // 다른 세션
		expect(acquire.all('ip:chat:day', 'S1', 1000, 3)).toEqual([{ count: 1 }]); // 다른 범위
	});

	it('refunds a count but never below zero', () => {
		const db = createDb();
		const acquire = db.prepare(ACQUIRE);
		acquire.all('session:chat:day', 'S1', 1000, 3);
		const refund = db.prepare(REFUND);
		expect(refund.run('session:chat:day', 'S1', 1000).changes).toBe(1);
		expect(refund.run('session:chat:day', 'S1', 1000).changes).toBe(0);
		expect(db.prepare('SELECT count FROM llm_usage').get()).toEqual({ count: 0 });
	});
});

describe('llm_gate call-interval gate (docs/llm-budget.md 4절)', () => {
	const GATE = `INSERT INTO llm_gate (key, last_call_ms) VALUES ('global', ?1)
		ON CONFLICT (key) DO UPDATE SET last_call_ms = ?1 WHERE last_call_ms <= ?1 - 1200
		RETURNING last_call_ms`;

	it('allows a call only when 1200 ms have passed since the previous one', () => {
		const db = createDb();
		const gate = db.prepare(GATE);
		expect(gate.all(10_000)).toEqual([{ last_call_ms: 10_000 }]); // 첫 호출
		expect(gate.all(10_500)).toEqual([]); // 너무 이름
		expect(gate.all(11_199)).toEqual([]); // 1199ms
		expect(gate.all(11_200)).toEqual([{ last_call_ms: 11_200 }]); // 정확히 1200ms
		expect(gate.all(11_300)).toEqual([]); // 갱신된 시각 기준
		expect(db.prepare('SELECT last_call_ms FROM llm_gate').get()).toEqual({ last_call_ms: 11_200 });
	});
});
