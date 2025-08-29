// 스케줄링 엔진 (초안)
// 규칙 요약:
// - 하루 2명 당직
// - 당직 다음날은 정규근무 오프 (당직 불가)
// - 주간 근무시간 72시간 초과 금지
//   * 정규근무: 월–금 8시간 가정
//   * 당직: 24시간 가정

import { addDays, isWorkday, weekKey, fmtDate, rangeDays } from './time.js';

// preference: 'any' | 'weekday' | 'weekend'
export function generateSchedule({ startDate, weeks = 4, employees, holidays = [], unavailableByName = {}, fillPriority = false }) {
  if (!employees || employees.length < 2) {
    throw new Error('근무자는 2명 이상 필요합니다.');
  }

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) throw new Error('시작일이 올바르지 않습니다.');

  const totalDays = weeks * 7;
  const days = rangeDays(start, totalDays);
  const holidaySet = new Set(holidays);

  // 주 단위 키 추출 (월요일 시작)
  const allWeekKeys = new Set(days.map((d) => weekKey(d)));
  const weekKeys = [...allWeekKeys];

  // 직원 상태 초기화
  const people = employees.map((emp, idx) => ({
    id: idx,
    name: typeof emp === 'string' ? emp : emp.name,
    preference: normalizePref(typeof emp === 'string' ? 'any' : emp.preference),
    weeklyHours: Object.fromEntries(
      weekKeys.map((wk) => [wk, baselineRegularForWeek(wk, start, totalDays, holidaySet)])
    ),
    dutyCount: 0,
    lastDutyIndex: -999,
    offDayKeys: new Set(), // 당직 다음날 (정규근무 오프, 당직 불가)
    unavailable: new Set(unavailableByName[(typeof emp === 'string' ? emp : emp.name)] || []),
  }));

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
      let result = pickCandidate({ index: i, date: cell.date, schedule, people, holidaySet, relax72: false });
      if (!result.person && fillPriority) {
        // 72h 제약 완화 재시도
        const relaxed = pickCandidate({ index: i, date: cell.date, schedule, people, holidaySet, relax72: true });
        if (relaxed.person) {
          result = relaxed;
          warnings.push(`충원우선: ${fmtDate(cell.date)} ${relaxed.person.name} 72h 초과 허용 배정`);
        }
      }

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

  // 통계 및 검증 메시지
  for (const p of people) {
    for (const wk of Object.keys(p.weeklyHours)) {
      if (p.weeklyHours[wk] > 72 + 1e-9) {
        warnings.push(`${p.name}의 ${wk} 주간 시간이 72시간을 초과했습니다: ${p.weeklyHours[wk]}h`);
      }
    }
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
  function baselineRegularForWeek(wk, start, totalDays, holidaySet) {
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

  function pickCandidate({ index, date, schedule, people, holidaySet, relax72 }) {
    const todayKey = fmtDate(date);
    const wk = weekKey(date);
    const next = addDays(date, 1);
    const nextWk = weekKey(next);
    const isNextWorkday = isWorkday(next, holidaySet);
    const isTodayWorkday = isWorkday(date, holidaySet);

    const takenIds = new Set(schedule[index].duties.map((d) => d.id));

    // 단계별 필터로 사유 수집
    const stage = { offday: [], preference: [], unavailable: [], over72_today: [], over72_next: [] };
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

    // 오늘 72h 체크 (완화 모드에서는 건너뜀)
    const afterToday = [];
    for (const p of pool) {
      const simToday = p.weeklyHours[wk] + 24 - (isTodayWorkday ? 8 : 0);
      if (!relax72 && simToday > 72 + 1e-9) stage.over72_today.push(p); else afterToday.push(p);
    }
    pool = afterToday;

    // 스코어링
    const candidates = pool
      .map((p) => ({ p, score: [p.dutyCount, p.weeklyHours[wk], -(index - p.lastDutyIndex)] }))
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
      if (!relax72 && simNext > 72 + 1e-9) { stage.over72_next.push(p); continue; }
      return { person: p, reasons: [] };
    }

    const reasons = [];
    if (stage.offday.length) reasons.push(['전일 당직 오프', stage.offday.length]);
    if (stage.preference.length) reasons.push(['선호 불일치', stage.preference.length]);
    if (stage.unavailable.length) reasons.push(['불가일', stage.unavailable.length]);
    if (stage.over72_today.length && !relax72) reasons.push(['72h 초과(당일)', stage.over72_today.length]);
    if (stage.over72_next.length && !relax72) reasons.push(['72h 초과(다음날)', stage.over72_next.length]);
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
}
