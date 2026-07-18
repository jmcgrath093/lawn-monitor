const express = require('express');
const db = require('./db');
const { buildSchedule } = require('./schedule');

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

function adjustStock(productId, deltaInRateUnit) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  const delta = convertQty(deltaInRateUnit, p.rate_unit, p.stock_unit);
  db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(delta, productId);
}

router.post('/applications', (req, res) => {
  const v = validateApplication(req.body, res);
  if (!v) return;
  const create = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO applications (product_id, zone_id, date_applied, calculated_qty, actual_qty, notes)
      VALUES (@product_id, @zone_id, @date_applied, @calculated_qty, @actual_qty, @notes)
    `).run(v.row);
    adjustStock(v.row.product_id, -usedQty(v.row));
    return info.lastInsertRowid;
  });
  const id = create();
  res.status(201).json(db.prepare('SELECT * FROM applications WHERE id = ?').get(id));
});

router.put('/applications/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Application not found');
  const v = validateApplication({ ...existing, ...req.body }, res);
  if (!v) return;
  const update = db.transaction(() => {
    // Return the old deduction to the old product's stock, then deduct the new amount
    adjustStock(existing.product_id, usedQty(existing));
    db.prepare(`
      UPDATE applications SET product_id = @product_id, zone_id = @zone_id,
        date_applied = @date_applied, calculated_qty = @calculated_qty,
        actual_qty = @actual_qty, notes = @notes
      WHERE id = @id
    `).run({ ...v.row, id: existing.id });
    adjustStock(v.row.product_id, -usedQty(v.row));
  });
  update();
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(existing.id));
});

router.delete('/applications/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id);
  if (!existing) return httpError(res, 404, 'Application not found');
  const remove = db.transaction(() => {
    adjustStock(existing.product_id, usedQty(existing));
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

// ---------- Schedule & dashboard ----------
router.get('/schedule', (req, res) => {
  res.json(buildSchedule());
});

router.get('/dashboard', (req, res) => {
  const schedule = buildSchedule();
  const lowStock = db.prepare(`
    SELECT id, name, stock_qty, stock_unit, low_stock_threshold
    FROM products
    WHERE active = 1 AND low_stock_threshold IS NOT NULL AND stock_qty <= low_stock_threshold
    ORDER BY name COLLATE NOCASE
  `).all();
  res.json({ ...schedule, lowStock });
});

module.exports = router;
