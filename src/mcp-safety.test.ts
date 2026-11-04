// What an agent takes from a paired device, and how it pairs: only what it asked for, and never by a code from elsewhere.
import { mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({ current: undefined as any, connects: [] as any[] }));
vi.mock("./connection", () => ({ connect: async (...args: any[]) => { links.connects.push(args); return links.current instanceof Function ? links.current(...args) : links.current; } }));

const fakeLink = (session: Record<string, unknown>): any => ({
  session: { peerTakesRequests: () => true, peerTakesWatch: () => true, acceptFile: vi.fn(async () => {}), rejectFile: vi.fn(async () => {}),
    confirmFileSaved: vi.fn(async () => {}), withdrawRequest: vi.fn(async () => {}), stopWatch: vi.fn(async () => {}), ...session },
  peer: { id: "p".repeat(20), name: "Phone", publicKey: "k".repeat(87), pairedAt: 1, lastSeenAt: 1 }, path: "direct", events: {} as any, close: vi.fn(),
});
const received = (name: string, bytes: Uint8Array, transferId = `t-${name}-aaaaaaaaaaaaaaaa`) => ({ transferId, name, size: bytes.length, url: "", mime: "image/jpeg", blob: new Blob([bytes.slice()]) });
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const pause = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

let cwd: string;
beforeEach(async () => {
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
    expect(link.close).toHaveBeenCalled();
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

describe("names from the other device", () => {
  it("lose control and text-direction characters", async () => {
    const { safeName } = await import("./store");
    expect(safeName("evil\u001b[2Jname")).toBe("evil [2Jname");
    expect(safeName("a\u009bb‮c")).toBe("a b c");
    expect(safeName("\u0007")).toBe("device");
  });
});
