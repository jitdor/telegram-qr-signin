// The hub's admin console: server-rendered HTML, no JavaScript, no external requests.
//
// It sits behind the same QR sign-in as everything else, under the reserved "hub-admin" namespace,
// and the gate is "is a super admin" — checked live on every request (auth.guard), so removing a
// super admin takes effect on their very next click.
//
// What stands between a signed-in admin's browser and a state change, in order:
//   1. The session cookie (HttpOnly, Secure, SameSite=Lax, Path=<adminPath>).
//   2. The Origin header, when the browser sends one, must be this site.
//   3. A CSRF token in the form, derived from the session (HMAC of its id and sign-in time), so one
//      admin's token is useless on another's session and a new sign-in invalidates old pages.
//   4. Strict validation of every id and name (./validate.js) — nothing from a form reaches SQL
//      except as a bound parameter, and nothing reaches HTML except through escapeHtml.
//
// Every mutation is written to the audit log. Redirects after a POST carry a fixed message CODE,
// never message text, so a crafted link cannot make the console say something it did not.

import { escapeHtml as esc } from "../login-page.js";
import { hmacSha256, toHex, timingSafeEqualHex } from "../crypto.js";
import {
  ACCESS_MODES,
  OriginInUseError,
  NAMESPACE_RE,
  assertSiteNamespace,
  cleanLabel,
  cleanName,
  describeUser,
  normalizeOrigin,
  parseTelegramId,
  parseTelegramIds,
  suggestNamespace,
} from "./validate.js";

const MAX_IDS_PER_SUBMIT = 200;
const AUDIT_ROWS_SHOWN = 40;

const OK_MESSAGES = {
  site_created: "Site added. Point its Worker at this namespace, then grant people access below.",
  site_saved: "Site settings saved.",
  origin_added: "URL added. The site can now be served from it.",
  origin_removed: "URL removed. Requests from it are refused from now on.",
  site_deleted: "Site deleted, along with its users.",
  grants_added: (n) => `Granted access to ${n} ${n === 1 ? "person" : "people"}.`,
  grants_none: "Everyone listed already had access.",
  grant_removed: "Access revoked. It applies on their next request.",
  request_approved: "Approved. They can sign in now.",
  request_dismissed: "Request dismissed.",
  request_blocked: "Blocked, and the request removed.",
  access_open: "This site is now open to anyone with a Telegram account, except people you block.",
  access_granted: "This site now requires approval. People without a grant are locked out on their next request.",
  blocks_added: (n) => `Blocked ${n} ${n === 1 ? "person" : "people"}. It applies on their next request.`,
  blocks_none: "Everyone listed was already blocked.",
  block_removed: "Unblocked.",
  admin_added: "Super admin added.",
  admin_removed: "Super admin removed.",
};

const ERR_MESSAGES = {
  bad_namespace: "A site id is 1–24 letters, digits or hyphens (no underscore).",
  reserved_namespace: "That id is reserved for the console itself.",
  site_exists: "A site with that id already exists.",
  bad_url: "Enter the site's full URL, such as https://docs.example.com (https only; http is allowed for localhost).",
  origin_exists: "That URL is already registered for this site.",
  origin_in_use: "That URL already belongs to another site. A URL can belong to only one site, because a site finds its own id from the URL it is served at.",
  origin_last: "A site must keep at least one URL. Add the new one first, then remove this one.",
  origin_missing: "That URL is not registered for this site.",
  too_many_origins: "A site can have at most 10 URLs.",
  site_missing: "That site no longer exists.",
  no_ids: "Enter at least one Telegram user id.",
  bad_ids: "Some entries are not Telegram user ids — they are digits only, such as 123456789. Nothing was added.",
  too_many_ids: `Add at most ${MAX_IDS_PER_SUBMIT} people at a time.`,
  request_gone: "That request is already gone.",
  bad_id: "That is not a Telegram user id — digits only.",
  admin_exists: "They are already a super admin.",
  admin_root: "That super admin is set in the hub's configuration and cannot be changed here.",
  admin_self: "You cannot remove yourself. Ask another super admin.",
  admin_missing: "That super admin no longer exists.",
  confirm_mismatch: "The confirmation did not match, so nothing was deleted.",
  confirm_open: "To open a site to everyone, type its id in the box to confirm. Nothing was changed.",
  bad_mode: "That is not a valid setting.",
  bad_request: "That request could not be processed. Reload the page and try again.",
  failed: "Something went wrong and the change may not have been saved. Check the logs.",
};

const SECURITY_HEADERS = {
  "Content-Type": "text/html; charset=UTF-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  // NOT "no-referrer": browsers answer that policy by sending `Origin: null` on same-origin form
  // POSTs too, which the Origin check below would (correctly) refuse — every form would fail.
  "Referrer-Policy": "same-origin",
};

/**
 * @param {object} options
 * @param {object} options.auth        createTelegramQrAuth for the "hub-admin" namespace, mounted so
 *   that its basePath is `${adminPath}/auth`.
 * @param {object} options.registry    A HubStore.
 * @param {number[]} options.rootAdmins  Bootstrap admins: shown, never removable here.
 * @param {string} options.adminPath   e.g. "/admin".
 * @param {string} options.secret      Session secret, from which the CSRF key is derived.
 * @param {(err: unknown) => void} [options.onError]
 */
