const express = require('express');
const db = require('./db');
const { buildSchedule, todayStr } = require('./schedule');
const { PLANS, resolveEntries } = require('./plans');

const router = express.Router();

// Unit conversion for stock deduction. Application quantities are in the
// product's rate_unit; stock is kept in stock_unit. Convert when both units
// are the same dimension (volume or mass); otherwise deduct the raw number.
const UNIT_FACTORS = { mL: ['vol', 1], L: ['vol', 1000], g: ['mass', 1], kg: ['mass', 1000] };
function convertQty(qty, fromUnit, toUnit) {
  const from = UNIT_FACTORS[fromUnit];
  const to = UNIT_FACTORS[toUnit];
  if (!from || !to || from[0] !== to[0]) return qty;
  return qty * from[1] / to[1];
}

function usedQty(app) {
  return app.actual_qty != null ? app.actual_qty : app.calculated_qty;
}

// Amount of one package in stock units, parsed from the free-text package_size ("2.5L bottle").
function packageQty(product) {
  if (!product.package_size) return null;
  const m = String(product.package_size).match(/([\d.]+)\s*(mL|L|g|kg)\b/i);
  if (!m) return null;
  const unit = { ml: 'mL', l: 'L', g: 'g', kg: 'kg' }[m[2].toLowerCase()];
  const qty = Number(m[1]);
  if (!qty || !unit) return null;
  if (UNIT_FACTORS[unit][0] !== UNIT_FACTORS[product.stock_unit][0]) return null;
  return convertQty(qty, unit, product.stock_unit);
}

// Low-stock threshold in stock units: an explicit threshold wins;
// otherwise fall back to 10% of a parseable package size.
function effectiveThreshold(product) {
  if (product.low_stock_threshold != null) return product.low_stock_threshold;
  const pkg = packageQty(product);
  return pkg != null ? pkg * 0.1 : null;
}

function httpError(res, code, msg) {
  return res.status(code).json({ error: msg });
}

// ---------- Product types ----------
router.get('/types', (req, res) => {
  res.json(db.prepare('SELECT * FROM product_types ORDER BY name').all());
});

