/* Lawn Monitor - single-file frontend, no build step. */
'use strict';

// ---------- Utilities ----------
const $ = sel => document.querySelector(sel);

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body != null ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtShort(str) { // "Sat 18 Jul"
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return `${WDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function fmtDate(str) { // "18 Jul 2026"
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtQty(n) {
  if (n == null) return '';
  const r = Math.round(n * 100) / 100;
  return String(r % 1 === 0 ? Math.round(r) : r);
}

// Convert between mL/L or g/kg; returns qty unchanged across dimensions.
const UNIT_FACTORS = { mL: ['vol', 1], L: ['vol', 1000], g: ['mass', 1], kg: ['mass', 1000] };
function convertQty(qty, fromUnit, toUnit) {
  const from = UNIT_FACTORS[fromUnit];
  const to = UNIT_FACTORS[toUnit];
  if (!from || !to || from[0] !== to[0]) return qty;
  return qty * from[1] / to[1];
}

// Explicit low-stock threshold wins; otherwise 10% of a parseable package size.
function effThreshold(p) {
  if (p.low_stock_threshold != null) return p.low_stock_threshold;
  const pkg = parsePkg(p.package_size, p.stock_unit);
  return pkg != null ? pkg * 0.1 : null;
}

// Parse a leading "<number><unit>" out of a free-text package size ("2.5L bottle"),
// converted into the product's stock unit. Returns null when unparseable.
function parsePkg(text, stockUnit) {
  if (!text || !stockUnit) return null;
  const m = String(text).match(/([\d.]+)\s*(mL|L|g|kg)\b/i);
  if (!m) return null;
  let qty = parseFloat(m[1]);
  if (!qty) return null;
  const unit = { ml: 'mL', l: 'L', g: 'g', kg: 'kg' }[m[2].toLowerCase()];
  const fam = u => (u === 'mL' || u === 'L') ? 'vol' : 'mass';
  if (fam(unit) !== fam(stockUnit)) return null;
  const inBase = unit === 'L' || unit === 'kg' ? qty * 1000 : qty; // mL / g
  return stockUnit === 'L' || stockUnit === 'kg' ? inBase / 1000 : inBase;
}

function setHead(title, sub, actions = '') {
  $('#screen-title').textContent = title;
  $('#screen-sub').textContent = sub;
  $('#head-actions').innerHTML = actions;
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.innerHTML = `<span class="toast-mark" aria-hidden="true">${isError ? '✕' : '✓'}</span>${esc(msg)}`;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---------- Theme ----------
function applyTheme(dark) {
  if (dark) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  const btn = $('#theme-toggle');
  btn.textContent = dark ? '☀ Light' : '☾ Dark';
  btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-pressed', String(dark));
  try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
}
$('#theme-toggle').addEventListener('click', () =>
  applyTheme(document.documentElement.dataset.theme !== 'dark'));
applyTheme(document.documentElement.dataset.theme === 'dark');

// ---------- Modal ----------
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() {
  $('#modal-backdrop').classList.add('hidden');
  $('#modal').innerHTML = '';
}
$('#modal-backdrop').addEventListener('click', e => {
  if (e.target === $('#modal-backdrop')) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ---------- Status labels ----------
function statusBadge(item) {
  switch (item.status) {
    case 'overdue': return `<span class="badge overdue">Overdue by ${item.days_overdue}d</span>`;
    case 'due_soon': return `<span class="badge due-soon">${item.days_until_due === 0 ? 'Due today' : 'Due in ' + item.days_until_due + 'd'}</span>`;
    case 'upcoming': return `<span class="badge upcoming">Due in ${item.days_until_due}d</span>`;
    case 'ok': return `<span class="badge ok">Due in ${item.days_until_due}d</span>`;
    case 'one_off': return `<span class="badge neutral">${item.last_applied ? 'Last ' + fmtShort(item.last_applied) : 'As needed'}</span>`;
    case 'not_started': return `<span class="badge neutral">Never applied</span>`;
    default: return '';
  }
}

// ---------- Views ----------
const view = $('#view');

async function renderDashboard() {
  const now = new Date();
  const mFirst = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const mLast = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
  const [d, monthPlan] = await Promise.all([
    api('/dashboard'),
    api(`/planned?from=${mFirst}&to=${mLast}`)
  ]);
  const overdue = d.items.filter(i => i.status === 'overdue');
  const dueSoon = d.items.filter(i => i.status === 'due_soon');
  const upcoming = d.items.filter(i => i.status === 'upcoming');
  const oneOffs = d.items.filter(i => i.status === 'one_off');
  const ok = d.items.filter(i => i.status === 'ok');

  setHead('Today', 'What needs doing');

  const stat = (value, label, alertCls) =>
    `<div class="stat"><div class="stat-num${value ? ' ' + alertCls : ''}">${value}</div><div class="stat-label">${label}</div></div>`;
  const statsHtml = `<div class="stats">
    ${stat(overdue.length, 'Overdue', 'alert-red')}
    ${stat(dueSoon.length, 'Due this week', 'alert-amber')}
    ${stat(d.lowStock.length, 'Low stock', 'alert-red')}
  </div>`;

  const schedRow = i => `
    <div class="row-card">
      <div class="row-main">
        <div class="row-name">${esc(i.product_name)}</div>
        <div class="row-sub">${esc(i.zone_name)} · last applied ${i.days_since}d ago</div>
        ${statusBadge(i)}
      </div>
      <button class="row-act btn-primary" onclick="openLogForm(${i.product_id}, ${i.zone_id})">Log</button>
    </div>`;
  const lowRow = p => `
    <div class="row-card">
      <div class="row-main">
        <div class="row-name">${esc(p.name)}</div>
        ${p.effective_threshold != null ? `<div class="row-sub">warn below ${fmtQty(p.effective_threshold)}${esc(p.stock_unit)}</div>` : ''}
        <span class="badge overdue">${p.out_of_stock ? 'Out of stock' : `${fmtQty(p.stock_qty)}${esc(p.stock_unit)} left`}</span>
      </div>
      <button class="row-act btn-ghost" onclick="openRestockForm(${p.id})">Restock</button>
    </div>`;
  const today = todayStr();
  const planRow = e => `
    <div class="row-card">
      <div class="row-main">
        <div class="row-name">${esc(e.concept)}</div>
        <div class="row-sub">${fmtShort(e.planned_date)} · ${esc(e.zone_name)}${e.product_id ? ' · ' + esc(e.product_name) : ' · no product assigned'}</div>
        ${e.planned_date < today ? '<span class="badge due-soon">Missed</span>' : (e.optional ? '<span class="badge neutral">Optional</span>' : '')}
      </div>
      <button class="row-act btn-primary" onclick="logPlanned(${e.id})">Log</button>
    </div>`;
  const nsRow = p => `
    <div class="row-card">
      <div class="row-main">
        <div class="row-name">${esc(p.product_name)}</div>
        <span class="badge neutral">Never applied</span>
      </div>
      <button class="row-act btn-primary" onclick="openLogForm(${p.product_id})">Log</button>
    </div>`;

  const panels = [];
  const push = (title, dotCls, rows) => {
    if (!rows.length) return;
    panels.push(`
      <section class="panel">
        <div class="panel-head"><span class="dot ${dotCls}"></span><span class="panel-title">${title}</span><span class="pill">${rows.length}</span></div>
        <div class="panel-rows">${rows.join('')}</div>
      </section>`);
  };
  push('Low stock', 'dot-red', d.lowStock.map(lowRow));
  push('Overdue', 'dot-red', overdue.map(schedRow));
  push('Due this week', 'dot-amber', dueSoon.map(schedRow));
  push("This month's plan", 'dot-blue', monthPlan.map(planRow));
  push('Coming up', 'dot-blue', upcoming.map(schedRow));
  push('One-off products', 'dot-gray', oneOffs.map(schedRow));
  push('On track', 'dot-green', ok.map(schedRow));
  push('Never applied', 'dot-gray', d.notStarted.map(nsRow));

  view.innerHTML = statsHtml + (panels.length
    ? `<div class="masonry">${panels.join('')}</div>`
    : `<div class="caught-up"><strong>All caught up 🌱</strong><span>Nothing due right now.</span></div>`);
}

// ---------- Calendar ----------
let calYear, calMonth; // month is 1-12
let presetSources = []; // 'preset:<id>' sources with upcoming entries, set by renderCalendar

async function renderCalendar() {
  const now = new Date();
  if (!calYear) { calYear = now.getFullYear(); calMonth = now.getMonth() + 1; }

  const monthStart = `${calYear}-${String(calMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(calYear, calMonth, 0).getDate();
  const monthEnd = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const [apps, schedule, planned] = await Promise.all([
    api(`/applications?from=${monthStart}&to=${monthEnd}`),
    api('/schedule'),
    api('/planned') // all upcoming/outstanding planned entries (active zones)
  ]);

  const today = todayStr();
  presetSources = [...new Set(planned
    .filter(pl => pl.source.startsWith('preset:') && pl.planned_date >= today)
    .map(pl => pl.source))];

  setHead('Calendar', 'Applications, due dates & planned work', `
    ${presetSources.length ? '<button class="btn-head" onclick="clearPresetPlan()">Clear preset entries</button>' : ''}
    <button class="btn-head btn-head-primary" onclick="openApplyPlanWizard()">Apply a plan</button>`);
  const appliedMap = {}; // date -> [labels]
  for (const a of apps) {
    (appliedMap[a.date_applied] = appliedMap[a.date_applied] || [])
      .push(`${a.product_name} → ${a.zone_name}`);
  }
  // date -> {cls, prio, labels}: worst status wins the dot colour
  const DUE_CLS = { overdue: ['due-red', 0], due_soon: ['due-amber', 1], upcoming: ['due-blue', 2], ok: ['due-green', 3] };
  const dueMap = {};
  for (const i of schedule.items) {
    if (!i.next_due) continue;
    const status = i.next_due < today ? 'overdue' : i.status;
    const [cls, prio] = DUE_CLS[status] || DUE_CLS.ok;
    const cur = dueMap[i.next_due];
    if (!cur || prio < cur.prio) dueMap[i.next_due] = { cls, prio, labels: cur ? cur.labels : [] };
    dueMap[i.next_due].labels.push(`${i.product_name} due (${i.zone_name})`);
  }
  const plannedMap = {}; // date -> [planned rows]
  for (const pl of planned) {
    (plannedMap[pl.planned_date] = plannedMap[pl.planned_date] || []).push(pl);
  }

  const cell = (y, m, day, muted) => {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const applied = !muted && appliedMap[dateStr];
    const due = !muted && dueMap[dateStr];
    const plans = !muted && plannedMap[dateStr];
    const isToday = dateStr === today;
    const classes = ['cal-cell'];
    if (muted) classes.push('other-month');
    if (isToday) classes.push('today');
    else if (applied) classes.push('applied');
    if (due && !isToday) classes.push(due.cls);
    if (plans) classes.push('has-plan');
    const titleTxt = [
      ...(applied || []).map(l => '✓ ' + l),
      ...((due && due.labels) || []),
      ...(plans || []).map(p => `◌ ${p.concept} (${p.zone_name})`)
    ].join('\n');
    return `<div class="${classes.join(' ')}"${titleTxt ? ` title="${esc(titleTxt)}"` : ''}${plans ? ` onclick="openDayPlan('${dateStr}')"` : ''}>
      <span class="cal-num">${day}</span>
      <span class="cal-marks">${applied ? '<span class="mark-check">✓</span>' : ''}${due ? `<span class="mark-dot ${due.cls}"></span>` : ''}${plans ? `<span class="mark-plan${plans.every(p => p.optional) ? ' faint' : ''}"></span>` : ''}</span>
    </div>`;
  };

  const firstDow = (new Date(calYear, calMonth - 1, 1).getDay() + 6) % 7; // Monday-first
  const prevDays = new Date(calYear, calMonth - 1, 0).getDate();
  let cells = '';
  for (let i = firstDow - 1; i >= 0; i--) {
    const [py, pm] = calMonth === 1 ? [calYear - 1, 12] : [calYear, calMonth - 1];
    cells += cell(py, pm, prevDays - i, true);
  }
  for (let day = 1; day <= lastDay; day++) cells += cell(calYear, calMonth, day, false);
  let next = 1;
  while ((firstDow + lastDay + next - 1) % 7 !== 0) {
    const [ny, nm] = calMonth === 12 ? [calYear + 1, 1] : [calYear, calMonth + 1];
    cells += cell(ny, nm, next++, true);
  }

  const monthName = new Date(calYear, calMonth - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  view.innerHTML = `
    <div class="cal-wrap">
      <div class="card cal-card">
        <div class="cal-header">
          <button class="cal-nav" id="cal-prev" title="Previous month">‹</button>
          <strong>${monthName}</strong>
          <button class="cal-nav" id="cal-next" title="Next month">›</button>
        </div>
        <div class="cal-dows">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(w => `<div class="cal-dow">${w}</div>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </div>
      <aside class="card legend">
        <div class="legend-title">Legend</div>
        <div class="legend-row"><span class="legend-mark mark-check">✓</span>Applied on this day</div>
        <div class="legend-row"><span class="legend-mark"><span class="mark-dot due-red" style="display:inline-block"></span></span>Overdue due-date</div>
        <div class="legend-row"><span class="legend-mark"><span class="mark-dot due-amber" style="display:inline-block"></span></span>Due soon / upcoming</div>
        <div class="legend-row"><span class="legend-mark"><span class="mark-plan" style="display:inline-block"></span></span>Planned application (click day)</div>
        <div class="legend-row"><span class="legend-mark"><span class="mark-dot due-green" style="display:inline-block"></span></span>On-track due-date</div>
      </aside>
    </div>`;

  $('#cal-prev').onclick = () => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderCalendar(); };
  $('#cal-next').onclick = () => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderCalendar(); };
}

// ---------- Products ----------
let productFilterType = '';
let productShowArchived = false;

function setProductType(id) { productFilterType = id; renderProducts(); }
function toggleArchivedProducts(on) { productShowArchived = on; renderProducts(); }

async function renderProducts() {
  const [products, types, schedule] = await Promise.all([
    api('/products?all=1'),
    api('/types'),
    api('/schedule')
  ]);

  setHead('Products', `${products.filter(p => p.active).length} active products`,
    `<button class="btn-head" onclick="openTypesManager()">Manage types</button>
     <button class="btn-head btn-head-primary" onclick="openProductForm()">＋ Add product</button>`);

  const nextDue = {}; // product_id -> earliest next_due
  for (const i of schedule.items) {
    if (i.next_due && (!nextDue[i.product_id] || i.next_due < nextDue[i.product_id]))
      nextDue[i.product_id] = i.next_due;
  }

  const visible = products.filter(p =>
    (productShowArchived || p.active) &&
    (!productFilterType || String(p.type_id) === productFilterType));

  const chips = [{ id: '', name: 'All' }, ...types].map(t =>
    `<button class="chip${String(t.id ?? '') === productFilterType ? ' on' : ''}" onclick="setProductType('${t.id ?? ''}')">${esc(t.name)}</button>`).join('');

  const cards = visible.map(p => {
    const thr = effThreshold(p);
    const out = p.stock_qty <= 0;
    const low = out || (thr != null && p.stock_qty <= thr);
    const pkgAmt = parsePkg(p.package_size, p.stock_unit);
    const capacity = Math.max(p.stock_qty, pkgAmt || 0, (thr || 0) * 2) || 1;
    const pct = Math.min(100, Math.round(p.stock_qty / capacity * 100));
    const interval = p.interval_days != null ? `Every ${p.interval_days} days` : 'As needed';
    const next = nextDue[p.id] ? fmtShort(nextDue[p.id]) : (p.interval_days == null ? 'as needed' : '—');
    return `
      <div class="card product-card${p.active ? '' : ' archived'}">
        <div class="pc-top">
          <div>
            <div class="pc-name">${esc(p.name)}</div>
            ${p.brand ? `<div class="pc-brand">${esc(p.brand)}</div>` : ''}
          </div>
          ${p.type_name ? `<span class="tag">${esc(p.type_name)}</span>` : ''}
        </div>
        <div class="pc-stats">
          <div><div class="pc-k">Rate</div><div class="pc-v">${fmtQty(p.rate_amount)}${esc(p.rate_unit)} / ${fmtQty(p.rate_area_m2)}m²</div></div>
          <div><div class="pc-k">Interval</div><div class="pc-v">${interval}</div></div>
          ${p.dilution_note ? `<div><div class="pc-k">Dilute</div><div class="pc-v">${esc(p.dilution_note)}</div></div>` : ''}
        </div>
        <div class="pc-stock">
          <div class="pc-stock-line">
            <span>Stock</span>
            <span class="pc-stock-val${low ? ' low' : ''}">${out ? 'Out of stock' : `${fmtQty(p.stock_qty)} ${esc(p.stock_unit)}${low ? ' · low' : ''}`}</span>
          </div>
          <div class="bar"><div class="bar-fill${low ? ' low' : ''}" style="width:${pct}%"></div></div>
          <div class="pc-stock-meta">
            <span>Next: ${next}</span>
            <span>${thr != null ? `Low below ${fmtQty(thr)} ${esc(p.stock_unit)}` : ''}</span>
          </div>
        </div>
        ${p.notes ? `<div class="pc-notes">${esc(p.notes)}</div>` : ''}
        <div class="pc-actions">
          ${p.active ? `<button class="btn-primary" onclick="openLogForm(${p.id})">Log</button>` : '<span></span>'}
          <button class="btn-ghost" onclick="openRestockForm(${p.id})">Restock</button>
          <button class="btn-ghost" onclick="openProductForm(${p.id})">Edit</button>
          <button class="btn-ghost btn-amber" onclick="archiveProduct(${p.id}, ${p.active})">${p.active ? 'Archive' : 'Restore'}</button>
        </div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <div class="prod-toolbar">
      <div class="chips">${chips}</div>
      <label class="check">
        <input type="checkbox" id="pf-archived" ${productShowArchived ? 'checked' : ''}> Show archived
      </label>
    </div>
    ${cards ? `<div class="prod-grid">${cards}</div>` : '<div class="card"><div class="empty">No products match.</div></div>'}
  `;

  $('#pf-archived').onchange = e => toggleArchivedProducts(e.target.checked);
}

// ---------- History ----------
const historyFilters = { product_id: '', zone_id: '', from: '', to: '' };

async function renderHistory() {
  const qs = Object.entries(historyFilters).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('&');
  const [apps, products, zones] = await Promise.all([
    api('/applications' + (qs ? '?' + qs : '')),
    api('/products?all=1'),
    api('/zones?all=1')
  ]);

  setHead('History', `${apps.length} application${apps.length === 1 ? '' : 's'} logged`);

  const rows = apps.map(a => {
    const qty = a.actual_qty ?? a.calculated_qty;
    const manual = a.actual_qty != null;
    return `
      <tr>
        <td class="dim" style="white-space:nowrap;">${fmtDate(a.date_applied)}</td>
        <td class="strong">${esc(a.product_name)}${a.product_active ? '' : ' <span class="badge neutral" style="margin:0 0 0 6px;">Archived</span>'}</td>
        <td class="dim">${esc(a.zone_name)}</td>
        <td class="num"${manual ? ` title="Calculated: ${fmtQty(a.calculated_qty)}${esc(a.rate_unit)}"` : ''}>${fmtQty(qty)} ${esc(a.rate_unit)}</td>
        <td class="dim">${manual ? '<span class="manual-chip">MANUAL</span>' : ''}${esc(a.notes || '—')}</td>
        <td>
          <div class="t-actions">
            <button class="btn-mini btn-ghost" onclick="openEditApplication(${a.id})">Edit</button>
            <button class="btn-mini btn-danger-o" onclick="deleteApplication(${a.id})">Delete</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  const cards = apps.map(a => {
    const qty = a.actual_qty ?? a.calculated_qty;
    const manual = a.actual_qty != null;
    return `
      <div class="hist-card">
        <div class="hc-top">
          <div class="hc-main">
            <div class="hc-name">${esc(a.product_name)}${a.product_active ? '' : ' <span class="badge neutral" style="margin:0 0 0 6px;">Archived</span>'}</div>
            <div class="hc-sub">${esc(a.zone_name)} · ${fmtDate(a.date_applied)}</div>
          </div>
          <div class="hc-right">
            <div class="hc-qty">${fmtQty(qty)} ${esc(a.rate_unit)}</div>
            ${manual ? '<span class="manual-chip">MANUAL</span>' : ''}
          </div>
        </div>
        ${a.notes ? `<div class="hc-notes">${esc(a.notes)}</div>` : ''}
        <div class="hc-actions">
          <button class="btn-ghost" onclick="openEditApplication(${a.id})">Edit</button>
          <button class="btn-danger-o" onclick="deleteApplication(${a.id})">Delete</button>
        </div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <div class="filters">
      <select id="hf-product">
        <option value="">All products</option>
        ${products.map(p => `<option value="${p.id}" ${String(p.id) === historyFilters.product_id ? 'selected' : ''}>${esc(p.name)}${p.active ? '' : ' (archived)'}</option>`).join('')}
      </select>
      <select id="hf-zone">
        <option value="">All zones</option>
        ${zones.map(z => `<option value="${z.id}" ${String(z.id) === historyFilters.zone_id ? 'selected' : ''}>${esc(z.name)}</option>`).join('')}
      </select>
      <input type="date" id="hf-from" value="${historyFilters.from}" title="From date">
      <input type="date" id="hf-to" value="${historyFilters.to}" title="To date">
      <button class="btn-mini btn-ghost" id="hf-clear">Clear</button>
    </div>
    <div class="table-card table-scroll lm-scroll">
      <table>
        <thead><tr><th>Date</th><th>Product</th><th>Zone</th><th class="num">Qty</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6"><div class="empty">No applications logged yet.</div></td></tr>'}</tbody>
      </table>
    </div>
    <div class="hist-cards">${cards || '<div class="empty">No applications logged yet.</div>'}</div>`;

  $('#hf-product').onchange = e => { historyFilters.product_id = e.target.value; renderHistory(); };
  $('#hf-zone').onchange = e => { historyFilters.zone_id = e.target.value; renderHistory(); };
  $('#hf-from').onchange = e => { historyFilters.from = e.target.value; renderHistory(); };
  $('#hf-to').onchange = e => { historyFilters.to = e.target.value; renderHistory(); };
  $('#hf-clear').onclick = () => {
    historyFilters.product_id = historyFilters.zone_id = historyFilters.from = historyFilters.to = '';
    renderHistory();
  };
}

// ---------- Zones ----------
async function renderZones() {
  const zones = await api('/zones?all=1');

  setHead('Zones', `${zones.filter(z => z.active).length} lawn area${zones.filter(z => z.active).length === 1 ? '' : 's'}`,
    `<button class="btn-head btn-head-primary" onclick="openZoneForm()">＋ Add zone</button>`);

  const rows = zones.map(z => `
    <tr>
      <td class="strong" style="font-size:16px;">${esc(z.name)}${z.active ? '' : ' <span class="badge neutral" style="margin:0 0 0 6px;">Archived</span>'}</td>
      <td class="dim" style="font-size:15px;">${fmtQty(z.area_m2)} m²</td>
      <td>
        <div class="t-actions">
          <button class="btn-mini btn-ghost" onclick="openZoneForm(${z.id})">Edit</button>
          <button class="btn-mini btn-ghost btn-amber" onclick="archiveZone(${z.id}, ${z.active})">${z.active ? 'Archive' : 'Restore'}</button>
          <button class="btn-mini btn-danger-o" onclick="deleteZone(${z.id})" title="Delete zone">✕</button>
        </div>
      </td>
    </tr>`).join('');

  const totalArea = zones.filter(z => z.active).reduce((t, z) => t + z.area_m2, 0);

  const cards = zones.map(z => `
    <div class="zone-card">
      <div>
        <div class="hc-name">${esc(z.name)}${z.active ? '' : ' <span class="badge neutral" style="margin:0 0 0 6px;">Archived</span>'}</div>
        <div class="hc-sub">${fmtQty(z.area_m2)} m²</div>
      </div>
      <div class="t-actions">
        <button class="btn-mini btn-ghost" onclick="openZoneForm(${z.id})">Edit</button>
        <button class="btn-mini btn-ghost btn-amber" onclick="archiveZone(${z.id}, ${z.active})">${z.active ? 'Archive' : 'Restore'}</button>
        <button class="btn-mini btn-danger-o" onclick="deleteZone(${z.id})" title="Delete zone">✕</button>
      </div>
    </div>`).join('');

  view.innerHTML = `
    <div style="max-width:640px;">
      <div class="table-card">
        <table>
          <thead><tr><th>Zone</th><th>Area</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="3"><div class="empty">No zones yet — add your lawn areas to start logging.</div></td></tr>'}</tbody>
        </table>
        <div class="t-foot">Total lawn: ${fmtQty(totalArea)} m²</div>
      </div>
      <div class="zone-cards">${cards || '<div class="empty">No zones yet — add your lawn areas to start logging.</div>'}</div>
      <div class="zones-total">Total lawn: ${fmtQty(totalArea)} m²</div>
    </div>`;
}

// ---------- Forms ----------
const UNITS = ['mL', 'L', 'g', 'kg'];
const unitOptions = sel => UNITS.map(u => `<option ${u === sel ? 'selected' : ''}>${u}</option>`).join('');

async function openProductForm(id) {
  const types = await api('/types');
  let p = { rate_unit: 'mL', stock_unit: 'mL', rate_area_m2: 100, stock_qty: 0 };
  if (id) {
    const all = await api('/products?all=1');
    p = all.find(x => x.id === id);
  }
  openModal(`
    <h2 class="modal-title">${id ? 'Edit product' : 'New product'}</h2>
    <form id="product-form">
      <div class="field-row">
        <div class="field"><label>Name *</label><input name="name" required value="${esc(p.name || '')}"></div>
        <div class="field"><label>Brand</label><input name="brand" value="${esc(p.brand || '')}"></div>
      </div>
      <div class="field">
        <label>Type</label>
        <select name="type_id">
          <option value="">— none —</option>
          ${types.map(t => `<option value="${t.id}" ${p.type_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div class="field"><label>Rate qty *</label><input name="rate_amount" type="number" step="any" min="0.001" required value="${p.rate_amount ?? ''}"></div>
        <div class="field"><label>Unit</label><select name="rate_unit">${unitOptions(p.rate_unit)}</select></div>
        <div class="field"><label>Per m²</label><input name="rate_area_m2" type="number" step="any" min="1" value="${p.rate_area_m2 ?? 100}"></div>
      </div>
      <div class="field"><label>Dilution note</label><input name="dilution_note" placeholder="e.g. in 5L water per 100m²" value="${esc(p.dilution_note || '')}"></div>
      <div class="field">
        <label>Reapply interval (days, blank = one-off)</label>
        <input name="interval_days" type="number" min="1" step="1" value="${p.interval_days ?? ''}" placeholder="blank = one-off / as-needed">
      </div>
      <div class="field-row">
        <div class="field"><label>Stock</label><input name="stock_qty" type="number" step="any" min="0" value="${p.stock_qty ?? 0}"></div>
        <div class="field"><label>Unit</label><select name="stock_unit">${unitOptions(p.stock_unit)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Package size</label><input name="package_size" placeholder="e.g. 2.5L bottle" value="${esc(p.package_size || '')}"></div>
        <div class="field"><label>Low below</label><input name="low_stock_threshold" type="number" step="any" min="0" value="${p.low_stock_threshold ?? ''}" placeholder="optional"></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" rows="2" placeholder="Label link, safety notes…">${esc(p.notes || '')}</textarea></div>
      <button type="submit" class="btn-primary btn-big">${id ? 'Save product' : 'Add product'}</button>
    </form>`);

  $('#product-form').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (id) await api(`/products/${id}`, { method: 'PUT', body });
      else await api('/products', { method: 'POST', body });
      closeModal();
      toast(id ? 'Product updated' : 'Product added');
      route();
    } catch (err) { toast(err.message, true); }
  };
}

async function archiveProduct(id, archive) {
  if (archive && !confirm('Archive this product? It stays in history and can be restored later.')) return;
  try {
    await api(`/products/${id}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' });
    toast(archive ? 'Product archived' : 'Product restored');
    route();
  } catch (err) { toast(err.message, true); }
}

async function openRestockForm(id) {
  const all = await api('/products?all=1');
  const p = all.find(x => x.id === id);
  const pkgAmt = parsePkg(p.package_size, p.stock_unit);
  openModal(`
    <h2 class="modal-title tight">Restock</h2>
    <div class="modal-sub">${esc(p.name)}</div>
    <div class="restock-panel">
      <div><div class="pc-k">Current</div><div class="restock-num">${fmtQty(p.stock_qty)} ${esc(p.stock_unit)}</div></div>
      <div class="right"><div class="pc-k">After restock</div><div class="restock-num accent" id="restock-after">${fmtQty(p.stock_qty)} ${esc(p.stock_unit)}</div></div>
    </div>
    <form id="restock-form">
      <div class="field">
        <label>Add amount (${esc(p.stock_unit)})</label>
        <input name="amount" id="restock-amt" type="number" step="any" min="0.001" required autofocus>
      </div>
      ${pkgAmt ? `<div class="field"><button type="button" class="btn-ghost btn-wide" id="restock-pkg">＋ One package (${fmtQty(pkgAmt)} ${esc(p.stock_unit)})</button></div>` : ''}
      <button type="submit" class="btn-primary btn-big">Add to stock</button>
    </form>`);

  const updateAfter = () => {
    const amt = parseFloat($('#restock-amt').value) || 0;
    $('#restock-after').textContent = `${fmtQty(p.stock_qty + amt)} ${p.stock_unit}`;
  };
  $('#restock-amt').oninput = updateAfter;
  if (pkgAmt) $('#restock-pkg').onclick = () => {
    $('#restock-amt').value = fmtQty((parseFloat($('#restock-amt').value) || 0) + pkgAmt);
    updateAfter();
  };

  $('#restock-form').onsubmit = async e => {
    e.preventDefault();
    try {
      const amount = new FormData(e.target).get('amount');
      const updated = await api(`/products/${id}/restock`, { method: 'POST', body: { amount } });
      closeModal();
      toast(`Stock now ${fmtQty(updated.stock_qty)}${updated.stock_unit}`);
      route();
    } catch (err) { toast(err.message, true); }
  };
}

async function openTypesManager() {
  const [types, products] = await Promise.all([api('/types'), api('/products?all=1')]);
  openModal(`
    <h2 class="modal-title">Product types</h2>
    <div>
      ${types.map(t => {
        const used = products.filter(p => p.type_id === t.id).length;
        return `
          <div class="type-row">
            <span class="type-name">${esc(t.name)}</span>
            <span class="type-usage">${used ? used + ' in use' : 'unused'}</span>
            <button class="btn-mini btn-ghost" onclick="renameType(${t.id}, '${esc(t.name).replace(/'/g, "\\'")}')">Rename</button>
            <button class="type-del" ${used ? 'disabled' : ''} onclick="deleteType(${t.id})" title="${used ? 'In use — cannot delete' : 'Delete type'}">✕</button>
          </div>`;
      }).join('') || '<div class="empty">No types yet.</div>'}
    </div>
    <form id="type-form" class="type-add">
      <input name="name" placeholder="Add a type…" required>
      <button type="submit">Add</button>
    </form>`);
  $('#type-form').onsubmit = async e => {
    e.preventDefault();
    try {
      await api('/types', { method: 'POST', body: { name: new FormData(e.target).get('name') } });
      openTypesManager();
    } catch (err) { toast(err.message, true); }
  };
}

async function renameType(id, current) {
  const name = prompt('New name for this type:', current);
  if (!name || name === current) return;
  try { await api(`/types/${id}`, { method: 'PUT', body: { name } }); openTypesManager(); }
  catch (err) { toast(err.message, true); }
}

async function deleteType(id) {
  if (!confirm('Delete this type?')) return;
  try { await api(`/types/${id}`, { method: 'DELETE' }); openTypesManager(); }
  catch (err) { toast(err.message, true); }
}

async function openZoneForm(id) {
  let z = {};
  if (id) {
    const zones = await api('/zones?all=1');
    z = zones.find(x => x.id === id);
  }
  openModal(`
    <h2 class="modal-title">${id ? 'Edit zone' : 'New zone'}</h2>
    <form id="zone-form">
      <div class="field"><label>Name *</label><input name="name" required value="${esc(z.name || '')}" placeholder="e.g. Front lawn"></div>
      <div class="field"><label>Area (m²) *</label><input name="area_m2" type="number" step="any" min="0.1" required value="${z.area_m2 ?? ''}"></div>
      <button type="submit" class="btn-primary btn-big">Save zone</button>
    </form>`);
  $('#zone-form').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (id) await api(`/zones/${id}`, { method: 'PUT', body });
      else await api('/zones', { method: 'POST', body });
      closeModal();
      toast(id ? 'Zone updated' : 'Zone added');
      route();
    } catch (err) { toast(err.message, true); }
  };
}

async function archiveZone(id, archive) {
  try {
    await api(`/zones/${id}`, { method: 'PUT', body: { active: !archive } });
    toast(archive ? 'Zone archived' : 'Zone restored');
    route();
  } catch (err) { toast(err.message, true); }
}

async function deleteZone(id) {
  if (!confirm('Delete this zone? Only possible if it has no logged applications.')) return;
  try { await api(`/zones/${id}`, { method: 'DELETE' }); toast('Zone deleted'); route(); }
  catch (err) { toast(err.message, true); }
}

// ---------- Planned applications & preset plans ----------
async function getPlanned(id) {
  const rows = await api('/planned?status=all&all=1');
  return rows.find(r => r.id === id);
}

async function logPlanned(id) {
  const e = await getPlanned(id);
  if (!e) return toast('Planned entry not found', true);
  openLogForm(e.product_id, e.zone_id, null, e);
}

async function skipPlanned(id) {
  try {
    await api(`/planned/${id}`, { method: 'PUT', body: { status: 'skipped' } });
    toast('Planned entry skipped');
    closeModal();
    route();
  } catch (err) { toast(err.message, true); }
}

async function deletePlanned(id) {
  if (!confirm('Delete this planned entry?')) return;
  try {
    await api(`/planned/${id}`, { method: 'DELETE' });
    toast('Planned entry deleted');
    closeModal();
    route();
  } catch (err) { toast(err.message, true); }
}

async function editPlanned(id) {
  const [e, products] = await Promise.all([getPlanned(id), api('/products')]);
  if (!e) return toast('Planned entry not found', true);
  openModal(`
    <h2 class="modal-title tight">Edit planned entry</h2>
    <div class="modal-sub">${esc(e.concept)}</div>
    <form id="planned-form">
      <div class="field">
        <label>Product</label>
        <select name="product_id">
          <option value="">— no product assigned —</option>
          ${products.map(p => `<option value="${p.id}" ${p.id === e.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Date</label><input name="planned_date" type="date" required value="${e.planned_date}"></div>
      <div class="field"><label>Notes</label><input name="notes" value="${esc(e.notes || '')}"></div>
      <button type="submit" class="btn-primary btn-big">Save</button>
    </form>`);
  $('#planned-form').onsubmit = async ev => {
    ev.preventDefault();
    const body = Object.fromEntries(new FormData(ev.target).entries());
    try {
      await api(`/planned/${id}`, { method: 'PUT', body });
      closeModal();
      toast('Planned entry updated');
      route();
    } catch (err) { toast(err.message, true); }
  };
}

async function openDayPlan(dateStr) {
  const entries = await api(`/planned?from=${dateStr}&to=${dateStr}`);
  if (!entries.length) return;
  openModal(`
    <h2 class="modal-title tight">Planned</h2>
    <div class="modal-sub">${fmtDate(dateStr)}</div>
    <div class="dayplan">
      ${entries.map(e => `
        <div class="dayplan-row">
          <div class="dp-main">
            <div class="dp-name">${esc(e.concept)}${e.optional ? ' <span class="badge neutral">Optional</span>' : ''}</div>
            <div class="dp-sub">${e.product_id ? esc(e.product_name) + (e.product_active ? '' : ' (archived)') : 'No product assigned'} · ${esc(e.zone_name)}</div>
            ${e.notes ? `<div class="dp-note">${esc(e.notes)}</div>` : ''}
          </div>
          <div class="t-actions">
            <button class="btn-mini btn-primary" onclick="logPlanned(${e.id})">Log</button>
            <button class="btn-mini btn-ghost" onclick="editPlanned(${e.id})">Edit</button>
            <button class="btn-mini btn-ghost" onclick="skipPlanned(${e.id})">Skip</button>
            <button class="btn-mini btn-danger-o" onclick="deletePlanned(${e.id})" title="Delete">✕</button>
          </div>
        </div>`).join('')}
    </div>`);
}

async function clearPresetPlan() {
  if (!confirm('Remove all upcoming preset plan entries? Completed and skipped entries are kept.')) return;
  try {
    let deleted = 0;
    for (const src of presetSources) {
      const r = await api(`/plans/${src.replace('preset:', '')}/clear`, { method: 'POST', body: {} });
      deleted += r.deleted;
    }
    toast(`Removed ${deleted} planned entr${deleted === 1 ? 'y' : 'ies'}`);
    route();
  } catch (err) { toast(err.message, true); }
}

// ---------- Apply-plan wizard ----------
let wizState = null;

function wizMonthsLabel(step) {
  const slot = step.week === 1 ? 'early in the month' : 'mid-month';
  if (step.months.length === 12) return `Every month · ${slot}`;
  const names = [...step.months].sort((a, b) => a - b).map(m => MONTHS[m - 1]);
  return `${names.join(', ')} · ${slot}`;
}

async function openApplyPlanWizard() {
  const [plans, zones, products] = await Promise.all([api('/plans'), api('/zones'), api('/products')]);
  if (!zones.length) return toast('Add a lawn zone first (Zones tab)', true);
  const plan = plans[0];
  const mapping = {};
  for (const step of plan.steps) {
    const ofType = products.filter(p => p.type_name === step.type);
    const match = ofType.length === 1 ? ofType[0]
      : ofType.length > 1
        ? (step.matchHint && ofType.find(p => p.name.toLowerCase().includes(step.matchHint.toLowerCase()))) || null
        : null;
    mapping[step.key] = { include: !step.optional && !!match, product_id: match ? match.id : null };
  }
  wizState = { plan, zones, products, start_month: todayStr().slice(0, 7), zone_ids: zones.map(z => z.id), mapping };
  wizSetup();
}

function wizSetup() {
  const w = wizState;
  openModal(`
    <h2 class="modal-title tight">Apply a plan</h2>
    <div class="modal-sub">Step 1 of 3 — plan &amp; zones</div>
    <div class="wiz-plan-card">
      <div class="wiz-plan-name">${esc(w.plan.name)}</div>
      <div class="wiz-plan-desc">${esc(w.plan.description)}</div>
    </div>
    <div class="field"><label>Start month (schedules 12 months ahead)</label>
      <input type="month" id="wiz-month" value="${w.start_month}"></div>
    <div class="field"><label>Zones</label>
      ${w.zones.map(z => `<label class="check"><input type="checkbox" class="wiz-zone" value="${z.id}"
        ${w.zone_ids.includes(z.id) ? 'checked' : ''}> ${esc(z.name)} — ${fmtQty(z.area_m2)}m²</label>`).join('')}
    </div>
    <button class="btn-primary btn-big" id="wiz-next1">Next — match products</button>`);
  $('#wiz-next1').onclick = () => {
    w.start_month = $('#wiz-month').value || todayStr().slice(0, 7);
    w.zone_ids = [...document.querySelectorAll('.wiz-zone:checked')].map(el => Number(el.value));
    if (!w.zone_ids.length) return toast('Select at least one zone', true);
    wizMapping();
  };
}

function wizMapping() {
  const w = wizState;
  const rows = w.plan.steps.map(step => {
    const m = w.mapping[step.key];
    const noMatch = !m.product_id;
    return `
      <div class="wiz-step-row">
        <label class="wiz-inc"><input type="checkbox" class="wiz-include" data-key="${step.key}" ${m.include ? 'checked' : ''}></label>
        <div class="wiz-info">
          <div class="wiz-name">${esc(step.label)}${step.optional ? ' <span class="badge neutral">Optional</span>' : ''}</div>
          <div class="wiz-sub">${esc(wizMonthsLabel(step))}${step.note ? ' · ' + esc(step.note) : ''}</div>
          ${noMatch && !step.optional ? `<div class="wiz-sub wiz-nomatch">No matching product — pick one, or leave as a reminder</div>` : ''}
        </div>
        <select class="wiz-product" data-key="${step.key}">
          <option value="">Reminder only (no product)</option>
          ${w.products.map(p => `<option value="${p.id}" ${p.id === m.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>`;
  }).join('');
  openModal(`
    <h2 class="modal-title tight">Match your products</h2>
    <div class="modal-sub">Step 2 of 3 — tick the steps you want; unticked steps are skipped</div>
    <div class="wiz-steps">${rows}</div>
    <div class="wiz-nav">
      <button class="btn-ghost" id="wiz-back2">Back</button>
      <button class="btn-primary" id="wiz-next2">Next — preview</button>
    </div>`);
  const readMapping = () => {
    document.querySelectorAll('.wiz-include').forEach(el => { w.mapping[el.dataset.key].include = el.checked; });
    document.querySelectorAll('.wiz-product').forEach(el => {
      w.mapping[el.dataset.key].product_id = el.value ? Number(el.value) : null;
    });
  };
  $('#wiz-back2').onclick = () => { readMapping(); wizSetup(); };
  $('#wiz-next2').onclick = () => {
    readMapping();
    if (!Object.values(w.mapping).some(m => m.include)) return toast('Include at least one step', true);
    wizPreview();
  };
}

async function wizPreview() {
  const w = wizState;
  const body = { start_month: w.start_month, zone_ids: w.zone_ids, mapping: w.mapping };
  let dry;
  try { dry = await api(`/plans/${w.plan.id}/apply`, { method: 'POST', body: { ...body, dry_run: true } }); }
  catch (err) { return toast(err.message, true); }
  openModal(`
    <h2 class="modal-title tight">Preview</h2>
    <div class="modal-sub">Step 3 of 3 — confirm</div>
    <div class="wiz-preview">
      <div class="wiz-preview-num">${dry.count} planned entries</div>
      <div class="wiz-sub">across ${w.zone_ids.length} zone${w.zone_ids.length === 1 ? '' : 's'}, ${fmtDate(dry.from)} → ${fmtDate(dry.to)}</div>
      <div class="wiz-bystep">
        ${Object.entries(dry.byStep).map(([label, n]) => `<div class="wiz-bystep-row"><span>${esc(label)}</span><span>${n}×</span></div>`).join('')}
      </div>
    </div>
    <div class="wiz-replace hidden" id="wiz-replace">
      <span id="wiz-replace-msg"></span>
      <button class="btn-primary" id="wiz-apply-replace">Replace &amp; apply</button>
    </div>
    <div class="wiz-nav">
      <button class="btn-ghost" id="wiz-back3">Back</button>
      <button class="btn-primary" id="wiz-apply">Apply plan</button>
    </div>`);
  const apply = async replace => {
    try {
      const r = await api(`/plans/${w.plan.id}/apply`, { method: 'POST', body: { ...body, replace } });
      closeModal();
      toast(`Plan applied — ${r.created} entries scheduled${r.replaced ? ` (${r.replaced} replaced)` : ''}`);
      if (location.hash === '#/calendar') route();
      else location.hash = '#/calendar';
    } catch (err) {
      if (!replace && /upcoming entr/.test(err.message)) {
        $('#wiz-replace-msg').textContent = err.message + '.';
        $('#wiz-replace').classList.remove('hidden');
        $('#wiz-apply').disabled = true;
      } else {
        toast(err.message, true);
      }
    }
  };
  $('#wiz-back3').onclick = () => wizMapping();
  $('#wiz-apply').onclick = () => apply(false);
  $('#wiz-apply-replace').onclick = () => apply(true);
}

// ---------- Log / edit application ----------
// `planned` (optional): a planned_applications row being completed — prefills
// the form and marks the row done on save.
async function openLogForm(productId, zoneId, existing, planned) {
  const [products, zones] = await Promise.all([api('/products'), api('/zones')]);
  if (!zones.length) {
    toast('Add a lawn zone first (Zones tab)', true);
    return;
  }
  const isEdit = !!existing;
  const sel = {
    product_id: existing ? existing.product_id : ((planned && planned.product_id) || productId || products[0]?.id),
    zone_id: existing ? existing.zone_id : ((planned && planned.zone_id) || zoneId || zones[0]?.id),
    date_applied: existing ? existing.date_applied : (planned ? planned.planned_date : todayStr()),
    notes: existing ? existing.notes : ((planned && planned.notes) || '')
  };
  const plannedArchived = planned && planned.product_id && !products.some(p => p.id === planned.product_id);

  openModal(`
    <h2 class="modal-title${planned ? ' tight' : ''}">${isEdit ? 'Edit application' : 'Log application'}</h2>
    ${planned ? `<div class="modal-sub">Completing planned: ${esc(planned.concept)}</div>` : ''}
    ${plannedArchived ? `<div class="plan-warn">The planned product is archived — pick a replacement below.</div>` : ''}
    <form id="log-form">
      <div class="field">
        <label>Product</label>
        <select name="product_id" id="log-product">
          ${products.map(p => `<option value="${p.id}" ${p.id === sel.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Zone</label>
          <select name="zone_id" id="log-zone">
            ${zones.map(z => `<option value="${z.id}" ${z.id === sel.zone_id ? 'selected' : ''}>${esc(z.name)} — ${fmtQty(z.area_m2)}m²</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Date</label><input name="date_applied" type="date" required value="${sel.date_applied}"></div>
      </div>
      <div class="dose-panel" id="calc-preview"><div class="dose-label">Calculated dose</div><div class="dose-num">…</div></div>
      <div class="field-row">
        <div class="field">
          <label>Qty override</label>
          <input name="actual_qty" id="log-actual" type="number" step="any" min="0"
            value="${existing && existing.actual_qty != null ? existing.actual_qty : ''}">
        </div>
        <div class="field">
          <label>Notes</label>
          <input name="notes" value="${esc(sel.notes || '')}" placeholder="Conditions, observations…">
        </div>
      </div>
      <button type="submit" class="btn-primary btn-big">${isEdit ? 'Save changes' : 'Log application'}</button>
    </form>`);

  let lastCalc = null;
  function paintDose() {
    const p = products.find(x => x.id === +$('#log-product').value);
    const z = zones.find(x => x.id === +$('#log-zone').value);
    const box = $('#calc-preview');
    if (!lastCalc || !p || !z) { box.innerHTML = '<div class="dose-label">Calculated dose</div><div class="dose-num">—</div>'; return; }
    const override = parseFloat($('#log-actual').value);
    const used = isNaN(override) ? lastCalc.calculated_qty : override;
    const usedInStock = convertQty(used, p.rate_unit, p.stock_unit);
    const after = Math.max(0, p.stock_qty - usedInStock);
    const short = usedInStock - Math.max(0, p.stock_qty);
    box.innerHTML = `
      <div class="dose-label">Calculated dose</div>
      <div class="dose-num">${fmtQty(lastCalc.calculated_qty)} ${esc(lastCalc.unit)}</div>
      <div class="dose-sub">${fmtQty(p.rate_amount)}${esc(p.rate_unit)} / ${fmtQty(p.rate_area_m2)}m² × ${fmtQty(z.area_m2)}m²</div>
      ${lastCalc.dilution_note ? `<div class="dose-sub dose-div">${esc(lastCalc.dilution_note)}</div>` : ''}
      <div class="dose-sub dose-div">Stock: ${fmtQty(Math.max(0, p.stock_qty))} → ${fmtQty(after)} ${esc(p.stock_unit)} left${!isNaN(override) ? ' (manual qty)' : ''}</div>
      ${short > 1e-9 ? `<div class="dose-sub dose-div">⚠ Not enough stock — short by ${fmtQty(short)} ${esc(p.stock_unit)}</div>` : ''}`;
    $('#log-actual').placeholder = `${fmtQty(lastCalc.calculated_qty)} ${lastCalc.unit}`;
  }
  async function updateCalc() {
    const pid = $('#log-product').value;
    const zid = $('#log-zone').value;
    try { lastCalc = await api(`/calc?product_id=${pid}&zone_id=${zid}`); }
    catch { lastCalc = null; }
    paintDose();
  }
  $('#log-product').onchange = updateCalc;
  $('#log-zone').onchange = updateCalc;
  $('#log-actual').oninput = paintDose;
  updateCalc();

  $('#log-form').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    if (planned && !isEdit) body.planned_id = planned.id;
    try {
      if (isEdit) {
        await api(`/applications/${existing.id}`, { method: 'PUT', body });
        toast('Application updated');
      } else {
        const created = await api('/applications', { method: 'POST', body });
        if (created.stock_shortfall > 0) {
          toast(`Logged — stock was short by ${fmtQty(created.stock_shortfall)}${created.stock_unit}, now empty`, true);
        } else {
          toast(planned ? 'Application logged — planned entry completed' : 'Application logged — stock updated');
        }
      }
      closeModal();
      route();
    } catch (err) { toast(err.message, true); }
  };
}

async function openEditApplication(id) {
  const apps = await api('/applications');
  const a = apps.find(x => x.id === id);
  if (!a) return toast('Application not found', true);
  openLogForm(null, null, a);
}

async function deleteApplication(id) {
  if (!confirm('Delete this log entry? The deducted stock will be returned.')) return;
  try { await api(`/applications/${id}`, { method: 'DELETE' }); toast('Entry deleted — stock restored'); route(); }
  catch (err) { toast(err.message, true); }
}

// ---------- Router ----------
const routes = {
  dashboard: renderDashboard,
  calendar: renderCalendar,
  products: renderProducts,
  history: renderHistory,
  zones: renderZones
};

async function route() {
  const name = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  const fn = routes[name] || renderDashboard;
  document.querySelectorAll('nav a').forEach(a =>
    a.classList.toggle('active', a.dataset.route === (routes[name] ? name : 'dashboard')));
  try {
    await fn();
  } catch (err) {
    view.innerHTML = `<div class="card"><div class="empty">Failed to load: ${esc(err.message)}</div></div>`;
  }
}

window.addEventListener('hashchange', route);
$('#cta-log').addEventListener('click', () => openLogForm());
$('#today-date').textContent = fmtShort(todayStr());
route();
