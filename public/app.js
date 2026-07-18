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

function fmtDate(str) {
  if (!str) return '';
  const d = new Date(str + 'T00:00:00');
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtQty(n) {
  if (n == null) return '';
  const r = Math.round(n * 100) / 100;
  return String(r % 1 === 0 ? Math.round(r) : r);
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
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
    case 'overdue': return `<span class="badge overdue">Overdue ${item.days_overdue}d</span>`;
    case 'due_soon': return `<span class="badge due_soon">${item.days_until_due === 0 ? 'Due today' : 'Due in ' + item.days_until_due + 'd'}</span>`;
    case 'upcoming': return `<span class="badge upcoming">Due in ${item.days_until_due}d</span>`;
    case 'ok': return `<span class="badge ok">Due in ${item.days_until_due}d</span>`;
    case 'one_off': return `<span class="badge one_off">One-off / as-needed</span>`;
    case 'not_started': return `<span class="badge not_started">Not yet started</span>`;
    default: return '';
  }
}

function schedItemHtml(item) {
  const due = item.next_due ? ` &middot; next due ${fmtDate(item.next_due)}` : '';
  return `
    <div class="sched-item">
      <div class="sched-main">
        <div class="pname">${esc(item.product_name)}</div>
        <div class="zname">${esc(item.zone_name)} &middot; last applied ${fmtDate(item.last_applied)} (${item.days_since}d ago)${due}</div>
      </div>
      ${statusBadge(item)}
      <button class="btn-sm btn-primary" onclick="openLogForm(${item.product_id}, ${item.zone_id})">Log</button>
    </div>`;
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

  const section = (title, cls, items, emptyMsg) => `
    <h3 class="sec ${cls}"><span class="tick"></span>${title} <span class="count">${items.length}</span></h3>
    <div class="card">
      ${items.length ? items.map(schedItemHtml).join('') : `<div class="empty">${emptyMsg}</div>`}
    </div>`;

  let lowStockHtml = '';
  if (d.lowStock.length) {
    lowStockHtml = `
      <h3 class="sec sec-red"><span class="tick"></span>Low stock <span class="count">${d.lowStock.length}</span></h3>
      <div class="card">
        ${d.lowStock.map(p => `
          <div class="sched-item">
            <div class="sched-main"><span class="pname">${esc(p.name)}</span>
              <span class="muted">${fmtQty(p.stock_qty)}${esc(p.stock_unit)} left (threshold ${fmtQty(p.low_stock_threshold)}${esc(p.stock_unit)})</span>
            </div>
            <span class="badge low-stock">Low stock</span>
            <button class="btn-sm" onclick="openRestockForm(${p.id})">Restock</button>
          </div>`).join('')}
      </div>`;
  }

  let notStartedHtml = '';
  if (d.notStarted.length) {
    notStartedHtml = `
      <h3 class="sec"><span class="tick"></span>Not yet started <span class="count">${d.notStarted.length}</span></h3>
      <div class="card">
        ${d.notStarted.map(p => `
          <div class="sched-item">
            <div class="sched-main"><span class="pname">${esc(p.product_name)}</span></div>
            <span class="badge not_started">Not yet started</span>
            <button class="btn-sm btn-primary" onclick="openLogForm(${p.product_id})">Log first application</button>
          </div>`).join('')}
      </div>`;
  }

  view.innerHTML = `
    <h2>Dashboard</h2>
    ${lowStockHtml}
    ${section('Overdue', 'sec-red', overdue, 'Nothing overdue — nice work.')}
    ${section('Due this week', 'sec-amber', dueSoon, 'Nothing due in the next 7 days.')}
    ${section('Coming up (8–14 days)', 'sec-blue', upcoming, 'Nothing in the 2-week window.')}
    ${oneOffs.length ? section('One-off / as-needed (last applied)', '', oneOffs, '') : ''}
    ${ok.length ? section('On schedule (due later)', 'sec-green', ok, '') : ''}
    ${notStartedHtml}
  `;
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

  // Events per day
  const events = {}; // 'YYYY-MM-DD' -> [{cls, label, title}]
  const push = (date, ev) => { (events[date] = events[date] || []).push(ev); };
  for (const a of apps) {
    push(a.date_applied, {
      cls: 'applied',
      label: `✓ ${a.product_name}`,
      title: `${a.product_name} applied to ${a.zone_name} — ${fmtQty(a.actual_qty ?? a.calculated_qty)}${a.rate_unit}`
    });
  }
  const today = todayStr();
  for (const i of schedule.items) {
    if (!i.next_due) continue;
    if (i.next_due >= monthStart && i.next_due <= monthEnd) {
      push(i.next_due, {
        cls: i.next_due < today ? 'overdue' : 'due',
        label: `${i.next_due < today ? '!' : '○'} ${i.product_name}`,
        title: `${i.product_name} due for ${i.zone_name}`
      });
    }
  }

  const monthName = new Date(calYear, calMonth - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const firstDow = (new Date(calYear, calMonth - 1, 1).getDay() + 6) % 7; // Monday-first

  let cells = '';
  for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) cells += `<div class="cal-dow">${dow}</div>`;
  for (let i = 0; i < firstDow; i++) cells += `<div class="cal-cell other-month"></div>`;
  for (let day = 1; day <= lastDay; day++) {
    const dateStr = `${calYear}-${String(calMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const evs = (events[dateStr] || [])
      .map(e => `<div class="cal-event ${e.cls}" title="${esc(e.title)}">${esc(e.label)}</div>`).join('');
    cells += `<div class="cal-cell${dateStr === today ? ' today' : ''}"><div class="cal-daynum">${day}</div>${evs}</div>`;
  }

  view.innerHTML = `
    <h2>Calendar</h2>
    <div class="card">
      <div class="cal-header">
        <button class="btn-sm" id="cal-prev">← Prev</button>
        <strong>${monthName}</strong>
        <button class="btn-sm" id="cal-next">Next →</button>
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">
        <span><span class="cal-event applied">✓ applied</span></span>
        <span><span class="cal-event due">○ due</span></span>
        <span><span class="cal-event overdue">! overdue</span></span>
      </div>
    </div>`;

  $('#cal-prev').onclick = () => { calMonth--; if (calMonth < 1) { calMonth = 12; calYear--; } renderCalendar(); };
  $('#cal-next').onclick = () => { calMonth++; if (calMonth > 12) { calMonth = 1; calYear++; } renderCalendar(); };
}

// ---------- Products ----------
let productFilterType = '';
let productShowArchived = false;

async function renderProducts() {
  const [products, types] = await Promise.all([
    api('/products?all=1'),
    api('/types')
  ]);

  const visible = products.filter(p =>
    (productShowArchived || p.active) &&
    (!productFilterType || String(p.type_id) === productFilterType));

  const typeOptions = types.map(t =>
    `<option value="${t.id}" ${String(t.id) === productFilterType ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  const cards = visible.map(p => {
    const lowStock = p.low_stock_threshold != null && p.stock_qty <= p.low_stock_threshold;
    const interval = p.interval_days != null ? `every ${p.interval_days} days` : 'one-off / as-needed';
    return `
      <div class="card product-card">
        <div class="pinfo">
          <div class="pname">${esc(p.name)}${p.brand ? ` <span class="muted">· ${esc(p.brand)}</span>` : ''}
            ${p.active ? '' : ' <span class="badge archived">Archived</span>'}
            ${lowStock ? ' <span class="badge low-stock">Low stock</span>' : ''}
          </div>
          <div class="pmeta">
            ${p.type_name ? `<span class="badge type">${esc(p.type_name)}</span> · ` : ''}
            ${fmtQty(p.rate_amount)}${esc(p.rate_unit)} / ${fmtQty(p.rate_area_m2)}m² · ${interval}
            ${p.dilution_note ? ` · ${esc(p.dilution_note)}` : ''}
          </div>
          <div class="pmeta">
            Stock: <strong>${fmtQty(p.stock_qty)}${esc(p.stock_unit)}</strong>
            ${p.package_size ? ` · pack: ${esc(p.package_size)}` : ''}
            ${p.low_stock_threshold != null ? ` · warn at ${fmtQty(p.low_stock_threshold)}${esc(p.stock_unit)}` : ''}
          </div>
          ${p.notes ? `<div class="pnotes muted">${esc(p.notes)}</div>` : ''}
        </div>
        <div class="pactions">
          ${p.active ? `<button class="btn-sm btn-primary" onclick="openLogForm(${p.id})">Log</button>` : ''}
          <button class="btn-sm" onclick="openRestockForm(${p.id})">Restock</button>
          <button class="btn-sm" onclick="openProductForm(${p.id})">Edit</button>
          ${p.active
            ? `<button class="btn-sm btn-danger" onclick="archiveProduct(${p.id}, true)">Archive</button>`
            : `<button class="btn-sm" onclick="archiveProduct(${p.id}, false)">Unarchive</button>`}
        </div>
      </div>`;
  }).join('');

  view.innerHTML = `
    <h2>Products</h2>
    <div class="filters">
      <select id="pf-type">
        <option value="">All types</option>
        ${typeOptions}
      </select>
      <label class="check">
        <input type="checkbox" id="pf-archived" ${productShowArchived ? 'checked' : ''}> Show archived
      </label>
      <span class="spacer"></span>
      <button class="btn-sm" onclick="openTypesManager()">Manage types</button>
      <button class="btn-primary btn-sm" onclick="openProductForm()">+ Add product</button>
    </div>
    ${cards || '<div class="card empty">No products match.</div>'}
  `;

  $('#pf-type').onchange = e => { productFilterType = e.target.value; renderProducts(); };
  $('#pf-archived').onchange = e => { productShowArchived = e.target.checked; renderProducts(); };
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

  const rows = apps.map(a => {
    const qty = a.actual_qty ?? a.calculated_qty;
    const overridden = a.actual_qty != null;
    return `
      <tr>
        <td class="data">${fmtDate(a.date_applied)}</td>
        <td>${esc(a.product_name)}${a.product_active ? '' : ' <span class="badge archived">Archived</span>'}</td>
        <td>${esc(a.zone_name)}</td>
        <td class="data">${fmtQty(qty)}${esc(a.rate_unit)}${overridden ? ` <span class="muted" title="Calculated: ${fmtQty(a.calculated_qty)}${esc(a.rate_unit)}">(manual)</span>` : ''}</td>
        <td>${esc(a.notes || '')}</td>
        <td style="white-space:nowrap;">
          <button class="btn-sm" onclick="openEditApplication(${a.id})">Edit</button>
          <button class="btn-sm btn-danger" onclick="deleteApplication(${a.id})">Delete</button>
        </td>
      </tr>`;
  }).join('');

  view.innerHTML = `
    <h2>History</h2>
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
      <button class="btn-sm" id="hf-clear">Clear</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Product</th><th>Zone</th><th>Qty</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="empty">No applications logged.</td></tr>'}</tbody>
      </table>
    </div>`;

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
  const rows = zones.map(z => `
    <tr>
      <td>${esc(z.name)}${z.active ? '' : ' <span class="badge archived">Archived</span>'}</td>
      <td class="data">${fmtQty(z.area_m2)} m²</td>
      <td style="white-space:nowrap;">
        <button class="btn-sm" onclick="openZoneForm(${z.id})">Edit</button>
        ${z.active
          ? `<button class="btn-sm btn-danger" onclick="archiveZone(${z.id}, true)">Archive</button>`
          : `<button class="btn-sm" onclick="archiveZone(${z.id}, false)">Unarchive</button>`}
        <button class="btn-sm btn-danger" onclick="deleteZone(${z.id})">Delete</button>
      </td>
    </tr>`).join('');

  view.innerHTML = `
    <h2>Lawn zones</h2>
    <div class="filters">
      <span class="muted">Applications are logged against a zone; quantities are calculated from its area.</span>
      <span class="spacer"></span>
      <button class="btn-primary btn-sm" onclick="openZoneForm()">+ Add zone</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Name</th><th>Area</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="empty">No zones yet — add your lawn areas to start logging.</td></tr>'}</tbody>
      </table>
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
    <h2>${id ? 'Edit product' : 'Add product'}</h2>
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
        <div class="field"><label>Rate amount *</label><input name="rate_amount" type="number" step="any" min="0.001" required value="${p.rate_amount ?? ''}"></div>
        <div class="field"><label>Rate unit</label><select name="rate_unit">${unitOptions(p.rate_unit)}</select></div>
        <div class="field"><label>Per area (m²)</label><input name="rate_area_m2" type="number" step="any" min="1" value="${p.rate_area_m2 ?? 100}"></div>
      </div>
      <div class="field"><label>Dilution note</label><input name="dilution_note" placeholder="e.g. in 5L+ water per 100m²" value="${esc(p.dilution_note || '')}"></div>
      <div class="field">
        <label>Reapplication interval (days)</label>
        <input name="interval_days" type="number" min="1" step="1" value="${p.interval_days ?? ''}" placeholder="blank = one-off / seasonal / as-needed">
        <div class="hint">Leave blank for one-off, seasonal or as-needed products (no auto-scheduling).</div>
      </div>
      <div class="field-row">
        <div class="field"><label>Stock on hand</label><input name="stock_qty" type="number" step="any" min="0" value="${p.stock_qty ?? 0}"></div>
        <div class="field"><label>Stock unit</label><select name="stock_unit">${unitOptions(p.stock_unit)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Package size</label><input name="package_size" placeholder="e.g. 2.5L bottle" value="${esc(p.package_size || '')}"></div>
        <div class="field"><label>Low-stock warning at</label><input name="low_stock_threshold" type="number" step="any" min="0" value="${p.low_stock_threshold ?? ''}" placeholder="optional, in stock unit"></div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" placeholder="Label link, safety notes…">${esc(p.notes || '')}</textarea></div>
      <div class="row-flex">
        <span class="spacer"></span>
        <button type="button" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${id ? 'Save' : 'Add product'}</button>
      </div>
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
  if (archive && !confirm('Archive this product? It stays in history and can be unarchived later.')) return;
  try {
    await api(`/products/${id}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' });
    toast(archive ? 'Product archived' : 'Product unarchived');
    route();
  } catch (err) { toast(err.message, true); }
}

async function openRestockForm(id) {
  const all = await api('/products?all=1');
  const p = all.find(x => x.id === id);
  openModal(`
    <h2>Restock ${esc(p.name)}</h2>
    <p class="muted">Current stock: <strong>${fmtQty(p.stock_qty)}${esc(p.stock_unit)}</strong>
      ${p.package_size ? ` · usually bought as ${esc(p.package_size)}` : ''}</p>
    <form id="restock-form">
      <div class="field">
        <label>Amount to add (${esc(p.stock_unit)})</label>
        <input name="amount" type="number" step="any" min="0.001" required autofocus>
      </div>
      <div class="row-flex">
        <span class="spacer"></span>
        <button type="button" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">Add stock</button>
      </div>
    </form>`);
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
  const types = await api('/types');
  openModal(`
    <h2>Product types</h2>
    <div class="table-wrap"><table>
      <tbody>
        ${types.map(t => `
          <tr>
            <td>${esc(t.name)}</td>
            <td style="white-space:nowrap; text-align:right;">
              <button class="btn-sm" onclick="renameType(${t.id}, '${esc(t.name).replace(/'/g, "\\'")}')">Rename</button>
              <button class="btn-sm btn-danger" onclick="deleteType(${t.id})">Delete</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table></div>
    <form id="type-form" class="row-flex" style="margin-top:12px;">
      <input name="name" placeholder="New type name" required style="flex:1;">
      <button type="submit" class="btn-primary btn-sm">Add</button>
    </form>
    <div class="row-flex" style="margin-top:12px;">
      <span class="spacer"></span><button onclick="closeModal()">Close</button>
    </div>`);
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
    <h2>${id ? 'Edit zone' : 'Add zone'}</h2>
    <form id="zone-form">
      <div class="field"><label>Name *</label><input name="name" required value="${esc(z.name || '')}" placeholder="e.g. Front lawn — Home"></div>
      <div class="field"><label>Area (m²) *</label><input name="area_m2" type="number" step="any" min="0.1" required value="${z.area_m2 ?? ''}"></div>
      <div class="row-flex">
        <span class="spacer"></span>
        <button type="button" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${id ? 'Save' : 'Add zone'}</button>
      </div>
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
    toast(archive ? 'Zone archived' : 'Zone unarchived');
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
    <h2>${isEdit ? 'Edit application' : 'Log application'}</h2>
    <form id="log-form">
      <div class="field">
        <label>Product *</label>
        <select name="product_id" id="log-product">
          ${products.map(p => `<option value="${p.id}" ${p.id === sel.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label>Zone *</label>
        <select name="zone_id" id="log-zone">
          ${zones.map(z => `<option value="${z.id}" ${z.id === sel.zone_id ? 'selected' : ''}>${esc(z.name)} (${fmtQty(z.area_m2)}m²)</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>Date *</label><input name="date_applied" type="date" required value="${sel.date_applied}"></div>
      <div class="calc-preview" id="calc-preview">Calculating…</div>
      <div class="field">
        <label>Quantity used (override)</label>
        <input name="actual_qty" id="log-actual" type="number" step="any" min="0" placeholder="leave blank to use calculated amount"
          value="${existing && existing.actual_qty != null ? existing.actual_qty : ''}">
        <div class="hint">Stock is deducted by this amount (or the calculated amount if blank).</div>
      </div>
      <div class="field"><label>Notes</label><textarea name="notes" placeholder="Conditions, observations…">${esc(sel.notes || '')}</textarea></div>
      <div class="row-flex">
        <span class="spacer"></span>
        <button type="button" onclick="closeModal()">Cancel</button>
        <button type="submit" class="btn-primary">${isEdit ? 'Save changes' : 'Log application'}</button>
      </div>
    </form>`);

  async function updateCalc() {
    const pid = $('#log-product').value;
    const zid = $('#log-zone').value;
    try {
      const c = await api(`/calc?product_id=${pid}&zone_id=${zid}`);
      $('#calc-preview').innerHTML =
        `Calculated: <strong>${fmtQty(c.calculated_qty)}${esc(c.unit)}</strong>` +
        (c.dilution_note ? ` <span class="muted">(${esc(c.dilution_note)})</span>` : '');
      $('#log-actual').placeholder = `leave blank to use ${fmtQty(c.calculated_qty)}${c.unit}`;
    } catch { $('#calc-preview').textContent = 'Could not calculate quantity.'; }
  }
  $('#log-product').onchange = updateCalc;
  $('#log-zone').onchange = updateCalc;
  updateCalc();

  $('#log-form').onsubmit = async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      if (isEdit) await api(`/applications/${existing.id}`, { method: 'PUT', body });
      else await api('/applications', { method: 'POST', body });
      closeModal();
      toast(isEdit ? 'Application updated' : 'Application logged — stock updated');
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
    view.innerHTML = `<div class="card empty">Failed to load: ${esc(err.message)}</div>`;
  }
}

window.addEventListener('hashchange', route);
$('#fab').addEventListener('click', () => openLogForm());
route();
