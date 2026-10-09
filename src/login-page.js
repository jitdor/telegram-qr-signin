// The default sign-in page, laid out as a boarding pass: a loud headline, a ticket carrying the
// site's name, and a perforated stub with the QR on it (or, on a phone, the button that opens
// Telegram). Nothing to type: the pass says so ("Phone number: Not needed", "Code to type: None").
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
// The layout follows the device. A computer shows the QR and a small "open it here" link. A phone
// leads with the Open Telegram button and tucks the QR behind "Signing in on another device?". A
// tablet shows both, side by side in landscape and stacked in portrait.
//
// Replace it wholesale by passing `renderLoginPage` to createTelegramQrAuth; restyle it by passing
// `branding`. A replacement can reuse the polling script via `pollScript()` and supply only the
// markup — see POLL_STATUSES in provider.js for the contract it implements.

import { fontFaceCss, fontPreloadLinks } from "./fonts/index.js";
import { PREVIEW_HEIGHT, PREVIEW_WIDTH } from "./preview/index.js";

export const DEFAULT_BRANDING = {
  title: "Sign in",
  // The headline, one line per field. The second line depends on the device and the sign-in state.
  heading: "Your pass is ready.",
  scanHeading: "Scan it to sign in.",
  tapHeading: "Tap to sign in.",
  approvedHeading: "Approved.",
  approvedSubheading: "You're through.",
  expiredHeading: "Pass expired.",
  expiredSubheading: "Get a new one.",
  deniedHeading: "No entry.",
  deniedSubheading: "Not on the list.",
  // The ticket.
  kickerText: "Sign-in pass",
  viaText: "Via Telegram",
  destinationLabel: "Destination",
  phoneLabel: "Phone number",
  phoneText: "Not needed",
  codeLabel: "Code to type",
  codeText: "None",
  statusLabel: "Status",
  stepLabel: "Step",
  stepText: "{n} of 3",
  nextLabel: "Next",
  nextText: "Tap Start, then Approve",
  nextDoneText: "Opening {name}…",
  nextExpiredText: "Get a new pass",
  nextDeniedText: "Ask for access",
  // What the Status field says. `waitingText` is "Ready" on a phone that is about to open Telegram.
  waitingText: "Awaiting scan",
  readyText: "Ready",
  successText: "Signed in",
  statusExpiredText: "Expired",
  statusDeniedText: "Not allowed",
  // Longer messages, shown on the stub when the sign-in ends badly.
  expiredText: "This sign-in code expired.",
  deniedText: "Your Telegram account isn't allowed to sign in here.",
  retryText: "Get a new code",
  stampText: "Admitted",
  // The stub.
  scanText: "Scan with your phone",
  scanOtherText: "Scan with the phone that has Telegram",
  qrLinkTitle: "Open Telegram to sign in",
  qrHintText: "Telegram on this computer? Open it here",
  mobileLinkText: "Open Telegram",
  tabletLinkText: "Open Telegram on this tablet",
  orScanText: "Or",
  tabletTitleText: "Telegram on this tablet?",
  mobileSubtitle: "Tap Start, then Approve. Come back here when you're done.",
  showQrText: "Signing in on another device? Show the QR code",
  showAppText: "Telegram is on this phone? Open it instead",
  // The line along the bottom.
  footText: "Keep this tab open. It signs you in by itself once you approve in Telegram.",
  mobileFootText: "This page finishes signing you in when you come back.",
  scanFootText: "Keep this screen on until the other phone approves.",
  // The OIDC provider's consent screen and its error page (see oidc/consent-page.js).
  consentHeading: "One last check.",
  consentSubheading: "Let it sign you in?",
  consentKickerText: "Access request",
  consentWarnText: "This app is not operated by us. Authorize it only if you started this sign-in yourself.",
  signedInAsLabel: "Signed in as",
  returnsLabel: "Returns to",
  accessLabel: "It will receive",
  allowText: "Authorize",
  denyText: "Cancel",
  consentFootText: "You can withdraw this at any time. Withdrawing also signs the app out.",
  errorHeading: "Sign-in could not continue",
  errorCodeLabel: "Error code",
  errorNoteText:
    "Nothing was shared with the application that sent you here. If you arrived from a link you did not expect, close this page.",
  // The page ending a scan that came too late (see renderScanEndedPage).
  scanEndedHeading: "This sign-in code has ended",
  scanEndedText: "It expired or was already used. Go back to the sign-in page on your computer for a new code.",
  // The page itself is the accent colour; ink and paper follow from it. Text on the page switches
  // between dark and white to stay legible, whatever accent is chosen.
  accent: "#ee5a1c",
  siteName: "",
  // What a link preview says under the title (Telegram, Slack, Discord, X, iMessage ...), and in search
  // results. "{name}" is the site's name. `previewImage` replaces the built-in card with an image of your own:
  // an absolute https URL, or a path on this site.
  description:
    "Sign in to {name} with Telegram. Scan the code, tap Start, and you're in. No phone number, no password, nothing to type.",
  previewImage: "",
  logoHtml: "",
  footerHtml: "",
  headHtml: "",
};

const INK = "#17130f";

// Telegram's paper plane, drawn inline so the page makes no external requests. Only shown when the
// site has no name to take a letter from.
const PLANE_PATH = "M21.4 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.8 5.6c.3.9 1.4 1.1 2 .4l2.6-2.7 4.8 3.5c.8.6 1.9.1 2.1-.9l3-15.1c.2-1.1-.8-2-1.9-1.6Zm-3.6 4.1-8.5 7.6-.4 3.4-1.2-4 9.6-6.9c.4-.3.9.2.5.6Z";
const PLANE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${PLANE_PATH}"/></svg>`;
const ARROW_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>`;

// A small glyph, used as a CSS mask so it takes the colour of the text around it and needs no
// markup. A data: URI is not a network request.
const MASK_LOCK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4.5' y='11' width='15' height='10' rx='2.5'/%3E%3Cpath d='M8 11V8a4 4 0 0 1 8 0v3'/%3E%3C/svg%3E")`;

