#!/usr/bin/env node
// Checks the proposal split out of tasks/archive/master-plan.md: every rule, decision and question it
// cites (R12, D9, Q6) is defined in the proposal itself, every section it cites as § *Name* is a
// heading in it, every relative link names a file that exists, and every https link answers below
// 400. With --offline it skips the https links. Carried from the first flavor's checker, which
// read its numbers from sep-notes.md.
//
//   node scripts/check-proposal.mjs <proposal.md> [--offline]
//
// It exits 1 and lists each problem, or prints what it checked and exits 0.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const proposalPath = args.find((arg) => !arg.startsWith('--'));
if (!proposalPath) {
  console.error('usage: node scripts/check-proposal.mjs <proposal.md> [--offline]');
  process.exit(2);
}

const proposal = readFileSync(proposalPath, 'utf-8');
// A rule or a question is a list item that opens with its number in bold, as `- **R12.**`, and a
// decision is a table row that opens with its number, as `| D9 |`.
const defined = new Set([
  ...[...proposal.matchAll(/^- \*\*([RQ]\d+)\./gm)].map((match) => match[1]),
  ...[...proposal.matchAll(/^\| (D\d+) \|/gm)].map((match) => match[1]),
]);
const problems = [];
const cited = new Set([...proposal.matchAll(/\b([RDQ]\d+)\b/g)].map((match) => match[1]));
for (const number of [...cited].sort()) {
  if (!defined.has(number)) problems.push(`cites ${number}, which it does not define`);
}

// A section of another document, as SEP-3415's § *Authorization*, follows a possessive.
const headings = new Set([...proposal.matchAll(/^#+ (.+)$/gm)].map((match) => match[1]));
const sections = [...proposal.matchAll(/(\S*\s)?§ \*([^*]+)\*/g)].filter((match) => !/'s\s$/.test(match[1] ?? ''));
for (const name of new Set(sections.map((match) => match[2]))) {
  if (!headings.has(name)) problems.push(`cites § *${name}*, which is no heading in it`);
}

const links = [...proposal.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]);
const external = links.filter((link) => /^https?:/.test(link));
for (const link of links.filter((each) => !/^(https?:|mailto:|#)/.test(each))) {
  const target = resolve(dirname(proposalPath), link.split('#')[0]);
  if (!existsSync(target)) problems.push(`links ${link}, which names no file`);
}
if (!offline) {
  for (const link of [...new Set(external)]) {
    let status;
    try {
      status = (await fetch(link, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })).status;
    } catch (error) {
      status = String(error);
    }
    if (!(typeof status === 'number' && status < 400)) problems.push(`links ${link}, which answered ${status}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`checked ${cited.size} numbers cited, ${new Set(sections.map((match) => match[2])).size} sections cited and ${links.length} links${offline ? ', the https ones skipped' : ''}`);
