#!/usr/bin/env node
// Builds the publishable static site: a Markdown landing page at the site
// root, the songbook builder app under deploy.config.json's `appPath`, a
// demo songbook, and any other Markdown pages the config lists. See
// DEPLOY-SPEC.md for the full design.
//
// Usage:
//   node scripts/build-site.mjs [--out site] [--work .site-build] [--strict]
//                               [--skip-tests] [--only app|demo]
//   node scripts/build-site.mjs --serve [--out site] [--port 4173]
//
// Needs nothing beyond this repo's own dependencies (vite, jszip) and Node.
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import JSZip from "jszip";
import { build as viteBuild } from "vite";
import { renderMarkdownPage } from "./render-markdown.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { out: "site", work: ".site-build", port: 4173 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--work") args.work = argv[++i];
    else if (a === "--strict") args.strict = true;
    else if (a === "--skip-tests") args.skipTests = true;
    else if (a === "--only") args.only = argv[++i];
    else if (a === "--serve") args.serve = true;
    else if (a === "--port") args.port = Number(argv[++i]);
    else throw new Error(`build-site: unrecognised argument "${a}"`);
  }
  if (args.only && args.only !== "app" && args.only !== "demo") {
    throw new Error(`build-site: --only must be "app" or "demo", got "${args.only}"`);
  }
  return args;
}

function log(msg) {
  console.log(`[build-site] ${msg}`);
}

function run(cmd, cmdArgs, opts = {}) {
  log(`+ ${cmd} ${cmdArgs.join(" ")}`);
  const result = spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`build-site: "${cmd} ${cmdArgs.join(" ")}" exited with status ${result.status}`);
  }
}

// ---- preview-only mode ------------------------------------------------------

function serve(outDir, port) {
  const root = path.resolve(repoRoot, outDir);
  if (!existsSync(root)) {
    throw new Error(`build-site --serve: ${outDir} does not exist — run "npm run build:site" first`);
  }
  const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
    ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".txt": "text/plain", ".zip": "application/zip",
  };
  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath.endsWith("/")) reqPath += "index.html";
    const filePath = path.join(root, reqPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const body = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  server.listen(port, () => {
    log(`serving ${outDir}/ at http://localhost:${port}/`);
    log("Ctrl-C to stop.");
  });
}

// ---- deploy.config.json ------------------------------------------------------

function loadConfig() {
  const config = JSON.parse(readFileSync(path.join(repoRoot, "deploy.config.json"), "utf8"));
  for (const key of ["demo", "outDir"]) {
    if (!(key in config)) throw new Error(`deploy.config.json: missing required key "${key}"`);
  }
  return config;
}

// ---- the embedded chordprobook bundle ------------------------------------------

// Every songbook embeds generated/chordprobook_browser_bundle.js, which is
// committed. Regenerate it from the installed (lockfile-pinned) chordprobook
// into the work dir and compare, so a stale committed copy is caught here
// rather than shipped.
function verifyBundle(workDir, strict) {
  const fresh = path.join(workDir, "chordprobook_browser_bundle.js");
  run("node", [path.join(repoRoot, "scripts", "bundle-chordprobook-for-browser.mjs"), "--out", fresh]);
  const committed = path.join(repoRoot, "src", "chordpro-input", "generated", "chordprobook_browser_bundle.js");
  if (readFileSync(fresh, "utf8") !== readFileSync(committed, "utf8")) {
    const msg = "the committed chordprobook_browser_bundle.js is stale relative to the installed chordprobook — "
      + "run \"npm run generate:chordprobook-bundle\" and commit the result.";
    if (strict) throw new Error(`build-site: ${msg}`);
    log(`WARNING: ${msg}`);
  } else {
    log("chordprobook_browser_bundle.js matches the installed chordprobook.");
  }
}

// ---- the app ---------------------------------------------------------------------

async function buildApp(destDir) {
  log(`building the app into ${path.relative(repoRoot, destDir)}/`);
  await viteBuild({
    configFile: path.join(repoRoot, "vite.config.js"),
    build: { outDir: destDir, emptyOutDir: true },
    logLevel: "warn",
  });
}

// ---- demo songbook(s) --------------------------------------------------------

