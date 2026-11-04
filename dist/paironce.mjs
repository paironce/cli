#!/usr/bin/env node
// paironce CLI (Apache-2.0). Source: https://github.com/paironce/cli

// <define:import.meta.env>
var define_import_meta_env_default = {};

// src/env.ts
import { RTCDataChannel, RTCIceCandidate, RTCPeerConnection as RTCPeerConnection2, RTCSessionDescription } from "node-datachannel/polyfill";
var [major] = process.versions.node.split(".").map(Number);
if (!major || major < 22) {
  console.error(`PairOnce needs Node.js 22 or later (this is ${process.versions.node}).`);
  process.exit(1);
}
Object.assign(globalThis, { RTCPeerConnection: RTCPeerConnection2, RTCSessionDescription, RTCIceCandidate, RTCDataChannel });

// src/cli.ts
import { createInterface as createInterface2 } from "node:readline/promises";
import { mkdir as mkdir3, rename as rename2, stat as stat3, writeFile as writeFile2 } from "node:fs/promises";
import path5 from "node:path";

// ../../node_modules/@paironce/crypto/src/index.ts
var encoder = new TextEncoder();
function webCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable in this browser");
  }
  return globalThis.crypto;
}
function randomBytes(length) {
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new RangeError("Random byte length must be a positive integer");
  }
  return webCrypto().getRandomValues(new Uint8Array(length));
}
function generateSessionSecret() {
  return randomBytes(32);
}
function createNoncePrefix() {
  return randomBytes(8);
}
async function deriveDataChannelKey(secret, hostNonce, joinNonce, context) {
  if (secret.byteLength !== 32) throw new RangeError("A session secret must be exactly 32 bytes");
  if (hostNonce.byteLength !== 16 || joinNonce.byteLength !== 16) {
    throw new RangeError("DataChannel session nonces must be exactly 16 bytes");
  }
  const keyMaterial = await webCrypto().subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  const label = encoder.encode("PairOnce DataChannel key v1");
  const extra = context ?? new Uint8Array(0);
  const info = new Uint8Array(label.byteLength + hostNonce.byteLength + joinNonce.byteLength + extra.byteLength);
  info.set(label, 0);
  info.set(hostNonce, label.byteLength);
  info.set(joinNonce, label.byteLength + hostNonce.byteLength);
  info.set(extra, label.byteLength + hostNonce.byteLength + joinNonce.byteLength);
  return webCrypto().subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("PairOnce DataChannel salt v1"),
      info
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
async function deriveDirectionalDataChannelKeys(secret, hostNonce, joinNonce, context) {
  const derive = (sender) => deriveDataChannelKey(
    secret,
    hostNonce,
    joinNonce,
    encoder.encode(JSON.stringify(["paironce-frame-v2", sender, context ? toBase64Url(context) : null]))
  );
  const [host, join] = await Promise.all([derive("host"), derive("join")]);
  return { host, join };
}
function createIv(prefix, chunkIndex) {
  if (prefix.byteLength !== 8) {
    throw new RangeError("Nonce prefix must be exactly 8 bytes");
  }
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 4294967295) {
    throw new RangeError("Chunk index must fit an unsigned 32-bit counter");
  }
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, chunkIndex, false);
  return iv;
}
function additionalData(context) {
  if (!Number.isSafeInteger(context.chunkIndex) || context.chunkIndex < 0) {
    throw new RangeError("Invalid chunk index");
  }
  if (!Number.isSafeInteger(context.totalChunks) || context.totalChunks <= 0) {
    throw new RangeError("Invalid total chunk count");
  }
  if (!Number.isSafeInteger(context.plainSize) || context.plainSize < 0) {
    throw new RangeError("Invalid plaintext size");
  }
  return encoder.encode(
    JSON.stringify([
      context.channel ? 2 : 1,
      context.transferId,
      context.kind,
      context.chunkIndex,
      context.totalChunks,
      context.plainSize,
      ...context.channel ? [context.channel.sender, context.channel.frameType] : []
    ])
  );
}
async function encryptChunk(key, noncePrefix, plaintext, context) {
  const ciphertext = await webCrypto().subtle.encrypt(
    {
      name: "AES-GCM",
      iv: createIv(noncePrefix, context.chunkIndex),
      additionalData: additionalData(context),
      tagLength: 128
    },
    key,
    plaintext
  );
  return new Uint8Array(ciphertext);
}
async function decryptChunk(key, noncePrefix, ciphertext, context) {
  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: "AES-GCM",
      iv: createIv(noncePrefix, context.chunkIndex),
      additionalData: additionalData(context),
      tagLength: 128
    },
    key,
    ciphertext
  );
  return new Uint8Array(plaintext);
}
function toBase64Url(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// ../../node_modules/@paironce/protocol/src/index.ts
import { z } from "zod";

// ../../node_modules/@paironce/protocol/src/pro-pass.ts
var PRO_PASS_MS = 24 * 36e5;

// ../../node_modules/@paironce/protocol/src/index.ts
var PROTOCOL_VERSION = 1;
var descriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string().min(1).max(64 * 1024)
});
var iceCandidateSchema = z.object({
  candidate: z.string().max(8 * 1024),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().nonnegative().nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional()
});
var MAX_FILE_CHUNKS = 1048576;
var MAX_FILE_BYTES = 1e10;
var helloSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  type: z.literal("hello"),
  role: z.enum(["host", "join"]),
  // Fresh per-connection nonce used to derive the application frame key.
  // It is public handshake context, not a credential.
  sessionNonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  // The identity fields are public device descriptors. The corresponding
  // private key never crosses the signaling channel.
  deviceId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(),
  deviceName: z.string().min(1).max(80).optional(),
  devicePublicKey: z.string().regex(/^[A-Za-z0-9_-]{40,200}$/).optional(),
  // Capabilities are negotiated per DataChannel and bound into the frame key when both sides send a list (protocol, section 5.2).
  capabilities: z.array(z.enum(["file-approval-v1", "offer-preview-v1"])).max(8).optional(),
  // Safety-code version (pairing-sas-v2). A separate field, not a capability: a peer that predates it drops unknown keys
  // instead of rejecting the whole hello, so it keeps connecting and simply cannot pair with a safety code.
  safetyCode: z.literal(2).optional(),
  // Parsed as optional to give older peers a clear refresh message; current sessions require version 2.
  frameProtocol: z.literal(2).optional(),
  // Binary file-chunk frames (binary-frame.ts). A separate optional field so a peer that predates it drops the
  // key and keeps using JSON chunks; binary frames are used only when both hellos carry it.
  binaryFileChunks: z.literal(1).optional(),
  // This side writes large incoming files to disk and accepts offers up to 2 GB.
  // A separate optional field for the same reason: a peer that predates it drops the key and keeps offering up to 50 MiB.
  largeFiles: z.literal(1).optional(),
  // This side reports how far it has handled an incoming file and keeps a sender within its receive window
  // (receive-window.ts). Optional for the same reason: without it in both hellos neither side changes.
  receiveWindow: z.literal(1).optional(),
  // This side writes files to disk and takes offers above 2 GB, up to MAX_FILE_BYTES, when its storage has room. Optional
  // like the flags above: a peer that predates it drops the key and is never offered more than 2 GB.
  hugeFiles: z.literal(1).optional(),
  // This device has PairOnce Pro. Files over 2 GB need Pro on one of the two devices; a direct transfer costs the service
  // nothing, so this is a plan boundary and the sender checks it.
  pro: z.literal(1).optional(),
  // The service's signed pass for that Pro (pro-pass.ts, 2.19.1): the other device turns Pro on only with a valid one.
  // Optional like the flags above: a peer that predates it drops the key.
  proPass: z.string().regex(/^[A-Za-z0-9_-]{40,400}\.[A-Za-z0-9_-]{86}$/).optional(),
  // This side can show and watch a live picture (camera or screen) over this connection, set up by encrypted `live`
  // frames. Optional like the flags above: a peer that predates it drops the key and is never sent a `live` frame.
  liveMedia: z.literal(1).optional()
});
var signalMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("offer"),
    sessionNonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    description: descriptionSchema.extend({ type: z.literal("offer") })
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("answer"),
    sessionNonce: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    description: descriptionSchema.extend({ type: z.literal("answer") })
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("ice"),
    candidate: iceCandidateSchema
  })
]);
var idSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
var encodedBytesSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(256 * 1024);
var noncePrefixSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
var encryptedControlSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  transferId: idSchema,
  noncePrefix: noncePrefixSchema,
  ciphertext: encodedBytesSchema,
  plainSize: z.number().int().positive().max(4096)
});
var dataFrameSchema = z.discriminatedUnion("type", [
  encryptedControlSchema.extend({ type: z.literal("pair-claim") }),
  encryptedControlSchema.extend({ type: z.literal("pair-result") }),
  encryptedControlSchema.extend({ type: z.literal("pair-confirm") }),
  encryptedControlSchema.extend({ type: z.literal("file-offer") }),
  encryptedControlSchema.extend({ type: z.literal("file-decision") }),
  encryptedControlSchema.extend({ type: z.literal("file-cancel") }),
  encryptedControlSchema.extend({ type: z.literal("file-receipt") }),
  encryptedControlSchema.extend({ type: z.literal("file-progress") }),
  // A small JPEG in a JSON envelope (offer-preview-v1): larger than the other control frames, still tiny.
  encryptedControlSchema.extend({ type: z.literal("file-preview"), plainSize: z.number().int().positive().max(24 * 1024) }),
  // Live picture set-up (live-media.ts): requests, answers, the renegotiation description and the DTLS fingerprint
  // check. Sent only to a peer whose hello carried liveMedia; a description is larger than the other control frames.
  encryptedControlSchema.extend({ type: z.literal("live"), plainSize: z.number().int().positive().max(32 * 1024) }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("text"),
    transferId: idSchema,
    noncePrefix: noncePrefixSchema,
    ciphertext: encodedBytesSchema,
    plainSize: z.number().int().nonnegative().max(256 * 1024)
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("file-meta"),
    transferId: idSchema,
    name: z.string().min(1).max(512),
    mime: z.string().max(256),
    // Up to 10 GB (MAX_FILE_BYTES). The session holds each file to the limit it
    // announced: 50 MiB unless it writes large files to disk; this schema only bounds what can be parsed.
    size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
    chunkSize: z.number().int().min(16 * 1024).max(64 * 1024),
    totalChunks: z.number().int().positive().max(MAX_FILE_CHUNKS),
    noncePrefix: noncePrefixSchema,
    // Continuing a file the receiver kept after a dropped connection: chunks before this index are already there.
    // Optional, so a peer that predates it drops the key; a sender only sets it when the receiver asked for it.
    resumeFrom: z.number().int().positive().max(MAX_FILE_CHUNKS - 1).optional()
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("file-chunk"),
    transferId: idSchema,
    index: z.number().int().nonnegative().max(MAX_FILE_CHUNKS - 1),
    ciphertext: encodedBytesSchema
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("file-complete"),
    transferId: idSchema
  }),
  z.object({
    v: z.literal(PROTOCOL_VERSION),
    type: z.literal("file-ack"),
    transferId: idSchema
  })
]);
function parseSignalMessage(input) {
  const message = signalMessageSchema.parse(input);
  if (message.type === "hello") {
    const present = [message.deviceId, message.deviceName, message.devicePublicKey].filter((item) => item !== void 0).length;
    if (present !== 0 && present !== 3) throw new Error("Device identity fields must be supplied together");
  }
  return message;
}
function parseDataFrame(input) {
  return dataFrameSchema.parse(input);
}

// ../../node_modules/@paironce/transfer/src/index.ts
function chunkCount(byteLength, chunkSize) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new RangeError("Invalid length");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError("Invalid chunk size");
  return Math.max(1, Math.ceil(byteLength / chunkSize));
}

// ../core/src/constants.ts
var FILE_CHUNK_SIZE = 32 * 1024;

// ../core/src/pairing.ts
async function deviceSessionSecret(privateKey, local, peer, nonce, room) {
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(peer.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits"]);
  const devices = [local, peer].sort((a, b) => a.id < b.id ? -1 : 1).map((d) => [d.id, d.publicKey]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: nonce,
    info: new TextEncoder().encode(JSON.stringify(["paironce-device-session-v2", room, devices]))
  }, material, 256));
}
var SAFETY_CODE_DIGITS = 13;
async function derivePairingSas(privateKey, local, peer, invitationSecret, roomId) {
  if (invitationSecret.byteLength !== 32 || !/^[A-Za-z0-9_-]{20,128}$/.test(roomId) || !isDeviceDescriptor(local) || !isDeviceDescriptor(peer)) throw new Error("Invalid pairing SAS context");
  const peerKey = await crypto.subtle.importKey("raw", fromBase64Url(peer.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peerKey }, privateKey, 256));
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const keys = [local.publicKey, peer.publicKey].sort();
  const info = new TextEncoder().encode(JSON.stringify(["paironce-pairing-sas-v2", roomId, ...keys]));
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: invitationSecret, info }, material, 64);
  const value = new DataView(bits).getBigUint64(0, false) % 10000000000000n;
  return String(value).padStart(SAFETY_CODE_DIGITS, "0");
}
async function deviceProofKey(input) {
  if (input.privateKey.type !== "private" || input.privateKey.algorithm.name !== "ECDH") {
    throw new Error("A device ECDH private key is required");
  }
  const publicBytes = fromBase64Url(input.peerPublicKey);
  if (publicBytes.byteLength !== 65 || publicBytes[0] !== 4) throw new Error("Invalid device public key");
  const publicKey = await crypto.subtle.importKey(
    "raw",
    publicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, input.privateKey, 256);
  const keyMaterial = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: input.invitationSecret,
      info: new TextEncoder().encode("PairOnce device possession proof v1")
    },
    keyMaterial,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  );
}
function deviceProofTranscript(input) {
  if (!/^(?:\d{6}|\d{13})$/.test(input.code)) throw new Error("Invalid pairing code for device proof");
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(input.claimId)) throw new Error("Invalid claim ID for device proof");
  return new TextEncoder().encode(JSON.stringify([
    "paironce-device-proof-v1",
    input.direction,
    input.roomId,
    input.claimId,
    input.host.id,
    input.host.publicKey,
    input.join.id,
    input.join.publicKey,
    input.code
  ]));
}
async function createDeviceProof(input) {
  const key = await deviceProofKey(input);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, deviceProofTranscript(input))));
}
async function verifyDeviceProof(input, proof) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const key = await deviceProofKey(input);
  return crypto.subtle.verify("HMAC", key, fromBase64Url(proof), deviceProofTranscript(input));
}
function isDeviceDescriptor(value) {
  if (!value || typeof value !== "object") return false;
  const descriptor = value;
  return typeof descriptor.id === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(descriptor.id) && typeof descriptor.name === "string" && descriptor.name.length > 0 && descriptor.name.length <= 80 && typeof descriptor.publicKey === "string" && /^[A-Za-z0-9_-]{40,200}$/.test(descriptor.publicKey);
}
function parsePairingPayload(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid pairing message");
  const payload = value;
  const claimId = payload.claimId;
  if (typeof claimId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claimId)) {
    throw new Error("Invalid pairing claim ID");
  }
  if (payload.type === "pair-claim") {
    if (typeof payload.code !== "string" || !/^(?:\d{6}|\d{13})$/.test(payload.code) || !isDeviceDescriptor(payload.device) || !isDeviceProof(payload.proof)) {
      throw new Error("Invalid pairing claim");
    }
    return { type: "pair-claim", claimId, code: payload.code, device: payload.device, proof: payload.proof };
  }
  if (payload.type === "pair-result") {
    if (typeof payload.accepted !== "boolean") throw new Error("Invalid pairing result");
    if (payload.terminal !== void 0 && typeof payload.terminal !== "boolean") throw new Error("Invalid pairing result");
    if (payload.accepted && (!isDeviceDescriptor(payload.device) || !isDeviceProof(payload.proof))) {
      throw new Error("Pairing result omitted host device or proof");
    }
    if (payload.accepted && payload.terminal) throw new Error("Accepted pairing cannot be terminal");
    if (payload.reason !== void 0 && (typeof payload.reason !== "string" || payload.reason.length > 120)) {
      throw new Error("Invalid pairing rejection reason");
    }
    return {
      type: "pair-result",
      claimId,
      accepted: payload.accepted,
      ...isDeviceDescriptor(payload.device) ? { device: payload.device } : {},
      ...isDeviceProof(payload.proof) ? { proof: payload.proof } : {},
      ...typeof payload.reason === "string" ? { reason: payload.reason } : {},
      ...typeof payload.terminal === "boolean" ? { terminal: payload.terminal } : {}
    };
  }
  if (payload.type === "pair-confirm" && isDeviceProof(payload.proof)) {
    return { type: "pair-confirm", claimId, proof: payload.proof };
  }
  throw new Error("Unknown pairing message type");
}
function isDeviceProof(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
function equalPairingCodes(expected, actual) {
  if (!/^(?:\d{6}|\d{13})$/.test(expected) || actual.length !== expected.length || !/^\d+$/.test(actual)) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return mismatch === 0;
}

// ../core/src/binary-frame.ts
var MAGIC = 80;
var VERSION = 1;
var FILE_CHUNK = 1;
var ID = /^[A-Za-z0-9_-]{16,128}$/;
var MAX_INDEX = MAX_FILE_CHUNKS - 1;
var MAX_CIPHERTEXT = 64 * 1024 + 16;
var MAX_BINARY_FRAME_BYTES = 8 + 128 + MAX_CIPHERTEXT;
function encodeFileChunk(transferId, index, ciphertext) {
  if (!ID.test(transferId)) throw new Error("Invalid transfer ID for a binary frame");
  if (!Number.isSafeInteger(index) || index < 0 || index > MAX_INDEX) throw new Error("Invalid chunk index for a binary frame");
  if (ciphertext.byteLength < 17 || ciphertext.byteLength > MAX_CIPHERTEXT) throw new Error("Invalid ciphertext size for a binary frame");
  const id = new TextEncoder().encode(transferId);
  const frame = new Uint8Array(8 + id.byteLength + ciphertext.byteLength);
  frame[0] = MAGIC;
  frame[1] = VERSION;
  frame[2] = FILE_CHUNK;
  frame[3] = id.byteLength;
  frame.set(id, 4);
  new DataView(frame.buffer).setUint32(4 + id.byteLength, index, false);
  frame.set(ciphertext, 8 + id.byteLength);
  return frame.buffer;
}
function decodeBinaryFrame(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 8 + 16 + 17 || data.byteLength > MAX_BINARY_FRAME_BYTES) {
    throw new Error("Binary frame size is out of range");
  }
  const bytes = new Uint8Array(data);
  if (bytes[0] !== MAGIC || bytes[1] !== VERSION) throw new Error("Unknown binary frame format");
  if (bytes[2] !== FILE_CHUNK) throw new Error("Unknown binary frame type");
  const idLength = bytes[3];
  if (idLength < 16 || idLength > 128 || 8 + idLength + 17 > bytes.byteLength) throw new Error("Invalid binary frame header");
  let transferId = "";
  for (let i = 4; i < 4 + idLength; i++) transferId += String.fromCharCode(bytes[i]);
  if (!ID.test(transferId)) throw new Error("Invalid binary frame header");
  const index = new DataView(data).getUint32(4 + idLength, false);
  if (index > MAX_INDEX) throw new Error("File chunk index is out of range");
  return { type: "file-chunk", transferId, index, ciphertext: new Uint8Array(data, 8 + idLength) };
}

// ../core/src/chunk-assembler.ts
var ASSEMBLY_RUN_BYTES = 4 * 1024 * 1024;
var ChunkAssembler = class {
  #total;
  #runLimit;
  #next = 0;
  #early = /* @__PURE__ */ new Map();
  #run = [];
  #runBytes = 0;
  #parts = [];
  constructor(totalChunks, runLimit = ASSEMBLY_RUN_BYTES) {
    if (!Number.isSafeInteger(totalChunks) || totalChunks < 1) throw new RangeError("A file needs at least one chunk");
    this.#total = totalChunks;
    this.#runLimit = runLimit;
  }
  add(index, chunk) {
    if (!Number.isSafeInteger(index) || index < this.#next || index >= this.#total || this.#early.has(index)) {
      throw new Error("File chunk index is out of order");
    }
    this.#early.set(index, chunk);
    for (let next = this.#early.get(this.#next); next; next = this.#early.get(this.#next)) {
      this.#early.delete(this.#next);
      this.#next += 1;
      this.#run.push(next);
      this.#runBytes += next.byteLength;
      if (this.#runBytes >= this.#runLimit) this.#flush();
    }
  }
  get complete() {
    return this.#next === this.#total;
  }
  /** Bytes still held by the page (the current run and any early chunks), for tests and diagnostics. */
  get heldBytes() {
    let early = 0;
    for (const chunk of this.#early.values()) early += chunk.byteLength;
    return this.#runBytes + early;
  }
  /** The whole file as one Blob. Joining Blob parts does not copy their bytes into the page. */
  finish(type) {
    if (!this.complete) throw new Error("File completion arrived before all chunks");
    this.#flush();
    const blob = new Blob(this.#parts, { type });
    this.#parts = [];
    return blob;
  }
  /** Drop everything, for a cancelled or failed transfer. */
  clear() {
    this.#early.clear();
    this.#run = [];
    this.#runBytes = 0;
    this.#parts = [];
  }
  #flush() {
    if (this.#run.length === 0) return;
    this.#parts.push(new Blob(this.#run));
    this.#run = [];
    this.#runBytes = 0;
  }
};

// ../core/src/receive-window.ts
var RECEIVE_WINDOW_BYTES = 16 * 1024 * 1024;
var PROGRESS_STEP_BYTES = 2 * 1024 * 1024;
var RECEIVE_WINDOW_CHUNKS = RECEIVE_WINDOW_BYTES / FILE_CHUNK_SIZE;
var PROGRESS_STEP_CHUNKS = PROGRESS_STEP_BYTES / FILE_CHUNK_SIZE;
var RECEIVE_STALL_MS = 12e4;
var RECEIVE_STALL_MESSAGE = "The receiving browser stopped saving this file; try sending it again";
function progressDue(next, reported, total, step = PROGRESS_STEP_CHUNKS) {
  return next < total && next - reported >= step;
}
var SendWindow = class {
  constructor(start, total, limit = RECEIVE_WINDOW_CHUNKS) {
    this.total = total;
    this.limit = limit;
    this.#acked = start;
  }
  total;
  limit;
  #acked;
  #wake;
  get acked() {
    return this.#acked;
  }
  /** Take a report. Old, repeated or impossible values are ignored, so a replayed report cannot move the window. */
  acknowledge(next) {
    if (!Number.isSafeInteger(next) || next <= this.#acked || next > this.total) return false;
    this.#acked = next;
    const wake = this.#wake;
    this.#wake = void 0;
    wake?.();
    return true;
  }
  /** Resolves once chunk `index` may be sent. Rejects when `signal` aborts or no report arrives for `stallMs`. */
  async before(index, signal, stallMs = RECEIVE_STALL_MS) {
    while (index - this.#acked >= this.limit) {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const done = (error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (this.#wake === wake) this.#wake = void 0;
          if (error) reject(error);
          else resolve();
        };
        const onAbort = () => done(signal.reason ?? new Error("File transfer cancelled"));
        const wake = () => done();
        const timer = setTimeout(() => done(new Error(RECEIVE_STALL_MESSAGE)), stallMs);
        signal.addEventListener("abort", onAbort, { once: true });
        this.#wake = wake;
      });
    }
  }
};

// ../../apps/app/src/abort.ts
function anySignal(signals) {
  const native = AbortSignal.any;
  if (typeof native === "function") return native.call(AbortSignal, [...signals]);
  const controller = new AbortController();
  const cleanups = [];
  const finish = (source) => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    controller.abort(source.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      finish(signal);
      break;
    }
    const onAbort = () => finish(signal);
    signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", onAbort));
  }
  return controller.signal;
}
function timeoutSignal(milliseconds) {
  const native = AbortSignal.timeout;
  if (typeof native === "function") return native.call(AbortSignal, milliseconds);
  const controller = new AbortController();
  setTimeout(() => {
    let reason;
    try {
      reason = new DOMException("The operation timed out.", "TimeoutError");
    } catch {
      reason = new Error("The operation timed out.");
    }
    controller.abort(reason);
  }, milliseconds);
  return controller.signal;
}

