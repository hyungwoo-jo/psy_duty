import { computeCarryoverDeltas } from './scoring.js';

export function renderScoreBreakdownDetailed(candidate, report) {
    if (!candidate || !candidate.breakdown) return;

    const bd = candidate.breakdown;
    const result = bd.result;
    const prevStats = bd.prevStats || { entriesByClassRole: new Map() };
    const weights = bd.weights || {};

    if (!result) return;

    const empById = new Map(result.employees.map((e) => [e.id, e]));
    const gapCounts = result.meta?.gapCounts || {};
    const friSunCounts = result.meta?.friSunComboCounts || {};
    const sunTueCounts = result.meta?.sunTueComboCounts || {};

    const wrap = document.createElement('details');
    wrap.open = false;
    const summaryEl = document.createElement('summary');
    summaryEl.textContent = `점수 상세 (총점: ${candidate.totalScore.toFixed(1)})`;
    wrap.appendChild(summaryEl);

    const container = document.createElement('div');
    container.style.padding = '1rem';

    const order = ['R1', 'R2', 'R3', 'R4'];
    for (const klass of order) {
        const total = candidate.perClassScore.get(klass) ?? 0;
        if (total <= 0) continue;

        const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
        if (!peopleInClass.length) continue;

        // Class header
        const header = document.createElement('h4');
        header.textContent = `${klass} (합계: ${total.toFixed(1)}점)`;
        header.style.marginTop = '1rem';
        header.style.marginBottom = '0.5rem';
        container.appendChild(header);

        const list = document.createElement('ul');
        list.style.listStyle = 'none';
        list.style.padding = '0';
        list.style.margin = '0';

        // 1. Carryover (Day-off + 역할 편차)
        const carryScore = bd.carryoverPerClass?.get(klass) || 0;
        if (carryScore > 0) {
            renderCarryoverDetails(list, klass, peopleInClass, prevStats, weights, result, empById);
        }

        // 2. Hour penalties
        const hourScore = bd.hourPerClass?.get(klass) || 0;
        if (hourScore > 0) {
            renderHourDetails(list, klass, peopleInClass, weights);
        }

        // 3. Gap penalties
        const gapScore = bd.gapPerClass?.get(klass) || 0;
        if (gapScore > 0) {
            renderGapDetails(list, klass, peopleInClass, gapCounts, weights);
        }

        // 4. FriSun penalties
        const friSunScore = bd.friSunPerClass?.get(klass) || 0;
        if (friSunScore > 0) {
            renderFriSunDetails(list, klass, peopleInClass, friSunCounts, weights);
        }

        const sunTueScore = bd.sunTuePerClass?.get(klass) || 0;
        if (sunTueScore > 0) {
            renderSunTueDetails(list, klass, peopleInClass, sunTueCounts, weights);
        }

        // 5. Weekly duty penalties
        const weeklyScore = bd.weeklyPerClass?.get(klass) || 0;
        if (weeklyScore > 0) {
            renderWeeklyDetails(list, klass, peopleInClass, weights);
        }

        container.appendChild(list);
    }

    wrap.appendChild(container);
    report.prepend(wrap);
}

function renderCarryoverDetails(list, klass, peopleInClass, prevStats, weights, result, empById) {
    const isR3 = klass === 'R3';
    const wClass = (weights.perClass?.[klass]) || {};

    const { byungCount, eungCount, dayOff } = computeRoleAndOffCountsLocal(result);

    const roles = isR3
        ? [
            { key: 'off', name: 'Day-off', countMap: dayOff },
            { key: 'duty', name: '당직', countMap: new Map([...peopleInClass.map(p => [p.id, (byungCount.get(p.id) || 0) + (eungCount.get(p.id) || 0)])]) },
        ]
        : [
            { key: 'off', name: 'Day-off', countMap: dayOff },
            { key: 'byung', name: '병당', countMap: byungCount },
            { key: 'eung', name: '응당', countMap: eungCount },
        ];

    for (const role of roles) {
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
        if (deltas.length === 0) continue;

        const base = role.key === 'off'
            ? (wClass.dayoffBase ?? weights.global?.dayoffBase ?? 0.5)
            : (wClass.roleBase ?? weights.global?.roleBase ?? 1);
        const inc = role.key === 'off'
            ? (wClass.dayoffIncrement ?? weights.global?.dayoffIncrement ?? 1)
            : (wClass.roleIncrement ?? weights.global?.roleIncrement ?? 1);

        const deltaStrs = deltas.map(d => {
            const deltaAbs = Math.abs(d.delta);
            const steps = Math.max(0, deltaAbs - 1);
            const penalty = base + steps * inc;
            return `${d.name} ${d.delta > 0 ? '+' : ''}${d.delta} (${penalty.toFixed(1)}점)`;
        });

        const totalPenalty = deltas.reduce((sum, d) => {
            const deltaAbs = Math.abs(d.delta);
            const steps = Math.max(0, deltaAbs - 1);
            return sum + base + steps * inc;
        }, 0);

        const li = document.createElement('li');
        li.style.marginBottom = '0.5rem';
        li.innerHTML = `<strong>${role.name} 편차:</strong> ${deltaStrs.join(', ')} | 합계 ${totalPenalty.toFixed(1)}점`;
        list.appendChild(li);
    }
}

