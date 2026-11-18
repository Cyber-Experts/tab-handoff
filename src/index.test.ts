import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWindow } from "./fake-window";
import {
  FILES,
  HandoffError,
  RECEIVED,
  VERSION,
  checkLimits,
  handoffSender,
  parseFiles,
  receiveHandoff,
  safePath,
  sendHandoff,
  stripHandoff,
  type ReceiveOptions,
  type ReceivedFile,
} from "./index";

const SENDER = "https://www.diskimageparser.com";
const RECEIVER = "https://www.evtxparser.com";
const EVIL = "https://evil.example";
const MB = 1024 * 1024;

const tick = () => new Promise((r) => setTimeout(r, 0));
const blob = (s: string) => new Blob([s]);
const text = (f: File) => f.text();

/** A receiver page opened by `opener` with the given hash, running receiveHandoff. */
function startReceiver(child: FakeWindow, extra: Partial<ReceiveOptions> = {}) {
  const got: { files?: ReceivedFile[]; sender?: string; timeout?: string; wait?: string } = {};
  const stop = receiveHandoff({
    window: child as unknown as Window,
    senders: { "disk-image-parser": [SENDER, "https://diskimageparser.com"], "msi-parser": ["https://www.msiparser.com"] },
    maxFiles: 10,
    maxTotalBytes: 10 * MB,
    maxFileBytes: 5 * MB,
    onFiles: (files, sender) => Object.assign(got, { files, sender }),
    onTimeout: (sender) => (got.timeout = sender),
    onWait: (sender) => (got.wait = sender),
    timeoutMs: 1000,
    ...extra,
  });
  return { got, stop };
}

describe("hash flag", () => {
  it("reads the sender id and keeps other hash content", () => {
    expect(handoffSender("#handoff=msi-parser")).toBe("msi-parser");
    expect(handoffSender("#range=a-b&handoff=disk-image-parser")).toBe("disk-image-parser");
    expect(handoffSender("#range=a-b")).toBeNull();
    expect(handoffSender("#handoff=Bad_ID")).toBeNull();
    expect(handoffSender("#handoff=")).toBeNull();
    expect(stripHandoff("#range=a-b&handoff=msi-parser")).toBe("#range=a-b");
    expect(stripHandoff("#handoff=msi-parser")).toBe("");
  });
});

describe("payload validation", () => {
  const limits = { maxFiles: 3, maxTotalBytes: 10, maxFileBytes: 6 };
  const msg = (files: unknown) => ({ type: FILES, v: VERSION, files });

  it("makes paths safe", () => {
    expect(safePath("../../etc/passwd")).toBe("etc/passwd");
    expect(safePath("\\Windows\\System32\\config\\SYSTEM")).toBe("Windows/System32/config/SYSTEM");
    expect(safePath("/a//./b/../c")).toBe("a/b/c");
    expect(safePath("na\u0000me\u001f.evtx")).toBe("name.evtx");
    expect(safePath("../..")).toBe("");
    expect(safePath(Array.from({ length: 40 }, (_, i) => `d${i}`).join("/")).split("/")).toHaveLength(32);
  });

  it("accepts files within the limits, as Files with safe paths", async () => {
    const got = parseFiles(msg([{ path: "Logs/../Security.evtx", blob: blob("abc") }, { path: "", blob: blob("d") }]), limits)!;
    expect(got.map((f) => f.path)).toEqual(["Logs/Security.evtx", "file-2.bin"]);
    expect(got[0].file.name).toBe("Security.evtx");
    expect(await text(got[0].file)).toBe("abc");
  });

  it("rejects anything else", () => {
    const ok = { path: "a", blob: blob("x") };
    for (const bad of [
      null,
      "x",
      { type: FILES, v: 1, files: [ok] },
      { type: "other", v: VERSION, files: [ok] },
      msg([]),
      msg("not an array"),
      msg([ok, ok, ok, ok]), // too many
      msg([{ path: "a", blob: new ArrayBuffer(1) }]),
      msg([{ path: "a", blob: new Uint8Array(1) }]),
      msg([{ path: "a", blob: "x" }]),
      msg([{ path: 1, blob: blob("x") }]),
      msg([{ path: "a", blob: blob("1234567") }]), // over maxFileBytes
      msg([{ path: "a", blob: blob("123456") }, { path: "b", blob: blob("12345") }]), // over maxTotalBytes
      msg([null]),
    ]) {
      expect(parseFiles(bad, limits)).toBeNull();
    }
  });

  it("checkLimits names the problem", () => {
    expect(checkLimits([], limits)?.code).toBe("empty");
    expect(checkLimits([1, 2, 3, 4].map(() => ({ path: "a", blob: blob("x") })), limits)?.code).toBe("too-many");
    expect(checkLimits([{ path: "a", blob: blob("1234567") }], limits)?.code).toBe("too-large");
    expect(checkLimits([{ path: "a", blob: blob("123") }], limits)).toBeNull();
  });
});