// ../../apps/app/src/file-control.ts
var MAX_FILE_SIZE = 5e7;
var LARGE_FILE_MAX_BYTES = 2e9;
var PRO_FILE_MAX_BYTES = 1e10;
function isTransferId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}
function parseFileControlPayload(raw, maxSize = MAX_FILE_SIZE) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid file control message");
  }
  if (!value || typeof value !== "object") throw new Error("Invalid file control message");
  const input = value;
  if (!isTransferId(input.transferId) || typeof input.type !== "string") throw new Error("Invalid file control message");
  if (input.type === "file-offer") {
    const size = input.size;
    const chunkSize = input.chunkSize;
    const totalChunks = input.totalChunks;
    if (typeof input.name !== "string" || input.name.length < 1 || input.name.length > 512 || typeof input.mime !== "string" || input.mime.length > 256 || !Number.isSafeInteger(size) || size < 0 || size > maxSize || chunkSize !== FILE_CHUNK_SIZE || !Number.isSafeInteger(totalChunks) || totalChunks !== chunkCount(size, FILE_CHUNK_SIZE)) throw new Error("Invalid file offer");
    if (input.resumeKey !== void 0 && !isTransferId(input.resumeKey)) throw new Error("Invalid file offer");
    return {
      type: "file-offer",
      transferId: input.transferId,
      name: input.name,
      mime: input.mime,
      size,
      chunkSize,
      totalChunks,
      ...input.resumeKey !== void 0 ? { resumeKey: input.resumeKey } : {}
    };
  }
  if (input.type === "file-decision") {
    if (!["accept", "reject", "busy", "timeout"].includes(input.decision)) throw new Error("Invalid file decision");
    if (input.resumeFrom !== void 0 && (input.decision !== "accept" || !Number.isSafeInteger(input.resumeFrom) || input.resumeFrom < 1)) {
      throw new Error("Invalid file decision");
    }
    if (input.privateMeta !== void 0 && (input.privateMeta !== true || input.decision !== "accept")) throw new Error("Invalid file decision");
    return {
      type: "file-decision",
      transferId: input.transferId,
      decision: input.decision,
      ...input.resumeFrom !== void 0 ? { resumeFrom: input.resumeFrom } : {},
      ...input.privateMeta === true ? { privateMeta: true } : {}
    };
  }
  if (input.type === "file-cancel") {
    if (input.reason !== void 0 && (typeof input.reason !== "string" || input.reason.length > 256)) throw new Error("Invalid file cancellation");
    return { type: "file-cancel", transferId: input.transferId, reason: input.reason };
  }
  if (input.type === "file-receipt") {
    if (input.stage !== "received" && input.stage !== "saved") throw new Error("Invalid file receipt");
    return { type: "file-receipt", transferId: input.transferId, stage: input.stage };
  }
  if (input.type === "file-progress") {
    if (!Number.isSafeInteger(input.next) || input.next < 1) throw new Error("Invalid file progress");
    return { type: "file-progress", transferId: input.transferId, next: input.next };
  }
  throw new Error("Unknown file control message");
}
function offerToPayload(offer) {
  return { type: "file-offer", ...offer };
}

// ../../apps/app/src/debug-flags.ts
function fromAddress(flag) {
  try {
    return typeof window !== "undefined" && new URL(window.location.href).searchParams.get(flag) === "1";
  } catch {
    return false;
  }
}
function fromStorage(flag) {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(`paironce.${flag}`) === "1";
  } catch {
    return false;
  }
}
function debugFlagOff(flag) {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(`paironce.${flag}`) === "0";
  } catch {
    return false;
  }
}
function debugFlag(flag) {
  return define_import_meta_env_default.DEV && fromAddress(flag) || fromStorage(flag);
}

// ../../apps/app/src/offer-preview.ts
var PREVIEW_MAX_BYTES = 12 * 1024;
var PREVIEW_MAX_SIDE = 160;
var PREVIEW_MAX_DECODE_SIDE = 256;
var PREVIEW_MIN_BYTES = 125;
var PREVIEW_QUALITIES = [0.72, 0.58, 0.45, 0.32];
var PREVIEW_SIDES = [PREVIEW_MAX_SIDE, 112];
var PREVIEW_TIMEOUT_MS = 4e3;
var SOURCE_TYPES = /^image\/(?:jpeg|png|webp)$/;
var MAX_SOURCE_BYTES = 5e7;
function previewEligible(mime, size) {
  return SOURCE_TYPES.test(mime.split(";", 1)[0].trim().toLowerCase()) && Number.isSafeInteger(size) && size > 0 && size <= MAX_SOURCE_BYTES;
}
function fitWithin(width, height, max) {
  if (!(width > 0) || !(height > 0)) return { width: 1, height: 1 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return void 0;
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 255) return void 0;
    let marker = bytes[at + 1];
    while (marker === 255 && at + 2 < bytes.length) {
      at += 1;
      marker = bytes[at + 1];
    }
    if (marker === 216 || marker === 1 || marker >= 208 && marker <= 215) {
      at += 2;
      continue;
    }
    if (marker === 217 || marker === 218) return void 0;
    const length = bytes[at + 2] << 8 | bytes[at + 3];
    if (length < 2 || at + 2 + length > bytes.length) return void 0;
    if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
      if (length < 8) return void 0;
      const height = bytes[at + 5] << 8 | bytes[at + 6];
      const width = bytes[at + 7] << 8 | bytes[at + 8];
      return width > 0 && height > 0 ? { width, height } : void 0;
    }
    at += 2 + length;
  }
  return void 0;
}
function validateOfferPreview(bytes) {
  if (bytes.length < PREVIEW_MIN_BYTES || bytes.length > PREVIEW_MAX_BYTES) return false;
  if (bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) return false;
  const size = jpegDimensions(bytes);
  return size !== void 0 && size.width <= PREVIEW_MAX_DECODE_SIDE && size.height <= PREVIEW_MAX_DECODE_SIDE;
}
function encodeOfferPreviewPayload(transferId, image) {
  return new TextEncoder().encode(JSON.stringify({ type: "file-preview", transferId, mime: "image/jpeg", data: toBase64Url(image) }));
}
function parseOfferPreviewPayload(raw, transferId) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (!value || typeof value !== "object") return void 0;
  const input = value;
  if (input.type !== "file-preview" || input.transferId !== transferId || input.mime !== "image/jpeg" || typeof input.data !== "string") return void 0;
  if (input.data.length > Math.ceil(PREVIEW_MAX_BYTES * 4 / 3) + 4) return void 0;
  let image;
  try {
    image = fromBase64Url(input.data);
  } catch {
    return void 0;
  }
  return validateOfferPreview(image) ? image : void 0;
}
function createCanvas(width, height) {
  try {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
  } catch {
  }
  return void 0;
}
function encodeJpeg(canvas, quality) {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) return canvas.convertToBlob({ type: "image/jpeg", quality });
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}
function withTimeout(work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("preview timed out")), ms);
    work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
async function makeOfferPreview(file) {
  if (typeof createImageBitmap !== "function" || !previewEligible(file.type, file.size)) return void 0;
  let bitmap;
  try {
    bitmap = await withTimeout(createImageBitmap(file, { imageOrientation: "from-image" }), PREVIEW_TIMEOUT_MS);
    for (const side of PREVIEW_SIDES) {
      const { width, height } = fitWithin(bitmap.width, bitmap.height, side);
      const canvas = createCanvas(width, height);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return void 0;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of PREVIEW_QUALITIES) {
        const blob = await encodeJpeg(canvas, quality);
        if (!blob) return void 0;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.byteLength <= PREVIEW_MAX_BYTES) return validateOfferPreview(bytes) ? bytes : void 0;
      }
    }
    return void 0;
  } catch {
    return void 0;
  } finally {
    bitmap?.close();
  }
}

// ../../apps/app/src/live-media.ts
var RECORDING_MS = { free: 5 * 6e4, pro: 60 * 6e4 };
var LIVE_CONTROL_MAX_BYTES = 32 * 1024;
var LIVE_ANSWER_TIMEOUT_MS = 6e4;
var LIVE_NEGOTIATION_TIMEOUT_MS = 15e3;
var ID2 = /^[A-Za-z0-9_-]{16,128}$/;
var FINGERPRINT = /^sha-(?:256|384|512) (?:[0-9A-F]{2}:){31,63}[0-9A-F]{2}$/;
function exactKeys(value, keys) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function parseLivePayload(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Invalid live control message");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid live control message");
  const v = value;
  const id = typeof v.id === "string" && ID2.test(v.id);
  switch (v.op) {
    case "fingerprint":
      if (exactKeys(v, ["op", "value"]) && typeof v.value === "string" && FINGERPRINT.test(v.value)) return { op: "fingerprint", value: v.value };
      break;
    case "request":
      if (exactKeys(v, ["op", "id", "kind"]) && id && (v.kind === "camera" || v.kind === "screen")) return { op: "request", id: v.id, kind: v.kind };
      break;
    case "answer":
      if (exactKeys(v, ["op", "id", "accept"]) && id && typeof v.accept === "boolean") return { op: "answer", id: v.id, accept: v.accept };
      break;
    case "sdp": {
      const d = v.description;
      if (exactKeys(v, ["op", "id", "description"]) && id && d && typeof d === "object" && exactKeys(d, ["type", "sdp"]) && (d.type === "offer" || d.type === "answer") && typeof d.sdp === "string" && d.sdp.length > 0 && d.sdp.length <= LIVE_CONTROL_MAX_BYTES)
        return { op: "sdp", id: v.id, description: { type: d.type, sdp: d.sdp } };
      break;
    }
    case "stop":
    case "shutter":
      if (exactKeys(v, ["op", "id"]) && id) return { op: v.op, id: v.id };
      break;
    case "shutter-file":
      if (exactKeys(v, ["op", "id", "transferId"]) && id && typeof v.transferId === "string" && ID2.test(v.transferId))
        return { op: "shutter-file", id: v.id, transferId: v.transferId };
      break;
  }
  throw new Error("Invalid live control message");
}
function sdpFingerprints(sdp) {
  if (!sdp) return [];
  const found = /* @__PURE__ */ new Set();
  for (const match of sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/gm)) found.add(`${match[1].toLowerCase()} ${match[2].toUpperCase()}`);
  return [...found];
}
function fingerprintMatches(reported, remoteSdp) {
  const remote = sdpFingerprints(remoteSdp);
  return remote.length === 1 && remote[0] === reported;
}

