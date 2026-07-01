// ABOUTME: Dev static server for the git-for-agents plan overview — the design-review surface.
// ABOUTME: Scans ports from PORT (default 4400), serves this dir ("/" → overview.html), writes the bound URL to .serve-url.
const http = require("http");
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const START = parseInt(process.env.PORT || process.argv[2] || "4400", 10);
const PORTS = [START, START + 1, START + 2, START + 3, START + 4, START + 5];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const rel = u.pathname === "/" ? "overview.html" : decodeURIComponent(u.pathname).replace(/^\/+/, "");
  const fp = path.join(DIR, rel);
  if (!fp.startsWith(DIR)) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    // no-store so editing overview.html + refresh always shows the latest
    res.writeHead(200, { "Content-Type": TYPES[path.extname(fp)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(d);
  });
});

function listen(i) {
  if (i >= PORTS.length) { console.error("No free port in", PORTS.join(",")); process.exit(1); }
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE") { listen(i + 1); }
    else { console.error(e.message); process.exit(1); }
  });
  server.listen(PORTS[i], "127.0.0.1", () => {
    const url = "http://localhost:" + PORTS[i] + "/";
    try { fs.writeFileSync(path.join(DIR, ".serve-url"), url); } catch (_) {}
    console.log("SERVE_URL=" + url);
  });
}
listen(0);
