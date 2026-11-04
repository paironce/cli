/**
 * paironce: send files and text from a terminal to your own devices through PairOnce (https://paironce.com).
 *
 *   paironce pair                 show a code to type on the other device (or: paironce pair 123456)
 *   paironce send <file>...       send files to a paired device (--to <name>)
 *   paironce text "<message>"     send a message or a link
 *   paironce receive              receive files into this folder (--to <folder>, --yes to accept without asking)
 *   paironce devices              list paired devices; paironce forget <name> removes one
 *   paironce mcp                  run as an MCP server, so an AI agent can send to your devices
 */
import "./env";
import { createInterface } from "node:readline/promises";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect, type ConnectUi, type Link, type Target } from "./connection";
import { createDiskReceiver, partPath } from "./disk";
import { forgetDevice, listDevices, loadOrCreateIdentity, pickDevice } from "./store";
import { runMcp } from "./mcp";
import { CLI_VERSION } from "./version";
import type { DeviceIdentity } from "../../../apps/app/src/identity";

import { human, say, sendPath } from "./send";

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--") { rest.push(...argv.slice(index + 1)); break; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) { rest.push(arg); continue; }
    if (match[2] !== undefined) flags[match[1]!] = match[2];
    else if (["to", "from"].includes(match[1]!) && argv[index + 1] && !argv[index + 1]!.startsWith("--")) flags[match[1]!] = argv[++index]!;
    else flags[match[1]!] = true;
  }
  return { flags, rest };
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const line = createInterface({ input: process.stdin, output: process.stderr });
  try { return /^y(es)?$/i.test((await line.question(`${question} [y/N] `)).trim()); } finally { line.close(); }
}

/** Grouped as the web app shows it (CodeCells.tsx codeGroups): 3+3 for a code, fours for a safety code. */
const groups = (code: string) => (code.length > 6 ? code.match(/.{1,4}/g) ?? [code] : [code.slice(0, 3), code.slice(3)]).join(" ");

/** The terminal's side of connecting: codes and the safety code on screen, approval asked here. */
export const terminalUi: ConnectUi = {
  code: code => say(`\nOn your other device, open https://paironce.com, choose "Enter a code" and type:\n\n    ${code.slice(0, 3)} ${code.slice(3)}\n`),
  safetyCode: code => say(`Safety code: ${groups(code)}  (the other screen must show the same)`),
  approve: peer => ask(`Connect "${peer.name}"? Check that both screens show the same safety code.`),
};

/** A saved device when there is one (named with --to or --from), else a new pairing with a code. */
async function open(identity: DeviceIdentity, name: string | undefined, folder?: string): Promise<Link> {
  const devices = await listDevices();
  const picked = pickDevice(devices, name);
  if (picked === "ambiguous") throw new Error(`Which device? Use --to with one of: ${devices.map(device => `"${device.name}"`).join(", ")}`);
  if (picked === "none" && name) throw new Error(`No paired device is called "${name}". Run "paironce devices" to see them.`);
  const target: Target = picked === "none" ? { kind: "host" } : { kind: "saved", device: picked };
  if (target.kind === "saved") say(`Connecting to ${target.device.name}… Open https://paironce.com there and tap Connect next to "${identity.name}".`);
  const diskReceive = folder ? createDiskReceiver(folder) : undefined;
  const link = await connect(identity, target, terminalUi, { diskReceive, signal: AbortSignal.timeout(target.kind === "saved" ? 180_000 : 600_000) });
  say(`Connected to ${link.peer.name} (${link.path === "turn" ? "through the encrypted relay" : "direct"}).`);
  return link;
}

async function uniquePath(folder: string, name: string): Promise<string> {
  const safe = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_") || "file";
  const { name: stem, ext } = path.parse(safe);
  for (let index = 0; ; index++) {
    const candidate = path.join(folder, index ? `${stem} (${index})${ext}` : safe);
    try { await stat(candidate); } catch { return candidate; }
  }
}

