# Clawdling for iPhone

A chat-only companion for your own Clawdling server: see what needs you, follow live sessions,
chat with any agent, start new work and ask Donna, from your phone. Expo SDK 54, expo-router,
TypeScript. It has its own `package.json`; nothing here touches the server at the repo root.

```sh
cd mobile
npm install
npm run mock                 # a mock Clawdling server; prints a pairing link
npm run web                  # the app in a browser (paste the link), or:
npm run ios                  # the iOS simulator
```

To pair with a real server, start it so the phone can reach it (`clawdling start --host 0.0.0.0`),
open Settings, Use Clawdling on your phone in the cockpit, and scan the code. Or tap "Try the demo".

## Tests

```sh
npm run typecheck            # tsc --noEmit
npm test                     # unit tests (links, API client, markdown, chat, demo data)
npm run export:web && npm run e2e   # Playwright against the web build + mock server
```

`test/e2e/real-server.spec.mts` runs the same app against the real server (real tmux, the
server's fake `claude`, its test mode). It runs automatically when `mobile/` sits inside the server
repo, or with `CLAWDLING_SERVER_DIR=/path/to/clawdling npm run e2e`; otherwise it is skipped.

Screenshots land in `test/screenshots/` (git-ignored). `npm run store-shots` renders the App Store
set; `npm run icons` re-renders the icon, splash and mark from `assets/brand/mark.svg`.

## Layout

- `app/`: screens (Connect, Scan, Home, session chat, new session, Donna, Settings, Help).
- `src/api.ts`: typed client for the server API; `src/links.ts`: pairing-link parser.
- `src/demo/`: demo mode (sample org + a local stand-in for the server).
- `test/mock-server.mjs`: in-memory server with the same routes, for tests and screenshots.

Release steps, store copy and review notes: [STORE.md](STORE.md). Privacy policy: [PRIVACY.md](PRIVACY.md).
