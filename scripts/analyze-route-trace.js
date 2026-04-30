const fs = require("fs");
const path = require("path");

const hotRoutes = [
  { label: "/", suffixes: [path.join("server", "app", "page.js.nft.json")] },
  { label: "/agents", suffixes: [path.join("server", "app", "agents", "page.js.nft.json")] },
  { label: "/g", suffixes: [path.join("server", "app", "g", "page.js.nft.json")] },
  { label: "/api/activity", suffixes: [path.join("server", "app", "api", "activity", "route.js.nft.json")] },
  {
    label: "/api/activity/[kind]/[id]/context",
    suffixes: [path.join("server", "app", "api", "activity", "[kind]", "[id]", "context", "route.js.nft.json")],
  },
];

const heavyPackages = [
  "chromadb",
  "chromadb-default-embed",
  "@atproto/crypto",
  "@atproto/repo",
  "@modelcontextprotocol/sdk",
  "next-mdx-remote",
  "rss-parser",
];

function traceFiles(tracePath) {
  if (!fs.existsSync(tracePath)) return [];
  const raw = JSON.parse(fs.readFileSync(tracePath, "utf8"));
  return Array.isArray(raw.files) ? raw.files : [];
}

function includedPackages(files) {
  return heavyPackages.filter((pkg) => {
    const needle = `${path.sep}node_modules${path.sep}${pkg}${path.sep}`.replaceAll("\\", "/");
    return files.some((file) => file.replaceAll("\\", "/").includes(needle));
  });
}

const root = path.join(process.cwd(), ".next");
let failed = false;

for (const route of hotRoutes) {
  const traces = route.suffixes.map((suffix) => path.join(root, suffix));
  const files = traces.flatMap(traceFiles);
  if (files.length === 0) {
    console.log(`${route.label} | trace=missing`);
    failed = true;
    continue;
  }

  const packages = includedPackages(files);
  console.log(`${route.label} | files=${files.length} | heavy=${packages.length ? packages.join(",") : "none"}`);
}

if (failed) process.exitCode = 1;
