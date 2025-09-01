import { generateSchedule } from './scheduler.js';
import { fmtDate, addDays, isWeekday, rangeDays, weekKey, weekKeyByMode } from './time.js';

const startInput = document.querySelector('#start-date');
const weeksInput = document.querySelector('#weeks');
const endInput = document.querySelector('#end-date');
const employeesInput = document.querySelector('#employees');
const generateBtn = document.querySelector('#generate');
const exportJsonBtn = document.querySelector('#export-json');
const exportCsvBtn = document.querySelector('#export-csv');
const messages = document.querySelector('#messages');
const summary = document.querySelector('#summary');
const report = document.querySelector('#report');
const calendar = document.querySelector('#calendar');
const holidaysInput = document.querySelector('#holidays');
const unavailableInput = document.querySelector('#unavailable');
const vacationsInput = document.querySelector('#vacations');
const optLevelSelect = document.querySelector('#opt-level');

// 기본값: 다음 월요일
setDefaultStartMonday();

generateBtn.addEventListener('click', onGenerate);
exportJsonBtn.addEventListener('click', onExportJson);
exportCsvBtn.addEventListener('click', onExportCsv);

let lastResult = null;

function setDefaultStartMonday() {
  const today = new Date();
  const day = today.getDay();
  const toNextMonday = ((8 - day) % 7) || 7;
  const nextMonday = new Date(today);
  nextMonday.setDate(today.getDate() + toNextMonday);
  startInput.valueAsDate = nextMonday;
}

function parseEmployees(text) {
  // 형식: 이름[,|\t| ](any|weekday|weekend|평일|주말) (옵션)
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.map((line) => {
    // 쉼표/탭/파이프/공백 구분자 지원
    const parts = line.split(/\s*[|,\t]\s*|\s{2,}/).map((p) => p.trim()).filter(Boolean);
    const name = parts[0];
    const pref = (parts[1] || 'any').toLowerCase();
    return { name, preference: toPref(pref) };
  });
}

function toPref(s) {
  if (!s) return 'any';
  if (s.startsWith('weekend') || s === '주말') return 'weekend';
  if (s.startsWith('weekday') || s === '평일') return 'weekday';
  return 'any';
}

function parseHolidays(text) {
  return new Set(
    text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  );
}

function parseUnavailable(text) {
  // 형식: 이름: YYYY-MM-DD, YYYY-MM-DD ... (쉼표/파이프/탭/공백 등 혼합 허용)
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]+)[:：](.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2];
    const dates = (rest.match(/\d{4}-\d{2}-\d{2}/g) || []).map((d) => d.trim());
    if (!map.has(name)) map.set(name, new Set());
    const set = map.get(name);
    for (const d of dates) set.add(d);
  }
  return map;
}

function onGenerate() {
  try {
    messages.textContent = '';
    const startDate = startInput.value;
    const weeks = Math.max(1, Math.min(8, Number(weeksInput.value || 4)));
    const endDate = endInput.value || null;
    const employees = parseEmployees(employeesInput.value);

    const holidays = [...parseHolidays(holidaysInput.value)];
    const unavailable = parseUnavailable(unavailableInput.value);
    const optimization = (optLevelSelect.value || 'medium');
    const weekMode = (weekModeSelect?.value || 'calendar');
    const vacations = parseVacations(vacationsInput.value, (d) => weekKeyByMode(new Date(d), new Date(startDate), weekMode));
    const result = generateSchedule({ startDate, endDate, weeks, weekMode, employees, holidays, unavailableByName: Object.fromEntries(unavailable), vacationWeeksByName: Object.fromEntries(vacations), optimization });
    lastResult = result;
    renderSummary(result);
    renderReport(result);
    renderCalendar(result);
    exportJsonBtn.disabled = false;
    exportCsvBtn.disabled = false;

    // 경고: 불가일/휴가 이름 확인
    const names = new Set(employees.map((e) => e.name));
    const unknownUnavail = [...unavailable.keys()].filter((n) => !names.has(n));
    const unknownVacs = [...vacations.keys()].filter((n) => !names.has(n));
    const notes = [];
    if (unknownUnavail.length) notes.push(`불가일 이름 불일치: ${unknownUnavail.join(', ')}`);
    if (unknownVacs.length) notes.push(`휴가 이름 불일치: ${unknownVacs.join(', ')}`);
    messages.textContent = notes.join(' | ');
  } catch (err) {
    console.error(err);
    messages.textContent = err.message || String(err);
    exportJsonBtn.disabled = true;
    exportCsvBtn.disabled = true;
  }
}

function renderSummary(result) {
  const totalUnderfill = result.schedule.filter((d) => d.underfilled).length;
  const warn = result.warnings.length || totalUnderfill > 0;

  const lines = [];
  lines.push(`기간: ${result.startDate} ~ ${endDateOf(result)}`);
  lines.push(`근무자 수: ${result.employees.length}명`);
  lines.push(`미충원 일수: ${totalUnderfill}일`);
  lines.push(warn ? `주의: ${[...result.warnings].join(' | ') || '충원 인원 부족일 존재'}` : '검증: 제약 내에서 생성됨');

  // 인원별 통계
  const fairness = `평균 당직시간 ${result.fairness.avgDutyHours}h / 평균 총근무시간 ${result.fairness.avgTotalHours}h`;
  lines.push(fairness);

  const perDuty = result.stats
    .map((s) => `${s.name}: 당직 ${s.dutyCount}회(${s.dutyHours}h, ${signed(s.dutyHoursDelta)}h)`)    
    .join(' · ');
  lines.push(perDuty);

  const perTotal = result.stats
    .map((s) => `${s.name}: 총 ${Math.round(s.totalHours)}h(${signed(s.totalHoursDelta)}h)`)    
    .join(' · ');
  lines.push(perTotal);

  summary.innerHTML = `
    <div class="legend">시간 산식: 평일 정규 11h, 평일 당직 1명 +13h(다음날 평일 -11h), 주말/공휴일 당직 2명 각 +24h(다음날 평일 -11h). 주당 상한: 72h, 개인 총합 ≤ 72×(근무주수)</div>
    <div class="${warn ? 'warn' : 'ok'}">${lines.join(' / ')}</div>
  `;
}

