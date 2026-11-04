/**
 * One connection from this terminal, made exactly as the web app makes it (apps/app/src/realtime/useRealtime.ts,
 * connect()): the same PeerSession, the same v2 pairing with a safety code both sides compare, the same encrypted frames,
 * per-file approval on the receiving side, direct first and the relay only when a direct path fails.
 *
 * Three ways in: show a six-digit code for the other device to type (`host`), type the code the other device shows
 * (`join`), or reconnect to a device paired before (`saved`), which needs no code and no approval again.
 */
import { fromBase64Url, generateSessionSecret } from "@paironce/crypto";
import type { DeliveryPath } from "@paironce/transfer";
import { PeerSession, randomId, signalingOrigin, type DiskReceiver, type FileOffer, type FileReceipt, type PeerIdentityDescriptor, type ReceivedFile, type SessionCallbacks } from "../../../apps/app/src/session";
import { PAIRING_CODE_TTL_MS, type DeviceDescriptor, type DeviceIdentity, type PairedDevice } from "../../../apps/app/src/identity";
import { returningDeviceSession, returningPresence } from "../../../apps/app/src/returning-device";
import { saveDevice } from "./store";

/** What the person sees and decides while connecting. */
export interface ConnectUi {
  status?(text: string): void;
  /** `host`: the code to type on the other device. */
  code?(code: string): void;
  /** Both screens show this; the person checks they match. */
  safetyCode?(code: string): void;
  /** `host` with a new device: approve it (after comparing the safety code). */
  approve?(peer: DeviceDescriptor): Promise<boolean>;
}

/** What happens on the open connection. Set by the command that uses it. */
export interface LinkEvents {
  offer?(offer: FileOffer): void;
  file?(file: ReceivedFile): void;
  receipt?(receipt: FileReceipt): void;
  progress?(name: string, fraction: number, direction?: "sent" | "received"): void;
  text?(text: string): void;
  /** The other device answered a request for a file, a photo or a scan (Agent as a Device v3). */
  requestAnswer?(answer: { id: string; decision: "decline" | "send"; count?: number }): void;
  error?(message: string): void;
  closed?(): void;
}

export interface Link { session: PeerSession; peer: PairedDevice; path: DeliveryPath; events: LinkEvents; close(): void }

export type Target = { kind: "host" } | { kind: "join"; code: string } | { kind: "saved"; device: PairedDevice };

const httpOrigin = () => {
  const url = new URL(signalingOrigin());
  url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  return url;
};

/** The room a typed code stands for (the web app's joinFromDirectory). */
async function lookupCode(code: string, identity: DeviceIdentity) {
  const response = await fetch(new URL("/v1/connection-code/lookup", httpOrigin()), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, device: identity.id }), signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 429) throw new Error("Too many requests. Wait a moment, then try again.");
  if (!response.ok) throw new Error("Connection code expired or unavailable.");
  const offer = await response.json() as { roomId: string; nonce: string; expiresAt: number; host: DeviceDescriptor; room?: boolean };
  const secret = fromBase64Url(offer.nonce);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(offer.roomId) || secret.byteLength !== 32 || offer.expiresAt <= Date.now()
    || !offer.host || !/^[A-Za-z0-9_-]{16,128}$/.test(offer.host.id) || !/^[A-Za-z0-9_-]{87}$/.test(offer.host.publicKey)) {
    throw new Error("Connection code expired or unavailable.");
  }
  if (offer.host.id === identity.id) throw new Error("That code is shown by this same device. Type it on your other device.");
  if (offer.room) throw new Error("That is a distribution room's code. Open it in a browser to join the room.");
  return { roomId: offer.roomId, secret, host: offer.host };
}

/** Connects and resolves once the encrypted channel is open and both devices confirmed each other. */
export async function connect(identity: DeviceIdentity, target: Target, ui: ConnectUi, options: { diskReceive?: DiskReceiver; signal?: AbortSignal } = {}): Promise<Link> {
  const events: LinkEvents = {};
  let room: { roomId: string; secret: Uint8Array<ArrayBuffer>; role: "host" | "join"; expected?: PeerIdentityDescriptor; code?: string; expiresAt: number };
  const returning = target.kind === "saved" ? target.device : undefined;
  if (target.kind === "host") {
    room = { roomId: randomId(), secret: generateSessionSecret(), role: "host", expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
  } else if (target.kind === "join") {
    const found = await lookupCode(target.code, identity);
    room = { roomId: found.roomId, secret: found.secret, role: "join", expected: found.host, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
  } else {
    const next = await returningDeviceSession(identity, target.device);
    // Ask the other device to connect: it shows this one at the top of its list (or connects on its own if set to).
    void returningPresence(identity, target.device, true, AbortSignal.timeout(10_000)).catch(() => {});
    room = { roomId: next.roomId, secret: next.secret, role: next.role, expected: target.device, code: next.offer.code, expiresAt: next.offer.expiresAt };
  }

  return new Promise<Link>((resolve, reject) => {
    let peer: PairedDevice | undefined;
    let saving: Promise<void> = Promise.resolve();
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) { events.error?.(error instanceof Error ? error.message : String(error)); return; }
      settled = true;
      session?.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    options.signal?.addEventListener("abort", () => fail(new Error(returning
      ? `${returning.name} did not connect. Open https://paironce.com there, tap Connect where it says "${identity.name} wants to reconnect", then try again.`
      : "Nobody connected in time. Try again.")), { once: true });
    const callbacks: SessionCallbacks = {
      onStatus: text => {
        if (text === "Transfer channel closed") { if (settled) events.closed?.(); else fail(new Error("The connection ended.")); return; }
        ui.status?.(text);
      },
      onConnectionCode: code => ui.code?.(code),
      // A saved device has nothing to compare: its code comes from both devices' keys and is checked by the session.
      onPairingSas: code => { if (!returning) ui.safetyCode?.(code); },
      onPairingRequired: () => {
        if (room.role !== "join") return;
        void (async () => {
          // A saved device proves itself with the code both derive from their keys; a new one with the safety code.
          const code = room.code ?? await session.getPairingSas();
          if (!room.code) ui.safetyCode?.(code);
          await session.submitPairingCode(code);
        })().catch(fail);
      },
      onPairingApprovalRequired: candidate => {
        if (returning && candidate.id === returning.id && candidate.publicKey === returning.publicKey) {
          void session.approvePairing().catch(fail);
          return;
        }
        if (!ui.approve) { void session.rejectPairing().catch(() => {}); fail(new Error("A new device can only be approved in the terminal.")); return; }
        void ui.approve(candidate).then(yes => yes ? session.approvePairing() : session.rejectPairing()).catch(fail);
      },
      onPairingConfirmed: confirmed => {
        peer = { ...confirmed, pairedAt: Date.now(), lastSeenAt: Date.now() };
        // Remembered before the connection counts as ready, so a command that ends right after still keeps the device.
        saving = saveDevice(confirmed).then(saved => { peer = saved; }, error => { ui.status?.(error instanceof Error ? error.message : String(error)); });
      },
      onPairingRejected: (reason, terminal) => { if (terminal) fail(new Error(reason)); else ui.status?.(reason); },
      onReady: path => {
        if (settled) return;
        settled = true;
        void saving.then(() => resolve({ session, peer: peer ?? { ...(room.expected as DeviceDescriptor), pairedAt: Date.now(), lastSeenAt: Date.now() }, path, events, close: () => session.close() }));
      },
      onText: text => events.text?.(text),
      onRequestAnswer: answer => events.requestAnswer?.(answer),
      onFile: file => events.file?.(file),
      onFileOffer: offer => events.offer?.(offer),
      onFileReceipt: receipt => events.receipt?.(receipt),
      onProgress: (label, fraction, direction) => events.progress?.(label, fraction, direction),
      onError: message => fail(new Error(message)),
      onConnectionCodeUnavailable: reason => fail(new Error(reason === "limited" ? "Too many requests. Wait a moment, then try again." : "No code is available right now. Try again.")),
    };
    let session: PeerSession;
    try {
      session = new PeerSession(room.roomId, room.role, room.secret, callbacks, {
        identity: { id: identity.id, name: identity.name, publicKey: identity.publicKey },
        identityPrivateKey: identity.privateKey,
        requirePairing: true,
        // As the web app: new pairings (host, join) agree keys from the devices (v2); a saved device's room already comes
        // from both devices' keys, and its host checks the code both derived instead (returning-device.ts).
        deviceKeyAgreement: target.kind !== "saved",
        fileApproval: true,
        publishConnectionCode: target.kind === "host",
        pairingExpiresAt: room.expiresAt,
        ...(target.kind === "saved" && room.role === "host" && room.code ? { pairingCode: room.code } : {}),
        isPro: () => false,
        // Agent as a Device v2: an agent says so (the other device marks it) and may ask to be forgotten after a while away.
        ...(process.env.PAIRONCE_AGENT === "1" ? { deviceKind: "agent" as const,
          ...(Number(process.env.PAIRONCE_FORGET_AFTER) > 0 ? { forgetAfter: Number(process.env.PAIRONCE_FORGET_AFTER) } : {}) } : {}),
        // PAIRONCE_FORCE_RELAY=1 skips the direct attempt: for checking the relay path on a given network.
        forceRelay: process.env.PAIRONCE_FORCE_RELAY === "1",
        ...(room.expected ? { expectedPeerIdentity: room.expected } : {}),
        ...(options.diskReceive ? { diskReceive: options.diskReceive } : {}),
      });
    } catch (error) { fail(error); return; }
    session.connect().catch(fail);
  });
}
