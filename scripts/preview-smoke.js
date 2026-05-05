const http = require("http");
const https = require("https");

function usage() {
  console.error("Usage: node scripts/preview-smoke.js <preview-url> [vercel-share-token]");
  process.exit(1);
}

function normalizeBase(rawBase) {
  const input = new URL(rawBase);
  const shareToken = input.searchParams.get("_vercel_share") || undefined;
  input.search = "";
  input.hash = "";
  return {
    baseUrl: new URL(`${input.origin}/`),
    shareToken,
  };
}

function cookieHeader(jar) {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function rememberCookies(jar, setCookie) {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const index = pair.indexOf("=");
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function requestUrl(url, jar, options = {}) {
  const transport = url.protocol === "https:" ? https : http;
  const headers = { ...(options.headers || {}) };
  const cookies = cookieHeader(jar);
  if (cookies) headers.cookie = cookies;

  return new Promise((resolve, reject) => {
    const req = transport.request(url, { method: options.method || "GET", headers }, (res) => {
      const chunks = [];
      rememberCookies(jar, res.headers["set-cookie"]);
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`Timeout requesting ${url.href}`)));
    req.end(options.body);
  });
}

function header(result, name) {
  const value = result.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value || "";
}

function setCookieCount(result) {
  const value = result.headers["set-cookie"];
  return Array.isArray(value) ? value.length : value ? 1 : 0;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestPath(baseUrl, jar, path, options) {
  return requestUrl(new URL(path, baseUrl), jar, options);
}

async function seedShareCookie(baseUrl, jar, shareToken) {
  if (!shareToken) return;
  const url = new URL("/", baseUrl);
  url.searchParams.set("_vercel_share", shareToken);
  const result = await requestUrl(url, jar);
  const location = header(result, "location");
  if (result.status >= 300 && result.status < 400 && location) {
    await requestUrl(new URL(location, baseUrl), jar);
  }
}

function activityContextPath(activity) {
  return `/api/activity/${encodeURIComponent(activity.kind)}/${encodeURIComponent(activity.id)}/context`;
}

async function main() {
  const [rawBase, rawShareToken] = process.argv.slice(2);
  if (!rawBase) usage();

  const { baseUrl, shareToken: parsedShareToken } = normalizeBase(rawBase);
  const shareToken = rawShareToken || parsedShareToken;
  const jar = new Map();
  await seedShareCookie(baseUrl, jar, shareToken);

  const activityWarm = await requestPath(baseUrl, jar, "/api/activity");
  assert(activityWarm.status === 200, `/api/activity warmup returned ${activityWarm.status}`);

  const activity = await requestPath(baseUrl, jar, "/api/activity");
  assert(activity.status === 200, `/api/activity returned ${activity.status}`);
  assert(header(activity, "server-timing"), "/api/activity missing Server-Timing");

  await new Promise((resolve) => setTimeout(resolve, 1200));
  const activityHit = await requestPath(baseUrl, jar, "/api/activity");
  assert(header(activityHit, "x-vercel-cache") === "HIT", "/api/activity did not produce an X-Vercel-Cache: HIT warm response");

  const body = JSON.parse(activity.body);
  const firstActivity = body.activities?.[0];
  assert(firstActivity?.kind && firstActivity?.id, "/api/activity returned no activity row for context smoke");
  const context = await requestPath(baseUrl, jar, activityContextPath(firstActivity));
  assert(context.status === 200, `${activityContextPath(firstActivity)} returned ${context.status}`);
  assert(header(context, "server-timing"), `${activityContextPath(firstActivity)} missing Server-Timing`);

  for (const path of ["/api/v1/classes", "/api/v1/evaluations"]) {
    const result = await requestPath(baseUrl, jar, path);
    assert(result.status === 200, `${path} returned ${result.status}`);
    assert(setCookieCount(result) === 0, `${path} returned ${setCookieCount(result)} Set-Cookie header(s)`);
  }

  const leaderboard = await requestPath(baseUrl, jar, "/u");
  assert(leaderboard.status === 404, `/u returned ${leaderboard.status}, expected 404`);

  const dashboard = await requestPath(baseUrl, jar, "/dashboard");
  assert(dashboard.body.includes("NEXT_REDIRECT;replace;/login"), "/dashboard did not render the unauthenticated login redirect marker");

  console.log(`preview smoke OK: ${baseUrl.origin}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
