// tab-handoff: hand files from one web app to another, tab to tab, without a
// server. Protocol version 2.
//
// The sender opens the receiver in a new tab with `#handoff=<sender id>` and
// keeps the tab's handle. The receiver says it is ready to its opener; the
// sender then posts the files as Blobs with `postMessage`, addressed to the
// receiver's exact origin. A Blob crosses tabs by reference, so large files
// are not copied. Nothing is uploaded and the URL carries nothing about the
// files.
//
// The receiver accepts exactly one message, only from the window that opened
// it and only from an origin it lists for that sender id, in the expected
// shape and within its limits; it then drops its reference to the opener.
// The sender posts only to the receiver's exact origin, and only after that
// tab has said it is ready.

export const VERSION = 2;
export const READY = "handoff:ready";
export const FILES = "handoff:files";
export const RECEIVED = "handoff:received";
export const DEFAULT_TIMEOUT_MS = 60_000;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** A file being handed over: a relative path (folders allowed) and its bytes. */
export interface HandoffFile {
  path: string;
  blob: Blob;
  /**
   * When the file was last modified (ms since the epoch), e.g. from the file
   * system it was extracted from. The receiver's File carries it (1.1+), for
   * tools that date records by their file. Left out when not finite.
   */
  lastModified?: number;
}

/** Valid `lastModified` values: what a JavaScript Date can hold. */
const MAX_TIME = 8.64e15;
const isTime = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= MAX_TIME;

/** A file as the receiver gets it: a safe relative path and a File over the received bytes. */
export interface ReceivedFile {
  path: string;
  file: File;
}

/** What one handoff may carry. */
export interface Limits {
  /** Most files in one handoff (at least 1). */
  maxFiles: number;
  /** Most bytes for all files together. */
  maxTotalBytes: number;
  /** Most bytes for any one file (defaults to maxTotalBytes). */
  maxFileBytes?: number;
}

// ---------------------------------------------------------------------------
// Hash flag

const tokens = (hash: string) => hash.replace(/^#/, "").split("&").filter(Boolean);

/** The sender id a location hash asks to receive from, or null. */
export function handoffSender(hash: string): string | null {
  for (const t of tokens(hash)) {
    if (t.startsWith("handoff=")) {
      const id = t.slice("handoff=".length);
      return ID_RE.test(id) ? id : null;
    }
  }
  return null;
}

/** The hash without any handoff flag; other hash content is kept. */
export function stripHandoff(hash: string): string {
  const rest = tokens(hash).filter((t) => !t.startsWith("handoff="));
  return rest.length ? `#${rest.join("&")}` : "";
}

// ---------------------------------------------------------------------------
// Paths and payload

/**
 * A relative path made safe: forward slashes, no empty, `.` or `..`
 * segments, no control characters, at most 32 segments of 255 characters and
 * 1024 characters in all. Returns "" when nothing usable is left.
 */
export function safePath(path: string): string {
  const parts = path
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim().slice(0, 255))
    .filter((s) => s && s !== "." && s !== "..");
  return parts.slice(-32).join("/").slice(-1024).replace(/^\/+/, "");
}

/**
 * Validates a `handoff:files` message against the limits; returns the files
 * (with safe paths and File objects over the received Blobs) or null.
 */
