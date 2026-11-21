import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** CLI 0.11.6, after the 11-20 review of the agent tools. */
const links = vi.hoisted(() => ({ current: undefined as any, connects: [] as any[] }));
vi.mock("./connection", () => ({ connect: async (...args: any[]) => { links.connects.push(args); return links.current; } }));

const PHONE_A = { id: "aaaaaaaaaaaaaaaa", name: "iPhone · Safari", publicKey: "k".repeat(87) };
const PHONE_B = { id: "bbbbbbbbbbbbbbbb", name: "iPhone · Safari", publicKey: "j".repeat(87) };
const fakeLink = (peer: { id: string; name: string }, session: Record<string, unknown>): any => ({
  session: { peerTakesRequests: () => true, peerTakesWatch: () => true, ...session },
  peer: { ...peer, publicKey: "k".repeat(87), pairedAt: 1, lastSeenAt: 1 }, path: "direct", events: {} as any, close: vi.fn(), isOpen: () => true,
});

let cwd: string;
beforeEach(async () => {
  (await import("./mcp")).closeKeptLink();
  process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
  cwd = mkdtempSync(path.join(tmpdir(), "paironce-work-"));
  process.chdir(cwd);
  links.connects.length = 0;
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("two devices with the same name", () => {
  beforeEach(async () => {
    const { saveDevice } = await import("./store");
    await saveDevice(PHONE_A);
    await saveDevice(PHONE_B);
  });

  it("lists each with its id", async () => {
    const { callTool } = await import("./mcp");
    const list = await callTool("list_devices", {}) as string;
    expect(list).toContain(`iPhone · Safari (id ${PHONE_A.id}`);
    expect(list).toContain(`iPhone · Safari (id ${PHONE_B.id}`);
  });

  it("asks which one by id, and sends only to the one picked by id", async () => {
    const { callTool } = await import("./mcp");
    const asked = await callTool("send_text", { text: "hi", device: "iPhone · Safari" }).then(() => "", (error: Error) => error.message);
    expect(asked).toContain("Which device? Pass its id as device:");
    expect(asked).toContain(`"iPhone · Safari" (id ${PHONE_A.id})`);
    expect(asked).toContain(`"iPhone · Safari" (id ${PHONE_B.id})`);
    expect(links.connects).toHaveLength(0);
    links.current = fakeLink(PHONE_B, { sendText: vi.fn(async () => {}), drained: vi.fn(async () => {}) });
    expect(await callTool("send_text", { text: "hi", device: PHONE_B.id })).toContain("Sent to iPhone · Safari");
    expect(links.connects).toHaveLength(1);
    expect(links.connects[0][1].device.id).toBe(PHONE_B.id);
  });
});

describe("what send_file says", () => {
  beforeEach(async () => {
    const { saveDevice } = await import("./store");
    await saveDevice(PHONE_A);
  });

  it("reports delivery only once the device confirmed it, with no extra wait after the receipt", async () => {
    const { callTool } = await import("./mcp");
    writeFileSync(path.join(cwd, "report.pdf"), "pdf");
    // sendFile resolves on the receiver's encrypted receipt for this transfer; nothing else is awaited.
    links.current = fakeLink(PHONE_A, { sendFile: vi.fn(async () => {}) });
    const started = Date.now();
    const result = await callTool("send_file", { paths: ["report.pdf"] }) as string;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result).toContain("Delivered report.pdf to iPhone · Safari: it confirmed receipt.");
  });

  it("says a file may still arrive when the receipt is late, instead of a bare failure", async () => {
    const { callTool } = await import("./mcp");
    writeFileSync(path.join(cwd, "video.mp4"), "mp4");
    links.current = fakeLink(PHONE_A, { sendFile: vi.fn(async () => { throw new Error("The receiving browser did not confirm the file in time"); }) });
    await expect(callTool("send_file", { paths: ["video.mp4"] })).rejects.toThrow(/Sent all of video\.mp4, but iPhone · Safari has not confirmed it yet\. It may still arrive/);
  });

  it("passes other failures on as they are", async () => {
    const { callTool } = await import("./mcp");
    writeFileSync(path.join(cwd, "a.txt"), "a");
    links.current = fakeLink(PHONE_A, { sendFile: vi.fn(async () => { throw new Error("The receiving browser declined this file"); }) });
    await expect(callTool("send_file", { paths: ["a.txt"] })).rejects.toThrow("The receiving browser declined this file");
  });
});

describe("the registry entry", () => {
  it("names both directions and stays within the registry's 100 characters", async () => {
    const { readFileSync } = await import("node:fs");
    const server = JSON.parse(readFileSync(path.join(__dirname, "..", "server.json"), "utf8"));
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.description).toMatch(/photo, scan or file/);
  });
});
