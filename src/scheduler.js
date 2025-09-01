// 스케줄링 엔진 (초안)
// 규칙 요약:
// - 하루 2명 당직
// - 당직 다음날은 정규근무 오프 (당직 불가)
// - 주간 근무시간 72시간 초과 금지
//   * 정규근무: 월–금 8시간 가정
//   * 당직: 24시간 가정

import { addDays, isWorkday, weekKey, fmtDate, rangeDays, weekKeyByMode, allWeekKeysInRange } from './time.js';

// preference: 'any' | 'weekday' | 'weekend'
// optimization: 'off' | 'fast' | 'medium' | 'strong'
export function generateSchedule({ startDate, endDate = null, weeks = 4, weekMode = 'calendar', employees, holidays = [], unavailableByName = {}, vacationWeeksByName = {}, optimization = 'medium', weekdaySlots = 1, weekendSlots = 2, timeBudgetMs = 2000 }) {
  if (!employees || employees.length < 2) {
    throw new Error('근무자는 2명 이상 필요합니다.');
  }

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) throw new Error('시작일이 올바르지 않습니다.');

  let totalDays = weeks * 7;
  if (endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    if (Number.isNaN(e.getTime())) throw new Error('종료일이 올바르지 않습니다.');
    if (e < s) throw new Error('종료일이 시작일보다 빠릅니다.');
    totalDays = Math.floor((e - s) / (1000 * 60 * 60 * 24)) + 1;
  }
  const days = rangeDays(start, totalDays);
  const holidaySet = new Set(holidays);
  const WEEK_MAX = 72; // 주당 상한 72h (엄격)

  // 주 단위 키 추출 (월요일 시작)
  const weekKeys = allWeekKeysInRange(start, totalDays, weekMode);

  // 직원 상태 초기화
  const people = employees.map((emp, idx) => ({
    id: idx,
    name: typeof emp === 'string' ? emp : emp.name,
    preference: normalizePref(typeof emp === 'string' ? 'any' : emp.preference),
    // 주별 근무시간: 베이스라인 0에서 시작 (정규는 이후 날짜별로 2명만 +11h 반영)
    weeklyHours: Object.fromEntries(
      weekKeys.map((wk) => [wk, 0])
    ),
    dutyCount: 0,
    weekdayDutyCount: 0,
    weekendDutyCount: 0,
    lastDutyIndex: -999,
    offDayKeys: new Set(), // 당직 다음날 (정규근무 오프, 당직 불가)
    unavailable: new Set(unavailableByName[(typeof emp === 'string' ? emp : emp.name)] || []),
    vacationWeeks: new Set(vacationWeeksByName[(typeof emp === 'string' ? emp : emp.name)] || []),
  }));

  // 개인별 총합 상한(휴가 주 제외) 계산 (스케줄링 전에 필요)
  for (const p of people) {
    const effectiveWeeks = weekKeys.filter((wk) => !p.vacationWeeks.has(wk)).length;
    p.totalCapHours = 72 * effectiveWeeks;
  }

  // 결과 구조
  const schedule = days.map((date, idx) => ({
    date,
    key: fmtDate(date),
    weekKey: weekKeyByMode(date, start, weekMode),
    duties: [], // [{id, name}]
    regulars: [], // [{id, name}] — 평일 정규 2명
    underfilled: false,
    reasons: [],
  }));

  // 메인 할당 루프
  const warnings = [];
  const meta = { elapsedMs: 0 };
  for (let i = 0; i < schedule.length; i += 1) {
    const cell = schedule[i];
    const slots = isWorkday(cell.date, holidaySet) ? Math.max(1, Math.min(2, weekdaySlots)) : Math.max(1, weekendSlots);
    for (let slot = 0; slot < slots; slot += 1) {
      const result = pickCandidate({ index: i, date: cell.date, schedule, people, holidaySet });

      if (!result.person) {
        cell.underfilled = true; // 규칙 준수 내에서 미충원
        if (result.reasons && result.reasons.length) {
          cell.reasons = summarizeReasons(result.reasons);
        }
        continue;
      }
      const picked = result.person;
      cell.duties.push({ id: picked.id, name: picked.name });
      applyAssignment({ person: picked, index: i, date: cell.date, holidaySet });
    }
  }

  // 선택적 최적화 (총근무시간/주별 편차 완화)
  const map = schedule.map((d) => d.duties.map((x) => x.id));
  let regularsAlreadyApplied = false;
  if (optimization && optimization !== 'off') {
    // 시간 예산 내에서 다중 재시도: strong은 더 많은 재시작/이터레이션
    const startTs = Date.now();
    const timeBudget = Math.max(500, Math.min(20000, Number(timeBudgetMs) || 2000));
    const baseAttempts = optimization === 'strong' ? 16 : (optimization === 'medium' ? 4 : 1);
    let tries = 0;
    let bestOpt = null;
    while (tries < baseAttempts && (Date.now() - startTs) < timeBudget) {
      const remainingMs = timeBudget - (Date.now() - startTs);
      const res = optimizeBySA({ map, days, people, weekKeys, start, totalDays, holidaySet, level: optimization, timeBudgetMs: remainingMs });
      tries += 1;
      if (res && res.accepted) {
        if (!bestOpt || res.objective < bestOpt.objective) bestOpt = res;
      }
    }
    if (bestOpt) {
      for (let i = 0; i < schedule.length; i += 1) {
        schedule[i].duties = (bestOpt.map[i] || []).map((id) => {
          const p = people.find((pp) => pp.id === id);
          return { id: p.id, name: p.name };
        });
      }
      applyPeopleState(people, bestOpt.peopleSim);
      warnings.push(...bestOpt.warningsAfter);
      regularsAlreadyApplied = true; // 평가 단계에서 정규(+11h×2) 이미 반영됨
      meta.elapsedMs = Date.now() - startTs;
    } else {
      for (const p of people) { collectWeeklyWarnings(p, warnings, WEEK_MAX); collectTotalWarning(p, warnings, p.totalCapHours); }
    }
  } else {
    // (정규 반영 전) 일단 경고는 보류하고, 정규 반영 후 재계산
  }

  // 최종 duties를 기준으로 정규/당직 시간 재계산 (원천 ledger에서 파생)
  rebuildFromLedger();
  // 경고/총합 재계산
  warnings.length = 0;
  for (const p of people) { collectWeeklyWarnings(p, warnings, WEEK_MAX); collectTotalWarning(p, warnings, p.totalCapHours); }

  // 공정성 지표: 당직 시간의 평균 대비 편차
  const totalDutyHours = people.reduce((acc, p) => acc + (p._dutyHoursAccum || 0), 0);
  const avgDutyHours = totalDutyHours / people.length;
  const totals = people.map((p) => Object.values(p.weeklyHours).reduce((a, b) => a + b, 0));
  const totalSum = totals.reduce((a, b) => a + b, 0);
  const avgTotalHours = totalSum / people.length;

  return {
    startDate: fmtDate(start),
    weeks,
    holidays: [...holidaySet],
    employees: people.map((p) => ({ id: p.id, name: p.name, preference: p.preference })),
    endDate: endDate ? fmtDate(addDays(start, totalDays - 1)) : null,
    schedule,
    config: { weekMode, weekdaySlots: Math.max(1, Math.min(2, weekdaySlots)), weekendSlots: Math.max(1, weekendSlots) },
    warnings,
    stats: people.map((p, i) => ({
      id: p.id,
      name: p.name,
      dutyCount: p.dutyCount,
      weekdayDutyCount: p.weekdayDutyCount,
      weekendDutyCount: p.weekendDutyCount,
      dutyHours: Math.round((p._dutyHoursAccum || 0)),
      weeklyHours: p.weeklyHours,
      totalHours: totals[i],
      dutyHoursDelta: round1((p._dutyHoursAccum || 0) - avgDutyHours),
      totalHoursDelta: round1(totals[i] - avgTotalHours),
    })),
    fairness: { avgDutyHours: round1(avgDutyHours), totalDutyHours, avgTotalHours: round1(avgTotalHours) },
  };

  // 내부 유틸
  function collectWeeklyWarnings(p, warningsArr, WEEK_MAX_VAL) {
    for (const wk of Object.keys(p.weeklyHours)) {
      if (p.weeklyHours[wk] > WEEK_MAX_VAL + 1e-9) {
        warningsArr.push(`${p.name}의 ${wk} 주간 시간이 ${WEEK_MAX_VAL}h를 초과했습니다: ${p.weeklyHours[wk]}h`);
      }
    }
  }

  function collectTotalWarning(p, warningsArr, TOTAL_MAX_VAL) {
    const total = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
    if (total > TOTAL_MAX_VAL + 1e-9) warningsArr.push(`${p.name}의 총합 시간이 ${TOTAL_MAX_VAL}h를 초과했습니다: ${Math.round(total)}h`);
  }

  // 베이스라인 정규근무는 0으로 모델링 (정규는 ledger 재계산에서 날짜별 2명만 +11h 반영)
  function baselineRegularForWeek() { return 0; }

  function pickCandidate({ index, date, schedule, people, holidaySet }) {
    const todayKey = fmtDate(date);
    const wk = weekKeyByMode(date, start, weekMode);
    const next = addDays(date, 1);
    const nextWk = weekKeyByMode(next, start, weekMode);
    const isNextWorkday = isWorkday(next, holidaySet);
    const isTodayWorkday = isWorkday(date, holidaySet);

    const takenIds = new Set(schedule[index].duties.map((d) => d.id));
    const isTodayWeekendLike = !isWorkday(date, holidaySet);
    // 전날 야간당직(18~07) 직후 바로 주말/공휴일 24h 당직 금지 (연속 >24h 방지)
    const prevNightDutyIds = new Set();
    if (isTodayWeekendLike && index > 0) {
      for (const d of schedule[index - 1].duties) prevNightDutyIds.add(d.id);
    }

    // 단계별 필터로 사유 수집
    const stage = { offday: [], preference: [], unavailable: [], vacation: [], overWeek_today: [], overWeek_next: [], overTotal: [] };
    let pool = people.filter((p) => !takenIds.has(p.id));

    const afterOff = [];
    for (const p of pool) (p.offDayKeys.has(todayKey) ? stage.offday : afterOff).push(p);
    pool = afterOff;

    // 주말/휴일: 전날 야간당직자 제외
    if (isTodayWeekendLike && prevNightDutyIds.size) {
      const afterPrev = [];
      for (const p of pool) (prevNightDutyIds.has(p.id) ? stage.offday : afterPrev).push(p);
      pool = afterPrev;
    }

    const afterPref = [];
    for (const p of pool) (allowByPreference(p.preference, isTodayWorkday) ? afterPref : stage.preference).push(p);
    pool = afterPref;

    const afterUnavail = [];
    for (const p of pool) ((p.unavailable && p.unavailable.has(todayKey)) ? stage.unavailable : afterUnavail).push(p);
    pool = afterUnavail;

    const afterVacation = [];
    for (const p of pool) ((p.vacationWeeks && p.vacationWeeks.has(wk)) ? stage.vacation : afterVacation).push(p);
    pool = afterVacation;

    // 오늘 주간 상한 체크
    const afterToday = [];
    for (const p of pool) {
      const addDuty = isTodayWorkday ? 13 : 24; // 평일+13h, 휴일/주말+24h
      const simToday = (p.weeklyHours[wk] ?? 0) + addDuty; // 평일 당일 정규 11h는 유지 (대체 X)
      if (simToday > WEEK_MAX + 1e-9) stage.overWeek_today.push(p); else afterToday.push(p);
    }
    pool = afterToday;

    // 스코어링 (공평성 강화: 전체 총근무시간을 우선 고려)
    const candidates = pool
      .map((p) => {
        const totalHours = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
        return { p, score: [p.dutyCount, totalHours, p.weeklyHours[wk], -(index - p.lastDutyIndex)] };
      })
      .sort((a, b) => {
        for (let i = 0; i < a.score.length; i += 1) {
          if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i];
        }
        return 0;
      })
      .map((x) => x.p);

    for (const p of candidates) {
      // 총합 상한 체크 (정규는 후처리이므로 여기서는 당직 영향만 고려)
      const totalNow = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
      const deltaTotal = (isTodayWorkday ? 13 : 24);
      const totalCap = p.totalCapHours ?? (72 * weeks); // fallback
      if (totalNow + deltaTotal > totalCap + 1e-9) { stage.overTotal.push(p); continue; }
      return { person: p, reasons: [] };
    }

    const reasons = [];
    if (stage.offday.length) reasons.push(['전일 당직 오프', stage.offday.length]);
    if (stage.preference.length) reasons.push(['선호 불일치', stage.preference.length]);
    if (stage.unavailable.length) reasons.push(['불가일', stage.unavailable.length]);
    if (stage.vacation.length) reasons.push(['휴가 주 제외', stage.vacation.length]);
    if (stage.overWeek_today.length) reasons.push([`주간상한 초과(당일>${WEEK_MAX}h)`, stage.overWeek_today.length]);
    if (stage.overWeek_next.length) reasons.push([`주간상한 초과(다음날>${WEEK_MAX}h)`, stage.overWeek_next.length]);
    if (stage.overTotal.length) reasons.push(['총합상한 초과', stage.overTotal.length]);
    return { person: null, reasons };
  }

  function applyAssignment({ person, index, date, holidaySet }) {
    const wk = weekKeyByMode(date, start, weekMode);
    const isTodayWorkday = isWorkday(date, holidaySet);
    const addDuty = isTodayWorkday ? 13 : 24;
    person.weeklyHours[wk] = Math.max(0, (person.weeklyHours[wk] ?? 0) + addDuty);
    person._dutyHoursAccum = (person._dutyHoursAccum || 0) + addDuty;
    person.dutyCount += 1;
    if (isTodayWorkday) person.weekdayDutyCount += 1; else person.weekendDutyCount += 1;
    person.lastDutyIndex = index;

    // 다음날 오프: 주말/공휴일 당직(24h)만 즉시 오프
    if (!isTodayWorkday) {
      const next = addDays(date, 1);
      const nKey = fmtDate(next);
      person.offDayKeys.add(nKey);
    }
  }

  function normalizePref(pref) {
    const p = String(pref || 'any').toLowerCase();
    if (p.startsWith('weekend') || p === '주말') return 'weekend';
    if (p.startsWith('weekday') || p === '평일') return 'weekday';
    return 'any';
  }

  function allowByPreference(pref, isWorkdayFlag) {
    if (pref === 'weekday') return isWorkdayFlag;
    if (pref === 'weekend') return !isWorkdayFlag;
    return true;
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function summarizeReasons(entries) {
    // entries: [label, count][] -> ['label: N명', ...]
    return entries.map(([label, count]) => `${label}: ${count}명`);
  }

  // 로컬 스왑 최적화
  function optimizeBySA({ map, days, people, weekKeys, start, totalDays, holidaySet, level, timeBudgetMs = 2000 }) {
    // 초기 평가
    let current = map.map((arr) => arr.slice());
    let best = evaluateMap(current);
    if (!best.valid) return null;
    let curObj = best.objective;
    let bestMap = current.map((a) => a.slice());
    let bestEval = best;

    // 파라미터 (레벨별 시도 횟수와 냉각률)
    const params = {
      fast: { iters: Math.max(5000, days.length * 40), startT: 1.5, cool: 0.998 },
      medium: { iters: Math.max(20000, days.length * 80), startT: 2.0, cool: 0.9987 },
      // Option B: strong 이터레이션 상향 (재시작 16회 유지)
      strong: { iters: Math.max(30000, days.length * 120), startT: 3.0, cool: 0.999 },
    }[level] || { iters: 0 };
    if (!params.iters) return { accepted: false };

    let T = params.startT;
    const endTs = Date.now() + Math.max(200, Math.min(20000, Number(timeBudgetMs) || 2000));
    let noImprove = 0;
    for (let step = 0; step < params.iters; step += 1) {
      if (Date.now() > endTs) break; // 시간 예산 초과 시 중단
      const proposal = current.map((arr) => arr.slice());
      // 무브 선택: 1-move 60%, 2-swap 40%
      if (Math.random() < 0.6) {
        // 1-move: 한 날짜의 한 슬롯을 다른 날짜의 다른 사람으로 교체
        let i = Math.floor(Math.random() * days.length);
        const di = proposal[i] || [];
        if (di.length === 0) continue;
        const si = Math.floor(Math.random() * di.length);

        // 대체 후보 찾기: 가능한 날짜 j, 그 날의 인원들 중 중복 없이 하나 선택
        let j = Math.floor(Math.random() * days.length);
        let guard = 0;
        while (guard++ < 10 && (j === i || (proposal[j] || []).length === 0)) j = Math.floor(Math.random() * days.length);
        const dj = proposal[j] || [];
        const sj = Math.floor(Math.random() * dj.length);
        const cand = dj[sj];
        // 같은 날 중복 방지
        if (proposal[i].includes(cand) && di[si] !== cand) continue;
        proposal[i][si] = cand;
      } else {
        // 2-swap: 서로 교환
        let i = Math.floor(Math.random() * days.length);
        let j = Math.floor(Math.random() * days.length);
        if (i === j) { j = (j + 1) % days.length; }
        const di = proposal[i] || [];
        const dj = proposal[j] || [];
        if (di.length === 0 || dj.length === 0) continue;
        const si = Math.floor(Math.random() * di.length);
        const sj = Math.floor(Math.random() * dj.length);
        if (di[si] === dj[sj]) continue;
        // 중복 방지
        if (proposal[i].includes(dj[sj]) || proposal[j].includes(di[si])) continue;
        const tmp = proposal[i][si];
        proposal[i][si] = proposal[j][sj];
        proposal[j][sj] = tmp;
      }

      const evalRes = evaluateMap(proposal);
      if (!evalRes.valid) {
        // 불만족 move는 버림
      } else {
        const dObj = evalRes.objective - curObj;
        if (dObj <= 0 || Math.random() < Math.exp(-dObj / Math.max(1e-6, T))) {
          current = proposal;
          curObj = evalRes.objective;
          if (curObj < best.objective - 1e-9) {
            best = evalRes;
            bestMap = proposal.map((a) => a.slice());
            bestEval = evalRes;
            noImprove = 0;
          }
        }
      }
      T *= params.cool;
      // 개선 정체 시 조기 종료
      if (noImprove > Math.max(1000, Math.floor(params.iters * 0.1))) break;
    }

    if (best.objective < Number.POSITIVE_INFINITY) {
      return { accepted: true, map: bestMap, peopleSim: bestEval.peopleSim, warningsAfter: bestEval.warnings };
    }
    return { accepted: false };

    function evaluateMap(assignMap) {
      // 사람 상태 초기화 (베이스라인 0; 정규는 후처리)
      const sim = people.map((p) => ({
        id: p.id,
        name: p.name,
        preference: p.preference,
        unavailable: p.unavailable,
        vacationWeeks: p.vacationWeeks,
        totalCapHours: p.totalCapHours,
        weeklyHours: Object.fromEntries(
          weekKeys.map((wk) => [wk, 0])
        ),
        dutyCount: 0,
        weekdayDutyCount: 0,
        weekendDutyCount: 0,
        _dutyHoursAccum: 0,
        lastDutyIndex: -999,
        offDayKeys: new Set(),
      }));

      const warningsSim = [];
      for (let d = 0; d < days.length; d += 1) {
        const date = days[d];
        const wk = weekKeyByMode(date, start, weekMode);
        const todayKey = fmtDate(date);
        const isTodayWorkday = isWorkday(date, holidaySet);
        const ids = assignMap[d] || [];
        // 중복 인물 체크
        if (new Set(ids).size !== ids.length) return { valid: false };
        for (let s = 0; s < ids.length; s += 1) {
          const id = ids[s];
          const p = sim.find((x) => x.id === id);
          if (!p) return { valid: false };
          // 제약 검사
          if (p.offDayKeys.has(todayKey)) return { valid: false };
          if (p.unavailable && p.unavailable.has(todayKey)) return { valid: false };
          if (p.vacationWeeks && p.vacationWeeks.has(wk)) return { valid: false };
          if (!allowByPreference(p.preference, isTodayWorkday)) return { valid: false };
          // 주말/공휴일 24h는 전날 야간당직 직후 배정 금지 (연속 >24h 방지)
          if (!isTodayWorkday && d > 0) {
            const prevIds = new Set(assignMap[d - 1] || []);
            if (prevIds.has(id)) return { valid: false };
          }
          const addDuty = isTodayWorkday ? 13 : 24;
          const simToday = (p.weeklyHours[wk] ?? 0) + addDuty;
          if (simToday > WEEK_MAX + 1e-9) return { valid: false };
          // 적용
          p.weeklyHours[wk] = Math.max(0, simToday);
          p.dutyCount += 1;
          if (isTodayWorkday) p.weekdayDutyCount += 1; else p.weekendDutyCount += 1;
          p._dutyHoursAccum += addDuty;
          p.lastDutyIndex = d;
          // 다음날 오프: 주말/공휴일 당직(24h)만 즉시 오프
          if (!isTodayWorkday) {
            const next = addDays(date, 1);
            const nKey = fmtDate(next);
            p.offDayKeys.add(nKey);
          }
        }
      }
      // 평일 정규 2명 반영
      for (let d = 0; d < days.length; d += 1) {
        const date = days[d];
        if (!isWorkday(date, holidaySet)) continue;
        const wk = weekKeyByMode(date, start, weekMode);
        const key = fmtDate(date);
        const pool = sim
          .filter((p) => !(p.vacationWeeks && p.vacationWeeks.has(wk)))
          .filter((p) => !(p.offDayKeys && p.offDayKeys.has(key)))
          .filter((p) => !(p.unavailable && p.unavailable.has(key)));
        const scored = pool.map((p) => {
          const totalHours = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
          return { p, score: [p.weeklyHours[wk] || 0, totalHours, p.dutyCount, -(d - p.lastDutyIndex)] };
        }).sort((a, b) => {
          for (let i = 0; i < a.score.length; i += 1) { if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i]; }
          return 0;
        }).map((x) => x.p);
        const pick = scored.slice(0, 2);
        for (const p of pick) { p.weeklyHours[wk] = (p.weeklyHours[wk] || 0) + 11; }
        // 평일 24h인 경우(정규+당직) 다음날 오프
        const dutyIds = new Set(assignMap[d] || []);
        const next = addDays(date, 1);
        const nKey = fmtDate(next);
        for (const p of pick) { if (dutyIds.has(p.id)) p.offDayKeys.add(nKey); }
      }

      // 주간 경고 집계 및 목적함수 계산
      for (const p of sim) collectWeeklyWarnings(p, warningsSim, WEEK_MAX);
      // (주간 상한은 경고 수준으로 유지)
      // 총합 상한 검사 (개인별 cap)
      for (const p of sim) {
        const total = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
        const cap = p.totalCapHours ?? (72 * weekKeys.length);
        if (total > cap + 1e-9) return { valid: false };
      }
      const totals = sim.map((p) => Object.values(p.weeklyHours).reduce((a, b) => a + b, 0));
      const avg = totals.reduce((a, b) => a + b, 0) / sim.length;
      // 목적함수: 1순위 총 근무시간 분산, 2순위 개인 내 주별 편차
      const varTotal = totals.reduce((acc, t) => acc + (t - avg) * (t - avg), 0);
      let smooth = 0;
      // 개인별로 주간 시간의 분산을 합산(주별 편차가 작을수록 작아짐)
      for (const p of sim) {
        const vals = weekKeys.map((wk) => p.weeklyHours[wk] || 0);
        const m = vals.reduce((a, b) => a + b, 0) / vals.length;
        smooth += vals.reduce((acc, v) => acc + (v - m) * (v - m), 0);
      }
      const WEIGHTS = { total: 1.0, smooth: 0.5 };
      const objective = WEIGHTS.total * varTotal + WEIGHTS.smooth * smooth;
      return { valid: true, objective, peopleSim: sim, warnings: warningsSim };
    }
  }

  function applyPeopleState(target, source) {
    for (let i = 0; i < target.length; i += 1) {
      target[i].weeklyHours = source[i].weeklyHours;
      target[i].dutyCount = source[i].dutyCount;
      target[i].weekdayDutyCount = source[i].weekdayDutyCount;
      target[i].weekendDutyCount = source[i].weekendDutyCount;
      target[i]._dutyHoursAccum = source[i]._dutyHoursAccum;
      target[i].lastDutyIndex = source[i].lastDutyIndex;
      target[i].offDayKeys = source[i].offDayKeys;
    }
  }

  function rebuildFromLedger() {
    // 초기화
    for (const p of people) {
      p.weeklyHours = Object.fromEntries(weekKeys.map((wk) => [wk, 0]));
      p.dutyCount = 0; p.weekdayDutyCount = 0; p.weekendDutyCount = 0;
      p._dutyHoursAccum = 0; p.offDayKeys = new Set();
      p.lastDutyIndex = -999;
    }
    // 1) 당직 시간 누적 및 24h 오프로 인한 off 설정(주말/공휴일)
    for (let i = 0; i < schedule.length; i += 1) {
      const cell = schedule[i];
      const d = cell.date; const wk = weekKeyByMode(d, start, weekMode);
      const isWkday = isWorkday(d, holidaySet);
      for (const duty of cell.duties) {
        const p = people.find((x) => x.id === duty.id);
        if (!p) continue;
        const add = isWkday ? 13 : 24;
        p.weeklyHours[wk] = (p.weeklyHours[wk] || 0) + add;
        p._dutyHoursAccum += add;
        p.dutyCount += 1;
        if (isWkday) p.weekdayDutyCount += 1; else p.weekendDutyCount += 1;
        p.lastDutyIndex = i;
        if (!isWkday) {
          const nKey = fmtDate(addDays(d, 1));
          p.offDayKeys.add(nKey);
        }
      }
    }
    // 2) 평일 정규 2명 선발(+11h) 및 24h(정규+당직) 다음날 오프
    for (let i = 0; i < schedule.length; i += 1) {
      const cell = schedule[i]; const d = cell.date;
      if (!isWorkday(d, holidaySet)) { cell.regulars = []; continue; }
      const wk = weekKeyByMode(d, start, weekMode); const key = fmtDate(d);
      const pool = people
        .filter((p) => !(p.vacationWeeks && p.vacationWeeks.has(wk)))
        .filter((p) => !(p.offDayKeys && p.offDayKeys.has(key)))
        .filter((p) => !(p.unavailable && p.unavailable.has(key)));
      const scored = pool.map((p) => {
        const totalHours = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
        return { p, score: [p.weeklyHours[wk] || 0, totalHours, p.dutyCount, -(i - p.lastDutyIndex)] };
      }).sort((a, b) => {
        for (let k = 0; k < a.score.length; k += 1) { if (a.score[k] !== b.score[k]) return a.score[k] - b.score[k]; }
        return 0;
      }).map((x) => x.p);
      const pick = scored.slice(0, 2);
      for (const p of pick) p.weeklyHours[wk] = (p.weeklyHours[wk] || 0) + 11;
      cell.regulars = pick.map((p) => ({ id: p.id, name: p.name }));
      const dutyIds = new Set(cell.duties.map((dd) => dd.id));
      if (dutyIds.size > 0) {
        const nKey = fmtDate(addDays(d, 1));
        for (const p of pick) if (dutyIds.has(p.id)) p.offDayKeys.add(nKey);
      }
    }
  }
}
