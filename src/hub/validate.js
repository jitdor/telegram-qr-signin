// Input rules shared by the stores and the admin console. They live in one place so a value the
// console refuses can never be written by another route, and the other way round.

/** Same rule createTelegramQrAuth applies to `namespace`: no "_", it is the payload separator. */
export const NAMESPACE_RE = /^[A-Za-z0-9-]{1,24}$/;

/**
 * The namespace the admin console signs in under. It is reserved so a site can never be registered
 * under it: the hub routes that namespace's scans to the super-admin gate, not to the registry.
 */
export const ADMIN_NAMESPACE = "hub-admin";

export const MAX_LABEL_LENGTH = 80;
export const MAX_NAME_LENGTH = 60;

/**
 * Who a site lets in.
 *   "granted"  only people holding a grant (the default, and what every new site starts as)
 *   "anyone"   any Telegram account that is not blocked — the hub proves who someone is, and the
 *              site decides what they may do
 */
export const ACCESS_MODES = ["granted", "anyone"];
export const DEFAULT_ACCESS = "granted";

/** Throws unless `mode` is one of ACCESS_MODES. */
export function assertAccessMode(mode) {
  if (!ACCESS_MODES.includes(mode)) throw new Error(`access must be one of ${ACCESS_MODES.join(", ")}`);
  return mode;
}

/** Throws unless `namespace` is something a site may be registered under. */
export function assertSiteNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    throw new Error("namespace must be 1-24 chars of A-Z a-z 0-9 - (no underscore)");
  }
  if (namespace === ADMIN_NAMESPACE) throw new Error(`"${ADMIN_NAMESPACE}" is reserved for the admin console`);
  return namespace;
}

/** How many URLs one site may be served from (a custom domain, a workers.dev address, a preview…). */
export const MAX_ORIGINS = 10;

/**
 * "https://Docs.Example.com:443/any/path?x" -> "https://docs.example.com", or null.
 *
 * A site is bound to an ORIGIN — scheme, host, port — which is what a browser (and `request.url`)
 * identifies a site by; the path is irrelevant, so one is accepted and dropped. https only, except
 * for localhost and 127.0.0.1, so a site under development can be registered. Credentials in the URL
 * are refused outright.
 */
export function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length > 200) return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  return null;
}

/** The origin a request was made to, normalised the same way as a registered one. */
export function originOfRequest(request) {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

/** Throws unless `origins` is a non-empty list (at most MAX_ORIGINS) of valid origins. Returns them normalised and de-duplicated. */
export function assertOrigins(origins) {
  const list = Array.isArray(origins) ? origins : [];
  const clean = [...new Set(list.map(normalizeOrigin))];
  if (!clean.length || clean.includes(null)) {
    throw new Error("origins must be a non-empty list of https URLs such as https://docs.example.com (http only for localhost)");
  }
  if (clean.length > MAX_ORIGINS) throw new Error(`a site can have at most ${MAX_ORIGINS} origins`);
  return clean;
}

/** A Telegram user id: a positive safe integer. Returns it as a number, or null. */
export function parseTelegramId(value) {
  const text = String(value ?? "").trim();
  if (!/^[0-9]{1,15}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * "111, 222\n333" -> { ids: [111, 222, 333], invalid: [] }. Splits on commas and whitespace and
 * reports every entry that is not a Telegram id instead of silently dropping it, so a typo in a
 * pasted list is seen rather than lost. Duplicates collapse.
 */
export function parseTelegramIds(input) {
  const ids = new Set();
  const invalid = [];
  for (const part of String(input ?? "").split(/[\s,;]+/)) {
    if (part === "") continue;
    const id = parseTelegramId(part);
    if (id === null) invalid.push(part.slice(0, 20));
    else ids.add(id);
  }
  return { ids: [...ids], invalid };
}

/** Trims, collapses whitespace and control characters, and caps the length. */
export function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export const cleanLabel = (value) => cleanText(value, MAX_LABEL_LENGTH);
export const cleanName = (value) => cleanText(value, MAX_NAME_LENGTH);

/** "Ada Lovelace (@ada)" — how a Telegram user is written in a label or the audit log. */
export function describeUser(user) {
  const name = cleanText([user?.first_name, user?.last_name].filter(Boolean).join(" "), 40);
  const handle = user?.username ? `@${cleanText(user.username, 32)}` : "";
  if (name && handle) return `${name} (${handle})`;
  return name || handle;
}