// Left out of the samples zip: they're this tool's own output, not source
// content someone downloading the zip would want to start from.
const GENERATED_ARTIFACT_NAMES = new Set([
  "ro-crate-metadata.json", "ro-crate-metadata.jsonld", "ro-crate-metadata.xlsx",
  "ro-crate-preview.html", "additional-ro-crate-metadata.xlsx", "songbook.html",
]);

async function buildDemo(demoEntry, workDir, outDir) {
  // Built from a scratch copy, so the committed samples folder is never
  // written to.
  const sourceDir = path.join(repoRoot, demoEntry.source);
  const scratch = path.join(workDir, "demo", demoEntry.path);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  for (const name of readdirSync(sourceDir)) {
    if (GENERATED_ARTIFACT_NAMES.has(name)) continue;
    cpSync(path.join(sourceDir, name), path.join(scratch, name), { recursive: true });
  }
  const cliArgs = [path.join(repoRoot, "src", "chordpro-input", "build-songbook.mjs"), scratch, "--file", "songbook.html"];
  if (demoEntry.title) cliArgs.push("--title", demoEntry.title);
  run("node", cliArgs);

  const destDir = path.join(outDir, demoEntry.path);
  mkdirSync(destDir, { recursive: true });
  cpSync(scratch, destDir, { recursive: true });
  writeFileSync(
    path.join(destDir, "index.html"),
    '<!doctype html><meta http-equiv="refresh" content="0; url=songbook.html">\n',
  );

  if (demoEntry.zip) await buildSamplesZip(sourceDir, path.join(destDir, demoEntry.zip));
}

// A downloadable zip of the demo's own source charts/setlists — a folder
// someone can point the app at themselves.
async function buildSamplesZip(sourceDir, destZipPath) {
  const zip = new JSZip();
  for (const name of readdirSync(sourceDir)) {
    if (name.startsWith(".") || name.startsWith("~$") || GENERATED_ARTIFACT_NAMES.has(name)) continue;
    const fullPath = path.join(sourceDir, name);
    if (statSync(fullPath).isDirectory()) continue; // samples/ is flat
    zip.file(name, readFileSync(fullPath));
  }
  writeFileSync(destZipPath, await zip.generateAsync({ type: "nodebuffer" }));
}

// ---- landing page + docs pages -------------------------------------------------

function buildMarkdownPage(sourcePath, destPath) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, renderMarkdownPage(readFileSync(sourcePath, "utf8")));
}

// ---- tree printing --------------------------------------------------------------

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function printTree(dir, prefix = "") {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      console.log(`${prefix}${entry.name}/`);
      printTree(full, prefix + "  ");
    } else {
      console.log(`${prefix}${entry.name}  (${formatSize(statSync(full).size)})`);
    }
  }
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.serve) {
    serve(args.out, args.port);
    return;
  }

  const config = loadConfig();
  const workDir = path.resolve(repoRoot, args.work);
  const outDir = path.resolve(repoRoot, args.out);
  mkdirSync(workDir, { recursive: true });

  if (!args.skipTests) run("npm", ["test"], { cwd: repoRoot });
  verifyBundle(workDir, args.strict);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // First, since Vite empties its outDir — the site root itself when there
  // is no appPath.
  if (args.only !== "demo") {
    await buildApp(config.appPath ? path.join(outDir, config.appPath) : outDir);
  }

  if (config.landing) {
    log(`rendering landing page: ${config.landing.source} -> ${config.landing.path}`);
    buildMarkdownPage(path.join(repoRoot, config.landing.source), path.join(outDir, config.landing.path));
  }
  for (const page of config.pages || []) {
    log(`rendering page: ${page.source} -> ${page.path}`);
    buildMarkdownPage(path.join(repoRoot, page.source), path.join(outDir, page.path));
  }

  if (args.only !== "app") {
    for (const demoEntry of config.demo) {
      log(`building demo songbook: ${demoEntry.source} -> ${demoEntry.path}/`);
      await buildDemo(demoEntry, workDir, outDir);
    }
  }

  writeFileSync(path.join(outDir, ".nojekyll"), "");

  log(`done — ${path.relative(repoRoot, outDir)}/:`);
  printTree(outDir);
}

main().catch((err) => {
  console.error(`[build-site] ${err.message}`);
  process.exitCode = 1;
});