// ../../apps/app/src/session.ts
var PRO_FILE_MESSAGE = "Files over 2 GB need PairOnce Pro on one of the two devices.";
var RELAY_CREDENTIAL_ATTEMPTS = 3;
var NEARBY_RENEW_MS = 25e3;
var RETRYABLE_RELAY_STATUS = /* @__PURE__ */ new Set([500, 502, 503, 504]);
var PRIVATE_META_NAME = "-";
var MAX_RECEIVE_BYTES = 1e8;
var RELAY_SESSION_BYTE_LIMIT = 32 * 1024 * 1024;
var RELAY_LIMIT_MESSAGE = "This connection uses the relay, and the relay allowance left for this device is not enough for this file. Choose a smaller file, or put both devices on the same Wi-Fi.";
var RELAY_QUOTA_MESSAGE = "This device has used this month's relay allowance";
var RELAY_REPORT_BYTES = 4 * 1024 * 1024;
var MAX_DATA_FRAME_CHARS = 512 * 1024;
var MAX_QUEUED_FRAMES = 8192;
var MAX_QUEUED_BYTES = 128 * 1024 * 1024;
var MAX_CONTROL_FRAME_KEYS = 2e5;
var BUFFER_HIGH_WATER = 512 * 1024;
var BUFFER_POLL_MS = 250;
var DIRECT_RETRY_TIMEOUT_MS = 15e3;
var DISCONNECT_RECOVERY_TIMEOUT_MS = 45e3;
var FILE_ACK_TIMEOUT_MS = 3e4;
var READ_BLOCK_BYTES = 32 * FILE_CHUNK_SIZE;
var FILE_OFFER_TIMEOUT_MS = 18e4;
var FILE_DECISION_TIMEOUT_MS = FILE_OFFER_TIMEOUT_MS + 15e3;
var FILE_META_TIMEOUT_MS = 3e4;
var MAX_PENDING_FILE_OFFERS = 16;
var LIVE_RELAY_BITRATE = 15e5;
var MAX_FILE_HISTORY = 256;
var PAIRING_RESPONSE_TIMEOUT_MS = 9e4;
var MAX_PAIRING_ATTEMPTS = 3;
function shouldRetryWithTurn(input) {
  return (input.relayAllowed ?? true) && !input.forceRelay && input.retryCount < 1 && !input.channelReady;
}
function isLoopbackHostname(hostname) {
  return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(hostname);
}
function signalingOrigin() {
  const configured = "https://paironce.com"?.trim() || void 0;
  if (typeof window !== "undefined" && isLoopbackHostname(window.location.hostname)) {
    if (configured) {
      try {
        const endpoint = new URL(configured);
        if (/^(https?|wss?):$/.test(endpoint.protocol) && isLoopbackHostname(endpoint.hostname)) return configured;
      } catch {
      }
    }
    return window.location.origin;
  }
  return configured ?? (typeof window !== "undefined" ? window.location.origin : "http://localhost:8787");
}
function acceptFrameKey(seen, key) {
  if (!key || seen.has(key)) return false;
  seen.add(key);
  return true;
}
var UNOPENED_PART = {
  write: async () => {
    throw new Error("This kept part is not open");
  },
  finish: async () => {
    throw new Error("This kept part is not open");
  },
  abort: async () => {
  },
  park: async () => {
  }
};
function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    operation.then((value) => {
      cleanup();
      if (!signal.aborted) resolve(value);
    }, (error) => {
      cleanup();
      reject(error);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}
var SIGNAL_PING_MS = 25e3;
var SIGNAL_PING = '{"type":"ping"}';
var SIGNAL_PONG = '{"type":"pong"}';
var CODE_RATE_LIMIT_RETRY_MS = [5e3, 15e3, 45e3];
function codeRetryDelay(status, limitedSoFar) {
  return status === 429 ? CODE_RATE_LIMIT_RETRY_MS[limitedSoFar] : void 0;
}
var PeerSession = class {
  #roomId;
  #role;
  #secret;
  #callbacks;
  #options;
  #sessionId = toBase64Url(randomBytes(24));
  #deviceClaim;
  #receiveQueuedFrames = 0;
  #receiveQueuedBytes = 0;
  /** Fresh public context for deriving the current DataChannel frame key. */
  #channelNonce = randomBytes(16);
  #peerChannelNonce;
  #incomingFiles = /* @__PURE__ */ new Map();
  #pendingFileAcks = /* @__PURE__ */ new Map();
  /** Files being sent under the peer's receive window, by transfer ID. */
  #sendWindows = /* @__PURE__ */ new Map();
  #pendingFileDecisions = /* @__PURE__ */ new Map();
  #activeFileAborters = /* @__PURE__ */ new Map();
  #pendingFileOffers = /* @__PURE__ */ new Map();
  #acceptedFileOffers = /* @__PURE__ */ new Map();
  #receivedFileHistory = /* @__PURE__ */ new Map();
  #closedFileTransfers = /* @__PURE__ */ new Set();
  #closedFileTransferOrder = [];
  #seenPairingClaims = /* @__PURE__ */ new Set();
  #receivedFrameKeys = /* @__PURE__ */ new Set();
  #controlFrameKeys = 0;
  #pendingCandidates = [];
  #socket;
  #signalKeepAlive;
  #nearbyTimer;
  #nearbyListed = false;
  #peer;
  #channel;
  #frameKey;
  #frameKeyPromise;
  #peerFrameProtocol = false;
  #agreementPeer;
  #peerPromise;
  #offered = false;
  #echoedHello = false;
  #receiveChain = Promise.resolve();
  #signalChain = Promise.resolve();
  #forceRelay;
  #retryCount = 0;
  #connectionReady = false;
  #connectionTimer;
  #disconnectTimer;
  #disconnectRetryTimer;
  #relayExpiresAt;
  #relayExpiryTimer;
  #relayRenewalTimer;
  #relayRenewing = false;
  #peerGeneration = 0;
  #retryPromise;
  #closed = false;
  #transportAbort = new AbortController();
  #paired = false;
  #pairedPeerIdentity;
  #pairingAttempts = 0;
  #pairingClaimId;
  #pairingCodeEntered;
  #pairingCodeForClaim;
  #pendingPeerIdentity;
  #awaitingHostApproval = false;
  #pairingDenied = false;
  #readyPath;
  #pairingTimer;
  #relayChallengePending;
  #peerCapabilities = /* @__PURE__ */ new Set();
  // Whether the peer's hello carried a capabilities field at all. Only then does the frame key bind the lists.
  #peerSentCapabilities = false;
  // Whether the peer's hello announced the safety-code version (pairing-sas-v2).
  #peerSafetyCode = false;
  /** This page announces binary file-chunk frames. */
  #localBinaryChunks;
  /** Both hellos announced binary file-chunk frames (binary-frame.ts). */
  #peerBinaryChunks = false;
  // The peer writes large files to disk and takes offers up to LARGE_FILE_MAX_BYTES.
  #peerLargeFiles = false;
  #peerHugeFiles = false;
  #peerPro = false;
  // Both hellos announced the receive window (receive-window.ts, 2026-10-21 audit F02).
  #peerReceiveWindow = false;
  #peerLiveMedia = false;
  /** The peer's DTLS fingerprint, reported over the encrypted channel, matched the description signaling delivered. */
  #liveVerified = false;
  #pendingLiveFingerprint;
  #live;
  /** The live picture that ended last: its closing renegotiation is still accepted. */
  #liveLastId;
  #liveAnswer;
  #liveSdpAnswer;
  #liveChain = Promise.resolve();
  #realtimeOnly;
  #relayFallback;
  /** Payload bytes sent, received or reserved on this connection while it runs through the relay. */
  #relayBytes = 0;
  /** The most #relayBytes may reach: what was reported plus what the server said is left, or 32 MiB without an allowance. */
  #relayLimit = RELAY_SESSION_BYTE_LIMIT;
  /** Whether the server names a monthly allowance; only then is usage reported. */
  #relayAllowance = false;
  #relayReported = 0;
  #relayUnreported = 0;
  #relayReporting;
  constructor(roomId, role, secret, callbacks, options = {}) {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(roomId)) throw new Error("Invalid room ID");
    if (secret.byteLength !== 32) throw new Error("Invalid invitation secret");
    this.#roomId = roomId;
    this.#role = role;
    this.#secret = secret;
    this.#callbacks = callbacks;
    this.#options = options;
    this.#realtimeOnly = true;
    this.#relayFallback = true;
    this.#agreementPeer = options.deviceKeyAgreement ? options.expectedPeerIdentity : void 0;
    if (options.deviceKeyAgreement && !options.requirePairing) throw new Error("Device key agreement requires explicit pairing approval");
    if (options.requirePairing) {
      if (!options.identity) throw new Error("A local device identity is required for pairing");
      if (!options.identityPrivateKey || options.identityPrivateKey.type !== "private" || options.identityPrivateKey.algorithm.name !== "ECDH" || options.identityPrivateKey.extractable) {
        throw new Error("The non-exportable device ECDH private key is required for pairing");
      }
      if (role === "host" && (!options.deviceKeyAgreement && !/^\d{6}$/.test(options.pairingCode ?? "") || !Number.isSafeInteger(options.pairingExpiresAt))) {
        throw new Error("A six-digit code and expiry are required for the pairing host");
      }
      if (role === "join" && !isDeviceDescriptor(options.expectedPeerIdentity)) {
        throw new Error("The invitation must pin the expected host device identity");
      }
    }
    this.#forceRelay = !options.directOnly && (!this.#realtimeOnly || this.#relayFallback) && (options.forceRelay ?? debugFlag("forceRelay"));
    this.#localBinaryChunks = options.binaryFileChunks ?? !debugFlagOff("binaryChunks");
  }
  async connect() {
    this.#closed = false;
    this.#sessionId = toBase64Url(randomBytes(24));
    this.#deviceClaim = await this.#options.deviceClaim?.(this.#sessionId).catch(() => void 0);
    this.#channelNonce = randomBytes(16);
    this.#peerChannelNonce = void 0;
    this.#peerFrameProtocol = false;
    this.#frameKey = void 0;
    this.#frameKeyPromise = void 0;
    this.#paired = false;
    this.#pairedPeerIdentity = void 0;
    this.#peerCapabilities.clear();
    this.#peerSentCapabilities = false;
    this.#peerSafetyCode = false;
    this.#peerBinaryChunks = false;
    this.#peerLargeFiles = false;
    this.#peerHugeFiles = false;
    this.#peerPro = false;
    this.#peerReceiveWindow = false;
    this.#peerLiveMedia = false;
    this.#liveVerified = false;
    this.#pendingLiveFingerprint = void 0;
    this.#live = void 0;
    this.#openSignaling(false);
  }
  #openSignaling(recovering) {
    const endpoint = this.#edgeEndpoint(`/v1/pair/${this.#roomId}`, "websocket");
    endpoint.searchParams.set("session", this.#sessionId);
    endpoint.searchParams.set("device", this.#options.identity?.id ?? randomId());
    if (this.#deviceClaim) {
      endpoint.searchParams.set("key", this.#deviceClaim.key);
      endpoint.searchParams.set("proof", this.#deviceClaim.proof);
      endpoint.searchParams.set("at", String(this.#deviceClaim.at));
    }
    if (!recovering) this.#callbacks.onStatus("Connecting to the rendezvous service\u2026");
    const socket = new WebSocket(endpoint);
    this.#socket = socket;
    clearInterval(this.#signalKeepAlive);
    socket.addEventListener("open", () => {
      if (this.#closed || this.#socket !== socket) return;
      this.#signalKeepAlive = setInterval(() => {
        if (this.#socket === socket && socket.readyState === WebSocket.OPEN) socket.send(SIGNAL_PING);
      }, SIGNAL_PING_MS);
      if (!recovering) this.#callbacks.onStatus("Waiting for the other browser\u2026");
      this.#sendHello();
      if (!recovering && this.#options.publishConnectionCode) void this.#publishConnectionCode();
      if (recovering) this.#attemptDisconnectRecovery();
    });
    socket.addEventListener("message", (event) => {
      if (event.data === SIGNAL_PONG) return;
      if (this.#socket === socket) this.#queueSignal(event.data);
    });
    socket.addEventListener("error", () => {
      if (this.#socket === socket && !this.#closed && !this.#connectionReady) this.#callbacks.onError("The signaling connection failed.");
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket === socket) clearInterval(this.#signalKeepAlive);
      if (this.#closed || this.#socket !== socket) return;
      if (this.#relayChallengePending) {
        clearTimeout(this.#relayChallengePending.timer);
        this.#relayChallengePending.reject(new Error("The signaling connection closed"));
        this.#relayChallengePending = void 0;
      }
      if (this.#connectionReady && this.#peer && this.#channel?.readyState === "open") {
        if ([1003, 1008, 1009].includes(event.code)) {
          this.#endTransferChannel();
          return;
        }
        this.#beginDisconnectRecovery(this.#peer);
        this.#scheduleDisconnectRetry();
      } else if (!event.wasClean && !this.#channel) this.#callbacks.onError("The signaling connection closed early.");
    });
  }
  async #publishConnectionCode() {
    try {
      if (this.#role !== "host" || !this.#options.deviceKeyAgreement || !this.#options.identity) throw new Error("invalid_host");
      let response;
      const pool = this.#options.connectionPool;
      let limited = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.#closed) return;
        const poolCode = pool?.code();
        response = await fetch(this.#edgeEndpoint(`/v1/pair/${this.#roomId}/connection-code`, "http"), {
          // Code-Notify: this page understands the `code-claimed` signal (older pages would treat it as an error).
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-PairOnce-Session": this.#sessionId,
            "X-PairOnce-Code-Notify": "1",
            ...pool ? { "X-PairOnce-Pool": poolCode ? `${poolCode}.${pool.key}` : pool.key } : {}
          },
          body: JSON.stringify({
            roomId: this.#roomId,
            nonce: toBase64Url(this.#secret),
            host: this.#options.identity,
            expiresAt: this.#options.pairingExpiresAt
          }),
          signal: timeoutSignal(1e4)
        });
        const wait = codeRetryDelay(response.status, limited);
        if (wait !== void 0) {
          limited += 1;
          attempt -= 1;
          await new Promise((resolve) => setTimeout(resolve, wait));
          continue;
        }
        if (response.status !== 409) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (response?.status === 429) throw new Error("code_limited");
      if (response?.status === 404 && pool?.code()) throw new Error("code_expired");
      if (!response?.ok) throw new Error("code_unavailable");
      const result = await response.json();
      if (typeof result.code !== "string" || !/^\d{6}$/.test(result.code)) throw new Error("invalid_code");
      if (!this.#closed) this.#callbacks.onConnectionCode?.(result.code);
      if (!this.#closed && this.#options.nearby && !pool) void this.#renewNearby();
    } catch (error) {
      if (this.#closed) return;
      const reason = error instanceof Error && error.message === "code_limited" ? "limited" : error instanceof Error && error.message === "code_expired" ? "expired" : void 0;
      this.#callbacks.onConnectionCodeUnavailable?.(reason);
    }
  }
  /**
   * A disk probe that finished after this session started (2.13.5): while the session has not met its peer yet, it takes
   * the receiver, so the hello it sends when the other device arrives already announces large files. The code stays.
   */
  adoptDiskReceive(disk) {
    if (this.#closed || this.#options.diskReceive || this.#echoedHello || this.#connectionReady) return false;
    this.#options.diskReceive = disk;
    return true;
  }
  /** Put this waiting connection in its network's nearby list, or take it out; then again in NEARBY_RENEW_MS (2.20.0). */
  async #renewNearby() {
    clearTimeout(this.#nearbyTimer);
    if (this.#closed || !this.#options.nearby || this.#role !== "host") return;
    if (this.#connectionReady || this.#paired || this.#peer) {
      this.#nearbyListed = false;
      return;
    }
    const visible = this.#options.nearby();
    if (visible || this.#nearbyListed) {
      try {
        const response = await fetch(this.#edgeEndpoint(`/v1/pair/${this.#roomId}/nearby`, "http"), {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PairOnce-Session": this.#sessionId },
          body: JSON.stringify({ visible }),
          signal: timeoutSignal(1e4)
        });
        const result = response.ok ? await response.json() : void 0;
        this.#nearbyListed = result?.listed === true;
      } catch {
      }
    }
    if (!this.#closed) this.#nearbyTimer = setTimeout(() => void this.#renewNearby(), NEARBY_RENEW_MS);
  }
  /** The person switched "Visible on this Wi-Fi": tell the list now rather than at the next renewal. */
  nearbyChanged() {
    if (!this.#closed && this.#options.nearby && !this.#options.connectionPool) void this.#renewNearby();
  }
  /** Host only: publish a fresh one-time code (after the previous one was used without anyone arriving). */
  refreshConnectionCode() {
    if (!this.#closed && this.#role === "host" && this.#options.publishConnectionCode) void this.#publishConnectionCode();
  }
  close() {
    if (this.#closed) return;
    clearInterval(this.#signalKeepAlive);
    clearTimeout(this.#nearbyTimer);
    void this.flushRelayUsage();
    this.#closed = true;
    this.#transportAbort.abort(new Error("The transfer channel closed"));
    this.#clearConnectionTimer();
    this.#clearDisconnectTimer();
    this.#clearRelayTimers();
    this.#clearPairingTimer();
    this.#connectionReady = false;
    if (this.#relayChallengePending) {
      clearTimeout(this.#relayChallengePending.timer);
      this.#relayChallengePending.reject(new Error("The connection closed"));
      this.#relayChallengePending = void 0;
    }
    this.#awaitingHostApproval = false;
    this.#live = void 0;
    this.#liveAnswer?.settle("cancel");
    this.#liveSdpAnswer?.reject(new Error("The connection closed"));
    this.#pendingPeerIdentity = void 0;
    this.#pairingClaimId = void 0;
    this.#pairingCodeEntered = void 0;
    this.#pairingCodeForClaim = void 0;
    this.#paired = false;
    this.#pairedPeerIdentity = void 0;
    this.#rejectPendingFileAcks("The transfer channel closed before receipt confirmation");
    this.#rejectPendingFileDecisions("The transfer channel closed before file approval");
    this.#channel?.close();
    this.#peer?.close();
    this.#socket?.close(1e3, "client closed");
    this.#channel = void 0;
    this.#peer = void 0;
    this.#peerPromise = void 0;
    this.#discardIncomingFiles();
    for (const transferId of this.#pendingFileOffers.keys()) this.#removePendingFileOffer(transferId);
    this.#keepAcceptedPartials();
    this.#pendingFileOffers.clear();
    this.#receivedFileHistory.clear();
    this.#closedFileTransfers.clear();
    this.#closedFileTransferOrder.length = 0;
    this.#receivedFrameKeys.clear();
    this.#controlFrameKeys = 0;
    this.#frameKey = void 0;
    this.#frameKeyPromise = void 0;
    this.#peerChannelNonce = void 0;
  }
  /** Return the current server-bound session context after local pairing. */
  getPairingAuthorizationContext() {
    if (!this.#paired || !this.#options.identity || !this.#pairedPeerIdentity) return void 0;
    return {
      roomId: this.#roomId,
      sessionId: this.#sessionId,
      deviceId: this.#options.identity.id,
      peerDeviceId: this.#pairedPeerIdentity.id
    };
  }
  /** Revoke the active peer's server-side paired-inbox authorizations. */
  async revokePairedPeer() {
    const context = this.getPairingAuthorizationContext();
    if (!context) throw new Error("The paired session is not active");
    const endpoint = this.#edgeEndpoint(
      `/v1/pair/${encodeURIComponent(context.roomId)}/devices/${encodeURIComponent(context.peerDeviceId)}/revoke`,
      "http"
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PairOnce-Session": context.sessionId },
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => void 0);
      throw new Error(typeof payload?.error === "string" ? `Device revocation failed: ${payload.error}` : `Device revocation failed (${response.status})`);
    }
  }
  /** Called by the joining browser after the user reads the host's code. */
  async submitPairingCode(code) {
    if (!this.#options.requirePairing || this.#role !== "join") throw new Error("This session does not accept a pairing code");
    if (!/^(?:\d{6}|\d{13})$/.test(code)) throw new Error("Enter the code shown on the other device");
    if (!this.#connectionReady || this.#channel?.readyState !== "open") throw new Error("Wait for the secure channel before confirming the code");
    if (this.#paired) return;
    if (this.#pairingDenied) throw new Error("Pairing was declined; start a new session");
    if (this.#pairingAttempts >= MAX_PAIRING_ATTEMPTS) throw new Error("Too many pairing attempts; start a new session");
    if (this.#pairingClaimId && this.#pairingCodeEntered === code) return;
    if (this.#pairingClaimId) throw new Error("Waiting for the other device to confirm the previous code");
    const claimId = randomId();
    this.#pairingClaimId = claimId;
    this.#pairingCodeEntered = code;
    try {
      await this.#registerCodeAttempt(claimId);
      if (this.#closed || this.#pairingClaimId !== claimId) throw new Error("The pairing session closed");
      const proof = await createDeviceProof({
        privateKey: this.#options.identityPrivateKey,
        peerPublicKey: this.#options.expectedPeerIdentity.publicKey,
        invitationSecret: this.#secret,
        roomId: this.#roomId,
        claimId,
        host: this.#options.expectedPeerIdentity,
        join: this.#options.identity,
        code,
        direction: "join-claim"
      });
      this.#pairingAttempts += 1;
      await this.#sendPairingFrame("pair-claim", {
        type: "pair-claim",
        claimId,
        code,
        device: this.#options.identity,
        proof
      });
      this.#startPairingTimer();
      this.#callbacks.onStatus("Confirming the code with the other device\u2026");
    } catch (error) {
      this.#pairingClaimId = void 0;
      this.#pairingCodeEntered = void 0;
      throw error;
    }
  }
  /** Return the deterministic v2 SAS for the joining device. */
  async getPairingSas() {
    if (!this.#options.deviceKeyAgreement || this.#role !== "join" || !this.#options.identity || !this.#options.expectedPeerIdentity) {
      throw new Error("This session does not expose a pairing SAS");
    }
    return this.#safetyCodeFor(this.#options.expectedPeerIdentity);
  }
  /** The capabilities this side names in its hello. An empty list means the hello carries no capabilities field. */
  #localCapabilities() {
    return [
      ...this.#options.fileApproval ? ["file-approval-v1"] : [],
      ...this.#options.fileApproval && this.#options.offerPreview ? ["offer-preview-v1"] : []
    ];
  }
  /**
   * When both hellos carried capability lists, both lists go into the frame key, in role order. A signalling hop that
   * strips one list then leaves the two ends with different keys, so frames fail closed. A peer that sent no list keeps
   * the original derivation, so older text-only peers still work.
   */
  #capabilityContext() {
    const local = this.#localCapabilities().sort();
    if (!this.#peerSentCapabilities || local.length === 0) return void 0;
    const peer = [...this.#peerCapabilities].sort();
    const [host, join] = this.#role === "host" ? [local, peer] : [peer, local];
    return new TextEncoder().encode(JSON.stringify(["paironce-capabilities-v1", host, join]));
  }
  /**
   * The safety code both ends must show. It needs the safety-code version (pairing-sas-v2) from the other device. Without
   * it the session refuses, rather than falling back to a shorter code that a signalling attacker could search for.
   */
  #safetyCodeFor(peer) {
    if (!this.#peerSafetyCode) throw new Error("The other device needs an update before pairing. Refresh both pages.");
    return derivePairingSas(this.#options.identityPrivateKey, this.#options.identity, peer, this.#secret, this.#roomId);
  }
  // Same-origin HTTP calls must retain private staging/access cookies.
  // Fetch still omits cookies when a separate signaling origin is configured.
  async #registerCodeAttempt(claimId) {
    const endpoint = this.#edgeEndpoint(`/v1/pair/${this.#roomId}/code-attempt`, "http");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PairOnce-Session": this.#sessionId },
      body: JSON.stringify({ claimId }),
      cache: "no-store",
      credentials: "same-origin"
    });
    if (response.status === 429) throw new Error("Too many pairing-code attempts; wait before trying again");
    if (!response.ok) throw new Error("Pairing protection is unavailable; try a new private link");
  }
  async #verifyCodeAttempt(claimId, deviceId) {
    const endpoint = this.#edgeEndpoint(
      `/v1/pair/${this.#roomId}/code-attempt/${encodeURIComponent(claimId)}/verify`,
      "http"
    );
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PairOnce-Session": this.#sessionId },
      body: JSON.stringify({ deviceId }),
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error("The pairing-code attempt was not authorized");
  }
  /**
   * Host only, after it approved the device and checked its final proof: tell the service the pairing finished, for its
   * daily totals (no identifiers kept there). A failure changes nothing about the pairing.
   */
  async #reportPairingComplete(claimId) {
    try {
      await fetch(this.#edgeEndpoint(`/v1/pair/${this.#roomId}/code-attempt/${encodeURIComponent(claimId)}/complete`, "http"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PairOnce-Session": this.#sessionId },
        body: "{}",
        cache: "no-store",
        credentials: "same-origin"
      });
    } catch {
    }
  }
  /** Host only: a valid code and joining-device proof still require a local human decision. */
  async approvePairing() {
    if (this.#role !== "host" || !this.#options.requirePairing || !this.#awaitingHostApproval || !this.#pairingClaimId || !this.#pendingPeerIdentity || this.#closed || this.#pairingDenied) {
      throw new Error("No joining device is waiting for host approval");
    }
    if (Date.now() >= (this.#options.pairingExpiresAt ?? 0)) {
      await this.#rejectHostApproval("Pairing code expired; start a new session");
      throw new Error("Pairing code expired; start a new session");
    }
    this.#awaitingHostApproval = false;
    const claimId = this.#pairingClaimId;
    const peer = this.#pendingPeerIdentity;
    try {
      const hostProof = await createDeviceProof({
        privateKey: this.#options.identityPrivateKey,
        peerPublicKey: peer.publicKey,
        invitationSecret: this.#secret,
        roomId: this.#roomId,
        claimId,
        host: this.#options.identity,
        join: peer,
        code: this.#pairingCodeForClaim ?? this.#options.pairingCode,
        direction: "host-approve"
      });
      if (this.#closed || this.#pairingClaimId !== claimId || this.#pendingPeerIdentity !== peer) {
        throw new Error("The pairing request is no longer active");
      }
      await this.#sendPairingFrame("pair-result", {
        type: "pair-result",
        claimId,
        accepted: true,
        device: this.#options.identity,
        proof: hostProof
      });
      this.#startPairingTimer();
      this.#callbacks.onStatus("Host approved; waiting for the joining device to confirm.");
    } catch (error) {
      if (!this.#closed && this.#pairingClaimId === claimId && this.#pendingPeerIdentity === peer) {
        this.#awaitingHostApproval = true;
      }
      throw error;
    }
  }
  /** Host only: refuse the pending device without issuing an acceptance proof. */
  async rejectPairing() {
    if (this.#role !== "host" || !this.#awaitingHostApproval || !this.#pendingPeerIdentity || this.#closed) {
      throw new Error("No joining device is waiting for host approval");
    }
    await this.#rejectHostApproval("Host declined pairing; start a new session");
  }
  async #rejectHostApproval(reason) {
    const claimId = this.#pairingClaimId;
    if (!claimId) throw new Error("No joining device is waiting for host approval");
    this.#awaitingHostApproval = false;
    this.#pairingDenied = true;
    this.#clearPairingTimer();
    this.#pendingPeerIdentity = void 0;
    this.#pairingClaimId = void 0;
    try {
      await this.#sendPairingFrame("pair-result", {
        type: "pair-result",
        claimId,
        accepted: false,
        reason,
        terminal: true
      });
    } finally {
      this.#callbacks.onPairingRejected?.(reason, true);
      this.#callbacks.onStatus(reason);
    }
  }
  async sendText(text) {
    this.#requirePairing();
    const plaintext = new TextEncoder().encode(text);
    if (plaintext.byteLength === 0 || plaintext.byteLength > 128 * 1024) {
      throw new Error("Text must be between 1 byte and 128 KiB");
    }
    const relayed = this.#relayed();
    const relayClaim = relayed ? this.#claimRelay(plaintext.byteLength) : void 0;
    if (relayed && !relayClaim) throw new Error(RELAY_LIMIT_MESSAGE);
    try {
      const transferId = randomId();
      const noncePrefix = createNoncePrefix();
      const ciphertext = await encryptChunk(await this.#requiredKey("send"), noncePrefix, plaintext, {
        channel: this.#frameContext("send", "text"),
        transferId,
        kind: "text",
        chunkIndex: 0,
        totalChunks: 1,
        plainSize: plaintext.byteLength
      });
      this.#sendFrame({
        v: PROTOCOL_VERSION,
        type: "text",
        transferId,
        noncePrefix: toBase64Url(noncePrefix),
        ciphertext: toBase64Url(ciphertext),
        plainSize: plaintext.byteLength
      });
      this.#useRelay(relayClaim, plaintext.byteLength);
    } catch (error) {
      this.#releaseRelay(relayClaim);
      throw error;
    }
  }
  /** Whether the negotiated peer supports aborting one file without closing the session. */
  canCancelFileIndependently() {
    return this.#fileApprovalNegotiated();
  }
  /** Accept a pending authenticated offer without blocking the receive chain. */
  async acceptFile(transferId) {
    this.#requirePairing();
    const pending = this.#pendingFileOffers.get(transferId);
    if (!pending) throw new Error("This file offer is no longer pending");
    this.#removePendingFileOffer(transferId);
    const resume = this.#matchingPartial(pending);
    const needed = this.#stillNeeded(pending, resume);
    const room = await this.#roomFor(pending.size, 0, needed);
    if (this.#closed || this.#closedFileTransfers.has(transferId)) return;
    const relayed = this.#relayed();
    const relayClaim = relayed && room ? this.#claimRelay(needed) : void 0;
    if (!room || relayed && !relayClaim) {
      this.#rememberClosedTransfer(transferId);
      await this.#sendFileControl({ type: "file-decision", transferId, decision: "busy" });
      return;
    }
    if (resume) this.#options.diskReceive.takePartial(resume);
    const timer = setTimeout(() => {
      this.#acceptedFileOffers.delete(transferId);
      this.#releaseRelay(relayClaim);
      if (resume) void this.#options.diskReceive.discardPartial(resume);
      this.#rememberClosedTransfer(transferId);
      void this.#sendFileControl({ type: "file-cancel", transferId, reason: "offer_expired" }).catch(() => {
      });
    }, FILE_META_TIMEOUT_MS);
    this.#acceptedFileOffers.set(transferId, { ...pending, timer, relayClaim, ...resume ? { resume } : {} });
    try {
      await this.#sendFileControl({ type: "file-decision", transferId, decision: "accept", privateMeta: true, ...resume ? { resumeFrom: resume.next } : {} });
    } catch (error) {
      clearTimeout(timer);
      this.#acceptedFileOffers.delete(transferId);
      this.#releaseRelay(relayClaim);
      if (resume) void this.#options.diskReceive.discardPartial(resume);
      this.#rememberClosedTransfer(transferId);
      throw error;
    }
  }
  /** Reject a pending offer; the peer keeps the session for other files. */
  async rejectFile(transferId) {
    this.#requirePairing();
    const pending = this.#pendingFileOffers.get(transferId);
    if (!pending) throw new Error("This file offer is no longer pending");
    this.#removePendingFileOffer(transferId);
    this.#rememberClosedTransfer(transferId);
    await this.#sendFileControl({ type: "file-decision", transferId, decision: "reject" });
  }
  /** Confirm that the caller has durably saved a received file in the OS/app. */
  async confirmFileSaved(transferId) {
    this.#requirePairing();
    const receipt = this.#receivedFileHistory.get(transferId);
    if (!receipt) throw new Error("This received file is no longer available for confirmation");
    if (receipt.stage === "saved") return;
    if (this.#fileApprovalNegotiated()) await this.#sendFileControl({ type: "file-receipt", transferId, stage: "saved" });
    receipt.stage = "saved";
  }
  /** Cancel one active send while preserving the paired channel for other files. */
  cancelFile(transferId) {
    const controller = this.#activeFileAborters.get(transferId);
    if (!controller) return false;
    controller.abort(new DOMException("File transfer cancelled", "AbortError"));
    return true;
  }
  #fileApprovalNegotiated() {
    return this.#options.fileApproval === true && this.#peerCapabilities.has("file-approval-v1");
  }
  /** Thumbnails are only exchanged when both sides asked for them and file approval itself is in force. */
  #previewNegotiated() {
    return this.#options.offerPreview === true && this.#fileApprovalNegotiated() && this.#peerCapabilities.has("offer-preview-v1");
  }
  /** Send the thumbnail after the offer, never before it, so a slow image decode cannot delay the question. */
  #sendOfferPreview(file, transferId, signal) {
    if (!this.#previewNegotiated() || this.#relayed() || !previewEligible(file.type, file.size)) return;
    void (async () => {
      const image = await (this.#options.makePreview ?? makeOfferPreview)(file);
      if (!image || signal.aborted || this.#closed || !this.#pendingFileDecisions.has(transferId)) return;
      const payload = encodeOfferPreviewPayload(transferId, image);
      const noncePrefix = createNoncePrefix();
      const ciphertext = await encryptChunk(await this.#requiredKey("send"), noncePrefix, payload, {
        channel: this.#frameContext("send", "file-preview"),
        transferId,
        kind: "text",
        chunkIndex: 0,
        totalChunks: 1,
        plainSize: payload.byteLength
      });
      signal.throwIfAborted();
      if (!this.#pendingFileDecisions.has(transferId)) return;
      this.#sendFrame({
        v: PROTOCOL_VERSION,
        type: "file-preview",
        transferId,
        noncePrefix: toBase64Url(noncePrefix),
        ciphertext: toBase64Url(ciphertext),
        plainSize: payload.byteLength
      });
    })().catch(() => {
    });
  }
  /**
   * A thumbnail is a courtesy, so everything unexpected about one is dropped quietly: it never ends the session or
   * raises an error. It is shown only for an offer that is still waiting, once, and only if it passes the size,
   * dimension and format checks before any decoder sees it.
   */
  async #handleFilePreview(frame, signal) {
    if (!this.#previewNegotiated() || !this.#pendingFileOffers.has(frame.transferId)) return;
    if (!acceptFrameKey(this.#receivedFrameKeys, `file-preview:${frame.transferId}`)) return;
    let image;
    try {
      const plaintext = await decryptChunk(await this.#requiredKey("receive"), fromBase64Url(frame.noncePrefix), fromBase64Url(frame.ciphertext), {
        channel: this.#frameContext("receive", frame.type),
        transferId: frame.transferId,
        kind: "text",
        chunkIndex: 0,
        totalChunks: 1,
        plainSize: frame.plainSize
      });
      image = parseOfferPreviewPayload(new TextDecoder("utf-8", { fatal: true }).decode(plaintext), frame.transferId);
    } catch {
      return;
    }
    signal.throwIfAborted();
    if (!image || !this.#pendingFileOffers.has(frame.transferId)) return;
    try {
      this.#callbacks.onFileOfferPreview?.(frame.transferId, image);
    } catch {
    }
  }
  async #requestFileDecision(offer, signal, afterOfferSent) {
    if (this.#pendingFileDecisions.size >= MAX_PENDING_FILE_OFFERS) throw new Error("Too many file offers are already awaiting a decision");
    const decision = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingFileDecisions.delete(offer.transferId);
        resolve({ decision: "timeout" });
      }, FILE_DECISION_TIMEOUT_MS);
      this.#pendingFileDecisions.set(offer.transferId, { resolve, reject, timer });
    });
    const waiting = abortable(decision, signal);
    void waiting.catch(() => {
    });
    try {
      await abortable(this.#sendFileControl(offerToPayload(offer), signal), signal);
    } catch (error) {
      const pending = this.#pendingFileDecisions.get(offer.transferId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingFileDecisions.delete(offer.transferId);
        pending.reject(error instanceof Error ? error : new Error("File offer could not be sent"));
      }
      throw error;
    }
    try {
      afterOfferSent?.();
    } catch {
    }
    return waiting;
  }
  /** Whether a file of this size is written to disk rather than held in page memory. */
  #toDisk(size) {
    return Boolean(this.#options.diskReceive && size > this.#options.diskReceive.threshold);
  }
  /** Page memory taken by files arriving now (disk-bound files do not count). */
  #incomingBytes() {
    return [...this.#incomingFiles.values()].reduce((sum, file) => sum + (file.sink ? 0 : file.size), 0);
  }
  #acceptedFileBytes() {
    return [...this.#acceptedFileOffers.values()].reduce((sum, file) => sum + (this.#toDisk(file.size) ? 0 : file.size), 0);
  }
  /** Disk space already promised to accepted or arriving disk-bound files (the part not yet written). */
  #diskPromisedBytes() {
    let bytes = 0;
    for (const file of this.#incomingFiles.values()) if (file.sink) bytes += Math.max(0, file.size - file.next * file.chunkSize);
    for (const file of this.#acceptedFileOffers.values()) if (this.#toDisk(file.size)) bytes += this.#stillNeeded(file, file.resume);
    return bytes;
  }
  /** Bytes still to come for a file: all of it, or what follows the part a kept file already holds (2026-10-21 audit, F06). */
  #stillNeeded(offer, resume) {
    return resume ? Math.max(0, offer.size - resume.next * resume.chunkSize) : offer.size;
  }
  /** Room for one more incoming file of `size`: page memory for small files, disk space for large ones (`needed` of it). */
  async #roomFor(size, extraMemory = 0, needed = size) {
    if (this.#toDisk(size)) {
      const available = await this.#options.diskReceive.available().catch(() => 0);
      return this.#diskPromisedBytes() + needed <= available;
    }
    return this.#incomingBytes() + this.#acceptedFileBytes() + extraMemory + (this.#options.retainedReceiveBytes?.() ?? 0) + size <= MAX_RECEIVE_BYTES;
  }
  /** The connection is gone: memory files are dropped; a disk file that can be continued is kept for its sender. */
  #discardIncomingFiles() {
    const disk = this.#options.diskReceive;
    for (const file of this.#incomingFiles.values()) {
      file.assembler?.clear();
      if (!file.sink) continue;
      if (disk && file.resumeKey && file.peerId && file.entry && file.next > 0 && file.next < file.totalChunks) {
        void disk.keepPartial({
          peerId: file.peerId,
          resumeKey: file.resumeKey,
          entry: file.entry,
          name: file.name,
          mime: file.mime,
          size: file.size,
          chunkSize: file.chunkSize,
          totalChunks: file.totalChunks,
          next: file.next
        }, file.sink).catch(() => {
        });
      } else void file.sink.abort();
    }
    this.#incomingFiles.clear();
  }
  /**
   * The connection is gone before an accepted file's data came: a part this device kept goes back to be continued later,
   * not lost with the attempt (2.19.3, audit R09), and what the attempt reserved of the relay is returned.
   */
  #keepAcceptedPartials() {
    const disk = this.#options.diskReceive;
    for (const file of this.#acceptedFileOffers.values()) {
      clearTimeout(file.timer);
      this.#releaseRelay(file.relayClaim);
      if (disk && file.resume) void disk.keepPartial(file.resume, UNOPENED_PART).catch(() => {
      });
    }
    this.#acceptedFileOffers.clear();
  }
  /** A kept, cut-off file this offer continues: same device, same chosen file, same layout. */
  #matchingPartial(offer) {
    const disk = this.#options.diskReceive;
    const peerId = this.#pairedPeerIdentity?.id;
    if (!disk || !offer.resumeKey || !peerId || !this.#toDisk(offer.size)) return void 0;
    const partial = disk.findPartial(peerId, offer.resumeKey);
    return partial && partial.name === offer.name && partial.mime === offer.mime && partial.size === offer.size && partial.chunkSize === offer.chunkSize && partial.totalChunks === offer.totalChunks && partial.next > 0 && partial.next < offer.totalChunks ? partial : void 0;
  }
  /** Whether the other device takes files up to LARGE_FILE_MAX_BYTES. */
  peerTakesLargeFiles() {
    return this.#peerLargeFiles;
  }
  /** The largest file this connection can send now, by the same rules sendFile applies (live review: say it up front). */
  sendLimit() {
    if (!this.#peerLargeFiles) return MAX_FILE_SIZE;
    return this.#peerHugeFiles && this.#proConnection() ? PRO_FILE_MAX_BYTES : LARGE_FILE_MAX_BYTES;
  }
  /** One of the two devices has Pro: this connection may carry files over 2 GB. Checked by the sender, with its own Pro
   * read now, so Pro activated during a connection counts at once. */
  #proConnection() {
    return Boolean(this.#options.isPro?.()) || this.#peerPro;
  }
  /** The same for the page (2.17.0): scan pages and resolution, live picture quality and recording length follow it. */
  proConnection() {
    return this.#proConnection();
  }
  /**
   * The largest file this side takes: up to 10 GB when it writes to disk (it announced hugeFiles), 50 MB in memory.
   * Whether a file over 2 GB is allowed by plan is the sender's check: the receiver's view of the peer's Pro comes from a
   * hello that can be older than a licence activated since. Room on disk is checked for each offer (#roomFor).
   */
  #receiveLimit() {
    return this.#options.diskReceive ? PRO_FILE_MAX_BYTES : MAX_FILE_SIZE;
  }
  async #sendFileControl(payload, signal = this.#transportAbort.signal) {
    signal.throwIfAborted();
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    if (plaintext.byteLength > 4096) throw new Error("File control message is too large");
    const noncePrefix = createNoncePrefix();
    const ciphertext = await encryptChunk(await this.#requiredKey("send"), noncePrefix, plaintext, {
      channel: this.#frameContext("send", payload.type),
      transferId: payload.transferId,
      kind: "text",
      chunkIndex: 0,
      totalChunks: 1,
      plainSize: plaintext.byteLength
    });
    signal.throwIfAborted();
    this.#sendFrame({
      v: PROTOCOL_VERSION,
      type: payload.type,
      transferId: payload.transferId,
      noncePrefix: toBase64Url(noncePrefix),
      ciphertext: toBase64Url(ciphertext),
      plainSize: plaintext.byteLength
    });
  }
  #rememberClosedTransfer(transferId) {
    if (this.#closedFileTransfers.has(transferId)) return;
    this.#closedFileTransfers.add(transferId);
    this.#closedFileTransferOrder.push(transferId);
    while (this.#closedFileTransferOrder.length > MAX_FILE_HISTORY) {
      const old = this.#closedFileTransferOrder.shift();
      if (old) this.#closedFileTransfers.delete(old);
    }
  }
  #forgetClosedTransfer(transferId) {
    this.#closedFileTransfers.delete(transferId);
    for (let index = this.#closedFileTransferOrder.length - 1; index >= 0; index -= 1) {
      if (this.#closedFileTransferOrder[index] === transferId) this.#closedFileTransferOrder.splice(index, 1);
    }
  }
  /** True when this connection runs through the relay, so the per-connection byte limit applies. */
  #relayed() {
    return this.#readyPath === "turn";
  }
  /** Reserve bytes against the relay limit; undefined (and no change) when they would not fit. */
  #claimRelay(size) {
    if (this.#relayBytes + size > this.#relayLimit) return void 0;
    this.#relayBytes += size;
    return { unused: size };
  }
  /** Mark reserved bytes as carried: they have crossed the relay and stay counted. */
  #useRelay(claim, bytes) {
    if (claim) {
      claim.unused = Math.max(0, claim.unused - bytes);
      this.#noteRelayed(bytes);
    }
  }
  /** What this device may still relay this month, or undefined where the server names no allowance. */
  relayAllowanceLeft() {
    return this.#relayAllowance ? Math.max(0, this.#relayLimit - this.#relayBytes) : void 0;
  }
  #noteRelayed(bytes) {
    if (!this.#relayAllowance || bytes <= 0) return;
    this.#relayUnreported += bytes;
    if (this.#relayUnreported >= RELAY_REPORT_BYTES) void this.flushRelayUsage();
  }
  #setRelayLeft(left) {
    this.#relayLimit = this.#relayReported + Math.max(0, left);
    try {
      this.#callbacks.onRelayAllowance?.(Math.max(0, this.#relayLimit - this.#relayBytes));
    } catch {
    }
  }
  /**
   * Tell the server what this device relayed since the last report, and learn what is left. Called every few MiB, when the
   * session closes and when the page goes away. A report that fails is kept for the next one.
   */
  async flushRelayUsage() {
    if (!this.#relayAllowance || this.#relayUnreported < 1 || this.#relayReporting) return this.#relayReporting;
    const bytes = this.#relayUnreported;
    this.#relayUnreported = 0;
    this.#relayReported += bytes;
    this.#relayReporting = (async () => {
      try {
        const response = await fetch(this.#edgeEndpoint(`/v1/pair/${this.#roomId}/relay-usage`, "http"), {
          method: "POST",
          keepalive: true,
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-PairOnce-Session": this.#sessionId },
          body: JSON.stringify({ bytes }),
          signal: timeoutSignal(1e4)
        });
        if (!response.ok) throw new Error("relay usage not recorded");
        const payload = await response.json();
        if (typeof payload.relayRemaining === "number" && payload.relayRemaining >= 0) this.#setRelayLeft(payload.relayRemaining);
      } catch {
        this.#relayReported -= bytes;
        this.#relayUnreported += bytes;
      } finally {
        this.#relayReporting = void 0;
      }
    })();
    return this.#relayReporting;
  }
  /** Give back what a transfer reserved but never carried. Safe to call again: it returns each byte once. */
  /** Give back `bytes` of a reservation that will not be used, at most what is still unused. */
  #returnRelay(claim, bytes) {
    if (!claim || bytes <= 0) return;
    const back = Math.min(claim.unused, bytes);
    claim.unused -= back;
    this.#relayBytes = Math.max(0, this.#relayBytes - back);
  }
  #releaseRelay(claim) {
    if (!claim) return;
    this.#relayBytes = Math.max(0, this.#relayBytes - claim.unused);
    claim.unused = 0;
  }
  /** `resumeKey`: the same for every attempt at this chosen file, so a device that kept part of it can continue. */
  async sendFile(file, transferId = randomId(), signal, options = {}) {
    this.#requirePairing();
    if (file.size > PRO_FILE_MAX_BYTES) throw new Error("Live files are limited to 10 GB each. Choose a smaller file.");
    if (file.size > MAX_FILE_SIZE && !this.#peerLargeFiles) {
      throw new Error("The other device's browser takes files up to 50 MB. Open PairOnce there in Chrome, Edge or Firefox, or on iOS 26, for larger files.");
    }
    if (file.size > LARGE_FILE_MAX_BYTES) {
      if (!this.#peerHugeFiles) throw new Error("The other device needs an update before it can take files over 2 GB. Refresh PairOnce there.");
      if (!this.#proConnection()) throw new Error(PRO_FILE_MESSAGE);
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(transferId)) throw new Error("Invalid file transfer ID");
    if (this.#activeFileAborters.has(transferId)) throw new Error("This file transfer is already active");
    if (this.#options.fileApproval && !this.#fileApprovalNegotiated()) {
      throw new Error("The other device does not support file approval. Refresh it, then send again.");
    }
    const approvalNegotiated = this.#fileApprovalNegotiated();
    const resumeKey = approvalNegotiated && this.#peerLargeFiles && options.resumeKey && isTransferId(options.resumeKey) ? options.resumeKey : void 0;
    const relayed = this.#relayed();
    let relayClaim = relayed ? this.#claimRelay(file.size) : void 0;
    const relayAfterAnswer = relayed && !relayClaim && Boolean(resumeKey) && this.#relayLimit > this.#relayBytes;
    if (relayed && !relayClaim && !relayAfterAnswer) throw new Error(RELAY_LIMIT_MESSAGE);
    const localAbort = new AbortController();
    this.#activeFileAborters.set(transferId, localAbort);
    const operationSignal = anySignal([this.#transportAbort.signal, localAbort.signal, ...signal ? [signal] : []]);
    let announced = false;
    let offerSent = false;
    let privateMeta = false;
    try {
      operationSignal.throwIfAborted();
      const totalChunks = chunkCount(file.size, FILE_CHUNK_SIZE);
      let startChunk = 0;
      const noncePrefix = createNoncePrefix();
      const first = await abortable(file.slice(0, FILE_CHUNK_SIZE).arrayBuffer(), operationSignal);
      operationSignal.throwIfAborted();
      if (approvalNegotiated) {
        offerSent = true;
        const answer2 = await this.#requestFileDecision(
          {
            transferId,
            name: file.name,
            mime: file.type || "application/octet-stream",
            size: file.size,
            chunkSize: FILE_CHUNK_SIZE,
            totalChunks,
            ...resumeKey ? { resumeKey } : {}
          },
          operationSignal,
          () => this.#sendOfferPreview(file, transferId, operationSignal)
        );
        const decision = answer2.decision;
        privateMeta = answer2.privateMeta === true;
        if (answer2.resumeFrom !== void 0) {
          if (!resumeKey || answer2.resumeFrom >= totalChunks) throw new Error("The receiving browser asked to continue from an invalid point");
          startChunk = answer2.resumeFrom;
          this.#returnRelay(relayClaim, startChunk * FILE_CHUNK_SIZE);
        }
        if (decision !== "accept") {
          this.#rememberClosedTransfer(transferId);
          throw new Error(decision === "reject" ? "The receiving browser declined this file" : decision === "busy" ? "The receiving browser is busy; try this file again" : "The receiving browser did not answer this file offer in time");
        }
        if (relayAfterAnswer) {
          relayClaim = this.#claimRelay(file.size - startChunk * FILE_CHUNK_SIZE);
          if (!relayClaim) throw new Error(RELAY_LIMIT_MESSAGE);
        }
      }
      this.#sendFrame({
        v: PROTOCOL_VERSION,
        type: "file-meta",
        transferId,
        // The name and type already went in the encrypted offer; the receiver takes them from there.
        ...privateMeta ? { name: PRIVATE_META_NAME, mime: "" } : { name: file.name, mime: file.type || "application/octet-stream" },
        size: file.size,
        chunkSize: FILE_CHUNK_SIZE,
        totalChunks,
        noncePrefix: toBase64Url(noncePrefix),
        ...startChunk > 0 ? { resumeFrom: startChunk } : {}
      });
      announced = true;
      const window2 = this.#useReceiveWindow() ? new SendWindow(startChunk, totalChunks) : void 0;
      if (window2) this.#sendWindows.set(transferId, window2);
      let block = startChunk === 0 ? { start: 0, bytes: new Uint8Array(first) } : { start: startChunk * FILE_CHUNK_SIZE, bytes: new Uint8Array(0) };
      for (let index = startChunk; index < totalChunks; index += 1) {
        operationSignal.throwIfAborted();
        if (window2) await window2.before(index, operationSignal);
        const start = index * FILE_CHUNK_SIZE;
        if (start >= block.start + block.bytes.byteLength) {
          block = { start, bytes: new Uint8Array(await abortable(file.slice(start, start + READ_BLOCK_BYTES).arrayBuffer(), operationSignal)) };
        }
        const offset = start - block.start;
        const plaintext = block.bytes.slice(offset, offset + Math.min(FILE_CHUNK_SIZE, file.size - start));
        operationSignal.throwIfAborted();
        const key = await abortable(this.#requiredKey("send"), operationSignal);
        const ciphertext = await abortable(encryptChunk(key, noncePrefix, plaintext, {
          channel: this.#frameContext("send", "file-chunk"),
          transferId,
          kind: "file",
          chunkIndex: index,
          totalChunks,
          plainSize: plaintext.byteLength
        }), operationSignal);
        await this.#waitForWritableChannel(operationSignal);
        operationSignal.throwIfAborted();
        if (this.#peerBinaryChunks) this.#sendBinary(encodeFileChunk(transferId, index, ciphertext));
        else this.#sendFrame({ v: PROTOCOL_VERSION, type: "file-chunk", transferId, index, ciphertext: toBase64Url(ciphertext) });
        this.#useRelay(relayClaim, plaintext.byteLength);
        this.#callbacks.onProgress(file.name, (index + 1) / totalChunks, "sent");
      }
      operationSignal.throwIfAborted();
      await this.#waitForWritableChannel(operationSignal, true);
      operationSignal.throwIfAborted();
      await abortable(new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pendingFileAcks.delete(transferId);
          reject(new Error("The receiving browser did not confirm the file in time"));
        }, FILE_ACK_TIMEOUT_MS);
        this.#pendingFileAcks.set(transferId, { resolve, reject, timer });
        this.#sendFrame({ v: PROTOCOL_VERSION, type: "file-complete", transferId });
      }), operationSignal);
      this.#releaseRelay(relayClaim);
    } catch (error) {
      this.#releaseRelay(relayClaim);
      const pending = this.#pendingFileAcks.get(transferId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#pendingFileAcks.delete(transferId);
        pending.reject(error instanceof Error ? error : new Error("File transfer cancelled"));
      }
      const pendingDecision = this.#pendingFileDecisions.get(transferId);
      if (pendingDecision) {
        clearTimeout(pendingDecision.timer);
        this.#pendingFileDecisions.delete(transferId);
        pendingDecision.reject(error instanceof Error ? error : new Error("File offer cancelled"));
      }
      if (approvalNegotiated && (offerSent || announced)) {
        this.#rememberClosedTransfer(transferId);
        try {
          await this.#sendFileControl({ type: "file-cancel", transferId, reason: operationSignal.aborted ? "cancelled" : "send_failed" });
        } catch {
        }
      } else if (announced) {
        this.#endTransferChannel();
      }
      throw error;
    } finally {
      this.#activeFileAborters.delete(transferId);
      this.#sendWindows.delete(transferId);
    }
  }
  /** The receive window applies only when both hellos announced it and file control messages are in use. */
  #useReceiveWindow() {
    return this.#peerReceiveWindow && this.#fileApprovalNegotiated();
  }
  #queueSignal(raw) {
    if (this.#closed) return;
    try {
      if (typeof raw === "string" && JSON.parse(raw)?.type === "relay-challenge") {
        void this.#handleSignal(raw);
        return;
      }
    } catch {
    }
    this.#signalChain = this.#signalChain.then(async () => {
      if (!this.#closed) await this.#handleSignal(raw);
    });
  }
  async #handleSignal(raw) {
    let renewingRelay = false;
    try {
      if (typeof raw !== "string") throw new Error("Signaling frames must be JSON text");
      const decoded = JSON.parse(raw);
      if (decoded?.v === 1 && decoded.type === "relay-challenge") {
        const pending = this.#relayChallengePending;
        if (!pending || decoded.requestId !== pending.id) return;
        clearTimeout(pending.timer);
        this.#relayChallengePending = void 0;
        if (typeof decoded.challenge === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(decoded.challenge)) pending.resolve(decoded.challenge);
        else pending.reject(new Error("Relay connection is currently unavailable"));
        return;
      }
      if (decoded?.v === 1 && decoded.type === "code-claimed") {
        if (this.#role === "host") this.#callbacks.onConnectionCodeClaimed?.();
        return;
      }
      const message = parseSignalMessage(decoded);
      if (message.type === "hello") {
        if (this.#connectionReady) return;
        if (message.role === this.#role) return;
        if (message.frameProtocol !== 2) {
          this.close();
          throw new Error("The other device needs an update before pairing. Refresh both pages.");
        }
        this.#peerFrameProtocol = true;
        this.#peerCapabilities = new Set(message.capabilities ?? []);
        this.#peerSentCapabilities = message.capabilities !== void 0;
        this.#peerSafetyCode = message.safetyCode === 2;
        this.#peerBinaryChunks = this.#localBinaryChunks && message.binaryFileChunks === 1;
        this.#peerLargeFiles = message.largeFiles === 1;
        this.#peerHugeFiles = message.hugeFiles === 1;
        this.#peerPro = false;
        const passFor = message.deviceId && message.devicePublicKey ? { id: message.deviceId, publicKey: message.devicePublicKey } : this.#agreementPeer ?? this.#options.expectedPeerIdentity;
        if (message.pro === 1 && message.proPass && passFor && this.#options.verifyProPass) {
          const generation2 = this.#peerGeneration;
          void this.#options.verifyProPass(message.proPass, passFor.id, passFor.publicKey).then((valid) => {
            if (valid && generation2 === this.#peerGeneration) this.#peerPro = true;
          }, () => {
          });
        }
        this.#peerReceiveWindow = message.receiveWindow === 1;
        this.#peerLiveMedia = message.liveMedia === 1;
        if (this.#options.deviceKeyAgreement && message.role !== this.#role) {
          const descriptor = { id: message.deviceId, name: message.deviceName, publicKey: message.devicePublicKey };
          if (!isDeviceDescriptor(descriptor)) throw new Error("The other device did not provide a valid identity");
          const pinned = this.#agreementPeer ?? this.#options.expectedPeerIdentity;
          if (pinned && (pinned.id !== descriptor.id || pinned.publicKey !== descriptor.publicKey)) {
            this.close();
            throw new Error("The other device identity changed. Create a new connection.");
          }
          this.#agreementPeer = descriptor;
        }
        const peerNonce = fromBase64Url(message.sessionNonce);
        if (peerNonce.byteLength !== 16) throw new Error("Invalid DataChannel session nonce");
        const peerRestart = this.#peerChannelNonce !== void 0 && !sameBytes(this.#peerChannelNonce, peerNonce);
        this.#setPeerChannelNonce(peerNonce);
        if (!this.#options.requirePairing && message.deviceId && message.deviceName && message.devicePublicKey) {
          this.#options.onPeerIdentity?.({
            id: message.deviceId,
            name: message.deviceName,
            publicKey: message.devicePublicKey
          });
        }
        if (this.#peer?.connectionState === "failed" && !this.#connectionReady) {
          await this.#beginRelayRetry(false);
        }
        if (message.role === this.#role) return;
        if (this.#role === "join" && message.role === "host") {
          if (peerRestart && !this.#connectionReady && !this.#forceRelay) {
            await this.#beginRelayRetry(false);
          }
          if (!this.#echoedHello) {
            this.#echoedHello = true;
            this.#sendHello();
          }
        }
        if (this.#role === "host" && message.role === "join") {
          if (!this.#echoedHello) {
            this.#echoedHello = true;
            this.#sendHello();
          }
          if (peerRestart && this.#offered && !this.#connectionReady && !this.#forceRelay) {
            await this.#beginRelayRetry(false);
          }
          await this.#makeOffer();
        }
        return;
      }
      if (message.type !== "ice") {
        const peerNonce = fromBase64Url(message.sessionNonce);
        if (peerNonce.byteLength !== 16) throw new Error("Invalid DataChannel session nonce");
        if (this.#connectionReady && !sameBytes(this.#peerChannelNonce, peerNonce)) return;
        this.#setPeerChannelNonce(peerNonce);
      }
      const generation = this.#peerGeneration;
      const peer = await this.#ensurePeer();
      this.#assertActivePeer(peer, generation);
      if (message.type === "offer" && this.#role === "join") {
        if (this.#connectionReady && this.#forceRelay) {
          renewingRelay = true;
          const iceServers = await this.#loadIceServers(true);
          if (this.#closed || this.#peer !== peer) return;
          peer.setConfiguration({ ...peer.getConfiguration(), iceServers });
        }
        await peer.setRemoteDescription(message.description);
        this.#assertActivePeer(peer, generation);
        await this.#flushCandidates(peer, generation);
        const answer2 = await peer.createAnswer();
        this.#assertActivePeer(peer, generation);
        if (!answer2.sdp) throw new Error("The browser created an empty WebRTC answer");
        await peer.setLocalDescription(answer2);
        this.#assertActivePeer(peer, generation);
        this.#sendSignal({
          v: PROTOCOL_VERSION,
          type: "answer",
          sessionNonce: toBase64Url(this.#channelNonce),
          description: { type: "answer", sdp: answer2.sdp }
        });
        this.#completeDisconnectRecovery(peer);
      } else if (message.type === "answer" && this.#role === "host") {
        await peer.setRemoteDescription(message.description);
        this.#assertActivePeer(peer, generation);
        await this.#flushCandidates(peer, generation);
        this.#completeDisconnectRecovery(peer);
      } else if (message.type === "ice") {
        if (peer.remoteDescription) await this.#applyCandidate(peer, generation, message.candidate);
        else this.#pendingCandidates.push(message.candidate);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "Peer connection superseded") return;
      this.#callbacks.onError(renewingRelay ? "Relay renewal is unavailable. Reconnect to continue; your files remain here." : error instanceof Error ? error.message : "Invalid signaling message");
      if (renewingRelay) this.#endTransferChannel();
    }
  }
  async #makeOffer() {
    if (this.#offered) return;
    this.#offered = true;
    const generation = this.#peerGeneration;
    const peer = await this.#ensurePeer();
    this.#assertActivePeer(peer, generation);
    const channel = peer.createDataChannel("paironce", { ordered: true });
    this.#attachChannel(channel);
    const offer = await peer.createOffer();
    this.#assertActivePeer(peer, generation);
    if (!offer.sdp) throw new Error("The browser created an empty WebRTC offer");
    await peer.setLocalDescription(offer);
    this.#assertActivePeer(peer, generation);
    this.#sendSignal({
      v: PROTOCOL_VERSION,
      type: "offer",
      sessionNonce: toBase64Url(this.#channelNonce),
      description: { type: "offer", sdp: offer.sdp }
    });
    this.#callbacks.onStatus("Negotiating a direct browser connection\u2026");
  }
  async #ensurePeer() {
    if (this.#peer) return this.#peer;
    this.#peerPromise ??= this.#createPeer();
    return this.#peerPromise;
  }
  async #createPeer() {
    const generation = this.#peerGeneration;
    const forceRelay = this.#forceRelay;
    const iceServers = await this.#loadIceServers(forceRelay);
    const peer = new RTCPeerConnection({
      iceServers,
      // Pre-gathering can emit candidates before the applied SDP carries the
      // matching ICE username fragment. That creates intermittent direct
      // failures, and it can allocate relay candidates before TURN is needed.
      // Gather on demand for both paths so signaling and cost accounting stay
      // aligned with the active description.
      iceCandidatePoolSize: 0,
      iceTransportPolicy: forceRelay ? "relay" : "all"
    });
    peer.addEventListener("icecandidate", (event) => {
      if (generation !== this.#peerGeneration || this.#peer !== peer || this.#closed) return;
      if (event.candidate) {
        const candidate = event.candidate.toJSON();
        this.#sendSignal({
          v: PROTOCOL_VERSION,
          type: "ice",
          candidate: {
            candidate: candidate.candidate ?? event.candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            usernameFragment: candidate.usernameFragment
          }
        });
      }
    });
    peer.addEventListener("track", (event) => {
      if (generation !== this.#peerGeneration || this.#peer !== peer || this.#closed) return;
      const live = this.#live;
      if (!live || live.role !== "view" || !live.accepted || event.track.kind !== "video") {
        event.track.stop();
        return;
      }
      live.on = true;
      try {
        this.#callbacks.onLiveStream?.(event.streams[0] ?? new MediaStream([event.track]), live.kind);
      } catch {
      }
    });
    peer.addEventListener("datachannel", (event) => {
      if (generation !== this.#peerGeneration || this.#peer !== peer || this.#closed) {
        event.channel.close();
        return;
      }
      this.#attachChannel(event.channel);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (generation !== this.#peerGeneration || this.#peer !== peer || this.#closed) return;
      if (peer.connectionState === "failed") {
        this.#handlePeerFailure(peer);
      }
      if (peer.connectionState === "disconnected" && this.#connectionReady) this.#beginDisconnectRecovery(peer);
      if (peer.connectionState === "connected") this.#completeDisconnectRecovery(peer);
    });
    if (generation !== this.#peerGeneration || this.#closed) {
      peer.close();
      throw new Error("Peer connection superseded");
    }
    this.#peer = peer;
    this.#startConnectionTimer(generation);
    return peer;
  }
  #startConnectionTimer(generation) {
    this.#clearConnectionTimer();
    this.#clearPairingTimer();
    this.#connectionTimer = setTimeout(() => {
      if (generation !== this.#peerGeneration || this.#connectionReady || this.#closed) return;
      this.#handlePeerFailure(this.#peer);
    }, DIRECT_RETRY_TIMEOUT_MS);
  }
  #clearConnectionTimer() {
    if (this.#connectionTimer !== void 0) {
      clearTimeout(this.#connectionTimer);
      this.#connectionTimer = void 0;
    }
  }
  #handlePeerFailure(peer) {
    if (this.#closed || peer && peer !== this.#peer) return;
    if (this.#connectionReady) {
      if (peer && this.#channel?.readyState === "open") this.#beginDisconnectRecovery(peer);
      else this.#endTransferChannel();
      return;
    }
    if (shouldRetryWithTurn({
      forceRelay: this.#forceRelay,
      retryCount: this.#retryCount,
      channelReady: this.#connectionReady,
      relayAllowed: !this.#options.directOnly && (!this.#realtimeOnly || this.#relayFallback)
    })) {
      this.#retryPromise ??= this.#beginRelayRetry(true).finally(() => {
        this.#retryPromise = void 0;
      });
      return;
    }
    this.#clearConnectionTimer();
    this.#callbacks.onError(
      this.#forceRelay ? "The TURN relay connection failed." : "The peer connection failed."
    );
  }
  #beginDisconnectRecovery(peer) {
    if (this.#disconnectTimer !== void 0 || this.#closed || this.#peer !== peer) return;
    const generation = this.#peerGeneration;
    this.#callbacks.onConnectivityChanged?.(false);
    this.#callbacks.onStatus("Connection interrupted. Trying to reconnect\u2026");
    this.#disconnectTimer = setTimeout(() => {
      this.#disconnectTimer = void 0;
      if (generation !== this.#peerGeneration || this.#peer !== peer || this.#closed) return;
      this.#endTransferChannel();
    }, DISCONNECT_RECOVERY_TIMEOUT_MS);
    this.#attemptDisconnectRecovery();
  }
  #attemptDisconnectRecovery() {
    if (this.#closed || this.#disconnectTimer === void 0) return;
    if (this.#disconnectRetryTimer !== void 0) clearTimeout(this.#disconnectRetryTimer);
    this.#disconnectRetryTimer = void 0;
    if (!this.#socket || this.#socket.readyState >= 2) this.#openSignaling(true);
    if (this.#socket?.readyState !== WebSocket.OPEN) {
      this.#scheduleDisconnectRetry();
      return;
    }
    if (this.#role === "host") void this.#restartIce(this.#forceRelay, true);
  }
  #scheduleDisconnectRetry() {
    if (this.#closed || this.#disconnectTimer === void 0 || this.#disconnectRetryTimer !== void 0) return;
    this.#disconnectRetryTimer = setTimeout(() => {
      this.#disconnectRetryTimer = void 0;
      this.#attemptDisconnectRecovery();
    }, 2e3);
  }
  #clearDisconnectTimer() {
    if (this.#disconnectTimer !== void 0) clearTimeout(this.#disconnectTimer);
    if (this.#disconnectRetryTimer !== void 0) clearTimeout(this.#disconnectRetryTimer);
    this.#disconnectTimer = void 0;
    this.#disconnectRetryTimer = void 0;
  }
  #completeDisconnectRecovery(peer) {
    if (this.#closed || this.#peer !== peer || this.#disconnectTimer === void 0 || peer.connectionState !== "connected" || peer.signalingState !== "stable" || this.#socket?.readyState !== WebSocket.OPEN || this.#channel?.readyState !== "open") return;
    this.#clearDisconnectTimer();
    if (this.#paired || !this.#options.requirePairing) {
      this.#callbacks.onConnectivityChanged?.(true);
      this.#callbacks.onStatus("Connection restored. You can continue sending files.");
    }
  }
  #clearRelayTimers() {
    if (this.#relayExpiryTimer !== void 0) clearTimeout(this.#relayExpiryTimer);
    if (this.#relayRenewalTimer !== void 0) clearTimeout(this.#relayRenewalTimer);
    this.#relayExpiryTimer = void 0;
    this.#relayRenewalTimer = void 0;
    this.#relayExpiresAt = void 0;
  }
  #scheduleRelayRenewal() {
    if (this.#role !== "host" || !this.#forceRelay || !this.#relayExpiresAt || this.#closed || !this.#connectionReady || this.#options.requirePairing && !this.#paired) return;
    if (this.#relayRenewalTimer !== void 0) clearTimeout(this.#relayRenewalTimer);
    const remaining = this.#relayExpiresAt - Date.now();
    const lead = Math.min(6e4, Math.floor(remaining / 3));
    this.#relayRenewalTimer = setTimeout(() => {
      this.#relayRenewalTimer = void 0;
      void this.#restartIce();
    }, Math.max(0, remaining - lead));
  }
  async #restartIce(refreshRelay = true, recovering = false) {
    const peer = this.#peer;
    if (!peer || this.#closed || this.#relayRenewing) return;
    this.#relayRenewing = true;
    try {
      const iceServers = refreshRelay ? await this.#loadIceServers(true) : void 0;
      if (this.#closed || this.#peer !== peer) return;
      if (peer.signalingState !== "stable") throw new Error("Relay negotiation is busy");
      if (iceServers) peer.setConfiguration({ ...peer.getConfiguration(), iceServers });
      const offer = await peer.createOffer({ iceRestart: true });
      if (!offer.sdp) throw new Error("Empty relay renewal offer");
      if (this.#closed || this.#peer !== peer) return;
      await peer.setLocalDescription(offer);
      if (this.#closed || this.#peer !== peer) return;
      this.#sendSignal({
        v: PROTOCOL_VERSION,
        type: "offer",
        sessionNonce: toBase64Url(this.#channelNonce),
        description: { type: "offer", sdp: offer.sdp }
      });
      this.#scheduleRelayRenewal();
    } catch {
      if (!this.#closed && this.#peer === peer) {
        if (recovering) {
          this.#scheduleDisconnectRetry();
          return;
        }
        this.#callbacks.onError(refreshRelay ? "Relay renewal is unavailable. Reconnect to continue; your files remain here." : "The peer connection failed.");
        this.#endTransferChannel();
      }
    } finally {
      this.#relayRenewing = false;
    }
  }
  #endTransferChannel() {
    if (this.#closed) return;
    this.close();
    this.#callbacks.onStatus("Transfer channel closed");
  }
  async #beginRelayRetry(notifyPeer) {
    if (this.#closed || this.#retryCount >= 1 || this.#connectionReady) return;
    this.#retryCount = 1;
    this.#forceRelay = true;
    this.#callbacks.onTransportRetry?.("turn");
    this.#callbacks.onStatus("Direct connection failed; retrying through TURN relay\u2026");
    this.#resetPeer();
    if (notifyPeer && this.#socket?.readyState === WebSocket.OPEN) this.#sendHello();
    if (this.#role === "host") {
      try {
        await this.#makeOffer();
      } catch (error) {
        this.#callbacks.onError(error instanceof Error ? error.message : "TURN relay unavailable");
      }
    }
  }
  #resetPeer() {
    this.#peerGeneration += 1;
    this.#transportAbort.abort(new Error("The transfer channel restarted"));
    this.#transportAbort = new AbortController();
    this.#channelNonce = randomBytes(16);
    this.#frameKey = void 0;
    this.#frameKeyPromise = void 0;
    this.#receivedFrameKeys.clear();
    this.#controlFrameKeys = 0;
    this.#discardIncomingFiles();
    this.#clearConnectionTimer();
    this.#rejectPendingFileAcks("The transfer channel restarted before receipt confirmation");
    this.#rejectPendingFileDecisions("The transfer channel restarted before file approval");
    for (const transferId of this.#pendingFileOffers.keys()) this.#removePendingFileOffer(transferId);
    this.#keepAcceptedPartials();
    this.#pendingFileOffers.clear();
    this.#receivedFileHistory.clear();
    this.#closedFileTransfers.clear();
    this.#closedFileTransferOrder.length = 0;
    this.#clearDisconnectTimer();
    this.#clearRelayTimers();
    this.#channel?.close();
    this.#peer?.close();
    this.#channel = void 0;
    this.#peer = void 0;
    this.#peerPromise = void 0;
    this.#pendingCandidates.length = 0;
    this.#offered = false;
    this.#connectionReady = false;
    this.#readyPath = void 0;
    this.#pairingClaimId = void 0;
    this.#pairingCodeEntered = void 0;
    this.#pendingPeerIdentity = void 0;
    this.#awaitingHostApproval = false;
  }
  #startPairingTimer() {
    this.#clearPairingTimer();
    this.#pairingTimer = setTimeout(() => {
      if (this.#paired || this.#closed) return;
      this.#pairingDenied = true;
      this.#awaitingHostApproval = false;
      this.#callbacks.onPairingRejected?.("Pairing confirmation timed out; start a new session.", true);
      this.#callbacks.onError("Pairing confirmation timed out; start a new session.");
      this.close();
    }, PAIRING_RESPONSE_TIMEOUT_MS);
  }
  #clearPairingTimer() {
    if (this.#pairingTimer !== void 0) {
      clearTimeout(this.#pairingTimer);
      this.#pairingTimer = void 0;
    }
  }
  #sendHello() {
    this.#sendSignal({
      v: PROTOCOL_VERSION,
      type: "hello",
      role: this.#role,
      frameProtocol: 2,
      ...this.#localBinaryChunks ? { binaryFileChunks: 1 } : {},
      ...this.#options.diskReceive ? { largeFiles: 1, hugeFiles: 1 } : {},
      ...this.#options.isPro?.() ? { pro: 1, ...this.#options.proPass?.() ? { proPass: this.#options.proPass() } : {} } : {},
      receiveWindow: 1,
      ...this.#options.liveMedia ? { liveMedia: 1 } : {},
      sessionNonce: toBase64Url(this.#channelNonce),
      ...this.#localCapabilities().length > 0 ? { capabilities: this.#localCapabilities() } : {},
      ...this.#options.deviceKeyAgreement ? { safetyCode: 2 } : {},
      ...(!this.#options.requirePairing || this.#options.deviceKeyAgreement) && this.#options.identity ? {
        deviceId: this.#options.identity.id,
        deviceName: this.#options.identity.name,
        devicePublicKey: this.#options.identity.publicKey
      } : {}
    });
  }
  async #loadIceServers(forceRelay) {
    const fallback = [
      { urls: "stun:stun.cloudflare.com:3478" }
    ];
    if (!forceRelay) return fallback;
    const generation = this.#peerGeneration;
    try {
      const endpoint = this.#edgeEndpoint(
        `/v1/pair/${this.#roomId}/turn-credentials`,
        "http"
      );
      let response;
      let requestedAt = Date.now();
      for (let attempt = 1; ; attempt++) {
        try {
          const challenge = await this.#requestRelayChallenge();
          requestedAt = Date.now();
          response = await fetch(endpoint, {
            method: "POST",
            headers: { Accept: "application/json", "Content-Type": "application/json", "X-PairOnce-Session": this.#sessionId },
            body: JSON.stringify({ challenge }),
            signal: anySignal([this.#transportAbort.signal, timeoutSignal(15e3)]),
            cache: "no-store",
            credentials: "same-origin"
          });
          if (response.ok || !RETRYABLE_RELAY_STATUS.has(response.status) || attempt >= RELAY_CREDENTIAL_ATTEMPTS) break;
        } catch (error) {
          if (attempt >= RELAY_CREDENTIAL_ATTEMPTS || this.#closed || this.#transportAbort.signal.aborted) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, attempt === 1 ? 1e3 : 3e3));
        if (generation !== this.#peerGeneration || this.#closed) throw new Error("Peer connection superseded");
      }
      if (!response.ok) {
        const refused = response.status === 429 ? await response.json().catch(() => ({})) : {};
        throw new Error(refused.error === "relay_quota_exhausted" ? RELAY_QUOTA_MESSAGE : `TURN credential request failed (${response.status})`);
      }
      const payload = await response.json();
      if (!isRtcIceServerList(payload.iceServers)) throw new Error("TURN credential response was invalid");
      if (!Number.isInteger(payload.ttlSeconds) || payload.ttlSeconds < 1 || payload.ttlSeconds > 900)
        throw new Error("TURN credential lifetime was invalid");
      if (generation !== this.#peerGeneration || this.#closed) throw new Error("Peer connection superseded");
      if (typeof payload.relayAllowanceBytes === "number" && Number.isSafeInteger(payload.relayAllowanceBytes) && payload.relayAllowanceBytes >= 0) {
        this.#relayAllowance = true;
        this.#setRelayLeft(payload.relayAllowanceBytes);
      }
      const expiresAt = requestedAt + payload.ttlSeconds * 1e3 - 1e3;
      if (expiresAt <= Date.now()) throw new Error("TURN credentials have expired");
      if (this.#relayExpiryTimer !== void 0) clearTimeout(this.#relayExpiryTimer);
      this.#relayExpiresAt = expiresAt;
      this.#relayExpiryTimer = setTimeout(() => {
        if (generation !== this.#peerGeneration || this.#closed) return;
        this.#callbacks.onError("Relay authorization expired. Reconnect to continue; your files remain here.");
        this.#endTransferChannel();
      }, expiresAt - Date.now());
      return payload.iceServers;
    } catch (error) {
      if (forceRelay) {
        throw new Error(
          error instanceof Error ? `TURN relay unavailable: ${error.message}` : "TURN relay unavailable"
        );
      }
      return fallback;
    }
  }
  #requestRelayChallenge() {
    if (this.#socket?.readyState !== WebSocket.OPEN || this.#relayChallengePending) return Promise.reject(new Error("The relay session is not ready"));
    return new Promise((resolve, reject) => {
      const id = randomId();
      const timer = setTimeout(() => {
        this.#relayChallengePending = void 0;
        reject(new Error("Relay authorization timed out"));
      }, 5e3);
      this.#relayChallengePending = { id, resolve, reject, timer };
      this.#socket.send(JSON.stringify({ v: 1, type: "relay-challenge", requestId: id }));
    });
  }
  #edgeEndpoint(pathname, transport) {
    const endpoint = new URL(signalingOrigin());
    if (transport === "websocket") {
      endpoint.protocol = endpoint.protocol === "https:" || endpoint.protocol === "wss:" ? "wss:" : "ws:";
    } else {
      endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : endpoint.protocol === "ws:" ? "http:" : endpoint.protocol;
    }
    endpoint.pathname = pathname;
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint;
  }
  #attachChannel(channel) {
    channel.binaryType = "arraybuffer";
    if (this.#channel && this.#channel !== channel) this.#channel.close();
    this.#channel = channel;
    const generation = this.#peerGeneration;
    const signal = this.#transportAbort.signal;
    channel.bufferedAmountLowThreshold = 128 * 1024;
    channel.addEventListener("open", async () => {
      if (generation !== this.#peerGeneration || this.#channel !== channel || this.#closed) return;
      if (!this.#peerFrameProtocol) {
        this.close();
        this.#callbacks.onError("The other device needs an update before pairing. Refresh both pages.");
        return;
      }
      this.#connectionReady = true;
      this.#clearConnectionTimer();
      const path6 = await this.#detectPath();
      if (generation !== this.#peerGeneration || this.#channel !== channel || this.#closed) return;
      this.#readyPath = path6;
      if (this.#options.requirePairing) {
        this.#callbacks.onStatus("Secure channel ready; confirm the six-digit code on the joining device.");
        this.#callbacks.onPairingRequired?.();
      } else {
        this.#callbacks.onStatus(path6 === "turn" ? "Connected through TURN relay" : "Direct connection established");
        this.#callbacks.onReady(path6);
        this.#scheduleRelayRenewal();
      }
    });
    channel.addEventListener("message", (event) => {
      if (generation !== this.#peerGeneration || this.#channel !== channel || this.#closed) return;
      const size = typeof event.data === "string" ? event.data.length : event.data instanceof ArrayBuffer ? event.data.byteLength : 0;
      if (this.#receiveQueuedFrames >= MAX_QUEUED_FRAMES || this.#receiveQueuedBytes + size > MAX_QUEUED_BYTES) {
        this.#callbacks.onError("The other device sent more than this page can take at once. Connect again.");
        channel.close();
        return;
      }
      this.#receiveQueuedFrames += 1;
      this.#receiveQueuedBytes += size;
      this.#receiveChain = this.#receiveChain.then(() => {
        if (generation !== this.#peerGeneration || this.#channel !== channel || signal.aborted) return;
        return this.#handleDataFrame(event.data, signal);
      }).catch((error) => {
        if (generation !== this.#peerGeneration || this.#channel !== channel || signal.aborted) return;
        this.#callbacks.onError(error instanceof Error ? error.message : "Could not read encrypted payload");
      }).finally(() => {
        this.#receiveQueuedFrames -= 1;
        this.#receiveQueuedBytes -= size;
      });
    });
    channel.addEventListener("close", () => {
      if (generation !== this.#peerGeneration || this.#channel !== channel || this.#closed) return;
      this.#endTransferChannel();
    });
  }
  async #handleDataFrame(raw, signal) {
    signal.throwIfAborted();
    let frame;
    if (raw instanceof ArrayBuffer) {
      if (!this.#peerBinaryChunks) throw new Error("Unsupported binary frame");
      frame = decodeBinaryFrame(raw);
    } else {
      if (typeof raw !== "string") throw new Error("Unsupported binary frame");
      if (raw.length > MAX_DATA_FRAME_CHARS) throw new Error("Data channel frame is too large");
      frame = parseDataFrame(JSON.parse(raw));
    }
    if (frame.type === "pair-claim" || frame.type === "pair-result" || frame.type === "pair-confirm") {
      await this.#handlePairingFrame(frame, signal);
      return;
    }
    if (frame.type === "file-offer" || frame.type === "file-decision" || frame.type === "file-cancel" || frame.type === "file-receipt" || frame.type === "file-progress") {
      await this.#handleFileControlFrame(frame, signal);
      return;
    }
    if (frame.type === "file-ack") {
      if (this.#options.fileApproval) return;
      const pending = this.#pendingFileAcks.get(frame.transferId);
      if (!pending) {
        if (this.#closedFileTransfers.has(frame.transferId)) return;
        throw new Error("Unexpected file receipt confirmation");
      }
      clearTimeout(pending.timer);
      this.#pendingFileAcks.delete(frame.transferId);
      pending.resolve();
      return;
    }
    if (frame.type === "file-preview") {
      this.#requirePairing();
      await this.#handleFilePreview(frame, signal);
      return;
    }
    if (frame.type === "live") {
      await this.#handleLiveFrame(frame, signal);
      return;
    }
    this.#requirePairing();
    if (frame.type === "text") {
      const frameKey = `text:${frame.transferId}`;
      if (this.#receivedFrameKeys.has(frameKey)) throw new Error("Encrypted frame replay detected");
      const plaintext = await decryptChunk(
        await this.#requiredKey("receive"),
        fromBase64Url(frame.noncePrefix),
        fromBase64Url(frame.ciphertext),
        {
          channel: this.#frameContext("receive", frame.type),
          transferId: frame.transferId,
          kind: "text",
          chunkIndex: 0,
          totalChunks: 1,
          plainSize: frame.plainSize
        }
      );
      signal.throwIfAborted();
      if (!acceptFrameKey(this.#receivedFrameKeys, frameKey)) throw new Error("Encrypted frame replay detected");
      if (this.#relayed()) {
        this.#relayBytes += plaintext.byteLength;
        this.#noteRelayed(plaintext.byteLength);
      }
      this.#callbacks.onText(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      return;
    }
    try {
      await this.#receiveFileFrame(frame, signal);
    } catch (error) {
      if (!signal.aborted) {
        this.#cancelIncomingFile(frame.transferId);
        if (this.#fileApprovalNegotiated()) {
          try {
            await this.#sendFileControl({ type: "file-cancel", transferId: frame.transferId, reason: "receive_failed" });
          } catch {
          }
        }
      }
      throw error;
    }
  }
  async #receiveFileFrame(frame, signal) {
    if (frame.type === "file-meta") {
      if (frame.totalChunks !== chunkCount(frame.size, frame.chunkSize)) throw new Error("Invalid file chunk count");
      let accepted;
      if (this.#options.fileApproval) {
        accepted = this.#acceptedFileOffers.get(frame.transferId);
        if (!accepted) {
          if (this.#closedFileTransfers.has(frame.transferId)) return;
          throw new Error("File metadata arrived without an accepted offer");
        }
        clearTimeout(accepted.timer);
        this.#acceptedFileOffers.delete(frame.transferId);
        const privateMeta = frame.name === PRIVATE_META_NAME && frame.mime === "";
        if (!privateMeta && (accepted.name !== frame.name || accepted.mime !== frame.mime) || accepted.size !== frame.size || accepted.chunkSize !== frame.chunkSize || accepted.totalChunks !== frame.totalChunks) {
          this.#releaseRelay(accepted.relayClaim);
          if (accepted.resume) void this.#options.diskReceive?.discardPartial(accepted.resume);
          this.#rememberClosedTransfer(frame.transferId);
          await this.#sendFileControl({ type: "file-cancel", transferId: frame.transferId, reason: "manifest_mismatch" });
          return;
        }
        if (privateMeta) frame = { ...frame, name: accepted.name, mime: accepted.mime };
      } else {
        if (frame.size > this.#receiveLimit()) throw new Error("File is larger than this device takes");
        if (!await this.#roomFor(frame.size)) {
          throw new Error("Receive memory limit reached. Save and remove received files, then reconnect.");
        }
      }
      const frameKey2 = `meta:${frame.transferId}`;
      if (!acceptFrameKey(this.#receivedFrameKeys, frameKey2)) {
        this.#releaseRelay(accepted?.relayClaim);
        if (accepted?.resume) void this.#options.diskReceive?.discardPartial(accepted.resume);
        throw new Error("Encrypted file metadata replay detected");
      }
      let sink;
      let entry = frame.transferId;
      let next = 0;
      const resume = accepted?.resume;
      if (frame.resumeFrom !== void 0 && frame.resumeFrom !== resume?.next) {
        this.#releaseRelay(accepted?.relayClaim);
        if (resume) void this.#options.diskReceive.discardPartial(resume);
        throw new Error("File continuation did not match what this device kept");
      }
      if (this.#toDisk(frame.size)) {
        const disk = this.#options.diskReceive;
        try {
          if (resume && frame.resumeFrom === resume.next) {
            entry = resume.entry;
            next = resume.next;
            sink = await disk.open(entry, frame.name, frame.mime, next * frame.chunkSize);
          } else {
            if (resume) await disk.discardPartial(resume);
            sink = await disk.open(entry, frame.name, frame.mime);
          }
        } catch (error) {
          this.#releaseRelay(accepted?.relayClaim);
          if (resume) void disk.discardPartial(resume);
          throw error;
        }
        if (signal.aborted || this.#closed) {
          this.#releaseRelay(accepted?.relayClaim);
          const peerId = this.#pairedPeerIdentity?.id;
          if (resume && accepted?.resumeKey && peerId) {
            void disk.keepPartial({
              peerId,
              resumeKey: accepted.resumeKey,
              entry,
              name: frame.name,
              mime: frame.mime,
              size: frame.size,
              chunkSize: frame.chunkSize,
              totalChunks: frame.totalChunks,
              next
            }, sink).catch(() => {
            });
          } else void sink.abort();
          return;
        }
      }
      this.#incomingFiles.set(frame.transferId, {
        name: frame.name,
        mime: frame.mime,
        size: frame.size,
        chunkSize: frame.chunkSize,
        totalChunks: frame.totalChunks,
        noncePrefix: fromBase64Url(frame.noncePrefix),
        ...sink ? { sink, entry } : { assembler: new ChunkAssembler(frame.totalChunks) },
        next,
        reported: next,
        ...sink && accepted?.resumeKey && this.#pairedPeerIdentity ? { resumeKey: accepted.resumeKey, peerId: this.#pairedPeerIdentity.id } : {},
        relayClaim: accepted?.relayClaim
      });
      return;
    }
    const incoming = this.#incomingFiles.get(frame.transferId);
    if (!incoming) {
      if (this.#closedFileTransfers.has(frame.transferId)) return;
      throw new Error("File chunk arrived without metadata");
    }
    if (frame.type === "file-chunk") {
      if (frame.index >= incoming.totalChunks) throw new Error("File chunk index is out of range");
      if (incoming.sink && frame.index !== incoming.next) throw new Error("Encrypted file chunk replay detected");
      const frameKey2 = `chunk:${frame.transferId}:${frame.index}`;
      if (!incoming.sink && this.#receivedFrameKeys.has(frameKey2)) throw new Error("Encrypted file chunk replay detected");
      const expectedSize = Math.max(
        0,
        Math.min(incoming.chunkSize, incoming.size - frame.index * incoming.chunkSize)
      );
      const ciphertext = typeof frame.ciphertext === "string" ? fromBase64Url(frame.ciphertext) : frame.ciphertext;
      if (ciphertext.byteLength !== expectedSize + 16) throw new Error("File chunk size did not match its manifest");
      const plaintext = await decryptChunk(
        await this.#requiredKey("receive"),
        incoming.noncePrefix,
        ciphertext,
        {
          channel: this.#frameContext("receive", frame.type),
          transferId: frame.transferId,
          kind: "file",
          chunkIndex: frame.index,
          totalChunks: incoming.totalChunks,
          plainSize: expectedSize
        }
      );
      signal.throwIfAborted();
      if (incoming.sink) {
        if (frame.index !== incoming.next) throw new Error("Encrypted file chunk replay detected");
        incoming.next += 1;
        await incoming.sink.write(plaintext);
      } else {
        if (!acceptFrameKey(this.#receivedFrameKeys, frameKey2)) throw new Error("Encrypted file chunk replay detected");
        incoming.assembler.add(frame.index, plaintext);
      }
      this.#useRelay(incoming.relayClaim, plaintext.byteLength);
      this.#callbacks.onProgress(incoming.name, (frame.index + 1) / incoming.totalChunks, "received");
      if (this.#useReceiveWindow() && progressDue(frame.index + 1, incoming.reported, incoming.totalChunks)) {
        incoming.reported = frame.index + 1;
        await this.#sendFileControl({ type: "file-progress", transferId: frame.transferId, next: incoming.reported }, signal);
      }
      return;
    }
    if (incoming.sink && incoming.next !== incoming.totalChunks) throw new Error("Received file size did not match its manifest");
    const blob = incoming.sink ? await incoming.sink.finish() : incoming.assembler.finish(incoming.mime);
    if (blob.size !== incoming.size) throw new Error("Received file size did not match its manifest");
    const frameKey = `complete:${frame.transferId}`;
    if (!acceptFrameKey(this.#receivedFrameKeys, frameKey)) throw new Error("Encrypted file completion replay detected");
    this.#incomingFiles.delete(frame.transferId);
    this.#releaseRelay(incoming.relayClaim);
    const received = {
      transferId: frame.transferId,
      name: incoming.name,
      size: incoming.size,
      mime: incoming.mime,
      blob,
      url: URL.createObjectURL(blob),
      ...incoming.sink ? { onDisk: true, diskEntry: incoming.entry } : {}
    };
    this.#receivedFileHistory.set(frame.transferId, { transferId: frame.transferId, stage: "received" });
    while (this.#receivedFileHistory.size > MAX_FILE_HISTORY) {
      const oldest = this.#receivedFileHistory.keys().next().value;
      if (!oldest) break;
      this.#receivedFileHistory.delete(oldest);
    }
    this.#callbacks.onFile(received);
    if (this.#fileApprovalNegotiated()) await this.#sendFileControl({ type: "file-receipt", transferId: frame.transferId, stage: "received" });
    else this.#sendFrame({ v: PROTOCOL_VERSION, type: "file-ack", transferId: frame.transferId });
  }
  async #handleFileControlFrame(frame, signal) {
    this.#requirePairing();
    const frameKey = `file-control:${frame.type}:${frame.transferId}:${frame.noncePrefix}`;
    const remember = frame.type !== "file-progress";
    if (remember && this.#receivedFrameKeys.has(frameKey)) throw new Error("Encrypted file control replay detected");
    const plaintext = await decryptChunk(await this.#requiredKey("receive"), fromBase64Url(frame.noncePrefix), fromBase64Url(frame.ciphertext), {
      channel: this.#frameContext("receive", frame.type),
      transferId: frame.transferId,
      kind: "text",
      chunkIndex: 0,
      totalChunks: 1,
      plainSize: frame.plainSize
    });
    signal.throwIfAborted();
    if (remember) {
      if (!acceptFrameKey(this.#receivedFrameKeys, frameKey)) throw new Error("Encrypted file control replay detected");
      if (++this.#controlFrameKeys > MAX_CONTROL_FRAME_KEYS) {
        this.#channel?.close();
        throw new Error("The other device sent more than this page can take at once. Connect again.");
      }
    }
    const payload = parseFileControlPayload(new TextDecoder("utf-8", { fatal: true }).decode(plaintext), this.#receiveLimit());
    if (payload.type !== frame.type || payload.transferId !== frame.transferId) throw new Error("File control message type mismatch");
    if (payload.type === "file-offer") {
      await this.#handleFileOffer(payload);
      return;
    }
    if (payload.type === "file-decision") {
      const pending2 = this.#pendingFileDecisions.get(payload.transferId);
      if (!pending2) {
        if (this.#closedFileTransfers.has(payload.transferId)) return;
        throw new Error("Unexpected file decision");
      }
      clearTimeout(pending2.timer);
      this.#pendingFileDecisions.delete(payload.transferId);
      pending2.resolve({
        decision: payload.decision,
        ...payload.resumeFrom !== void 0 ? { resumeFrom: payload.resumeFrom } : {},
        ...payload.privateMeta ? { privateMeta: true } : {}
      });
      return;
    }
    if (payload.type === "file-progress") {
      this.#sendWindows.get(payload.transferId)?.acknowledge(payload.next);
      return;
    }
    if (payload.type === "file-cancel") {
      this.#activeFileAborters.get(payload.transferId)?.abort(new Error("The receiving browser stopped this file transfer"));
      this.#cancelIncomingFile(payload.transferId);
      return;
    }
    const pending = this.#pendingFileAcks.get(payload.transferId);
    if (pending && payload.stage === "received") {
      clearTimeout(pending.timer);
      this.#pendingFileAcks.delete(payload.transferId);
      pending.resolve();
    }
    this.#callbacks.onFileReceipt?.({ transferId: payload.transferId, stage: payload.stage });
  }
  async #handleFileOffer(offer) {
    if (!this.#fileApprovalNegotiated()) {
      this.#rememberClosedTransfer(offer.transferId);
      await this.#sendFileControl({ type: "file-decision", transferId: offer.transferId, decision: "reject" });
      return;
    }
    if (this.#closedFileTransfers.has(offer.transferId)) {
      this.#forgetClosedTransfer(offer.transferId);
      for (const key of this.#receivedFrameKeys) {
        if (key === `meta:${offer.transferId}` || key.startsWith(`chunk:${offer.transferId}:`) || key === `complete:${offer.transferId}`) {
          this.#receivedFrameKeys.delete(key);
        }
      }
    }
    if (this.#pendingFileOffers.has(offer.transferId) || this.#acceptedFileOffers.has(offer.transferId) || this.#incomingFiles.has(offer.transferId)) return;
    const pendingMemory = [...this.#pendingFileOffers.values()].reduce((sum, file) => sum + (this.#toDisk(file.size) ? 0 : file.size), 0);
    const needed = this.#stillNeeded(offer, this.#matchingPartial(offer));
    if (this.#pendingFileOffers.size >= MAX_PENDING_FILE_OFFERS || !await this.#roomFor(offer.size, pendingMemory, needed)) {
      this.#rememberClosedTransfer(offer.transferId);
      await this.#sendFileControl({ type: "file-decision", transferId: offer.transferId, decision: "busy" });
      return;
    }
    const timer = setTimeout(() => {
      const pending = this.#pendingFileOffers.get(offer.transferId);
      if (!pending) return;
      this.#removePendingFileOffer(offer.transferId);
      this.#rememberClosedTransfer(offer.transferId);
      void this.#sendFileControl({ type: "file-decision", transferId: offer.transferId, decision: "timeout" }).catch(() => {
      });
    }, FILE_OFFER_TIMEOUT_MS);
    this.#pendingFileOffers.set(offer.transferId, { ...offer, timer });
    if (this.#matchingPartial(offer)) {
      void this.acceptFile(offer.transferId).catch(() => {
      });
      return;
    }
    try {
      this.#callbacks.onFileOffer?.(offer);
    } catch {
    }
  }
  #cancelIncomingFile(transferId) {
    this.#removePendingFileOffer(transferId);
    const accepted = this.#acceptedFileOffers.get(transferId);
    if (accepted) {
      clearTimeout(accepted.timer);
      this.#releaseRelay(accepted.relayClaim);
      if (accepted.resume) void this.#options.diskReceive?.discardPartial(accepted.resume);
    }
    this.#acceptedFileOffers.delete(transferId);
    const incoming = this.#incomingFiles.get(transferId);
    if (incoming) {
      incoming.assembler?.clear();
      if (incoming.sink) void incoming.sink.abort();
      this.#releaseRelay(incoming.relayClaim);
    }
    this.#incomingFiles.delete(transferId);
    this.#rememberClosedTransfer(transferId);
    if (accepted || incoming) {
      try {
        this.#callbacks.onIncomingFileClosed?.(transferId, incoming?.name ?? accepted?.name);
      } catch {
      }
    }
  }
  #removePendingFileOffer(transferId) {
    const pending = this.#pendingFileOffers.get(transferId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pendingFileOffers.delete(transferId);
    try {
      this.#callbacks.onFileOfferClosed?.(transferId);
    } catch {
    }
  }
  async #sendPairingFrame(type, payload) {
    const signal = this.#transportAbort.signal;
    signal.throwIfAborted();
    if (type !== payload.type) throw new Error("Pairing frame type mismatch");
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    if (plaintext.byteLength > 4096) throw new Error("Pairing message is too large");
    const transferId = randomId();
    const noncePrefix = createNoncePrefix();
    const ciphertext = await encryptChunk(await this.#requiredKey("send"), noncePrefix, plaintext, {
      channel: this.#frameContext("send", type),
      transferId,
      kind: "text",
      chunkIndex: 0,
      totalChunks: 1,
      plainSize: plaintext.byteLength
    });
    signal.throwIfAborted();
    this.#sendFrame({
      v: PROTOCOL_VERSION,
      type,
      transferId,
      noncePrefix: toBase64Url(noncePrefix),
      ciphertext: toBase64Url(ciphertext),
      plainSize: plaintext.byteLength
    });
  }
  async #handlePairingFrame(frame, signal) {
    if (!this.#options.requirePairing || this.#paired) throw new Error("Unexpected pairing message");
    const frameKey = `pair:${frame.transferId}`;
    if (this.#receivedFrameKeys.has(frameKey)) throw new Error("Pairing message replay detected");
    const plaintext = await decryptChunk(
      await this.#requiredKey("receive"),
      fromBase64Url(frame.noncePrefix),
      fromBase64Url(frame.ciphertext),
      {
        channel: this.#frameContext("receive", frame.type),
        transferId: frame.transferId,
        kind: "text",
        chunkIndex: 0,
        totalChunks: 1,
        plainSize: frame.plainSize
      }
    );
    signal.throwIfAborted();
    if (!acceptFrameKey(this.#receivedFrameKeys, frameKey)) throw new Error("Pairing message replay detected");
    const payload = parsePairingPayload(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (payload.type !== frame.type) throw new Error("Pairing message type mismatch");
    if (payload.type === "pair-claim") {
      if (this.#role !== "host" || this.#pendingPeerIdentity || this.#pairingDenied) throw new Error("Unexpected pairing claim");
      if (this.#seenPairingClaims.has(payload.claimId)) throw new Error("Pairing claim replay detected");
      this.#seenPairingClaims.add(payload.claimId);
      try {
        await this.#verifyCodeAttempt(payload.claimId, payload.device.id);
      } catch {
        signal.throwIfAborted();
        this.#pairingDenied = true;
        const reason = "Pairing attempt could not be verified; create a new private link";
        await this.#sendPairingFrame("pair-result", {
          type: "pair-result",
          claimId: payload.claimId,
          accepted: false,
          reason,
          terminal: true
        });
        signal.throwIfAborted();
        this.#callbacks.onPairingRejected?.(reason, true);
        this.#callbacks.onStatus(reason);
        return;
      }
      const expectedCode = this.#options.deviceKeyAgreement ? this.#options.pairingCode ?? await this.#safetyCodeFor(payload.device) : this.#options.pairingCode ?? "";
      signal.throwIfAborted();
      this.#pairingCodeForClaim = expectedCode;
      this.#callbacks.onPairingSas?.(expectedCode);
      const validCode = this.#pairingAttempts < MAX_PAIRING_ATTEMPTS && Date.now() < (this.#options.pairingExpiresAt ?? 0) && equalPairingCodes(payload.code, expectedCode);
      let validProof = false;
      if (validCode) {
        try {
          validProof = await verifyDeviceProof({
            privateKey: this.#options.identityPrivateKey,
            peerPublicKey: payload.device.publicKey,
            invitationSecret: this.#secret,
            roomId: this.#roomId,
            claimId: payload.claimId,
            host: this.#options.identity,
            join: payload.device,
            code: payload.code,
            direction: "join-claim"
          }, payload.proof);
        } catch {
          validProof = false;
        }
      }
      signal.throwIfAborted();
      const pinned = this.#options.expectedPeerIdentity;
      const valid = validCode && validProof && (!pinned || pinned.id === payload.device.id && pinned.publicKey === payload.device.publicKey);
      if (!valid) {
        this.#pairingAttempts += 1;
        const reason = this.#pairingAttempts >= MAX_PAIRING_ATTEMPTS ? "Too many pairing attempts; start a new session" : Date.now() >= (this.#options.pairingExpiresAt ?? 0) ? "Pairing code expired; start a new session" : "Pairing code or device proof did not match";
        const terminal = this.#pairingAttempts >= MAX_PAIRING_ATTEMPTS || Date.now() >= (this.#options.pairingExpiresAt ?? 0);
        if (terminal) this.#pairingDenied = true;
        await this.#sendPairingFrame("pair-result", {
          type: "pair-result",
          claimId: payload.claimId,
          accepted: false,
          reason,
          terminal
        });
        signal.throwIfAborted();
        this.#callbacks.onPairingRejected?.(reason, terminal);
        return;
      }
      this.#pairingClaimId = payload.claimId;
      this.#pendingPeerIdentity = payload.device;
      this.#awaitingHostApproval = true;
      this.#startPairingTimer();
      this.#callbacks.onPairingApprovalRequired?.(payload.device);
      this.#callbacks.onStatus("Code matched; approve or reject the joining device on this browser.");
      return;
    }
    if (payload.type === "pair-result") {
      if (this.#role !== "join" || !this.#pairingClaimId || payload.claimId !== this.#pairingClaimId) {
        throw new Error("Unexpected pairing result");
      }
      if (!payload.accepted) {
        this.#pairingClaimId = void 0;
        this.#pairingCodeEntered = void 0;
        this.#clearPairingTimer();
        if (payload.terminal) this.#pairingDenied = true;
        this.#callbacks.onPairingRejected?.(payload.reason ?? "Pairing code was rejected", payload.terminal);
        return;
      }
      if (!payload.device) throw new Error("Pairing result omitted the host device");
      const expectedHost = this.#options.expectedPeerIdentity;
      if (payload.device.id !== expectedHost.id || payload.device.publicKey !== expectedHost.publicKey || !payload.proof) {
        throw new Error("Host device identity did not match the invitation");
      }
      const proofInput = {
        privateKey: this.#options.identityPrivateKey,
        peerPublicKey: expectedHost.publicKey,
        invitationSecret: this.#secret,
        roomId: this.#roomId,
        claimId: payload.claimId,
        host: expectedHost,
        join: this.#options.identity,
        code: this.#pairingCodeEntered,
        direction: "host-approve"
      };
      if (!await verifyDeviceProof(proofInput, payload.proof)) {
        throw new Error("Host device private-key proof failed");
      }
      signal.throwIfAborted();
      const finalProof = await createDeviceProof({ ...proofInput, direction: "join-confirm" });
      signal.throwIfAborted();
      await this.#sendPairingFrame("pair-confirm", { type: "pair-confirm", claimId: payload.claimId, proof: finalProof });
      signal.throwIfAborted();
      this.#pairingClaimId = void 0;
      this.#pairingCodeEntered = void 0;
      this.#finishPairing(expectedHost);
      return;
    }
    if (this.#role !== "host" || !this.#pendingPeerIdentity || this.#awaitingHostApproval || payload.claimId !== this.#pairingClaimId) {
      throw new Error("Unexpected pairing confirmation");
    }
    if (!await verifyDeviceProof({
      privateKey: this.#options.identityPrivateKey,
      peerPublicKey: this.#pendingPeerIdentity.publicKey,
      invitationSecret: this.#secret,
      roomId: this.#roomId,
      claimId: payload.claimId,
      host: this.#options.identity,
      join: this.#pendingPeerIdentity,
      code: this.#pairingCodeForClaim ?? this.#options.pairingCode,
      direction: "join-confirm"
    }, payload.proof)) {
      throw new Error("Joining device private-key proof failed");
    }
    signal.throwIfAborted();
    void this.#reportPairingComplete(payload.claimId);
    this.#finishPairing(this.#pendingPeerIdentity);
    this.#pendingPeerIdentity = void 0;
    this.#awaitingHostApproval = false;
    this.#pairingClaimId = void 0;
    this.#pairingCodeForClaim = void 0;
  }
  #finishPairing(peer) {
    if (this.#paired) return;
    this.#paired = true;
    this.#pairedPeerIdentity = peer;
    this.#clearPairingTimer();
    this.#options.onPeerIdentity?.(peer);
    this.#callbacks.onPairingConfirmed?.(peer);
    void this.#sendLiveFingerprint();
    if (this.#pendingLiveFingerprint) {
      const reported = this.#pendingLiveFingerprint;
      this.#pendingLiveFingerprint = void 0;
      this.#verifyLiveFingerprint(reported);
    }
    const path6 = this.#readyPath;
    if (path6) {
      this.#callbacks.onStatus(path6 === "turn" ? "Paired through TURN relay" : "Paired through direct connection");
      this.#callbacks.onReady(path6);
      this.#scheduleRelayRenewal();
    }
  }
  // ---------- live picture (live-media.ts) ----------
  /**
   * A live picture can start now: both pages offer it, the devices are paired and the media identity checked, directly,
   * or over the relay when either device has Pro (2.17.0; the relay's measured bytes count against its allowance).
   */
  liveAvailable() {
    return this.#options.liveMedia === true && this.#peerLiveMedia && this.#paired && this.#liveVerified && (!this.#relayed() || this.#proConnection()) && this.#channel?.readyState === "open" && !this.#closed;
  }
  /** The other page offers a live picture at all (an older page does not). */
  peerOffersLive() {
    return this.#peerLiveMedia;
  }
  /**
   * Ask to show this stream's video, and once the other person accepts, add it to the connection. Resolves when the
   * picture flows; rejects when it is declined, not answered in time, cancelled, or the connection cannot carry it.
   */
  async startLive(stream, kind) {
    if (!this.liveAvailable()) throw new Error("A live picture needs a direct connection on the same Wi-Fi, or Pro.");
    if (this.#live) throw new Error("A live picture is already on.");
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("No picture to show");
    const live = { id: randomId(), role: "share", kind, on: false };
    this.#live = live;
    try {
      const answered = new Promise((resolve) => {
        const timer = setTimeout(() => settle("timeout"), LIVE_ANSWER_TIMEOUT_MS);
        const settle = (answer3) => {
          clearTimeout(timer);
          if (this.#liveAnswer?.id === live.id) this.#liveAnswer = void 0;
          resolve(answer3);
        };
        this.#liveAnswer = { id: live.id, settle };
      });
      await this.#sendLive({ op: "request", id: live.id, kind });
      const answer2 = await answered;
      if (answer2 !== "accept" || this.#live !== live) {
        if (answer2 === "timeout") void this.#sendLive({ op: "stop", id: live.id }).catch(() => {
        });
        throw new Error(answer2 === "decline" ? "The other device declined the live picture" : answer2 === "timeout" ? "The other device did not answer the live picture in time" : "The live picture was cancelled");
      }
      const peer = this.#peer;
      if (!peer) throw new Error("The connection closed");
      if (kind === "screen") {
        try {
          track.contentHint = "detail";
        } catch {
        }
      }
      live.sender = peer.addTrack(track, stream);
      await this.#renegotiateLive(live.id);
      if (this.#live !== live) throw new Error("The live picture was cancelled");
      try {
        const parameters = live.sender.getParameters();
        if (parameters.encodings?.length) {
          parameters.encodings[0].maxBitrate = this.#relayed() ? LIVE_RELAY_BITRATE : kind === "screen" ? 3e6 : 25e5;
          await live.sender.setParameters(parameters);
        }
      } catch {
      }
      live.on = true;
    } catch (error) {
      if (this.#live === live) this.#endLive(live, true);
      throw error;
    }
  }
  /** Viewer: accept or decline a request (onLiveRequest). */
  async answerLive(id, accept) {
    const live = this.#live;
    if (!live || live.role !== "view" || live.id !== id) return;
    if (!accept) {
      this.#live = void 0;
      this.#liveLastId = id;
    } else live.accepted = true;
    await this.#sendLive({ op: "answer", id, accept });
  }
  /** Either side: end the live picture (or withdraw a request). */
  stopLive() {
    const live = this.#live;
    if (live) this.#endLive(live, true);
  }
  /** Sharer: show another track (the other camera) without renegotiating. */
  async replaceLiveTrack(track) {
    const live = this.#live;
    if (!live || live.role !== "share" || !live.sender) throw new Error("No live picture is on");
    await live.sender.replaceTrack(track);
  }
  /** Viewer: ask the sharer for a full-resolution still. */
  requestLiveStill() {
    const live = this.#live;
    if (live?.role === "view" && live.on) {
      live.stillsAsked = (live.stillsAsked ?? 0) + 1;
      void this.#sendLive({ op: "shutter", id: live.id }).catch(() => {
      });
    }
  }
  /** Sharer: the file about to be sent with this ID is the still the viewer asked for. */
  async announceLiveStill(transferId) {
    const live = this.#live;
    if (live?.role !== "share") throw new Error("No live picture is on");
    await this.#sendLive({ op: "shutter-file", id: live.id, transferId });
  }
  #endLive(live, notify) {
    if (this.#live !== live) return;
    this.#live = void 0;
    this.#liveLastId = live.id;
    if (this.#liveAnswer?.id === live.id) this.#liveAnswer.settle("cancel");
    if (notify && this.#channel?.readyState === "open") void this.#sendLive({ op: "stop", id: live.id }).catch(() => {
    });
    if (live.role === "share" && live.sender && this.#peer && !this.#closed) {
      try {
        this.#peer.removeTrack(live.sender);
      } catch {
      }
      if (live.on) void this.#renegotiateLive(live.id).catch(() => {
      });
    }
  }
  /** Sharer: one offer/answer round over the encrypted channel, one at a time. */
  #renegotiateLive(id) {
    const run = async () => {
      const peer = this.#peer;
      if (!peer || this.#closed) throw new Error("The connection closed");
      const answer2 = new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error("The live picture could not start in time")), LIVE_NEGOTIATION_TIMEOUT_MS);
        const done = () => {
          clearTimeout(timer);
          if (this.#liveSdpAnswer?.id === id) this.#liveSdpAnswer = void 0;
        };
        const fail = (error) => {
          done();
          reject(error);
        };
        this.#liveSdpAnswer = { id, resolve: (description) => {
          done();
          resolve(description);
        }, reject: fail };
      });
      await peer.setLocalDescription(await peer.createOffer());
      await this.#sendLive({ op: "sdp", id, description: { type: "offer", sdp: peer.localDescription.sdp } });
      await peer.setRemoteDescription(await answer2);
    };
    const next = this.#liveChain.then(run, run);
    this.#liveChain = next.catch(() => {
    });
    return next;
  }
  async #sendLiveFingerprint() {
    if (!this.#options.liveMedia || !this.#peerLiveMedia) return;
    const local = sdpFingerprints(this.#peer?.localDescription?.sdp);
    if (local.length !== 1) return;
    try {
      await this.#sendLive({ op: "fingerprint", value: local[0] });
    } catch {
    }
  }
  #verifyLiveFingerprint(reported) {
    if (!fingerprintMatches(reported, this.#peer?.currentRemoteDescription?.sdp ?? this.#peer?.remoteDescription?.sdp)) {
      this.#callbacks.onError("The device proof did not match the media connection. For your safety this connection stopped.");
      this.#endTransferChannel();
      return;
    }
    if (this.#liveVerified) return;
    this.#liveVerified = true;
    try {
      this.#callbacks.onLiveReady?.();
    } catch {
    }
  }
  async #sendLive(payload) {
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    if (plaintext.byteLength > LIVE_CONTROL_MAX_BYTES) throw new Error("Live control message is too large");
    const transferId = randomId();
    const noncePrefix = createNoncePrefix();
    const ciphertext = await encryptChunk(await this.#requiredKey("send"), noncePrefix, plaintext, {
      channel: this.#frameContext("send", "live"),
      transferId,
      kind: "text",
      chunkIndex: 0,
      totalChunks: 1,
      plainSize: plaintext.byteLength
    });
    this.#sendFrame({
      v: PROTOCOL_VERSION,
      type: "live",
      transferId,
      noncePrefix: toBase64Url(noncePrefix),
      ciphertext: toBase64Url(ciphertext),
      plainSize: plaintext.byteLength
    });
  }
  async #handleLiveFrame(frame, signal) {
    if (!this.#options.liveMedia || !this.#peerLiveMedia) throw new Error("Unexpected live control message");
    const frameKey = `live:${frame.transferId}:${frame.noncePrefix}`;
    if (this.#receivedFrameKeys.has(frameKey)) throw new Error("Encrypted live control replay detected");
    const plaintext = await decryptChunk(await this.#requiredKey("receive"), fromBase64Url(frame.noncePrefix), fromBase64Url(frame.ciphertext), {
      channel: this.#frameContext("receive", "live"),
      transferId: frame.transferId,
      kind: "text",
      chunkIndex: 0,
      totalChunks: 1,
      plainSize: frame.plainSize
    });
    signal.throwIfAborted();
    if (!acceptFrameKey(this.#receivedFrameKeys, frameKey)) throw new Error("Encrypted live control replay detected");
    const payload = parseLivePayload(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (payload.op === "fingerprint") {
      if (!this.#paired) {
        this.#pendingLiveFingerprint = payload.value;
        return;
      }
      this.#verifyLiveFingerprint(payload.value);
      return;
    }
    this.#requirePairing();
    if (!this.#liveVerified) return;
    const live = this.#live;
    switch (payload.op) {
      case "request":
        if (live || !this.liveAvailable()) {
          await this.#sendLive({ op: "answer", id: payload.id, accept: false });
          return;
        }
        this.#live = { id: payload.id, role: "view", kind: payload.kind, on: false };
        try {
          this.#callbacks.onLiveRequest?.({ id: payload.id, kind: payload.kind });
        } catch {
        }
        return;
      case "answer":
        if (this.#liveAnswer?.id === payload.id) this.#liveAnswer.settle(payload.accept ? "accept" : "decline");
        return;
      case "sdp": {
        if (payload.description.type === "answer") {
          if (this.#liveSdpAnswer?.id === payload.id) this.#liveSdpAnswer.resolve(payload.description);
          return;
        }
        if (!(live?.role === "view" && live.id === payload.id && live.accepted || this.#liveLastId === payload.id)) return;
        const peer = this.#peer;
        if (!peer) return;
        const respond = async () => {
          await peer.setRemoteDescription(payload.description);
          await peer.setLocalDescription(await peer.createAnswer());
          await this.#sendLive({ op: "sdp", id: payload.id, description: { type: "answer", sdp: peer.localDescription.sdp } });
        };
        const next = this.#liveChain.then(respond, respond);
        this.#liveChain = next.catch(() => {
        });
        await next;
        return;
      }
      case "stop":
        if (live?.id !== payload.id) return;
        this.#endLive(live, false);
        try {
          this.#callbacks.onLiveEnded?.("stopped");
        } catch {
        }
        return;
      case "shutter":
        if (live?.role === "share" && live.on && live.id === payload.id) {
          try {
            this.#callbacks.onLiveShutter?.();
          } catch {
          }
        }
        return;
      case "shutter-file":
        if (live?.role === "view" && live.id === payload.id && live.accepted && (live.stillsAsked ?? 0) > 0) {
          live.stillsAsked -= 1;
          try {
            this.#callbacks.onLiveShutterFile?.(payload.transferId);
          } catch {
          }
        }
        return;
    }
  }
  #requirePairing() {
    if (this.#options.requirePairing && !this.#paired) {
      throw new Error("Confirm the six-digit pairing code before sending content");
    }
  }
  #rejectPendingFileAcks(message) {
    for (const [transferId, pending] of this.#pendingFileAcks) {
      clearTimeout(pending.timer);
      this.#pendingFileAcks.delete(transferId);
      pending.reject(new Error(message));
    }
  }
  #rejectPendingFileDecisions(message) {
    for (const [transferId, pending] of this.#pendingFileDecisions) {
      clearTimeout(pending.timer);
      this.#pendingFileDecisions.delete(transferId);
      pending.reject(new Error(message));
    }
  }
  #assertActivePeer(peer, generation) {
    if (this.#closed || generation !== this.#peerGeneration || this.#peer !== peer) {
      throw new Error("Peer connection superseded");
    }
  }
  async #applyCandidate(peer, generation, candidate) {
    this.#assertActivePeer(peer, generation);
    try {
      await peer.addIceCandidate(candidate);
    } catch (error) {
      this.#assertActivePeer(peer, generation);
      const name = error instanceof Error ? error.name : void 0;
      if (name !== "OperationError" && name !== "TypeError") {
        throw new Error("Peer ICE candidate could not be applied");
      }
    }
    this.#assertActivePeer(peer, generation);
  }
  async #flushCandidates(peer, generation) {
    this.#assertActivePeer(peer, generation);
    for (const candidate of this.#pendingCandidates.splice(0)) {
      await this.#applyCandidate(peer, generation, candidate);
    }
  }
  #sendSignal(message) {
    if (this.#socket?.readyState !== WebSocket.OPEN) throw new Error("Signaling is not connected");
    this.#socket.send(JSON.stringify(message));
  }
  #setPeerChannelNonce(peerNonce) {
    if (sameBytes(this.#peerChannelNonce, peerNonce)) return;
    this.#peerChannelNonce = peerNonce;
    this.#frameKey = void 0;
    this.#frameKeyPromise = void 0;
    this.#receivedFrameKeys.clear();
    this.#controlFrameKeys = 0;
    this.#discardIncomingFiles();
  }
  #sendFrame(frame) {
    if (this.#channel?.readyState !== "open") throw new Error("The peer channel is not ready");
    this.#channel.send(JSON.stringify(frame));
  }
  #sendBinary(frame) {
    if (this.#channel?.readyState !== "open") throw new Error("The peer channel is not ready");
    this.#channel.send(frame);
  }
  async #waitForWritableChannel(signal, drain = false) {
    signal?.throwIfAborted();
    const transportSignal = this.#transportAbort.signal;
    transportSignal.throwIfAborted();
    const channel = this.#channel;
    if (!channel || channel.readyState !== "open") throw new Error("The peer channel is not ready");
    if (drain ? channel.bufferedAmount === 0 : channel.bufferedAmount < BUFFER_HIGH_WATER) return;
    await new Promise((resolve, reject) => {
      const onLow = () => {
        if (channel.bufferedAmount > (drain ? 0 : channel.bufferedAmountLowThreshold)) return;
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error("The transfer channel closed"));
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new DOMException("Transfer stopped", "AbortError"));
      };
      const poll = setInterval(onLow, BUFFER_POLL_MS);
      const cleanup = () => {
        clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        transportSignal.removeEventListener("abort", onClose);
        channel.removeEventListener("bufferedamountlow", onLow);
        channel.removeEventListener("close", onClose);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      transportSignal.addEventListener("abort", onClose, { once: true });
      channel.addEventListener("bufferedamountlow", onLow);
      channel.addEventListener("close", onClose, { once: true });
    });
  }
  async #detectPath() {
    const unknown = this.#forceRelay ? "turn" : "direct";
    const reports = await this.#peer?.getStats().catch(() => void 0);
    if (!reports) return unknown;
    let selectedPairIds;
    for (const report of reports.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        const pair = reports.get(report.selectedCandidatePairId);
        if (typeof pair?.localCandidateId === "string" && typeof pair.remoteCandidateId === "string") {
          selectedPairIds = { local: pair.localCandidateId, remote: pair.remoteCandidateId };
          break;
        }
      }
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated || report.selected)) {
        const pair = report;
        if (typeof pair.localCandidateId === "string" && typeof pair.remoteCandidateId === "string") {
          selectedPairIds = { local: pair.localCandidateId, remote: pair.remoteCandidateId };
        }
      }
    }
    if (selectedPairIds) {
      const local = reports.get(selectedPairIds.local);
      const remote = reports.get(selectedPairIds.remote);
      if (local?.candidateType === "relay" || remote?.candidateType === "relay") return "turn";
      if (local && remote) return "direct";
    }
    return unknown;
  }
  #frameContext(direction, frameType) {
    return { sender: direction === "send" ? this.#role : this.#role === "host" ? "join" : "host", frameType };
  }
  async #requiredKey(direction) {
    if (!this.#peerFrameProtocol) throw new Error("The secure channel session is not established");
    const sender = direction === "send" ? this.#role : this.#role === "host" ? "join" : "host";
    if (this.#frameKey) return this.#frameKey[sender];
    const peerNonce = this.#peerChannelNonce;
    if (!peerNonce) throw new Error("The secure channel session is not established");
    const hostNonce = this.#role === "host" ? this.#channelNonce : peerNonce;
    const joinNonce = this.#role === "host" ? peerNonce : this.#channelNonce;
    const promise = this.#frameKeyPromise ??= (async () => {
      if (!this.#options.deviceKeyAgreement) return deriveDirectionalDataChannelKeys(this.#secret, hostNonce, joinNonce, this.#capabilityContext());
      if (!this.#options.identityPrivateKey || !this.#options.identity || !this.#agreementPeer) throw new Error("Device key agreement is unavailable");
      const secret = await deviceSessionSecret(this.#options.identityPrivateKey, this.#options.identity, this.#agreementPeer, this.#secret, this.#roomId);
      return deriveDirectionalDataChannelKeys(secret, hostNonce, joinNonce, this.#capabilityContext());
    })();
    const key = await promise;
    if (this.#frameKeyPromise !== promise || !sameBytes(this.#peerChannelNonce, peerNonce)) {
      throw new Error("The secure channel session restarted");
    }
    this.#frameKey = key;
    return key[sender];
  }
};
function sameBytes(a, b) {
  if (!a || a.byteLength !== b.byteLength) return false;
  let mismatch = 0;
  for (let index = 0; index < b.byteLength; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}
function isRtcIceServerList(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return false;
  return value.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry;
    const urls = typeof candidate.urls === "string" ? [candidate.urls] : candidate.urls;
    return Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === "string" && /^(?:stun|turn|turns):/i.test(url)) && (candidate.username === void 0 || typeof candidate.username === "string") && (candidate.credential === void 0 || typeof candidate.credential === "string");
  });
}
function randomId() {
  return toBase64Url(randomBytes(18));
}

// ../../apps/app/src/identity.ts
var PAIRING_CODE_TTL_MS = 10 * 60 * 1e3;
var PAIRING_LOCKOUT_MS = 60 * 1e3;

// ../../apps/app/src/returning-device.ts
async function returningDeviceSession(identity, peer) {
  if (identity.id === peer.id) throw new Error("Choose a different device");
  const descriptors = [identity, peer].sort((a, b) => a.id < b.id ? -1 : 1);
  const context = new TextEncoder().encode(JSON.stringify(descriptors.map((d) => [d.id, d.publicKey])));
  const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(peer.publicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, identity.privateKey, 256);
  const key = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  async function derive(purpose) {
    return new Uint8Array(await crypto.subtle.deriveBits({
      name: "HKDF",
      hash: "SHA-256",
      salt: context,
      info: new TextEncoder().encode(`paironce-return-v1:${purpose}`)
    }, key, 256));
  }
  const room = await derive("rendezvous");
  const secret = await derive("session-secret");
  const codeBytes = await derive("confirmation");
  const presenceToken = toBase64Url(await derive("presence"));
  const presenceRoom = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(presenceToken))));
  const code = String(new DataView(codeBytes.buffer).getUint32(0) % 1e6).padStart(6, "0");
  const role = identity.id < peer.id ? "host" : "join";
  const host = role === "host" ? identity : peer;
  return {
    roomId: toBase64Url(room),
    secret,
    role,
    presenceToken,
    presenceRoom,
    hostIdentity: { id: host.id, name: host.name, publicKey: host.publicKey },
    offer: { code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS, host: { id: host.id, name: host.name, publicKey: host.publicKey } },
    peer
  };
}
async function returningPresence(identity, peer, requestConnection, signal) {
  const target2 = await returningDeviceSession(identity, peer);
  const endpoint = new URL(`/v1/presence/${target2.presenceRoom}`, "https://paironce.com");
  endpoint.protocol = endpoint.protocol === "ws:" ? "http:" : endpoint.protocol === "wss:" ? "https:" : endpoint.protocol;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PairOnce-Presence": target2.presenceToken },
    body: JSON.stringify({ deviceId: identity.id, peerId: peer.id, requestConnection }),
    signal: signal ? anySignal([signal, timeoutSignal(1e4)]) : timeoutSignal(1e4)
  });
  if (!response.ok) throw new Error("presence_unavailable");
  return response.json();
}

