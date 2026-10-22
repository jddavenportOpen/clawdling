# Clawdling for iPhone and iPad: App Store listing and release notes

Everything App Store Connect asks for, ready to paste. App record: **ASC app id 6788494862**,
bundle id **com.jddavenport.cockpitchat**, team **TP4ZZ5XA76**. Builds 1 and 2 already exist on
the record, so the first new build must be 3 or higher (see "Build and submit").

Trademark rule for this listing: the word "Claude" stays out of the name, subtitle, keywords and
screenshots. The description may say the server "works with Claude Code".

## App information

| Field | Value |
|---|---|
| Name (30) | Clawdling |
| Subtitle (30) | Chat with your AI agents |
| Primary language | English (U.S.) |
| Primary category | Productivity |
| Secondary category | Developer Tools |
| Content rights | Does not contain, show or access third-party content |
| Age rating | 4+ (answers below) |
| Price | Free, no in-app purchases |

## Version information (1.0)

**Promotional text** (170, editable without a new build):

> Your agents keep working on your own computer. Check in, answer their questions and start new work from your phone, or just ask Donna and she routes it.

**Description** (4000):

> Clawdling for iPhone is the pocket companion to Clawdling, free open-source software that turns your computer into an organization of AI agents: a chief of staff, an agent for each area of your life and work, and one for each project. Your agents run on your own computer. This app lets you chat with them from anywhere.
>
> WHAT YOU CAN DO
> • See what needs you. Sessions waiting on your answer come first, with the question they are asking.
> • Follow live work. Every running session with its real name, its agent and its status.
> • Chat with any session. Read replies with formatting, code and tables, see the steps an agent took, and reply.
> • Start new work. Tap an agent and say what to do; the session starts on your computer.
> • Ask Donna. Your chief of staff hands the request to the right agent and tells you who is on it.
> • Pick up where you left off. Resume a session that has ended.
>
> PRIVATE BY DESIGN
> • No accounts, no analytics, no tracking.
> • The app talks only to the Clawdling server you pair it with, on your own computer.
> • Your pairing code stays in this device's Keychain.
>
> HOW IT WORKS
> 1. Install Clawdling on your Mac or Linux computer. It is free and open source (AGPL-3.0) and works with Claude Code: github.com/jddavenportOpen/clawdling
> 2. Start it so your phone can reach it, then open Settings, Connect your phone in the cockpit.
> 3. Scan the code with this app. At home, use the same Wi-Fi. Away from home, use Tailscale.
>
> Want to look around first? Tap "Try the demo" for a complete sample org that runs entirely on your phone.
>
> Clawdling is a chat client. It does not run AI models itself, it downloads no code, and it is not a remote desktop.

**Keywords** (100; words already in the name and subtitle are indexed, so they are not repeated):

```
assistant,chief of staff,coding,developer,terminal,tmux,self-hosted,open source,remote,automation
```

| Field | Value |
|---|---|
| Support URL | https://github.com/jddavenportOpen/clawdling/issues |
| Marketing URL | https://github.com/jddavenportOpen/clawdling |
| Privacy Policy URL | https://github.com/jddavenportOpen/clawdling/blob/main/PRIVACY.md (text: `mobile/PRIVACY.md`, to be placed at the repo root) |
| Copyright | 2026 JD Davenport |
| What's New | First release. |

## App Privacy (the "nutrition label")

Answer **No, we do not collect data from this app**. Result: **Data Not Collected**.

Why that is true: no analytics or crash SDKs are linked, there is no backend of ours, and the app
sends requests only to the server address the user pairs it with. The privacy manifest in
`app.json` declares no tracking, no tracking domains and no collected data types; the required-reason
APIs it lists (UserDefaults, file timestamps, system boot time, disk space) are the standard React
Native and Expo uses.

## Age rating answers

Every content question (violence, sexual content, profanity, horror, drugs, gambling, contests,
medical, mature themes): **None**. Capabilities:

- Unrestricted web access: **No**. The app embeds no browser; a link in a message opens in Safari.
- User-generated content shared with other people, messaging or chat with other people: **No**.
  The app only shows text exchanged with the user's own agents on their own computer.
- Advertising, in-app purchases, location, gambling: **No**.

Expected rating: **4+**. If the questionnaire asks about AI-generated content, answer that the app
displays text produced by AI agents the user runs and controls on their own computer.

## Export compliance

The app uses only the encryption built into iOS (HTTPS through URLSession).
`ITSAppUsesNonExemptEncryption` is `false` (set by `ios.config.usesNonExemptEncryption` in
`app.json`), so App Store Connect does not ask per build. Answer, if asked: **No non-exempt
encryption**.

## App Review information

