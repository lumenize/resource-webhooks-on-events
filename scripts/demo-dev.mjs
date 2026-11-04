// `npm run demo:dev`: the demo page under `wrangler dev`, over https at https://localhost:8443, as
// the deployed Worker serves it. Vite rebuilds the page into dist/demo on each change, and wrangler
// serves it from there. A fetches its own origin twice, for the clients' metadata document and for
// each webhook POST to B, and both go over TLS with a certificate from mkcert's local CA. The CA
// lives in the gitignored .certs/ and is never installed in the system's trust store: workerd
// trusts it through NODE_EXTRA_CA_CERTS, and a browser has to be told to accept the certificate.
// The secrets are .demo-dev.vars', made on the first run, and kept out of .dev.vars, which
// wrangler would also load into the tests' lanes.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PORT = 8443;
const ORIGIN = `https://localhost:${PORT}`;
const CERTS = join(ROOT, '.certs');
const CA = join(CERTS, 'ca');
const CERT = join(CERTS, 'localhost.pem');
const KEY = join(CERTS, 'localhost-key.pem');
const SECRETS = join(ROOT, '.demo-dev.vars');
const bin = (name) => join(ROOT, 'node_modules/.bin', name);

if (!(existsSync(CERT) && existsSync(KEY) && existsSync(join(CA, 'rootCA.pem')))) {
  mkdirSync(CA, { recursive: true });
  try {
    execFileSync('mkcert', ['-cert-file', CERT, '-key-file', KEY, 'localhost', '127.0.0.1'], { env: { ...process.env, CAROOT: CA }, stdio: 'pipe' });
  } catch (error) {
    console.error(`The demo needs mkcert for its certificate (brew install mkcert): ${error}`);
    process.exit(1);
  }
}

if (!existsSync(SECRETS)) {
  const secret = () => randomBytes(32).toString('base64url');
  writeFileSync(SECRETS, `TOKEN_SIGNING_KEY=${secret()}\nSUBSCRIPTION_ID_KEY=${secret()}\nOPERATOR_TOKEN=${secret()}\n`, { mode: 0o600 });
  console.log('Made .demo-dev.vars, whose OPERATOR_TOKEN the page asks for.');
}

execFileSync(bin('vite'), ['build', '--config', 'demo/vite.config.ts', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
const children = [
  spawn(bin('vite'), ['build', '--watch', '--config', 'demo/vite.config.ts', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' }),
  spawn(
    bin('wrangler'),
    ['dev', '--port', String(PORT), '--local-protocol', 'https', '--https-key-path', KEY, '--https-cert-path', CERT, '--env-file', SECRETS, '--var', `ORIGIN:${ORIGIN}`],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: join(CA, 'rootCA.pem') } },
  ),
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => code && stop());
console.log(`The demo is at ${ORIGIN}`);
