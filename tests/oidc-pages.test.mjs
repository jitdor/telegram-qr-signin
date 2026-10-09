// The consent screen and the error page wear the same pass as the sign-in page.

import test from "node:test";
import assert from "node:assert/strict";

import { renderConsentPage, renderErrorPage } from "../src/oidc/consent-page.js";
import { createTelegramQrAuth } from "../src/provider.js";
import { MemoryLoginStore } from "../src/stores/memory.js";
import { allowlist } from "../src/gates.js";
import { createOidcProvider } from "../src/oidc/provider.js";
import { generateSigningKey, loadSigningKeys } from "../src/oidc/keys.js";
import { StaticClientRegistry } from "../src/oidc/clients.js";
import { MemoryOidcStore } from "../src/oidc/store.js";
import { createPkcePair } from "../src/oidc/pkce.js";
import { makeFakeTelegram, makeRequest, cookieFrom, ALICE } from "./helpers.mjs";

const CLIENT = { client_name: "Totally Legit Analytics", redirect_uris: ["https://analytics.example.org/callback"] };
const PAGE = { client: CLIENT, scopes: ["openid", "profile"], session: { name: "Alice Ng" }, requestId: "req-1", csrfToken: "csrf-1", actionPath: "/consent" };

test("the consent screen is the app's pass: its name, where it returns to, who is signed in, and what it receives", () => {
  const html = renderConsentPage({ ...PAGE, origin: "https://courier.jitdor.com" });
  assert.match(html, /<title>Authorize Totally Legit Analytics<\/title>/);
  assert.match(html, /<p class="tqa-name"[^>]*>Totally Legit Analytics<\/p>/);
  assert.match(html, /<dt>Returns to<\/dt><dd><code>analytics\.example\.org<\/code><\/dd>/);
  assert.match(html, /<dt>Signed in as<\/dt><dd>Alice Ng<\/dd>/);
  assert.match(html, /<li><span>Confirm your identity<\/span><code>openid<\/code><\/li>/);
  assert.match(html, /<li><span>See your name and Telegram username<\/span><code>profile<\/code><\/li>/);
  assert.match(html, /This app is not operated by us\. Authorize it only if you started this sign-in yourself\./);
  assert.match(html, /You can withdraw this at any time\. Withdrawing also signs the app out\./);
});

test("the consent form still carries everything the provider checks", () => {
  const html = renderConsentPage({ ...PAGE, requestId: 'r"1', csrfToken: "c<1" });
  assert.match(html, /<form class="tqa-decide" method="POST" action="\/consent">/);
  assert.match(html, /<input type="hidden" name="request_id" value="r&quot;1">/);
  assert.match(html, /<input type="hidden" name="csrf" value="c&lt;1">/);
  assert.match(html, /<button class="tqa-ghost tqa-deny" type="submit" name="decision" value="deny">Cancel<\/button>/);
  assert.match(html, /<button class="tqa-open tqa-allow" type="submit" name="decision" value="allow">Authorize<\/button>/);
  assert.equal((html.match(/<form\b/g) ?? []).length, 1);
});

test("the top bar names the provider and shows its address; the client is never mistaken for it", () => {
  const html = renderConsentPage({ ...PAGE, origin: "https://courier.jitdor.com" });
  assert.match(html, /<span class="tqa-brand-name">Courier<\/span>/);
  assert.match(html, /<span class="tqa-host">courier\.jitdor\.com<\/span>/);
  assert.match(html, /<span class="tqa-mark" aria-hidden="true">C<\/span>/);
  const named = renderConsentPage({ ...PAGE, origin: "https://courier.jitdor.com", branding: { siteName: "Acme ID" } });
  assert.match(named, /<span class="tqa-brand-name">Acme ID<\/span>/);
});

