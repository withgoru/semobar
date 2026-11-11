/**
 * K-EXAONE(OpenAI 호환 chat completions) 클라이언트.
 *
 * - 제공자 교체가 가능하도록 `LlmProvider` 인터페이스 뒤에 둔다 (docs/api-contract.md 6절).
 * - 한도 통제(호출 간격 게이트·카운터)와 재시도는 호출자(llm-budget, 이슈 #20)가 맡는다. 이 모듈은 재시도하지 않는다.
 * - `reasoning_content`(추론 과정)는 결과에 담지 않고 버린다. `content` 앞뒤 공백은 제거한다.
 * - API 키와 요청·응답 본문은 오류 메시지와 로그에 넣지 않는다.
 *
 * 실측(docs/llm-budget.md 0절): 추론을 끌 수 없고 `max_tokens`에 추론 토큰이 포함된다.
 */
import { secret, type AppConfig, type ConfigEnv, loadConfig, type ReasoningEffort } from './config';

// ── 공개 타입 ──────────────────────────────────────────────────────────

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
	role: ChatRole;
	content: string;
	/** role이 'tool'일 때 응답 대상 호출 ID */
	toolCallId?: string;
}

export interface ToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		/** JSON Schema (object) */
		parameters: Record<string, unknown>;
	};
}

/** `{ name }`이면 해당 도구를 강제로 호출한다 (구조화 출력을 도구 호출로 받을 때) */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
	messages: ChatMessage[];
	tools?: ToolDefinition[];
	toolChoice?: ToolChoice;
	/** 추론 토큰을 포함한 출력 상한 (docs/llm-budget.md 2절: 서술 1500, 채팅 1200) */
	maxTokens: number;
	/** 요청 전체(응답 본문 읽기 포함) 타임아웃. 채팅 20초, 서술 30초 */
	timeoutMs: number;
	/** 지정하지 않으면 설정의 기본값(low)을 쓴다 */
	reasoningEffort?: ReasoningEffort;
}

export interface ToolCall {
	id: string;
	name: string;
	/** 파싱된 인자. JSON이 아니거나 객체가 아니면 null */
	arguments: Record<string, unknown> | null;
	/** 모델이 보낸 원문 (깨진 출력 진단용, 사용자에게 노출하지 않는다) */
	rawArguments: string;
	argumentsValid: boolean;
}

export interface ChatUsage {
	promptTokens: number;
	completionTokens: number;
	reasoningTokens: number;
	totalTokens: number;
}

export interface RateLimitWindow {
	limit: number;
	remaining: number;
}

/** 응답 헤더 `x-{second|minute|day}-rate-limit(-remaining)` */
export interface RateLimitInfo {
	second?: RateLimitWindow;
	minute?: RateLimitWindow;
	day?: RateLimitWindow;
}

export interface ChatResult {
	/** 앞뒤 공백을 제거한 답변 텍스트 (도구 호출만 있으면 빈 문자열) */
	content: string;
	toolCalls: ToolCall[];
	finishReason: string | null;
	/** finish_reason이 length: `max_tokens`가 추론에 다 쓰여 답변이 잘렸거나 비었을 수 있다 */
	truncated: boolean;
	usage: ChatUsage | null;
	rateLimit: RateLimitInfo;
	latencyMs: number;
}

export interface LlmProvider {
	readonly name: string;
	chat(request: ChatRequest): Promise<ChatResult>;
}

// ── 오류 ───────────────────────────────────────────────────────────────

export type LlmErrorKind =
	| 'config' // 키 없음 등 설정 오류 (호출하지 않음)
	| 'timeout'
	| 'network'
	| 'rate_limited' // 429
	| 'auth' // 401·403: 키 오류·만료 → llm-budget이 L3(AI 중단)로 전환
	| 'bad_request' // 400 등 그 밖의 4xx
	| 'server' // 5xx
	| 'invalid_response'; // 응답 형식이 계약과 다름

export class LlmError extends Error {
	readonly kind: LlmErrorKind;
	readonly status?: number;
	/** 429일 때 `retry-after-ms` 또는 `retry-after`(초)에서 읽은 값 */
	readonly retryAfterMs?: number;
	readonly rateLimit?: RateLimitInfo;