const MASK_UNLOCK =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='4.5' y='11' width='15' height='10' rx='2.5'/%3E%3Cpath d='M8 11V8a4 4 0 0 1 7.6-1.7'/%3E%3C/svg%3E")`;

/** The first letter or digit of a name, upper-cased, or "" when it has none. */
function firstLetter(name) {
  return String(name ?? "").match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "";
}

/** "courier.jitdor.com" → "Courier": a name for a site that was only given an address. */
function nameFromHost(host) {
  const hostname = String(host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!hostname || hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return "";
  const label = hostname.replace(/^www\./, "").split(".")[0];
  return label ? label[0].toUpperCase() + label.slice(1) : "";
}

function hostOf(origin) {
  try {
    return origin ? new URL(origin).host : "";
  } catch {
    return "";
  }
}

/** Dark ink or white, whichever reads better on `color` (a #rgb or #rrggbb value; anything else gets ink). */
function textOn(color) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color).trim());
  if (!match) return INK;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const inkLuminance = 0.0086;
  return (luminance + 0.05) / (inkLuminance + 0.05) >= 1.05 / (luminance + 0.05) ? INK : "#ffffff";
}

/**
 * A tab icon: the site's letter in the accent colour on a dark tile, unless the app already supplies
 * one in `headHtml`. An inline data: URI, so the browser does not go looking for /favicon.ico.
 */
