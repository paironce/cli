// What an agent takes from a paired device, and how it pairs: only what it asked for, and never by a code from elsewhere.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({ current: undefined as any, connects: [] as any[] }));
vi.mock("./connection", () => ({ connect: async (...args: any[]) => { links.connects.push(args); return links.current instanceof Function ? links.current(...args) : links.current; } }));

const fakeLink = (session: Record<string, unknown>): any => ({
  session: { peerTakesRequests: () => true, peerTakesWatch: () => true, acceptFile: vi.fn(async () => {}), rejectFile: vi.fn(async () => {}),
    confirmFileSaved: vi.fn(async () => {}), withdrawRequest: vi.fn(async () => {}), stopWatch: vi.fn(async () => {}), ...session },
  peer: { id: "p".repeat(20), name: "Phone", publicKey: "k".repeat(87), pairedAt: 1, lastSeenAt: 1 }, path: "direct", events: {} as any, close: vi.fn(), isOpen: () => true,
});
const received = (name: string, bytes: Uint8Array, transferId = `t-${name}-aaaaaaaaaaaaaaaa`) => ({ transferId, name, size: bytes.length, url: "", mime: "image/jpeg", blob: new Blob([bytes.slice()]) });
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const pause = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

let cwd: string;
beforeEach(async () => {
  (await import("./mcp")).closeKeptLink();
  process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-test-"));
  const { saveDevice } = await import("./store");
  await saveDevice({ id: "p".repeat(20), name: "Phone", publicKey: "k".repeat(87) });
  cwd = mkdtempSync(path.join(tmpdir(), "paironce-work-"));
  process.chdir(cwd);
  links.connects.length = 0;
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

describe("a request takes what its own answer announced", () => {
  it("ignores an answer to another request, and a second answer to this one", async () => {
    const { callTool } = await import("./mcp");
    const link = fakeLink({ askFor: vi.fn(async () => "the-real-request-id-000") });
    links.current = link;
    const call = callTool("request_photo", { purpose: "label", wait_seconds: 10 });
    await vi.waitFor(() => expect(link.session.askFor).toHaveBeenCalled(), { timeout: 5000 });
    await pause(20);
    link.events.requestAnswer({ id: "not-the-request-id-0000", decision: "send", count: 5 });
    link.events.offer({ transferId: "offer-unrelated-aaaaaaaa", name: "unrelated.txt", size: 3, mime: "text/plain" });
    await pause(50);
    expect(link.session.acceptFile).not.toHaveBeenCalled();
    expect(link.session.rejectFile).toHaveBeenCalledOnce();
    link.events.requestAnswer({ id: "the-real-request-id-000", decision: "send", count: 1 });
    link.events.requestAnswer({ id: "the-real-request-id-000", decision: "send", count: 5 });
    link.events.offer({ transferId: "offer-asked-for-aaaaaaaa", name: "photo.jpg", size: 7, mime: "image/jpeg" });
    link.events.offer({ transferId: "offer-one-too-many-aaaaa", name: "extra.txt", size: 3, mime: "text/plain" });
    await pause(50);
    expect(link.session.acceptFile).toHaveBeenCalledOnce();
    expect(link.session.acceptFile).toHaveBeenCalledWith("offer-asked-for-aaaaaaaa");
    link.events.file(received("photo.jpg", JPEG));
    expect(await call).toContain("photo.jpg");
    expect(readdirSync(path.join(cwd, "inbox"))).toEqual(["photo.jpg"]);
  }, 20000);

  it("reads an answer of another kind as declined", async () => {
    const { callTool } = await import("./mcp");
    const link = fakeLink({ askFor: vi.fn(async () => "the-real-request-id-000") });
    links.current = link;
    const call = callTool("request_file", { purpose: "invoice", wait_seconds: 10 });
    await vi.waitFor(() => expect(link.session.askFor).toHaveBeenCalled(), { timeout: 5000 });
    await pause(20);
    link.events.requestAnswer({ id: "the-real-request-id-000", decision: "watch" });
    expect(await call).toContain("declined");
  }, 20000);
});

describe("a watch takes one JPEG for each still it asked for", () => {
  const WATCH = "watch-id-0000000000000";
  async function watching(call: () => Promise<unknown>) {
    const link = fakeLink({ askFor: vi.fn(async () => WATCH), askStill: vi.fn(async () => {}) });
    links.current = link;
    const running = call();
    await vi.waitFor(() => expect(link.session.askFor).toHaveBeenCalled(), { timeout: 5000 });
    await pause(20);
    link.events.requestAnswer({ id: WATCH, decision: "watch" });
    await vi.waitFor(() => expect(link.session.askStill).toHaveBeenCalled(), { timeout: 3000 });
    return { link, running };
  }

  it("takes the announced still only, and returns it", async () => {
    const { callTool } = await import("./mcp");
    const { link, running } = await watching(() => callTool("watch_frames", { purpose: "see it", count: 1 }));
    link.events.watchStillFile(WATCH, "still-one-aaaaaaaaaaaaaaaa");
    link.events.watchStillFile(WATCH, "still-two-aaaaaaaaaaaaaaaa");
    link.events.offer({ transferId: "still-two-aaaaaaaaaaaaaaaa", name: "b.jpg", size: 7, mime: "image/jpeg" });
    link.events.offer({ transferId: "still-one-aaaaaaaaaaaaaaaa", name: "a.jpg", size: 7, mime: "image/jpeg" });
    await pause(50);
    expect(link.session.acceptFile).toHaveBeenCalledOnce();
    expect(link.session.acceptFile).toHaveBeenCalledWith("still-one-aaaaaaaaaaaaaaaa");
    link.events.file(received("a.jpg", JPEG));
    const content = await running as { type: string; data?: string; mimeType?: string }[];
    expect(Buffer.from(content.find(item => item.type === "image")!.data!, "base64")).toEqual(Buffer.from(JPEG));
    await callTool("watch_stop", {});
  }, 20000);

  it("refuses a still that is not a JPEG of a still's size, and removes bytes that only claim to be one", async () => {
    const { callTool } = await import("./mcp");
    const { link, running } = await watching(() => callTool("watch_frames", { purpose: "see it", count: 1 }));
    link.events.watchStillFile(WATCH, "still-text-aaaaaaaaaaaaaaa");
    link.events.offer({ transferId: "still-text-aaaaaaaaaaaaaaa", name: "a.txt", size: 7, mime: "text/plain" });
    await pause(50);
    expect(link.session.rejectFile).toHaveBeenCalledWith("still-text-aaaaaaaaaaaaaaa");
    link.session.askStill = vi.fn(async () => {});
    await callTool("watch_stop", {});
    await running;

    (await import("./mcp")).closeKeptLink();
    const next = await watching(() => callTool("watch_frames", { purpose: "see it", count: 1 }));
    next.link.events.watchStillFile(WATCH, "still-fake-aaaaaaaaaaaaaaa");
    next.link.events.offer({ transferId: "still-fake-aaaaaaaaaaaaaaa", name: "fake.jpg", size: 10, mime: "image/jpeg" });
    await pause(50);
    next.link.events.file(received("fake.jpg", new TextEncoder().encode("not-a-jpeg")));
    const content = await next.running as { type: string; text?: string }[];
    expect(content.some(item => item.type === "image")).toBe(false);
    expect(content[0]!.text).toContain("not a JPEG");
    expect(readdirSync(path.join(cwd, "inbox", "watch"))).toEqual([]);
    await callTool("watch_stop", {});
  }, 30000);
});

describe("pair_device shows a code; it never takes one", () => {
  it("takes no code, and approves only on the user's word about the safety code", async () => {
    const { callTool, TOOLS } = await import("./mcp");
    const tool = TOOLS.find(item => item.name === "pair_device")!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).not.toContain("code");
    let settle!: (link: unknown) => void; let approved: boolean | undefined;
    const link = fakeLink({});
    links.current = (_identity: unknown, target: unknown, ui: any) => {
      expect(target).toEqual({ kind: "host" });
      setTimeout(() => ui.code("482196"));
      setTimeout(async () => {
        ui.safetyCode("12345678");
        approved = await ui.approve({ id: "p".repeat(20), name: "Phone\u001b[2J", publicKey: "k".repeat(87) });
        if (approved) settle(link);
      }, 300);
      return new Promise(resolve => { settle = resolve; });
    };
    expect(await callTool("pair_device", {})).toContain("482 196");
    const second = await callTool("pair_device", { wait_seconds: 5 }) as string;
    expect(second).toContain("1234 5678");
    expect(second).not.toContain("\u001b");
    expect(approved).toBeUndefined();
    expect(await callTool("pair_device", { confirm: true })).toContain("Paired with Phone");
    expect(approved).toBe(true);
    // The person just paired on their device: the next tool goes on over this connection, with no tap there.
    expect(link.close).not.toHaveBeenCalled();
    Object.assign(link.session, { sendText: vi.fn(async () => {}), drained: vi.fn(async () => {}) });
    links.connects.length = 0;
    expect(await callTool("send_text", { text: "hello" })).toContain("Sent to Phone");
    expect(link.session.sendText).toHaveBeenCalledWith("hello");
    expect(links.connects).toHaveLength(0);
  }, 20000);

  it("refuses the device when the user says the codes differ, and needs something to confirm", async () => {
    const { callTool } = await import("./mcp");
    await expect(callTool("pair_device", { confirm: true })).rejects.toThrow("Nothing to confirm");
    let approved: boolean | undefined;
    links.current = (_identity: unknown, _target: unknown, ui: any) => {
      setTimeout(() => ui.code("482196"));
      setTimeout(async () => { ui.safetyCode("12345678"); approved = await ui.approve({ id: "p".repeat(20), name: "Stranger", publicKey: "k".repeat(87) }); }, 100);
      return new Promise(() => {});
    };
    await callTool("pair_device", {});
    await expect(callTool("pair_device", { confirm: true })).rejects.toThrow("Nothing to confirm yet");
    await callTool("pair_device", { wait_seconds: 5 });
    expect(await callTool("pair_device", { confirm: false })).toContain("refused");
    expect(approved).toBe(false);
  }, 20000);
});

describe("the connection between tool calls", () => {
  const sending = () => fakeLink({ sendText: vi.fn(async () => {}), drained: vi.fn(async () => {}), usesTunnel: () => false });

  it("stays open, so a second tool connects to nothing", async () => {
    const { callTool } = await import("./mcp");
    const link = sending();
    links.current = link;
    await callTool("send_text", { text: "one" });
    await callTool("send_text", { text: "two" });
    expect(links.connects).toHaveLength(1);
    expect(link.close).not.toHaveBeenCalled();
    expect(link.session.sendText).toHaveBeenCalledTimes(2);
  });

  it("closes some time after the last tool, and a tool in between starts that time again", async () => {
    const { callTool, KEEP_OPEN_MS } = await import("./mcp");
    const link = sending();
    links.current = link;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await callTool("send_text", { text: "one" });
      vi.advanceTimersByTime(KEEP_OPEN_MS - 1000);
      await callTool("send_text", { text: "two" });
      vi.advanceTimersByTime(KEEP_OPEN_MS - 1000);
      expect(link.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2000);
      expect(link.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
    await callTool("send_text", { text: "three" });
    expect(links.connects).toHaveLength(2);
  });

  it("connects again when the person ended it", async () => {
    const { callTool } = await import("./mcp");
    const first = sending(); let open = true;
    first.isOpen = () => open;
    links.current = first;
    await callTool("send_text", { text: "one" });
    open = false;
    first.events.closed();
    const second = sending();
    links.current = second;
    await callTool("send_text", { text: "two" });
    expect(links.connects).toHaveLength(2);
    expect(second.session.sendText).toHaveBeenCalledWith("two");
  });

  it("is replaced for another device", async () => {
    const { callTool } = await import("./mcp");
    const { saveDevice } = await import("./store");
    await saveDevice({ id: "q".repeat(20), name: "Tablet", publicKey: "m".repeat(87) });
    const first = sending();
    links.current = first;
    await callTool("send_text", { text: "one", device: "Phone" });
    const second = sending();
    second.peer = { ...second.peer, id: "q".repeat(20), name: "Tablet" };
    links.current = second;
    await callTool("send_text", { text: "two", device: "Tablet" });
    expect(first.close).toHaveBeenCalledOnce();
    expect(links.connects).toHaveLength(2);
  });

  it("takes nothing unasked: what the person sends meanwhile waits for receive_files, and a request declines it", async () => {
    const { callTool } = await import("./mcp");
    const link = sending();
    Object.assign(link.session, { askFor: vi.fn(async () => "the-real-request-id-000") });
    links.current = link;
    await callTool("send_text", { text: "one" });
    link.events.offer({ transferId: "offer-held-aaaaaaaaaaaaaa", name: "held.jpg", size: 7, mime: "image/jpeg" });
    link.events.text("a note from the phone");
    expect(link.session.acceptFile).not.toHaveBeenCalled();
    expect(link.session.rejectFile).not.toHaveBeenCalled();
    const call = callTool("receive_files", { wait_seconds: 10 });
    await vi.waitFor(() => expect(link.session.acceptFile).toHaveBeenCalledWith("offer-held-aaaaaaaaaaaaaa"), { timeout: 5000 });
    link.events.file(received("held.jpg", JPEG, "offer-held-aaaaaaaaaaaaaa"));
    const reply = await call;
    expect(reply).toContain("held.jpg");
    expect(reply).toContain("a note from the phone");
    link.events.offer({ transferId: "offer-late-aaaaaaaaaaaaaa", name: "late.txt", size: 3, mime: "text/plain" });
    const asked = callTool("request_file", { purpose: "invoice", wait_seconds: 10 });
    await vi.waitFor(() => expect(link.session.rejectFile).toHaveBeenCalledWith("offer-late-aaaaaaaaaaaaaa"), { timeout: 5000 });
    await vi.waitFor(() => expect(link.session.askFor).toHaveBeenCalled(), { timeout: 5000 });
    await pause(20);
    link.events.requestAnswer({ id: "the-real-request-id-000", decision: "decline" });
    expect(await asked).toContain("declined");
  }, 30000);
});

describe("where an MCP tool saves", () => {
  it("is a folder inside the server's folder", async () => {
    const { insideFolder } = await import("./receive");
    const root = realpathSync(cwd);
    expect(await insideFolder(undefined, "inbox")).toBe(path.join(root, "inbox"));
    expect(await insideFolder("scans/2026", "inbox")).toBe(path.join(root, "scans", "2026"));
    expect(await insideFolder("./scans\\june", "inbox")).toBe(path.join(root, "scans", "june"));
  });

  it("refuses a way out, a dot folder, an absolute path and the folder itself", async () => {
    const { insideFolder } = await import("./receive");
    for (const folder of ["/etc", "C:\\Users\\me", "C:evil", "\\\\server\\share", "../up", "a/../../up", "~/.ssh", ".ssh", ".claude/commands", "a/.git/hooks", ".", "./", "a:b"]) {
      await expect(insideFolder(folder, "inbox"), folder).rejects.toThrow("must be a relative path");
    }
  });

  it("refuses a link that leads out", async () => {
    const { insideFolder } = await import("./receive");
    const outside = mkdtempSync(path.join(tmpdir(), "paironce-outside-"));
    try { symlinkSync(outside, path.join(cwd, "out"), "junction"); } catch { return; }
    await expect(insideFolder("out", "inbox")).rejects.toThrow("must be a relative path");
    await expect(insideFolder("out/deeper/still", "inbox")).rejects.toThrow("must be a relative path");
  });

  it("is checked before any tool connects", async () => {
    const { callTool } = await import("./mcp");
    links.connects.length = 0;
    await expect(callTool("receive_files", { folder: path.join(tmpdir(), ".ssh") })).rejects.toThrow("must be a relative path");
    await expect(callTool("request_file", { purpose: "a key", folder: "../up" })).rejects.toThrow("must be a relative path");
    await expect(callTool("watch_frames", { purpose: "see it", folder: "/etc" })).rejects.toThrow("must be a relative path");
    expect(links.connects).toHaveLength(0);
  });
});

describe("the MCP server's input", () => {
  it("answers valid JSON that is no request with an error", async () => {
    const { answer } = await import("./mcp");
    for (const input of [null, 7, "x", [], {}]) expect(await answer(input as never)).toMatchObject({ error: { code: -32600 } });
  });
});

describe("saving what arrives", () => {
  it("gives two files of one name two paths, with both contents", async () => {
    const { receiveInto } = await import("./receive");
    const link = fakeLink({});
    const saved: string[] = [];
    await receiveInto(link as never, cwd, { accept: async () => true, saved: file => saved.push(file) });
    link.events.file(received("photo.jpg", new Uint8Array(1000).fill(1), "first-aaaaaaaaaaaaaaaaaa"));
    link.events.file(received("photo.jpg", new Uint8Array(1000).fill(2), "second-aaaaaaaaaaaaaaaaa"));
    await vi.waitFor(() => expect(saved.length).toBe(2), { timeout: 5000 });
    expect(new Set(saved).size).toBe(2);
    expect(saved.map(file => readFileSync(file)[0]).sort()).toEqual([1, 2]);
  });

  it("keeps a sender's name inside the folder and free of control characters", async () => {
    const { uniquePath } = await import("./receive");
    for (const name of ["..\\..\\evil.txt", "../../evil.txt", "a\u001b[2Jb.txt", "‮gnp.exe"]) {
      const file = await uniquePath(cwd, name);
      expect(path.dirname(file)).toBe(cwd);
      expect(path.basename(file)).not.toMatch(/[\u0000-\u001f‮]/);
    }
  });
});

describe("the store shared by several processes", () => {
  it("keeps every device saved at once, and one identity", async () => {
    const { listDevices, loadOrCreateIdentity, saveDevice } = await import("./store");
    process.env.PAIRONCE_HOME = mkdtempSync(path.join(tmpdir(), "paironce-store-"));
    const identities = await Promise.all(Array.from({ length: 6 }, () => loadOrCreateIdentity()));
    expect(new Set(identities.map(item => item.id)).size).toBe(1);
    await Promise.all(Array.from({ length: 8 }, (_, n) => saveDevice({ id: `device-${n}`.padEnd(20, "x"), name: `Device ${n}`, publicKey: "k".repeat(87) })));
    expect((await listDevices()).length).toBe(8);
  }, 20000);
});

describe("a part kept by a process that ended", () => {
  const partial = (entry: string) => ({ peerId: "p".repeat(20), resumeKey: "r".repeat(32), entry, name: "big.bin", mime: "", size: 400, chunkSize: 100, totalChunks: 4, next: 2 });
  const sink = { write: async () => {}, finish: async () => new File([], "x"), abort: async () => {}, park: async () => {} };

  it("is found by the next one, for the same device and file", async () => {
    const { createDiskReceiver, partPath } = await import("./disk");
    writeFileSync(partPath(cwd, "entry-one"), new Uint8Array(200));
    const first = createDiskReceiver(cwd);
    void first.keepPartial(partial("entry-one"), sink);
    await first.settled();
    const next = createDiskReceiver(cwd);
    expect(next.findPartial("p".repeat(20), "r".repeat(32))).toBeUndefined();
    await next.restore();
    expect(next.findPartial("p".repeat(20), "r".repeat(32))).toMatchObject({ entry: "entry-one", next: 2 });
    expect(next.findPartial("q".repeat(20), "r".repeat(32))).toBeUndefined();
    next.takePartial(next.findPartial("p".repeat(20), "r".repeat(32))!);
    await vi.waitFor(() => expect(readdirSync(cwd).filter(name => name.endsWith(".json"))).toEqual([]));
    const third = createDiskReceiver(cwd);
    await third.restore();
    expect(third.findPartial("p".repeat(20), "r".repeat(32))).toBeUndefined();
  });

  it("is not taken when the note lies about what is on disk, or names another place", async () => {
    const { createDiskReceiver, partPath } = await import("./disk");
    writeFileSync(partPath(cwd, "short"), new Uint8Array(50));
    writeFileSync(path.join(cwd, ".paironce-short.json"), JSON.stringify({ partial: partial("short"), at: Date.now() }));
    writeFileSync(path.join(cwd, ".paironce-away.json"), JSON.stringify({ partial: partial("../../away"), at: Date.now() }));
    const next = createDiskReceiver(cwd);
    await next.restore();
    expect(next.findPartial("p".repeat(20), "r".repeat(32))).toBeUndefined();
  });
});

describe("parts left on disk", () => {
  it("go when they can no longer be continued", async () => {
    const { removeOldParts } = await import("./disk");
    const { partPath } = await import("./disk");
    writeFileSync(partPath(cwd, "old"), "x");
    writeFileSync(path.join(cwd, "keep.txt"), "x");
    await removeOldParts(cwd);
    expect(readdirSync(cwd).sort()).toEqual([".paironce-old.part", "keep.txt"]);
    await removeOldParts(cwd, Date.now() + 365 * 86_400_000);
    expect(readdirSync(cwd)).toEqual(["keep.txt"]);
  });
});

describe("names from the other device", () => {
  it("lose control and text-direction characters", async () => {
    const { safeName } = await import("./store");
    expect(safeName("evil\u001b[2Jname")).toBe("evil [2Jname");
    expect(safeName("a\u009bb‮c")).toBe("a b c");
    expect(safeName("\u0007")).toBe("device");
  });
});
