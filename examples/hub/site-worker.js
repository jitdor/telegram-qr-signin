// A site that signs people in through the hub. Compare with ../cloudflare-worker/worker.js: no bot
// token, no webhook, no store, no database. This Worker holds the hub's address and its own KEY, and
// nothing else of the hub's: it asks the hub over HTTPS to start a sign-in, to say who scanned, and
// whether that person may come in. Who may enter is whoever the hub's console has granted access.
//
// Register this site in the console first (https://<hub>/admin -> Add site, with the URL this Worker
// is served from). The console shows the site's key once: that is HUB_KEY below.
//
// Setup:
//   wrangler secret put HUB_KEY             # the key the console showed
//   wrangler secret put SESSION_SECRET      # this site's own; never shared with another site
//   wrangler deploy
// HUB_URL (a var, in site-wrangler.jsonc) is the hub's API address, https://<hub>/hub-api.

import { escapeHtml } from "telegram-qr-signin";
import { createSiteAuth } from "telegram-qr-signin/site";

export default {
  async fetch(request, env) {
    const auth = createSiteAuth({
      hub: { url: env.HUB_URL, key: env.HUB_KEY },
      botUsername: env.TELEGRAM_BOT_USERNAME, // the QR points at the bot; the bot token is not needed here
      session: { secret: env.SESSION_SECRET },
      branding: { title: "Docs — Sign in", heading: "📚 Internal docs" },

      // Optionally AND in a gate of your own (needs `botToken` if it talks to Telegram):
      //   authorize: chatMember({ chatId: env.CHAT_ID }),
    });

    const handled = await auth.handle(request); // /auth/login, /auth/poll, /auth/logout, ...
    if (handled) return handled;

    // Verifies the cookie AND asks the hub again, so revoking someone in the console locks them out
    // of this site on their next request. If the hub is unreachable the visitor is asked to try
    // again; nobody is signed out because of an outage.
    const gate = await auth.guard(request);
    if (!gate.ok) return gate.response;

    return new Response(`<h1>Hello ${escapeHtml(gate.session.name)}</h1><p><a href="/auth/logout">Sign out</a></p>`, {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  },
};
