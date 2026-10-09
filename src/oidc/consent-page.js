// The consent screen.
//
// This is the one place the "zero user input" promise is deliberately broken, and it is worth
// being clear why. Among your own apps, consent is theatre: you already know the answer, and
// `first_party: true` skips it. The moment a third party can send users at your provider, skipping
// it means any client that talks someone into scanning a QR silently collects their identity —
// the user never learns which app asked or what it got. One tap is the honest price.
//
// It also happens to be the strongest anti-phishing control the flow has. The screen names the
// client and shows the callback host, so a user who scanned a QR expecting their own dashboard is
// told, before anything is issued, that "Totally Legit Analytics" is about to receive their
// identity.

import { DEFAULT_BRANDING, escapeHtml, nameScaleFor, pageHead, renderEndedPage, resolveSite, topBar } from "../login-page.js";

export const SCOPE_DESCRIPTIONS = {
  openid: "Confirm your identity",
  profile: "See your name and Telegram username",
  offline_access: "Stay signed in when you are not using the app",
};

/**
 * The consent screen, laid out as the same pass as the sign-in page: the app asking is the name on the
 * ticket, what it will receive is listed on it, and the two buttons are on the stub.
 *
 * @param {object} params
 * @param {object} params.client       The registered client.
 * @param {string[]} params.scopes     Scopes being requested.
 * @param {object} params.session      The signed-in user's claims.
 * @param {string} [params.redirectUri] The callback actually matched for this request — what the
 * user is shown. Falls back to the client's first registered URI only if omitted.
 * @param {string} params.requestId    Opaque id of the paused authorization request.
 * @param {string} params.csrfToken    Must come back with the form.
 * @param {string} params.actionPath   Where the form posts.
 * @param {object} [params.branding]   See DEFAULT_BRANDING in ../login-page.js.
 * @param {string} [params.fontsPath]  Where the bundled fonts are served from (`auth.paths.fonts`).
 * @param {{ name?: string, host?: string }} [params.site]  The provider itself, for the top bar: the
 *   host defaults to the one of `origin`, the name to `branding.siteName`.
 * @param {string} [params.origin]     The provider's own origin (its issuer).
 */
