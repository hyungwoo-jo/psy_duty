import { renderCalendar } from './calendar-ui.js';
import {
    SCORE_DEFAULTS,
    SCORE_CLASSES,
    ensureScoreConfigs,
    setScoreConfig,
    getScoreWeights
} from './scoring.js';
import { fmtDate, addDays, weekKey } from './time.js';
import { renderScoreBreakdownDetailed } from './ui-controller-breakdown.js';

// DOM Elements
const startInput = document.querySelector('#start-date');
const weeksInput = document.querySelector('#weeks');
const retryAttemptsInput = document.querySelector('#retry-attempts');
const endInput = document.querySelector('#end-date');
// const employeesInput = document.querySelector('#employees'); // Removed
const empR1Input = document.querySelector('#emp-r1');
const empR2Input = document.querySelector('#emp-r2');
const empR3Input = document.querySelector('#emp-r3');
const empR4Input = document.querySelector('#emp-r4');

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
const hardcapModeLabel = document.querySelector('#role-hardcap-mode-label');
const toggleR3Balance = document.querySelector('#toggle-r3-balance');
const toggleDayoffWish = document.querySelector('#toggle-dayoff-wish');
const toggleDayoffCounting = document.querySelector('#toggle-dayoff-trailing');
const toggleR3PediatricWed = document.querySelector('#toggle-r3-ped-wed');
const toggleVacationBan = document.querySelector('#toggle-vacation-ban');
const toggleUnavailableBan = document.querySelector('#toggle-unavailable-ban');
const excludeR4Toggle = document.querySelector('#exclude-r4-mode');
const dayoffBalanceToggle = document.querySelector('#dayoff-balance-toggle');
const weeklyHourCapToggle = document.querySelector('#toggle-weekly-hour-cap');

// Score Inputs
const scoreOvertimeSoft = document.querySelector('#score-overtime-soft');
const scoreOvertimeHard = document.querySelector('#score-overtime-hard');
const scoreUnder40Penalty = document.querySelector('#score-under-40');
const scoreDayoffBase = document.querySelector('#score-dayoff-base');
const scoreDayoffIncrement = document.querySelector('#score-dayoff-increment');
const scoreRoleBase = document.querySelector('#score-role-base');
const scoreRoleIncrement = document.querySelector('#score-role-increment');
const scoreRoleSpread = document.querySelector('#score-role-spread');
const scoreGapPenalty = document.querySelector('#score-gap2');
const scoreFriSunPenalty = document.querySelector('#score-fri-sun');
const scoreSunTuePenalty = document.querySelector('#score-sun-tue');
const scoreR1WeeklyOver = document.querySelector('#score-r1-weekly-over');
const scoreR3WeeklyOver = document.querySelector('#score-r3-weekly-over');
const scoreR2WeeklyUnder = document.querySelector('#score-r2-weekly-under');

let _scoreClass = 'R1';

export function bindEvents(callbacks) {
    const { onGenerate, onExportXlsx, onExportIcs, onLoadHolidays } = callbacks;

    generateBtn?.addEventListener('click', onGenerate);
    exportXlsxBtn?.addEventListener('click', onExportXlsx);
    exportIcsBtn?.addEventListener('click', onExportIcs);

    // employeesInput?.addEventListener('input', debounce(renderPreviousStatsUI, 250));
    [empR1Input, empR2Input, empR3Input, empR4Input].forEach(el => {
        el?.addEventListener('input', debounce(renderPreviousStatsUI, 250));
    });

    ['change', 'input'].forEach((ev) => {
        startInput?.addEventListener(ev, updateIcsPreview);
        endInput?.addEventListener(ev, updateIcsPreview);
        weeksInput?.addEventListener(ev, updateIcsPreview);
        icsVersionInput?.addEventListener(ev, updateIcsPreview);
    });

    hardcapToggle?.addEventListener('change', () => {
        updateHardcapToggleLabel();
    });

    document.querySelector('#load-kr-holidays')?.addEventListener('click', loadKRHolidays);
    document.querySelector('#clear-holidays')?.addEventListener('click', () => { holidaysInput.value = ''; });

    document.querySelector('#show-calendar')?.addEventListener('click', () => {
        const excludeR4 = excludeR4Toggle?.checked || false;
        renderCalendar(startInput, endInput, weeksInput, holidaysInput, getWeeksCount, parseHolidays, excludeR4);
    });

    bindScoreClassTabs();
}

