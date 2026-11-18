// The full-stack review of 2026-11-18, CLI items (CLI 0.11.5): B07, B08, B15, B16, B20.
import { describe, expect, it, vi } from "vitest";
import { wrongOption } from "./options";
import { sendPath } from "./send";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("options (B20)", () => {
  it("refuses an option the command does not take", () => {
    expect(wrongOption("devices", { naem: "Wrong" })).toMatch(/no option --naem/);
    expect(wrongOption("send", { yes: true })).toMatch(/no option --yes/);
  });
  it("refuses a value option given no value, instead of falling back to the only device", () => {
    expect(wrongOption("send", { to: true })).toMatch(/--to needs a value/);
    expect(wrongOption("send", { to: "" })).toMatch(/--to needs a value/);
    expect(wrongOption("receive", { from: true })).toMatch(/--from needs a value/);
  });
  it("takes the options a command has, and those every command has", () => {
    expect(wrongOption("send", { to: "Pixel" })).toBeUndefined();
    expect(wrongOption("receive", { to: "./inbox", from: "Pixel", yes: true })).toBeUndefined();
    expect(wrongOption("mcp", { ephemeral: true, name: "Codex · Agent" })).toBeUndefined();
    expect(wrongOption("pair", { agent: true })).toBeUndefined();
  });
});

describe("sending several files on one connection (B16)", () => {
  it("leaves the receipt listener as it found it, file after file", async () => {
    const folder = mkdtempSync(path.join(tmpdir(), "po-send-"));
    const original = vi.fn();
    const events: { receipt?: (receipt: { stage: string }) => void; progress?: unknown } = { receipt: original };
    const session = { sendFile: vi.fn(async () => { events.receipt?.({ stage: "received" }); }) };
    const link = { events, session, peer: { name: "Phone" } } as never;
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      const file = path.join(folder, name);
      writeFileSync(file, name);
      await sendPath(link, file, () => {});
      expect(events.receipt).toBe(original);
    }
    expect(original).toHaveBeenCalledTimes(3);
  });
});

describe("ending receive while a file is still being written (B15)", () => {
  it("waits for the save, so the file is whole", async () => {
    const { receiveInto, savesSettled } = await import("./receive");
    const { readFileSync } = await import("node:fs");
    const folder = mkdtempSync(path.join(tmpdir(), "po-recv-"));
    const events: Record<string, unknown> = {};
    const link = { events, session: { confirmFileSaved: vi.fn(async () => {}), acceptFile: vi.fn(), rejectFile: vi.fn() }, peer: { name: "Phone" } } as never;
    await receiveInto(link, folder, { accept: async () => true });
    const bytes = new Uint8Array(1_000_000).fill(7);
    // A disk slower than the 50 ms the program used to wait.
    const blob = { arrayBuffer: () => new Promise<ArrayBuffer>(resolve => setTimeout(() => resolve(bytes.buffer), 200)) };
    (events.file as (file: unknown) => void)({ transferId: "t-1", name: "slow.bin", blob, url: "blob:nothing", onDisk: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    await savesSettled();
    expect(readFileSync(path.join(folder, "slow.bin")).length).toBe(1_000_000);
  });
});
