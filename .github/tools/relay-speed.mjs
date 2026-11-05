// Relay speed on paironce.com from a clean network: two Chrome pages on this machine, both forced onto the relay, one file within the free allowance.
import { chromium } from 'playwright';
const MIB = Number(process.env.SIZE_MIB ?? 40);
const browser = await chromium.launch({ channel: 'chrome' });
const open = async () => {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  await context.addInitScript(() => localStorage.setItem('paironce.forceRelay', '1'));
  const page = await context.newPage();
  await page.goto('https://paironce.com/');
  return page;
};
const result = {};
try {
  const a = await open(); const b = await open();
  await a.getByRole('button', { name: 'Copy invite link' }).click({ timeout: 40000 });
  const link = await a.evaluate(() => navigator.clipboard.readText());
  await b.goto(link);
  await a.getByRole('button', { name: /Approve/ }).first().click({ timeout: 60000 }).catch(e => { result.approve = e.message.split('\n')[0]; });
  await b.getByRole('button', { name: /Confirm|Approve/ }).first().click({ timeout: 5000 }).catch(() => {});
  await a.locator('input[type=file][aria-label="Choose files to send"]').waitFor({ state: 'attached', timeout: 60000 });
  await a.waitForTimeout(2000);
  result.status = (await a.locator('body').innerText()).match(/Encrypted[^\n]*/)?.[0];
  const start = Date.now();
  await a.evaluate(mib => {
    const chunk = new Uint8Array(1048576);
    for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, Math.min(i + 65536, chunk.length)));
    const dt = new DataTransfer();
    dt.items.add(new File(Array(mib).fill(chunk), 'speed.bin', { type: 'application/octet-stream' }));
    const input = document.querySelector('input[type=file][aria-label="Choose files to send"]');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  }, MIB);
  // The receiver takes it by hand: its Accept button.
  await b.getByRole('button', { name: /^Accept|^Save|Receive/ }).first().click({ timeout: 30000 }).catch(e => { result.accept = e.message.split('\n')[0]; });
  const samples = [];
  for (let i = 0; i < 60; i++) {
    await a.waitForTimeout(5000);
    const text = await a.locator('body').innerText();
    const line = text.match(/[^\n]*\/s[^\n]*/)?.[0];
    samples.push(line ?? 'none');
    if (!line && i > 1) break;
  }
  result.samples = samples.map(s => s.replace(/ · about.*| · a few.*/, ""));
  result.seconds = (Date.now() - start) / 1000;
  result.final = (await a.locator('body').innerText()).match(/speed\.bin[\s\S]{0,120}/)?.[0];
} catch (error) { result.error = error.message.split('\n')[0]; }
console.log(JSON.stringify(result, null, 1));
await browser.close();
process.exit(0);