router.post('/types', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return httpError(res, 400, 'Type name is required');
  try {
    const info = db.prepare('INSERT INTO product_types (name) VALUES (?)').run(name);
    res.status(201).json(db.prepare('SELECT * FROM product_types WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    return httpError(res, 409, 'A type with that name already exists');
  }
});

router.put('/types/:id', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return httpError(res, 400, 'Type name is required');
  const info = db.prepare('UPDATE product_types SET name = ? WHERE id = ?').run(name, req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Type not found');
  res.json(db.prepare('SELECT * FROM product_types WHERE id = ?').get(req.params.id));
});

router.delete('/types/:id', (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM products WHERE type_id = ?').get(req.params.id).n;
  if (inUse > 0) return httpError(res, 409, `Type is used by ${inUse} product(s)`);
  const info = db.prepare('DELETE FROM product_types WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Type not found');
  res.json({ ok: true });
});

// ---------- Products ----------
const PRODUCT_FIELDS = ['name', 'brand', 'type_id', 'rate_amount', 'rate_unit', 'rate_area_m2',
  'dilution_note', 'interval_days', 'stock_qty', 'stock_unit', 'package_size',
  'low_stock_threshold', 'notes', 'active'];

function validateProduct(body, res) {
  if (!body.name || !String(body.name).trim()) { httpError(res, 400, 'Name is required'); return null; }
  const rate = Number(body.rate_amount);
  if (!(rate > 0)) { httpError(res, 400, 'Application rate must be a positive number'); return null; }
  if (!UNIT_FACTORS[body.rate_unit]) { httpError(res, 400, 'Invalid rate unit'); return null; }
  if (!UNIT_FACTORS[body.stock_unit]) { httpError(res, 400, 'Invalid stock unit'); return null; }
  const rateArea = body.rate_area_m2 != null && body.rate_area_m2 !== '' ? Number(body.rate_area_m2) : 100;
  if (!(rateArea > 0)) { httpError(res, 400, 'Rate area must be a positive number'); return null; }
  let interval = null;
  if (body.interval_days != null && body.interval_days !== '') {
    interval = Math.round(Number(body.interval_days));
    if (!(interval > 0)) { httpError(res, 400, 'Interval must be a positive number of days (or blank for one-off)'); return null; }
  }
  return {
    name: String(body.name).trim(),
    brand: body.brand ? String(body.brand).trim() : null,
    type_id: body.type_id || null,
    rate_amount: rate,
    rate_unit: body.rate_unit,
    rate_area_m2: rateArea,
    dilution_note: body.dilution_note ? String(body.dilution_note).trim() : null,
    interval_days: interval,
    stock_qty: body.stock_qty != null && body.stock_qty !== '' ? Number(body.stock_qty) : 0,
    stock_unit: body.stock_unit,
    package_size: body.package_size ? String(body.package_size).trim() : null,
    low_stock_threshold: body.low_stock_threshold != null && body.low_stock_threshold !== '' ? Number(body.low_stock_threshold) : null,
    notes: body.notes ? String(body.notes).trim() : null,
    active: body.active === 0 || body.active === false ? 0 : 1
  };
}

router.get('/products', (req, res) => {
  const includeArchived = req.query.all === '1';
  const rows = db.prepare(`
    SELECT p.*, t.name AS type_name
    FROM products p LEFT JOIN product_types t ON t.id = p.type_id
    ${includeArchived ? '' : 'WHERE p.active = 1'}
    ORDER BY p.active DESC, p.name COLLATE NOCASE
  `).all();
  res.json(rows);
});

router.post('/products', (req, res) => {
  const p = validateProduct(req.body, res);
  if (!p) return;
  const cols = PRODUCT_FIELDS.join(', ');
  const params = PRODUCT_FIELDS.map(f => '@' + f).join(', ');
  const info = db.prepare(`INSERT INTO products (${cols}) VALUES (${params})`).run(p);
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/products/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Product not found');
  const p = validateProduct({ ...existing, ...req.body }, res);
  if (!p) return;
  const sets = PRODUCT_FIELDS.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE products SET ${sets} WHERE id = @id`).run({ ...p, id: existing.id });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(existing.id));
});

// Archive / unarchive (no hard delete - history must keep its products)
router.post('/products/:id/archive', (req, res) => {
  const info = db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Product not found');
  res.json({ ok: true });
});
router.post('/products/:id/unarchive', (req, res) => {
  const info = db.prepare('UPDATE products SET active = 1 WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Product not found');
  res.json({ ok: true });
});

// Restock: add an amount (in stock_unit) to stock on hand
router.post('/products/:id/restock', (req, res) => {
  const amount = Number(req.body.amount);
  if (!(amount > 0)) return httpError(res, 400, 'Restock amount must be a positive number');
  const info = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(amount, req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Product not found');
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// ---------- Zones ----------
router.get('/zones', (req, res) => {
  const includeArchived = req.query.all === '1';
  res.json(db.prepare(`SELECT * FROM zones ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY name COLLATE NOCASE`).all());
});

router.post('/zones', (req, res) => {
  const name = (req.body.name || '').trim();
  const area = Number(req.body.area_m2);
  if (!name) return httpError(res, 400, 'Zone name is required');
  if (!(area > 0)) return httpError(res, 400, 'Area must be a positive number of m2');
  const info = db.prepare('INSERT INTO zones (name, area_m2) VALUES (?, ?)').run(name, area);
  res.status(201).json(db.prepare('SELECT * FROM zones WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/zones/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Zone not found');
  const name = req.body.name != null ? String(req.body.name).trim() : existing.name;
  const area = req.body.area_m2 != null ? Number(req.body.area_m2) : existing.area_m2;
  const active = req.body.active != null ? (req.body.active ? 1 : 0) : existing.active;
  if (!name) return httpError(res, 400, 'Zone name is required');
  if (!(area > 0)) return httpError(res, 400, 'Area must be a positive number of m2');
  db.prepare('UPDATE zones SET name = ?, area_m2 = ?, active = ? WHERE id = ?').run(name, area, active, existing.id);
  res.json(db.prepare('SELECT * FROM zones WHERE id = ?').get(existing.id));
});

router.delete('/zones/:id', (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) AS n FROM applications WHERE zone_id = ?').get(req.params.id).n;
  if (inUse > 0) return httpError(res, 409, `Zone has ${inUse} logged application(s) - archive it instead`);
  const info = db.prepare('DELETE FROM zones WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Zone not found');
  res.json({ ok: true });
});

// ---------- Applications ----------
router.get('/applications', (req, res) => {
  const where = [];
  const params = {};
  if (req.query.product_id) { where.push('a.product_id = @product_id'); params.product_id = req.query.product_id; }
  if (req.query.zone_id) { where.push('a.zone_id = @zone_id'); params.zone_id = req.query.zone_id; }
  if (req.query.from) { where.push('a.date_applied >= @from'); params.from = req.query.from; }
  if (req.query.to) { where.push('a.date_applied <= @to'); params.to = req.query.to; }
  const rows = db.prepare(`
    SELECT a.*, p.name AS product_name, p.rate_unit, p.active AS product_active,
           z.name AS zone_name
    FROM applications a
    JOIN products p ON p.id = a.product_id
    JOIN zones z ON z.id = a.zone_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.date_applied DESC, a.id DESC
  `).all(params);
  res.json(rows);
});

function validateApplication(body, res) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(body.product_id);
  if (!product) { httpError(res, 400, 'Unknown product'); return null; }
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(body.zone_id);
  if (!zone) { httpError(res, 400, 'Unknown zone'); return null; }
  const date = String(body.date_applied || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { httpError(res, 400, 'Date must be YYYY-MM-DD'); return null; }
  const calculated = product.rate_amount * (zone.area_m2 / product.rate_area_m2);
  let actual = null;
  if (body.actual_qty != null && body.actual_qty !== '') {
    actual = Number(body.actual_qty);
    if (!(actual >= 0)) { httpError(res, 400, 'Actual quantity must be a non-negative number'); return null; }
    // Treat an override equal to the calculated amount as "no override"
    if (Math.abs(actual - calculated) < 1e-9) actual = null;
  }
  return {
    product, zone,
    row: {
      product_id: product.id,
      zone_id: zone.id,
      date_applied: date,
      calculated_qty: calculated,
      actual_qty: actual,
      notes: body.notes ? String(body.notes).trim() : null
    }
  };
}

// Deduct stock for an application. Stock floors at 0 — you can't use what you
// don't have — and the amount actually removed (in stock_unit) is returned so
// it can be recorded on the application and restored exactly on edit/delete.
function deductStock(productId, qtyInRateUnit) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const want = Math.max(0, convertQty(qtyInRateUnit, p.rate_unit, p.stock_unit));
  const deducted = Math.min(want, Math.max(0, p.stock_qty));
  db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?').run(deducted, productId);
  return { deducted, shortfall: want - deducted, stock_unit: p.stock_unit };
}

function restoreStock(app) {
  // Legacy rows (before deducted_qty was recorded) restore the full converted amount
  let amount = app.deducted_qty;
  if (amount == null) {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(app.product_id);
    amount = convertQty(usedQty(app), p.rate_unit, p.stock_unit);
  }
  db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(amount, app.product_id);
}

router.post('/applications', (req, res) => {
  const v = validateApplication(req.body, res);
  if (!v) return;
  const plannedId = req.body.planned_id ? Number(req.body.planned_id) : null;
  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO applications (product_id, zone_id, date_applied, calculated_qty, actual_qty, notes)
      VALUES (@product_id, @zone_id, @date_applied, @calculated_qty, @actual_qty, @notes)
    `).run(v.row);
    const d = deductStock(v.row.product_id, usedQty(v.row));
    db.prepare('UPDATE applications SET deducted_qty = ? WHERE id = ?').run(d.deducted, info.lastInsertRowid);
    if (plannedId) {
      db.prepare(`UPDATE planned_applications SET status = 'done', application_id = ?
                  WHERE id = ? AND status = 'planned'`).run(info.lastInsertRowid, plannedId);
    }
    return { id: info.lastInsertRowid, ...d };
  });
  const r = create();
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(r.id);
  res.status(201).json({ ...app, stock_shortfall: r.shortfall > 1e-9 ? r.shortfall : 0, stock_unit: r.stock_unit });
});

