#!/usr/bin/env node
// Standalone CLI: builds a songbook for one folder of ChordPro songs and
// setlists, with no browser involved — the same buildSongbook() the app
// runs (songbook_build.js), against a small File System Access API
// stand-in over plain Node `fs`. See SPEC.md's "Songbook HTML output"
// section.
//
// The title and songbook filename default to whatever an earlier build of
// the same folder recorded in its ro-crate-metadata.json (else the folder's
// own name and songbook.html), exactly as the app's own form prefills them.
// Ambiguous setlist matches are never asked about here: a choice recorded
// by an earlier build is reused, anything else gets the path-proximity
// default (SPEC.md §16).
//
// Usage:
//   node src/songbook/build-songbook.mjs <folder> [--title "My Songbook"] [--file my-songbook.html]
//   npm run build:songbook -- <folder> [--title ...] [--file ...]
import fs from "node:fs";
import path from "node:path";
import { extractPersistedSetlistMatches } from "./chordpro_crate.js";
import { buildSongbook, readBookSettings, CRATE_FILE } from "./songbook_build.js";
import { readJsonFromFolder } from "./fs_helpers.js";

function notFound(what) {
  const e = new Error(`${what} not found`);
  e.name = "NotFoundError";
  return e;
}

// Mirrors the shape of a FileSystemDirectoryHandle closely enough for
// everything songbook_build.js and chordpro_crate.js call on one.
function dirHandleFor(realPath, name = path.basename(realPath)) {
  return {
    kind: "directory",
    name,
    async *values() {
      for (const entry of fs.readdirSync(realPath, { withFileTypes: true })) {
        const childPath = path.join(realPath, entry.name);
        if (entry.isDirectory()) yield dirHandleFor(childPath, entry.name);
        else if (entry.isFile()) yield fileHandleFor(childPath, entry.name);
      }
    },
    async getDirectoryHandle(child, { create = false } = {}) {
      const childPath = path.join(realPath, child);
      if (!fs.existsSync(childPath)) {
        if (!create) throw notFound(child);
        fs.mkdirSync(childPath);
      }
      return dirHandleFor(childPath, child);
    },
    async getFileHandle(child, { create = false } = {}) {
      const childPath = path.join(realPath, child);
      if (!fs.existsSync(childPath) && !create) throw notFound(child);
      return fileHandleFor(childPath, child);
    },
  };
}

function fileHandleFor(realPath, name) {
  return {
    kind: "file",
    name,
    async getFile() { return new File([fs.readFileSync(realPath)], name); },
    async createWritable() {
      const chunks = [];
      return {
        async write(contents) { chunks.push(Buffer.from(contents)); },
        async close() { fs.writeFileSync(realPath, Buffer.concat(chunks)); },
      };
    },
  };
}

function parseArgs(argv) {
  const args = { folder: null, title: null, file: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--title") args.title = argv[++i];
    else if (argv[i] === "--file") args.file = argv[++i];
    else if (!args.folder) args.folder = argv[i];
    else throw new Error(`Unexpected argument "${argv[i]}"`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.folder) {
    console.error('Usage: node src/songbook/build-songbook.mjs <folder> [--title "..."] [--file name.html]');
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(args.folder);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a folder: ${root}`);
    process.exitCode = 1;
    return;
  }

  const dirHandle = dirHandleFor(root);
  const prior = await readJsonFromFolder(dirHandle, CRATE_FILE).catch(() => null);
  const settings = readBookSettings(prior, path.basename(root));

  let result;
  try {
    result = await buildSongbook(dirHandle, {
      title: args.title ?? settings.title,
      filename: args.file ?? settings.filename,
      matchOverrides: prior ? extractPersistedSetlistMatches(prior) : {},
      log: (msg) => console.log(msg),
    });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }

  const { songCount, setlistCount, unresolvedCount, ambiguousCount, songbookFile } = result;
  console.log(
    `Wrote ${songbookFile} to ${root} ` +
      `(${songCount} song(s), ${setlistCount} setlist(s)` +
      (unresolvedCount ? `, ${unresolvedCount} unresolved setlist entr${unresolvedCount === 1 ? "y" : "ies"}` : "") +
      (ambiguousCount ? `, ${ambiguousCount} ambiguous setlist entr${ambiguousCount === 1 ? "y" : "ies"}` : "") +
      ").",
  );
}

await main();