- Sign-in required: **No** (no accounts exist).
- Contact: JD Davenport (fill the phone and email fields in App Store Connect).
- Notes for the reviewer:

> Clawdling is a chat client for Clawdling, free open-source software (AGPL-3.0) that each user runs on their own Mac or Linux computer (github.com/jddavenportOpen/clawdling). The app connects only to the server the user pairs it with, by scanning a QR code or pasting a link that their own server shows. There are no accounts and we operate no backend.
>
> To review everything without installing anything: on the first screen tap "Try the demo". Demo mode is a complete sample organization that runs entirely on the device and is labelled DEMO on every screen. Home, opening and replying to a chat, starting a new session from an agent, Donna (the chief-of-staff chat), resuming an ended session, and Settings all work, with simulated replies.
>
> The app is a chat client only. It does not run AI models or agents itself, it does not download or execute code, and it is not a remote desktop or a remote terminal. Messages are sent as text to the user's own server, which hands them to agents running there.
>
> Camera: only to scan the pairing QR code. Local network: only to reach the user's own computer. A public test server is not available because the server runs on the user's own computer by design; demo mode covers every screen.

## Screenshots

Generated from the web build against the mock server (no DEMO badge, a realistic LAN address),
framed with a caption. Regenerate with `npm run export:web && npm run store-shots`; output goes to
`test/screenshots/store/<device>/` (git-ignored, upload from there).

| Order | File | Caption | Subcaption |
|---|---|---|---|
| 1 | `01-home.png` | Every agent, one tap away | See what needs you and what is running. |
| 2 | `02-chat.png` | Chat with any session | Replies, code and every step your agents took. |
| 3 | `03-donna.png` | Just ask Donna | Your chief of staff routes it to the right agent. |
| 4 | `04-needs.png` | Know when you're needed | Questions and approvals come first. |
| 5 | `05-agents.png` | An agent for every part of life | Domains and projects, each with its own memory. |
| 6 | `06-connect.png` | Your computer, your agents | Pair with a QR code. No accounts, no cloud. |

| App Store Connect slot | Folder | Pixel size |
|---|---|---|
| iPhone 6.9" display | `iphone-6.9/` | 1320 x 2868 |
| iPhone 6.5" display | `iphone-6.5/` | 1284 x 2778 |
| iPad 13" display (required: the app supports iPad) | `ipad-13/` | 2064 x 2752 |

The `raw-*.png` files beside them are the same scenes without the frame, if a plain screenshot is
preferred.

## Build and submit

Prerequisites: an Expo account with access to the project, the App Store distribution certificate
(.p12) and provisioning profile for `com.jddavenport.cockpitchat`, and an App Store Connect API key.
None of these are in the repository; `credentials.json`, `credentials/`, `*.p12`, `*.p8` and
`*.mobileprovision` are git-ignored.

```sh
cd mobile
npm ci

# One time: link the Expo project (writes extra.eas.projectId and owner into app.json; commit that).
npx eas-cli@latest login
npx eas-cli@latest init

# One time: make sure the remote build number starts above the existing builds 1 and 2.
# EAS initializes the remote counter from app.json (ios.buildNumber "2"); autoIncrement then
# makes the first build 3. To check or force it:
npx eas-cli@latest build:version:get -p ios
npx eas-cli@latest build:version:set -p ios      # enter 2 if it shows lower

# Local signing (credentialsSource: local): put credentials.json next to app.json, e.g.
#   { "ios": { "provisioningProfilePath": "credentials/ios/profile.mobileprovision",
#              "distributionCertificate": { "path": "credentials/ios/dist.p12", "password": "..." } } }

# Optional: a simulator build to click through first.
npx eas-cli@latest build -p ios --profile simulator

# The store build.
npx eas-cli@latest build -p ios --profile production

# Upload it to App Store Connect (TestFlight first). The API key comes from the environment:
EXPO_ASC_API_KEY_PATH=/path/to/AuthKey_XXXX.p8 EXPO_ASC_KEY_ID=XXXX EXPO_ASC_ISSUER_ID=xxxx-xxxx \
  npx eas-cli@latest submit -p ios --profile production --latest
```

Then in App Store Connect: pick the build for version 1.0, paste the fields above, upload the
screenshots, set App Privacy to Data Not Collected, and submit for review.

## Before you submit

- [ ] `npm run typecheck && npm test` pass; `npx expo-doctor` reports no issues.
- [ ] `npm run export:web && npm run e2e` pass.
- [ ] `PRIVACY.md` is live at the privacy policy URL.
- [ ] The simulator build: Connect, demo, Home, a chat, Donna, Settings, Disconnect all work.
- [ ] On a real iPhone on the same Wi-Fi as a Clawdling server started with `--host 0.0.0.0`:
      scan the QR code, allow Local Network, send a message, see the reply.
