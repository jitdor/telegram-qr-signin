import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramQrAuth } from "../src/provider.js";
import { createStartHandler, createWebhookHandler } from "../src/bot.js";
import { MemoryLoginStore } from "../src/stores/memory.js";
import { allowlist } from "../src/gates.js";
import { TelegramClient } from "../src/telegram.js";
import { makeFakeTelegram, makeRequest, ALICE, MALLORY } from "./helpers.mjs";

function setup(options = {}) {
  const telegram = makeFakeTelegram({ members: [ALICE.id] });
  const auth = createTelegramQrAuth({
    botToken: "123:TEST",
    botUsername: "example_bot",
    store: new MemoryLoginStore(),
    namespace: "cockpit",
    telegram,
    authorize: allowlist([ALICE.id]),
    ...options,
  });
  return { auth, telegram };
}

function messageUpdate(text, from = ALICE, messageId = 55) {
  return { message: { message_id: messageId, chat: { id: 4242, type: "private" }, from, text } };
}

test("the start handler confirms, replies, and tidies up after itself", async () => {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth);
  const { token } = await auth.beginLogin();

  assert.equal(await handle(messageUpdate(`/start cockpit_${token}`)), true);

  const sent = telegram.calls.find((call) => call.method === "sendMessage");
  assert.match(sent.payload.text, /signed in/i);
  assert.ok(telegram.calls.some((call) => call.method === "deleteMessage" && call.payload.message_id === 55));
});

test("the start handler ignores everything that isn't a sign-in for this app", async () => {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth);

  for (const update of [
    messageUpdate("/start"),
    messageUpdate("hello"),
    messageUpdate("/start otherapp_0123456789abcdef0123456789abcdef"),
    messageUpdate("/start cockpit_not-a-token"),
    { message: { message_id: 1, chat: { id: 1 }, from: ALICE } }, // a photo, no text
    { callback_query: { data: "x" } },
    {},
  ]) {
    assert.equal(await handle(update), false);
  }
  assert.equal(telegram.calls.length, 0, "an unrelated message must not produce any API call");
});

test("a rejected scan gets told why, and the token stays usable", async () => {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth);
  const { token } = await auth.beginLogin();

  assert.equal(await handle(messageUpdate(`/start cockpit_${token}`, MALLORY)), true);
  const sent = telegram.calls.find((call) => call.method === "sendMessage");
  assert.match(sent.payload.text, /not authorized/i);

  assert.equal((await auth.store.get(token, "cockpit")).status, "pending");
});

test("the success message says what is being signed into", async () => {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth);
  const request = makeRequest("https://cockpit.example/auth/login", {
    headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0" },
  });
  const { token } = await auth.beginLogin({ request });

  await handle(messageUpdate(`/start cockpit_${token}`));
  const text = telegram.calls.find((call) => call.method === "sendMessage").payload.text;
  assert.match(text, /https:\/\/cockpit\.example/);
  assert.match(text, /Chrome on macOS/);
  assert.match(text, /203\.0\.113\.7/);
  assert.match(text, /wasn't you/i);
});

test("client context can be suppressed", async () => {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth, { showClientContext: false });
  const { token } = await auth.beginLogin({ request: makeRequest("https://cockpit.example/", { headers: { "CF-Connecting-IP": "203.0.113.7" } }) });

  await handle(messageUpdate(`/start cockpit_${token}`));
  assert.equal(/203\.0\.113\.7/.test(telegram.calls.find((c) => c.method === "sendMessage").payload.text), false);
});

test("a failed message delete never fails the sign-in", async () => {
  const { auth, telegram } = setup();
  telegram.deleteMessage = async () => {
    throw new Error("message can't be deleted");
  };
  const handle = createStartHandler(auth);
  const { token } = await auth.beginLogin();

  assert.equal(await handle(messageUpdate(`/start cockpit_${token}`)), true);
  assert.equal((await auth.store.get(token, "cockpit")).status, "confirmed");
});

test("onSignIn fires only on success", async () => {
  const { auth } = setup();
  const signedIn = [];
  const handle = createStartHandler(auth, { onSignIn: (user) => signedIn.push(user.id) });

  const { token } = await auth.beginLogin();
  await handle(messageUpdate(`/start cockpit_${token}`, MALLORY));
  assert.deepEqual(signedIn, []);

  await handle(messageUpdate(`/start cockpit_${token}`, ALICE));
  assert.deepEqual(signedIn, [ALICE.id]);
});

