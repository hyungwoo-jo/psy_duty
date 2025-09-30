# psy_duty 코드 개요

## 실행 흐름
1. `src/app.js`가 DOM 요소를 초기화하고 기본 시작일을 다음 달 첫 월요일로 설정합니다.
2. 사용자가 "생성" 버튼을 누르면 `onGenerate`가 폼 데이터를 파싱합니다. 이때 인력 목록, 휴일, 불가일, 휴가, 전월 보정, 전일 당직 등의 입력을 정규화합니다.
3. 정리된 입력은 `src/scheduler.js`의 `generateSchedule`로 전달되어 실제 배정 로직이 수행됩니다.
4. 스케줄 결과가 반환되면 `renderSummary`, `renderReport`, `renderRoster`가 요약/상세/표 형태로 UI를 갱신하며, 익스포트 버튼을 활성화합니다.
5. 이후 사용자는 XLSX, ICS(월 전체 또는 개인 ZIP), 미리보기 URL 등으로 출력할 수 있습니다.

## 입력 정규화 규칙 (`app.js`)
- **인력 파싱**: `parseEmployees`는 `R# 이름, 소아, 응급` 형식의 줄을 읽어 연차, 소아/응급 태그를 분리합니다.
- **휴일 관리**: `parseHolidayAddsRemoves`는 `YYYY-MM-DD` 추가/`- YYYY-MM-DD` 제거 형식으로 휴일을 조정합니다. 필요 시 `loadKRHolidays`가 Nager API로 공휴일을 병합합니다.
- **불가/Day-off/휴가**: `parseUnavailable`과 `parseVacationRanges`는 이름별로 날짜 세트를 구성합니다. Day-off 희망은 전날 당직 선호로 변환됩니다.
- **전월 보정**: `getPreviousStatsFromUI`가 인력별 병당/응당/Day-off 보정치를 수집하여 이후 균형 계산에 반영합니다.
- **시간 설정**: `getWeeksCount`와 `currentDateRange`가 시작일, 종료일(또는 주 수)을 기준으로 계산 범위를 일관되게 유지합니다.

## 스케줄링 핵심 규칙 (`scheduler.js`)
- **슬롯 구성**: 하루 2개 슬롯(병당, 응당). 주말·공휴일은 `R2/R1`, 평일은 요일별로 필요한 연차가 고정됩니다.
- **근무 불가 조건**: 휴가·불가일·이미 배정된 당직·연속 당직 금지, 당직 다음 첫 평일 정규 근무 면제(정규시간 계산 시 Day-off로 처리).
- **하드/소프트 상한**:
  - 주당 72h 초과는 소프트 경고, 75h 초과는 하드 초과로 엄격히 제어합니다.
  - 연차별 역할 편차는 `roleHardcapMode`에 따라 ±1(기본) 또는 ±2(완화)를 허용합니다. 전월 보정 델타를 포함한 중앙값 기반 비교로 판단합니다.
- **사전 배치**: Day-off 희망일은 전날 슬록을 우선 예약합니다. 조건이 맞지 않으면 사유를 경고로 남깁니다.
- **후보 선택**: 각 슬롯마다 `pickCandidate`가 가용 인력에서 제약, 선호, 편차, Day-off 보정 등을 고려해 최적 인원을 선택합니다.
- **최적화 루프**: `optimization='strong'`에서 시뮬레이티드 어닐링 기반 재시도를 수행해 주별 시간 편차와 역할 균형을 개선합니다. 실패 시 기본 배정 결과를 사용합니다.
- **strict 모드 재시도**: 주당 72 h 초과가 남아 있으면 서로 다른 시드로 최대 50회까지 전체 스케줄을 다시 생성해보고, 모두 해결되지 않을 경우 가장 균형이 좋은 결과를 사용합니다.
- **사후 보정**: 주 80h 이상 등 극단값 감지를 위한 제한적 스왑 시도를 거치고, 통계(weeklyHours, totalHours, dayOff)와 경고 목록을 완성합니다.

## 결과 구조
`generateSchedule`은 다음을 포함한 객체를 반환합니다.
- `schedule`: 날짜별 `{ key, duties, back, underfilled, reasons }`.
- `employees`: 입력 인력의 메타 정보(id, name, klass 등).
- `stats`: 개인별 총시간, 주별 시간, 당직 횟수 등.
- `config`: 생성에 사용된 파라미터(주당 슬롯 수, priorDayDuty, roleHardcapMode 등).
- `randomSeed`: 동일한 결과를 재현하고 싶을 때 지정할 수 있는 시드 값(지정하지 않으면 매번 자동 생성).
- `warnings`와 `meta.elapsedMs`: 생성 과정의 제약 위반, 최적화 시간 등의 부가 정보.

## 후처리 및 출력 (`app.js`)
- **요약/통계**: `renderWeeklyHours`, `renderPersonalStats`, `renderCarryoverStats`가 연차별 표를 구성합니다. 진단 모드(`toggle-diagnostics`)가 켜져 있으면 추가 로그와 디버그 정보를 노출합니다.
- **익스포트**:
  - `export-xlsx`는 `buildSpreadsheetXML`로 삼중 표(달력, 통계, 보정)를 묶어 Excel XML 형태로 다운로드합니다.
  - `export-ics`는 `buildICS`로 개인별 캘린더를 생성하고 ZIP(`buildZip`)으로 묶습니다.
  - `icsPreview`는 `dominantMonthKey`와 버전 입력을 조합해 GitHub Pages 배포 경로를 추정합니다.

## 주요 유틸 (`time.js`)
- 날짜 연산(`addDays`, `fmtDate`, `weekKey`, `weekKeyByMode`)과 근무일 판정(`isWorkday`)을 제공합니다.
- `allWeekKeysInRange`는 주간 통계를 위한 키 집합을 만들어 스케줄러와 UI가 공유합니다.

이 문서는 인력 구성 변경이나 규칙 개편 시 참고용으로 유지하며, 규칙이 바뀌면 `scheduler.js`의 요구 연차/상한 로직과 본 문서를 함께 업데이트하세요.
