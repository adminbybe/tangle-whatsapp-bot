// dayjs setup with utc + timezone plugins, fixed to Israel time by default.

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import 'dayjs/locale/he.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const FAMILY_TZ = process.env.BOT_FAMILY_TIMEZONE || 'Asia/Jerusalem';

export function nowInTz() {
  return dayjs().tz(FAMILY_TZ);
}

export function todayIsoDate() {
  return nowInTz().format('YYYY-MM-DD');
}

export function parseIsoToTz(iso) {
  return dayjs(iso).tz(FAMILY_TZ);
}

export { dayjs };
