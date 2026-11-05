# paironce

Send files and text from a terminal to your own phone or computer with [PairOnce](https://paironce.com). Pair once with
a six-digit code; after that, `npx paironce send report.pdf` puts the file on your phone. End-to-end encrypted, direct
between the devices whenever the network allows, and through an encrypted relay when it does not. No account.

```sh
npx paironce pair                 # shows a code: type it at paironce.com on your phone
npx paironce send build.zip       # sends to the paired device
npx paironce text "https://example.com/some/long/link"
npx paironce receive --to ./inbox # receives files sent from the phone
```

The other device is any browser with https://paironce.com open: iPhone, Android, Windows, Mac or Linux. Nothing to
install there.

## Commands

| Command | What it does |
| --- | --- |
| `paironce pair` | Shows a six-digit code. On the other device, open paironce.com, choose **Enter a code** and type it. Both screens show the same safety code; approve the device in the terminal. |
| `paironce pair 123456` | Joins with the code the other device shows, for a person at this terminal. |
| `paironce send <file>...` | Sends files to the paired device. With several paired devices, add `--to "<name>"`. The other device accepts each file before it arrives. |
| `paironce text "<message>"` | Sends a message or a link. |
| `paironce receive` | Receives files into the current folder (`--to <folder>`). Asks before each file; `--yes` accepts every file during this run. Large files are written straight to disk, so they can be as large as the sender may send. |
| `paironce devices` | Lists paired devices. |
| `paironce forget <name>` | Forgets a paired device. |
| `paironce mcp` | Runs as an MCP server for AI agents. |

`--name "<name>"` (or the `PAIRONCE_NAME` variable) sets what the other device shows for this one, for example
`--name "Build server"`. The key stays the same, so paired devices still know it. `--agent` marks this device as an AI
agent on the other device (the MCP server always does). The MCP server stays connected for 30 minutes after its last tool call, so the next task needs no tap on your device; you see it as connected and can end it there. The MCP tools save inside the folder the server runs in (`inbox` by default). `--ephemeral` uses a throwaway identity in a temporary folder,
which the other device forgets after a day without a connection: right for a sandbox that is thrown away.

When a paired device is not connected, the command asks it to connect: PairOnce on that device shows
**"Windows · Terminal wants to reconnect"** with a **Connect** button.

## Use it from an AI agent (MCP)

`paironce mcp` gives an agent ten tools:

| Tool | What it does |
| --- | --- |
| `pair_device` | Pairs one of your devices. The agent gives you a six-digit code; you open paironce.com on that device, choose **Enter a code** and type it. The agent then tells you a safety code, and goes on only after you say your device shows the same. Once per device. |
| `send_file`, `send_text` | Sends to a paired device; you accept every file there. |
| `receive_files` | Waits while you send files from your device (a photo of a whiteboard, a scan, a document) and saves them into `./inbox`. |
| `request_photo`, `request_scan`, `request_file` | Asks for something specific, with the reason. Your device shows the request; you take the photo, scan the pages or choose the file there, or decline. Saved into `./inbox`. |
| `watch_frames`, `watch_stop` | Asks to see your camera or screen, with the reason. You share it on your device, or decline; the agent then gets a still picture each time it asks (at most two a second) and can guide you step by step. Your device shows the share and a stop button; it ends when either side stops it. |
| `list_devices` | Lists the paired devices. |

The agent reaches only devices you paired and approved, and nothing arrives anywhere unasked. Your device marks it
**Agent** when it asks to be approved and in your saved devices. Design and plans:
[Agent as a Device](https://github.com/paironce/protocol/blob/main/agent-as-a-device.md).

Claude Code:

```sh
claude mcp add paironce -e PAIRONCE_NAME="Claude Code · Agent" -- npx -y paironce mcp
# in a throwaway sandbox: ... -- npx -y paironce mcp --ephemeral
```

Other clients (Cursor, Claude Desktop and others), in their MCP configuration:

```json
{ "mcpServers": { "paironce": { "command": "npx", "args": ["-y", "paironce", "mcp"], "env": { "PAIRONCE_NAME": "Cursor · Agent" } } } }
```

Then ask: "pair with my phone", "send the build log to my phone", or let the agent ask you: "I need a photo of the label on the back of the router".

## How it works

The CLI runs the same connection code as paironce.com: the [PairOnce protocol](https://github.com/paironce/protocol)
and [@paironce/core](https://github.com/paironce/core) for pairing and encryption, with WebRTC from
[node-datachannel](https://github.com/murat-dogan/node-datachannel) for direct connections and
[@roamhq/wrtc](https://github.com/WonderInventions/node-webrtc) (libwebrtc) for the relay. Files and messages are encrypted on this computer
and decrypted on the other device; the PairOnce service only introduces the two devices and, when needed, relays
encrypted bytes it cannot read.

This computer's device key and the list of paired devices are kept in `~/.paironce` (or `$PAIRONCE_HOME`), readable only
by you. The private key never leaves this computer.

It connects directly whenever the networks allow it, otherwise through the encrypted relay over UDP, TCP or TLS on port
443, and where even that is blocked, through the PairOnce tunnel: the same encrypted data over a secure WebSocket to
paironce.com. So it works on servers, in containers that block UDP, and behind a web proxy (`HTTPS_PROXY` is used
automatically). In a cloud sandbox with an allow-list, such as Claude Code on the web, add `paironce.com` to the allowed
domains. `PAIRONCE_DEBUG=1` shows each step of connecting.

Requires Node.js 22 or later on Windows, macOS (x64 and arm64) or Linux (x64 and arm64).

## License

Apache-2.0. PairOnce is a trademark of its owner; see https://paironce.com.
