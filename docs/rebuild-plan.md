# 달력 중심 UI 재구성 메모

## 현재 상태
- 코드베이스는 `7db0925`(scoring 결합된 상태)로 리셋됨. `tests/scenarios/vacation_heavy.json`만 untracked.
- 기존 slot editor 관련 수정은 모두 롤백된 상태.
- 로컬 서버는 권한/포트 이슈로 직접 띄우지 못하고 있음(포트 1734 점유/리스닝 권한 필요).

## 목표
1. **달력 기반 슬롯 편집**: 7xN 달력 그리드에서 병당/응당 연차, 강제 배정, 금지 인원을 직관적으로 입력.
2. **사전 입력 최소화**: 공휴일을 먼저 불러온 뒤 달력을 렌더링(주기 기본값 반영).
3. **부가 입력 최소화**: 불가일/희망일/휴가 입력은 `<details>`로 접어두되, 기능은 유지.
4. **스코어링 유지**: ILP는 하드 제약(슬롯·연속 금지·역할 하드캡 등), 주간 규칙은 scoring(필요하면 80h 하드컷 필터)로 유지.

## 구현 가이드(스케치)

### 달력 렌더링
```js
function buildCalendarCells(start, end) {
  // start: Date, end: Date
  const firstMon = new Date(start);
  firstMon.setDate(firstMon.getDate() - ((firstMon.getDay() + 6) % 7)); // 월요일
  const lastSun = new Date(end);
  lastSun.setDate(lastSun.getDate() + ((7 - lastSun.getDay()) % 7));   // 일요일

  const cells = [];
  for (let d = new Date(firstMon); d <= lastSun; d.setDate(d.getDate() + 1)) {
    cells.push(new Date(d));
  }
  // 7개씩 슬라이싱 → 주 배열
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks; // weeks[weekIndex][0..6]
}
```

### 슬롯 카드 구성안
- 셀 기본 표시: `YYYY-MM-DD` + 병당/응당 현재 연차 텍스트.
- 연차 선택: label+select(투명 select 위에 텍스트만 보이게).
- 강제 배정/금지: 입력 2개(병/응) + 금지 입력 1개(쉼표 구분).
- 저장 시 구조:
```js
customSlotOverrides = {
  '2025-01-03': { slots: ['R1', 'R3'], force: ['김철수',''], bans: ['이수연'] },
};
```
→ `prepareContext`에서 `slotClassByDaySlot`, `forceByDaySlot`, `bannedByDay`로 변환해 ILP에 전달.

### 공휴일 선반영
- 달력 버튼 클릭 전에 `loadKRHolidays` 실행(기간 검사).
- UI 안내: “공휴일 불러오기 → 달력 불러오기” 순서를 강조.

### 80h 하드컷(필터 방식)
```js
function hasWeeklyOver(result, limit = 80) {
  return (result.stats || []).some(s =>
    Object.values(s.weeklyHours || {}).some(h => h > limit + 1e-9)
  );
}
// Scoring 전 필터링, stitched 결과도 재검사
```

## 진행 순서 제안
1. 공휴일 블록을 달력 버튼 위로 배치(이미지/레이아웃만 수정).
2. 기본 달력 렌더링 함수 추가(buildCalendarCells)했고 연차/강제/금지 카드 UI부터 구현.
3. 저장 로직 → `customSlotOverrides` 직렬화, `generateSchedule` 인자에 전달.
4. `prepareContext`/`buildModel`에서 override 반영(필요 시 역할 캡 계산도 override 기반으로 재계산).
5. 접히는 입력(`details`)로 불가/희망/휴가 UI 정리.
6. 80h 필터(옵션 토글) 추가.

## 주의/검증
- `isEligibleForSlot`는 `neededClass`가 'Any'일 때도 통과하도록 유지.
- `requiredClassFor` 기본 규칙은 당분간 그대로 두고, override만 덮어쓰기.
- 브라우저 콘솔 오류 없을 때까지 작은 단위로 적용 후 확인.
