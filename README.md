# Content Tools

A Strapi 5 plugin that adds Content-Manager productivity tools:

1. **Sticky, configurable list filters** — pick which fields become quick
   filters per content type (relations, enumerations, booleans, and
   `createdAt` / `publishedAt` date ranges). Selections stick across reloads
   and navigation via a cookie, like the language selector.
2. **Language tools** — reassign an entry's locale in place (single, per-row,
   and bulk), without creating a copy. Or move one *language* onto a different
   entry, for when a translation was filled in on the wrong one, with a
   configurable label so you can tell candidates apart. Both are opt-in per
   content type.
3. **Data Transfer** — pull content + media from another Strapi environment
   into this one from the admin panel, with an optional pre-pull backup,
   live progress, and local regeneration of every image's responsive formats.

Published as [`strapi-plugin-content-tools`](https://www.npmjs.com/package/strapi-plugin-content-tools).

---

## Table of contents

- [Installation & enabling](#installation--enabling)
- [Feature 1 — Always-on filters](#feature-1--always-on-filters)
- [Feature 2 — Language tools](#feature-2--language-tools)
  - [Move to another language](#move-to-another-language)
  - [Move one language onto another entry](#move-one-language-onto-another-entry)
  - [Configuring the merge picker's label](#configuring-the-merge-pickers-label)
- [Feature 3 — Data Transfer](#feature-3--data-transfer)
- [Settings pages](#settings-pages)
- [HTTP API](#http-api)
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

Requires **Strapi 5**. Nothing is enabled by default — filters and the two
language-tools actions are opt-in per content type from **Settings → Content
Tools**.

---

## Feature 1 — Always-on filters

Adds a filter row **above** the Content-Manager list toolbar. Each configured
field renders a control:

| Field kind      | Control                                   | Query applied                        |
| --------------- | ----------------------------------------- | ------------------------------------ |
| `relation`      | searchable dropdown of related entries    | `filters[field][id][$eq]=<id>`       |
| `enumeration`   | value dropdown                            | `filters[field][$eq]=<value>`        |
| `boolean`       | Yes / No dropdown                         | `filters[field][$eq]=<true\|false>`  |
| `createdAt`     | date-range preset dropdown                | `filters[createdAt][$gte]=<iso>`     |
| `publishedAt`   | date-range preset dropdown (D&P only)     | `filters[publishedAt][$gte]=<iso>`   |

Configured per content type in **Settings → Content Tools → Always-on filters**; nothing
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

## Feature 2 — Language tools

Two independent actions, covered below. Both are **opt-in per content type**,
switched on in **Settings → Content Tools → Language tools** — a tab that only
lists localized collection types, since neither action means anything for a
non-localized one. Nothing appears anywhere until enabled, the same "off until
configured" default as Always-on filters.

This is enforced twice, not just in the UI: enabling/disabling hides or shows
the actions in the Content Manager immediately, **and** the server
independently checks the same config before performing the operation,
rejecting it with `403` if the content type isn't enabled. A stale browser tab
that still shows an action after it's been disabled elsewhere can't act on it.

### Move to another language

Reassigns an entry's locale **in place** at the database level — no copy, and
nothing left in the source locale. Both draft and published rows move; component
/ relation / media links (keyed by entry id) survive untouched.

**Conflict:** if the document already exists in the target language, the move is
**blocked with a warning** (single) or **skipped and reported** (bulk).

Triggers: **edit-view action panel**, the **row `⋯` menu**, and the **bulk bar**.
Only for localized collection types on entries that already exist.

### Move one language onto another entry

The mirror image of the above: the language stays, the entry it belongs to
changes. Look for **Move this language to another entry** in:

- the **edit-view action panel** — the "…" (more actions) menu near
  Publish/Unpublish;
- each row's own **`⋯` kebab menu** in the list view (scroll right if it's cut
  off — it's the last column).

It is **not** in the bulk-selection toolbar that appears when you tick
checkboxes — that bar only ever shows *bulk* actions, and merging always asks
"onto which one entry?", a question bulk-selecting several rows can't answer.
Deselect any ticked rows if you don't see it; you're looking at the wrong menu,
not a missing feature.

Use it when a translation ends up on the wrong entry — you filled in French on a
duplicate, and the entry you actually want has every language *except* French.
Rather than retyping it there, move the French version across. Both draft and
published rows move together, and because components, relations and media are
keyed by row id, they travel with it untouched.

- Only entries **without** that language are offered as a target — Strapi
  requires `(documentId, locale, publishedAt)` to be unique, so an entry can
  hold exactly one version per language.
- The source entry keeps its remaining languages, and **disappears entirely if
  that was its only one** — which is usually the point.
- Each candidate in the picker is labelled using **your configured template**
  (see below), so you can tell them apart without guessing from a raw id.

### Configuring the merge picker's label

By default the picker falls back to a heuristic label (title/name/slug/the
content-manager's own mainField, whichever exists) — not always enough to tell
two similar entries apart. In **Settings → Content Tools → Language tools**,
enabling "Move this language to another entry" for a content type reveals an
**Entry label template** field, e.g.:

```
{title} — {slug} — {lang}
```

Underneath it, a row of buttons lists every variable available for that content
type — its own text/string/richtext/uid/email/enum/numeric/boolean/date
fields, plus two built-ins: `{documentId}` and `{lang}`. **Click one to insert
it** at the current cursor position in the template field, so you can build a
template without typing braces by hand.

`{lang}` matters because most fields are themselves per-locale — "the title" of
a document isn't one fixed value. Since a merge candidate by definition lacks
the language being moved, its label is built from **one representative row**:
the site's default locale if the candidate has it, otherwise its earliest
locale code. `{lang}` names exactly which one supplied the data shown, so the
label never implies a language the candidate doesn't have.

Leave the template empty to keep the heuristic fallback.

> ⚠️ Both language-tools operations bypass document-service lifecycles (raw DB
> write), so search-index plugins don't reindex automatically.

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

**Relations that can't be reconnected are reported.** The links stage remaps
every source id to its new local id; when it can't, the engine drops that link
and the record imports without the relation. Nothing looks broken — until
something downstream filters on it (a listing that requires a category, say,
quietly stops showing those entries). The pull counts these, names them in the
result line, and logs each one, so a partial import is visible instead of
looking like missing content.

> ⚠️ **Numeric ids change on every pull.** The restore deletes every row and
> re-inserts it, so Postgres assigns fresh ids (`documentId` is preserved).
> Anything caching a numeric id — bookmarked admin URLs, saved filters, external
> references — goes stale. If a list looks empty right after a pull, that is
> almost always the cause.

> ⚠️ Give the DB pool headroom (`DATABASE_POOL_MAX`); a restore holds
> connections and the admin can starve while it runs.

## Settings pages

Registered via `createSettingSection` under a **Content Tools** section —
three tabs:

- **Always-on filters** — filterable fields per content type, grouped
  **Relations / Choices / Dates**. Save shows a **"Reload to apply"** prompt.
- **Language tools** — per *localized* content type: enable **Move to another
  language** and/or **Move this language to another entry**, and — when the
  latter is on — the merge picker's **Entry label template** with click-to-insert
  variable buttons.
- **Data Transfer** — saved environments, pull, live status, backup.

The first two tabs are separate pages but **share one config object per
content type** (plugin-store key `filterConfig`; legacy bare-array form
auto-normalized) — `fields` belongs to Always-on filters, `moveLocale` /
`mergeLocale` / `mergeLabelTemplate` to Language tools. Each page always loads
the whole entry and merges only its own edits onto it before saving, so saving
on one tab can never erase what the other configured — including while both
are open in different tabs at once, as long as each is saved with its own
fresh load rather than a stale one carried over from before the other's edit.

```jsonc
{
  "api::page.page": {
    "fields": ["websites", "countries", "page_type", "createdAt"],
    "moveLocale": true,
    "mergeLocale": true,
    "mergeLabelTemplate": "{title} — {slug} — {lang}"
  }
}
```

`moveLocale`/`mergeLocale` are only ever persisted `true` for localized
collection types — the server strips them for anything else regardless of what
a request sends.

Other plugin-store keys: `dataTransferTargets`, `dataTransferBackups`,
`dataTransferEstimates`.

---

## HTTP API

All routes are **admin-type** (authenticated admin), mounted under `/content-tools`.

| Method | Path                             | Body / input                                          | Purpose                              |
| ------ | -------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| POST   | `/move-locale`                   | `{ uid, documentId, sourceLocale, targetLocale }`     | Move one entry to another language   |
| POST   | `/move-locale-many`              | `{ uid, documentIds[], sourceLocale, targetLocale }`  | Bulk move                            |
| GET    | `/merge-candidates`              | `?uid=&documentId=&locale=&q=`                        | Entries that lack `locale` (merge targets) |
| POST   | `/merge-locale`                  | `{ uid, sourceDocumentId, targetDocumentId, locale }` | Move one language onto another entry |
| GET    | `/config`                        | —                                                     | Per-CT config `{ fields, moveLocale, mergeLocale, mergeLabelTemplate }` |
| PUT    | `/config`                        | `{ config: { "<uid>": { … } } }`                      | Save config                          |
| GET    | `/schema`                        | —                                                     | Filterable fields, `localized`, `templateFields` per CT + config |
| GET    | `/data-transfer/targets`         | —                                                     | Saved environments (token masked)    |
| PUT    | `/data-transfer/targets`         | `{ targets: [...] }`                                  | Save environments                    |
| POST   | `/data-transfer/probe`           | `{ targetId }`                                        | Reachability / token / version check |
| POST   | `/data-transfer/pull`            | `{ targetId, skipMedia, skipBackup }`                 | Start a pull (background) → status   |
| POST   | `/data-transfer/stop`            | `{ rollback }`                                        | Stop, optionally rolling back        |
| GET    | `/data-transfer/status`          | —                                                     | Current / last transfer status       |
| GET    | `/data-transfer/backups`         | —                                                     | Saved backup (at most one)           |
| POST   | `/data-transfer/restore-backup`  | `{ backupId }`                                        | Restore a backup                     |

`409`: `/move-locale` and `/merge-locale` when the target already has that language; `/data-transfer/pull`
when a transfer is already running.


---

## Known limitations

- **Language tools are off by default** for every content type — both actions
  need enabling in Settings → Content Tools → Language tools before they
  appear anywhere.
- **Locale move / merge** don't trigger search-index reindexing (raw DB write).
- **Merge candidates with a label template** are capped at **500** (fetched in
  document-id order, before search/sort) — building a templated label needs
  real row data rather than one SQL-aggregated column, so it can't sort/search
  the database directly the way the untemplated fallback can. A content type
  with more than 500 documents lacking a given language may not surface every
  possible target through search.
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
