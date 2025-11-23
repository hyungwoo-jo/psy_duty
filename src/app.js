import { customSlotOverrides } from './calendar-ui.js';
import {
  bindEvents,
  initializeUI,
  getGenerationParams,
  renderResults,
  setLoading,
  disableActions,
  appendMessage,
  enableExportButtons,
  renderScoreBreakdown,
  clearMessages
} from './ui-controller.js';
import { runScheduleInWorkerWithTimeout } from './worker-pool.js';
import {
  calculateHourScore,
  calculateCarryoverScore,
  calculateGapPenalty,
  calculateFriSunPenalty,
  calculateWeeklyDutyPenalty,
  checkWeeklyDutyViolation,
  stitchSchedulesByClass,
  addWeeklyWarnings,
  recomputeStatsInPlace,
  getScoreWeights,
  computeRoleAndOffCounts,
  computeCarryoverDeltas
} from './scoring.js';
import { weekKey, fmtDate, addDays } from './time.js';
import {
  download,
  buildSpreadsheetXML,
  buildICS,
  buildZip,
  safePersonFilename,
  hasDutiesFor,
  dominantMonthKey,
  getComputedIcsBase,
  joinUrl,
  buildCarryoverRows,
  buildPreviousAdjustRows
} from './export-utils.js';

let lastResult = null;

