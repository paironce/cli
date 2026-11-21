import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** CLI 0.12.0: status and cancel while a call waits for the user, the client's own cancel, and fields in every result. */
const links = vi.hoisted(() => ({ current: undefined as any, connects: [] as any[] }));
vi.mock("./connection", () => ({ connect: async (...args: any[]) => { links.connects.push(args); return links.current; } }));

const PHONE = { id: "pppppppppppppppp", name: "Phone", publicKey: "k".repeat(87) };
/** A phone that shows a request and, unless told otherwise, never answers it. */
const phone = (answer?: (link: any, id: string) => void): any => {
  const link: any = {
    session: { peerTakesRequests: () => true, peerTakesWatch: () => true, acceptFile: vi.fn(async () => {}), rejectFile: vi.fn(async () => {}),
      confirmFileSaved: vi.fn(async () => {}), withdrawRequest: vi.fn(async () => {}), sendText: vi.fn(async () => {}), drained: vi.fn(async () => {}),
      usesTunnel: () => false,
      askFor: vi.fn(async () => { setTimeout(() => answer?.(link, "req-1"), 20); return "req-1"; }) },
    peer: { ...PHONE, pairedAt: 1, lastSeenAt: 1 }, path: "direct", events: {} as any, close: vi.fn(), isOpen: () => true,
  };
  return link;
};
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({ jsonrpc: "2.0" as const, id, method: "tools/call", params: { name, arguments: args } });

beforeEach(async () => {
  (await import("./mcp")).closeKeptLink();
  process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
  process.chdir(mkdtempSync(path.join(tmpdir(), "paironce-work-")));
  const { saveDevice } = await import("./store");
  await saveDevice(PHONE);
  links.connects.length = 0;
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("status and cancel while a call waits for the user", () => {
  it("say what waits, and cancel withdraws the request on the phone", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { answer, callTool } = await import("./mcp");
    const link = phone();
    links.current = link;
    expect(await callTool("status", {})).toContain("Nothing is running.");
    const stop = new AbortController();
    const running = answer(call(1, "request_photo", { purpose: "The label on the router", wait_seconds: 60 }), stop) as Promise<any>;
    await pause(700);
    const status = await callTool("status", {}) as string;
    expect(status).toContain("request_photo has run for");
    expect(status).toContain("waiting for the user on Phone to answer the photo request");
    expect(status).toMatch(/It waits \d+ s more/);
    expect(await callTool("cancel", {})).toContain("Cancelled request_photo on Phone");
    const result = await running;
    expect(result.result.structuredContent).toMatchObject({ status: "cancelled", device: "Phone", retry: true });
    expect(link.session.withdrawRequest).toHaveBeenCalledWith("req-1");
    expect(await callTool("status", {})).toContain("Nothing is running.");
    expect(await callTool("cancel", {})).toBe("Nothing is running.");
  });
});

describe("the client's own cancel (notifications/cancelled)", () => {
  let input: PassThrough;
  const writes: string[] = [];
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
  beforeEach(() => {
    input = new PassThrough();
    Object.defineProperty(process, "stdin", { value: input, configurable: true });
    writes.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { writes.push(String(chunk)); return true; });
  });
  afterEach(() => { Object.defineProperty(process, "stdin", stdin); });
  const reply = (id: number) => writes.map(line => JSON.parse(line)).find(message => message.id === id);
  const waitFor = async (id: number) => { for (let tries = 0; tries < 100 && !reply(id); tries++) await pause(50); return reply(id); };

  it("answers status at once, stops the call with no answer for it, and lets the next call start", async () => {
    const { runMcp } = await import("./mcp");
    const link = phone();
    links.current = link;
    const done = runMcp();
    input.write(`${JSON.stringify(call(1, "request_photo", { purpose: "A photo of the label", wait_seconds: 60 }))}\n`);
    await pause(400);
    input.write(`${JSON.stringify(call(2, "status"))}\n`);
    expect((await waitFor(2)).result.content[0].text).toContain("request_photo has run for");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1, reason: "The user pressed Esc" } })}\n`);
    input.write(`${JSON.stringify(call(3, "send_text", { text: "hello" }))}\n`);
    const sent = await waitFor(3);
    expect(sent.result.content[0].text).toContain("Sent to Phone");
    expect(sent.result.structuredContent).toMatchObject({ status: "sent", device: "Phone", device_id: PHONE.id });
    expect(link.session.withdrawRequest).toHaveBeenCalledWith("req-1");
    expect(reply(1)).toBeUndefined();
    input.end();
    expect(await done).toBe(0);
  }, 20000);

  it("never starts a call the client cancelled while it waited its turn", async () => {
    const { runMcp } = await import("./mcp");
    const link = phone();
    links.current = link;
    const done = runMcp();
    input.write(`${JSON.stringify(call(1, "request_photo", { purpose: "A photo of the label", wait_seconds: 60 }))}\n`);
    input.write(`${JSON.stringify(call(2, "send_text", { text: "queued" }))}\n`);
    await pause(300);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`);
    input.write(`${JSON.stringify(call(3, "cancel"))}\n`);
    expect((await waitFor(3)).result.content[0].text).toContain("Cancelled request_photo");
    expect((await waitFor(1)).result.structuredContent).toMatchObject({ status: "cancelled" });
    await pause(300);
    expect(link.session.sendText).not.toHaveBeenCalled();
    expect(reply(2)).toBeUndefined();
    input.end();
    await done;
  }, 20000);
});

describe("fields in the result", () => {
  it("tell a declined request from one the user answered", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { answer } = await import("./mcp");
    links.current = phone((link, id) => link.events.requestAnswer?.({ id, decision: "decline" }));
    const declined = await answer(call(1, "request_photo", { purpose: "The label", wait_seconds: 30 }), new AbortController()) as any;
    expect(declined.result.structuredContent).toMatchObject({ status: "declined", device: "Phone", files: [], retry: false });
    expect(declined.result.content[0].text).toContain("Phone declined the request.");
  });

  it("list the devices with their ids", async () => {
    const { answer } = await import("./mcp");
    const listed = await answer(call(1, "list_devices")) as any;
    expect(listed.result.structuredContent.devices).toEqual([expect.objectContaining({ id: PHONE.id, name: "Phone" })]);
  });
});
