// The fonts the sign-in page uses, served by the app itself so the page still makes no request to
// anyone else (no Google Fonts, no CDN). They live in data.js as base64 because a Worker has no file
// system and this package has no build step; `auth.handle()` answers /auth/fonts/<file> from them.
//
//   display  Archivo, width 80, weight 900    the headline and the ticket's name
//   sans     Inter, variable weight           everything else
//   mono     Google Sans Code, variable weight  the small labels and hints
//
// All three are SIL Open Font License 1.1: see LICENSES.md.

import { FONT_DATA } from "./data.js";

const FACES = [
  { key: "display", file: "archivo-display", family: "TQA Display", weight: "900" },
  { key: "sans", file: "inter", family: "TQA Sans", weight: "100 900" },
  { key: "mono", file: "google-sans-code", family: "TQA Mono", weight: "300 800" },
];

// A short fingerprint of the bytes goes into each file name, so the files can be cached forever and
// a new release with new fonts still gets fetched.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

const names = new Map(); // file name -> { data, face }
function nameOf(face) {
  return `${face.file}-${fingerprint(FONT_DATA[face.file])}.woff2`;
}
function registry() {
  if (names.size === 0) for (const face of FACES) names.set(nameOf(face), { face, bytes: null });
  return names;
}

/** Only plain paths are put into the page's CSS and markup. Anything else means "no local fonts". */
function usable(fontsPath) {
  // No "//": that would be a protocol-relative URL, which points at another host.
  return typeof fontsPath === "string" && /^\/[\w\-./]*$/.test(fontsPath) && !fontsPath.includes("..") && !fontsPath.includes("//");
}

/** `@font-face` rules for the bundled fonts, or "" when the page has nowhere to fetch them from. */
export function fontFaceCss(fontsPath) {
  if (!usable(fontsPath)) return "";
  return FACES.map(
    (face) =>
      `@font-face { font-family: "${face.family}"; font-style: normal; font-weight: ${face.weight}; font-display: swap; src: url("${fontsPath}/${nameOf(face)}") format("woff2"); }`
  ).join("\n  ");
}

/** `<link rel="preload">` tags, so the page does not paint in a fallback font and then jump. */
export function fontPreloadLinks(fontsPath) {
  if (!usable(fontsPath)) return "";
  return FACES.map((face) => `<link rel="preload" href="${fontsPath}/${nameOf(face)}" as="font" type="font/woff2" crossorigin>`).join("\n");
}

/** The response for `<fontsPath>/<file>`: the font, cached for a year, or a 404 for any other name. */
export function fontResponse(request, fontsPath) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const name = new URL(request.url).pathname.slice(fontsPath.length + 1);
  const entry = registry().get(name);
  if (!entry) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  entry.bytes ??= Uint8Array.from(atob(FONT_DATA[entry.face.file]), (c) => c.charCodeAt(0));
  return new Response(request.method === "HEAD" ? null : entry.bytes, {
    headers: {
      "Content-Type": "font/woff2",
      "Content-Length": String(entry.bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
