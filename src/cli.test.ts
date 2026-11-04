import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanName, forgetDevice, listDevices, loadOrCreateIdentity, pickDevice, saveDevice, terminalName } from "./store";
import { answer, TOOLS } from "./mcp";

const device = (id: string, name: string, at = 1) => ({ id: id.padEnd(16, "x"), name, publicKey: "k".repeat(87), pairedAt: at, lastSeenAt: at });

describe("the terminal's device", () => {
  it("keeps one identity and refuses a known device with another key", async () => {
    process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
    const first = await loadOrCreateIdentity();
    const again = await loadOrCreateIdentity();
    expect(again.id).toBe(first.id);
    expect(again.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(first.name).toBe(terminalName());
    await saveDevice({ id: "phone".padEnd(16, "x"), name: "Mobile Android · Chrome", publicKey: "a".repeat(87) });
    await expect(saveDevice({ id: "phone".padEnd(16, "x"), name: "Mobile Android · Chrome", publicKey: "b".repeat(87) })).rejects.toThrow("different key");
    expect((await listDevices()).map(item => item.name)).toEqual(["Mobile Android · Chrome"]);
    expect(await forgetDevice("phone".padEnd(16, "x"))).toBe(true);
    expect(await listDevices()).toEqual([]);
  });

  it("takes the name PAIRONCE_NAME gives it and keeps its key", async () => {
    process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
    const first = await loadOrCreateIdentity();
    process.env.PAIRONCE_NAME = "Claude Code · Agent";
    try {
      const named = await loadOrCreateIdentity();
      expect(named.name).toBe("Claude Code · Agent");
      expect(named.publicKey).toBe(first.publicKey);
      delete process.env.PAIRONCE_NAME;
      expect((await loadOrCreateIdentity()).name).toBe("Claude Code · Agent");
    } finally { delete process.env.PAIRONCE_NAME; }
    expect(cleanName("  Build	bot  ")).toBe("Build bot");
    expect(() => cleanName(" ")).toThrow("1 to 80");
    expect(() => cleanName("x".repeat(81))).toThrow("1 to 80");
  });

  it("names its platform like a browser names itself", () => {
    expect(terminalName("win32")).toBe("Windows · Terminal");
    expect(terminalName("darwin")).toBe("macOS · Terminal");
  });

  it("picks a device by part of its name, or the only one", () => {
    const phone = device("a", "Mobile Android · Chrome"); const laptop = device("b", "macOS · Safari");
    expect(pickDevice([phone])).toBe(phone);
    expect(pickDevice([phone, laptop])).toBe("ambiguous");
    expect(pickDevice([phone, laptop], "android")).toBe(phone);
    expect(pickDevice([phone, laptop], "iphone")).toBe("none");
    expect(pickDevice([], undefined)).toBe("none");
  });
});

describe("the MCP server", () => {
  it("introduces itself, lists its ten tools and ignores notifications", async () => {
    const init = await answer({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) as { result: { serverInfo: { name: string }; capabilities: object } };
    expect(init.result.serverInfo.name).toBe("paironce");
    expect(init.result.capabilities).toEqual({ tools: {}, logging: {} });
    expect(await answer({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list = await answer({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: { tools: typeof TOOLS } };
    expect(list.result.tools.map(tool => tool.name)).toEqual(["pair_device", "list_devices", "send_file", "send_text", "receive_files", "request_photo", "request_scan", "request_file", "watch_frames", "watch_stop"]);
    const unknown = await answer({ jsonrpc: "2.0", id: 3, method: "resources/list" }) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });

  it("answers a tool call that cannot run with an error result, not a crash", async () => {
    process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
    const reply = await answer({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "send_text", arguments: { text: "hi" } } }) as { result: { isError: boolean; content: { text: string }[] } };
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0]!.text).toContain("pair_device");
    const bad = await answer({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pair_device", arguments: { code: "12ab" } } }) as { result: { isError: boolean; content: { text: string }[] } };
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]!.text).toContain("six digits");
  });

  it("asks for a reason before it watches, and stops nothing when nothing is watched", async () => {
    process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
    const silent = await answer({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "watch_frames", arguments: {} } }) as { result: { isError: boolean; content: { text: string }[] } };
    expect(silent.result.isError).toBe(true);
    expect(silent.result.content[0]!.text).toContain("purpose is required");
    const stop = await answer({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "watch_stop", arguments: {} } }) as { result: { content: { text: string }[] } };
    expect(stop.result.content[0]!.text).toBe("Not watching.");
  });
});
