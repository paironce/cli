/**
 * `paironce mcp`: a Model Context Protocol server on stdin/stdout (JSON-RPC 2.0, one message per line), so an AI agent
 * (Claude Code, Cursor, …) can work with the person's own devices. Ten tools:
 *
 * - pair_device: join with the six-digit code the person's device shows; the person approves on that device after
 *   comparing the safety code (sent to the client as a log message too).
 * - send_file, send_text: to a paired device; the device accepts every file itself.
 * - receive_files: wait for the person to send files from a paired device; they land in a folder (default ./inbox).
 * - request_photo, request_scan, request_file: ask for something specific, with the reason; the person's device shows the
 *   request and the person answers by taking a photo, scanning or choosing files, or declines. Never answered for them.
 * - watch_frames, watch_stop: ask to see the person's camera or screen; once they share it there, each call returns
 *   stills (images the agent can look at). The connection stays open between calls until either side stops, the person
 *   leaves, or WATCH.idle passes without a call.
 * - list_devices.
 *
 * The agent never reaches a device the person did not pair and approve, and nothing arrives anywhere unasked. Set
 * PAIRONCE_NAME (e.g. "Claude Code · Agent") so the device shows which agent this is.
 */
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { connect, type Link } from "./connection";
import { createDiskReceiver } from "./disk";
import { receiveInto } from "./receive";
import { listDevices, loadOrCreateIdentity, pickDevice } from "./store";
import { pathName, sendPath } from "./send";
import { CLI_VERSION } from "./version";

