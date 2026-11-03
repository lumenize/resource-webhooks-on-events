// What the first flavor left behind stays behind: no carried or root file names a file, script or
// route this flavor dropped. SCAN_ROOT points the scan at another tree, which is how it was shown
// to find each name in the first flavor's, `../resource-webhooks-standalone`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const ROOT = process.env.SCAN_ROOT ?? join(import.meta.dirname, '../..');
const THIS_FILE = 'test/harness/left-behind.test.ts';
const ROOT_FILES = ['package.json', 'package-lock.json', 'wrangler.jsonc', 'wrangler.conformance.jsonc', 'vitest.config.ts', 'tsconfig.json', 'worker-configuration.d.ts', '.nvmrc', '.dev.vars.example', '.gitignore', 'conformance-baseline.yml'];

// Each name as code refers to it, so prose that mentions one in passing does not count.
const LEFT_BEHIND: Record<string, RegExp> = {
  'notes-http': /notes-http/,
  targets: /\/targets(\.[jt]s)?['"]/,
  'tool-types': /tool-types/,
  'resource-webhooks-types': /resource-webhooks-types/,
  'src/page': /src\/page|\.\/page\/page|\/js\/page/,
  'tsconfig.page': /tsconfig\.page/,
  'build:page': /build:page/,
  './public': /\.\/public|"directory": "public"|public\/js/,
  playwright: /["']playwright["']|node_modules\/playwright/,
  'the notes and lists routes': /\(notes\|lists\)|\/notes\/inbox|\/lists\/list-/,
};

function filesUnder(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, directory));
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(join(ROOT, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

function scanned(): string[] {
  const ours = ['src', 'scripts', 'test'].flatMap(filesUnder).filter((path) => !path.startsWith('src/vendor/') && path !== THIS_FILE);
  return [...ours, ...ROOT_FILES.filter((file) => statSync(join(ROOT, file), { throwIfNoEntry: false }))];
}

it('finds no left-behind name in any carried or root file', () => {
  const files = scanned();
  expect(files).toEqual(expect.arrayContaining(['src/server.ts', 'src/edge.ts', 'package.json', 'wrangler.jsonc']));
  const found = Object.entries(LEFT_BEHIND).flatMap(([name, pattern]) =>
    files.filter((file) => pattern.test(readFileSync(join(ROOT, file), 'utf-8'))).map((file) => `${relative(ROOT, join(ROOT, file))} names ${name}`),
  );
  expect(found).toEqual([]);
});
