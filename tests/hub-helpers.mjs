import { createHub } from "../src/hub/hub.js";
import { createSiteAuth } from "../src/hub/site.js";
import { MemoryHubStore } from "../src/hub/store.js";
import { MemoryLoginStore } from "../src/stores/memory.js";
import { createHash } from "node:crypto";
import { generateSiteKey } from "../src/hub/validate.js";
import { makeFakeTelegram, makeRequest, cookieFrom } from "./helpers.mjs";

export const ROOT = { id: 1000, first_name: "Rhea", username: "rhea" };
export const ADMIN2 = { id: 2000, first_name: "Ada", last_name: "Min" };
export const ALICE = { id: 111, first_name: "Alice", last_name: "Ng", username: "alice" };
export const BOB = { id: 222, first_name: "Bob" };
export const MALLORY = { id: 999, first_name: "Mallory", username: "mal" };

export const ORIGIN = "https://hub.example";
export const WEBHOOK_SECRET = "whsec";

export function makeHub({ registry = new MemoryHubStore(), config = {} } = {}) {
  const telegram = makeFakeTelegram();
  const store = new MemoryLoginStore();
  const errors = [];
  const hub = createHub({
    botUsername: "hub_bot",
    botToken: "1:TOKEN",
    telegram,
    store,
    registry,
    superAdmins: [ROOT.id],
    sessionSecret: "console-secret-console-secret-00",
    webhookSecret: WEBHOOK_SECRET,
    onError: (err) => errors.push(err),
    ...config,
  });
  return { hub, telegram, store, registry, errors };
}

/**
 * A site's auth, as it is deployed: it knows the hub's address and its own key and NOTHING else of the
 * hub's. Its `fetch` goes straight into the hub in-process, so these tests exercise the real API
 * without a network. The key is made the way the console makes one (a hash is stored, the key is not).
 */
export function makeSite(ctx, namespace, extra = {}) {
  const { hub, registry } = ctx;
  // One key per site per test, as in life: making another would replace (and so revoke) the first.
  ctx.siteKeys ??= {};
  let key = ctx.siteKeys[namespace];
  if (!key) {
    key = ctx.siteKeys[namespace] = generateSiteKey(namespace);
    // The memory store's setSiteKey has no await in it, so the key is in place when this returns. A
    // namespace that does not exist gets a key the hub does not know, which is how a deleted site looks.
    registry.setSiteKey(namespace, createHash("sha256").update(key).digest("hex"));
  }
  const { hub: hubExtra, ...rest } = extra;
  return createSiteAuth({
    botUsername: "hub_bot",
    session: { secret: `site-secret-${namespace}-site-secret-00` },
    onError: () => {},
    ...rest,
    hub: { url: `${ORIGIN}/hub-api`, key, fetch: (url, init) => hub.fetch(new Request(url, init)), ...hubExtra },
  });
}

/** Mints a QR on `site` as a real visit would: with the request, so the QR records where it was shown. */
export function login(site, host = `https://${site.namespace}.example`) {
  return site.beginLogin({ request: makeRequest(`${host}/auth/login`) });
}

export function startUpdate(text, from, messageId = 7) {
  return { message: { message_id: messageId, chat: { id: from.id, type: "private" }, from, text } };
}

export function webhookRequest(update, secret = WEBHOOK_SECRET) {
  return new Request(`${ORIGIN}/telegram/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}) },
    body: JSON.stringify(update),
  });
}

export function lastReply(telegram) {
  const sent = telegram.calls.filter((call) => call.method === "sendMessage");
  return sent.length ? sent.at(-1).payload.text : null;
}

/** Signs a super admin into the console the way a person would: mint, scan, poll. Returns the Cookie header. */
export async function signInToConsole(hub, user) {
  const { token } = await hub.adminAuth.beginLogin();
  await hub.handleUpdate(startUpdate(`/start hub-admin_${token}`, user));
  const polled = await hub.fetch(makeRequest(`${ORIGIN}/admin/auth/poll?token=${token}`));
  const body = await polled.json();
  if (body.status !== "confirmed") throw new Error(`console sign-in failed: ${JSON.stringify(body)}`);
  return `hub_admin_session=${cookieFrom(polled, "hub_admin_session")}`;
}

/** The CSRF token the console embeds in its forms for the session in `cookie` — read the way a browser would. */
export async function csrfFor(hub, cookie) {
  const html = await (await hub.fetch(makeRequest(`${ORIGIN}/admin`, { cookie }))).text();
  const match = html.match(/name="csrf" value="([0-9a-f]+)"/);
  if (!match) throw new Error("no CSRF token on the dashboard — is the cookie valid?");
  return match[1];
}

export function get(hub, path, cookie) {
  return hub.fetch(makeRequest(`${ORIGIN}${path}`, { cookie }));
}

/** POSTs a form the way a browser would. `csrf` defaults to the right token for `cookie`. */
export async function post(hub, path, fields, { cookie, csrf, origin = ORIGIN } = {}) {
  const body = new URLSearchParams({ csrf: csrf ?? (cookie ? await csrfFor(hub, cookie) : "none"), ...fields });
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return hub.fetch(new Request(`${ORIGIN}${path}`, { method: "POST", headers, body }));
}

export function redirectTarget(response) {
  assertRedirect(response);
  return new URL(response.headers.get("Location"), ORIGIN);
}

function assertRedirect(response) {
  if (response.status !== 303) throw new Error(`expected a 303 redirect, got ${response.status}`);
}

/**
 * A pending sign-in written straight into the hub's store, as if a site had minted it: for tests of
 * what the hub does with a record it should never have been given (the API refuses to make these).
 */
export async function plantLogin(ctx, namespace, client) {
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await ctx.store.create({ token, namespace, expiresAt: Math.floor(Date.now() / 1000) + 600, client });
  return token;
}

/** The request a visitor's browser makes at `${host}${path}`, for the gate's origin check. */
export function visit(host, path = "/") {
  return makeRequest(`${host}${path}`);
}
