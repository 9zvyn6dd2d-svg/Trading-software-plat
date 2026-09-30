// US equity session windows in Eastern time. Holidays are not listed here on
// purpose: on a holiday no trades print, so every quote fails the freshness
// check and the page says data is unavailable rather than guessing.

const ET = 'America/New_York';

const SESSIONS = [
  { name: 'premarket', start: 4 * 60, end: 9 * 60 + 30 },
  { name: 'regular', start: 9 * 60 + 30, end: 16 * 60 },
  { name: 'afterhours', start: 16 * 60, end: 20 * 60 },
];

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ET,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function easternParts(date) {
  const parts = Object.fromEntries(partsFormatter.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export function marketSession(date = new Date()) {
  const { weekday, minutes } = easternParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  const session = SESSIONS.find((s) => minutes >= s.start && minutes < s.end);
  return session ? session.name : 'closed';
}

// Offset (ms) between UTC and Eastern time on the given date, e.g. -4h in summer.
function easternOffsetMs(date) {
  const tzName = new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName').value; // "GMT-4"
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(tzName);
  const hours = match ? Number(match[1]) : 0;
  const mins = match && match[2] ? Number(match[2]) : 0;
  return (hours * 60 + Math.sign(hours) * mins) * 60_000;
}

// The instant today's pre-market opens (04:00 ET) for the Eastern date of `date`.
export function premarketOpen(date = new Date()) {
  const { dateKey } = easternParts(date);
  const utcMidnight = Date.parse(`${dateKey}T00:00:00Z`);
  return new Date(utcMidnight + 4 * 3_600_000 - easternOffsetMs(date));
}