router.put('/applications/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Application not found');
  const v = validateApplication({ ...existing, ...req.body }, res);
  if (!v) return;
  const update = db.transaction(() => {
    // Return the old deduction to the old product's stock, then deduct the new amount
    restoreStock(existing);
    const d = deductStock(v.row.product_id, usedQty(v.row));
    db.prepare(`
      UPDATE applications SET product_id = @product_id, zone_id = @zone_id,
        date_applied = @date_applied, calculated_qty = @calculated_qty,
        actual_qty = @actual_qty, deducted_qty = @deducted_qty, notes = @notes
      WHERE id = @id
    `).run({ ...v.row, deducted_qty: d.deducted, id: existing.id });
  });
  update();
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(existing.id));
});

router.delete('/applications/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Application not found');
  const remove = db.transaction(() => {
    restoreStock(existing);
    // Deleting a log entry revives the planned entry it completed
    db.prepare(`UPDATE planned_applications SET status = 'planned', application_id = NULL
                WHERE application_id = ?`).run(existing.id);
    db.prepare('DELETE FROM applications WHERE id = ?').run(existing.id);
  });
  remove();
  res.json({ ok: true });
});

// Preview the calculated quantity for a product+zone (used by the log form)
router.get('/calc', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.query.product_id);
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.query.zone_id);
  if (!product || !zone) return httpError(res, 400, 'Unknown product or zone');
  const qty = product.rate_amount * (zone.area_m2 / product.rate_area_m2);
  res.json({ calculated_qty: qty, unit: product.rate_unit, dilution_note: product.dilution_note });
});

