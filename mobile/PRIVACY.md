# Clawdling privacy policy

Effective October 22, 2026. Applies to the Clawdling app for iPhone and iPad ("the app").

Clawdling is free, open-source software that you run on your own computer. The app is a chat
client for it: it lets you talk to the agents running on your computer from your phone.

## What we collect

Nothing. The app has no accounts, no analytics, no advertising, no tracking and no crash
reporting. The developer runs no server for the app and receives no data from it, about you or
about how you use it.

## Where your data goes

The app sends requests only to the Clawdling server you pair it with, which is software running
on a computer you control. Your messages, your agents' replies and the details of your sessions
travel between your device and that computer and nowhere else. If you reach your computer through
Tailscale or another VPN, that traffic follows your VPN provider's terms.

On your computer, Clawdling runs AI agents through the command-line tools you have installed and
signed in to there (for example Claude Code). What those tools do with the messages you send is
covered by their providers' own terms and privacy policies. The app never sees, stores or sends
the credentials for those tools.

## What stays on your device

- The address of your Clawdling server and its pairing code, kept in the iOS Keychain on this
  device only. They are not synced to iCloud and are not restored to another device.
- Nothing else. Messages are fetched from your computer when you open a chat and are not saved by
  the app.

To remove the pairing, open Settings in the app and tap Disconnect, or delete the app.

## Permissions

- **Camera**: used only to scan the pairing QR code that Clawdling shows on your computer. The
  image is read on the device and is never stored or sent anywhere.
- **Local network**: used only to reach your own computer on your Wi-Fi.

## Demo mode

Demo mode uses sample data bundled in the app. Nothing you type in demo mode leaves the device.

## Children

The app is not directed at children under 13 and does not knowingly collect any information from
anyone.

## Changes

Changes to this policy are published in this file, with a new effective date, in the public
repository at https://github.com/jddavenportOpen/clawdling.

## Contact

Questions: open an issue at https://github.com/jddavenportOpen/clawdling/issues.
