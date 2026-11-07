/**
 * Large incoming files go straight to disk in the folder they are received into, as hidden ".part" files, instead of
 * memory: the terminal's version of the browser's private-storage receiver (apps/app/src/realtime/disk-receive.ts), so
 * a terminal receives files as large as the sender may send and continues a cut-off one like a browser does.
 */
import { createWriteStream, openAsBlob, type WriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, statfs, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DiskReceiver, DiskSink, PartialFile } from "../../../apps/app/src/session";
import { DISK_THRESHOLD_BYTES, MAX_PARTIALS, PARTIAL_KEEP_MS } from "../../../apps/app/src/realtime/disk-receive";

/** Left free on the disk. */
const RESERVE_BYTES = 512 * 1024 * 1024;

export const partPath = (folder: string, entry: string) => path.join(folder, `.paironce-${entry.replace(/[^A-Za-z0-9_-]/g, "_")}.part`);
/** What a later process needs to continue a part: written when the part is kept, gone when it is taken up or dropped. */
const notePath = (folder: string, entry: string) => partPath(folder, entry).replace(/\.part$/, ".json");

function sinkFor(file: string, stream: WriteStream, name: string, mime: string): DiskSink {
  // Each write and the end report their own error; without a listener the same error would also end the program.
  stream.on("error", () => {});
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

/** Parts a process that ended left behind, past the time they could be continued. */
export async function removeOldParts(folder: string, now = Date.now()): Promise<void> {
  const names = await readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (!/^\.paironce-[A-Za-z0-9_-]+\.(?:part|json|json\.lock)$/.test(name)) continue;
    const file = path.join(folder, name);
    const info = await stat(file).catch(() => undefined);
    if (info && now - info.mtimeMs > PARTIAL_KEEP_MS) await rm(file, { force: true }).catch(() => {});
  }
}

function validPartial(value: unknown): value is PartialFile {
  const item = value as PartialFile | null;
  return Boolean(item) && [item!.peerId, item!.resumeKey, item!.entry, item!.name, item!.mime].every(text => typeof text === "string")
    && /^[A-Za-z0-9_-]+$/.test(item!.entry) && [item!.size, item!.chunkSize, item!.totalChunks, item!.next].every(count => Number.isSafeInteger(count) && count >= 0);
}

