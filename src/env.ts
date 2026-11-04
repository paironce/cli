/**
 * What the web app's connection code expects from a browser, supplied in Node: WebRTC from @roamhq/wrtc, which is
 * Google's libwebrtc (the engine inside Chrome) with the standard RTCPeerConnection API. It reaches the relay over UDP,
 * TCP and TLS on port 443, so it also connects from containers and networks that block UDP (0.2.0; node-datachannel's
 * prebuilt library could only use the relay over UDP). WebSocket, fetch, File, Blob and Web Crypto are Node's own (22+).
 */
import wrtc from "@roamhq/wrtc";

const [major] = process.versions.node.split(".").map(Number);
if (!major || major < 22) {
  console.error(`PairOnce needs Node.js 22 or later (this is ${process.versions.node}).`);
  process.exit(1);
}
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel } = wrtc;
Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCDataChannel });
