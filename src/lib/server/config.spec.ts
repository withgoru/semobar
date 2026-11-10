import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ConfigError, loadConfig, secret } from './config';

/** wrangler.jsonc에서 한 줄 주석을 제거하고 파싱한다 */
function readWranglerConfig() {
	const text = readFileSync(new URL('../../../wrangler.jsonc', import.meta.url), 'utf8');
	const json = text
		.split('\n')
		.filter((line) => !line.trim().startsWith('//'))
		.join('\n');
	return JSON.parse(json) as {
		vars: Record<string, string>;
		d1_databases: { binding: string }[];
		r2_buckets: { binding: string }[];
		kv_namespaces: { binding: string }[];
		ratelimits: { name: string; simple: { limit: number; period: number } }[];
	};
}

describe('wrangler.jsonc', () => {
	const cfg = readWranglerConfig();

	it('declares the bindings documented in docs/db-schema.md', () => {
		expect(cfg.d1_databases.map((b) => b.binding)).toEqual(['DB']);
		expect(cfg.r2_buckets.map((b) => b.binding)).toEqual(['BUCKET']);
		expect(cfg.kv_namespaces.map((b) => b.binding)).toEqual(['CACHE']);
		expect(cfg.ratelimits.map((r) => r.name)).toEqual(['REQ_LIMITER', 'CHAT_LIMITER']);
	});

	it('defaults to production-safe values', () => {
		expect(cfg.vars.APP_ENV).toBe('production');
		expect(cfg.vars.LIMITS_MODE).toBe('enforce');
	});

	it('uses only string vars (.dev.vars overrides are strings too)', () => {
		for (const [name, value] of Object.entries(cfg.vars)) {
			expect(typeof value, name).toBe('string');
		}
	});

	it('has the same defaults as loadConfig() (no drift between jsonc and code)', () => {
		expect(loadConfig(cfg.vars)).toEqual(loadConfig({}));
	});

	it('matches the measured provider limits (docs/llm-budget.md)', () => {
		const { exaone, llm } = loadConfig(cfg.vars);
		expect(exaone).toMatchObject({
			rpmLimit: 60,
			rpdLimit: 86400,
			minIntervalMs: 1200,
			reasoningEffort: 'low'
		});
		expect(llm).toMatchObject({
			chatTimeoutMs: 20000,
			narrationTimeoutMs: 30000,
			chatMaxTokens: 1200,
			narrationMaxTokens: 1500
		});
	});
});

describe('loadConfig', () => {
	it('reads a development override from .dev.vars-style values', () => {
		const c = loadConfig({ APP_ENV: 'development', LIMITS_MODE: 'off' });
		expect(c.appEnv).toBe('development');
		expect(c.limitsModeRequested).toBe('off');
		expect(c.warnings).toEqual([]);
	});

	it('falls back to the safest values for unknown modes', () => {
		const c = loadConfig({ APP_ENV: 'prod', LIMITS_MODE: 'disabled' });
		expect(c.appEnv).toBe('production');
		expect(c.limitsModeRequested).toBe('enforce');
		expect(c.warnings).toHaveLength(2);
	});

	it('throws a ConfigError naming the variable for invalid numbers', () => {
		expect(() => loadConfig({ EXAONE_RPM_LIMIT: 'sixty' })).toThrow(ConfigError);
		expect(() => loadConfig({ EXAONE_RPM_LIMIT: 'sixty' })).toThrow(/EXAONE_RPM_LIMIT/);
		expect(() => loadConfig({ LLM_SESSION_CHAT_DAILY: '0' })).toThrow(/LLM_SESSION_CHAT_DAILY/);
		expect(() => loadConfig({ LLM_SAFETY_RATIO: '1.5' })).toThrow(/LLM_SAFETY_RATIO/);
	});

	it('treats empty strings as unset and trims the base URL', () => {
		const c = loadConfig({ EXAONE_MODEL: '', EXAONE_BASE_URL: 'https://example.test/v1//' });
		expect(c.exaone.model).toBe('k-exaone_v2.5');
		expect(c.exaone.baseUrl).toBe('https://example.test/v1');
	});
});

describe('secret', () => {
	it('returns null for missing or blank secrets and trims values', () => {
		expect(secret({}, 'EXAONE_API_KEY')).toBeNull();
		expect(secret({ EXAONE_API_KEY: '   ' }, 'EXAONE_API_KEY')).toBeNull();
		expect(secret({ EXAONE_API_KEY: ' abc ' }, 'EXAONE_API_KEY')).toBe('abc');
	});

	it('does not leak the secret through ConfigError messages', () => {
		try {
			loadConfig({ EXAONE_RPM_LIMIT: 'x' });
		} catch (e) {
			expect(String((e as Error).message)).not.toMatch(/KEY/i);
		}
	});
});
