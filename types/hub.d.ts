// Types for telegram-qr-signin/hub.

import type { Gate, LoginStore, TelegramApi, TelegramQrAuth, TelegramQrAuthConfig, Branding, AuthUser, BeginLoginResult } from "./index";

/**
 * Who a site lets in.
 *  - `"granted"`: invite only. Only people holding a grant; a stranger is turned away and shown their
 *    Telegram id, and nothing is recorded about them (the default).
 *  - `"approval"`: only people holding a grant, but a stranger's scan is recorded as a request, the
 *    super admins are messaged, and the person is messaged when someone approves them.
 *  - `"anyone"`: any Telegram account that is not blocked. The hub only proves who someone is; the
 *    site keeps its own accounts and does its own moderation.
 */
export type HubAccessMode = "granted" | "approval" | "anyone";

export interface HubNamespace {
  namespace: string;
  /** What people see in the bot chat and the console. */
  name: string;
  enabled: boolean;
  access: HubAccessMode;
  /** The origins (scheme + host + port) the site is served from, at least one. The site works only from these. */
  origins: string[];
  createdAt: number;
  createdBy: number | null;
}

export interface HubNamespaceSummary extends HubNamespace {
  /** People holding a grant. */
  users: number;
  /** Refused scans waiting for an admin. */
  requests: number;
}

export interface HubAdmin {
  id: number;
  label: string;
  addedBy: number | null;
  addedAt: number;
}

export interface HubGrant {
  namespace: string;
  id: number;
  label: string;
  addedBy: number | null;
  addedAt: number;
}

export interface HubBlock {
  namespace: string;
  id: number;
  label: string;
  addedBy: number | null;
  addedAt: number;
}

export interface HubRequest {
  namespace: string;
  id: number;
  firstName: string;
  lastName: string;
  username: string;
  firstSeen: number;
  lastSeen: number;
  attempts: number;
}

export interface HubAuditEntry {
  id: number;
  at: number;
  actor: number | null;
  action: string;
  target: string;
  detail: string;
}

export interface HubAccess {
  exists: boolean;
  enabled: boolean;
  /** The site's access mode. */
  mode: HubAccessMode;
  /** The site's registered origins (empty only when `exists` is false). */
  origins: string[];
  granted: boolean;
  /** On the site's block list. Beats `granted`, and applies in every mode. */
  blocked: boolean;
}

/** The registry contract. `create*` / `add*` resolve true if they made a row, false if it existed. */
export interface HubStore {
  listNamespaces(): Promise<HubNamespaceSummary[]>;
  getNamespace(namespace: string): Promise<HubNamespace | null>;
  /**
   * `origins` is required and must be non-empty: URLs such as "https://docs.example.com" (http only
   * for localhost). Rejects otherwise, and with `OriginInUseError` if one belongs to another site.
   */
  createNamespace(site: { namespace: string; name?: string; origins: string[]; access?: HubAccessMode; createdBy?: number | null }): Promise<boolean>;
  updateNamespace(namespace: string, changes: { name?: string; enabled?: boolean; access?: HubAccessMode }): Promise<boolean>;
  /**
   * The sites whose origins include `url` (normalised first): one, normally; none if unregistered.
   * More than one only after a race; callers must refuse rather than pick.
   */
  namespacesForOrigin(url: string): Promise<string[]>;
  /**
   * True if added; false if already there or the site does not exist. Rejects an invalid URL, more
   * than 10, or a URL that belongs to another site (`OriginInUseError`).
   */
  addOrigin(namespace: string, url: string): Promise<boolean>;
  /** True if removed; false if absent, or if it is the site's only origin (a site always keeps one). */
  removeOrigin(namespace: string, url: string): Promise<boolean>;
  /** Stores a hash of the site's key (see `generateSiteKey`, `hashSiteKey`). False if there is no such site. */
  setSiteKey(namespace: string, hash: string): Promise<boolean>;
  getSiteKey(namespace: string): Promise<{ hash: string; createdAt: number } | null>;
  removeSiteKey(namespace: string): Promise<boolean>;
  /** Switches the site off first, then removes its grants, blocks, requests and key. */
  deleteNamespace(namespace: string): Promise<boolean>;

