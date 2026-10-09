// The admin console's look: stylesheet, icons, avatars and the page shell around every page.
//
// No scripts, no fonts, no images and no network requests — the console's Content-Security-Policy
// allows none of them — so everything here is CSS and inline SVG. That is also why navigation is
// plain links to anchors, and why there is no "copy" button: a page that cannot run code cannot
// have one, and a read-only code block with `user-select: all` is the honest equivalent.

import { escapeHtml as esc } from "../login-page.js";

// --- Icons -------------------------------------------------------------------------------------

const ICONS = {
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.8"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.8"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.8"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18.2 14.7c1.9.8 3 2.5 3.3 5.3"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.4 3.1 8 7.5 9.5 4.4-1.5 7.5-5.1 7.5-9.5V6L12 3Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
  activity: '<path d="M3 12h4l2.5-7 4 14 2.5-7H21"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevron: '<path d="m9.5 6 6 6-6 6"/>',
  lock: '<rect x="4.5" y="11" width="15" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l3 3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  logout: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 8l-4 4 4 4M6 12h10"/>',
  link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
  trash: '<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.6v.1"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  unlock: '<rect x="4.5" y="11" width="15" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.5-1.8"/>',
  inbox: '<path d="M3.5 13.5 6 5.5h12l2.5 8M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5M3.5 13.5H8a1 1 0 0 1 1 1 3 3 0 0 0 6 0 1 1 0 0 1 1-1h4.5"/>',
};

/** An inline stroke icon. `name` must be one of ICONS: it is never user input. */
export function icon(name, className = "i") {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

// Telegram's paper plane, as the console's mark.
const MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.4 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.8 5.6c.3.9 1.4 1.1 2 .4l2.6-2.7 4.8 3.5c.8.6 1.9.1 2.1-.9l3-15.1c.2-1.1-.8-2-1.9-1.6Zm-3.6 4.1-8.5 7.6-.4 3.4-1.2-4 9.6-6.9c.4-.3.9.2.5.6Z"/></svg>`;

/** The console's tab icon: the mark on its gradient, as a data: URI (so no request for /favicon.ico is needed). */
const FAVICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3d52e0"/><stop offset="1" stop-color="#7648e0"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><g transform="translate(14 14) scale(1.5)"><path fill="#fff" d="M21.4 3.6 2.9 10.8c-1 .4-1 1.8.1 2.1l4.6 1.5 1.8 5.6c.3.9 1.4 1.1 2 .4l2.6-2.7 4.8 3.5c.8.6 1.9.1 2.1-.9l3-15.1c.2-1.1-.8-2-1.9-1.6Zm-3.6 4.1-8.5 7.6-.4 3.4-1.2-4 9.6-6.9c.4-.3.9.2.5.6Z"/></g></svg>`
)}`;

// --- Avatars -----------------------------------------------------------------------------------

/** A stable number 0–359 from any string, so the same site is always the same colour. */
function hueOf(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

/** Up to two initials from a name ("Internal docs" → "ID"), or "#" when there is nothing to use. */
export function initialsOf(text) {
  const letters = String(text ?? "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0] ?? "")
    .join("")
    .toUpperCase();
  return letters || "#";
}

/** A coloured tile with initials. `seed` picks the colour; `size` is "sm", "md" (default) or "lg". */
export function avatar(label, seed = label, size = "md") {
  return `<span class="av ${size}" style="--h:${hueOf(seed)}" aria-hidden="true">${esc(initialsOf(label))}</span>`;
}

/** The icon that stands for an audit entry, by the part of the action before the dot. */
export function activityIcon(action) {
  const kind = String(action).split(".")[0];
  return { site: "grid", origin: "globe", grant: "users", block: "ban", request: "bell", admin: "shield" }[kind] ?? "activity";
}

// --- The page shell ----------------------------------------------------------------------------

/**
 * The whole page: a sidebar (navigation, a quick list of sites, who is signed in) and the content.
 *
 * @param {object} p
 * @param {string} p.title      Page title.
 * @param {string} p.body       Already-escaped HTML for the content area.
 * @param {string} p.adminPath
 * @param {{ name: string, id: number|string }} p.session
 * @param {Array} [p.sites]     The site list, for the sidebar.
 * @param {string} [p.active]   "overview", or a site's namespace.
 */
export function renderShell({ title, body, adminPath, session, sites = [], active = "overview" }) {
  const shown = sites.slice(0, 10);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="${FAVICON}">
<title>${esc(title)} · Hub admin</title>
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <aside class="side">
    <a class="logo" href="${adminPath}"><span class="logo-mark">${MARK}</span><span class="logo-text"><strong>Hub</strong><small>Admin console</small></span></a>
    <nav class="nav" aria-label="Main">
      <a href="${adminPath}"${active === "overview" ? ' class="on" aria-current="page"' : ""}>${icon("grid")}<span>Overview</span></a>
      <a href="${adminPath}#sites">${icon("globe")}<span>Sites</span><span class="n">${sites.length}</span></a>
      <a href="${adminPath}#admins">${icon("shield")}<span>Super admins</span></a>
      <a href="${adminPath}#activity">${icon("activity")}<span>Activity</span></a>
    </nav>
    ${
      shown.length
        ? `<div class="side-title">Your sites</div>
    <nav class="nav sites-nav" aria-label="Sites">${shown
      .map(
        (s) => `<a href="${adminPath}/ns/${esc(s.namespace)}"${active === s.namespace ? ' class="on" aria-current="page"' : ""}><span class="dot${s.enabled ? "" : " off"}" title="${s.enabled ? "On" : "Off"}"></span><span class="ellip">${esc(s.name)}</span>${s.access === "approval" && s.requests ? `<span class="n warn">${s.requests}</span>` : ""}</a>`
      )
      .join("")}${sites.length > shown.length ? `<a href="${adminPath}#sites" class="more">+${sites.length - shown.length} more</a>` : ""}</nav>`
        : ""
    }
    <div class="me">
      ${avatar(session.name, session.id, "sm")}
      <div class="me-text"><strong class="ellip">${esc(session.name)}</strong><small>${esc(session.id)}</small></div>
      <a class="icon-btn" href="${adminPath}/auth/logout" title="Sign out" aria-label="Sign out">${icon("logout")}</a>
    </div>
  </aside>
  <div class="content"><main id="main">${body}</main></div>
</div>
</body>
</html>`;
}

