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
| **Registry** (`D1HubStore`) | Sites, grants, super admins, requests, audit log | Only the hub's console |

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

**2. Open `https://<hub>/admin`** and scan the QR with a Telegram account whose numeric id is in
`superAdmins`. Add a site (`docs`, "Internal docs"). Grant people access.

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
| **Sites** | Add a site (namespace + display name), rename it, switch sign-in off and on, delete it |
| **People with access** | Grant by Telegram id (paste many at once, with an optional note), revoke |
| **Waiting for approval** | People who scanned a site's QR and were refused. Approve with one click, or dismiss — no need to ask anyone for their numeric id |
| **Super admins** | Add and remove other super admins |
| **Recent activity** | An audit log of every change: who, what, which site |

Revoking, disabling and deleting take effect on the person's **next request** to the site, not when
their cookie expires — the same live-check guarantee `chatMember` gives.

When someone is turned away, the bot tells them their Telegram id and the site's name, so even
without the approval queue they have something to send an admin.

### Roles

There are two kinds of access, deliberately separate:

- **Super admin** — can use the console. Does **not** get into any site by being one; grant
  yourself access like anyone else.
- **Site access** — a grant for one namespace. It lets someone sign in to that site and does nothing
  else. It is per site: access to `docs` opens nothing on `wiki`.

**Bootstrap admins** (`superAdmins` in config) always work, cannot be removed in the console, and
never touch the database to be recognised. That is what makes locking yourself out impossible: even
with an empty or broken registry, they can sign in and repair it. Admins you add in the console are
extra, removable, and recorded with who added them. All super admins are equal; there are no
per-site administrators.

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
- **One namespace, one site.** Two Workers sharing a namespace share a login queue and an access
  list. Give each site its own.
- **Deleting a site deletes its grants.** Re-adding the same namespace later starts with nobody.
- **Switching a site off keeps its grants.** Nobody can sign in, and open sessions fail on their next
  request; switching it back on restores everyone.
- **Refused scans are remembered, but only for real QR codes.** A request is recorded only if the
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
- **The console lists at most 500 people per site.** Past that, manage them from the registry.

## Using the registry from code

The console is a front end over the `HubStore` interface, which you can call directly — to seed
a new environment, import a list, or mirror grants from another system:

```js
const registry = new D1HubStore(env.HUB_DB);
await registry.createNamespace({ namespace: "docs", name: "Internal docs" });
await registry.addGrant({ namespace: "docs", id: 123456789, label: "Ada" });
await registry.access("docs", 123456789);   // { exists: true, enabled: true, granted: true }
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
| `not_granted` | The site is on and this person has no grant |
| `namespace_disabled` | The site is switched off in the console |
| `unknown_namespace` | The site is not registered (deleted, or never added) |
| `not_admin` | A scan of the console's QR by someone who is not a super admin |
| `hub_unavailable` | The registry could not be read — transient, retry |
