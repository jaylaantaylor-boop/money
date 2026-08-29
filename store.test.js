import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDoc, migrate, exportDoc, importDoc, loadDoc, saveDoc, lastLoadError, readCorruptBackup, clearCorruptBackup } from './store.js';

test('an empty document is valid and holds nothing personal', () => {
  const d = emptyDoc();
  assert.equal(d.v, 1);
  assert.deepEqual(d.obligations, []);
  assert.equal(d.schedule.baseline, 0);
  assert.equal(d.free, 0);
  assert.equal(d.lastExport, null);
  assert.equal(d.lastResult, null);
});

test('migrate repairs a document missing newer fields', () => {
  const d = migrate({ v: 1, obligations: [{ id: 'a', name: 'A', amount: 10 }] });
  assert.equal(d.periodFree, 0);
  assert.equal(d.settings.useSavingsAccount, true);
  assert.equal(d.obligations[0].envelopeBalance, 0);
  assert.equal(d.obligations[0].priority, 'hard');
  assert.equal(d.obligations[0].split, true);
});

test('migrate backfills dueDay from an existing dueDate', () => {
  const d = migrate({ v: 1, obligations: [{ id: 'a', name: 'A', amount: 10, dueDate: '2026-01-31' }] });
  assert.equal(d.obligations[0].dueDay, 31);
  assert.equal(migrate({ v: 1, obligations: [{ id: 'b', name: 'B', amount: 1 }] }).obligations[0].dueDay, null);
});

test('migrate survives junk', () => {
  assert.equal(migrate(null).v, 1);
  assert.equal(migrate('nonsense').v, 1);
  assert.deepEqual(migrate({ obligations: 'not an array' }).obligations, []);
});

test('export then import round-trips to an identical document', () => {
  const d = migrate({ v: 1, free: 123.45, buffer: 7,
    obligations: [{ id:'r', name:'Rent', amount:1600, dueDate:'2026-09-01' }] });
  assert.deepEqual(importDoc(exportDoc(d)), d);
});

test('importing rubbish throws a readable error', () => {
  assert.throws(() => importDoc('{ not json'), /could not be read/i);
});

// ===== Tests for Critical Issues =====

test('migrate handles null obligations without throwing', () => {
  const d = migrate({ v: 1, obligations: [null] });
  assert.equal(d.v, 1);
  assert.deepEqual(d.obligations, []);
});

test('migrate handles undefined obligations without throwing', () => {
  const d = migrate({ v: 1, obligations: [undefined] });
  assert.equal(d.v, 1);
  assert.deepEqual(d.obligations, []);
});

test('importDoc with null obligation does not throw TypeError; returns valid document', () => {
  const d = importDoc(JSON.stringify({ v: 1, obligations: [null] }));
  assert.equal(d.v, 1);
  assert.deepEqual(d.obligations, []);
});

test('migrate with corrupt schedule normalizes to clean object', () => {
  const d = migrate({ v: 1, schedule: 'weekly' });
  assert.equal(typeof d.schedule, 'object');
  assert.equal(d.schedule.cadence, 'weekly');
  assert.deepEqual(Object.keys(d.schedule).sort(), ['anchor', 'baseline', 'cadence']);
});

test('migrate with garbage dueDate gives dueDay: null, not 0', () => {
  const d = migrate({ v: 1, obligations: [{ id: 'a', name: 'A', amount: 1, dueDate: 'garbage' }] });
  assert.equal(d.obligations[0].dueDay, null);
});

test('migrate preserves every field declared in emptyDoc', () => {
  // Build fixture as raw object literal, not via migrate
  const fixture = {
    v: 1,
    schedule: { cadence: 'weekly', anchor: '', baseline: 0 },
    settings: { useSavingsAccount: true },
    obligations: [],
    free: 0, periodFree: 0, buffer: 0,
    lastPaycheckDate: null, heldMoved: true,
    lastResult: null,
    lastExport: null,
    spends: [], log: []
  };
  const d = migrate(fixture);
  assert.deepEqual(d, fixture);
});

test('migrate preserves all obligation fields', () => {
  const obligation = {
    id: 'test-id',
    name: 'Test Bill',
    amount: 100.50,
    category: 'Utilities',
    dueDate: '2026-08-31',
    dueDay: 31,
    recurrence: 'monthly',
    priority: 'flexible',
    split: false,
    envelopeBalance: 50.25,
    autopay: true,
    isCard: true,
    archived: false
  };
  const d = migrate({ v: 1, obligations: [obligation] });
  assert.deepEqual(d.obligations[0], obligation);
});