async function receive(link: Link, folder: string, acceptAll: boolean): Promise<void> {
  await mkdir(folder, { recursive: true });
  say(`Receiving into ${folder}. Press Ctrl+C to stop.`);
  link.events.offer = offer => {
    void (async () => {
      const yes = acceptAll || await ask(`${link.peer.name} sends ${offer.name} (${human(offer.size)}). Accept?`);
      await (yes ? link.session.acceptFile(offer.transferId) : link.session.rejectFile(offer.transferId));
    })().catch(error => say(String(error instanceof Error ? error.message : error)));
  };
  link.events.file = file => {
    void (async () => {
      const target = await uniquePath(folder, file.name);
      if (file.onDisk) await rename(partPath(folder, file.diskEntry ?? file.transferId), target);
      else await writeFile(target, new Uint8Array(await (file.blob ?? await (await fetch(file.url)).blob()).arrayBuffer()));
      URL.revokeObjectURL(file.url);
      await link.session.confirmFileSaved(file.transferId).catch(() => {});
      say(`Saved ${target}`);
    })().catch(error => say(`Could not save ${file.name}: ${error instanceof Error ? error.message : error}`));
  };
  link.events.text = text => process.stdout.write(`${text}\n`);
  await new Promise<void>(resolve => { link.events.closed = resolve; process.once("SIGINT", () => resolve()); });
}

const HELP = `paironce ${CLI_VERSION}: send files and text from this terminal to your own devices (https://paironce.com).

  paironce pair                  show a code to type on the other device
  paironce pair 123456           type the code the other device shows
  paironce send <file>...        send files (--to <device name> when several are paired)
  paironce text "<message>"      send a message or a link
  paironce receive               receive into this folder (--to <folder>, --yes accepts without asking)
  paironce devices               list paired devices
  paironce forget <name>         forget a paired device
  paironce mcp                   run as an MCP server for AI agents (send_file, send_text, list_devices)

Files are end-to-end encrypted and go directly between the devices, or through an encrypted relay when a network
blocks direct connections. The other device accepts every file before it arrives. This device is kept in ~/.paironce.`;

async function main(argv: string[]): Promise<number> {
  const { flags, rest } = parse(argv);
  const [command, ...args] = rest;
  if (flags.version) { process.stdout.write(`${CLI_VERSION}\n`); return 0; }
  if (!command || flags.help || command === "help") { process.stdout.write(`${HELP}\n`); return command || flags.help ? 0 : 1; }
  if (command === "mcp") return runMcp();
  const identity = await loadOrCreateIdentity();
  if (command === "devices") {
    const devices = await listDevices();
    if (!devices.length) say(`No paired devices yet. Run "paironce pair".`);
    for (const device of devices) process.stdout.write(`${device.name}\tlast seen ${new Date(device.lastSeenAt).toLocaleString()}\n`);
    return 0;
  }
  if (command === "forget") {
    const picked = pickDevice(await listDevices(), args.join(" ") || undefined);
    if (typeof picked === "string") { say(picked === "none" ? "No such device." : "Several devices match; name it more exactly."); return 1; }
    await forgetDevice(picked.id);
    say(`Forgot ${picked.name}. Remove "${identity.name}" on that device too.`);
    return 0;
  }
  if (command === "pair") {
    const code = args.join("").replace(/\s/g, "");
    if (code && !/^\d{6}$/.test(code)) { say("The code has six digits."); return 1; }
    const link = await connect(identity, code ? { kind: "join", code } : { kind: "host" }, terminalUi, { signal: AbortSignal.timeout(600_000) });
    say(`Paired with ${link.peer.name}. Next time, "paironce send <file>" connects without a code.`);
    link.close();
    return 0;
  }
  if (command === "send") {
    if (!args.length) { say("Name the files to send: paironce send report.pdf photo.jpg"); return 1; }
    const link = await open(identity, typeof flags.to === "string" ? flags.to : undefined);
    try { for (const file of args) await sendPath(link, file); } finally { link.close(); }
    return 0;
  }
  if (command === "text") {
    const text = args.join(" ");
    if (!text) { say('Write the message: paironce text "https://example.com"'); return 1; }
    const link = await open(identity, typeof flags.to === "string" ? flags.to : undefined);
    try { await link.session.sendText(text); say(`Sent to ${link.peer.name}.`); } finally { link.close(); }
    return 0;
  }
  if (command === "receive") {
    const folder = path.resolve(typeof flags.to === "string" ? flags.to : ".");
    const link = await open(identity, typeof flags.from === "string" ? flags.from : undefined, folder);
    try { await receive(link, folder, flags.yes === true); } finally { link.close(); }
    return 0;
  }
  say(`Unknown command "${command}". Run "paironce help".`);
  return 1;
}

main(process.argv.slice(2)).then(code => process.exit(code), error => {
  say(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
