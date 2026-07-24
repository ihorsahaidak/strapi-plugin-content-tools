# Content Tools

A local Strapi 5 plugin that adds Content-Manager productivity tools for this
project:

1. **Sticky, configurable list filters** — pick which fields become quick
   filters per content type (relations, enumerations, booleans, and
   `createdAt` / `publishedAt` date ranges). Selections stick across reloads
   and navigation via a cookie, like the language selector.
2. **Move an entry between languages** — reassign an entry's locale in place
   (single, per-row, and bulk), without creating a copy.
3. **Export / Import entries with media** — export selected entries to a ZIP
   (including their media files and folder structure) and import that archive
   into another environment.

Everything lives under `src/plugins/content-tools` and is enabled as a local
plugin — there is no separate build/publish step. The admin code is TypeScript
(bundled by Strapi's Vite build); the server code is plain CommonJS.

---

## Table of contents

- [Installation & enabling](#installation--enabling)
- [Feature 1 — Sticky filters](#feature-1--sticky-filters)
- [Feature 2 — Move to another language](#feature-2--move-to-another-language)
- [Feature 3 — Export / Import with media](#feature-3--export--import-with-media)
- [Settings page](#settings-page)
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

Requires **Strapi 5**. The export/import feature bundles `jszip`. No content
types are assumed — filters are opt-in per content type from
**Settings → Content Tools → Filters**.

---

## Feature 1 — Sticky filters

Adds a filter row **above** the Content-Manager list toolbar (Search / Filters
bar). Each configured field renders a control:

| Field kind      | Control                                   | Query applied                        |
| --------------- | ----------------------------------------- | ------------------------------------ |
| `relation`      | searchable dropdown of related entries    | `filters[field][id][$eq]=<id>`       |
| `enumeration`   | value dropdown                            | `filters[field][$eq]=<value>`        |
| `boolean`       | Yes / No dropdown                         | `filters[field][$eq]=<true\|false>`  |
| `createdAt`     | date-range preset dropdown                | `filters[createdAt][$gte]=<iso>`     |
| `publishedAt`   | date-range preset dropdown (D&P only)     | `filters[publishedAt][$gte]=<iso>`   |

### Which fields appear

The set of fields is **configured per content type** in
**Settings → Content Tools → Filters** (see [Settings page](#settings-page)).
On first run, `website` / `country` relations are enabled by default wherever
they exist, preserving the original out-of-the-box behavior.

Field names are auto-detected from the schema, so different content types can
use different relation field names (e.g. Page uses `websites` / `countries`,
Content Block uses `website` / `country`).

### Date range presets

`createdAt` / `publishedAt` filters offer: **Today**, **Last 3 days**,
**Last week** (7 d), **Last month** (30 d), **Last year** (365 d). Cutoffs are
snapped to start-of-day so a selected preset still reads correctly after a
same-day reload.

### Stickiness

Selections are stored in the `content-tools:scope` cookie:

- **Relation** picks are keyed by target uid, so choosing a Website sticks
  across every content type that references websites.
- **Enum / boolean / date** picks are stored per content type.

The URL `filters` query param is the live source of truth; the cookie seeds it
when you land on a list with no filter yet.

---

## Feature 2 — Move to another language

Reassigns an entry's locale **in place** at the database level — no copy is
created and nothing is left behind in the source locale. Both the draft and
published rows of the document are moved. Component / relation / media links
survive untouched (they are keyed by entry id, not locale).

**Conflict handling:** if the document already exists in the target language,
the move is **blocked with a warning** (single) or that entry is **skipped and
reported** (bulk).

### Where to trigger it

- **Edit view** → right-hand action panel → *Move to another language*.
- **List view row** → the `⋯` menu → *Move to another language*.
- **List view bulk** → select entries → *Move to another language* in the bulk
  bar.

Only shown for localized collection types on entries that already exist.

> ⚠️ The move writes at the DB level and bypasses document-service lifecycles,
> so the `strapi-algolia` reindex does **not** fire automatically. Use
> **Index all items** afterwards if search must reflect the new language.

---

## Feature 3 — Export / Import with media

### Export

A **bulk action** *Export selected* in the list view. It:

1. Deep-populates each selected entry (components, dynamic zones, media,
   relations) using the fragment API for polymorphic dynamic zones.
2. Replaces media with `{ __media: <hash> }` refs and relations with
   `{ __rel: <target>, field, value }` natural-key refs (schema-driven walk).
3. Bundles a `manifest.json` plus the actual media bytes into a ZIP.
4. Returns the ZIP base64-encoded (so it flows through the authenticated fetch
   client); the browser decodes it to a Blob and downloads it.

Media **folder structure is preserved** — each file records its folder path as
name segments (not environment-specific pathIds).

### Import

An **Import** button in the list toolbar opens a dialog to upload a ZIP
exported from any environment. On import the server:

1. Recreates the media folder tree **by name**, creating any missing folders.
2. **Dedupes media by hash** — reuses an existing file if the same hash is
   already present; otherwise uploads the bytes into the resolved folder.
3. **Matches relations by name** (`name` / `slug` / `title` / `code` / `uid`) in
   the target environment. Unmatched relations are skipped and reported.
4. **Skips same-slug + locale conflicts** and reports them (no overwrite).
5. Creates each entry, **publishes** it (D&P types) so `publishedAt` = import
   time, and stamps `createdAt` = import time.

The import notification summarises: created / skipped / not-published /
unmatched relations.

### Manifest format (v1)

```jsonc
{
  "version": 1,
  "uid": "api::page.page",
  "exportedAt": "2026-07-24T...",
  "locale": "fr-FR",
  "media": [
    { "hash": "abc123", "ext": ".jpg", "mime": "image/jpeg",
      "name": "banner.jpg", "folderSegments": ["Marketing", "Banners"] }
  ],
  "entities": [
    { "documentId": "...", "locale": "fr-FR", "data": { /* transformed */ } }
  ]
}
```

Media bytes live in the ZIP under `media/<hash><ext>`.

---

## Settings page

**Settings → Content Tools → Filters** (registered via `createSettingSection`).

- Lists every `api::` collection type as a card.
- Each card shows a checkbox per filterable field: relations, enumerations,
  booleans, **Created At**, and **Published At** (draft&publish types only).
- **Save** persists the configuration to the plugin store (shared across all
  admins). Saved config is picked up by list views on their next load.

Config shape (persisted under plugin-store key `filterConfig`):

```jsonc
{ "api::page.page": ["websites", "countries", "page_type", "createdAt"] }
```

Server-side sanitisation drops any field that is not a valid filterable
attribute of that content type (plus the special `createdAt` / `publishedAt`).

---

## HTTP API

All routes are **admin-type** (require an authenticated admin session) and are
mounted under `/content-tools`.

| Method | Path                        | Body / input                                            | Purpose                              |
| ------ | --------------------------- | ------------------------------------------------------- | ------------------------------------ |
| POST   | `/move-locale`              | `{ uid, documentId, sourceLocale, targetLocale }`       | Move one entry to another language   |
| POST   | `/move-locale-many`         | `{ uid, documentIds[], sourceLocale, targetLocale }`    | Bulk move                            |
| GET    | `/config`                   | —                                                       | Current per-CT filter config         |
| PUT    | `/config`                   | `{ config: { "<uid>": ["field", …] } }`                 | Save filter config                   |
| GET    | `/schema`                   | —                                                       | Filterable fields per CT + config    |
| POST   | `/export`                   | `{ uid, documentIds[], locale }`                        | Export → `{ filename, contentBase64, count, mediaCount }` |
| POST   | `/import`                   | multipart, field `file` (the ZIP)                       | Import → `{ created, skipped, notPublished, missingRelations }` |

`409` is returned by `/move-locale` when the target language already exists.

---

## Project structure

```
src/plugins/content-tools/
├── package.json                 # local-plugin exports (admin=TS, server=JS)
├── README.md
├── admin/src/
│   ├── index.ts                 # register settings section; bootstrap injections/actions
│   ├── pluginId.ts
│   ├── components/
│   │   ├── SiteScopeFilter.tsx   # the filter controls (config-driven)
│   │   ├── RelocatedFilterBar.tsx# portals the filter row above the toolbar
│   │   ├── MoveLocaleDialog.tsx  # shared move-locale modal body/footer
│   │   └── ImportButton.tsx      # toolbar Import button + dialog
│   ├── actions/
│   │   ├── moveLocaleDocumentAction.tsx  # edit panel + row-menu action
│   │   ├── moveLocaleBulkAction.tsx      # bulk move
│   │   └── exportBulkAction.tsx          # bulk export/download
│   ├── pages/
│   │   └── Settings.tsx          # Settings → Content Tools → Filters
│   └── utils/
│       ├── scope.ts              # cookie + URL-filter helpers + date presets
│       └── configClient.ts       # cached fetch of the filter config
└── server/src/
    ├── index.js                  # plugin server entry (routes/controllers/services)
    ├── routes/index.js           # admin routes under /content-tools
    ├── controllers/{move-locale,config,transfer}.js
    └── services/{move-locale,config,transfer}.js
```

### Key integration points

- **Admin injection:** `getPlugin('content-manager').injectComponent('listView','actions', …)`
  for the filter bar and Import button.
- **Actions:** `apis.addDocumentAction(…)` and `apis.addBulkAction(…)`.
- **Filter placement:** `RelocatedFilterBar` keeps a hidden marker in the
  `listView.actions` zone and portals the real UI into a `<div>` inserted
  before the action bar inside `<main id="main-content">`, copying the action
  bar's computed horizontal padding so edges align.
- **Locale move:** knex `UPDATE … SET locale` on the collection table, keyed by
  `document_id`.
- **Media:** `@strapi/upload` `folder` + `upload` services; dedupe via
  `strapi.db.query('plugin::upload.file').findOne({ where: { hash } })`.

---

## Development & deployment

This package is built with [`@strapi/sdk-plugin`](https://docs.strapi.io/cms/plugins-development/plugin-sdk).

```bash
npm install
npm run build      # bundle admin + server to dist/
npm run verify     # check the build is marketplace-ready
npm run watch:link # develop against a linked Strapi app (yalc)
```

To develop inside a host app, use `npm run watch:link` here and `yalc add
strapi-plugin-content-tools` in the app, or install from a local path. After
admin changes, rebuild the app's admin and **hard-refresh** the browser tab
(`Cmd/Ctrl + Shift + R`) — the tab caches the admin bundle until forced to
reload.

Quick server-side health check (admin routes require auth, so `401` = healthy):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1337/content-tools/config   # 401
```

### Publishing

```bash
npm run build && npm run verify
npm publish --access public
```

Then submit the published npm package to the [Strapi Marketplace](https://market.strapi.io).

---

## Known limitations

- **Search-index reindex** is not triggered by the locale move (raw DB write),
  since it bypasses document-service lifecycles. Reindex affected content types
  manually if an external search index must reflect the change immediately.
- **Export size:** the ZIP is returned base64 in a JSON response. Fine for
  typical exports; very large media sets would be better served by a streamed
  binary download (not yet implemented).
- **Media provider:** the local provider is read from disk; other providers
  fall back to fetching the file URL.
- **Import relations:** matched by natural key in the target environment; if no
  match exists the link is dropped and reported (never auto-created).
- **Import publish state:** D&P entries are published on import (so
  `publishedAt` = import time). Entries that fail validation on publish remain
  as drafts and are reported under `notPublished`.
- **Published-date filter** works against the `publishedAt` column; because the
  list view shows the draft version by default (whose `publishedAt` is null),
  it effectively surfaces entries that have been published.
