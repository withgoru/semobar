import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';
import { createExaoneProvider, LlmError, type ChatRequest, type ToolDefinition } from './exaone';

/**
 * 실제 K-EXAONE API를 부르는 옵트인 테스트. 기본 실행(`npm test`)에서는 건너뛴다.
 * 실행: `npm run test:live` — 키는 `.dev.vars`의 EXAONE_API_KEY를 읽고 출력하지 않는다.
 * 제공자 한도(초당 1회, 분당 60회)를 지키려고 호출 사이에 간격을 둔다. CI에서는 실행하지 않는다.
 */
const live = process.env.EXAONE_LIVE === '1';

function readKey(): string {
	const text = readFileSync(new URL('../../../.dev.vars', import.meta.url), 'utf8');
	const line = text.split('\n').find((l) => l.startsWith('EXAONE_API_KEY='));
	const key = line?.slice('EXAONE_API_KEY='.length).trim();
	if (!key) throw new Error('EXAONE_API_KEY is empty in .dev.vars');
	return key;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const config = loadConfig({}).exaone;

describe.skipIf(!live)('K-EXAONE live (opt-in)', () => {
	const request: ChatRequest = {
		messages: [{ role: 'user', content: '한 문장으로 자기소개해줘.' }],
		maxTokens: 600,
		timeoutMs: 30_000
	};

	it('returns trimmed content, usage with reasoning tokens, and rate-limit headers', async () => {
		const provider = createExaoneProvider({ config, apiKey: readKey() });
		const result = await provider.chat(request);
		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content).toBe(result.content.trim());
		expect(result.truncated).toBe(false);
		expect(result.usage?.reasoningTokens).toBeGreaterThan(0); // 추론을 끌 수 없다
		expect(result.rateLimit.minute?.limit).toBeTypeOf('number');
		expect(result).not.toHaveProperty('reasoning_content');
		await pause(1400);
	}, 60_000);

	it('gets structured output through a forced tool call', async () => {
		const tool: ToolDefinition = {
			type: 'function',
			function: {
				name: 'write_intro',
				description: '짧은 소개를 작성한다',
				parameters: {
					type: 'object',
					properties: { title: { type: 'string' }, summary: { type: 'string' } },
					required: ['title', 'summary']
				}
			}
		};
		const provider = createExaoneProvider({ config, apiKey: readKey() });
		const result = await provider.chat({
			messages: [
				{ role: 'user', content: '오레오 쿠키를 소개하는 짧은 글을 write_intro로 작성해.' }
			],
			tools: [tool],
			toolChoice: { name: 'write_intro' },
			maxTokens: 1500,
			timeoutMs: 30_000
		});
		expect(result.toolCalls[0]?.name).toBe('write_intro');
		expect(result.toolCalls[0]?.argumentsValid).toBe(true);
		expect(result.toolCalls[0]?.arguments).toHaveProperty('summary');
		await pause(1400);
	}, 60_000);

	it('times out when the deadline is too short', async () => {
		const provider = createExaoneProvider({ config, apiKey: readKey() });
		await expect(provider.chat({ ...request, timeoutMs: 1 })).rejects.toMatchObject({
			kind: 'timeout'
		});
		await pause(1400);
	}, 30_000);

	it('maps an invalid key to an auth error without leaking it', async () => {
		const bad = 'sk-invalid-key-for-live-test';
		const provider = createExaoneProvider({ config, apiKey: bad });
		const error = await provider.chat(request).catch((e) => e);
		expect(error).toBeInstanceOf(LlmError);
		expect((error as LlmError).kind).toBe('auth');
		expect(String((error as LlmError).message)).not.toContain(bad);
	}, 30_000);
});
