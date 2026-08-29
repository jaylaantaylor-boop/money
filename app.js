import { loadDoc, saveDoc, exportDoc, importDoc, lastLoadError, readCorruptBackup, clearCorruptBackup, emptyDoc } from './store.js';
import { catchUp, pace, daysBetween, applyPaycheck, autoPayDue, recordSpend, payBill, summarise, prevMonthStart,
  projectDueDates, projectFundedDate, onTrack, heavyMonths } from './engine.js';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

const todayIso = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString().slice(0, 10);
};

const initialDoc = loadDoc();
// C3: seed session state from the document's own lastResult rather than always null, so a
// reload (the phone killing the PWA) still shows the paycheck that actually landed instead
// of claiming none exists.
export const state = { doc: initialDoc, screen: 'home', today: todayIso(), lastResult: initialDoc.lastResult, entry: { digits: '', category: null, onCard: false }, editing: null, setupStep: 1, lastLoadErrorDismissed: false };
export const screens = {};

export function commit(doc) { state.doc = doc; saveDoc(doc); render(); }
export function go(name) {
  // Entering the spend screen always starts from a clean slate. Leaving via the bottom nav
  // skips cancel-spend, so an abandoned amount would otherwise sit there waiting to be
  // recorded against something else. Category is deliberately NOT reset — recall is the
  // point — and it is read from the last spend, not from here.
  if (name === 'add') state.entry = { digits: '', category: null, onCard: false };
  state.screen = name; render(); window.scrollTo(0, 0);
}

const NAV = [['home', 'Home'], ['upcoming', 'Coming up'], ['bills', 'Bills'], ['settings', 'Settings']];

export function render() {
  const view = screens[state.screen] || screens.home || (() => '');
  document.getElementById('screen').innerHTML = view();
  document.getElementById('nav').innerHTML = NAV.map(([k, label]) =>
    `<button aria-current="${state.screen === k}" data-go="${k}">${label}</button>`).join('');
}

export function currentObligation() {
  const o = state.editing === 'new'
    ? { id:'', name:'', amount:'', dueDate:'', recurrence:'monthly', priority:'hard',
        split:true, envelopeBalance:0, category:'Bills', autopay:false, isCard:false }
    : state.doc.obligations.find(x => x.id === state.editing);
  return o;
}

export function obligationFormFields() {
  const o = currentObligation();
  return `<label for="f-name">Name</label><input id="f-name" type="text" value="${esc(o.name)}">
    <label for="f-amount">Amount</label><input id="f-amount" type="number" inputmode="decimal" step="0.01" value="${o.amount}">
    <label for="f-due">Next due</label><input id="f-due" type="date" value="${o.dueDate}">
    <label for="f-rec">Repeats</label>
    <select id="f-rec">${['none','weekly','biweekly','monthly','yearly'].map(r =>
      `<option value="${r}"${o.recurrence === r ? ' selected' : ''}>${r === 'none' ? 'One-off' : r}</option>`).join('')}</select>
    <label for="f-pri">Priority</label>
    <select id="f-pri">
      <option value="hard"${o.priority === 'hard' ? ' selected' : ''}>Hard — a missed date costs money</option>
      <option value="flexible"${o.priority === 'flexible' ? ' selected' : ''}>Flexible — a missed date costs nothing</option>
    </select>
    <div class="sw"><div><b>Split across checks</b><p>Off means the whole amount comes out of the last check before it is due.</p></div>
      <button class="tog" aria-pressed="${o.split}" data-action="toggle-split" aria-label="Split across checks"><i></i></button></div>
    <div class="sw"><div><b>Autopay</b><p>Pays itself from the envelope the moment it is due and fully funded.</p></div>
      <button class="tog" aria-pressed="${o.autopay}" data-action="toggle-autopay" aria-label="Autopay"><i></i></button></div>
    <div class="sw"><div><b>Credit card</b><p>Charges made on this card feed its envelope automatically; paying it off drains only what you actually pay.</p></div>
      <button class="tog" aria-pressed="${o.isCard}" data-action="toggle-iscard" aria-label="Credit card"><i></i></button></div>`;
}

function obligationForm() {
  return `<div class="hd"><h2>${state.editing === 'new' ? 'New obligation' : esc(currentObligation().name)}</h2></div>
    ${obligationFormFields()}
    <p class="err" id="form-error" hidden></p>
    <div class="stack">
      <button class="btn" data-action="save-obligation">Save</button>
      ${state.editing !== 'new' && currentObligation().envelopeBalance > 0
        ? `<button class="btn sage" data-action="pay-obligation" data-id="${currentObligation().id}">Mark paid</button>` : ''}
      <button class="btn ghost" data-action="cancel-obligation">Cancel</button>
    </div>`;
}

