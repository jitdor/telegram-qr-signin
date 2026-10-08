// The default sign-in page: a QR, a status line, and a way in for people who cannot scan.
//
// The QR image encodes an https link — the t.me deep link, or with `qrOrigin` set an address on
// that domain which redirects to it — because that is what a phone camera can open. Clicking the
// QR (on a computer) and the "Open Telegram" button (on a phone or tablet) use the tg:// app link
// instead, which goes straight to the installed Telegram app rather than through a t.me web page,
// an "Open in Telegram?" prompt and a leftover browser tab. Opening an app link does not navigate
// this page away, so it stays put and keeps polling. No framework, no bundler, no external
// requests — it is one self-contained HTML string, which is what lets a consuming app be a single
// file with no build step.
//
// Replace it wholesale by passing `renderLoginPage` to createTelegramQrAuth; restyle it by passing
// `branding`. A replacement can reuse the polling script via `pollScript()` and supply only the
// markup — see POLL_STATUSES in provider.js for the contract it implements.

export const DEFAULT_BRANDING = {
  title: "Sign in",
  heading: "Sign in with Telegram",
  subtitle: "Scan the code with the Telegram app on your phone. No phone number, no code to type. If Telegram shows a Start button, tap it.",
  mobileSubtitle: "Telegram opens. If you see a Start button, tap it, then come back to this tab.",
  orScanText: "or scan from another phone",
  qrHintText: "Telegram on this computer? Click the code.",
  qrLinkTitle: "Open Telegram to sign in",
  waitingText: "Waiting for Telegram…",
  successText: "Signed in. Loading…",
  expiredText: "This sign-in code expired.",
  deniedText: "Your Telegram account isn't allowed to sign in here.",
  retryText: "Get a new code",
  mobileLinkText: "Open Telegram",
  stepsLabel: "How it works",
  stepOneText: "Open Telegram",
  stepTwoText: "Approve in the chat",
  stepThreeText: "You're in",
  scanEndedHeading: "This sign-in code has ended",
  scanEndedText: "It expired or was already used. Go back to the sign-in page on your computer for a new code.",
  accent: "#2aabee",
  background: "#0e1a2f",
  gradientFrom: "#2aabee",
  gradientTo: "#8b5cf6",
  qrDark: "#0f172a",
  qrLight: "#ffffff",
  logoHtml: "",
  footerHtml: "",
  headHtml: "",
};

// Telegram's paper plane, drawn inline so the page makes no external requests.
const PLANE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21.4 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.8 5.6c.3.9 1.4 1.1 2 .4l2.6-2.7 4.8 3.5c.8.6 1.9.1 2.1-.9l3-15.1c.2-1.1-.8-2-1.9-1.6Zm-3.6 4.1-8.5 7.6-.4 3.4-1.2-4 9.6-6.9c.4-.3.9.2.5.6Z"/></svg>`;

// Small glyphs, used as CSS masks so they take the colour of the text around them and need no
// markup (which keeps the page's structure, and anything a test or a custom stylesheet relies on,
// exactly as it was). A data: URI is not a network request.
const mask = (paths) =>
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.3' stroke-linecap='round' stroke-linejoin='round'%3E${paths}%3C/svg%3E")`;
const MASK_LOCK = mask("%3Crect x='4.5' y='11' width='15' height='10' rx='2.5'/%3E%3Cpath d='M8 11V8a4 4 0 0 1 8 0v3'/%3E");
const MASK_ALERT = mask("%3Ccircle cx='12' cy='12' r='9'/%3E%3Cpath d='M12 7.5v5.5M12 16.6v.1'/%3E");

/**
 * A tab icon in the page's brand colours, unless the app already supplies one in `headHtml`. An
 * inline data: URI, so the browser does not go looking for /favicon.ico.
 */