  /** The one call a gate makes: one query per guarded request. */
  access(namespace: string, userId: number | string): Promise<HubAccess>;

  listAdmins(): Promise<HubAdmin[]>;
  isAdmin(id: number | string): Promise<boolean>;
  addAdmin(admin: { id: number; label?: string; addedBy?: number | null }): Promise<boolean>;
  removeAdmin(id: number | string): Promise<boolean>;
  /** The Telegram name each admin last signed in to the console with. Display only. */
  listAdminNames(): Promise<Array<{ id: number; name: string }>>;
  setAdminName(id: number | string, name: string): Promise<void>;

  listGrants(namespace: string, options?: { limit?: number }): Promise<HubGrant[]>;
  addGrant(grant: { namespace: string; id: number; label?: string; addedBy?: number | null }): Promise<boolean>;
  removeGrant(namespace: string, id: number | string): Promise<boolean>;

  listBlocks(namespace: string, options?: { limit?: number }): Promise<HubBlock[]>;
  addBlock(block: { namespace: string; id: number; label?: string; addedBy?: number | null }): Promise<boolean>;
  removeBlock(namespace: string, id: number | string): Promise<boolean>;

  /** `isNew` is false when this person already had a request waiting; `attempts` counts the scans. */
  recordRequest(request: { namespace: string; user: Pick<AuthUser, "id"> & Partial<AuthUser> }): Promise<{ isNew: boolean; attempts: number }>;
  listRequests(namespace: string, options?: { limit?: number }): Promise<HubRequest[]>;
  getRequest(namespace: string, id: number | string): Promise<HubRequest | null>;
  removeRequest(namespace: string, id: number | string): Promise<boolean>;

  appendAudit(entry: { actor?: number | null; action: string; target?: string; detail?: string }): Promise<void>;
  listAudit(options?: { limit?: number }): Promise<HubAuditEntry[]>;
}

export interface HubStoreOptions {
  /** Pending access requests kept per site. Default 100. */
  requestCap?: number;
  /** Audit entries kept. Default 1000. */
  auditKeep?: number;
}

export declare class MemoryHubStore {
  constructor(options?: HubStoreOptions);
}
export interface MemoryHubStore extends HubStore {}

export declare class D1HubStore {
  /** `db` is a D1 binding; apply `migrations/hub-d1.sql` to it first. */
  constructor(db: unknown, options?: HubStoreOptions & { prefix?: string });
}
export interface D1HubStore extends HubStore {}

export interface HubConfig {
  botToken?: string;
  botUsername: string;
  /**
   * The hub's own login store. Sites never see it: they start and collect sign-ins through the API.
   * Use a strongly consistent one (a Durable Object, or D1): KV's eventual consistency can delay a
   * confirmed scan by tens of seconds.
   */
  store: LoginStore;
  registry: HubStore;
  /**
   * Bootstrap super admins — "111,222" or an array. At least one. Not removable from the console.
   * Name one with "111:Ada", and the console shows Ada instead of 111 wherever it says who did something.
   */
  superAdmins: string | number | Array<string | number>;
  /** Signs the console's session cookie. Use a dedicated secret. */
  sessionSecret: string;
  /** The `secret_token` you gave setWebhook. */
  webhookSecret?: string;
  webhookPath?: string;
  adminPath?: string;
  /** Where sites call the hub. Default "/hub-api"; a site's `hub.url` is this path on the hub's address. */
  apiPath?: string;
  /**
   * The console's public URL, such as "https://hub.example.com/admin", for the link in the message
   * super admins get when someone asks to join a site. Defaults to the address Telegram calls the
   * webhook at.
   */
  adminUrl?: string;
  adminSessionSeconds?: number;
  qrOrigin?: string;
  branding?: Branding;
  telegram?: TelegramApi;
  onUnhandled?: (update: any) => void | Promise<void>;
  onError?: (err: unknown, update?: any) => void | Promise<void>;
}

export interface Hub {
  /** A complete Worker `fetch`: the hub's routes, 404 for the rest. */
  fetch(request: Request): Promise<Response>;
  /** The hub's routes, or null for any path it does not own. */
  handle(request: Request): Promise<Response | null>;
  webhook(request: Request): Promise<Response>;
  /** Feed one Telegram update in directly. Resolves true if it was a sign-in. */
  handleUpdate(update: any): Promise<boolean>;
  rootAdmins: number[];
  paths: { webhook: string; admin: string; api: string };
  adminAuth: TelegramQrAuth;
  registry: HubStore;
  store: LoginStore;
}