export function createAdminConsole({ auth, registry, rootAdmins, adminPath, secret, onError = defaultOnError }) {
  const roots = new Set(rootAdmins);
  const authPrefix = `${adminPath}/auth/`;
  const csrfKey = hmacSha256(new TextEncoder().encode("TelegramQrHubCsrfKey"), secret);

  async function csrfFor(session) {
    return toHex(await hmacSha256(await csrfKey, `${session.id}.${session.iat}`));
  }

  /** Returns a Response if this request is the console's, else null. */
  async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith(authPrefix)) {
      const response = await auth.handle(request);
      return framed(response ?? plain("Not found", 404));
    }
    if (path !== adminPath && path !== `${adminPath}/` && !path.startsWith(`${adminPath}/`)) return null;

    const gate = await auth.guard(request);
    if (!gate.ok) return framed(gate.response);

    try {
      return await route(request, url, gate.session);
    } catch (err) {
      onError(err);
      // A failed page load answers 500 itself: redirecting to the dashboard could loop if the
      // dashboard is what is failing. A failed POST goes back to the dashboard with a notice.
      return request.method === "POST" ? redirect(adminPath, { err: "failed" }) : plain("Something went wrong. Check the Worker logs.", 500);
    }
  }

  async function route(request, url, session) {
    const rest = url.pathname.slice(adminPath.length).split("/").filter(Boolean);
    const isRead = request.method === "GET" || request.method === "HEAD";
    const isPost = request.method === "POST";
    if (!isRead && !isPost) return plain("Method not allowed", 405, { Allow: "GET, HEAD, POST" });

    const ctx = { request, url, session, csrf: await csrfFor(session) };

    if (isRead) {
      if (rest.length === 0) return dashboard(ctx);
      if (rest.length === 2 && rest[0] === "ns" && NAMESPACE_RE.test(rest[1])) return sitePage(ctx, rest[1]);
      return plain("Not found", 404);
    }

    const form = await readForm(ctx);
    if (!form) return redirect(adminPath, { err: "bad_request" });
    ctx.form = form;

    const [a, b, c, d, e] = rest;
    if (a === "ns" && rest.length === 1) return createSite(ctx);
    if (a === "ns" && b === "new" && rest.length === 2) return newSite(ctx);
    if (a === "ns" && NAMESPACE_RE.test(b ?? "")) {
      if (c === "update" && rest.length === 3) return updateSite(ctx, b);
      if (c === "delete" && rest.length === 3) return deleteSite(ctx, b);
      if (c === "grants" && rest.length === 3) return addGrants(ctx, b);
      if (c === "grants" && e === "remove" && rest.length === 5) return removeGrant(ctx, b, d);
      if (c === "access" && rest.length === 3) return setAccess(ctx, b);
      if (c === "origins" && rest.length === 3) return addOrigin(ctx, b);
      if (c === "origins" && d === "remove" && rest.length === 4) return removeOrigin(ctx, b);
      if (c === "blocks" && rest.length === 3) return addBlocks(ctx, b);
      if (c === "blocks" && e === "remove" && rest.length === 5) return removeBlock(ctx, b, d);
      if (c === "requests" && (e === "approve" || e === "dismiss" || e === "block") && rest.length === 5) return answerRequest(ctx, b, d, e);
    }
    if (a === "admins" && rest.length === 1) return addAdmin(ctx);
    if (a === "admins" && c === "remove" && rest.length === 3) return removeAdmin(ctx, b);
    return plain("Not found", 404);
  }

  /** The parsed form, or null if the request fails the origin or CSRF check. */
  async function readForm({ request, url, csrf }) {
    const origin = request.headers.get("Origin");
    if (origin !== null && origin !== url.origin) return null;
    let form;
    try {
      form = await request.formData();
    } catch {
      return null;
    }
    const presented = String(form.get("csrf") ?? "");
    return presented.length === csrf.length && timingSafeEqualHex(presented, csrf) ? form : null;
  }

  async function audit(session, action, target = "", detail = "") {
    try {
      await registry.appendAudit({ actor: Number(session.id), action, target, detail: String(detail).slice(0, 240) });
    } catch (err) {
      // The change has already happened; a log failure must not turn it into an error page.
      onError(err);
    }
  }

  // --- Pages -----------------------------------------------------------------------------------

  async function dashboard(ctx) {
    const [sites, admins, log] = await Promise.all([registry.listNamespaces(), registry.listAdmins(), registry.listAudit({ limit: AUDIT_ROWS_SHOWN })]);
    const adminRows = [
      ...[...roots].map((id) => ({ id, label: "", root: true })),
      ...admins.filter((a) => !roots.has(a.id)).map((a) => ({ ...a, root: false })),
    ];

    const body = `
${flash(ctx.url)}
<section>
  <h2>Sites</h2>
  <p class="lead">Each site is a namespace on this bot. A person can sign in to a site only if they are granted access to it here.</p>
  ${
    sites.length
      ? `<div class="table-wrap"><table>
    <thead><tr><th>Site</th><th>Namespace</th><th>Status</th><th class="num">People</th><th class="num">Waiting</th><th></th></tr></thead>
    <tbody>${sites
      .map(
        (s) => `<tr>
      <td><a href="${adminPath}/ns/${esc(s.namespace)}">${esc(s.name)}</a><br>${
        s.origins.length
          ? `<span class="muted small">${esc(s.origins[0])}${s.origins.length > 1 ? ` +${s.origins.length - 1}` : ""}</span>`
          : '<span class="pill warn" title="Any Worker with the shared bindings can use this namespace">Not bound to a URL</span>'
      }</td>
      <td><code>${esc(s.namespace)}</code></td>
      <td>${s.enabled ? '<span class="pill on">On</span>' : '<span class="pill off">Off</span>'}</td>
      <td class="num">${s.access === "anyone" ? '<span class="pill warn">Anyone</span>' : s.users}</td>
      <td class="num">${s.access === "anyone" ? "—" : s.requests ? `<span class="pill warn">${s.requests}</span>` : "0"}</td>
      <td class="act"><a class="btn quiet" href="${adminPath}/ns/${esc(s.namespace)}">Manage</a></td>
    </tr>`
      )
      .join("")}</tbody></table></div>`
      : '<p class="empty">No sites yet. Add the first one below.</p>'
  }
  ${postForm(ctx, `${adminPath}/ns/new`, `
    <div class="row">
      <label>Display name<input name="name" maxlength="60" placeholder="Acme dashboard" autocomplete="off"></label>
      <label>Site URL<input name="url" required maxlength="200" placeholder="https://acme.example.com" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <button class="btn primary">Continue</button>
    </div>
    <p class="hint">Next you will confirm the site's id, which is suggested from these and can be changed before you save.</p>`)}
</section>

<section>
  <h2>Super admins</h2>
  <p class="lead">Can use this console: add sites, grant and revoke access, and add other super admins. Being a super admin does not by itself let you into any site.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Telegram id</th><th>Note</th><th>Source</th><th></th></tr></thead>
    <tbody>${adminRows
      .map(
        (a) => `<tr>
      <td><code>${a.id}</code>${a.id === Number(ctx.session.id) ? ' <span class="pill">you</span>' : ""}</td>
      <td>${esc(a.label)}</td>
      <td>${a.root ? "Hub configuration" : `Console${a.addedBy ? `, added by <code>${a.addedBy}</code>` : ""}`}</td>
      <td class="act">${
        a.root || a.id === Number(ctx.session.id)
          ? ""
          : postForm(ctx, `${adminPath}/admins/${a.id}/remove`, '<button class="btn danger">Remove</button>', "inline")
      }</td>
    </tr>`
      )
      .join("")}</tbody></table></div>
  ${postForm(ctx, `${adminPath}/admins`, `
    <div class="row">
      <label>Telegram user id<input name="id" required inputmode="numeric" pattern="[0-9]{1,15}" placeholder="123456789" autocomplete="off"></label>
      <label>Note<input name="label" maxlength="80" placeholder="Who is this?" autocomplete="off"></label>
      <button class="btn primary">Add super admin</button>
    </div>`)}
</section>

<section>
  <h2>Recent activity</h2>
  ${auditTable(log)}
</section>`;
    return page("Hub admin", body, ctx);
  }

  async function sitePage(ctx, namespace) {
    const site = await registry.getNamespace(namespace);
    if (!site) return page("Not found", `<p class="empty">That site does not exist. <a href="${adminPath}">Back to all sites</a>.</p>`, ctx, 404);
    const open = site.access === "anyone";
    const [grants, blocks, requests] = await Promise.all([
      registry.listGrants(namespace),
      registry.listBlocks(namespace),
      open ? [] : registry.listRequests(namespace), // an open site has nobody to approve
    ]);
    const base = `${adminPath}/ns/${namespace}`; // namespace already matched NAMESPACE_RE

    const body = `
<p class="crumb"><a href="${adminPath}">&larr; All sites</a></p>
${flash(ctx.url)}
<section>
  <h2>${esc(site.name)} ${site.enabled ? '<span class="pill on">On</span>' : '<span class="pill off">Off</span>'}</h2>
  <p class="lead">Id <code>${esc(namespace)}</code>. The site's code does not need it: <code>createSiteAuth({ registry, store, botUsername, session })</code> finds this site from the URL it is served at.</p>
  ${postForm(ctx, `${base}/update`, `
    <div class="row">
      <label>Display name<input name="name" value="${esc(site.name)}" required maxlength="60" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="enabled" value="1"${site.enabled ? " checked" : ""}> Sign-in enabled</label>
      <button class="btn primary">Save</button>
    </div>
    <p class="hint">Switching a site off locks everyone out of it on their next request. Their access is kept for when you switch it back on.</p>`)}
</section>

${
  site.origins.length
    ? ""
    : `<section class="warn-zone">
  <h2>Not bound to a URL</h2>
  <p class="lead">This site was registered before sites were bound to URLs, so any Worker with the hub's shared bindings can use this id, and a site cannot find it from its URL. Add the URL it is served from, below, to close that.</p>
</section>`
}

<section>
  <h2>Site URLs <span class="count">${site.origins.length}</span></h2>
  <p class="lead">The site finds its own id from the address it is reached at, so each URL can belong to only one site, and a visitor reaching the site at any other address is refused, as is a QR code shown anywhere else. Use the address as it appears in the browser, for example both your custom domain and its <code>workers.dev</code> address if people can reach either.</p>
  ${
    site.origins.length
      ? `<div class="table-wrap"><table>
    <thead><tr><th>Origin</th><th></th></tr></thead>
    <tbody>${site.origins
      .map(
        (o) => `<tr>
      <td><code>${esc(o)}</code></td>
      <td class="act">${
        site.origins.length > 1
          ? postForm(ctx, `${base}/origins/remove`, `<input type="hidden" name="origin" value="${esc(o)}"><button class="btn danger">Remove</button>`, "inline")
          : '<span class="muted small">only URL</span>'
      }</td>
    </tr>`
      )
      .join("")}</tbody></table></div>`
      : ""
  }
  ${postForm(ctx, `${base}/origins`, `
    <div class="row">
      <label class="grow">Add a URL<input name="url" required maxlength="200" placeholder="https://acme.example.com" autocomplete="off" spellcheck="false" inputmode="url"></label>
      <button class="btn primary">Add URL</button>
    </div>
    <p class="hint">Scheme and host (and port, if not the default) are what count; any path is ignored. Removing a URL stops working for people on it immediately.</p>`)}
</section>

${
  open
    ? `<section class="warn-zone">
  <h2>Who can sign in <span class="pill warn">Anyone with Telegram</span></h2>
  <p class="lead">Any Telegram account can sign in to this site unless it is blocked below. This site is responsible for its own accounts and moderation: the hub only proves who someone is.</p>
  ${postForm(ctx, `${base}/access`, `
    <input type="hidden" name="mode" value="granted">
    <div class="row"><button class="btn primary">Require approval again</button></div>
    <p class="hint">People without a grant are locked out on their next request. Grants made earlier are still there.</p>`)}
</section>`
    : `<section>
  <h2>Who can sign in <span class="pill">Approved people only</span></h2>
  <p class="lead">Only the people you grant access to below can sign in to this site.</p>
  <div class="callout">
    <strong>Open this site to anyone with a Telegram account</strong>
    <p class="hint">For public sites such as a forum. Before you do:</p>
    <ul class="hint">
      <li>Anyone can sign in. The grant list below stops being used (it is kept, in case you switch back).</li>
      <li>The hub only proves who someone is. The site must keep its own accounts, keyed on the Telegram id, and do its own moderation and rate limiting.</li>
      <li>You can still block individual people.</li>
    </ul>
    ${postForm(ctx, `${base}/access`, `
      <input type="hidden" name="mode" value="anyone">
      <div class="row">
        <label><span>Type <code>${esc(namespace)}</code> to confirm</span><input name="confirm" required autocomplete="off" spellcheck="false"></label>
        <button class="btn danger">Open to anyone</button>
      </div>`)}
  </div>
</section>`
}

${
  requests.length
    ? `<section>
  <h2>Waiting for approval <span class="pill warn">${requests.length}</span></h2>
  <p class="lead">These people scanned this site's QR code and were turned away. Approve to grant access, dismiss to forget the request, or block to refuse them for good.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Person</th><th>Telegram id</th><th class="num">Tries</th><th>Last seen</th><th></th></tr></thead>
    <tbody>${requests
      .map((r) => {
        const who = describeUser({ first_name: r.firstName, last_name: r.lastName, username: r.username });
        return `<tr>
      <td>${who ? esc(who) : '<span class="muted">no name</span>'}</td>
      <td><code>${r.id}</code></td>
      <td class="num">${r.attempts}</td>
      <td>${when(r.lastSeen)}</td>
      <td class="act">
        ${postForm(ctx, `${base}/requests/${r.id}/approve`, '<button class="btn primary">Approve</button>', "inline")}
        ${postForm(ctx, `${base}/requests/${r.id}/dismiss`, '<button class="btn quiet">Dismiss</button>', "inline")}
        ${postForm(ctx, `${base}/requests/${r.id}/block`, '<button class="btn danger">Block</button>', "inline")}
      </td></tr>`;
      })
      .join("")}</tbody></table></div>
</section>`
    : ""
}

<section>
  <h2>People with access <span class="count">${grants.length}${grants.length >= 500 ? "+" : ""}</span></h2>
  ${open ? '<p class="lead">Not used while this site is open to anyone. Kept in case you require approval again.</p>' : ""}
  ${postForm(ctx, `${base}/grants`, `
    <div class="row">
      <label class="grow">Telegram user ids<textarea name="ids" rows="2" required placeholder="123456789, 987654321" spellcheck="false"></textarea></label>
      <label>Note (optional)<input name="label" maxlength="80" placeholder="e.g. Finance team" autocomplete="off"></label>
      <button class="btn primary">Grant access</button>
    </div>
    <p class="hint">Separate ids with commas, spaces or new lines.${open ? "" : " If you do not know someone's id, ask them to scan this site's QR code: they will appear under <em>Waiting for approval</em>."}</p>`)}
  ${
    grants.length
      ? `<div class="table-wrap"><table>
    <thead><tr><th>Telegram id</th><th>Note</th><th>Added</th><th></th></tr></thead>
    <tbody>${grants
      .map(
        (g) => `<tr>
      <td><code>${g.id}</code></td>
      <td>${esc(g.label)}</td>
      <td>${when(g.addedAt)}${g.addedBy ? ` by <code>${g.addedBy}</code>` : ""}</td>
      <td class="act">${postForm(ctx, `${base}/grants/${g.id}/remove`, '<button class="btn danger">Revoke</button>', "inline")}</td>
    </tr>`
      )
      .join("")}</tbody></table></div>`
      : '<p class="empty">Nobody can sign in to this site yet.</p>'
  }
</section>

<section>
  <h2>Blocked people <span class="count">${blocks.length}${blocks.length >= 500 ? "+" : ""}</span></h2>
  <p class="lead">Refused by this site whatever else is true of them: even with a grant, and even while the site is open to anyone. It applies on their next request.</p>
  ${postForm(ctx, `${base}/blocks`, `
    <div class="row">
      <label class="grow">Telegram user ids<textarea name="ids" rows="2" required placeholder="123456789" spellcheck="false"></textarea></label>
      <label>Note (optional)<input name="label" maxlength="80" placeholder="e.g. spam" autocomplete="off"></label>
      <button class="btn danger">Block</button>
    </div>
    ${open ? '<p class="hint">On an open site the hub never sees who is signed up. The site knows its own members\' Telegram ids: take the id from the member you are banning.</p>' : ""}`)}
  ${
    blocks.length
      ? `<div class="table-wrap"><table>
    <thead><tr><th>Telegram id</th><th>Note</th><th>Blocked</th><th></th></tr></thead>
    <tbody>${blocks
      .map(
        (b) => `<tr>
      <td><code>${b.id}</code></td>
      <td>${esc(b.label)}</td>
      <td>${when(b.addedAt)}${b.addedBy ? ` by <code>${b.addedBy}</code>` : ""}</td>
      <td class="act">${postForm(ctx, `${base}/blocks/${b.id}/remove`, '<button class="btn quiet">Unblock</button>', "inline")}</td>
    </tr>`
      )
      .join("")}</tbody></table></div>`
      : '<p class="empty">Nobody is blocked.</p>'
  }
</section>

<section class="danger-zone">
  <h2>Delete this site</h2>
  <p class="lead">Removes the site, its grants and its block list. The site's Worker will refuse every sign-in until you add the namespace again.</p>
  ${postForm(ctx, `${base}/delete`, `
    <div class="row">
      <label><span>Type <code>${esc(namespace)}</code> to confirm</span><input name="confirm" required autocomplete="off" spellcheck="false"></label>
      <button class="btn danger">Delete site</button>
    </div>`)}
</section>`;
    return page(site.name, body, ctx);
  }

  // --- Actions ---------------------------------------------------------------------------------

  /**
   * Step one of adding a site: take the name and URL, and show a confirmation page with a suggested
   * id the admin can edit before anything is saved. Nothing is written here. It is a POST rather
   * than a link so that only the admin's own form can produce it: a crafted link that pre-filled a
   * URL would be a way to get someone to bind a site they did not mean to.
   */
  async function newSite(ctx) {
    const origin = normalizeOrigin(String(ctx.form.get("url") ?? ""));
    if (!origin) return redirect(adminPath, { err: "bad_url" });
    if ((await registry.namespacesForOrigin(origin)).length) return redirect(adminPath, { err: "origin_in_use" });
    const name = cleanName(ctx.form.get("name"));
    const taken = (await registry.listNamespaces()).map((site) => site.namespace);
    const namespace = suggestNamespace({ name, url: origin }, taken);

    const body = `
<p class="crumb"><a href="${adminPath}">&larr; All sites</a></p>
<section>
  <h2>Add a site</h2>
  <p class="lead">Check the id before saving. It identifies this site in the QR code and in its stored access list, and it cannot be changed afterwards.</p>
  ${postForm(ctx, `${adminPath}/ns`, `
    <div class="row">
      <label>Id<input name="namespace" value="${esc(namespace)}" required maxlength="24" pattern="[A-Za-z0-9\\-]{1,24}" autocomplete="off" spellcheck="false"></label>
      <label>Display name<input name="name" value="${esc(name)}" maxlength="60" placeholder="${esc(namespace)}" autocomplete="off"></label>
      <label class="grow">Site URL<input name="url" value="${esc(origin)}" required maxlength="200" autocomplete="off" spellcheck="false" inputmode="url"></label>
    </div>
    <p class="hint">Suggested from ${name ? "the display name" : "the URL"}. Letters, digits and hyphens, up to 24. The site's code does not need to know it: the site finds its id from its URL.</p>
    <div class="row"><button class="btn primary">Add site</button> <a class="btn quiet" href="${adminPath}">Cancel</a></div>`)}
</section>`;
    return page("Add a site", body, ctx);
  }

  async function createSite({ form, session }) {
    const namespace = String(form.get("namespace") ?? "").trim();
    try {
      assertSiteNamespace(namespace);
    } catch (err) {
      return redirect(adminPath, { err: /reserved/.test(err.message) ? "reserved_namespace" : "bad_namespace" });
    }
    const origin = normalizeOrigin(String(form.get("url") ?? ""));
    if (!origin) return redirect(adminPath, { err: "bad_url" });
    const name = cleanName(form.get("name")) || namespace;
    let created;
    try {
      created = await registry.createNamespace({ namespace, name, origins: [origin], createdBy: Number(session.id) });
    } catch (err) {
      if (err instanceof OriginInUseError) return redirect(adminPath, { err: "origin_in_use" });
      throw err;
    }
    if (!created) return redirect(adminPath, { err: "site_exists" });
    await audit(session, "site.create", namespace, `${name}; ${origin}`);
    return redirect(`${adminPath}/ns/${namespace}`, { ok: "site_created" });
  }

  async function updateSite({ form, session }, namespace) {
    const before = await registry.getNamespace(namespace);
    if (!before) return redirect(adminPath, { err: "site_missing" });
    const name = form.has("name") ? cleanName(form.get("name")) || namespace : undefined;
    const enabled = form.get("enabled") === "1";
    await registry.updateNamespace(namespace, { name, enabled });

    const changes = [];
    if (name !== undefined && name !== before.name) changes.push(`name "${before.name}" -> "${name}"`);
    if (enabled !== before.enabled) changes.push(enabled ? "enabled" : "disabled");
    if (changes.length) await audit(session, "site.update", namespace, changes.join("; "));
    return redirect(`${adminPath}/ns/${namespace}`, { ok: "site_saved" });
  }

  async function addOrigin({ form, session }, namespace) {
    const site = await registry.getNamespace(namespace);
    if (!site) return redirect(adminPath, { err: "site_missing" });
    const back = `${adminPath}/ns/${namespace}`;
    const origin = normalizeOrigin(String(form.get("url") ?? ""));
    if (!origin) return redirect(back, { err: "bad_url" });
    if (site.origins.length >= 10) return redirect(back, { err: "too_many_origins" });
    let added;
    try {
      added = await registry.addOrigin(namespace, origin);
    } catch (err) {
      if (err instanceof OriginInUseError) return redirect(back, { err: "origin_in_use" });
      throw err;
    }
    if (!added) return redirect(back, { err: "origin_exists" });
    await audit(session, "origin.add", namespace, origin);
    return redirect(back, { ok: "origin_added" });
  }

  async function removeOrigin({ form, session }, namespace) {
    const site = await registry.getNamespace(namespace);
    if (!site) return redirect(adminPath, { err: "site_missing" });
    const back = `${adminPath}/ns/${namespace}`;
    const origin = normalizeOrigin(String(form.get("origin") ?? ""));
    if (!origin || !site.origins.includes(origin)) return redirect(back, { err: "origin_missing" });
    if (!(await registry.removeOrigin(namespace, origin))) return redirect(back, { err: "origin_last" });
    await audit(session, "origin.remove", namespace, origin);
    return redirect(back, { ok: "origin_removed" });
  }

  async function setAccess({ form, session }, namespace) {
    const before = await registry.getNamespace(namespace);
    if (!before) return redirect(adminPath, { err: "site_missing" });
    const back = `${adminPath}/ns/${namespace}`;
    const mode = String(form.get("mode") ?? "");
    if (!ACCESS_MODES.includes(mode)) return redirect(back, { err: "bad_mode" });
    if (mode === before.access) return redirect(back);

    // Widening access to the whole world is the one change here that cannot be walked back for the
    // people who sign in meanwhile, so it takes a deliberate act. Narrowing again needs none.
    if (mode === "anyone" && String(form.get("confirm") ?? "").trim() !== namespace) {
      return redirect(back, { err: "confirm_open" });
    }
    await registry.updateNamespace(namespace, { access: mode });
    await audit(session, "site.access", namespace, `${before.access} -> ${mode}`);
    return redirect(back, { ok: mode === "anyone" ? "access_open" : "access_granted" });
  }

  async function deleteSite({ form, session }, namespace) {
    const site = await registry.getNamespace(namespace);
    if (!site) return redirect(adminPath, { err: "site_missing" });
    if (String(form.get("confirm") ?? "").trim() !== namespace) {
      return redirect(`${adminPath}/ns/${namespace}`, { err: "confirm_mismatch" });
    }
    const people = (await registry.listGrants(namespace, { limit: 100000 })).length;
    await registry.deleteNamespace(namespace);
    await audit(session, "site.delete", namespace, `${site.name}; ${people} people had access`);
    return redirect(adminPath, { ok: "site_deleted" });
  }

  async function addGrants({ form, session }, namespace) {
    if (!(await registry.getNamespace(namespace))) return redirect(adminPath, { err: "site_missing" });
    const back = `${adminPath}/ns/${namespace}`;
    const { ids, invalid } = parseTelegramIds(form.get("ids"));
    if (invalid.length) return redirect(back, { err: "bad_ids" });
    if (!ids.length) return redirect(back, { err: "no_ids" });
    if (ids.length > MAX_IDS_PER_SUBMIT) return redirect(back, { err: "too_many_ids" });

    const label = cleanLabel(form.get("label"));
    const added = [];
    for (const id of ids) {
      if (await registry.addGrant({ namespace, id, label, addedBy: Number(session.id) })) added.push(id);
    }
    if (!added.length) return redirect(back, { ok: "grants_none" });
    await audit(session, "grant.add", namespace, `${added.length}: ${added.join(", ")}`);
    return redirect(back, { ok: "grants_added", n: added.length });
  }

  async function addBlocks({ form, session }, namespace) {
    if (!(await registry.getNamespace(namespace))) return redirect(adminPath, { err: "site_missing" });
    const back = `${adminPath}/ns/${namespace}`;
    const { ids, invalid } = parseTelegramIds(form.get("ids"));
    if (invalid.length) return redirect(back, { err: "bad_ids" });
    if (!ids.length) return redirect(back, { err: "no_ids" });
    if (ids.length > MAX_IDS_PER_SUBMIT) return redirect(back, { err: "too_many_ids" });

    const label = cleanLabel(form.get("label"));
    const added = [];
    for (const id of ids) {
      if (await registry.addBlock({ namespace, id, label, addedBy: Number(session.id) })) added.push(id);
      // Someone being banned has no business in the approval queue. Their grant, if any, stays: the
      // block outranks it, and unblocking them should not also silently erase their access.
      await registry.removeRequest(namespace, id);
    }
    if (!added.length) return redirect(back, { ok: "blocks_none" });
    await audit(session, "block.add", namespace, `${added.length}: ${added.join(", ")}`);
    return redirect(back, { ok: "blocks_added", n: added.length });
  }

  async function removeBlock({ session }, namespace, idText) {
    const id = parseTelegramId(idText);
    const back = `${adminPath}/ns/${namespace}`;
    if (id === null) return redirect(back, { err: "bad_id" });
    if (await registry.removeBlock(namespace, id)) await audit(session, "block.remove", namespace, String(id));
    return redirect(back, { ok: "block_removed" });
  }

  async function removeGrant({ session }, namespace, idText) {
    const id = parseTelegramId(idText);
    const back = `${adminPath}/ns/${namespace}`;
    if (id === null) return redirect(back, { err: "bad_id" });
    if (await registry.removeGrant(namespace, id)) await audit(session, "grant.remove", namespace, String(id));
    return redirect(back, { ok: "grant_removed" });
  }

  async function answerRequest({ session }, namespace, idText, verdict) {
    const id = parseTelegramId(idText);
    const back = `${adminPath}/ns/${namespace}`;
    if (id === null) return redirect(back, { err: "bad_id" });
    const request = await registry.getRequest(namespace, id);
    if (!request) return redirect(back, { err: "request_gone" });

    if (verdict === "block") {
      const note = describeUser({ first_name: request.firstName, last_name: request.lastName, username: request.username });
      await registry.addBlock({ namespace, id, label: note, addedBy: Number(session.id) });
      await registry.removeRequest(namespace, id);
      await audit(session, "block.add", namespace, `${id} (from request)`);
      return redirect(back, { ok: "request_blocked" });
    }
    if (verdict === "dismiss") {
      await registry.removeRequest(namespace, id);
      await audit(session, "request.dismiss", namespace, String(id));
      return redirect(back, { ok: "request_dismissed" });
    }
    const label = describeUser({ first_name: request.firstName, last_name: request.lastName, username: request.username });
    await registry.addGrant({ namespace, id, label, addedBy: Number(session.id) });
    await registry.removeRequest(namespace, id);
    await audit(session, "grant.add", namespace, `${id} (approved request)`);
    return redirect(back, { ok: "request_approved" });
  }

  async function addAdmin({ form, session }) {
    const id = parseTelegramId(form.get("id"));
    if (id === null) return redirect(adminPath, { err: "bad_id" });
    if (roots.has(id)) return redirect(adminPath, { err: "admin_exists" });
    if (!(await registry.addAdmin({ id, label: cleanLabel(form.get("label")), addedBy: Number(session.id) }))) {
      return redirect(adminPath, { err: "admin_exists" });
    }
    await audit(session, "admin.add", String(id));
    return redirect(adminPath, { ok: "admin_added" });
  }

  async function removeAdmin({ session }, idText) {
    const id = parseTelegramId(idText);
    if (id === null) return redirect(adminPath, { err: "bad_id" });
    if (roots.has(id)) return redirect(adminPath, { err: "admin_root" });
    if (id === Number(session.id)) return redirect(adminPath, { err: "admin_self" });
    if (!(await registry.removeAdmin(id))) return redirect(adminPath, { err: "admin_missing" });
    await audit(session, "admin.remove", String(id));
    return redirect(adminPath, { ok: "admin_removed" });
  }

  // --- Rendering -------------------------------------------------------------------------------

  function page(title, body, ctx, status = 200) {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · Hub admin</title>
<style>${STYLES}</style>
</head>
<body>
<header class="bar">
  <a class="brand" href="${adminPath}">Hub admin</a>
  <span class="who">${esc(ctx.session.name)} <span class="muted">· ${esc(ctx.session.id)}</span> · <a href="${adminPath}/auth/logout">Sign out</a></span>
</header>
<main>${body}</main>
</body>
</html>`;
    return new Response(ctx.request.method === "HEAD" ? null : html, { status, headers: SECURITY_HEADERS });
  }

  /** Renders a POST form carrying the CSRF token. `inline` forms sit inside a table cell. */
  function postForm(ctx, action, inner, variant = "") {
    return `<form method="post" action="${esc(action)}"${variant ? ` class="${variant}"` : ""}><input type="hidden" name="csrf" value="${esc(ctx.csrf)}">${inner}</form>`;
  }

  function flash(url) {
    const ok = url.searchParams.get("ok");
    const err = url.searchParams.get("err");
    const n = Math.min(Number(url.searchParams.get("n")) || 0, 100000);
    if (err && Object.hasOwn(ERR_MESSAGES, err)) return `<p class="flash bad" role="alert">${esc(ERR_MESSAGES[err])}</p>`;
    if (ok && Object.hasOwn(OK_MESSAGES, ok)) {
      const message = OK_MESSAGES[ok];
      return `<p class="flash good" role="status">${esc(typeof message === "function" ? message(n) : message)}</p>`;
    }
    return "";
  }

  function auditTable(log) {
    if (!log.length) return '<p class="empty">Nothing yet.</p>';
    return `<div class="table-wrap"><table>
    <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead>
    <tbody>${log
      .map(
        (e) => `<tr><td>${when(e.at)}</td><td><code>${e.actor ?? "—"}</code></td><td><code>${esc(e.action)}</code></td><td>${esc(e.target)}</td><td>${esc(e.detail)}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
  }

  function redirect(location, params = {}) {
    const url = new URL(location, "https://hub.invalid");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return new Response(null, {
      status: 303,
      headers: { Location: url.pathname + url.search, "Cache-Control": "no-store", "Referrer-Policy": "same-origin" },
    });
  }

  return { handle, csrfFor };
}