function faviconLink(branding) {
  if (/rel\s*=\s*["']?(?:shortcut\s+)?icon/i.test(branding.headHtml)) return "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${branding.gradientFrom}"/><stop offset="1" stop-color="${branding.gradientTo}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><g transform="translate(14 14) scale(1.5)"><path fill="#fff" d="M21.4 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.8 5.6c.3.9 1.4 1.1 2 .4l2.6-2.7 4.8 3.5c.8.6 1.9.1 2.1-.9l3-15.1c.2-1.1-.8-2-1.9-1.6Zm-3.6 4.1-8.5 7.6-.4 3.4-1.2-4 9.6-6.9c.4-.3.9.2.5.6Z"/></g></svg>`;
  return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}">`;
}

/**
 * The sign-in page's stylesheet. The default look follows the visitor's light or dark setting; an
 * app that sets its own `branding.background` keeps a light card on that background instead, since
 * a dark card could not promise to stay readable on a colour it did not choose.
 */
function loginStyles(branding, themed) {
  return `
  :root {
    color-scheme: ${themed ? "light dark" : "light"};
    --tqa-accent: ${branding.accent};
    --tqa-a: ${branding.gradientFrom};
    --tqa-b: ${branding.gradientTo};
    --tqa-grad: linear-gradient(135deg, var(--tqa-a), var(--tqa-b));
    /* Where white text sits on the brand colours (the mark, the buttons, the ticks) they are darkened a
       little, because Telegram's own blue is too light to carry white text legibly. The vivid pair above
       is for glows and lines, which carry no text. */
    --tqa-grad-ink: linear-gradient(135deg, color-mix(in srgb, var(--tqa-a) 72%, #000), color-mix(in srgb, var(--tqa-b) 82%, #000));
    --tqa-bg: ${themed ? "#e8edf6" : branding.background};
    --tqa-card: #ffffff;
    --tqa-edge: rgba(15, 23, 42, 0.07);
    --tqa-ink: #0f172a;
    --tqa-muted: #566175;
    --tqa-rule: #e4e9f1;
    --tqa-tile: #f3f6fb;
    --tqa-ok: #166534;
    --tqa-bad: #b42318;
    --tqa-grid: rgba(70, 90, 130, 0.09);
    --tqa-shadow: 0 1px 0 rgba(255, 255, 255, 0.8) inset, 0 34px 70px -30px rgba(15, 23, 42, 0.5), 0 10px 26px -14px rgba(15, 23, 42, 0.25);
    --tqa-font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --tqa-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
${
  themed
    ? `  @media (prefers-color-scheme: dark) {
    :root {
      --tqa-bg: ${branding.background};
      --tqa-card: rgba(20, 29, 49, 0.74);
      --tqa-edge: rgba(255, 255, 255, 0.1);
      --tqa-ink: #f2f6fc;
      --tqa-muted: #9eabc1;
      --tqa-rule: rgba(255, 255, 255, 0.1);
      --tqa-tile: rgba(255, 255, 255, 0.055);
      --tqa-ok: #4ade80;
      --tqa-bad: #fca5a5;
      --tqa-grid: rgba(255, 255, 255, 0.045);
      --tqa-shadow: 0 1px 0 rgba(255, 255, 255, 0.07) inset, 0 44px 90px -34px rgba(0, 0, 0, 0.8);
    }
    .tqa-card { -webkit-backdrop-filter: blur(22px) saturate(1.5); backdrop-filter: blur(22px) saturate(1.5); }
  }
`
    : ""
}  *, *::before, *::after { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; overflow-x: hidden;
    padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
    background: var(--tqa-bg); color: var(--tqa-ink);
    font: 16px/1.5 var(--tqa-font); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  /* Two soft glows in the brand colours, and a faint grid fading out from the card: depth without noise. */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    background:
      radial-gradient(60% 55% at 85% 8%, color-mix(in srgb, var(--tqa-a) 30%, transparent), transparent 70%),
      radial-gradient(55% 50% at 6% 100%, color-mix(in srgb, var(--tqa-b) 26%, transparent), transparent 70%);
  }
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    background-image: linear-gradient(var(--tqa-grid) 1px, transparent 1px), linear-gradient(90deg, var(--tqa-grid) 1px, transparent 1px);
    background-size: 46px 46px;
    -webkit-mask-image: radial-gradient(ellipse 70% 60% at 50% 45%, #000 0%, transparent 75%);
    mask-image: radial-gradient(ellipse 70% 60% at 50% 45%, #000 0%, transparent 75%);
  }
  .tqa-card {
    position: relative; z-index: 1; width: 100%; max-width: 25rem; padding: 30px 26px 24px;
    background: var(--tqa-card); border: 1px solid var(--tqa-edge); border-radius: 28px; box-shadow: var(--tqa-shadow);
    animation: tqa-rise 0.55s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  /* A thin line of the brand gradient along the top edge. */
  .tqa-card::before {
    content: ""; position: absolute; inset: 0 30px auto; height: 1px; opacity: 0.8;
    background: linear-gradient(90deg, transparent, var(--tqa-a), var(--tqa-b), transparent);
  }
  .tqa-head { display: flex; flex-direction: column; align-items: center; text-align: center; padding-bottom: 20px; margin-bottom: 22px; border-bottom: 1px solid var(--tqa-rule); }
  .tqa-mark {
    display: grid; place-items: center; width: 54px; height: 54px; margin-bottom: 16px; border-radius: 17px; color: #fff;
    background: var(--tqa-grad-ink); font-weight: 700; font-size: 1.4rem; line-height: 1; letter-spacing: -0.02em;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.35) inset, 0 14px 28px -12px var(--tqa-a);
  }
  .tqa-mark svg { width: 26px; height: 26px; fill: currentColor; }
  .tqa-head h1 { margin: 0; font-size: 1.5rem; line-height: 1.18; font-weight: 700; letter-spacing: -0.028em; text-wrap: balance; }
  .tqa-site {
    display: flex; align-items: center; gap: 7px; width: fit-content; max-width: 100%; margin: 12px 0 0; padding: 5px 12px 5px 10px;
    border: 1px solid var(--tqa-rule); border-radius: 999px; background: var(--tqa-tile); color: var(--tqa-muted);
    font: 600 0.78rem/1.3 var(--tqa-mono); overflow-wrap: anywhere;
  }
  .tqa-site::before {
    content: ""; flex: none; width: 13px; height: 13px; background: var(--tqa-ok);
    -webkit-mask: ${MASK_LOCK} center / contain no-repeat; mask: ${MASK_LOCK} center / contain no-repeat;
  }
  .tqa-sub { margin: 14px 0 0; color: var(--tqa-muted); font-size: 0.92rem; text-wrap: balance; }
  .tqa-error {
    position: relative; margin: 0 0 18px; padding: 12px 14px 12px 42px; border-radius: 14px; font-size: 0.88rem; color: var(--tqa-bad);
    background: color-mix(in srgb, var(--tqa-bad) 11%, transparent); border: 1px solid color-mix(in srgb, var(--tqa-bad) 28%, transparent);
  }
  .tqa-error::before {
    content: ""; position: absolute; left: 14px; top: 13px; width: 18px; height: 18px; background: currentColor;
    -webkit-mask: ${MASK_ALERT} center / contain no-repeat; mask: ${MASK_ALERT} center / contain no-repeat;
  }
  .tqa-open, .tqa-retry {
    display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 56px; padding: 0 22px;
    border: 0; border-radius: 18px; color: #fff; background: var(--tqa-grad-ink); cursor: pointer; text-decoration: none;
    font: 600 1.05rem/1.2 var(--tqa-font); letter-spacing: -0.005em;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.35) inset, 0 16px 30px -14px var(--tqa-a);
    transition: transform 0.15s ease, filter 0.15s ease, box-shadow 0.15s ease;
  }
  .tqa-open:hover, .tqa-retry:hover { filter: brightness(1.06) saturate(1.05); }
  .tqa-open:active, .tqa-retry:active { transform: scale(0.985); }
  .tqa-open svg { width: 21px; height: 21px; fill: currentColor; flex: none; }
  .tqa-how { margin: 14px 0 0; color: var(--tqa-muted); font-size: 0.86rem; text-align: center; text-wrap: balance; }
  .tqa-or { align-items: center; gap: 14px; margin: 24px 0 18px; color: var(--tqa-muted); font-size: 0.72rem; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase; }
  .tqa-or::before, .tqa-or::after { content: ""; flex: 1; height: 1px; background: var(--tqa-rule); }
  .tqa-qr { display: flex; justify-content: center; }
  /* The code sits on a white tile whatever the theme, because a QR needs a light quiet zone. The
     corner brackets and the sweeping line say "point a camera here" without being an animation
     anyone has to watch. */
  .tqa-qr-link {
    position: relative; display: block; line-height: 0; padding: 18px; border-radius: 24px; background: #fff;
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.08), 0 20px 44px -22px rgba(15, 23, 42, 0.6);
    transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.3s ease, filter 0.3s ease;
  }
  .tqa-qr-link:hover { transform: translateY(-2px); box-shadow: 0 0 0 1px color-mix(in srgb, var(--tqa-accent) 55%, transparent), 0 26px 50px -22px color-mix(in srgb, var(--tqa-accent) 70%, #000); }
  .tqa-qr-link::before {
    content: ""; position: absolute; inset: 7px; pointer-events: none; border-radius: 4px;
    --c: var(--tqa-accent);
    background:
      linear-gradient(var(--c), var(--c)) top left / 20px 3px no-repeat, linear-gradient(var(--c), var(--c)) top left / 3px 20px no-repeat,
      linear-gradient(var(--c), var(--c)) top right / 20px 3px no-repeat, linear-gradient(var(--c), var(--c)) top right / 3px 20px no-repeat,
      linear-gradient(var(--c), var(--c)) bottom left / 20px 3px no-repeat, linear-gradient(var(--c), var(--c)) bottom left / 3px 20px no-repeat,
      linear-gradient(var(--c), var(--c)) bottom right / 20px 3px no-repeat, linear-gradient(var(--c), var(--c)) bottom right / 3px 20px no-repeat;
  }
  .tqa-qr-link::after {
    content: ""; position: absolute; left: 16px; right: 16px; top: 16px; height: 2px; border-radius: 2px; pointer-events: none; opacity: 0;
    background: linear-gradient(90deg, transparent, var(--tqa-accent), transparent);
    box-shadow: 0 0 16px 3px color-mix(in srgb, var(--tqa-accent) 55%, transparent);
    animation: tqa-sweep 3.2s ease-in-out infinite;
  }
  .tqa-qr svg { width: 13.5rem; max-width: 100%; height: auto; display: block; }
  .tqa-hint { margin: 16px 0 0; color: var(--tqa-muted); font-size: 0.82rem; text-align: center; }
  .tqa-steps {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 22px 0 0; padding: 18px 0 0; list-style: none;
    border-top: 1px solid var(--tqa-rule); counter-reset: tqa-step; transition: opacity 0.3s ease;
  }
  .tqa-steps li { position: relative; display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; color: var(--tqa-muted); font-size: 0.75rem; font-weight: 600; line-height: 1.25; }
  .tqa-steps li::before {
    counter-increment: tqa-step; content: counter(tqa-step); display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%;
    font-size: 0.74rem; font-weight: 700; color: var(--tqa-muted); background: var(--tqa-tile); border: 1px solid var(--tqa-rule);
    transition: background 0.3s ease, color 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
  }
  .tqa-steps li:not(:last-child)::after { content: ""; position: absolute; top: 13px; left: calc(50% + 20px); right: calc(-50% + 20px); height: 1px; background: var(--tqa-rule); }
  [data-tqa-state="waiting"] .tqa-steps li:nth-child(-n + 2) { color: var(--tqa-ink); }
  [data-tqa-state="waiting"] .tqa-steps li:nth-child(-n + 2)::before { color: var(--tqa-ink); border-color: color-mix(in srgb, var(--tqa-accent) 55%, transparent); background: color-mix(in srgb, var(--tqa-accent) 10%, transparent); }
  [data-tqa-state="signed-in"] .tqa-steps li { color: var(--tqa-ink); }
  [data-tqa-state="signed-in"] .tqa-steps li::before { content: "✓"; color: #fff; border-color: transparent; background: var(--tqa-grad-ink); box-shadow: 0 8px 16px -8px var(--tqa-a); }
  [data-tqa-state="expired"] .tqa-steps, [data-tqa-state="denied"] .tqa-steps { opacity: 0.4; }
  .tqa-status {
    display: flex; align-items: center; justify-content: center; gap: 9px; width: fit-content; max-width: 100%; min-height: 36px; margin: 20px auto 0; padding: 7px 16px;
    border: 1px solid var(--tqa-rule); border-radius: 20px; text-wrap: balance; background: var(--tqa-tile); color: var(--tqa-muted); font-size: 0.85rem; font-weight: 500; text-align: center;
    transition: background 0.3s ease, color 0.3s ease, border-color 0.3s ease;
  }
  .tqa-status::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--tqa-accent); animation: tqa-pulse 1.6s ease-in-out infinite; }
  [data-tqa-state="signed-in"] .tqa-status { color: var(--tqa-ok); border-color: color-mix(in srgb, var(--tqa-ok) 35%, transparent); background: color-mix(in srgb, var(--tqa-ok) 10%, transparent); }
  [data-tqa-state="signed-in"] .tqa-status::before { background: var(--tqa-ok); animation: none; }
  [data-tqa-state="expired"] .tqa-status, [data-tqa-state="denied"] .tqa-status { color: var(--tqa-bad); border-color: color-mix(in srgb, var(--tqa-bad) 32%, transparent); background: color-mix(in srgb, var(--tqa-bad) 9%, transparent); }
  [data-tqa-state="expired"] .tqa-status::before, [data-tqa-state="denied"] .tqa-status::before { background: var(--tqa-bad); animation: none; }
  [data-tqa-state="signed-in"] .tqa-qr-link { opacity: 0.3; filter: grayscale(0.7) blur(1px); }
  [data-tqa-state="signed-in"] .tqa-qr-link::after, [data-tqa-state="denied"] .tqa-qr-link::after { animation: none; opacity: 0; }
  .tqa-foot { margin: 18px 0 0; color: var(--tqa-muted); font-size: 0.75rem; text-align: center; }
  a:focus-visible, button:focus-visible { outline: 3px solid color-mix(in srgb, var(--tqa-accent) 75%, transparent); outline-offset: 3px; }
  [hidden] { display: none !important; }
  @keyframes tqa-rise { from { opacity: 0; transform: translateY(14px) scale(0.985); } to { opacity: 1; transform: none; } }
  @keyframes tqa-pulse { 50% { opacity: 0.25; } }
  @keyframes tqa-sweep { 0% { top: 16px; opacity: 0; } 14% { opacity: 0.95; } 50% { top: calc(100% - 18px); opacity: 0.95; } 64% { opacity: 0; } 100% { top: 16px; opacity: 0; } }
  /* Phones and tablets can't scan their own screen: lead with the button, keep the QR for a second device. */
  .tqa-touch-only { display: none; }
  @media (hover: none) and (pointer: coarse) {
    .tqa-touch-only { display: block; }
    .tqa-open.tqa-touch-only, .tqa-or.tqa-touch-only { display: flex; }
    .tqa-pointer-only { display: none; }
    .tqa-qr svg { width: 10.5rem; }
    .tqa-qr-link { padding: 14px; }
    .tqa-qr-link:hover { transform: none; }
  }
  @media (max-width: 380px) { .tqa-card { padding: 26px 20px 20px; border-radius: 24px; } .tqa-head h1 { font-size: 1.35rem; } }
  @media (prefers-reduced-motion: reduce) {
    .tqa-card, .tqa-qr-link::after, .tqa-status::before { animation: none; }
    .tqa-qr-link::after { opacity: 0; }
    .tqa-open, .tqa-retry, .tqa-qr-link, .tqa-steps, .tqa-steps li::before, .tqa-status { transition: none; }
    .tqa-open:active, .tqa-retry:active, .tqa-qr-link:hover { transform: none; }
  }
`;
}

/**
 * @param {object} params
 * @param {string} params.token       The pending login token, handed to the polling script.
 * @param {string} params.deepLink    https://t.me/<bot>?start=<payload>.
 * @param {string} [params.appLink]   tg://resolve?domain=<bot>&start=<payload> — what the button
 *   and a click on the QR open. Derived from `deepLink` when omitted.
 * @param {string} [params.qrLink]    What `qrSvg` encodes: `deepLink`, or
 *   https://<qrOrigin>/auth/q/<token> when `qrOrigin` is set.
 * @param {string} params.qrSvg       Inline SVG markup from qr.js.
 * @param {string} [params.error]     Message to show above the QR (e.g. "you were removed").
 * @param {string} params.pollPath    Absolute path the page should poll.
 * @param {number} params.pollIntervalMs
 * @param {object} [params.branding]
 * @param {string} [params.redirectTo="/"]  Where to send the browser once signed in.
 * @param {string} [params.origin]    The origin this page is being served from, when the request is
 *   known. Informational: nothing here uses it unless a replacement renderer does.
 * @param {{ name?: string, host?: string }} [params.site]  Which site this is, for pages that say so.
 *   `host` is shown under the heading, as a chip. `name` replaces the default heading and title
 *   ("Sign in to <name>"), but never one the app has set itself through `branding`, and its initials
 *   mark the card. Supplied by the hub's createSiteAuth; a standalone app can pass it from a
 *   custom renderer.
 */
export function renderLoginPage(params) {
  const branding = { ...DEFAULT_BRANDING, ...(params.branding ?? {}) };
  const site = params.site ?? null;
  if (site?.name && params.branding?.heading === undefined) branding.heading = `Sign in to ${site.name}`;
  if (site?.name && params.branding?.title === undefined) branding.title = `Sign in to ${site.name}`;
  const { token, deepLink, qrSvg, error, pollPath, pollIntervalMs = 2000, redirectTo = "/" } = params;
  const appLink = escapeHtml(params.appLink ?? appLinkFromDeepLink(deepLink));
  const errorHtml = error ? `<p class="tqa-error" role="alert">${escapeHtml(error)}</p>` : "";

  // The mark above the heading: the app's own logo if it gave one, else the initials of the site's name
  // ("Internal docs" → "ID"), else Telegram's plane.
  const initials = site?.name
    ? String(site.name)
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
        .join("")
        .toUpperCase()
    : "";
  const markHtml = branding.logoHtml || `<span class="tqa-mark" aria-hidden="true">${initials ? escapeHtml(initials) : PLANE_ICON}</span>`;

  // With no `background` of its own the page follows the visitor's light/dark setting.
  const themed = params.branding?.background === undefined;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="${themed ? "light dark" : "light"}">
<title>${escapeHtml(branding.title)}</title>
${faviconLink(branding)}
${branding.headHtml}
<style>${loginStyles(branding, themed)}</style>
</head>
<body>
  <main class="tqa-card">
    <header class="tqa-head">
      ${markHtml}
      <h1>${escapeHtml(branding.heading)}</h1>
      ${site?.host ? `<p class="tqa-site">${escapeHtml(site.host)}</p>` : ""}
      <p class="tqa-sub tqa-pointer-only">${escapeHtml(branding.subtitle)}</p>
    </header>
    ${errorHtml}
    <a class="tqa-open tqa-touch-only" id="tqa-open" href="${appLink}">${PLANE_ICON}<span>${escapeHtml(branding.mobileLinkText)}</span></a>
    <p class="tqa-how tqa-touch-only" id="tqa-how">${escapeHtml(branding.mobileSubtitle)}</p>
    <p class="tqa-or tqa-touch-only" id="tqa-or">${escapeHtml(branding.orScanText)}</p>
    <div class="tqa-qr" id="tqa-qr"><a class="tqa-qr-link" href="${appLink}" title="${escapeHtml(branding.qrLinkTitle)}" aria-label="${escapeHtml(branding.qrLinkTitle)}">${qrSvg}</a></div>
    <p class="tqa-hint tqa-pointer-only" id="tqa-hint">${escapeHtml(branding.qrHintText)}</p>
    <ol class="tqa-steps" aria-label="${escapeHtml(branding.stepsLabel)}">
      <li>${escapeHtml(branding.stepOneText)}</li>
      <li>${escapeHtml(branding.stepTwoText)}</li>
      <li>${escapeHtml(branding.stepThreeText)}</li>
    </ol>
    <p class="tqa-status" id="tqa-status" role="status">${escapeHtml(branding.waitingText)}</p>
    ${branding.footerHtml ? `<p class="tqa-foot">${branding.footerHtml}</p>` : ""}
  </main>
<script>
${pollScript({
  token,
  pollPath,
  redirectTo,
  pollIntervalMs,
  texts: { success: branding.successText, expired: branding.expiredText, denied: branding.deniedText, retry: branding.retryText },
  ids: { status: "tqa-status", qr: "tqa-qr", hide: ["tqa-open", "tqa-how", "tqa-or", "tqa-hint"] },
})}
</script>
</body>
</html>`;
}

/**
 * What a phone shows when it opens /auth/q/<token> for a code that expired, was already used or
 * never existed. Takes the sign-in page's `branding`, and looks like the sign-in page it came from.
 */
export function renderScanEndedPage({ branding: overrides } = {}) {
  const branding = { ...DEFAULT_BRANDING, ...(overrides ?? {}) };
  const themed = overrides?.background === undefined;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="${themed ? "light dark" : "light"}">
<title>${escapeHtml(branding.title)}</title>
${faviconLink(branding)}
${branding.headHtml}
<style>${loginStyles(branding, themed)}
  .tqa-card { text-align: center; }
  .tqa-ended { display: grid; place-items: center; width: 54px; height: 54px; margin: 0 auto 16px; border-radius: 17px; color: var(--tqa-bad); background: color-mix(in srgb, var(--tqa-bad) 12%, transparent); border: 1px solid color-mix(in srgb, var(--tqa-bad) 28%, transparent); }
  .tqa-ended::before { content: ""; width: 26px; height: 26px; background: currentColor; -webkit-mask: ${MASK_ALERT} center / contain no-repeat; mask: ${MASK_ALERT} center / contain no-repeat; }
  .tqa-card h1 { margin: 0; font-size: 1.3rem; line-height: 1.25; letter-spacing: -0.025em; text-wrap: balance; }
  .tqa-card p { margin: 12px 0 0; color: var(--tqa-muted); font-size: 0.92rem; text-wrap: balance; }
</style>
</head>
<body>
  <main class="tqa-card">
    ${branding.logoHtml || `<span class="tqa-ended" aria-hidden="true"></span>`}
    <h1>${escapeHtml(branding.scanEndedHeading)}</h1>
    <p>${escapeHtml(branding.scanEndedText)}</p>
  </main>
</body>
</html>`;
}

/**
 * The tg:// app link for a t.me deep link: `https://t.me/<bot>?start=<payload>` becomes
 * `tg://resolve?domain=<bot>&start=<payload>`. Anything else is returned unchanged.
 */
export function appLinkFromDeepLink(deepLink) {
  let url;
  try {
    url = new URL(deepLink);
  } catch {
    return deepLink;
  }
  const domain = url.pathname.replace(/^\/+|\/+$/g, "");
  if (url.protocol !== "https:" || url.hostname !== "t.me" || !/^[A-Za-z0-9_]+$/.test(domain)) return deepLink;
  const start = url.searchParams.get("start");
  return `tg://resolve?domain=${domain}${start ? `&start=${encodeURIComponent(start)}` : ""}`;
}

export const DEFAULT_POLL_TEXTS = {
  success: DEFAULT_BRANDING.successText,
  expired: DEFAULT_BRANDING.expiredText,
  denied: DEFAULT_BRANDING.deniedText,
  retry: DEFAULT_BRANDING.retryText,
};

export const DEFAULT_POLL_IDS = {
  status: "tqa-status",
  qr: "tqa-qr",
  hide: ["tqa-open", "tqa-hint"],
};

/**
 * The sign-in page's polling script, as JavaScript source for a custom page to put in a
 * `<script>` element (add a CSP nonce there if you use one). It handles all of POLL_STATUSES, so a
 * custom page only supplies markup:
 *
 * - `ids.status`: element whose text shows progress. Optional.
 * - `ids.qr`: element whose contents are replaced by a "new QR code" button on expiry. Optional.
 * - `ids.hide`: elements hidden once the sign-in is over (links that would open a dead token).
 *
 * It also sets `data-tqa-state` on `<html>` to "waiting", "signed-in", "expired" or "denied", so a
 * page can style a status indicator in CSS alone.
 *
 * @param {object} params
 * @param {string} params.token
 * @param {string} params.pollPath
 * @param {string} [params.redirectTo="/"]
 * @param {number} [params.pollIntervalMs=2000]
 * @param {object} [params.texts]  `{ success, expired, denied, retry }`; see DEFAULT_POLL_TEXTS.
 * @param {object} [params.ids]    `{ status, qr, hide }`; see DEFAULT_POLL_IDS.
 */
export function pollScript({ token, pollPath, redirectTo = "/", pollIntervalMs = 2000, texts, ids } = {}) {
  const interval = Math.max(250, Number(pollIntervalMs) || 2000);
  const config = {
    token,
    pollPath,
    redirectTo,
    interval,
    texts: { ...DEFAULT_POLL_TEXTS, ...(texts ?? {}) },
    ids: { ...DEFAULT_POLL_IDS, ...(ids ?? {}) },
  };
  return `(function () {
  var cfg = ${scriptJson(config)};
  var text = cfg.texts;
  var statusEl = cfg.ids.status ? document.getElementById(cfg.ids.status) : null;
  var qrEl = cfg.ids.qr ? document.getElementById(cfg.ids.qr) : null;
  var root = document.documentElement;
  var stopped = false;
  var inFlight = false;
  var timer = null;

  function setState(state, message) {
    root.setAttribute("data-tqa-state", state);
    if (statusEl && message) statusEl.textContent = message;
  }

  // Once the sign-in is over (expired, denied) the links would open a dead or refused token.
  function hideOpenLinks() {
    (cfg.ids.hide || []).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
  }

  function showExpired() {
    stop();
    hideOpenLinks();
    setState("expired", text.expired);
    if (!qrEl) return;
    // Replacing the QR with the button rather than leaving a dead QR on screen: a stale QR that
    // still looks scannable is the single most confusing state this page can be in.
    qrEl.textContent = "";
    var button = document.createElement("button");
    button.type = "button";
    button.className = "tqa-retry";
    button.textContent = text.retry;
    button.addEventListener("click", function () { window.location.reload(); });
    qrEl.appendChild(button);
  }

  // One loop only: every path into poll() goes through here, and a poll already on the wire is
  // never doubled up by a timer or a visibility change.
  function schedule(delay) {
    clearTimeout(timer);
    timer = stopped ? null : setTimeout(poll, delay);
  }

  function poll() {
    clearTimeout(timer);
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    fetch(cfg.pollPath + "?token=" + encodeURIComponent(cfg.token), { credentials: "same-origin", cache: "no-store" })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        inFlight = false;
        var status = data && data.status;
        if (status === "confirmed") {
          stop();
          setState("signed-in", text.success);
          // Full navigation, not a fetch: the session cookie arrived on the poll response and the
          // app needs a fresh document request to render as the signed-in user.
          window.location.href = cfg.redirectTo;
          return;
        }
        if (status === "expired" || status === "invalid") { showExpired(); return; }
        if (status === "denied") {
          stop();
          hideOpenLinks();
          // data.reason is a machine code for logs and gates, not copy for a person to read.
          setState("denied", text.denied);
          return;
        }
        schedule(cfg.interval);
      })
      // A failed poll is usually a blip (sleeping laptop, flaky tunnel), so back off rather than
      // giving up — the token's own TTL is what ends this loop.
      .catch(function () {
        inFlight = false;
        schedule(cfg.interval + 1000);
      });
  }

  // Background tabs have their timers throttled, so coming back from Telegram could mean a long
  // wait for the next poll. Poll the moment the tab is visible again instead.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && !stopped && !inFlight) poll();
  });
  // Coming back can also restore the page from the back/forward cache, or just refocus the window,
  // without the tab ever having been hidden. Ask at once in those cases too.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pageshow", function (event) {
      if (event && event.persisted && !stopped && !inFlight) poll();
    });
    window.addEventListener("focus", function () {
      if (!stopped && !inFlight) poll();
    });
  }

  root.setAttribute("data-tqa-state", "waiting");
  schedule(cfg.interval);
})();`;
}

/** JSON that is safe inside a <script> element: no "</script>", no HTML comment openers. */
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
