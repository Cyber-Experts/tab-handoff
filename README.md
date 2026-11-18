# tab-handoff

Hand files from one web app to another, **tab to tab**, with `postMessage`:
no server, nothing uploaded, no file data in the URL. Built for browser-only
tools (forensic parsers, viewers, converters) that want an "Open in …" button
to another site. No dependencies.

```text
sender tab                                   receiver tab (new, same browser)
──────────                                   ─────────────────────────────────
click "Open in X"
window.open("https://x.example/en#handoff=my-app")
                                       ───▶  page loads, sees #handoff=my-app
                                       ◀───  { type: "handoff:ready", v: 2, limits }   (to my-app's origins only)
extract the files (if needed)
{ type: "handoff:files", v: 2, files: [{ path, blob }] }  ───▶  (to x.example's origin only)
                                       ◀───  { type: "handoff:received", v: 2, count }
                                             drops window.opener, removes the flag
```

A `Blob` crosses tabs by reference, so large files are not copied, and a
slice of a big `File` stays a slice.

## Security model

The receiver:

- does nothing unless the URL has `#handoff=<sender id>` **and** the page has
  an opener **and** it lists that sender id;
- says "ready" only to that sender's exact origins (the browser drops the
  message for any other opener), with no data beyond its limits;
- accepts **one** message, only from the window that opened it
  (`event.source === window.opener`) and only from a listed origin;
- validates it: protocol version, at most `maxFiles` files, each a real
  `Blob` (no strings, buffers or other objects), within `maxFileBytes` and
  `maxTotalBytes`, with paths made safe (no `..`, `.`, empty or absolute
  segments, no control characters, bounded length);
- then answers once, sets `window.opener = null` and removes the flag from
  the URL. Without a valid message it gives up after a timeout.

The sender:

- only opens HTTPS receivers (or `http://localhost` in development);
- posts the files only to the receiver's exact origin, only after that tab
  said "ready", and checks the receiver's limits first (a clear error instead
  of a silent refusal);
- produces the files lazily, after opening the tab (keep the click
  synchronous for pop-up blockers).

What it does not do: authenticate users, encrypt, or protect against a
compromised sender or receiver site — each side trusts the other site's code.
The receiving app must still treat the files as untrusted input, exactly as a
dropped file.

## Receiver

```ts
import { receiveHandoff } from "tab-handoff";

useEffect(
  () =>
    receiveHandoff({
      senders: {
        "disk-image-parser": ["https://www.diskimageparser.com", "https://diskimageparser.com"],
      },
      maxFiles: 500,
      maxTotalBytes: 2 * 1024 ** 3,
      maxFileBytes: 512 * 1024 ** 2,
      onWait: () => setStatus("Receiving files…"),
      onFiles: (files) => ingest(files.map(({ path, file }) => ({ path, file }))),
      onTimeout: () => setError("No file arrived."),
    }),
  [],
);
```

## Sender

```ts
import { sendHandoff, HandoffError } from "tab-handoff";

function onClick() {
  // Synchronous from the click: the tab opens before anything is awaited.
  sendHandoff({
    url: "https://www.evtxparser.com/en",
    sender: "disk-image-parser",
    files: async () => [
      // lastModified (optional): the receiver's File keeps it, for tools that
      // date records by their file (1.1+).
      { path: "Windows/System32/winevt/Logs/Security.evtx", blob: await extract(node), lastModified: node.mtime },
    ],
    size: node.size, // optional: refuse before opening when over maxTotalBytes
    maxTotalBytes: 2 * 1024 ** 3,
  }).catch((e: HandoffError) => showError(e.message));
}
```

Errors are `HandoffError` with a `code`: `too-large`, `too-many`, `empty`,
`blocked` (pop-up blocked), `closed`, `timeout`, `bad-target`, `bad-sender`.

## Protocol

Version 2. Message types: `handoff:ready` (`{ limits }`), `handoff:files`
(`{ files: { path: string; blob: Blob; lastModified?: number }[] }`),
`handoff:received` (`{ count }`), all with `v: 2`. The hash flag is
`handoff=<id>`, where an id is 1–40 characters of `a-z`, `0-9` and `-`.
Other hash content is kept.

`lastModified` (ms since the epoch, added in 1.1.0) is optional both ways: a
1.0 receiver ignores it, and a 1.1 receiver gives the File the time it was
sent with, or the time of receipt when there is none. A value that is not a
finite number a `Date` can hold makes the message invalid; the sender leaves
such values out.

Requires a browser that passes `Blob` through `postMessage` (all current
browsers) and no `Cross-Origin-Opener-Policy` that severs the opener on
either page.

## Development

```bash
npm install
npm test          # vitest: protocol, validation and hostile-page cases
npm run typecheck
npm run build     # dist/index.js + dist/index.d.ts
```

## Releasing

Bump `version` in `package.json`, commit, and push a matching tag
(`git tag v1.0.1 && git push origin v1.0.1`). `.github/workflows/publish.yml`
then checks, builds and publishes with npm trusted publishing and provenance
(no npm token).

## License

MIT
