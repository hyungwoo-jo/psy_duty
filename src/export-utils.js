import { fmtDate, addDays } from './time.js';
import { computeRoleAndOffCounts, computeCarryoverDeltas } from './scoring.js';

export function download(filename, content) {
    const isXls = filename.toLowerCase().endsWith('.xls');
    const isIcs = filename.toLowerCase().endsWith('.ics');
    const isZip = filename.toLowerCase().endsWith('.zip');
    const type = isXls
        ? 'application/vnd.ms-excel;charset=utf-8'
        : (isIcs ? 'text/calendar;charset=utf-8' : (isZip ? 'application/zip' : 'text/plain;charset=utf-8'));
    const blob = new Blob([content instanceof Uint8Array ? content : String(content)], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function base64Utf8(str) {
    try {
        return btoa(unescape(encodeURIComponent(str)));
    } catch {
        const bytes = new TextEncoder().encode(str);
        let s = '';
        for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }
}

export function sanitizeFilename(s) {
    return String(s).replace(/[^\w\-\.가-힣]+/g, '_');
}

export function xmlEscape(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

export function buildSpreadsheetXML(sheets) {
    const header = `<?xml version="1.0"?>\n<?mso-application progid=\"Excel.Sheet\"?>\n<Workbook xmlns=\"urn:schemas-microsoft-com:office:spreadsheet\" xmlns:o=\"urn:schemas-microsoft-com:office:office\" xmlns:x=\"urn:schemas-microsoft-com:office:excel\" xmlns:ss=\"urn:schemas-microsoft-com:office:spreadsheet\">`;
    const styles = `
    <Styles>
      <Style ss:ID="Header"><Font ss:Bold="1"/><Alignment ss:Horizontal="Center"/></Style>
      <Style ss:ID="Weekend"><Interior ss:Color="#E8F6FF" ss:Pattern="Solid"/></Style>
      <Style ss:ID="Holiday"><Interior ss:Color="#FFF6D5" ss:Pattern="Solid"/></Style>
      <Style ss:ID="Underfill"><Interior ss:Color="#FDE2E2" ss:Pattern="Solid"/></Style>
      <Style ss:ID="Pos"><Font ss:Color="#22C55E"/></Style>
      <Style ss:ID="Neg"><Font ss:Color="#EF4444"/></Style>
    </Styles>`;
    const tail = '</Workbook>';
    const ws = sheets.map((sh) => sheetXML(sh.name, sh.rows)).join('');
    return header + styles + ws + tail;
}

function sheetXML(name, rows) {
    const safe = xmlEscape(name || 'Sheet1');
    const rs = rows.map((r) => {
        const cells = r.map((cell) => {
            const obj = (cell && typeof cell === 'object' && 'v' in cell) ? cell : { v: cell };
            const sid = obj.style ? ` ss:StyleID=\"${xmlEscape(obj.style)}\"` : '';
            const href = obj.href ? ` ss:HRef=\"${xmlEscape(obj.href)}\"` : '';
            return `<Cell${sid}${href}><Data ss:Type=\"String\">${xmlEscape(obj.v ?? '')}</Data></Cell>`;
        }).join('');
        return `<Row>${cells}</Row>`;
    }).join('');
    return `<Worksheet ss:Name=\"${safe}\"><Table>${rs}</Table></Worksheet>`;
}

export function guessIcsBaseURL(result) {
    try {
        const origin = window.location.origin;
        const host = window.location.hostname || '';
        const path = window.location.pathname || '';
        const isGh = /github\.io$/.test(host);
        const yymm = (result?.startDate || '').slice(0, 7) || '';
        if (isGh) return `${origin}/psy_duty/ics/${yymm}/`;
        if (path.includes('/psy_duty/')) return `${origin}/psy_duty/ics/${yymm}/`;
    } catch { }
    return '';
}

export function joinUrl(base, path) {
    const b = base.endsWith('/') ? base : base + '/';
    return b + (path.startsWith('/') ? path.slice(1) : path);
}

export function getComputedIcsBase(icsVersionValue, result) {
    try {
        const url = new URL(window.location.href);
        const override = url.searchParams.get('ics_base');
        if (override) return override;
    } catch { }
    const version = (icsVersionValue || '').trim();
    if (!version) return '';
    const monthKey = dominantMonthKey(result);
    if (!monthKey) return '';
    const origin = window.location.origin;
    return `${origin}/psy_duty/ics/${monthKey}/${version}/`;
}

export function dominantMonthKey(result) {
    try {
        if (!result) return '';
        const counts = new Map();
        for (const d of result.schedule || []) {
            const dt = new Date(d.date);
            const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        let best = ''; let max = -1;
        for (const [k, v] of counts) { if (v > max) { max = v; best = k; } }
        return best;
    } catch { return ''; }
}

export function buildICS(result, opts = {}) {
    const nameFilter = (opts && opts.nameFilter) || null;
    const includeBack = !!(opts && opts.includeBack);
    const lines = [];
    const now = new Date();
    const dtstamp = icsDateTimeUTC(now);
    const calName = nameFilter ? `Psy Duty (${nameFilter})` : 'Psy Duty Roster';
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('CALSCALE:GREGORIAN');
    lines.push('PRODID:-//psy_duty//Duty Roster//KO');
    lines.push('METHOD:PUBLISH');
    lines.push('X-WR-CALNAME:' + icsText(calName));

    const holidaySet = new Set(result.holidays || []);
    const pushEvent = (dateObj, title, uidSeed, description = '') => {
        const d0 = icsDate(dateObj);
        const d1 = icsDate(addDays(dateObj, 1)); // all-day end exclusive
        const uid = `${uidSeed}@psy_duty`;
        lines.push('BEGIN:VEVENT');
        lines.push('UID:' + uid);
        lines.push('DTSTAMP:' + dtstamp);
        lines.push('DTSTART;VALUE=DATE:' + d0);
        lines.push('DTEND;VALUE=DATE:' + d1);
        lines.push('SUMMARY:' + icsText(title));
        if (description) lines.push('DESCRIPTION:' + icsText(description));
        lines.push('END:VEVENT');
    };

    for (const day of result.schedule) {
        const dateObj = new Date(day.date);
        const key = fmtDate(dateObj);
        const isHoliday = holidaySet.has(key);
        const wd = dateObj.getDay();
        const isWeekend = (wd === 0 || wd === 6);
        const dayNote = isHoliday ? '공휴일' : (isWeekend ? '주말' : '평일');
        const roles = ['병당', '응당'];
        for (let i = 0; i < (day.duties || []).length; i += 1) {
            const duty = day.duties[i];
            if (!duty) continue;
            if (nameFilter && duty.name !== nameFilter) continue;
            const role = roles[i] || `슬롯${i + 1}`;
            const title = `${role} - ${duty.name}`;
            const desc = `${key} ${dayNote}`;
            const roleKey = i === 0 ? 'B' : 'E';
            const nameHash = (crc32(new TextEncoder().encode(duty.name)) >>> 0).toString(16);
            pushEvent(dateObj, title, `duty-${key}-${roleKey}-${nameHash}`, desc);
        }
        if (includeBack && day.back) {
            if (!nameFilter || day.back.name === nameFilter) {
                const title = `응급 back - ${day.back.name}`;
                const desc = `${key} ${dayNote}`;
                pushEvent(dateObj, title, `back-${key}-${day.back.id}`, desc);
            }
        }
    }

    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
}

function icsDate(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

function icsDateTimeUTC(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}

function icsText(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/,/g, '\\,')
        .replace(/;/g, '\\;');
}

export function hasDutiesFor(result, name) {
    for (const day of result.schedule || []) {
        const duties = day.duties || [];
        for (const d of duties) { if (d && d.name === name) return true; }
    }
    return false;
}

export function safePersonFilename(name) {
    return String(name).replace(/[\\/]+/g, '_');
}

export function buildZip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = toDosTime(now);
    const dosDate = toDosDate(now);

    for (const f of files) {
        const nameBytes = new TextEncoder().encode(f.name);
        const data = f.bytes;
        const crc = crc32(data);
        const localHeader = [];
        pushU32(localHeader, 0x04034b50);
        pushU16(localHeader, 20);
        pushU16(localHeader, 0x0800);
        pushU16(localHeader, 0);
        pushU16(localHeader, dosTime);
        pushU16(localHeader, dosDate);
        pushU32(localHeader, crc >>> 0);
        pushU32(localHeader, data.length >>> 0);
        pushU32(localHeader, data.length >>> 0);
        pushU16(localHeader, nameBytes.length);
        pushU16(localHeader, 0);
        const local = concatBytes(new Uint8Array(localHeader), nameBytes, data);
        chunks.push(local);

        const cd = [];
        pushU32(cd, 0x02014b50);
        pushU16(cd, 20);
        pushU16(cd, 20);
        pushU16(cd, 0x0800);
        pushU16(cd, 0);
        pushU16(cd, dosTime);
        pushU16(cd, dosDate);
        pushU32(cd, crc >>> 0);
        pushU32(cd, data.length >>> 0);
        pushU32(cd, data.length >>> 0);
        pushU16(cd, nameBytes.length);
        pushU16(cd, 0);
        pushU16(cd, 0);
        pushU16(cd, 0);
        pushU16(cd, 0);
        pushU32(cd, 0);
        pushU32(cd, offset >>> 0);
        const cdr = concatBytes(new Uint8Array(cd), nameBytes);
        central.push(cdr);

        offset += local.length;
    }

    const centralDir = concatBytes(...central);
    const eocd = [];
    pushU32(eocd, 0x06054b50);
    pushU16(eocd, 0);
    pushU16(eocd, 0);
    pushU16(eocd, files.length);
    pushU16(eocd, files.length);
    pushU32(eocd, centralDir.length);
    pushU32(eocd, offset);
    pushU16(eocd, 0);
    const tail = new Uint8Array(eocd);

    return concatBytes(...chunks, centralDir, tail);
}

function toDosTime(date) {
    const h = date.getHours();
    const m = date.getMinutes();
    const s = Math.floor(date.getSeconds() / 2);
    return ((h & 0x1f) << 11) | ((m & 0x3f) << 5) | (s & 0x1f);
}
function toDosDate(date) {
    const y = date.getFullYear() - 1980;
    const mo = date.getMonth() + 1;
    const d = date.getDate();
    return ((y & 0x7f) << 9) | ((mo & 0x0f) << 5) | (d & 0x1f);
}

function pushU16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
function pushU32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

function concatBytes(...parts) {
    const total = parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

let _crcTable;
function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
}
function crc32(bytes) {
    if (!_crcTable) _crcTable = makeCrcTable();
    let c = 0 ^ -1;
    for (let i = 0; i < bytes.length; i++) c = (_crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
    return (c ^ -1) >>> 0;
}

function signed(n) {
    return (n > 0 ? '+' : '') + n;
}

export function buildCarryoverRows(result, prev) {
    const rows = [[{ v: '연차', style: 'Header' }, { v: '항목', style: 'Header' }, { v: '이름', style: 'Header' }, { v: '보정치', style: 'Header' }]];
    const { byungCount, eungCount, dayOff } = computeRoleAndOffCounts(result);
    const empById = new Map(result.employees.map((e) => [e.id, e]));

    const order = ['R1', 'R2', 'R3', 'R4', '기타'];
    for (const klass of order) {
        if (!empById.size) continue;
        const peopleInClass = result.stats.filter(s => (empById.get(s.id)?.klass || '기타') === klass);
        if (!peopleInClass.length) continue;

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

            if (finalDeltas.length === 0) {
                rows.push([klass, role.name, '-', '-']);
            } else {
                for (const d of finalDeltas) {
                    rows.push([klass, role.name, d.name, { v: signed(d.delta), style: d.delta > 0 ? 'Pos' : 'Neg' }]);
                }
            }
        }
        rows.push(['', '', '', '']);
    }
    return rows;
}

export function buildPreviousAdjustRows(result, prev) {
    const rows = [[{ v: '연차', style: 'Header' }, { v: '항목', style: 'Header' }, { v: '이름', style: 'Header' }, { v: '보정치', style: 'Header' }]];
    const entriesBy = prev.entriesByClassRole || new Map();
    const order = ['R1', 'R2', 'R3', 'R4', '기타'];
    for (const klass of order) {
        const rec = entriesBy.get(klass);
        if (!rec) continue;
        const isR3 = klass === 'R3';
        const sections = isR3
            ? [['duty', '당직'], ['off', 'Day-off']]
            : [['byung', '병당'], ['eung', '응당'], ['off', 'Day-off']];
        for (const [key, label] of sections) {
            const list = rec[key] || [];
            if (list.length === 0) continue;
            for (const e of list) {
                rows.push([klass, label, e.name, signed(Number(e.delta) || 0)]);
            }
        }
        rows.push(['', '', '', '']);
    }
    return rows;
}
