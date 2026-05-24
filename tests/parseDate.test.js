import { describe, it, expect } from 'vitest';
import { parseConnectedDate } from '../linkedin-tracker/core/parseDate.js';

// Helper: assert parsed timestamp equals (year, month, day) regardless of
// runtime timezone. Months are 1-indexed for readability in test cases.
function expectYMD(ts, year, month1Indexed, day) {
  expect(ts).not.toBeNull();
  const d = new Date(ts);
  expect(d.getFullYear()).toBe(year);
  expect(d.getMonth()).toBe(month1Indexed - 1);
  expect(d.getDate()).toBe(day);
}

describe('parseConnectedDate', () => {
  it('returns null for empty or null input', () => {
    expect(parseConnectedDate('')).toBeNull();
    expect(parseConnectedDate(null)).toBeNull();
    expect(parseConnectedDate(undefined)).toBeNull();
  });

  it('parses English "Connected on May 24, 2026"', () => {
    expectYMD(parseConnectedDate('Connected on May 24, 2026'), 2026, 5, 24);
  });

  it('parses English short form "Jan 3, 2025"', () => {
    expectYMD(parseConnectedDate('Connected on Jan 3, 2025'), 2025, 1, 3);
  });

  it('parses Russian "В контактах с 24 мая 2026 г."', () => {
    expectYMD(parseConnectedDate('В контактах с 24 мая 2026 г.'), 2026, 5, 24);
  });

  it('parses Ukrainian "У контактах з 24 травня 2026 р."', () => {
    expectYMD(parseConnectedDate('У контактах з 24 травня 2026 р.'), 2026, 5, 24);
  });

  it('parses German "Verbunden seit 24. Mai 2026"', () => {
    expectYMD(parseConnectedDate('Verbunden seit 24. Mai 2026'), 2026, 5, 24);
  });

  it('parses Ukrainian listopad (November)', () => {
    expectYMD(parseConnectedDate('У контактах з 5 листопада 2024 р.'), 2024, 11, 5);
  });

  it('parses Russian January', () => {
    expectYMD(parseConnectedDate('В контактах с 1 января 2023 г.'), 2023, 1, 1);
  });

  it('returns null when no recognizable month present', () => {
    expect(parseConnectedDate('Connected on Quartz 12, 2026')).toBeNull();
  });

  it('returns null when no year present', () => {
    expect(parseConnectedDate('Connected on May 24')).toBeNull();
  });

  it('ignores numbers that could not be a day', () => {
    // "2026" should be picked as year, not as day. With month=May, year=2026, the
    // day candidate must be in 1-31 — the only matching number is "5".
    expectYMD(parseConnectedDate('5 мая 2026'), 2026, 5, 5);
  });
});
