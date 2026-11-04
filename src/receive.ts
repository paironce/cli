/** Saving what arrives on an open link into a folder, shared by `paironce receive` and the MCP `receive_files` tool. */
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FileOffer, ReceivedFile } from "../../../apps/app/src/session";
import type { Link } from "./connection";
import { partPath } from "./disk";

/** A name of its own in `folder`: the sender's name made safe, "name (1).ext" when it is taken. */
export async function uniquePath(folder: string, name: string): Promise<string> {
  const safe = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_") || "file";
  const { name: stem, ext } = path.parse(safe);
  for (let index = 0; ; index++) {
    const candidate = path.join(folder, index ? `${stem} (${index})${ext}` : safe);
    try { await stat(candidate); } catch { return candidate; }
  }
}

export interface ReceiveHandlers {
  /** Whether to take an offered file. */
  accept(offer: FileOffer): Promise<boolean>;
  saved?(file: string): void;
  failed?(name: string, message: string): void;
  text?(text: string): void;
}

/** From now on, files offered on `link` are accepted or declined, and the accepted ones are saved into `folder`. */
export async function receiveInto(link: Link, folder: string, handlers: ReceiveHandlers): Promise<void> {
  await mkdir(folder, { recursive: true });
  link.events.offer = offer => {
    void (async () => {
      await ((await handlers.accept(offer)) ? link.session.acceptFile(offer.transferId) : link.session.rejectFile(offer.transferId));
    })().catch(error => handlers.failed?.(offer.name, error instanceof Error ? error.message : String(error)));
  };
  link.events.file = (file: ReceivedFile) => {
    void (async () => {
      const target = await uniquePath(folder, file.name);
      if (file.onDisk) await rename(partPath(folder, file.diskEntry ?? file.transferId), target);
      else await writeFile(target, new Uint8Array(await (file.blob ?? await (await fetch(file.url)).blob()).arrayBuffer()));
      URL.revokeObjectURL(file.url);
      await link.session.confirmFileSaved(file.transferId).catch(() => {});
      handlers.saved?.(target);
    })().catch(error => handlers.failed?.(file.name, error instanceof Error ? error.message : String(error)));
  };
  if (handlers.text) link.events.text = handlers.text;
}