test("the webhook handler checks Telegram's secret token", async () => {
  const { auth } = setup();
  const handle = createWebhookHandler(auth, { secretToken: "s3cret" });
  const { token } = await auth.beginLogin();

  const body = JSON.stringify(messageUpdate(`/start cockpit_${token}`));
  const post = (headers) => new Request("https://bot.example/webhook", { method: "POST", headers, body });

  assert.equal((await handle(post({}))).status, 403);
  assert.equal((await handle(post({ "X-Telegram-Bot-Api-Secret-Token": "wrong" }))).status, 403);
  assert.equal((await auth.store.get(token, "cockpit")).status, "pending");

  assert.equal((await handle(post({ "X-Telegram-Bot-Api-Secret-Token": "s3cret" }))).status, 200);
  assert.equal((await auth.store.get(token, "cockpit")).status, "confirmed");
});

test("the webhook handler acks anything Telegram sends, so nothing gets retried forever", async () => {
  const { auth } = setup();
  const unhandled = [];
  const handle = createWebhookHandler(auth, { onUnhandled: (update) => unhandled.push(update) });

  assert.equal((await handle(new Request("https://bot.example/webhook", { method: "POST", body: "{}" }))).status, 200);
  assert.equal((await handle(new Request("https://bot.example/webhook", { method: "POST", body: "not json" }))).status, 400);
  assert.equal((await handle(new Request("https://bot.example/webhook", { method: "GET" }))).status, 405);
  assert.equal(unhandled.length, 1);
});

test("a bring-your-own client only needs call()", async () => {
  const calls = [];
  const minimal = {
    async call(method, payload) {
      calls.push(method);
      return { ok: true, result: { status: "member", message_id: 1 } };
    },
  };
  const { auth } = setup({ telegram: minimal, botToken: "123:TEST" });
  const handle = createStartHandler(auth, { telegram: minimal });
  const { token } = await auth.beginLogin();

  assert.equal(await handle(messageUpdate(`/start cockpit_${token}`)), true);
  assert.deepEqual(calls, ["sendMessage", "deleteMessage"]);
});

test("the default TelegramClient calls fetch with globalThis as this, as Workers requires", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const seen = [];
  globalThis.fetch = function (url, init) {
    // Workers throws "Illegal invocation" when fetch runs with any other receiver.
    if (this !== globalThis && this !== undefined) throw new TypeError("Illegal invocation");
    seen.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })));
  };

  const client = new TelegramClient("123:TEST");
  await client.sendMessage(4242, "hi");
  await client.deleteMessage(4242, 55);
  assert.deepEqual(
    seen.map((call) => call.url),
    ["https://api.telegram.org/bot123:TEST/sendMessage", "https://api.telegram.org/bot123:TEST/deleteMessage"]
  );
});

test("a failed reply still acks the webhook, so later sign-ins are not queued behind it", async () => {
  const { auth, telegram } = setup();
  telegram.sendMessage = async () => {
    throw new Error("Telegram API sendMessage failed: 502");
  };
  const errors = [];
  const handle = createWebhookHandler(auth, { onError: (err, update) => errors.push({ err, update }) });
  const post = (update) => new Request("https://bot.example/webhook", { method: "POST", body: JSON.stringify(update) });

  const first = await auth.beginLogin();
  const response = await handle(post(messageUpdate(`/start cockpit_${first.token}`)));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.equal((await auth.store.get(first.token, "cockpit")).status, "confirmed", "the confirm happened before the reply");
  assert.equal(errors.length, 1);
  assert.match(errors[0].err.message, /502/);
  assert.equal(errors[0].update.message.message_id, 55);

  // The next update is not stuck behind the failed one.
  const second = await auth.beginLogin();
  assert.equal((await handle(post(messageUpdate(`/start cockpit_${second.token}`, ALICE, 56)))).status, 200);
  assert.equal((await auth.store.get(second.token, "cockpit")).status, "confirmed");
});

test("an onError that throws, or the default console.error, still acks", async (t) => {
  const { auth, telegram } = setup();
  telegram.sendMessage = async () => {
    throw new Error("down");
  };
  const post = (update) => new Request("https://bot.example/webhook", { method: "POST", body: JSON.stringify(update) });

  const throwing = createWebhookHandler(auth, {
    onError: () => {
      throw new Error("reporter broke");
    },
  });
  const a = await auth.beginLogin();
  assert.equal((await throwing(post(messageUpdate(`/start cockpit_${a.token}`)))).status, 200);

  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  const byDefault = createWebhookHandler(auth);
  const b = await auth.beginLogin();
  assert.equal((await byDefault(post(messageUpdate(`/start cockpit_${b.token}`)))).status, 200);
  assert.equal(logged.length, 1);
});

test("an onUnhandled that throws is reported and acked too", async () => {
  const { auth } = setup();
  const errors = [];
  const handle = createWebhookHandler(auth, {
    onUnhandled: () => {
      throw new Error("app bot broke");
    },
    onError: (err) => errors.push(err),
  });
  const response = await handle(new Request("https://bot.example/webhook", { method: "POST", body: JSON.stringify(messageUpdate("hello")) }));
  assert.equal(response.status, 200);
  assert.equal(errors.length, 1);
});

