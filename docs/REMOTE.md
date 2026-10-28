# Use it from anywhere (optional)

Back to the [README](../README.md).

Off until you turn it on. **Settings → Use from anywhere** lets you open your cockpit from your
phone or another computer, away from home. Pick one of two ways:

- **Just my devices (recommended).** [Tailscale](https://tailscale.com), free for personal use,
  makes a private network between your own devices. The cockpit gets an `https://….ts.net`
  address that only your signed-in devices can open. Nothing goes on the public internet.
- **A web address with a sign-in (beta).** A [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  on your own domain, with a Cloudflare Access email sign-in in front. Needs a free Cloudflare
  account and a domain on Cloudflare.

Why not a copy in the cloud? Your cockpit has to run on the computer where your Claude Code and
your files live; a cloud copy could not reach them. Both ways keep it there and open one private
door to it. Clawdling itself still listens on `127.0.0.1` only.

**Set it up with an agent** opens a setup chat: a Claude Code session, on your own plan, whose
first message is the one shown before you start (`/remote-access tailscale`). The agent explains
the plan, asks before it installs or changes anything, and you sign in to Tailscale or
Cloudflare yourself, in your browser: Clawdling never sees those logins. It registers the address
with `clawdling remote add` only after a check passes (Tailscale Funnel off and the address
reaching this cockpit; for Cloudflare, a signed-out visitor stopped by Access).

Then press **Add a device** and scan the code with your phone. The code is a one-time link that
works for 10 minutes and never holds your cockpit's private token; the phone gets its own
sign-in, which you can sign out from Settings. **Turn off** stops answering every remote address
at once, signs out every device, and can open a chat that removes the serve entry or tunnel too
(`/remote-access off`).

From a terminal: `clawdling remote list`, `clawdling remote check`, `clawdling remote
tailscale-name`, `clawdling remote serve
<https-url>`, `clawdling remote serve-status`, `clawdling remote add <https-url> --kind
tailscale|cloudflare`,
`clawdling remote remove <url>|--all`, `clawdling remote off`. How it is protected: [SECURITY.md](SECURITY.md#use-from-anywhere).
