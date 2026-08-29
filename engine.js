// Splits sign to avoid banker's rounding of .5 cases and -0 for near-zero negatives
export const r2 = n => (Math.sign(n) * Math.round(Math.abs(n) * 100) / 100) || 0;

const DAY = 86400000;
const asDate = iso => new Date(iso + 'T00:00:00Z');
const asIso = d => d.toISOString().slice(0, 10);

// A document that has not been through first-run setup has schedule.anchor === ''.
// Without this guard daysBetween returns NaN, addDays builds an Invalid Date, and
// toISOString throws RangeError — crashing the app for every brand-new user.
const validIso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) &&
  !Number.isNaN(asDate(String(v)).getTime());

export const addDays = (iso, n) => asIso(new Date(asDate(iso).getTime() + n * DAY));
export const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / DAY);

const stepOf = sched => (sched.cadence === 'biweekly' ? 14 : 7);

const clone = doc => JSON.parse(JSON.stringify(doc));

export function nextPaydateOnOrAfter(iso, sched) {
  if (!validIso(iso) || !validIso(sched?.anchor)) return null;
  const step = stepOf(sched);
  const k = Math.ceil(daysBetween(sched.anchor, iso) / step);
  return addDays(sched.anchor, k * step);
}

export function paydatesBetween(fromIso, toIso, sched) {
  const out = [];
  if (!validIso(fromIso) || !validIso(toIso) || !validIso(sched?.anchor)) return out;
  if (daysBetween(fromIso, toIso) < 0) return out;
  const step = stepOf(sched);
  let d = nextPaydateOnOrAfter(fromIso, sched);
  if (!d) return out;
  while (daysBetween(d, toIso) >= 0) { out.push(d); d = addDays(d, step); }
  return out;
}

export function advanceDueDate(ob) {
  const r = ob.recurrence;
  if (r === 'none') return null;
  if (r === 'weekly') return addDays(ob.dueDate, 7);
  if (r === 'biweekly') return addDays(ob.dueDate, 14);
  const d = asDate(ob.dueDate);
  const day = ob.dueDay ?? d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (r === 'monthly') t.setUTCMonth(t.getUTCMonth() + 1);
  else if (r === 'yearly') t.setUTCFullYear(t.getUTCFullYear() + 1);
  else return null;
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return asIso(t);
}

export function allocate(amount, obligations, payDateIso, sched) {
  // C2: an archived obligation is a ghost — payBill has already settled it and Home
  // hides it, so demanding money for it here would fund an envelope nothing can reach.
  // Filtered once, up front, so every caller (and the shortfall ordering below) is safe.
  const active = obligations.filter(ob => !ob.archived);
  const contributions = {};
  for (const ob of active) {
    const checks = paydatesBetween(payDateIso, ob.dueDate, sched).length;
    const n = Math.max(1, checks);
    const remaining = Math.max(0, r2(ob.amount - ob.envelopeBalance));
    if (remaining === 0) contributions[ob.id] = 0;
    else if (ob.split) contributions[ob.id] = r2(remaining / n);
    else contributions[ob.id] = n <= 1 ? remaining : 0;
  }
  const warnings = [];
  let total = r2(Object.values(contributions).reduce((a, b) => a + b, 0));
  if (total > amount) {
    const order = [...active].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'flexible' ? -1 : 1;
      return daysBetween(a.dueDate, b.dueDate);   // furthest due first
    });
    for (const ob of order) {
      if (total <= amount) break;
      const cut = Math.min(contributions[ob.id], r2(total - amount));
      if (cut > 0) {
        contributions[ob.id] = r2(contributions[ob.id] - cut);
        total = r2(total - cut);
        if (ob.priority === 'hard') warnings.push(ob.name);
      }
    }
  }
  const setAside = r2(Object.values(contributions).reduce((a, b) => a + b, 0));
  return { contributions, setAside, free: r2(Math.max(0, amount - setAside)), warnings };
}

export function isFifthPaycheck(payDateIso, sched) {
  if (sched.cadence !== 'weekly') return false;
  const first = payDateIso.slice(0, 8) + '01';
  const d = asDate(payDateIso);
  const last = asIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
  const dates = paydatesBetween(first, last, sched);
  // I2: "does this month have five paydays" is not "is this THAT payday" — the banner
  // belongs on the fifth check alone, not on all five.
  return dates.length >= 5 && dates[dates.length - 1] === payDateIso;
}

