import { generateSchedule } from './scheduler.js';
import { fmtDate, addDays, isWeekday, rangeDays, weekKey } from './time.js';

const startInput = document.querySelector('#start-date');
const weeksInput = document.querySelector('#weeks');
const endInput = document.querySelector('#end-date');
const employeesInput = document.querySelector('#employees');
const generateBtn = document.querySelector('#generate');
const exportXlsxBtn = document.querySelector('#export-xlsx');
const exportIcsBtn = document.querySelector('#export-ics');
const messages = document.querySelector('#messages');
const summary = document.querySelector('#summary');
const report = document.querySelector('#report');
const roster = document.querySelector('#roster');
const holidaysInput = document.querySelector('#holidays');
const unavailableInput = document.querySelector('#unavailable');
const dayoffWishInput = document.querySelector('#dayoff-wish');
const vacationsInput = document.querySelector('#vacations');
const priorByungInput = document.querySelector('#prior-byung');
const priorEungInput = document.querySelector('#prior-eung');
const previousStatsUIRoot = document.querySelector('#prev-stats-ui');
const loadingOverlay = document.querySelector('#loading-overlay');
const loadingTextEl = loadingOverlay ? loadingOverlay.querySelector('.loading-text') : null;
const icsVersionInput = document.querySelector('#ics-version');
const icsPreview = document.querySelector('#ics-preview');
const hardcapToggle = document.querySelector('#role-hardcap-toggle');
let roleHardcapMode = hardcapToggle?.dataset.mode === 'relaxed' ? 'relaxed' : 'strict';
// 최적화 선택 UI 제거: 기본 strong
// 주 계산 모드 옵션 제거: 달력 기준(월–일) 고정
// 당직 슬롯 고정: 병당 1, 응당 1

// 기본값: 다음 월요일
setDefaultStartMonday();

generateBtn.addEventListener('click', onGenerate);
exportXlsxBtn?.addEventListener('click', onExportXlsx);
exportIcsBtn?.addEventListener('click', onExportIcs);
// 직원 목록 변경 시 보정 UI 갱신
employeesInput.addEventListener('input', debounce(renderPreviousStatsUI, 250));
runOnReady(renderPreviousStatsUI);
runOnReady(updateHardcapToggleLabel);
runOnReady(() => {
  // GitHub Pages 경로 자동 추정(비어있을 때만)
  try {
    if (icsVersionInput && !icsVersionInput.value) icsVersionInput.value = 'v1';
    updateIcsPreview();
  } catch {}
});
['change','input'].forEach((ev) => {
  startInput.addEventListener(ev, updateIcsPreview);
  endInput.addEventListener(ev, updateIcsPreview);
  weeksInput.addEventListener(ev, updateIcsPreview);
  icsVersionInput?.addEventListener(ev, updateIcsPreview);
});
hardcapToggle?.addEventListener('click', () => {
  setRoleHardcapMode(roleHardcapMode === 'strict' ? 'relaxed' : 'strict');
});
// 공휴일 도우미 버튼
document.querySelector('#load-kr-holidays')?.addEventListener('click', () => loadKRHolidays({ merge: true }));
document.querySelector('#clear-holidays')?.addEventListener('click', () => { holidaysInput.value = ''; });

let lastResult = null;
let scheduleSeedCounter = 0;

function nextRandomSeed() {
  try {
    if (window.crypto?.getRandomValues) {
      const arr = new Uint32Array(1);
      window.crypto.getRandomValues(arr);
      return arr[0] >>> 0;
    }
  } catch {}
  scheduleSeedCounter += 1;
  const base = Date.now() & 0xffffffff;
  const extra = Math.floor(Math.random() * 0xffffffff);
  return (base ^ extra ^ scheduleSeedCounter) >>> 0;
}

function getWeeksCount() {
  const value = Number(weeksInput.value || 4);
  if (!Number.isFinite(value)) return 4;
  return Math.max(1, Math.min(8, value));
}

function setRoleHardcapMode(mode) {
  roleHardcapMode = mode;
  updateHardcapToggleLabel();
}

function updateHardcapToggleLabel() {
  if (!hardcapToggle) return;
  const relaxed = roleHardcapMode === 'relaxed';
  hardcapToggle.dataset.mode = roleHardcapMode;
  hardcapToggle.textContent = relaxed ? '완화 모드 (±2 허용)' : '기본 (±1)';
  hardcapToggle.setAttribute('aria-pressed', relaxed ? 'true' : 'false');
}

function runOnReady(fn) {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', fn, { once: true });
  } else {
    fn();
  }
}

function setDefaultStartMonday() {
  // 오늘 기준 "다음달의 첫 월요일"로 설정
  const today = new Date();
  const firstOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  // 안전하게 while 루프로 확정(타임존/수식 혼동 방지)
  const firstMonday = new Date(firstOfNextMonth);
  firstMonday.setHours(12, 0, 0, 0); // DST/타임존 영향 최소화
  while (firstMonday.getDay() !== 1) {
    firstMonday.setDate(firstMonday.getDate() + 1);
  }
  try {
    startInput.valueAsDate = firstMonday;
  } catch {
    // Fallback to yyyy-mm-dd string
    const y = firstMonday.getFullYear();
    const m = String(firstMonday.getMonth() + 1).padStart(2, '0');
    const d = String(firstMonday.getDate()).padStart(2, '0');
    startInput.value = `${y}-${m}-${d}`;
  }
}

function parseEmployees(text) {
  // 형식: R# 이름[, 소아][, 응급]
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.map((line) => {
    const m = line.match(/^(R[1-4])\s+([^,|\t]+)(.*)$/);
    if (m) {
      const klass = m[1];
      const name = m[2].trim();
      const rest = (m[3] || '').replace(/^\s*[ ,|\t]+/, '');
      const tags = new Set(rest.split(/[ ,|\t]+/).map(s => s.trim()).filter(Boolean));
      const pediatric = tags.has('소아');
      const emergency = tags.has('응급');
      return { name, klass, pediatric, emergency, preference: 'any' };
    }
    // fallback: treat as name only
    return { name: line, klass: '', pediatric: false, emergency: false, preference: 'any' };
  });
}

function parseHolidayAddsRemoves(text) {
  const add = new Set();
  const remove = new Set();
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    const excl = /^[-!]\s*(\d{4}-\d{2}-\d{2})$/.exec(line);
    if (excl) { remove.add(excl[1]); continue; }
    const incl = /^(\d{4}-\d{2}-\d{2})$/.exec(line);
    if (incl) add.add(incl[1]);
  }
  return { add, remove };
}

