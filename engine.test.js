import { test } from 'node:test';
import assert from 'node:assert/strict';
import { r2, addDays, daysBetween, nextPaydateOnOrAfter, paydatesBetween, advanceDueDate, allocate, applyPaycheck, isFifthPaycheck, payBill, autoPayDue, recordSpend, catchUp, pace, summarise, prevMonthStart, projectDueDates, projectFundedDate, onTrack, heavyMonths } from './engine.js';
import { migrate } from './store.js';

test('r2 rounds to two decimal places', () => {
  assert.equal(r2(0.1 + 0.2), 0.3);
  assert.equal(r2(1600 / 3), 533.33);
  assert.equal(r2(-0.005), -0.01);
});

test('r2 normalizes -0 to 0 for near-zero negatives', () => {
  // Regression: small negative values that round to zero should be +0, not -0
  // assert.equal uses Object.is, so Object.is(-0, 0) fails without normalization
  assert.equal(r2(-0.001), 0);
  assert.equal(r2(-0.004), 0);
  assert.equal(r2(0), 0);
});

const WEEKLY = { cadence: 'weekly', anchor: '2026-08-28' };   // a Friday

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-08-28', 7), '2026-09-04');
  assert.equal(addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(addDays('2026-09-04', -7), '2026-08-28');
});

test('daysBetween counts whole days', () => {
  assert.equal(daysBetween('2026-08-28', '2026-09-04'), 7);
  assert.equal(daysBetween('2026-08-28', '2026-08-28'), 0);
});

test('nextPaydateOnOrAfter returns the date itself when it is a payday', () => {
  assert.equal(nextPaydateOnOrAfter('2026-08-28', WEEKLY), '2026-08-28');
  assert.equal(nextPaydateOnOrAfter('2026-08-29', WEEKLY), '2026-09-04');
  assert.equal(nextPaydateOnOrAfter('2026-08-01', WEEKLY), '2026-08-07');
});

test('paydatesBetween is inclusive at both ends', () => {
  assert.deepEqual(paydatesBetween('2026-08-28', '2026-09-04', WEEKLY),
    ['2026-08-28', '2026-09-04']);
  assert.equal(paydatesBetween('2026-08-28', '2026-09-01', WEEKLY).length, 1);
  assert.equal(paydatesBetween('2026-08-28', '2026-08-27', WEEKLY).length, 0);
});

test('biweekly steps by fourteen days', () => {
  const b = { cadence: 'biweekly', anchor: '2026-08-28' };
  assert.deepEqual(paydatesBetween('2026-08-28', '2026-09-26', b),
    ['2026-08-28', '2026-09-11', '2026-09-25']);
});

const ob = (over) => ({ id: 'x', name: 'X', amount: 100, category: 'Bills',
  dueDate: '2026-09-01', recurrence: 'monthly', priority: 'hard', split: true,
  envelopeBalance: 0, autopay: false, isCard: false, dueDay: undefined, ...over });

test('monthly advances by one calendar month', () => {
  assert.equal(advanceDueDate(ob({ dueDate: '2026-09-01' })), '2026-10-01');
  assert.equal(advanceDueDate(ob({ dueDate: '2026-12-15' })), '2027-01-15');
});

test('monthly on the 31st clamps to the end of a short month', () => {
  assert.equal(advanceDueDate(ob({ dueDate: '2026-01-31' })), '2026-02-28');
  assert.equal(advanceDueDate(ob({ dueDate: '2026-03-31' })), '2026-04-30');
});

test('yearly advances by one year', () => {
  assert.equal(advanceDueDate(ob({ dueDate: '2026-03-12', recurrence: 'yearly' })), '2027-03-12');
});

test('weekly and biweekly advance by days', () => {
  assert.equal(advanceDueDate(ob({ dueDate: '2026-09-01', recurrence: 'weekly' })), '2026-09-08');
  assert.equal(advanceDueDate(ob({ dueDate: '2026-09-01', recurrence: 'biweekly' })), '2026-09-15');
});

test('a one-off returns null when it is paid', () => {
  assert.equal(advanceDueDate(ob({ recurrence: 'none' })), null);
});

