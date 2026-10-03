# mxs author — local admin editor for LiteXML drafts

**Date:** 2026-09-13
**Status:** Approved
**Owner:** Innei

## Goal

Replace `mxs preview` with `mxs author`: a published `@mx-space/cli` command that serves the same `RichEditor` surface as admin, lets a human edit a local LiteXML envelope body, writes the file back, and overwrites a sidecar unified diff against the body frozen at process start. The human returns to the agent conversation to continue; the command never handoffs on its own.

## Non-goals

- Agent panel, write-page chrome, publish, categories, cover, TTS, version tree.
- Image / video / file upload, afilmory manifest fetch, geocode, stock APIs, or any mx-core session.
- Extracting `apps/admin/src/vendor/rich-editor` into a new package.
- A second Vite-dev file API. Iteration is `build:author` then `mxs author`.
- HTML dump flags (`--print`, `--save`), stdin `-`, `--theme`.
- Browser E2E for the SPA.
- A new npm package name. Still `@mx-space/cli`.

## Current state (anchor)

- `mxs preview` vendors `@haklex/rich-litexml-cli` plus `@haklex/rich-compose` HTML preview CSS/JS and opens a renderer whose styles do not match admin.
- Admin editor lives at `apps/admin/src/vendor/rich-editor/core/RichEditor.tsx` (no agent). Write page wraps it with `RichEditorWithAgent`.
- LiteXML ↔ Lexical already exists in CLI via `Lexical` (`packages/cli/src/services/Lexical.ts`) and `@mx-space/editor`.
- Envelope parse: `packages/cli/src/domain/envelope.ts`. Reconstructing via `renderEnvelope` reorders meta and is **not** used for save.

## Decisions (locked)

| Topic | Choice |
| --- | --- |
| Editor surface | Admin `RichEditor` only, same nodes (map / afilmory / stock). |
| Edit scope | `<content>` body only. Envelope meta is byte-stable except the content span. |
| Save | Explicit (button + ⌘/Ctrl+S). Writes xml + diff. No autosave, no auto handoff. |
| Diff baseline | Body frozen in memory at process start. Each save overwrites one unified diff of current body vs that freeze. |
| Shipping | Admin extra Vite entry; CLI vendors the dist. |
| Command | `mxs author`. `mxs preview` is deleted. |
| Chrome | Top bar: dirty blue dot + basename + primary blue Save. Failure: red text in the bar + Retry. Theme follows `prefers-color-scheme`. |

## User-facing surface

```text
mxs author [--port <n>] [--no-open] [--variant article|note] <file>
```

