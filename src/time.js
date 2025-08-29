export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function fmtDate(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isWeekday(date) {
  const day = date.getDay(); // 0 Sun .. 6 Sat
  return day >= 1 && day <= 5;
}

export function isWorkday(date, holidaySet) {
  // 평일이면서 휴일이 아닌 날
  if (!isWeekday(date)) return false;
  const key = fmtDate(date);
  return !holidaySet?.has(key);
}

export function rangeDays(start, count) {
  return Array.from({ length: count }, (_, i) => addDays(start, i));
}

export function weekKey(date) {
  // 주의 월요일 날짜를 키로 사용 (YYYY-MM-DD)
  const d = new Date(date);
  const day = d.getDay();
  const diffToMonday = (day + 6) % 7; // Mon=0
  const monday = addDays(d, -diffToMonday);
  return fmtDate(monday);
}

export function nextDayKey(date) {
  return fmtDate(addDays(date, 1));
}
