import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';
import {
	createExaoneProvider,
	createExaoneProviderFromEnv,
	LlmError,
	parseRateLimit,
	type ChatRequest,
	type LlmErrorKind,
	type LlmProvider,
	type ToolDefinition,
	type UsageEvent
} from './exaone';

// 모든 테스트는 가짜 fetch와 가짜 키만 쓴다 (실제 API·실제 키를 쓰지 않는다)
const FAKE_KEY = 'sk-test-FAKE-KEY-0123456789';
const config = loadConfig({}).exaone;

type FetchCall = { url: string; init: RequestInit };

function mockFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
	const calls: FetchCall[] = [];
	const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { url: String(input), init: init ?? {} };
		calls.push(call);
		return respond(call);
	});
	return { fetch: impl as unknown as typeof fetch, calls };
}

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
	return new Response(JSON.stringify(body), {
		status: init.status ?? 200,
		headers: { 'content-type': 'application/json', ...init.headers }
	});
}

function completion(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
	return {
		choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
		usage: { prompt_tokens: 24, completion_tokens: 96, total_tokens: 120, reasoning_tokens: 77 },
		...extra
	};
}

const baseRequest: ChatRequest = {
	messages: [{ role: 'user', content: '비밀 프롬프트 내용 12345' }],
	maxTokens: 1200,
	timeoutMs: 20_000
};

function provider(
	fetchImpl: typeof globalThis.fetch,
	extra: { onUsage?: (e: UsageEvent) => void } = {}
) {
	return createExaoneProvider({ config, apiKey: FAKE_KEY, fetch: fetchImpl, ...extra });
}

async function errorOf(p: Promise<unknown>): Promise<LlmError> {
	try {
		await p;
	} catch (e) {
		return e as LlmError;
	}
	throw new Error('expected the call to fail');
}

describe('request', () => {
	it('posts an OpenAI-compatible body with auth header, effort, and token cap', async () => {
		const { fetch, calls } = mockFetch(() => json(completion({ content: 'hi' })));
		await provider(fetch).chat(baseRequest);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.exaone.ai/v1/chat/completions');
		expect(calls[0].init.method).toBe('POST');
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
		expect(headers['Content-Type']).toBe('application/json');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			model: 'k-exaone_v2.5',
			messages: [{ role: 'user', content: '비밀 프롬프트 내용 12345' }],
			max_tokens: 1200,
			reasoning_effort: 'low'
		});
	});

	it('lets a request override the reasoning effort', async () => {
		const { fetch, calls } = mockFetch(() => json(completion({ content: 'x' })));
		await provider(fetch).chat({ ...baseRequest, reasoningEffort: 'high' });
		expect(JSON.parse(String(calls[0].init.body)).reasoning_effort).toBe('high');
	});

	it('sends tools and a forced tool_choice, and tool-result messages', async () => {
		const tool: ToolDefinition = {
			type: 'function',
			function: {
				name: 'write_product_narration',
				description: '제품 설명을 작성한다',
				parameters: {
					type: 'object',
					properties: { summary: { type: 'string' } },
					required: ['summary']
				}
			}
		};
		const { fetch, calls } = mockFetch(() => json(completion({ content: '' })));
		await provider(fetch).chat({
			...baseRequest,
			messages: [
				{ role: 'system', content: 's' },
				{ role: 'tool', content: '{"ok":true}', toolCallId: 'call_1' }
			],
			tools: [tool],
			toolChoice: { name: 'write_product_narration' }
		});
		const body = JSON.parse(String(calls[0].init.body));
		expect(body.tools).toEqual([tool]);
		expect(body.tool_choice).toEqual({
			type: 'function',
			function: { name: 'write_product_narration' }
		});
		expect(body.messages[1]).toEqual({
			role: 'tool',
			content: '{"ok":true}',
			tool_call_id: 'call_1'
		});
	});

	it('supports string tool choices and omits tool_choice when no tools are given', async () => {
		const { fetch, calls } = mockFetch(() => json(completion({ content: 'x' })));
		await provider(fetch).chat({ ...baseRequest, toolChoice: 'auto' }); // 도구가 없으면 보내지 않는다
		expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('tool_choice');
		expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty('tools');
	});
});

