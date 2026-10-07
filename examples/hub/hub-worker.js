// The hub: ONE Telegram bot for every site, plus the admin console that decides who may sign in to
// which. Deploy this once. It is the only Worker that holds the bot token.
//
// Setup:
//   wrangler d1 create hub
//   wrangler d1 execute hub --remote --file=node_modules/telegram-qr-signin/migrations/hub-d1.sql
//   wrangler kv namespace create LOGINS                  # shared with every site Worker
//   wrangler secret put TELEGRAM_BOT_TOKEN
//   wrangler secret put TELEGRAM_WEBHOOK_SECRET          # any long random string
//   wrangler secret put CONSOLE_SESSION_SECRET           # another one; NOT the bot token
//   wrangler deploy
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<hub>/telegram/webhook&secret_token=<WEBHOOK_SECRET>"
//
// Then open https://<hub>/admin, scan the QR with a Telegram account whose numeric id is listed in
// SUPER_ADMINS (see wrangler.jsonc), add a site, and grant people access.

import { KVLoginStore } from "telegram-qr-signin";
import { createHub, D1HubStore } from "telegram-qr-signin/hub";

export default {
  async fetch(request, env) {
    const hub = createHub({
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUsername: env.TELEGRAM_BOT_USERNAME,

      // Where a scan is handed from the bot to the site's browser. Every site binds the same one.
      store: new KVLoginStore(env.LOGINS),

      // The access list. Every site reads it on each guarded request; only this Worker writes it.
      registry: new D1HubStore(env.HUB_DB),

      // Bootstrap admins: "111,222". They cannot be removed from the console, so you cannot lock
      // yourself out. Everyone else is added in the console.
      superAdmins: env.SUPER_ADMINS,

      sessionSecret: env.CONSOLE_SESSION_SECRET,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,

      // Optional: put your own domain in the console's QR instead of t.me.
      qrOrigin: env.QR_ORIGIN,
    });

    // /telegram/webhook and /admin/*; 404 for everything else. Use `hub.handle(request)` instead
    // (it returns null for paths it does not own) to compose it with routes of your own.
    return hub.fetch(request);
  },
};