/** Adds the framing protections to a response that did not come from `page()`. */
function framed(response) {
  const copy = new Response(response.body, response);
  copy.headers.set("X-Frame-Options", "DENY");
  if (!copy.headers.has("Content-Security-Policy")) copy.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  return copy;
}

function plain(text, status, extra = {}) {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "no-store", ...extra } });
}

function when(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  return `<time datetime="${new Date(seconds * 1000).toISOString()}">${new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC</time>`;
}

function defaultOnError(err) {
  console.error("telegram-qr-signin/hub: console error", err);
}

const STYLES = `
:root{color-scheme:light dark;--bg:#f5f6f9;--card:#fff;--ink:#141a29;--muted:#667085;--rule:#e3e7ee;--accent:#2563eb;--accent-ink:#fff;--good:#177245;--good-bg:#e6f5ec;--bad:#b3261e;--bad-bg:#fdeceb;--warn:#8a5a00;--warn-bg:#fff3d6;--code:#eef1f6;--font:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#0e1420;--card:#161e2e;--ink:#e8ecf4;--muted:#93a0b8;--rule:#27324a;--accent:#5b8cff;--accent-ink:#0b1020;--good:#5fd39a;--good-bg:#12301f;--bad:#ff8a80;--bad-bg:#3a1714;--warn:#f1c25c;--warn-bg:#35290a;--code:#1f2940}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--accent)}
code{background:var(--code);padding:.08em .38em;border-radius:5px;font:.88em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.bar{display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;align-items:center;padding:12px max(16px,calc((100% - 62rem)/2));background:var(--card);border-bottom:1px solid var(--rule)}
.brand{font-weight:700;text-decoration:none;color:var(--ink);letter-spacing:-.01em}
.who{color:var(--muted);font-size:.88rem}
main{max-width:62rem;margin:0 auto;padding:20px 16px 64px}
section{background:var(--card);border:1px solid var(--rule);border-radius:14px;padding:20px;margin:0 0 18px}
h2{margin:0 0 4px;font-size:1.1rem;letter-spacing:-.01em;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lead{margin:0 0 14px;color:var(--muted);font-size:.9rem}
.hint+.row{margin-top:14px}
.hint{margin:8px 0 0;color:var(--muted);font-size:.82rem}
.crumb{margin:0 0 12px;font-size:.9rem}
.muted{color:var(--muted)}
.empty{color:var(--muted);margin:8px 0 14px}
.count{color:var(--muted);font-weight:400;font-size:.9rem}
.table-wrap{overflow-x:auto;margin:0 -4px 14px}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--rule);vertical-align:middle}
th{color:var(--muted);font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em}
tr:last-child td{border-bottom:0}
td code{white-space:nowrap;word-break:normal}
.num{text-align:right;font-variant-numeric:tabular-nums}
.act{text-align:right;white-space:nowrap}
.act form.inline{display:inline;margin:0 0 0 6px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
label{display:flex;flex-direction:column;gap:4px;font-size:.82rem;color:var(--muted);font-weight:600}
label.grow{flex:1 1 16rem}
label.check{flex-direction:row;align-items:center;gap:8px;color:var(--ink);font-weight:500;font-size:.92rem;padding-bottom:9px}
input[type=text],input:not([type]),input[type=search],textarea{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--rule);border-radius:9px;padding:8px 10px;min-width:12rem;width:100%}
::placeholder{color:var(--muted);opacity:.55}
textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88rem}
input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px}
.btn{display:inline-block;font:600 .88rem/1 var(--font);padding:10px 14px;border-radius:9px;border:1px solid var(--rule);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
.btn.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--rule))}
.btn.quiet{color:var(--muted)}
.pill{display:inline-block;font:600 .72rem/1 var(--font);padding:4px 8px;border-radius:99px;background:var(--code);color:var(--muted)}
.pill.on{background:var(--good-bg);color:var(--good)}
.pill.off{background:var(--bad-bg);color:var(--bad)}
.pill.warn{background:var(--warn-bg);color:var(--warn)}
.flash{margin:0 0 16px;padding:11px 14px;border-radius:10px;font-size:.92rem}
.flash.good{background:var(--good-bg);color:var(--good)}
.flash.bad{background:var(--bad-bg);color:var(--bad)}
.warn-zone{border-color:color-mix(in srgb,var(--warn) 45%,var(--rule));background:color-mix(in srgb,var(--warn-bg) 35%,var(--card))}
.small{font-size:.8rem}
.callout{border:1px dashed var(--rule);border-radius:12px;padding:14px 16px}
.callout strong{display:block;margin-bottom:2px}
.callout ul{margin:4px 0 12px;padding-left:1.2rem}
.danger-zone{border-color:color-mix(in srgb,var(--bad) 35%,var(--rule))}
@media (max-width:560px){input[type=text],input:not([type]){min-width:0}.row>label{flex:1 1 100%}}
`;