describe('response', () => {
	it('trims content and discards reasoning_content', async () => {
		const { fetch } = mockFetch(() =>
			json(
				completion({
					content: '\n\n안녕하세요!  \n',
					reasoning_content: '내부 추론 과정 SECRET-THOUGHT'
				})
			)
		);
		const result = await provider(fetch).chat(baseRequest);
		expect(result.content).toBe('안녕하세요!');
		expect(JSON.stringify(result)).not.toContain('SECRET-THOUGHT');
		expect(result).not.toHaveProperty('reasoning_content');
		expect(result).not.toHaveProperty('reasoningContent');
	});

	it('reads usage including reasoning tokens (top-level or nested)', async () => {
		const top = mockFetch(() => json(completion({ content: 'a' })));
		expect((await provider(top.fetch).chat(baseRequest)).usage).toEqual({
			promptTokens: 24,
			completionTokens: 96,
			reasoningTokens: 77,
			totalTokens: 120
		});
		const nested = mockFetch(() =>
			json(
				completion(
					{ content: 'a' },
					{
						usage: {
							prompt_tokens: 1,
							completion_tokens: 2,
							total_tokens: 3,
							completion_tokens_details: { reasoning_tokens: 9 }
						}
					}
				)
			)
		);
		expect((await provider(nested.fetch).chat(baseRequest)).usage?.reasoningTokens).toBe(9);
	});

	it('parses valid tool calls', async () => {
		const { fetch } = mockFetch(() =>
			json(
				completion({
					content: '\n\n',
					tool_calls: [
						{
							id: 'call_abc',
							type: 'function',
							function: {
								name: 'generate_custom_qr',
								arguments: '{"url": "https://example.com", "color_hex": "#000080"}'
							}
						}
					]
				})
			)
		);
		const result = await provider(fetch).chat(baseRequest);
		expect(result.content).toBe('');
		expect(result.toolCalls).toEqual([
			{
				id: 'call_abc',
				name: 'generate_custom_qr',
				arguments: { url: 'https://example.com', color_hex: '#000080' },
				rawArguments: '{"url": "https://example.com", "color_hex": "#000080"}',
				argumentsValid: true
			}
		]);
	});

	it('flags malformed tool arguments instead of throwing (measured: 1 of 6 narrations was garbled)', async () => {
		const { fetch } = mockFetch(() =>
			json(
				completion({
					tool_calls: [
						{
							id: 'c1',
							function: {
								name: 'write_security_narration',
								arguments: '{"headline": "x</parameteer>\n<parameteers=explanation>'
							}
						},
						{ id: 'c2', function: { name: 'x', arguments: '[1,2]' } },
						{ id: 'c3', function: { name: 'y', arguments: '' } }
					]
				})
			)
		);
		const calls = (await provider(fetch).chat(baseRequest)).toolCalls;
		expect(calls.map((c) => [c.name, c.argumentsValid, c.arguments])).toEqual([
			['write_security_narration', false, null],
			['x', false, null],
			['y', false, null]
		]);
		expect(calls[0].rawArguments).toContain('parameteer');
	});

	it('marks truncated responses (finish_reason=length) so callers can handle empty content', async () => {
		const { fetch } = mockFetch(() =>
			json({
				choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
				usage: {
					prompt_tokens: 37,
					completion_tokens: 300,
					total_tokens: 337,
					reasoning_tokens: 300
				}
			})
		);
		const result = await provider(fetch).chat({ ...baseRequest, maxTokens: 300 });
		expect(result.truncated).toBe(true);
		expect(result.content).toBe('');
		expect(result.finishReason).toBe('length');
	});

	it('parses rate-limit headers (measured: 1/s, 60/min, 86400/day)', async () => {
		const { fetch } = mockFetch(() =>
			json(completion({ content: 'a' }), {
				headers: {
					'x-second-rate-limit': '1',
					'x-second-rate-limit-remaining': '0',
					'x-minute-rate-limit': '60',
					'x-minute-rate-limit-remaining': '59',
					'x-day-rate-limit': '86400',
					'x-day-rate-limit-remaining': '86399'
				}
			})
		);
		expect((await provider(fetch).chat(baseRequest)).rateLimit).toEqual({
			second: { limit: 1, remaining: 0 },
			minute: { limit: 60, remaining: 59 },
			day: { limit: 86400, remaining: 86399 }
		});
		expect(parseRateLimit(new Headers())).toEqual({});
	});
});