export declare function createHub(config: HubConfig): Hub;

export interface SiteHubConfig {
  /** The hub's API address, as the console shows it: "https://auth.example.com/hub-api". https, except for localhost. */
  url: string;
  /** This site's key, made in the console (`tqk_<site>_<64 hex>`). Keep it in a secret. It says which site this is. */
  key: string;
  /** Replaces global `fetch` (a Cloudflare service binding's, a test double). */
  fetch?: typeof fetch;
  /** How long to wait for the hub before treating it as unreachable. Default 5000. */
  timeoutMs?: number;
  /**
   * How long a "yes" from the hub is reused for the same person. Default 0: ask on every request, so
   * revoking someone in the console applies to their very next request. A "no" is never cached.
   */
  checkCacheSeconds?: number;
}

export interface SiteAuthConfig extends Omit<TelegramQrAuthConfig, "namespace" | "store" | "authorize" | "botToken" | "session"> {
  /** Everything a site holds of the hub. There is no registry, no login store and no bot token. */
  hub: SiteHubConfig;
  /** Required: a site has no bot token to fall back on. Give each site its own. */
  session: NonNullable<TelegramQrAuthConfig["session"]> & { secret: string };
  /** Optional extra gate, ANDed with the hub's. Needs `botToken` or `telegram`. */
  authorize?: Gate;
  /** Not needed unless an extra gate calls Telegram. */
  botToken?: string;
  /** Hub failures (unreachable, wrong key). Defaults to console.error. */
  onError?: (err: unknown) => void;
}

/**
 * A site's auth: the same `handle` / `guard` / `poll` as `createTelegramQrAuth`, but every question
 * about sign-ins and access goes to the hub over HTTPS. If the hub cannot be reached, visitors get
 * "try again" (503) and nobody is signed out.
 */
export interface SiteAuth extends TelegramQrAuth {
  /** The site's own moderation, for a site open to anyone: refuse this person, on this site's list only. */
  block(id: number, label?: string): Promise<{ ok: true; added: boolean }>;
  /** Undo `block`. */
  unblock(id: number): Promise<{ ok: true; removed: boolean }>;
}

export declare function createSiteAuth(config: SiteAuthConfig): SiteAuth;

/** The hub did not answer, or refused. `code` says which; `transient` means trying again may work. */
export declare class HubError extends Error {
  code: "hub_unreachable" | "hub_unavailable" | "unauthorized" | "origin_not_allowed" | "namespace_disabled" | "refused" | string;
  /** The HTTP status, or 0 if the hub never answered. */
  status: number;
  readonly transient: boolean;
}

/** Thrown when a URL is given to a site but already belongs to another. */
export declare class OriginInUseError extends Error {
  code: "origin_in_use";
  origin: string;
  owner: string;
}

export declare function hubGate(options: {
  registry: HubStore;
  namespace: string;
  /** Only an `"approval"` site records requests. */
  recordRequests?: boolean | (() => boolean);
  /** Called after a scan was written down as a request, so you can tell the admins. */
  onRequest?: (request: { user: AuthUser; isNew: boolean; attempts: number }) => void | Promise<void>;
  onError?: (err: unknown) => void;
}): Gate;

export declare function superAdminGate(options: {
  registry: HubStore;
  rootAdmins: Iterable<number>;
  onError?: (err: unknown) => void;
}): Gate;

/** The names given to bootstrap admins ("111:Ada, 222" gives 111 -> "Ada"). */
export declare function parseRootAdminNames(value: string | number | Array<string | number> | undefined): Map<number, string>;
export declare function parseRootAdmins(value: string | number | Array<string | number> | undefined): number[];

export declare const ADMIN_NAMESPACE: "hub-admin";
export declare const NAMESPACE_RE: RegExp;
export declare function parseTelegramId(value: unknown): number | null;
export declare function parseTelegramIds(input: unknown): { ids: number[]; invalid: string[] };