	constructor(
		kind: LlmErrorKind,
		message: string,
		extra: { status?: number; retryAfterMs?: number; rateLimit?: RateLimitInfo } = {}
	) {
		super(message);
		this.name = 'LlmError';
		this.kind = kind;
		this.status = extra.status;
		this.retryAfterMs = extra.retryAfterMs;
		this.rateLimit = extra.rateLimit;
	}
}

// ── 구현 ───────────────────────────────────────────────────────────────

export interface UsageEvent {
	model: string;
	ok: boolean;
	latencyMs: number;
	usage: ChatUsage | null;
	/** 실패 시 종류 */
	errorKind?: LlmErrorKind;
}

export interface ExaoneProviderOptions {
	config: AppConfig['exaone'];
	/** null이면 호출하지 않고 `config` 오류를 던진다 */
	apiKey: string | null;
	/** 테스트에서 가짜 fetch를 주입한다 */
	fetch?: typeof fetch;
	/** 호출마다 사용량(토큰·지연)을 집계하는 훅. 프롬프트·응답 본문은 넘기지 않는다 */
	onUsage?: (event: UsageEvent) => void;
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
	const wire: Record<string, unknown> = { role: m.role, content: m.content };
	if (m.toolCallId) wire.tool_call_id = m.toolCallId;
	return wire;
}

function toWireToolChoice(choice: ToolChoice): unknown {
	return typeof choice === 'string'
		? choice
		: { type: 'function', function: { name: choice.name } };
}

function num(v: unknown): number | undefined {
	if (typeof v === 'number' && Number.isFinite(v)) return v;
	if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
	return undefined;
}

function readWindow(
	headers: Headers,
	unit: 'second' | 'minute' | 'day'
): RateLimitWindow | undefined {
	const limit = num(headers.get(`x-${unit}-rate-limit`));
	const remaining = num(headers.get(`x-${unit}-rate-limit-remaining`));
	return limit === undefined || remaining === undefined ? undefined : { limit, remaining };
}

export function parseRateLimit(headers: Headers): RateLimitInfo {
	const info: RateLimitInfo = {};
	for (const unit of ['second', 'minute', 'day'] as const) {
		const w = readWindow(headers, unit);
		if (w) info[unit] = w;
	}
	return info;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
	const ms = num(headers.get('retry-after-ms'));
	if (ms !== undefined && ms >= 0) return ms;
	const sec = num(headers.get('retry-after'));
	return sec !== undefined && sec >= 0 ? Math.round(sec * 1000) : undefined;
}

function parseToolCalls(raw: unknown): ToolCall[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((entry): ToolCall[] => {
		const fn = (entry as { function?: { name?: unknown; arguments?: unknown } })?.function;
		if (!fn || typeof fn.name !== 'string') return [];
		const rawArguments = typeof fn.arguments === 'string' ? fn.arguments : '';
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawArguments);
		} catch {
			parsed = null; // 깨진 JSON은 argumentsValid=false로 알린다
		}
		const valid = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
		return [
			{
				id: String((entry as { id?: unknown }).id ?? ''),
				name: fn.name,
				arguments: valid ? (parsed as Record<string, unknown>) : null,
				rawArguments,
				argumentsValid: valid
			}
		];
	});
}

function parseUsage(raw: unknown): ChatUsage | null {
	if (!raw || typeof raw !== 'object') return null;
	const u = raw as Record<string, unknown>;
	const details = u.completion_tokens_details as Record<string, unknown> | null | undefined;
	return {
		promptTokens: num(u.prompt_tokens) ?? 0,
		completionTokens: num(u.completion_tokens) ?? 0,
		reasoningTokens: num(u.reasoning_tokens) ?? num(details?.reasoning_tokens) ?? 0,
		totalTokens: num(u.total_tokens) ?? 0
	};
}

function classifyStatus(status: number): LlmErrorKind {
	if (status === 429) return 'rate_limited';
	if (status === 401 || status === 403) return 'auth';
	if (status >= 500) return 'server';
	return 'bad_request';
}