- `<file>` is a required filesystem path. `-` / stdin is rejected.
- Default: bind `127.0.0.1` on a free port (search starts at `4173`), print the URL, open the system browser, run until Ctrl+C.
- `--port`: fail if occupied; do not scan.
- `--no-open`: print URL only.
- `--variant`: only for a raw LiteXML fragment. Envelope root wins (`<mxpost>` → `article`, `<mxnote>` → `note`). Pages that reuse `<mxpost>` are `article`.
- No active CLI profile required (preflight exempt, same as today's `preview`).
- Does not contact mx-core.

### Breaking vs `mxs preview`

| Gone | Migration |
| --- | --- |
| `mxs preview` | `mxs author <file>` |
| `--print` / `--save` HTML | none; this command is an editor, not a renderer |
| `--theme` | OS color scheme |
| stdin `-` | write a file first |
| `--variant comment` | unsupported |

## Architecture

```text
apps/admin/author.html + src/author/*
        │  vite.author.config.mts → dist-author/
        ▼
packages/cli/dist/vendor/author/     (copied at CLI package)
        │
mxs author article.xml
        │  localhost HTTP: static SPA + /api/document
        ▼
article.xml  +  article.xml.diff
```

Three pieces:

1. Admin author entry — mounts `RichEditor`, not `RichEditorWithAgent`, not write routes.
2. CLI command — serves the vendored SPA and owns the file.
3. Sidecar diff — AI reads this after the human says continue.

## Admin author entry

Paths:

- `apps/admin/author.html`
- `apps/admin/src/author/main.tsx`
- `apps/admin/src/author/AuthorApp.tsx`
- `apps/admin/vite.author.config.mts`
- `apps/admin/package.json` script `build:author`

`vite.author.config.mts` shares Tailwind, React, path aliases, and token CSS with the main admin Vite config. It does **not** use `admin-routes`. Input is `author.html` only. Out dir is `apps/admin/dist-author/` (gitignored; root `.gitignore` `dist` does not cover this name).

`main.tsx` imports `./index.css` (tokens + Tailwind) and `vendor/rich-editor/core/style.ts` (haklex CSS). It applies `document.documentElement.classList.toggle('dark', prefersDark)` from `prefers-color-scheme` (no admin `theme-mode` localStorage).

`AuthorApp`:

- Top bar: optional blue dirty dot, `basename(fileName)`, primary Save (`⌘S` / `Ctrl+S` in the button label). Unsaved → blue Save enabled. Saved and clean → Save disabled/grey. Error → red message in the bar, button label **重试**.
- Remaining viewport is `RichEditor` with `variant` from GET, `theme` from color scheme, `initialValue` from GET `lexical`.
- No “hand back to AI”.
- `beforeunload` when dirty is allowed.

Import graph: `src/author/**` may import `vendor/rich-editor/core/RichEditor` and its style module. It must not import `features/write`, `RichEditorWithAgent`, or admin routers. Do not fork `RichEditor`. If a plugin (link-card convert, map geocode, afilmory, stock, image paste) needs mx-core and fails, the editor stays up; the action fails in-place. If a plugin throws at module load, stub **only at the author entry**, not in the shared `RichEditor` used by admin.

## CLI command

Replace `packages/cli/src/cli/preview/` with `packages/cli/src/cli/author/`.

Wire through:

- `packages/cli/src/bin/mxs.ts` (`previewCmd` → `authorCmd`)
- `packages/cli/src/cli/help/index.ts` (`GROUP_NAMES`, side-effect import)
- `packages/cli/src/domain/preflight-guards.ts` (`PREFLIGHT_EXEMPT_TOPLEVEL`, `TOPLEVEL_COMMANDS`)
- `packages/cli/README.md`, `ROADMAP.md`
- help / skill integration tests that list `preview`

### SPA resolution

1. Published / packaged: `<cli-package-root>/dist/vendor/author/index.html`
2. Source `tsx` in this repo: `apps/admin/dist-author/index.html` if present
3. Else fail: tell the user to run `pnpm -C apps/admin run build:author` (source) or reinstall `@mx-space/cli` (published)

### HTTP

Bind `127.0.0.1` only. Serve the SPA as static files. Same origin for API.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| `GET` | `/api/document` | — | `{ lexical, variant, fileName }` |
| `PUT` | `/api/document` | `{ lexical }` | `{ ok: true, diffPath }` or `{ error: { message } }` |

This is a private local API. Do not wrap it in the mx-core `{ data }` envelope.

Security:

- Reject `Host` that is not `127.0.0.1` / `localhost` (with port).
- If `Origin` is present, it must match `http://127.0.0.1:<port>` or `http://localhost:<port>`.
- No `Access-Control-Allow-Origin: *`.

`GET` converts the current on-disk body with `Lexical.litexmlToPayload` (wrap `<doc>` if needed). `PUT` converts with `Lexical.payloadToLitexml` (`compact: false`). Conversion stays in CLI; the browser never sees LiteXML.

### File write

On start:

1. Read `<file>` (must exist).
2. Detect envelope vs raw fragment (same rules as today's preview).
3. Extract body XML. Freeze `originalBody` in memory. Do not write a `.orig` sidecar.
4. Remember the full original file text for envelope splicing.

On save:

1. Serialize lexical → pretty LiteXML body. On failure: no disk writes, return `{ error }`.
2. If envelope: splice **only** the inner XML of the root `<content>` element; leave every other byte of the file as last successfully saved (or the start file). Extend `parseEnvelope` with a content span (`start`/`end` into the source string) rather than calling `renderEnvelope`. Empty or self-closing `<content>` is valid; the span still identifies where the new inner XML goes.
3. If fragment: the new body is the entire file.
4. Build a unified diff of `originalBody` vs new body (pretty LiteXML). Unchanged still writes a headers-only diff:

   ```diff
   --- article.xml (original)
   +++ article.xml (current)
   ```
5. Sidecar path: `<file>.diff` (e.g. `article.xml` → `article.xml.diff`).
6. Atomic-enough write: write both payloads to sibling temp files, then `rename` xml, then `rename` diff. If the diff rename fails after xml renamed, restore xml from the in-memory previous successful file text, then return `{ error }`. Serialize-fail or temp-write-fail leaves both targets at the previous successful pair.

The process owns `<file>` until Ctrl+C. Unsaved browser state is not on disk. Agents must not rewrite `<file>` during the same process. A new round is: stop, let the agent rewrite, run `mxs author` again (new freeze).

Diff is always current body vs the **start-of-process** body, not vs the previous save.

## Build and release

- `apps/admin` `build:author`: `vite build --config vite.author.config.mts`
- `packages/cli` `package` / `build`: run `build:author`, copy `apps/admin/dist-author/` → `packages/cli/dist/vendor/author/`
- Remove tsdown copies of `@haklex/rich-litexml-cli` and the `@haklex/rich-compose` HTML preview CSS/JS. Drop `@haklex/rich-litexml-cli` from CLI `package.json` if nothing else imports it.
- Unified diff: bundle a small `diff` implementation in the CLI (devDependency + tsdown bundle, or a local helper). Do not add a runtime dependency unless the CLI already needs it unbundled.
- `release-core` CLI pipeline already rebuilds `dist/`. `package` must produce `dist/vendor/author/` so `npm pack` contains it. Add a pack smoke check that `dist/vendor/author/index.html` exists.
- Heavy editor chunks (maplibre, mermaid, excalidraw) may be dynamic-imported. Style parity with admin is required; matching admin's code-split is not.

## Skills and docs

In-repo:

- Replace `packages/cli/skills/commands-preview.md` with `commands-author.md` (`slug: commands-author`). Document start, URL, save, sidecar path, freeze semantics, “do not auto-continue”, “read the diff not the whole file”.
- Update `packages/cli/README.md` and `ROADMAP.md` (v0.6 preview bullet becomes author).
- `.claude/skills/mxs-cli-ai-author/references/content-authoring.md`: after writing the envelope, run `mxs author <file>`, wait for the human, then read `<file>.diff`.

Out of repo, still this task:

- `~/.claude/skills/session-to-skill-and-blog/references/publish-flow.md`: delete `mxs preview`; the local review step is `mxs author /tmp/blog/article.xml` in the background, show the URL, **stop**, on “continue” read `article.xml.diff` and do not rescan the full article.

## Tests

Pure functions (vitest, no SPA):

- Envelope save replaces only the content span; title / slug / tags / unrelated whitespace outside content stay.
- Raw fragment replaces the whole file.
- Multiple saves: `.diff` is vs the frozen start body, not vs the last save.
- Unchanged save still writes a headers-only `.diff`.
- Serialize failure and write failure leave both xml and diff at the previous successful pair.

HTTP (fixture `index.html`, not the real author bundle):

- `GET` returns lexical + variant + fileName.
- `PUT` updates xml and `.diff` to match.
- Bad `Host` / `Origin` rejected.
- Missing SPA directory: command fails, does not hang.

Build / CLI surface:

- `mxs --help` lists `author`, not `preview`.
- `mxs skill` lists `commands-author`, not `commands-preview`.
- Packaged CLI contains `dist/vendor/author/` and does not contain `dist/vendor/litexml/cli.mjs` or the HTML preview client assets.

Manual (not automated this release): open a real envelope with heading, code, and a custom node → edit a paragraph → save → inspect xml + diff → in chat, continue from the diff only.

## Error table

| Case | Behavior |
| --- | --- |
| Missing / unreadable file | Exit non-zero, no server |
| Invalid envelope / LiteXML | Exit with parse error (line if known) |
| Missing SPA | Exit, tell user to `build:author` or reinstall |
| `--port` in use | Exit |
| Default port in use | Next free port |
| PUT serialize fail | `{ error }`, disk unchanged |
| PUT disk fail | restore previous pair, `{ error }` |
| Plugin network (upload, map, afilmory) | editor stays; action fails |
| Ctrl+C | process exits; unsaved browser state discarded |