async function loadKRHolidays() {
    const merge = true;
    try {
        const startValue = startInput.value;
        if (!startValue) {
            alert('시작일/종료일 또는 주 수를 먼저 지정해주세요.');
            return;
        }
        const start = new Date(startValue);
        const weeks = getWeeksCount();
        const endValue = endInput.value;
        const end = endValue ? new Date(endValue) : addDays(start, weeks * 7 - 1);

        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
            alert('날짜 형식이 올바르지 않습니다.');
            return;
        }

        setLoading(true, '공휴일 불러오는 중…');
        const years = new Set();
        for (let y = start.getFullYear(); y <= end.getFullYear(); y++) years.add(y);

        const fetched = new Set();
        for (const y of years) {
            try {
                const res = await fetch(`https://date.nager.at/api/v3/PublicHolidays/${y}/KR`);
                if (!res.ok) throw new Error('fetch failed');
                const data = await res.json();
                for (const it of data) {
                    if (!it?.date) continue;
                    const d = new Date(it.date);
                    if (!Number.isNaN(d.getTime()) && d >= start && d <= end) fetched.add(String(it.date));
                }
            } catch (e) {
                // 네트워크 실패 시 고정일 공휴일만 보정
                for (const day of fixedKRHolidays(y)) {
                    const d = new Date(day);
                    if (!Number.isNaN(d.getTime()) && d >= start && d <= end) fetched.add(day);
                }
            }
        }
        const { add: curAdd, remove: curRemove } = parseHolidaysWithRemoves(holidaysInput.value);
        const base = merge ? new Set([...curAdd, ...fetched]) : new Set([...fetched]);
        for (const d of curRemove) base.delete(d);
        const list = [...base].sort();
        holidaysInput.value = list.join('\n');
    } catch (e) {
        console.error(e);
        alert('공휴일 불러오기에 실패했습니다.');
    } finally { setLoading(false); }
}

function fixedKRHolidays(year) {
    const mk = (m, d) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return new Set([
        mk(1, 1), mk(3, 1), mk(5, 5), mk(6, 6), mk(8, 15), mk(10, 3), mk(10, 9), mk(12, 25),
    ]);
}

function parseHolidaysWithRemoves(text) {
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

export function initializeUI() {
    runOnReady(setDefaultStartMonday);
    runOnReady(setDefaultEmployees);
    runOnReady(renderPreviousStatsUI);
    runOnReady(updateHardcapToggleLabel);
    runOnReady(() => {
        try {
            if (icsVersionInput && !icsVersionInput.value) icsVersionInput.value = 'v1';
            updateIcsPreview();
        } catch { }
    });
}

function runOnReady(fn) {
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
        setTimeout(fn, 0);
    }
}

function setDefaultStartMonday() {
    if (!startInput) return;
    const today = new Date();
    const firstOfNextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    const firstMonday = new Date(firstOfNextMonth);
    firstMonday.setHours(12, 0, 0, 0);
    while (firstMonday.getDay() !== 1) {
        firstMonday.setDate(firstMonday.getDate() + 1);
    }
    const y = firstMonday.getFullYear();
    const m = String(firstMonday.getMonth() + 1).padStart(2, '0');
    const d = String(firstMonday.getDate()).padStart(2, '0');
    try {
        startInput.valueAsDate = firstMonday;
    } catch { }
    startInput.value = `${y}-${m}-${d}`;
}