// src/store.ts
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
var home = () => process.env.PAIRONCE_HOME || path.join(homedir(), ".paironce");
var identityFile = () => path.join(home(), "identity.json");
var devicesFile = () => path.join(home(), "devices.json");
function terminalName(system = platform()) {
  const name = system === "win32" ? "Windows" : system === "darwin" ? "macOS" : system === "linux" ? "Linux" : "Computer";
  return `${name} \xB7 Terminal`;
}
async function writePrivate(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 448 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { mode: 384 });
  await rename(temporary, file);
}
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function usable(stored) {
  const privateKey = await crypto.subtle.importKey("jwk", stored.privateKey, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { id: stored.id, name: stored.name, publicKey: stored.publicKey, privateKey, createdAt: stored.createdAt };
}
async function loadOrCreateIdentity() {
  const existing = await readJson(identityFile());
  if (existing) return usable(existing);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const stored = {
    id: toBase64Url(randomBytes(12)),
    name: terminalName(),
    publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
    createdAt: Date.now()
  };
  await writePrivate(identityFile(), stored);
  return usable(stored);
}
async function listDevices() {
  return (await readJson(devicesFile()) ?? []).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
async function saveDevice(device, now = Date.now()) {
  const devices = await listDevices();
  const known = devices.find((item) => item.id === device.id);
  if (known && known.publicKey !== device.publicKey) throw new Error("A saved device with this ID has a different key. Remove it first.");
  const saved = { ...known, id: device.id, name: device.name, publicKey: device.publicKey, pairedAt: known?.pairedAt ?? now, lastSeenAt: now };
  await writePrivate(devicesFile(), [saved, ...devices.filter((item) => item.id !== device.id)]);
  return saved;
}
async function forgetDevice(id) {
  const devices = await listDevices();
  const rest = devices.filter((item) => item.id !== id);
  if (rest.length === devices.length) return false;
  await writePrivate(devicesFile(), rest);
  return true;
}
function pickDevice(devices, query) {
  if (!query) return devices.length === 1 ? devices[0] : devices.length ? "ambiguous" : "none";
  const wanted = query.toLowerCase();
  const exact = devices.filter((device) => device.name.toLowerCase() === wanted || device.id === query);
  if (exact.length === 1) return exact[0];
  const matches = devices.filter((device) => device.name.toLowerCase().includes(wanted));
  return matches.length === 1 ? matches[0] : matches.length ? "ambiguous" : "none";
}

// src/connection.ts
var httpOrigin = () => {
  const url = new URL(signalingOrigin());
  url.protocol = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
  return url;
};
async function lookupCode(code, identity) {
  const response = await fetch(new URL("/v1/connection-code/lookup", httpOrigin()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, device: identity.id }),
    signal: AbortSignal.timeout(1e4)
  });
  if (response.status === 429) throw new Error("Too many requests. Wait a moment, then try again.");
  if (!response.ok) throw new Error("Connection code expired or unavailable.");
  const offer = await response.json();
  const secret = fromBase64Url(offer.nonce);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(offer.roomId) || secret.byteLength !== 32 || offer.expiresAt <= Date.now() || !offer.host || !/^[A-Za-z0-9_-]{16,128}$/.test(offer.host.id) || !/^[A-Za-z0-9_-]{87}$/.test(offer.host.publicKey)) {
    throw new Error("Connection code expired or unavailable.");
  }
  if (offer.host.id === identity.id) throw new Error("That code is shown by this same device. Type it on your other device.");
  if (offer.room) throw new Error("That is a distribution room's code. Open it in a browser to join the room.");
  return { roomId: offer.roomId, secret, host: offer.host };
}
async function connect(identity, target2, ui, options = {}) {
  const events = {};
  let room;
  const returning = target2.kind === "saved" ? target2.device : void 0;
  if (target2.kind === "host") {
    room = { roomId: randomId(), secret: generateSessionSecret(), role: "host", expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
  } else if (target2.kind === "join") {
    const found = await lookupCode(target2.code, identity);
    room = { roomId: found.roomId, secret: found.secret, role: "join", expected: found.host, expiresAt: Date.now() + PAIRING_CODE_TTL_MS };
  } else {
    const next = await returningDeviceSession(identity, target2.device);
    void returningPresence(identity, target2.device, true, AbortSignal.timeout(1e4)).catch(() => {
    });
    room = { roomId: next.roomId, secret: next.secret, role: next.role, expected: target2.device, code: next.offer.code, expiresAt: next.offer.expiresAt };
  }
  return new Promise((resolve, reject) => {
    let peer;
    let saving = Promise.resolve();
    let settled = false;
    const fail = (error) => {
      if (settled) {
        events.error?.(error instanceof Error ? error.message : String(error));
        return;
      }
      settled = true;
      session?.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    options.signal?.addEventListener("abort", () => fail(new Error(returning ? `${returning.name} did not connect. Open https://paironce.com there and tap Connect next to "${identity.name}", then try again.` : "Nobody connected in time. Try again.")), { once: true });
    const callbacks = {
      onStatus: (text) => {
        if (text === "Transfer channel closed") {
          if (settled) events.closed?.();
          else fail(new Error("The connection ended."));
          return;
        }
        ui.status?.(text);
      },
      onConnectionCode: (code) => ui.code?.(code),
      // A saved device has nothing to compare: its code comes from both devices' keys and is checked by the session.
      onPairingSas: (code) => {
        if (!returning) ui.safetyCode?.(code);
      },
      onPairingRequired: () => {
        if (room.role !== "join") return;
        void (async () => {
          const code = room.code ?? await session.getPairingSas();
          if (!room.code) ui.safetyCode?.(code);
          await session.submitPairingCode(code);
        })().catch(fail);
      },
      onPairingApprovalRequired: (candidate) => {
        if (returning && candidate.id === returning.id && candidate.publicKey === returning.publicKey) {
          void session.approvePairing().catch(fail);
          return;
        }
        if (!ui.approve) {
          void session.rejectPairing().catch(() => {
          });
          fail(new Error("A new device can only be approved in the terminal."));
          return;
        }
        void ui.approve(candidate).then((yes) => yes ? session.approvePairing() : session.rejectPairing()).catch(fail);
      },
      onPairingConfirmed: (confirmed) => {
        peer = { ...confirmed, pairedAt: Date.now(), lastSeenAt: Date.now() };
        saving = saveDevice(confirmed).then((saved) => {
          peer = saved;
        }, (error) => {
          ui.status?.(error instanceof Error ? error.message : String(error));
        });
      },
      onPairingRejected: (reason, terminal) => {
        if (terminal) fail(new Error(reason));
        else ui.status?.(reason);
      },
      onReady: (path6) => {
        if (settled) return;
        settled = true;
        void saving.then(() => resolve({ session, peer: peer ?? { ...room.expected, pairedAt: Date.now(), lastSeenAt: Date.now() }, path: path6, events, close: () => session.close() }));
      },
      onText: (text) => events.text?.(text),
      onFile: (file) => events.file?.(file),
      onFileOffer: (offer) => events.offer?.(offer),
      onFileReceipt: (receipt) => events.receipt?.(receipt),
      onProgress: (label, fraction, direction) => events.progress?.(label, fraction, direction),
      onError: (message) => fail(new Error(message)),
      onConnectionCodeUnavailable: (reason) => fail(new Error(reason === "limited" ? "Too many requests. Wait a moment, then try again." : "No code is available right now. Try again."))
    };
    let session;
    try {
      session = new PeerSession(room.roomId, room.role, room.secret, callbacks, {
        identity: { id: identity.id, name: identity.name, publicKey: identity.publicKey },
        identityPrivateKey: identity.privateKey,
        requirePairing: true,
        // As the web app: new pairings (host, join) agree keys from the devices (v2); a saved device's room already comes
        // from both devices' keys, and its host checks the code both derived instead (returning-device.ts).
        deviceKeyAgreement: target2.kind !== "saved",
        fileApproval: true,
        publishConnectionCode: target2.kind === "host",
        pairingExpiresAt: room.expiresAt,
        ...target2.kind === "saved" && room.role === "host" && room.code ? { pairingCode: room.code } : {},
        isPro: () => false,
        ...room.expected ? { expectedPeerIdentity: room.expected } : {},
        ...options.diskReceive ? { diskReceive: options.diskReceive } : {}
      });
    } catch (error) {
      fail(error);
      return;
    }
    session.connect().catch(fail);
  });
}

// src/disk.ts
import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir as mkdir2, rm, stat, statfs, truncate } from "node:fs/promises";
import path2 from "node:path";

// ../../apps/app/src/realtime/disk-receive.ts
var DISK_THRESHOLD_BYTES = 16e6;
var RESERVE_BYTES = 512 * 1024 * 1024;
var WRITE_BYTES = 1024 * 1024;
var ABANDONED_MS = 24 * 60 * 60 * 1e3;
var PARTIAL_KEEP_MS = 30 * 60 * 1e3;
var MAX_PARTIALS = 3;

// src/disk.ts
var RESERVE_BYTES2 = 512 * 1024 * 1024;
var partPath = (folder, entry) => path2.join(folder, `.paironce-${entry.replace(/[^A-Za-z0-9_-]/g, "_")}.part`);
function sinkFor(file, stream, name, mime) {
  const closed = () => new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve()));
  return {
    write: (chunk) => new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve())),
    async finish() {
      await closed();
      return new File([await openAsBlob(file, { type: mime })], name, { type: mime, lastModified: Date.now() });
    },
    async abort() {
      stream.destroy();
      await rm(file, { force: true });
    },
    park: closed
  };
}
function createDiskReceiver(folder) {
  const kept = [];
  const drop = async (index) => {
    const [gone] = kept.splice(index, 1);
    if (gone) await rm(partPath(folder, gone.partial.entry), { force: true });
  };
  return {
    threshold: DISK_THRESHOLD_BYTES,
    async available() {
      await mkdir2(folder, { recursive: true });
      const disk = await statfs(folder);
      return Math.max(0, disk.bavail * disk.bsize - RESERVE_BYTES2);
    },
    async open(entry, name, mime, offset = 0) {
      await mkdir2(folder, { recursive: true });
      const file = partPath(folder, entry);
      if (offset > 0) {
        if ((await stat(file)).size < offset) throw new Error("disk_partial_short");
        await truncate(file, offset);
      }
      return sinkFor(file, createWriteStream(file, { flags: offset > 0 ? "a" : "w" }), name, mime);
    },
    async remove(entry) {
      await rm(partPath(folder, entry), { force: true });
    },
    async keepPartial(partial, sink) {
      try {
        await sink.park();
      } catch {
        await sink.abort();
        return;
      }
      for (let index = kept.length - 1; index >= 0; index--) if (Date.now() - kept[index].at > PARTIAL_KEEP_MS) await drop(index);
      const same = kept.findIndex((item) => item.partial.peerId === partial.peerId && item.partial.resumeKey === partial.resumeKey);
      if (same >= 0) kept.splice(same, 1);
      kept.push({ partial, at: Date.now() });
      while (kept.length > MAX_PARTIALS) await drop(0);
    },
    findPartial: (peerId, resumeKey) => kept.find((item) => item.partial.peerId === peerId && item.partial.resumeKey === resumeKey && Date.now() - item.at <= PARTIAL_KEEP_MS)?.partial,
    takePartial(partial) {
      const index = kept.findIndex((item) => item.partial === partial);
      if (index >= 0) kept.splice(index, 1);
    },
    async discardPartial(partial) {
      const index = kept.findIndex((item) => item.partial === partial);
      if (index >= 0) await drop(index);
      else await rm(partPath(folder, partial.entry), { force: true });
    }
  };
}

