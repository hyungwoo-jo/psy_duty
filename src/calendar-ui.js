import { fmtDate, addDays } from './time.js';

// Calendar slot overrides storage
export let customSlotOverrides = {}; // { 'YYYY-MM-DD': { slots: ['R1','R3'], force: ['name1','name2'], bans: ['name3'] } }

function buildCalendarCells(start, end) {
  // Calculate first Monday and last Sunday for 7xN grid
  const firstMon = new Date(start);
  firstMon.setDate(firstMon.getDate() - ((firstMon.getDay() + 6) % 7));
  const lastSun = new Date(end);
  lastSun.setDate(lastSun.getDate() + ((7 - lastSun.getDay()) % 7));

  const cells = [];
  for (let d = new Date(firstMon); d <= lastSun; d.setDate(d.getDate() + 1)) {
    cells.push(new Date(d));
  }
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }
  return weeks;
}

// Helper to determine default slot class based on date and slot index
function getDefaultSlotClass(date, holidays, slotIndex, excludeR4Mode, weekIndexFromStart) {
  const isHoliday = holidays.has(date.toISOString().split('T')[0]);
  const dow = date.getDay();
  const isWorkday = dow >= 1 && dow <= 5 && !isHoliday;

  if (!isWorkday) {
    return slotIndex === 0 ? 'R2' : 'R1';
  }

  switch (dow) {
    case 1: return slotIndex === 0 ? 'R1' : 'R3';
    case 2:
      if (slotIndex === 0) return 'R1';
      if (excludeR4Mode) {
        return (weekIndexFromStart % 2 === 0) ? 'R2' : 'R3';
      }
      return 'R4';
    case 3: return slotIndex === 0 ? 'R3' : 'R2';
    case 4: return slotIndex === 0 ? 'R1' : 'R2';
    case 5: return slotIndex === 0 ? 'R1' : 'R3';
    default: return slotIndex === 0 ? 'R2' : 'R1';
  }
}

export function renderCalendar(startInput, endInput, weeksInput, holidaysInput, getWeeksCount, parseHolidays, excludeR4Mode) {
  const container = document.querySelector('#calendar-container');
  if (!container) return;

  const start = startInput.valueAsDate;
  const end = endInput.valueAsDate || addDays(start, getWeeksCount() * 7 - 1);
  if (!start) {
    alert('시작일을 먼저 지정하세요');
    return;
  }

  const weeks = buildCalendarCells(start, end);
  const holidays = parseHolidays(holidaysInput.value);

  container.innerHTML = '';
  container.style.display = 'block';

  const calGrid = document.createElement('div');
  calGrid.className = 'calendar-grid';

  // Info text
  const infoDiv = document.createElement('div');
  infoDiv.className = 'calendar-info';
  infoDiv.textContent = '※ 연차 슬롯 선택 / 강제 배정 / 금지 인원 입력 가능. Day-off 희망일은 전날 강제 배정으로 처리. 금지 인원은 쉼표로 구분 (예: 윤성민, 이수연)';
  calGrid.appendChild(infoDiv);

  // Header row
  const headerRow = document.createElement('div');
  headerRow.className = 'calendar-header-row';
  ['월', '화', '수', '목', '금', '토', '일'].forEach(day => {
    const hdr = document.createElement('div');
    hdr.className = 'calendar-header-cell';
    hdr.textContent = day;
    headerRow.appendChild(hdr);
  });
  calGrid.appendChild(headerRow);

  // Weeks
  let weekIndexFromStart = 0;
  weeks.forEach(week => {
    const weekRow = document.createElement('div');
    weekRow.className = 'calendar-week-row';

    week.forEach(date => {
      const dateStr = fmtDate(date);
      const isHoliday = holidays.has(dateStr);
      const inRange = date >= start && date <= end;
      const override = customSlotOverrides[dateStr] || {};

      // Calculate week index from start date for R4 exclusion mode
      const daysSinceStart = Math.floor((date - start) / (1000 * 60 * 60 * 24));
      const currentWeekIndex = Math.floor(daysSinceStart / 7);

      const cell = document.createElement('div');
      cell.className = 'calendar-cell';
      const isWeekend = date.getDay() === 0 || date.getDay() === 6;
      if (!inRange) cell.classList.add('out-of-range');
      if (isHoliday) cell.classList.add('holiday');
      if (isWeekend) cell.classList.add('weekend');

      // Date label
      const dateLabel = document.createElement('div');
      dateLabel.className = 'calendar-date';
      dateLabel.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
      cell.appendChild(dateLabel);

      if (inRange) {
        // Slot selects
        const slotDiv = document.createElement('div');
        slotDiv.className = 'calendar-slots';

        const defaultByung = override.slots?.[0] || getDefaultSlotClass(date, holidays, 0, excludeR4Mode, currentWeekIndex);
        const defaultEung = override.slots?.[1] || getDefaultSlotClass(date, holidays, 1, excludeR4Mode, currentWeekIndex);

        const byungSelect = createSlotSelect('병당', dateStr, 0, defaultByung, holidays, excludeR4Mode, currentWeekIndex);
        const eungSelect = createSlotSelect('응당', dateStr, 1, defaultEung, holidays, excludeR4Mode, currentWeekIndex);

        slotDiv.appendChild(byungSelect);
        slotDiv.appendChild(eungSelect);
        cell.appendChild(slotDiv);

        // Force assignment inputs
        const forceDiv = document.createElement('div');
        forceDiv.className = 'calendar-force';

        const byungForce = createForceInput('강제 병당', dateStr, 0, override.force?.[0] || '');
        const eungForce = createForceInput('강제 응당', dateStr, 1, override.force?.[1] || '');

        const banInput = createForceInput('금지 인원', dateStr, 'ban', override.bans?.join(', ') || '');

        forceDiv.appendChild(byungForce);
        forceDiv.appendChild(eungForce);
        forceDiv.appendChild(banInput);
        cell.appendChild(forceDiv);
      }

      weekRow.appendChild(cell);
    });

    calGrid.appendChild(weekRow);
  });

  container.appendChild(calGrid);
}