test('a clamped day-of-month recovers in the next long month', () => {
  const o = ob({ dueDate: '2026-01-31', dueDay: 31 });
  const seen = [];
  for (let i = 0; i < 5; i++) { o.dueDate = advanceDueDate(o); seen.push(o.dueDate); }
  assert.deepEqual(seen, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
});

test('a yearly leap day returns to the 29th in the next leap year', () => {
  const o = ob({ dueDate: '2024-02-29', dueDay: 29, recurrence: 'yearly' });
  const seen = [];
  for (let i = 0; i < 4; i++) { o.dueDate = advanceDueDate(o); seen.push(o.dueDate); }
  assert.deepEqual(seen, ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
});

test('without dueDay the old clamping behaviour is unchanged', () => {
  assert.equal(advanceDueDate(ob({ dueDate: '2026-01-31' })), '2026-02-28');
});

const WEEKLY2 = { cadence: 'weekly', anchor: '2026-08-28' };
const bill = (over) => ({ id: 'b', name: 'B', amount: 400, category: 'Bills',
  dueDate: '2026-09-25', recurrence: 'monthly', priority: 'hard', split: true,
  envelopeBalance: 0, autopay: false, isCard: false, ...over });

test('splits the remaining need across the checks before the due date', () => {
  const b = bill({ amount: 400, dueDate: '2026-09-18', envelopeBalance: 0 });
  const a = allocate(1000, [b], '2026-08-28', WEEKLY2);
  assert.equal(paydatesBetween('2026-08-28', '2026-09-18', WEEKLY2).length, 4);
  assert.equal(a.contributions.b, 100);
  assert.equal(a.setAside, 100);
  assert.equal(a.free, 900);
});

test('divides the REMAINING need, not the full amount', () => {
  const b = bill({ amount: 400, dueDate: '2026-09-18', envelopeBalance: 200 });
  const a = allocate(1000, [b], '2026-08-28', WEEKLY2);
  assert.equal(a.contributions.b, 50);
});

test('a light week is caught up by the next check', () => {
  const b = bill({ amount: 400, dueDate: '2026-09-18', envelopeBalance: 0 });
  const first = allocate(1000, [b], '2026-08-28', WEEKLY2).contributions.b;
  b.envelopeBalance = r2(first - 60);
  const second = allocate(1000, [b], '2026-09-04', WEEKLY2).contributions.b;
  assert.ok(second > first, `${second} should exceed ${first}`);
  assert.equal(second, r2((400 - b.envelopeBalance) / 3));
});

test('a fully funded envelope contributes nothing', () => {
  const b = bill({ amount: 400, envelopeBalance: 400 });
  assert.equal(allocate(1000, [b], '2026-08-28', WEEKLY2).contributions.b, 0);
});

test('split:false pays nothing until the last check before the due date', () => {
  const b = bill({ amount: 45, dueDate: '2026-09-18', split: false });
  assert.equal(allocate(1000, [b], '2026-08-28', WEEKLY2).contributions.b, 0);
  assert.equal(allocate(1000, [b], '2026-09-18', WEEKLY2).contributions.b, 45);
});

test('an overdue obligation demands its whole remaining amount', () => {
  const b = bill({ amount: 180, dueDate: '2026-08-20', envelopeBalance: 100 });
  assert.equal(allocate(1000, [b], '2026-08-28', WEEKLY2).contributions.b, 80);
});

test('set aside plus free always equals the paycheck', () => {
  const bs = [bill({ id: 'r', amount: 1600, dueDate: '2026-10-01' }),
              bill({ id: 'c', amount: 420, dueDate: '2026-09-05' })];
  const a = allocate(1120, bs, '2026-08-28', WEEKLY2);
  assert.equal(r2(a.setAside + a.free), 1120);
});

const many = () => ([
  { id:'rent', name:'Rent', amount:1600, dueDate:'2026-09-01', recurrence:'monthly',
    priority:'hard', split:true, envelopeBalance:0, category:'Home', autopay:false, isCard:false },
  { id:'elec', name:'Electric', amount:140, dueDate:'2026-09-22', recurrence:'monthly',
    priority:'hard', split:true, envelopeBalance:0, category:'Home', autopay:false, isCard:false },
  { id:'xmas', name:'Christmas', amount:800, dueDate:'2026-12-20', recurrence:'none',
    priority:'flexible', split:true, envelopeBalance:0, category:'Goals', autopay:false, isCard:false }
]);

test('a short week never produces negative free to spend', () => {
  const a = allocate(300, many(), '2026-08-28', WEEKLY2);
  assert.ok(a.free >= 0, `free was ${a.free}`);
  assert.ok(a.setAside <= 300.005);
});

test('flexible envelopes are cut before hard ones', () => {
  const a = allocate(300, many(), '2026-08-28', WEEKLY2);
  assert.equal(a.contributions.xmas, 0);
  assert.ok(a.contributions.rent > 0);
});

test('among hard bills of equal contribution the furthest due is cut first', () => {
  // Both start at exactly 100 per check from 2026-08-28:
  //   Near: 100 over 1 check  (due 09-01, only the 08-28 payday precedes it)
  //   Far:  400 over 4 checks (due 09-22: 08-28, 09-04, 09-11, 09-18)
  const near = bill({ id: 'near', name: 'Near', amount: 100, dueDate: '2026-09-01', priority: 'hard' });
  const far  = bill({ id: 'far',  name: 'Far',  amount: 400, dueDate: '2026-09-22', priority: 'hard' });
  const a = allocate(150, [near, far], '2026-08-28', WEEKLY2);
  assert.equal(a.contributions.near, 100);   // nearest due is protected
  assert.equal(a.contributions.far, 50);     // furthest due absorbs the whole cut
  assert.deepEqual(a.warnings, ['Far']);
  assert.equal(r2(a.setAside + a.free), 150);
});

test('cutting a hard bill raises a named warning', () => {
  const a = allocate(300, many(), '2026-08-28', WEEKLY2);
  assert.ok(a.warnings.includes('Rent') || a.warnings.includes('Electric'),
    JSON.stringify(a.warnings));
});

test('a full week raises no warnings and cuts nothing', () => {
  const a = allocate(5000, many(), '2026-08-28', WEEKLY2);
  assert.deepEqual(a.warnings, []);
  assert.ok(a.contributions.xmas > 0);
});

test('C2: an archived obligation contributes nothing and is absent from contributions', () => {
  const ghost = bill({ id: 'ghost', amount: 800, dueDate: '2026-08-01', envelopeBalance: 0, archived: true });
  const rent = bill({ id: 'rent', amount: 400, dueDate: '2026-09-25', envelopeBalance: 0 });
  const a = allocate(1120, [ghost, rent], '2026-08-28', WEEKLY2);
  assert.equal('ghost' in a.contributions, false);
  assert.equal(a.setAside, a.contributions.rent);
});

test('C2: an archived obligation is ignored by shortfall ordering too', () => {
  const ghost = bill({ id: 'ghost', amount: 800, dueDate: '2026-08-01', envelopeBalance: 0,
    priority: 'flexible', archived: true });
  const rent = bill({ id: 'rent', amount: 100, dueDate: '2026-09-01', envelopeBalance: 0 });
  // A short week that would have to reduce something — must not throw or produce NaN
  // trying to look up a contribution the archived ghost never received.
  const a = allocate(50, [ghost, rent], '2026-08-28', WEEKLY2);
  assert.ok(Number.isFinite(a.free));
  assert.ok(Number.isFinite(a.setAside));
});

const doc0 = () => ({
  v: 1, schedule: { cadence:'weekly', anchor:'2026-08-28', baseline:1120 },
  settings: { useSavingsAccount: true }, obligations: many(),
  free: 90, periodFree: 400, buffer: 10,
  lastPaycheckDate: null, heldMoved: true, spends: [], log: []
});

test('applying a paycheck does not mutate the input document', () => {
  const before = doc0();
  const snapshot = JSON.stringify(before);
  applyPaycheck(before, '2026-08-28', 1120);
  assert.equal(JSON.stringify(before), snapshot);
});

test('leftover free rolls into the buffer', () => {
  const { doc } = applyPaycheck(doc0(), '2026-08-28', 1120);
  assert.equal(doc.buffer, 100);          // 10 existing + 90 left over
});

test('envelopes grow by their contributions and periodFree is recorded', () => {
  const { doc, result } = applyPaycheck(doc0(), '2026-08-28', 1120);
  const rent = doc.obligations.find(o => o.id === 'rent');
  assert.equal(rent.envelopeBalance, result.contributions.rent);
  assert.equal(doc.free, result.free);
  assert.equal(doc.periodFree, result.free);
  assert.equal(doc.lastPaycheckDate, '2026-08-28');
  assert.equal(doc.heldMoved, false);
  assert.equal('held' in doc, false);   // no write-only state on the document
});

test('I2: the fifth-payday banner fires only on the last payday of a five-payday month', () => {
  const s = { cadence: 'weekly', anchor: '2026-08-28' };
  // Oct 2026 has paydays on 2, 9, 16, 23 and 30 — only the LAST one is "the fifth check".
  // The other four are ordinary paydays and must not claim everything is genuinely spare.
  assert.equal(isFifthPaycheck('2026-10-02', s), false);
  assert.equal(isFifthPaycheck('2026-10-09', s), false);
  assert.equal(isFifthPaycheck('2026-10-16', s), false);
  assert.equal(isFifthPaycheck('2026-10-23', s), false);
  assert.equal(isFifthPaycheck('2026-10-30', s), true);
  // Sep 2026 has paydays on 4, 11, 18 and 25 — a four-payday month, never fifth
  assert.equal(isFifthPaycheck('2026-09-04', s), false);
  assert.equal(isFifthPaycheck('2026-09-25', s), false);
});

test('biweekly pay never reports a fifth paycheck', () => {
  assert.equal(isFifthPaycheck('2026-10-30', { cadence:'biweekly', anchor:'2026-08-28' }), false);
});

// Task 7: Paying bills and rolling due dates forward
const funded = () => {
  const d = doc0();
  d.obligations = [{ id:'elec', name:'Electric', amount:140, dueDate:'2026-09-22',
    recurrence:'monthly', priority:'hard', split:true, envelopeBalance:140,
    category:'Home', autopay:true, isCard:false }];
  d.buffer = 0;
  return d;
};

const withCard = () => {
  const d = doc0();
  d.obligations = [{ id:'card', name:'Card payoff', amount:2000, dueDate:'2027-06-01',
    recurrence:'none', priority:'flexible', split:true, envelopeBalance:300,
    category:'Debt', autopay:false, isCard:true }];
  d.free = 400; d.buffer = 0;
  return d;
};

test('paying exactly the envelope drains it and rolls the due date', () => {
  const { doc, difference } = payBill(funded(), 'elec', 140, '2026-09-22');
  const e = doc.obligations[0];
  assert.equal(e.envelopeBalance, 0);
  assert.equal(e.dueDate, '2026-10-22');
  assert.equal(difference, 0);
  assert.equal(doc.buffer, 0);
});

test('paying less than the envelope returns the difference to the buffer', () => {
  const { doc, difference } = payBill(funded(), 'elec', 110, '2026-09-22');
  assert.equal(difference, 30);
  assert.equal(doc.buffer, 30);
  assert.equal(doc.obligations[0].amount, 110);   // learns the new figure
});

test('paying more than the envelope takes the difference from the buffer', () => {
  const start = funded(); start.buffer = 100;
  const { doc, difference } = payBill(start, 'elec', 260, '2026-09-22');
  assert.equal(difference, -120);
  assert.equal(doc.buffer, -20);   // 100 in buffer, 120 overspend against the envelope
  assert.equal(doc.obligations[0].amount, 260);
});

test('a one-off obligation is archived rather than rolled', () => {
  const d = funded();
  d.obligations[0].recurrence = 'none';
  const { doc } = payBill(d, 'elec', 140, '2026-09-22');
  assert.equal(doc.obligations[0].archived, true);
});

test('autoPayDue settles every funded bill whose date has passed', () => {
  const { doc, paid } = autoPayDue(funded(), '2026-09-30');
  assert.deepEqual(paid, ['Electric']);
  assert.equal(doc.obligations[0].dueDate, '2026-10-22');
});

test('autoPayDue leaves an underfunded bill alone', () => {
  const d = funded(); d.obligations[0].envelopeBalance = 50;
  const { doc, paid } = autoPayDue(d, '2026-09-30');
  assert.deepEqual(paid, []);
  assert.equal(doc.obligations[0].dueDate, '2026-09-22');
});

test('a partial card payment leaves the card active', () => {
  const d = withCard();
  d.obligations[0].amount = 2050;
  d.obligations[0].envelopeBalance = 350;
  const { doc } = payBill(d, 'card', 350, '2026-09-22');
  assert.equal(doc.obligations[0].amount, 1700);
  assert.notEqual(doc.obligations[0].archived, true);
});

test('paying a card off completely archives it', () => {
  const d = withCard();
  d.obligations[0].amount = 300;
  d.obligations[0].envelopeBalance = 300;
  const { doc } = payBill(d, 'card', 300, '2026-09-22');
  assert.equal(doc.obligations[0].amount, 0);
  assert.equal(doc.obligations[0].archived, true);
});

test('I5: a partial card payment drains only the amount paid, leaving the remainder earmarked', () => {
  const d = withCard();
  d.obligations[0].amount = 980;
  d.obligations[0].envelopeBalance = 980;
  const { doc, difference } = payBill(d, 'card', 300, '2026-09-22');
  assert.equal(doc.obligations[0].envelopeBalance, 680);
  assert.equal(doc.obligations[0].amount, 680);
  // Nothing was overpaid, so nothing should move to or from Buffer.
  assert.equal(difference, 0);
  assert.equal(doc.buffer, 0);
});

test('I5: paying a card more than its envelope holds draws only the shortfall from Buffer', () => {
  const d = withCard();
  d.obligations[0].amount = 980;
  d.obligations[0].envelopeBalance = 200;
  d.buffer = 500;
  const { doc, difference } = payBill(d, 'card', 300, '2026-09-22');
  assert.equal(doc.obligations[0].envelopeBalance, 0);   // the whole envelope was drained
  assert.equal(doc.obligations[0].amount, 680);
  assert.equal(difference, -100);                        // only the 100 beyond the envelope
  assert.equal(doc.buffer, 400);                          // 500 - 100
});

test('conservation survives a partial card payoff followed by a charge', () => {
  const d = withCard();
  d.obligations[0].amount = 2050;
  d.obligations[0].envelopeBalance = 350;
  const { doc: paid } = payBill(d, 'card', 350, '2026-09-22');
  const before = r2(paid.free + paid.obligations[0].envelopeBalance);
  const after = recordSpend(paid, { date: '2026-09-23', amount: 20, category: 'Gas', onCard: true });
  assert.equal(r2(after.free + after.obligations[0].envelopeBalance), before);
  assert.equal(after.obligations[0].amount, 1720);  // 2050 - 350 (paid) + 20 (charged)
});

// Task 8: Spending and the credit card rule

test('a checking spend reduces free to spend', () => {
  const doc = recordSpend(withCard(), { date:'2026-09-01', amount:50, category:'Gas', onCard:false });
  assert.equal(doc.free, 350);
  assert.equal(doc.obligations[0].envelopeBalance, 300);
});

test('a card charge conserves free plus the card envelope', () => {
  const start = withCard();
  const before = r2(start.free + start.obligations[0].envelopeBalance);
  const doc = recordSpend(start, { date:'2026-09-01', amount:50, category:'Gas', onCard:true });
  assert.equal(r2(doc.free + doc.obligations[0].envelopeBalance), before);
  assert.equal(doc.free, 350);
  assert.equal(doc.obligations[0].envelopeBalance, 350);
  assert.equal(doc.obligations[0].amount, 2050);
});

test('overspending drains the buffer and never leaves free negative', () => {
  const start = withCard(); start.buffer = 100;
  const doc = recordSpend(start, { date:'2026-09-01', amount:450, category:'Fun', onCard:false });
  assert.equal(doc.free, 0);
  assert.equal(doc.buffer, 50);
  // Verify that when deficit exceeds the buffer, the buffer can go negative but free stays 0
  const start2 = withCard(); start2.buffer = 10;
  const doc2 = recordSpend(start2, { date:'2026-09-02', amount:450, category:'Fun', onCard:false });
  assert.equal(doc2.free, 0);
  assert.equal(doc2.buffer, -40);   // deficit (450 - 400 - 10) exceeds buffer, so it goes negative
});

test('every spend is recorded', () => {
  const doc = recordSpend(withCard(), { date:'2026-09-01', amount:12, category:'Gas', onCard:false });
  assert.equal(doc.spends[0].amount, 12);
  assert.equal(doc.spends[0].category, 'Gas');
});

// Task 9: Catching up on missed paydays

test('three missed paydays run exactly three, in order', () => {
  const d = doc0(); d.lastPaycheckDate = '2026-08-28';
  const { doc, ran } = catchUp(d, '2026-09-20');
  assert.deepEqual(ran, ['2026-09-04', '2026-09-11', '2026-09-18']);
  assert.equal(doc.lastPaycheckDate, '2026-09-18');
});

test('catching up matches having opened it every week', () => {
  const a = catchUp({ ...doc0(), lastPaycheckDate: '2026-08-28' }, '2026-09-20').doc;
  let b = { ...doc0(), lastPaycheckDate: '2026-08-28' };
  for (const d of ['2026-09-04', '2026-09-11', '2026-09-18']) {
    b = autoPayDue(b, d).doc;
    b = applyPaycheck(b, d, b.schedule.baseline).doc;
  }
  assert.deepEqual(a.obligations.map(o => o.envelopeBalance),
                   b.obligations.map(o => o.envelopeBalance));
});

test('opening before the next payday runs nothing', () => {
  const d = { ...doc0(), lastPaycheckDate: '2026-09-04' };
  assert.deepEqual(catchUp(d, '2026-09-06').ran, []);
});

test('a document that has never been paid runs nothing', () => {
  assert.deepEqual(catchUp(doc0(), '2026-09-20').ran, []);
  assert.equal(catchUp(doc0(), '2026-09-20').lastResult, null);
});

test('lastResult describes the final payday, not the first', () => {
  const d = doc0(); d.lastPaycheckDate = '2026-08-28';
  const { lastResult } = catchUp(d, '2026-09-20');
  assert.equal(lastResult.date, '2026-09-18');
  assert.equal(lastResult.amount, 1120);
  assert.equal(typeof lastResult.setAside, 'number');
});

test('catching up pays bills that came due along the way', () => {
  const d = doc0();
  d.lastPaycheckDate = '2026-08-28';
  const rent = d.obligations.find(o => o.id === 'rent');
  rent.autopay = true;
  rent.envelopeBalance = rent.amount;        // fully funded, due 2026-09-01
  const { doc } = catchUp(d, '2026-09-20');
  assert.equal(rent.dueDate, '2026-09-01');  // input untouched (purity)
  const after = doc.obligations.find(o => o.id === 'rent');
  assert.notEqual(after.dueDate, '2026-09-01');       // it rolled forward
  assert.ok(doc.log.some(l => l.text.startsWith('Rent paid')));
});

// Task 10: Daily allowance and pace

const paced = (free, periodFree) => ({ ...doc0(), free, periodFree,
  schedule: { cadence:'weekly', anchor:'2026-08-28', baseline:1120 } });

test('days left counts today through the day before the next payday', () => {
  assert.equal(pace(paced(400, 400), '2026-08-28').daysLeft, 7);
  assert.equal(pace(paced(400, 400), '2026-09-01').daysLeft, 3);
  assert.equal(pace(paced(400, 400), '2026-09-03').daysLeft, 1);
});

test('per day is free divided by days left', () => {
  assert.equal(pace(paced(300, 400), '2026-09-01').perDay, 100);
});

test('zero free never divides by zero and yields zero', () => {
  const p = pace(paced(0, 400), '2026-09-03');
  assert.ok(Number.isFinite(p.perDay));
  assert.equal(p.perDay, 0);
});

test('pace is hidden on payday itself', () => {
  assert.equal(pace(paced(400, 400), '2026-08-28').status, 'hidden');
});

test('spending faster than the period reads behind', () => {
  // 3 of 7 days left, so on pace would be 400 * 3/7 = 171.43
  assert.equal(pace(paced(80, 400), '2026-09-01').status, 'behind');
});

test('spending slower than the period reads ahead', () => {
  assert.equal(pace(paced(320, 400), '2026-09-01').status, 'ahead');
});

test('within tolerance reads on pace', () => {
  assert.equal(pace(paced(171, 400), '2026-09-01').status, 'on');
});

test('a fully allocated period is on pace, not behind', () => {
  const d = paced(0, 0);
  const p = pace(d, '2026-09-01');
  assert.equal(p.perDay, 0);
  assert.equal(p.status, 'on');
});

// Critical: guard against unconfigured documents (first-run path)
test('pace on an unconfigured document (empty anchor) returns hidden and does not throw', () => {
  const d = { ...doc0(), schedule: { cadence: 'weekly', anchor: '', baseline: 1120 } };
  const p = pace(d, '2026-09-01');
  assert.equal(p.daysLeft, 0);
  assert.equal(p.perDay, 0);
  assert.equal(p.onPace, 0);
  assert.equal(p.delta, 0);
  assert.equal(p.isPayday, false);
  assert.equal(p.status, 'hidden');
});

test('nextPaydateOnOrAfter with empty anchor returns null', () => {
  const result = nextPaydateOnOrAfter('2026-08-22', { cadence: 'weekly', anchor: '' });
  assert.equal(result, null);
});

test('paydatesBetween with empty anchor returns empty array', () => {
  const result = paydatesBetween('2026-08-01', '2026-09-01', { cadence: 'weekly', anchor: '' });
  assert.deepEqual(result, []);
});

test('prevMonthStart on 2026-03-31 returns 2026-02-01 (not 2026-03-01)', () => {
  assert.equal(prevMonthStart('2026-03-31'), '2026-02-01');
});

test('prevMonthStart on 2026-05-31 returns 2026-04-01 (not 2026-05-01)', () => {
  assert.equal(prevMonthStart('2026-05-31'), '2026-04-01');
});

test('prevMonthStart on 2026-07-31 returns 2026-06-01 (not 2026-07-01)', () => {
  assert.equal(prevMonthStart('2026-07-31'), '2026-06-01');
});

test('prevMonthStart on 2026-10-31 returns 2026-09-01 (not 2026-10-01)', () => {
  assert.equal(prevMonthStart('2026-10-31'), '2026-09-01');
});

test('prevMonthStart on 2026-12-31 returns 2026-11-01 (not 2026-12-01)', () => {
  assert.equal(prevMonthStart('2026-12-31'), '2026-11-01');
});

test('prevMonthStart on 2026-01-15 returns 2025-12-01', () => {
  assert.equal(prevMonthStart('2026-01-15'), '2025-12-01');
});

// Task 17: Spending history
const spends = [
  { date: '2026-09-03', amount: 40, category: 'Groceries', onCard: false },
  { date: '2026-09-01', amount: 12, category: 'Gas', onCard: false },
  { date: '2026-09-02', amount: 60, category: 'Groceries', onCard: true },
  { date: '2026-08-30', amount: 99, category: 'Fun', onCard: false }
];

test('summarise totals only the spends inside the window, inclusive', () => {
  const s = summarise(spends, '2026-09-01', '2026-09-30');
  assert.equal(s.total, 112);
  assert.equal(s.byCategory.length, 2);
});

test('categories come back largest first', () => {
  const s = summarise(spends, '2026-09-01', '2026-09-30');
  assert.deepEqual(s.byCategory[0], { category: 'Groceries', amount: 100 });
  assert.deepEqual(s.byCategory[1], { category: 'Gas', amount: 12 });
});

test('an empty window totals zero rather than throwing', () => {
  const s = summarise(spends, '2026-07-01', '2026-07-31');
  assert.equal(s.total, 0);
  assert.deepEqual(s.byCategory, []);
});

test('catchUp with invalid lastPaycheckDate returns early without throwing', () => {
  const d = doc0();
  d.lastPaycheckDate = 'not-a-date';
  const result = catchUp(d, '2026-09-20');
  assert.deepEqual(result.ran, []);
  assert.equal(result.lastResult, null);
});

test('migrate validates obligation id and regenerates if invalid', () => {
  // Invalid ID (XSS attempt) must be regenerated
  const result = migrate({obligations:[{id:'abc" data-injected="yes', name:'R', amount:1}]});
  const regen = result.obligations[0].id;
  assert.match(regen, /^[A-Za-z0-9_-]{1,64}$/);
  assert.notEqual(regen, 'abc" data-injected="yes');
  
  // Valid UUID-format ID must pass through unchanged
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';
  const result2 = migrate({obligations:[{id:validUUID, name:'R', amount:1}]});
  assert.equal(result2.obligations[0].id, validUUID);
});

// Task 21: projections — engine only, no DOM, no clock, todayIso always passed in

const proj = (over) => ({ id: 'p', name: 'Proj', amount: 100, category: 'Bills',
  dueDate: '2026-09-01', recurrence: 'monthly', priority: 'hard', split: true,
  envelopeBalance: 0, autopay: false, isCard: false, dueDay: undefined, ...over });

// --- projectDueDates ---

test('projectDueDates: recurrence none yields the single occurrence when it falls in range', () => {
  const o = proj({ recurrence: 'none', dueDate: '2026-09-15' });
  assert.deepEqual(projectDueDates(o, '2026-09-01', '2026-09-30'), ['2026-09-15']);
});

test('projectDueDates: recurrence none yields none when the date falls outside the range', () => {
  const o = proj({ recurrence: 'none', dueDate: '2026-10-15' });
  assert.deepEqual(projectDueDates(o, '2026-09-01', '2026-09-30'), []);
});

test('projectDueDates: an archived obligation yields none', () => {
  const o = proj({ archived: true });
  assert.deepEqual(projectDueDates(o, '2026-01-01', '2027-01-01'), []);
});

test('projectDueDates: a blank dueDate yields none', () => {
  const o = proj({ dueDate: '' });
  assert.deepEqual(projectDueDates(o, '2026-01-01', '2027-01-01'), []);
});

test('projectDueDates: a weekly obligation over a year yields about 52 occurrences', () => {
  const o = proj({ recurrence: 'weekly', dueDate: '2026-01-02' });
  const dates = projectDueDates(o, '2026-01-01', '2026-12-31');
  assert.ok(dates.length >= 51 && dates.length <= 53, `expected ~52, got ${dates.length}`);
});

test('projectDueDates: guards the loop at 400 rather than spinning over a huge horizon', () => {
  const o = proj({ recurrence: 'weekly', dueDate: '2026-01-02' });
  const dates = projectDueDates(o, '2026-01-01', '2040-01-01');   // ~730 weekly occurrences if unbounded
  assert.ok(dates.length <= 400, `expected the 400 guard to cap this, got ${dates.length}`);
});

test('projectDueDates: preserves the dueDay anchor across a clamped month when walking forward', () => {
  // Mirrors the advanceDueDate regression: due the 31st must recover in the next long
  // month rather than permanently ratcheting down to the 28th/30th.
  const o = proj({ recurrence: 'monthly', dueDate: '2026-01-31', dueDay: 31 });
  const dates = projectDueDates(o, '2026-01-01', '2026-06-30');
  assert.deepEqual(dates,
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
});

test('projectDueDates does not mutate the input obligation', () => {
  const o = proj({ recurrence: 'monthly', dueDate: '2026-01-31', dueDay: 31 });
  const snapshot = JSON.stringify(o);
  projectDueDates(o, '2026-01-01', '2026-06-30');
  assert.equal(JSON.stringify(o), snapshot);
});

// --- projectFundedDate ---

const WEEKLY3 = { cadence: 'weekly', anchor: '2026-08-28', baseline: 200 };
const fundDoc = (obligations, over) => ({
  v: 1, schedule: { ...WEEKLY3, ...over }, settings: { useSavingsAccount: true },
  obligations, free: 0, periodFree: 0, buffer: 0,
  lastPaycheckDate: '2026-08-28', heldMoved: true, spends: [], log: []
});

test('projectFundedDate returns the current dueDate when already funded, without simulating', () => {
  const o = proj({ id: 'goal', amount: 100, envelopeBalance: 100, dueDate: '2026-11-01' });
  const doc = fundDoc([o]);
  assert.equal(projectFundedDate(o, doc, '2026-08-28'), '2026-11-01');
});

test('projectFundedDate finds the paydate a lone envelope first reaches its target', () => {
  // amount 60, needed over 3 weekly checks up to the due date => 20/week uncontested
  const goal = proj({ id: 'goal', name: 'Goal', amount: 60, envelopeBalance: 0,
    recurrence: 'none', priority: 'flexible', dueDate: '2026-09-11' });
  const doc = fundDoc([goal]);
  assert.equal(projectFundedDate(goal, doc, '2026-08-28'), '2026-09-11');
});

test('projectFundedDate returns null when the envelope never reaches its target inside the horizon', () => {
  const goal = proj({ id: 'goal', amount: 100000, envelopeBalance: 0,
    recurrence: 'none', dueDate: '2027-01-01' });
  const doc = fundDoc([goal]);
  assert.equal(projectFundedDate(goal, doc, '2026-08-28', 12), null);
});

// The trap that matters most: projectFundedDate must run the REAL allocate() against the
// whole obligation list, not a per-obligation rate. Here a dominant hard bill (Rent, needing
// far more than the weekly baseline) starves a flexible goal that — considered alone — funds
// itself in three weeks (see the test above: 2026-09-11). Rent is flagged overdue on every
// paydate once its own due date passes without ever being paid off by this simulation (there
// is no payBill call — projections don't pretend the bill gets settled), so it demands its
// full remaining balance every week and is capped at the entire $200 baseline, leaving the
// flexible goal cut to zero for as long as Rent still needs money: 5000 / 200 = 25 weeks.
// Only once Rent's envelope is full (week 25, paydate 2027-02-19) does the goal finally get
// a look-in, funding on the very next paydate. A naive per-obligation shortcut — computing
// the goal's rate as if Rent didn't exist — would still report 2026-09-11. The real answer,
// 2027-02-26, is nearly 5.5 months later: the competition the trap warns about.
test('projectFundedDate: competition from other bills genuinely delays funding', () => {
  const rent = proj({ id: 'rent', name: 'Rent', amount: 5000, envelopeBalance: 0,
    recurrence: 'monthly', priority: 'hard', dueDate: '2026-09-25' });
  const goal = proj({ id: 'goal', name: 'Goal', amount: 60, envelopeBalance: 0,
    recurrence: 'none', priority: 'flexible', dueDate: '2026-09-11' });
  const doc = fundDoc([rent, goal]);
  assert.equal(projectFundedDate(goal, doc, '2026-08-28', 12), '2027-02-26');
});

test('projectFundedDate returns null gracefully on an unconfigured document (no pay schedule)', () => {
  const goal = proj({ id: 'goal', amount: 100, envelopeBalance: 0, dueDate: '2026-12-01' });
  const doc = fundDoc([goal], { anchor: '' });
  assert.equal(projectFundedDate(goal, doc, '2026-08-28'), null);
});

// --- onTrack ---

test('onTrack is ok when the projected funded date lands on or before the due date', () => {
  const goal = proj({ id: 'goal', amount: 60, envelopeBalance: 0,
    recurrence: 'none', priority: 'flexible', dueDate: '2026-09-11' });
  const doc = fundDoc([goal]);
  assert.deepEqual(onTrack(goal, doc, '2026-08-28'), { ok: true });
});

test('onTrack reports a named shortfall and the missed due date when funding falls behind', () => {
  const rent = proj({ id: 'rent', name: 'Rent', amount: 5000, envelopeBalance: 0,
    recurrence: 'monthly', priority: 'hard', dueDate: '2026-09-25' });
  const goal = proj({ id: 'goal', name: 'Goal', amount: 60, envelopeBalance: 0,
    recurrence: 'none', priority: 'flexible', dueDate: '2026-09-11' });
  const doc = fundDoc([rent, goal]);
  const result = onTrack(goal, doc, '2026-08-28');
  assert.equal(result.ok, false);
  assert.equal(result.dueDate, '2026-09-11');
  assert.equal(result.shortfall, 60);   // the goal receives nothing by its due date
});

test('onTrack: an obligation with no dueDate is always ok', () => {
  const o = proj({ dueDate: '' });
  const doc = fundDoc([o]);
  assert.deepEqual(onTrack(o, doc, '2026-08-28'), { ok: true });
});

test('onTrack: an already-funded obligation is ok', () => {
  const o = proj({ id: 'goal', amount: 100, envelopeBalance: 100, dueDate: '2026-09-01' });
  const doc = fundDoc([o]);
  assert.deepEqual(onTrack(o, doc, '2026-08-28'), { ok: true });
});

// --- heavyMonths ---

const heavyDoc = (obligations, baseline) => ({
  v: 1, schedule: { cadence: 'weekly', anchor: '2026-01-01', baseline },
  settings: { useSavingsAccount: true }, obligations, free: 0, periodFree: 0, buffer: 0,
  lastPaycheckDate: null, heldMoved: true, spends: [], log: []
});

test('heavyMonths: baseline 0 yields ratio null in every month, no divide-by-zero', () => {
  const rent = proj({ id: 'rent', amount: 500, recurrence: 'monthly', dueDate: '2026-01-15' });
  const months = heavyMonths(heavyDoc([rent], 0), '2026-01-01', 3);
  for (const m of months) {
    assert.equal(m.ratio, null);
    assert.ok(Number.isFinite(m.income));
    assert.ok(Number.isFinite(m.obligations));
  }
});

test('heavyMonths: an empty obligation list yields the months with zeros, not []', () => {
  const months = heavyMonths(heavyDoc([], 1000), '2026-01-01', 12);
  assert.equal(months.length, 12);
  for (const m of months) assert.equal(m.obligations, 0);
});

test('heavyMonths: archived obligations are excluded from the monthly total', () => {
  const ghost = proj({ id: 'ghost', amount: 900, recurrence: 'monthly', dueDate: '2026-01-15', archived: true });
  const rent = proj({ id: 'rent', amount: 500, recurrence: 'monthly', dueDate: '2026-01-15' });
  const months = heavyMonths(heavyDoc([ghost, rent], 5000), '2026-01-01', 1);
  assert.equal(months[0].obligations, 500);
});

test('heavyMonths: ratio above 0.7 flags high share of income', () => {
  const rent = proj({ id: 'rent', amount: 4000, recurrence: 'monthly', dueDate: '2026-01-15' });
  // Jan 2026 has 5 weekly paydates from anchor 2026-01-01 (1, 8, 15, 22, 29) at baseline 1000 => income 5000
  const months = heavyMonths(heavyDoc([rent], 1000), '2026-01-01', 1);
  assert.equal(months[0].income, 5000);
  assert.equal(months[0].ratio, 0.8);
  assert.equal(months[0].heavy, true);
  assert.deepEqual(months[0].reasons, ['high share of income']);
});

test('heavyMonths: the trailing-three-month rule does not fire before the fourth month', () => {
  const rent = proj({ id: 'rent', amount: 500, recurrence: 'monthly', dueDate: '2026-01-15' });
  // A one-off spike landing in March (index 2, the third month) — well above any trailing
  // average, but the rule must not apply yet because there are fewer than three prior months.
  const spike = proj({ id: 'spike', amount: 2000, recurrence: 'none', dueDate: '2026-03-10' });
  const months = heavyMonths(heavyDoc([rent, spike], 1000), '2026-01-01', 3);
  assert.equal(months[2].month, '2026-03');
  assert.equal(months[2].obligations, 2500);
  assert.equal(months[2].heavy, false);
  assert.deepEqual(months[2].reasons, []);
});

test('heavyMonths: the trailing-three-month rule fires from the fourth month onward', () => {
  const rent = proj({ id: 'rent', amount: 500, recurrence: 'monthly', dueDate: '2026-01-15' });
  // April (index 3, the fourth month) picks up an extra $200 bill. Jan/Feb/Mar obligations
  // are 500 each (mean 500); 700 > 500 * 1.25 = 625, so the trailing rule fires.
  // Income stays comfortably above obligations in every month, so ratio never fires alone.
  const extra = proj({ id: 'extra', amount: 200, recurrence: 'none', dueDate: '2026-04-10' });
  const months = heavyMonths(heavyDoc([rent, extra], 1000), '2026-01-01', 4);
  assert.equal(months[3].month, '2026-04');
  assert.equal(months[3].obligations, 700);
  assert.ok(months[3].ratio <= 0.7, `ratio was ${months[3].ratio}`);
  assert.equal(months[3].heavy, true);
  assert.deepEqual(months[3].reasons, ['well above recent months']);
});

// Follow-up defect: month 0's obligations run from todayIso (not the 1st), so it is a
// partial month. Letting a partial $0 month into the trailing-three-month average
// manufactures a false "well above recent months" flag on the very next ordinary month.

const monthProbeDoc = () => ({
  v: 1, schedule: { cadence: 'weekly', anchor: '2026-08-28', baseline: 1120 },
  settings: { useSavingsAccount: true },
  obligations: [
    proj({ id: 'rent', name: 'Rent', amount: 1600, recurrence: 'monthly', dueDate: '2026-09-01' }),
    proj({ id: 'car', name: 'Car', amount: 420, recurrence: 'monthly', dueDate: '2026-09-05' }),
    proj({ id: 'xmas', name: 'Christmas', amount: 800, recurrence: 'none', priority: 'flexible', dueDate: '2026-12-20' }),
    proj({ id: 'reg', name: 'Registration', amount: 700, recurrence: 'yearly', dueDate: '2027-03-10' }),
    proj({ id: 'ins', name: 'Insurance', amount: 540, recurrence: 'yearly', dueDate: '2027-03-25' })
  ],
  free: 0, periodFree: 0, buffer: 0, lastPaycheckDate: null, heldMoved: true, spends: [], log: []
});

test('heavyMonths: a partial first month is flagged and excluded from the trailing average', () => {
  const months = heavyMonths(monthProbeDoc(), '2026-08-24', 8);
  // index: 0=Aug(partial) 1=Sep 2=Oct 3=Nov 4=Dec 5=Jan 6=Feb 7=Mar
  assert.equal(months[0].month, '2026-08');
  assert.equal(months[0].partial, true);
  assert.equal(months[0].obligations, 0);
  assert.equal(months[1].obligations, 2020);
  assert.equal(months[2].obligations, 2020);
  assert.equal(months[3].month, '2026-11');
  assert.equal(months[3].obligations, 2020);
  // November is identical to September and October — it must NOT be flagged just because
  // the partial (near-empty) August dragged the trailing mean down.
  assert.equal(months[3].heavy, false, 'November must not be flagged heavy');
  assert.deepEqual(months[3].reasons, []);
  assert.equal(months[4].month, '2026-12');
  assert.equal(months[4].obligations, 2820);
  // December genuinely holds Christmas on top of the usual bills — this flag is legitimate.
  assert.equal(months[4].heavy, true, 'December must still be flagged heavy');
  assert.ok(months[4].reasons.includes('well above recent months'));
  assert.equal(months[7].month, '2027-03');
  assert.equal(months[7].heavy, true, 'March must still be flagged heavy');
  assert.ok(months[7].reasons.includes('high share of income'));
  assert.ok(months[7].reasons.includes('well above recent months'));
});

test('heavyMonths: month 0 is not partial when todayIso is the 1st of the month', () => {
  const rent = proj({ id: 'rent', amount: 500, recurrence: 'monthly', dueDate: '2026-01-15' });
  const months = heavyMonths(heavyDoc([rent], 1000), '2026-01-01', 1);
  assert.equal(months[0].partial, false);
});

test('heavyMonths: with today the 1st, a full month 0 still serves the trailing average from the fourth month (unchanged behaviour)', () => {
  const rent = proj({ id: 'rent', amount: 500, recurrence: 'monthly', dueDate: '2026-01-15' });
  const extra = proj({ id: 'extra', amount: 200, recurrence: 'none', dueDate: '2026-04-10' });
  const months = heavyMonths(heavyDoc([rent, extra], 1000), '2026-01-01', 4);
  assert.equal(months[0].partial, false);
  assert.equal(months[3].month, '2026-04');
  assert.equal(months[3].heavy, true);
  assert.deepEqual(months[3].reasons, ['well above recent months']);
});

test('heavyMonths: the mean > 0 guard stops a spurious flag when the trailing months are genuinely empty', () => {
  // Three months with nothing due, then a normal $300 bill appears in the fourth month.
  // Without the mean > 0 guard, obligations > mean * 1.25 reduces to 300 > 0 (true) for any
  // positive amount following an all-zero trailing window — a false "well above recent
  // months" flag on the first bill an otherwise-empty document ever sees.
  const first = proj({ id: 'first', amount: 300, recurrence: 'none', dueDate: '2026-04-10' });
  const months = heavyMonths(heavyDoc([first], 1000), '2026-01-01', 4);
  assert.equal(months[0].obligations, 0);
  assert.equal(months[1].obligations, 0);
  assert.equal(months[2].obligations, 0);
  assert.equal(months[3].obligations, 300);
  assert.equal(months[3].heavy, false, 'a lone bill after three empty months must not be flagged');
  assert.deepEqual(months[3].reasons, []);
});

test('heavyMonths: an empty obligation list never divides by zero building the trailing average', () => {
  const months = heavyMonths(heavyDoc([], 1000), '2026-01-01', 6);
  for (const m of months) {
    assert.equal(m.obligations, 0);
    assert.equal(m.heavy, false);
    assert.deepEqual(m.reasons, []);
    assert.ok(Number.isFinite(m.ratio));
  }
});
