# 🌱 Lawn Monitor

Self-hosted lawn care product tracker. Single user, single container, SQLite — designed to sit behind your own reverse proxy (Nginx Proxy Manager + Authelia); the app has no auth of its own and makes no external calls.

## Features

- **Product library** — types (editable tag list), rate per area, dilution notes, reapplication interval, stock on hand, package size, low-stock threshold, notes. Products are archived, never deleted, so history stays intact.
- **Zones** — named lawn areas with m², across multiple properties.
- **Application logging** — pick product + zone + date; quantity is auto-calculated from `rate × (zone area ÷ rate area)`, deducted from stock, and manually overridable. Editing/deleting a log entry adjusts stock back correctly.
- **Auto-scheduling** — next due = *actual* last application date + interval (never a calendar grid). Overdue items show how many days late. One-off/seasonal products (blank interval) are never auto-scheduled. Unapplied products show as "not yet started".
- **Views** — dashboard (overdue / due this week / next 2 weeks / low stock), monthly calendar (past applications + upcoming/overdue due dates), filterable product library, filterable history log.
- **Preset plans** — apply a pre-made seasonal program (currently "Couch / Bermuda — warm season", distilled from the Lawn Addicts and Lawn Pride couch programs) from the Calendar. The wizard maps each plan *concept* (kelp, soil wetter, pre-emergent…) to your own products by type, then schedules dated planned entries for the next 12 months. Planned entries show as rings on the calendar (click a day to log/skip/edit/delete them), appear in a "This month's plan" dashboard panel, and convert to a logged application with one click — everything stays individually editable.
- Mobile-friendly — usable from a phone standing on the lawn.

### Design decision: scheduling is per product **and zone**

Because you manage two properties, recurrence is tracked per (product, zone) pair: applying Kelpro to the front lawn at home doesn't mark it "done" for the other property. A product with no applications anywhere shows once as "not yet started".

## Run with Docker (recommended)

```bash
docker compose up -d --build
```

Then open `http://<host>:3000`. Configuration:

| Variable | Default | Purpose |
|---|---|---|
| `LAWN_MONITOR_PORT` | `3000` | Host port to publish (compose) |
| `TZ` | `Australia/Sydney` | Container timezone — affects "today" for due calculations |
| `DB_PATH` | `/data/lawn.db` | SQLite location (inside container) |

The database lives in the `lawn-data` named volume. To use a bind mount instead, replace the volume line with e.g. `- /opt/appdata/lawn-monitor:/data`.

Point Nginx Proxy Manager at `http://<docker-host>:3000` and protect it with Authelia as usual.

### Backups

It's one SQLite file: `docker exec lawn-monitor sh -c "sqlite3 /data/lawn.db '.backup /data/backup.db'"` or just copy `/data/lawn.db` while the app is idle.

## Run locally (dev)

```bash
npm install
npm start        # http://localhost:3000, DB at ./data/lawn.db
```

## Seed data

On first run (empty DB) the product library is pre-populated with Spartan, Bow & Arrow, Impala, Kelpro, Phosfighter, Special FeX, Hydrolink Rapid and Maintain, plus a starter set of product types. Where the label gives a range, a midpoint was seeded and the full range noted in the product's notes:

- Spartan 25mL/100m² (label 10–40), one-off/seasonal
- Kelpro / Phosfighter / Special FeX intervals seeded at 21 days (label 14–28)
- Phosfighter 150mL/100m² (label 100–200), Special FeX 300mL/100m² (label 200–400), Hydrolink Rapid 35mL/100m² (label 20–50)

All stock quantities start at 0 — use **Restock** or **Edit** on each product to set what you actually have. Zones start empty; add your lawn areas in the **Zones** tab before logging.

## Data model

- `products` — name, brand, type_id, rate_amount/rate_unit/rate_area_m2, dilution_note, interval_days (NULL = one-off/as-needed), stock_qty/stock_unit, package_size, low_stock_threshold, notes, active
- `product_types` — editable list of type tags
- `zones` — name, area_m2, active
- `applications` — product_id, zone_id, date_applied, calculated_qty, actual_qty (NULL = used calculated), notes
- `planned_applications` — zone_id, product_id (NULL = reminder without a product), concept, planned_date, source (`preset:<plan>` or `manual`), optional, status (planned/done/skipped), application_id (link to the log entry that completed it), notes

A product that has an `interval_days` **and** appears in a plan shows both a derived due-dot and a planned ring on the calendar — that's intentional (the two systems are independent). If you run a product purely off the plan, clear its interval.

Stock deduction converts between mL↔L and g↔kg automatically when a product's rate unit and stock unit differ.

## API

REST under `/api`: `types`, `products` (+ `/archive`, `/unarchive`, `/restock`), `zones`, `applications` (with `product_id`/`zone_id`/`from`/`to` filters), `calc` (quantity preview), `schedule`, `dashboard`, `plans` (+ `/:id/apply` with dry-run/replace, `/:id/clear`), `planned` (CRUD, with `from`/`to`/`zone_id`/`status` filters). All JSON.