// ---------- Preset plans ----------
router.get('/plans', (req, res) => {
  res.json(PLANS);
});

// Apply a preset plan: generate planned_applications rows for the next
// 12 months. dry_run previews counts without writing; replace clears this
// plan's remaining future entries in the chosen zones first.
router.post('/plans/:planId/apply', (req, res) => {
  const plan = PLANS.find(p => p.id === req.params.planId);
  if (!plan) return httpError(res, 404, 'Unknown plan');

  const zoneIds = Array.isArray(req.body.zone_ids) ? req.body.zone_ids.map(Number) : [];
  if (!zoneIds.length) return httpError(res, 400, 'At least one zone is required');
  for (const id of zoneIds) {
    if (!db.prepare('SELECT id FROM zones WHERE id = ?').get(id)) return httpError(res, 400, `Unknown zone ${id}`);
  }

  const mapping = req.body.mapping || {};
  for (const [key, m] of Object.entries(mapping)) {
    if (!plan.steps.some(s => s.key === key)) return httpError(res, 400, `Unknown plan step "${key}"`);
    if (m && m.include && m.product_id != null &&
        !db.prepare('SELECT id FROM products WHERE id = ?').get(m.product_id)) {
      return httpError(res, 400, `Unknown product for step "${key}"`);
    }
  }

  const today = todayStr();
  let entries;
  try {
    entries = resolveEntries(plan, req.body.start_month, mapping, zoneIds, today);
  } catch (e) {
    return httpError(res, 400, e.message);
  }
  if (!entries.length) return httpError(res, 400, 'Nothing to schedule — no steps included');

  if (req.body.dry_run) {
    const byStep = {};
    const dates = entries.map(e => e.planned_date).sort();
    for (const e of entries) byStep[e.concept] = (byStep[e.concept] || 0) + 1;
    return res.json({ count: entries.length, byStep, from: dates[0], to: dates[dates.length - 1] });
  }

  const zoneMarks = zoneIds.map(() => '?').join(',');
  const existing = db.prepare(`
    SELECT COUNT(*) AS n FROM planned_applications
    WHERE source = ? AND status = 'planned' AND planned_date >= ? AND zone_id IN (${zoneMarks})
  `).get('preset:' + plan.id, today, ...zoneIds).n;
  if (existing > 0 && !req.body.replace) {
    return res.status(409).json({ error: `This plan already has ${existing} upcoming entr${existing === 1 ? 'y' : 'ies'} in the selected zone(s)`, existing });
  }

  const apply = db.transaction(() => {
    if (existing > 0) {
      db.prepare(`
        DELETE FROM planned_applications
        WHERE source = ? AND status = 'planned' AND planned_date >= ? AND zone_id IN (${zoneMarks})
      `).run('preset:' + plan.id, today, ...zoneIds);
    }
    const ins = db.prepare(`
      INSERT INTO planned_applications (zone_id, product_id, concept, planned_date, source, optional, notes)
      VALUES (@zone_id, @product_id, @concept, @planned_date, @source, @optional, @notes)
    `);
    for (const e of entries) ins.run(e);
  });
  apply();
  res.status(201).json({ created: entries.length, replaced: existing });
});

// Remove a plan's remaining future entries (done/skipped/past rows are kept)
router.post('/plans/:planId/clear', (req, res) => {
  const plan = PLANS.find(p => p.id === req.params.planId);
  if (!plan) return httpError(res, 404, 'Unknown plan');
  const zoneIds = Array.isArray(req.body.zone_ids) ? req.body.zone_ids.map(Number) : null;
  const zoneClause = zoneIds && zoneIds.length ? `AND zone_id IN (${zoneIds.map(() => '?').join(',')})` : '';
  const info = db.prepare(`
    DELETE FROM planned_applications
    WHERE source = ? AND status = 'planned' AND planned_date >= ? ${zoneClause}
  `).run('preset:' + plan.id, todayStr(), ...(zoneIds && zoneIds.length ? zoneIds : []));
  res.json({ deleted: info.changes });
});

