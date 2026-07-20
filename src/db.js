const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lawn.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS product_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  brand TEXT,
  type_id INTEGER REFERENCES product_types(id),
  rate_amount REAL NOT NULL,
  rate_unit TEXT NOT NULL CHECK (rate_unit IN ('mL','L','g','kg')),
  rate_area_m2 REAL NOT NULL DEFAULT 100,
  dilution_note TEXT,
  interval_days INTEGER,            -- NULL = one-off / seasonal / as-needed
  stock_qty REAL NOT NULL DEFAULT 0,
  stock_unit TEXT NOT NULL CHECK (stock_unit IN ('mL','L','g','kg')),
  package_size TEXT,
  low_stock_threshold REAL,         -- in stock_unit; NULL = no warning
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  area_m2 REAL NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  date_applied TEXT NOT NULL,       -- YYYY-MM-DD
  calculated_qty REAL NOT NULL,     -- in the product's rate_unit
  actual_qty REAL,                  -- manual override, same unit; NULL = used calculated
  deducted_qty REAL,                -- stock actually removed, in stock_unit; NULL = legacy row
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applications_product ON applications(product_id, date_applied);
CREATE INDEX IF NOT EXISTS idx_applications_zone ON applications(zone_id, date_applied);

CREATE TABLE IF NOT EXISTS planned_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  product_id INTEGER REFERENCES products(id),        -- NULL = "no product assigned" reminder
  concept TEXT NOT NULL,                             -- display label, e.g. 'Kelp / seaweed biostimulant'
  planned_date TEXT NOT NULL,                        -- YYYY-MM-DD
  source TEXT NOT NULL DEFAULT 'manual',             -- 'preset:<plan id>' | 'manual'
  optional INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','skipped')),
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_planned_date ON planned_applications(planned_date);
CREATE INDEX IF NOT EXISTS idx_planned_zone ON planned_applications(zone_id, planned_date);
`);

// ---- Migrations for databases created before deducted_qty existed ----
const appCols = db.prepare('PRAGMA table_info(applications)').all().map(c => c.name);
if (!appCols.includes('deducted_qty')) {
  db.exec('ALTER TABLE applications ADD COLUMN deducted_qty REAL');
}
// Stock can no longer go negative; repair rows left by the old deduction logic
db.prepare('UPDATE products SET stock_qty = 0 WHERE stock_qty < 0').run();

// ---- Seed on first run only (empty product_types table) ----
const typeCount = db.prepare('SELECT COUNT(*) AS n FROM product_types').get().n;
if (typeCount === 0) {
  const seedTypes = [
    'Herbicide - pre-emergent',
    'Herbicide - selective post-emergent',
    'Herbicide - non-selective',
    'Fungicide',
    'Insecticide',
    'Granular fertiliser',
    'Liquid fertiliser',
    'Biostimulant',
    'Soil wetter'
  ];
  const insType = db.prepare('INSERT INTO product_types (name) VALUES (?)');
  const typeIds = {};
  for (const t of seedTypes) typeIds[t] = insType.run(t).lastInsertRowid;

  const insProduct = db.prepare(`
    INSERT INTO products (name, brand, type_id, rate_amount, rate_unit, rate_area_m2,
      dilution_note, interval_days, stock_qty, stock_unit, package_size, notes)
    VALUES (@name, @brand, @type_id, @rate_amount, @rate_unit, 100,
      @dilution_note, @interval_days, 0, @stock_unit, @package_size, @notes)
  `);

  const seedProducts = [
    {
      name: 'Spartan', brand: null, type_id: typeIds['Herbicide - pre-emergent'],
      rate_amount: 25, rate_unit: 'mL', stock_unit: 'mL', dilution_note: null,
      interval_days: null, package_size: null,
      notes: 'Label rate range 10-40mL/100m2 (seeded at 25). One-off / seasonal - apply per season, no auto-recurrence.'
    },
    {
      name: 'Bow & Arrow', brand: null, type_id: typeIds['Herbicide - selective post-emergent'],
      rate_amount: 50, rate_unit: 'mL', stock_unit: 'mL', dilution_note: null,
      interval_days: null, package_size: null,
      notes: 'Selective broadleaf post-emergent. As-needed - no fixed interval.'
    },
    {
      name: 'Impala', brand: null, type_id: typeIds['Fungicide'],
      rate_amount: 60, rate_unit: 'mL', stock_unit: 'mL', dilution_note: 'in 5L water per 100m2',
      interval_days: 28, package_size: null,
      notes: 'Preventative interval 28 days, or as-needed under disease pressure.'
    },
    {
      name: 'Kelpro', brand: null, type_id: typeIds['Biostimulant'],
      rate_amount: 120, rate_unit: 'mL', stock_unit: 'mL', dilution_note: null,
      interval_days: 21, package_size: null,
      notes: 'Kelp biostimulant. Label interval 14-28 days (seeded at 21).'
    },
    {
      name: 'Phosfighter', brand: null, type_id: typeIds['Biostimulant'],
      rate_amount: 150, rate_unit: 'mL', stock_unit: 'mL', dilution_note: null,
      interval_days: 21, package_size: null,
      notes: 'P/K + amino acids. Label rate range 100-200mL/100m2 (seeded at 150), interval 14-28 days (seeded at 21).'
    },
    {
      name: 'Special FeX', brand: null, type_id: typeIds['Liquid fertiliser'],
      rate_amount: 300, rate_unit: 'mL', stock_unit: 'mL', dilution_note: null,
      interval_days: 21, package_size: null,
      notes: 'Fe/Mn/N liquid fertiliser. Label rate range 200-400mL/100m2 (seeded at 300), interval 14-28 days (seeded at 21).'
    },
    {
      name: 'Hydrolink Rapid', brand: null, type_id: typeIds['Soil wetter'],
      rate_amount: 35, rate_unit: 'mL', stock_unit: 'mL', dilution_note: null,
      interval_days: null, package_size: null,
      notes: 'Label rate range 20-50mL/100m2 (seeded at 35). As-needed - no fixed interval.'
    },
    {
      name: 'Maintain', brand: null, type_id: typeIds['Granular fertiliser'],
      rate_amount: 2, rate_unit: 'kg', stock_unit: 'kg', dilution_note: null,
      interval_days: 90, package_size: null,
      notes: 'Slow release, ~90 day interval.'
    }
  ];
  const seedAll = db.transaction(() => {
    for (const p of seedProducts) insProduct.run(p);
  });
  seedAll();
}

module.exports = db;