const log = (text: string) => process.stderr.write(`${text}\n`);
/** A log message the client can show the person (MCP logging). */
const notify = (text: string) => {
  log(text);
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "notice", logger: "paironce", data: text } })}\n`);
};
const target = { type: "string", description: "Name of a paired device (from list_devices). Optional when only one is paired." };
/** How long receive_files waits by default and at most, and how long it waits after the last file before it returns. */
export const RECEIVE_WAIT = { default: 120, max: 600, quietAfterFile: 15 } as const;
/** Watching: stills per call, the gap between them (seconds), how long one still may take, and the idle close (ms). */
export const WATCH = { count: 5, interval: { default: 1, min: 0.5, max: 10 }, stillMs: 20_000, idle: 5 * 60_000 } as const;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export const TOOLS = [
  { name: "pair_device", description: "Pair one of the user's devices (phone or computer) with this agent through PairOnce. Ask the user to open https://paironce.com on that device and read out the six-digit code it shows, then call this with the code. The device asks the user to approve this agent after comparing a safety code. Needed once per device.",
    inputSchema: { type: "object", properties: { code: { type: "string", description: "The six-digit code shown on the user's device." } }, required: ["code"] } },
  { name: "list_devices", description: "List the devices this agent is paired with through PairOnce.", inputSchema: { type: "object", properties: {} } },
  { name: "send_file", description: "Send files from this computer to one of the user's paired devices through PairOnce, end-to-end encrypted. The user accepts each file on that device, and PairOnce must be open there.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Files to send (absolute paths, or relative to the server's folder)." }, device: target }, required: ["paths"] } },
  { name: "send_text", description: "Send a message or a link to one of the user's paired devices through PairOnce, end-to-end encrypted. PairOnce must be open there.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, device: target }, required: ["text"] } },
  { name: "receive_files", description: "Wait for the user to send files (photos, scans, documents) from one of their paired devices, and save them into a folder here. Tell the user to open https://paironce.com on that device, tap Connect, then choose the files. Returns the saved paths and any messages the user sent.",
    inputSchema: { type: "object", properties: { device: target,
      folder: { type: "string", description: "Where to save, relative to the server's folder. Default: inbox." },
      wait_seconds: { type: "number", description: `How long to wait for the user, ${RECEIVE_WAIT.default} by default, at most ${RECEIVE_WAIT.max}.` } } } },
  ...(["photo", "scan", "file"] as const).map(kind => ({
    name: `request_${kind}`,
    description: {
      photo: "Ask the user for a photo from one of their paired devices (usually their phone), for example of a label, a screen, an error message or a document. Their device shows your request with your reason; they take the photo there and it is saved here (default ./inbox). They may decline.",
      scan: "Ask the user to scan paper pages with one of their paired devices (usually their phone): it makes a PDF there with straightened pages, which is saved here (default ./inbox). Their device shows your request with your reason. They may decline.",
      file: "Ask the user for a file from one of their paired devices: their device shows your request with your reason, they choose the file there, and it is saved here (default ./inbox). They may decline.",
    }[kind],
    inputSchema: { type: "object", properties: {
      purpose: { type: "string", description: "What you need and why, in one or two sentences the user reads on their device (at most 300 characters)." },
      device: target,
      folder: { type: "string", description: "Where to save, relative to the server's folder. Default: inbox." },
      wait_seconds: { type: "number", description: `How long to wait for the user, ${RECEIVE_WAIT.default} by default, at most ${RECEIVE_WAIT.max}.` } },
      required: ["purpose"] },
  })),
  { name: "watch_frames", description: "See what the user sees: ask to watch their camera or screen on one of their paired devices, then get still pictures of it, returned as images you can look at (and saved, default ./inbox/watch). The first call asks; their device shows your reason and they share the camera or the screen there, or decline. Later calls return new stills from the same share, so you can guide them step by step (\"now turn the switch on the left\"). It ends when they stop, when you call watch_stop, or after 5 minutes without a call; their device ends it after 15 minutes.",
    inputSchema: { type: "object", properties: {
      purpose: { type: "string", description: "Needed when not watching yet: what you want to see and why, in one or two sentences the user reads on their device (at most 300 characters)." },
      count: { type: "number", description: `Stills to take now, 1 to ${WATCH.count}. Default 1.` },
      interval_seconds: { type: "number", description: `Seconds between those stills, ${WATCH.interval.min} to ${WATCH.interval.max}. Default ${WATCH.interval.default}.` },
      device: target,
      folder: { type: "string", description: "Where to save the stills, relative to the server's folder. Default: inbox/watch." },
      wait_seconds: { type: "number", description: `When asking: how long to wait for the user to share, ${RECEIVE_WAIT.default} by default, at most ${RECEIVE_WAIT.max}.` } } } },
  { name: "watch_stop", description: "Stop watching the user's camera or screen (see watch_frames). Their device stops sharing.", inputSchema: { type: "object", properties: {} } },
];

/** The watch on now (watch_frames): its connection stays open between calls. */
let watch: { link: Link; id: string; folder: string; ended?: string; idle?: ReturnType<typeof setTimeout>; next?: (file: string | Error) => void } | undefined;

/** Why the last watch ended, told on the next watch_frames call that has no purpose to ask again. */
let lastWatchEnd: string | undefined;

function endWatch(reason: string): void {
  const current = watch;
  if (!current) return;
  watch = undefined;
  lastWatchEnd = reason;
  clearTimeout(current.idle);
  current.next?.(new Error(reason));
  void current.link.session.stopWatch(current.id).finally(() => current.link.close());
}

async function startWatch(args: Record<string, unknown>, device: string | undefined): Promise<string | undefined> {
  const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
  if (!purpose) throw new Error(`${lastWatchEnd ? `Not watching: ${lastWatchEnd} ` : ""}purpose is required to start watching: say what you want to see and why, in a sentence the user reads on their device.`);
  lastWatchEnd = undefined;
  const seconds = Math.min(RECEIVE_WAIT.max, Math.max(10, typeof args.wait_seconds === "number" ? args.wait_seconds : RECEIVE_WAIT.default));
  const folder = path.resolve(typeof args.folder === "string" && args.folder ? args.folder : path.join("inbox", "watch"));
  const link = await openSaved(device, seconds, folder);
  let answer: "decline" | "watch" | undefined;
  let closed = false;
  const stills = new Set<string>();
  const current: NonNullable<typeof watch> = { link, id: "", folder };
  try {
    if (!link.session.peerTakesWatch()) throw new Error(`${link.peer.name} cannot share its camera or screen with an agent yet: PairOnce there needs version 2.25 or later. Use request_photo instead.`);
    link.events.requestAnswer = reply => { if (reply.id === current.id) answer = reply.decision === "watch" ? "watch" : "decline"; };
    link.events.watchStillFile = (id, transferId) => { if (id === current.id) stills.add(transferId); };
    link.events.watchEnded = id => { if (id === current.id && watch === current) { current.ended = `${link.peer.name} stopped sharing.`; endWatch(current.ended); } };
    link.events.closed = () => { closed = true; if (watch === current) { current.ended = "The connection ended."; endWatch(current.ended); } };
    await receiveInto(link, folder, {
      // Only the stills this watch asked for.
      accept: async offer => stills.delete(offer.transferId),
      saved: file => { const next = current.next; current.next = undefined; next?.(file); },
      failed: (_name, message) => { const next = current.next; current.next = undefined; next?.(new Error(message)); },
    });
    current.id = await link.session.askFor("watch", purpose);
    notify(`Asked ${link.peer.name} to see the camera or the screen: "${purpose}". Waiting for the user there.`);
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline && !closed && !answer) await new Promise(resolve => setTimeout(resolve, 300));
    if (answer === "watch") { watch = current; return undefined; }
    if (!answer && !closed) await link.session.withdrawRequest(current.id);
  } catch (error) { link.close(); throw error; }
  link.close();
  return answer === "decline" ? `${link.peer.name} declined.` : closed ? "The connection ended before the user answered."
    : `No answer from ${link.peer.name} within ${seconds} seconds; the request was withdrawn.`;
}

/** One still from the watch on now, saved and read back. */
async function takeWatchStill(current: NonNullable<typeof watch>): Promise<{ file: string; data: string }> {
  const arrived = new Promise<string | Error>(resolve => { current.next = resolve; });
  await current.link.session.askStill(current.id);
  const file = await Promise.race([arrived, new Promise<Error>(resolve => setTimeout(() => resolve(new Error("No still arrived in time. The user's screen may be locked or PairOnce in the background.")), WATCH.stillMs))]);
  if (current.next) current.next = undefined;
  if (file instanceof Error) throw file;
  return { file, data: (await readFile(file)).toString("base64") };
}

async function watchFrames(args: Record<string, unknown>, device: string | undefined): Promise<string | Content[]> {
  if (watch && device && watch.link.peer.name !== device) endWatch("Watching another device.");
  let started = false;
  if (!watch) {
    const refused = await startWatch(args, device);
    if (refused) return refused;
    started = true;
  }
  const current = watch!;
  clearTimeout(current.idle);
  const count = Math.min(WATCH.count, Math.max(1, Math.round(typeof args.count === "number" ? args.count : 1)));
  const gap = Math.min(WATCH.interval.max, Math.max(WATCH.interval.min, typeof args.interval_seconds === "number" ? args.interval_seconds : WATCH.interval.default));
  const content: Content[] = [];
  const saved: string[] = [];
  let problem: string | undefined;
  for (let index = 0; index < count; index++) {
    if (index) await new Promise(resolve => setTimeout(resolve, gap * 1000));
    if (watch !== current) { problem = current.ended ?? "Watching ended."; break; }
    try {
      const still = await takeWatchStill(current);
      saved.push(still.file);
      content.push({ type: "image", data: still.data, mimeType: "image/jpeg" });
    } catch (error) { problem = error instanceof Error ? error.message : String(error); break; }
  }
  if (watch === current) current.idle = setTimeout(() => endWatch("No watch_frames call for 5 minutes."), WATCH.idle);
  const lines = [`${started ? `${current.link.peer.name} is sharing. ` : ""}${saved.length} still${saved.length === 1 ? "" : "s"} from ${current.link.peer.name}${saved.length ? `, saved as:\n${saved.join("\n")}` : "."}`];
  if (problem) lines.push(problem);
  lines.push(watch === current ? "Still watching: call watch_frames again for new stills, watch_stop when done." : "Not watching any more.");
  return [{ type: "text", text: lines.join("\n\n") }, ...content];
}

/**
 * Ask the connected device for a photo, a scan or a file, and take exactly the files its answer announces. Without an
 * answer in time the request is withdrawn, so the card does not stay on the person's device.
 */
async function requestFrom(kind: "photo" | "scan" | "file", args: Record<string, unknown>, device: string | undefined): Promise<string> {
  const purpose = typeof args.purpose === "string" ? args.purpose.trim() : "";
  if (!purpose) throw new Error("purpose is required: say what you need and why, in a sentence the user reads on their device.");
  const seconds = Math.min(RECEIVE_WAIT.max, Math.max(10, typeof args.wait_seconds === "number" ? args.wait_seconds : RECEIVE_WAIT.default));
  const folder = path.resolve(typeof args.folder === "string" && args.folder ? args.folder : "inbox");
  const deadline = Date.now() + seconds * 1000;
  const link = await openSaved(device, seconds, folder);
  const saved: string[] = []; const failures: string[] = [];
  let expected = 0; let announced = 0; let pending = 0; let declined = false;
  try {
    if (!link.session.peerTakesRequests()) throw new Error(`${link.peer.name} does not take requests yet: PairOnce there needs version 2.24 or later. Use receive_files and ask the user in the chat instead.`);
    link.events.requestAnswer = answer => {
      if (answer.decision === "decline") { declined = true; return; }
      expected += answer.count ?? 1; announced += answer.count ?? 1;
    };
    await receiveInto(link, folder, {
      // Only the files the answer announced: anything else the person sends now is declined, as it was not asked for.
      accept: async () => { if (expected < 1) return false; expected--; pending++; return true; },
      saved: file => { pending = Math.max(0, pending - 1); saved.push(file); notify(`Saved ${file}`); },
      failed: (name, message) => { pending = Math.max(0, pending - 1); failures.push(`${name}: ${message}`); },
    });
    const id = await link.session.askFor(kind, purpose);
    notify(`Asked ${link.peer.name} for ${kind === "file" ? "a file" : `a ${kind}`}: "${purpose}". Waiting for the user there.`);
    let closed = false;
    link.events.closed = () => { closed = true; };
    while (Date.now() < deadline && !closed && !declined && !(announced > 0 && saved.length + failures.length >= announced && !pending)) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!declined && !announced) await link.session.withdrawRequest(id);
  } finally { link.close(); }
  if (declined) return `${link.peer.name} declined the request.`;
  if (!announced) return `No answer from ${link.peer.name} within ${seconds} seconds; the request was withdrawn.`;
  const parts = [saved.length ? `Saved ${saved.length} file${saved.length === 1 ? "" : "s"} from ${link.peer.name}:\n${saved.join("\n")}`
    : `${link.peer.name} accepted, but no file arrived within ${seconds} seconds.`];
  if (failures.length) parts.push(`Not saved:\n${failures.join("\n")}`);
  return parts.join("\n\n");
}

async function openSaved(device: string | undefined, seconds: number, folder?: string): Promise<Link> {
  // A message or a file to the device being watched goes over the watch's own connection, which stays open.
  if (watch && !folder && (!device || device === watch.link.peer.name)) return { ...watch.link, close: () => {} };
  if (watch) endWatch(`Stopped watching ${watch.link.peer.name} for this.`);
  const identity = await loadOrCreateIdentity();
  const devices = await listDevices();
  const picked = pickDevice(devices, device);
  if (picked === "none") throw new Error(devices.length ? `No paired device is called "${device}".` : "No device is paired yet. Ask the user for the code paironce.com shows on their device, then call pair_device.");
  if (picked === "ambiguous") throw new Error(`Name the device: ${devices.map(item => item.name).join(", ")}.`);
  notify(`Connecting to ${picked.name}. On that device, open https://paironce.com: it shows "${identity.name} wants to reconnect"; tap Connect.`);
  return connect(identity, { kind: "saved", device: picked }, { status: log },
    { signal: AbortSignal.timeout(seconds * 1000), ...(folder ? { diskReceive: createDiskReceiver(folder) } : {}) });
}

