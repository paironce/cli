/**
 * `paironce mcp`: a Model Context Protocol server on stdin/stdout (JSON-RPC 2.0, one message per line), so an AI agent
 * (Claude Code, Cursor, …) can work with the person's own devices. Five tools:
 *
 * - pair_device: join with the six-digit code the person's device shows; the person approves on that device after
 *   comparing the safety code (sent to the client as a log message too).
 * - send_file, send_text: to a paired device; the device accepts every file itself.
 * - receive_files: wait for the person to send files from a paired device; they land in a folder (default ./inbox).
 * - list_devices.
 *
 * The agent never reaches a device the person did not pair and approve, and nothing arrives anywhere unasked. Set
 * PAIRONCE_NAME (e.g. "Claude Code · Agent") so the device shows which agent this is.
 */
import { createInterface } from "node:readline";
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
];

async function openSaved(device: string | undefined, seconds: number, folder?: string): Promise<Link> {
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

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
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
  if (name === "receive_files") return receiveFiles(args, device);
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
        const text = await callTool(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: "text", text }] });
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
  return new Promise(resolve => lines.on("close", () => { void queue.then(() => resolve(0)); }));
}
