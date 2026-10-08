// Types for telegram-qr-signin/hub.

import type { Gate, LoginStore, TelegramApi, TelegramQrAuth, TelegramQrAuthConfig, Branding, AuthUser } from "./index";

/**
 * Who a site lets in.
 *  - `"granted"`: only people holding a grant (the default).
 *  - `"anyone"`: any Telegram account that is not blocked. The hub only proves who someone is; the
 *    site keeps its own accounts and does its own moderation.
 */
export type HubAccessMode = "granted" | "anyone";

export interface HubNamespace {
  namespace: string;
  /** What people see in the bot chat and the console. */
  name: string;
  enabled: boolean;
  access: HubAccessMode;
  /**
   * The origins (scheme + host + port) the site is served from. The namespace works only from these.
   * Empty only for a site registered before binding existed: it is "unbound" and works from anywhere
   * until an origin is added.
   */
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
  /** The site's registered origins; empty means unbound (legacy). */
  origins: string[];
  granted: boolean;
  /** On the site's block list. Beats `granted`, and applies in every mode. */
  blocked: boolean;
}

/** The registry contract. `create*` / `add*` resolve true if they made a row, false if it existed. */
export interface HubStore {
  listNamespaces(): Promise<HubNamespaceSummary[]>;
  getNamespace(namespace: string): Promise<HubNamespace | null>;
  /** `origins` is required and must be non-empty: URLs such as "https://docs.example.com" (http only for localhost). Rejects otherwise. */
  createNamespace(site: { namespace: string; name?: string; origins: string[]; access?: HubAccessMode; createdBy?: number | null }): Promise<boolean>;
  updateNamespace(namespace: string, changes: { name?: string; enabled?: boolean; access?: HubAccessMode }): Promise<boolean>;
  /** True if added; false if already there or the site does not exist. Rejects an invalid URL, or more than 10. */
  addOrigin(namespace: string, url: string): Promise<boolean>;
  /** True if removed; false if absent, or if it is the site's only origin (a site is never left unbound). */
  removeOrigin(namespace: string, url: string): Promise<boolean>;
  /** Switches the site off first, then removes its grants, blocks and requests. */
  deleteNamespace(namespace: string): Promise<boolean>;

  /** The one call a gate makes: one query per guarded request. */
  access(namespace: string, userId: number | string): Promise<HubAccess>;

  listAdmins(): Promise<HubAdmin[]>;
  isAdmin(id: number | string): Promise<boolean>;
  addAdmin(admin: { id: number; label?: string; addedBy?: number | null }): Promise<boolean>;
  removeAdmin(id: number | string): Promise<boolean>;

  listGrants(namespace: string, options?: { limit?: number }): Promise<HubGrant[]>;
  addGrant(grant: { namespace: string; id: number; label?: string; addedBy?: number | null }): Promise<boolean>;
  removeGrant(namespace: string, id: number | string): Promise<boolean>;

  listBlocks(namespace: string, options?: { limit?: number }): Promise<HubBlock[]>;
  addBlock(block: { namespace: string; id: number; label?: string; addedBy?: number | null }): Promise<boolean>;
  removeBlock(namespace: string, id: number | string): Promise<boolean>;

  recordRequest(request: { namespace: string; user: Pick<AuthUser, "id"> & Partial<AuthUser> }): Promise<void>;
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
  /** The login store the sites share. */
  store: LoginStore;
  registry: HubStore;
  /** Bootstrap super admins — "111,222" or an array. At least one. Not removable from the console. */
  superAdmins: string | number | Array<string | number>;
  /** Signs the console's session cookie. Use a dedicated secret. */
  sessionSecret: string;
  /** The `secret_token` you gave setWebhook. */
  webhookSecret?: string;
  webhookPath?: string;
  adminPath?: string;
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
  paths: { webhook: string; admin: string };
  adminAuth: TelegramQrAuth;
  registry: HubStore;
  store: LoginStore;
}

export declare function createHub(config: HubConfig): Hub;

export interface SiteAuthConfig extends Omit<TelegramQrAuthConfig, "namespace" | "authorize" | "botToken" | "session"> {
  registry: HubStore;
  /** The id this site was registered under in the console. */
  namespace: string;
  /** Required: a site has no bot token to fall back on. Give each site its own. */
  session: TelegramQrAuthConfig["session"] & { secret: string };
  /** Optional extra gate, ANDed with the hub's. Needs `botToken` or `telegram`. */
  authorize?: Gate;
  /** Not needed unless an extra gate calls Telegram. */
  botToken?: string;
  recordRequests?: boolean | (() => boolean);
}

export declare function createSiteAuth(config: SiteAuthConfig): TelegramQrAuth;

export declare function hubGate(options: {
  registry: HubStore;
  namespace: string;
  recordRequests?: boolean | (() => boolean);
  onError?: (err: unknown) => void;
}): Gate;

export declare function superAdminGate(options: {
  registry: HubStore;
  rootAdmins: Iterable<number>;
  onError?: (err: unknown) => void;
}): Gate;

export declare function parseRootAdmins(value: string | number | Array<string | number> | undefined): number[];

export declare const ADMIN_NAMESPACE: "hub-admin";
export declare const NAMESPACE_RE: RegExp;
export declare function parseTelegramId(value: unknown): number | null;
export declare function parseTelegramIds(input: unknown): { ids: number[]; invalid: string[] };
