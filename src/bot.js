// The bot half, as a ready-made webhook handler.
//
// `auth.handleStart()` already does the security-relevant work and hands back a reply string;
// this file is the thin layer that actually sends it, and it exists so the common case is a
// three-line bot rather than a hand-rolled update loop. Apps that already run grammY, Telegraf or
// their own dispatcher should skip this and call `auth.handleStart()` from inside whatever
// `/start` handler they already have — that path is fully supported and no less complete.

import { hmacSha256, toHex, timingSafeEqualHex } from "./crypto.js";

/** Constant-time string compare: MACs both sides under the secret so length cannot leak either. */
async function safeEqual(candidate, secret) {
  const key = new TextEncoder().encode(secret);
  const [a, b] = await Promise.all([hmacSha256(key, candidate), hmacSha256(key, secret)]);
  return timingSafeEqualHex(toHex(a), toHex(b));
}

/**
 * @param {object} auth   The object returned by createTelegramQrAuth.
 * @param {object} [options]
 * @param {object} [options.telegram]  Client to reply with. Defaults to the provider's.
 * @param {boolean} [options.deleteCommandMessage=true]  Delete the "/start <token>" message once
 *   it has done its job, so the chat isn't left as a scrollback of spent sign-in links. Best
 *   effort — a failure here is never allowed to fail the sign-in.
 * @param {boolean} [options.showClientContext=true]  Append where the sign-in was started from
 *   (origin, IP, browser) to the success message. Costs nothing and is the main defence against
 *   someone being talked into scanning a QR that isn't theirs — see the README.
 * @param {boolean} [options.showReturnHint=true]  When the sign-in page was open in a phone or
 *   tablet browser, say how to get back to it ("tap ◀ Safari at the top-left"). A bot cannot switch
 *   apps for the person, but their phone has a way back and most people do not know it is there.
 * @param {Function} [options.onSignIn]  `(user, result) => void|Promise` after a successful confirm.
 * @returns {(update: object) => Promise<boolean>}  true if the update was a sign-in for this app.
 */
export function createStartHandler(auth, options = {}) {
  const {
    telegram = auth.telegram,
    deleteCommandMessage = true,
    showClientContext = true,
    showReturnHint = true,
    onSignIn,
  } = options;

  return async function handleUpdate(update) {
    const message = update?.message;
    const text = message?.text;
    const from = message?.from;
    if (!text || !from) return false;

    // Cheap pre-check so this handler stays silent on every message that isn't ours — including
    // /start payloads belonging to a *different* app sharing the same bot.
    if (!auth.parseStartPayload(text)) return false;

    const result = await auth.handleStart({ text, from });
    if (!result.matched) return false;

    let reply = result.replyText;
    const hint = result.ok && showReturnHint ? returnHint(result.client) : null;
    if (hint) reply += `\n${hint}`;
    if (result.ok && showClientContext && result.client) {
      reply += `\n\n${formatClientContext(result.client)}`;
    }

    await send(telegram, message.chat.id, reply);

    if (deleteCommandMessage) {
      try {
        await remove(telegram, message.chat.id, message.message_id);
      } catch {
        // Deleting someone else's message needs permissions the bot may not have in this chat,
        // and the sign-in has already succeeded either way.
      }
    }

    if (result.ok) await onSignIn?.(result.user, result);
    return true;
  };
}

/**
 * A whole webhook endpoint for a bot that does nothing but sign-ins. Verifies Telegram's secret
 * token header when you give it one — always do, on a public URL.
 *
 * @param {object} auth
 * @param {object} [options]  Everything createStartHandler takes, plus:
 * @param {string} [options.secretToken]  Value configured as `secret_token` on setWebhook.
 * @param {Function} [options.onUnhandled]  `(update) => void|Promise` for updates that weren't sign-ins.
 * @param {Function} [options.onError]  `(err, update) => void|Promise` when handling an update
 *   throws. Defaults to `console.error`. The webhook answers 200 either way.
 */
