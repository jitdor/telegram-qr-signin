# One bot, many sites: the hub

`telegram-qr-signin/hub` lets **one Telegram bot** sign people in to **many sites**, with an **admin
console** where super admins decide who may enter which site.

It is optional and separate: nothing in the base package, the stores or the OIDC provider imports
it, and a deployment that does not use it does not load it.

## Why

A bot has exactly one webhook URL. With several sites that is awkward: either every site gets its
own bot, or one place has to know every site and route each `/start` to the right one. The hub is
that place, and it adds the missing piece — a list of who may enter which site — so the access list
lives in one database and a person is added or removed in one screen instead of one config per site.

```
        browser A ──▶ site A (namespace "acme") ─┐                    ┌──▶ D1 registry
        browser B ──▶ site B (namespace "wiki") ─┤  login store (KV)  │     sites · grants
                                                 │  ◀── scan ──┐      │     super admins · audit
   phone scans QR ──▶ Telegram ──▶ hub webhook ──┴─────────────┘      │
                                      │  1. which site? ("acme")      │
                                      │  2. does this person hold a   │
                                      │     grant for it?  ◀──────────┘
                                      └─▶ 3. if so, confirm the scan
```

Three Workers' worth of roles, but only two things are shared between them:

| Shared | What it is | Who writes it |
| --- | --- | --- |
| **Login store** (KV, D1 or a Durable Object) | The 10-minute hand-off record for a scan | Sites mint, the hub confirms |
| **Registry** (`D1HubStore`) | Sites, grants, blocks, super admins, requests, audit log | The hub's console. A site writes it only if you make its moderation call `addBlock` (see [Open sites](#open-sites)) |

**Sites never hold the bot token.** Only the hub talks to Telegram, so a compromised site cannot
impersonate the bot or message your users.

## Setup

**1. The hub Worker** — [`examples/hub/hub-worker.js`](../examples/hub/hub-worker.js):

```js
import { KVLoginStore } from "telegram-qr-signin";
import { createHub, D1HubStore } from "telegram-qr-signin/hub";

export default {
  fetch: (request, env) =>
    createHub({
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUsername: env.TELEGRAM_BOT_USERNAME,
      store: new KVLoginStore(env.LOGINS),
      registry: new D1HubStore(env.HUB_DB),
      superAdmins: env.SUPER_ADMINS,             // "123456789,987654321"
      sessionSecret: env.CONSOLE_SESSION_SECRET, // its own secret, not the bot token
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    }).fetch(request),
};
```

```bash
wrangler d1 create hub
wrangler d1 execute hub --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1.sql
wrangler kv namespace create LOGINS
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<hub>/telegram/webhook&secret_token=<WEBHOOK_SECRET>"
```

Already running an earlier version of the hub? Apply the upgrade scripts you have not yet run, each
**once**, in this order:

| Script | Adds | Effect on existing sites |
| --- | --- | --- |
| `hub-d1-upgrade-access.sql` | open sites and block lists | None: every site stays approved-people-only |
| `hub-d1-upgrade-origins.sql` | binding a site to its URL | None yet: existing sites are *unbound* and keep working from anywhere. The console flags each one; open it and add its URL, and the namespace is bound from then on |

A second run of either fails loudly and changes nothing. `createNamespace()` now requires `origins`,
so code that seeds sites programmatically needs the URL added.

**2. Open `https://<hub>/admin`** and scan the QR with a Telegram account whose numeric id is in
`superAdmins`. Add a site (`docs`, "Internal docs", `https://docs.example.com`). Grant people access.

**3. Each site** — [`examples/hub/site-worker.js`](../examples/hub/site-worker.js). It is
`createTelegramQrAuth` with the hub's gate already wired in:

```js
import { KVLoginStore } from "telegram-qr-signin";
import { createSiteAuth, D1HubStore } from "telegram-qr-signin/hub";

const auth = createSiteAuth({
  namespace: "docs",                       // the id you registered in the console
  botUsername: env.TELEGRAM_BOT_USERNAME,  // no bot token
  store: new KVLoginStore(env.LOGINS),     // the SAME store as the hub
  registry: new D1HubStore(env.HUB_DB),    // the SAME database as the hub
  session: { secret: env.SESSION_SECRET }, // required, and different for every site
});

const handled = await auth.handle(request);
if (handled) return handled;
const gate = await auth.guard(request);    // cookie + a live registry check, every request
if (!gate.ok) return gate.response;
```

