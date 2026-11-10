import { describe, it, expect } from 'vitest';

// 테스트 러너가 Node 환경에서 동작하는지 확인하는 스모크 테스트.
// 실제 도메인 테스트(보안 골든 케이스, 한도 카운터 등)는 각 기능 이슈에서 추가한다.
describe('test runner', () => {
	it('runs in a Node environment', () => {
		expect(typeof process.versions.node).toBe('string');
	});
});
