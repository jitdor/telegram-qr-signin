// A site that signs people in through the hub. Compare with ../cloudflare-worker/worker.js: no bot
// token, no webhook, no group id — the hub owns the bot, and who may enter is whoever the hub's
// console has granted access to this site's namespace.
//
// Register this site in the console first (https://<hub>/admin → Add site, with the URL this Worker
// is served from). There is nothing to copy into this file: the site works out which site it is from
// the URL each request arrives at, and refuses to run anywhere that is not registered.
//
// Setup:
//   wrangler secret put SESSION_SECRET      # this site's own; never shared with another site
//   wrangler deploy
// and bind the SAME D1 database (HUB_DB) as the hub — see site-wrangler.jsonc. It holds both the
// registry and the login store.

import { D1LoginStore, escapeHtml } from "telegram-qr-signin";
import { createSiteAuth, D1HubStore } from "telegram-qr-signin/hub";

export default {
  async fetch(request, env) {
    const auth = createSiteAuth({
      botUsername: env.TELEGRAM_BOT_USERNAME, // the QR points at the bot; the bot token is not needed here
      store: new D1LoginStore(env.HUB_DB), // the hub's login store: the same database
      registry: new D1HubStore(env.HUB_DB),
      session: { secret: env.SESSION_SECRET },
      branding: { title: "Docs — Sign in", heading: "📚 Internal docs" },

      // Optionally AND in a gate of your own (needs `botToken` if it talks to Telegram):
      //   authorize: chatMember({ chatId: env.CHAT_ID }),
    });

    const handled = await auth.handle(request); // /auth/login, /auth/poll, /auth/logout, ...
    if (handled) return handled;

    // Verifies the cookie AND asks the registry again, so revoking someone in the console locks
    // them out of this site on their next request.
    const gate = await auth.guard(request);
    if (!gate.ok) return gate.response;

    return new Response(`<h1>Hello ${escapeHtml(gate.session.name)}</h1><p><a href="/auth/logout">Sign out</a></p>`, {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  },
};