function setDefaultEmployees() {
    if (empR1Input && !empR1Input.value) empR1Input.value = '윤성민\n장주만\n조형우';
    if (empR2Input && !empR2Input.value) empR2Input.value = '김대근\n김진아\n이수연';
    if (empR3Input && !empR3Input.value) empR3Input.value = '권지영 소아\n김선민\n윤준성 응급';
    if (empR4Input && !empR4Input.value) empR4Input.value = '김지영\n김현태\n이동인';
}

function debounce(fn, ms) {
    let t = null;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn.apply(null, args), ms); };
}

export function setLoading(flag, text) {
    if (!loadingOverlay) return;
    if (typeof text === 'string' && loadingTextEl) loadingTextEl.textContent = text;
    if (flag) loadingOverlay.classList.add('show'); else loadingOverlay.classList.remove('show');
}

export function disableActions(flag) {
    const disabled = !!flag;
    generateBtn.disabled = disabled;
    if (exportXlsxBtn) exportXlsxBtn.disabled = disabled; // Logic for enabling handled by caller or state
    if (exportIcsBtn) exportIcsBtn.disabled = disabled;
}

export function enableExportButtons(enable) {
    if (exportXlsxBtn) exportXlsxBtn.disabled = !enable;
    if (exportIcsBtn) exportIcsBtn.disabled = !enable;
}

export function appendMessage(msg, type = 'normal') {
    if (!msg) return;
    const div = document.createElement('div');
    div.innerHTML = msg; // Allow HTML
    if (type === 'warn') div.style.color = 'var(--warn-color)';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
}

export function clearMessages() {
    messages.innerHTML = '';
}

function getEmployeesFromUI() {
    const lines = [];
    const process = (el, prefix) => {
        if (!el) return;
        const val = el.value || '';
        val.split(/\r?\n/).forEach(line => {
            let t = line.trim();
            if (!t) return;
            // Normalize: remove existing prefix if present (case-insensitive) to ensure correct format
            if (t.toUpperCase().startsWith(prefix)) {
                t = t.substring(prefix.length).trim();
            }
            if (t) lines.push(`${prefix} ${t}`);
        });
    };
    process(empR1Input, 'R1');
    process(empR2Input, 'R2');
    process(empR3Input, 'R3');
    process(empR4Input, 'R4');
    return lines.join('\n');
}

export function getGenerationParams() {
    // Persist current class edits
    try { ensureScoreConfigs(); setScoreConfig(_scoreClass, getCurrentScoreInputs()); } catch { }

    const empStr = getEmployeesFromUI();

    return {
        startDate: startInput.value,
        weeks: getWeeksCount(),
        endDate: endInput.value || null,
        employees: parseEmployees(empStr),
        prevStats: getPreviousStatsFromUI(),
        holidays: [...parseHolidays(holidaysInput.value)],
        dutyUnavailable: parseUnavailable(unavailableInput.value),
        dayoffWish: parseUnavailable(dayoffWishInput?.value || ''),
        vacations: parseVacationRanges(vacationsInput.value),
        priorDayDuty: getPriorDayDutyFromUI(),
        prior2DayDuty: getPrior2DayDutyFromUI(),
        retryAttempts: Number(retryAttemptsInput?.value || 5000),

        // Toggles
        enforceR3Balance: readToggle(toggleR3Balance),
        enforceDayoffWishRule: readToggle(toggleDayoffWish),
        enforceR3PediatricWedBan: readToggle(toggleR3PediatricWed),
        enforceVacationExclusion: readToggle(toggleVacationBan),
        enforceUnavailableExclusion: readToggle(toggleUnavailableBan),
        roleHardcapMode: hardcapToggle?.checked ? 'relaxed' : 'strict',
        dayoffCountingMode: toggleDayoffCounting?.checked ? 'trailing' : 'leading',
        excludeR4Mode: excludeR4Toggle?.checked ?? false,
        enforceDayoffBalance: dayoffBalanceToggle?.checked ?? true,
        enforceWeeklyHourCap: weeklyHourCapToggle?.checked ?? true,

        // Scoring
        scoreConfigs: ensureScoreConfigs(), // Get current configs

        // Other
        icsVersion: icsVersionInput?.value || 'v1',
    };
}

