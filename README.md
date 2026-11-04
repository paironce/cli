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
| `paironce pair 123456` | Joins with the code the other device shows. |
| `paironce send <file>...` | Sends files to the paired device. With several paired devices, add `--to "<name>"`. The other device accepts each file before it arrives. |
| `paironce text "<message>"` | Sends a message or a link. |
| `paironce receive` | Receives files into the current folder (`--to <folder>`). Asks before each file; `--yes` accepts every file during this run. Large files are written straight to disk and continue after a dropped connection. |
| `paironce devices` | Lists paired devices. |
| `paironce forget <name>` | Forgets a paired device. |
| `paironce mcp` | Runs as an MCP server for AI agents. |

When a paired device is not connected, the command asks it to connect: PairOnce on that device shows
**"Windows · Terminal wants to reconnect"** with a **Connect** button.

## Use it from an AI agent (MCP)

`paironce mcp` gives an agent three tools: `list_devices`, `send_file` and `send_text`. Pair first with
`npx paironce pair`; the agent can then send to paired devices only, and every file is still accepted on the device by
you.

Claude Code:

```sh
claude mcp add paironce -- npx -y paironce mcp
```

Other clients (Cursor, Claude Desktop and others), in their MCP configuration:

```json
{ "mcpServers": { "paironce": { "command": "npx", "args": ["-y", "paironce", "mcp"] } } }
```

Then ask: "send the build log to my phone".

## How it works

The CLI runs the same connection code as paironce.com: the [PairOnce protocol](https://github.com/paironce/protocol)
and [@paironce/core](https://github.com/paironce/core) for pairing and encryption, with WebRTC from
[node-datachannel](https://github.com/murat-dogan/node-datachannel) for direct connections and
[@roamhq/wrtc](https://github.com/WonderInventions/node-webrtc) (libwebrtc) for the relay. Files and messages are encrypted on this computer
and decrypted on the other device; the PairOnce service only introduces the two devices and, when needed, relays
encrypted bytes it cannot read.

This computer's device key and the list of paired devices are kept in `~/.paironce` (or `$PAIRONCE_HOME`), readable only
by you. The private key never leaves this computer.

It connects directly whenever the networks allow it, and otherwise through the encrypted relay over UDP, TCP or TLS on
port 443, so it also works on servers and in containers that block UDP. Networks that only allow traffic through an HTTP
proxy are not supported yet. `PAIRONCE_DEBUG=1` shows each step of connecting.

Requires Node.js 22 or later on Windows, macOS (x64 and arm64) or Linux (x64 and arm64).

## License

Apache-2.0. PairOnce is a trademark of its owner; see https://paironce.com.
