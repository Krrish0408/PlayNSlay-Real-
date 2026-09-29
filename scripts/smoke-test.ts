import http from "http";
import https from "https";
import { URL } from "url";

interface CheckResult {
  name: string;
  passed: boolean;
  status?: number;
  durationMs: number;
  details?: string;
  error?: string;
}

const targetBaseUrl = process.env.TARGET_URL || `http://localhost:${process.env.PORT || 5001}`;

function makeRequest(
  urlPath: string,
  method = "GET",
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, targetBaseUrl);
    const client = fullUrl.protocol === "https:" ? https : http;

    const req = client.request(
      fullUrl,
      {
        method,
        headers: {
          Accept: "application/json",
          ...headers,
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: data,
          });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${urlPath} timed out (10s)`));
    });

    req.end();
  });
}

async function runSmokeTests() {
  console.log("================================================================================");
  console.log(`[SMOKE TEST] Initiating post-deployment smoke tests against: ${targetBaseUrl}`);
  console.log("================================================================================");

  const results: CheckResult[] = [];
  const startTime = Date.now();

  // Test 1: Liveness Probe (GET /api/health/live)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/health/live");
    const json = JSON.parse(res.body || "{}");
    const passed = res.status === 200 && (json.status === "alive" || json.status === "live");
    results.push({
      name: "1. Liveness Probe (GET /api/health/live)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `Status: ${json.status}`,
    });
  } catch (err: any) {
    results.push({
      name: "1. Liveness Probe (GET /api/health/live)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 2: Readiness Probe (GET /api/health/ready)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/health/ready");
    const json = JSON.parse(res.body || "{}");
    const passed = res.status === 200 && json.status === "ready";
    results.push({
      name: "2. Readiness Probe (GET /api/health/ready)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `DB: ${json.dependencies?.database || "unknown"}`,
    });
  } catch (err: any) {
    results.push({
      name: "2. Readiness Probe (GET /api/health/ready)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 3: Public Health Endpoint (GET /api/health)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/health");
    const json = JSON.parse(res.body || "{}");
    const passed = res.status === 200 && json.status === "healthy";
    results.push({
      name: "3. Health & Database Pool Latency (GET /api/health)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `Latency: ${json.latencyMs ?? 0}ms`,
    });
  } catch (err: any) {
    results.push({
      name: "3. Health & Database Pool Latency (GET /api/health)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 4: Catalog & Game Types Endpoint (GET /api/game-types)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/game-types");
    const json = JSON.parse(res.body || "[]");
    const passed = res.status === 200 && Array.isArray(json);
    results.push({
      name: "4. Catalog & Game Categories (GET /api/game-types)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `Game types count: ${Array.isArray(json) ? json.length : 0}`,
    });
  } catch (err: any) {
    results.push({
      name: "4. Catalog & Game Categories (GET /api/game-types)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 5: Physical Station Browsing (GET /api/stations)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/stations");
    const json = JSON.parse(res.body || "[]");
    const passed = res.status === 200 && Array.isArray(json);
    results.push({
      name: "5. Station Availability Browsing (GET /api/stations)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `Stations count: ${Array.isArray(json) ? json.length : 0}`,
    });
  } catch (err: any) {
    results.push({
      name: "5. Station Availability Browsing (GET /api/stations)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 6: CSRF Token Endpoint (GET /api/csrf-token)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/csrf-token");
    const json = JSON.parse(res.body || "{}");
    const passed = res.status === 200 && typeof json.csrfToken === "string" && json.csrfToken.length >= 16;
    results.push({
      name: "6. CSRF Synchronizer Token Probe (GET /api/csrf-token)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `Token length: ${json.csrfToken?.length || 0}`,
    });
  } catch (err: any) {
    results.push({
      name: "6. CSRF Synchronizer Token Probe (GET /api/csrf-token)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 7: RBAC Protection Verification (GET /api/admin/stats/comprehensive must reject unauthenticated requests)
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/admin/stats/comprehensive");
    const passed = res.status === 401 || res.status === 403;
    results.push({
      name: "7. Privileged RBAC Guardrail (GET /api/admin/stats/comprehensive)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `Correctly rejected unauthenticated call with HTTP ${res.status}`,
    });
  } catch (err: any) {
    results.push({
      name: "7. Privileged RBAC Guardrail (GET /api/admin/stats/comprehensive)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Test 8: Security Headers Verification
  try {
    const t0 = Date.now();
    const res = await makeRequest("/api/health");
    const headers = res.headers;
    const hasNoSniff = headers["x-content-type-options"] === "nosniff";
    const hasDenyFrame = headers["x-frame-options"] === "DENY";
    const passed = hasNoSniff && hasDenyFrame;
    results.push({
      name: "8. Essential Security Headers (nosniff, DENY)",
      passed,
      status: res.status,
      durationMs: Date.now() - t0,
      details: `nosniff=${hasNoSniff}, frameDeny=${hasDenyFrame}`,
    });
  } catch (err: any) {
    results.push({
      name: "8. Essential Security Headers (nosniff, DENY)",
      passed: false,
      durationMs: 0,
      error: err.message,
    });
  }

  // Print Summary Table
  console.log("\n[SMOKE TEST RESULTS]");
  console.table(
    results.map((r) => ({
      Check: r.name,
      Result: r.passed ? "PASS" : "FAIL",
      HTTP: r.status ?? "-",
      "Duration (ms)": r.durationMs,
      Notes: r.error ? `ERR: ${r.error}` : r.details || "OK",
    }))
  );

  const allPassed = results.every((r) => r.passed);
  const totalDuration = Date.now() - startTime;

  if (allPassed) {
    console.log(`\nAll ${results.length} smoke tests passed successfully in ${totalDuration}ms.`);
    process.exit(0);
  } else {
    const failedCount = results.filter((r) => !r.passed).length;
    console.error(`\nFATAL: ${failedCount} of ${results.length} smoke test(s) failed in ${totalDuration}ms.`);
    process.exit(1);
  }
}

runSmokeTests();