test('r2 parity: negative buffer survives persist and load unchanged', () => {
  // This tests I4 - rounding parity between store and engine
  const fixture = {
    v: 1,
    schedule: { cadence: 'weekly', anchor: '', baseline: 0 },
    settings: { useSavingsAccount: true },
    obligations: [],
    free: 0, periodFree: 0, buffer: -2.505,
    lastPaycheckDate: null, heldMoved: true,
    lastExport: null,
    spends: [], log: []
  };
  // After one migrate cycle, buffer should be rounded correctly
  const d1 = migrate(fixture);
  // After export/import round-trip, it should match
  const d2 = importDoc(exportDoc(d1));
  // And it should equal what engine.js's r2 would produce
  assert.equal(d2.buffer, d1.buffer);
  // The specific value matters: with sign-aware rounding, -2.505 should round to -2.51
  assert.equal(d2.buffer, -2.51);
});

// ===== Tests for C2 and C3 (require localStorage mocking) =====

test('C2: corrupt storage is preserved and loadDoc sets lastLoadError', () => {
  const stored = {};
  const mock = {
    getItem: (k) => stored[k] ?? null,
    setItem: (k, v) => { stored[k] = v; },
  };

  globalThis.localStorage = mock;
  try {
    // Establish starting state: successful save clears any previous fallback
    saveDoc(emptyDoc());

    // Simulate corrupted data in storage
    const truncated = '{"v":1,"free":1234.56,"obligations":[{"id":"r","name":"R';
    stored['money-doc-v1'] = truncated;

    const d = loadDoc();
    assert.equal(d.v, 1);
    assert.deepEqual(d.obligations, []);
    assert.equal(lastLoadError, 'parse');
    assert.equal(stored['money-doc-v1-corrupt'], truncated);
  } finally {
    delete globalThis.localStorage;
  }
});

test('C3: Safari private mode - after setItem throws, loadDoc returns edited doc not stale one', () => {
  const stored = {};
  let setItemThrows = false;
  const mock = {
    getItem: (k) => stored[k] ?? null,
    setItem: (k, v) => {
      if (setItemThrows) throw new Error('QuotaExceededError');
      stored[k] = v;
    },
  };

  globalThis.localStorage = mock;
  try {
    // Establish starting state: successful save clears any previous fallback
    saveDoc(emptyDoc());

    // First save succeeds
    const doc1 = { v: 1, free: 100, schedule: { cadence: 'weekly', anchor: '', baseline: 0 }, settings: { useSavingsAccount: true }, obligations: [], periodFree: 0, buffer: 0, lastPaycheckDate: null, heldMoved: true, lastExport: null, spends: [], log: [] };
    saveDoc(doc1);

    // Now make setItem throw (simulating Safari private mode)
    setItemThrows = true;
    const doc2 = { ...doc1, free: 42 };
    saveDoc(doc2);

    // loadDoc should return the edited doc (from fallback), not the stale one (from storage)
    const loaded = loadDoc();
    assert.equal(loaded.free, 42);
  } finally {
    delete globalThis.localStorage;
  }
});

test('saveDoc succeeding clears the fallback, so later loadDoc reads storage again', () => {
  const stored = {};
  const mock = {
    getItem: (k) => stored[k] ?? null,
    setItem: (k, v) => { stored[k] = v; },
  };
  
  globalThis.localStorage = mock;
  try {
    let setItemThrows = false;
    mock.setItem = (k, v) => {
      if (setItemThrows) throw new Error('QuotaExceededError');
      stored[k] = v;
    };
    
    // First save to storage
    const doc1 = { v: 1, free: 100, schedule: { cadence: 'weekly', anchor: '', baseline: 0 }, settings: { useSavingsAccount: true }, obligations: [], periodFree: 0, buffer: 0, lastPaycheckDate: null, heldMoved: true, lastExport: null, spends: [], log: [] };
    saveDoc(doc1);
    
    // Make setItem throw
    setItemThrows = true;
    const doc2 = { ...doc1, free: 50 };
    saveDoc(doc2); // This sets fallback
    
    // Load returns from fallback
    let loaded = loadDoc();
    assert.equal(loaded.free, 50);
    
    // Stop throwing errors and try to save again
    setItemThrows = false;
    const doc3 = { ...doc1, free: 75 };
    saveDoc(doc3); // This clears fallback and writes to storage
    
    // Now load should read from storage
    loaded = loadDoc();
    assert.equal(loaded.free, 75);
  } finally {
    delete globalThis.localStorage;
  }
});

