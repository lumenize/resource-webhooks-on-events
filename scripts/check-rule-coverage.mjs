#!/usr/bin/env node
// Checks that every rule from R1 to R24 but R6 is named by a passing test. It reads the JSON
// vitest writes with `--reporter=json`, takes every R number before the first colon of each
// passing test's title, as `R13, R14: brings ...`, and exits 1 naming each rule none names.
import { readFileSync } from 'node:fs';

const [file = 'test-results.json'] = process.argv.slice(2);
// R6, several writers minting moments, is designed, not built.
const REQUIRED = Array.from({ length: 24 }, (_, index) => index + 1).filter((rule) => rule !== 6);

const report = JSON.parse(readFileSync(file, 'utf8'));
const named = new Set();
for (const { assertionResults } of report.testResults) {
  for (const { title, status } of assertionResults) {
    const colon = title.indexOf(':');
    if (status !== 'passed' || colon === -1) continue;
    for (const match of title.slice(0, colon).matchAll(/\bR(\d+)\b/g)) named.add(Number(match[1]));
  }
}
const missing = REQUIRED.filter((rule) => !named.has(rule));
if (missing.length > 0) {
  console.error(`No passing test names ${missing.map((rule) => `R${rule}`).join(', ')} before the first colon of its title`);
  process.exit(1);
}
console.log(`Every rule from R1 to R24 but R6 is named by a passing test, in ${file}`);
