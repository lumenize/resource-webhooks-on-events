// The rule-coverage check `npm test` runs after the whole suite, given reports written by hand: it
// passes only when every rule from R1 to R26 but R6 and R25 is named before the first colon of a passing
// test's title.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '../../scripts/check-rule-coverage.mjs');
const scratches: string[] = [];

afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true });
});

function check(tests: { title: string; status: string }[]): { exitCode: number; output: string } {
  const scratch = mkdtempSync(join(tmpdir(), 'rule-coverage-'));
  scratches.push(scratch);
  const file = join(scratch, 'report.json');
  writeFileSync(file, JSON.stringify({ testResults: [{ assertionResults: tests }] }));
  try {
    return { exitCode: 0, output: execFileSync(process.execPath, [SCRIPT, file], { encoding: 'utf-8', stdio: 'pipe' }) };
  } catch (error) {
    const { status, stderr } = error as { status: number; stderr: string };
    return { exitCode: status, output: stderr };
  }
}

const every = (except: number[] = []) =>
  Array.from({ length: 26 }, (_, index) => index + 1)
    .filter((rule) => rule !== 6 && rule !== 25 && !except.includes(rule))
    .map((rule) => ({ title: `R${rule}: a test of it`, status: 'passed' }));

it('passes when every rule but R6 and R25 is named by a passing test', () => {
  expect(check(every())).toMatchObject({ exitCode: 0 });
});

it('fails naming a rule no passing test names, as R17 once left out', () => {
  expect(check(every([17]))).toEqual({ exitCode: 1, output: expect.stringContaining('No passing test names R17') });
  expect(check(every([26]))).toEqual({ exitCode: 1, output: expect.stringContaining('No passing test names R26') });
});

it('counts neither a failing test, nor an R number after the colon, nor a title with none', () => {
  const tests = [...every([17]), { title: 'R17: a failing test', status: 'failed' }, { title: 'a test: of R17, after the colon', status: 'passed' }, { title: 'R17 with no colon', status: 'passed' }];
  expect(check(tests)).toMatchObject({ exitCode: 1 });
  expect(check([...every([17]), { title: "R17's case: a test of it", status: 'passed' }])).toMatchObject({ exitCode: 0 });
});
