# Content Tools

A Strapi 5 plugin that adds Content-Manager productivity tools:

1. **Sticky, configurable list filters** — pick which fields become quick
   filters per content type (relations, enumerations, booleans, and
   `createdAt` / `publishedAt` date ranges). Selections stick across reloads
   and navigation via a cookie, like the language selector.
2. **Move an entry between languages** — reassign an entry's locale in place
   (single, per-row, and bulk), without creating a copy.
3. **Data Transfer** — pull content + media from another Strapi environment
   into this one from the admin panel, with an optional pre-pull backup,
   live progress, and local regeneration of every image's responsive formats.

Published as [`strapi-plugin-content-tools`](https://www.npmjs.com/package/strapi-plugin-content-tools).
The admin code is TypeScript, the server code is CommonJS; both build to `dist/`
via `@strapi/sdk-plugin`. `@strapi/design-system`, `@strapi/icons`,
`@strapi/data-transfer`, react and styled-components are peer dependencies.

---

## Table of contents

- [Installation & enabling](#installation--enabling)
- [Feature 1 — Sticky filters](#feature-1--sticky-filters)
- [Feature 2 — Move to another language](#feature-2--move-to-another-language)
- [Feature 3 — Data Transfer](#feature-3--data-transfer)
- [Settings pages](#settings-pages)
- [HTTP API](#http-api)
- [Project structure](#project-structure)
- [Development & deployment](#development--deployment)
- [Known limitations](#known-limitations)

---

## Installation & enabling

```bash
npm install strapi-plugin-content-tools
# or
yarn add strapi-plugin-content-tools
```

The plugin is auto-discovered. If you keep an explicit plugins config, enable it
in `config/plugins.ts` (or `.js`):

```ts
export default () => ({
  'content-tools': { enabled: true },
});
```

Then rebuild the admin panel and start Strapi:

```bash
npm run build && npm run develop
```

Requires **Strapi 5**. Nothing is enabled by default — filters are opt-in per
content type from **Settings → Content Tools**.

---

## Feature 1 — Sticky filters

Adds a filter row **above** the Content-Manager list toolbar. Each configured
field renders a control:

| Field kind      | Control                                   | Query applied                        |
| --------------- | ----------------------------------------- | ------------------------------------ |
| `relation`      | searchable dropdown of related entries    | `filters[field][id][$eq]=<id>`       |
| `enumeration`   | value dropdown                            | `filters[field][$eq]=<value>`        |
| `boolean`       | Yes / No dropdown                         | `filters[field][$eq]=<true\|false>`  |
| `createdAt`     | date-range preset dropdown                | `filters[createdAt][$gte]=<iso>`     |
| `publishedAt`   | date-range preset dropdown (D&P only)     | `filters[publishedAt][$gte]=<iso>`   |

Configured per content type in **Settings → Content Tools → Filters**; nothing
appears until enabled. Field names are auto-detected; noisy relations
(`createdBy`, `updatedBy`, `localizations`, any `admin::user` relation) are never
offered. Date presets: **Today / Last 3 days / Last week / Last month (30 d) /
Last year (365 d)** (cutoffs snap to start-of-day). Selections persist in the
`content-tools:scope` cookie — relation picks stick across content types (keyed
by target uid), enum/boolean/date picks per content type.

**Stale relation ids self-heal.** A relation filter stores a numeric id, and ids
are not stable across a Data Transfer pull (see below). Before re-applying a
stored id the bar waits for the target's options to load and drops the value if
that record no longer exists — otherwise a pre-pull id would silently filter the
list down to zero rows while the control itself rendered blank. An id is only
judged stale when the option list is known to be complete, so targets with more
records than one page never lose valid selections.

---

## Feature 2 — Move to another language

Reassigns an entry's locale **in place** at the database level — no copy, and
nothing left in the source locale. Both draft and published rows move; component
/ relation / media links (keyed by entry id) survive untouched.

**Conflict:** if the document already exists in the target language, the move is
**blocked with a warning** (single) or **skipped and reported** (bulk).

Triggers: **edit-view action panel**, the **row `⋯` menu**, and the **bulk bar**.
Only for localized collection types on entries that already exist.

> ⚠️ Bypasses document-service lifecycles (raw DB write), so search-index
> plugins don't reindex automatically.

---

## Feature 3 — Data Transfer

**Settings → Content Tools → Data Transfer** — pull content and media from
another Strapi environment into this one. Save environments as
`{ name, url, transfer token }` (token stored masked); **Test** checks
reachability, the token, and the version match before you commit to a pull.

**The source needs** a **Transfer token** (Settings → Transfer Tokens — an API
token will *not* work). Content is pulled with lenient version/schema strategies,
so a source whose schema differs still imports whatever matches.

### What a pull does

1. **Back up** *(optional — you choose per pull)*. Exports this environment's
   **content** to a local `.tar` under `<app>/.tmp/content-tools-dumps/_full`.
   This is the rollback point. Only one backup is ever kept.
2. **Content** — `remote source → local destination` with `strategy: 'restore'`,
   entities + links only. Commits on its own.
3. **Media** *(skippable)* — downloads each file's bytes from the source and
   **regenerates the thumbnail and responsive formats locally** using Strapi's
   own image-manipulation and upload-provider services. Best effort: a broken
   file is logged and never rolls back content that already committed.

**Admin accounts, tokens, webhooks and core-store configuration are kept** —
never deleted or replaced.

### Stopping and undoing

Nothing is ever restored silently.

| Action | Effect |
| --- | --- |
| **Stop** | Aborts; keeps whatever already landed. The backup stays available. |
| **Stop & roll back** | Aborts and restores the backup now. Only offered when the run took one. |
| Pull fails on its own | Reports the failure and **keeps** the backup; the page offers to apply it. |
| Pull succeeds | Discards the backup. |

If an aborted engine doesn't settle within 20 s the job releases itself rather
than leaving the page stuck on "Stopping…", and says so plainly.

### Progress

The page polls status — fast while running, slowly when idle — so a run that
finished while the admin was unreachable still shows up without a reload. A
failed poll is surfaced ("lost contact with the server") instead of freezing on
the last good frame. Phases appear as a step tracker (Back up → Content → Media)
with per-step counts.

A percentage is only shown where a real denominator exists: the backup knows
this environment's exact entity count, media knows the exact file count, and
content uses **what that same target sent on its last successful pull** (stored
per target). A first pull of a new target shows no bar rather than an invented
one, and the ratio is dropped if the source turns out bigger than last time.

> ⚠️ **Numeric ids change on every pull.** The restore deletes every row and
> re-inserts it, so Postgres assigns fresh ids (`documentId` is preserved).
> Anything caching a numeric id — bookmarked admin URLs, saved filters, external
> references — goes stale. If a list looks empty right after a pull, that is
> almost always the cause.

> ⚠️ Give the DB pool headroom (`DATABASE_POOL_MAX`); a restore holds
> connections and the admin can starve while it runs.

### Notes on the implementation

Two decisions worth knowing, both driven by failures on real data:

- **Content is pulled directly, not through an intermediate tar.** The tar
  destination requires every asset's bytes to match its stored size (broken
  media → `ERR_STREAM_DESTROYED`, aborting the whole transfer) and couldn't
  reliably carry a cloud source's schemas.
- **Media does not use the engine's assets stage.** That stage resolves each
  asset's local file id through a map populated only by the entities stage of
  the *same* engine run. Content and media are deliberately separate runs, so
  the map is always empty for a media-only run and every write fails with
  "File ID not found". Fetching the bytes directly also removes any dependency
  on the source host's CSP/CORS and is what makes pulled images render.

The backup is content-only and uncompressed on purpose. A content-only restore
never empties `public/uploads` (`restore.assets` false ⇒ `deleteAllAssets` and
`handleAssetsBackup` both early-return), and the media step only ever *adds*
files, so the pre-pull bytes are still on disk for a rollback to point back at.
Archiving them instead meant re-downloading every file and format from the media
provider — on a cloud provider that is thousands of round trips and was the
single slowest, most failure-prone part of the whole feature.

---

## Settings pages

Registered via `createSettingSection` under a **Content Tools** section.

- **Filters** — filterable fields per content type, grouped **Relations /
  Choices / Dates**. Save shows a **"Reload to apply"** prompt.
- **Data Transfer** — saved environments, pull, live status, backup.

Config shape (plugin-store key `filterConfig`; legacy array form auto-normalized):

```jsonc
{
  "api::page.page": {
    "fields": ["websites", "countries", "page_type", "createdAt"]
  }
}
```

Other plugin-store keys: `dataTransferTargets`, `dataTransferBackups`,
`dataTransferEstimates`.

---

## HTTP API

All routes are **admin-type** (authenticated admin), mounted under `/content-tools`.

| Method | Path                             | Body / input                                          | Purpose                              |
| ------ | -------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| POST   | `/move-locale`                   | `{ uid, documentId, sourceLocale, targetLocale }`     | Move one entry to another language   |
| POST   | `/move-locale-many`              | `{ uid, documentIds[], sourceLocale, targetLocale }`  | Bulk move                            |
| GET    | `/config`                        | —                                                     | Per-CT config `{ fields }`           |
| PUT    | `/config`                        | `{ config: { "<uid>": { … } } }`                      | Save config                          |
| GET    | `/schema`                        | —                                                     | Filterable fields per CT + config    |
| GET    | `/data-transfer/targets`         | —                                                     | Saved environments (token masked)    |
| PUT    | `/data-transfer/targets`         | `{ targets: [...] }`                                  | Save environments                    |
| POST   | `/data-transfer/probe`           | `{ targetId }`                                        | Reachability / token / version check |
| POST   | `/data-transfer/pull`            | `{ targetId, skipMedia, skipBackup }`                 | Start a pull (background) → status   |
| POST   | `/data-transfer/stop`            | `{ rollback }`                                        | Stop, optionally rolling back        |
| GET    | `/data-transfer/status`          | —                                                     | Current / last transfer status       |
| GET    | `/data-transfer/backups`         | —                                                     | Saved backup (at most one)           |
| POST   | `/data-transfer/restore-backup`  | `{ backupId }`                                        | Restore a backup                     |

`409`: `/move-locale` when the target language exists; `/data-transfer/pull`
when a transfer is already running.

---

## Project structure

```
strapi-plugin-content-tools/
├── admin/src/
│   ├── index.ts                 # settings section; inject filter bar; move actions
│   ├── components/  SiteScopeFilter · RelocatedFilterBar · MoveLocaleDialog
│   ├── actions/     moveLocaleDocumentAction · moveLocaleBulkAction
│   ├── pages/       Settings (Filters) · DataTransfer
│   └── utils/       scope.ts · configClient.ts
└── server/src/
    ├── index.js                 # server entry
    ├── routes/index.js
    ├── controllers/  move-locale · config · data-transfer
    └── services/     move-locale · config · data-transfer
```

### Key integration points

- **Admin injection:** `injectComponent('listView','actions', …)` for the filter
  bar; `apis.addDocumentAction` / `apis.addBulkAction` for the locale move.
- **Filter placement:** `RelocatedFilterBar` portals the row above the toolbar
  (before the action bar inside `<main id="main-content">`).
- **Config cache** on `window` so lazy chunks share one instance.
- **Locale move:** knex `UPDATE … SET locale` by `document_id`.
- **Data transfer:** `@strapi/data-transfer` remote source → local destination
  (`strategy: 'restore'`), plus a custom media step built on `@strapi/upload`'s
  `image-manipulation` and `provider` services.

---

## Development & deployment

```bash
npm install
npm run build      # bundle admin + server to dist/
npm run verify     # marketplace-readiness gate
npm run watch:link # develop against a linked Strapi app (yalc)
```

Health check (admin routes require auth, so `401` = healthy):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1337/content-tools/config   # 401
```

### Publishing

```bash
npm version patch && npm run build && npm run verify && npm publish --access public
```

Then submit to the [Strapi Marketplace](https://market.strapi.io).

When the plugin is baked into a Docker image's `node_modules`, a published
version only takes effect after the image is rebuilt. To test a change against a
running container without publishing:

```bash
npm run build
docker exec <container> rm -rf /opt/app/node_modules/strapi-plugin-content-tools/dist
docker cp dist <container>:/opt/app/node_modules/strapi-plugin-content-tools/dist
docker exec <container> rm -rf /opt/app/node_modules/.strapi/vite /opt/app/.strapi/client
docker restart <container>
```

Both `rm -rf` steps matter, and skipping either makes the change look like it had
no effect at all:

- **`dist`** — `docker cp <dir> <container>:<dest>` copies the source *into*
  `<dest>` when `<dest>` already exists, silently producing a nested `dist/dist/`
  that Strapi never loads. Removing the target first (or copying `dist/.` into
  `dist/`) avoids that, and also clears stale hashed chunks from previous builds.
- **Vite's dep cache** — the admin dev server pre-bundles `node_modules` into
  `node_modules/.strapi/vite/deps` and invalidates that cache on dependency
  *versions*. Swapping files inside a package doesn't change a version, so a
  restart alone rebuilds nothing and the old pre-bundled copy is served forever.

This is ephemeral — it is lost on the next image rebuild. Hard-reload the admin
afterwards, or the browser will serve the cached bundle.

---

## Known limitations

- **Locale move** doesn't trigger search-index reindexing (raw DB write).
- **Numeric ids are not stable across a Data Transfer pull** — `documentId` is.
  Bookmarked admin URLs and anything holding a raw id will go stale.
- **Data Transfer is pull-only** (remote → local); nothing is pushed. It runs
  in-process as a single job — one at a time per server process, and the state
  is lost if the process restarts mid-run.
- **Backups are content-only** and live under `<app>/.tmp` — **ephemeral if the
  image is rebuilt**. They are a short-lived undo for a pull, not a backup
  strategy. Because media bytes aren't archived, pulling source A, then B, then
  rolling back to A won't recover any file B overwrote at the same hash.
- **Media pull** refetches every file and regenerates its formats, so it scales
  with the number of files × formats; each download is capped at 60 s.
- **Published-date filter** works against `publishedAt`; the list shows drafts by
  default (whose `publishedAt` is null), so it effectively surfaces published
  entries.