export function applyPaycheck(docIn, payDateIso, amount) {
  const doc = clone(docIn);
  doc.buffer = r2(doc.buffer + doc.free);
  const a = allocate(amount, doc.obligations, payDateIso, doc.schedule);
  for (const ob of doc.obligations) {
    ob.envelopeBalance = r2(ob.envelopeBalance + (a.contributions[ob.id] || 0));
  }
  doc.free = a.free;
  doc.periodFree = a.free;
  doc.heldMoved = false;
  doc.lastPaycheckDate = payDateIso;
  doc.log.unshift({ date: payDateIso, text: `Paycheck ${amount} — ${a.setAside} set aside` });
  return { doc, result: { ...a, isFifthPaycheck: isFifthPaycheck(payDateIso, doc.schedule) } };
}

export function payBill(docIn, obligationId, actualAmount, onIso) {
  const doc = clone(docIn);
  const ob = doc.obligations.find(o => o.id === obligationId);
  if (!ob) return { doc, difference: 0 };
  let difference;
  if (ob.isCard) {
    // I5: a card's normal case is a PARTIAL payment. Draining the whole envelope (like a
    // bill) and pushing the untouched remainder to Buffer would turn still-owed money into
    // spendable money — the exact double count section 5 exists to prevent. Only the amount
    // actually paid comes out of the envelope; anything paid beyond what was in it (rare,
    // but possible) is the only part that moves Buffer.
    const drain = Math.min(ob.envelopeBalance, actualAmount);
    const shortfall = r2(actualAmount - drain);
    difference = r2(-shortfall);
    doc.buffer = r2(doc.buffer + difference);
    ob.envelopeBalance = r2(ob.envelopeBalance - drain);
    ob.amount = r2(Math.max(0, ob.amount - actualAmount));
    const next = advanceDueDate(ob);
    if (next) ob.dueDate = next;
    // A card closes only when the balance is cleared. Archiving it while money is
    // still owed would make recordSpend's card lookup miss, so later charges would
    // drop free-to-spend with nothing crediting the envelope — the exact double
    // count section 5 exists to prevent.
    if (ob.amount <= 0.005) ob.archived = true;
  } else {
    difference = r2(ob.envelopeBalance - actualAmount);
    doc.buffer = r2(doc.buffer + difference);
    ob.envelopeBalance = 0;
    if (actualAmount > 0) ob.amount = r2(actualAmount);
    const next = advanceDueDate(ob);
    if (next) ob.dueDate = next; else ob.archived = true;
  }
  doc.log.unshift({ date: onIso, text: `${ob.name} paid ${actualAmount}` });
  return { doc, difference };
}

export function autoPayDue(docIn, uptoIso) {
  let doc = clone(docIn);
  const paid = [];
  for (let guard = 0; guard < 200; guard++) {
    const ob = doc.obligations.find(o => !o.archived && o.autopay &&
      daysBetween(o.dueDate, uptoIso) >= 0 && o.envelopeBalance >= o.amount - 0.005);
    if (!ob) break;
    paid.push(ob.name);
    doc = payBill(doc, ob.id, ob.amount, ob.dueDate).doc;
  }
  return { doc, paid };
}

export function recordSpend(docIn, { date, amount, category, onCard }) {
  const doc = clone(docIn);
  const amt = r2(amount);
  doc.free = r2(doc.free - amt);
  if (doc.free < 0) { doc.buffer = r2(doc.buffer + doc.free); doc.free = 0; }
  if (onCard) {
    const card = doc.obligations.find(o => o.isCard && !o.archived);
    if (card) {
      card.amount = r2(card.amount + amt);
      card.envelopeBalance = r2(card.envelopeBalance + amt);
    }
  }
  doc.spends.unshift({ date, amount: amt, category, onCard: !!onCard });
  return doc;
}

export function catchUp(docIn, todayIso) {
  let doc = clone(docIn);
  const ran = [];
  let lastResult = null;
  if (!validIso(doc.lastPaycheckDate)) return { doc, ran, lastResult };
  const due = paydatesBetween(addDays(doc.lastPaycheckDate, 1), todayIso, doc.schedule);
  for (const d of due) {
    doc = autoPayDue(doc, d).doc;
    const amount = doc.schedule.baseline;
    const applied = applyPaycheck(doc, d, amount);
    doc = applied.doc;
    lastResult = { ...applied.result, date: d, amount };
    ran.push(d);
  }
  doc = autoPayDue(doc, todayIso).doc;
  return { doc, ran, lastResult };
}

