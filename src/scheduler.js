import { ensureSolver } from './ilp/solverLoader.js';
import { addDays, isWorkday, weekKeyByMode, fmtDate, rangeDays, allWeekKeysInRange } from './time.js';

const solver = typeof window !== 'undefined' ? await ensureSolver() : null;

const DUTY_HOURS = { weekday: 13.5, weekend: 21 };
const REGULAR_HOURS = 8;
const WEEK_HARD_MAX = 72;

export function generateSchedule(params) {
  if (!solver) {
    throw new Error('ILP solver 초기화에 실패했습니다. 새로고침 후 다시 시도해주세요.');
  }

  const ctx = prepareContext(params);
  const { model, assignmentVars, underfillVars } = buildModel(ctx);

  const startTs = performance?.now?.() ?? Date.now();
  const solution = solver.Solve(model);
  const endTs = performance?.now?.() ?? Date.now();

  if (!solution || solution.feasible !== true) {
    throw new Error('ILP로 유효한 해를 찾지 못했습니다. 제약 조건을 조정하거나 완화 모드를 사용해보세요.');
  }

  return buildResultFromSolution({
    ctx,
    assignmentVars,
    underfillVars,
    solution,
    elapsedMs: Math.round(endTs - startTs),
  });
}

function prepareContext(params) {
  const {
    startDate,
    endDate = null,
    weeks = 4,
    weekMode = 'calendar',
    employees,
    holidays = [],
    dutyUnavailableByName = {},
    dayoffWishByName = {},
    vacationDaysByName = {},
    priorDayDuty = { byung: '', eung: '' },
    optimization = 'medium',
    weekdaySlots = 2,
    weekendSlots = 2,
    timeBudgetMs = 2000,
    roleHardcapMode = 'strict',
    prevStats = null,
    randomSeed = null,
    enforceR3WeeklyCap = false,
    enforceR1WeeklyCap = false,
    enforceDayoffBalance = true,
    weeklyHourCapMode = 'strict',
  } = params || {};

  if (!employees || employees.length < 2) {
    throw new Error('근무자는 최소 2명 이상이어야 합니다.');
  }

  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) {
    throw new Error('시작일이 올바르지 않습니다.');
  }

  let totalDays = weeks * 7;
  let weeksCount = weeks;
  if (endDate) {
    const end = new Date(endDate);
    if (Number.isNaN(end.getTime())) throw new Error('종료일이 올바르지 않습니다.');
    if (end < start) throw new Error('종료일이 시작일보다 빠릅니다.');
    totalDays = Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1;
    weeksCount = Math.max(1, Math.ceil(totalDays / 7));
  }

  const days = rangeDays(start, totalDays);
  const holidaySet = new Set(holidays);
  const dayKeys = days.map((d) => fmtDate(d));
  const weekKeys = allWeekKeysInRange(start, totalDays, weekMode);

  const random = createPRNG(randomSeed);

  const priorDutyNames = new Set([priorDayDuty?.byung, priorDayDuty?.eung].filter(Boolean));

  const employeesWithMeta = employees.map((emp, idx) => {
    const name = typeof emp === 'string' ? emp : emp.name;
    const klass = typeof emp === 'string' ? '' : (emp.klass || '');
    return {
      id: idx,
      name,
      klass,
      pediatric: !!(typeof emp === 'string' ? false : emp.pediatric),
      emergency: !!(typeof emp === 'string' ? false : emp.emergency),
      preference: (typeof emp === 'string' ? 'any' : emp.preference) || 'any',
      dutyUnavailable: new Set(iterableOrEmpty(dutyUnavailableByName[name])),
      dayoffWish: new Set(iterableOrEmpty(dayoffWishByName[name])),
      vacationDays: new Set(iterableOrEmpty(vacationDaysByName[name])),
      carryover: extractCarryover(prevStats, name),
      isPriorDuty: priorDutyNames.has(name),
    };
  });

  const vacationKlasses = new Set();
  for (const p of employeesWithMeta) {
    if (p.vacationDays.size > 0) {
      vacationKlasses.add(p.klass);
    }
  }

  const weekdaysInWeek = new Map();
  const vacationWeekdays = new Map(); // personId -> weekKey -> count

  for (const wk of weekKeys) {
    weekdaysInWeek.set(wk, 0);
  }
  for (const p of employeesWithMeta) {
    vacationWeekdays.set(p.id, new Map());
    for (const wk of weekKeys) {
      vacationWeekdays.get(p.id).set(wk, 0);
    }
  }

  for (const d of days) {
    const wk = weekKeyByMode(d, start, weekMode);
    if (isWorkday(d, holidaySet)) {
      weekdaysInWeek.set(wk, (weekdaysInWeek.get(wk) || 0) + 1);
      const dayKey = fmtDate(d);
      for (const p of employeesWithMeta) {
        if (p.vacationDays.has(dayKey)) {
          const pmap = vacationWeekdays.get(p.id);
          pmap.set(wk, (pmap.get(wk) || 0) + 1);
        }
      }
    }
  }

  const dayoffWishes = buildDayoffWishes({ days, employees: employeesWithMeta, holidaySet, dayKeys });

  const { capBy, capEu, minCapBy, minCapEu } = computeRoleCaps({
    days,
    holidaySet,
    employees: employeesWithMeta,
    roleHardcapMode,
    weekdaySlots,
    weekendSlots,
  });

  const r1s = employeesWithMeta.filter(p => p.klass === 'R1');
  const unavoidableWeekKeys = new Set();

  if (r1s.length > 0) {
    const r1SlotsPerWeek = new Map();
    for (const wk of weekKeys) {
      r1SlotsPerWeek.set(wk, 0);
    }

    for (const date of days) {
      const wk = weekKeyByMode(date, start, weekMode);
      for (let slot = 0; slot < 2; slot += 1) {
        if (requiredClassFor(date, holidaySet, slot) === 'R1') {
          r1SlotsPerWeek.set(wk, (r1SlotsPerWeek.get(wk) || 0) + 1);
        }
      }
    }

    for (const [wk, count] of r1SlotsPerWeek.entries()) {
      if (count > r1s.length * 2) {
        unavoidableWeekKeys.add(wk);
      }
    }
  }

  return {
    start,
    days,
    dayKeys,
    holidaySet,
    weekKeys,
    employees: employeesWithMeta,
    priorDayDuty,
    dayoffWishes,
    capBy,
    capEu,
    minCapBy,
    minCapEu,
    roleHardcapMode,
    weekdaySlots,
    weekendSlots,
    weekMode,
    optimization,
    timeBudgetMs,
    random,
    weeks: weeksCount,
    totalDays,
    vacationKlasses,
    weekdaysInWeek,
    vacationWeekdays,
    enforceR3WeeklyCap,
    enforceR1WeeklyCap,
    weeklyHourCapMode,
    unavoidableWeekKeys,
  };
}