async function onGenerate() {
  try {
    setLoading(true, '당직표 생성 중…');
    disableActions(true);
    clearMessages();

    await new Promise(resolve => setTimeout(resolve, 30));

    try {
      const params = getGenerationParams();
      const {
        startDate, endDate, weeks, employees, holidays,
        dutyUnavailable, dayoffWish, vacations, priorDayDuty, prior2DayDuty,
        enforceR3Balance, enforceDayoffWishRule, enforceR3PediatricWedBan,
        enforceVacationExclusion, enforceUnavailableExclusion,
        roleHardcapMode, dayoffCountingMode, excludeR4Mode, enforceDayoffBalance, enforceWeeklyHourCap,
        retryAttempts, scoreConfigs
      } = params;

      const optimization = 'strong';
      const budgetMs = 5000; // Default
      const weekMode = 'calendar';
      const weekdaySlots = 2;

      const runSchedule = (mode, seed, r3Cap = false, r1Cap = false, hourCap = 'strict') => {
        const randomSeed = Number.isFinite(seed) ? seed : nextRandomSeed();
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
          priorDayDuty,
          prior2DayDuty,
          optimization,
          weekdaySlots,
          weekendSlots: 2,
          timeBudgetMs: budgetMs,
          roleHardcapMode: mode,
          prevStats: params.prevStats,
          randomSeed,
          enforceR3NonPediatricBalance: enforceR3Balance,
          enforceDayoffWish: enforceDayoffWishRule,
          enforceR3PediatricWedBan,
          enforceVacationExclusion,
          enforceUnavailableExclusion,
          enforceDayoffBalance,
          weeklyHourCapMode: hourCap,
          dayoffCountingMode,
          excludeR4Mode,
          enforceWeeklyHourCap,
          customSlotOverrides,
        };
        return runScheduleInWorkerWithTimeout(args, 60000);
      };

      const MAX_ATTEMPTS = retryAttempts;
      const results = [];
      let autoRelaxMessageShown = false;
      appendMessage(`총 ${MAX_ATTEMPTS}번의 생성을 시도합니다...`);

      const attemptWithConstraints = async (mode) => {
        try {
          return await runSchedule(mode, undefined, false, false, 'strict');
        } catch (err) {
          try {
            return await runSchedule(mode, undefined, false, false, 'strict');
          } catch {
            return await runSchedule(mode, undefined, false, false, 'none');
          }
        }
      };

      const runSingleAttempt = async (attemptNum) => {
        const modes = roleHardcapMode === 'strict' ? ['strict', 'relaxed'] : [roleHardcapMode];
        let currentResult = null;
        let usedMode = roleHardcapMode;
        let lastError = null;

        for (const mode of modes) {
          try {
            currentResult = await attemptWithConstraints(mode);
            usedMode = mode;
            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!currentResult) throw lastError;

        if (usedMode === 'relaxed' && roleHardcapMode !== 'relaxed') {
          // Note: We can't easily update UI state from here without callback, 
          // but we can just log the message.
          if (!autoRelaxMessageShown) {
            appendMessage('기본 모드(±1)로는 스케줄 생성에 실패하여 자동으로 완화 모드(±2)로 전환했습니다.');
            autoRelaxMessageShown = true;
          }
        }

        return currentResult;
      };

      const runAllAttempts = async () => {
        try {
          // Quick fail: 첫 시도로 ILP 가능성 확인
          appendMessage('제약 조건을 확인하는 중...');
          let firstAttempt;
          try {
            firstAttempt = await runSingleAttempt(1);
          } catch (err) {
            // 첫 시도 실패 → 제약이 너무 엄격함
            clearMessages();
            appendMessage(`스케줄 생성 실패: ${err.message}`, 'error');
            appendMessage('제약 조건이 너무 엄격합니다. 다음을 시도해보세요:', 'warn');
            appendMessage('1. "주간 근무시간 상한" 토글 해제', 'warn');
            appendMessage('2. "Day-off 균형 제약" 토글 해제', 'warn');
            appendMessage('3. "역할 편차 완화 모드" 체크', 'warn');
            appendMessage('4. 달력에서 강제 배정/금지 줄이기', 'warn');
            setLoading(false);
            disableActions(false);
            return;
          }

          // 첫 시도 성공 → 나머지 시도
          results.push(firstAttempt);
          appendMessage(`제약 조건 확인 완료! 총 ${MAX_ATTEMPTS}개의 스케줄을 생성합니다...`);

          const attemptPromises = [];
          for (let i = 2; i <= MAX_ATTEMPTS; i++) {
            attemptPromises.push(
              runSingleAttempt(i).catch(err => {
                console.warn(`Attempt ${i} failed:`, err.message);
                return null;
              })
            );
          }

          const allResults = await Promise.all(attemptPromises);
          const successfulResults = allResults.filter(r => r !== null);

          results.push(...successfulResults);
          evaluateAndRender(results, params);
        } catch (err) {
          const detailedError = `오류 발생: ${err.message}\n\nStack Trace:\n${err.stack}`;
          console.error(err);
          clearMessages();
          appendMessage(detailedError.replace(/\n/g, '<br>'));
          setLoading(false);
          disableActions(false);
        }
      };

      const evaluateAndRender = (finalResults, params) => {
        if (finalResults.length === 0) {
          appendMessage("모든 스케줄 생성 시도에 실패했습니다. 입력값을 확인해주세요.");
          setLoading(false);
          disableActions(false);
          return;
        }

        appendMessage('생성된 스케줄들을 새로운 점수 체계로 평가합니다...');
        const weights = getScoreWeights(params.scoreConfigs); // Use configs from params

        const scoredResults = finalResults.map((res) => {
          recomputeStatsInPlace(res);
          const perClassScore = new Map();
          const carryoverPerClass = new Map();
          const hourPerClass = new Map();
          const gapPerClass = new Map();
          const friSunPerClass = new Map();
          const weeklyPerClass = new Map();

          const hourScore = calculateHourScore(res, hourPerClass, weights);
          const carryoverScore = calculateCarryoverScore(res, carryoverPerClass, weights, params.prevStats);
          const gapScore = calculateGapPenalty(res, gapPerClass, weights);
          const friSunScore = calculateFriSunPenalty(res, friSunPerClass, weights);
          const weeklyDutyScore = calculateWeeklyDutyPenalty(res, weeklyPerClass, weights);
          const totalScore = hourScore + carryoverScore + gapScore + friSunScore + weeklyDutyScore;

          // Combine into total perClassScore
          for (const klass of ['R1', 'R2', 'R3', 'R4']) {
            const total = (hourPerClass.get(klass) || 0) +
              (carryoverPerClass.get(klass) || 0) +
              (gapPerClass.get(klass) || 0) +
              (friSunPerClass.get(klass) || 0) +
              (weeklyPerClass.get(klass) || 0);
            if (total > 0) perClassScore.set(klass, total);
          }

          const breakdown = {
            hourScore, carryoverScore, gapScore, friSunScore, weeklyDutyScore,
            hourPerClass, carryoverPerClass, gapPerClass, friSunPerClass, weeklyPerClass,
            result: res,
            prevStats: params.prevStats,
            weights
          };
          return { result: res, totalScore, perClassScore, breakdown };
        });

        let baseline = null;
        for (const cand of scoredResults) {
          if (!baseline || cand.totalScore < baseline.totalScore) baseline = cand;
        }

        const classes = ['R1', 'R2', 'R3', 'R4'];
        const bestByClass = new Map();
        for (const k of classes) {
          let best = null;
          let bestScore = Infinity;
          for (const cand of scoredResults) {
            const v = cand.perClassScore.get(k) ?? 0;
            if (v < bestScore) {
              bestScore = v;
              best = cand;
            }
          }
          if (best) bestByClass.set(k, best);
        }

        const merged = stitchSchedulesByClass({ classes, bestByClass, base: baseline, weights, prevStats: params.prevStats });

        let winner = baseline;
        let note = '전체 최저점 스케줄 사용';

        if (merged?.passed && merged.candidate) {
          if (merged.candidate.totalScore < baseline.totalScore) {
            winner = merged.candidate;
            note = merged.note;
          } else {
            note = `전체 최저점 스케줄 사용 (조합 스케줄 점수: ${merged.candidate.totalScore}, 기본 스케줄 점수: ${baseline.totalScore})`;
          }
        }

        appendMessage(note, 'warn');

        lastResult = winner.result;
        renderResults(lastResult, params.prevStats);

        if (document.getElementById('toggle-diagnostics')?.checked) {
          try { renderScoreBreakdown(winner); } catch { }
        }

        enableExportButtons(true);
        setLoading(false);
        disableActions(false);
      };

      runAllAttempts();

    } catch (err) {
      console.error(err);
      appendMessage(err.message || String(err));
      enableExportButtons(false);
    }
  } catch (err) {
    console.error(err);
    appendMessage(err.message || String(err));
    setLoading(false);
    disableActions(false);
    enableExportButtons(false);
  }
}

