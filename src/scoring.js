import { fmtDate, addDays, weekKey } from './time.js';

export const SCORE_DEFAULTS = {
    overtimeSoft: 5,
    overtimeHard: 10,
    underwork: 0,
    dayoffBase: 0.5,
    dayoffIncrement: 1,
    roleBase: 1,
    roleIncrement: 1,
    roleSpread: 1,
    gapPenalty: 0,
    r1WeeklyOver: 10,
    r3WeeklyOver: 10,
    r2WeeklyUnder: 10,
    friSunPenalty: 0,
    sunTuePenalty: 0,
};

export const SCORE_CLASSES = ['R1', 'R2', 'R3', 'R4'];

let _scoreConfigs = null;

export function ensureScoreConfigs(currentInputs) {
    if (_scoreConfigs) return _scoreConfigs;
    // If no configs yet, initialize with defaults or provided inputs
    const base = currentInputs || { ...SCORE_DEFAULTS };
    _scoreConfigs = Object.fromEntries(SCORE_CLASSES.map(k => [k, { ...base }]));
    return _scoreConfigs;
}

export function setScoreConfig(klass, config) {
    ensureScoreConfigs();
    if (_scoreConfigs[klass]) {
        _scoreConfigs[klass] = config;
    }
}

export function getScoreWeights(currentGlobalInputs) {
    const global = currentGlobalInputs || { ...SCORE_DEFAULTS };
    const perClass = ensureScoreConfigs(global);
    return { global, perClass };
}

const EPSILON = 1e-6;

function applyPenalty(deltaAbs, base, increment) {
    if (!(deltaAbs > 0)) return 0;
    const steps = Math.max(0, deltaAbs - 1);
    const penalty = base + steps * increment;
    return Math.max(0, penalty);
}

export function calculateHourScore(result, perClassScore, weights) {
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

export function calculateCarryoverScore(result, perClassScore, weights, prevStats) {
    if (!result) return 0;
    let score = 0;
    const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);
    const empById = new Map(result.employees.map((e) => [e.id, e]));
    const klasses = [...new Set(result.employees.map(e => e.klass || '기타'))];

    for (const klass of klasses) {
        const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
        if (!peopleInClass.length) continue;

        const isR3 = klass === 'R3';
        const roles = isR3
            ? [
                { key: 'off', countMap: dayOff },
                { key: 'duty', countMap: new Map([...peopleInClass.map(p => [p.id, (byungCount.get(p.id) || 0) + (eungCount.get(p.id) || 0)])]) },
            ]
            : [
                { key: 'off', countMap: dayOff },
                { key: 'byung', countMap: byungCount },
                { key: 'eung', countMap: eungCount },
            ];

        for (const role of roles) {
            // For R3 'duty', combine byung and eung from previous stats
            let prevList = [];
            if (isR3 && role.key === 'duty') {
                const byungList = (prevStats.entriesByClassRole.get(klass)?.['byung']) || [];
                const eungList = (prevStats.entriesByClassRole.get(klass)?.['eung']) || [];
                const combined = new Map();
                for (const e of [...byungList, ...eungList]) {
                    combined.set(e.name, (combined.get(e.name) || 0) + (Number(e.delta) || 0));
                }
                prevList = [...combined.entries()].map(([name, delta]) => ({ name, delta }));
            } else {
                prevList = (prevStats.entriesByClassRole.get(klass)?.[role.key]) || [];
            }
            const prevByName = new Map(prevList.map((e) => [e.name, Number(e.delta) || 0]));
            const finalCounts = peopleInClass.map((p) => ({
                id: p.id,
                name: p.name,
                count: (Number(role.countMap.get(p.id) || 0)) + (prevByName.get(p.name) || 0),
            }));
            const { deltas } = computeCarryoverDeltas(finalCounts);
            const wClass = (weights.perClass?.[klass]) || {};
            let hasPlusOne = false;
            let hasMinusOne = false;
            for (const d of deltas) {
                const deltaAbs = Math.abs(d.delta);
                const add = role.key === 'off'
                    ? applyPenalty(deltaAbs, (wClass.dayoffBase ?? weights.global.dayoffBase), (wClass.dayoffIncrement ?? weights.global.dayoffIncrement))
                    : applyPenalty(deltaAbs, (wClass.roleBase ?? weights.global.roleBase), (wClass.roleIncrement ?? weights.global.roleIncrement));
                if (add) {
                    score += add;
                    if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
                }
                if (d.delta === 1) hasPlusOne = true;
                else if (d.delta === -1) hasMinusOne = true;
            }
            if (role.key !== 'off' && hasPlusOne && hasMinusOne) {
                const spreadPenalty = (wClass.roleSpread ?? weights.global.roleSpread);
                if (spreadPenalty) {
                    score += spreadPenalty;
                    if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + spreadPenalty);
                }
            }
        }
    }
    return score;
}