export function createDiskReceiver(folder: string): DiskReceiver & { restore(): Promise<void>; settled(): Promise<void> } {
  const kept: { partial: PartialFile; at: number }[] = [];
  // Parts with a note on disk, and the note's time: another process may have found them too, so continuing or removing one
  // means winning its note (CLI 0.11.0, B03; removing since 0.11.3, C02).
  const restored = new Map<string, number>();
  const lost = new Set<string>();
  let keeping: Promise<unknown> = Promise.resolve();
  let tidied = false;
  const forgetNote = (entry: string) => rm(notePath(folder, entry), { force: true }).catch(() => {});
  /**
   * Whether this process has the part. A note that is gone, or newer than the one this process saw (another process
   * continued the part and kept it again), means it is someone else's. A part with no note here has no one to win against.
   */
  const claim = async (entry: string): Promise<boolean> => {
    const at = restored.get(entry);
    if (at === undefined) return true;
    restored.delete(entry);
    const note = notePath(folder, entry);
    // Not by renaming the note: on Windows two renames of one file at the same moment both succeed.
    const lock = await open(`${note}.lock`, "wx").catch(() => undefined);
    if (!lock) return false;
    try {
      const seen = await readFile(note, "utf8").then(text => (JSON.parse(text) as { at?: unknown }).at, () => undefined);
      if (seen !== at) return false;
      await rm(note);
      return true;
    } catch { return false; } finally {
      await lock.close().catch(() => {});
      await rm(`${note}.lock`, { force: true }).catch(() => {});
    }
  };
  const remove = async (entry: string) => {
    if (!await claim(entry)) return;
    await rm(partPath(folder, entry), { force: true });
    await forgetNote(entry);
  };
  const drop = async (index: number) => {
    const [gone] = kept.splice(index, 1);
    if (gone) await remove(gone.partial.entry);
  };
  return {
    /** Parts an earlier process kept here, for files sent again. Call before connecting; old ones go first. */
    async restore() {
      await removeOldParts(folder);
      tidied = true;
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (!/^\.paironce-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        const note = await readFile(path.join(folder, name), "utf8").then(text => JSON.parse(text) as { partial?: unknown; at?: unknown }).catch(() => undefined);
        if (!validPartial(note?.partial) || typeof note.at !== "number") continue;
        const size = await stat(partPath(folder, note.partial.entry)).then(info => info.size, () => -1);
        if (size < note.partial.next * note.partial.chunkSize) continue;
        kept.push({ partial: note.partial, at: note.at });
        restored.set(note.partial.entry, note.at);
      }
    },
    threshold: DISK_THRESHOLD_BYTES,
    async available() {
      await mkdir(folder, { recursive: true });
      if (!tidied) { tidied = true; await removeOldParts(folder); }
      const disk = await statfs(folder);
      return Math.max(0, disk.bavail * disk.bsize - RESERVE_BYTES);
    },
    async open(entry, name, mime, offset = 0) {
      await mkdir(folder, { recursive: true });
      const file = partPath(folder, entry);
      if (offset > 0 && !await claim(entry)) { lost.add(entry); throw new Error("disk_partial_taken"); }
      if (offset > 0) {
        if ((await stat(file)).size < offset) throw new Error("disk_partial_short");
        await truncate(file, offset);
      }
      return sinkFor(file, createWriteStream(file, { flags: offset > 0 ? "a" : "w" }), name, mime);
    },
    async remove(entry) { await rm(partPath(folder, entry), { force: true }); },
    /** Parts being kept are written: a program that ends right after a connection dropped waits for this. */
    settled: async () => { await keeping; },
    keepPartial(partial, sink) {
      const job = (async () => {
      try { await sink.park(); } catch { await sink.abort(); return; }
      for (let index = kept.length - 1; index >= 0; index--) if (Date.now() - kept[index]!.at > PARTIAL_KEEP_MS) await drop(index);
      const same = kept.findIndex(item => item.partial.peerId === partial.peerId && item.partial.resumeKey === partial.resumeKey);
      if (same >= 0) kept.splice(same, 1);
      const at = Date.now();
      kept.push({ partial, at });
      // Whole or not at all: the next process reads this.
      const note = notePath(folder, partial.entry);
      await writeFile(`${note}.tmp`, JSON.stringify({ partial, at }), { mode: 0o600 }).then(() => rename(`${note}.tmp`, note))
        .then(() => { if (kept.some(item => item.partial === partial)) restored.set(partial.entry, at); else void forgetNote(partial.entry); }, () => {});
      while (kept.length > MAX_PARTIALS) await drop(0);
      })();
      keeping = Promise.all([keeping, job.catch(() => {})]);
      return job;
    },
    findPartial: (peerId, resumeKey) => kept.find(item => item.partial.peerId === peerId && item.partial.resumeKey === resumeKey
      && Date.now() - item.at <= PARTIAL_KEEP_MS)?.partial,
    takePartial(partial) {
      const index = kept.findIndex(item => item.partial === partial);
      if (index >= 0) kept.splice(index, 1);
      // A restored part's note stays until it is opened: that is where another process and this one find out who has it.
      if (!restored.has(partial.entry)) void forgetNote(partial.entry);
    },
    async discardPartial(partial) {
      // Another process is writing it.
      if (lost.delete(partial.entry)) return;
      const index = kept.findIndex(item => item.partial === partial);
      if (index >= 0) kept.splice(index, 1);
      await remove(partial.entry);
    },
  };
}
