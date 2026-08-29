export const DOC_KEY = 'money-doc-v1';
export const PREFS_KEY = 'money-prefs-v1';
export const CORRUPT_KEY = 'money-doc-v1-corrupt';

// Must stay byte-identical to engine.js's r2. Splits sign to avoid banker's rounding
// of .5 cases and -0 for near-zero negatives. store.js imports nothing by design,
// so this is a deliberate duplicate — divergence silently drifts persisted negative
// values (buffer and free can both go negative) by a cent on every load.
const r2 = n => (Math.sign(n) * Math.round(Math.abs(n) * 100) / 100) || 0;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// A day-of-month outside 1-31 is not an anchor. Returning 0 would roll Date maths
// into the previous month — the exact bug dueDay exists to prevent.
const validDay = n => (Number.isInteger(n) && n >= 1 && n <= 31 ? n : null);

// Dates have a known shape, so they are validated here at the trust boundary rather than
// guarded at every use. An imported backup is an untrusted file.
const validDate = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) &&
  !Number.isNaN(new Date(String(v) + 'T00:00:00Z').getTime()) ? String(v) : fallback);

// I4: known-shape fields are validated here, at the trust boundary, rather than trusted
// wherever they are later read. cadence and recurrence are closed enums — anything outside
// them is nonsense a hostile import could plant to reach innerHTML or an attribute unescaped,
// and an unvalidated recurrence also makes advanceDueDate return null, permanently archiving
// a bill that should have rolled forward.
const validCadence = v => (v === 'biweekly' ? 'biweekly' : 'weekly');
const RECURRENCES = ['none', 'weekly', 'biweekly', 'monthly', 'yearly'];
const validRecurrence = v => (RECURRENCES.includes(v) ? v : 'monthly');

// lastResult is engine-computed, not free text, so it gets the same known-shape treatment:
// numbers are rounded, warnings are coerced to strings (already escaped at render), and a
// result missing a valid date is discarded rather than half-trusted.
function validLastResult(v) {
  if (!isObj(v)) return null;
  const date = validDate(v.date, null);
  if (!date) return null;
  return {
    date,
    amount: r2(v.amount),
    contributions: isObj(v.contributions)
      ? Object.fromEntries(Object.entries(v.contributions).map(([k, n]) => [k, r2(n)]))
      : {},
    setAside: r2(v.setAside),
    free: r2(v.free),
    warnings: Array.isArray(v.warnings) ? v.warnings.map(w => String(w)) : [],
    isFifthPaycheck: !!v.isFifthPaycheck
  };
}

let fallback = null;

// Set by loadDoc: null | 'parse' | 'access'. 'parse' means stored data existed but
// could not be read, and the raw bytes were preserved under CORRUPT_KEY.
export let lastLoadError = null;

export function emptyDoc() {
  return {
    v: 1,
    schedule: { cadence: 'weekly', anchor: '', baseline: 0 },
    settings: { useSavingsAccount: true },
    obligations: [],
    free: 0, periodFree: 0, buffer: 0,
    lastPaycheckDate: null, heldMoved: true,
    // C3: the last-recorded paycheck's breakdown lives on the document, not only in
    // session state — otherwise a reload (every time the phone kills the PWA) makes
    // Payday claim no paycheck exists when doc.lastPaycheckDate proves otherwise.
    lastResult: null,
    lastExport: null,
    spends: [], log: []
  };
}

export function migrate(raw) {
  const base = emptyDoc();
  const d = isObj(raw) ? raw : {};   // isObj excludes arrays: migrate([1,2,3]) must not spread
  const out = {
    ...base, ...d,
    v: 1,
    schedule: {
      cadence: validCadence((isObj(d.schedule) ? d.schedule : {}).cadence ?? base.schedule.cadence),
      anchor: validDate((isObj(d.schedule) ? d.schedule : {}).anchor ?? base.schedule.anchor, ''),
      baseline: r2((isObj(d.schedule) ? d.schedule : {}).baseline ?? base.schedule.baseline)
    },
    settings: {
      useSavingsAccount: !!((isObj(d.settings) ? d.settings : {}).useSavingsAccount ?? base.settings.useSavingsAccount)
    },
    obligations: Array.isArray(d.obligations)
      ? d.obligations.filter(isObj).map(o => ({
          id: (/^[A-Za-z0-9_-]{1,64}$/.test(String(o.id ?? '')) ? String(o.id)
               : Math.random().toString(36).slice(2)),
          name: String(o.name ?? 'Untitled'),
          amount: r2(o.amount),
          category: o.category ?? 'Bills',
          dueDate: validDate(o.dueDate, ''),
          dueDay: validDay(o.dueDay) ?? validDay(Number(String(o.dueDate ?? '').slice(8, 10))),
          recurrence: validRecurrence(o.recurrence),
          priority: o.priority === 'flexible' ? 'flexible' : 'hard',
          split: o.split !== false,
          envelopeBalance: r2(o.envelopeBalance),
          autopay: !!o.autopay,
          isCard: !!o.isCard,
          archived: !!o.archived
        }))
      : [],
    spends: Array.isArray(d.spends)
      ? d.spends.filter(isObj).map(s => ({ ...s, date: validDate(s.date, ''), amount: r2(s.amount) }))
      : [],
    log: Array.isArray(d.log) ? d.log.filter(isObj) : [],
    lastResult: validLastResult(d.lastResult)
  };
  for (const k of ['free', 'periodFree', 'buffer']) out[k] = r2(out[k]);
  out.lastPaycheckDate = validDate(out.lastPaycheckDate, null);
  out.lastExport = validDate(out.lastExport, null);
  return out;
}

export function loadDoc() {
  lastLoadError = null;
  // Once a write has failed this session, memory is the truth. Safari in private mode
  // lets getItem succeed while setItem throws, so reading storage here would silently
  // hand back the stale pre-edit document and lose the user's work with no error.
  if (fallback !== null) return migrate(JSON.parse(fallback));
  let raw = null;
  try { raw = localStorage.getItem(DOC_KEY); }
  catch { lastLoadError = 'access'; return emptyDoc(); }
  if (!raw) return emptyDoc();
  try { return migrate(JSON.parse(raw)); }
  catch {
    // Stored data existed but could not be parsed. Preserve the bytes before anything
    // overwrites them — this is the user's only copy — and tell the caller.
    lastLoadError = 'parse';
    try {
      if (!localStorage.getItem(CORRUPT_KEY)) localStorage.setItem(CORRUPT_KEY, raw);
      // Write-once on purpose: the FIRST corruption holds the bytes from before things went
      // wrong. Later incidents may only contain the empty document this function returns, so
      // overwriting would replace good salvage with worthless salvage. The recovery UI calls
      // clearCorruptBackup() once the user has the file, freeing the slot for any future one.
    } catch {}
    return emptyDoc();
  }
}

export function saveDoc(doc) {
  const s = JSON.stringify(doc);
  try { localStorage.setItem(DOC_KEY, s); fallback = null; } catch { fallback = s; }
}

export const exportDoc = doc => JSON.stringify(doc, null, 2);

export function importDoc(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error('That file could not be read as a backup.'); }
  try { return migrate(parsed); }
  catch { throw new Error('That file could not be read as a backup.'); }
}

// store.js is the only file allowed to touch localStorage, so recovery goes through here.
export function readCorruptBackup() {
  try { return localStorage.getItem(CORRUPT_KEY); } catch { return null; }
}

export function clearCorruptBackup() {
  try { localStorage.removeItem(CORRUPT_KEY); } catch {}
}