export function renderConsentPage({ client, scopes, session, redirectUri, requestId, csrfToken, actionPath, branding: overrides = {}, fontsPath, site, origin }) {
  const branding = { ...DEFAULT_BRANDING, ...overrides };
  const callbackHost = hostOf(redirectUri ?? client.redirect_uris[0]);
  const { host, name, letter } = resolveSite({ branding, site, origin });
  const text = (key) => escapeHtml(branding[key]);
  const clientName = String(client.client_name);

  const scopeItems = scopes
    .map((scope) => {
      const description = SCOPE_DESCRIPTIONS[scope] ?? scope;
      return `<li><span>${escapeHtml(description)}</span><code>${escapeHtml(scope)}</code></li>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
${pageHead({
  branding,
  fontsPath,
  title: `Authorize ${clientName}`,
  letter,
  css: `
  .tqa-foot > .tqa-foot-desk { display: inline !important; }
  /* The stub holds one form, not a QR beside a button: it never needs the sign-in page's tablet grid. */
  .tqa-stub { display: flex; flex-direction: column; align-items: stretch; padding: 24px 24px 26px; }
  .tqa-f-wide { grid-column: 1 / -1; }
  .tqa-field dd code { font: inherit; }
  .tqa-scopes { list-style: none; margin: 4px 0 0; padding: 0; }
  .tqa-scopes li { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 9px 0; border-top: 1.5px dashed var(--tqa-rule); font-weight: 600; font-size: 1rem; line-height: 1.3; letter-spacing: -0.01em; }
  .tqa-scopes li:first-child { border-top: 0; padding-top: 4px; }
  .tqa-scopes code { flex: none; font: 500 0.72rem/1.3 var(--tqa-mono); letter-spacing: 0.04em; color: var(--tqa-muted); }
  .tqa-warn { margin: 22px 0 0; padding: 12px 14px; border: 2px solid var(--tqa-ink); border-radius: 12px; font-weight: 600; font-size: 0.92rem; line-height: 1.45; }
  .tqa-decide { display: flex; flex-direction: column; gap: 12px; width: 100%; margin: 0; }
  .tqa-ghost {
    display: flex; align-items: center; justify-content: center; width: 100%; min-height: 54px; padding: 0 20px; border: 2px solid var(--tqa-ink); border-radius: 16px;
    background: transparent; color: var(--tqa-ink); cursor: pointer; font: 600 1.1rem/1.2 var(--tqa-font); letter-spacing: -0.01em; transition: background 0.15s ease;
  }
  .tqa-ghost:hover { background: color-mix(in srgb, var(--tqa-ink) 7%, transparent); }
  @media (min-width: 640px) and (max-width: 899.98px) { .tqa-stub { padding-left: 36px; padding-right: 36px; } .tqa-decide { flex-direction: row-reverse; } .tqa-decide > * { flex: 1; } }
  @media (min-width: 900px) { .tqa-stub { padding: 28px 22px; } }
`,
})}
</head>
<body>
  <div class="tqa-page">
    ${topBar({ branding, name, letter, host })}
    <main class="tqa-stage">
      <h1 class="tqa-headline">
        <span class="tqa-hl">${text("consentHeading")}</span>
        <span class="tqa-hl">${escapeHtml(branding.consentSubheading).replace("{name}", escapeHtml(clientName))}</span>
      </h1>
      <div class="tqa-ticket">
        <section class="tqa-main">
          <div class="tqa-kicker"><span>${text("consentKickerText")}</span><span>${text("viaText")}</span></div>
          <p class="tqa-name" style="--tqa-name-scale: ${nameScaleFor(clientName)}">${escapeHtml(clientName)}</p>
          <dl class="tqa-fields">
            <div class="tqa-field tqa-f-wide"><dt>${text("returnsLabel")}</dt><dd><code>${escapeHtml(callbackHost)}</code></dd></div>
            <div class="tqa-field tqa-f-wide"><dt>${text("signedInAsLabel")}</dt><dd>${escapeHtml(session.name)}</dd></div>
            <div class="tqa-field tqa-f-wide"><dt>${text("accessLabel")}</dt><dd><ul class="tqa-scopes">${scopeItems}</ul></dd></div>
          </dl>
          <p class="tqa-warn">${text("consentWarnText")}</p>
        </section>
        <aside class="tqa-stub">
          <form class="tqa-decide" method="POST" action="${escapeHtml(actionPath)}">
            <input type="hidden" name="request_id" value="${escapeHtml(requestId)}">
            <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
            <button class="tqa-open tqa-allow" type="submit" name="decision" value="allow">${text("allowText")}</button>
            <button class="tqa-ghost tqa-deny" type="submit" name="decision" value="deny">${text("denyText")}</button>
          </form>
        </aside>
      </div>
    </main>
    <footer class="tqa-foot"><span class="tqa-foot-desk">${text("consentFootText")}</span></footer>
  </div>
</body>
</html>`;
}

/**
 * A minimal error page for failures that must NOT be redirected back to the client. It wears the same
 * pass as the rest, but says nothing about which client asked.
 *
 * @param {string} error        The OAuth error code.
 * @param {string} description  What to tell the person.
 * @param {object} [options]    `{ branding, fontsPath, site, origin }`, as for the consent page.
 */
export function renderErrorPage(error, description, { branding: overrides = {}, fontsPath, site, origin } = {}) {
  const branding = { ...DEFAULT_BRANDING, ...overrides };
  return renderEndedPage({
    branding,
    fontsPath,
    site,
    origin,
    title: branding.errorHeading,
    pageTitle: "Sign-in error",
    text: description,
    extraHtml: `<p class="tqa-ended-code">${escapeHtml(branding.errorCodeLabel)}: <code>${escapeHtml(error)}</code></p>
          <p class="tqa-ended-note">${escapeHtml(branding.errorNoteText)}</p>`,
  });
}

function hostOf(uri) {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}