describe('errors', () => {
	const cases: [number, LlmErrorKind][] = [
		[429, 'rate_limited'],
		[401, 'auth'],
		[403, 'auth'],
		[400, 'bad_request'],
		[404, 'bad_request'],
		[500, 'server'],
		[503, 'server']
	];

	it.each(cases)('maps HTTP %i to %s', async (status, kind) => {
		const { fetch } = mockFetch(() => json({ error: { message: 'x' } }, { status }));
		const error = await errorOf(provider(fetch).chat(baseRequest));
		expect(error).toBeInstanceOf(LlmError);
		expect(error.kind).toBe(kind);
		expect(error.status).toBe(status);
	});

	it('reads retry-after-ms first, then retry-after seconds, only for 429', async () => {
		const ms = mockFetch(() =>
			json({}, { status: 429, headers: { 'retry-after-ms': '1500', 'retry-after': '9' } })
		);
		expect((await errorOf(provider(ms.fetch).chat(baseRequest))).retryAfterMs).toBe(1500);

		const sec = mockFetch(() => json({}, { status: 429, headers: { 'retry-after': '2' } }));
		expect((await errorOf(provider(sec.fetch).chat(baseRequest))).retryAfterMs).toBe(2000);

		const none = mockFetch(() => json({}, { status: 429 }));
		expect((await errorOf(provider(none.fetch).chat(baseRequest))).retryAfterMs).toBeUndefined();

		const other = mockFetch(() => json({}, { status: 500, headers: { 'retry-after': '2' } }));
		expect((await errorOf(provider(other.fetch).chat(baseRequest))).retryAfterMs).toBeUndefined();
	});

	it('keeps rate-limit headers on a 429', async () => {
		const { fetch } = mockFetch(() =>
			json(
				{},
				{
					status: 429,
					headers: { 'x-second-rate-limit': '1', 'x-second-rate-limit-remaining': '0' }
				}
			)
		);
		expect((await errorOf(provider(fetch).chat(baseRequest))).rateLimit).toEqual({
			second: { limit: 1, remaining: 0 }
		});
	});

	it('times out and aborts the underlying request', async () => {
		let aborted = false;
		const { fetch } = mockFetch(
			({ init }) =>
				new Promise<Response>((_, reject) => {
					init.signal?.addEventListener('abort', () => {
						aborted = true;
						reject(new DOMException('The operation was aborted', 'AbortError'));
					});
				})
		);
		const started = Date.now();
		const error = await errorOf(provider(fetch).chat({ ...baseRequest, timeoutMs: 30 }));
		expect(error.kind).toBe('timeout');
		expect(aborted).toBe(true);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('times out while the response body is still being read', async () => {
		const slowBody = new ReadableStream({
			start() {
				/* 본문이 끝나지 않는다 */
			}
		});
		const { fetch } = mockFetch(({ init }) => {
			const response = new Response(slowBody, { status: 200 });
			init.signal?.addEventListener('abort', () => slowBody.cancel().catch(() => {}));
			return response;
		});
		const error = await errorOf(provider(fetch).chat({ ...baseRequest, timeoutMs: 30 }));
		expect(error.kind).toBe('timeout');
	});

	it('reports network failures', async () => {
		const { fetch } = mockFetch(() => {
			throw new TypeError('fetch failed');
		});
		expect((await errorOf(provider(fetch).chat(baseRequest))).kind).toBe('network');
	});

	it('rejects responses that do not match the contract', async () => {
		const notJson = mockFetch(() => new Response('<html>oops</html>', { status: 200 }));
		expect((await errorOf(provider(notJson.fetch).chat(baseRequest))).kind).toBe(
			'invalid_response'
		);

		const noChoices = mockFetch(() => json({ choices: [] }));
		expect((await errorOf(provider(noChoices.fetch).chat(baseRequest))).kind).toBe(
			'invalid_response'
		);

		const noMessage = mockFetch(() => json({ choices: [{ finish_reason: 'stop' }] }));
		expect((await errorOf(provider(noMessage.fetch).chat(baseRequest))).kind).toBe(
			'invalid_response'
		);
	});

	it('does not call the API without a key', async () => {
		const { fetch, calls } = mockFetch(() => json(completion({ content: 'x' })));
		const p = createExaoneProvider({ config, apiKey: null, fetch });
		const error = await errorOf(p.chat(baseRequest));
		expect(error.kind).toBe('config');
		expect(calls).toHaveLength(0);
	});

	it('never leaks the API key, the prompt, or upstream error text', async () => {
		const failures = [
			mockFetch(() =>
				json(
					{ error: { message: `bad key ${FAKE_KEY} for 비밀 프롬프트 내용 12345` } },
					{ status: 401 }
				)
			),
			mockFetch(() => json({}, { status: 429, headers: { 'retry-after': '1' } })),
			mockFetch(() => {
				throw new TypeError(
					`fetch failed: Authorization: Bearer ${FAKE_KEY} 비밀 프롬프트 내용 12345`
				);
			}),
			mockFetch(() => new Response(`not json ${FAKE_KEY}`, { status: 200 }))
		];
		for (const f of failures) {
			const error = await errorOf(provider(f.fetch).chat(baseRequest));
			const dump = `${error.message} ${error.stack?.split('\n')[0]} ${JSON.stringify({ ...error })}`;
			expect(dump).not.toContain(FAKE_KEY);
			expect(dump).not.toContain('비밀 프롬프트');
			expect(dump).not.toContain('12345');
		}
	});
});

describe('usage hook', () => {
	it('reports tokens and latency on success without prompt or response text', async () => {
		const events: UsageEvent[] = [];
		const { fetch } = mockFetch(() => json(completion({ content: '응답 본문 ABC' })));
		await provider(fetch, { onUsage: (e) => events.push(e) }).chat(baseRequest);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			model: 'k-exaone_v2.5',
			ok: true,
			usage: { reasoningTokens: 77 }
		});
		expect(events[0].latencyMs).toBeGreaterThanOrEqual(0);
		expect(JSON.stringify(events[0])).not.toContain('ABC');
		expect(JSON.stringify(events[0])).not.toContain('12345');
	});

	it('reports the failure kind on errors', async () => {
		const events: UsageEvent[] = [];
		const { fetch } = mockFetch(() => json({}, { status: 429 }));
		await errorOf(provider(fetch, { onUsage: (e) => events.push(e) }).chat(baseRequest));
		expect(events).toEqual([
			expect.objectContaining({ ok: false, errorKind: 'rate_limited', usage: null })
		]);
	});
});

