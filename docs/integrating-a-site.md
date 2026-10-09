# Integrating a site with the hub

This is the step-by-step guide for connecting **one site** to a running hub, so that people sign in
to it by scanning a QR code with Telegram and the hub decides whether they may come in. For what the
hub is and why, read [hub.md](hub.md); this guide is only the wiring.

**What a site is, in one paragraph.** A site holds two things from the hub: its **address**
(`https://<hub>/hub-api`) and its **key** (`tqk_<site>_<secret>`). It shows the sign-in page, and every
question about a sign-in goes to the hub over HTTPS: *start one*, *did anyone scan it*, *may this
person come in right now*. The site has no bot token, no database binding, no share of any store, and
no copy of who is allowed. It can run anywhere that can make an HTTPS request.

## 0. Before you start

- [ ] The hub is deployed and `https://<hub>/admin` shows the console (see [hub.md](hub.md#setup)).
- [ ] You are a super admin of the hub (your Telegram id is in `superAdmins`, or was added in the console).
- [ ] You know **every address the site is served from**: the custom domain, plus any `workers.dev` or
      preview address people could reach it at. The hub only works for the addresses you register.
- [ ] You can store two **secrets** for the site: `HUB_KEY` and `SESSION_SECRET`.
- [ ] You know the bot's username (without the `@`).

## 1. Register the site in the console

1. Open `https://<hub>/admin` and sign in by scanning the QR.
2. Under **Add a site**, enter a display name and the site's URL (for example `Internal docs` and
   `https://docs.example.com`), then **Continue**.
3. Check the suggested **id** (`internal-docs`). It cannot be changed after saving; it only appears in
   the console and in the QR link, and the site's code never needs it. **Add site.**
4. **The next page shows the site's key. It is shown once.** Copy it now, straight into the site's
   secrets store. If you lose it, make a new one from the site's page (*Site key*); that stops the old
   one working at once.
5. If the site is reachable at more than one address, add each under **Site URLs**. A visitor arriving
   at an address that is not listed is refused.
6. Choose who gets in under **Who can sign in**: *invite only* (the default: you add people),
   *approval required* (anyone may scan to ask; you approve), or *anyone with Telegram*. See
   [hub.md](hub.md#who-gets-in).

You now have three values to give the site:

| Value | Example | Where it goes |
| --- | --- | --- |
| Hub API address | `https://auth.example.com/hub-api` | config / variable (`HUB_URL`), not secret |
| Site key | `tqk_internal-docs_9f3c…` (64 hex after the id) | **secret** (`HUB_KEY`) |
| Bot username | `acme_signin_bot` | config / variable (`TELEGRAM_BOT_USERNAME`) |

You also need a **session secret** for the site: a long random string, **different for every site**
(`openssl rand -hex 32`). It signs the site's own cookie, and the hub never sees it.

## 2. Wire the site

Pick the one that matches the site.

### A. JavaScript on Cloudflare Workers

[`examples/hub/site-worker.js`](../examples/hub/site-worker.js), complete:

```js
import { escapeHtml } from "telegram-qr-signin";
import { createSiteAuth } from "telegram-qr-signin/site";

export default {
  async fetch(request, env) {
    const auth = createSiteAuth({
      hub: { url: env.HUB_URL, key: env.HUB_KEY },
      botUsername: env.TELEGRAM_BOT_USERNAME,
      session: { secret: env.SESSION_SECRET },
    });

    const handled = await auth.handle(request);     // /auth/login, /auth/poll, /auth/logout, …
    if (handled) return handled;

    const gate = await auth.guard(request);         // cookie + a live question to the hub
    if (!gate.ok) return gate.response;             // the sign-in page, or a refusal

    return new Response(`<h1>Hello ${escapeHtml(gate.session.name)}</h1>`, { headers: { "Content-Type": "text/html" } });
  },
};
```

```bash
npm install github:jitdor/telegram-qr-signin#semver:^1.2.0
wrangler secret put HUB_KEY
wrangler secret put SESSION_SECRET
# vars in wrangler.jsonc: HUB_URL, TELEGRAM_BOT_USERNAME. No bindings: no D1, no KV, no Durable Object.
wrangler deploy
```

### B. JavaScript on Node, Deno or Bun

[`examples/hub/site-node.mjs`](../examples/hub/site-node.mjs) is a runnable server. The only
differences from the Workers version are how a request is turned into a `Request` and a response is
written back. On `localhost` set `session: { secure: false }` (a cookie marked `Secure` is not stored
over plain HTTP); never in production.

### C. Any other language

The hub's API is plain HTTPS and JSON, so a site in PHP, Python, Go, C#, Ruby… talks to it directly
(the whole contract is in [hub.md](hub.md#the-api)). You build the page and the session; the hub does
the rest. The flow is four calls. This Python version was run against a live hub:

```python
import json, os, secrets, sys, time, urllib.request, urllib.error

HUB = os.environ["HUB_URL"].rstrip("/") + "/v1"      # https://<hub>/hub-api
KEY = os.environ["HUB_KEY"]                           # tqk_<site>_<64 hex>
NAMESPACE = KEY.split("_")[1]                         # the key says which site this is


def hub(method, path, body=None):
    req = urllib.request.Request(
        HUB + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, json.load(res)
    except urllib.error.HTTPError as err:
        return err.code, json.load(err)


# 1. Start a sign-in when you show the login page. You make the token; the hub keeps it.
token = secrets.token_hex(16)                          # 32 hex characters, no more and no fewer
status, body = hub("POST", "/logins", {
    "token": token,
    "expiresAt": int(time.time()) + 600,
    "client": {"origin": os.environ["SITE_ORIGIN"], "ip": "203.0.113.7", "userAgent": "example"},
})
assert status == 201, (status, body)
qr_text = "https://t.me/%s?start=%s_%s" % (os.environ["BOT"], NAMESPACE, token)   # what the QR encodes
print("TOKEN", token, qr_text, flush=True)

# 2. Poll until the person has scanned and the hub's bot has confirmed.
for _ in range(50):
    status, body = hub("GET", "/logins/" + token)
    record = body.get("record")
    if record is None:
        sys.exit("expired or unknown")
    if record["status"] == "confirmed":
        break
    time.sleep(0.1)

# 3. Take it (once), then ask whether this person may come in right now.
status, body = hub("POST", "/logins/%s/consume" % token)
user = body["record"]["user"]
status, answer = hub("POST", "/check", {"user": {"id": user["id"]}, "stage": "poll", "origin": os.environ["SITE_ORIGIN"]})
print("ANSWER", json.dumps(answer), "user", user["id"], flush=True)
# answer == {"ok": True}  -> set your own session cookie.   {"ok": False, "reason": ...} -> refuse.
```

What each piece means for your own implementation:

- **The token** is 16 random bytes as 32 lowercase hex characters. The site makes it; the hub only
  accepts that exact shape.
- **The QR** encodes `https://t.me/<bot>?start=<site id>_<token>`. The site id is the part of the key
  between `tqk_` and the secret. (Or serve your own `https://<your site>/auth/q/<token>` that redirects
  there, so the QR shows your domain; see the README, *What the QR points at*.)
- **`origin`** is the scheme, host and port the visitor reached **your** site at, for example
  `https://docs.example.com`. It must be one of the addresses registered for the site, or the hub
  answers `403 origin_not_allowed`. Send the same value to `/check`.
- **Polling**: ask `GET /logins/<token>` every second or two while the page is open. `record` is
  `null` once the sign-in has expired (ten minutes), and `status` is `"confirmed"` after the scan.
- **`/consume`** hands over the confirmed sign-in once; a second call returns `null`. Do not skip it:
  it is what makes one scan one sign-in.
- **`/check`** is the authority. `{"ok": true}`: create your session. `{"ok": false, "reason": …}`:
  refuse. Ask it again on **every** request a signed-in person makes (`"stage": "session"`), so that
  revoking someone in the console takes effect at once.
- **Your session** is yours: a cookie you sign with your own secret (see the README, *Using it from
  other languages*, for a format other services can verify). The hub never sees it.
- **If the hub does not answer** (a timeout, a `5xx`, a `503`), do not treat it as "no". Show "try
  again" and keep the person's session. Only an explicit `{"ok": false}` means refuse.

## 3. Let people in

- *Invite only*: in the console, open the site → **People with access**, paste Telegram ids.
- *Approval required*: nothing to do first. People scan, you are messaged, and you press **Approve**.
- *Anyone with Telegram*: the site must keep its own accounts keyed on the Telegram id, and do its own
  moderation. To ban someone from the site's code: `await auth.block(telegramId, "reason")` (and
  `auth.unblock(id)`). That is one call with the site's key, and it can only change this site's own
  list.

## 4. Check that it works

Work down this list; each line says what you should see.

1. **The key and address are right.** From anywhere:
   ```bash
   curl -s -H "Authorization: Bearer $HUB_KEY" "$HUB_URL/v1/site"
   # {"namespace":"internal-docs","name":"Internal docs","enabled":true,"origins":["https://docs.example.com"]}
   ```
   `{"error":"unauthorized"}` means the key is wrong or was replaced.
2. **The sign-in page loads** at the site's address: "Sign in to Internal docs" with the host under it.
   A `503` "temporarily unavailable" means the hub or the key is wrong (the site's logs say which).
   A `403` "not registered for this site" means the address is missing under **Site URLs**.
3. **Scan the QR** with a Telegram account you have given access to. The bot replies "✅ You're signed
   in to Internal docs", and the page signs you in **within a couple of seconds**. If it sits on
   "Waiting for Telegram…" for tens of seconds the hub's login store is eventually consistent (KV):
   use a Durable Object or D1 ([hub.md](hub.md#setup)).
4. **A stranger is handled as configured.** Scan with an account that has no access: invite only shows
   their Telegram id; approval required says "Request received" and messages you; open lets them in.
5. **Revoking works at once.** Revoke yourself in the console, reload the site: you should be turned
   away on that very request, not later.
6. **A wrong address is refused.** Open the site through an address that is not registered: refused.
7. **An outage does not sign anyone out.** (Optional.) Point `HUB_URL` somewhere dead for a moment:
   signed-in pages answer `503` "try again", and work again when the URL is right, without signing in
   again.

## 5. Things to know

- **One key per site, one session secret per site.** Never reuse either, and keep both in secrets.
- **Every guarded request costs one call to the hub.** That is the price of immediate revocation. If
  it is too slow, `hub: { checkCacheSeconds: 10 }` reuses a "yes" for ten seconds (a "no" is never
  reused), and revocation then takes up to ten seconds.
- **`timeoutMs`** (default 5 seconds) is how long a request waits for the hub before it counts as
  unreachable.
- **Do not turn off `captureClient`.** The hub checks where each QR was shown, so the site must record it.
- **Do not set a custom `tokenBytes`.** The hub recognises scans by the default token shape.
- **A second copy of the site** (staging) needs its own site in the console, with its own URL and key.
  A copy that reuses production's key at another address is refused.
- **Replacing the key** locks the site out until it has the new one, so deploy the new secret straight
  after making it.

## 6. Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| Sign-in page says "temporarily unavailable" (`503`) and the logs show `unauthorized` | Wrong, truncated or replaced key | Check `HUB_KEY` against the console; make a new key if needed |
| Same page, logs show `hub_unreachable` | The hub is down, `HUB_URL` is wrong, or it is blocked from the site | `curl` the `/v1/site` call from the site's host |
| `403` "This address is not registered for this site" | The address the visitor used is not under **Site URLs** | Add it exactly as it appears in the browser (`www.` is a different address) |
| `403` "Sign-in for this site is switched off" | The site is off in the console | Switch it on under **Settings** |
| Page stays on "Waiting for Telegram…", then works after a long delay | The hub's login store is KV (eventually consistent) | Use a Durable Object or D1 for the hub's `store` |
| Page stays on "Waiting for Telegram…" forever; the bot says "You don't have access" | The person has no grant (invite only) or is waiting (approval) | Grant or approve them in the console |
| The bot says "That sign-in link came from a site that isn't registered" | The QR was made at an address that is not registered for the site | Register the address, or use the real site |
| The bot says "isn't recognised" | The site id in the QR does not exist in the hub (a deleted site) | Add the site again; make a new key |
| Everyone is asked to try again at once | The hub is unwell | Check the hub's logs; sites recover by themselves |
| A person is signed out unexpectedly | They were revoked or blocked, or the site was switched off or deleted | Check the console's activity log |

## 7. Security checklist

- [ ] `HUB_KEY` and `SESSION_SECRET` are in a secrets store, not in the repository or the browser.
- [ ] The hub URL is `https`. (The library refuses plain `http` except for `localhost`, because the key
      travels in every request.)
- [ ] The key is different for every site, and replaced if it ever leaks. The hub keeps only a hash of it.
- [ ] The site's code trusts only the hub's `/check` for "may this person come in". It never decides
      from the cookie alone.
- [ ] An open site keys its own accounts on the Telegram **id**, never the username, and escapes names.
- [ ] Rate limiting sits in front of the sign-in page (the hub has none of its own).

## 8. Moving a site from 1.0 or 1.1

In 1.0 and 1.1 a site bound the hub's database and shared its login store. That is gone in 1.2: **a site no
longer touches the hub's data**, which is also what lets it run anywhere. To move one:

1. Run `migrations/hub-d1-upgrade-1.2.sql` against the hub's database (adds the table for keys).
2. Deploy the new hub. Existing sites stop working until they have a key.
3. In the console, open each site → **Site key** → **Make a key**, and put it in that site's secrets as
   `HUB_KEY`, with `HUB_URL=https://<hub>/hub-api`.
4. Replace the site's `createSiteAuth({ namespace, registry, store, … })` with
   `createSiteAuth({ hub: { url, key }, botUsername, session })`, and delete its D1 and KV bindings:
   `registry`, `store` and `namespace` are no longer options and throw if passed.
5. Deploy the site. Sessions stay valid: the cookie is signed with the site's own `session.secret`,
   which did not change. One exception: a 1.0 or 1.1 site that worked out its own id named its cookie
   `site_session`, and 1.2 names it `<site id>_session`, so those people would have to sign in once
   more. To keep them signed in, pass `session: { secret, cookieName: "site_session" }`.
