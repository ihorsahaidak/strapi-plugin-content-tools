# Content Tools

A Strapi 5 plugin that adds Content-Manager productivity tools:

1. **Sticky, configurable list filters** — pick which fields become quick
   filters per content type (relations, enumerations, booleans, and
   `createdAt` / `publishedAt` date ranges). Selections stick across reloads
   and navigation via a cookie, like the language selector.
2. **Move an entry between languages** — reassign an entry's locale in place
   (single, per-row, and bulk), without creating a copy.
3. **Export / Import entries with media** — export selected grid entries to a
   ZIP (media + folder structure included) and import that archive into another
   environment. Opt-in per content type.
4. **Collection Dump** — snapshot a whole collection (all entries + media +
   folder structure) to disk, keep the last N, and restore a snapshot
   (wipe + recreate). Manual and once-a-day automatic.
5. **Data Transfer** — pull content + media from another Strapi environment
   into this one, from the admin panel (config and admin accounts kept).

Published as [`strapi-plugin-content-tools`](https://www.npmjs.com/package/strapi-plugin-content-tools).
The admin code is TypeScript, the server code is CommonJS; both build to `dist/`
via `@strapi/sdk-plugin`. `@strapi/design-system`, `@strapi/icons`,
`@strapi/data-transfer`, react and styled-components are peer dependencies.

---

## Table of contents

- [Installation & enabling](#installation--enabling)
- [Feature 1 — Sticky filters](#feature-1--sticky-filters)
- [Feature 2 — Move to another language](#feature-2--move-to-another-language)
- [Feature 3 — Export / Import with media](#feature-3--export--import-with-media)
- [Feature 4 — Collection Dump](#feature-4--collection-dump)
- [Feature 5 — Data Transfer](#feature-5--data-transfer)
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

Requires **Strapi 5**. Nothing is enabled by default — every feature is opt-in
per content type from **Settings → Content Tools**. The daily Collection Dump
job additionally needs Strapi's scheduler enabled (`config/server` →
`cron: { enabled: true }`).

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

## Feature 3 — Export / Import with media

Enabled per content type via the **Export** / **Import** toggles in
**Settings → Content Tools → Import / Export** — the actions appear only where
enabled. This is for **selective** content migration (cherry-pick grid rows);
for a full clone use [Collection Dump](#feature-4--collection-dump) or
[Data Transfer](#feature-5--data-transfer).

### Export

A **bulk action** *Export selected* in the list view:

1. Deep-populates each selected entry (components, dynamic zones, media,
   relations — fragment API for polymorphic dynamic zones).
2. Replaces media with `{ __media: <hash> }` refs and relations with
   `{ __rel: <target>, field, value }` natural-key refs.
3. Bundles a `manifest.json` + media bytes into a ZIP (folder structure kept).
4. Returns the ZIP base64-encoded; the browser downloads it as a Blob.

### Import

An **Import** button in the list toolbar uploads a ZIP from any environment:

1. Recreates the media folder tree **by name** (missing folders created).
2. **Dedupes media by hash** (reuses existing files).
3. **Matches relations by name** (`name`/`slug`/`title`/`code`/`uid`); unmatched
   are skipped and reported.
4. **Skips same-slug + locale conflicts** (no overwrite).
5. Creates each entry, publishes it (D&P), and stamps `createdAt` = import time.

Notification reports created / skipped / not-published / unmatched relations.

---

## Feature 4 — Collection Dump

**Settings → Content Tools → Collection Dump** — full-collection snapshots.

- **Enable per content type** and set **Keep last N dumps** (max 7).
- A dump is a ZIP of the whole collection (every document, all locales, media +
  folder structure), written to disk, with metadata in the plugin store.
- **Create dump** — manual button with a progress modal.
- **Restore** — **wipe the collection and recreate it from the snapshot** (media
  deduped by hash, relations by name). Destructive; confirmed with a modal.
- **Retention** — the oldest dump is deleted once *Keep last N* is exceeded.

### Automatic dumps

- Enabling a collection (on **Save**) **creates its dump immediately** if none
  exists from today.
- A **daily cron** (03:00 server time) dumps every enabled collection but
  **skips** any that already has a dump dated today (manual or auto).

Requires `config/server` → `cron: { enabled: true }`.

---

## Feature 5 — Data Transfer

**Settings → Content Tools → Data Transfer** — pull *all* data from another
Strapi environment into this one via `@strapi/data-transfer` (same engine as the
`strapi transfer` CLI).

- **Save environments** `{ name, url, transfer token }` (token stored masked).
- **Pull & replace**: `remote source → local destination` (**restore**), run as
  a background job with a polled status line.
- Local side runs in-process, so only the remote's token is needed.

**Source needs** a **Transfer token** (Settings → Transfer Tokens; not an API
token) and the **same Strapi version**. Only **content (all collection & single
types) and media/assets** are transferred (`only: ['content', 'files']`).
**Configuration** (webhooks, core store, plugin/admin settings) and **admin
accounts / tokens / audit logs are kept** — never replaced.

> ⚠️ Destructive for local **content + media** (they're replaced); no undo.
> **Pull only** — remote → local; nothing is pushed to the remote. Restart
> Strapi after a pull.

---

## Settings pages

Registered via `createSettingSection` under a **Content Tools** section.

- **Filters** — filterable fields per content type, grouped **Relations /
  Choices / Dates**. Save shows a **"Reload to apply"** prompt.
- **Import / Export** — per-type **Export** / **Import** toggles (gate Feature 3).
- **Collection Dump** — per-type enable + Create/Restore/Delete + **Keep last N**.
- **Data Transfer** — saved environments + pull.

The Filters and Import / Export tabs share one config; each preserves the
other's part on save. Config shape (plugin-store key `filterConfig`; legacy
array form auto-normalized):

```jsonc
{
  "api::page.page": {
    "fields": ["websites", "countries", "page_type", "createdAt"], // Filters
    "export": true,                                                // Import / Export
    "import": false,                                               // Import / Export
    "dump": true                                                   // Collection Dump
  }
}
```

Other plugin-store keys: `dumps`, `dumpRetention`, `dataTransferTargets`.

---

## HTTP API

All routes are **admin-type** (authenticated admin), mounted under `/content-tools`.

| Method | Path                          | Body / input                                          | Purpose                              |
| ------ | ----------------------------- | ----------------------------------------------------- | ------------------------------------ |
| POST   | `/move-locale`                | `{ uid, documentId, sourceLocale, targetLocale }`     | Move one entry to another language   |
| POST   | `/move-locale-many`           | `{ uid, documentIds[], sourceLocale, targetLocale }`  | Bulk move                            |
| GET    | `/config`                     | —                                                     | Per-CT config `{ fields, export, import, dump }` |
| PUT    | `/config`                     | `{ config: { "<uid>": { … } } }`                      | Save config                          |
| GET    | `/schema`                     | —                                                     | Filterable fields per CT + config    |
| POST   | `/export`                     | `{ uid, documentIds[], locale }`                      | Export → `{ filename, contentBase64, count, mediaCount }` |
| POST   | `/import`                     | multipart, field `file` (the ZIP)                     | Import → `{ created, skipped, notPublished, missingRelations }` |
| GET    | `/dumps`                      | —                                                     | `{ retention, dumps: { uid: [...] } }` |
| PUT    | `/dumps/retention`            | `{ retention }`                                       | Set keep-last-N (1–7)                |
| POST   | `/dumps/create`               | `{ uid }`                                             | Create a dump                        |
| POST   | `/dumps/restore`              | `{ uid, dumpId }`                                     | Restore (wipe + recreate)            |
| POST   | `/dumps/ensure`               | —                                                     | Create today's dump for enabled CTs missing one |
| POST   | `/dumps/delete`               | `{ uid, dumpId }`                                     | Delete a dump                        |
| GET    | `/data-transfer/targets`      | —                                                     | Saved environments (token masked)    |
| PUT    | `/data-transfer/targets`      | `{ targets: [...] }`                                  | Save environments                    |
| POST   | `/data-transfer/pull`         | `{ targetId }`                                        | Start a pull (background) → status   |
| GET    | `/data-transfer/status`       | —                                                     | Current / last transfer status       |

`409`: `/move-locale` when the target language exists; `/data-transfer/pull`
when a transfer is already running.

---

## Project structure

```
strapi-plugin-content-tools/
├── admin/src/
│   ├── index.ts                 # settings section; inject filter bar + import button; move/export actions
│   ├── components/  SiteScopeFilter · RelocatedFilterBar · MoveLocaleDialog · ImportButton
│   ├── actions/     moveLocaleDocumentAction · moveLocaleBulkAction · exportBulkAction
│   ├── pages/       Settings (Filters) · ImportExport · CollectionDump · DataTransfer
│   └── utils/       scope.ts · configClient.ts
└── server/src/
    ├── index.js                 # server entry + daily-dump cron
    ├── routes/index.js
    ├── controllers/  move-locale · config · transfer · data-transfer · dumps
    └── services/     move-locale · config · transfer · data-transfer · dumps
```

`services/transfer.js` is the shared archive engine (build a media-aware ZIP,
and restore one), used by Export/Import and Collection Dump.

### Key integration points

- **Admin injection:** `injectComponent('listView','actions', …)` for the filter
  bar and Import button; `apis.addDocumentAction` / `apis.addBulkAction` for
  move + export.
- **Filter placement:** `RelocatedFilterBar` portals the row above the toolbar
  (before the action bar inside `<main id="main-content">`).
- **Config cache** on `window` so lazy chunks share one instance.
- **Locale move:** knex `UPDATE … SET locale` by `document_id`.
- **Archives/media:** ZIP manifest + `media/<hash><ext>`; `@strapi/upload`
  `folder`/`upload` services, deduped by hash.
- **Dumps:** disk files + plugin-store metadata; daily `strapi.cron.add` gated by
  `server.cron.enabled`.
- **Data transfer:** `@strapi/data-transfer` remote source → local destination
  (`strategy: 'restore'`).

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

---

## Known limitations

- **Locale move** doesn't trigger search-index reindexing (raw DB write).
- **Export size:** the ZIP is base64 in a JSON response — fine for typical
  exports; very large media sets would want a streamed binary download.
- **Media provider:** local provider read from disk; others fall back to fetching
  the file URL.
- **Import / restore relations** matched by natural key; unmatched links dropped
  and reported.
- **Collection Dump files** live under `<app>/.tmp` — **ephemeral if the image is
  rebuilt**; treat as short-lived snapshots, not long-term backups. Create/restore
  run synchronously with a progress modal. Daily cron only fires while running
  and needs `server.cron.enabled`.
- **Data Transfer** replaces local content + media only (config, admin accounts
  and tokens are kept), is same-version-only, runs in-process (restart after),
  and is pull-only.
- **Published-date filter** works against `publishedAt`; the list shows drafts by
  default (whose `publishedAt` is null), so it effectively surfaces published
  entries.
```