function parseHolidays(text) {
  const { add, remove } = parseHolidayAddsRemoves(text);
  for (const d of remove) add.delete(d);
  return add;
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

async function onGenerate() {
  try {
    setLoading(true, '당직표 생성 중… 잠시만 기다려주세요');
    disableActions(true);
    messages.innerHTML = '';
    
    await new Promise(resolve => setTimeout(resolve, 30));

    try {
      const startDate = startInput.value;
      const weeks = getWeeksCount();
      const endDate = endInput.value || null;
      const employees = parseEmployees(employeesInput.value);
      const prev = getPreviousStatsFromUI();

      const holidays = [...parseHolidays(holidaysInput.value)];
      const dutyUnavailable = parseUnavailable(unavailableInput.value);
      const dayoffWish = parseUnavailable(dayoffWishInput?.value || '');
      const optimization = 'strong';
      const budgetMs = getTimeBudgetMsFromQuery();
      const weekMode = 'calendar';
      const weekdaySlots = 2;
      const vacations = parseVacationRanges(vacationsInput.value);
      const prior = getPriorDayDutyFromUI();

      const runSchedule = (mode, seed, r3Cap = false, r1Cap = false, hourCap = 'strict') => {
        const randomSeed = Number.isFinite(seed) ? seed : nextRandomSeed();
        const args = { startDate, endDate, weeks, weekMode, employees, holidays, dutyUnavailableByName: Object.fromEntries(dutyUnavailable), dayoffWishByName: Object.fromEntries(dayoffWish), vacationDaysByName: Object.fromEntries(vacations), priorDayDuty: prior, optimization, weekdaySlots, weekendSlots: 2, timeBudgetMs: budgetMs, roleHardcapMode: mode, prevStats: prev, randomSeed, enforceR3WeeklyCap: r3Cap, enforceR1WeeklyCap: r1Cap, weeklyHourCapMode: hourCap };
        return generateSchedule(args);
      };

      const needsUnderfillFix = (result) => result.schedule.some((day) => (day.duties?.length || 0) < 2 || day.underfilled);

      const calculateScore = (result, prev) => {
        let score = 0;
        const { byungCount, eungCount } = computeRoleAndOffCounts(result);
        const empById = new Map(result.employees.map((e) => [e.id, e]));

        for (const klass of ['R1', 'R2']) {
          const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
          if (!peopleInClass.length) continue;

          for (const role of [{ key: 'byung', countMap: byungCount }, { key: 'eung', countMap: eungCount }]) {
            const prevList = (prev.entriesByClassRole.get(klass)?.[role.key]) || [];
            const prevByName = new Map(prevList.map((e) => [e.name, Number(e.delta) || 0]));
            
            const finalCounts = peopleInClass.map((p) => ({
              id: p.id,
              name: p.name,
              count: (Number(role.countMap.get(p.id) || 0)) + (prevByName.get(p.name) || 0),
            }));

            const { deltas: finalDeltas } = computeCarryoverDeltas(finalCounts);
            
            for (const d of finalDeltas) {
              if (Math.abs(d.delta) >= 2) {
                score += 10; // Heavy penalty for ±2 deviations
              }
            }
          }
        }

        const r3NonPediatric = result.employees.filter(p => p.klass === 'R3' && !p.pediatric);
        if (r3NonPediatric.length === 2) {
          const p1 = r3NonPediatric[0];
          const p2 = r3NonPediatric[1];
          score += Math.abs((byungCount.get(p1.id) || 0) - (byungCount.get(p2.id) || 0));
          score += Math.abs((eungCount.get(p1.id) || 0) - (eungCount.get(p2.id) || 0));
        }
        
        score += countHardExceed(result, 75) * 100; // Very heavy penalty
        return score;
      };

      const r1s = employees.filter(e => e.klass === 'R1');
      let anyR1HasVacation = false;
      if (r1s.length > 0) {
          const scheduleDays = rangeDays(new Date(startDate), weeks * 7).map(d => fmtDate(d));
          for (const r1 of r1s) {
              const r1Vacations = vacations.get(r1.name) || new Set();
              for (const vacDay of r1Vacations) {
                  if (scheduleDays.has(vacDay)) {
                      anyR1HasVacation = true;
                      break;
                  }
              }
              if (anyR1HasVacation) break;
          }
      }

      const r3s = employees.filter(e => e.klass === 'R3');
      let anyR3HasVacation = false;
      if (r3s.length > 0) {
          const scheduleDays = rangeDays(new Date(startDate), weeks * 7).map(d => fmtDate(d));
          for (const r3 of r3s) {
              const r3Vacations = vacations.get(r3.name) || new Set();
              for (const vacDay of r3Vacations) {
                  if (scheduleDays.has(vacDay)) {
                      anyR3HasVacation = true;
                      break;
                  }
              }
              if (anyR3HasVacation) break;
          }
      }

      let bestResult = null;
      const initialR1Cap = !anyR1HasVacation;
      const initialR3Cap = !anyR3HasVacation;

      // --- Constraint Dropping Architecture ---

      // Attempt 1: All constraints are applied
      try {
        appendMessage('1단계 시도: 모든 규칙을 적용하여 생성합니다...');
        bestResult = runSchedule(roleHardcapMode, undefined, initialR3Cap, initialR1Cap, 'strict');
        appendMessage('성공: 모든 규칙을 만족하는 스케줄을 찾았습니다.');
      } catch (e) {
        console.warn('Constraint dropping step 1 failed. All constraints were applied.', e);
        appendMessage('1단계 실패. 2단계: R1 주간 당직 제한을 완화하여 재시도합니다...');
        
        // Attempt 2: Drop R1 weekly cap
        try {
          bestResult = runSchedule(roleHardcapMode, undefined, initialR3Cap, false, 'strict'); // enforceR1WeeklyCap = false
          appendMessage('R1 주간 당직 2회 제한 규칙을 포기했습니다 😥');
        } catch (e2) {
          console.warn('Constraint dropping step 2 failed. R1 weekly cap was dropped.', e2);
          appendMessage('2단계 실패. 3단계: 주간 근무 시간 제한을 완화하여 재시도합니다...');

          // Attempt 3: Drop R1 cap AND weekly hour cap
          try {
            bestResult = runSchedule(roleHardcapMode, undefined, initialR3Cap, false, 'none'); // weeklyHourCapMode = 'none'
            appendMessage('기본 주간 근무 시간(72시간) 제한을 완화했습니다 (최대 80시간 적용) 😥');
          } catch (e3) {
            console.error('Constraint dropping step 3 failed. All constraints were relaxed.', e3);
            appendMessage('최종 실패: 모든 제약을 완화해도 해를 찾을 수 없습니다. 입력값을 확인해주세요.');
            throw e3; // Re-throw the final error to be caught by the outer handler
          }
        }
      }

      lastResult = bestResult;
      renderSummary(bestResult);
      renderReport(bestResult, { previous: prev });
      renderRoster(bestResult);
      if (exportXlsxBtn) exportXlsxBtn.disabled = false;
      if (exportIcsBtn) exportIcsBtn.disabled = false;

      const finalSoftExceeds = countSoftExceed(bestResult, 72);
      if (finalSoftExceeds > 0) {
        const warnMsg = `주의: 일부 주의 72h 초과가 해소되지 않았습니다 (셀 ${finalSoftExceeds}개). 설정을 조정하거나 인원을 늘려주세요.`;
        appendMessage(warnMsg);
      }

      const names = new Set(employees.map((e) => e.name));
      const unknownUnavail = [...dutyUnavailable.keys()].filter((n) => !names.has(n));
      const unknownDayoff = [...dayoffWish.keys()].filter((n) => !names.has(n));
      const unknownVacs = [...vacations.keys()].filter((n) => !names.has(n));
      const priorNames = [prior.byung, prior.eung].filter(Boolean);
      const unknownPrior = priorNames.filter((n) => !names.has(n));
      const notes = [];
      if (unknownUnavail.length) notes.push(`당직 불가일 이름 불일치: ${unknownUnavail.join(', ')}`);
      if (unknownDayoff.length) notes.push(`Day-off 희망일 이름 불일치: ${unknownDayoff.join(', ')}`);
      if (unknownVacs.length) notes.push(`휴가 이름 불일치: ${unknownVacs.join(', ')}`);
      if (unknownPrior.length) notes.push(`전일 당직 이름 불일치: ${unknownPrior.join(', ')}`);
      notes.forEach((msg) => appendMessage(msg));

    } catch (err) {
      console.error(err);
      messages.textContent = err.message || String(err);
      if (exportXlsxBtn) exportXlsxBtn.disabled = true;
      if (exportIcsBtn) exportIcsBtn.disabled = true;
    } finally {
      setLoading(false);
      disableActions(false);
    }
  } catch (err) {
    console.error(err);
    messages.textContent = err.message || String(err);
    setLoading(false);
    disableActions(false);
    if (exportXlsxBtn) exportXlsxBtn.disabled = true;
    if (exportIcsBtn) exportIcsBtn.disabled = true;
  }
}

function renderSummary(result) {
  // 미충원(underfill) 표기는 숨기고, 경고만 표시
  const warn = result.warnings.length > 0;

  const lines = [];
  lines.push(`기간: ${result.startDate} ~ ${endDateOf(result)}`);
  lines.push(`근무자 수: ${result.employees.length}명`);
  const back = result.employees.find((e) => e.emergency) || result.schedule.find((d) => d.back)?.back;
  if (back) lines.push(`응급 back: ${back.name || back}`);
  lines.push(warn ? `주의: ${[...result.warnings].join(' | ') || '검토 필요한 항목 존재'}` : '검증: 제약 내에서 생성됨');

  // 상세 비교는 개인별 통계 테이블에서 연차 내 기준으로 확인

  const wkdaySlots = result?.config?.weekdaySlots ?? 1;
  const wkendSlots = result?.config?.weekendSlots ?? 2;
  summary.innerHTML = `
    <div class="legend">시간 산식(개정): 평일 정규 8h(2명), 평일 당직 ${wkdaySlots}명(당일 총 21.5h = 정규 8 + 당직 13.5, 휴게 2.5), 주말/공휴일 당직 ${wkendSlots}명(각 21h). 평일 당직 다음날 정규 면제. 주당 상한: 72h, 개인 총합 ≤ 72×(근무주수)</div>
    <div class="${warn ? 'warn' : 'ok'}">${lines.join(' / ')}${result?.meta?.elapsedMs ? ` / 최적화 ${result.meta.elapsedMs}ms` : ''}</div>
  `;
}

function renderRoster(result) {
  roster.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'report-table';
  const thead = document.createElement('thead');
  const thr = document.createElement('tr');
  const hdrs = ['날짜', '병당', '응당', '응급 back'];
  for (const h of hdrs) {
    const th = document.createElement('th'); th.textContent = h; thr.appendChild(th);
  }
  thead.appendChild(thr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const empById = new Map(result.employees.map((e) => [e.id, e]));
  for (const s of result.schedule) {
    const tr = document.createElement('tr');
    // weekend/holiday highlighting
    const d = new Date(s.date);
    const key = fmtDate(d);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) tr.classList.add('weekend');
    if ((result.holidays || []).includes(key)) tr.classList.add('holiday');
    const cells = [];
    // 날짜
    cells.push(s.key);
    // 병당/응당
    for (let i = 0; i < 2; i += 1) {
      const duty = s.duties[i];
      if (duty) {
        const emp = empById.get(duty.id) || {};
        const span = document.createElement('span');
        const tag = document.createElement('span');
        tag.className = `tag ${emp.klass || ''}`; tag.textContent = emp.klass || '';
        span.className = 'name'; span.textContent = duty.name;
        const container = document.createElement('div');
        container.appendChild(tag); container.appendChild(span);
        cells.push(container);
      } else {
        cells.push('');
      }
    }
    // back
    if (s.back) {
      const emp = empById.get(s.back.id) || {};
      const tag = document.createElement('span'); tag.className = `tag ${emp.klass || ''}`; tag.textContent = emp.klass || '';
      const span = document.createElement('span'); span.className = 'name'; span.textContent = s.back.name;
      const container = document.createElement('div'); container.appendChild(tag); container.appendChild(span);
      cells.push(container);
    } else {
      cells.push('');
    }

    cells.forEach((val) => {
      const td = document.createElement('td');
      if (val instanceof HTMLElement) td.appendChild(val); else td.textContent = String(val);
      tr.appendChild(td);
    });
    if (s.underfilled) tr.classList.add('underfill');
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  roster.appendChild(table);
}

function renderReport(result, opts = {}) {
  report.innerHTML = '';
  // Back banner
  const backEmp = result.employees.find((e) => e.emergency) || null;
  if (backEmp) {
    const bn = document.createElement('div');
    bn.className = 'banner';
    bn.textContent = `응급 back: ${backEmp.name} (R연차=${backEmp.klass || '-'})`;
    report.appendChild(bn);
  }
  // 전체 연차(전원) 단일 테이블은 제거

  if (result.warnings && result.warnings.length) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = `경고 ${result.warnings.length}건: ` + result.warnings.join(' | ');
    report.appendChild(warn);
  }

  // 주별 시간 통계 테이블
  renderWeeklyHours(result);

  // 개인별 수련시간/데이오프 통계
  renderPersonalStats(result);

  // carry-over 통계 (stat-to-pass)
  renderCarryoverStats(result, opts);
}

// onExportJson / onExportCsv 제거(미사용)

function onExportXlsx() {
  if (!lastResult) return;
  const summaryRows = [];
  // Roster section
  summaryRows.push([ { v: '당직표', style: 'Header' } ]);
  summaryRows.push([]);
  summaryRows.push([ { v: '날짜', style: 'Header' }, { v: '병당', style: 'Header' }, { v: '응당', style: 'Header' }, { v: '응급 back', style: 'Header' } ]);
  const holidaySet = new Set(lastResult.holidays || []);
  for (const d of lastResult.schedule) {
    const names = d.duties.map((x) => x.name);
    const dt = new Date(d.date);
    const key = fmtDate(dt);
    const wd = dt.getDay();
    const isWeekend = (wd === 0 || wd === 6);
    const isHoliday = holidaySet.has(key);
    const rowStyle = isHoliday ? 'Holiday' : (isWeekend ? 'Weekend' : null);
    summaryRows.push([
      { v: d.key, style: d.underfilled && !rowStyle ? 'Underfill' : (rowStyle || undefined) },
      { v: names[0] || '', style: rowStyle || undefined },
      { v: names[1] || '', style: rowStyle || undefined },
      { v: d.back?.name || '', style: rowStyle || undefined },
    ]);
  }
  // 다음달 반영 section
  const prev = getPreviousStatsFromUI();
  const carryRows = buildCarryoverRows(lastResult, prev);
  summaryRows.push([]);
  summaryRows.push([ { v: '다음달 반영', style: 'Header' } ]);
  for (const r of carryRows) summaryRows.push(r);
  // 지난달 반영 section
  const prevRows = buildPreviousAdjustRows(lastResult, prev);
  summaryRows.push([]);
  summaryRows.push([ { v: '지난달 반영', style: 'Header' } ]);
  for (const r of prevRows) summaryRows.push(r);

  // ICS Links separate sheet
  const linksRows = [ [ { v: '이름', style: 'Header' }, { v: 'ICS', style: 'Header' } ] ];
  const base = getComputedIcsBase();
  const monthKey = monthKeyFromResult(lastResult) || dominantMonthKey();
  const version = (icsVersionInput?.value || '').trim() || 'v1';
  linksRows.push([ { v: '월', style: 'Header' }, monthKey || '-' ]);
  linksRows.push([ { v: '버전', style: 'Header' }, version ]);
  linksRows.push([ { v: '기본 경로', style: 'Header' }, base || '미설정(링크 비활성)' ]);
  for (const e of lastResult.employees) {
    if (!hasDutiesFor(lastResult, e.name)) continue;
    let cell = { v: '설정 필요' };
    if (base) {
      const fname = safePersonFilename(e.name) + '.ics';
      const href = joinUrl(base, encodeURIComponent(fname));
      cell = { v: `${e.name}.ics`, href };
    }
    linksRows.push([ e.name, cell ]);
  }
  const xml = buildSpreadsheetXML([
    { name: 'Summary', rows: summaryRows },
    { name: 'ICS Links', rows: linksRows },
  ]);
  const fileMonth = monthKey || (lastResult.startDate || '').slice(0,7) || 'YYYY-MM';
  const verSafe = String(version).replace(/[^\w\-\.]+/g, '_');
  download(`duty-roster-${fileMonth}-${verSafe}.xls`, xml);
}

function onExportIcs() {
  if (!lastResult) return;
  const emps = lastResult.employees || [];
  const files = [];
  for (const e of emps) {
    const name = e.name;
    if (!hasDutiesFor(lastResult, name)) continue; // 당직 없음 스킵
    const icsText = buildICS(lastResult, { nameFilter: name, includeBack: false });
    const bytes = new TextEncoder().encode(icsText);
    const fname = safePersonFilename(name);
    files.push({ name: `${fname}.ics`, bytes });
  }
  if (files.length === 0) return;
  const zip = buildZip(files);
  const monthKey = dominantMonthKey() || (lastResult.startDate || '').slice(0,7) || 'YYYY-MM';
  const version = (icsVersionInput?.value || 'v1');
  const verSafe = String(version).replace(/[^\w\-\.]+/g, '_');
  download(`duty-roster-${monthKey}-${verSafe}.zip`, zip);
}

// csvEscape 제거(미사용)

function download(filename, content) {
  const isXls = filename.toLowerCase().endsWith('.xls');
  const isIcs = filename.toLowerCase().endsWith('.ics');
  const isZip = filename.toLowerCase().endsWith('.zip');
  const type = isXls
    ? 'application/vnd.ms-excel;charset=utf-8'
    : (isIcs ? 'text/calendar;charset=utf-8' : (isZip ? 'application/zip' : 'text/plain;charset=utf-8'));
  const blob = new Blob([content instanceof Uint8Array ? content : String(content)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function base64Utf8(str) {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    // Fallback using TextEncoder
    const bytes = new TextEncoder().encode(str);
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
}

function sanitizeFilename(s) {
  return String(s).replace(/[^\w\-\.가-힣]+/g, '_');
}

function xmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildSpreadsheetXML(sheets) {
  const header = `<?xml version="1.0"?>\n<?mso-application progid=\"Excel.Sheet\"?>\n<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:x=\"urn:schemas-microsoft-com:office:excel\" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">`;
  const styles = `
    <Styles>
      <Style ss:ID="Header"><Font ss:Bold="1"/><Alignment ss:Horizontal="Center"/></Style>
      <Style ss:ID="Weekend"><Interior ss:Color="#E8F6FF" ss:Pattern="Solid"/></Style>
      <Style ss:ID="Holiday"><Interior ss:Color="#FFF6D5" ss:Pattern="Solid"/></Style>
      <Style ss:ID="Underfill"><Interior ss:Color="#FDE2E2" ss:Pattern="Solid"/></Style>
      <Style ss:ID="Pos"><Font ss:Color="#22C55E"/></Style>
      <Style ss:ID="Neg"><Font ss:Color="#EF4444"/></Style>
    </Styles>`;
  const tail = '</Workbook>';
  const ws = sheets.map((sh) => sheetXML(sh.name, sh.rows)).join('');
  return header + styles + ws + tail;
}

function sheetXML(name, rows) {
  const safe = xmlEscape(name || 'Sheet1');
  const rs = rows.map((r) => {
    const cells = r.map((cell) => {
      const obj = (cell && typeof cell === 'object' && 'v' in cell) ? cell : { v: cell };
      const sid = obj.style ? ` ss:StyleID=\"${xmlEscape(obj.style)}\"` : '';
      const href = obj.href ? ` ss:HRef=\"${xmlEscape(obj.href)}\"` : '';
      return `<Cell${sid}${href}><Data ss:Type=\"String\">${xmlEscape(obj.v ?? '')}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');
  return `<Worksheet ss:Name=\"${safe}\"><Table>${rs}</Table></Worksheet>`;
}

function guessIcsBaseURL(result) {
  try {
    const origin = window.location.origin;
    const host = window.location.hostname || '';
    const path = window.location.pathname || '';
    const isGh = /github\.io$/.test(host);
    const yymm = (result?.startDate || '').slice(0, 7) || '';
    if (isGh) return `${origin}/psy_duty/ics/${yymm}/`;
    if (path.includes('/psy_duty/')) return `${origin}/psy_duty/ics/${yymm}/`;
  } catch {}
  return '';
}

function joinUrl(base, path) {
  const b = base.endsWith('/') ? base : base + '/';
  return b + (path.startsWith('/') ? path.slice(1) : path);
}

function getComputedIcsBase() {
  try {
    const url = new URL(window.location.href);
    const override = url.searchParams.get('ics_base');
    if (override) return override;
  } catch {}
  const version = (icsVersionInput?.value || '').trim();
  if (!version) return '';
  const monthKey = dominantMonthKey();
  if (!monthKey) return '';
  const origin = window.location.origin;
  // Assume repository path is /psy_duty/
  return `${origin}/psy_duty/ics/${monthKey}/${version}/`;
}

function dominantMonthKey() {
  try {
    const range = currentDateRange();
    if (!range) return '';
    const counts = new Map();
    for (let d = new Date(range.start); d <= range.end; d = addDays(d, 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = ''; let max = -1;
    for (const [k, v] of counts) { if (v > max) { max = v; best = k; } }
    return best;
  } catch { return ''; }
}

function updateIcsPreview() {
  try {
    const base = getComputedIcsBase();
    if (icsPreview) icsPreview.textContent = base || '시작/종료일과 버전으로 자동 계산됩니다.';
  } catch {}
}

function buildICS(result, opts = {}) {
  const nameFilter = (opts && opts.nameFilter) || null;
  const includeBack = !!(opts && opts.includeBack);
  const lines = [];
  const now = new Date();
  const dtstamp = icsDateTimeUTC(now);
  const calName = nameFilter ? `Psy Duty (${nameFilter})` : 'Psy Duty Roster';
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('PRODID:-//psy_duty//Duty Roster//KO');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:' + icsText(calName));

  const holidaySet = new Set(result.holidays || []);
  const pushEvent = (dateObj, title, uidSeed, description = '') => {
    const d0 = icsDate(dateObj);
    const d1 = icsDate(addDays(dateObj, 1)); // all-day end exclusive
    const uid = `${uidSeed}@psy_duty`;
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + uid);
    lines.push('DTSTAMP:' + dtstamp);
    lines.push('DTSTART;VALUE=DATE:' + d0);
    lines.push('DTEND;VALUE=DATE:' + d1);
    lines.push('SUMMARY:' + icsText(title));
    if (description) lines.push('DESCRIPTION:' + icsText(description));
    lines.push('END:VEVENT');
  };

  for (const day of result.schedule) {
    const dateObj = new Date(day.date);
    const key = fmtDate(dateObj);
    const isHoliday = holidaySet.has(key);
    const wd = dateObj.getDay();
    const isWeekend = (wd === 0 || wd === 6);
    const dayNote = isHoliday ? '공휴일' : (isWeekend ? '주말' : '평일');
    const roles = ['병당', '응당'];
    // Duties
    for (let i = 0; i < (day.duties || []).length; i += 1) {
      const duty = day.duties[i];
      if (!duty) continue;
      if (nameFilter && duty.name !== nameFilter) continue;
      const role = roles[i] || `슬롯${i + 1}`;
      const title = `${role} - ${duty.name}`;
      const desc = `${key} ${dayNote}`;
      const roleKey = i === 0 ? 'B' : 'E';
      const nameHash = (crc32(new TextEncoder().encode(duty.name)) >>> 0).toString(16);
      pushEvent(dateObj, title, `duty-${key}-${roleKey}-${nameHash}`, desc);
    }
    // Emergency back (옵션) — 기본적으로 미포함
    if (includeBack && day.back) {
      if (!nameFilter || day.back.name === nameFilter) {
        const title = `응급 back - ${day.back.name}`;
        const desc = `${key} ${dayNote}`;
        pushEvent(dateObj, title, `back-${key}-${day.back.id}`, desc);
      }
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function icsDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

function icsDateTimeUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}

function icsText(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function hasDutiesFor(result, name) {
  for (const day of result.schedule || []) {
    const duties = day.duties || [];
    for (const d of duties) { if (d && d.name === name) return true; }
  }
  return false;
}

function safePersonFilename(name) {
  // 최소한의 안전 처리: 경로 구분자만 제거
  return String(name).replace(/[\\/]+/g, '_');
}

// ZIP(Stored) 최소 구현: UTF-8 파일명, 무압축
function buildZip(files) {
  // files: [{ name: string, bytes: Uint8Array }]
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = toDosTime(now);
  const dosDate = toDosDate(now);

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const data = f.bytes;
    const crc = crc32(data);
    const localHeader = [];
    pushU32(localHeader, 0x04034b50);
    pushU16(localHeader, 20);            // version needed to extract
    pushU16(localHeader, 0x0800);        // general purpose bit flag (UTF-8)
    pushU16(localHeader, 0);             // compression method (0=store)
    pushU16(localHeader, dosTime);
    pushU16(localHeader, dosDate);
    pushU32(localHeader, crc >>> 0);
    pushU32(localHeader, data.length >>> 0);
    pushU32(localHeader, data.length >>> 0);
    pushU16(localHeader, nameBytes.length);
    pushU16(localHeader, 0);             // extra length
    const local = concatBytes(new Uint8Array(localHeader), nameBytes, data);
    chunks.push(local);

    // central directory header
    const cd = [];
    pushU32(cd, 0x02014b50);
    pushU16(cd, 20);        // version made by
    pushU16(cd, 20);        // version needed
    pushU16(cd, 0x0800);    // UTF-8
    pushU16(cd, 0);         // method
    pushU16(cd, dosTime);
    pushU16(cd, dosDate);
    pushU32(cd, crc >>> 0);
    pushU32(cd, data.length >>> 0);
    pushU32(cd, data.length >>> 0);
    pushU16(cd, nameBytes.length);
    pushU16(cd, 0);         // extra length
    pushU16(cd, 0);         // comment length
    pushU16(cd, 0);         // disk number start
    pushU16(cd, 0);         // internal attrs
    pushU32(cd, 0);         // external attrs
    pushU32(cd, offset >>> 0);
    const cdr = concatBytes(new Uint8Array(cd), nameBytes);
    central.push(cdr);

    offset += local.length;
  }

  const centralDir = concatBytes(...central);
  const eocd = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0); // disk
  pushU16(eocd, 0); // disk
  pushU16(eocd, files.length); // entries on this disk
  pushU16(eocd, files.length); // total entries
  pushU32(eocd, centralDir.length);
  pushU32(eocd, offset);
  pushU16(eocd, 0); // comment length
  const tail = new Uint8Array(eocd);

  return concatBytes(...chunks, centralDir, tail);
}

function toDosTime(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  const s = Math.floor(date.getSeconds() / 2);
  return ((h & 0x1f) << 11) | ((m & 0x3f) << 5) | (s & 0x1f);
}
function toDosDate(date) {
  const y = date.getFullYear() - 1980;
  const mo = date.getMonth() + 1;
  const d = date.getDate();
  return ((y & 0x7f) << 9) | ((mo & 0x0f) << 5) | (d & 0x1f);
}

function pushU16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
function pushU32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

function concatBytes(...parts) {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

let _crcTable;
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}
function crc32(bytes) {
  if (!_crcTable) _crcTable = makeCrcTable();
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i++) c = (_crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ -1) >>> 0;
}

function buildCarryoverRows(result, prev) {
  const rows = [[ { v: '연차', style: 'Header' }, { v: '항목', style: 'Header' }, { v: '이름', style: 'Header' }, { v: '보정치', style: 'Header' } ]];
  const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);
  const empById = new Map(result.employees.map((e) => [e.id, e]));

  const order = ['R1','R2','R3','R4','기타'];
  for (const klass of order) {
    if (!empById.size) continue;
    const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
    if (!peopleInClass.length) continue;

    const roles = [
      { key: 'byung', name: '병당', countMap: byungCount },
      { key: 'eung', name: '응당', countMap: eungCount },
      { key: 'off', name: 'Day-off', countMap: dayOff },
    ];

    for (const role of roles) {
      const prevList = (prev.entriesByClassRole.get(klass)?.[role.key]) || [];
      const prevByName = new Map(prevList.map((e) => [e.name, Number(e.delta) || 0]));

      const finalCounts = peopleInClass.map((p) => ({
        id: p.id,
        name: p.name,
        count: (Number(role.countMap.get(p.id) || 0)) + (prevByName.get(p.name) || 0),
      }));

      const { deltas: finalDeltas } = computeCarryoverDeltas(finalCounts);

      if (finalDeltas.length === 0) {
        rows.push([klass, role.name, '-', '-']);
      } else {
        for (const d of finalDeltas) {
          rows.push([ klass, role.name, d.name, { v: signed(d.delta), style: d.delta > 0 ? 'Pos' : 'Neg' } ]);
        }
      }
    }
    rows.push(['','','','']);
  }
  return rows;
}

function buildPreviousAdjustRows(result, prev) {
  const rows = [[ { v: '연차', style: 'Header' }, { v: '항목', style: 'Header' }, { v: '이름', style: 'Header' }, { v: '보정치', style: 'Header' } ]];
  const entriesBy = prev.entriesByClassRole || new Map();
  const order = ['R1','R2','R3','R4','기타'];
  for (const klass of order) {
    const rec = entriesBy.get(klass);
    if (!rec) continue;
    const sections = [ ['byung','병당'], ['eung','응당'], ['off','Day-off'] ];
    for (const [key, label] of sections) {
      const list = rec[key] || [];
      if (list.length === 0) continue;
      for (const e of list) {
        rows.push([ klass, label, e.name, signed(Number(e.delta) || 0) ]);
      }
    }
    rows.push(['','','','']);
  }
  return rows;
}

function computeCarryoverDeltas(entries) {
  const diagnostics = isDiagnosticsEnabled();
  if (diagnostics) {
    console.log('[computeCarryoverDeltas] entries:', JSON.parse(JSON.stringify(entries)));
  }
  if (!entries.length) return { deltas: [], base: 0 };
  const counts = entries.map(e => e.count);
  let base = counts[0] || 0;

  if (counts.length > 1) {
    const freq = new Map();
    counts.forEach(c => freq.set(c, (freq.get(c) || 0) + 1));

    let maxFreq = 0;
    let modes = [];
    freq.forEach((f, val) => {
      if (f > maxFreq) {
        maxFreq = f;
        modes = [val];
      } else if (f === maxFreq) {
        modes.push(val);
      }
    });

    if (modes.length === 1 && maxFreq > 1) {
      base = modes[0];
    } else {
      const sorted = [...counts].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      base = sorted.length % 2 === 0 ? sorted[mid - 1] : sorted[mid];
    }
  }
  if (diagnostics) {
    console.log(`[computeCarryoverDeltas] calculated base=${base}`);
  }

  const deltas = entries.map(e => ({
    name: e.name,
    id: e.id,
    delta: e.count - base,
  }))
  .filter(d => d.delta !== 0)
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.delta - a.delta);

  if (diagnostics) {
    console.log('[computeCarryoverDeltas] final deltas:', JSON.parse(JSON.stringify(deltas)));
  }

  return { deltas, base };
}

// 중앙값 기준 signed(−/0/+): delta = count − median
function monthKeyFromResult(result) {
  try {
    const counts = new Map();
    for (const d of result.schedule || []) {
      const dt = new Date(d.date);
      const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = ''; let max = -1;
    for (const [k, v] of counts) { if (v > max) { max = v; best = k; } }
    return best;
  } catch { return ''; }
}

function endDateOf(result) {
  if (result.endDate) return result.endDate;
  const start = new Date(result.startDate);
  const end = addDays(start, result.weeks * 7 - 1);
  return fmtDate(end);
}

function getTimeBudgetMsFromQuery() {
  try {
    const qs = new URLSearchParams(window.location.search);
    const v = Number(qs.get('budget'));
    if (Number.isFinite(v) && v > 200 && v < 30000) return Math.floor(v);
  } catch {}
  return 5000; // default 5s to strengthen in-class balancing
}

function signed(n) {
  return (n > 0 ? '+' : '') + n;
}

function appendMessage(msg) {
  if (!msg) return;
  messages.innerHTML = messages.innerHTML ? `${messages.innerHTML}<br>${msg}` : msg;
}

function isDiagnosticsEnabled() {
  try {
    return !!document.getElementById('toggle-diagnostics')?.checked;
  } catch {
    return false;
  }
}

function countSoftExceed(result, limit = 72) {
  try {
    let cnt = 0;
    for (const s of result.stats || []) {
      for (const wk of Object.keys(s.weeklyHours || {})) {
        if ((s.weeklyHours[wk] || 0) > limit + 1e-9) cnt += 1;
      }
    }
    return cnt;
  } catch { return 0; }
}

function countHardExceed(result, limit = 75) {
  try {
    let cnt = 0;
    for (const s of result.stats || []) {
      for (const wk of Object.keys(s.weeklyHours || {})) {
        if ((s.weeklyHours[wk] || 0) > limit + 1e-9) cnt += 1;
      }
    }
    return cnt;
  } catch { return 0; }
}

function parseVacationRanges(text) {
  // 형식: 이름: YYYY-MM-DD~YYYY-MM-DD[, YYYY-MM-DD~YYYY-MM-DD]
  // 단일 날짜도 허용: YYYY-MM-DD (그 하루만 제외)
  const map = new Map();
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([^:：]+)[:：](.+)$/);
    if (!m) continue;
    const name = m[1].trim();
    const rest = m[2];
    const ranges = rest.split(/[ ,|\t]+/).filter(Boolean);
    if (!map.has(name)) map.set(name, new Set());
    const set = map.get(name);
    for (const token of ranges) {
      const mm = token.match(/^(\d{4}-\d{2}-\d{2})\s*[~\-–—]?\s*(\d{4}-\d{2}-\d{2})?$/);
      if (!mm) continue;
      const s = new Date(mm[1]);
      const e = mm[2] ? new Date(mm[2]) : new Date(mm[1]);
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) continue;
      const start = s < e ? s : e;
      const end = s < e ? e : s;
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        set.add(fmtDate(d));
      }
    }
  }
  return map;
}

function getPriorDayDutyFromUI() {
  const byung = (priorByungInput?.value || '').trim();
  const eung = (priorEungInput?.value || '').trim();
  return { byung, eung };
}

function renderWeeklyHours(result) {
  // 주 키 수집 및 정렬
  const weekKeysSet = new Set();
  for (const s of result.stats) {
    for (const wk of Object.keys(s.weeklyHours || {})) weekKeysSet.add(wk);
  }
  const weekKeys = [...weekKeysSet].sort();
  if (!weekKeys.length) return;

  const wrap = document.createElement('div');
  wrap.className = 'weekly-report section-card';
  const title = document.createElement('div');
  title.className = 'legend title';
  title.textContent = '주별 시간 통계 (연차 내)';
  wrap.appendChild(title);

  const empById = new Map(result.employees.map((e) => [e.id, e]));
  const groups = new Map();
  for (const s of result.stats) {
    const emp = empById.get(s.id) || {};
    const k = emp.klass || '기타';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const order = ['R1','R2','R3','R4','기타'];
  for (const klass of order) {
    if (!groups.has(klass)) continue;
    const header = document.createElement('div');
    header.className = 'legend';
    header.textContent = `연차: ${klass}`;
    wrap.appendChild(header);

    const table = document.createElement('table');
    table.className = 'report-table';
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    const headers = ['이름', ...weekKeys, '합계'];
    for (const h of headers) { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); }
    thead.appendChild(thr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const s of groups.get(klass)) {
      const tr = document.createElement('tr');
      const total = (s.totalHours).toFixed(1);
      const values = weekKeys.map((wk) => (s.weeklyHours[wk] || 0));
      const cells = [s.name, ...values.map((v) => v.toFixed(1)), total];
      cells.forEach((val, idx) => {
        const td = document.createElement('td');
        td.textContent = String(val);
        if (idx >= 1) td.classList.add('num');
        // 주별 시간 셀 스타일링: <72 무색, ==72 약하게, >72 하이라이트
        if (idx >= 1 && idx <= weekKeys.length) {
          const v = values[idx - 1] || 0;
          if (v > 72 + 1e-9) td.classList.add('wk-over');
          else if (Math.abs(v - 72) <= 1e-9) td.classList.add('wk-soft');
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }
  report.appendChild(wrap);
}

// 보조: 로딩 오버레이/버튼 상태
function setLoading(flag, text) {
  if (!loadingOverlay) return;
  if (typeof text === 'string' && loadingTextEl) loadingTextEl.textContent = text;
  if (flag) loadingOverlay.classList.add('show'); else loadingOverlay.classList.remove('show');
}
function disableActions(flag) {
  const disabled = !!flag;
  generateBtn.disabled = disabled;
  // Export buttons follow disabled flag; if not disabled, enable only when result exists
  if (exportXlsxBtn) exportXlsxBtn.disabled = disabled || !lastResult;
  if (exportIcsBtn) exportIcsBtn.disabled = disabled || !lastResult;
}

// carry-over 계산/렌더링
function renderCarryoverStats(result, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'weekly-report carryover-section';
  const title = document.createElement('div');
  title.className = 'legend title';
  title.textContent = '다음달 반영';
  wrap.appendChild(title);

  const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);
  const prev = opts.previous || { sumByClassRole: new Map(), entriesByClassRole: new Map(), entries: [] };
  const empById = new Map(result.employees.map((e) => [e.id, e]));

  const order = ['R1','R2','R3','R4','기타'];
  for (const klass of order) {
    const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
    if (!peopleInClass.length) continue;

    const header = document.createElement('div');
    header.className = 'legend';
    header.textContent = `연차: ${klass}`;
    wrap.appendChild(header);

    const table = document.createElement('table');
    table.className = 'report-table';
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    for (const h of ['항목', '보정치']) { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); }
    thead.appendChild(thr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');

    const roles = [
      { key: 'byung', name: '병당', countMap: byungCount },
      { key: 'eung', name: '응당', countMap: eungCount },
      { key: 'off', name: 'Day-off', countMap: dayOff },
    ];

    for (const role of roles) {
      const prevList = (prev.entriesByClassRole.get(klass)?.[role.key]) || [];
      const prevByName = new Map(prevList.map((e) => [e.name, Number(e.delta) || 0]));
      
      // 1. Create "Final Count" by adding previous delta to current raw count
      const finalCounts = peopleInClass.map((p) => ({
        id: p.id,
        name: p.name,
        count: (Number(role.countMap.get(p.id) || 0)) + (prevByName.get(p.name) || 0),
      }));

      // 2. Calculate new base and deltas from the "Final Count"
      const { deltas: finalDeltas, base: calculatedBase } = computeCarryoverDeltas(finalCounts);

      const tr = document.createElement('tr');
      const labelTd = document.createElement('td');
      labelTd.textContent = role.name;
      tr.appendChild(labelTd);

      const valueTd = document.createElement('td');
      const showDiagnostics = isDiagnosticsEnabled();
      const deltaStr = finalDeltas.length ? finalDeltas.map((d) => `${d.name} ${signed(d.delta)}`).join(' · ') : '-';

      if (showDiagnostics) {
        const countsStr = `Final Counts: ${finalCounts.map(c => c.count).join(',')}`;
        const baseStr = `Base: ${calculatedBase}`;
        valueTd.textContent = `(${countsStr} / ${baseStr}) -> ${deltaStr}`;
      } else {
        valueTd.textContent = deltaStr;
      }
      tr.appendChild(valueTd);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  const showDiagnostics = isDiagnosticsEnabled();
  if (showDiagnostics) {
    const diag = document.createElement('pre');
    diag.style.background = '#111';
    diag.style.color = '#ffa';
    diag.style.padding = '8px';
    diag.style.marginTop = '8px';
    diag.textContent = `DIAGNOSTIC (Carry-over):\nEungCount Map: ${JSON.stringify([...eungCount.entries()])}`;
    wrap.appendChild(diag);
  }

  report.appendChild(wrap);
}

function computeRoleAndOffCounts(result) {
  const byungCount = new Map();
  const eungCount = new Map();
  const dayOff = new Map();
  const holidays = new Set(result.holidays || []);

  const isWorkdayLocal = (date) => {
    const d = new Date(date);
    const key = fmtDate(d);
    const wd = d.getDay();
    return wd >= 1 && wd <= 5 && !holidays.has(key);
  };

  // Fix: Account for prior day duty causing a day-off on the first day
  if (result.schedule.length > 0) {
    const firstDay = result.schedule[0];
    if (isWorkdayLocal(firstDay.date)) {
      const priorDutyNames = new Set([result.config.priorDayDuty?.byung, result.config.priorDayDuty?.eung].filter(Boolean));
      if (priorDutyNames.size > 0) {
        const priorDutyPeople = result.employees.filter(e => priorDutyNames.has(e.name));
        for (const p of priorDutyPeople) {
          dayOff.set(p.id, (dayOff.get(p.id) || 0) + 1);
        }
      }
    }
  }

  for (let i = 0; i < result.schedule.length; i += 1) {
    const cell = result.schedule[i];
    const next = result.schedule[i + 1];
    if (cell.duties && cell.duties.length) {
      const b = cell.duties[0]; if (b) byungCount.set(b.id, (byungCount.get(b.id) || 0) + 1);
      const e = cell.duties[1]; if (e) eungCount.set(e.id, (eungCount.get(e.id) || 0) + 1);
    }
    if (next && isWorkdayLocal(next.date)) {
      for (const d of (cell.duties || [])) dayOff.set(d.id, (dayOff.get(d.id) || 0) + 1);
    }
  }
  return { byungCount, eungCount, dayOff };
}

// 보정 규칙:
// - 두 수가 같고 하나만 다른 전형 케이스: outlier를 mode로 맞춤(±diff) — 1명만 보정
// - 그 외 복잡한 케이스: 중앙값 기준 편차를 계산하고, 한 명에게 총합을 모아 전달(±sum) — 1명만 보정
// 다자 균형: 총합 보존(sum deltas = 0), 가능한 한 값들을 floor(avg) 또는 ceil(avg)로 맞춤
// 이전 보정 파서: 텍스트에서 (이름, 역할, 부호있는 정수)를 추출
function getPreviousStatsFromUI() {
  const root = previousStatsUIRoot;
  if (!root) return { entries: [], sumByClassRole: new Map(), entriesByClassRole: new Map() };
  const employees = parseEmployees(employeesInput.value);
  const byName = new Map(employees.map((e, idx) => [e.name, { ...e, id: idx }]));
  const entries = [];
  root.querySelectorAll('tr[data-name]')?.forEach((tr) => {
    const name = tr.getAttribute('data-name');
    const emp = byName.get(name);
    if (!emp) return;
    const by = Number(tr.querySelector('input[data-role="byung"]').value);
    const eu = Number(tr.querySelector('input[data-role="eung"]').value);
    const off = Number(tr.querySelector('input[data-role="off"]').value);
    if (by) entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'byung', delta: by });
    if (eu) entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'eung', delta: eu });
    if (off) entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'off', delta: off });
  });
  const sumByClassRole = new Map();
  const entriesByClassRole = new Map();
  for (const e of entries) {
    if (!sumByClassRole.has(e.klass)) sumByClassRole.set(e.klass, { byung: 0, eung: 0, off: 0 });
    sumByClassRole.get(e.klass)[e.role] += e.delta;
    if (!entriesByClassRole.has(e.klass)) entriesByClassRole.set(e.klass, { byung: [], eung: [], off: [] });
    entriesByClassRole.get(e.klass)[e.role].push(e);
  }
  return { entries, sumByClassRole, entriesByClassRole };
}

function renderPreviousStatsUI() {
  const root = previousStatsUIRoot;
  if (!root) return;
  const emps = parseEmployees(employeesInput.value);
  const table = document.createElement('table');
  table.className = 'report-table';
  const thead = document.createElement('thead');
  const thr = document.createElement('tr');
  ['이름', '병당', '응당', 'Day-off'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); });
  thead.appendChild(thr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const e of emps) {
    const tr = document.createElement('tr'); tr.setAttribute('data-name', e.name);
    const nameTd = document.createElement('td'); nameTd.textContent = `${e.name} (${e.klass || '-'})`; tr.appendChild(nameTd);
    for (const role of ['byung','eung','off']) {
      const td = document.createElement('td'); td.classList.add('num');
      const input = document.createElement('input');
      input.type = 'number'; input.step = '1'; input.value = '0';
      input.setAttribute('data-role', role);
      td.appendChild(input); tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.innerHTML = '';
  root.appendChild(table);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(null, args), ms); };
}

// 대한민국 공휴일 로더 (Nager.Date API 사용, 병합)
async function loadKRHolidays({ merge = true } = {}) {
  try {
    const rng = currentDateRange();
    const years = yearsInRange();
    if (years.size === 0 || !rng) {
      alert('시작일/종료일 또는 주 수를 먼저 지정해주세요.');
      return;
    }
    setLoading(true, '공휴일 불러오는 중…');
    const fetched = new Set();
    for (const y of years) {
      try {
        const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/KR`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        for (const it of data) {
          if (!it?.date) continue;
          const d = new Date(it.date);
          if (!Number.isNaN(d.getTime()) && d >= rng.start && d <= rng.end) fetched.add(String(it.date));
        }
      } catch (e) {
        // 네트워크 실패 시 고정일 공휴일만 보정
        for (const day of fixedKRHolidays(y)) {
          const d = new Date(day);
          if (!Number.isNaN(d.getTime()) && d >= rng.start && d <= rng.end) fetched.add(day);
        }
      }
    }
    const { add: curAdd, remove: curRemove } = parseHolidayAddsRemoves(holidaysInput.value);
    const base = merge ? new Set([...curAdd, ...fetched]) : new Set([...fetched]);
    for (const d of curRemove) base.delete(d);
    const list = [...base].sort();
    holidaysInput.value = list.join('\n');
  } catch (e) {
    console.error(e);
    alert('공휴일 불러오기에 실패했습니다.');
  } finally { setLoading(false); }
}

function yearsInRange() {
  const range = currentDateRange();
  if (!range) return new Set();
  const ys = new Set();
  const startYear = range.start.getFullYear();
  const endYear = range.end.getFullYear();
  for (let y = Math.min(startYear, endYear); y <= Math.max(startYear, endYear); y += 1) {
    ys.add(y);
  }
  return ys;
}

function currentDateRange() {
  const startValue = startInput.value;
  if (!startValue) return null;
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) return null;

  const endValue = endInput.value;
  let end;
  if (endValue) {
    end = new Date(endValue);
    if (Number.isNaN(end.getTime())) return null;
  } else {
    end = addDays(start, getWeeksCount() * 7 - 1);
  }
  return { start, end };
}

function fixedKRHolidays(year) {
  // 네트워크 실패 시 최소한의 고정일 공휴일 제공
  const mk = (m, d) => `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return new Set([
    mk(1,1),   // 신정
    mk(3,1),   // 삼일절
    mk(5,5),   // 어린이날
    mk(6,6),   // 현충일
    mk(8,15),  // 광복절
    mk(10,3),  // 개천절
    mk(10,9),  // 한글날
    mk(12,25), // 성탄절
  ]);
}

function renderPersonalStats(result) {
  const wrap = document.createElement('div');
  wrap.className = 'weekly-report section-card';
  const title = document.createElement('div');
  title.className = 'legend title';
  title.textContent = '개인별 수련시간 및 Day-off 통계 (연차 내)';
  wrap.appendChild(title);

  const empById = new Map(result.employees.map((e) => [e.id, e]));
  // Compute day-off counts from schedule (정의: 전날 당직이고 오늘이 평일이면 Day-off 1)
  const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);

  const groups = new Map();
  for (const s of result.stats) {
    const emp = empById.get(s.id) || {};
    const k = emp.klass || '기타';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const order = ['R1','R2','R3','R4','기타'];
  for (const klass of order) {
    if (!groups.has(klass)) continue;
    const header = document.createElement('div');
    header.className = 'legend';
    header.textContent = `연차: ${klass}`;
    wrap.appendChild(header);

    const table = document.createElement('table');
    table.className = 'report-table';
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    const hdrs = ['이름', '병당(회)', '응당(회)', '총 당직(회)', 'Day-off', '당직시간(h)', '총근무시간(h)'];
    for (const h of hdrs) { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); }
    thead.appendChild(thr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const s of groups.get(klass)) {
      const emp = empById.get(s.id) || {};
      const offW = dayOff.get(s.id) || 0;
      const tr = document.createElement('tr');
      const cells = [
        s.name,
        String(byungCount.get(s.id) || 0),
        String(eungCount.get(s.id) || 0),
        String((byungCount.get(s.id) || 0) + (eungCount.get(s.id) || 0)),
        String(offW),
        (s.dutyHours).toFixed(1),
        (s.totalHours).toFixed(1),
      ];
      cells.forEach((val, idx) => {
        const td = document.createElement('td');
        td.textContent = String(val);
        if (idx >= 1) td.classList.add('num');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  const showDiagnostics = isDiagnosticsEnabled();
  if (showDiagnostics) {
    const diag = document.createElement('pre');
    diag.style.background = '#111';
    diag.style.color = '#afa';
    diag.style.padding = '8px';
    diag.style.marginTop = '8px';
    diag.textContent = `DIAGNOSTIC (Personal Stats):\nEungCount Map: ${JSON.stringify([...eungCount.entries()])}`;
    wrap.appendChild(diag);
  }

  report.appendChild(wrap);
}