// --- Helper Functions (Private or Exported if needed) ---

function getWeeksCount() {
    const value = Number(weeksInput.value || 4);
    if (!Number.isFinite(value)) return 4;
    return Math.max(1, Math.min(8, value));
}

function readToggle(el, fallback = true) {
    if (!el) return fallback;
    return !!el.checked;
}

function parseEmployees(text) {
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.map((line) => {
        // Match: Class (R1-4), then Name (non-space/comma), then Rest (tags)
        const m = line.match(/^(R[1-4])\s+([^\s,]+)(.*)$/);
        if (m) {
            const klass = m[1];
            const name = m[2].trim();
            const rest = (m[3] || '').replace(/^\s*[ ,|\t]+/, '');
            const tags = new Set(rest.split(/[ ,|\t]+/).map(s => s.trim()).filter(Boolean));
            const pediatric = tags.has('소아');
            const emergency = tags.has('응급');
            return { name, klass, pediatric, emergency, preference: 'any' };
        }
        return { name: line, klass: '', pediatric: false, emergency: false, preference: 'any' };
    });
}

function parseHolidays(text) {
    const add = new Set();
    const remove = new Set();
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
        const excl = /^[-!]\s*(\d{4}-\d{2}-\d{2})$/.exec(line);
        if (excl) { remove.add(excl[1]); continue; }
        const incl = /^(\d{4}-\d{2}-\d{2})$/.exec(line);
        if (incl) add.add(incl[1]);
    }
    for (const d of remove) add.delete(d);
    return add;
}

function parseUnavailable(text) {
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

function parseVacationRanges(text) {
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

function getPreviousStatsFromUI() {
    const root = previousStatsUIRoot;
    if (!root) return { entries: [], sumByClassRole: new Map(), entriesByClassRole: new Map() };
    const employees = parseEmployees(getEmployeesFromUI());
    const byName = new Map(employees.map((e, idx) => [e.name, { ...e, id: idx }]));
    const entries = [];
    root.querySelectorAll('tr[data-name]')?.forEach((tr) => {
        const name = tr.getAttribute('data-name');
        const emp = byName.get(name);
        if (!emp) return;
        const isR3 = emp.klass === 'R3';
        if (isR3) {
            const dutyInput = tr.querySelector('input[data-role="duty"]');
            const duty = dutyInput ? Number(dutyInput.value) : 0;
            if (duty) {
                const half = duty / 2;
                entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'byung', delta: half });
                entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'eung', delta: half });
            }
        } else {
            const byungInput = tr.querySelector('input[data-role="byung"]');
            const eungInput = tr.querySelector('input[data-role="eung"]');
            const by = byungInput ? Number(byungInput.value) : 0;
            const eu = eungInput ? Number(eungInput.value) : 0;
            if (by) entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'byung', delta: by });
            if (eu) entries.push({ id: emp.id, name, klass: emp.klass || '', role: 'eung', delta: eu });
        }
        const offInput = tr.querySelector('input[data-role="off"]');
        const off = offInput ? Number(offInput.value) : 0;
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

export function renderPreviousStatsUI() {
    const root = previousStatsUIRoot;
    if (!root) return;
    const emps = parseEmployees(getEmployeesFromUI());
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
        const isR3 = e.klass === 'R3';
        if (isR3) {
            const td = document.createElement('td'); td.classList.add('num'); td.colSpan = 2;
            const input = document.createElement('input');
            input.type = 'number'; input.step = '1'; input.value = '0';
            input.setAttribute('data-role', 'duty');
            td.appendChild(input); tr.appendChild(td);
        } else {
            for (const role of ['byung', 'eung']) {
                const td = document.createElement('td'); td.classList.add('num');
                const input = document.createElement('input');
                input.type = 'number'; input.step = '1'; input.value = '0';
                input.setAttribute('data-role', role);
                td.appendChild(input); tr.appendChild(td);
            }
        }
        const tdOff = document.createElement('td'); tdOff.classList.add('num');
        const inputOff = document.createElement('input');
        inputOff.type = 'number'; inputOff.step = '1'; inputOff.value = '0';
        inputOff.setAttribute('data-role', 'off');
        tdOff.appendChild(inputOff); tr.appendChild(tdOff);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    root.innerHTML = '';
    root.appendChild(table);
}