// --- Styles ------------------------------------------------------------------------------------

export const STYLES = `
:root{color-scheme:light dark;
--bg:#f3f5fa;--panel:#fff;--panel-2:#f8f9fd;--side:#fff;
--ink:#0d1424;--ink-2:#33405a;--muted:#5a6781;--faint:#98a4ba;
--line:#e5e9f2;--line-2:#d5dbe8;
--accent:#3d52e0;--accent-2:#7648e0;--accent-ink:#fff;
--ok:#137537;--ok-bg:#e7f6ec;--bad:#b42318;--bad-bg:#fdecea;--warn:#965a00;--warn-bg:#fff3d9;--info:#3b4fd8;--info-bg:#eceffe;
--ph:#7b879e;--code:#edf0f7;--shadow-sm:0 1px 2px rgba(13,20,36,.05);--shadow:0 1px 2px rgba(13,20,36,.05),0 14px 34px -16px rgba(13,20,36,.2);
--radius:14px;--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
--bg:#080d19;--panel:#0f1626;--panel-2:#0b1220;--side:#0a101e;
--ink:#f0f4fb;--ink-2:#c3cde0;--muted:#8d9bb5;--faint:#5f6e8a;
--line:#1b2640;--line-2:#27355a;
--accent:#7b90ff;--accent-2:#a98bfa;--accent-ink:#090e1d;
--ok:#4ade80;--ok-bg:#0e2a1a;--bad:#fca5a5;--bad-bg:#331517;--warn:#fbbf24;--warn-bg:#32260b;--info:#a5b4fc;--info-bg:#161e42;
--ph:#6d7c99;--code:#18213a;--shadow-sm:0 1px 2px rgba(0,0,0,.35);--shadow:0 1px 2px rgba(0,0,0,.4),0 18px 40px -18px rgba(0,0,0,.7)}}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:76px}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.55 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent)}
code{background:var(--code);padding:.1em .42em;border-radius:6px;font:.86em var(--mono);word-break:break-all}
.skip{position:absolute;left:-999px;top:8px;background:var(--panel);padding:8px 12px;border-radius:8px;z-index:20}.skip:focus{left:8px}
.ellip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.muted{color:var(--muted)}.small{font-size:.8rem}
.i{width:18px;height:18px;flex:none}
/* ---- shell ---- */
.app{display:grid;grid-template-columns:272px minmax(0,1fr);min-height:100vh;min-height:100dvh}
.side{position:sticky;top:0;align-self:start;height:100vh;height:100dvh;overflow:auto;display:flex;flex-direction:column;gap:4px;padding:18px 14px 14px;background:var(--side);border-right:1px solid var(--line)}
.logo{display:flex;align-items:center;gap:12px;padding:4px 8px 16px;color:var(--ink);text-decoration:none}
.logo-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:12px;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 1px 0 rgba(255,255,255,.3) inset,0 10px 20px -10px var(--accent)}
.logo-mark svg{width:19px;height:19px}
.logo-text strong{display:block;font-size:1.05rem;line-height:1.1;letter-spacing:-.02em}.logo-text small{color:var(--muted);font-size:.74rem}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:10px;color:var(--ink-2);text-decoration:none;font-weight:560;font-size:.9rem;transition:background .15s,color .15s}
.nav a:hover{background:var(--panel-2);color:var(--ink)}
.nav a.on{background:color-mix(in srgb,var(--accent) 13%,transparent);color:var(--accent)}
.nav .n{margin-left:auto;padding:1px 8px;border-radius:99px;background:var(--code);color:var(--muted);font-size:.72rem;font-weight:650;font-variant-numeric:tabular-nums}
.nav .n.warn{background:var(--warn-bg);color:var(--warn)}
.side-title{padding:16px 10px 6px;color:var(--faint);font-size:.68rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.sites-nav a{padding:6px 10px;font-weight:520;font-size:.87rem}.sites-nav .more{color:var(--muted);font-size:.8rem;padding-left:29px}
.dot{width:8px;height:8px;margin:0 3px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--ok) 20%,transparent);flex:none}.dot.off{background:var(--faint);box-shadow:none}
.me{display:flex;align-items:center;gap:10px;margin-top:auto;padding:14px 6px 2px;border-top:1px solid var(--line)}
.me-text{min-width:0;display:flex;flex-direction:column;line-height:1.25;flex:1}.me-text strong{font-size:.86rem}.me-text small{color:var(--muted);font-size:.74rem;font-variant-numeric:tabular-nums}
.icon-btn{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;color:var(--muted);transition:background .15s,color .15s}.icon-btn:hover{background:var(--code);color:var(--ink)}
.content{min-width:0}
main{max-width:1060px;margin:0 auto;padding:34px clamp(16px,3.4vw,40px) 90px}
/* ---- avatars ---- */
.av{display:inline-grid;place-items:center;flex:none;width:40px;height:40px;border-radius:12px;color:#fff;font-weight:700;font-size:.82rem;letter-spacing:-.01em;background:linear-gradient(135deg,hsl(var(--h) 78% 58%),hsl(calc(var(--h) + 38) 72% 46%));box-shadow:0 1px 0 rgba(255,255,255,.28) inset}
.av.sm{width:32px;height:32px;border-radius:10px;font-size:.72rem}.av.lg{width:56px;height:56px;border-radius:17px;font-size:1.1rem;box-shadow:0 1px 0 rgba(255,255,255,.28) inset,0 14px 26px -14px hsl(var(--h) 80% 50%)}
/* ---- page headers ---- */
.page-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:14px 20px;margin:0 0 26px}
.page-head h1{margin:0;font-size:1.7rem;line-height:1.15;letter-spacing:-.034em}.page-head .sub{margin:5px 0 0;color:var(--muted);max-width:46rem}
.crumb{margin:0 0 14px;font-size:.86rem}.crumb a{color:var(--muted);text-decoration:none;font-weight:560}.crumb a:hover{color:var(--accent)}
.site-head{display:flex;gap:18px;align-items:center;margin:0 0 20px}.site-head h1{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0;font-size:1.65rem;line-height:1.15;letter-spacing:-.034em}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:9px}
.chip{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:3px 10px 3px 8px;border:1px solid var(--line);border-radius:99px;background:var(--panel);color:var(--muted);font:600 .76rem/1.4 var(--mono);overflow-wrap:anywhere}.chip .i{width:13px;height:13px;color:var(--ok)}
.subnav{position:sticky;top:0;z-index:5;display:flex;gap:4px;margin:0 -6px 22px;padding:8px 6px;overflow-x:auto;background:color-mix(in srgb,var(--bg) 82%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.subnav a{flex:none;display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:99px;color:var(--ink-2);text-decoration:none;font-weight:580;font-size:.84rem;transition:background .15s}
.subnav a:hover{background:var(--code)}.subnav .n{padding:0 7px;border-radius:99px;background:var(--code);color:var(--muted);font-size:.7rem}.subnav .n.warn{background:var(--warn-bg);color:var(--warn)}
/* ---- stat cards ---- */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:0 0 24px}
.stat{--c:var(--accent);position:relative;overflow:hidden;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm)}
.stat::after{content:"";position:absolute;right:-30px;top:-30px;width:110px;height:110px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,var(--c) 18%,transparent),transparent)}
.stat .ic{display:grid;place-items:center;width:36px;height:36px;border-radius:11px;color:var(--c);background:color-mix(in srgb,var(--c) 13%,transparent)}
.stat b{display:block;margin-top:14px;font-size:2rem;line-height:1;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.stat .l{display:block;margin-top:5px;color:var(--muted);font-size:.84rem}.stat .l em{font-style:normal;color:var(--faint)}
.stat.warn{--c:#d97706}.stat.ok{--c:#16a34a}.stat.violet{--c:var(--accent-2)}
/* ---- cards ---- */
section{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin:0 0 20px;box-shadow:var(--shadow-sm)}
section>h2,.card-h{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:0 0 4px;font-size:1.06rem;line-height:1.3;letter-spacing:-.018em}
section>h2 .i{width:19px;height:19px;color:var(--accent)}
.lead{margin:0 0 18px;color:var(--muted);font-size:.9rem;max-width:46rem}
.hint{margin:9px 0 0;color:var(--muted);font-size:.82rem}.hint+.row{margin-top:16px}
.count{padding:1px 9px;border-radius:99px;background:var(--code);color:var(--muted);font-size:.76rem;font-weight:650;font-variant-numeric:tabular-nums}
.empty{display:flex;flex-direction:column;align-items:center;gap:8px;margin:6px 0 4px;padding:26px 16px;border:1px dashed var(--line-2);border-radius:12px;color:var(--muted);text-align:center}.empty .i{width:26px;height:26px;color:var(--faint)}
/* ---- site list ---- */
.site-list{display:grid;gap:10px;margin:0 0 20px}
a.site{display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:6px 16px;padding:14px 16px;border:1px solid var(--line);border-radius:13px;background:var(--panel-2);color:inherit;text-decoration:none;transition:border-color .15s,box-shadow .15s,transform .15s}
a.site:hover{border-color:color-mix(in srgb,var(--accent) 50%,var(--line));box-shadow:var(--shadow);transform:translateY(-1px)}
.site-main{min-width:0}.site-main strong{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:.98rem;letter-spacing:-.01em}.site-main .host{display:block;margin-top:2px;color:var(--muted);font:.78rem var(--mono);overflow-wrap:anywhere}
.site-side{display:flex;align-items:center;gap:22px}
.site-badges{display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end}
.site-nums{display:flex;gap:20px}.site-nums>span{min-width:3.2rem;text-align:right;line-height:1.15}.site-nums b{display:block;font-size:1.08rem;font-variant-numeric:tabular-nums}.site-nums small{color:var(--muted);font-size:.7rem}
.site .go{color:var(--faint);transition:transform .15s,color .15s}a.site:hover .go{color:var(--accent);transform:translateX(2px)}
.add-site{padding-top:20px;border-top:1px solid var(--line)}
/* ---- tables ---- */
.table-wrap{overflow-x:auto;margin:0 -8px 12px;padding:0 8px}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{padding:11px 10px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-size:.7rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
tbody tr{transition:background .12s}tbody tr:hover{background:var(--panel-2)}tbody tr:last-child td{border-bottom:0}
td code{white-space:nowrap;word-break:normal}
.who{display:flex;align-items:center;gap:11px;min-width:0}.who .av{width:32px;height:32px;border-radius:10px;font-size:.7rem}
.num{text-align:right;font-variant-numeric:tabular-nums}.act{text-align:right;white-space:nowrap}.act form.inline{display:inline;margin:0 0 0 6px}
/* ---- forms ---- */
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
label{display:flex;flex-direction:column;gap:6px;color:var(--ink-2);font-size:.8rem;font-weight:620}
label.grow{flex:1 1 16rem}label.check{flex-direction:row;align-items:center;gap:9px;padding-bottom:9px;color:var(--ink);font-size:.9rem;font-weight:520}
input[type=text],input:not([type]),input[type=search],textarea{width:100%;min-width:12rem;padding:9px 12px;border:1px solid var(--line-2);border-radius:10px;background:var(--panel-2);color:var(--ink);font:inherit;transition:border-color .15s,box-shadow .15s,background .15s}
input:hover,textarea:hover{border-color:var(--faint)}
input:focus,textarea:focus{outline:none;border-color:var(--accent);background:var(--panel);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 20%,transparent)}
input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent)}
::placeholder{color:var(--ph);opacity:1}
textarea{resize:vertical;font:.86rem/1.5 var(--mono)}
a:focus-visible,button:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 60%,transparent);outline-offset:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:38px;padding:0 15px;border:1px solid var(--line-2);border-radius:10px;background:var(--panel);color:var(--ink);font:620 .86rem/1 var(--font);text-decoration:none;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s,box-shadow .15s,transform .1s,filter .15s}
.btn:hover{background:var(--panel-2);border-color:var(--faint)}.btn:active{transform:scale(.98)}
.btn .i{width:16px;height:16px}
.btn.primary{border-color:transparent;color:var(--accent-ink);background:linear-gradient(135deg,var(--accent),var(--accent-2));box-shadow:0 1px 0 rgba(255,255,255,.25) inset,0 8px 18px -10px var(--accent)}.btn.primary:hover{filter:brightness(1.07)}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 40%,var(--line-2));background:color-mix(in srgb,var(--bad) 5%,var(--panel))}.btn.danger:hover{background:var(--bad-bg);border-color:var(--bad)}
.btn.quiet{color:var(--muted);background:transparent;border-color:transparent}.btn.quiet:hover{background:var(--code);color:var(--ink)}
td .btn,.act .btn{min-height:32px;padding:0 12px;font-size:.8rem}
/* ---- pills, notices ---- */
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:99px;background:var(--code);color:var(--muted);font:650 .7rem/1.3 var(--font)}
.pill.on{background:var(--ok-bg);color:var(--ok)}.pill.off{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.info{background:var(--info-bg);color:var(--info)}
.flash{display:flex;align-items:flex-start;gap:11px;margin:0 0 22px;padding:13px 16px;border:1px solid transparent;border-radius:12px;font-size:.9rem;font-weight:540;animation:rise .35s cubic-bezier(.2,.8,.2,1) both}
.flash .i{margin-top:1px}.flash.good{background:var(--ok-bg);color:var(--ok);border-color:color-mix(in srgb,var(--ok) 25%,transparent)}.flash.bad{background:var(--bad-bg);color:var(--bad);border-color:color-mix(in srgb,var(--bad) 28%,transparent)}
.warn-zone{border-color:color-mix(in srgb,var(--warn) 40%,var(--line));background:linear-gradient(var(--warn-bg),var(--panel) 140px)}
.danger-zone{border-color:color-mix(in srgb,var(--bad) 32%,var(--line))}.danger-zone>h2 .i{color:var(--bad)}
.callout{padding:16px 18px;border:1px dashed var(--line-2);border-radius:12px;background:var(--panel-2)}.callout strong{display:block;margin-bottom:2px}.callout ul{margin:4px 0 14px;padding-left:1.2rem}
.code.key{white-space:pre-wrap;overflow-wrap:anywhere;user-select:all;font-size:.92rem}
.key-next{margin-top:22px}.key-done{margin-top:18px}
.modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:6px}
.mode{display:flex;flex-direction:column;gap:6px;padding:16px 18px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
.mode h3{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0;font-size:.95rem}
.mode h3 svg{width:18px;height:18px;flex:none;color:var(--muted)}
.mode .hint{margin:0}.mode ul{margin:4px 0 0;padding-left:1.2rem}
.mode form{margin-top:auto;padding-top:10px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
.mode.on{border-color:color-mix(in srgb,var(--accent) 55%,var(--line));background:color-mix(in srgb,var(--accent) 7%,var(--panel))}
.mode.on h3 svg{color:var(--accent)}
pre.code{margin:0;padding:15px 17px;overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel-2);font:.8rem/1.65 var(--mono);color:var(--ink-2);user-select:all}
/* ---- activity ---- */
.feed{margin:0;padding:0;list-style:none}
.feed li{position:relative;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:14px;align-items:start;padding:13px 0}
.feed li:not(:last-child)::before{content:"";position:absolute;left:17px;top:46px;bottom:-8px;width:1px;background:var(--line)}
.feed .ic{display:grid;place-items:center;width:35px;height:35px;border-radius:11px;color:var(--accent);background:color-mix(in srgb,var(--accent) 11%,transparent)}.feed .ic .i{width:17px;height:17px}
.feed strong{font-weight:620}.feed .what{overflow-wrap:anywhere}.feed .meta{display:block;margin-top:2px;color:var(--muted);font-size:.8rem}.feed time{color:var(--muted);font-size:.78rem;white-space:nowrap}
.feed-detail{color:var(--ink-2);overflow-wrap:anywhere}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:0 0 22px}
.mini{padding:13px 15px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.mini b{display:block;font-size:1.25rem;line-height:1.1;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.mini span{color:var(--muted);font-size:.78rem}
@keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@media (max-width:900px){
 .app{grid-template-columns:minmax(0,1fr)}
 .side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:12px 16px;border-right:0;border-bottom:1px solid var(--line)}
 .logo{padding:0 8px 0 0}.logo-text small{display:none}
 .nav:not(.sites-nav){flex-direction:row;flex-wrap:nowrap;order:3;flex:1 0 100%;overflow-x:auto;scrollbar-width:none}.nav:not(.sites-nav) a{flex:none}.nav a{padding:6px 11px}.nav a span:not(.n){display:inline}
 .side-title,.sites-nav{display:none}
 .me{margin:0 0 0 auto;padding:0;border:0}.me-text{display:none}
 main{padding-top:24px}
 a.site{grid-template-columns:auto minmax(0,1fr) auto}.site-side{grid-column:2/-1;grid-row:2;flex-wrap:wrap;gap:10px 20px}.site-badges{justify-content:flex-start}
}
details.snippet{margin-top:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel-2)}
details.snippet summary{display:flex;align-items:center;gap:8px;padding:11px 14px;color:var(--ink-2);font-weight:600;font-size:.86rem;cursor:pointer;list-style:none;border-radius:12px}
details.snippet summary::-webkit-details-marker{display:none}details.snippet summary::after{content:"";margin-left:auto;width:8px;height:8px;border:solid var(--faint);border-width:0 2px 2px 0;transform:rotate(45deg);transition:transform .15s}
details.snippet[open] summary::after{transform:rotate(-135deg)}details.snippet summary:hover{color:var(--ink)}
details.snippet pre.code{margin:0;border:0;border-top:1px solid var(--line);border-radius:0 0 12px 12px}
@media (max-width:640px){
 /* Tables become stacked rows: nothing is clipped, and the action buttons wrap under what they act on. */
 .table-wrap table,.table-wrap tbody,.table-wrap tr,.table-wrap td{display:block}.table-wrap thead{display:none}
 .table-wrap tr{padding:12px 4px;border-bottom:1px solid var(--line)}.table-wrap tbody tr:last-child{border-bottom:0}.table-wrap td{padding:3px 0;border:0}
 .table-wrap td.act{padding-top:10px;text-align:left;white-space:normal}.table-wrap .act form.inline{display:inline-block;margin:0 8px 6px 0}
 .table-wrap .hide-sm,.hide-sm{display:none}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.stat{padding:14px}.stat b{font-size:1.65rem;margin-top:10px}.cols{grid-template-columns:repeat(2,minmax(0,1fr))}.table-wrap{margin:0 -4px}th,td{padding:10px 6px}}
@media (max-width:560px){input[type=text],input:not([type]){min-width:0}.row>label{flex:1 1 100%}.row>.btn{flex:1 1 100%}.page-head h1,.site-head h1{font-size:1.4rem}.site-head{align-items:flex-start}.av.lg{width:46px;height:46px}.feed li{grid-template-columns:auto minmax(0,1fr)}.feed time{grid-column:2}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}html{scroll-behavior:auto}}
`;
