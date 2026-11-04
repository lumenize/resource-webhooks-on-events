// `npm run demo:deploy`: deploys the demo Worker under wrangler.jsonc's own name, at the ORIGIN it
// names, with secrets of its own in the gitignored .demo.vars, made on the first deploy. It builds
// the page, checks the bundle as `npm run deployed` does, deploys, and waits until A and B run the
// new version, since a deploy reaches each Durable Object late. The operator token the page asks
// for is .demo.vars' OPERATOR_TOKEN, which this script never prints.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const SECRETS = '.demo.vars';
const POLL_MS = 5000;
const config = readFileSync('wrangler.jsonc', 'utf8');
const origin = /"ORIGIN":\s*"([^"]+)"/.exec(config)?.[1];
if (!origin) fail('wrangler.jsonc names no ORIGIN');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!existsSync(SECRETS)) {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync(SECRETS, `TOKEN_SIGNING_KEY=${secret()}\nSUBSCRIPTION_ID_KEY=${secret()}\nOPERATOR_TOKEN=${secret()}\n`, { mode: 0o600 });
  console.log(`Made ${SECRETS}, whose OPERATOR_TOKEN the page asks for.`);
}

run('npm', ['run', '--silent', 'build:demo']);
run('node', ['scripts/check-deploy-bundle.mjs', '--config', 'wrangler.jsonc']);
const deployed = spawnSync('node_modules/.bin/wrangler', ['deploy', '--secrets-file', SECRETS], { encoding: 'utf8' });
process.stdout.write(deployed.stdout ?? '');
process.stderr.write(deployed.stderr ?? '');
if (deployed.status !== 0) fail('wrangler deploy failed');
const version = /Current Version ID: ([0-9a-f-]+)/.exec(deployed.stdout ?? '')?.[1];
if (!version) fail('The deploy named no version');

// The version id a page socket's greeting names, or undefined if none comes within ten seconds.
function greeting(url) {
  return new Promise((done) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      done(undefined);
    }, 10_000);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.kind !== 'hello') return;
      clearTimeout(timer);
      socket.close();
      done(message.version);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      done(undefined);
    });
  });
}

const deadline = Date.now() + 10 * 60_000;
for (const path of ['/server/A/page', '/gateway/B/page']) {
  const url = `${origin.replace(/^http/, 'ws')}${path}`;
  for (let seen = await greeting(url); seen !== version; seen = await greeting(url)) {
    if (Date.now() > deadline) fail(`${path} still runs ${seen} rather than ${version}`);
    await new Promise((wait) => setTimeout(wait, POLL_MS));
  }
}
console.log(`The demo runs ${version} at ${origin}/`);
