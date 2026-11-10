// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		interface Platform {
			env: Env;
			ctx: ExecutionContext;
			caches: CacheStorage;
			cf?: IncomingRequestCfProperties;
		}
	}

	/**
	 * 시크릿 (운영: `wrangler secret put`, 로컬: `.dev.vars`).
	 *
	 * `wrangler types`는 `.dev.vars`에 있는 이름만 Env에 넣어서 로컬과 CI의 타입이 달라지므로
	 * 시크릿은 여기서 직접 선언한다 (`.dev.vars` 없이도 타입체크가 통과해야 한다).
	 * 값이 비어 있을 수 있으니 `secret()`(src/lib/server/config.ts)로 읽는다.
	 */
	interface Env {
		EXAONE_API_KEY: string;
		SAFE_BROWSING_API_KEY: string;
		URLHAUS_AUTH_KEY: string;
		UPCITEMDB_USER_KEY: string;
		TURNSTILE_SECRET_KEY: string;
	}
}

export {};
