# tab-handoff

[![npm](https://img.shields.io/npm/v/tab-handoff)](https://www.npmjs.com/package/tab-handoff)
[![license](https://img.shields.io/npm/l/tab-handoff)](./LICENSE)

Hand files from one web app to another, **tab to tab**, with `postMessage`.
No server, no upload, and nothing about the files in the URL.

Use it to add an **"Open in …"** button to a browser-only tool, such as a
parser, viewer or converter, that sends the user's files to a tool on
another site. The other site opens in a new tab with the files already
loaded. The files never leave the user's machine.

- **Zero dependencies**, about 11 KB unminified, typed.
- **Origin-locked both ways.** Each side talks only to origins it names.
- **Validated.** The receiver checks the shape, the file count, the sizes
  and the paths before your code sees anything.
- **No copying.** A `Blob` crosses tabs by reference, so a multi-gigabyte
  file costs nothing to hand over. A slice of a large `File` stays a slice.

```bash
npm install tab-handoff
```

Works with `import` and `require`.

## How it works

```text
Sender tab                          Receiver tab
----------                          ------------
user clicks "Open in X"
window.open(url#handoff=my-app) --> page loads, sees the flag
                                <-- handoff:ready { limits }
produce the files
handoff:files [{ path, blob }]  --> checks origin, shape, limits
                                <-- handoff:received { count }
promise resolves                    drops opener, cleans the URL
```

## Receiving files

Call `receiveHandoff` once when the page loads. On a normal visit it does
nothing and returns a no-op. Only a page opened with `#handoff=<id>`, by a
sender you list, starts listening.

```ts
import { receiveHandoff } from "tab-handoff";

const stop = receiveHandoff({
  // Sender id → the exact origins it may send from.
  senders: {
    "disk-image-parser": ["https://www.diskimageparser.com", "https://diskimageparser.com"],
  },
  maxFiles: 500,
  maxTotalBytes: 2 * 1024 ** 3, // 2 GiB in all
  maxFileBytes: 512 * 1024 ** 2, // 512 MiB per file
  onWait: () => showStatus("Receiving files…"),
  onFiles: (files) => {
    for (const { path, file } of files) openFile(path, file); // file is a File
  },
  onTimeout: () => showError("No file arrived."),
});
```

In React, return the stop function from an effect:

```tsx
useEffect(() => receiveHandoff({ senders, maxFiles, maxTotalBytes, onFiles }), []);
```

| Option          | Type                                    | Default         |                                                                    |
| --------------- | --------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `senders`       | `Record<string, readonly string[]>`     | required        | Sender ids and the exact origins (scheme + host + port) of each.   |
| `maxFiles`      | `number`                                | required        | Most files in one handoff.                                         |
| `maxTotalBytes` | `number`                                | required        | Most bytes for all files together.                                 |
| `maxFileBytes`  | `number`                                | `maxTotalBytes` | Most bytes for any one file.                                       |
| `onFiles`       | `(files: ReceivedFile[], sender) => void` | required      | Called once with `{ path, file }[]`.                               |
| `onWait`        | `(sender) => void`                      |                 | Called when a handoff starts. Use it to show a waiting state.      |
| `onTimeout`     | `(sender) => void`                      |                 | Called when no valid message arrives in time.                      |
| `timeoutMs`     | `number`                                | `60000`         | How long to wait for the files.                                    |

Paths are relative and safe to use: forward slashes, no `.`, `..` or empty
segments, no control characters, at most 32 segments and 1024 characters. If
nothing usable is left, the path becomes `file-<n>.bin`. Each `File` keeps
the sender's MIME type and modification time (from 1.1.0).

## Sending files

Call `sendHandoff` **synchronously from the click handler**. It opens the tab
before awaiting anything, so pop-up blockers let it through. The files are
produced afterwards, by your `files` callback, while the receiver loads.

```ts
import { sendHandoff, HandoffError } from "tab-handoff";

button.addEventListener("click", () => {
  sendHandoff({
    url: "https://www.evtxparser.com/en",
    sender: "disk-image-parser",
    files: async () => [
      {
        path: "Windows/System32/winevt/Logs/Security.evtx",
        blob: await extract(node),
        lastModified: node.mtime, // optional, ms since the epoch
      },
    ],
    size: node.size, // optional: refuse before opening a tab
    maxTotalBytes: 2 * 1024 ** 3,
  })
    .then(() => showStatus("Opened in EVTX Parser."))
    .catch((e: HandoffError) => showError(e.message));
});
```

| Option          | Type                           | Default  |                                                                         |
| --------------- | ------------------------------ | -------- | ----------------------------------------------------------------------- |
| `url`           | `string`                       | required | The receiver page. HTTPS, or `http://localhost` in development.          |
| `sender`        | `string`                       | required | Your id as the receiver lists it: 1–40 characters of `a-z`, `0-9`, `-`. |
| `files`         | `() => Promise<HandoffFile[]>` | required | Produces `{ path, blob, lastModified? }[]` once the tab is open.        |
| `size`          | `number`                       |          | Total size if known up front, checked before any tab opens.             |
| `maxTotalBytes` | `number`                       |          | The receiver's total limit, if you know it, for an early refusal.       |
| `timeoutMs`     | `number`                       | `60000`  | How long to wait for the receiver.                                      |

The promise resolves when the receiver confirms that it has the files. It
rejects with a `HandoffError` whose `code` says why:

| Code         | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `blocked`    | The browser blocked the new tab.                                                         |
| `bad-target` | The URL is invalid or not HTTPS.                                                         |
| `bad-sender` | The sender id is not 1–40 characters of `a-z`, `0-9`, `-`.                              |
| `empty`      | `files()` returned no file.                                                              |
| `too-many`   | More files than the receiver accepts.                                                    |
| `too-large`  | Over the receiver's per-file or total limit.                                             |
| `timeout`    | The receiver did not answer in time, for example because it does not list this sender. |
| `closed`     | The user closed the receiving tab first.                                                 |

The messages are written for end users. When the files are never sent
(extraction failed, limits exceeded), the empty tab is closed. After a
timeout the tab is left open.

## Security model

The receiver does nothing unless all three hold: the URL has
`#handoff=<id>`, the page has an `opener`, and the id is in `senders`. It
then:

- sends "ready" only to that sender's listed origins. The browser drops the
  message if the opener is anywhere else, so no other site receives it;
- accepts **one** message, only from `window.opener` and only from a listed
  origin;
- rejects the message unless it has the right protocol version and every
  file is a real `Blob` (not a string or a buffer) within the limits;
- after accepting, replies once, sets `window.opener = null` and removes the
  flag from the URL.

The sender only opens HTTPS receivers. It posts the files only to the
receiver's exact origin, only after that tab has said "ready", and only
within the limits it announced.

**Out of scope:** authentication, encryption, and protection against a
compromised sender or receiver site. Each side trusts the other site's code.
Treat received files as untrusted input, just like a file dropped on the
page.

## Requirements

- A browser that passes `Blob` through `postMessage`, as all current browsers
  do.
- No `Cross-Origin-Opener-Policy` that severs the opener on either page:
  `same-origin` breaks the handoff, `unsafe-none` (the default) works.
- Both functions run in the browser. Call them from client code only.

## Protocol

For implementing either side without this package. Protocol version 2,
unrelated to the package version.

| Message            | Direction           | Fields                                                                         |
| ------------------ | ------------------- | ------------------------------------------------------------------------------ |
| `handoff:ready`    | receiver → sender   | `v: 2`, `limits: { maxFiles, maxTotalBytes, maxFileBytes }`                    |
| `handoff:files`    | sender → receiver   | `v: 2`, `files: { path: string; blob: Blob; lastModified?: number }[]`         |
| `handoff:received` | receiver → sender   | `v: 2`, `count: number`                                                        |

The receiver is opened with the hash flag `handoff=<id>`. Other hash content
is kept, and the flag is removed once the handoff is handled.

`lastModified` (from 1.1.0) is optional in both directions. A 1.0 receiver
ignores it. A 1.1 receiver uses it, or the time of receipt when it is
absent. A value that is not a finite number within `Date`'s range makes the
message invalid, so the sender leaves such values out.

The helpers behind the protocol are exported too: `checkLimits`,
`parseFiles`, `safePath`, `handoffSender`, `stripHandoff`, and the
constants `VERSION`, `READY`, `FILES`, `RECEIVED`, `DEFAULT_TIMEOUT_MS`.

## License

[MIT](./LICENSE)
