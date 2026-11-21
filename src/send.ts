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

/**
 * A file's type from its name. The type travels with the offer, and the phone uses it to preview a picture and to offer
 * Share (Chrome on Android shares only some types): without it every file from here arrived as an unknown binary
 * (CLI 0.12.1, real Galaxy S24, 2026-11-21).
 */
const TYPES: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  heic: "image/heic", heif: "image/heif", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", m4a: "audio/x-m4a", wav: "audio/wav",
  ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", txt: "text/plain", text: "text/plain", md: "text/markdown", csv: "text/csv",
  html: "text/html", htm: "text/html", css: "text/css", json: "application/json", xml: "application/xml", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf", epub: "application/epub+zip",
};
export const typeOf = (name: string): string => TYPES[path.extname(name).slice(1).toLowerCase()] ?? "";

/**
 * Send one file and wait until the other device has it. The other side accepts it first. `sendFile` itself returns only
 * when that device confirms this very transfer with its encrypted receipt, and throws when it does not within 30 s of the
 * last byte; no second wait for a receipt is needed here (CLI 0.11.6, after the 11-20 agent review).
 */
export async function sendPath(link: Link, file: string, report = say, signal?: AbortSignal): Promise<void> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${file} is not a file. Send the files inside a folder with: paironce send ${path.join(file, "*")}`);
  const name = path.basename(file);
  const blob = await openAsBlob(file);
  let shown = -1;
  link.events.progress = (label, fraction, direction) => {
    const percent = Math.floor(fraction * 100);
    if (direction === "sent" && percent >= shown + 10) { shown = percent; report(`  ${label}: ${percent}%`); }
  };
  report(`Sending ${name} (${human(info.size)}). Waiting for ${link.peer.name} to accept…`);
  // The same for this file until it changes, so a device that kept part of it continues when it is sent again.
  const resumeKey = createHash("sha256").update(`paironce-send-v1\0${path.resolve(file)}\0${info.size}\0${info.mtimeMs}`).digest("base64url").slice(0, 32);
  try {
    await link.session.sendFile(new File([blob], name, { lastModified: info.mtimeMs, type: typeOf(name) }), undefined, signal, { resumeKey });
  } catch (error) {
    // Every byte went, but no receipt came back in time: the file may still arrive (a slow disk on the other side), so say
    // that instead of a plain failure, and let the agent ask before it sends the file again.
    if (/did not confirm the file in time/i.test(error instanceof Error ? error.message : String(error)))
      throw new Error(`Sent all of ${name}, but ${link.peer.name} has not confirmed it yet. It may still arrive: ask the user whether ${name} shows in PairOnce on ${link.peer.name} before sending it again.`);
    throw error;
  }
  report(`Sent ${name}; ${link.peer.name} confirmed it arrived.`);
}

