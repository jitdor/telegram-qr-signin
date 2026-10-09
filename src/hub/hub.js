// The hub: ONE bot webhook for every site, and the console that says who may sign in to which.
//
// Without it, each site that wants a bot needs its own bot, or you hand-write the dispatch. With
// it, you point Telegram's single webhook here and register sites in the admin console:
//
//   site Worker                         hub Worker                         Telegram
//   -----------                         ----------                         --------
//   shows QR  acme_<token>  ----------------------------------------->  user scans
//   polls its store           <--- /start acme_<token> (the webhook) ---  bot gets /start
//                                  1. namespace "acme" registered?
//                                  2. gate: does this person hold a grant?
//                                  3. if so, confirm the token in the shared login store
//   poll sees "confirmed",
//   re-checks the grant, sets cookie
//
// The hub and the sites share exactly two things: the login store (where a scan is handed over)
// and the registry (who holds a grant). Sites never need the bot token.

import { createTelegramQrAuth } from "../provider.js";
import { DEFAULT_BRANDING, escapeHtml, previewTags, renderEndedPage } from "../login-page.js";
import { createStartHandler, createUpdateEndpoint } from "../bot.js";
import { TelegramClient } from "../telegram.js";
import { tokenPattern } from "../crypto.js";
import { hubGate, superAdminGate, parseRootAdmins, parseRootAdminNames } from "./gates.js";
import { createAdminConsole } from "./console.js";
import { createHubApi } from "./api.js";
import { ADMIN_NAMESPACE, NAMESPACE_RE, cleanName, describeUser } from "./validate.js";

const PATH_RE = /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const TOKEN_RE = tokenPattern(16); // sites use the default token size; the hub does not know otherwise
const ADMIN_KEY_LABEL = "TelegramQrHubAdminSession";

// How many "someone asked to join" messages the super admins get per site per hour. One more says
// that the rest are not being announced; after that, silence until the hour is up. The requests are
// all still in the console, so a flood of scans costs the admins at most six messages.
const REQUEST_NOTICES_PER_HOUR = 5;

/**
 * @param {object} config
 * @param {string} [config.botToken]       Required unless `telegram` is supplied.
 * @param {string} config.botUsername      Without the "@".
 * @param {object} config.store            The login store the sites share (KV, D1 or Durable Object).
 * @param {object} config.registry         A HubStore — `new D1HubStore(env.HUB_DB)`.
 * @param {string|number|Array<string|number>} config.superAdmins
 *   Bootstrap super admins, as "111,222" or an array. At least one is required, and they cannot be
 *   removed from the console — that is what makes locking yourself out impossible. Give one a name
 *   with "111:Ada" and the console shows Ada, not 111, wherever it says who did something.
 * @param {string} config.sessionSecret    Signs the console's session cookie. Use a dedicated secret.
 * @param {string} [config.webhookSecret]  The `secret_token` given to setWebhook. Set it.
 * @param {string} [config.webhookPath="/telegram/webhook"]
 * @param {string} [config.adminPath="/admin"]
 * @param {string} [config.apiPath="/hub-api"]  Where sites call the hub (see ./api.js). A site's
 *   `hub.url` is this path on the hub's address, e.g. "https://auth.example.com/hub-api".
 * @param {string} [config.adminUrl]       The console's public URL, such as "https://hub.example.com/admin",
 *   for the link in the message super admins get when someone asks to join a site. Without it the
 *   hub uses the address Telegram's webhook calls it at.
 * @param {number} [config.adminSessionSeconds=28800]  Console sign-ins last 8 hours by default.
 * @param {string} [config.qrOrigin]       See createTelegramQrAuth — applies to the console's QR.
 * @param {boolean} [config.landing=true]  Answer GET / with a small page that says what this is and links to the
 *   console, carrying the link-preview card, so the hub's bare address unfurls in Telegram, Slack and the like
 *   instead of being a 404. Set false when something else owns `/`.
 * @param {object} [config.branding]       Overrides for the console's sign-in page.
 * @param {object} [config.telegram]       Bring-your-own Telegram client exposing `call()`.
 * @param {Function} [config.onUnhandled]  `(update) => void` for updates that were not sign-ins.
 * @param {Function} [config.onError]      `(err, update?) => void`. Defaults to console.error.
 */