export function computeGapPenaltyCounts(result) {
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

export function getGapCounts(result) {
    if (!result) return new Map();
    const counts = computeGapPenaltyCounts(result);
    if (!result.meta) result.meta = {};
    result.meta.gapCounts = Object.fromEntries([...counts.entries()].map(([k, v]) => [String(k), Number(v) || 0]));
    return counts;
}

export function calculateGapPenalty(result, perClassScore, weights) {
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

function computeDayPairComboCounts(result, { startDow, endDow, offsetDays, metaKey }) {
    const counts = new Map();
    if (!result) return counts;
    const schedule = result.schedule || [];
    const dutiesByDate = new Map();
    for (const cell of schedule) {
        if (!cell?.date || !cell?.duties?.length) continue;
        dutiesByDate.set(fmtDate(new Date(cell.date)), cell.duties);
    }
    for (const cell of schedule) {
        if (!cell?.duties?.length) continue;
        const date = new Date(cell.date);
        if (date.getDay() !== startDow) continue;
        const targetDate = addDays(date, offsetDays);
        if (targetDate.getDay() !== endDow) continue;
        const sourceSet = new Set();
        for (const duty of cell.duties) {
            if (duty?.id == null) continue;
            sourceSet.add(duty.id);
        }
        if (!sourceSet.size) continue;
        const targetDuties = dutiesByDate.get(fmtDate(targetDate)) || [];
        for (const duty of targetDuties) {
            if (duty?.id == null) continue;
            if (!sourceSet.has(duty.id)) continue;
            counts.set(duty.id, (counts.get(duty.id) || 0) + 1);
        }
    }
    if (!result.meta) result.meta = {};
    if (metaKey) {
        result.meta[metaKey] = Object.fromEntries([...counts.entries()].map(([k, v]) => [String(k), Number(v) || 0]));
    }
    return counts;
}

export function computeFriSunComboCounts(result) {
    return computeDayPairComboCounts(result, {
        startDow: 5,
        endDow: 0,
        offsetDays: 2,
        metaKey: 'friSunComboCounts',
    });
}

export function getFriSunCounts(result) {
    if (!result) return new Map();
    return computeFriSunComboCounts(result);
}

export function calculateFriSunPenalty(result, perClassScore, weights) {
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

export function computeSunTueComboCounts(result) {
    return computeDayPairComboCounts(result, {
        startDow: 0,
        endDow: 2,
        offsetDays: 2,
        metaKey: 'sunTueComboCounts',
    });
}

export function getSunTueCounts(result) {
    if (!result) return new Map();
    return computeSunTueComboCounts(result);
}

export function calculateSunTuePenalty(result, perClassScore, weights) {
    const counts = getSunTueCounts(result);
    if (!counts.size) return 0;
    let score = 0;
    const empById = new Map(result.employees.map((e) => [e.id, e]));
    for (const [id, count] of counts.entries()) {
        const klass = empById.get(id)?.klass || '기타';
        const conf = (weights.perClass?.[klass]) || {};
        const penalty = conf.sunTuePenalty ?? weights.global.sunTuePenalty ?? 0;
        if (!penalty || !count) continue;
        const add = penalty * count;
        score += add;
        if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
    }
    return score;
}

export function calculateWeeklyDutyPenalty(result, perClassScore, weights) {
    if (!result || !result.stats) return 0;
    const empById = new Map(result.employees.map((e) => [e.id, e]));
    let score = 0;

    for (const person of result.stats) {
        const klass = empById.get(person.id)?.klass || '';
        const weeklyDuties = person.weeklyDuties || {};
        const conf = (weights.perClass?.[klass]) || {};

        for (const week of Object.keys(weeklyDuties)) {
            const count = Number(weeklyDuties[week]) || 0;

            // R1: 3회 이상 페널티
            if (klass === 'R1' && count >= 3) {
                const penalty = conf.r1WeeklyOver ?? weights.global.r1WeeklyOver ?? 0;
                const add = penalty * (count - 2); // 3회부터 페널티
                console.warn(`[WEEKLY DUTY] ${person.name} (R1): ${week} 주에 ${count}회 당직 → 페널티 ${add}점 (penalty=${penalty})`);
                score += add;
                if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
            }

            // R3: 2회 이상 페널티
            if (klass === 'R3' && count >= 2) {
                const penalty = conf.r3WeeklyOver ?? weights.global.r3WeeklyOver ?? 0;
                const add = penalty * (count - 1); // 2회부터 페널티
                console.warn(`[WEEKLY DUTY] ${person.name} (R3): ${week} 주에 ${count}회 당직 → 페널티 ${add}점 (penalty=${penalty})`);
                score += add;
                if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + add);
            }

            // R2: 0회 페널티
            if (klass === 'R2' && count === 0) {
                const penalty = conf.r2WeeklyUnder ?? weights.global.r2WeeklyUnder ?? 0;
                console.warn(`[WEEKLY DUTY] ${person.name} (R2): ${week} 주에 0회 당직 → 페널티 ${penalty}점`);
                score += penalty;
                if (perClassScore) perClassScore.set(klass, (perClassScore.get(klass) || 0) + penalty);
            }
        }
    }

    return score;
}

export function checkWeeklyDutyViolation(result) {
    if (!result || !result.stats) return false;
    const empById = new Map(result.employees.map((e) => [e.id, e]));

    for (const person of result.stats) {
        const klass = empById.get(person.id)?.klass || '';
        const weeklyDuties = person.weeklyDuties || {};

        for (const week of Object.keys(weeklyDuties)) {
            const count = Number(weeklyDuties[week]) || 0;

            // R1: 3회 이상이면 위반
            if (klass === 'R1' && count >= 3) {
                return true;
            }

            // R3: 2회 이상이면 위반
            if (klass === 'R3' && count >= 2) {
                return true;
            }
        }
    }

    return false;
}

export function stitchSchedulesByClass({ classes, bestByClass, base, weights, prevStats }) {
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
        const carryoverPerClass = new Map();
        const hourPerClass = new Map();
        const gapPerClass = new Map();
        const friSunPerClass = new Map();
        const sunTuePerClass = new Map();
        const weeklyPerClass = new Map();

        const hourScore = calculateHourScore(result, hourPerClass, weights);
        const carryoverScore = prevStats ? calculateCarryoverScore(result, carryoverPerClass, weights, prevStats) : 0;
        const gapScore = calculateGapPenalty(result, gapPerClass, weights);
        const friSunScore = calculateFriSunPenalty(result, friSunPerClass, weights);
        const sunTueScore = calculateSunTuePenalty(result, sunTuePerClass, weights);
        const weeklyDutyScore = calculateWeeklyDutyPenalty(result, weeklyPerClass, weights);
        const totalScore = hourScore + carryoverScore + gapScore + friSunScore + sunTueScore + weeklyDutyScore;

        // Combine into total perClassScore
        for (const klass of ['R1', 'R2', 'R3', 'R4']) {
            const total = (hourPerClass.get(klass) || 0) +
                (carryoverPerClass.get(klass) || 0) +
                (gapPerClass.get(klass) || 0) +
                (friSunPerClass.get(klass) || 0) +
                (sunTuePerClass.get(klass) || 0) +
                (weeklyPerClass.get(klass) || 0);
            if (total > 0) perClassScore.set(klass, total);
        }

        const breakdown = {
            hourScore, carryoverScore, gapScore, friSunScore, sunTueScore, weeklyDutyScore,
            hourPerClass, carryoverPerClass, gapPerClass, friSunPerClass, sunTuePerClass, weeklyPerClass,
            result,
            prevStats,
            weights
        };

        // Always return the merged schedule - let the caller decide based on score
        const hasWeeklyDutyViolation = checkWeeklyDutyViolation(result);
        const note = hasWeeklyDutyViolation
            ? '연차별 최저점 조합 스케줄 적용 (주당 당직 제약 위반 있음)'
            : '연차별 최저점 조합 스케줄 적용';

        return {
            passed: true,
            candidate: { result, totalScore, perClassScore, breakdown },
            note,
        };
    } catch (e) {
        console.warn('[stitchSchedulesByClass] fail:', e);
        return { passed: false, note: `조합 실패: ${e?.message || e}` };
    }
}

export function addWeeklyWarnings(result, limit) {
    const warns = [];
    for (const s of result.stats || []) {
        for (const [wk, hours] of Object.entries(s.weeklyHours || {})) {
            if (hours > limit + 1e-9) warns.push(`${s.name}의 ${wk} 주간 시간이 ${limit}h를 초과했습니다: ${Number(hours).toFixed(1)}h`);
        }
    }
    result.warnings = warns;
}

export function recomputeStatsInPlace(result) {
    const holidays = new Set(result.holidays || []);
    const employees = result.employees || [];
    const schedule = result.schedule || [];
    const people = employees.map((e) => ({ id: e.id, name: e.name, weeklyHours: {}, weeklyDuties: {}, totalHours: 0, gapA2: 0 }));

    const dayOffKeysById = new Map(people.map((p) => [p.id, new Set()]));
    const prior = result.config?.priorDayDuty || {};
    const prior2 = result.config?.prior2DayDuty || {};
    const priorNames = new Set([prior.byung, prior.eung].filter(Boolean));
    const prior2Names = new Set([prior2.byung, prior2.eung].filter(Boolean));
    const dayoffMode = result.config?.dayoffCountingMode || 'leading';

    const isWorkday = (date) => {
        const key = fmtDate(date);
        const wd = date.getDay();
        return wd >= 1 && wd <= 5 && !holidays.has(key);
    };

    if (dayoffMode === 'leading' && schedule.length > 0) {
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
        let targetDate = null;
        if (dayoffMode === 'trailing') {
            targetDate = addDays(new Date(cell.date), 1);
        } else {
            const next = schedule[i + 1];
            if (next) targetDate = new Date(next.date);
        }
        if (!targetDate || !isWorkday(targetDate)) continue;
        const key = fmtDate(targetDate);
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
            // Count weekly duties
            if (isOnDuty) {
                person.weeklyDuties[wkKey] = (person.weeklyDuties[wkKey] || 0) + 1;
            }
        }
    }

    result.stats = people;
    const gapCounts = getGapCounts(result);
    for (const person of people) {
        person.gapA2 = Number(gapCounts.get(person.id) || 0);
    }
}

