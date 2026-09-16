# Running the cockpit from your phone

The cockpit is a local-first app: your panes are real `claude` processes on your
own machine. To reach them from a phone you expose two things, not one.

## Why two

The browser streams pane output **directly from the bridge** over SSE, rather
than proxying it through Next. That is deliberate: a proxied stream dies on the
function timeout of most hosts. The consequence is that your phone needs to
reach the bridge as well as the web app.

```
phone ──► https://cockpit.example.com   (Next app, port 3000)
     └──► https://bridge.example.com    (bridge SSE + input, port 8787)
```

`BRIDGE_URL` must therefore be the bridge's **public** origin, not
`http://localhost:8787`. Localhost works only when the browser is on the same
machine.

## Cloudflare Tunnel (no open ports, free)

```bash
brew install cloudflared      # or your platform's package
cloudflared tunnel login
cloudflared tunnel create clawdling
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: clawdling
credentials-file: /Users/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: cockpit.example.com
    service: http://localhost:3000
  - hostname: bridge.example.com
    service: http://localhost:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns clawdling cockpit.example.com
cloudflared tunnel route dns clawdling bridge.example.com
cloudflared tunnel run clawdling
```

Then in `.env`:

```bash
BRIDGE_URL=https://bridge.example.com
NEXTAUTH_URL=https://cockpit.example.com
```

Restart both (`make run`, `make bridge`) and open the cockpit URL on your phone.

## Locking it down

Exposing this puts a process that can run commands on your machine on the
public internet. Do not skip this section.

1. **Set a real `BRIDGE_SECRET`** (`openssl rand -hex 32`). The bridge refuses
   to boot without one. Every call is HMAC-signed; a 15-minute token is minted
   per stream.
2. **Turn on real auth.** `ADJUTANT_AUTH=single` is convenient locally and is
   not an internet-facing posture. Use `magic-link` when the app is exposed.
3. **Put Cloudflare Access in front of both hostnames** and restrict to your own
   email. This is the single highest-value control here: it authenticates at the
   edge, before a request ever reaches your machine.
4. **Keep `CLAWDLING_WORKSPACE_ROOT` narrow.** The bridge refuses any spawn whose
   cwd resolves outside it, so it bounds what a pane can reach even if
   everything above fails.
5. Prefer a **named tunnel** over a `trycloudflare.com` quick tunnel. Quick
   tunnels rotate their hostname and are unauthenticated by default.

## Tailscale instead

If you would rather not expose anything publicly, put the machine and the phone
on a tailnet and use the machine's tailnet name:

```bash
BRIDGE_URL=http://your-mac.tailnet-name.ts.net:8787
```

No public DNS, no edge auth to configure, and the bridge never leaves your
private network. This is the safer default if you only ever use your own
devices.

## A note on `claude remote-control`

Claude Code ships its own remote control, and for "drive one session from my
phone" it is simpler than any of the above. The cockpit is for the other thing:
many panes at once, each pinned to a domain, in one screen you control.
