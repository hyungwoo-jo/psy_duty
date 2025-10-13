import { generateSchedule } from './scheduler.js';
import { fmtDate, addDays, isWeekday, rangeDays, weekKey } from './time.js';

const startInput = document.querySelector('#start-date');
const weeksInput = document.querySelector('#weeks');
const retryAttemptsInput = document.querySelector('#retry-attempts');
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
const prior2ByungInput = document.querySelector('#prior2-byung');
const prior2EungInput = document.querySelector('#prior2-eung');
const previousStatsUIRoot = document.querySelector('#prev-stats-ui');
const loadingOverlay = document.querySelector('#loading-overlay');
const loadingTextEl = loadingOverlay ? loadingOverlay.querySelector('.loading-text') : null;
const icsVersionInput = document.querySelector('#ics-version');
const icsPreview = document.querySelector('#ics-preview');
const hardcapToggle = document.querySelector('#role-hardcap-toggle');
const toggleR1Cap = document.querySelector('#toggle-r1-cap');
const toggleR3Cap = document.querySelector('#toggle-r3-cap');
const toggleR2Min = document.querySelector('#toggle-r2-min');
const toggleR3Balance = document.querySelector('#toggle-r3-balance');
const toggleDayoffWish = document.querySelector('#toggle-dayoff-wish');
const toggleR3PediatricWed = document.querySelector('#toggle-r3-ped-wed');
const toggleVacationBan = document.querySelector('#toggle-vacation-ban');
const toggleUnavailableBan = document.querySelector('#toggle-unavailable-ban');
const scoreOvertimeSoft = document.querySelector('#score-overtime-soft');
const scoreOvertimeHard = document.querySelector('#score-overtime-hard');
const scoreUnder40Penalty = document.querySelector('#score-under-40');
const scoreDayoffBase = document.querySelector('#score-dayoff-base');
const scoreDayoffIncrement = document.querySelector('#score-dayoff-increment');
const scoreRoleBase = document.querySelector('#score-role-base');
const scoreRoleIncrement = document.querySelector('#score-role-increment');
const scoreGapPenalty = document.querySelector('#score-gap2');
const scoreFriSunPenalty = document.querySelector('#score-fri-sun');
let roleHardcapMode = hardcapToggle?.dataset.mode === 'relaxed' ? 'relaxed' : 'strict';
// 최적화 선택 UI 제거: 기본 strong
// 주 계산 모드 옵션 제거: 달력 기준(월–일) 고정
// 당직 슬롯 고정: 병당 1, 응당 1

// 기본값: 다음 월요일 (DOMContentLoaded 이후 안전하게 지정)
runOnReady(setDefaultStartMonday);

generateBtn?.addEventListener('click', onGenerate);
exportXlsxBtn?.addEventListener('click', onExportXlsx);
exportIcsBtn?.addEventListener('click', onExportIcs);
// 직원 목록 변경 시 보정 UI 갱신
employeesInput?.addEventListener('input', debounce(renderPreviousStatsUI, 250));
runOnReady(renderPreviousStatsUI);
runOnReady(updateHardcapToggleLabel);
runOnReady(() => {
  // GitHub Pages 경로 자동 추정(비어있을 때만)
  try {
    if (icsVersionInput && !icsVersionInput.value) icsVersionInput.value = 'v1';
    updateIcsPreview();
  } catch {}
});
runOnReady(bindScoreClassTabs);
['change','input'].forEach((ev) => {
  startInput?.addEventListener(ev, updateIcsPreview);
  endInput?.addEventListener(ev, updateIcsPreview);
  weeksInput?.addEventListener(ev, updateIcsPreview);
  icsVersionInput?.addEventListener(ev, updateIcsPreview);
});
hardcapToggle?.addEventListener('click', () => {
  setRoleHardcapMode(roleHardcapMode === 'strict' ? 'relaxed' : 'strict');
});
// 공휴일 도우미 버튼
document.querySelector('#load-kr-holidays')?.addEventListener('click', () => loadKRHolidays({ merge: true }));
document.querySelector('#clear-holidays')?.addEventListener('click', () => { holidaysInput.value = ''; });

const SCORE_DEFAULTS = {
  overtimeSoft: 1,
  overtimeHard: 2,
  underwork: 1,
  dayoffBase: 0.5,
  dayoffIncrement: 1,
  roleBase: 1,
  roleIncrement: 1,
  gapPenalty: 0.5,
  friSunPenalty: 1,
};
const SCORE_CLASSES = ['R1','R2','R3','R4'];
let _scoreClass = 'R1';
let _scoreConfigs = null;
let lastResult = null;
let scheduleSeedCounter = 0;

