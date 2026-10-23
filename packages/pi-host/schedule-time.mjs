// Schedule times (docs/SCHEDULES.md). Pure functions: wall-clock times in a named IANA time
// zone are turned into instants with Intl.DateTimeFormat, so daylight saving changes are
// handled by the zone rules rather than a fixed offset. No timers live here.

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const HOUR = 3600000;
const formatters = new Map();

function formatter(timeZone) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

/** True when `timeZone` is an IANA zone name this runtime knows, e.g. "Australia/Sydney". */
export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try { formatter(timeZone); return true; } catch { return false; }
}

/** The wall clock in `timeZone` at instant `ms`: { year, month (1-12), day, hour, minute, second, weekday (0 = Sunday) }. */
export function wallClock(ms, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return { year: parts.year, month: parts.month, day: parts.day, hour, minute: parts.minute, second: parts.second, weekday };
}

/** How far the zone's wall clock is ahead of UTC at `ms`, in milliseconds. */
function offset(ms, timeZone) {
  const w = wallClock(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant a wall-clock time happens in `timeZone`. A time that happens twice (clocks go
 * back) gives the first; a time that does not exist (clocks go forward) moves forward by the
 * jump, so 02:30 on a one-hour spring-forward night is 03:30.
 */
export function localToInstant({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offset(guess - 48 * HOUR, timeZone);
  const offsets = [...new Set([before, offset(guess, timeZone), offset(guess + 48 * HOUR, timeZone)])];
  const matches = offsets.map((o) => guess - o).filter((at) => {
    const w = wallClock(at, timeZone);
    return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
  });
  return matches.length ? Math.min(...matches) : guess - before;
}

/** "08:00" as { hour, minute }, or undefined. Accepts "8:00" too. */
export function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return undefined;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : undefined;
}

/** "2026-07-01T09:30" as wall-clock fields, or undefined. A space instead of "T" works too. */
export function parseLocal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}:\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return undefined;
  const time = parseTime(match[4]);
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (!time || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return undefined;
  return { year, month, day, ...time };
}

const intervalMs = (when) => when.every * (when.unit === 'hours' ? 60 : 1) * 60000;

/**
 * The first run time strictly after `after` (ms), or null when there is none (a once
 * schedule whose time has passed). `anchor` (ms) is where interval counting starts.
 */
export function nextRun({ when, timezone, anchor = 0 }, after) {
  if (when.kind === 'interval') {
    const period = intervalMs(when);
    const steps = after < anchor ? 1 : Math.floor((after - anchor) / period) + 1;
    return anchor + steps * period;
  }
  if (when.kind === 'once') {
    const at = localToInstant(parseLocal(when.at), timezone);
    return at > after ? at : null;
  }
  const time = parseTime(when.time);
  const allowed = when.kind === 'daily' ? () => true
    : when.kind === 'weekdays' ? (day) => day >= 1 && day <= 5
      : (day) => when.days.includes(DAY_NAMES[day]);
  const today = wallClock(after, timezone);
  for (let i = 0; i <= 8; i++) {
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (!allowed(date.getUTCDay())) continue;
    const at = localToInstant({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), ...time }, timezone);
    if (at > after) return at;
  }
  return null;
}

const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
/** The timing in plain words, e.g. "Weekdays at 08:00" or "Every 30 minutes". */
export function describeWhen(when) {
  if (when.kind === 'interval') return `Every ${when.every === 1 ? '' : when.every + ' '}${when.every === 1 ? when.unit.replace(/s$/, '') : when.unit}`;
  if (when.kind === 'daily') return `Every day at ${when.time}`;
  if (when.kind === 'weekdays') return `Weekdays at ${when.time}`;
  if (when.kind === 'weekly') return `${DAY_NAMES.slice(1).concat('sun').filter((d) => when.days.includes(d)).map((d) => DAY_LABELS[d]).join(', ')} at ${when.time}`;
  return `Once on ${String(when.at).replace(/[T ]/, ' at ')}`;
}

/** A short local date and time, e.g. "Mon 6 Oct, 08:00". */
export function formatLocal(ms, timeZone) {
  return new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms)).replace(/\s+/g, ' ').replace(/^(\w+),/, '$1');
}