// src/mcp.ts
import { createInterface } from "node:readline";
import path4 from "node:path";

// src/send.ts
import { openAsBlob as openAsBlob2 } from "node:fs";
import { stat as stat2 } from "node:fs/promises";
import path3 from "node:path";
var say = (text) => {
  process.stderr.write(`${text}
`);
};
var human = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} kB`;
async function sendPath(link, file, report = say) {
  const info = await stat2(file);
  if (!info.isFile()) throw new Error(`${file} is not a file. Send the files inside a folder with: paironce send ${path3.join(file, "*")}`);
  const name = path3.basename(file);
  const blob = await openAsBlob2(file);
  const received = new Promise((resolve) => {
    const before = link.events.receipt;
    link.events.receipt = (receipt) => {
      before?.(receipt);
      if (receipt.stage === "received") resolve();
    };
  });
  let shown = -1;
  link.events.progress = (label, fraction, direction) => {
    const percent = Math.floor(fraction * 100);
    if (direction === "sent" && percent >= shown + 10) {
      shown = percent;
      report(`  ${label}: ${percent}%`);
    }
  };
  report(`Sending ${name} (${human(info.size)}). Waiting for ${link.peer.name} to accept\u2026`);
  await link.session.sendFile(new File([blob], name, { lastModified: info.mtimeMs }));
  await Promise.race([received, new Promise((resolve) => setTimeout(resolve, 3e4))]);
  report(`Sent ${name}.`);
}

// src/version.ts
var CLI_VERSION = "0.1.0";

// src/mcp.ts
var log = (text) => process.stderr.write(`${text}
`);
var target = { type: "string", description: "Name of a paired device (from list_devices). Optional when only one is paired." };
var TOOLS = [
  { name: "list_devices", description: "List the devices this computer is paired with through PairOnce.", inputSchema: { type: "object", properties: {} } },
  {
    name: "send_file",
    description: "Send files from this computer to one of the user's paired devices (phone or computer) through PairOnce, end-to-end encrypted. The user accepts each file on that device, and PairOnce must be open there.",
    inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" }, description: "Files to send (absolute paths, or relative to the server's folder)." }, device: target }, required: ["paths"] }
  },
  {
    name: "send_text",
    description: "Send a message or a link to one of the user's paired devices through PairOnce, end-to-end encrypted. PairOnce must be open there.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, device: target }, required: ["text"] }
  }
];
async function openSaved(device) {
  const identity = await loadOrCreateIdentity();
  const devices = await listDevices();
  const picked = pickDevice(devices, device);
  if (picked === "none") throw new Error(devices.length ? `No paired device is called "${device}".` : 'No device is paired yet. Run "npx paironce pair" in a terminal first.');
  if (picked === "ambiguous") throw new Error(`Name the device: ${devices.map((item) => item.name).join(", ")}.`);
  log(`Connecting to ${picked.name}; open https://paironce.com there.`);
  return connect(identity, { kind: "saved", device: picked }, { status: log }, { signal: AbortSignal.timeout(12e4) });
}
async function callTool(name, args) {
  if (name === "list_devices") {
    const devices = await listDevices();
    return devices.length ? devices.map((device2) => `${device2.name} (last seen ${new Date(device2.lastSeenAt).toISOString()})`).join("\n") : 'No paired devices. Run "npx paironce pair" in a terminal.';
  }
  const device = typeof args.device === "string" && args.device ? args.device : void 0;
  if (name === "send_text") {
    if (typeof args.text !== "string" || !args.text) throw new Error("text is required.");
    const link = await openSaved(device);
    try {
      await link.session.sendText(args.text);
      return `Sent to ${link.peer.name}.`;
    } finally {
      link.close();
    }
  }
  if (name === "send_file") {
    const paths = Array.isArray(args.paths) ? args.paths.filter((item) => typeof item === "string") : [];
    if (!paths.length) throw new Error("paths is required.");
    const link = await openSaved(device);
    try {
      for (const file of paths) await sendPath(link, path4.resolve(file), log);
      return `Sent ${paths.length === 1 ? path4.basename(paths[0]) : `${paths.length} files`} to ${link.peer.name}.`;
    } finally {
      link.close();
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}
async function answer(request) {
  const reply = (result) => ({ jsonrpc: "2.0", id: request.id, result });
  if (request.id === void 0) return void 0;
  switch (request.method) {
    case "initialize":
      return reply({
        protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "paironce", version: CLI_VERSION }
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const params = request.params ?? {};
      try {
        const text = await callTool(String(params.name), params.arguments ?? {});
        return reply({ content: [{ type: "text", text }] });
      } catch (error) {
        return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
  }
}
function runMcp() {
  const lines = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}
`);
      return;
    }
    queue = queue.then(async () => {
      const response = await answer(request);
      if (response) process.stdout.write(`${JSON.stringify(response)}
`);
    });
  });
  return new Promise((resolve) => lines.on("close", () => {
    void queue.then(() => resolve(0));
  }));
}

// src/cli.ts
function parse(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") {
      rest.push(...argv.slice(index + 1));
      break;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) {
      rest.push(arg);
      continue;
    }
    if (match[2] !== void 0) flags[match[1]] = match[2];
    else if (["to", "from"].includes(match[1]) && argv[index + 1] && !argv[index + 1].startsWith("--")) flags[match[1]] = argv[++index];
    else flags[match[1]] = true;
  }
  return { flags, rest };
}
async function ask(question) {
  if (!process.stdin.isTTY) return false;
  const line = createInterface2({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await line.question(`${question} [y/N] `)).trim());
  } finally {
    line.close();
  }
}
var groups = (code) => (code.length > 6 ? code.match(/.{1,4}/g) ?? [code] : [code.slice(0, 3), code.slice(3)]).join(" ");
var terminalUi = {
  code: (code) => say(`
On your other device, open https://paironce.com, choose "Enter a code" and type:

    ${code.slice(0, 3)} ${code.slice(3)}
`),
  safetyCode: (code) => say(`Safety code: ${groups(code)}  (the other screen must show the same)`),
  approve: (peer) => ask(`Connect "${peer.name}"? Check that both screens show the same safety code.`)
};
async function open(identity, name, folder) {
  const devices = await listDevices();
  const picked = pickDevice(devices, name);
  if (picked === "ambiguous") throw new Error(`Which device? Use --to with one of: ${devices.map((device) => `"${device.name}"`).join(", ")}`);
  if (picked === "none" && name) throw new Error(`No paired device is called "${name}". Run "paironce devices" to see them.`);
  const target2 = picked === "none" ? { kind: "host" } : { kind: "saved", device: picked };
  if (target2.kind === "saved") say(`Connecting to ${target2.device.name}\u2026 Open https://paironce.com there and tap Connect next to "${identity.name}".`);
  const diskReceive = folder ? createDiskReceiver(folder) : void 0;
  const link = await connect(identity, target2, terminalUi, { diskReceive, signal: AbortSignal.timeout(target2.kind === "saved" ? 18e4 : 6e5) });
  say(`Connected to ${link.peer.name} (${link.path === "turn" ? "through the encrypted relay" : "direct"}).`);
  return link;
}
async function uniquePath(folder, name) {
  const safe = path5.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/^\.+/, "_") || "file";
  const { name: stem, ext } = path5.parse(safe);
  for (let index = 0; ; index++) {
    const candidate = path5.join(folder, index ? `${stem} (${index})${ext}` : safe);
    try {
      await stat3(candidate);
    } catch {
      return candidate;
    }
  }
}
async function receive(link, folder, acceptAll) {
  await mkdir3(folder, { recursive: true });
  say(`Receiving into ${folder}. Press Ctrl+C to stop.`);
  link.events.offer = (offer) => {
    void (async () => {
      const yes = acceptAll || await ask(`${link.peer.name} sends ${offer.name} (${human(offer.size)}). Accept?`);
      await (yes ? link.session.acceptFile(offer.transferId) : link.session.rejectFile(offer.transferId));
    })().catch((error) => say(String(error instanceof Error ? error.message : error)));
  };
  link.events.file = (file) => {
    void (async () => {
      const target2 = await uniquePath(folder, file.name);
      if (file.onDisk) await rename2(partPath(folder, file.diskEntry ?? file.transferId), target2);
      else await writeFile2(target2, new Uint8Array(await (file.blob ?? await (await fetch(file.url)).blob()).arrayBuffer()));
      URL.revokeObjectURL(file.url);
      await link.session.confirmFileSaved(file.transferId).catch(() => {
      });
      say(`Saved ${target2}`);
    })().catch((error) => say(`Could not save ${file.name}: ${error instanceof Error ? error.message : error}`));
  };
  link.events.text = (text) => process.stdout.write(`${text}
`);
  await new Promise((resolve) => {
    link.events.closed = resolve;
    process.once("SIGINT", () => resolve());
  });
}
var HELP = `paironce ${CLI_VERSION}: send files and text from this terminal to your own devices (https://paironce.com).

  paironce pair                  show a code to type on the other device
  paironce pair 123456           type the code the other device shows
  paironce send <file>...        send files (--to <device name> when several are paired)
  paironce text "<message>"      send a message or a link
  paironce receive               receive into this folder (--to <folder>, --yes accepts without asking)
  paironce devices               list paired devices
  paironce forget <name>         forget a paired device
  paironce mcp                   run as an MCP server for AI agents (send_file, send_text, list_devices)

Files are end-to-end encrypted and go directly between the devices, or through an encrypted relay when a network
blocks direct connections. The other device accepts every file before it arrives. This device is kept in ~/.paironce.`;
async function main(argv) {
  const { flags, rest } = parse(argv);
  const [command, ...args] = rest;
  if (flags.version) {
    process.stdout.write(`${CLI_VERSION}
`);
    return 0;
  }
  if (!command || flags.help || command === "help") {
    process.stdout.write(`${HELP}
`);
    return command || flags.help ? 0 : 1;
  }
  if (command === "mcp") return runMcp();
  const identity = await loadOrCreateIdentity();
  if (command === "devices") {
    const devices = await listDevices();
    if (!devices.length) say(`No paired devices yet. Run "paironce pair".`);
    for (const device of devices) process.stdout.write(`${device.name}	last seen ${new Date(device.lastSeenAt).toLocaleString()}
`);
    return 0;
  }
  if (command === "forget") {
    const picked = pickDevice(await listDevices(), args.join(" ") || void 0);
    if (typeof picked === "string") {
      say(picked === "none" ? "No such device." : "Several devices match; name it more exactly.");
      return 1;
    }
    await forgetDevice(picked.id);
    say(`Forgot ${picked.name}. Remove "${identity.name}" on that device too.`);
    return 0;
  }
  if (command === "pair") {
    const code = args.join("").replace(/\s/g, "");
    if (code && !/^\d{6}$/.test(code)) {
      say("The code has six digits.");
      return 1;
    }
    const link = await connect(identity, code ? { kind: "join", code } : { kind: "host" }, terminalUi, { signal: AbortSignal.timeout(6e5) });
    say(`Paired with ${link.peer.name}. Next time, "paironce send <file>" connects without a code.`);
    link.close();
    return 0;
  }
  if (command === "send") {
    if (!args.length) {
      say("Name the files to send: paironce send report.pdf photo.jpg");
      return 1;
    }
    const link = await open(identity, typeof flags.to === "string" ? flags.to : void 0);
    try {
      for (const file of args) await sendPath(link, file);
    } finally {
      link.close();
    }
    return 0;
  }
  if (command === "text") {
    const text = args.join(" ");
    if (!text) {
      say('Write the message: paironce text "https://example.com"');
      return 1;
    }
    const link = await open(identity, typeof flags.to === "string" ? flags.to : void 0);
    try {
      await link.session.sendText(text);
      say(`Sent to ${link.peer.name}.`);
    } finally {
      link.close();
    }
    return 0;
  }
  if (command === "receive") {
    const folder = path5.resolve(typeof flags.to === "string" ? flags.to : ".");
    const link = await open(identity, typeof flags.from === "string" ? flags.from : void 0, folder);
    try {
      await receive(link, folder, flags.yes === true);
    } finally {
      link.close();
    }
    return 0;
  }
  say(`Unknown command "${command}". Run "paironce help".`);
  return 1;
}
main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
  say(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
export {
  terminalUi
};