// --- Getting back to the browser ---------------------------------------------------------------

const UA = {
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0.6312.52 Mobile/15E148 Safari/604.1",
  iphoneFirefox: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/124.0 Mobile/15E148 Safari/605.1.15",
  ipadEdge: "Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/123.0.2420.65 Mobile/15E148 Safari/605.1.15",
  androidChrome: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.99 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0",
  macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
};

async function signInFrom(userAgent, options) {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth, options);
  const request = makeRequest("https://cockpit.example/auth/login", { headers: userAgent ? { "User-Agent": userAgent } : {} });
  const { token } = await auth.beginLogin({ request });
  await handle(messageUpdate(`/start cockpit_${token}`));
  return telegram.calls.find((call) => call.method === "sendMessage").payload.text;
}

test("signing in from an iPhone browser says how to get back, naming that browser", async () => {
  assert.match(await signInFrom(UA.iphoneSafari), /↩ To go back, tap "◀ Safari" at the top-left of your screen\./);
  assert.match(await signInFrom(UA.iphoneChrome), /tap "◀ Chrome"/);
  assert.match(await signInFrom(UA.iphoneFirefox), /tap "◀ Firefox"/);
  assert.match(await signInFrom(UA.ipadEdge), /tap "◀ Edge"/);
});

test("signing in from an Android browser says how to get back", async () => {
  assert.match(await signInFrom(UA.androidChrome), /↩ To go back, swipe back or switch to Chrome\./);
  assert.match(await signInFrom(UA.androidFirefox), /switch to Firefox\./);
});

test("a computer's browser gets no hint, because it signs itself in", async () => {
  for (const ua of [UA.macChrome, UA.windowsEdge, undefined, ""]) {
    assert.doesNotMatch(await signInFrom(ua), /To go back/, String(ua).slice(0, 30));
  }
});

test("the hint sits with the success line and above the sign-in context", async () => {
  const text = await signInFrom(UA.iphoneSafari);
  const [first, hint, blank, context] = text.split("\n");
  assert.match(first, /signed in/i);
  assert.match(hint, /^↩ /);
  assert.equal(blank, "");
  assert.match(context, /^Signed in to: https:\/\/cockpit\.example · Safari on iOS/);
});

test("the hint can be switched off, and does not depend on the client context being shown", async () => {
  assert.doesNotMatch(await signInFrom(UA.iphoneSafari, { showReturnHint: false }), /To go back/);
  const withoutContext = await signInFrom(UA.iphoneSafari, { showClientContext: false });
  assert.match(withoutContext, /To go back/);
  assert.doesNotMatch(withoutContext, /Signed in to:/);
});

test("a refusal gets no hint: there is nothing to go back to", async () => {
  const { auth, telegram } = setup();
  const handle = createStartHandler(auth);
  const { token } = await auth.beginLogin({ request: makeRequest("https://cockpit.example/", { headers: { "User-Agent": UA.iphoneSafari } }) });
  await handle(messageUpdate(`/start cockpit_${token}`, MALLORY));
  assert.doesNotMatch(telegram.calls.find((call) => call.method === "sendMessage").payload.text, /To go back/);
});

test("a sign-in that recorded no client has no hint to give", async () => {
  const { auth, telegram } = setup({ captureClient: false });
  const handle = createStartHandler(auth);
  const { token } = await auth.beginLogin({ request: makeRequest("https://cockpit.example/", { headers: { "User-Agent": UA.iphoneSafari } }) });
  await handle(messageUpdate(`/start cockpit_${token}`));
  assert.doesNotMatch(telegram.calls.find((call) => call.method === "sendMessage").payload.text, /To go back/);
});

test("the sign-in context now names iOS builds of Chrome and Firefox correctly", async () => {
  assert.match(await signInFrom(UA.iphoneChrome), /Signed in to: .*Chrome on iOS/);
  assert.match(await signInFrom(UA.iphoneFirefox), /Firefox on iOS/);
});

test("the sign-in context names the platform correctly for phones, tablets and computers", async () => {
  const cases = [
    [UA.iphoneSafari, "Safari on iOS"],
    [UA.ipadEdge, "Edge on iOS"],
    [UA.androidChrome, "Chrome on Android"],
    [UA.androidFirefox, "Firefox on Android"],
    [UA.macChrome, "Chrome on macOS"],
    [UA.windowsEdge, "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0", "Firefox on Linux"],
  ];
  for (const [ua, expected] of cases) assert.match(await signInFrom(ua), new RegExp(`Signed in to: https://cockpit\\.example · ${expected}`), expected);
});
