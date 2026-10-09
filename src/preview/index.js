// The card that link previews (Telegram, Slack, Discord, X, iMessage ...) show for the sign-in page: a
// 1200x630 PNG in the page's own look, served by the app itself like the fonts. It lives in data.js as
// base64 because a Worker has no file system and this package has no build step; scripts/build-preview.mjs
// regenerates it. `auth.handle()` answers <basePath>/preview-<hash>.png.

import { PREVIEW_PNG } from "./data.js";

export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;

// A short fingerprint of the bytes goes into the file name, so the image can be cached forever while a
// new release with a new card still gets fetched (link previews keep their own copies for a long time).
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** The file name of the card: `preview-<hash>.png`. */
export const previewFileName = () => `preview-${fingerprint(PREVIEW_PNG)}.png`;

let bytes = null;

/** The response for `<basePath>/preview-<hash>.png`: the card, cached for a year, or a 404 for any other name. */
export function previewResponse(request, previewPath) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (new URL(request.url).pathname !== previewPath) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  bytes ??= Uint8Array.from(atob(PREVIEW_PNG), (c) => c.charCodeAt(0));
  return new Response(request.method === "HEAD" ? null : bytes, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