Both bindings (`LOGINS`, `HUB_DB`) point at the hub's resources — copy the ids into the site's
`wrangler.jsonc` ([`site-wrangler.jsonc`](../examples/hub/site-wrangler.jsonc)). Everything else
`createTelegramQrAuth` takes (`branding`, `claims`, `redirectTo`, `qrOrigin`, …) works unchanged.
To also require, say, group membership, pass `authorize: chatMember({ chatId })` and a `botToken`:
it is ANDed with the hub's check.

## The console

Server-rendered, no JavaScript, no external requests. Everything is behind the same QR sign-in.

| Area | What a super admin can do |
| --- | --- |
| **Sites** | Add a site (namespace, display name and the URL it is served from), rename it, switch sign-in off and on, delete it |
| **Site URLs** | Add or remove the origins a site is served from — the namespace works only there |
| **Who can sign in** | Keep a site to approved people (the default), or [open it to anyone](#open-sites) with a Telegram account |
| **People with access** | Grant by Telegram id (paste many at once, with an optional note), revoke |
| **Waiting for approval** | People who scanned a site's QR and were refused. Approve with one click, dismiss, or block — no need to ask anyone for their numeric id |
| **Blocked people** | Refuse someone from a site whatever else is true of them — works on open sites too |
| **Super admins** | Add and remove other super admins |
| **Recent activity** | An audit log of every change: who, what, which site |

Revoking, blocking, disabling and deleting take effect on the person's **next request** to the site, not when
their cookie expires — the same live-check guarantee `chatMember` gives.

When someone is turned away, the bot tells them their Telegram id and the site's name, so even
without the approval queue they have something to send an admin.

### Roles

There are two kinds of access, deliberately separate:

- **Super admin** — can use the console. Does **not** get into any site by being one; grant
  yourself access like anyone else.
- **Site access** — a grant for one namespace. It lets someone sign in to that site and does nothing
  else. It is per site: access to `docs` opens nothing on `wiki`. (A site can instead be
  [open to anyone](#open-sites).)

**Bootstrap admins** (`superAdmins` in config) always work, cannot be removed in the console, and
never touch the database to be recognised. That is what makes locking yourself out impossible: even
with an empty or broken registry, they can sign in and repair it. Admins you add in the console are
extra, removable, and recorded with who added them. All super admins are equal; there are no
per-site administrators.

## Binding a site to its URL

A namespace is not a domain; it is a label in the QR. Left at that, two sites at different URLs could
share one namespace — and with it one access list — by accident, the usual case being a staging copy
that borrowed production's configuration. So every site is **bound to the origin or origins it is
served from** (scheme, host and port; `https://docs.example.com`, not a path). It is required to add a
site, and enforced in two places:

- **At every request to the site.** The site's gate compares the origin the request arrived at with
  the registered list. A visitor, a session cookie or a poll arriving at any other origin gets
  `origin_not_allowed` and nothing from this registry — no grant, and no open-site access either. The
  same cookie secret does not help: a copy of the site on an unregistered URL cannot use the access
  list.
- **At the scan.** The QR records where it was shown. The hub compares that with the site's origins
  before it confirms anything, and tells the person when a code came from a site that is not
  registered for that namespace. The code is not spent, and nothing is remembered about it.

What the origin means in practice:

- It is **exactly what `request.url` shows**: scheme, host and port must match. `http` is refused
  (except for `localhost` and `127.0.0.1`, so you can register a dev server), and `www.` is a
  different origin. If people can reach the site at both a custom domain and its `workers.dev`
  address, register both.
- A site can have up to ten, so a custom domain, its `workers.dev` address and a preview can coexist.
  The console never lets you remove the last one; add the new URL first.
- Removing a URL takes effect on the next request from it.
- **Both redirects are already fixed points.** After sign-in the browser is sent only to a path on the
  *same* site, and the QR link only ever leads to `t.me/<your bot>`. Binding the namespace to the
  origin is what ties those together: the site that shows the QR, the namespace on the bot, and the
  site that receives the cookie are one origin.
- A site must record where each QR is shown, which is the default; `createSiteAuth` refuses
  `captureClient: false` for that reason.

**What this does not do.** The origin on a QR is recorded by the site that mints it, and every site
holds the shared login store and registry, so a *malicious* Worker with those bindings could write
whatever origin it liked. Binding stops mistakes — staging on production's namespace, a copy deployed
to the wrong place, a site nobody registered — and makes each one visible; it is not a defence against
a hostile site you have already given the shared bindings. Keep those bindings to Workers you trust.

Sites registered before binding existed are **unbound** (no origins) and keep working from anywhere,
so upgrading locks nobody out. The console flags each one on the dashboard and its page: open it and
add its URL. Unbound is never a state a new site can be in.

## Open sites

A site normally lets in only people you grant access to. For a public site — a forum, say — you can
instead let in **anyone with a Telegram account**. It is a setting on one site, and sites are
approved-people-only until you change it.

```js
await registry.createNamespace({ namespace: "forum", name: "The forum", origins: ["https://forum.example.com"], access: "anyone" });
// or, in the console: the site's page → Who can sign in → Open to anyone
```

What changes, and what does not:

- **Anyone can sign in**, except people on the site's block list. The grant list stops being
  consulted but is **kept**, so requiring approval again restores it exactly.
- **Opening a site takes a deliberate step.** The console asks you to type the site's id, and the
  change is written to the audit log. Going back to approved-only needs no confirmation: narrowing
  access is the safe direction, and people without a grant are locked out on their next request.
- **There is no approval queue** on an open site — nobody to approve — and refused scans are not
  recorded.
- **A switched-off site stays off**, open or not.

**An open site is responsible for its own accounts.** The hub only proves *who someone is*: a
Telegram user id, a display name and an optional username. Everything after that is the site's job:

- Key your accounts on the **Telegram id**. Usernames can be changed or removed at any time, and
  names are whatever the person typed — escape them like any user input.
- Keep your own roles, moderation and rate limiting. Telegram accounts need a phone number, which
  makes throwaway signups harder, but it does not stop abuse.
- The hub **does not know who has signed up** to an open site, so it cannot list them. To ban
  someone, take the id from your own member record and block it in the console — or, from the site's
  own moderation tools, call `registry.addBlock({ namespace, id, label })`. (That means the site
  holds write access to the registry. Fine for a site you run; it is one more reason this mode is for
  sites you control. For someone else's site, use the [OIDC provider](../README.md#running-a-public-identity-provider).)

### Blocks

A block refuses one person from one site, **whatever else is true of them**: it beats a grant and
applies to open sites too. It is checked on every request, so it ends their current session on its
next request, and unblocking restores access without further action. Blocking someone also removes
their pending approval request, but leaves any grant in place — unblocking them does not silently
erase it. The bot tells a blocked person plainly that they can't sign in, without inviting them to
ask for access.

## What protects the console

- **Sign-in** is the QR flow, under the reserved namespace `hub-admin` (no site can be registered
  under it), and the "is a super admin" check runs on **every** request. Removing an admin ends
  their console session on its next click.
- **Cookie**: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/admin`, 8 hours by default
  (`adminSessionSeconds`), signed under its own key label so a site's cookie can never pass as a
  console cookie even if a secret were reused.
- **CSRF**: every state change is a POST that must carry a token derived from the session (so one
  admin's token is useless on another's session, and a fresh sign-in retires old pages), and any
  `Origin` header must be the console's own.
- **No script injection surface**: a Content-Security-Policy that allows no scripts at all,
  `frame-ancestors 'none'`, everything user-supplied HTML-escaped, and notices chosen from a fixed
  list of codes — a crafted link cannot make the console display words you did not write.
- **Input**: Telegram ids are digits only and all-or-nothing (one typo in a pasted list adds nobody),
  site ids are validated, and nothing from a form reaches SQL except as a bound parameter.
- **Audit**: every mutation is logged with the acting admin's id. A failing log write never undoes
  or hides the change itself.

## Behaviours worth knowing

- **Sites use the default token size.** The hub recognises a scan by its shape (`<namespace>_<32 hex
  characters>`); a site that sets a custom `tokenBytes` would not be recognised.
- **One namespace, one site (now enforced).** A namespace works only from its registered URLs, so a
  second site cannot silently borrow it. Two sites that genuinely should share an audience can be
  registered under one namespace by giving it both URLs.
- **Deleting a site deletes its grants and its block list.** Re-adding the same namespace later
  starts with nobody, and with nobody banned.
- **Switching a site off keeps its grants.** Nobody can sign in, and open sessions fail on their next
  request; switching it back on restores everyone.
- **Refused scans are remembered, but only for real QR codes, and only on sites that need grants.** A request is recorded only if the
  scan carried a token that a site actually minted and is still pending; messaging the bot made-up
  payloads is refused without leaving a trace. Requests are capped per site (100, newest kept), so
  the list cannot be flooded into growing without bound.
- **A registry outage is retryable, not a sign-out.** If the database cannot be read, sites answer
  `503` and the hub asks the person to scan again; nobody's cookie is cleared on the strength of an
  outage. Bootstrap admins can still reach the console.
- **KV's consistency applies to the login store.** A scan can take an extra poll or two to reach the
  site's browser, and two simultaneous scans of one QR are not strictly one-shot. Bind D1 or a
  Durable Object as the login store if you need that guarantee (see README → *Storage*). The
  registry is always D1, which is strongly consistent for its writes.
- **Other bot features.** The hub owns the webhook, so a bot that also does other things should
  pass those updates through `onUnhandled`, or call `hub.handleUpdate(update)` from the framework
  that already owns the webhook — it resolves `true` for a sign-in and `false` for anything else.

## What it does not do

- **No rate limiting.** The webhook is behind Telegram's secret token, but `/admin/auth/*` and the
  sites' sign-in pages mint tokens for anyone who asks. Put Cloudflare rate limiting in front, as
  you would for any sign-in page.
- **No per-site administrators.** All super admins can change everything. If a site's owners should
  manage their own people, that is a separate role this does not model.
- **No groups, expiry or bulk import.** A grant is a Telegram id for a site; it lasts until revoked.
  The registry is a plain interface (see below), so scripts can add many people at once.
- **Grants are by numeric Telegram id.** Usernames are not resolvable by a bot, and not stable.
- **The console lists at most 500 people (and 500 blocks) per site.** Past that, manage them from the
  registry.
- **No list of an open site's members.** The hub learns nothing about who signs in to an open site
  beyond the moment of the scan.

## Using the registry from code

The console is a front end over the `HubStore` interface, which you can call directly — to seed
a new environment, import a list, or mirror grants from another system:

```js
const registry = new D1HubStore(env.HUB_DB);
await registry.createNamespace({ namespace: "docs", name: "Internal docs", origins: ["https://docs.example.com"] });
await registry.addGrant({ namespace: "docs", id: 123456789, label: "Ada" });
await registry.addBlock({ namespace: "docs", id: 555, label: "left the company" });
await registry.access("docs", 123456789);
// { exists: true, enabled: true, mode: "granted", origins: ["https://docs.example.com"], granted: true, blocked: false }
```

Direct writes skip the audit log; call `registry.appendAudit({ actor, action, target, detail })`
yourself if you want them recorded. To use a different database, implement the contract documented
at the top of [`src/hub/store.js`](../src/hub/store.js); `tests/hub-store.test.mjs` is the suite
both built-in stores pass.

## Configuration

```js
createHub({
  botToken,                  // required unless `telegram` is given
  botUsername,               // required, without the "@"
  store,                     // required — the login store the sites share
  registry,                  // required — a HubStore (D1HubStore on Workers)
  superAdmins,               // required, at least one: "111,222" or [111, 222]
  sessionSecret,             // required — the console's cookie secret; not the bot token

  webhookSecret,             // the secret_token given to setWebhook — set it
  webhookPath: "/telegram/webhook",
  adminPath: "/admin",
  adminSessionSeconds: 28800,
  qrOrigin,                  // optional, as for createTelegramQrAuth
  branding,                  // optional overrides for the console's sign-in page
  telegram,                  // bring your own client: { call(method, payload) }
  onUnhandled,               // (update) => void — updates that were not sign-ins
  onError,                   // (err, update?) => void — defaults to console.error
});
```

| Member | Purpose |
| --- | --- |
| `fetch(request)` | A complete Worker handler: the hub's routes, `404` for the rest |
| `handle(request)` | The same, but `null` for paths it does not own, so it composes with your routing |
| `webhook(request)` | Just the Telegram webhook endpoint |
| `handleUpdate(update)` | One update from a bot framework you already run; resolves `true` for a sign-in |
| `adminAuth`, `registry`, `store` | Escape hatches |

`createSiteAuth` takes everything `createTelegramQrAuth` does, plus `registry` and a required
`session.secret`; `botToken` is optional. `hubGate({ registry, namespace })` and
`superAdminGate({ registry, rootAdmins })` are the two gates underneath, for composing by hand with
`every` / `some`.

## Refusal reasons

A custom sign-in page or log can tell these apart (`ctx.stage` is as in README → *Authorization*):

| `reason` | Meaning |
| --- | --- |
| `not_granted` | The site needs grants and this person has none |
| `blocked` | This person is on the site's block list (beats a grant; applies to open sites) |
| `namespace_disabled` | The site is switched off in the console (open or not) |
| `origin_not_allowed` | The request reached the site at a URL its namespace is not registered for |
| `unknown_namespace` | The site is not registered (deleted, or never added) |
| `not_admin` | A scan of the console's QR by someone who is not a super admin |
| `hub_unavailable` | The registry could not be read — transient, retry |
