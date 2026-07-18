const db = require('./db');

// Date helpers - all dates are 'YYYY-MM-DD' strings, math done in UTC to avoid DST issues.
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function diffDays(fromStr, toStr) {
  const a = new Date(fromStr + 'T00:00:00Z');
  const b = new Date(toStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

/**
 * Build the schedule. Recurrence is tracked per (product, zone) pair, because
 * applying a product at one property doesn't cover the other. Next-due is always
 * last actual application date + interval - never a fixed calendar grid.
 *
 * Returns:
 *  - items: one entry per (active product, active zone) pair that has history,
 *    with last_applied, next_due (recurring only), status and day counts.
 *  - notStarted: active products with no applications anywhere.
 */
function buildSchedule() {
  const today = todayStr();

  const lastApps = db.prepare(`
    SELECT a.product_id, a.zone_id, MAX(a.date_applied) AS last_applied
    FROM applications a
    JOIN products p ON p.id = a.product_id
    JOIN zones z ON z.id = a.zone_id
    WHERE p.active = 1 AND z.active = 1
    GROUP BY a.product_id, a.zone_id
  `).all();

  const products = {};
  for (const p of db.prepare('SELECT * FROM products WHERE active = 1').all()) products[p.id] = p;
  const zones = {};
  for (const z of db.prepare('SELECT * FROM zones WHERE active = 1').all()) zones[z.id] = z;

  const items = [];
  const startedProductIds = new Set();

  for (const row of lastApps) {
    const p = products[row.product_id];
    const z = zones[row.zone_id];
    if (!p || !z) continue;
    startedProductIds.add(p.id);

    const item = {
      product_id: p.id,
      product_name: p.name,
      zone_id: z.id,
      zone_name: z.name,
      interval_days: p.interval_days,
      last_applied: row.last_applied,
      days_since: diffDays(row.last_applied, today),
      next_due: null,
      days_until_due: null,
      days_overdue: null,
      status: 'one_off'
    };

    if (p.interval_days != null) {
      item.next_due = addDays(row.last_applied, p.interval_days);
      const delta = diffDays(today, item.next_due); // positive = in the future
      if (delta < 0) {
        item.status = 'overdue';
        item.days_overdue = -delta;
      } else if (delta <= 7) {
        item.status = 'due_soon';
        item.days_until_due = delta;
      } else if (delta <= 14) {
        item.status = 'upcoming';
        item.days_until_due = delta;
      } else {
        item.status = 'ok';
        item.days_until_due = delta;
      }
    }
    items.push(item);
  }

  // Sort: overdue first (most overdue at top), then by next_due ascending, one-offs last.
  const rank = { overdue: 0, due_soon: 1, upcoming: 2, ok: 3, one_off: 4 };
  items.sort((a, b) => {
    const r = rank[a.status] - rank[b.status];
    if (r !== 0) return r;
    if (a.next_due && b.next_due) return a.next_due < b.next_due ? -1 : 1;
    return diffDays(a.last_applied, b.last_applied); // one-offs: most recent last-applied first
  });

  const notStarted = Object.values(products)
    .filter(p => !startedProductIds.has(p.id))
    .map(p => ({ product_id: p.id, product_name: p.name, interval_days: p.interval_days, status: 'not_started' }));

  return { today, items, notStarted };
}

module.exports = { buildSchedule, addDays, todayStr, diffDays };