async function receiveFiles(args: Record<string, unknown>, device: string | undefined): Promise<string> {
  const seconds = Math.min(RECEIVE_WAIT.max, Math.max(10, typeof args.wait_seconds === "number" ? args.wait_seconds : RECEIVE_WAIT.default));
  const folder = path.resolve(typeof args.folder === "string" && args.folder ? args.folder : "inbox");
  const deadline = Date.now() + seconds * 1000;
  const link = await openSaved(device, seconds, folder);
  const saved: string[] = []; const texts: string[] = []; const failures: string[] = [];
  let pending = 0; let lastActivity = Date.now();
  try {
    // The user chose these files on their own device and is sending them to this agent now: take them.
    await receiveInto(link, folder, {
      accept: async () => { pending++; lastActivity = Date.now(); return true; },
      saved: file => { pending = Math.max(0, pending - 1); saved.push(file); lastActivity = Date.now(); notify(`Saved ${file}`); },
      failed: (name, message) => { pending = Math.max(0, pending - 1); failures.push(`${name}: ${message}`); lastActivity = Date.now(); },
      text: text => { texts.push(text); lastActivity = Date.now(); },
    });
    notify(`Connected to ${link.peer.name} (${pathName(link)}). Waiting for files there (choose files to send) until ${new Date(deadline).toLocaleTimeString()}.`);
    let closed = false;
    link.events.closed = () => { closed = true; };
    while (Date.now() < deadline && !closed) {
      const quiet = (saved.length || texts.length || failures.length) && !pending && Date.now() - lastActivity > RECEIVE_WAIT.quietAfterFile * 1000;
      if (quiet) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally { link.close(); }
  const parts = [saved.length ? `Saved ${saved.length} file${saved.length === 1 ? "" : "s"} from ${link.peer.name}:\n${saved.join("\n")}` : `No files arrived from ${link.peer.name}.`];
  if (texts.length) parts.push(`Messages:\n${texts.join("\n")}`);
  if (failures.length) parts.push(`Not saved:\n${failures.join("\n")}`);
  return parts.join("\n\n");
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string | Content[]> {
  if (name === "list_devices") {
    const devices = await listDevices();
    return devices.length ? devices.map(device => `${device.name} (last seen ${new Date(device.lastSeenAt).toISOString()})`).join("\n") : "No paired devices. Ask the user for the code paironce.com shows on their device, then call pair_device.";
  }
  if (name === "pair_device") {
    const code = typeof args.code === "string" ? args.code.replace(/\s/g, "") : "";
    if (!/^\d{6}$/.test(code)) throw new Error("The code has six digits, as paironce.com shows it on the user's device.");
    const identity = await loadOrCreateIdentity();
    const link = await connect(identity, { kind: "join", code }, {
      status: log,
      safetyCode: sas => notify(`Safety code ${sas.match(/.{1,4}/g)?.join(" ") ?? sas}: the user's device shows the same code and asks to approve "${identity.name}".`),
    }, { signal: AbortSignal.timeout(300_000) });
    link.close();
    return `Paired with ${link.peer.name}. It now appears in list_devices; send_file, send_text and receive_files work with it.`;
  }
  const device = typeof args.device === "string" && args.device ? args.device : undefined;
  if (name === "watch_frames") return watchFrames(args, device);
  if (name === "watch_stop") {
    if (!watch) return "Not watching.";
    const peer = watch.link.peer.name;
    endWatch("Stopped.");
    return `Stopped watching ${peer}.`;
  }
  if (name === "receive_files") return receiveFiles(args, device);
  if (name === "request_photo" || name === "request_scan" || name === "request_file") return requestFrom(name.slice("request_".length) as "photo" | "scan" | "file", args, device);
  if (name === "send_text") {
    if (typeof args.text !== "string" || !args.text) throw new Error("text is required.");
    const link = await openSaved(device, 120);
    try { await link.session.sendText(args.text); await link.session.drained(); return `Sent to ${link.peer.name}.`; } finally { link.close(); }
  }
  if (name === "send_file") {
    const paths = Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === "string") : [];
    if (!paths.length) throw new Error("paths is required.");
    const link = await openSaved(device, 120);
    try {
      for (const file of paths) await sendPath(link, path.resolve(file), log);
      return `Sent ${paths.length === 1 ? path.basename(paths[0]!) : `${paths.length} files`} to ${link.peer.name}.`;
    } finally { link.close(); }
  }
  throw new Error(`Unknown tool ${name}.`);
}

type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

export async function answer(request: Request): Promise<object | undefined> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: request.id, result });
  if (request.id === undefined) return undefined; // A notification (notifications/initialized and the like).
  switch (request.method) {
    case "initialize":
      return reply({ protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {}, logging: {} }, serverInfo: { name: "paironce", version: CLI_VERSION } });
    case "ping": return reply({});
    case "logging/setLevel": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const params = request.params ?? {};
      try {
        const result = await callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: typeof result === "string" ? [{ type: "text", text: result }] : result });
      } catch (error) {
        return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default: return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}

export function runMcp(): Promise<number> {
  const lines = createInterface({ input: process.stdin });
  // One tool call at a time: each opens its own connection to a device.
  let queue = Promise.resolve();
  lines.on("line", line => {
    if (!line.trim()) return;
    let request: Request;
    try { request = JSON.parse(line) as Request; }
    catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`); return; }
    queue = queue.then(async () => {
      const response = await answer(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    });
  });
  return new Promise(resolve => lines.on("close", () => { void queue.then(() => { endWatch("The agent closed."); resolve(0); }); }));
}
