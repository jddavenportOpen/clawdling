# Privacy

_Last updated: 2026-10-22_

Clawdling is open-source software you run on your own computer. This policy covers the
Clawdling server and cockpit (this repository) and the Clawdling iPhone app.

## What we collect

Nothing. Clawdling has no accounts, no analytics, no telemetry, no advertising identifiers and
no servers of its own. The author never receives any of your data.

## Where your data lives

- **Your org and sessions** live on your computer: plain files in `~/clawdling` and the session
  transcripts Claude Code itself writes. Clawdling's cockpit binds to `127.0.0.1` by default
  and requires a local access token.
- **Bring in your projects** (discovery and import) reads folder names, git metadata (a remote
  URL, with any credential stripped out), manifest and README files, and the names (never the
  values) of your Claude Code setup: skills, subagents, MCP servers and hooks. It reaches GitHub
  only through your own `gh` command, never a token Clawdling holds itself. All of this stays on
  your computer and is read-only; creating a project agent writes only inside your org folder,
  never into the repo. Detail: [docs/SECURITY.md](docs/SECURITY.md).
- **Your Claude account** stays with Claude Code. Clawdling never reads, stores or forwards your
  Claude credentials and never calls the Anthropic API itself; it starts the `claude` command
  you are already signed into. What Claude Code sends to Anthropic is governed by Anthropic's
  own terms and privacy policy. If you add a second Claude account in Settings, Clawdling only
  gives it its own folder (`~/.clawdling-accounts/<name>`) and passes that folder to `claude`;
  you sign in inside Claude Code, and Clawdling never sees, reads or stores that login.
- **Telegram or iMessage** (optional, only if you turn on Donna's text channel): messages pass
  through Telegram's or Apple's own services under their terms. Clawdling answers only the one
  chat you pair it with.

## The iPhone app

The app talks only to the Clawdling server you connect it to (the address and token you scan or
paste). It stores that address and token in the iOS Keychain on your device. It collects no
data, has no analytics, and sends nothing to the author or any third party. The camera is used
only to scan the pairing QR code; nothing is recorded or uploaded. Demo mode runs entirely on
the device with built-in sample data.

## Contact

Questions: open an issue at https://github.com/jddavenportOpen/clawdling or email
me@jddavenport.com.