export function parseFiles(data: unknown, limits: Limits): ReceivedFile[] | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== FILES || d.v !== VERSION || !Array.isArray(d.files)) return null;
  const items = d.files as unknown[];
  if (items.length < 1 || items.length > Math.max(1, limits.maxFiles)) return null;
  const perFile = limits.maxFileBytes ?? limits.maxTotalBytes;
  let total = 0;
  const out: ReceivedFile[] = [];
  for (const [i, item] of items.entries()) {
    if (typeof item !== "object" || item === null) return null;
    const { path, blob, lastModified } = item as { path?: unknown; blob?: unknown; lastModified?: unknown };
    if (typeof path !== "string" || !(blob instanceof Blob)) return null;
    if (lastModified !== undefined && !isTime(lastModified)) return null;
    if (blob.size > perFile) return null;
    total += blob.size;
    if (total > limits.maxTotalBytes) return null;
    const p = safePath(path) || `file-${i + 1}.bin`;
    const name = p.slice(p.lastIndexOf("/") + 1);
    // A File over the received Blob: same bytes, not copied.
    const file = new File([blob], name, lastModified === undefined ? { type: blob.type } : { type: blob.type, lastModified });
    out.push({ path: p, file });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Receiver

export interface ReceiveOptions extends Limits {
  /** Sender id → the exact origins it may send from, e.g. { "msi-parser": ["https://www.msiparser.com"] }. */
  senders: Record<string, readonly string[]>;
  /** Called once the page is waiting for the files. */
  onWait?: (sender: string) => void;
  onFiles: (files: ReceivedFile[], sender: string) => void;
  /** No valid files arrived in time. */
  onTimeout?: (sender: string) => void;
  timeoutMs?: number;
  /** The receiving window (tests). */
  window?: Window;
}

/**
 * Starts receiving when this page was opened for a handoff from a known
 * sender; returns a function that stops. Does nothing (and returns a no-op)
 * otherwise. The handoff flag is removed from the URL once it is handled.
 */
export function receiveHandoff(o: ReceiveOptions): () => void {
  const win = o.window ?? (typeof window === "undefined" ? undefined : window);
  if (!win) return () => {};
  const sender = handoffSender(win.location.hash);
  if (!sender) return () => {};
  const origins = Object.prototype.hasOwnProperty.call(o.senders, sender) ? o.senders[sender] : undefined;
  const clearFlag = () => {
    const { pathname, search, hash } = win.location;
    win.history.replaceState(win.history.state, "", pathname + search + stripHandoff(hash));
  };
  const opener = win.opener as Window | null;
  if (!origins?.length || !opener) {
    clearFlag();
    return () => {};
  }
  let live = true;
  const stop = () => {
    live = false;
    clearTimeout(timer);
    win.removeEventListener("message", onMessage);
  };
  const onMessage = (e: MessageEvent) => {
    if (!live || e.source !== opener || !origins.includes(e.origin)) return;
    const files = parseFiles(e.data, o);
    if (!files) return;
    stop();
    clearFlag();
    opener.postMessage({ type: RECEIVED, v: VERSION, count: files.length }, e.origin);
    // The opener is no longer needed: drop the reference to it.
    win.opener = null;
    o.onFiles(files, sender);
  };
  const timer = setTimeout(() => {
    if (!live) return;
    stop();
    clearFlag();
    o.onTimeout?.(sender);
  }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  win.addEventListener("message", onMessage);
  o.onWait?.(sender);
  // Only an opener at one of these origins gets this; the browser drops it
  // for any other. The limits let the sender refuse early with a clear error.
  const limits: Limits = { maxFiles: o.maxFiles, maxTotalBytes: o.maxTotalBytes, maxFileBytes: o.maxFileBytes ?? o.maxTotalBytes };
  for (const origin of origins) opener.postMessage({ type: READY, v: VERSION, limits }, origin);
  return stop;
}

// ---------------------------------------------------------------------------
// Sender

export interface SendOptions {
  /** The receiver page, without a hash, e.g. "https://www.peparser.com/en". */
  url: string;
  /** This app's sender id, as the receiver lists it. */
  sender: string;
  /** Produces the files once the receiver is open (may extract them first). */
  files: () => Promise<HandoffFile[]>;
  /** Total size, when known before opening: checked against maxTotalBytes before any tab opens. */
  size?: number;
  /** The receiver's limit for all files together, to refuse early. */
  maxTotalBytes?: number;
  timeoutMs?: number;
  /** The sending window (tests). */
  window?: Window;
}

export class HandoffError extends Error {
  constructor(
    readonly code: "too-large" | "too-many" | "empty" | "blocked" | "closed" | "timeout" | "bad-target" | "bad-sender",
    message: string,
  ) {
    super(message);
    this.name = "HandoffError";
  }
}

/** Why `files` break the receiver's limits, or null when they fit. */
export function checkLimits(files: readonly HandoffFile[], limits: Limits): HandoffError | null {
  if (files.length === 0) return new HandoffError("empty", "There is no file to hand over.");
  if (files.length > Math.max(1, limits.maxFiles)) {
    return new HandoffError("too-many", `Too many files for the receiving tool (${files.length}, at most ${limits.maxFiles}).`);
  }
  const perFile = limits.maxFileBytes ?? limits.maxTotalBytes;
  let total = 0;
  for (const f of files) {
    if (f.blob.size > perFile) return new HandoffError("too-large", "A file is too large for the receiving tool.");
    total += f.blob.size;
  }
  return total > limits.maxTotalBytes ? new HandoffError("too-large", "Too large for the receiving tool.") : null;
}

const isLimits = (x: unknown): x is Limits => {
  const l = x as Partial<Limits> | null;
  return !!l && typeof l === "object" && Number.isFinite(l.maxFiles) && Number.isFinite(l.maxTotalBytes);
};

/**
 * Opens the receiver and hands it the files. Call it synchronously from a
 * click: the tab opens before anything is awaited, so pop-up blockers allow
 * it. Resolves once the receiver confirms it has the files.
 */
export function sendHandoff(o: SendOptions): Promise<void> {
  const win = o.window ?? window;
  let target: URL;
  try {
    target = new URL(o.url);
  } catch {
    return Promise.reject(new HandoffError("bad-target", "Invalid receiver URL."));
  }
  const local = target.hostname === "localhost" || target.hostname === "127.0.0.1";
  if (target.protocol !== "https:" && !(local && target.protocol === "http:")) {
    return Promise.reject(new HandoffError("bad-target", "The receiver must be served over HTTPS."));
  }
  if (!ID_RE.test(o.sender)) return Promise.reject(new HandoffError("bad-sender", "Invalid sender id."));
  if (o.size !== undefined && o.maxTotalBytes !== undefined && o.size > o.maxTotalBytes) {
    return Promise.reject(new HandoffError("too-large", "Too large for the receiving tool."));
  }
  const origin = target.origin;
  target.hash = `handoff=${o.sender}`;
  const tab = win.open(target.href, "_blank");
  if (!tab) return Promise.reject(new HandoffError("blocked", "The browser blocked the new tab. Allow pop-ups for this site and try again."));

  return new Promise<void>((resolve, reject) => {
    let limits: Limits | null = null;
    let sent = false;
    let done = false;
    let files: HandoffFile[] | null = null;
    // `close`: the files never went out (extraction failed, over the limits),
    // so the empty tab is closed; after a timeout it is left to the user.
    const end = (err?: Error, close = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      win.removeEventListener("message", onMessage);
      if (close) tab.close();
      if (err) reject(err);
      else resolve();
    };
    const send = () => {
      if (!limits || !files || sent) return;
      const err = checkLimits(files, limits);
      if (err) return end(err, true);
      sent = true;
      // Only the fields of the protocol, and a lastModified only when valid.
      const payload = files.map(({ path, blob, lastModified }) =>
        isTime(lastModified) ? { path, blob, lastModified } : { path, blob },
      );
      tab.postMessage({ type: FILES, v: VERSION, files: payload }, origin);
      files = null;
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== tab || e.origin !== origin) return;
      const d = e.data as { type?: unknown; v?: unknown; limits?: unknown } | null;
      if (!d || d.v !== VERSION) return;
      if (d.type === READY && isLimits(d.limits)) {
        limits = d.limits;
        send();
      } else if (d.type === RECEIVED && sent) {
        end();
      }
    };
    const timer = setTimeout(
      () =>
        end(
          tab.closed
            ? new HandoffError("closed", "The receiving tab was closed before it got the files.")
            : new HandoffError("timeout", "The receiving tool did not answer in time."),
        ),
      o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    win.addEventListener("message", onMessage);
    o.files().then(
      (f) => {
        if (f.length === 0) throw new HandoffError("empty", "There is no file to hand over.");
        const total = f.reduce((n, x) => n + x.blob.size, 0);
        if (o.maxTotalBytes !== undefined && total > o.maxTotalBytes) {
          throw new HandoffError("too-large", "Too large for the receiving tool.");
        }
        files = f;
        send();
      },
    ).catch((err: unknown) => end(err instanceof Error ? err : new Error(String(err)), true));
  });
}