function createSlotSelect(label, dateStr, slotIndex, currentValue) {
  const wrapper = document.createElement('div');
  wrapper.className = 'slot-select-wrapper';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  lbl.style.fontSize = '11px';
  lbl.style.minWidth = '36px';

  const select = document.createElement('select');
  [currentValue, 'R1', 'R2', 'R3', 'R4'].forEach((opt, idx) => {
    // Add currentValue first, then others (avoid duplicates)
    if (idx > 0 && opt === currentValue) return;
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = opt;
    if (opt === currentValue) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    if (!customSlotOverrides[dateStr]) customSlotOverrides[dateStr] = {};
    if (!customSlotOverrides[dateStr].slots) customSlotOverrides[dateStr].slots = [null, null];
    customSlotOverrides[dateStr].slots[slotIndex] = select.value;
  });

  wrapper.appendChild(lbl);
  wrapper.appendChild(select);
  return wrapper;
}

function createForceInput(label, dateStr, slotIndex, currentValue) {
  const wrapper = document.createElement('div');
  wrapper.className = 'force-input-wrapper';

  const lbl = document.createElement('label');
  lbl.textContent = label;
  lbl.style.fontSize = '10px';
  lbl.style.minWidth = '56px';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '이름';
  input.value = currentValue;
  input.style.fontSize = '11px';

  input.addEventListener('change', () => {
    if (!customSlotOverrides[dateStr]) customSlotOverrides[dateStr] = {};

    if (slotIndex === 'ban') {
      // Ban input
      const bans = input.value.split(',').map(s => s.trim()).filter(Boolean);
      customSlotOverrides[dateStr].bans = bans;
    } else {
      // Force assignment input
      if (!customSlotOverrides[dateStr].force) customSlotOverrides[dateStr].force = ['', ''];
      customSlotOverrides[dateStr].force[slotIndex] = input.value.trim();
    }
  });

  wrapper.appendChild(lbl);
  wrapper.appendChild(input);
  return wrapper;
}
