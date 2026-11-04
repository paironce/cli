/**
 * `paironce mcp`: a Model Context Protocol server on stdin/stdout (JSON-RPC 2.0, one message per line), so an AI agent
 * (Claude Code, Cursor, …) can send files and text to the devices this terminal paired with. Three tools: send_file,
 * send_text, list_devices. Only saved devices: pairing a new one needs a person at the terminal (`paironce pair`), and the
 * receiving device still accepts every file itself, so an agent can never put anything on a device unasked.
 */
import { createInterface } from "node:readline";
import path from "node:path";
import { connect, type Link } from "./connection";
import { listDevices, loadOrCreateIdentity, pickDevice } from "./store";
import { sendPath } from "./send";
import { CLI_VERSION } from "./version";

const log = (text: string) => process.stderr.write(`${text}\n`);
const target = { type: "string", description: "Name of a paired device (from list_devices). Optional when only one is paired." };
export const TOOLS = [
  { name: "list_devices", description: "List the devices this computer is paired with through PairOnce.", inputSchema: { type: "object", properties: {} } },
  { name: "send_file", description: "Send files from this computer to one of the user's paired devices (phone or computer) through PairOnce, end-to-end encrypted. The user accepts each file on that device, and PairOnce must be open there.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Files to send (absolute paths, or relative to the server's folder)." }, device: target }, required: ["paths"] } },
  { name: "send_text", description: "Send a message or a link to one of the user's paired devices through PairOnce, end-to-end encrypted. PairOnce must be open there.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, device: target }, required: ["text"] } },
];

async function openSaved(device?: string): Promise<Link> {
  const identity = await loadOrCreateIdentity();
  const devices = await listDevices();
  const picked = pickDevice(devices, device);
  if (picked === "none") throw new Error(devices.length ? `No paired device is called "${device}".` : "No device is paired yet. Run \"npx paironce pair\" in a terminal first.");
  if (picked === "ambiguous") throw new Error(`Name the device: ${devices.map(item => item.name).join(", ")}.`);
  log(`Connecting to ${picked.name}; open https://paironce.com there.`);
  return connect(identity, { kind: "saved", device: picked }, { status: log }, { signal: AbortSignal.timeout(120_000) });
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "list_devices") {
    const devices = await listDevices();
    return devices.length ? devices.map(device => `${device.name} (last seen ${new Date(device.lastSeenAt).toISOString()})`).join("\n") : "No paired devices. Run \"npx paironce pair\" in a terminal.";
  }
  const device = typeof args.device === "string" && args.device ? args.device : undefined;
  if (name === "send_text") {
    if (typeof args.text !== "string" || !args.text) throw new Error("text is required.");
    const link = await openSaved(device);
    try { await link.session.sendText(args.text); await link.session.drained(); return `Sent to ${link.peer.name}.`; } finally { link.close(); }
  }
  if (name === "send_file") {
    const paths = Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === "string") : [];
    if (!paths.length) throw new Error("paths is required.");
    const link = await openSaved(device);
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
        capabilities: { tools: {} }, serverInfo: { name: "paironce", version: CLI_VERSION } });
    case "ping": return reply({});
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
