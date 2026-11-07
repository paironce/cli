// Relay speed by path on paironce.com: two Chrome pages on this machine, both on the relay, only the named relay addresses kept.
// One line of JSON per run: seconds from Accept to saved, and each second's bytes from the sender's WebRTC stats.
// Usage: PATHS=udp,tcp,tls SIZES=1,8 node tcp-speed.mjs   (A,B when the two ends differ: tcp:udp)
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + "/package.json");
const { chromium } = require('playwright');
const PATHS = (process.env.PATHS ?? 'udp,tcp,tls').split(',');
const SIZES = (process.env.SIZES ?? '1,8').split(',').map(Number);
const channel = undefined;

const PACE = Number(process.env.PACE ?? 0);
const init = ({ keep, pace }) => {
  // An experiment only: the app waits on bufferedAmount, so a debt added to it holds the sender to `pace` KiB per second.
  if (pace) {
    const proto = RTCDataChannel.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, 'bufferedAmount').get;
    const send = proto.send;
    let debt = 0; let at = performance.now();
    const settle = () => { const now = performance.now(); debt = Math.max(0, debt - (now - at) / 1000 * pace * 1024); at = now; };
    proto.send = function (data) { settle(); debt += data.byteLength ?? data.size ?? data.length ?? 0; return send.call(this, data); };
    Object.defineProperty(proto, 'bufferedAmount', { get() { settle(); return real.call(this) + debt; } });
  }
  localStorage.setItem('paironce.forceRelay', '1');
  const wanted = { none: () => false, udp: url => /^turn:.*transport=udp/.test(url), tcp: url => /^turn:.*transport=tcp/.test(url), tls: url => /^turns:/.test(url) }[keep];
  const Real = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Real {
    constructor(config, ...rest) {
      const iceServers = (config?.iceServers ?? []).map(server => ({ ...server, urls: [server.urls].flat().filter(wanted) })).filter(server => server.urls.length);
      super({ ...config, iceServers }, ...rest);
      window.__pcs.push(this);
    }
  };
};
const stats = page => page.evaluate(async () => {
  const pc = window.__pcs.filter(item => item.connectionState !== 'closed').pop();
  if (!pc) return {};
  const report = await pc.getStats();
  let pair; const all = {};
  report.forEach(item => { all[item.id] = item; if (item.type === 'transport' && item.selectedCandidatePairId) pair = report.get(item.selectedCandidatePairId); });
  if (!pair) report.forEach(item => { if (item.type === 'candidate-pair' && item.nominated) pair = item; });
  const local = pair && all[pair.localCandidateId];
  const channel = [...report.values()].find(item => item.type === 'data-channel' && item.label === 'paironce');
  return { rtt: pair?.currentRoundTripTime, sent: pair?.bytesSent, received: pair?.bytesReceived, type: local?.candidateType, relay: local?.relayProtocol, out: pair?.availableOutgoingBitrate, channelSent: channel?.bytesSent };
});

async function run(pathName, mib) {
  const [one, two] = pathName.split(':');
  const browser = await chromium.launch({ channel });
  const result = { path: pathName, mib, pace: PACE };
  try {
    const open = async keep => {
      const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
      await context.addInitScript(init, { keep, pace: PACE });
      const page = await context.newPage();
      await page.goto('https://paironce.com/');
      return page;
    };
    const a = await open(one); const b = await open(two ?? one);
    await a.getByRole('button', { name: 'Copy invite link' }).click({ timeout: 40000 });
    const link = await a.evaluate(() => navigator.clipboard.readText());
    await b.goto(link);
    const paired = Date.now();
    await b.locator('.link-ask').getByRole('button', { name: 'Connect', exact: true }).click({ timeout: 40000 });
    await a.getByRole('button', { name: 'Approve device', exact: true }).click({ timeout: 60000 });
    for (const page of [a, b]) await page.locator('.app[data-phase="connected"]').waitFor({ timeout: 120000 });
    result.connectSeconds = (Date.now() - paired) / 1000;
    await a.waitForTimeout(1500);
    for (const page of [a, b]) await page.getByRole('button', { name: 'No thanks', exact: true }).click({ timeout: 1500 }).catch(() => {});
    result.line = await b.locator('.ws-state').first().innerText().catch(() => null);
    await a.getByLabel('Choose files to send', { exact: true }).first().setInputFiles({ name: 'speed.bin', mimeType: 'application/octet-stream', buffer: randomBytes(mib * 1048576) });
    await b.getByRole('button', { name: 'Accept', exact: true }).click({ timeout: 30000 });
    const start = Date.now();
    const before = await stats(a);
    result.relay = before.relay; result.type = before.type;
    const series = [];
    let last = before.sent ?? 0;
    const limit = start + Number(process.env.LIMIT_SECONDS ?? 240) * 1000;
    let done = false;
    while (Date.now() < limit) {
      await a.waitForTimeout(500);
      const now = await stats(a);
      const received = await stats(b);
      series.push({ s: Math.round((Date.now() - start) / 1000), kib: Math.round(((now.sent ?? 0) - last) / 1024), rtt: now.rtt, inKib: received.received });
      last = now.sent ?? last;
      if (await b.locator('.received-item').filter({ hasText: 'speed.bin' }).count()) { done = true; break; }
    }
    result.seconds = (Date.now() - start) / 1000;
    result.done = done;
    result.rttEnd = series.at(-1)?.rtt;
    result.kibPerSecond = series.map(item => item.kib);
    result.rtts = series.filter((_, index) => index % 5 === 0).map(item => item.rtt);
    result.ratio = before.out;
  } catch (error) { result.error = error.message.split('\n')[0]; }
  await browser.close();
  console.log(JSON.stringify(result));
}

for (const size of SIZES) for (const name of PATHS) await run(name, size);
process.exit(0);
