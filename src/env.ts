/**
 * What the web app's connection code expects from a browser, supplied in Node: WebRTC, chosen per connection.
 *
 * - The direct attempt uses node-datachannel (libdatachannel): it gets through home and office NATs to the other device
 *   reliably, which libwebrtc in Node did not in the 2026-11-04 checks from a cloud machine.
 * - A relay connection (the session's retry after a failed direct attempt, with TURN servers and the "relay" policy) uses
 *   @roamhq/wrtc (libwebrtc, the engine inside Chrome): it reaches the relay over UDP, TCP and TLS on port 443, so it
 *   also connects from containers and networks that block UDP, where node-datachannel's prebuilt library cannot.
 *
 * The session makes a new RTCPeerConnection for each attempt and only reconfigures relay connections, so one connection
 * never mixes the two. WebSocket, fetch, File, Blob and Web Crypto are Node's own (22 or later).
 */
import wrtc from "@roamhq/wrtc";
import * as datachannel from "node-datachannel/polyfill";

const [major] = process.versions.node.split(".").map(Number);
if (!major || major < 22) {
  console.error(`PairOnce needs Node.js 22 or later (this is ${process.versions.node}).`);
  process.exit(1);
}

const usesRelay = (config?: RTCConfiguration) => config?.iceTransportPolicy === "relay"
  || Boolean(config?.iceServers?.some(server => [server.urls].flat().some(url => /^turns?:/i.test(url))));

/** Returns the implementation's own object, so every later call goes straight to it. */
class RTCPeerConnection {
  constructor(config?: RTCConfiguration) {
    return (usesRelay(config) ? new wrtc.RTCPeerConnection(config) : new datachannel.RTCPeerConnection(config)) as unknown as RTCPeerConnection;
  }
}

Object.assign(globalThis, { RTCPeerConnection, RTCSessionDescription: datachannel.RTCSessionDescription, RTCIceCandidate: datachannel.RTCIceCandidate });
