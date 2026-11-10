/**
 * wrangler 변수(`vars`)를 타입이 있는 설정으로 읽는다.
 * 기본값은 wrangler.jsonc와 같아야 한다 (config.spec.ts가 어긋남을 검사한다).
 *
 * 개발 모드 해제 여부(`APP_ENV` + `LIMITS_MODE` + 로컬 호스트)는 이슈 #21의 가드가 판단한다.
 * 여기서는 요청된 값만 노출한다.
 */

export type AppEnv = 'production' | 'staging' | 'development';
export type LimitsMode = 'enforce' | 'off';
export type ReasoningEffort = 'low' | 'high' | 'max';

export interface AppConfig {
	appEnv: AppEnv;
	/** 환경 변수가 요청한 값. 실제 해제는 호스트까지 확인하는 가드(#21)가 결정한다. */
	limitsModeRequested: LimitsMode;
	exaone: {
		baseUrl: string;
		model: string;
		reasoningEffort: ReasoningEffort;
		rpmLimit: number;
		rpdLimit: number;
		minIntervalMs: number;
	};
	llm: {
		safetyRatio: number;
		sessionChatPerMin: number;
		sessionChatDaily: number;
		sessionScanDaily: number;
		ipMultiplier: number;
		chatTimeoutMs: number;
		narrationTimeoutMs: number;
		chatMaxTokens: number;
		narrationMaxTokens: number;
		devWarnPerMin: number;
	};
	/** 해석 중 안전한 기본값으로 대체한 항목 (로그용) */
	warnings: string[];
}

export type ConfigEnv = Partial<Record<string, string | undefined>>;

export class ConfigError extends Error {
	constructor(name: string, reason: string) {
		super(`invalid config ${name}: ${reason}`);
		this.name = 'ConfigError';
	}
}

const DEFAULTS = {
	APP_ENV: 'production',
	LIMITS_MODE: 'enforce',
	EXAONE_BASE_URL: 'https://api.exaone.ai/v1',
	EXAONE_MODEL: 'k-exaone_v2.5',
	EXAONE_REASONING_EFFORT: 'low',
	EXAONE_RPM_LIMIT: '60',
	EXAONE_RPD_LIMIT: '86400',
	EXAONE_MIN_INTERVAL_MS: '1200',
	LLM_SAFETY_RATIO: '0.8',
	LLM_SESSION_CHAT_PER_MIN: '5',
	LLM_SESSION_CHAT_DAILY: '20',
	LLM_SESSION_SCAN_DAILY: '60',
	LLM_IP_MULTIPLIER: '3',
	LLM_CHAT_TIMEOUT_MS: '20000',
	LLM_NARRATION_TIMEOUT_MS: '30000',
	LLM_CHAT_MAX_TOKENS: '1200',
	LLM_NARRATION_MAX_TOKENS: '1500',
	LLM_DEV_WARN_PER_MIN: '30'
} as const;

type VarName = keyof typeof DEFAULTS;

function raw(env: ConfigEnv, name: VarName): string {
	const v = env[name];
	return v === undefined || v === '' ? DEFAULTS[name] : v.trim();
}

function num(
	env: ConfigEnv,
	name: VarName,
	opts: { integer?: boolean; min?: number; max?: number } = {}
) {
	const text = raw(env, name);
	const n = Number(text);
	if (text === '' || !Number.isFinite(n)) throw new ConfigError(name, `"${text}" is not a number`);
	if (opts.integer && !Number.isInteger(n))
		throw new ConfigError(name, `"${text}" is not an integer`);
	if (opts.min !== undefined && n < opts.min) throw new ConfigError(name, `${n} < ${opts.min}`);
	if (opts.max !== undefined && n > opts.max) throw new ConfigError(name, `${n} > ${opts.max}`);
	return n;
}

function oneOf<T extends string>(
	env: ConfigEnv,
	name: VarName,
	allowed: readonly T[],
	fallback: T,
	warnings: string[]
): T {
	const v = raw(env, name);
	if ((allowed as readonly string[]).includes(v)) return v as T;
	warnings.push(`${name}="${v}" is not one of ${allowed.join('|')}; using "${fallback}"`);
	return fallback;
}

export function loadConfig(env: ConfigEnv = {}): AppConfig {
	const warnings: string[] = [];
	const int = { integer: true, min: 1 } as const;
	return {
		// 알 수 없는 값은 가장 안전한 쪽(운영·한도 적용)으로 대체한다
		appEnv: oneOf(env, 'APP_ENV', ['production', 'staging', 'development'], 'production', warnings),
		limitsModeRequested: oneOf(env, 'LIMITS_MODE', ['enforce', 'off'], 'enforce', warnings),
		exaone: {
			baseUrl: raw(env, 'EXAONE_BASE_URL').replace(/\/+$/, ''),
			model: raw(env, 'EXAONE_MODEL'),
			reasoningEffort: oneOf(
				env,
				'EXAONE_REASONING_EFFORT',
				['low', 'high', 'max'],
				'low',
				warnings
			),
			rpmLimit: num(env, 'EXAONE_RPM_LIMIT', int),
			rpdLimit: num(env, 'EXAONE_RPD_LIMIT', int),
			minIntervalMs: num(env, 'EXAONE_MIN_INTERVAL_MS', int)
		},
		llm: {
			safetyRatio: num(env, 'LLM_SAFETY_RATIO', { min: 0.1, max: 1 }),
			sessionChatPerMin: num(env, 'LLM_SESSION_CHAT_PER_MIN', int),
			sessionChatDaily: num(env, 'LLM_SESSION_CHAT_DAILY', int),
			sessionScanDaily: num(env, 'LLM_SESSION_SCAN_DAILY', int),
			ipMultiplier: num(env, 'LLM_IP_MULTIPLIER', int),
			chatTimeoutMs: num(env, 'LLM_CHAT_TIMEOUT_MS', int),
			narrationTimeoutMs: num(env, 'LLM_NARRATION_TIMEOUT_MS', int),
			chatMaxTokens: num(env, 'LLM_CHAT_MAX_TOKENS', int),
			narrationMaxTokens: num(env, 'LLM_NARRATION_MAX_TOKENS', int),
			devWarnPerMin: num(env, 'LLM_DEV_WARN_PER_MIN', int)
		},
		warnings
	};
}

export type SecretName = Extract<
	keyof Env,
	| 'EXAONE_API_KEY'
	| 'SAFE_BROWSING_API_KEY'
	| 'URLHAUS_AUTH_KEY'
	| 'UPCITEMDB_USER_KEY'
	| 'TURNSTILE_SECRET_KEY'
>;

/**
 * 시크릿을 읽는다. 없거나 비어 있으면 null. 값은 로그·오류 메시지에 넣지 않는다.
 */
export function secret(env: Partial<Pick<Env, SecretName>>, name: SecretName): string | null {
	const v = env[name];
	if (typeof v !== 'string') return null;
	const t = v.trim();
	return t === '' ? null : t;
}
