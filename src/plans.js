/*
 * Preset application plans.
 *
 * A plan is a brand-agnostic seasonal program: each step is a product
 * *concept* (matched to the user's own products via product_types.name)
 * applied in certain calendar months, in one of two monthly slots
 * (week 1 or week 3 — the cadence both Lawn Addicts and Lawn Pride
 * programs share). Months are literal southern-hemisphere calendar
 * months (9 = September = early spring).
 *
 * `type` must equal a product_types.name for auto-matching in the wizard;
 * no match simply leaves the step unmatched there. `matchHint` breaks
 * ties between several products of the same type by name substring.
 */

const PLANS = [
  {
    id: 'couch-warm',
    name: 'Couch / Bermuda — warm season',
    description: 'Distilled monthly program for warm-season couch lawns, merged from the Lawn Addicts couch/bermuda warm-region calendars and the Lawn Pride green & blue couch standard program. Two slots per month: early (week 1) and mid (week 3).',
    steps: [
      { key: 'kelp', label: 'Kelp / seaweed biostimulant', type: 'Biostimulant',
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], week: 1, optional: false,
        note: 'Monthly all year', matchHint: 'kelp' },
      { key: 'liquid-fert', label: 'Liquid fertiliser + trace elements', type: 'Liquid fertiliser',
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], week: 3, optional: false,
        note: 'Monthly; reduce rate over winter (Jun–Aug)' },
      { key: 'soil-wetter', label: 'Soil wetter', type: 'Soil wetter',
        months: [9, 10, 11, 12, 1, 2], week: 1, optional: false,
        note: 'Monthly through spring & summer' },
      { key: 'granular', label: 'Granular fertiliser', type: 'Granular fertiliser',
        months: [9, 12, 3, 5], week: 1, optional: false,
        note: 'Start-of-season feed' },
      { key: 'pre-em', label: 'Pre-emergent herbicide', type: 'Herbicide - pre-emergent',
        months: [9, 3], week: 1, optional: false,
        note: 'Spring and autumn windows' },
      { key: 'grub', label: 'Grub preventative (Acelepryn-style)', type: 'Insecticide',
        months: [9, 1], week: 3, optional: true,
        note: 'Season-long protection from two applications' },
      { key: 'pgr', label: 'Plant growth regulator (Primo-style)', type: 'Plant growth regulator',
        months: [10, 11, 12, 1, 2, 3], week: 3, optional: true,
        note: 'Growing season only' },
      { key: 'phosphite', label: 'Phosphite (e.g. Phosfighter)', type: 'Biostimulant',
        months: [9, 10, 11, 12, 1, 2, 3, 4], week: 3, optional: true,
        note: 'Times of stress / growing season', matchHint: 'phosf' }
    ]
  }
];

// Week slot -> day of month. Fixed days keep generated dates predictable
// and valid in every month.
const WEEK_DAY = { 1: 3, 3: 17 };

/*
 * Resolve a plan into concrete planned_applications rows.
 *
 * startMonth: 'YYYY-MM'; the 12 months from here are generated.
 * mapping: { stepKey: { include: bool, product_id: number|null } }
 *   include:false skips the step; product_id null keeps it as a
 *   "no product assigned" reminder.
 * today: 'YYYY-MM-DD'; dates strictly before it are dropped so applying
 *   mid-month doesn't create instantly-overdue entries.
 */
function resolveEntries(plan, startMonth, mapping, zoneIds, today) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(startMonth || ''));
  if (!m) throw new Error('start_month must be YYYY-MM');
  const startYear = Number(m[1]);
  const startMon = Number(m[2]);
  if (startMon < 1 || startMon > 12) throw new Error('start_month must be YYYY-MM');

  const entries = [];
  for (let i = 0; i < 12; i++) {
    const mon = ((startMon - 1 + i) % 12) + 1;
    const year = startYear + Math.floor((startMon - 1 + i) / 12);
    for (const step of plan.steps) {
      const map = mapping[step.key];
      if (!map || !map.include) continue;
      if (!step.months.includes(mon)) continue;
      const date = `${year}-${String(mon).padStart(2, '0')}-${String(WEEK_DAY[step.week]).padStart(2, '0')}`;
      if (date < today) continue;
      for (const zoneId of zoneIds) {
        entries.push({
          zone_id: zoneId,
          product_id: map.product_id || null,
          concept: step.label,
          planned_date: date,
          source: 'preset:' + plan.id,
          optional: step.optional ? 1 : 0,
          notes: step.note || null
        });
      }
    }
  }
  return entries;
}

module.exports = { PLANS, resolveEntries };
