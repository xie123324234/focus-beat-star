import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const html = read("index.html");
const publicSources = ["index.html", "app.js", "ai-client.js", "music-client.js", "music-engine.js", "composition-plan.js", "melody-guide.js"].map(file => `${file}\n${read(file)}`).join("\n");

const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map(match => match[1]);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual(duplicates, [], `duplicate HTML ids: ${[...new Set(duplicates)].join(", ")}`);
assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "inline event handlers violate the CSP and make review harder");
for (const match of html.matchAll(/<a\b[^>]*target=["']_blank["'][^>]*>/gi)) assert.match(match[0], /rel=["'][^"']*noopener[^"']*["']/i, "target=_blank link is missing noopener");
for (const match of html.matchAll(/<script\b([^>]*)>/gi)) assert.match(match[1], /\bsrc=["'][^"']+["']/i, "inline scripts are not allowed by the production CSP");

assert.doesNotMatch(publicSources, /(?:sk-live-|sk-[A-Za-z0-9_-]{24,}|Bearer\s+[A-Za-z0-9_-]{24,})/, "a credential-like value is present in browser-delivered files");
assert.doesNotMatch(publicSources, /https?:\/\/api\.(?:treblo|acemusic|siliconflow|minimax)/i, "frontend must call only same-origin gateways, never provider APIs directly");
assert.doesNotMatch(publicSources, /\b(?:eval|new\s+Function)\s*\(/, "dynamic code execution is not allowed");

const headers = read("_headers");
for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "X-Content-Type-Options: nosniff"]) assert.ok(headers.includes(directive), `missing security header/directive: ${directive}`);

console.log("PASS static security, CSP and DOM identity audit");