function faviconLink(branding, letter) {
  if (/rel\s*=\s*["']?(?:shortcut\s+)?icon/i.test(branding.headHtml)) return "";
  const accent = escapeHtml(branding.accent);
  const glyph = letter
    ? `<text x="32" y="47" text-anchor="middle" font-family="Arial Black,Impact,Arial,sans-serif" font-weight="900" font-size="42" fill="${accent}">${escapeHtml(letter)}</text>`
    : `<g transform="translate(14 14) scale(1.5)"><path fill="${accent}" d="${PLANE_PATH}"/></g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="${INK}"/>${glyph}</svg>`;
  return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}">`;
}

/**
 * The stylesheet shared by the sign-in page and the code-ended page.
 *
 * The same markup serves every device; what shows is decided here. Three conditions pick the layout:
 * a pointer device (a computer), a coarse-pointer device narrower than 640px (a phone), and a
 * coarse-pointer device wider than that (a tablet, laid out beside the QR at 900px and up and
 * stacked below it). `data-tqa-state` on <html> (set by the polling script) drives the endings, and
 * `data-tqa-view` picks between the button and the QR on a phone.
 */
function loginStyles(branding, fontsPath) {
  return `
  ${fontFaceCss(fontsPath)}
  :root {
    color-scheme: light;
    --tqa-accent: ${branding.accent};
    --tqa-on: ${textOn(branding.accent)};
    --tqa-ink: ${INK};
    --tqa-paper: #fbfaf6;
    --tqa-muted: #6a6358;
    --tqa-rule: #cdc7b8;
    --tqa-ok: #1d6b43;
    --tqa-bad: #b3261e;
    --tqa-notch: 14px;
    /* The bundled fonts (served by the app itself, see src/fonts), then the best the system has. A site
       that wants its own can set --tqa-display, --tqa-font and --tqa-mono from branding.headHtml. */
    --tqa-display: "TQA Display", "Archivo Black", Impact, "Haettenschweiler", "Arial Narrow Bold", "Arial Black", system-ui, sans-serif;
    --tqa-font: "TQA Sans", Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --tqa-mono: "TQA Mono", "Google Sans Code", ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh; overflow-x: hidden;
    background-color: var(--tqa-accent);
    background-image: radial-gradient(color-mix(in srgb, var(--tqa-on) 24%, transparent) 1.1px, transparent 1.6px);
    background-size: 22px 22px;
    color: var(--tqa-on); font: 16px/1.5 var(--tqa-font); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  .tqa-page {
    display: flex; flex-direction: column; width: min(100%, 47rem); min-height: 100vh; min-height: 100dvh; margin: 0 auto;
    padding: max(20px, env(safe-area-inset-top)) 20px max(22px, env(safe-area-inset-bottom));
  }
  .tqa-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 14px; min-width: 0; }
  .tqa-brand { display: flex; align-items: center; gap: 12px; min-width: 0; font-weight: 700; font-size: 1.15rem; letter-spacing: -0.01em; }
  .tqa-brand-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tqa-mark {
    flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 11px;
    background: var(--tqa-ink); color: var(--tqa-accent); font: 900 1.5rem/1 var(--tqa-display);
  }
  .tqa-mark svg { width: 22px; height: 22px; fill: currentColor; }
  /* The address, in the shape of a browser's address bar: a lock on its own segment, then the host. */
  .tqa-site {
    display: flex; align-items: stretch; flex: 0 1 auto; min-width: 0; max-width: 100%; margin: 0 0 0 auto; border-radius: 999px; overflow: hidden;
    background: var(--tqa-ink); color: #fff; font: 600 0.86rem/1.2 var(--tqa-font); letter-spacing: -0.005em;
    box-shadow: 0 0 0 1px color-mix(in srgb, #fff 14%, transparent) inset;
  }
  .tqa-lock { flex: none; display: grid; place-items: center; width: 30px; border-right: 1px solid color-mix(in srgb, #fff 24%, transparent); }
  .tqa-lock::before {
    content: ""; width: 14px; height: 14px; background: #7ee2a8;
    -webkit-mask: ${MASK_LOCK} center / contain no-repeat; mask: ${MASK_LOCK} center / contain no-repeat;
  }
  .tqa-site-open .tqa-lock::before { background: #ffc15e; -webkit-mask-image: ${MASK_UNLOCK}; mask-image: ${MASK_UNLOCK}; }
  /* A host name is lower case, so it looks centred when its x-height is, not its line box. Where the browser can
     trim the line box to the x-height and the baseline (text-box), equal padding around that centres it in any
     font, with the pill the same 2.4em tall. Elsewhere, padding measured for the bundled Inter. */
  .tqa-host { min-width: 0; padding: 8.1px 12px 8.4px 10px; overflow-wrap: anywhere; }
  @supports (text-box: trim-both ex alphabetic) {
    .tqa-host { text-box: trim-both ex alphabetic; padding-block: calc((2.4em - 1ex) / 2); }
  }
  .tqa-stage { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: clamp(1.5rem, 5vh, 3.5rem) 0 1.5rem; }
  .tqa-headline {
    margin: 0 0 clamp(1.25rem, 3.5vw, 2rem); font: 900 clamp(2rem, 11.4vw, 4rem)/0.94 var(--tqa-display);
    letter-spacing: -0.03em; text-transform: uppercase; text-wrap: balance;
  }
  .tqa-hl { display: block; }
  .tqa-error {
    margin: 0 0 14px; padding: 12px 16px; border-radius: 14px; background: var(--tqa-ink); color: var(--tqa-paper);
    font: 500 0.85rem/1.45 var(--tqa-mono);
  }

  /* The ticket. The paper is painted by its two halves, so the notches can be real holes in it (masks,
     below) that show the page through them. Each layer is drawn by the element above the one it follows:
     a mask clips its own element's filter and shadows, so the ink edge is a drop shadow of the ticket,
     around the masked halves, and the soft shadow belongs to .tqa-pass, outside that filter, where it lies
     under the whole ticket and a hole lets it show. */
  .tqa-pass { position: relative; isolation: isolate; animation: tqa-rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  /* What box-shadow: 0 38px 50px -28px would draw, but drawn under the ticket rather than only around it. */
  .tqa-pass::before {
    content: ""; position: absolute; z-index: -1; inset: 28px; transform: translateY(38px); pointer-events: none;
    background: color-mix(in srgb, var(--tqa-ink) 55%, transparent); filter: blur(25px);
  }
  .tqa-ticket { display: grid; grid-template-columns: minmax(0, 1fr); color: var(--tqa-ink); filter: drop-shadow(0 2px 0 var(--tqa-ink)); }
  .tqa-main, .tqa-stub { background: var(--tqa-paper); --tqa-bite: #0000 calc(var(--tqa-notch) - 0.5px), #000 calc(var(--tqa-notch) + 0.5px); }
  .tqa-main { min-width: 0; padding: 26px 24px 24px; container-type: inline-size; border-radius: 26px; }
  .tqa-kicker { display: flex; justify-content: space-between; gap: 12px; font: 500 0.66rem/1.2 var(--tqa-mono); letter-spacing: 0.2em; text-transform: uppercase; color: var(--tqa-muted); }
  .tqa-name {
    margin: 0.6rem 0 0; padding-bottom: 1rem; border-bottom: 2px solid var(--tqa-ink);
    font: 900 calc(min(30cqw, 9rem) * var(--tqa-name-scale, 1))/0.9 var(--tqa-display); letter-spacing: -0.04em; text-transform: uppercase;
    overflow-wrap: break-word; text-wrap: balance;
  }
  .tqa-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 20px; margin: 18px 0 0; }
  .tqa-field { min-width: 0; }
  .tqa-field dt { font: 500 0.64rem/1.2 var(--tqa-mono); letter-spacing: 0.2em; text-transform: uppercase; color: var(--tqa-muted); }
  .tqa-field dd { margin: 4px 0 0; font-weight: 600; font-size: 1rem; line-height: 1.25; letter-spacing: -0.01em; overflow-wrap: anywhere; text-wrap: balance; }
  .tqa-f-dest { grid-column: 1 / -1; }
  .tqa-f-next { display: none; }
  .tqa-status { display: inline-flex; align-items: center; gap: 0.5em; }
  .tqa-status::before { content: ""; flex: none; width: 0.6em; height: 0.6em; background: var(--tqa-accent); }

  /* Which words show depends on how the sign-in is going: the polling script sets data-tqa-state. */
  .tqa-v { display: none; }
  [data-tqa-state="waiting"] .tqa-v-wait, [data-tqa-state="signed-in"] .tqa-v-ok,
  [data-tqa-state="expired"] .tqa-v-expired, [data-tqa-state="denied"] .tqa-v-denied { display: inline; }
  [data-tqa-state="signed-in"] .tqa-status::before { background: var(--tqa-ok); }
  [data-tqa-state="expired"] .tqa-status::before, [data-tqa-state="denied"] .tqa-status::before { background: var(--tqa-bad); }
  .tqa-h-tap, .tqa-st-ready { display: none; }

  /* The stub: the part you tear off. A dashed edge with a bite out of each end: half of each bite is cut
     from the main part, half from the stub, both centred on the middle of the dashed line. Each mask
     layer covers one half of its element, with the hole in that half's corner. */
  .tqa-main:not(:last-child) {
    border-radius: 26px 26px 0 0;
    -webkit-mask: radial-gradient(circle at 0 calc(100% + 0.75px), var(--tqa-bite)) 0 0 / 51% 100% no-repeat,
      radial-gradient(circle at 100% calc(100% + 0.75px), var(--tqa-bite)) 100% 0 / 51% 100% no-repeat;
    mask: radial-gradient(circle at 0 calc(100% + 0.75px), var(--tqa-bite)) 0 0 / 51% 100% no-repeat,
      radial-gradient(circle at 100% calc(100% + 0.75px), var(--tqa-bite)) 100% 0 / 51% 100% no-repeat;
  }
  .tqa-stub {
    position: relative; display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 26px 24px 28px;
    border-top: 1.5px dashed var(--tqa-rule); border-radius: 0 0 26px 26px;
    -webkit-mask: radial-gradient(circle at 0 0.75px, var(--tqa-bite)) 0 0 / 51% 100% no-repeat,
      radial-gradient(circle at 100% 0.75px, var(--tqa-bite)) 100% 0 / 51% 100% no-repeat;
    mask: radial-gradient(circle at 0 0.75px, var(--tqa-bite)) 0 0 / 51% 100% no-repeat,
      radial-gradient(circle at 100% 0.75px, var(--tqa-bite)) 100% 0 / 51% 100% no-repeat;
  }
  .tqa-qr { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; }
  .tqa-qr-link { --tqa-qr-size: 12.5rem; display: block; width: min(100%, var(--tqa-qr-size)); line-height: 0; transition: transform 0.2s ease; }
  /* The code is drawn with crisp edges, so at a size that isn't a whole number of device pixels per module
     the modules come out unevenly, some a pixel wider than others. With the module count from the SVG
     (--tqa-qr-modules, set on the link), the size goes to the nearest whole number of device pixels per
     module. A device pixel is 1px / --tqa-dpr, the pixel ratio, which the script below keeps current: it
     changes with browser zoom and with the screen the window is on. Rounding up can take the code up to
     half a module's width into the stub's padding. */
  @supports (width: round(1px, 1px)) {
    .tqa-qr-link { width: round(min(100%, var(--tqa-qr-size)), var(--tqa-qr-modules, 1) * 1px / var(--tqa-dpr, 1)); }
  }
  .tqa-qr-link:hover { transform: translateY(-2px); }
  .tqa-qr svg { display: block; width: 100%; height: auto; }
  /* The code sits on the ticket's paper, with the three finder squares in the page colour. They stay
     dark enough to scan: a scanner reads brightness, not hue. */
  .tqa-qr svg > rect:first-child { fill: var(--tqa-paper); }
  .tqa-qr svg > path { fill: var(--tqa-ink); }
  .tqa-qr svg .qr-eye { fill: color-mix(in srgb, var(--tqa-accent) 88%, #000); }
  .tqa-cap { margin: 0; font: 500 0.68rem/1.4 var(--tqa-mono); letter-spacing: 0.15em; text-transform: uppercase; text-align: center; text-wrap: balance; }
  .tqa-cap-other { display: none; }
  .tqa-here, .tqa-switch {
    appearance: none; margin: 0; padding: 0; border: 0; background: none; cursor: pointer; color: var(--tqa-ink);
    font: 600 0.88rem/1.35 var(--tqa-font); letter-spacing: -0.005em; text-align: center;
    text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px;
  }
  .tqa-switch { display: none; align-self: flex-start; text-align: left; }
  .tqa-app { display: none; flex-direction: column; gap: 12px; width: 100%; }
  .tqa-app-title { display: none; margin: 0; font: 900 clamp(1.5rem, 5vw, 1.9rem)/0.95 var(--tqa-display); letter-spacing: -0.02em; text-transform: uppercase; }
  .tqa-open, .tqa-retry {
    display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 54px; padding: 0 20px;
    border: 0; border-radius: 16px; background: var(--tqa-ink); color: var(--tqa-paper); cursor: pointer; text-decoration: none;
    font: 600 1.1rem/1.2 var(--tqa-font); letter-spacing: -0.01em; transition: transform 0.15s ease, filter 0.15s ease;
  }
  .tqa-open:hover, .tqa-retry:hover { filter: brightness(1.25); }
  .tqa-open:active, .tqa-retry:active { transform: scale(0.985); }
  .tqa-open svg { flex: none; width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  .tqa-lbl-long { display: none; }
  .tqa-how { display: none; margin: 0; font: 400 0.75rem/1.6 var(--tqa-mono); color: var(--tqa-muted); text-align: center; }
  .tqa-or {
    display: none; align-items: center; gap: 12px; width: 100%; font: 500 0.75rem/1 var(--tqa-mono); letter-spacing: 0.22em; text-transform: uppercase; color: var(--tqa-muted);
  }
  .tqa-or::before, .tqa-or::after { content: ""; flex: 1; border-top: 1.5px dashed var(--tqa-rule); }
  .tqa-msg { display: none; width: 100%; margin: 0; font: 500 0.78rem/1.5 var(--tqa-mono); text-align: center; color: var(--tqa-bad); }
  .tqa-stamp { display: none; width: 100%; min-height: 9rem; place-content: center; justify-items: center; gap: 16px; text-align: center; }
  .tqa-stamp-mark {
    display: inline-block; padding: 0.12em 0.4em 0.08em; border: 0.14em solid var(--tqa-ok); border-radius: 0.3em; color: var(--tqa-ok);
    font: 900 clamp(1.9rem, 8vw, 2.6rem)/1 var(--tqa-display); letter-spacing: -0.01em; text-transform: uppercase; transform: rotate(-6deg);
    animation: tqa-stamp 0.45s cubic-bezier(0.2, 1.3, 0.4, 1) both;
  }
  .tqa-stamp-note { margin: 0; font: 500 0.72rem/1.4 var(--tqa-mono); color: var(--tqa-muted); }
  .tqa-foot { margin: 0; padding-top: 1rem; font: 500 0.75rem/1.5 var(--tqa-mono); }
  .tqa-foot > span { display: none; }
  .tqa-foot > .tqa-foot-desk { display: inline; }
  .tqa-foot-extra { margin: 0.5rem 0 0; font-size: 0.8rem; }
  a:focus-visible, button:focus-visible { outline: 3px solid var(--tqa-ink); outline-offset: 3px; }
  .tqa-open:focus-visible, .tqa-retry:focus-visible { outline-color: var(--tqa-accent); box-shadow: 0 0 0 3px var(--tqa-ink); }
  [hidden] { display: none !important; }
  @keyframes tqa-rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
  @keyframes tqa-stamp { from { opacity: 0; transform: rotate(-14deg) scale(1.7); } to { opacity: 1; transform: rotate(-6deg) scale(1); } }

  /* Wide enough for the stub to sit beside the ticket. */
  @media (min-width: 640px) {
    .tqa-main { padding: 30px 36px 28px; }
    /* Columns the width of what is in them, sharing out whatever is left, so an address or "Tap Start, then Approve" stays on one line when it fits. */
    .tqa-fields { grid-template-columns: repeat(3, auto); column-gap: 14px; }
    .tqa-f-dest { grid-column: auto; }
    .tqa-f-next { display: block; }
    .tqa-field dd { font-size: 0.9rem; }
  }
  @media (min-width: 900px) {
    .tqa-ticket { grid-template-columns: minmax(0, 1fr) clamp(15rem, 33%, 19rem); }
    .tqa-main:not(:last-child) {
      border-radius: 26px 0 0 26px;
      -webkit-mask: radial-gradient(circle at calc(100% + 0.75px) 0, var(--tqa-bite)) 0 0 / 100% 51% no-repeat,
        radial-gradient(circle at calc(100% + 0.75px) 100%, var(--tqa-bite)) 0 100% / 100% 51% no-repeat;
      mask: radial-gradient(circle at calc(100% + 0.75px) 0, var(--tqa-bite)) 0 0 / 100% 51% no-repeat,
        radial-gradient(circle at calc(100% + 0.75px) 100%, var(--tqa-bite)) 0 100% / 100% 51% no-repeat;
    }
    .tqa-stub {
      justify-content: center; padding: 28px 22px; border-top: 0; border-left: 1.5px dashed var(--tqa-rule); border-radius: 0 26px 26px 0;
      -webkit-mask: radial-gradient(circle at 0.75px 0, var(--tqa-bite)) 0 0 / 100% 51% no-repeat,
        radial-gradient(circle at 0.75px 100%, var(--tqa-bite)) 0 100% / 100% 51% no-repeat;
      mask: radial-gradient(circle at 0.75px 0, var(--tqa-bite)) 0 0 / 100% 51% no-repeat,
        radial-gradient(circle at 0.75px 100%, var(--tqa-bite)) 0 100% / 100% 51% no-repeat;
    }
    .tqa-stamp-mark { font-size: 1.8rem; }
    /* Room to spare: the type steps down so the ticket reads as a ticket, not as a form. */
    .tqa-headline { font-size: clamp(2rem, 11.4vw, 4rem); }
    .tqa-name { font-size: calc(min(25cqw, 7rem) * var(--tqa-name-scale, 1)); }
    .tqa-kicker, .tqa-field dt { font-size: 0.6rem; }
    .tqa-field dd { font-size: 0.8rem; }
    .tqa-cap { font-size: 0.62rem; }
    .tqa-here, .tqa-switch { font-size: 0.8rem; }
    .tqa-foot { font-size: 0.68rem; }
    .tqa-how { font-size: 0.7rem; }
    .tqa-msg { font-size: 0.74rem; }
    .tqa-open, .tqa-retry { min-height: 50px; font-size: 1rem; }
  }

  /* Phones and tablets can't scan their own screen: they get the button. */
  @media (hover: none) and (pointer: coarse) {
    .tqa-here { display: none; }
    .tqa-app, .tqa-or { display: flex; }
    .tqa-qr-link:hover { transform: none; }
  }
  @media (hover: none) and (pointer: coarse) and (min-width: 640px) {
    .tqa-page { width: min(100%, 62rem); padding-left: 40px; padding-right: 40px; }
  }
  /* Tablet, held upright: the stub runs along the bottom with the QR on one side and the button on the other. */
  @media (hover: none) and (pointer: coarse) and (min-width: 640px) and (max-width: 899.98px) {
    .tqa-stub { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 24px; padding: 28px 36px; }
    .tqa-or { flex-direction: column; align-self: stretch; width: auto; }
    .tqa-or::before, .tqa-or::after { border-top: 0; border-left: 1.5px dashed var(--tqa-rule); min-height: 1.5rem; }
    .tqa-app-title, .tqa-how { display: block; }
    .tqa-how { text-align: left; }
    .tqa-qr-link { --tqa-qr-size: 11.5rem; }
  }
  /* Tablet, held sideways: the button goes under the QR on the stub. */
  @media (hover: none) and (pointer: coarse) and (min-width: 900px) {
    .tqa-lbl-short { display: none; }
    .tqa-lbl-long { display: inline; }
    .tqa-qr-link { --tqa-qr-size: 9.5rem; }
    .tqa-stub { gap: 10px; padding-top: 22px; padding-bottom: 22px; }
    .tqa-open { font-size: 0.9rem; padding: 0 14px; gap: 8px; min-height: 44px; }
  }
  /* Phone: the button first, and the QR for a second device one tap away. */
  @media (hover: none) and (pointer: coarse) and (max-width: 639.98px) {
    .tqa-page { padding-left: 16px; padding-right: 16px; }
    .tqa-stub { align-items: stretch; padding: 24px 20px 22px; }
    .tqa-or { display: none; }
    .tqa-qr-link { --tqa-qr-size: 15rem; }
    .tqa-how { display: block; }
    .tqa-foot { text-align: center; }
    .tqa-foot > .tqa-foot-desk { display: none; }
    html[data-tqa-view="app"] .tqa-qr { display: none; }
    html[data-tqa-view="app"] .tqa-switch-qr { display: block; }
    html[data-tqa-view="app"] .tqa-foot > .tqa-foot-app { display: inline; }
    html[data-tqa-view="app"] .tqa-h-scan, html[data-tqa-view="app"] .tqa-st-scan { display: none; }
    html[data-tqa-view="app"] .tqa-h-tap, html[data-tqa-view="app"] .tqa-st-ready { display: inline; }
    html[data-tqa-view="qr"] .tqa-app { display: none; }
    html[data-tqa-view="qr"] .tqa-switch-app { display: block; align-self: center; text-align: center; }
    html[data-tqa-view="qr"] .tqa-foot > .tqa-foot-qr { display: inline; }
    html[data-tqa-view="qr"] .tqa-cap-main { display: none; }
    html[data-tqa-view="qr"] .tqa-cap-other { display: inline; }
    /* Showing the code to another phone needs no headline: the code is the point. It stays for screen readers. */
    html[data-tqa-state="waiting"][data-tqa-view="qr"] .tqa-headline { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  }

  /* How it ends. */
  html[data-tqa-state="signed-in"] .tqa-stub > :not(.tqa-stamp),
  html[data-tqa-state="signed-in"] .tqa-foot { display: none !important; }
  html[data-tqa-state="signed-in"] .tqa-stamp { display: grid; }
  html[data-tqa-state="signed-in"] .tqa-stub, html[data-tqa-state="expired"] .tqa-stub, html[data-tqa-state="denied"] .tqa-stub { display: flex; flex-direction: column; justify-content: center; align-items: center; }
  html[data-tqa-state="expired"] .tqa-stub > :not(.tqa-qr):not(.tqa-msg-expired),
  html[data-tqa-state="denied"] .tqa-stub > :not(.tqa-msg-denied) { display: none !important; }
  html[data-tqa-state="expired"] .tqa-qr { display: flex !important; max-width: 20rem; }
  html[data-tqa-state="expired"] .tqa-msg-expired, html[data-tqa-state="denied"] .tqa-msg-denied { display: block; }
  @media (prefers-reduced-motion: reduce) {
    .tqa-pass, .tqa-stamp-mark { animation: none; }
    .tqa-open, .tqa-retry, .tqa-qr-link { transition: none; }
    .tqa-open:active, .tqa-retry:active, .tqa-qr-link:hover { transform: none; }
  }
`;
}

/**
 * What the pass calls the site: its name (`branding.siteName`, else the hub's `site.name`, else the first
 * label of the host), the address it is served from (`site.host`, else the host of `origin`), and the
 * letter that marks it. Shared by every page that wears the pass.
 */
export function resolveSite({ branding, site, origin }) {
  const host = site?.host || hostOf(origin);
  const name = String(branding.siteName || site?.name || nameFromHost(host) || "").trim();
  // The lock claims a secure connection, so it only says so unless the page is known to be served over plain http.
  return { host, name, letter: firstLetter(name), secure: !/^http:/i.test(String(origin ?? "")) };
}

/** The CSS scale that keeps a long name inside the ticket: 1 up to seven characters, smaller after. */
export function nameScaleFor(name) {
  const length = [...name].length;
  return length > 7 ? Math.max(0.4, 7 / length).toFixed(2) : "1";
}

/**
 * The Open Graph and Twitter tags link previews are built from: a title, a short description and, when the
 * address the page is served from is known, the card. Link previews need an absolute image URL, so without
 * an `origin` (or `branding.previewImage` as an absolute URL) the preview is text only.
 */
export function previewTags({ branding, name, host, origin, previewPath }) {
  const title = branding.title;
  const description = String(branding.description ?? "").replace("{name}", name || host || "this site").trim();
  let image = "";
  const own = String(branding.previewImage ?? "").trim();
  try {
    if (own) image = new URL(own, origin || undefined).href;
    else if (previewPath && origin) image = new URL(previewPath, origin).href;
  } catch {
    image = "";
  }
  if (image && !/^https?:/i.test(image)) image = "";
  const meta = (attr, key, value) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  return [
    description && meta("name", "description", description),
    meta("property", "og:type", "website"),
    meta("property", "og:title", title),
    description && meta("property", "og:description", description),
    (name || host) && meta("property", "og:site_name", name || host),
    image && meta("property", "og:image", image),
    image && !own && meta("property", "og:image:type", "image/png"),
    image && !own && meta("property", "og:image:width", PREVIEW_WIDTH),
    image && !own && meta("property", "og:image:height", PREVIEW_HEIGHT),
    image && meta("property", "og:image:alt", `${title}: scan the code with Telegram`),
    meta("name", "twitter:card", image ? "summary_large_image" : "summary"),
    meta("name", "twitter:title", title),
    description && meta("name", "twitter:description", description),
    image && meta("name", "twitter:image", image),
  ]
    .filter(Boolean)
    .join("\n");
}

/** Everything inside <head> that every pass page shares. `css` is added after the shared stylesheet. */
export function pageHead({ branding, fontsPath, title, letter, css = "" }) {
  return `<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="${escapeHtml(branding.accent)}">
<title>${escapeHtml(title)}</title>
${faviconLink(branding, letter)}
${fontPreloadLinks(fontsPath)}
${branding.headHtml}
<style>${loginStyles(branding, fontsPath)}${css}</style>`;
}

/** The top bar: the site's mark and name on the left, the address it is served from on the right. */
export function topBar({ branding, name, letter, host, secure = true }) {
  const mark = branding.logoHtml || `<span class="tqa-mark" aria-hidden="true">${letter ? escapeHtml(letter) : PLANE_ICON}</span>`;
  return `<header class="tqa-top">
      <div class="tqa-brand">${mark}${name ? `<span class="tqa-brand-name">${escapeHtml(name)}</span>` : ""}</div>
      ${host ? `<p class="tqa-site${secure ? "" : " tqa-site-open"}" title="${secure ? "Secure connection to" : "Not a secure connection to"} ${escapeHtml(host)}"><span class="tqa-lock" role="img" aria-label="${secure ? "Secure connection" : "Not secure"}"></span><span class="tqa-host">${escapeHtml(host)}</span></p>` : ""}
    </header>`;
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
 * @param {string} [params.error]     Message to show above the pass (e.g. "you were removed").
 * @param {string} params.pollPath    Absolute path the page should poll.
 * @param {number} params.pollIntervalMs
 * @param {object} [params.branding]
 * @param {string} [params.redirectTo="/"]  Where to send the browser once signed in.
 * @param {string} [params.fontsPath]  Where the app serves the bundled fonts from (`auth.paths.fonts`).
 *   Without it the page uses the system fonts.
 * @param {string} [params.origin]    The origin this page is being served from, when the request is
 *   known. It supplies the address shown on the pass when `site.host` is not given, and the absolute
 *   URL of the link-preview card.
 * @param {string} [params.previewPath]  Where the app serves the link-preview card from (`auth.paths.preview`).
 *   Without it, and without `branding.previewImage`, link previews of the page have no image.
 * @param {{ name?: string, host?: string }} [params.site]  Which site this is. `name` is the pass's
 *   name (and, by its first letter, the mark in the corner) and becomes the title "Sign in to
 *   <name>"; `host` is the address shown top right and as the destination. Supplied by the hub's
 *   createSiteAuth; `branding.siteName` overrides the name, and a standalone app gets its host from `origin`.
 */
export function renderLoginPage(params) {
  const branding = { ...DEFAULT_BRANDING, ...(params.branding ?? {}) };
  const site = params.site ?? null;
  const { host, name, letter, secure } = resolveSite({ branding, site, origin: params.origin });
  if (name && params.branding?.title === undefined) branding.title = `Sign in to ${name}`;
  const { token, deepLink, qrSvg, error, pollPath, pollIntervalMs = 2000, redirectTo = "/" } = params;
  const appLink = escapeHtml(params.appLink ?? appLinkFromDeepLink(deepLink));
  const errorHtml = error ? `<p class="tqa-error" role="alert">${escapeHtml(error)}</p>` : "";
  const text = (key) => escapeHtml(branding[key]);
  const withName = (key) => escapeHtml(String(branding[key]).replace("{name}", name || host || ""));
  const nameScale = nameScaleFor(name);
  const step = (n) => escapeHtml(String(branding.stepText).replace("{n}", n));
  // How many modules the code is across, when it says (qr.js does), so the page can size it on whole pixels.
  const qrModules = Number(/\sdata-modules="(\d+)"/.exec(qrSvg ?? "")?.[1]) || 0;

  return `<!DOCTYPE html>
<html lang="en" data-tqa-state="waiting" data-tqa-view="app">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="${escapeHtml(branding.accent)}">
<title>${escapeHtml(branding.title)}</title>
${previewTags({ branding, name, host, origin: params.origin, previewPath: params.previewPath })}
${faviconLink(branding, letter)}
${fontPreloadLinks(params.fontsPath)}
${branding.headHtml}
<style>${loginStyles(branding, params.fontsPath)}</style>
</head>
<body>
  <div class="tqa-page">
    ${topBar({ branding, name, letter, host, secure })}
    <main class="tqa-stage">
      <h1 class="tqa-headline">
        <span class="tqa-hl"><span class="tqa-v tqa-v-wait">${text("heading")}</span><span class="tqa-v tqa-v-ok">${text("approvedHeading")}</span><span class="tqa-v tqa-v-expired">${text("expiredHeading")}</span><span class="tqa-v tqa-v-denied">${text("deniedHeading")}</span></span>
        <span class="tqa-hl"><span class="tqa-v tqa-v-wait"><span class="tqa-h-scan">${text("scanHeading")}</span><span class="tqa-h-tap">${text("tapHeading")}</span></span><span class="tqa-v tqa-v-ok">${text("approvedSubheading")}</span><span class="tqa-v tqa-v-expired">${text("expiredSubheading")}</span><span class="tqa-v tqa-v-denied">${text("deniedSubheading")}</span></span>
      </h1>
      ${errorHtml}
      <div class="tqa-pass"><div class="tqa-ticket">
        <section class="tqa-main">
          <div class="tqa-kicker"><span>${text("kickerText")}</span><span>${text("viaText")}</span></div>
          <p class="tqa-name" style="--tqa-name-scale: ${nameScale}">${escapeHtml(name || branding.title)}</p>
          <dl class="tqa-fields">
            <div class="tqa-field tqa-f-dest"><dt>${text("destinationLabel")}</dt><dd>${escapeHtml(host || name)}</dd></div>
            <div class="tqa-field"><dt>${text("phoneLabel")}</dt><dd>${text("phoneText")}</dd></div>
            <div class="tqa-field"><dt>${text("codeLabel")}</dt><dd>${text("codeText")}</dd></div>
            <div class="tqa-field"><dt>${text("statusLabel")}</dt><dd><span class="tqa-status" id="tqa-status" role="status"><span class="tqa-st-scan">${text("waitingText")}</span><span class="tqa-st-ready">${text("readyText")}</span></span></dd></div>
            <div class="tqa-field"><dt>${text("stepLabel")}</dt><dd><span class="tqa-v tqa-v-wait tqa-v-expired tqa-v-denied">${step(1)}</span><span class="tqa-v tqa-v-ok">${step(3)}</span></dd></div>
            <div class="tqa-field tqa-f-next"><dt>${text("nextLabel")}</dt><dd><span class="tqa-v tqa-v-wait">${text("nextText")}</span><span class="tqa-v tqa-v-ok">${withName("nextDoneText")}</span><span class="tqa-v tqa-v-expired">${text("nextExpiredText")}</span><span class="tqa-v tqa-v-denied">${text("nextDeniedText")}</span></dd></div>
          </dl>
        </section>
        <aside class="tqa-stub">
          <div class="tqa-qr" id="tqa-qr">
            <a class="tqa-qr-link" href="${appLink}"${qrModules ? ` style="--tqa-qr-modules: ${qrModules}"` : ""} title="${text("qrLinkTitle")}" aria-label="${text("qrLinkTitle")}">${qrSvg}</a>
            <p class="tqa-cap"><span class="tqa-cap-main">${text("scanText")}</span><span class="tqa-cap-other">${text("scanOtherText")}</span></p>
          </div>
          <a class="tqa-here" id="tqa-here" href="${appLink}">${text("qrHintText")}</a>
          <p class="tqa-or" id="tqa-or">${text("orScanText")}</p>
          <div class="tqa-app" id="tqa-app">
            <h2 class="tqa-app-title">${text("tabletTitleText")}</h2>
            <a class="tqa-open" id="tqa-open" href="${appLink}"><span class="tqa-lbl-short">${text("mobileLinkText")}</span><span class="tqa-lbl-long">${text("tabletLinkText")}</span>${ARROW_ICON}</a>
            <p class="tqa-how" id="tqa-how">${text("mobileSubtitle")}</p>
          </div>
          <button type="button" class="tqa-switch tqa-switch-qr" id="tqa-show-qr">${text("showQrText")}</button>
          <button type="button" class="tqa-switch tqa-switch-app" id="tqa-show-app">${text("showAppText")}</button>
          <p class="tqa-msg tqa-msg-expired" role="alert">${text("expiredText")}</p>
          <p class="tqa-msg tqa-msg-denied" role="alert">${text("deniedText")}</p>
          <div class="tqa-stamp"><span class="tqa-stamp-mark">${text("stampText")}</span><p class="tqa-stamp-note">${withName("nextDoneText")}</p></div>
        </aside>
      </div></div>
    </main>
    <footer class="tqa-foot"><span class="tqa-foot-desk">${text("footText")}</span><span class="tqa-foot-app">${text("mobileFootText")}</span><span class="tqa-foot-qr">${text("scanFootText")}</span>${branding.footerHtml ? `<p class="tqa-foot-extra">${branding.footerHtml}</p>` : ""}</footer>
  </div>
<script>
(function () {
  var root = document.documentElement;
  function view(name) { return function () { root.setAttribute("data-tqa-view", name); }; }
  var showQr = document.getElementById("tqa-show-qr");
  var showApp = document.getElementById("tqa-show-app");
  if (showQr) showQr.addEventListener("click", view("qr"));
  if (showApp) showApp.addEventListener("click", view("app"));
  // The pixel ratio, for sizing the QR on whole device pixels (see .tqa-qr-link). It changes with zoom and
  // when the window moves to another screen; a media query for the current ratio says when.
  function trackPixelRatio() {
    var dpr = window.devicePixelRatio || 1;
    root.style.setProperty("--tqa-dpr", String(dpr));
    var change = window.matchMedia && window.matchMedia("(resolution: " + dpr + "dppx)");
    if (change && change.addEventListener) change.addEventListener("change", trackPixelRatio, { once: true });
  }
  trackPixelRatio();
})();
${pollScript({
  token,
  pollPath,
  redirectTo,
  pollIntervalMs,
  texts: { success: branding.successText, expired: branding.statusExpiredText, denied: branding.statusDeniedText, retry: branding.retryText },
  ids: { status: "tqa-status", qr: "tqa-qr", hide: ["tqa-here", "tqa-or", "tqa-app", "tqa-show-qr", "tqa-show-app"] },
})}
</script>
</body>
</html>`;
}

/**
 * What a phone shows when it opens /auth/q/<token> for a code that expired, was already used or
 * never existed. Takes the sign-in page's `branding`, and looks like the sign-in page it came from.
 */
export function renderScanEndedPage({ branding: overrides, fontsPath } = {}) {
  const branding = { ...DEFAULT_BRANDING, ...(overrides ?? {}) };
  return renderEndedPage({ branding, fontsPath, title: branding.scanEndedHeading, text: branding.scanEndedText, pageTitle: branding.title });
}

/**
 * A pass that says one thing and stops: the code-ended page and the OIDC error page. With a `site` (or
 * an `origin` to take its address from) the top bar names the site; without, it shows only the app's logo.
 *
 * @param {object} params
 * @param {object} params.branding   Already merged with DEFAULT_BRANDING.
 * @param {string} [params.fontsPath]
 * @param {string} params.title      The headline on the ticket.
 * @param {string} params.text       What happened, in a sentence.
 * @param {string} [params.pageTitle]  The tab title. Defaults to `title`.
 * @param {string} [params.extraHtml]  Already-escaped markup after the text, inside the ticket.
 * @param {{ name?: string, host?: string }} [params.site]
 * @param {string} [params.origin]
 */
export function renderEndedPage({ branding, fontsPath, title, text, pageTitle, extraHtml = "", site, origin }) {
  const { host, name, letter, secure } = site || origin ? resolveSite({ branding, site, origin }) : { host: "", name: "", letter: firstLetter(branding.siteName), secure: true };
  const top = site || origin ? topBar({ branding, name, letter, host, secure }) : branding.logoHtml ? `<header class="tqa-top"><div class="tqa-brand">${branding.logoHtml}</div></header>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
${pageHead({
  branding,
  fontsPath,
  title: pageTitle ?? title,
  letter,
  css: `
  .tqa-ticket.tqa-ticket-ended { grid-template-columns: minmax(0, 1fr); }
  .tqa-ended-title { margin: 0.7rem 0 0; font: 900 clamp(2.2rem, 10vw, 3.4rem)/0.94 var(--tqa-display); letter-spacing: -0.03em; text-transform: uppercase; text-wrap: balance; }
  .tqa-ended-text { max-width: 32rem; margin: 1rem 0 0; font-size: 1rem; color: var(--tqa-muted); text-wrap: pretty; }
  .tqa-ended-code { margin: 1.25rem 0 0; padding-top: 1rem; border-top: 2px solid var(--tqa-ink); font: 500 0.8rem/1.4 var(--tqa-mono); letter-spacing: 0.04em; color: var(--tqa-muted); }
  .tqa-ended-code code { font: inherit; color: var(--tqa-ink); }
  .tqa-ended-note { max-width: 32rem; margin: 0.75rem 0 0; font-size: 0.9rem; color: var(--tqa-muted); text-wrap: pretty; }
`,
})}
</head>
<body>
  <div class="tqa-page">
    ${top}
    <main class="tqa-stage">
      <div class="tqa-pass"><div class="tqa-ticket tqa-ticket-ended">
        <section class="tqa-main">
          <div class="tqa-kicker"><span>${escapeHtml(branding.kickerText)}</span><span>${escapeHtml(branding.viaText)}</span></div>
          <h1 class="tqa-ended-title">${escapeHtml(title)}</h1>
          <p class="tqa-ended-text">${escapeHtml(text)}</p>
          ${extraHtml}
        </section>
      </div></div>
    </main>
  </div>
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
