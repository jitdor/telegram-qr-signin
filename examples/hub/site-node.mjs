// The same site, on plain Node: no Cloudflare anywhere. It holds the hub's address and its key, and
// asks the hub over HTTPS for everything else. Run it anywhere that can reach the hub: a VPS,
// another cloud, your laptop.
//
//   HUB_URL=https://auth.example.com/hub-api HUB_KEY=tqk_docs_... \
//   TELEGRAM_BOT_USERNAME=your_bot SESSION_SECRET=$(openssl rand -hex 32) node site-node.mjs
//
// The site's address (here http://localhost:8788) must be one of the URLs registered for it in the
// hub console, or the hub will refuse to start a sign-in.

import { createServer } from "node:http";
import { createSiteAuth } from "telegram-qr-signin/site";

const PORT = Number(process.env.PORT ?? 8788);
const { HUB_URL, HUB_KEY, TELEGRAM_BOT_USERNAME, SESSION_SECRET } = process.env;
if (!HUB_URL || !HUB_KEY || !TELEGRAM_BOT_USERNAME || !SESSION_SECRET) {
  console.error("Set HUB_URL, HUB_KEY, TELEGRAM_BOT_USERNAME and SESSION_SECRET");
  process.exit(1);
}

const auth = createSiteAuth({
  hub: { url: HUB_URL, key: HUB_KEY },
  botUsername: TELEGRAM_BOT_USERNAME,
  // localhost is plain HTTP, so the Secure attribute would stop the cookie from ever being set.
  // Never do this in production.
  session: { secret: SESSION_SECRET, secure: false },
});

createServer(async (req, res) => {
  const request = new Request(new URL(req.url, `http://localhost:${PORT}`), { method: req.method, headers: req.headers });
  const response = (await auth.handle(request)) ?? (await page(request));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`site on http://localhost:${PORT}`));

async function page(request) {
  const gate = await auth.guard(request); // asks the hub on every request
  if (!gate.ok) return gate.response;
  return new Response(`<h1>Hello ${gate.session.name.replace(/[<>&]/g, "")}</h1><p><a href="/auth/logout">Sign out</a></p>`, {
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}
