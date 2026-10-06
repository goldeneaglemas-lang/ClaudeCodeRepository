import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, isValidDateStr, utcToZoned, weekdayOf, zonedToUtc } from '../src/time.js';

test('zonedToUtc handles fixed and DST zones', () => {
  assert.equal(zonedToUtc('2026-10-05T09:00', 'Asia/Kolkata').toISOString(), '2026-10-05T03:30:00.000Z');
  assert.equal(zonedToUtc('2026-07-01T09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01T09:00', 'America/New_York').toISOString(), '2026-12-01T14:00:00.000Z');
  // Day after US DST ends (2026-11-01)
  assert.equal(zonedToUtc('2026-11-02T09:00', 'America/New_York').toISOString(), '2026-11-02T14:00:00.000Z');
});

test('utcToZoned round-trips', () => {
  const z = utcToZoned(new Date('2026-10-05T03:30:00Z'), 'Asia/Kolkata');
  assert.deepEqual(z, { date: '2026-10-05', time: '09:00', weekday: 'mon', local: '2026-10-05T09:00' });
});

test('date helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekdayOf('2026-10-05'), 'mon');
  assert.ok(isValidDateStr('2028-02-29'));
  assert.ok(!isValidDateStr('2026-02-30'));
  assert.throws(() => zonedToUtc('tomorrow', 'UTC'));
});
