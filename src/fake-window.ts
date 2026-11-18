// A minimal model of browser windows for the tests: each window has an
// origin, a location hash, history.replaceState, message events, and handles
// to other windows whose postMessage delivers only when the target origin
// matches the destination's origin, stamped with the sender's origin and the
// destination's own handle back to the sender (like a real WindowProxy).

export class FakeWindow extends EventTarget {
  opener: Handle | null = null;
  readonly location: { pathname: string; search: string; hash: string };
  readonly history = {
    state: null as unknown,
    replaceState: (_state: unknown, _title: string, url: string) => {
      const u = new URL(url, this.origin);
      this.location.pathname = u.pathname;
      this.location.search = u.search;
      this.location.hash = u.hash;
    },
  };
  /** Windows this one opened. */
  readonly opened: FakeWindow[] = [];
  /** Called with each window this one opens (to start code in it); return false to block the pop-up. */
  onOpen?: (w: FakeWindow) => void | false;
  private handles = new Map<FakeWindow, Handle>();

  constructor(
    readonly origin: string,
    path = "/",
  ) {
    super();
    const u = new URL(path, origin);
    this.location = { pathname: u.pathname, search: u.search, hash: u.hash };
  }

  /** This window's handle to `other` (stable: the same object every time). */
  handle(other: FakeWindow): Handle {
    let h = this.handles.get(other);
    if (!h) {
      h = new Handle(this, other);
      this.handles.set(other, h);
    }
    return h;
  }

  open(url: string): Handle | null {
    const u = new URL(url);
    const child = new FakeWindow(u.origin, u.pathname + u.search + u.hash);
    child.opener = child.handle(this);
    if (this.onOpen?.(child) === false) return null;
    this.opened.push(child);
    return this.handle(child);
  }
}

export class Handle {
  closed = false;
  constructor(
    private readonly from: FakeWindow,
    readonly to: FakeWindow,
  ) {}

  postMessage(data: unknown, targetOrigin: string) {
    if (this.closed || (targetOrigin !== "*" && targetOrigin !== this.to.origin)) return;
    const ev = Object.assign(new Event("message"), {
      data,
      origin: this.from.origin,
      source: this.to.handle(this.from),
    });
    queueMicrotask(() => this.to.dispatchEvent(ev));
  }

  close() {
    this.closed = true;
  }
}
