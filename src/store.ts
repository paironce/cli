/**
 * This terminal's device: its identity (an ECDH P-256 key pair, the same kind a browser keeps in IndexedDB) and the
 * devices it paired with, in ~/.paironce (or $PAIRONCE_HOME). The private key is kept as a JWK in a file only this user
 * can read; it never leaves this computer, exactly like a browser's.
 */
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { deviceIdForKey } from "@paironce/protocol";
import { randomBytes, toBase64Url } from "@paironce/crypto";
import type { DeviceDescriptor, DeviceIdentity, PairedDevice } from "../../../apps/app/src/identity";

export const home = () => process.env.PAIRONCE_HOME || path.join(homedir(), ".paironce");
const identityFile = () => path.join(home(), "identity.json");
const devicesFile = () => path.join(home(), "devices.json");

const LOCK_WAIT_MS = 8_000;
const LOCK_STALE_MS = 15_000;

interface StoredIdentity { id: string; name: string; publicKey: string; privateKey: JsonWebKey; createdAt: number }

/** "Windows · Terminal": what the other device shows for this one (the same shape as a browser's "Windows · Chrome"). */
export function terminalName(system = platform()): string {
  const name = system === "win32" ? "Windows" : system === "darwin" ? "macOS" : system === "linux" ? "Linux" : "Computer";
  return `${name} · Terminal`;
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${toBase64Url(randomBytes(4))}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/**
 * One process at a time reads, changes and writes this folder's files: a person's terminal and an agent can share it, and
 * two at once would lose a saved device or make two identities. A lock left by a process that ended goes after a while.
 */
async function locked<T>(work: () => Promise<T>): Promise<T> {
  const lock = path.join(path.dirname(identityFile()), "store.lock");
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (const end = Date.now() + LOCK_WAIT_MS; ;) {
    try { await (await open(lock, "wx", 0o600)).close(); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) { await rm(lock, { force: true }); continue; }
      if (Date.now() > end) throw new Error(`Another PairOnce process is holding ${lock}.`);
      await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 60));
    }
  }
  try { return await work(); } finally { await rm(lock, { force: true }).catch(() => {}); }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function usable(stored: StoredIdentity): Promise<DeviceIdentity> {
  const privateKey = await crypto.subtle.importKey("jwk", stored.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { id: stored.id, name: stored.name, publicKey: stored.publicKey, privateKey, createdAt: stored.createdAt };
}

/** What a terminal or an agent may be shown from the other device: no control, escape or text-direction characters. */
export const safeName = (name: string) => name.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim() || "device";

/** A name another device can show: 1–80 characters, no control characters. */
export function cleanName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean || clean.length > 80) throw new Error("The device name needs 1 to 80 characters.");
  return clean;
}

/**
 * This terminal's identity, made on first use. PAIRONCE_NAME (or --name) sets the name the other device shows, e.g.
 * "Claude Code · Agent"; it is kept, and the key stays the same, so a paired device still knows this one.
 */
export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  const wanted = process.env.PAIRONCE_NAME ? cleanName(process.env.PAIRONCE_NAME) : undefined;
  const found = await readJson<StoredIdentity>(identityFile());
  if (found && (!wanted || found.name === wanted)) return usable({ ...found, name: wanted ?? found.name });
  return locked(async () => {
  const existing = await readJson<StoredIdentity>(identityFile());
  if (existing && wanted && existing.name !== wanted) await writePrivate(identityFile(), { ...existing, name: wanted });
  if (existing) return usable({ ...existing, name: wanted ?? existing.name });
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const stored: StoredIdentity = {
    id: await deviceIdForKey(publicKey), name: wanted ?? terminalName(),
    publicKey,
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey), createdAt: Date.now(),
  };
  await writePrivate(identityFile(), stored);
  return usable(stored);
  });
}

export async function listDevices(): Promise<PairedDevice[]> {
  return ((await readJson<PairedDevice[]>(devicesFile())) ?? []).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Remember a device after pairing, or note that it was seen. A known ID with another key is refused, as in the browser. */
export function saveDevice(device: DeviceDescriptor, now = Date.now()): Promise<PairedDevice> {
  return locked(async () => {
  const devices = await listDevices();
  const known = devices.find(item => item.id === device.id);
  if (known && known.publicKey !== device.publicKey) throw new Error("A saved device with this ID has a different key. Remove it first.");
  const saved: PairedDevice = { ...known, id: device.id, name: safeName(device.name), publicKey: device.publicKey, pairedAt: known?.pairedAt ?? now, lastSeenAt: now };
  await writePrivate(devicesFile(), [saved, ...devices.filter(item => item.id !== device.id)]);
  return saved;
  });
}

export function forgetDevice(id: string): Promise<boolean> {
  return locked(async () => {
  const devices = await listDevices();
  const rest = devices.filter(item => item.id !== id);
  if (rest.length === devices.length) return false;
  await writePrivate(devicesFile(), rest);
  return true;
  });
}

/** A saved device by a part of its name (case-insensitive), or the only one when none is named. */
export function pickDevice(devices: PairedDevice[], query?: string): PairedDevice | "none" | "ambiguous" {
  if (!query) return devices.length === 1 ? devices[0]! : devices.length ? "ambiguous" : "none";
  const wanted = query.toLowerCase();
  const exact = devices.filter(device => device.name.toLowerCase() === wanted || device.id === query);
  if (exact.length === 1) return exact[0]!;
  const matches = devices.filter(device => device.name.toLowerCase().includes(wanted));
  return matches.length === 1 ? matches[0]! : matches.length ? "ambiguous" : "none";
}