export function createExaoneProvider(options: ExaoneProviderOptions): LlmProvider {
	const { config, apiKey, onUsage } = options;
	const doFetch = options.fetch ?? fetch;
	const url = `${config.baseUrl}/chat/completions`;

	async function chat(request: ChatRequest): Promise<ChatResult> {
		const started = Date.now();
		const report = (ok: boolean, usage: ChatUsage | null, errorKind?: LlmErrorKind) =>
			onUsage?.({ model: config.model, ok, latencyMs: Date.now() - started, usage, errorKind });
		const fail = (error: LlmError): never => {
			report(false, null, error.kind);
			throw error;
		};

		if (!apiKey) fail(new LlmError('config', 'EXAONE_API_KEY is not set'));

		const body: Record<string, unknown> = {
			model: config.model,
			messages: request.messages.map(toWireMessage),
			max_tokens: request.maxTokens,
			reasoning_effort: request.reasoningEffort ?? config.reasoningEffort
		};
		if (request.tools?.length) {
			body.tools = request.tools;
			if (request.toolChoice !== undefined) body.tool_choice = toWireToolChoice(request.toolChoice);
		}

		const controller = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		// 취소 신호가 본문 읽기까지 전달되지 않는 런타임에서도 타임아웃이 보장되도록 경쟁시킨다
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(new Error('timeout'));
			}, request.timeoutMs);
		});
		const exchange = (async () => {
			const res = await doFetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});
			return { res, text: await res.text() };
		})();
		exchange.catch(() => {}); // 타임아웃으로 버려진 요청의 뒤늦은 오류가 처리되지 않은 거부가 되지 않게 한다

		let response: Response;
		let text: string;
		try {
			({ res: response, text } = await Promise.race([exchange, timeout]));
		} catch {
			// 원인 객체에 요청 정보가 들어 있을 수 있어 메시지에 옮기지 않는다
			return fail(
				timedOut
					? new LlmError('timeout', `EXAONE request timed out after ${request.timeoutMs}ms`)
					: new LlmError('network', 'EXAONE request failed (network error)')
			);
		} finally {
			clearTimeout(timer);
			timeout.catch(() => {}); // 정상 완료 후 대기 중인 타임아웃 약속이 남지 않게 한다
		}

		const rateLimit = parseRateLimit(response.headers);

		if (!response.ok) {
			const kind = classifyStatus(response.status);
			return fail(
				new LlmError(kind, `EXAONE responded with HTTP ${response.status}`, {
					status: response.status,
					retryAfterMs: kind === 'rate_limited' ? parseRetryAfterMs(response.headers) : undefined,
					rateLimit
				})
			);
		}

		let payload: {
			choices?: { message?: Record<string, unknown>; finish_reason?: unknown }[];
			usage?: unknown;
		};
		try {
			payload = JSON.parse(text);
		} catch {
			return fail(
				new LlmError('invalid_response', 'EXAONE response is not JSON', {
					status: response.status,
					rateLimit
				})
			);
		}
		const choice = payload?.choices?.[0];
		if (!choice || typeof choice.message !== 'object' || choice.message === null) {
			return fail(
				new LlmError('invalid_response', 'EXAONE response has no choices[0].message', {
					status: response.status,
					rateLimit
				})
			);
		}

		const message = choice.message;
		const finishReason = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
		const usage = parseUsage(payload.usage);
		// message.reasoning_content는 읽지 않는다 (폐기)
		const result: ChatResult = {
			content: typeof message.content === 'string' ? message.content.trim() : '',
			toolCalls: parseToolCalls(message.tool_calls),
			finishReason,
			truncated: finishReason === 'length',
			usage,
			rateLimit,
			latencyMs: Date.now() - started
		};
		report(true, usage);
		return result;
	}

	return { name: 'k-exaone', chat };
}

/** 환경(`platform.env`)에서 설정과 키를 읽어 제공자를 만든다 */
export function createExaoneProviderFromEnv(
	env: ConfigEnv & Partial<Pick<Env, 'EXAONE_API_KEY'>>,
	extra: Pick<ExaoneProviderOptions, 'fetch' | 'onUsage'> = {}
): LlmProvider {
	return createExaoneProvider({
		config: loadConfig(env).exaone,
		apiKey: secret(env, 'EXAONE_API_KEY'),
		...extra
	});
}