describe('createExaoneProviderFromEnv', () => {
	it('uses the configured base URL and model, and the key from the env', async () => {
		const { fetch, calls } = mockFetch(() => json(completion({ content: 'ok' })));
		const p = createExaoneProviderFromEnv(
			{
				EXAONE_API_KEY: ` ${FAKE_KEY} `,
				EXAONE_BASE_URL: 'https://example.test/v1/',
				EXAONE_MODEL: 'test-model'
			},
			{ fetch }
		);
		await p.chat(baseRequest);
		expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
		expect(JSON.parse(String(calls[0].init.body)).model).toBe('test-model');
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
			`Bearer ${FAKE_KEY}`
		);
	});

	it('fails with a config error when the key is missing or blank', async () => {
		const { fetch, calls } = mockFetch(() => json(completion({ content: 'x' })));
		for (const env of [{}, { EXAONE_API_KEY: '   ' }]) {
			const error = await errorOf(createExaoneProviderFromEnv(env, { fetch }).chat(baseRequest));
			expect(error.kind).toBe('config');
		}
		expect(calls).toHaveLength(0);
	});
});

describe('LlmProvider interface', () => {
	it('can be replaced by another implementation', async () => {
		const fake: LlmProvider = {
			name: 'fake',
			chat: async () => ({
				content: 'from fake',
				toolCalls: [],
				finishReason: 'stop',
				truncated: false,
				usage: null,
				rateLimit: {},
				latencyMs: 0
			})
		};
		const run = async (p: LlmProvider) => (await p.chat(baseRequest)).content;
		expect(await run(fake)).toBe('from fake');
	});
});