function renderHourDetails(list, klass, peopleInClass, weights) {
    const wClass = (weights.perClass?.[klass]) || {};
    const soft = (wClass.overtimeSoft ?? weights.global?.overtimeSoft ?? 1);
    const hard = (wClass.overtimeHard ?? weights.global?.overtimeHard ?? 2);
    const under = (wClass.underwork ?? weights.global?.underwork ?? 1);

    const violations = [];
    for (const person of peopleInClass) {
        const weekly = person.weeklyHours || {};
        for (const [week, hours] of Object.entries(weekly)) {
            const h = Math.round(hours * 10) / 10;
            if (h >= 75 - 1e-6) {
                violations.push(`${person.name} ${week} ${h}h (${hard}점)`);
            } else if (h > 72 + 1e-6) {
                violations.push(`${person.name} ${week} ${h}h (${soft}점)`);
            } else if (h < 40 - 1e-6) {
                violations.push(`${person.name} ${week} ${h}h (${under}점)`);
            }
        }
    }

    if (violations.length > 0) {
        const li = document.createElement('li');
        li.style.marginBottom = '0.5rem';
        li.innerHTML = `<strong>시간 위반:</strong> ${violations.join(', ')}`;
        list.appendChild(li);
    }
}

function renderGapDetails(list, klass, peopleInClass, gapCounts, weights) {
    const wClass = (weights.perClass?.[klass]) || {};
    const gap = wClass.gapPenalty ?? weights.global?.gapPenalty ?? 0.5;

    const items = [];
    for (const person of peopleInClass) {
        const count = Number(gapCounts[person.id]) || 0;
        if (count > 0) {
            items.push(`${person.name} ${count}회 (${(gap * count).toFixed(1)}점)`);
        }
    }

    if (items.length > 0) {
        const li = document.createElement('li');
        li.style.marginBottom = '0.5rem';
        li.innerHTML = `<strong>OFF 하나 간격 반복:</strong> ${items.join(', ')}`;
        list.appendChild(li);
    }
}

function renderFriSunDetails(list, klass, peopleInClass, friSunCounts, weights) {
    const wClass = (weights.perClass?.[klass]) || {};
    const penalty = wClass.friSunPenalty ?? weights.global?.friSunPenalty ?? 1;

    const items = [];
    for (const person of peopleInClass) {
        const count = Number(friSunCounts[person.id]) || 0;
        if (count > 0) {
            items.push(`${person.name} ${count}회 (${(penalty * count).toFixed(1)}점)`);
        }
    }

    if (items.length > 0) {
        const li = document.createElement('li');
        li.style.marginBottom = '0.5rem';
        li.innerHTML = `<strong>금·일 동시 당직:</strong> ${items.join(', ')}`;
        list.appendChild(li);
    }
}

function renderSunTueDetails(list, klass, peopleInClass, sunTueCounts, weights) {
    const wClass = (weights.perClass?.[klass]) || {};
    const penalty = wClass.sunTuePenalty ?? weights.global?.sunTuePenalty ?? 1;

    const items = [];
    for (const person of peopleInClass) {
        const count = Number(sunTueCounts[person.id]) || 0;
        if (count > 0) {
            items.push(`${person.name} ${count}회 (${(penalty * count).toFixed(1)}점)`);
        }
    }

    if (items.length > 0) {
        const li = document.createElement('li');
        li.style.marginBottom = '0.5rem';
        li.innerHTML = `<strong>일·화 동시 당직:</strong> ${items.join(', ')}`;
        list.appendChild(li);
    }
}

function renderWeeklyDetails(list, klass, peopleInClass, weights) {
    const wClass = (weights.perClass?.[klass]) || {};

    const items = [];
    for (const person of peopleInClass) {
        const weeklyDuties = person.weeklyDuties || {};
        for (const [week, count] of Object.entries(weeklyDuties)) {
            const c = Number(count) || 0;

            if (klass === 'R1' && c >= 3) {
                const penalty = wClass.r1WeeklyOver ?? weights.global?.r1WeeklyOver ?? 10;
                const add = penalty * (c - 2);
                items.push(`${person.name} ${week} ${c}회 (${add.toFixed(1)}점)`);
            } else if (klass === 'R3' && c >= 2) {
                const penalty = wClass.r3WeeklyOver ?? weights.global?.r3WeeklyOver ?? 10;
                const add = penalty * (c - 1);
                items.push(`${person.name} ${week} ${c}회 (${add.toFixed(1)}점)`);
            } else if (klass === 'R2' && c === 0) {
                const penalty = wClass.r2WeeklyUnder ?? weights.global?.r2WeeklyUnder ?? 10;
                items.push(`${person.name} ${week} 0회 (${penalty.toFixed(1)}점)`);
            }
        }
    }

    if (items.length > 0) {
        const li = document.createElement('li');
        li.style.marginBottom = '0.5rem';
        const label = klass === 'R1' ? 'R1 주당 3회 이상' : klass === 'R3' ? 'R3 주당 2회 이상' : 'R2 주당 0회';
        li.innerHTML = `<strong>${label}:</strong> ${items.join(', ')}`;
        list.appendChild(li);
    }
}

function computeRoleAndOffCountsLocal(result) {
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

    for (let i = 0; i < result.schedule.length; i++) {
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

function fmtDate(date) {
    const d = new Date(date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}