export function createWebhookHandler(auth, options = {}) {
  const { secretToken, onUnhandled, onError, ...handlerOptions } = options;
  return createUpdateEndpoint(createStartHandler(auth, handlerOptions), { secretToken, onUnhandled, onError });
}

/**
 * The HTTP half of a webhook, for any `handleUpdate(update) => Promise<boolean>`: method check,
 * secret-token check, JSON parse, and the always-200 acknowledgement. `createWebhookHandler` is this
 * around one app's start handler; the hub (src/hub) is this around a handler that picks the app.
 *
 * @param {(update: object) => Promise<boolean>} handleUpdate  true if the update was handled.
 * @param {object} [options]  `secretToken`, `onUnhandled`, `onError` — see createWebhookHandler.
 */
export function createUpdateEndpoint(handleUpdate, options = {}) {
  const { secretToken, onUnhandled, onError = defaultOnError } = options;

  return async function handleRequest(request) {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    if (secretToken && !(await safeEqual(request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "", secretToken))) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Telegram retries a non-2xx and holds every later update behind it, so one failed reply
    // (a Telegram outage, a bug) would block every sign-in after it. The confirm has already
    // happened by the time the reply is sent; report the error and ack regardless.
    try {
      const handled = await handleUpdate(update);
      if (!handled) await onUnhandled?.(update);
    } catch (err) {
      try {
        await onError(err, update);
      } catch {
        // An error reporter that throws must not turn the ack into a 500 either.
      }
    }
    return new Response("ok");
  };
}

function defaultOnError(err) {
  console.error("telegram-qr-signin: webhook update failed", err);
}

function formatClientContext(client) {
  const parts = [];
  if (client.origin) parts.push(client.origin);
  if (client.userAgent) parts.push(describeBrowser(client.userAgent));
  if (client.ip) parts.push(client.ip);
  if (!parts.length) return "";
  return `Signed in to: ${parts.join(" · ")}\nIf that wasn't you, sign out and tell whoever runs this app.`;
}

/**
 * How to get back to the browser the sign-in page is open in, for phones and tablets; null for
 * anything else (a computer's browser signs itself in with no help). On iOS, Telegram shows a
 * "◀ <browser>" chip at the top-left when it was opened from a link in that browser; on Android the
 * back gesture or the recent-apps switcher does it.
 */
function returnHint(client) {
  const userAgent = client?.userAgent;
  if (!userAgent) return null;
  const browser = browserName(userAgent);
  if (/iPhone|iPad|iPod/.test(userAgent)) return `↩ To go back, tap "◀ ${browser}" at the top-left of your screen.`;
  if (/Android/.test(userAgent)) return `↩ To go back, swipe back or switch to ${browser}.`;
  return null;
}

/** The browser's name, recognising the iOS builds that put their own token in the user agent. */
function browserName(userAgent) {
  return /Edg\/|EdgA\/|EdgiOS\//.test(userAgent)
    ? "Edge"
    : /OPR\/|OPT\/|Opera/.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : "browser";
}

/** Deliberately coarse — a one-line hint for a human, not analytics. */
function describeBrowser(userAgent) {
  const browser = browserName(userAgent);
  // iPhone and iPad user agents say "like Mac OS X", so they must be recognised before macOS or
  // every iPhone sign-in would be described as a Mac. Likewise Android before Linux.
  const platform = /Windows/.test(userAgent)
    ? "Windows"
    : /iPhone|iPad|iPod/.test(userAgent)
      ? "iOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /Macintosh|Mac OS/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return platform ? `${browser} on ${platform}` : browser;
}

function send(telegram, chatId, text) {
  return telegram.sendMessage
    ? telegram.sendMessage(chatId, text)
    : telegram.call("sendMessage", { chat_id: chatId, text });
}

function remove(telegram, chatId, messageId) {
  return telegram.deleteMessage
    ? telegram.deleteMessage(chatId, messageId)
    : telegram.call("deleteMessage", { chat_id: chatId, message_id: messageId });
}
