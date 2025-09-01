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
export function generateSchedule({ startDate, endDate = null, weeks = 4, weekMode = 'calendar', employees, holidays = [], unavailableByName = {}, vacationWeeksByName = {}, optimization = 'medium' }) {
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
    weeklyHours: Object.fromEntries(
      weekKeys.map((wk) => [wk, baselineRegularForWeek(wk, start, totalDays, holidaySet, weekMode, (vacationWeeksByName[(typeof emp === 'string' ? emp : emp.name)] || []).includes(wk))])
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
    underfilled: false,
    reasons: [],
  }));

  // 메인 할당 루프
  const warnings = [];
  for (let i = 0; i < schedule.length; i += 1) {
    const cell = schedule[i];
    const slots = isWorkday(cell.date, holidaySet) ? 1 : 2; // 평일 1명, 주말/공휴일 2명
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

  // 선택적 최적화 (총근무시간 편차 완화)
  const map = schedule.map((d) => d.duties.map((x) => x.id));
  if (optimization && optimization !== 'off') {
    const optimized = optimizeBySA({
      map,
      days,
      people,
      weekKeys,
      start,
      totalDays,
      holidaySet,
      level: optimization,
    });
    if (optimized && optimized.accepted) {
      for (let i = 0; i < schedule.length; i += 1) {
        schedule[i].duties = (optimized.map[i] || []).map((id) => {
          const p = people.find((pp) => pp.id === id);
          return { id: p.id, name: p.name };
        });
      }
      applyPeopleState(people, optimized.peopleSim);
      warnings.push(...optimized.warningsAfter);
    } else {
      for (const p of people) { collectWeeklyWarnings(p, warnings, WEEK_MAX); collectTotalWarning(p, warnings, p.totalCapHours); }
    }
  } else {
    for (const p of people) { collectWeeklyWarnings(p, warnings, WEEK_MAX); collectTotalWarning(p, warnings, p.totalCapHours); }
  }

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

  function baselineRegularForWeek(wk, start, totalDays, holidaySet, mode, onVacation = false) {
    if (onVacation) return 0;
    // 주 내에서 이 범위에 포함된 평일 수 * 8h
    const [y, m, d] = wk.split('-').map((v) => parseInt(v, 10));
    // wk는 해당 주의 시작 날짜 문자열 (mode에 따라 월요일 또는 시작일 기준 7일 단위)
    const weekStart = new Date(y, m - 1, d);
    let hours = 0;
    for (let i = 0; i < 7; i += 1) {
      const dt = addDays(weekStart, i);
      // 범위 내인지
      const inRange = dt >= start && dt < addDays(start, totalDays);
      if (inRange && isWorkday(dt, holidaySet)) hours += 11; // 평일 정규 11h
    }
    return hours;
  }

  function pickCandidate({ index, date, schedule, people, holidaySet }) {
    const todayKey = fmtDate(date);
    const wk = weekKeyByMode(date, start, weekMode);
    const next = addDays(date, 1);
    const nextWk = weekKeyByMode(next, start, weekMode);
    const isNextWorkday = isWorkday(next, holidaySet);
    const isTodayWorkday = isWorkday(date, holidaySet);

    const takenIds = new Set(schedule[index].duties.map((d) => d.id));

    // 단계별 필터로 사유 수집
    const stage = { offday: [], preference: [], unavailable: [], vacation: [], overWeek_today: [], overWeek_next: [], overTotal: [] };
    let pool = people.filter((p) => !takenIds.has(p.id));

    const afterOff = [];
    for (const p of pool) (p.offDayKeys.has(todayKey) ? stage.offday : afterOff).push(p);
    pool = afterOff;

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
      const nextHours = p.weeklyHours[nextWk] ?? 0;
      const simNext = isNextWorkday ? Math.max(0, nextHours - 11) : nextHours; // 다음날 평일 오프 -11h
      if (simNext > WEEK_MAX + 1e-9) { stage.overWeek_next.push(p); continue; }
      // 총합 상한 체크 (당일/다음날 효과 델타 반영)
      const totalNow = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
      const deltaTotal = (isTodayWorkday ? 13 : 24) - (isNextWorkday ? 11 : 0);
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

    // 다음날 오프(평일이면 해당 주간 8h 감산), 당일+다음날 당직 금지 관리용 offDay 표시
    const next = addDays(date, 1);
    const nKey = fmtDate(next);
    person.offDayKeys.add(nKey);
    const nWk = weekKeyByMode(next, start, weekMode);
    if (isWorkday(next, holidaySet)) {
      person.weeklyHours[nWk] = Math.max(0, (person.weeklyHours[nWk] ?? 0) - 11); // 다음날 평일 -11h
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
  function optimizeBySA({ map, days, people, weekKeys, start, totalDays, holidaySet, level }) {
    // 초기 평가
    let current = map.map((arr) => arr.slice());
    let best = evaluateMap(current);
    if (!best.valid) return null;
    let curObj = best.objective;
    let bestMap = current.map((a) => a.slice());
    let bestEval = best;

    // 파라미터 (레벨별 시도 횟수와 냉각률)
    const params = {
      fast: { iters: Math.max(3000, days.length * 30), startT: 1.5, cool: 0.998 },
      medium: { iters: Math.max(10000, days.length * 60), startT: 2.0, cool: 0.9985 },
      strong: { iters: Math.max(25000, days.length * 120), startT: 3.0, cool: 0.999 },
    }[level] || { iters: 0 };
    if (!params.iters) return { accepted: false };

    let T = params.startT;
    for (let step = 0; step < params.iters; step += 1) {
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
          }
        }
      }
      T *= params.cool;
    }

    if (best.objective < Number.POSITIVE_INFINITY) {
      return { accepted: true, map: bestMap, peopleSim: bestEval.peopleSim, warningsAfter: bestEval.warnings };
    }
    return { accepted: false };

    function evaluateMap(assignMap) {
      // 사람 상태 초기화 (베이스라인 정규근무만 반영)
      const sim = people.map((p) => ({
        id: p.id,
        name: p.name,
        preference: p.preference,
        unavailable: p.unavailable,
        vacationWeeks: p.vacationWeeks,
        totalCapHours: p.totalCapHours,
        weeklyHours: Object.fromEntries(
          weekKeys.map((wk) => [wk, baselineRegularForWeek(wk, start, totalDays, holidaySet, weekMode, p.vacationWeeks.has(wk))])
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
          const addDuty = isTodayWorkday ? 13 : 24;
          const simToday = (p.weeklyHours[wk] ?? 0) + addDuty;
          if (simToday > WEEK_MAX + 1e-9) return { valid: false };
          // 적용
          p.weeklyHours[wk] = Math.max(0, simToday);
          p.dutyCount += 1;
          if (isTodayWorkday) p.weekdayDutyCount += 1; else p.weekendDutyCount += 1;
          p._dutyHoursAccum += addDuty;
          p.lastDutyIndex = d;
          // 다음날 오프 및 다음날 평일 감산
          const next = addDays(date, 1);
          const nKey = fmtDate(next);
          p.offDayKeys.add(nKey);
          if (isWorkday(next, holidaySet)) {
            const nWk = weekKeyByMode(next, start, weekMode);
            p.weeklyHours[nWk] = Math.max(0, (p.weeklyHours[nWk] ?? 0) - 11);
          }
        }
      }
      // 주간 경고 집계 및 목적함수 계산
      for (const p of sim) collectWeeklyWarnings(p, warningsSim, WEEK_MAX);
      // 총합 상한 검사 (개인별 cap)
      for (const p of sim) {
        const total = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
        const cap = p.totalCapHours ?? (72 * weekKeys.length);
        if (total > cap + 1e-9) return { valid: false };
      }
      const totals = sim.map((p) => Object.values(p.weeklyHours).reduce((a, b) => a + b, 0));
      const avg = totals.reduce((a, b) => a + b, 0) / sim.length;
      // 공정성: 총근무시간 분산 + 평일/주말 당직 편차 가중
      const varTotal = totals.reduce((acc, t) => acc + (t - avg) * (t - avg), 0);
      const avgWkday = sim.reduce((a, p) => a + p.weekdayDutyCount, 0) / sim.length;
      const avgWkend = sim.reduce((a, p) => a + p.weekendDutyCount, 0) / sim.length;
      const varWkday = sim.reduce((a, p) => a + (p.weekdayDutyCount - avgWkday) ** 2, 0);
      const varWkend = sim.reduce((a, p) => a + (p.weekendDutyCount - avgWkend) ** 2, 0);
      const objective = varTotal + 5 * (varWkday + varWkend);
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
}