test("everything a client or user controls is escaped on the consent screen", () => {
  const evil = `<img src=x onerror=alert(1)>"`;
  const html = renderConsentPage({
    ...PAGE,
    client: { client_name: evil, redirect_uris: [`https://${"a"}.example/cb`] },
    session: { name: evil },
    scopes: [evil],
    branding: { consentSubheading: `Let {name} in <b>?` },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>\?/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;/);
});

test("the consent screen can be reworded and recoloured, and uses the bundled fonts when told where they are", () => {
  const html = renderConsentPage({ ...PAGE, fontsPath: "/auth/fonts", branding: { accent: "#0e1a2f", consentHeading: "Une dernière vérification.", allowText: "Autoriser", denyText: "Annuler", returnsLabel: "Retour vers" } });
  assert.match(html, /--tqa-accent: #0e1a2f;/);
  assert.match(html, /--tqa-on: #ffffff;/);
  for (const text of ["Une dernière vérification.", ">Autoriser<", ">Annuler<", "<dt>Retour vers</dt>"]) assert.ok(html.includes(text), text);
  assert.equal(fontUrls(html).length, 3);
  assert.doesNotMatch(renderConsentPage(PAGE), /@font-face/, "no fontsPath, no fonts");
  assert.doesNotMatch(html.replace(/url\("data:[^"]*"\)/g, "").replace(/<link rel="icon" href="data:[^"]*">/, ""), /https?:\/\//, "nothing external");
});

test("a long app name shrinks to fit the ticket", () => {
  assert.match(renderConsentPage(PAGE), /--tqa-name-scale: 0\.\d\d"/);
  assert.match(renderConsentPage({ ...PAGE, client: { ...CLIENT, client_name: "App" } }), /--tqa-name-scale: 1"/);
});

test("the error page is a pass that says what happened, with the code and the reassurance", () => {
  const html = renderErrorPage("invalid_request", "This sign-in expired. Start again from the app.", { origin: "https://courier.jitdor.com", fontsPath: "/auth/fonts" });
  assert.match(html, /<title>Sign-in error<\/title>/);
  assert.match(html, /<h1 class="tqa-ended-title">Sign-in could not continue<\/h1>/);
  assert.match(html, /<p class="tqa-ended-text">This sign-in expired\. Start again from the app\.<\/p>/);
  assert.match(html, /Error code: <code>invalid_request<\/code>/);
  assert.match(html, /Nothing was shared with the application that sent you here\./);
  assert.match(html, /<span class="tqa-host">courier\.jitdor\.com<\/span>/);
  assert.equal(fontUrls(html).length, 3);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
});

test("the error page escapes what it is given and works with no options at all", () => {
  const evil = `<script>alert(1)</script>`;
  const html = renderErrorPage(evil, evil);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<p class="tqa-site"/, "nothing to say about the site");
});

// --- Through the provider ---------------------------------------------------------------------------

const ISSUER = "https://auth.example.com";
const REDIRECT = "https://app-a.example.com/callback";
const fontUrls = (html) => [...html.matchAll(/url\("(\/[^"]+\.woff2)"\)/g)].map((m) => m[1]);

async function setup(branding) {
  const auth = createTelegramQrAuth({
    botToken: "123:TEST",
    botUsername: "example_bot",
    store: new MemoryLoginStore(),
    namespace: "idp",
    telegram: makeFakeTelegram({ members: [ALICE.id] }),
    authorize: allowlist([ALICE.id]),
    claims: () => ({ auth_time: Math.floor(Date.now() / 1000) }),
  });
  const oidc = createOidcProvider({
    auth,
    issuer: ISSUER,
    keys: await loadSigningKeys(await generateSigningKey()),
    clients: new StaticClientRegistry([{ client_id: "app-a", client_name: "App A", redirect_uris: [REDIRECT], scopes: ["openid", "profile"] }]),
    store: new MemoryOidcStore(),
    branding,
  });
  return { auth, oidc };
}

async function signedInCookie(auth) {
  const { token } = await auth.beginLogin();
  await auth.handleStart({ text: `/start idp_${token}`, from: ALICE });
  return `${auth.cookieName}=${cookieFrom(await auth.poll(makeRequest(`${ISSUER}/auth/poll?token=${token}`)), auth.cookieName)}`;
}

test("through the provider, the consent screen names the provider's own address and serves the fonts from the same app", async () => {
  const { auth, oidc } = await setup({ siteName: "Auth Hub" });
  const cookie = await signedInCookie(auth);
  const { challenge } = await createPkcePair();
  const url = `${ISSUER}/authorize?response_type=code&client_id=app-a&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=openid%20profile&state=s&code_challenge=${challenge}&code_challenge_method=S256`;
  const response = await oidc.handle(makeRequest(url, { cookie }));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<p class="tqa-name"[^>]*>App A<\/p>/);
  assert.match(html, /<span class="tqa-brand-name">Auth Hub<\/span>/);
  assert.match(html, /<span class="tqa-host">auth\.example\.com<\/span>/);
  const fonts = fontUrls(html);
  assert.equal(fonts.length, 3);
  assert.ok(fonts.every((f) => f.startsWith(`${auth.paths.fonts}/`)));
  assert.equal((await oidc.handle(makeRequest(`${ISSUER}${fonts[0]}`))).status, 200, "the provider hands font requests on to the sign-in handler");
});

test("through the provider, an error page wears the pass too", async () => {
  const { auth, oidc } = await setup({});
  const response = await oidc.handle(makeRequest(`${ISSUER}/authorize?response_type=code&client_id=nobody&redirect_uri=${encodeURIComponent(REDIRECT)}`));
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.match(html, /That application is not registered with us\./);
  assert.match(html, /Error code: <code>invalid_client<\/code>/);
  assert.equal(fontUrls(html).length, 3);
  assert.ok(fontUrls(html)[0].startsWith(`${auth.paths.fonts}/`));
});