export function pace(doc, todayIso) {
  const next = nextPaydateOnOrAfter(addDays(todayIso, 1), doc.schedule);
  // No pay schedule yet (a document before first-run setup): there is nothing to pace
  // against, so report a hidden, zeroed result rather than throwing.
  if (!next) return { daysLeft: 0, perDay: 0, onPace: 0, delta: 0, isPayday: false, status: 'hidden' };
  const daysLeft = Math.max(1, daysBetween(todayIso, next));
  const periodDays = doc.schedule.cadence === 'biweekly' ? 14 : 7;
  // ?? not || : a periodFree of 0 is a real state (a paycheck fully consumed by bills),
  // and || would fall through to the baseline and report the user badly behind pace in
  // the very week they have nothing spare.
  const periodFree = Math.max(1, doc.periodFree ?? doc.schedule.baseline ?? 1);
  const perDay = r2(Math.max(0, doc.free) / daysLeft);
  const onPace = r2(periodFree * (daysLeft / periodDays));
  const delta = r2(doc.free - onPace);
  const isPayday = daysLeft >= periodDays;
  const tolerance = Math.max(5, periodFree * 0.05);
  const status = isPayday ? 'hidden'
    : Math.abs(delta) < tolerance ? 'on'
    : delta > 0 ? 'ahead' : 'behind';
  return { daysLeft, perDay, onPace, delta, isPayday, status };
}

export function summarise(spends, fromIso, toIso) {
  const inWindow = spends.filter(s =>
    daysBetween(fromIso, s.date) >= 0 && daysBetween(s.date, toIso) >= 0);
  const totals = new Map();
  for (const s of inWindow) totals.set(s.category, r2((totals.get(s.category) || 0) + s.amount));
  return {
    total: r2(inWindow.reduce((a, s) => a + s.amount, 0)),
    byCategory: [...totals].map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount)
  };
}

// Built from the year and month directly. Date.setUTCMonth(-1) overflows on the 31st of
// March, May, July, October and December — 2026-05-31 comes back as 2026-05-01 — which
// would silently compare a month against itself.
export function prevMonthStart(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

// --- Task 21: looking forward (spec §4.8) ---
// Pure projections over the existing document. No DOM, no storage, no clock: todayIso is
// always a parameter. Nothing here mutates its inputs.

const DUE_DATE_GUARD = 400;    // ~52/year for weekly; this caps even a decade-long horizon
const SIMULATE_GUARD = 600;    // ~52 paydates/year (weekly); generous headroom over 12 months

// First day of (iso's month + n), n may be negative.
const monthStart = (iso, n) => {
  const d = asDate(iso);
  return asIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
};
// Last day of (iso's month + n).
const monthEnd = (iso, n) => {
  const d = asDate(iso);
  return asIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)));
};
// iso plus n calendar months, clamping the day-of-month like advanceDueDate does — used only
// to compute a horizon end date, so a clamp here (Jan 31 + 1mo => Feb 28) is the right call.
const addMonthsClamped = (iso, n) => {
  const d = asDate(iso);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  t.setUTCMonth(t.getUTCMonth() + n);
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d.getUTCDate(), last));
  return asIso(t);
};

export function projectDueDates(ob, fromIso, toIso) {
  const out = [];
  if (ob.archived) return out;
  if (!validIso(ob.dueDate) || !validIso(fromIso) || !validIso(toIso)) return out;
  if (daysBetween(fromIso, toIso) < 0) return out;
  // Clone so advanceDueDate's mutation-free contract holds and the caller's obligation is
  // never touched. dueDay stays fixed on this walker for the whole walk — advanceDueDate
  // needs it as the immutable anchor, or a due-the-31st bill would permanently ratchet down
  // to the 28th after walking past February.
  const walker = { ...ob };
  let guard = 0;
  while (walker.dueDate && daysBetween(walker.dueDate, toIso) >= 0 && guard++ < DUE_DATE_GUARD) {
    if (daysBetween(fromIso, walker.dueDate) >= 0) out.push(walker.dueDate);
    walker.dueDate = advanceDueDate(walker);
  }
  return out;
}

