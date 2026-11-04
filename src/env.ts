/**
 * What the web app's connection code expects from a browser, supplied in Node: WebRTC from node-datachannel (its
 * standard RTCPeerConnection API, the libdatachannel library underneath). WebSocket, fetch, File, Blob and Web Crypto
 * are Node's own (22 or later).
 */
import { RTCDataChannel, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from "node-datachannel/polyfill";

const [major] = process.versions.node.split(".").map(Number);
if (!major || major < 22) {
  console.error(`PairOnce needs Node.js 22 or later (this is ${process.versions.node}).`);
  process.exit(1);
}
Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel });
