# autoUWLearn

A read-only MCP server that answers questions about a Waterloo LEARN (Brightspace) account: what is due, what your grades are, what was announced, and what a lecture says.

Reads go straight to Brightspace's Valence JSON API using your session cookies. A browser is used only to complete Waterloo SSO/MFA once; no read ever drives one. Your Waterloo password is never stored, and never seen by the model.

## How it works

```
MCP client  ──►  MCP server  ──►  Valence JSON API  ──►  LEARN
                     │
                     └── browser (login only, on demand)
```

A course is spread across several Brightspace org units — a lecture offering, a lab offering, sometimes one per section — each holding different assignments and grades. The server merges them under one label such as `ECE 318`, so callers never handle an org unit id and never have to disambiguate.

## Setup

```bash
npm install
npm run build
```

Create `.local/server.env` (git-ignored, mode 600). The public identity has no default: baking a hostname in would make a misconfigured deploy publish OAuth metadata pointing at someone else's domain.

```bash
LEARN_MCP_OAUTH_PASSWORD=$(openssl rand -base64 32)   # the only credential guarding this server
LEARN_MCP_PUBLIC_BASE_URL=https://mcp.example.com
LEARN_MCP_RESOURCE_URL=https://mcp.example.com/mcp
LEARN_MCP_ALLOWED_HOSTS=mcp.example.com,mcp.example.com:443,127.0.0.1,localhost
```

Optional:

```bash
LEARN_BASE_URL=https://learn.uwaterloo.ca
LEARN_STATE_HOME=~/.uwlearn-mcp          # profile, storage state, tokens, downloads
LEARN_HEADLESS=true                      # interactive login only; recovery is always headless
LEARN_HEARTBEAT_MS=300000                # how often to keep the LEARN session warm
LEARN_MCP_AUTHORIZE_ATTEMPTS=10          # per window
LEARN_MCP_AUTHORIZE_WINDOW_MS=900000
```

## Logging in

The auth page is local-only, and refuses requests that arrive through a proxy:

```text
http://127.0.0.1:8787/auth
```

It opens LEARN in a local browser and waits while you complete Waterloo SSO/MFA by hand. From another machine, forward the port:

```bash
ssh -L 8787:127.0.0.1:8787 <host>
```

The login window appears on the server's own display, so drive it there or over screen sharing. The session is saved as soon as it is confirmed working — the page checks every few seconds — so reads keep working with the browser closed, and **Save session** is only there to force it.

Confirmation is a real LEARN read, not a look at the page: Brightspace renders its homepage with JavaScript and lands SSO on URLs of its own with `login` in them, so a session that works can look, to anything reading the page, exactly like one that does not.

## Staying logged in

Typing a password should be rare. Three mechanisms keep it that way, and they matter in this order:

- **Rotation is written back.** LEARN reissues the session cookie as you use it. Reads go out over `fetch`, which has no cookie jar, so every `Set-Cookie` LEARN returns is folded into the saved session explicitly. Without this the server keeps presenting the value from the last interactive login until LEARN stops accepting it — a session that dies while the heartbeat reports it healthy.
- **A heartbeat.** Brightspace signs out a session that goes quiet and offers no keep-alive endpoint, so any authenticated request has to serve as one. `LEARN_HEARTBEAT_MS` (default 5 minutes) sets the interval.
- **Silent re-login, on the failing read.** When a read does find the session gone, it replays the SSO handshake headlessly and retries once, before anything is reported. Waterloo's upstream identity session outlives the Brightspace one and Duo remembers the device, so this usually succeeds with nobody watching. Concurrent reads share one attempt, and a failed attempt is not retried for five minutes.

Only when that re-login needs a password do tools return `AUTH_REQUIRED` with the auth URL. `/health` reports the session state, so a lapse is visible without asking a tool.

`learn_auth_status` answers from the saved session and never starts a browser: the cookies are on disk and LEARN will say whether they work, so the check costs one request and cannot hang. Only `learn_auth_start` and `learn_auth_reset` drive a browser, and they are given a longer deadline to do it.

## Running

```bash
npm run dev             # stdio, for local MCP clients
npm run dev:http        # HTTP + OAuth, for remote clients
```

As a launchd service, plus optionally a cloudflared tunnel:

```bash
scripts/install-launchd.sh
scripts/install-launchd.sh --tunnel <tunnel-name>
```

Deploy a new revision to the machine running the service:

```bash
scripts/deploy.sh        # pull, clean build, test, restart, health check
```

Deploy from git, never by copying files in: a diverged working tree on the
server is how uncommitted production code gets lost.

Local MCP client configuration:

```json
{
  "mcpServers": {
    "autouwlearn": {
      "command": "node",
      "args": ["/path/to/autoUWLearn/dist/server.js"]
    }
  }
}
```

## Tools

Every read takes an optional `courseQuery` such as `ECE 318`, `ece318` or `318`. Omit it to cover all courses.

| Tool | Answers |
|---|---|
| `learn_courses` | Which courses am I in? |
| `learn_due_dates` | What is due, and did I submit it? (next N days) |
| `learn_grades` | How am I doing? (released grades only) |
| `learn_announcements` | What is the latest announcement? |
| `learn_content` | What lecture slides and handouts exist? |
| `learn_read_content` | What does that lecture actually say? (PDF → text) |
| `learn_auth_status` / `learn_auth_start` / `learn_auth_save` / `learn_auth_reset` | Session management |

`learn_due_dates` unions three sources, because none is complete on its own: calendar events, assignment folders and quizzes. A deadline can hang off a content module, which the latter two cannot express; and a course's quizzes can be dated while its calendar is empty. Each item carries `submissionStatus`, read from LEARN's list pages — the Valence API exposes no per-student status, so a caller must never infer "not submitted" from the absence of a grade.

A query matching several courses or topics returns the candidates rather than silently picking one. One org unit failing (a lab you cannot see, a transient error) is reported in `errors[]` while the rest of the data still returns.

`learn_read_content` only fetches `/content/enforced/...` paths on the LEARN host, so it cannot be pointed at an arbitrary URL.

## Security

The OAuth password is the only credential between the internet and your grades, and every other authorize parameter is public — the redirect allowlist is hard-coded to `chatgpt.com`, and the resource URL is published at `/.well-known/oauth-protected-resource`. So:

- `/oauth/authorize` is rate limited with a global token bucket (10 attempts per 15 minutes by default). It is deliberately global rather than per-IP: behind a tunnel every request carries the proxy's address, and a per-IP bucket keyed on a client-controlled header would be bypassed by rotating it.
- The password is compared with `timingSafeEqual` over SHA-256 digests.
- Access tokens last 7 days and can be revoked at `/oauth/revoke` (RFC 7009).
- PKCE S256 is required; `redirect_uri` is allowlisted; tokens are bound to the resource.

Use a high-entropy password. Consider putting an authenticating proxy in front of the public hostname, which removes the brute-force surface entirely.

Never commit `.local/`: it holds the OAuth password, the browser profile, and the LEARN session cookies.

## Tests

```bash
npm test        # typecheck + unit tests
```

Live smoke tests, read-only, against a real logged-in session:

```bash
npx tsx scripts/smoke-learn-api.ts
npx tsx scripts/smoke-learn-service.ts
npx tsx scripts/smoke-learn-content.ts "ECE 101" introduction
```