// ---------- Planned applications ----------
router.get('/planned', (req, res) => {
  const where = [];
  const params = {};
  if (req.query.from) { where.push('pl.planned_date >= @from'); params.from = req.query.from; }
  if (req.query.to) { where.push('pl.planned_date <= @to'); params.to = req.query.to; }
  if (req.query.zone_id) { where.push('pl.zone_id = @zone_id'); params.zone_id = req.query.zone_id; }
  const status = req.query.status || 'planned';
  if (status !== 'all') { where.push('pl.status = @status'); params.status = status; }
  if (req.query.all !== '1') where.push('z.active = 1');
  const rows = db.prepare(`
    SELECT pl.*, p.name AS product_name, p.active AS product_active, z.name AS zone_name
    FROM planned_applications pl
    LEFT JOIN products p ON p.id = pl.product_id
    JOIN zones z ON z.id = pl.zone_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY pl.planned_date, pl.id
  `).all(params);
  res.json(rows);
});

function validatePlanned(body, res) {
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(body.zone_id);
  if (!zone) { httpError(res, 400, 'Unknown zone'); return null; }
  if (body.product_id != null && body.product_id !== '' &&
      !db.prepare('SELECT id FROM products WHERE id = ?').get(body.product_id)) {
    httpError(res, 400, 'Unknown product'); return null;
  }
  const concept = (body.concept || '').trim();
  if (!concept) { httpError(res, 400, 'A description of the planned application is required'); return null; }
  const date = String(body.planned_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { httpError(res, 400, 'Date must be YYYY-MM-DD'); return null; }
  return {
    zone_id: zone.id,
    product_id: body.product_id != null && body.product_id !== '' ? Number(body.product_id) : null,
    concept,
    planned_date: date,
    optional: body.optional ? 1 : 0,
    notes: body.notes ? String(body.notes).trim() : null
  };
}

router.post('/planned', (req, res) => {
  const v = validatePlanned(req.body, res);
  if (!v) return;
  const info = db.prepare(`
    INSERT INTO planned_applications (zone_id, product_id, concept, planned_date, source, optional, notes)
    VALUES (@zone_id, @product_id, @concept, @planned_date, 'manual', @optional, @notes)
  `).run(v);
  res.status(201).json(db.prepare('SELECT * FROM planned_applications WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/planned/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM planned_applications WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Planned application not found');
  const v = validatePlanned({ ...existing, ...req.body }, res);
  if (!v) return;
  let status = existing.status;
  if (req.body.status != null) {
    if (!['planned', 'done', 'skipped'].includes(req.body.status)) return httpError(res, 400, 'Invalid status');
    status = req.body.status;
  }
  db.prepare(`
    UPDATE planned_applications SET zone_id = @zone_id, product_id = @product_id, concept = @concept,
      planned_date = @planned_date, optional = @optional, notes = @notes, status = @status
    WHERE id = @id
  `).run({ ...v, status, id: existing.id });
  res.json(db.prepare('SELECT * FROM planned_applications WHERE id = ?').get(existing.id));
});

router.delete('/planned/:id', (req, res) => {
  const info = db.prepare('DELETE FROM planned_applications WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return httpError(res, 404, 'Planned application not found');
  res.json({ ok: true });
});

// ---------- Schedule & dashboard ----------
router.get('/schedule', (req, res) => {
  res.json(buildSchedule());
});

router.get('/dashboard', (req, res) => {
  const schedule = buildSchedule();
  // Low stock: explicit threshold, or 10% of package size when no threshold is set.
  // Out-of-stock products are always flagged once they've actually been used
  // (never-stocked products the user hasn't touched shouldn't nag).
  const lowStock = db.prepare(`
    SELECT p.*, EXISTS(SELECT 1 FROM applications a WHERE a.product_id = p.id) AS has_apps
    FROM products p WHERE p.active = 1 ORDER BY p.name COLLATE NOCASE
  `).all()
    .map(p => ({ p, thr: effectiveThreshold(p) }))
    .filter(({ p, thr }) => (p.stock_qty <= 0 && p.has_apps) || (thr != null && p.stock_qty <= thr))
    .map(({ p, thr }) => ({
      id: p.id, name: p.name, stock_qty: p.stock_qty, stock_unit: p.stock_unit,
      low_stock_threshold: p.low_stock_threshold, effective_threshold: thr,
      out_of_stock: p.stock_qty <= 0
    }));
  res.json({ ...schedule, lowStock });
});

module.exports = router;