// Runs allocate() at every real paydate from the day after todayIso through endIso, against
// the WHOLE obligation list (never a per-obligation shortcut — that's the trap this function
// exists to avoid; see projectFundedDate below). Returns one snapshot per simulated paydate.
function simulateEnvelopes(docIn, todayIso, endIso) {
  const snapshots = [];
  if (!validIso(todayIso) || !validIso(docIn?.schedule?.anchor) || !validIso(endIso)) return snapshots;
  const doc = clone(docIn);
  let d = nextPaydateOnOrAfter(addDays(todayIso, 1), doc.schedule);
  let guard = 0;
  while (d && daysBetween(d, endIso) >= 0 && guard++ < SIMULATE_GUARD) {
    const a = allocate(doc.schedule.baseline, doc.obligations, d, doc.schedule);
    for (const o of doc.obligations) o.envelopeBalance = r2(o.envelopeBalance + (a.contributions[o.id] || 0));
    snapshots.push({ date: d, balances: Object.fromEntries(doc.obligations.map(o => [o.id, o.envelopeBalance])) });
    d = addDays(d, stepOf(doc.schedule));
  }
  return snapshots;
}

export function projectFundedDate(ob, doc, todayIso, horizonMonths = 12) {
  if (r2(ob.amount - ob.envelopeBalance) <= 0.005) return ob.dueDate || null;
  if (!validIso(todayIso)) return null;
  const horizonEnd = addMonthsClamped(todayIso, horizonMonths);
  const snapshots = simulateEnvelopes(doc, todayIso, horizonEnd);
  for (const s of snapshots) {
    const bal = s.balances[ob.id];
    if (bal !== undefined && r2(ob.amount - bal) <= 0.005) return s.date;
  }
  return null;
}

export function onTrack(ob, doc, todayIso) {
  if (!validIso(ob.dueDate)) return { ok: true };
  const funded = projectFundedDate(ob, doc, todayIso);
  if (funded && daysBetween(funded, ob.dueDate) >= 0) return { ok: true };
  const snapshots = simulateEnvelopes(doc, todayIso, ob.dueDate);
  let balance = ob.envelopeBalance;
  for (const s of snapshots) if (s.balances[ob.id] !== undefined) balance = s.balances[ob.id];
  return { ok: false, shortfall: r2(Math.max(0, ob.amount - balance)), dueDate: ob.dueDate };
}

export function heavyMonths(doc, todayIso, horizonMonths = 12) {
  const active = (doc.obligations || []).filter(o => !o.archived);
  const totals = [];
  const months = [];
  // Month 0 starts at todayIso itself — this is a forward-looking view, so bills and
  // paydates already past earlier this month don't count. Later months use full bounds.
  // That makes month 0 a PARTIAL month whenever todayIso isn't the 1st: it covers fewer
  // days than a real month, so its (deflated) obligations total is not a fair comparator
  // for the trailing-average rule below — including it manufactures a false "well above
  // recent months" flag on the very next ordinary month. It still gets reported (bills
  // due later this month are genuinely coming up), just excluded as a comparator.
  const partialFirstMonth = todayIso.slice(8, 10) !== '01';
  // With a partial month 0, the rule needs one extra month before it has three full
  // months of real history to compare against.
  const trailingGate = partialFirstMonth ? 4 : 3;
  for (let i = 0; i < horizonMonths; i++) {
    const label = monthStart(todayIso, i).slice(0, 7);
    const from = i === 0 ? todayIso : monthStart(todayIso, i);
    const to = monthEnd(todayIso, i);
    let obligations = 0;
    for (const ob of active) obligations = r2(obligations + projectDueDates(ob, from, to).length * ob.amount);
    const baseline = doc.schedule?.baseline || 0;
    const paydates = validIso(doc.schedule?.anchor) ? paydatesBetween(from, to, doc.schedule).length : 0;
    const income = r2(baseline * paydates);
    const ratio = income === 0 ? null : obligations / income;
    const reasons = [];
    let heavy = false;
    if (ratio !== null && ratio > 0.7) { heavy = true; reasons.push('high share of income'); }
    // Only once three FULL prior months exist: fewer than that means nothing comparable
    // to compare against, so the rule would otherwise fire on noise (see trailingGate).
    if (i >= trailingGate) {
      const trailing = totals.slice(i - 3, i);
      const mean = trailing.reduce((a, b) => a + b, 0) / trailing.length;
      if (mean > 0 && obligations > mean * 1.25) { heavy = true; reasons.push('well above recent months'); }
    }
    totals.push(obligations);
    const entry = { month: label, obligations, income, ratio, heavy, reasons };
    if (i === 0) entry.partial = partialFirstMonth;
    months.push(entry);
  }
  return months;
}