function iterableOrEmpty(value) {
  if (!value) return [];
  if (value instanceof Set || Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  if (value && typeof value[Symbol.iterator] === 'function') return value;
  return [];
}

function extractCarryover(prevStats, name) {
  const result = { byung: 0, eung: 0, off: 0 };
  if (!prevStats || !Array.isArray(prevStats?.entries)) return result;
  for (const entry of prevStats.entries) {
    if (entry?.name !== name) continue;
    if (entry.role === 'byung') result.byung += Number(entry.delta) || 0;
    if (entry.role === 'eung') result.eung += Number(entry.delta) || 0;
    if (entry.role === 'off') result.off += Number(entry.delta) || 0;
  }
  return result;
}

function buildDayoffWishes({ days, employees, holidaySet, dayKeys }) {
  const keyToIndex = new Map(dayKeys.map((key, idx) => [key, idx]));
  const wishes = [];
  for (const person of employees) {
    for (const key of person.dayoffWish) {
      const target = new Date(key);
      if (Number.isNaN(target.getTime())) continue;
      if (!isWorkday(target, holidaySet)) continue;
      const prev = addDays(target, -1);
      const dayIndex = keyToIndex.get(fmtDate(prev));
      if (dayIndex != null) {
        // User wants to force a duty on the day before the wished Day-off
        wishes.push({ personId: person.id, dayIndex });
      }
    }
  }
  return wishes;
}

function computeRoleCaps({ days, holidaySet, employees, roleHardcapMode, weekdaySlots, weekendSlots }) {
  const klassKey = (klass) => (klass && klass.trim()) ? klass : '__none__';
  const roleDeviationLimit = (klass) => {
    if (!klass || klass === '__none__') return Number.POSITIVE_INFINITY;
    if (klass === 'R3') return 2;
    return roleHardcapMode === 'relaxed' ? 2 : 1;
  };

  const classSlots = new Map();
  const ensureClass = (k) => {
    if (!classSlots.has(k)) classSlots.set(k, { by: 0, eu: 0 });
    return classSlots.get(k);
  };

  for (const date of days) {
    ensureClass(requiredClassFor(date, holidaySet, 0)).by += 1;
    ensureClass(requiredClassFor(date, holidaySet, 1)).eu += 1;
  }

  const eligBy = new Map();
  const eligEu = new Map();
  for (const p of employees) {
    eligBy.set(p.id, 0);
    eligEu.set(p.id, 0);
  }

  for (const date of days) {
    const key = fmtDate(date);
    for (const p of employees) {
      if (p.vacationDays.has(key)) continue;
      const disallow = p.dutyUnavailable.has(key) || p.dayoffWish.has(key);
      if (!disallow && requiredClassFor(date, holidaySet, 0) === p.klass) {
        eligBy.set(p.id, (eligBy.get(p.id) || 0) + 1);
      }
      if (!disallow && requiredClassFor(date, holidaySet, 1) === p.klass) {
        eligEu.set(p.id, (eligEu.get(p.id) || 0) + 1);
      }
    }
  }

  const sumEligByClass = new Map();
  const sumEligEuClass = new Map();
  for (const p of employees) {
    const k = p.klass || '';
    sumEligByClass.set(k, (sumEligByClass.get(k) || 0) + (eligBy.get(p.id) || 0));
    sumEligEuClass.set(k, (sumEligEuClass.get(k) || 0) + (eligEu.get(p.id) || 0));
  }

  const capBy = new Map();
  const capEu = new Map();
  const minCapBy = new Map();
  const minCapEu = new Map();

  for (const p of employees) {
    const k = p.klass || '';
    const slots = classSlots.get(k) || { by: 0, eu: 0 };
    const sBy = sumEligByClass.get(k) || 0;
    const sEu = sumEligEuClass.get(k) || 0;
    const numInClass = Math.max(1, employees.filter((q) => q.klass === k).length);

    const tBy = sBy > 0 ? (slots.by * (eligBy.get(p.id) || 0) / sBy) : (slots.by / numInClass);
    const tEu = sEu > 0 ? (slots.eu * (eligEu.get(p.id) || 0) / sEu) : (slots.eu / numInClass);
    const limit = roleDeviationLimit(k);

    if (Number.isFinite(limit)) {
      capBy.set(p.id, Math.max(Math.ceil(tBy), Math.floor(tBy) + limit));
      capEu.set(p.id, Math.max(Math.ceil(tEu), Math.floor(tEu) + limit));
      minCapBy.set(p.id, Math.max(0, Math.ceil(tBy) - limit));
      minCapEu.set(p.id, Math.max(0, Math.ceil(tEu) - limit));
    } else {
      capBy.set(p.id, Number.POSITIVE_INFINITY);
      capEu.set(p.id, Number.POSITIVE_INFINITY);
      minCapBy.set(p.id, 0);
      minCapEu.set(p.id, 0);
    }
  }

  return { capBy, capEu, minCapBy, minCapEu };
}

function buildModel(ctx) {
  const {
    days,
    dayKeys,
    holidaySet,
    employees,
    capBy,
    capEu,
    minCapBy,
    minCapEu,
    dayoffWishes,
    weekKeys,
    start,
    weekMode,
    random,
    vacationKlasses,
    weekdaysInWeek,
    vacationWeekdays,
    enforceR3WeeklyCap,
    enforceR1WeeklyCap,
    enforceDayoffBalance,
    weeklyHourCapMode,
    unavoidableWeekKeys,
  } = ctx;

  const model = {
    optimize: 'penalty',
    opType: 'min',
    constraints: {},
    variables: {},
    binaries: {},
  };

  const assignmentVars = [];
  const underfillVars = [];

  // Day-off wish constraints (force duty on the day before wished Day-off)
  for (const wish of dayoffWishes) {
    const constraintName = `wish_${wish.personId}_${wish.dayIndex}`;
    model.constraints[constraintName] = { equal: 1 }; // Force duty
  }

  // Slot constraints and underfill variables
  for (let i = 0; i < days.length; i += 1) {
    for (let slot = 0; slot < 2; slot += 1) {
      const constraintName = slotConstraintName(i, slot);
      model.constraints[constraintName] = { equal: 1 };
    }
  }

  // Person-day uniqueness and consecutive constraints
  for (const person of employees) {
    for (let dayIdx = 0; dayIdx < days.length; dayIdx += 1) {
      model.constraints[personDayConstraint(person.id, dayIdx)] = { max: 1 };
      if (dayIdx < days.length - 1) {
        model.constraints[personConsecutiveConstraint(person.id, dayIdx)] = { max: 1 };
      }
    }
  }

  /*
  // Total weekly hour constraints (duty + regular)
  // The logic is: Total Hours <= cap
  // Total Hours = Base Regular Hours + Extra Hours
  // Base Regular Hours = (numWeekdaysInWeek - numVacationDays) * REGULAR_HOURS
  // Extra Hours = (Sum of Duty Hours) - (Sum of Saved Regular Hours from Day-offs)
  // So, we model `Extra Hours` on the LHS of the constraint.
  // Extra Hours <= cap - Base Regular Hours
  for (const person of employees) {
    for (const wk of weekKeys) {
      let cap;
      if (weeklyHourCapMode === 'strict') {
        cap = vacationKlasses.has(person.klass) ? 80 : 72;
      } else {
        cap = 80;
      }

      const numWeekdays = weekdaysInWeek.get(wk) || 0;
      const numVacationDays = vacationWeekdays.get(person.id)?.get(wk) || 0;
      
      const baseRegularHours = (numWeekdays - numVacationDays) * REGULAR_HOURS;
      const rhs = cap - baseRegularHours;

      const constraintName = `total_week_hours_${person.id}_${wk}`;
      model.constraints[constraintName] = { max: rhs };
      console.log(`[ILP MODEL] Constraint Added: Person=${person.name}, Week=${wk}, MaxExtraHours=${rhs.toFixed(1)} (Cap=${cap}, BaseRegular=${baseRegularHours.toFixed(1)})`);
    }
  }
  */

  const r3s = employees.filter(p => p.klass === 'R3');

  if (enforceDayoffBalance) {
    // Day-off balance constraints (+/-2 for all residents)
    let actualPossibleDayoffs = 0;
    for (let i = 0; i < days.length; i++) {
      const currentDay = days[i];
      const nextDay = days[i + 1];
      if (nextDay && isWorkday(currentDay, holidaySet) && isWorkday(nextDay, holidaySet)) {
        actualPossibleDayoffs += 2;
      }
    }
    const totalDayoffs = actualPossibleDayoffs;
    const eligibleForDayoffCap = employees; // Apply to all employees
    const avgDayoffs = totalDayoffs / Math.max(1, eligibleForDayoffCap.length);
    const minDayoffs = Math.max(0, Math.floor(avgDayoffs) - 2); // Changed to 2
    const maxDayoffs = Math.ceil(avgDayoffs) + 2; // Changed to 2

    for (const person of eligibleForDayoffCap) {
      const carryover = person.carryover.off || 0;
      model.constraints[`dayoff_cap_${person.id}`] = {
        min: minDayoffs - carryover,
        max: maxDayoffs - carryover,
      };
    }

    // R3-specific relative day-off balancing is now removed.
  }

  // R3 non-pediatric pair balancing (+/-1)
  const r3NonPediatricPair = employees.filter(p => p.klass === 'R3' && !p.pediatric);
  if (r3NonPediatricPair.length === 2) {
    const p1 = r3NonPediatricPair[0].id;
    const p2 = r3NonPediatricPair[1].id;
    model.constraints[`r3_balance_byung_1`] = { max: 1 };
    model.constraints[`r3_balance_byung_2`] = { max: 1 };
    model.constraints[`r3_balance_eung_1`] = { max: 1 };
    model.constraints[`r3_balance_eung_2`] = { max: 1 };
    model.constraints[`r3_balance_dayoff_1`] = { max: 1 };
    model.constraints[`r3_balance_dayoff_2`] = { max: 1 };
  }

  // R3 주 1회 당직 제약
  if (enforceR3WeeklyCap) {
    for (const person of r3s) {
      for (const wk of weekKeys) {
        const constraintName = `r3_weekly_cap_${person.id}_${wk}`;
        model.constraints[constraintName] = { max: 1 };
      }
    }
  }

  // R1 주 2회 당직 제약
  if (enforceR1WeeklyCap) {
    const r1s = employees.filter(p => p.klass === 'R1');
    for (const person of r1s) {
      for (const wk of weekKeys) {
        const constraintName = `r1_weekly_cap_${person.id}_${wk}`;
                    const cap = unavoidableWeekKeys.has(wk) ? 3 : 2;
                    model.constraints[constraintName] = { max: cap };      }
    }
  }

  // Role caps
  for (const person of employees) {
    if (person.klass === 'R3') {
      // R3: Combined cap for byung+eung
      const maxCombined = (capBy.get(person.id) || 0) + (capEu.get(person.id) || 0);
      const minCombined = (minCapBy.get(person.id) || 0) + (minCapEu.get(person.id) || 0);
      const carryoverCombined = (person.carryover.byung || 0) + (person.carryover.eung || 0);
      const constraintName = `role_combined_${person.id}`;
      model.constraints[constraintName] = {
        min: minCombined - carryoverCombined,
        max: maxCombined - carryoverCombined,
      };
    } else {
      // Non-R3: Separate caps
      const maxBy = capBy.get(person.id);
      const minBy = minCapBy.get(person.id);
      if (Number.isFinite(maxBy)) {
        model.constraints[roleCapConstraint(person.id, 'byung')] = { 
          min: minBy - (person.carryover.byung || 0),
          max: maxBy - (person.carryover.byung || 0),
        };
      }
      const maxEu = capEu.get(person.id);
      const minEu = minCapEu.get(person.id);
      if (Number.isFinite(maxEu)) {
        model.constraints[roleCapConstraint(person.id, 'eung')] = { 
          min: minEu - (person.carryover.eung || 0),
          max: maxEu - (person.carryover.eung || 0),
        };
      }
    }
  }

  const priorCooldownIndex = buildPriorCooldown(days, employees);

  for (let dayIdx = 0; dayIdx < days.length; dayIdx += 1) {
    const date = days[dayIdx];
    const dayKey = dayKeys[dayIdx];
    const isWeekday = isWorkday(date, holidaySet);
    const dutyHours = isWeekday ? DUTY_HOURS.weekday : DUTY_HOURS.weekend;
    const weekKey = weekKeyByMode(date, start, weekMode);

    const nextDay = addDays(date, 1);
    const nextDayIsWorkday = (dayIdx < days.length - 1) && isWorkday(nextDay, holidaySet);

    for (let slot = 0; slot < 2; slot += 1) {
      const neededClass = requiredClassFor(date, holidaySet, slot);
      const slotConstraint = slotConstraintName(dayIdx, slot);

      for (const person of employees) {
        if (!isEligibleForSlot({ person, neededClass, date, dayKey, slot, isWeekday, holidaySet, dayIdx, priorCooldownIndex })) {
          continue;
        }
        const varName = `x_${dayIdx}_${slot}_${person.id}`;
        model.variables[varName] = {
          [slotConstraint]: 1,
          [personDayConstraint(person.id, dayIdx)]: 1,
          // Add a small random penalty to break ties between equally optimal solutions
          penalty: (random() * 0.001),
        };
        /*
        // Add to total week hours constraint.
        // The LHS accumulates "extra hours" on top of the base regular work week.
        // A duty adds its own hours, but also grants a day-off which *reduces* total hours.
        
        // 1. Add duty hours to the current week's extra hours.
        const dutyHour = isWeekday ? DUTY_HOURS.weekday : DUTY_HOURS.weekend;
        const weekHourConstraintName = `total_week_hours_${person.id}_${weekKey}`;
        if (!model.variables[varName][weekHourConstraintName]) {
          model.variables[varName][weekHourConstraintName] = 0;
        }
        model.variables[varName][weekHourConstraintName] += dutyHour;

        // 2. Subtract regular hours for the resulting day-off from the appropriate week's extra hours.
        const nextDay = addDays(date, 1);
        const nextDayIsWorkday = (dayIdx < days.length - 1) && isWorkday(nextDay, holidaySet);
        if (nextDayIsWorkday) {
          const nextDayWeekKey = weekKeyByMode(nextDay, start, weekMode);
          const nextWeekHourConstraintName = `total_week_hours_${person.id}_${nextDayWeekKey}`;
          if (!model.variables[varName][nextWeekHourConstraintName]) {
            model.variables[varName][nextWeekHourConstraintName] = 0;
          }
          model.variables[varName][nextWeekHourConstraintName] -= REGULAR_HOURS;
        }
        */

        // R3 주 1회 당직 제약 변수 추가
        if (enforceR3WeeklyCap && person.klass === 'R3') {
          const constraintName = `r3_weekly_cap_${person.id}_${weekKey}`;
          if (model.constraints[constraintName]) {
            model.variables[varName][constraintName] = 1;
          }
        }

        // R1 주 2회 당직 제약 변수 추가
        if (enforceR1WeeklyCap && person.klass === 'R1') {
          const constraintName = `r1_weekly_cap_${person.id}_${weekKey}`;
          if (model.constraints[constraintName]) {
            model.variables[varName][constraintName] = 1;
          }
        }

        // Add to day-off cap constraint if applicable
        if (nextDayIsWorkday) {
          if (person.klass !== 'R3') {
            model.variables[varName][`dayoff_cap_${person.id}`] = 1;
          } else if (r3s.length > 1) {
            model.variables[varName][`r3_dayoff_link_min_${person.id}`] = 1;
            model.variables[varName][`r3_dayoff_link_max_${person.id}`] = 1;
          }
        }

        // Add to day-off wish constraint if it exists
        const wishConstraintName = `wish_${person.id}_${dayIdx}`;
        if (model.constraints[wishConstraintName]) {
          model.variables[varName][wishConstraintName] = 1;
        }
        if (person.klass === 'R3') {
          model.variables[varName][`role_combined_${person.id}`] = 1;
        } else {
          if (slot === 0 && model.constraints[roleCapConstraint(person.id, 'byung')]) {
            model.variables[varName][roleCapConstraint(person.id, 'byung')] = 1;
          }
          if (slot === 1 && model.constraints[roleCapConstraint(person.id, 'eung')]) {
            model.variables[varName][roleCapConstraint(person.id, 'eung')] = 1;
          }
        }

        // Add to R3 non-pediatric pair balancing constraints
        if (r3NonPediatricPair.length === 2) {
          const p1Id = r3NonPediatricPair[0].id;
          const p2Id = r3NonPediatricPair[1].id;
          if (person.id === p1Id || person.id === p2Id) {
            const sign = person.id === p1Id ? 1 : -1;
            if (slot === 0) {
              model.variables[varName][`r3_balance_byung_1`] = sign;
              model.variables[varName][`r3_balance_byung_2`] = -sign;
            }
            if (slot === 1) {
              model.variables[varName][`r3_balance_eung_1`] = sign;
              model.variables[varName][`r3_balance_eung_2`] = -sign;
            }
            if (nextDayIsWorkday) {
              model.variables[varName][`r3_balance_dayoff_1`] = sign;
              model.variables[varName][`r3_balance_dayoff_2`] = -sign;
            }
          }
        }

        if (dayIdx > 0) {
          model.variables[varName][personConsecutiveConstraint(person.id, dayIdx - 1)] = 1;
        }
        if (dayIdx < days.length - 1) {
          model.variables[varName][personConsecutiveConstraint(person.id, dayIdx)] = 1;
        }
        model.binaries[varName] = 1;
        assignmentVars.push({ name: varName, dayIndex: dayIdx, slot, personId: person.id });
      }
    }
  }

  return { model, assignmentVars, underfillVars };
}




function isEligibleForSlot({ person, neededClass, date, dayKey, slot, isWeekday, holidaySet, dayIdx, priorCooldownIndex }) {
  if ((person.klass || '') !== neededClass) return false;
  if (person.vacationDays.has(dayKey)) return false;
  if (person.dutyUnavailable.has(dayKey)) return false;
  if (person.dayoffWish.has(dayKey)) return false;
  if (priorCooldownIndex.get(person.id)?.has(dayIdx)) return false;
  if (date.getDay() === 3 && person.klass === 'R3' && person.pediatric) return false;
  return true;
}

function buildPriorCooldown(days, employees) {
  const map = new Map();
  for (const person of employees) {
    map.set(person.id, new Set());
  }
  if (days.length > 0) {
    for (const p of employees) {
      if (p.isPriorDuty) {
        map.get(p.id).add(0);
      }
    }
  }
  return map;
}

function slotConstraintName(dayIdx, slot) {
  return `slot_${dayIdx}_${slot}`;
}

function personDayConstraint(personId, dayIdx) {
  return `pd_${personId}_${dayIdx}`;
}

function personConsecutiveConstraint(personId, dayIdx) {
  return `pc_${personId}_${dayIdx}`;
}

function weekHardConstraint(personId, weekKey) {
  return `wh_${personId}_${weekKey}`;
}

function weekSoftConstraint(personId, weekKey) {
  return `ws_${personId}_${weekKey}`;
}

function totalHardConstraint(personId) {
  return `th_${personId}`;
}

function totalSoftConstraint(personId) {
  return `ts_${personId}`;
}

function roleCapConstraint(personId, role) {
  return `role_${role}_${personId}`;
}

function buildResultFromSolution({ ctx, assignmentVars, underfillVars, solution, elapsedMs }) {
  const { days, holidaySet, start, weekMode, employees, priorDayDuty } = ctx;

  const schedule = days.map((date) => ({
    date,
    key: fmtDate(date),
    weekKey: weekKeyByMode(date, start, weekMode),
    duties: [null, null],
    regulars: [],
    underfilled: false,
    reasons: [],
  }));

  let hasUnderfill = false;
  for (const u of underfillVars) {
    if ((solution[u.name] || 0) > 0.5) {
      const cell = schedule[u.dayIndex];
      cell.underfilled = true;
      cell.reasons.push('해당 슬롯을 채우지 못했습니다.');
      hasUnderfill = true;
    }
  }

  for (const assign of assignmentVars) {
    if ((solution[assign.name] || 0) > 0.5) {
      const cell = schedule[assign.dayIndex];
      const person = employees.find((p) => p.id === assign.personId);
      if (!person) continue;
      cell.duties[assign.slot] = { id: person.id, name: person.name };
    }
  }

  const processedSchedule = schedule.map((cell) => ({
    ...cell,
    duties: cell.duties.filter(Boolean),
  }));

  const peopleState = rebuildLedger({ ctx, schedule: processedSchedule });

  const warnings = buildWarnings({ people: peopleState });
  if (hasUnderfill) {
    warnings.push('빈 슬롯이 남아 있습니다. 제약 조건을 확인해주세요.');
  }

  const totalDutyHours = peopleState.reduce((sum, p) => sum + (p._dutyHoursAccum || 0), 0);
  const avgDutyHours = totalDutyHours / Math.max(1, peopleState.length);
  const totals = peopleState.map((p) => Object.values(p.weeklyHours || {}).reduce((a, b) => a + b, 0));
  const totalSum = totals.reduce((a, b) => a + b, 0);
  const avgTotalHours = totalSum / Math.max(1, peopleState.length);

  const stats = peopleState.map((p, idx) => ({
    id: p.id,
    name: p.name,
    dutyCount: p.dutyCount,
    weekdayDutyCount: p.weekdayDutyCount,
    weekendDutyCount: p.weekendDutyCount,
    dutyHours: Math.round(p._dutyHoursAccum || 0),
    weeklyHours: p.weeklyHours,
    totalHours: totals[idx],
    dutyHoursDelta: round1((p._dutyHoursAccum || 0) - avgDutyHours),
    totalHoursDelta: round1(totals[idx] - avgTotalHours),
  }));

  for (const cell of processedSchedule) {
    const emergencyBack = employees.find((p) => p.emergency && p.klass === 'R3');
    if (emergencyBack) {
      cell.back = { id: emergencyBack.id, name: emergencyBack.name };
    }
  }

  return {
    startDate: fmtDate(start),
    weeks: ctx.weeks,
    holidays: [...holidaySet],
    employees: employees.map(({ id, name, preference, klass, pediatric, emergency }) => ({ id, name, preference, klass, pediatric, emergency })),
    endDate: fmtDate(addDays(start, ctx.totalDays - 1)),
    schedule: processedSchedule,
    config: {
      weekMode: ctx.weekMode,
      weekdaySlots: ctx.weekdaySlots,
      weekendSlots: ctx.weekendSlots,
      roleHardcapMode: ctx.roleHardcapMode,
      priorDayDuty,
    },
    randomSeed: null,
    warnings,
    stats,
    fairness: {
      avgDutyHours: round1(avgDutyHours),
      totalDutyHours,
      avgTotalHours: round1(avgTotalHours),
    },
    meta: { elapsedMs },
  };
}

function rebuildLedger({ ctx, schedule }) {
  const { weekKeys, start, weekMode, holidaySet, employees, priorDayDuty } = ctx;
  const people = employees.map((p) => ({
    ...p,
    weeklyHours: Object.fromEntries(weekKeys.map((wk) => [wk, 0])),
    dutyCount: 0, weekdayDutyCount: 0, weekendDutyCount: 0,
    _dutyHoursAccum: 0, _byung: 0, _eung: 0,
    regularOffDayKeys: new Set(),
    lastDutyIndex: -999,
  }));
  const byId = new Map(people.map((p) => [p.id, p]));

  // Step 1: Determine all day-offs first.
  if (priorDayDuty) {
    const names = new Set([priorDayDuty.byung, priorDayDuty.eung].filter(Boolean));
    if (names.size > 0 && ctx.days.length > 0) {
      const firstDay = ctx.days[0];
      if (isWorkday(firstDay, holidaySet)) {
        for (const p of people) {
          if (names.has(p.name)) p.regularOffDayKeys.add(fmtDate(firstDay));
        }
      }
    }
  }
  for (const cell of schedule) {
    const date = cell.date;
    (cell.duties || []).forEach((duty) => {
      const p = byId.get(duty?.id);
      if (!p) return;
      const nextDay = addDays(date, 1);
      if (isWorkday(nextDay, holidaySet)) {
        p.regularOffDayKeys.add(fmtDate(nextDay));
      }
    });
  }

  // Step 2: Calculate total hours day by day, correctly.
  for (const cell of schedule) {
    const key = cell.key;
    const date = cell.date;
    const weekKey = weekKeyByMode(date, start, weekMode);
    const workday = isWorkday(date, holidaySet);
    const dutyIdsOnThisDay = new Set((cell.duties || []).map(d => d.id));

    for (const p of people) {
      if (p.vacationDays.has(key)) continue;

      const isOnDuty = dutyIdsOnThisDay.has(p.id);
      const isDayOff = p.regularOffDayKeys.has(key);
      let hoursForThisDay = 0;

      if (workday) { // It's a workday
        if (!isDayOff) {
          hoursForThisDay += REGULAR_HOURS; // Add regular 8 hours
        }
        if (isOnDuty) {
          hoursForThisDay += DUTY_HOURS.weekday; // Add duty 13.5 hours on top
        }
      } else { // It's a weekend/holiday
        if (isOnDuty) {
          hoursForThisDay += DUTY_HOURS.weekend; // Only duty hours
        }
      }
      
      if (hoursForThisDay > 0) {
        p.weeklyHours[weekKey] = (p.weeklyHours[weekKey] || 0) + hoursForThisDay;
      }
      console.log(`[STAT CALC] Day=${key}, Person=${p.name}, Hours=${hoursForThisDay.toFixed(1)}, OnDuty=${isOnDuty}, DayOff=${isDayOff}, Vacation=${p.vacationDays.has(key)}`);
    }
  }

  // Step 3: Recalculate simple stats after all hours are calculated
  for (const cell of schedule) {
      const workday = isWorkday(cell.date, holidaySet);
      (cell.duties || []).forEach((duty, slot) => {
          const p = byId.get(duty?.id);
          if (!p) return;
          p.dutyCount += 1;
          p._dutyHoursAccum += workday ? (DUTY_HOURS.weekday + REGULAR_HOURS) : DUTY_HOURS.weekend;
          if (workday) p.weekdayDutyCount += 1; else p.weekendDutyCount += 1;
          if (slot === 0) p._byung += 1; else if (slot === 1) p._eung += 1;
      });
  }

  return people;
}
function buildWarnings({ people }) {
  const warnings = [];
  for (const p of people) {
    collectWeeklyWarnings(p, warnings, WEEK_HARD_MAX);
    collectTotalWarning(p, warnings, p.totalCapHours);
  }
  return [...new Set(warnings)];
}

function collectWeeklyWarnings(person, warnings, limit) {
  for (const [wk, hours] of Object.entries(person.weeklyHours || {})) {
    if (hours > limit + 1e-9) {
      warnings.push(`${person.name}의 ${wk} 주간 시간이 ${limit}h를 초과했습니다: ${round1(hours)}h`);
    }
  }
}

function collectTotalWarning(person, warnings, limit) {
  const total = Object.values(person.weeklyHours || {}).reduce((a, b) => a + b, 0);
  if (total > limit + 1e-9) {
    warnings.push(`${person.name}의 총합 시간이 ${limit}h를 초과했습니다: ${Math.round(total)}h`);
  }
}

function requiredClassFor(date, holidaySet, slotIndex) {
  const isWk = isWorkday(date, holidaySet);
  const dow = date.getDay();
  if (!isWk) {
    return slotIndex === 0 ? 'R2' : 'R1';
  }
  switch (dow) {
    case 1: return slotIndex === 0 ? 'R1' : 'R3';
    case 2: return slotIndex === 0 ? 'R1' : 'R4';
    case 3: return slotIndex === 0 ? 'R3' : 'R2';
    case 4: return slotIndex === 0 ? 'R1' : 'R2';
    case 5: return slotIndex === 0 ? 'R1' : 'R3';
    default: return slotIndex === 0 ? 'R2' : 'R1';
  }
}

function createPRNG(seed) {
  if (!Number.isFinite(seed)) {
    return Math.random;
  }
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 0) / 0x100000000;
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}