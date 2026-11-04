/**
 * This terminal's device: its identity (an ECDH P-256 key pair, the same kind a browser keeps in IndexedDB) and the
 * devices it paired with, in ~/.paironce (or $PAIRONCE_HOME). The private key is kept as a JWK in a file only this user
 * can read; it never leaves this computer, exactly like a browser's.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { randomBytes, toBase64Url } from "@paironce/crypto";
import type { DeviceDescriptor, DeviceIdentity, PairedDevice } from "../../../apps/app/src/identity";

export const home = () => process.env.PAIRONCE_HOME || path.join(homedir(), ".paironce");
const identityFile = () => path.join(home(), "identity.json");
const devicesFile = () => path.join(home(), "devices.json");

interface StoredIdentity { id: string; name: string; publicKey: string; privateKey: JsonWebKey; createdAt: number }

/** "Windows · Terminal": what the other device shows for this one (the same shape as a browser's "Windows · Chrome"). */
export function terminalName(system = platform()): string {
  const name = system === "win32" ? "Windows" : system === "darwin" ? "macOS" : system === "linux" ? "Linux" : "Computer";
  return `${name} · Terminal`;
}

async function writePrivate(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function usable(stored: StoredIdentity): Promise<DeviceIdentity> {
  const privateKey = await crypto.subtle.importKey("jwk", stored.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { id: stored.id, name: stored.name, publicKey: stored.publicKey, privateKey, createdAt: stored.createdAt };
}

/** This terminal's identity, made on first use. */
export async function loadOrCreateIdentity(): Promise<DeviceIdentity> {
  const existing = await readJson<StoredIdentity>(identityFile());
  if (existing) return usable(existing);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const stored: StoredIdentity = {
    id: toBase64Url(randomBytes(12)), name: terminalName(),
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey), createdAt: Date.now(),
  };
  await writePrivate(identityFile(), stored);
  return usable(stored);
}

export async function listDevices(): Promise<PairedDevice[]> {
  return ((await readJson<PairedDevice[]>(devicesFile())) ?? []).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/** Remember a device after pairing, or note that it was seen. A known ID with another key is refused, as in the browser. */
export async function saveDevice(device: DeviceDescriptor, now = Date.now()): Promise<PairedDevice> {
  const devices = await listDevices();
  const known = devices.find(item => item.id === device.id);
  if (known && known.publicKey !== device.publicKey) throw new Error("A saved device with this ID has a different key. Remove it first.");
  const saved: PairedDevice = { ...known, id: device.id, name: device.name, publicKey: device.publicKey, pairedAt: known?.pairedAt ?? now, lastSeenAt: now };
  await writePrivate(devicesFile(), [saved, ...devices.filter(item => item.id !== device.id)]);
  return saved;
}

export async function forgetDevice(id: string): Promise<boolean> {
  const devices = await listDevices();
  const rest = devices.filter(item => item.id !== id);
  if (rest.length === devices.length) return false;
  await writePrivate(devicesFile(), rest);
  return true;
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
