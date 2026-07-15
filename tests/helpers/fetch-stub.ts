// tests/helpers/fetch-stub.ts — shared fetch stub for apply-change.test.ts / apply-status.test.ts.
// Both scripts route writes through src/scripts/bot-api.ts's callBot(); this stub records
// every call so tests can assert URL/method/headers/body without a real HTTP server.

export function makeFetchStub(status = 200, body: unknown = { ok: true }) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}
