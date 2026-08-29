/**
 * Security smoke tests.
 *
 * A short list of properties that are cheap to check, catastrophic to get
 * wrong, and easy to break without noticing — the kind of thing that does not
 * belong in a unit test because it is about the repository rather than about a
 * function.
 *
 *   npm run smoke
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readConfig, ConfigError } from "@/lib/config/runtime";

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(process.cwd());
const sourceFiles = files.filter((f) => /\.(ts|tsx|js|mjs|sql)$/.test(f) && !f.includes("/node_modules/"));

// 1. Default mode is the safe one.
check("default runtime mode is demo", readConfig({}).mode === "demo");

// 2. A demo cannot be pointed at a database.
let refused = false;
try {
  readConfig({ AION_RUNTIME_MODE: "demo", DATABASE_URL: "postgres://x/y" });
} catch (e) {
  refused = e instanceof ConfigError;
}
check("demo mode refuses a DATABASE_URL", refused);

// 3. Pilot mode refuses to start empty.
let pilotRefused = false;
try {
  readConfig({ AION_RUNTIME_MODE: "pilot" });
} catch (e) {
  pilotRefused = e instanceof ConfigError;
}
check("pilot mode refuses to start unconfigured", pilotRefused);

// 4. No committed secrets. Deliberately narrow patterns — a broad entropy
//    scan on a repository this size is all false positives.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key block", /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/],
  ["postgres URL with password", /postgres(?:ql)?:\/\/[^\s:'"]+:[^\s@'"]{6,}@(?!host|localhost|db\b)/],
];
const secretHits: string[] = [];
for (const f of sourceFiles.concat(files.filter((x) => /\.(md|ya?ml|json|env|example)$/.test(x)))) {
  if (f.endsWith("package-lock.json")) continue;
  const text = readFileSync(f, "utf8");
  for (const [label, re] of SECRET_PATTERNS) {
    if (re.test(text)) secretHits.push(`${label} in ${f.replace(process.cwd(), ".")}`);
  }
}
check("no credentials committed", secretHits.length === 0, secretHits.join("; "));

// 5. The env example carries no filled-in values.
const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");
const filled = envExample
  .split("\n")
  .filter((l) => /^[A-Z_]+=.+/.test(l) && !/^AION_RUNTIME_MODE=demo$/.test(l.trim()));
check(".env.example has no real values", filled.length === 0, filled.join(", "));

// 6. Nothing logs a whole intake, fact or answer object.
const loggingSins: string[] = [];
for (const f of sourceFiles.filter((x) => x.includes("/src/"))) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/console\.(log|info|warn|error)\(([^\n]*)/g)) {
    const arg = m[2];
    if (/\b(intake|facts|answer|hpi|note|messages|patient)\b/.test(arg) && !/\.id\b|\.length\b|count/.test(arg)) {
      loggingSins.push(`${f.replace(process.cwd(), ".")}: console.${m[1]}(${arg.slice(0, 60)}`);
    }
  }
}
check("no console call logs a clinical object", loggingSins.length === 0, loggingSins.join("; "));

// 7. The pilot photo path never builds a public object URL.
const photoSources = sourceFiles.filter((f) => /objects|photo/i.test(f) && f.includes("/src/"));
const presigned = photoSources.filter((f) => /getSignedUrl|presign|X-Amz-Signature=|publicUrl/i.test(readFileSync(f, "utf8")));
check("no pre-signed or public photo URLs", presigned.length === 0, presigned.join("; "));

console.log("");
if (failures.length > 0) {
  console.error(`\x1b[31m${failures.length} smoke check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32mAll smoke checks passed.\x1b[0m");