function readScoreInput(el, fallback) {
  if (!el) return fallback;
  const value = Number(el.value);
  if (!Number.isFinite(value)) return fallback;
  return value; // allow negatives as requested
}

function getCurrentScoreInputs() {
  return {
    overtimeSoft: readScoreInput(scoreOvertimeSoft, SCORE_DEFAULTS.overtimeSoft),
    overtimeHard: readScoreInput(scoreOvertimeHard, SCORE_DEFAULTS.overtimeHard),
    underwork: readScoreInput(scoreUnder40Penalty, SCORE_DEFAULTS.underwork),
    dayoffBase: readScoreInput(scoreDayoffBase, SCORE_DEFAULTS.dayoffBase),
    dayoffIncrement: readScoreInput(scoreDayoffIncrement, SCORE_DEFAULTS.dayoffIncrement),
    roleBase: readScoreInput(scoreRoleBase, SCORE_DEFAULTS.roleBase),
    roleIncrement: readScoreInput(scoreRoleIncrement, SCORE_DEFAULTS.roleIncrement),
    gapPenalty: readScoreInput(scoreGapPenalty, SCORE_DEFAULTS.gapPenalty),
    friSunPenalty: readScoreInput(scoreFriSunPenalty, SCORE_DEFAULTS.friSunPenalty),
  };
}

function setCurrentScoreInputs(cfg) {
  if (!cfg) return;
  scoreOvertimeSoft.value = cfg.overtimeSoft;
  scoreOvertimeHard.value = cfg.overtimeHard;
  scoreUnder40Penalty.value = cfg.underwork;
  scoreDayoffBase.value = cfg.dayoffBase;
  scoreDayoffIncrement.value = cfg.dayoffIncrement;
  scoreRoleBase.value = cfg.roleBase;
  scoreRoleIncrement.value = cfg.roleIncrement;
  if (scoreGapPenalty) scoreGapPenalty.value = cfg.gapPenalty;
  if (scoreFriSunPenalty) scoreFriSunPenalty.value = cfg.friSunPenalty;
}

function ensureScoreConfigs() {
  if (_scoreConfigs) return _scoreConfigs;
  const base = getCurrentScoreInputs();
  _scoreConfigs = Object.fromEntries(SCORE_CLASSES.map(k => [k, { ...base }]));
  _scoreClass = 'R1';
  return _scoreConfigs;
}

function getScoreWeights() {
  const global = getCurrentScoreInputs();
  const perClass = ensureScoreConfigs();
  return { global, perClass };
}

function bindScoreClassTabs() {
  const tabs = document.getElementById('score-class-tabs');
  if (!tabs) return;
  ensureScoreConfigs();
  const indicator = document.getElementById('score-class-indicator');
  if (indicator) indicator.textContent = `현재: ${_scoreClass}`;
  tabs.addEventListener('click', (e) => {
    const btn = e.target?.closest('button[data-klass]');
    if (!btn) return;
    // save current edits to current class
    _scoreConfigs[_scoreClass] = getCurrentScoreInputs();
    // switch
    const next = btn.getAttribute('data-klass');
    _scoreClass = next;
    // update buttons state
    tabs.querySelectorAll('button[data-klass]').forEach(b => {
      const sel = b.getAttribute('data-klass') === _scoreClass;
      b.setAttribute('aria-pressed', sel ? 'true' : 'false');
      b.setAttribute('aria-selected', sel ? 'true' : 'false');
    });
    // load inputs
    setCurrentScoreInputs(_scoreConfigs[_scoreClass]);
    if (indicator) indicator.textContent = `현재: ${_scoreClass}`;
  });
}

function readToggle(el, fallback = true) {
  if (!el) return fallback;
  return !!el.checked;
}

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
    // Defer to end of current task to avoid TDZ on later declarations
    setTimeout(fn, 0);
  }
}