export function createHub(config) {
  const {
    botToken,
    botUsername,
    store,
    registry,
    superAdmins,
    sessionSecret,
    webhookSecret,
    webhookPath = "/telegram/webhook",
    adminPath = "/admin",
    adminUrl,
    apiPath = "/hub-api",
    adminSessionSeconds = 8 * 3600,
    qrOrigin,
    landing = true,
    branding,
    telegram = botToken ? new TelegramClient(botToken) : null,
    onUnhandled,
    onError = (err) => console.error("telegram-qr-signin/hub: update failed", err),
  } = config ?? {};

  if (!store) throw new Error("createHub: `store` (the shared login store) is required");
  if (!registry) throw new Error("createHub: `registry` is required");
  if (!botUsername) throw new Error("createHub: `botUsername` is required");
  if (!telegram) throw new Error("createHub: pass `botToken` or `telegram`");
  if (!sessionSecret || typeof sessionSecret !== "string") throw new Error("createHub: `sessionSecret` is required");
  if (!PATH_RE.test(adminPath)) throw new Error("createHub: `adminPath` must look like /admin (no trailing slash)");
  if (!PATH_RE.test(webhookPath)) throw new Error("createHub: `webhookPath` must look like /telegram/webhook");
  if (!PATH_RE.test(apiPath)) throw new Error("createHub: `apiPath` must look like /hub-api (no trailing slash)");
  const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  if (overlaps(webhookPath, adminPath) || overlaps(webhookPath, apiPath) || overlaps(adminPath, apiPath)) {
    throw new Error("createHub: `webhookPath`, `adminPath` and `apiPath` must not overlap");
  }
  const rootAdmins = parseRootAdmins(superAdmins);
  const rootNames = parseRootAdminNames(superAdmins);
  if (!rootAdmins.length) {
    throw new Error("createHub: `superAdmins` needs at least one Telegram user id — it is how you get into the console the first time");
  }

  // The console signs in through the same QR flow as any site, under a namespace sites cannot take.
  const adminAuth = createTelegramQrAuth({
    botUsername,
    botToken,
    telegram,
    store,
    namespace: ADMIN_NAMESPACE,
    authorize: superAdminGate({ registry, rootAdmins, onError }),
    basePath: `${adminPath}/auth`,
    redirectTo: adminPath,
    qrOrigin,
    session: {
      secret: sessionSecret,
      // A different label and cookie name from any site's, so a site session signed with the same
      // secret can never be mistaken for a console session.
      keyLabel: ADMIN_KEY_LABEL,
      cookieName: "hub_admin_session",
      path: adminPath,
      maxAgeSeconds: adminSessionSeconds,
    },
    branding: {
      title: "Hub admin — sign in",
      siteName: "Hub admin",
      deniedText: "Your Telegram account isn't a super admin of this hub.",
      botDeniedText: "🔒 You're not a super admin of this hub.",
      botSuccessText: "✅ Signed in to the hub admin console — head back to your browser tab.",
      ...branding,
    },
  });

  const adminConsole = createAdminConsole({
    auth: adminAuth,
    registry,
    rootAdmins,
    rootNames,
    adminPath,
    apiPath,
    secret: sessionSecret,
    onError,
    onApproved: (approval) => notifyApproved(approval),
  });
  const handleAdminStart = createStartHandler(adminAuth, { telegram });
  const api = createHubApi({ registry, store, apiPath, onError });

  /** `[namespace, token]` from a /start message, shaped like createTelegramQrAuth's own parser. */
  function parseStart(text) {
    if (typeof text !== "string") return null;
    let payload = text.trim();
    const start = payload.match(/^\/start(?:@\S+)?\s+(\S+)/);
    if (start) payload = start[1];
    const separator = payload.indexOf("_");
    if (separator < 1) return null;
    const namespace = payload.slice(0, separator);
    const token = payload.slice(separator + 1);
    return NAMESPACE_RE.test(namespace) && TOKEN_RE.test(token) ? { namespace, token } : null;
  }

  /** Reads the namespace off the scan, then lets that site's gate decide. */
  async function handleUpdate(update) {
    const message = update?.message;
    const parsed = parseStart(message?.text);
    if (!parsed || !message?.from) return false;

    if (parsed.namespace === ADMIN_NAMESPACE) return handleAdminStart(update);

    let site;
    let record = null;
    try {
      site = await registry.getNamespace(parsed.namespace);
      if (site) record = await store.get(parsed.token, parsed.namespace);
    } catch (err) {
      onError(err, update);
      await reply(message, "Couldn't check your access just now. Scan the same QR code again in a moment.");
      return true;
    }

    if (!site) {
      await reply(message, "That sign-in link isn't recognised. Go back to the sign-in page and scan the new QR code.");
      return true;
    }

    // Only a scan of a QR a site actually minted is worth remembering as a request; otherwise
    // anyone could fill the list by messaging the bot made-up payloads.
    const live = record?.status === "pending";

    // The namespace is bound to the site's URL(s). The QR records where it was shown, so a scan of
    // one minted anywhere else — staging using production's namespace, a site that was never
    // registered — is turned away before it can spend anything, and says why. A QR that is already
    // gone falls through to the usual "expired" reply. (This relies on the site recording its origin
    // honestly; it stops a mistake, not a hostile Worker that holds the shared bindings.)
    if (record && !site.origins.includes(record.client?.origin ?? "")) {
      await reply(message, `That sign-in code came from a site that isn't registered for ${cleanName(site.name) || site.namespace}. Open the real site and scan the code it shows.`);
      return true;
    }
    const outcome = { request: null };
    const handled = await createStartHandler(botAuthFor(site, message.from, live, outcome), { telegram })(update);
    // After the person has their reply: telling the admins is slower and is nobody's business to wait on.
    if (outcome.request?.isNew) await announceRequest(site, message.from);
    return handled;
  }

  /**
   * The per-scan auth the start handler needs. Built per update, so the site's current name and
   * state are always what the person sees, and nothing is cached that an admin's change could
   * leave stale. Construction is just closures — no I/O.
   *
   * The refusal message is chosen from what the gate actually decided, not from the site's state
   * beforehand, so the reply cannot disagree with the verdict (a site switched off a moment ago,
   * a block added mid-scan). The start handler reads `botDeniedText` only after the gate has run,
   * which is why a getter can see the outcome.
   */
  function botAuthFor(site, from, live, outcome) {
    const name = cleanName(site.name) || site.namespace;
    const gate = hubGate({
      registry,
      namespace: site.namespace,
      recordRequests: live,
      onRequest: (request) => {
        outcome.request = request;
      },
      onError,
    });
    let refusal = null;
    let requested = false;

    return createTelegramQrAuth({
      botUsername,
      botToken,
      telegram,
      store,
      namespace: site.namespace,
      authorize: async (user, ctx) => {
        const result = await gate(user, ctx);
        refusal = result === true ? null : result.reason;
        requested = result !== true && result.requested === true;
        return result;
      },
      session: { secret: sessionSecret },
      branding: {
        botSuccessText: `✅ You're signed in to ${name} — head back to your browser tab.`,
        get botDeniedText() {
          switch (refusal) {
            case "namespace_disabled":
              return `${name} is switched off right now.`;
            case "blocked":
              return `🚫 You can't sign in to ${name}.`;
            case "pending_approval":
              if (!requested) return `🔒 You don't have access to ${name} yet. Ask an administrator to approve you.`;
              return outcome.request?.isNew === false
                ? `⏳ Your request to join ${name} is still waiting for approval. I'll message you here as soon as it's approved.`
                : `📝 Request received. An administrator will review your request to join ${name}, and I'll message you here once you're approved.`;
            default:
              return `🔒 You don't have access to ${name} yet.\nYour Telegram ID is ${from.id} — send it to an administrator to be added.`;
          }
        },
      },
    });
  }

  async function reply(message, text) {
    await dm(message.chat.id, text);
  }

  /** Sends a message; true if Telegram took it. A person who has blocked the bot cannot be reached. */
  async function dm(chatId, text) {
    try {
      await telegram.call("sendMessage", { chat_id: chatId, text });
      return true;
    } catch (err) {
      onError(err);
      return false;
    }
  }

  /** The console approved someone: tell them. Returns whether the message was delivered. */
  async function notifyApproved({ site, id }) {
    const name = cleanName(site.name) || site.namespace;
    return dm(id, `✅ You've been approved for ${name}.\nOpen ${site.origins[0]} and scan the sign-in QR code again to get in.`);
  }

  // The address Telegram last called the webhook at, for the link in admin messages when adminUrl
  // is not configured. It is the hub's own public origin by construction: Telegram is calling it.
  let webhookOrigin = null;

  function consoleLink(namespace) {
    const base = adminUrl ? String(adminUrl).replace(/\/+$/, "") : webhookOrigin ? `${webhookOrigin}${adminPath}` : null;
    return base ? `\nReview: ${base}/ns/${namespace}#waiting` : "";
  }

  /**
   * Tells the super admins that someone asked to join a site, once per person (a repeat scan by the
   * same person does not message anyone again). Capped per site per hour, see REQUEST_NOTICES_PER_HOUR.
   */
  async function announceRequest(site, user) {
    try {
      const since = Math.floor(Date.now() / 1000) - 3600;
      const recent = (await registry.listRequests(site.namespace, { limit: 100 })).filter((r) => r.firstSeen >= since).length;
      if (recent > REQUEST_NOTICES_PER_HOUR + 1) return;

      const name = cleanName(site.name) || site.namespace;
      const who = describeUser(user);
      const text =
        recent > REQUEST_NOTICES_PER_HOUR
          ? `📝 More people are asking to join ${name}. I won't message you about each one for the next hour; they are all waiting in the console.${consoleLink(site.namespace)}`
          : `📝 ${who || "Someone"} is asking to join ${name}.\nTelegram id: ${user.id}${consoleLink(site.namespace)}`;

      const admins = new Set(rootAdmins);
      for (const admin of await registry.listAdmins()) admins.add(admin.id);
      admins.delete(Number(user.id)); // asking to join a site you administer needs no announcement to yourself
      for (const id of admins) await dm(id, text);
    } catch (err) {
      onError(err);
    }
  }

  const updateEndpoint = createUpdateEndpoint(handleUpdate, { secretToken: webhookSecret, onUnhandled, onError });
  const webhook = (request) => {
    try {
      webhookOrigin = new URL(request.url).origin;
    } catch {
      // Not a URL we can use; the link is simply left out.
    }
    return updateEndpoint(request);
  };

  /** GET / — what link previews of the hub's bare address read. No token is minted, and nothing here is private. */
  function landingResponse(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const origin = new URL(request.url).origin;
    const page = {
      ...DEFAULT_BRANDING,
      ...branding,
      kickerText: "Authentication platform",
      title: "Telegram QR Sign-in Provider",
      description: branding?.description ?? "Sign in by scanning a QR code with Telegram. Tap Approve and you're in. No password, no phone number, nothing to type.",
    };
    const text = String(page.description).replace("{name}", page.siteName || new URL(origin).host);
    const html = renderEndedPage({
      branding: page,
      fontsPath: adminAuth.paths.fonts,
      title: "Sign in with a QR code.",
      text,
      pageTitle: page.title,
      extraHtml: `<p class="tqa-ended-note"><a style="color: inherit; font-weight: 600" href="${escapeHtml(adminPath)}">Open the admin console</a></p>`,
      head: previewTags({ branding: page, name: page.siteName, host: new URL(origin).host, origin, previewPath: adminAuth.paths.preview }),
      origin,
    });
    return new Response(request.method === "HEAD" ? null : html, {
      headers: { "Content-Type": "text/html; charset=UTF-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  }

  /** The hub's routes, or null for any path it does not own — so it composes with other routing. */
  async function handle(request) {
    const { pathname } = new URL(request.url);
    if (landing && pathname === "/") return landingResponse(request);
    if (pathname === webhookPath) return webhook(request);
    return (await api.handle(request)) ?? adminConsole.handle(request);
  }

  return {
    /** A complete Worker `fetch`: the hub's routes, and 404 for everything else. */
    async fetch(request) {
      return (await handle(request)) ?? new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
    },
    handle,
    webhook,
    /** Feed one Telegram update in directly — for a bot framework that already owns the webhook. */
    handleUpdate,

    rootAdmins,
    paths: { webhook: webhookPath, admin: adminPath, api: apiPath },
    adminAuth,
    registry,
    store,
  };
}
