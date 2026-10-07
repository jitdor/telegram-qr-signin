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

/** Throws unless `namespace` is something a site may be registered under. */
export function assertSiteNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    throw new Error("namespace must be 1-24 chars of A-Z a-z 0-9 - (no underscore)");
  }
  if (namespace === ADMIN_NAMESPACE) throw new Error(`"${ADMIN_NAMESPACE}" is reserved for the admin console`);
  return namespace;
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