function setDefaultStartMonday() {
  if (!startInput) return;
  // 오늘 기준 "다음달의 첫 월요일"로 설정
  const today = new Date();
  const firstOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const firstMonday = new Date(firstOfNextMonth);
  firstMonday.setHours(12, 0, 0, 0); // DST/타임존 영향 최소화
  while (firstMonday.getDay() !== 1) {
    firstMonday.setDate(firstMonday.getDate() + 1);
  }
  const y = firstMonday.getFullYear();
  const m = String(firstMonday.getMonth() + 1).padStart(2, '0');
  const d = String(firstMonday.getDate()).padStart(2, '0');
  try {
    startInput.valueAsDate = firstMonday;
  } catch {}
  startInput.value = `${y}-${m}-${d}`;
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
      // persist current class edits before generating
      try { ensureScoreConfigs(); _scoreConfigs[_scoreClass] = getCurrentScoreInputs(); } catch {}
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
      const prior2 = getPrior2DayDutyFromUI();

      // --- Read ILP rule toggles from UI ---
      const enforceR1Cap = readToggle(toggleR1Cap);
      const enforceR3Cap = readToggle(toggleR3Cap);
      const enforceR2Min = readToggle(toggleR2Min);
      const enforceR3Balance = readToggle(toggleR3Balance);
      const enforceDayoffWishRule = readToggle(toggleDayoffWish);
      const enforceR3PediatricWedBan = readToggle(toggleR3PediatricWed);
      const enforceVacationExclusion = readToggle(toggleVacationBan);
      const enforceUnavailableExclusion = readToggle(toggleUnavailableBan);
      const enforceDayoffBalance = true; // Always enforce day-off balance

      const runSchedule = (mode, seed, r3Cap = false, r1Cap = false, hourCap = 'strict') => {
        const randomSeed = Number.isFinite(seed) ? seed : nextRandomSeed();
        console.log(`[SCHEDULER] Using random seed: ${randomSeed}`);
        const args = {
          startDate,
          endDate,
          weeks,
          weekMode,
          employees,
          holidays,
          dutyUnavailableByName: enforceUnavailableExclusion ? Object.fromEntries(dutyUnavailable) : {},
          dayoffWishByName: enforceDayoffWishRule ? Object.fromEntries(dayoffWish) : {},
          vacationDaysByName: enforceVacationExclusion ? Object.fromEntries(vacations) : {},
          priorDayDuty: prior,
          prior2DayDuty: prior2,
          optimization,
          weekdaySlots,
          weekendSlots: 2,
          timeBudgetMs: budgetMs,
          roleHardcapMode: mode,
          prevStats: prev,
          randomSeed,
          enforceR3WeeklyCap: r3Cap,
          enforceR1WeeklyCap: r1Cap,
          enforceR2WeeklyMin: enforceR2Min,
          enforceR3NonPediatricBalance: enforceR3Balance,
          enforceDayoffWish: enforceDayoffWishRule,
          enforceR3PediatricWedBan,
          enforceVacationExclusion,
          enforceUnavailableExclusion,
          enforceDayoffBalance,
          weeklyHourCapMode: hourCap,
        };
        return generateSchedule(args);
      };

      // --- Multi-run and evaluation logic ---
      const getRetryCount = () => {
        const value = Number(retryAttemptsInput?.value || 20);
        if (!Number.isFinite(value) || value <= 0) return 20;
        return Math.floor(value);
      };
      const MAX_ATTEMPTS = getRetryCount();
      const results = [];
      appendMessage(`총 ${MAX_ATTEMPTS}번의 생성을 시도하여 72시간 초과가 없는 최적의 해를 찾습니다...`);

      const runAttempt = async (attemptNum) => {
        if (attemptNum > MAX_ATTEMPTS) {
          evaluateAndRender(results);
          return;
        }

        try {
          let currentResult = null;
          
          // --- Constraint Dropping Architecture ---
          try {
            // First attempt with UI settings
            currentResult = await runSchedule(roleHardcapMode, undefined, enforceR3Cap, enforceR1Cap, 'strict');
          } catch (e) {
            try {
              // Fallback 1: Drop R1 cap
              currentResult = await runSchedule(roleHardcapMode, undefined, enforceR3Cap, false, 'strict');
            } catch (e2) {
              // Fallback 2: Drop R1 cap and relax hour mode
              currentResult = await runSchedule(roleHardcapMode, undefined, enforceR3Cap, false, 'none');
            }
          }
          results.push(currentResult);
        } catch (err) {
          const detailedError = `오류 발생: ${err.message}\n\nStack Trace:\n${err.stack}`;
          console.error(err);
          messages.innerHTML = '';
          appendMessage(detailedError.replace(/\n/g, '<br>'));
          setLoading(false);
          disableActions(false);
          return; // Stop the loop on first error
        }

        setTimeout(() => runAttempt(attemptNum + 1), 50);
      };

      const evaluateAndRender = (finalResults) => {
        if (finalResults.length === 0) {
          appendMessage("모든 스케줄 생성 시도에 실패했습니다. 입력값을 확인해주세요.");
          setLoading(false);
          disableActions(false);
          return;
        }

        appendMessage('생성된 스케줄들을 새로운 점수 체계로 평가합니다...');
        const weights = getScoreWeights();
        const EPSILON = 1e-6;

        const applyPenalty = (deltaAbs, base, increment) => {
          if (!(deltaAbs > 0)) return 0;
          const steps = Math.max(0, deltaAbs - 1);
          const penalty = base + steps * increment;
          return Math.max(0, penalty);
        };

        function calculateHourScore(result, perClassScore) {
          if (!result || !result.stats) return 0;
          const empById = new Map(result.employees.map((e) => [e.id, e]));
          let score = 0;
          for (const person of result.stats) {
            const klass = empById.get(person.id)?.klass || '기타';
            const weekly = person.weeklyHours || {};
            for (const week of Object.keys(weekly)) {
              const num = Number(weekly[week]);
              if (!Number.isFinite(num)) continue;
              const hours = Math.round(num * 10) / 10;
              let delta = 0;
              const wClass = (weights.perClass?.[klass]) || {};
              const soft = (wClass.overtimeSoft ?? weights.global.overtimeSoft);
              const hard = (wClass.overtimeHard ?? weights.global.overtimeHard);
              const under = (wClass.underwork ?? weights.global.underwork);
              if (hours >= 75 - EPSILON) {
                delta += hard;
              } else if (hours > 72 + EPSILON) {
                delta += soft;
              }
              if (hours < 40 - EPSILON) {
                delta += under;
              }
              if (delta) {
                score += delta;
                if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + delta);
              }
            }
          }
          return score;
        }

        function calculateCarryoverScore(result, perClassScore) {
          if (!result) return 0;
          let score = 0;
          const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);
          const empById = new Map(result.employees.map((e) => [e.id, e]));
          const klasses = [...new Set(result.employees.map(e => e.klass || '기타'))];

          for (const klass of klasses) {
            const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
            if (!peopleInClass.length) continue;

            const roles = [
              { key: 'off', countMap: dayOff },
              { key: 'byung', countMap: byungCount },
              { key: 'eung', countMap: eungCount },
            ];

            for (const role of roles) {
              if (klass === 'R3' && (role.key === 'byung' || role.key === 'eung')) {
                continue;
              }
              const prevList = (prev.entriesByClassRole.get(klass)?.[role.key]) || [];
              const prevByName = new Map(prevList.map((e) => [e.name, Number(e.delta) || 0]));
              const finalCounts = peopleInClass.map((p) => ({
                id: p.id,
                name: p.name,
                count: (Number(role.countMap.get(p.id) || 0)) + (prevByName.get(p.name) || 0),
              }));
              const { deltas } = computeCarryoverDeltas(finalCounts);
              for (const d of deltas) {
                const deltaAbs = Math.abs(d.delta);
                const wClass = (weights.perClass?.[klass]) || {};
                const add = role.key === 'off'
                  ? applyPenalty(deltaAbs, (wClass.dayoffBase ?? weights.global.dayoffBase), (wClass.dayoffIncrement ?? weights.global.dayoffIncrement))
                  : applyPenalty(deltaAbs, (wClass.roleBase ?? weights.global.roleBase), (wClass.roleIncrement ?? weights.global.roleIncrement));
                if (add) {
                  score += add;
                  if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
                }
              }
            }
          }
          return score;
        }

        function computeGapPenaltyCounts(result) {
          const counts = new Map();
          const lastSeen = new Map();
          const start = result.startDate ? new Date(result.startDate) : null;
          const prior = result.config?.priorDayDuty || {};
          const prior2 = result.config?.prior2DayDuty || {};
          if (start) {
            const priorDate = new Date(start);
            priorDate.setDate(priorDate.getDate() - 1);
            const priorNames = new Set([prior.byung, prior.eung].filter(Boolean));
            for (const emp of result.employees || []) {
              if (priorNames.has(emp.name)) {
                lastSeen.set(emp.id, new Date(priorDate));
              }
            }
            const priorDate2 = new Date(start);
            priorDate2.setDate(priorDate2.getDate() - 2);
            const priorNames2 = new Set([prior2.byung, prior2.eung].filter(Boolean));
            for (const emp of result.employees || []) {
              if (priorNames2.has(emp.name)) {
                const existing = lastSeen.get(emp.id);
                if (!existing || existing > priorDate2) {
                  lastSeen.set(emp.id, new Date(priorDate2));
                }
              }
            }
          }
          const schedule = result.schedule || [];
          for (const cell of schedule) {
            const date = new Date(cell.date);
            for (const duty of (cell.duties || [])) {
              const prevDate = lastSeen.get(duty.id);
              if (prevDate) {
                const diffDays = Math.round((date - prevDate) / 86400000);
                if (diffDays === 2) {
                  counts.set(duty.id, (counts.get(duty.id) || 0) + 1);
                }
              }
              lastSeen.set(duty.id, date);
            }
          }
          return counts;
        }

        function getGapCounts(result) {
          if (!result) return new Map();
          const counts = computeGapPenaltyCounts(result);
          if (!result.meta) result.meta = {};
          result.meta.gapCounts = Object.fromEntries([...counts.entries()].map(([k, v]) => [String(k), Number(v) || 0]));
          return counts;
        }

        function calculateGapPenalty(result, perClassScore) {
          const counts = getGapCounts(result);
          if (!counts.size) return 0;
          let score = 0;
          const empById = new Map(result.employees.map((e) => [e.id, e]));
          for (const [id, count] of counts.entries()) {
            const klass = empById.get(id)?.klass || '기타';
            const conf = (weights.perClass?.[klass]) || {};
            const gap = conf.gapPenalty ?? weights.global.gapPenalty ?? 0;
            if (!gap) continue;
            const add = gap * count;
            score += add;
            if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
          }
          return score;
        }

        function computeFriSunComboCounts(result) {
          const counts = new Map();
          if (!result) return counts;
          const schedule = result.schedule || [];
          const weekly = new Map(); // weekKey -> { fri:Set, sun:Set }
          for (const cell of schedule) {
            if (!cell?.duties?.length) continue;
            const date = new Date(cell.date);
            const day = date.getDay();
            if (day !== 5 && day !== 0) continue; // 5: Fri, 0: Sun
            const wk = weekKey(date);
            if (!weekly.has(wk)) {
              weekly.set(wk, { fri: new Set(), sun: new Set() });
            }
            const bucket = weekly.get(wk);
            const targetSet = day === 5 ? bucket.fri : bucket.sun;
            for (const duty of cell.duties) {
              if (duty?.id == null) continue;
              targetSet.add(duty.id);
            }
          }
          for (const bucket of weekly.values()) {
            if (!bucket.fri.size || !bucket.sun.size) continue;
            for (const id of bucket.fri) {
              if (bucket.sun.has(id)) {
                counts.set(id, (counts.get(id) || 0) + 1);
              }
            }
          }
          return counts;
        }

        function getFriSunCounts(result) {
          if (!result) return new Map();
          const counts = computeFriSunComboCounts(result);
          if (!result.meta) result.meta = {};
          result.meta.friSunComboCounts = Object.fromEntries([...counts.entries()].map(([k, v]) => [String(k), Number(v) || 0]));
          return counts;
        }

        function calculateFriSunPenalty(result, perClassScore) {
          const counts = getFriSunCounts(result);
          if (!counts.size) return 0;
          let score = 0;
          const empById = new Map(result.employees.map((e) => [e.id, e]));
          for (const [id, count] of counts.entries()) {
            const klass = empById.get(id)?.klass || '기타';
            const conf = (weights.perClass?.[klass]) || {};
            const penalty = conf.friSunPenalty ?? weights.global.friSunPenalty ?? 0;
            if (!penalty || !count) continue;
            const add = penalty * count;
            score += add;
            if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
          }
          return score;
        }

        function stitchSchedulesByClass({ classes, bestByClass, base }) {
          try {
            const baseRes = base?.result || base;
            if (!baseRes) return { passed: false, note: '기본 스케줄이 없습니다.' };
            const days = baseRes.schedule || [];
            const N = days.length;
            const merged = [];
            const empById = new Map(baseRes.employees.map((e) => [e.id, e]));

            for (let i = 0; i < N; i += 1) {
              const cell = days[i];
              const duties = [];
              for (let slot = 0; slot < 2; slot += 1) {
                const baseDuty = (cell.duties || [])[slot] || null;
                let klass = null;
                if (baseDuty && empById.has(baseDuty.id)) klass = empById.get(baseDuty.id).klass || null;
                // fallback: if klass unknown, leave base duty as-is
                if (!klass || !bestByClass.has(klass)) {
                  duties[slot] = baseDuty;
                  continue;
                }
                const candRes = bestByClass.get(klass).result;
                const pick = (candRes.schedule?.[i]?.duties || [])[slot] || baseDuty;
                duties[slot] = pick;
              }
              merged.push({ key: cell.key, date: cell.date, duties, back: cell.back, underfilled: false });
            }

            const result = {
              startDate: baseRes.startDate,
              endDate: baseRes.endDate,
              weeks: baseRes.weeks,
              holidays: baseRes.holidays ? [...baseRes.holidays] : [],
              employees: baseRes.employees,
              schedule: merged,
              config: baseRes.config,
              warnings: [],
              stats: [],
              fairness: {},
              meta: baseRes.meta,
            };
            recomputeStatsInPlace(result);
            // Optional: lightweight weekly-hour warnings (>72h)
            addWeeklyWarnings(result, 72);

            // Re-score merged result
            const perClassScore = new Map();
            const totalScore = calculateHourScore(result, perClassScore)
              + calculateCarryoverScore(result, perClassScore)
              + calculateGapPenalty(result, perClassScore)
              + calculateFriSunPenalty(result, perClassScore);
            return {
              passed: true,
              candidate: { result, totalScore, perClassScore },
              note: '연차별 최저점 조합 스케줄 적용',
            };
          } catch (e) {
            console.warn('[stitchSchedulesByClass] fail:', e);
            return { passed: false, note: `조합 실패: ${e?.message || e}` };
          }
        }

        function addWeeklyWarnings(result, limit) {
          const warns = [];
          for (const s of result.stats || []) {
            for (const [wk, hours] of Object.entries(s.weeklyHours || {})) {
              if (hours > limit + 1e-9) warns.push(`${s.name}의 ${wk} 주간 시간이 ${limit}h를 초과했습니다: ${Number(hours).toFixed(1)}h`);
            }
          }
          result.warnings = warns;
        }

