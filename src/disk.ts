/**
 * Large incoming files go straight to disk in the folder they are received into, as hidden ".part" files, instead of
 * memory: the terminal's version of the browser's private-storage receiver (apps/app/src/realtime/disk-receive.ts), so
 * a terminal receives files as large as the sender may send and continues a cut-off one like a browser does.
 */
import { createWriteStream, openAsBlob, type WriteStream } from "node:fs";
import { mkdir, rm, stat, statfs, truncate } from "node:fs/promises";
import path from "node:path";
import type { DiskReceiver, DiskSink, PartialFile } from "../../../apps/app/src/session";
import { DISK_THRESHOLD_BYTES, MAX_PARTIALS, PARTIAL_KEEP_MS } from "../../../apps/app/src/realtime/disk-receive";

/** Left free on the disk. */
const RESERVE_BYTES = 512 * 1024 * 1024;

export const partPath = (folder: string, entry: string) => path.join(folder, `.paironce-${entry.replace(/[^A-Za-z0-9_-]/g, "_")}.part`);

function sinkFor(file: string, stream: WriteStream, name: string, mime: string): DiskSink {
  const closed = () => new Promise<void>((resolve, reject) => stream.end((error?: Error | null) => error ? reject(error) : resolve()));
  return {
    write: chunk => new Promise((resolve, reject) => stream.write(chunk, error => error ? reject(error) : resolve())),
    async finish() {
      await closed();
      return new File([await openAsBlob(file, { type: mime })], name, { type: mime, lastModified: Date.now() });
    },
    async abort() { stream.destroy(); await rm(file, { force: true }); },
    park: closed,
  };
}

export function createDiskReceiver(folder: string): DiskReceiver {
  const kept: { partial: PartialFile; at: number }[] = [];
  const drop = async (index: number) => {
    const [gone] = kept.splice(index, 1);
    if (gone) await rm(partPath(folder, gone.partial.entry), { force: true });
  };
  return {
    threshold: DISK_THRESHOLD_BYTES,
    async available() {
      await mkdir(folder, { recursive: true });
      const disk = await statfs(folder);
      return Math.max(0, disk.bavail * disk.bsize - RESERVE_BYTES);
    },
    async open(entry, name, mime, offset = 0) {
      await mkdir(folder, { recursive: true });
      const file = partPath(folder, entry);
      if (offset > 0) {
        if ((await stat(file)).size < offset) throw new Error("disk_partial_short");
        await truncate(file, offset);
      }
      return sinkFor(file, createWriteStream(file, { flags: offset > 0 ? "a" : "w" }), name, mime);
    },
    async remove(entry) { await rm(partPath(folder, entry), { force: true }); },
    async keepPartial(partial, sink) {
      try { await sink.park(); } catch { await sink.abort(); return; }
      for (let index = kept.length - 1; index >= 0; index--) if (Date.now() - kept[index]!.at > PARTIAL_KEEP_MS) await drop(index);
      const same = kept.findIndex(item => item.partial.peerId === partial.peerId && item.partial.resumeKey === partial.resumeKey);
      if (same >= 0) kept.splice(same, 1);
      kept.push({ partial, at: Date.now() });
      while (kept.length > MAX_PARTIALS) await drop(0);
    },
    findPartial: (peerId, resumeKey) => kept.find(item => item.partial.peerId === peerId && item.partial.resumeKey === resumeKey
      && Date.now() - item.at <= PARTIAL_KEEP_MS)?.partial,
    takePartial(partial) {
      const index = kept.findIndex(item => item.partial === partial);
      if (index >= 0) kept.splice(index, 1);
    },
    async discardPartial(partial) {
      const index = kept.findIndex(item => item.partial === partial);
      if (index >= 0) await drop(index); else await rm(partPath(folder, partial.entry), { force: true });
    },
  };
}
