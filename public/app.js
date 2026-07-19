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
  const d = await api('/dashboard');
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

async function renderCalendar() {
  const now = new Date();
  if (!calYear) { calYear = now.getFullYear(); calMonth = now.getMonth() + 1; }

  const monthStart = `${calYear}-${String(calMonth).padStart(2, '0')}-01`;
  const lastDay = new Date(calYear, calMonth, 0).getDate();
  const monthEnd = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const [apps, schedule] = await Promise.all([
    api(`/applications?from=${monthStart}&to=${monthEnd}`),
    api('/schedule')
  ]);

  setHead('Calendar', 'Applications & due dates');

  const today = todayStr();
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

  const cell = (y, m, day, muted) => {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const applied = !muted && appliedMap[dateStr];
    const due = !muted && dueMap[dateStr];
    const isToday = dateStr === today;
    const classes = ['cal-cell'];
    if (muted) classes.push('other-month');
    if (isToday) classes.push('today');
    else if (applied) classes.push('applied');
    if (due && !isToday) classes.push(due.cls);
    const titleTxt = [...(applied || []).map(l => '✓ ' + l), ...((due && due.labels) || [])].join('\n');
    return `<div class="${classes.join(' ')}"${titleTxt ? ` title="${esc(titleTxt)}"` : ''}>
      <span class="cal-num">${day}</span>
      <span class="cal-marks">${applied ? '<span class="mark-check">✓</span>' : ''}${due ? `<span class="mark-dot ${due.cls}"></span>` : ''}</span>
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

// ---------- Log / edit application ----------
async function openLogForm(productId, zoneId, existing) {
  const [products, zones] = await Promise.all([api('/products'), api('/zones')]);
  if (!zones.length) {
    toast('Add a lawn zone first (Zones tab)', true);
    return;
  }
  const isEdit = !!existing;
  const sel = {
    product_id: existing ? existing.product_id : (productId || products[0]?.id),
    zone_id: existing ? existing.zone_id : (zoneId || zones[0]?.id),
    date_applied: existing ? existing.date_applied : todayStr(),
    notes: existing ? existing.notes : ''
  };

  openModal(`
    <h2 class="modal-title">${isEdit ? 'Edit application' : 'Log application'}</h2>
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
    try {
      if (isEdit) {
        await api(`/applications/${existing.id}`, { method: 'PUT', body });
        toast('Application updated');
      } else {
        const created = await api('/applications', { method: 'POST', body });
        if (created.stock_shortfall > 0) {
          toast(`Logged — stock was short by ${fmtQty(created.stock_shortfall)}${created.stock_unit}, now empty`, true);
        } else {
          toast('Application logged — stock updated');
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
