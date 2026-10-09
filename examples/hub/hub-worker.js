// The hub: ONE Telegram bot for every site, plus the admin console that decides who may sign in to
// which. Deploy this once. It is the only Worker that holds the bot token, the sign-in records and
// the access list: sites hold nothing of that and ask this Worker over HTTPS.
//
// Setup:
//   wrangler d1 create hub
//   wrangler d1 execute hub --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1.sql
//   wrangler secret put TELEGRAM_BOT_TOKEN
//   wrangler secret put TELEGRAM_WEBHOOK_SECRET          # any long random string
//   wrangler secret put CONSOLE_SESSION_SECRET           # another one; NOT the bot token
//   wrangler deploy
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<hub>/telegram/webhook&secret_token=<WEBHOOK_SECRET>"
//
// Then open https://<hub>/admin, scan the QR with a Telegram account whose numeric id is listed in
// SUPER_ADMINS (see wrangler.jsonc), add a site, copy the key it shows once into that site's
// secrets, and grant people access. docs/integrating-a-site.md walks through the site side.

import { DurableObject } from "cloudflare:workers";
import { defineQrAuthStorage, DoLoginStore } from "telegram-qr-signin/do";
import { createHub, D1HubStore } from "telegram-qr-signin/hub";

// The sign-in records live in a Durable Object: strongly consistent, so a confirmed scan is visible
// at once and one scan is exactly one sign-in. It creates its own tables; there is nothing to
// migrate. (KV would be simpler still, but it is eventually consistent and can leave a confirmed
// scan unseen for tens of seconds.) Bound in wrangler.jsonc.
export class QrAuthStorage extends defineQrAuthStorage(DurableObject) {}

export default {
  async fetch(request, env) {
    const hub = createHub({
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUsername: env.TELEGRAM_BOT_USERNAME,

      // Where a scan is handed from the bot to the site that is waiting for it. Only the hub reads or
      // writes it: a site starts and collects its sign-ins through the hub's API.
      store: new DoLoginStore(env.QRAUTH_DO),

      // The access list: sites, grants, blocks, super admins, requests, the audit log, site keys.
      // Durable, so back it up. Only this Worker binds it.
      registry: new D1HubStore(env.HUB_DB),

      // Bootstrap admins: "111,222". They cannot be removed from the console, so you cannot lock
      // yourself out. Everyone else is added in the console.
      superAdmins: env.SUPER_ADMINS,

      sessionSecret: env.CONSOLE_SESSION_SECRET,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,

      // Optional: put your own domain in the console's QR instead of t.me.
      qrOrigin: env.QR_ORIGIN,
    });

    // /telegram/webhook, /admin/* and /hub-api/*; 404 for everything else. Use `hub.handle(request)`
    // instead (it returns null for paths it does not own) to compose it with routes of your own.
    return hub.fetch(request);
  },
};