export function computeCarryoverDeltas(entries, diagnostics = false) {
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

export function computeRoleAndOffCounts(result) {
    const byungCount = new Map();
    const eungCount = new Map();
    const dayOff = new Map();
    const holidays = new Set(result.holidays || []);
    const mode = result.config?.dayoffCountingMode || 'leading';

    const isWorkdayLocal = (date) => {
        const d = new Date(date);
        const key = fmtDate(d);
        const wd = d.getDay();
        return wd >= 1 && wd <= 5 && !holidays.has(key);
    };

    // Fix: Account for prior day duty causing a day-off on the first day
    if (mode === 'leading' && result.schedule.length > 0) {
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
        if (cell.duties && cell.duties.length) {
            const b = cell.duties[0]; if (b) byungCount.set(b.id, (byungCount.get(b.id) || 0) + 1);
            const e = cell.duties[1]; if (e) eungCount.set(e.id, (eungCount.get(e.id) || 0) + 1);
        }
        let targetDate = null;
        if (mode === 'trailing') {
            targetDate = addDays(new Date(cell.date), 1);
        } else {
            const next = result.schedule[i + 1];
            if (next) targetDate = new Date(next.date);
        }
        if (targetDate && isWorkdayLocal(targetDate)) {
            for (const d of (cell.duties || [])) dayOff.set(d.id, (dayOff.get(d.id) || 0) + 1);
        }
    }
    return { byungCount, eungCount, dayOff };
}
