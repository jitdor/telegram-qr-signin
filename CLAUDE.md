# telegram-qr-signin

A zero-dependency library: Telegram as an identity provider (sign in by scanning a QR). It is **not** a deployable app; the
Workers in `examples/` are templates. Real deployments are separate projects that depend on this package.

## Everyday

- Tests: `npm test` (`node --test`, Node 22.13+). CI runs them on Node 22.13 and 24 for every push and PR. Keep all of them green.
- No build step, no runtime dependencies. The sign-in page is one self-contained HTML string (`src/login-page.js`); the consent and
  error pages (`src/oidc/consent-page.js`) reuse its pieces.
- Fonts are bundled, base64, in `src/fonts/data.js`. **Never hand-edit it**: run `scripts/build-fonts.sh` (needs `pip install fonttools brotli`).
- README screenshots live in `docs/img/`; re-take them when the page's look changes.
- Merging: PRs are merged with a merge commit ("Merge pull request #N from jitdor/<branch>"), after CI is green.

## Releasing

1. `version` in `package.json` is **manual**; npm never derives it from git. When releasing, set it with
   `npm version X.Y.Z --no-git-tag-version` and keep these in step: the assertion in `tests/entrypoints.test.mjs`, and the install
   snippets in `README.md` (`#semver:^X.Y.Z`) and `docs/integrating-a-site.md`. Commit as "Release X.Y.Z" on `main`.
2. Tag **after** that commit, as `vX.Y.Z`, via a GitHub release titled `vX.Y.Z: <Title>`.
   Consumers installing `#semver:^X.Y.Z` resolve **git tags**, not the `version` field; consumers on `#main` need neither.
3. Release notes follow the earlier ones (see the v1.2.0 and v1.3.0 releases): intro line, **Install**,
   **Read first** for anything breaking, **Highlights**, **Upgrading**, **Good to know**, and a **Full Changelog** compare link.
   Be honest about what was not tested.

## Redeploying a Worker that uses this library

The known consumer is **Courier** (`courier.jitdor.com`, private repo `jitdor/Courier`; its Worker is named `courier`).

- Courier depends on `telegram-qr-signin` at `#main` and its `wrangler.jsonc` has
  `"build": { "command": "npm update telegram-qr-signin" }`. **Every build re-pulls this repo's `main`**, so redeploying needs no
  change to Courier's code or lockfile, only a new build.
- Therefore: anything merged to this repo's `main` goes live on Courier's next build. Test and merge deliberately.
- To redeploy without a local clone: Cloudflare dashboard → Workers & Pages → `courier` → Builds → **Retry build** (works because
  the update runs inside the build). If the Worker is not Git-connected, deploy with
  `git clone https://github.com/jitdor/Courier && cd Courier && npm install && npm run deploy` (`wrangler deploy`; add
  `--keep-vars` if variables were set only in the dashboard).
- Never deploy a `wrangler.jsonc` copied from `examples/`: it holds placeholder D1/KV ids that would replace real bindings.
- In a cloud session, Courier must first be attached with `add_repo` (`jitdor/Courier`). Claude cannot trigger Cloudflare builds or see
  deploy state from here: tell the user to retry the build, or clone and deploy as above.
- Verify a deploy:
  `curl -s https://courier.jitdor.com/auth/login | grep -o '/auth/fonts/[^")]*' | head -1`, then `curl -I` that path (expect 200,
  `font/woff2`). No match means the old page is still live. A 404 on the font means the Worker routes individual paths and must
  send `/auth/fonts/*` to `auth.handle()` (the page still works, in system fonts).
- Roll back with `npx wrangler rollback`.
