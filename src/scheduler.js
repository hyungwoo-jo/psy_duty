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
export function generateSchedule({ startDate, endDate = null, weeks = 4, weekMode = 'calendar', employees, holidays = [], dutyUnavailableByName = {}, dayoffWishByName = {}, vacationDaysByName = {}, priorDayDuty = { byung: '', eung: '' }, optimization = 'medium', weekdaySlots = 1, weekendSlots = 2, timeBudgetMs = 2000 }) {
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
  const dayKeys = days.map((d) => fmtDate(d));
  const holidaySet = new Set(holidays);
  // 주당 상한: 72h는 소프트(권장) 상한, 75h를 하드 상한으로 드물게만 허용
  const WEEK_SOFT_MAX = 72;
  const WEEK_HARD_MAX = 75;

  // 주 단위 키 추출 (월요일 시작)
  const weekKeys = allWeekKeysInRange(start, totalDays, weekMode);

  // 직원 상태 초기화
  const people = employees.map((emp, idx) => ({
    id: idx,
    name: typeof emp === 'string' ? emp : emp.name,
    preference: normalizePref(typeof emp === 'string' ? 'any' : emp.preference),
    klass: (typeof emp === 'string' ? '' : emp.klass) || '',
    pediatric: !!(typeof emp === 'string' ? false : emp.pediatric),
    emergency: !!(typeof emp === 'string' ? false : emp.emergency),
    // 주별 근무시간: 베이스라인 0에서 시작 (정규는 이후 날짜별로 2명만 +11h 반영)
    weeklyHours: Object.fromEntries(
      weekKeys.map((wk) => [wk, 0])
    ),
    dutyCount: 0,
    weekdayDutyCount: 0,
    weekendDutyCount: 0,
    _byung: 0,
    _eung: 0,
    lastDutyIndex: -999,
    offDayKeys: new Set(), // 24h 당직 다음날: 당직/정규 제외
    regularOffDayKeys: new Set(), // 평일 당직 다음날: 정규 제외
    dutyUnavailable: new Set(dutyUnavailableByName[(typeof emp === 'string' ? emp : emp.name)] || []),
    dayoffWish: new Set(dayoffWishByName[(typeof emp === 'string' ? emp : emp.name)] || []),
    vacationDays: new Set(vacationDaysByName[(typeof emp === 'string' ? emp : emp.name)] || []),
  }));

  // 역할별 기대치 기반 소프트 캡 계산 (비 R3): 기대치 = (연차·역할 슬롯 수) × (가용일 비율), 캡 = ceil(기대)+2
  const classSlots = new Map();
  const ensureClass = (k) => { if (!classSlots.has(k)) classSlots.set(k, { by: 0, eu: 0 }); return classSlots.get(k); };
  for (const d of days) {
    ensureClass(requiredClassFor(d, holidaySet, 0)).by += 1;
    ensureClass(requiredClassFor(d, holidaySet, 1)).eu += 1;
  }
  const eligBy = new Map(); const eligEu = new Map();
  for (const p of people) { eligBy.set(p.id, 0); eligEu.set(p.id, 0); }
  for (const d of days) {
    const key = fmtDate(d);
    for (const p of people) {
      if (p.vacationDays && p.vacationDays.has(key)) continue;
      const disallow = (p.dutyUnavailable && p.dutyUnavailable.has(key)) || (p.dayoffWish && p.dayoffWish.has(key));
      if (!disallow && requiredClassFor(d, holidaySet, 0) === p.klass) eligBy.set(p.id, (eligBy.get(p.id) || 0) + 1);
      if (!disallow && requiredClassFor(d, holidaySet, 1) === p.klass) eligEu.set(p.id, (eligEu.get(p.id) || 0) + 1);
    }
  }
  const sumEligByClass = new Map(); const sumEligEuClass = new Map();
  for (const p of people) {
    const k = p.klass || '';
    if (!sumEligByClass.has(k)) sumEligByClass.set(k, 0);
    if (!sumEligEuClass.has(k)) sumEligEuClass.set(k, 0);
    sumEligByClass.set(k, sumEligByClass.get(k) + (eligBy.get(p.id) || 0));
    sumEligEuClass.set(k, sumEligEuClass.get(k) + (eligEu.get(p.id) || 0));
  }
  const capBy = new Map(); const capEu = new Map();
  for (const p of people) {
    const k = p.klass || '';
    const slots = classSlots.get(k) || { by: 0, eu: 0 };
    const sBy = sumEligByClass.get(k) || 0;
    const sEu = sumEligEuClass.get(k) || 0;
    const tBy = sBy > 0 ? (slots.by * (eligBy.get(p.id) || 0) / sBy) : (slots.by / Math.max(1, people.filter(pp => pp.klass === k).length));
    const tEu = sEu > 0 ? (slots.eu * (eligEu.get(p.id) || 0) / sEu) : (slots.eu / Math.max(1, people.filter(pp => pp.klass === k).length));
    let capByVal = Math.ceil(tBy) + 2;
    let capEuVal = Math.ceil(tEu) + 2;
    // 비 R3는 병/응 모두 기대치+1로 타이트하게(±1 목표)
    if (p.klass !== 'R3') {
      capByVal = Math.min(capByVal, Math.ceil(tBy) + 1);
      capEuVal = Math.min(capEuVal, Math.ceil(tEu) + 1);
    }
    capBy.set(p.id, capByVal);
    capEu.set(p.id, capEuVal);
  }
  // 전일 당직(시작일 전날) 사전 반영: 다음날(start)은 Day-off(주말/공휴일 전날이면 정규/당직 모두 제외)
  (function applyPriorDayDutyOff() {
    try {
      const prev = addDays(start, -1);
      const prevIsWork = isWorkday(prev, holidaySet);
      const startKey = fmtDate(start);
      const names = new Set([priorDayDuty?.byung || '', priorDayDuty?.eung || ''].filter(Boolean));
      for (const p of people) {
        if (!names.has(p.name)) continue;
        if (prevIsWork) p.regularOffDayKeys.add(startKey); else p.offDayKeys.add(startKey);
      }
    } catch {}
  })();

  // 날짜 키 ↔ 인덱스 매핑
  const keyToIndex = new Map(days.map((d, i) => [fmtDate(d), i]));
  // Day-off 희망일(평일) → 전날 당직 선호(소프트 제약)로 전환
  const preferByIndex = Array.from({ length: days.length }, () => new Set());
  for (const p of people) {
    for (const key of (p.dayoffWish || new Set())) {
      const d = new Date(key);
      if (Number.isNaN(d.getTime())) continue;
      // 해당 날짜가 평일(근무일)인 경우: 전날 당직을 선호로 표시
      if (isWorkday(d, holidaySet)) {
        const prev = addDays(d, -1);
        const pi = keyToIndex.get(fmtDate(prev));
        if (pi != null) preferByIndex[pi].add(p.id);
      }
    }
  }

  // 개인별 총합 상한: 전체 주 기준(휴가 중 정규 제외되므로 실제 총합은 자연히 줄어듦)
  for (const p of people) {
    p.totalCapHours = 72 * weekKeys.length;
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

  // 역할별 요구 연차(R-class) 템플릿
  function requiredClassFor(date, holidaySet, slotIndex) {
    const isWk = isWorkday(date, holidaySet);
    const dow = date.getDay(); // 0=Sun..6=Sat
    if (!isWk) {
      // 주말/공휴일: 병당=R2, 응당=R1
      return slotIndex === 0 ? 'R2' : 'R1';
    }
    // 평일: slot 0=병당, slot 1=응당
    switch (dow) {
      case 1: return slotIndex === 0 ? 'R1' : 'R3'; // 월
      case 2: return slotIndex === 0 ? 'R1' : 'R4'; // 화
      case 3: return slotIndex === 0 ? 'R3' : 'R2'; // 수
      case 4: return slotIndex === 0 ? 'R1' : 'R2'; // 목
      case 5: return slotIndex === 0 ? 'R1' : 'R3'; // 금
      default: return slotIndex === 0 ? 'R2' : 'R1';
    }
  }

  // 메인 할당 루프
  const warnings = [];
  const meta = { elapsedMs: 0 };
  // 평일 불가일 → 전날 강제 배치(가능 시) 사전 처리
  const preAssigned = Array.from({ length: days.length }, () => [null, null]);
  const preAssignFailures = [];
  (function preassignFromDayoffWish() {
    // 수집: (prevIndex, person)
    const reqs = [];
    for (const p of people) {
      for (const key of (p.dayoffWish || new Set())) {
        const d = new Date(key);
        if (!isWorkday(d, holidaySet)) continue; // 평일만 대상
        const prevKey = fmtDate(addDays(d, -1));
        const pi = keyToIndex.get(prevKey);
        if (pi == null) { preAssignFailures.push(`${p.name} ${key} (전일 없음)`); continue; }
        reqs.push({ pi, key, p });
      }
    }
    // 날짜 오름차순으로 처리 (충돌 완화)
    reqs.sort((a, b) => a.pi - b.pi);
    for (const { pi, key, p } of reqs) {
      const date = days[pi];
      const todayKey = fmtDate(date);
      // 기본 제약 체크: 해당일 휴가/불가/중복/연속 금지
      if (p.vacationDays && p.vacationDays.has(todayKey)) { preAssignFailures.push(`${p.name} ${key} (전일 휴가)`); continue; }
      if ((p.dutyUnavailable && p.dutyUnavailable.has(todayKey)) || (p.dayoffWish && p.dayoffWish.has(todayKey))) { preAssignFailures.push(`${p.name} ${key} (전일 불가)`); continue; }
      if (pi > 0) {
        const prevPrev = preAssigned[pi - 1] || [];
        if (prevPrev[0]?.id === p.id || prevPrev[1]?.id === p.id) { preAssignFailures.push(`${p.name} ${key} (연속 당직 불가)`); continue; }
      }
      // 슬롯 매칭(연차)
      let placed = false;
      for (let s = 0; s < 2; s += 1) {
        if (preAssigned[pi][s]) continue;
        const need = requiredClassFor(date, holidaySet, s);
        if (p.klass !== need) continue;
        preAssigned[pi][s] = { id: p.id, name: p.name };
        placed = true; break;
      }
      if (!placed) {
        preAssignFailures.push(`${p.name} ${key} (전일 연차/슬롯 불일치 또는 충돌)`);
      }
    }
  })();
  // 응급 back 고정 인원(R3 중 응급 태그)
  const emergencyBack = people.find((p) => p.klass === 'R3' && p.emergency);
  for (let i = 0; i < schedule.length; i += 1) {
    const cell = schedule[i];
    if (emergencyBack) cell.back = { id: emergencyBack.id, name: emergencyBack.name };
    // 당직 슬롯 고정: 병당 1, 응당 1 -> 총 2명/일
    for (let slot = 0; slot < 2; slot += 1) {
      // 사전 강제 배치가 있으면 우선 적용
      if (preAssigned[i][slot]) {
        const forced = preAssigned[i][slot];
        cell.duties.push({ id: forced.id, name: forced.name });
        const person = people.find((pp) => pp.id === forced.id);
        if (person) applyAssignment({ person, index: i, date: cell.date, holidaySet, slot });
        continue;
      }
      const needKlass = requiredClassFor(cell.date, holidaySet, slot);
      const result = pickCandidate({ index: i, date: cell.date, schedule, people, holidaySet, needKlass, slot });

      if (!result.person) {
        cell.underfilled = true; // 규칙 준수 내에서 미충원
        if (result.reasons && result.reasons.length) {
          cell.reasons = summarizeReasons(result.reasons);
        }
        continue;
      }
      const picked = result.person;
      cell.duties.push({ id: picked.id, name: picked.name });
      applyAssignment({ person: picked, index: i, date: cell.date, holidaySet, slot });
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
        // 기본은 최적화 결과를 채우되, 사전 강제배치는 보존
        const forced = preAssigned[i] || [null, null];
        const row = (bestOpt.map[i] || []).slice();
        for (let s = 0; s < 2; s += 1) {
          if (forced[s]) {
            row[s] = forced[s].id; // 강제 id로 고정
          }
        }
        schedule[i].duties = row
          .filter((v) => v != null)
          .map((id) => {
            const p = people.find((pp) => pp.id === id);
            return { id: p.id, name: p.name };
          });
      }
      applyPeopleState(people, bestOpt.peopleSim);
      warnings.push(...bestOpt.warningsAfter);
      regularsAlreadyApplied = true; // 평가 단계에서 정규(+11h×2) 이미 반영됨
      meta.elapsedMs = Date.now() - startTs;
    } else {
      for (const p of people) { collectWeeklyWarnings(p, warnings, WEEK_SOFT_MAX); collectTotalWarning(p, warnings, p.totalCapHours); }
    }
  } else {
    // (정규 반영 전) 일단 경고는 보류하고, 정규 반영 후 재계산
  }

  // 최종 duties를 기준으로 정규/당직 시간 재계산 (원천 ledger에서 파생)
  rebuildFromLedger();
  // 사후 보정: 주 80h 이상 해소를 위한 제한적 스왑(병당 위주)
  (function tryRepair80() {
    let changed = false;
    let guard = 0;
    const idxById = new Map(people.map((p, i) => [p.id, i]));
    while (guard++ < 30) {
      // 주별 80h 이상 찾기
      const offenders = [];
      for (const p of people) {
        for (const wk of Object.keys(p.weeklyHours)) {
          const v = p.weeklyHours[wk] || 0;
          if (v >= 80 - 1e-9) offenders.push({ id: p.id, wk, hours: v });
        }
      }
      if (offenders.length === 0) break;
      let fixedAny = false;
      // byungCount 맵(개인별 병당 횟수)
      const byCount = new Map();
      for (let i = 0; i < schedule.length; i += 1) {
        const duty = (schedule[i].duties || [])[0];
        if (duty) byCount.set(duty.id, (byCount.get(duty.id) || 0) + 1);
      }
      for (const off of offenders) {
        const p = people[idxById.get(off.id)];
        if (!p) continue;
        // 해당 주의 날짜 인덱스 수집
        const indices = [];
        for (let i = 0; i < schedule.length; i += 1) {
          if (weekKeyByMode(schedule[i].date, start, weekMode) === off.wk) indices.push(i);
        }
        // 해당 주에 본인이 병당으로 선 당직 날짜(주말 먼저: 21h 절감)
        const candDays = indices.filter((i) => (schedule[i].duties[0]?.id === p.id))
          .sort((a, b) => {
            const wa = isWorkday(schedule[a].date, holidaySet) ? 0 : 1;
            const wb = isWorkday(schedule[b].date, holidaySet) ? 0 : 1;
            return wb - wa; // 주말 먼저
          });
        // 같은 연차 후보 목록
        const klass = p.klass;
        const classPeople = people.filter((q) => q.klass === klass && q.id !== p.id);
        // 병당 슬롯 교체 시도
        for (const di of candDays) {
          const d = schedule[di].date; const key = fmtDate(d);
          const addDuty = isWorkday(d, holidaySet) ? 13.5 : 21;
          // 스왑 후보 탐색
          let swapped = false;
          for (const q of classPeople) {
            // 당일 당직 불가/희망/휴가/이미 배정/연속 금지 체크
            if ((q.dutyUnavailable && q.dutyUnavailable.has(key)) || (q.dayoffWish && q.dayoffWish.has(key))) continue;
            if (q.vacationDays && q.vacationDays.has(key)) continue;
            if (schedule[di].duties.find((x) => x?.id === q.id)) continue;
            // 연속 금지
            if (di > 0 && schedule[di - 1].duties.find((x) => x?.id === q.id)) continue;
            if (di + 1 < schedule.length && schedule[di + 1].duties.find((x) => x?.id === q.id)) continue;
            // 스왑 후 주간 80 체크
            const qWeekly = (q.weeklyHours[off.wk] || 0) + addDuty;
            const pWeekly = (p.weeklyHours[off.wk] || 0) - addDuty;
            if (qWeekly >= 80 - 1e-9) continue;
            // 병당 편차 ±2 이내 유지(양쪽)
            const byP = (byCount.get(p.id) || 0) - 1;
            const byQ = (byCount.get(q.id) || 0) + 1;
            // 클래스 평균(병당)
            const classIds = people.filter((x) => x.klass === klass).map((x) => x.id);
            let sum = 0; for (const id of classIds) sum += (byCount.get(id) || 0) + (id === p.id ? -1 : 0) + (id === q.id ? +1 : 0);
            const avg = sum / classIds.length;
            if (Math.abs(byP - avg) > 2 + 1e-9) continue;
            if (Math.abs(byQ - avg) > 2 + 1e-9) continue;
            // 스왑 수행
            schedule[di].duties[0] = { id: q.id, name: q.name };
            byCount.set(p.id, byP); byCount.set(q.id, byQ);
            swapped = true; changed = true; fixedAny = true;
            break;
          }
          if (swapped) break;
        }
      }
      if (!fixedAny) break;
      // 재계산
      rebuildFromLedger();
    }
    if (changed) {
      // after repair, leave schedule/people updated
    }
  })();

  // 사후 보정 2: Day-off 편차 완화(같은 연차, 같은 슬롯 간 스왑)
  (function tryRepairDayoffBalance() {
    let guard = 0;
    const idxById = new Map(people.map((p, i) => [p.id, i]));

    const isNextWorkday = (i) => {
      if (i + 1 >= schedule.length) return false;
      return isWorkday(schedule[i + 1].date, holidaySet);
    };

    // day-off 카운트 계산
    function computeDayOffMap() {
      const map = new Map();
      for (let i = 0; i < schedule.length - 1; i += 1) {
        if (!isNextWorkday(i)) continue;
        for (const d of (schedule[i].duties || [])) {
          map.set(d.id, (map.get(d.id) || 0) + 1);
        }
      }
      return map;
    }

    // 역할 카운트 맵(전역)과 재계산기
    const byCount = new Map();
    const euCount = new Map();
    function recomputeRoleCounts() {
      byCount.clear(); euCount.clear();
      for (let i = 0; i < schedule.length; i += 1) {
        const d0 = (schedule[i].duties || [])[0]; if (d0) byCount.set(d0.id, (byCount.get(d0.id) || 0) + 1);
        const d1 = (schedule[i].duties || [])[1]; if (d1) euCount.set(d1.id, (euCount.get(d1.id) || 0) + 1);
      }
    }
    recomputeRoleCounts();

    function classAvgBy(slot, klass, deltaOverrides = new Map()) {
      // 평균 병당/응당 카운트(스왑 검증용)
      const ids = people.filter((p) => p.klass === klass).map((p) => p.id);
      let sum = 0; for (const id of ids) sum += ((slot === 0 ? byCount.get(id) : euCount.get(id)) || 0) + (deltaOverrides.get(id) || 0);
      return sum / Math.max(1, ids.length);
    }

    while (guard++ < 50) {
      const dayOffMap = computeDayOffMap();
      // 연차별로 고/저 선택
      const byClass = new Map();
      for (const p of people) {
        const k = p.klass || '';
        if (!byClass.has(k)) byClass.set(k, []);
        byClass.get(k).push({ id: p.id, name: p.name, count: dayOffMap.get(p.id) || 0 });
      }
      let improved = false;
      for (const [klass, arr] of byClass) {
        if (!klass) continue;
        const sorted = arr.slice().sort((a, b) => b.count - a.count);
        if (sorted.length < 2) continue;
        const high = sorted[0];
        const low = sorted[sorted.length - 1];
        if ((high.count - low.count) <= 1 + 1e-9) continue; // 이미 균형

        // 병당 우선 스왑
        const trySlots = [0, 1];
        for (const slot of trySlots) {
          // high가 slot에 배정된 날 중에서 다음날 평일(true)인 날 i 찾기
          const idxHigh = [];
          for (let i = 0; i < schedule.length; i += 1) {
            const duty = (schedule[i].duties || [])[slot];
            if (duty?.id === high.id && isNextWorkday(i)) idxHigh.push(i);
          }
          if (idxHigh.length === 0) continue;
          const idxLow = [];
          for (let j = 0; j < schedule.length; j += 1) {
            const duty = (schedule[j].duties || [])[slot];
            if (duty?.id === low.id && !isNextWorkday(j)) idxLow.push(j); // day-off 줄이려면 false가 유리
          }
          if (idxLow.length === 0) continue;

          let found = false;
          outer:
          for (const i of idxHigh) {
            for (const j of idxLow) {
              if (i === j) continue;
              // 강제 배치 보호
              if ((preAssigned[i] && preAssigned[i][slot]) || (preAssigned[j] && preAssigned[j][slot])) continue;
              const dayI = schedule[i].date; const keyI = fmtDate(dayI);
              const dayJ = schedule[j].date; const keyJ = fmtDate(dayJ);
              const addI = isWorkday(dayI, holidaySet) ? 13.5 : 21;
              const addJ = isWorkday(dayJ, holidaySet) ? 13.5 : 21;
              const pHigh = people[idxById.get(high.id)];
              const pLow = people[idxById.get(low.id)];
              // 당일 제약(불가/희망/휴가)
              const disIforLow = (pLow.dutyUnavailable && pLow.dutyUnavailable.has(keyI)) || (pLow.dayoffWish && pLow.dayoffWish.has(keyI)) || (pLow.vacationDays && pLow.vacationDays.has(keyI));
              const disJforHigh = (pHigh.dutyUnavailable && pHigh.dutyUnavailable.has(keyJ)) || (pHigh.dayoffWish && pHigh.dayoffWish.has(keyJ)) || (pHigh.vacationDays && pHigh.vacationDays.has(keyJ));
              if (disIforLow || disJforHigh) continue;
              // 연속 금지 체크
              const hasPrev = (idx, id) => (idx > 0) && (schedule[idx - 1].duties || []).some((x) => x?.id === id);
              const hasNext = (idx, id) => (idx + 1 < schedule.length) && (schedule[idx + 1].duties || []).some((x) => x?.id === id);
              if (hasPrev(i, pLow.id) || hasNext(i, pLow.id)) continue;
              if (hasPrev(j, pHigh.id) || hasNext(j, pHigh.id)) continue;
              // 주간 75h 하드 체크
              const wkI = weekKeyByMode(dayI, start, weekMode);
              const wkJ = weekKeyByMode(dayJ, start, weekMode);
              const highNewI = (pHigh.weeklyHours[wkI] || 0) - addI;
              const highNewJ = (pHigh.weeklyHours[wkJ] || 0) + addJ;
              const lowNewI  = (pLow.weeklyHours[wkI]  || 0) + addI;
              const lowNewJ  = (pLow.weeklyHours[wkJ]  || 0) - addJ;
              if (highNewI < -1e-9 || highNewJ > 75 + 1e-9) continue;
              if (lowNewJ < -1e-9 || lowNewI  > 75 + 1e-9) continue;
              // 역할 편차 ±3 방지(요청)
              const delta = new Map();
              delta.set(high.id, (slot === 0 ? -1 : 0) + (slot === 1 ? -1 : 0));
              delta.set(low.id,  (slot === 0 ? +1 : 0) + (slot === 1 ? +1 : 0));
              const avg = classAvgBy(slot, klass, delta);
              const newHighRole = (slot === 0 ? (byCount.get(high.id) || 0) - 1 : (euCount.get(high.id) || 0) - 1);
              const newLowRole  = (slot === 0 ? (byCount.get(low.id)  || 0) + 1 : (euCount.get(low.id)  || 0) + 1);
              if (Math.abs(newHighRole - avg) > 2 + 1e-9) continue;
              if (Math.abs(newLowRole  - avg) > 2 + 1e-9) continue;
              // 스왑 적용
              const dutyI = schedule[i].duties[slot];
              const dutyJ = schedule[j].duties[slot];
              schedule[i].duties[slot] = { id: dutyJ.id, name: dutyJ.name };
              schedule[j].duties[slot] = { id: dutyI.id, name: dutyI.name };
              rebuildFromLedger();
              improved = true; found = true;
              break outer;
            }
          }
        }
      }
      if (!improved) break;
    }
  })();
  // 경고/총합 재계산
  warnings.length = 0;
  for (const p of people) { collectWeeklyWarnings(p, warnings, WEEK_SOFT_MAX); collectTotalWarning(p, warnings, p.totalCapHours); }

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
    employees: people.map((p) => ({ id: p.id, name: p.name, preference: p.preference, klass: p.klass, pediatric: !!p.pediatric })),
    endDate: endDate ? fmtDate(addDays(start, totalDays - 1)) : null,
    schedule,
    config: { weekMode, weekdaySlots: Math.max(1, Math.min(2, weekdaySlots)), weekendSlots: Math.max(1, weekendSlots) },
    warnings: preAssignFailures.length ? (warnings.concat([`불가일 전일 당직 배치 실패: ${preAssignFailures.join(' / ')}`])) : warnings,
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

  function pickCandidate({ index, date, schedule, people, holidaySet, needKlass, slot }) {
    const todayKey = fmtDate(date);
    const wk = weekKeyByMode(date, start, weekMode);
    const next = addDays(date, 1);
    const nextWk = weekKeyByMode(next, start, weekMode);
    const isNextWorkday = isWorkday(next, holidaySet);
    const isTodayWorkday = isWorkday(date, holidaySet);

    const takenIds = new Set(schedule[index].duties.map((d) => d.id));
    const isTodayWeekendLike = !isWorkday(date, holidaySet);
    // 전일 당직자는 오늘 당직 배제 (연속 금지)
    const prevDutyIds = new Set();
    if (index > 0) {
      for (const d of schedule[index - 1].duties) prevDutyIds.add(d.id);
    }

    // 단계별 필터로 사유 수집
    const stage = { offday: [], klass: [], preference: [], unavailable: [], vacation: [], special: [], overWeek_today: [], overWeek_next: [], overTotal: [] };
    let pool = people.filter((p) => !takenIds.has(p.id));

    // 요구 연차(klass) 필터
    const afterKlass = [];
    for (const p of pool) (p.klass === needKlass ? afterKlass : stage.klass).push(p);
    pool = afterKlass;

    const afterOff = [];
    for (const p of pool) (p.offDayKeys.has(todayKey) ? stage.offday : afterOff).push(p);
    pool = afterOff;

    // 전일 당직자 제외 (연속 금지)
    if (prevDutyIds.size) {
      const afterPrev = [];
      for (const p of pool) (prevDutyIds.has(p.id) ? stage.offday : afterPrev).push(p);
      pool = afterPrev;
    }

    // 선호옵션 제거: 모두 허용
    const afterPref = pool.slice();
    pool = afterPref;

    const afterUnavail = [];
    for (const p of pool) (((p.dutyUnavailable && p.dutyUnavailable.has(todayKey)) || (p.dayoffWish && p.dayoffWish.has(todayKey))) ? stage.unavailable : afterUnavail).push(p);
    pool = afterUnavail;

    const afterVacation = [];
    for (const p of pool) ((p.vacationDays && p.vacationDays.has(todayKey)) ? stage.vacation : afterVacation).push(p);
    pool = afterVacation;

    // 소아턴(R3) 수요일 제외 규칙
    const day = date.getDay(); // 0 Sun .. 6 Sat
    const afterSpecial = [];
    for (const p of pool) {
      if (day === 3 && p.klass === 'R3' && p.pediatric) stage.special.push(p); else afterSpecial.push(p);
    }
    pool = afterSpecial;

    // 다음날에 강제 배치(preAssigned)가 있는 경우, 오늘 배제해서 연속 방지
    const nextForced = new Set((preAssigned[index + 1] || []).filter(Boolean).map((x) => x.id));
    if (nextForced.size) {
      const afterNext = [];
      for (const p of pool) (nextForced.has(p.id) ? stage.offday : afterNext).push(p);
      pool = afterNext;
    }

    // 오늘 주간 상한 체크
    const afterToday = [];
    for (const p of pool) {
      const addDuty = isTodayWorkday ? 13.5 : 21; // 평일 당직 13.5h, 휴일/주말 21h
      const simToday = (p.weeklyHours[wk] ?? 0) + addDuty;
      if (simToday > WEEK_HARD_MAX + 1e-9) stage.overWeek_today.push(p); else afterToday.push(p);
    }
    pool = afterToday;

    // 스코어링 (공평성 강화: 전체 총근무시간을 우선 고려)
    const prefToday = preferByIndex[index] || new Set();
    // 역할별 소프트 캡: (R3 제외) 기대+2 초과자는 우선 제외
    const afterCap = [];
    for (const p of pool) {
      if (p.klass !== 'R3') {
        const cur = (slot === 0) ? (p._byung || 0) : (p._eung || 0);
        const cap = (slot === 0) ? (capBy.get(p.id) || Infinity) : (capEu.get(p.id) || Infinity);
        if (cur >= cap) { stage.special.push(p); continue; }
      }
      afterCap.push(p);
    }
    pool = afterCap;

    const candidates = pool
      .map((p) => {
        const totalHours = Object.values(p.weeklyHours).reduce((a, b) => a + b, 0);
        // 전날 당직 선호(weekday 불가일 보정): 해당 인원이 오늘 선호 대상이면 큰 보너스
        const preferBoost = prefToday.has(p.id) ? -1000 : 0;
        return { p, score: [p.dutyCount + preferBoost, totalHours, p.weeklyHours[wk], -(index - p.lastDutyIndex)] };
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
      const deltaTotal = (isTodayWorkday ? 13.5 : 21);
      const totalCap = p.totalCapHours ?? (72 * weeks); // fallback
      if (totalNow + deltaTotal > totalCap + 1e-9) { stage.overTotal.push(p); continue; }
      return { person: p, reasons: [] };
    }

    const reasons = [];
    if (stage.klass.length) reasons.push([`요구연차(${needKlass}) 불일치`, stage.klass.length]);
    if (stage.offday.length) reasons.push(['전일 당직 오프', stage.offday.length]);
    if (stage.preference.length) reasons.push(['선호 불일치', stage.preference.length]);
    if (stage.unavailable.length) reasons.push(['불가일', stage.unavailable.length]);
    if (stage.vacation.length) reasons.push(['휴가 주 제외', stage.vacation.length]);
    if (stage.special.length) reasons.push(['소아턴 수요일 제외', stage.special.length]);
    if (stage.overWeek_today.length) reasons.push([`주간상한 초과(당일>${WEEK_HARD_MAX}h)`, stage.overWeek_today.length]);
    if (stage.overWeek_next.length) reasons.push([`주간상한 초과(다음날>${WEEK_HARD_MAX}h)`, stage.overWeek_next.length]);
    if (stage.overTotal.length) reasons.push(['총합상한 초과', stage.overTotal.length]);
    return { person: null, reasons };
  }

  function applyAssignment({ person, index, date, holidaySet }) {
    const wk = weekKeyByMode(date, start, weekMode);
    const isTodayWorkday = isWorkday(date, holidaySet);
    const addDuty = isTodayWorkday ? 13.5 : 21;
    person.weeklyHours[wk] = Math.max(0, (person.weeklyHours[wk] ?? 0) + addDuty);
    person._dutyHoursAccum = (person._dutyHoursAccum || 0) + addDuty;
    person.dutyCount += 1;
    if (isTodayWorkday) person.weekdayDutyCount += 1; else person.weekendDutyCount += 1;
    person.lastDutyIndex = index;

    // 다음날 오프 처리
    const next = addDays(date, 1);
    const nKey = fmtDate(next);
    if (!isTodayWorkday) {
      person.offDayKeys.add(nKey); // 24h 다음날 전면 제외
    } else {
      person.regularOffDayKeys.add(nKey); // 평일 당직 다음날 정규 제외
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
        klass: p.klass,
        pediatric: p.pediatric,
        unavailable: p.unavailable,
        vacationDays: p.vacationDays,
        totalCapHours: p.totalCapHours,
        weeklyHours: Object.fromEntries(
          weekKeys.map((wk) => [wk, 0])
        ),
        dutyCount: 0,
        weekdayDutyCount: 0,
        weekendDutyCount: 0,
        _dutyHoursAccum: 0,
        _wkDuty: {},
        lastDutyIndex: -999,
        offDayKeys: new Set(),
        regularOffDayKeys: new Set(),
      }));

      const warningsSim = [];
      // Seed prior-day off constraints into sim based on current people state
      for (let idx = 0; idx < sim.length; idx += 1) {
        const src = people[idx];
        if (!src) continue;
        if (src.offDayKeys && src.offDayKeys.size) {
          for (const k of src.offDayKeys) sim[idx].offDayKeys.add(k);
        }
        if (src.regularOffDayKeys && src.regularOffDayKeys.size) {
          for (const k of src.regularOffDayKeys) sim[idx].regularOffDayKeys.add(k);
        }
      }
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
          // 역할별 요구 연차 매칭 (slot 0=병당, 1=응당)
          const needK = requiredClassFor(date, holidaySet, s);
          if (p.klass !== needK) return { valid: false };
          if (p.offDayKeys.has(todayKey)) return { valid: false };
          if ((p.dutyUnavailable && p.dutyUnavailable.has(todayKey)) || (p.dayoffWish && p.dayoffWish.has(todayKey))) return { valid: false };
          if (p.vacationDays && p.vacationDays.has(fmtDate(date))) return { valid: false };
          // 소아턴(R3) 수요일 제외
          if (date.getDay() === 3 && p.klass === 'R3' && p.pediatric) return { valid: false };
          // 전일 당직자는 오늘 당직 불가 (연속 금지)
          if (d > 0) {
            const prevIds = new Set(assignMap[d - 1] || []);
            if (prevIds.has(id)) return { valid: false };
          }
          const addDuty = isTodayWorkday ? 13.5 : 21;
          const simToday = (p.weeklyHours[wk] ?? 0) + addDuty;
          if (simToday > WEEK_HARD_MAX + 1e-9) return { valid: false };
          // 적용
          p.weeklyHours[wk] = Math.max(0, simToday);
          p.dutyCount += 1;
          if (isTodayWorkday) p.weekdayDutyCount += 1; else p.weekendDutyCount += 1;
          if (s === 0) p._byung = (p._byung || 0) + 1; else p._eung = (p._eung || 0) + 1;
          p._dutyHoursAccum += addDuty;
          p._wkDuty[wk] = (p._wkDuty[wk] || 0) + 1;
          p.lastDutyIndex = d;
          // 다음날 오프 처리
          if (!isTodayWorkday) {
            const next = addDays(date, 1);
            const nKey = fmtDate(next);
            p.offDayKeys.add(nKey); // 24h 다음날 전면 제외
          } else {
            const next = addDays(date, 1);
            const nKey = fmtDate(next);
            p.regularOffDayKeys.add(nKey); // 평일 당직 다음날 정규 제외
          }
        }
      }
      // 평일 정규 8h: eligible 모든 인원에게 부여 (정규 기본)
      for (let d = 0; d < days.length; d += 1) {
        const date = days[d];
        if (!isWorkday(date, holidaySet)) continue;
        const wk = weekKeyByMode(date, start, weekMode);
        const key = fmtDate(date);
      const pool = sim
          .filter((p) => !(p.vacationDays && p.vacationDays.has(fmtDate(date))))
          .filter((p) => !(p.regularOffDayKeys && p.regularOffDayKeys.has(key)))
          .filter((p) => !(p.offDayKeys && p.offDayKeys.has(key)));
        for (const p of pool) { p.weeklyHours[wk] = (p.weeklyHours[wk] || 0) + 8; }
      }

      // 주간 경고 집계 및 목적함수 계산
      for (const p of sim) collectWeeklyWarnings(p, warningsSim, WEEK_SOFT_MAX);
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
      // 연차 내부 공평성: 역할(병당/응당) 카운트 분산과 시간(총합) 분산을 연차 그룹 내에서 완화
      const byClass = new Map();
      for (const p of sim) { if (!byClass.has(p.klass)) byClass.set(p.klass, []); byClass.get(p.klass).push(p); }
      let roleVar = 0;           // 연차 내 역할(병당/응당) 분산
      let hoursVarInClass = 0;   // 연차 내 총 시간 분산
      let weeklyClassVar = 0;    // 연차 내 주별 duty 횟수 분산
      let countClassVar = 0;     // 연차 내 총 당직 횟수 분산 (최우선)
      let vacFavorPen = 0;       // 휴가자 과도 배치 억제 페널티
      let weekendBoundPen = 0;   // 주말 당직 편차 ±1 초과 페널티
      let roleBoundPen = 0;      // (R3 제외) 역할별 개인 편차 ±1 초과 페널티
      for (const [klass, arr] of byClass) {
        if (!klass) continue;
        const bys = arr.map((p) => p._byung || 0);
        const eus = arr.map((p) => p._eung || 0);
        const cnt = arr.map((p) => p.dutyCount || 0);
        const ths = arr.map((p) => Object.values(p.weeklyHours).reduce((a,b)=>a+b,0));
        const mb = bys.reduce((a,b)=>a+b,0) / (arr.length || 1);
        const me = eus.reduce((a,b)=>a+b,0) / (arr.length || 1);
        const mc = cnt.reduce((a,b)=>a+b,0) / (arr.length || 1);
        const mh = ths.reduce((a,b)=>a+b,0) / (arr.length || 1);
        roleVar += bys.reduce((acc,v)=>acc+(v-mb)*(v-mb),0);
        roleVar += eus.reduce((acc,v)=>acc+(v-me)*(v-me),0);
        countClassVar += cnt.reduce((acc,v)=>acc+(v-mc)*(v-mc),0);
        hoursVarInClass += ths.reduce((acc,v)=>acc+(v-mh)*(v-mh),0);
        // 주 내 공평성: 주별 duty 횟수 분산
        for (const wk of weekKeys) {
          const arrW = arr.map((p) => p._wkDuty[wk] || 0);
          const mw = arrW.reduce((a,b)=>a+b,0) / (arrW.length || 1);
          weeklyClassVar += arrW.reduce((acc,v)=>acc+(v-mw)*(v-mw),0);
        }
        // 주말 당직(weekendDutyCount) 편차: 평균 대비 ±1 초과분 페널티
        {
          const wends = arr.map((p) => p.weekendDutyCount || 0);
          const mwend = wends.reduce((a,b)=>a+b,0) / (wends.length || 1);
          for (const v of wends) weekendBoundPen += Math.max(0, Math.abs(v - mwend) - 1);
        }
        // (R3 제외) 개인별 병당/응당 편차가 ±2를 넘으면 초과분에 패널티(hinge)
        if (klass !== 'R3') {
          for (const p of arr) {
            const by = p._byung || 0;
            const eu = p._eung || 0;
            const overBy = Math.max(0, Math.abs(by - mb) - 1);
            const overEu = Math.max(0, Math.abs(eu - me) - 1);
            roleBoundPen += overBy + overEu;
          }
        }
        // 휴가자 배려: 휴가일 수 비례로 0~2개까지 적게 서도 무페널티, 넘기면 페널티
        for (const p of arr) {
          const set = p.vacationDays || new Set();
          let vacCount = 0; for (const k of dayKeys) { if (set.has(k)) vacCount++; }
          const vacAdj = Math.min(2, Math.floor(vacCount / 5)); // 5일 휴가당 1개 감면, 최대 2개
          const allow = Math.max(0, mc - vacAdj);
          if ((p.dutyCount || 0) > allow) vacFavorPen += ((p.dutyCount || 0) - allow);
        }
      }
      // 공평성 기준: 연차 내에서만 균형 유지 (최우선: 총 당직 횟수 균형)
      // 선호 미충족 패널티 (weekday 불가일의 전날 당직 선호)
      let preferMiss = 0;
      for (let d = 0; d < days.length; d += 1) {
        const pref = preferByIndex[d];
        if (!pref || pref.size === 0) continue;
        const assigned = new Set(current[d] || []);
        for (const pid of pref) { if (!assigned.has(pid)) preferMiss += 1; }
      }
      // 소프트 상한(72h) 초과 빈도/초과량에 패널티를 주어 '가끔'만 허용
      let softExceedCount = 0;
      let softExceedAmount = 0;
      for (const p of sim) {
        for (const wk of weekKeys) {
          const v = p.weeklyHours[wk] || 0;
          if (v > WEEK_SOFT_MAX + 1e-9) {
            softExceedCount += 1;
            softExceedAmount += (v - WEEK_SOFT_MAX);
          }
        }
      }
      // 주 80h 이상은 강한 페널티(가능하면 회피)
      let hard80Count = 0;
      let hard80Amount = 0;
      for (const p of sim) {
        for (const wk of weekKeys) {
          const v = p.weeklyHours[wk] || 0;
          if (v >= 80 - 1e-9) { // 80h 이상
            hard80Count += 1;
            hard80Amount += Math.max(0, v - 80);
          }
        }
      }
      const WEIGHTS = { total: 0.0, smooth: 0.0, countClass: 9.0, roleClass: 3.0, hoursClass: 0.1, weeklyClass: 0.4, softCnt: 2.0, softAmt: 0.5, hard80Cnt: 12.0, hard80Amt: 3.0, preferMiss: 1.5, vacFavor: 4.0, roleBound: 6.0, weekendBound: 4.0 };
      const objective = WEIGHTS.total * varTotal
        + WEIGHTS.smooth * smooth
        + WEIGHTS.countClass * countClassVar
        + WEIGHTS.roleClass * roleVar
        + WEIGHTS.hoursClass * hoursVarInClass
        + WEIGHTS.weeklyClass * weeklyClassVar
        + WEIGHTS.softCnt * softExceedCount
        + WEIGHTS.softAmt * softExceedAmount
        + WEIGHTS.hard80Cnt * hard80Count
        + WEIGHTS.hard80Amt * hard80Amount
        + WEIGHTS.preferMiss * preferMiss
        + WEIGHTS.vacFavor * vacFavorPen
        + WEIGHTS.weekendBound * weekendBoundPen
        + WEIGHTS.roleBound * roleBoundPen;
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
      target[i].regularOffDayKeys = source[i].regularOffDayKeys;
    }
  }

  function rebuildFromLedger() {
    // 초기화
    for (const p of people) {
      p.weeklyHours = Object.fromEntries(weekKeys.map((wk) => [wk, 0]));
      p.dutyCount = 0; p.weekdayDutyCount = 0; p.weekendDutyCount = 0;
      p._dutyHoursAccum = 0; p.offDayKeys = new Set(); p.regularOffDayKeys = new Set();
      p.lastDutyIndex = -999;
    }
    // 1) 당직 시간 누적 및 오프로 인한 상태 설정(주말/공휴일)
    for (let i = 0; i < schedule.length; i += 1) {
      const cell = schedule[i];
      const d = cell.date; const wk = weekKeyByMode(d, start, weekMode);
      const isWkday = isWorkday(d, holidaySet);
      for (const duty of cell.duties) {
        const p = people.find((x) => x.id === duty.id);
        if (!p) continue;
        const add = isWkday ? 13.5 : 21;
        p.weeklyHours[wk] = (p.weeklyHours[wk] || 0) + add;
        p._dutyHoursAccum += add;
        p.dutyCount += 1;
        if (isWkday) p.weekdayDutyCount += 1; else p.weekendDutyCount += 1;
        p.lastDutyIndex = i;
        if (!isWkday) {
          const nKey = fmtDate(addDays(d, 1));
          p.offDayKeys.add(nKey);
        } else {
          const nKey = fmtDate(addDays(d, 1));
          p.regularOffDayKeys.add(nKey);
        }
      }
    }
    // 2) 평일 정규 8h 부여: eligible 모든 인원(정규 기본). 평일 당직 다음날 정규 면제.
    for (let i = 0; i < schedule.length; i += 1) {
      const cell = schedule[i]; const d = cell.date;
      if (!isWorkday(d, holidaySet)) { cell.regulars = []; continue; }
      const wk = weekKeyByMode(d, start, weekMode); const key = fmtDate(d);
      const pool = people
        .filter((p) => !(p.vacationDays && p.vacationDays.has(key)))
        .filter((p) => !(p.regularOffDayKeys && p.regularOffDayKeys.has(key)))
        .filter((p) => !(p.offDayKeys && p.offDayKeys.has(key)));
      for (const p of pool) p.weeklyHours[wk] = (p.weeklyHours[wk] || 0) + 8;
      cell.regulars = [];
    }
  }
}
