# Content Tools

A Strapi 5 plugin that adds Content-Manager productivity tools:

1. **Sticky, configurable list filters** — pick which fields become quick
   filters per content type (relations, enumerations, booleans, and
   `createdAt` / `publishedAt` date ranges). Selections stick across reloads
   and navigation via a cookie, like the language selector.
2. **Move an entry between languages** — reassign an entry's locale in place
   (single, per-row, and bulk), without creating a copy.
3. **Collection Dump** — snapshot a whole collection (all entries + media +
   folder structure) to disk, keep the last N, and restore a snapshot
   (wipe + recreate). Manual and once-a-day automatic.
4. **Data Transfer** — pull *all* data (content, media, config) from another
   Strapi environment into this one, from the admin panel.

Published as [`strapi-plugin-content-tools`](https://www.npmjs.com/package/strapi-plugin-content-tools).
The admin code is TypeScript, the server code is CommonJS; both build to `dist/`
via `@strapi/sdk-plugin`. `@strapi/design-system`, `@strapi/icons`,
`@strapi/data-transfer`, react and styled-components are peer dependencies
(shared with the host app).

---

## Table of contents

- [Installation & enabling](#installation--enabling)
- [Feature 1 — Sticky filters](#feature-1--sticky-filters)
- [Feature 2 — Move to another language](#feature-2--move-to-another-language)
- [Feature 3 — Collection Dump](#feature-3--collection-dump)
- [Feature 4 — Data Transfer](#feature-4--data-transfer)
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

Configured per content type in **Settings → Content Tools → Filters**; nothing
appears until enabled there. Field names are auto-detected from the schema
(so different types can use different relation field names). Noisy relations
(`createdBy`, `updatedBy`, `localizations`, and any `admin::user` relation) are
never offered.

### Date range presets

`createdAt` / `publishedAt` offer: **Today**, **Last 3 days**, **Last week**,
**Last month** (30 d), **Last year** (365 d). Cutoffs snap to start-of-day so a
selected preset still reads correctly after a same-day reload.

### Stickiness

Stored in the `content-tools:scope` cookie. **Relation** picks are keyed by
target uid (a Website pick sticks across every content type referencing it);
**enum / boolean / date** picks are stored per content type. The URL `filters`
param is the live source of truth; the cookie seeds it when a list has no
filter yet.

---

## Feature 2 — Move to another language

Reassigns an entry's locale **in place** at the database level — no copy, and
nothing left in the source locale. Both draft and published rows of the
document are moved; component / relation / media links (keyed by entry id)
survive untouched.

**Conflict handling:** if the document already exists in the target language,
the move is **blocked with a warning** (single) or that entry is **skipped and
reported** (bulk).

Triggers: **edit-view action panel**, the **list-view row `⋯` menu**, and the
**list-view bulk bar**. Only for localized collection types on entries that
already exist.

> ⚠️ Writes at the DB level and bypasses document-service lifecycles, so
> search-index / reindex plugins do not fire automatically — reindex manually
> if an external index must reflect the change.

---

## Feature 3 — Collection Dump

**Settings → Content Tools → Collection Dump** — full-collection snapshots.

- **Enable per content type** (checkbox) and set **Keep last N dumps** (max 7).
- A **dump** is a ZIP of the whole collection (every document, all locales,
  media + folder structure), written to disk, with metadata in the plugin store.
- **Create dump** — manual button, shows a progress modal.
- **Restore** — **wipe the collection and recreate it from the snapshot**
  (media deduped by hash, relations matched by name). Destructive; confirmed
  with a modal.
- **Retention** — when a collection exceeds *Keep last N*, its oldest dump is
  deleted.

### Automatic dumps

- Enabling a collection (on **Save**) **creates its dump immediately** if it
  doesn't already have one from today.
- A **daily cron** (03:00 server time) dumps every enabled collection, but
  **skips** any that already has a dump dated today (manual or auto), so the
  same day is never duplicated.

Requires the host app to have Strapi's scheduler enabled
(`config/server` → `cron: { enabled: true }`).

---

## Feature 4 — Data Transfer

**Settings → Content Tools → Data Transfer** — pull *all* data from another
Strapi environment into this one, using the built-in `@strapi/data-transfer`
engine (the same machinery as the `strapi transfer` CLI).

- **Save environments**: `{ name, url, transfer token }` (token stored masked;
  blank on re-save keeps the stored one).
- **Pull & replace**: `remote source → local destination` with the **restore**
  strategy, run as a **background job** with a polled status line.
- The local side runs in-process (`getStrapi: () => strapi`), so only the
  remote's token is needed.

**Source requirements:** a **Transfer token** from the source env
(Settings → Transfer Tokens; not an API token) and the **same Strapi version**
(`versionStrategy: 'exact'`).

**Scope:** content, media/assets, and configuration transfer; **admin accounts,
API/transfer tokens and audit logs are excluded** (Strapi default) so you are
not locked out.

> ⚠️ Destructive: pulling deletes this environment's data and replaces it with
> the source's. No undo — back up first. Only remote → local (pull) is offered.
> Restart Strapi after a pull so the running instance loads fresh schema/data.

---

## Settings pages

Registered via `createSettingSection` under a **Content Tools** section.

### Filters

Every `api::` collection type as a card; each shows its filterable fields
grouped into **Relations / Choices / Dates**. **Save** persists to the plugin
store and shows a **"Reload to apply"** prompt (open Content-Manager views pick
up the change on their next load).

### Collection Dump

Per-collection **Enable dumps** checkbox + Create / Restore / Delete controls
and the global **Keep last N** retention — see
[Feature 3](#feature-3--collection-dump).

### Data Transfer

Saved environments + pull — see [Feature 4](#feature-4--data-transfer).

Config shape (plugin-store key `filterConfig`; legacy array form
auto-normalized on read):

```jsonc
{
  "api::page.page": {
    "fields": ["websites", "countries", "page_type", "createdAt"], // Filters tab
    "dump": true                                                   // Collection Dump tab
  }
}
```

Other plugin-store keys: `dumps` (dump metadata per uid), `dumpRetention`,
`dataTransferTargets`.

---

## HTTP API

All routes are **admin-type** (require an authenticated admin session), mounted
under `/content-tools`.

| Method | Path                          | Body / input                                          | Purpose                              |
| ------ | ----------------------------- | ----------------------------------------------------- | ------------------------------------ |
| POST   | `/move-locale`                | `{ uid, documentId, sourceLocale, targetLocale }`     | Move one entry to another language   |
| POST   | `/move-locale-many`           | `{ uid, documentIds[], sourceLocale, targetLocale }`  | Bulk move                            |
| GET    | `/config`                     | —                                                     | Per-CT config `{ fields, dump }`     |
| PUT    | `/config`                     | `{ config: { "<uid>": { fields, dump } } }`           | Save config                          |
| GET    | `/schema`                     | —                                                     | Filterable fields per CT + config    |
| GET    | `/dumps`                      | —                                                     | `{ retention, dumps: { uid: [...] } }` |
| PUT    | `/dumps/retention`            | `{ retention }`                                       | Set keep-last-N (1–7)                |
| POST   | `/dumps/create`               | `{ uid }`                                             | Create a dump                        |
| POST   | `/dumps/restore`              | `{ uid, dumpId }`                                     | Restore (wipe + recreate)            |
| POST   | `/dumps/ensure`               | —                                                     | Create today's dump for enabled CTs missing one |
| POST   | `/dumps/delete`               | `{ uid, dumpId }`                                     | Delete a dump                        |
| GET    | `/data-transfer/targets`      | —                                                     | Saved environments (token masked)    |
| PUT    | `/data-transfer/targets`      | `{ targets: [{ id, name, url, token }] }`             | Save environments                    |
| POST   | `/data-transfer/pull`         | `{ targetId }`                                        | Start a pull (background) → status   |
| GET    | `/data-transfer/status`       | —                                                     | Current / last transfer status       |

`409` is returned by `/move-locale` when the target language already exists, and
by `/data-transfer/pull` when a transfer is already running.

---

## Project structure

```
strapi-plugin-content-tools/
├── package.json
├── admin/src/
│   ├── index.ts                 # register settings section; inject filter bar; register move actions
│   ├── components/
│   │   ├── SiteScopeFilter.tsx    # the filter controls (config-driven)
│   │   ├── RelocatedFilterBar.tsx # portals the filter row above the toolbar
│   │   └── MoveLocaleDialog.tsx   # shared move-locale modal body/footer
│   ├── actions/
│   │   ├── moveLocaleDocumentAction.tsx  # edit panel + row-menu action
│   │   └── moveLocaleBulkAction.tsx      # bulk move
│   ├── pages/
│   │   ├── Settings.tsx           # Filters
│   │   ├── CollectionDump.tsx     # Collection Dump
│   │   └── DataTransfer.tsx       # Data Transfer
│   └── utils/
│       ├── scope.ts               # cookie + URL-filter helpers + date presets
│       └── configClient.ts        # window-shared cache of the config
└── server/src/
    ├── index.js                   # server entry + daily-dump cron registration
    ├── routes/index.js            # admin routes under /content-tools
    ├── controllers/{move-locale,config,data-transfer,dumps}.js
    └── services/{move-locale,config,transfer,data-transfer,dumps}.js
```

`services/transfer.js` is an internal engine (build a media-aware archive from a
collection, and restore one) reused by the Collection Dump feature — it has no
routes of its own.

### Key integration points

- **Admin injection:** `getPlugin('content-manager').injectComponent('listView','actions', …)`
  for the filter bar; `apis.addDocumentAction` / `apis.addBulkAction` for move.
- **Filter placement:** `RelocatedFilterBar` keeps a hidden marker in the
  `listView.actions` zone and portals the real UI into a `<div>` inserted before
  the action bar inside `<main id="main-content">`, copying its computed padding.
- **Config cache:** stored on `window` so lazy settings chunks and the list-view
  chunk share one instance (clearing on save applies without a full reload).
- **Locale move:** knex `UPDATE … SET locale`, keyed by `document_id`.
- **Dumps / media:** `services/transfer.js` builds/restores a ZIP (manifest +
  `media/<hash><ext>`); media via `@strapi/upload` `folder`/`upload` services,
  deduped by hash; restore-replace deletes documents via the document service.
- **Cron:** `strapi.cron.add` in the server bootstrap, gated by the app's
  `server.cron.enabled`.
- **Data transfer:** `@strapi/data-transfer` remote source → local destination
  (`strategy: 'restore'`) via `createTransferEngine`.

---

## Development & deployment

Built with [`@strapi/sdk-plugin`](https://docs.strapi.io/cms/plugins-development/plugin-sdk).

```bash
npm install
npm run build      # bundle admin + server to dist/
npm run verify     # marketplace-readiness gate
npm run watch:link # develop against a linked Strapi app (yalc)
```

Quick server-side health check (admin routes require auth, so `401` = healthy):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:1337/content-tools/config   # 401
```

### Publishing

```bash
npm version patch          # bump (commits + tags)
npm run build && npm run verify
npm publish --access public
```

Then submit the npm package to the [Strapi Marketplace](https://market.strapi.io).

---

## Known limitations

- **Search-index reindex** is not triggered by the locale move (raw DB write).
- **Collection Dump files** live under `<app>/.tmp` — **ephemeral if the
  container image is rebuilt** (metadata then points at missing files, which
  restore reports cleanly). Treat dumps as short-lived working snapshots, not
  long-term backups. Point the dump dir at a persisted volume for durability.
- **Dump create/restore** run synchronously with a progress modal; a very large
  collection can be slow.
- **Restore relations** are matched by natural key; unmatched links are dropped
  and reported.
- **Daily dump cron** only fires while the container is running and requires
  `server.cron.enabled`; it does not back-fill missed days.
- **Published-date filter** works against `publishedAt`; because the list view
  shows the draft version by default (whose `publishedAt` is null), it
  effectively surfaces entries that have been published.
- **Data Transfer** is destructive (full restore), requires the source to be the
  same Strapi version, runs in-process (restart after a pull), and excludes
  admin accounts/tokens. Pull only (remote → local).
```
