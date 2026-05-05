const http = require("http");
const https = require("https");
const { performance } = require("perf_hooks");

function requestUrl(url) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = transport.get(url, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          ms: performance.now() - start,
          bytes: Buffer.concat(chunks).length,
          cacheControl: res.headers["cache-control"] || "",
          serverTiming: res.headers["server-timing"] || "",
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Timeout requesting ${url.href}`));
    });
  });
}

async function measureRoute(baseUrl, route) {
  const url = new URL(route, baseUrl);
  await requestUrl(url);

  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(await requestUrl(url));
  }

  const durations = results.map((result) => result.ms);
  const last = results[results.length - 1];
  const average = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
  return {
    route,
    status: last.status,
    average,
    min: Math.min(...durations),
    max: Math.max(...durations),
    bytes: last.bytes,
    cacheControl: last.cacheControl,
    serverTiming: last.serverTiming,
  };
}

async function main() {
  const [base, ...routes] = process.argv.slice(2);
  if (!base || routes.length === 0) {
    console.error("Usage: node scripts/perf-smoke.js <base-url> <route> [route...]");
    process.exit(1);
  }

  const baseUrl = new URL(base.endsWith("/") ? base : `${base}/`);
  for (const route of routes) {
    const result = await measureRoute(baseUrl, route);
    console.log([
      result.route,
      `status=${result.status}`,
      `avg=${result.average.toFixed(1)}ms`,
      `min=${result.min.toFixed(1)}ms`,
      `max=${result.max.toFixed(1)}ms`,
      `bytes=${result.bytes}`,
      `cache=${result.cacheControl}`,
      `serverTiming=${result.serverTiming}`,
    ].join(" | "));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
