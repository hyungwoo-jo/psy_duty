// 스케줄링 엔진 (초안)
// 규칙 요약:
// - 하루 2명 당직
// - 당직 다음날은 정규근무 오프 (당직 불가)
// - 주간 근무시간 72시간 초과 금지
//   * 정규근무: 월–금 8시간 가정
//   * 당직: 24시간 가정

import { addDays, isWorkday, weekKey, fmtDate, rangeDays } from './time.js';

// preference: 'any' | 'weekday' | 'weekend'
// optimization: 'off' | 'fast' | 'medium' | 'strong'
export function generateSchedule({ startDate, weeks = 4, employees, holidays = [], unavailableByName = {}, vacationWeeksByName = {}, optimization = 'medium' }) {
  if (!employees || employees.length < 2) {
    throw new Error('근무자는 2명 이상 필요합니다.');
  }

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) throw new Error('시작일이 올바르지 않습니다.');

  const totalDays = weeks * 7;
  const days = rangeDays(start, totalDays);
  const holidaySet = new Set(holidays);
  const WEEK_MAX = 72 + 12; // 주당 상한 (72±12 허용: 상한 84)
  const TOTAL_MAX = 72 * weeks; // 총합 상한 (평균 72 유지)

  // 주 단위 키 추출 (월요일 시작)
  const allWeekKeys = new Set(days.map((d) => weekKey(d)));
  const weekKeys = [...allWeekKeys];

  // 직원 상태 초기화
  const people = employees.map((emp, idx) => ({
    id: idx,
    name: typeof emp === 'string' ? emp : emp.name,
    preference: normalizePref(typeof emp === 'string' ? 'any' : emp.preference),
    weeklyHours: Object.fromEntries(
      weekKeys.map((wk) => [wk, baselineRegularForWeek(wk, start, totalDays, holidaySet, (vacationWeeksByName[(typeof emp === 'string' ? emp : emp.name)] || []).includes(wk))])
    ),
    dutyCount: 0,
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
    weekKey: weekKey(date),
    duties: [], // [{id, name}]
    underfilled: false,
    reasons: [],
  }));

  // 메인 할당 루프
  const warnings = [];
  for (let i = 0; i < schedule.length; i += 1) {
    const cell = schedule[i];
    for (let slot = 0; slot < 2; slot += 1) {
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
  const totalDutyHours = people.reduce((acc, p) => acc + p.dutyCount * 24, 0);
  const avgDutyHours = totalDutyHours / people.length;
  const totals = people.map((p) => Object.values(p.weeklyHours).reduce((a, b) => a + b, 0));
  const totalSum = totals.reduce((a, b) => a + b, 0);
  const avgTotalHours = totalSum / people.length;

  return {
    startDate: fmtDate(start),
    weeks,
    holidays: [...holidaySet],
    employees: people.map((p) => ({ id: p.id, name: p.name, preference: p.preference })),
    schedule,
    warnings,
    stats: people.map((p, i) => ({
      id: p.id,
      name: p.name,
      dutyCount: p.dutyCount,
      dutyHours: p.dutyCount * 24,
      weeklyHours: p.weeklyHours,
      totalHours: totals[i],
      dutyHoursDelta: round1(p.dutyCount * 24 - avgDutyHours),
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

  function baselineRegularForWeek(wk, start, totalDays, holidaySet, onVacation = false) {
    if (onVacation) return 0;
    // 주 내에서 이 범위에 포함된 평일 수 * 8h
    const [y, m, d] = wk.split('-').map((v) => parseInt(v, 10));
    // wk는 해당 주의 월요일 날짜 문자열
    const monday = new Date(y, m - 1, d);
    let hours = 0;
    for (let i = 0; i < 7; i += 1) {
      const dt = addDays(monday, i);
      // 범위 내인지
      const inRange = dt >= start && dt < addDays(start, totalDays);
      if (inRange && isWorkday(dt, holidaySet)) hours += 8;
    }
    return hours;
  }

  function pickCandidate({ index, date, schedule, people, holidaySet }) {
    const todayKey = fmtDate(date);
    const wk = weekKey(date);
    const next = addDays(date, 1);
    const nextWk = weekKey(next);
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

    // 오늘 주간 상한 체크 (완화 모드에서는 건너뜀)
    const afterToday = [];
    for (const p of pool) {
      const simToday = p.weeklyHours[wk] + 24 - (isTodayWorkday ? 8 : 0);
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
      const simNext = isNextWorkday ? nextHours - 8 : nextHours;
      if (simNext > WEEK_MAX + 1e-9) { stage.overWeek_next.push(p); continue; }
      // 총합 상한 체크 (당일/다음날 효과 델타 반영)
      const totalNow = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
      const deltaTotal = 24 - (isTodayWorkday ? 8 : 0) - (isNextWorkday ? 8 : 0);
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
    const wk = weekKey(date);
    person.weeklyHours[wk] = (person.weeklyHours[wk] ?? 0) + 24;
    if (isWorkday(date, holidaySet)) {
      // 당일이 평일이면 정규 8h가 당직으로 대체되므로 8h 감산
      person.weeklyHours[wk] = Math.max(0, person.weeklyHours[wk] - 8);
    }
    person.dutyCount += 1;
    person.lastDutyIndex = index;

    // 다음날 오프(평일이면 해당 주간 8h 감산), 당일+다음날 당직 금지 관리용 offDay 표시
    const next = addDays(date, 1);
    const nKey = fmtDate(next);
    person.offDayKeys.add(nKey);
    const nWk = weekKey(next);
    if (isWorkday(next, holidaySet)) {
      person.weeklyHours[nWk] = (person.weeklyHours[nWk] ?? 0) - 8;
      if (person.weeklyHours[nWk] < 0) person.weeklyHours[nWk] = 0; // 바운드
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
          weekKeys.map((wk) => [wk, baselineRegularForWeek(wk, start, totalDays, holidaySet, p.vacationWeeks.has(wk))])
        ),
        dutyCount: 0,
        lastDutyIndex: -999,
        offDayKeys: new Set(),
      }));

      const warningsSim = [];
      for (let d = 0; d < days.length; d += 1) {
        const date = days[d];
        const wk = weekKey(date);
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
          const simToday = p.weeklyHours[wk] + 24 - (isTodayWorkday ? 8 : 0);
          if (simToday > WEEK_MAX + 1e-9) return { valid: false };
          // 적용
          p.weeklyHours[wk] = Math.max(0, simToday);
          p.dutyCount += 1;
          p.lastDutyIndex = d;
          // 다음날 오프 및 다음날 평일 감산
          const next = addDays(date, 1);
          const nKey = fmtDate(next);
          p.offDayKeys.add(nKey);
          if (isWorkday(next, holidaySet)) {
            const nWk = weekKey(next);
            p.weeklyHours[nWk] = Math.max(0, (p.weeklyHours[nWk] ?? 0) - 8);
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
      const objective = totals.reduce((acc, t) => acc + (t - avg) * (t - avg), 0);
      return { valid: true, objective, peopleSim: sim, warnings: warningsSim };
    }
  }

  function applyPeopleState(target, source) {
    for (let i = 0; i < target.length; i += 1) {
      target[i].weeklyHours = source[i].weeklyHours;
      target[i].dutyCount = source[i].dutyCount;
      target[i].lastDutyIndex = source[i].lastDutyIndex;
      target[i].offDayKeys = source[i].offDayKeys;
    }
  }
}