function updateHardcapToggleLabel() {
    if (!hardcapToggle) return;
    const relaxed = hardcapToggle.checked;
    if (hardcapModeLabel) {
        hardcapModeLabel.textContent = relaxed
            ? '현재: 완화 모드 — 역할 편차를 ±2까지 허용합니다. (체크 해제 시 ±1입니다.)'
            : '현재: 기본 모드 — 역할 편차 허용 범위는 ±1입니다. (체크 시 ±2까지 완화됩니다.)';
    }
}

function updateIcsPreview() {
    try {
        // Logic to update ICS preview text
        // Simplified for now as it depends on window.location which is fine
        // But we need dominantMonthKey logic if we want to be precise, or just leave it simple
        if (icsPreview) icsPreview.textContent = '시작/종료일과 버전으로 자동 계산됩니다.';
    } catch { }
}

// Scoring UI
function readScoreInput(el, fallback) {
    if (!el) return fallback;
    const value = Number(el.value);
    if (!Number.isFinite(value)) return fallback;
    return value;
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
        roleSpread: readScoreInput(scoreRoleSpread, SCORE_DEFAULTS.roleSpread),
        gapPenalty: readScoreInput(scoreGapPenalty, SCORE_DEFAULTS.gapPenalty),
        friSunPenalty: readScoreInput(scoreFriSunPenalty, SCORE_DEFAULTS.friSunPenalty),
        sunTuePenalty: readScoreInput(scoreSunTuePenalty, SCORE_DEFAULTS.sunTuePenalty),
        r1WeeklyOver: readScoreInput(scoreR1WeeklyOver, SCORE_DEFAULTS.r1WeeklyOver),
        r3WeeklyOver: readScoreInput(scoreR3WeeklyOver, SCORE_DEFAULTS.r3WeeklyOver),
        r2WeeklyUnder: readScoreInput(scoreR2WeeklyUnder, SCORE_DEFAULTS.r2WeeklyUnder),
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
    if (scoreRoleSpread) scoreRoleSpread.value = cfg.roleSpread;
    if (scoreGapPenalty) scoreGapPenalty.value = cfg.gapPenalty;
    if (scoreFriSunPenalty) scoreFriSunPenalty.value = cfg.friSunPenalty;
    if (scoreSunTuePenalty) scoreSunTuePenalty.value = cfg.sunTuePenalty ?? SCORE_DEFAULTS.sunTuePenalty;
    if (scoreR1WeeklyOver) scoreR1WeeklyOver.value = cfg.r1WeeklyOver ?? SCORE_DEFAULTS.r1WeeklyOver;
    if (scoreR3WeeklyOver) scoreR3WeeklyOver.value = cfg.r3WeeklyOver ?? SCORE_DEFAULTS.r3WeeklyOver;
    if (scoreR2WeeklyUnder) scoreR2WeeklyUnder.value = cfg.r2WeeklyUnder ?? SCORE_DEFAULTS.r2WeeklyUnder;
}

function bindScoreClassTabs() {
    const tabs = document.getElementById('score-class-tabs');
    if (!tabs) return;
    ensureScoreConfigs();
    const indicator = document.getElementById('score-class-indicator');
    if (indicator) indicator.textContent = `현재: ${_scoreClass}`;

    const toggleClassFields = (klass) => {
        document.querySelectorAll('[data-class-only]').forEach(el => {
            const target = el.getAttribute('data-class-only');
            el.style.display = target === klass ? '' : 'none';
        });
    };

    toggleClassFields(_scoreClass);

    tabs.addEventListener('click', (e) => {
        const btn = e.target?.closest('button[data-klass]');
        if (!btn) return;
        // save current edits to current class
        setScoreConfig(_scoreClass, getCurrentScoreInputs());
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
        const configs = ensureScoreConfigs();
        setCurrentScoreInputs(configs[_scoreClass]);
        if (indicator) indicator.textContent = `현재: ${_scoreClass}`;
        toggleClassFields(_scoreClass);
    });
}