screens.bills = () => {
  if (state.editing) return obligationForm();
  const live = state.doc.obligations.filter(o => !o.archived)
    .sort((a, b) => daysBetween(b.dueDate, a.dueDate));
  return `<div class="hd"><h2>Obligations</h2><span>${live.length} active</span></div>
    <div class="rows">${live.map(o => {
      const full = o.envelopeBalance >= o.amount - 0.005;
      const colour = full ? 'var(--ready)' : o.priority === 'flexible' ? 'var(--clay)' : 'var(--sage)';
      return `<button class="row" data-action="edit-obligation" data-id="${o.id}">
        ${ring(o.amount > 0 ? o.envelopeBalance / o.amount : 1, colour, full)}
        <span class="txt"><span class="nm">${esc(o.name)}</span>
        <span class="mt">${money(o.envelopeBalance)} of ${money(o.amount)} · ${o.priority} · due ${fmtDate(o.dueDate, state.today)}</span></span>
      </button>`;
    }).join('')}</div>
    <div class="stack">
      <button class="btn" data-action="new-obligation">Add a bill or goal</button>
    </div>`;
};

const monthStart = iso => iso.slice(0, 8) + '01';
const monthEnd = iso => {
  const d = new Date(iso + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
};

screens.history = () => {
  const { doc, today } = state;
  const thisMonth = summarise(doc.spends, monthStart(today), monthEnd(today));
  const prevIso = prevMonthStart(today);
  const lastMonth = summarise(doc.spends, prevIso, monthEnd(prevIso));
  const lastBy = new Map(lastMonth.byCategory.map(c => [c.category, c.amount]));

  const rows = thisMonth.byCategory.map(c => {
    const was = lastBy.get(c.category);
    const change = was === undefined ? ''
      : Math.abs(c.amount - was) < 1 ? 'about the same as last month'
      : c.amount > was ? `up ${money2(c.amount - was)} on last month`
      : `down ${money2(was - c.amount)} on last month`;
    return `<div class="line"><span>${esc(c.category)}<br><small class="mt">${change}</small></span>
      <b class="num">${money2(c.amount)}</b></div>`;
  }).join('');

  return `<div class="hd"><h2>This month</h2><span class="num">${money2(thisMonth.total)}</span></div>
    <div class="card">${rows || '<p class="note">Nothing recorded yet this month.</p>'}</div>
    <div class="hd" style="margin-top:22px"><h2>Every spend</h2></div>
    ${doc.spends.slice(0, 60).map(s =>
      `<div class="log"><span>${fmtDate(s.date, today)} — ${esc(s.category)}${s.onCard ? ' (card)' : ''}</span>
       <b class="num">${money2(s.amount)}</b></div>`).join('')
      || '<p class="note">Nothing yet.</p>'}
    <div class="stack"><button class="btn ghost" data-go="settings">Back</button></div>`;
};

screens.setup = () => {
  const s = state.setupStep || 1;
  if (s === 1) {
    const recovery = lastLoadError === 'parse' && readCorruptBackup()
      ? `<div class="flag"><b>Your saved data could not be read.</b> It has not been thrown away — the original is set aside and you can download it below before starting over. <div class="stack" style="margin-top:12px"><button class="btn ghost" data-action="download-corrupt">Download the unreadable file</button><button class="btn ghost" data-action="dismiss-corrupt">Dismiss</button></div></div>`
      : '';
    return `<div class="hd"><h2>When do you get paid?</h2></div>
    ${recovery}
    <label for="s-cad">How often</label>
    <select id="s-cad"><option value="weekly">Every week</option><option value="biweekly">Every two weeks</option></select>
    <label for="s-anchor">Your next payday</label><input id="s-anchor" type="date">
    <label for="s-base">A typical paycheck</label><input id="s-base" type="number" inputmode="decimal" step="0.01" placeholder="0.00">
    <p class="note">If the amount varies, put in a figure you can count on rather than your best week.</p>
    <p class="err" id="setup-error" hidden></p>
    <div class="stack"><button class="btn" data-action="setup-schedule">Next</button></div>`;
  }
  if (s === 2) return `<div class="hd"><h2>Add your first bill</h2></div>
    <p class="note">Rent or your biggest fixed bill is the right one to start with. You can add the rest afterwards.</p>
    ${obligationFormFields()}
    <p class="err" id="setup-error" hidden></p>
    <div class="stack"><button class="btn" data-action="setup-bill">Next</button>
    <button class="btn ghost" data-action="setup-skip">Skip for now</button></div>`;
  return `<div class="hd"><h2>Do you move money to savings?</h2></div>
    <p class="note">If you do, payday gives you one amount to transfer and your checking balance becomes your real spending money. If not, the app tracks the same numbers against one account and your bank will always look richer than you are.</p>
    <div class="stack">
      <button class="btn sage" data-action="setup-savings" data-on="1">Yes, I'll move it</button>
      <button class="btn ghost" data-action="setup-savings" data-on="0">No, just track it</button>
    </div>`;
};

screens.settings = () => {
  const { doc } = state;
  const last = doc.lastExport;
  const stale = !last || daysBetween(last, state.today) > 30;
  const corrupt = lastLoadError === 'parse' && !state.lastLoadErrorDismissed;
  const corruptBytes = corrupt ? readCorruptBackup() : null;

  return `<div class="hd"><h2>Settings</h2></div>
    ${corrupt && corruptBytes ? `<div class="flag"><b>Corrupt backup found.</b> Your data couldn't be read. <p>Download the file to investigate, then dismiss this alert.</p><div class="stack"><button class="btn ghost" data-action="download-corrupt">Download the file</button><button class="btn ghost" data-action="dismiss-corrupt">Dismiss</button></div></div>` : ''}
    ${stale && !corrupt ? `<div class="flag"><b>Back this up.</b> Everything lives on this phone only. If you clear your browser without a backup, it is gone.</div>` : ''}
    <div class="sw"><div><b>Move money to savings</b><p>Payday tells you one amount to transfer.</p></div>
      <button class="tog" aria-pressed="${doc.settings.useSavingsAccount}" data-action="toggle-savings" aria-label="Move money to savings"><i></i></button></div>
    <label for="s-baseline">Paycheck baseline</label>
    <input id="s-baseline" type="number" inputmode="decimal" step="0.01" value="${doc.schedule.baseline}" data-change="baseline">
    <div class="stack">
      <button class="btn" data-action="export">Save a backup</button>
      <button class="btn ghost" data-action="import">Restore from a backup</button>
      <button class="btn ghost" data-go="history">Spending history</button>
      <button class="btn ghost" data-go="payday">Payday</button>
    </div>
    <p class="err" id="settings-error" hidden></p>
    <p class="note">Last backup: ${last ? fmtDate(last, state.today) : 'never'}.</p>`;
};

const ACTIONS = {
  'mark-moved': () => commit({ ...state.doc, heldMoved: true }),
  'record-now': () => {
    // C3: refuse a duplicate recording for a date already recorded. Without this, tapping
    // "Record a paycheck" a second time for the same day invents a whole extra paycheck
    // with no undo and no history.
    if (state.doc.lastPaycheckDate === state.today) return;
    const amount = Number(prompt('How much was the paycheck?', state.doc.schedule.baseline));
    if (!Number.isFinite(amount) || amount <= 0) return;
    const paid = autoPayDue(state.doc, state.today).doc;
    const { doc, result } = applyPaycheck(paid, state.today, amount);
    const lastResult = { ...result, date: state.today, amount };
    state.lastResult = lastResult;
    doc.lastResult = lastResult;   // persisted so a reload still shows this paycheck
    go('payday'); commit(doc);
  },
  'cancel-spend': () => { state.entry.digits = ''; go('home'); },
  'commit-spend': () => {
    const amount = parseFloat(state.entry.digits);
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = document.getElementById('entry-error');
      err.textContent = 'Enter an amount first.';
      err.hidden = false;
      return;
    }
    const category = state.entry.category ?? state.doc.spends[0]?.category ?? CATEGORIES[0];
    const doc = recordSpend(state.doc, { date: state.today, amount, category, onCard: state.entry.onCard });
    state.entry.digits = '';
    go('home'); commit(doc);
  },
  'new-obligation': () => { state.editing = 'new'; go('bills'); },
  'cancel-obligation': () => { state.editing = null; go('bills'); },
  'edit-obligation': (el) => { state.editing = el.dataset.id; go('bills'); },
  'toggle-split': (el) => {
    // Flip aria-pressed on the element directly without calling render(), to preserve typed input.
    const current = el.getAttribute('aria-pressed') === 'true';
    el.setAttribute('aria-pressed', !current);
  },
  'toggle-autopay': (el) => {
    const current = el.getAttribute('aria-pressed') === 'true';
    el.setAttribute('aria-pressed', !current);
  },
  'toggle-iscard': (el) => {
    const current = el.getAttribute('aria-pressed') === 'true';
    el.setAttribute('aria-pressed', !current);
  },
  'save-obligation': () => {
    const name = document.getElementById('f-name').value.trim();
    const amount = Number(document.getElementById('f-amount').value);
    const dueDate = document.getElementById('f-due').value;
    const err = document.getElementById('form-error');
    if (!name || !Number.isFinite(amount) || amount <= 0 || !dueDate) {
      err.textContent = 'Give it a name, an amount above zero, and a due date.';
      err.hidden = false;
      return;
    }
    const fields = { name, amount, dueDate,
      recurrence: document.getElementById('f-rec').value,
      priority: document.getElementById('f-pri').value,
      // Read from each toggle's own state, not from a default — otherwise the switch has no
      // effect on what is persisted and every obligation saves as split:true/autopay:false/
      // isCard:false regardless of what was tapped.
      split: document.querySelector('[data-action="toggle-split"]').getAttribute('aria-pressed') === 'true',
      autopay: document.querySelector('[data-action="toggle-autopay"]').getAttribute('aria-pressed') === 'true',
      isCard: document.querySelector('[data-action="toggle-iscard"]').getAttribute('aria-pressed') === 'true' };
    const doc = structuredClone(state.doc);
    if (state.editing === 'new') {
      doc.obligations.push({ id: crypto.randomUUID(), category: 'Bills',
        envelopeBalance: 0, archived: false, ...fields,
        dueDay: Number(dueDate.slice(8, 10)) });
    } else {
      const existing = doc.obligations.find(o => o.id === state.editing);
      const dayChanged = Number(dueDate.slice(8, 10)) !== Number(String(existing.dueDate).slice(8, 10));
      Object.assign(existing, fields);
      if (dayChanged) existing.dueDay = Number(dueDate.slice(8, 10));   // editing the date re-anchors it
    }
    state.editing = null;
    commit(doc);
  },
  'pay-obligation': (el) => {
    const ob = state.doc.obligations.find(o => o.id === el.dataset.id);
    const raw = prompt(`How much did you actually pay for ${ob.name}?`, ob.amount);
    // prompt() returns null on Cancel and Number(null) is 0, which payBill would treat as a
    // real payment: it drains the envelope into buffer, rolls the due date forward and logs
    // "paid 0". Cancel must do nothing, and a zero payment is not a payment.
    if (raw === null) return;
    const actual = Number(raw);
    if (!Number.isFinite(actual) || actual <= 0) return;
    const { doc } = payBill(state.doc, ob.id, actual, state.today);
    state.editing = null;
    commit(doc);
  },
  'setup-schedule': () => {
    const cadence = document.getElementById('s-cad').value;
    const anchor = document.getElementById('s-anchor').value;
    const baseline = Number(document.getElementById('s-base').value);
    const err = document.getElementById('setup-error');
    if (!anchor || !Number.isFinite(baseline) || baseline <= 0) {
      err.textContent = 'Enter a payday date and a paycheck amount greater than zero.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const doc = structuredClone(state.doc);
    doc.schedule = { ...doc.schedule, cadence, anchor, baseline };
    state.doc = doc;
    state.setupStep = 2;
    state.editing = 'new';
    render();
  },
  'setup-bill': () => {
    const name = document.getElementById('f-name').value.trim();
    const amount = Number(document.getElementById('f-amount').value);
    const dueDate = document.getElementById('f-due').value;
    const err = document.getElementById('setup-error');
    if (!name || !Number.isFinite(amount) || amount <= 0 || !dueDate) {
      err.textContent = 'Give it a name, an amount above zero, and a due date.';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    const doc = structuredClone(state.doc);
    const split = document.querySelector('[data-action="toggle-split"]').getAttribute('aria-pressed') === 'true';
    const autopay = document.querySelector('[data-action="toggle-autopay"]').getAttribute('aria-pressed') === 'true';
    const isCard = document.querySelector('[data-action="toggle-iscard"]').getAttribute('aria-pressed') === 'true';
    doc.obligations.push({ id: crypto.randomUUID(), name, amount, dueDate, recurrence: 'monthly',
      priority: 'hard', split, category: 'Bills', envelopeBalance: 0, autopay, isCard, archived: false,
      dueDay: Number(dueDate.slice(8, 10)) });
    state.doc = doc;
    state.setupStep = 3;
    state.editing = null;
    render();
  },
  'setup-skip': () => {
    state.setupStep = 3;
    render();
  },
  'setup-savings': (el) => {
    const useSavingsAccount = el.dataset.on === '1';
    const doc = structuredClone(state.doc);
    doc.settings.useSavingsAccount = useSavingsAccount;
    commit(doc);
    state.setupStep = 1;
    go('home');
  },
  'toggle-savings': () => {
    // Must go through commit(), not saveDoc() alone. saveDoc writes localStorage but leaves
    // state.doc stale, so the next handler that clones state.doc overwrites the setting the
    // user just changed — reproduced: toggle savings off, edit the baseline, savings is back on.
    const doc = structuredClone(state.doc);
    doc.settings.useSavingsAccount = !doc.settings.useSavingsAccount;
    commit(doc);
  },
  'export': () => {
    const blob = new Blob([exportDoc(state.doc)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `money-backup-${state.today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    commit({ ...state.doc, lastExport: state.today });
  },
  'import': () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json';
    input.onchange = async () => {
      try { commit(importDoc(await input.files[0].text())); }
      catch (err) {
        const errEl = document.getElementById('settings-error');
        if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
      }
    };
    input.click();
  },
  'download-corrupt': () => {
    const bytes = readCorruptBackup();
    if (!bytes) return;
    const blob = new Blob([bytes], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `money-corrupt-${state.today}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  'dismiss-corrupt': () => {
    state.lastLoadErrorDismissed = true;
    clearCorruptBackup();
    render();
  }
};

// One delegated handler that dispatches at most one thing per tap. Two independent listeners
// would both fire when a data-action element sits inside a data-go element.
document.addEventListener('click', e => {
  const a = e.target.closest('[data-action]');
  if (a && ACTIONS[a.dataset.action]) { ACTIONS[a.dataset.action](a); return; }
  const el = e.target.closest('[data-go]');
  if (el) go(el.dataset.go);
});

document.addEventListener('click', e => {
  const k = e.target.closest('[data-key]');
  if (k) {
    const v = k.dataset.key, d = state.entry;
    if (v === 'back') d.digits = d.digits.slice(0, -1);
    else if (v === '.') { if (!d.digits.includes('.')) d.digits = (d.digits || '0') + '.'; }
    else if (!(d.digits.includes('.') && d.digits.split('.')[1].length >= 2)) d.digits += v;
    render();
  }
  const q = e.target.closest('[data-quick]');
  if (q) { state.entry.digits = String(q.dataset.quick); render(); }
  const c = e.target.closest('[data-cat]');
  if (c) { state.entry.category = c.dataset.cat; render(); }
  const a = e.target.closest('[data-card]');
  if (a) { state.entry.onCard = a.dataset.card === '1'; render(); }
});

document.addEventListener('change', e => {
  const input = e.target.closest('[data-change]');
  if (!input) return;
  const field = input.dataset.change;
  if (field === 'baseline') {
    const baseline = Number(input.value);
    if (Number.isFinite(baseline) && baseline >= 0) {
      const doc = structuredClone(state.doc);
      doc.schedule.baseline = baseline;
      saveDoc(doc);
      state.doc = doc;
    }
  }
});

// Sign goes before the currency symbol: "-$40.00", never "$-40.00".
const sign = n => (n < 0 ? '-' : '');
export const money  = n => sign(n) + '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
export const money2 = n => sign(n) + '$' + (Math.round(Math.abs(n) * 100) / 100)
  .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Every user-typed string reaches the screen through innerHTML, so it must be escaped.
// A bill named "Mum & Dad's loan <shared>" silently loses text without this, and an
// imported backup is an untrusted file.
export const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// "due 15 Sep", with the year only when it differs from today's — raw ISO is a machine
// value and does not belong on screen.
export const fmtDate = (iso, todayIso) => {
  if (!iso) return '';
  const sameYear = String(iso).slice(0, 4) === String(todayIso).slice(0, 4);
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
};

export const isLate = (o, todayIso) =>
  daysBetween(o.dueDate, todayIso) >= 0 && o.envelopeBalance < o.amount - 0.005;

// C1: isLate only flags an UNDERfunded past-due bill. A fully funded one whose date has
// passed slips through invisibly — dueDate only advances inside payBill, so nothing accrues
// for the next cycle and free-to-spend climbs without bound. needsPaying flags every
// obligation whose date has passed, funded or not, regardless of isLate.
export const needsPaying = (o, todayIso) =>
  !o.archived && daysBetween(o.dueDate, todayIso) >= 0;

export function ring(pct, colorVar, showCheck) {
  const c = 2 * Math.PI * 15;
  const on = (Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : 0) * c;
  return `<svg width="42" height="42" viewBox="0 0 42 42" aria-hidden="true" style="flex-shrink:0">
    <circle cx="21" cy="21" r="15" fill="none" stroke="var(--track)" stroke-width="5"></circle>
    <circle cx="21" cy="21" r="15" fill="none" stroke="${colorVar}" stroke-width="5"
      stroke-linecap="round" stroke-dasharray="${on.toFixed(1)} ${c.toFixed(1)}"
      transform="rotate(-90 21 21)"></circle>
    ${showCheck ? '<path d="M15 21l4.5 4.5L27 18" fill="none" stroke="var(--ready)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>' : ''}
  </svg>`;
}

screens.payday = () => {
  const { doc } = state;
  const L = state.lastResult;
  if (!L) return `<section class="hero"><div class="lab">No paycheck recorded yet</div></section>
    <div class="stack"><button class="btn" data-action="record-now">Record a paycheck</button></div>`;

  const rows = doc.obligations
    .filter(o => (L.contributions[o.id] || 0) > 0.004)
    .sort((a, b) => (L.contributions[b.id] || 0) - (L.contributions[a.id] || 0))
    .map(o => `<div class="line"><span>${esc(o.name)}</span><b class="num">${money2(L.contributions[o.id])}</b></div>`)
    .join('');

  return `<section class="hero">
      <div class="lab">Paycheck landed ${fmtDate(L.date, state.today)}</div>
      <div class="amt big num">${money(L.amount)}</div>
    </section>
    ${L.warnings.length ? `<div class="flag"><b>Short week.</b> Flexible envelopes were skipped, and these still came up short: ${L.warnings.map(esc).join(', ')}. They catch up on the next full check.</div>` : ''}
    ${L.isFifthPaycheck ? `<div class="ok"><b>Fifth payday this month.</b> Every envelope is already funded, so ${money(L.free)} of this is genuinely spare.</div>` : ''}
    <div class="card">
      <div class="line tot"><span>Set aside</span><b class="num">${money2(L.setAside)}</b></div>
      <div class="line tot"><span>Free to spend</span><b class="num">${money2(L.free)}</b></div>
    </div>
    ${doc.settings.useSavingsAccount
      ? (doc.heldMoved
        ? `<div class="ok">Moved to savings. Your checking balance is now your spending money.</div>`
        : `<div class="stack"><button class="btn sage" data-action="mark-moved">Mark ${money2(L.setAside)} moved to savings</button></div>`)
      : `<p class="note">Envelopes are tracked as numbers only, so your bank will show more than you can actually spend.</p>`}
    <div class="hd" style="margin-top:22px"><h2>This check funds</h2></div>
    <div class="card">${rows}</div>`;
};

// "March", or "March 2028" when that's not the current year — same convention as fmtDate.
// A month carrying `partial` is today's month counted from today rather than a whole month
// (Task 21), so it reads "Rest of August" and — the point of this helper — is never handed
// the same treatment as a full month by whatever calls it.
function monthLabel(m, todayIso) {
  const name = new Date(m.month + '-01T00:00:00Z')
    .toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const full = m.month.slice(0, 4) === todayIso.slice(0, 4) ? name : `${name} ${m.month.slice(0, 4)}`;
  return m.partial ? `Rest of ${full}` : full;
}

// The obligation names actually due in a given month, per projectDueDates — never invented.
function namesDueIn(obligations, from, to) {
  return obligations.filter(o => projectDueDates(o, from, to).length > 0).map(o => o.name);
}

// "Registration and car insurance land together" / "Rent lands this month" / "A, B and 2 more
// land together" — two or three names, then "and N more", per the brief.
function landCopy(names) {
  if (names.length === 0) return '';
  if (names.length === 1) return `${esc(names[0])} lands this month`;
  if (names.length <= 3) {
    const list = names.map(esc).join(', ').replace(/, ([^,]*)$/, ' and $1');
    return `${list} land together`;
  }
  const shown = names.slice(0, 2).map(esc).join(', ');
  return `${shown} and ${names.length - 2} more land together`;
}

const REASON_TEXT = { 'high share of income': 'a high share of income', 'well above recent months': 'well above recent months' };

screens.upcoming = () => {
  const { doc, today } = state;
  const live = doc.obligations.filter(o => !o.archived);

  const offTrack = live.map(o => ({ o, t: onTrack(o, doc, today) }))
    .filter(x => !x.t.ok)
    .sort((a, b) => b.t.shortfall - a.t.shortfall);

  // Task 21's own guard (a partial month never carries heavy:true from a fair comparison)
  // is not trusted blindly here — `!m.partial` is a second, explicit gate so the current,
  // not-yet-complete month can never be shown as heavy regardless of what the flag says.
  const heavy = heavyMonths(doc, today, 12).filter(m => m.heavy && !m.partial);

  const funded = live.map(o => ({ o, date: projectFundedDate(o, doc, today, 12) }));
  const withDate = funded.filter(f => f.date).sort((a, b) => daysBetween(b.date, a.date));
  const withoutDate = funded.filter(f => !f.date);

  return `<div class="hd"><h2>Coming up</h2></div>
    <p class="note">A trajectory, not a promise — assumes your usual paycheck and today's bills.</p>
    ${offTrack.length ? `<div class="hd" style="margin-top:22px"><h2>Off track</h2></div>
      ${offTrack.map(({ o, t }) => `<div class="flag">
        <b>${esc(o.name)}</b> · ${money(t.shortfall)} short on ${fmtDate(t.dueDate, today)} at this rate</div>`).join('')}` : ''}
    ${heavy.length ? `<div class="hd" style="margin-top:22px"><h2>Heavy months</h2></div>
      ${heavy.map(m => {
        const from = m.month + '-01';
        const to = new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
        const names = namesDueIn(live, from, to);
        const reason = m.reasons.map(r => REASON_TEXT[r] || r).join(' and ');
        return `<div class="flag">
          <b>${monthLabel(m, today)} — ${reason}</b>
          <p style="margin:4px 0 0">${money(m.obligations)} due against ${money(m.income)} in income.</p>
          ${names.length ? `<p style="margin:4px 0 0">${landCopy(names)}</p>` : ''}
        </div>`;
      }).join('')}` : ''}
    <div class="hd" style="margin-top:22px"><h2>Funded dates</h2></div>
    <div class="card">${[...withDate, ...withoutDate].map(({ o, date }) =>
      `<div class="line"><span>${esc(o.name)}</span>
       <b class="num${date ? '' : ' warn'}">${date ? `${o.isCard ? 'clear' : 'funded'} ${fmtDate(date, today)}` : 'not within a year at this rate'}</b></div>`
    ).join('') || '<div class="line"><span>No live obligations.</span></div>'}</div>`;
};

const CATEGORIES = ['Groceries', 'Gas', 'Eating out', 'Household', 'Fun', 'Other'];

screens.add = () => {
  const { doc } = state;
  const e = state.entry;
  const category = e.category ?? doc.spends[0]?.category ?? CATEGORIES[0];
  const p = pace(doc, state.today);
  const recent = [...new Set(doc.spends.map(s => s.amount))].slice(0, 3);
  const keys = ['1','2','3','4','5','6','7','8','9','.','0','back'];
  // I3: the chip promises a card envelope will absorb the charge. With no non-archived
  // card obligation to receive it, tapping it drops free-to-spend and credits nothing —
  // the double count section 5 exists to prevent, reached from the other side.
  const hasCard = doc.obligations.some(o => o.isCard && !o.archived);

  return `<div class="entry num">${e.digits === '' ? '$0' : '$' + e.digits}</div>
    <p class="note" style="text-align:center;margin-top:0">${money2(doc.free)} free · ${money(p.perDay)} a day for ${p.daysLeft} more</p>
    ${recent.length ? `<div class="chips">${recent.map(a =>
      `<button class="chip" data-quick="${a}">${money2(a)}</button>`).join('')}</div>` : ''}
    <div class="pad">${keys.map(k =>
      `<button data-key="${k}" aria-label="${k === 'back' ? 'Delete' : k}">${k === 'back' ? '⌫' : k}</button>`).join('')}</div>
    <label id="cat-label">Category</label>
    <div class="chips" role="group" aria-labelledby="cat-label">${CATEGORIES.map(c =>
      `<button class="chip" aria-pressed="${category === c}" data-cat="${c}">${c}</button>`).join('')}</div>
    <label id="acct-label">Paid with</label>
    <div class="chips" role="group" aria-labelledby="acct-label">
      <button class="chip" aria-pressed="${!e.onCard}" data-card="0">Checking</button>
      ${hasCard ? `<button class="chip" aria-pressed="${e.onCard}" data-card="1">Credit card</button>` : ''}
    </div>
    <p class="err" id="entry-error" hidden></p>
    <div class="stack">
      <button class="btn" data-action="commit-spend">Record spend</button>
      <button class="btn ghost" data-action="cancel-spend">Cancel</button>
    </div>`;
};

screens.home = () => {
  const { doc, today } = state;
  const p = pace(doc, today);
  const spent = Math.max(0, Math.round((doc.periodFree || 0) - doc.free));
  const live = doc.obligations.filter(o => !o.archived)
    .sort((a, b) => daysBetween(b.dueDate, a.dueDate));
  // C1: pin by needsPaying (any past-due obligation) rather than isLate (only underfunded
  // ones) — a fully funded bill past its due date must still be pinned and actioned.
  const overdue = live.filter(o => needsPaying(o, today));
  const rest = live.filter(o => !overdue.includes(o));

  const PACE_TEXT = {
    ahead:  d => `${money(d)} ahead`,
    behind: d => `${money(-d)} over pace`,
    on:     () => 'On pace'
  };
  const PACE_COLOR = { ahead: 'var(--ready)', behind: 'var(--alert)', on: 'var(--muted)' };

  const dayLine = p.daysLeft === 0 ? ''
    : doc.free <= 0
    ? `<div class="perday none num">Nothing left · ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} to payday</div>`
    : `<div class="perday num">${money(p.perDay)} a day for ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}</div>`;

  // Pace is meaningless before the first paycheck: there is no period to be on or off. A
  // brand-new user should not be told they are "On pace" against nothing.
  const showPace = p.status !== 'hidden' && !!doc.lastPaycheckDate;
  const chip = !showPace ? ''
    : `<div class="pchip num" style="color:${PACE_COLOR[p.status]}">${PACE_TEXT[p.status](p.delta)}</div>`;

  // A transfer is still owed from the last paycheck. Only meaningful when savings tracking
  // is on — screens.payday gates the same flag on useSavingsAccount at app.js:483, and
  // without that gate this would sit lit forever for anyone who opted out (heldMoved only
  // ever resets back to true via the mark-moved action, which that screen hides in that case).
  const transferOwed = doc.settings.useSavingsAccount && !doc.heldMoved && state.lastResult;
  const banner = transferOwed
    ? `<div class="flag" data-go="payday" style="cursor:pointer"><b>Move ${money(state.lastResult.setAside)} to savings.</b> Payday is waiting on this transfer.</div>`
    : '';

  return `<section class="hero">
      <div class="lab">Free to spend</div>
      <div class="amt big num">${money(doc.free)}</div>
      ${dayLine}${chip}
      <div class="sub num">${money(spent)} of ${money(doc.periodFree || 0)} spent this period</div>
    </section>
    ${banner}
    ${doc.buffer !== 0 ? `<div class="hd"><h2>Buffer</h2><span class="num">${money2(doc.buffer)}</span></div>` : ''}
    <div class="hd"><h2>Set aside</h2><span class="num">${money(live.reduce((a, o) => a + o.envelopeBalance, 0))} held</span></div>
    <div class="rows">${[...overdue, ...rest].map(obRow).join('')}</div>
    <div class="stack">
      <button class="btn" data-go="add">Add spend</button>
    </div>`;
};

function obRow(o) {
  const full = o.envelopeBalance >= o.amount - 0.005;
  const pastDue = needsPaying(o, state.today);
  // isLate keeps doing exactly the underfunded styling it always did — inside the pinned
  // group it distinguishes a short bill from one that is simply waiting to be marked paid.
  const late = isLate(o, state.today);
  const colour = pastDue ? 'var(--alert)' : full ? 'var(--ready)' : o.priority === 'flexible' ? 'var(--clay)' : 'var(--sage)';

  if (pastDue) {
    const shortfall = late ? `Short ${money2(o.amount - o.envelopeBalance)} · ` : '';
    return `<div class="row late" data-go="bills">
      ${ring(o.amount > 0 ? o.envelopeBalance / o.amount : 1, colour, false)}
      <span class="txt"><span class="nm">${esc(o.name)}</span>
      <span class="mt no">${shortfall}${esc(o.name)} was due ${fmtDate(o.dueDate, state.today)} — mark it paid</span></span>
      <button class="quick-pay" data-action="pay-obligation" data-id="${o.id}">Mark paid</button>
    </div>`;
  }

  const meta = full ? `Fully funded · due ${fmtDate(o.dueDate, state.today)}`
    : `${money(o.envelopeBalance)} of ${money(o.amount)} · due ${fmtDate(o.dueDate, state.today)}`;
  return `<button class="row ${full ? 'done' : ''}" data-go="bills">
    ${ring(o.amount > 0 ? o.envelopeBalance / o.amount : 1, colour, full)}
    <span class="txt"><span class="nm">${esc(o.name)}</span>
    <span class="mt ${full ? 'ok' : ''}">${meta}</span></span></button>`;
}

function boot() {
  if (!state.doc.schedule?.anchor) { state.screen = 'setup'; render(); return; }
  const { doc, ran, lastResult } = catchUp(state.doc, state.today);
  if (ran.length) {
    state.lastResult = lastResult;
    doc.lastResult = lastResult;   // persisted so a reload still shows this paycheck
    state.screen = 'payday';
    commit(doc);
  } else render();
}
boot();