function onExportXlsx() {
  if (!lastResult) return;
  const summaryRows = [];
  summaryRows.push([{ v: '당직표', style: 'Header' }]);
  summaryRows.push([]);
  summaryRows.push([{ v: '날짜', style: 'Header' }, { v: '병당', style: 'Header' }, { v: '응당', style: 'Header' }, { v: '응급 back', style: 'Header' }]);
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

  const params = getGenerationParams();
  const prev = params.prevStats;
  const carryRows = buildCarryoverRows(lastResult, prev);
  summaryRows.push([]);
  summaryRows.push([{ v: '다음달 반영', style: 'Header' }]);
  for (const r of carryRows) summaryRows.push(r);

  const prevRows = buildPreviousAdjustRows(lastResult, prev);
  summaryRows.push([]);
  summaryRows.push([{ v: '지난달 반영', style: 'Header' }]);
  for (const r of prevRows) summaryRows.push(r);

  const linksRows = [[{ v: '이름', style: 'Header' }, { v: 'ICS', style: 'Header' }]];
  const base = getComputedIcsBase(params.icsVersion, lastResult);
  const monthKey = dominantMonthKey(lastResult) || (lastResult.startDate || '').slice(0, 7) || 'YYYY-MM';
  const version = params.icsVersion || 'v1';
  linksRows.push([{ v: '월', style: 'Header' }, monthKey || '-']);
  linksRows.push([{ v: '버전', style: 'Header' }, version]);
  linksRows.push([{ v: '기본 경로', style: 'Header' }, base || '미설정(링크 비활성)']);
  for (const e of lastResult.employees) {
    if (!hasDutiesFor(lastResult, e.name)) continue;
    let cell = { v: '설정 필요' };
    if (base) {
      const fname = safePersonFilename(e.name) + '.ics';
      const href = joinUrl(base, encodeURIComponent(fname));
      cell = { v: `${e.name}.ics`, href };
    }
    linksRows.push([e.name, cell]);
  }
  const xml = buildSpreadsheetXML([
    { name: 'Summary', rows: summaryRows },
    { name: 'ICS Links', rows: linksRows },
  ]);
  const fileMonth = monthKey;
  const verSafe = String(version).replace(/[^\w\-\.]+/g, '_');
  download(`duty-roster-${fileMonth}-${verSafe}.xls`, xml);
}

function onExportIcs() {
  if (!lastResult) return;
  const emps = lastResult.employees || [];
  const files = [];
  for (const e of emps) {
    const name = e.name;
    if (!hasDutiesFor(lastResult, name)) continue;
    const icsText = buildICS(lastResult, { nameFilter: name, includeBack: false });
    const bytes = new TextEncoder().encode(icsText);
    const fname = safePersonFilename(name);
    files.push({ name: `${fname}.ics`, bytes });
  }
  if (files.length === 0) return;
  const zip = buildZip(files);
  const monthKey = dominantMonthKey(lastResult) || (lastResult.startDate || '').slice(0, 7) || 'YYYY-MM';
  const params = getGenerationParams();
  const version = params.icsVersion || 'v1';
  const verSafe = String(version).replace(/[^\w\-\.]+/g, '_');
  download(`duty-roster-${monthKey}-${verSafe}.zip`, zip);
}

// Helper for random seed
let scheduleSeedCounter = 0;
function nextRandomSeed() {
  try {
    if (window.crypto?.getRandomValues) {
      const arr = new Uint32Array(1);
      window.crypto.getRandomValues(arr);
      return arr[0] >>> 0;
    }
  } catch { }
  scheduleSeedCounter += 1;
  const base = Date.now() & 0xffffffff;
  const extra = Math.floor(Math.random() * 0xffffffff);
  return (base ^ extra ^ scheduleSeedCounter) >>> 0;
}



// Initialize
initializeUI();
bindEvents({
  onGenerate,
  onExportXlsx,
  onExportIcs
});