// --- Rendering Results ---

export function renderResults(result, prevStats) {
    renderSummary(result);
    renderRoster(result);
    renderReport(result, { previous: prevStats });
}

function renderSummary(result) {
    const warn = result.warnings.length > 0;
    const lines = [];
    lines.push(`기간: ${result.startDate} ~ ${result.endDate || '?'}`);
    lines.push(warn ? `주의: ${[...result.warnings].join(' | ') || '검토 필요한 항목 존재'}` : '검증: 제약 내에서 생성됨');

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
        const d = new Date(s.date);
        const key = fmtDate(d);
        const wd = d.getDay();
        if (wd === 0 || wd === 6) tr.classList.add('weekend');
        if ((result.holidays || []).includes(key)) tr.classList.add('holiday');
        const cells = [];
        cells.push(s.key);
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

// We need to import renderWeeklyHours, renderPersonalStats, renderCarryoverStats from somewhere or implement them here.
// They were in app.js. I'll implement them here as they are UI rendering.
// But they depend on `computeRoleAndOffCounts` etc. which are in `scoring.js`.
// So I need to import those from `scoring.js`.
import { computeRoleAndOffCounts, computeCarryoverDeltas } from './scoring.js';

function renderReport(result, opts = {}) {
    report.innerHTML = '';
    const backEmp = result.employees.find((e) => e.emergency) || null;
    if (backEmp) {
        const bn = document.createElement('div');
        bn.className = 'banner';
        bn.textContent = `응급 back: ${backEmp.name} (R연차=${backEmp.klass || '-'})`;
        report.appendChild(bn);
    }

    if (result.warnings && result.warnings.length) {
        const warn = document.createElement('div');
        warn.className = 'warn';
        warn.textContent = `경고 ${result.warnings.length}건: ` + result.warnings.join(' | ');
        report.appendChild(warn);
    }

    renderWeeklyHours(result);
    renderPersonalStats(result);
    renderCarryoverStats(result, opts);

    // Diagnostics
    if (document.getElementById('toggle-diagnostics')?.checked) {
        // renderGapDetails(result); // Implement if needed
    }
}

function renderWeeklyHours(result) {
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
    const order = ['R1', 'R2', 'R3', 'R4', '기타'];
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

            let avgColorClass = '';
            if (avgWeeklyHours >= 70) avgColorClass = 'avg-hours-tier-7';
            else if (avgWeeklyHours >= 65) avgColorClass = 'avg-hours-tier-6';
            else if (avgWeeklyHours >= 60) avgColorClass = 'avg-hours-tier-5';
            else if (avgWeeklyHours >= 55) avgColorClass = 'avg-hours-tier-4';
            else if (avgWeeklyHours >= 50) avgColorClass = 'avg-hours-tier-3';
            else if (avgWeeklyHours >= 45) avgColorClass = 'avg-hours-tier-2';
            else if (avgWeeklyHours >= 40) avgColorClass = 'avg-hours-tier-1';

            cells.forEach((val, idx) => {
                const td = document.createElement('td');
                td.textContent = String(val);
                if (idx >= 1) td.classList.add('num');

                if (idx >= 1 && idx <= weekKeys.length) {
                    const hours = values[idx - 1] || 0;
                    if (hours >= 80) td.classList.add('hours-tier-7');
                    else if (hours >= 75) td.classList.add('hours-tier-6');
                    else if (hours >= 72) td.classList.add('hours-tier-5');
                    else if (hours >= 60) td.classList.add('hours-tier-4');
                    else if (hours >= 50) td.classList.add('hours-tier-3');
                    else if (hours >= 40) td.classList.add('hours-tier-2');
                    else if (hours > 0) td.classList.add('hours-tier-1');
                }

                if (idx === cells.length - 1) {
                    if (avgColorClass) td.classList.add(avgColorClass);
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

function renderPersonalStats(result) {
    const wrap = document.createElement('div');
    wrap.className = 'weekly-report section-card';
    const title = document.createElement('div');
    title.className = 'legend title';
    title.textContent = '개인별 수련시간 및 Day-off 통계 (연차 내)';
    wrap.appendChild(title);

    const empById = new Map(result.employees.map((e) => [e.id, e]));
    const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);

    const groups = new Map();
    for (const s of result.stats) {
        const emp = empById.get(s.id) || {};
        const k = emp.klass || '기타';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
    }
    const order = ['R1', 'R2', 'R3', 'R4', '기타'];
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
        const isR3 = klass === 'R3';
        const hdrs = isR3
            ? ['이름', '당직(회)', 'Day-off']
            : ['이름', '병당(회)', '응당(회)', '총 당직(회)', 'Day-off'];
        for (const h of hdrs) { const th = document.createElement('th'); th.textContent = h; thr.appendChild(th); }
        thead.appendChild(thr); table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const s of groups.get(klass)) {
            const emp = empById.get(s.id) || {};
            const offW = dayOff.get(s.id) || 0;
            const tr = document.createElement('tr');
            const byung = byungCount.get(s.id) || 0;
            const eung = eungCount.get(s.id) || 0;
            const total = byung + eung;
            const cells = isR3
                ? [s.name, String(total), String(offW)]
                : [s.name, String(byung), String(eung), String(total), String(offW)];
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
    report.appendChild(wrap);
}

function signed(n) {
    return (n > 0 ? '+' : '') + n;
}

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

    const order = ['R1', 'R2', 'R3', 'R4', '기타'];
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

        const isR3 = klass === 'R3';
        const roles = isR3
            ? [
                { key: 'duty', name: '당직', countMap: new Map([...peopleInClass.map(p => [p.id, (byungCount.get(p.id) || 0) + (eungCount.get(p.id) || 0)])]) },
                { key: 'off', name: 'Day-off', countMap: dayOff },
            ]
            : [
                { key: 'byung', name: '병당', countMap: byungCount },
                { key: 'eung', name: '응당', countMap: eungCount },
                { key: 'off', name: 'Day-off', countMap: dayOff },
            ];

        for (const role of roles) {
            let prevList = [];
            if (isR3 && role.key === 'duty') {
                const byungList = (prev.entriesByClassRole.get(klass)?.['byung']) || [];
                const eungList = (prev.entriesByClassRole.get(klass)?.['eung']) || [];
                const combined = new Map();
                for (const e of [...byungList, ...eungList]) {
                    combined.set(e.name, (combined.get(e.name) || 0) + (Number(e.delta) || 0));
                }
                prevList = [...combined.entries()].map(([name, delta]) => ({ name, delta }));
            } else {
                prevList = (prev.entriesByClassRole.get(klass)?.[role.key]) || [];
            }
            const prevByName = new Map(prevList.map((e) => [e.name, Number(e.delta) || 0]));

            const finalCounts = peopleInClass.map((p) => ({
                id: p.id,
                name: p.name,
                count: (Number(role.countMap.get(p.id) || 0)) + (prevByName.get(p.name) || 0),
            }));

            const { deltas: finalDeltas } = computeCarryoverDeltas(finalCounts);

            const tr = document.createElement('tr');
            const labelTd = document.createElement('td');
            labelTd.textContent = role.name;
            tr.appendChild(labelTd);

            const valueTd = document.createElement('td');
            const deltaStr = finalDeltas.length ? finalDeltas.map((d) => `${d.name} ${signed(d.delta)}`).join(' · ') : '-';
            valueTd.textContent = deltaStr;
            tr.appendChild(valueTd);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
    }
    report.appendChild(wrap);
}

export function renderScoreBreakdown(candidate) {
    renderScoreBreakdownDetailed(candidate, report);
}