function recomputeStatsInPlace(result) {
  const holidays = new Set(result.holidays || []);
  const employees = result.employees || [];
  const schedule = result.schedule || [];
  const people = employees.map((e) => ({ id: e.id, name: e.name, weeklyHours: {}, totalHours: 0, gapA2: 0 }));

  const dayOffKeysById = new Map(people.map((p) => [p.id, new Set()]));
  const prior = result.config?.priorDayDuty || {};
  const prior2 = result.config?.prior2DayDuty || {};
  const priorNames = new Set([prior.byung, prior.eung].filter(Boolean));
  const prior2Names = new Set([prior2.byung, prior2.eung].filter(Boolean));

  const isWorkday = (date) => {
    const key = fmtDate(date);
    const wd = date.getDay();
    return wd >= 1 && wd <= 5 && !holidays.has(key);
  };

  if (schedule.length > 0) {
    const firstDate = new Date(schedule[0].date);
    if (isWorkday(firstDate) && priorNames.size) {
      for (const emp of employees) {
        if (priorNames.has(emp.name)) {
          dayOffKeysById.get(emp.id)?.add(fmtDate(firstDate));
        }
      }
    }
    const prevDate = new Date(firstDate);
    prevDate.setDate(prevDate.getDate() - 1);
    if (isWorkday(prevDate) && prior2Names.size) {
      for (const emp of employees) {
        if (prior2Names.has(emp.name)) {
          dayOffKeysById.get(emp.id)?.add(fmtDate(prevDate));
        }
      }
    }
  }

  for (let i = 0; i < schedule.length; i += 1) {
    const cell = schedule[i];
    const next = schedule[i + 1];
    if (!next) continue;
    const nextDate = new Date(next.date);
    if (!isWorkday(nextDate)) continue;
    const key = fmtDate(nextDate);
    for (const duty of (cell.duties || [])) {
      dayOffKeysById.get(duty.id)?.add(key);
    }
  }

  for (const cell of schedule) {
    const date = new Date(cell.date);
    const key = fmtDate(date);
    const wkKey = weekKey(date);
    const workday = isWorkday(date);
    const dutyIds = new Set((cell.duties || []).map((d) => d.id));

    for (const person of people) {
      let h = 0;
      const isOnDuty = dutyIds.has(person.id);
      const hasDayOff = dayOffKeysById.get(person.id)?.has(key);
      if (workday) {
        if (!hasDayOff) h += 8;
        if (isOnDuty) h += 13.5;
      } else if (isOnDuty) {
        h += 21;
      }
      if (h > 0) {
        person.weeklyHours[wkKey] = (person.weeklyHours[wkKey] || 0) + h;
        person.totalHours += h;
      }
    }
  }

  result.stats = people;
  const gapCounts = getGapCounts(result);
  for (const person of people) {
    person.gapA2 = Number(gapCounts.get(person.id) || 0);
  }
}

        const scoredResults = finalResults.map((res) => {
          const perClassScore = new Map();
          const hourScore = calculateHourScore(res, perClassScore);
          const carryoverScore = calculateCarryoverScore(res, perClassScore);
          const gapScore = calculateGapPenalty(res, perClassScore);
          const friSunScore = calculateFriSunPenalty(res, perClassScore);
          const totalScore = hourScore + carryoverScore + gapScore + friSunScore;
          return { result: res, totalScore, perClassScore };
        });

        // pick the minimal totalScore as baseline
        let baseline = null;
        for (const cand of scoredResults) {
          if (!baseline || cand.totalScore < baseline.totalScore) baseline = cand;
        }

        // Build per-class best map
        const classes = ['R1','R2','R3','R4'];
        const bestByClass = new Map();
        for (const k of classes) {
          let best = null;
          for (const cand of scoredResults) {
            const v = cand.perClassScore.get(k) ?? 0;
            if (!best || v < (best.perClassScore.get(k) ?? 0)) best = cand;
          }
          if (best) bestByClass.set(k, best);
        }

        // Stitch schedules by class from the per-class minima
        const merged = stitchSchedulesByClass({ classes, bestByClass, base: baseline });
        const winner = merged?.passed ? merged.candidate : baseline;
        if (merged?.note) appendMessage(merged.note, 'warn');

        // Render
        lastResult = winner.result;
        renderSummary(lastResult);
        renderReport(lastResult, { previous: prev });
        renderRoster(lastResult);
        if (isDiagnosticsEnabled()) {
          try { renderScoreBreakdown(winner); } catch {}
        }
        if (exportXlsxBtn) exportXlsxBtn.disabled = false;
        if (exportIcsBtn) exportIcsBtn.disabled = false;

        setLoading(false);
        disableActions(false);
      };

      runAttempt(1);

    } catch (err) {
      console.error(err);
      messages.textContent = err.message || String(err);
      if (exportXlsxBtn) exportXlsxBtn.disabled = true;
      if (exportIcsBtn) exportIcsBtn.disabled = true;
    } finally {
      // setLoading and disableActions are now called inside evaluateAndRender or the catch block
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
  lines.push(warn ? `주의: ${[...result.warnings].join(' | ') || '검토 필요한 항목 존재'}` : '검증: 제약 내에서 생성됨');

  // 상세 비교는 개인별 통계 테이블에서 연차 내 기준으로 확인

  const wkdaySlots = result?.config?.weekdaySlots ?? 1;
  const wkendSlots = result?.config?.weekendSlots ?? 2;
  summary.innerHTML = `
    <div class="legend">시간 산식(개정): 평일 정규 8h(2명), 평일 당직 ${wkdaySlots}명(당일 총 21.5h = 정규 8 + 당직 13.5, 휴게 2.5), 주말/공휴일 당직 ${wkendSlots}명(각 21h). 평일 당직 다음날 정규 면제. 주당 상한: 72h, 개인 총합 ≤ 72×(근무주수)</div>
    <div class="${warn ? 'warn' : 'ok'}">${lines.join(' / ')}</div>
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
  if (isDiagnosticsEnabled()) renderGapDetails(result);
}

function renderGapDetails(result) {
  if (!isDiagnosticsEnabled()) return;
  const stats = result.stats || [];
  const highlight = stats.filter((s) => Number(s.gapA2 || 0) > 0);
  if (highlight.length === 0) return;
  const wrap = document.createElement('details');
  wrap.open = false;
  const summary = document.createElement('summary');
  summary.textContent = '당직-휴무-당직(OFF 하나 간격) 반복 현황';
  wrap.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'report-table';
  const thead = document.createElement('thead');
  const thr = document.createElement('tr');
  ['이름','연차','반복 횟수'].forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    thr.appendChild(th);
  });
  thead.appendChild(thr);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const empById = new Map(result.employees.map((e) => [e.id, e]));
  for (const stat of highlight) {
    const tr = document.createElement('tr');
    const klass = empById.get(stat.id)?.klass || '';
    const cells = [stat.name, klass, Number(stat.gapA2 || 0)];
    cells.forEach((val, idx) => {
      const td = document.createElement('td');
      td.textContent = String(val);
      if (idx === 2) td.classList.add('num');
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  report.appendChild(wrap);
}

function renderScoreBreakdown(candidate) {
  if (!candidate || !candidate.perClassScore) return;
  const wrap = document.createElement('details');
  wrap.open = false;
  const summaryEl = document.createElement('summary');
  summaryEl.textContent = `연차별 점수 상세 (총점: ${candidate.totalScore})`;
  wrap.appendChild(summaryEl);

  const table = document.createElement('table');
  table.className = 'report-table';
  const thead = document.createElement('thead');
  const thr = document.createElement('tr');
  ['연차','점수'].forEach((h) => { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); });
  thead.appendChild(thr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const order = ['R1','R2','R3','R4'];
  for (const k of order) {
    const raw = candidate.perClassScore.get(k) ?? 0;
    const tr = document.createElement('tr');
    [[k],[raw]].forEach((val) => { const td = document.createElement('td'); td.textContent = String(val); tr.appendChild(td); });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  report.prepend(wrap);
  wrap.appendChild(table);
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

function getPrior2DayDutyFromUI() {
  const byung = (prior2ByungInput?.value || '').trim();
  const eung = (prior2EungInput?.value || '').trim();
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
    // Add new header for Average Weekly Hours
    const headers = ['이름', ...weekKeys, '합계', '주당 평균 시간'];
    for (const h of headers) { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); }  
    thead.appendChild(thr); table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const s of groups.get(klass)) {
      const tr = document.createElement('tr');
      const totalNum = Number(s.totalHours);
      const totalHours = Number.isFinite(totalNum) ? totalNum : 0;
      const avgBase = result.weeks > 0 ? totalHours / result.weeks : 0;
      const avgWeeklyHours = Number.isFinite(avgBase) ? avgBase : 0;
      const values = weekKeys.map((wk) => {
        const num = Number(s.weeklyHours[wk]);
        return Number.isFinite(num) ? num : 0;
      });
      const displayValues = values.map((v) => (Math.round(v * 10) / 10).toFixed(1));
      const totalDisplay = (Math.round(totalHours * 10) / 10).toFixed(1);
      const avgDisplay = (Math.round(avgWeeklyHours * 10) / 10).toFixed(1);
      const cells = [s.name, ...displayValues, totalDisplay, avgDisplay];
      
      // Determine color based on avgWeeklyHours for '주당 평균 시간' column
      let avgColorClass = '';
      if (avgWeeklyHours >= 70) {
        avgColorClass = 'avg-hours-tier-7'; // 70-75
      } else if (avgWeeklyHours >= 65) {
        avgColorClass = 'avg-hours-tier-6'; // 65-70
      } else if (avgWeeklyHours >= 60) {
        avgColorClass = 'avg-hours-tier-5'; // 60-65
      } else if (avgWeeklyHours >= 55) {
        avgColorClass = 'avg-hours-tier-4'; // 55-60
      } else if (avgWeeklyHours >= 50) {
        avgColorClass = 'avg-hours-tier-3'; // 50-55
      } else if (avgWeeklyHours >= 45) {
        avgColorClass = 'avg-hours-tier-2'; // 45-50
      } else if (avgWeeklyHours >= 40) {
        avgColorClass = 'avg-hours-tier-1'; // 40-45
      }

      cells.forEach((val, idx) => {
        const td = document.createElement('td');
        td.textContent = String(val);
        if (idx >= 1) td.classList.add('num');
        
        // Apply color to individual weekly cells
        if (idx >= 1 && idx <= weekKeys.length) { // Individual weekly cells
          const hours = values[idx - 1] || 0;
          if (hours >= 80) {
            td.classList.add('hours-tier-7');
          } else if (hours >= 75) {
            td.classList.add('hours-tier-6');
          } else if (hours >= 72) {
            td.classList.add('hours-tier-5');
          } else if (hours >= 60) {
            td.classList.add('hours-tier-4');
          } else if (hours >= 50) {
            td.classList.add('hours-tier-3');
          } else if (hours >= 40) {
            td.classList.add('hours-tier-2');
          } else if (hours > 0) {
            td.classList.add('hours-tier-1');
          }
        }

        // Apply color to '주당 평균 시간' column only
        if (idx === cells.length - 1) { // Last column is '주당 평균 시간'
          if (avgColorClass) {
            td.classList.add(avgColorClass);
          }
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
    diag.className = 'diagnostics-output';
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
    const hdrs = ['이름', '병당(회)', '응당(회)', '총 당직(회)', 'Day-off'];
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
    diag.className = 'diagnostics-output';
    diag.textContent = `DIAGNOSTIC (Personal Stats):\nEungCount Map: ${JSON.stringify([...eungCount.entries()])}`;
    wrap.appendChild(diag);
  }

  report.appendChild(wrap);
}