describe("handoff between two tabs", () => {
  let sender: FakeWindow;
  let receiver: { got: ReturnType<typeof startReceiver>["got"] } | null;
  beforeEach(() => {
    sender = new FakeWindow(SENDER, "/en");
    receiver = null;
    sender.onOpen = (child) => {
      receiver = startReceiver(child);
    };
  });
  afterEach(() => vi.useRealTimers());

  it("hands several files over and cleans up both sides", async () => {
    const sent = sendHandoff({
      window: sender as unknown as Window,
      url: `${RECEIVER}/en`,
      sender: "disk-image-parser",
      files: async () => [
        { path: "Windows/System32/winevt/Logs/Security.evtx", blob: blob("sec") },
        { path: "Windows/System32/winevt/Logs/System.evtx", blob: blob("sys") },
      ],
    });
    await sent;
    const child = sender.opened[0];
    expect(child.location.hash).toBe("");
    expect(child.opener).toBeNull();
    expect(receiver!.got.sender).toBe("disk-image-parser");
    expect(receiver!.got.files!.map((f) => f.path)).toEqual([
      "Windows/System32/winevt/Logs/Security.evtx",
      "Windows/System32/winevt/Logs/System.evtx",
    ]);
    expect(await Promise.all(receiver!.got.files!.map((f) => text(f.file)))).toEqual(["sec", "sys"]);
  });

  it("refuses early, with a clear error, what the receiver says it cannot take", async () => {
    const err = await sendHandoff({
      window: sender as unknown as Window,
      url: `${RECEIVER}/en`,
      sender: "disk-image-parser",
      files: async () => Array.from({ length: 11 }, (_, i) => ({ path: `f${i}`, blob: blob("x") })),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(HandoffError);
    expect(err.code).toBe("too-many");
    expect(sender.handle(sender.opened[0]).closed).toBe(true);
    expect(receiver!.got.files).toBeUndefined();
  });

  it("refuses an oversize handoff before any tab opens", async () => {
    const err = await sendHandoff({
      window: sender as unknown as Window,
      url: `${RECEIVER}/en`,
      sender: "disk-image-parser",
      size: 600 * MB,
      maxTotalBytes: 512 * MB,
      files: async () => [],
    }).catch((e) => e);
    expect(err.code).toBe("too-large");
    expect(sender.opened).toHaveLength(0);
  });

  it("reports a blocked pop-up, a non-HTTPS target and a bad sender id", async () => {
    sender.onOpen = () => false;
    const base = { window: sender as unknown as Window, sender: "disk-image-parser", files: async () => [] };
    expect((await sendHandoff({ ...base, url: `${RECEIVER}/en` }).catch((e) => e)).code).toBe("blocked");
    expect((await sendHandoff({ ...base, url: "http://www.evtxparser.com/en" }).catch((e) => e)).code).toBe("bad-target");
    expect((await sendHandoff({ ...base, url: "javascript:alert(1)" }).catch((e) => e)).code).toBe("bad-target");
    expect((await sendHandoff({ ...base, url: `${RECEIVER}/en`, sender: "Evil Id" }).catch((e) => e)).code).toBe("bad-sender");
  });

  it("times out without closing the tab when the receiver never answers", async () => {
    vi.useFakeTimers();
    sender.onOpen = () => {}; // a page without handoff support
    const p = sendHandoff({
      window: sender as unknown as Window,
      url: `${RECEIVER}/en`,
      sender: "disk-image-parser",
      timeoutMs: 1000,
      files: async () => [{ path: "a", blob: blob("x") }],
    }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1001);
    expect((await p).code).toBe("timeout");
    expect(sender.handle(sender.opened[0]).closed).toBe(false);
  });
});

describe("hostile pages", () => {
  afterEach(() => vi.useRealTimers());

  it("a foreign site that opens the tool never hears 'ready' and cannot inject files", async () => {
    vi.useFakeTimers();
    const evil = new FakeWindow(EVIL);
    const heard: unknown[] = [];
    evil.addEventListener("message", (e) => heard.push((e as MessageEvent).data));
    let r: ReturnType<typeof startReceiver> | null = null;
    evil.onOpen = (child) => {
      r = startReceiver(child);
    };
    const tab = evil.open(`${RECEIVER}/en#handoff=disk-image-parser`)!;
    await vi.advanceTimersByTimeAsync(10);
    expect(heard).toEqual([]); // READY went to the allowed origins only
    tab.postMessage({ type: FILES, v: VERSION, files: [{ path: "x.evtx", blob: blob("evil") }] }, "*");
    await vi.advanceTimersByTimeAsync(10);
    expect(r!.got.files).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r!.got.timeout).toBe("disk-image-parser");
    expect(evil.opened[0].location.hash).toBe("");
  });

  it("a page at the right origin that is not the opener is ignored", async () => {
    const sender = new FakeWindow(SENDER);
    let r: ReturnType<typeof startReceiver> | null = null;
    sender.onOpen = (child) => {
      r = startReceiver(child);
    };
    sender.open(`${RECEIVER}/en#handoff=disk-image-parser`);
    const child = sender.opened[0];
    const sameOriginOther = new FakeWindow(SENDER);
    sameOriginOther.handle(child).postMessage({ type: FILES, v: VERSION, files: [{ path: "a", blob: blob("x") }] }, RECEIVER);
    await tick();
    expect(r!.got.files).toBeUndefined();
    r!.stop();
  });

  it("a sender id the receiver does not know, or no opener, does nothing", async () => {
    const opener = new FakeWindow(SENDER);
    let r: ReturnType<typeof startReceiver> | null = null;
    opener.onOpen = (child) => {
      r = startReceiver(child);
    };
    opener.open(`${RECEIVER}/en#handoff=unknown-tool`);
    expect(r!.got.wait).toBeUndefined();
    expect(opener.opened[0].location.hash).toBe("");

    const lone = new FakeWindow(RECEIVER, "/en#handoff=disk-image-parser");
    const rr = startReceiver(lone);
    expect(rr.got.wait).toBeUndefined();
    expect(lone.location.hash).toBe("");
  });

  it("accepts exactly one message", async () => {
    const sender = new FakeWindow(SENDER);
    let r: ReturnType<typeof startReceiver> | null = null;
    sender.onOpen = (child) => {
      r = startReceiver(child);
    };
    const tab = sender.open(`${RECEIVER}/en#handoff=disk-image-parser`)!;
    const acks: unknown[] = [];
    sender.addEventListener("message", (e) => acks.push((e as MessageEvent).data));
    tab.postMessage({ type: FILES, v: VERSION, files: [{ path: "first", blob: blob("1") }] }, RECEIVER);
    await tick();
    tab.postMessage({ type: FILES, v: VERSION, files: [{ path: "second", blob: blob("2") }] }, RECEIVER);
    await tick();
    expect(r!.got.files!.map((f) => f.path)).toEqual(["first"]);
    expect(acks.filter((a) => (a as { type: string }).type === RECEIVED)).toHaveLength(1);
  });
});
