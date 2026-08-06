/**
 * A minimal, dependency-free load generator -- deliberately not using a
 * third-party tool (autocannon was tried and dropped: it pulls in
 * vulnerable transitive dependencies for what's fundamentally "fire N
 * concurrent requests and measure latency"). Run against a real running
 * instance (see package.json's `loadtest` script) to get honest,
 * reproducible numbers instead of aspirational ones.
 *
 * Usage: BASE_URL=http://localhost:3000 npx tsx scripts/loadtest.ts
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const CONCURRENCY = Number(process.env.LOADTEST_CONCURRENCY ?? 20);
const DURATION_MS = Number(process.env.LOADTEST_DURATION_MS ?? 5000);

interface ScenarioResult {
  name: string;
  requests: number;
  errors: number;
  latenciesMs: number[];
}

async function runScenario(
  name: string,
  makeRequest: () => Promise<Response>
): Promise<ScenarioResult> {
  const result: ScenarioResult = { name, requests: 0, errors: 0, latenciesMs: [] };
  const deadline = Date.now() + DURATION_MS;

  async function worker() {
    while (Date.now() < deadline) {
      const start = performance.now();
      try {
        const response = await makeRequest();
        await response.arrayBuffer(); // drain the body, as a real client would
        result.latenciesMs.push(performance.now() - start);
        result.requests += 1;
        if (!response.ok) result.errors += 1;
      } catch {
        result.latenciesMs.push(performance.now() - start);
        result.requests += 1;
        result.errors += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return result;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index]!;
}

function report(result: ScenarioResult) {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1);
  const throughput = result.requests / (DURATION_MS / 1000);
  console.log(`\n--- ${result.name} ---`);
  console.log(`  requests:    ${result.requests} (${result.errors} errors)`);
  console.log(`  throughput:  ${throughput.toFixed(1)} req/s`);
  console.log(`  latency ms:  avg=${avg.toFixed(1)} p50=${percentile(sorted, 50).toFixed(1)} p95=${percentile(sorted, 95).toFixed(1)} p99=${percentile(sorted, 99).toFixed(1)} max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}`
  );
}

async function main() {
  console.log(`Load testing ${BASE_URL} -- concurrency=${CONCURRENCY}, duration=${DURATION_MS}ms per scenario\n`);

  report(await runScenario("GET /health (baseline, no DB)", () => fetch(`${BASE_URL}/health`)));

  // Set up a real user + token for the authenticated scenarios, using
  // fixed pre-derived key material (no need to run scrypt here -- we're
  // measuring API throughput, not client-side KDF cost).
  const username = `loadtest_${Date.now()}`;
  const registerResponse = await fetch(`${BASE_URL}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      displayName: "Load Test",
      publicKey: "cHVibGljS2V5MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=",
      authKey: "YXV0aEtleTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=",
      authSalt: "c2FsdDEyMzQ1Njc4OTAxMjM0NTY3ODk=",
    }),
  });
  const { token } = (await registerResponse.json()) as { token: string };
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const envelope = {
    v: 1,
    algo: "xchacha20poly1305",
    keyId: "k1",
    nonce: "bm9uY2UxMjM0NTY3ODkwMTIzNA==",
    ciphertext: "Y2lwaGVydGV4dA==",
  };

  report(
    await runScenario("POST /events (authenticated write)", () =>
      fetch(`${BASE_URL}/events`, { method: "POST", headers: authHeaders, body: JSON.stringify({ envelope }) })
    )
  );

  report(
    await runScenario("GET /events (authenticated read)", () =>
      fetch(`${BASE_URL}/events`, { headers: authHeaders })
    )
  );

  console.log("\nDone. See docs/ARCHITECTURE.md's Scaling strategy section for how to interpret these numbers.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
