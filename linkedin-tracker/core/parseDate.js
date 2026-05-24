// Multi-locale "Connected on <date>" parser for the connections page.
// LinkedIn locales we've seen: English ("May 24, 2026"), Russian ("24 мая 2026 г."),
// Ukrainian ("24 травня 2026 р."), German ("24. Mai 2026").
//
// Two strategies:
//   1. Trim any prefix words ("Connected on", "В контактах с", etc.) and ask
//      native Date.parse — handles English reliably.
//   2. Manual extraction via month dictionary + year regex + day candidate —
//      used when native parser fails (most non-English locales).

const MONTH_INDEX = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
  января: 0, февраля: 1, марта: 2, апреля: 3, мая: 4, июня: 5,
  июля: 6, августа: 7, сентября: 8, октября: 9, ноября: 10, декабря: 11,
  січня: 0, лютого: 1, березня: 2, квітня: 3, травня: 4, червня: 5,
  липня: 6, серпня: 7, вересня: 8, жовтня: 9, листопада: 10, грудня: 11,
  januar: 0, februar: 1, märz: 2, mai: 4, juni: 5, juli: 6, oktober: 9, dezember: 11,
};

function parseConnectedDate(text) {
  if (!text) return null;

  // Require a 4-digit 20xx year somewhere in the input. Without this guard,
  // Date.parse("May 24") happily returns May 24 of 2001 (Node default), which
  // is wrong for every LinkedIn use case.
  const yearMatch = text.match(/\b(20\d{2})\b/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);

  // Native parser handles English well ("May 24, 2026" or "Connected on May 24, 2026"
  // after stripping the prefix). Validate the year matches our extracted one to
  // catch cases where the native parser invented a different year.
  const stripped = text.replace(/^[^\d\w]*[a-zа-яёі]+\s+/i, '');
  const native = Date.parse(stripped);
  if (!isNaN(native) && new Date(native).getFullYear() === year) return native;
  const native2 = Date.parse(text);
  if (!isNaN(native2) && new Date(native2).getFullYear() === year) return native2;

  // Manual extraction: month dictionary + extracted year + 1-2 digit day candidate.
  const lower = text.toLowerCase();
  let monthIdx = -1;
  for (const [name, idx] of Object.entries(MONTH_INDEX)) {
    if (new RegExp(`(?:^|[^a-zа-яёі])${name}(?:[^a-zа-яёі]|$)`, 'i').test(lower)) {
      monthIdx = idx;
      break;
    }
  }
  if (monthIdx === -1) return null;

  const numbers = (text.match(/\b\d{1,2}\b/g) || []).map((n) => parseInt(n, 10));
  const day = numbers.find((n) => n >= 1 && n <= 31);
  if (!day) return null;

  return new Date(year, monthIdx, day).getTime();
}

const LITParseDate = { parseConnectedDate, MONTH_INDEX };
if (typeof globalThis !== 'undefined') globalThis.LITParseDate = LITParseDate;
if (typeof module !== 'undefined' && module.exports) module.exports = LITParseDate;
