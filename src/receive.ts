/** Saving what arrives on an open link into a folder, shared by `paironce receive` and the MCP `receive_files` tool. */
import { copyFile, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileOffer, ReceivedFile } from "../../../apps/app/src/session";
import type { Link } from "./connection";
import { partPath } from "./disk";

/**
 * A path of its own in `folder`, already created empty so that nothing else can take it: the sender's name made safe,
 * "name (1).ext" when it is taken. Two files of one name arriving together get two paths.
 */
export async function uniquePath(folder: string, name: string): Promise<string> {
  const safe = path.basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, "_").replace(/^\.+/, "_") || "file";
  const { name: stem, ext } = path.parse(safe);
  for (let index = 0; ; index++) {
    const candidate = path.join(folder, index ? `${stem} (${index})${ext}` : safe);
    try { await (await open(candidate, "wx")).close(); return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

/**
 * Where an MCP tool saves: a folder inside the server's folder, never that folder itself. The name comes from the model,
 * and a message from the other device or a file it read can talk a model into anything, so an absolute path, a way out,
 * a dot folder such as .ssh or .claude, or a link that leads out is refused (CLI 0.8.1). A person's --to is not limited.
 */
export async function insideFolder(value: unknown, fallback: string): Promise<string> {
  const wanted = typeof value === "string" && value ? value : fallback;
  const parts = wanted.replace(/\\/g, "/").split("/").filter(part => part && part !== ".");
  const refused = `Cannot save to "${wanted.slice(0, 200)}": folder must be a relative path inside the server's folder, with no ".." and no folder starting with a dot.`;
  if (path.posix.isAbsolute(wanted) || path.win32.isAbsolute(wanted) || !parts.length || parts.some(part => part.startsWith(".") || part.includes(":"))) throw new Error(refused);
  const root = await realpath(process.cwd());
  let existing = path.join(root, ...parts);
  for (;;) {
    try { existing = await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === root) throw error;
      existing = path.dirname(existing);
    }
  }
  const relative = path.relative(root, existing);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(refused);
  return path.join(root, ...parts);
}

/**
 * Which folder each accepted file goes to: the one the accepting call named, also when the file arrives after that call
 * stopped waiting or during the next one (CLI 0.11.0). Per connection.
 */
const accepted = new WeakMap<object, Map<string, string>>();
function acceptedOn(link: Link): Map<string, string> {
  let folders = accepted.get(link.session);
  if (!folders) accepted.set(link.session, folders = new Map());
  return folders;
}

/** Files this connection accepted that have not arrived yet. */
export const stillArriving = (link: Link) => acceptedOn(link).size;

/** An accepted file ended before it all arrived, so it is no longer on its way (CLI 0.11.1); whether it was. */
export const stopWaitingFor = (link: Link, transferId: string) => acceptedOn(link).delete(transferId);

/** Whether this file was accepted, and so has somewhere to go. */
export const wasAccepted = (link: Link, file: ReceivedFile) => acceptedOn(link).has(file.transferId);

/** Moves a finished file, also to a folder on another disk (CLI 0.11.0, R14). */
export async function moveFile(from: string, to: string, renameFile = rename): Promise<void> {
  try { await renameFile(from, to); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(from, to);
    await rm(from, { force: true });
  }
}

/** Saves what arrived into the folder it was accepted for (`folder` when it has none), and tells the other device. */
export async function saveArrived(link: Link, file: ReceivedFile, folder: string, partsFolder: string): Promise<string> {
  const folders = acceptedOn(link);
  const into = folders.get(file.transferId) ?? folder;
  folders.delete(file.transferId);
  await mkdir(into, { recursive: true });
  const target = await uniquePath(into, file.name);
  try {
    if (file.onDisk) await moveFile(partPath(partsFolder, file.diskEntry ?? file.transferId), target);
    else await writeFile(target, new Uint8Array(await (file.blob ?? await (await fetch(file.url)).blob()).arrayBuffer()));
  } catch (error) { await rm(target, { force: true }).catch(() => {}); throw error; }
  finally { URL.revokeObjectURL(file.url); }
  await link.session.confirmFileSaved(file.transferId).catch(() => {});
  return target;
}

export interface ReceiveHandlers {
  /** Whether to take an offered file. */
  accept(offer: FileOffer): Promise<boolean>;
  saved?(file: string): void;
  failed?(name: string, message: string): void;
  text?(text: string): void;
}

/**
 * From now on, files offered on `link` are accepted or declined, and the accepted ones are saved into `folder`.
 * `partsFolder`: where the link's disk receiver keeps large files as they arrive, when not the same folder.
 */
export async function receiveInto(link: Link, folder: string, handlers: ReceiveHandlers, partsFolder = folder): Promise<void> {
  await mkdir(folder, { recursive: true });
  link.events.offer = offer => {
    void (async () => {
      if (!await handlers.accept(offer)) { await link.session.rejectFile(offer.transferId); return; }
      acceptedOn(link).set(offer.transferId, folder);
      await link.session.acceptFile(offer.transferId);
    })().catch(error => {
      // Not accepted after all, for example an offer that expired: it is not on its way (CLI 0.11.3, C05).
      stopWaitingFor(link, offer.transferId);
      handlers.failed?.(offer.name, error instanceof Error ? error.message : String(error));
    });
  };
  link.events.file = (file: ReceivedFile) => {
    void saveArrived(link, file, folder, partsFolder).then(target => handlers.saved?.(target))
      .catch(error => handlers.failed?.(file.name, error instanceof Error ? error.message : String(error)));
  };
  link.events.fileClosed = (transferId, name) => {
    if (stopWaitingFor(link, transferId)) handlers.failed?.(name ?? "A file", "the other device stopped sending it.");
  };
  if (handlers.text) link.events.text = handlers.text;
}