// ===== Tests for Finding 1: corrupt backup recovery API =====

test('readCorruptBackup returns the preserved corruption raw string', () => {
  const stored = {};
  const mock = {
    getItem: (k) => stored[k] ?? null,
    setItem: (k, v) => { stored[k] = v; },
  };

  globalThis.localStorage = mock;
  try {
    // Establish starting state: successful save clears any previous fallback/corrupt state
    saveDoc(emptyDoc());

    const truncated = '{"v":1,"free":1234.56,"obligations":[{"id":"r","name":"R';
    stored['money-doc-v1'] = truncated;
    loadDoc(); // Triggers preservation of corrupt bytes

    // readCorruptBackup should return the preserved raw string
    const recovered = readCorruptBackup();
    assert.equal(recovered, truncated);
  } finally {
    delete globalThis.localStorage;
  }
});

test('clearCorruptBackup empties slot; subsequent corruption is preserved with different bytes', () => {
  const stored = {};
  const mock = {
    getItem: (k) => stored[k] ?? null,
    setItem: (k, v) => { stored[k] = v; },
    removeItem: (k) => { delete stored[k]; },
  };

  globalThis.localStorage = mock;
  try {
    // Establish starting state: successful save clears any previous fallback/corrupt state
    saveDoc(emptyDoc());

    // First corruption
    const corrupt1 = '{"v":1,"free":1234';
    stored['money-doc-v1'] = corrupt1;
    loadDoc();
    assert.equal(readCorruptBackup(), corrupt1);

    // Clear the backup
    clearCorruptBackup();
    assert.equal(readCorruptBackup(), null);

    // Second corruption with different bytes
    const corrupt2 = '{"v":1,"obligations":[{"id":"x"';
    stored['money-doc-v1'] = corrupt2;
    loadDoc();

    // Should now have the second corruption, not the first
    assert.equal(readCorruptBackup(), corrupt2);
  } finally {
    delete globalThis.localStorage;
  }
});

test('readCorruptBackup returns null when localStorage is absent or throws', () => {
  // Test 1: localStorage not available
  delete globalThis.localStorage;
  assert.equal(readCorruptBackup(), null);
  
  // Test 2: localStorage throws on getItem
  const mock = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  globalThis.localStorage = mock;
  try {
    assert.equal(readCorruptBackup(), null);
  } finally {
    delete globalThis.localStorage;
  }
});

// ===== Tests for Finding 2: migrate array guard =====

test('migrate([1,2,3]) returns valid document with no numeric-keyed junk', () => {
  const d = migrate([1, 2, 3]);
  assert.equal(d.v, 1);
  const keys = Object.keys(d);
  // Should have only string keys from emptyDoc, no numeric keys from array spread
  assert(!keys.some(k => /^\d+$/.test(k)), `Found numeric keys: ${keys.filter(k => /^\d+$/.test(k))}`);
  // Should have exactly the keys from emptyDoc
  const emptyKeys = Object.keys(emptyDoc());
  assert.deepEqual(keys.sort(), emptyKeys.sort());
});

// ===== Tests for I4: known-shape fields validated in migrate =====

test('I4: migrate whitelists schedule.cadence to weekly or biweekly only', () => {
  assert.equal(migrate({ schedule: { cadence: 'biweekly' } }).schedule.cadence, 'biweekly');
  assert.equal(migrate({ schedule: { cadence: 'weekly' } }).schedule.cadence, 'weekly');
  assert.equal(migrate({ schedule: { cadence: 'monthly' } }).schedule.cadence, 'weekly');
  assert.equal(migrate({ schedule: { cadence: '"><script>' } }).schedule.cadence, 'weekly');
});

test('I4: migrate validates schedule.anchor and schedule.baseline', () => {
  const d = migrate({ schedule: { anchor: 'not-a-date', baseline: 'NaN' } });
  assert.equal(d.schedule.anchor, '');
  assert.equal(d.schedule.baseline, 0);
  const ok = migrate({ schedule: { anchor: '2026-09-04', baseline: 1120.005 } });
  assert.equal(ok.schedule.anchor, '2026-09-04');
  assert.equal(ok.schedule.baseline, 1120.01);
});

