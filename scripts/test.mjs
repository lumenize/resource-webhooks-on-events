// `npm test`: the schema check, then the suite, then the check that every rule is named by a
// passing test. Arguments go to vitest, as `npm test -- test/lane/copies.test.ts`, and a run they
// narrow skips the rule check, which only the whole suite can pass.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const run = (command, commandArgs) => spawnSync(command, commandArgs, { stdio: 'inherit' }).status ?? 1;

let status = run('npm', ['run', '--silent', 'check:schema']);
if (status === 0) {
  status = run('npx', ['vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile.json=results/test-results.json', ...args]);
}
if (status === 0 && args.length === 0) status = run('node', ['scripts/check-rule-coverage.mjs', 'results/test-results.json']);
process.exit(status);
