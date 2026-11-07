// CLI 0.11.3. C02: a kept part belongs to whoever wins its note, for removing it as well as continuing it, so a process
// that found the same part cannot delete what another is writing or has kept again. C05: an accept that failed is not on its way.
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_PARTIALS, PARTIAL_KEEP_MS } from "../../../apps/app/src/realtime/disk-receive";
import { createDiskReceiver, partPath, removeOldParts } from "./disk";
import { receiveInto, stillArriving } from "./receive";
import type { Link } from "./connection";

const partial = (entry = "fixture-part", resumeKey = "resume-key-fixture-001") => ({ entry, peerId: "peer-device-000000001", resumeKey, name: "file.bin", mime: "application/octet-stream", size: 8, chunkSize: 4, totalChunks: 2, next: 1 });
const folders: string[] = [];
const fresh = () => { const folder = mkdtempSync(path.join(tmpdir(), "paironce-c02-")); folders.push(folder); return folder; };
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

async function kept(folder: string, item = partial()) {
  const seed = createDiskReceiver(folder);
  const sink = await seed.open(item.entry, item.name, item.mime);
  await sink.write(Uint8Array.of(1, 2, 3, 4));
  await seed.keepPartial(item, sink);
  await seed.settled();
  return item;
}
async function two(folder: string, item = partial()) {
  const a = createDiskReceiver(folder), b = createDiskReceiver(folder);
  await a.restore(); await b.restore();
  const fromA = a.findPartial(item.peerId, item.resumeKey)!, fromB = b.findPartial(item.peerId, item.resumeKey)!;
  a.takePartial(fromA); b.takePartial(fromB);
  return { a, b, fromA, fromB };
}

describe("a part two processes found (C02)", () => {
  it("is not deleted by the one that gave up before opening it", async () => {
    const folder = fresh();
    const item = await kept(folder);
    const { a, b, fromB } = await two(folder);
    const writer = await a.open(item.entry, item.name, item.mime, 4);
    await writer.write(Uint8Array.of(5, 6, 7, 8));
    await b.discardPartial(fromB);
    expect(existsSync(partPath(folder, item.entry))).toBe(true);
    expect(new Uint8Array(await (await writer.finish()).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  });

  it("is not deleted when the other one continued it and kept it again", async () => {
    const folder = fresh();
    const item = await kept(folder);
    const { a, b, fromB } = await two(folder);
    await new Promise(resolve => setTimeout(resolve, 5));
    const writer = await a.open(item.entry, item.name, item.mime, 4);
    await writer.write(Uint8Array.of(5, 6));
    await a.keepPartial({ ...item, next: 1 }, writer);
    await a.settled();
    await b.discardPartial(fromB);
    expect(statSync(partPath(folder, item.entry)).size).toBe(6);
    const note = partPath(folder, item.entry).replace(/\.part$/, ".json");
    expect(existsSync(note)).toBe(true);
  });

  it("cannot be continued by the one holding the older note", async () => {
    const folder = fresh();
    const item = await kept(folder);
    const second = createDiskReceiver(folder);
    await second.restore();
    const a = createDiskReceiver(folder);
    await a.restore();
    const stale = second.findPartial(item.peerId, item.resumeKey)!;
    second.takePartial(stale);
    a.takePartial(a.findPartial(item.peerId, item.resumeKey)!);
    await new Promise(resolve => setTimeout(resolve, 5));
    const writer = await a.open(item.entry, item.name, item.mime, 4);
    await a.keepPartial(item, writer);
    await a.settled();
    await expect(second.open(item.entry, item.name, item.mime, 4)).rejects.toThrow("disk_partial_taken");
    await second.discardPartial(stale);
    expect(existsSync(partPath(folder, item.entry))).toBe(true);
    expect(a.findPartial(item.peerId, item.resumeKey)).toBeDefined();
  });

  it("is deleted when this process has it", async () => {
    const folder = fresh();
    const item = await kept(folder);
    const only = createDiskReceiver(folder);
    await only.restore();
    const found = only.findPartial(item.peerId, item.resumeKey)!;
    only.takePartial(found);
    await only.discardPartial(found);
    expect(existsSync(partPath(folder, item.entry))).toBe(false);
    expect(existsSync(partPath(folder, item.entry).replace(/\.part$/, ".json"))).toBe(false);
  });

  it("is not deleted when this process trims its list and another has it", async () => {
    const folder = fresh();
    const item = await kept(folder);
    const { a } = await two(folder);
    const b = createDiskReceiver(folder);
    await b.restore();
    const writer = await a.open(item.entry, item.name, item.mime, 4);
    for (let number = 0; number < MAX_PARTIALS; number++) {
      const other = partial(`other-${number}`, `resume-key-other-${number}-0000`);
      const sink = await b.open(other.entry, other.name, other.mime);
      await b.keepPartial(other, sink);
    }
    await b.settled();
    expect(existsSync(partPath(folder, item.entry))).toBe(true);
    await writer.abort();
  });

  it("two at the same moment never both continue it", async () => {
    for (let round = 0; round < 40; round++) {
      const folder = fresh();
      const item = await kept(folder);
      const { a, b } = await two(folder);
      const results = await Promise.allSettled([a.open(item.entry, item.name, item.mime, 4), b.open(item.entry, item.name, item.mime, 4)]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "fulfilled") await result.value.park();
    }
  });

  it("an old lock left by a process that ended is tidied", async () => {
    const folder = fresh();
    const lock = partPath(folder, "gone").replace(/\.part$/, ".json.lock");
    writeFileSync(lock, "");
    const long = new Date(Date.now() - PARTIAL_KEEP_MS - 60_000);
    utimesSync(lock, long, long);
    await removeOldParts(folder);
    expect(existsSync(lock)).toBe(false);
  });

  it("the same process keeps and continues its own part", async () => {
    const folder = fresh();
    const item = partial();
    const one = createDiskReceiver(folder);
    const first = await one.open(item.entry, item.name, item.mime);
    await first.write(Uint8Array.of(1, 2, 3, 4));
    await one.keepPartial(item, first);
    await one.settled();
    const found = one.findPartial(item.peerId, item.resumeKey)!;
    one.takePartial(found);
    const again = await one.open(item.entry, item.name, item.mime, 4);
    await again.write(Uint8Array.of(5, 6, 7, 8));
    expect(new Uint8Array(await (await again.finish()).arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    expect(existsSync(partPath(folder, item.entry).replace(/\.part$/, ".json"))).toBe(false);
  });
});

describe("a file that could not be accepted (C05)", () => {
  it("is not counted as on its way, and the failure is reported", async () => {
    const failed = vi.fn();
    const link = { session: { acceptFile: async () => { throw new Error("This file offer is no longer pending"); } }, events: {} } as unknown as Link;
    await receiveInto(link, fresh(), { accept: async () => true, failed });
    link.events.offer?.({ transferId: "expired", name: "expired.txt" } as never);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith("expired.txt", "This file offer is no longer pending"));
    expect(stillArriving(link)).toBe(0);
  });

  it("still counts one that was accepted", async () => {
    const link = { session: { acceptFile: async () => {} }, events: {} } as unknown as Link;
    await receiveInto(link, fresh(), { accept: async () => true });
    link.events.offer?.({ transferId: "fine", name: "fine.txt" } as never);
    await vi.waitFor(() => expect(stillArriving(link)).toBe(1));
  });
});