test('I4: migrate coerces settings.useSavingsAccount to a real boolean', () => {
  assert.equal(migrate({ settings: { useSavingsAccount: 'yes' } }).settings.useSavingsAccount, true);
  assert.equal(migrate({ settings: { useSavingsAccount: 0 } }).settings.useSavingsAccount, false);
  assert.equal(typeof migrate({}).settings.useSavingsAccount, 'boolean');
});

test('I4: migrate whitelists obligation recurrence to the five known values, defaulting to monthly', () => {
  for (const r of ['none', 'weekly', 'biweekly', 'monthly', 'yearly']) {
    const d = migrate({ obligations: [{ id: 'x', name: 'X', amount: 1, recurrence: r }] });
    assert.equal(d.obligations[0].recurrence, r);
  }
  const hostile = migrate({ obligations: [{ id: 'x', name: 'X', amount: 1, recurrence: 'DROP TABLE' }] });
  assert.equal(hostile.obligations[0].recurrence, 'monthly');
  const missing = migrate({ obligations: [{ id: 'x', name: 'X', amount: 1 }] });
  assert.equal(missing.obligations[0].recurrence, 'monthly');
});

test('I4: migrate validates spends entries — amount rounded, date whitelisted', () => {
  const d = migrate({ spends: [{ date: 'not-a-date', amount: 'lots', category: 'Fun' }] });
  assert.equal(d.spends[0].date, '');
  assert.equal(d.spends[0].amount, 0);
  const ok = migrate({ spends: [{ date: '2026-09-04', amount: 12.345, category: 'Gas' }] });
  assert.equal(ok.spends[0].date, '2026-09-04');
  assert.equal(ok.spends[0].amount, 12.35);
  assert.equal(ok.spends[0].category, 'Gas');   // free text — untouched here, escaped at render
});

test('I4: a hostile imported document yields only whitelisted values', () => {
  const hostile = {
    v: 1,
    schedule: { cadence: '"><script>alert(1)</script>', anchor: 'not-a-date', baseline: 'NaN' },
    settings: { useSavingsAccount: 'truthy-string' },
    obligations: [{ id: 'a', name: 'A', amount: '50', dueDate: '2026-01-01', recurrence: 'DROP TABLE obligations' }],
    spends: [{ date: 'not-a-date', amount: 'lots', category: 'Fun' }]
  };
  const d = migrate(hostile);
  assert.equal(d.schedule.cadence, 'weekly');
  assert.equal(d.schedule.anchor, '');
  assert.equal(d.schedule.baseline, 0);
  assert.equal(typeof d.settings.useSavingsAccount, 'boolean');
  assert.equal(d.obligations[0].recurrence, 'monthly');
  assert.equal(d.spends[0].date, '');
  assert.equal(d.spends[0].amount, 0);
});

// ===== Tests for C3: lastResult persisted on the document =====

test('C3: migrate preserves a valid lastResult', () => {
  const lr = { date: '2026-09-04', amount: 1120, contributions: { rent: 400 },
    setAside: 400, free: 720, warnings: ['Rent'], isFifthPaycheck: false };
  const d = migrate({ v: 1, lastResult: lr });
  assert.deepEqual(d.lastResult, lr);
});

test('C3: migrate drops a lastResult with no valid date', () => {
  const d = migrate({ v: 1, lastResult: { amount: 1120, contributions: {}, setAside: 0, free: 1120 } });
  assert.equal(d.lastResult, null);
});

test('C3: migrate sanitises a hostile lastResult', () => {
  const d = migrate({ v: 1, lastResult: { date: '2026-09-04', amount: 'lots',
    contributions: { rent: 'x' }, setAside: 'x', free: 'x', warnings: [123, 'Rent'], isFifthPaycheck: 'yes' } });
  assert.equal(d.lastResult.date, '2026-09-04');
  assert.equal(d.lastResult.amount, 0);
  assert.equal(d.lastResult.contributions.rent, 0);
  assert.equal(d.lastResult.setAside, 0);
  assert.equal(d.lastResult.free, 0);
  assert.deepEqual(d.lastResult.warnings, ['123', 'Rent']);
  assert.equal(d.lastResult.isFifthPaycheck, true);
});

test('C3: export then import round-trips a lastResult unchanged', () => {
  const d = migrate({ v: 1, lastResult: { date: '2026-09-04', amount: 1120,
    contributions: { rent: 400 }, setAside: 400, free: 720, warnings: [], isFifthPaycheck: false } });
  assert.deepEqual(importDoc(exportDoc(d)), d);
});
