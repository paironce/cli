// How fast the CLI carries a file from this machine to itself through paironce.com, between two saved identities, one file within the free allowance.
import { spawn } from 'node:child_process';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
const run = `${tmpdir()}/cli-speed-${Date.now()}`;
const MIB = Number(process.env.SIZE_MIB ?? 100);
const b64 = bytes => Buffer.from(bytes).toString('base64url');
async function identity(home, name) {
  mkdirSync(home, { recursive: true });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const publicKey = b64(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)));
  const id = b64(randomBytes(12));
  writeFileSync(`${home}/identity.json`, JSON.stringify({ id, name, publicKey, privateKey: await webcrypto.subtle.exportKey('jwk', pair.privateKey), createdAt: Date.now() }));
  return { id, name, publicKey, pairedAt: Date.now(), lastSeenAt: Date.now() };
}
const homeA = `${run}/a`; const homeB = `${run}/b`; const inbox = `${run}/inbox`;
const a = await identity(homeA, 'Speed Sender'); const b = await identity(homeB, 'Speed Receiver');
writeFileSync(`${homeA}/devices.json`, JSON.stringify([b])); writeFileSync(`${homeB}/devices.json`, JSON.stringify([a]));
mkdirSync(inbox, { recursive: true });
const file = `${run}/big.bin`;
writeFileSync(file, Buffer.concat(Array.from({ length: MIB }, () => randomBytes(1024 * 1024))));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const start = (home, args) => {
  const child = spawn('paironce', args, { env: { ...process.env, PAIRONCE_HOME: home, PAIRONCE_DEBUG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', d => { child.log += d; });
  child.done = new Promise(resolve => child.on('exit', code => resolve(code)));
  return child;
};
const result = { sizeMiB: MIB, relayForced: process.env.PAIRONCE_FORCE_RELAY === '1' };
const receiver = start(homeB, ['receive', '--yes', '--to', inbox]);
await sleep(3000);
const sender = start(homeA, ['send', file]);
const t0 = Date.now();
const code = await Promise.race([sender.done, sleep(480_000).then(() => 'timeout')]);
result.exit = code;
const connected = /Connected to [^\n]*/.exec(sender.log)?.[0];
result.path = connected;
const startedAt = sender.log.indexOf('Sending');
result.seconds = Math.round((Date.now() - t0) / 1000);
await sleep(2000);
receiver.kill('SIGKILL');
const saved = readdirSync(inbox).filter(name => name === 'big.bin');
result.sameBytes = saved.length === 1 && sha(`${inbox}/big.bin`) === sha(file);
result.mibPerSecond = Number((MIB / Math.max(1, result.seconds)).toFixed(2));
if (!result.sameBytes) { result.sender = sender.log.slice(-700); result.receiver = receiver.log.slice(-400); result.startedAt = startedAt; result.left = readdirSync(inbox).map(n => [n, statSync(`${inbox}/${n}`).size]); }
console.log(JSON.stringify(result, null, 1));
process.exit(0);
