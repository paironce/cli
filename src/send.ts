/** Sending one file from disk over an open link, shared by the commands and the MCP server. */
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Link } from "./connection";

export const say = (text: string) => { process.stderr.write(`${text}
`); };
/** How the connection runs, in words. */
export const pathName = (link: Link) => link.session.usesTunnel() ? "through the PairOnce tunnel"
  : link.path === "turn" ? "through the encrypted relay" : "direct";
export const human = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} kB`;

/**
 * Whether an MCP tool may send this file. The path comes from the model, and a message from the other device or a file it
 * read can talk a model into anything (CLI 0.11.0, R10): not this device's own keys, and nothing hidden, such as .ssh or
 * .env. Inside the server's folder, only what is below it counts. A person's `paironce send` is not limited.
 */
export async function refusedToAgent(file: string, ownHome: string): Promise<string | undefined> {
  const real = await realpath(file);
  const home = await realpath(ownHome).catch(() => path.resolve(ownHome));
  const root = await realpath(process.cwd());
  const inside = (folder: string, item: string) => { const relative = path.relative(folder, item); return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined; };
  const shown = file.slice(0, 200);
  if (inside(home, real)) return `Not sending "${shown}": it is one of this device's own PairOnce files.`;
  // The temporary folder counts from itself as well: on Windows it lies inside AppData, and agents do make files there.
  const parts = (inside(root, real) ?? inside(await realpath(tmpdir()), real) ?? real).split(/[\\/]/);
  // A system's own folders for what programs keep, which have no dot: Windows's AppData, a Mac's Library in the home folder.
  const userData = !inside(root, real) && inside(homedir(), real)?.split(/[\\/]/)[0] === "Library";
  if (userData || parts.some(part => part.startsWith(".") || part.toLowerCase() === "appdata")) return `Not sending "${shown}": hidden files and folders are not sent by an agent. The user can send it with: paironce send`;
  return undefined;
}

/** Send one file and wait until the other device has it. The other side accepts it first. */
export async function sendPath(link: Link, file: string, report = say): Promise<void> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${file} is not a file. Send the files inside a folder with: paironce send ${path.join(file, "*")}`);
  const name = path.basename(file);
  const blob = await openAsBlob(file);
  const received = new Promise<void>(resolve => {
    const before = link.events.receipt;
    link.events.receipt = receipt => { before?.(receipt); if (receipt.stage === "received") resolve(); };
  });
  let shown = -1;
  link.events.progress = (label, fraction, direction) => {
    const percent = Math.floor(fraction * 100);
    if (direction === "sent" && percent >= shown + 10) { shown = percent; report(`  ${label}: ${percent}%`); }
  };
  report(`Sending ${name} (${human(info.size)}). Waiting for ${link.peer.name} to accept…`);
  // The same for this file until it changes, so a device that kept part of it continues when it is sent again.
  const resumeKey = createHash("sha256").update(`paironce-send-v1\0${path.resolve(file)}\0${info.size}\0${info.mtimeMs}`).digest("base64url").slice(0, 32);
  await link.session.sendFile(new File([blob], name, { lastModified: info.mtimeMs }), undefined, undefined, { resumeKey });
  await Promise.race([received, new Promise(resolve => setTimeout(resolve, 30_000))]);
  report(`Sent ${name}.`);
}

