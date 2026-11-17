# ttyp phone workspace

`ttyp` provides a personal, phone-first browser terminal backed by a dedicated
tmux workspace. Open the same URL on your phone and desktop to mirror the active
tab. Each tab is a tmux window; new tabs open a shell. Your CLI applications,
including Devin CLI, run on the server.

## Build and run

Use the repository's existing native ttyd build dependencies, Node for building
the embedded frontend, Yarn 3.6.3, and tmux on your host. Node is not needed at
runtime. The Linux CI candidates are dynamically linked Ubuntu 24.04 binaries;
install libwebsockets (including its libuv event-loop plugin), libuv, json-c,
OpenSSL, and zlib on a compatible host. They are not static portable binaries.

```sh
cd html
corepack yarn install --immutable
TTYP=1 corepack yarn build
cd ..
cmake -S . -B build-phone -DBUILD_TTYP=ON
cmake --build build-phone --parallel 4
./build-phone/ttyp -i 127.0.0.1 -p 7682 -w /your/projects
```

Run as your normal account; `--uid` and `--gid` are unsupported. The binary uses tmux socket `ttyp` and session `phone`;
you can override these with `--tmux-socket NAME --tmux-session NAME` using letters,
numbers, hyphens, and underscores. Reserve this socket for ttyp. Its tmux server
starts without your personal tmux configuration. Your normal shell configuration
still applies. Use a distinct socket for each independent deployment.

The existing ttyd transport flags for authentication, TLS, interface, base path,
and port are available. Writing and origin checks are enabled by default.
`--url-arg` and supplying an arbitrary startup command are unsupported.

For `ttyp.vookie.net`, configure your existing HTTPS/access gateway to proxy both
HTTP and WebSocket upgrades to this service, preserving the public Host header.
Protect the entire site, including `/token` and `/ws`. Keep the backend private;
this application exposes your account's shell and does not implement separate
user accounts. If your proxy runs on a different host, bind to an appropriate
private interface and restrict access to that proxy. No DNS or live gateway
changes are performed by building ttyp.

## Using your phone

- Tap Keyboard to bring up your keyboard. Use the key bar for Esc, Tab, arrows,
  Ctrl+C, and Enter; More keys includes the other Ctrl combinations and navigation.
- Compose opens a native text editor suitable for paste and iPhone dictation.
  Insert transfers the draft to its original tab without pressing Enter. The
  application controls bracketed-paste behavior; press Enter separately to submit.
- Drafts are kept per window in browser memory while the page is open. Reloading
  discards drafts. A network reconnect does not replay your input.
- Read / copy opens a snapshot of the current pane and up to 5,000 available
  scrollback lines. Refresh explicitly. This is tmux's available output, not a
  complete Devin transcript; use navigation keys for application-owned history.
- The tab menu renames a tab; an empty name offers confirmed closure. Closing a
  tab terminates its applications. Closing the browser only detaches.
- A connected phone controls terminal dimensions. Desktop browsers mirror that
  grid. Phone connections stop holding sizing after their heartbeat expires.
  Without a phone, desktop clients provide dimensions.

A server restart preserves the tmux workspace. A host reboot or tmux server exit
does not preserve running processes. For systemd, keep tmux outside the service's
termination group (for example, `KillMode=process`) if service restarts must leave
applications alive. Use an explicit tmux command to stop the workspace when
intended: `tmux -L ttyp kill-session -t phone`.

## Verification and acceptance

`test/phone-check.js` exercises the actual binary and an isolated tmux server.
`test/phone-browser.js` tests Chromium or WebKit with a simulated phone viewport.
Install Playwright and ws in a disposable prefix and set `NODE_PATH` to its
`node_modules`; set `TTYP_BINARY` to override `./build-phone/ttyp`. Set
`CHROME_HEADLESS_SHELL` to an existing headless-shell binary when needed.

Before treating a deployment as accepted, test on your actual iPhone and record
iPhone model, iOS version, and `devin --version`. Verify typing/deletion,
dictation, multiline paste, approval dialogs, cancellation, scroll/copy, keyboard
dismissal, rotation, screen lock/unlock, Wi-Fi interruptions, and desktop
mirroring. Browser emulation does not prove the on-screen keyboard behavior.
