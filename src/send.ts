/** Sending one file from disk over an open link, shared by the commands and the MCP server. */
import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Link } from "./connection";

export const say = (text: string) => { process.stderr.write(`${text}
`); };
/** How the connection runs, in words. */
export const pathName = (link: Link) => link.session.usesTunnel() ? "through the PairOnce tunnel"
  : link.path === "turn" ? "through the encrypted relay" : "direct";
export const human = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} kB`;

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