function renderCalendar(result) {
  calendar.innerHTML = '';
  const start = new Date(result.startDate);
  const days = result.schedule.map((s) => new Date(s.date));

  // 주별로 테이블 생성
  const weeks = groupBy(result.schedule, (d) => d.weekKey);
  for (const [wk, items] of weeks) {
    const table = document.createElement('table');
    table.className = 'week-grid';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const weekdays = ['월', '화', '수', '목', '금', '토', '일'];
    for (const w of weekdays) {
      const th = document.createElement('th');
      th.textContent = w;
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const bodyTr = document.createElement('tr');
    const monday = new Date(wk);
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      const key = fmtDate(day);
      const cellData = items.find((x) => x.key === key);
      const td = document.createElement('td');
      td.className = 'day';
      const isWk = isWeekday(day);
      const keyStr = fmtDate(day);
      const isHol = (result.holidays || []).includes(keyStr);
      if (isHol) td.classList.add('holiday');
      else if (!isWk) td.classList.add('weekend');
      const dateEl = document.createElement('div');
      dateEl.className = 'date';
      dateEl.textContent = `${key}`;
      td.appendChild(dateEl);
      const dutiesEl = document.createElement('div');
      dutiesEl.className = 'duties';
      if (cellData) {
        for (const d of cellData.duties) {
          const chip = document.createElement('div');
          chip.className = 'duty-chip';
          chip.textContent = d.name;
          dutiesEl.appendChild(chip);
        }
        if (cellData.underfilled) {
          td.classList.add('underfill');
          if (cellData.reasons && cellData.reasons.length) {
            td.title = '미충원 사유\n' + cellData.reasons.join('\n');
          }
        }
      } else {
        // 범위 밖
        td.style.opacity = '0.3';
      }
      td.appendChild(dutiesEl);
      bodyTr.appendChild(td);
    }
    const tbody = document.createElement('tbody');
    tbody.appendChild(bodyTr);
    table.appendChild(tbody);
    calendar.appendChild(table);
  }
}

function renderReport(result) {
  report.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'report-table';
  const thead = document.createElement('thead');
  const thr = document.createElement('tr');
  const hdrs = ['이름', '선호', '당직(회)', '평일당직(회)', '주말당직(회)', '당직시간(h)', 'Δ당직(h)', '총근무시간(h)', 'Δ총(h)'];
  for (const h of hdrs) {
    const th = document.createElement('th');
    th.textContent = h;
    thr.appendChild(th);
  }
  thead.appendChild(thr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const s of result.stats) {
    const tr = document.createElement('tr');
    const cells = [
      s.name,
      (result.employees.find((e) => e.id === s.id)?.preference || 'any'),
      s.dutyCount,
      s.weekdayDutyCount,
      s.weekendDutyCount,
      s.dutyHours,
      signed(s.dutyHoursDelta),
      Math.round(s.totalHours),
      signed(s.totalHoursDelta),
    ];
    cells.forEach((val, idx) => {
      const td = document.createElement('td');
      td.textContent = String(val);
      if (idx >= 2) td.classList.add('num');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  report.appendChild(table);

  if (result.warnings && result.warnings.length) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = `경고 ${result.warnings.length}건: ` + result.warnings.join(' | ');
    report.appendChild(warn);
  }
}

function onExportJson() {
  if (!lastResult) return;
  download('duty-roster.json', JSON.stringify(lastResult, null, 2));
}

function onExportCsv() {
  if (!lastResult) return;
  const rows = [['date', 'name1', 'name2']];
  for (const d of lastResult.schedule) {
    const names = d.duties.map((x) => x.name);
    rows.push([d.key, names[0] || '', names[1] || '']);
  }
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  download('duty-roster.csv', csv);
}

function csvEscape(s) {
  const v = String(s);
  if (/[",\n]/.test(v)) return '"' + v.replaceAll('"', '""') + '"';
  return v;
}

function download(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function endDateOf(result) {
  if (result.endDate) return result.endDate;
  const start = new Date(result.startDate);
  const end = addDays(start, result.weeks * 7 - 1);
  return fmtDate(end);
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function signed(n) {
  return (n > 0 ? '+' : '') + n;
}

function parseVacations(text, weekKeyFn = (d) => weekKey(new Date(d))) {
  // 형식: 이름: YYYY-MM-DD, YYYY-MM-DD ...  (각 날짜가 속한 주 전체 휴가)
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]+)[:：](.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2];
    const dates = (rest.match(/\d{4}-\d{2}-\d{2}/g) || []).map((d) => d.trim());
    if (!map.has(name)) map.set(name, new Set());
const weekModeSelect = document.querySelector('#week-mode');
    const set = map.get(name);
    for (const d of dates) set.add(weekKeyFn(d));
  }
  return map;
}
