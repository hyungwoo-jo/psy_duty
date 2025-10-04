# 스케줄링 로직 설명

이 문서는 당직 스케줄링 시스템이 어떤 흐름과 규칙에 따라 동작하는지 알기 쉽게 설명합니다.

## 개요

스케줄링 시스템의 핵심 목표는, 주어진 모든 규칙과 제약 조건을 만족하면서 모든 근무자에게 최대한 공평한 당직표를 작성하는 것입니다.

이 과정은 "매우 똑똑한 해결사"에게 복잡한 퍼즐을 푸는 것과 같습니다. 우리는 해결사에게 퍼즐의 모든 규칙(예: "A는 B 옆에 올 수 없다")과 목표(예: "모든 조각을 사용해야 한다")를 알려주고, 해결사는 그 규칙을 모두 지키는 최적의 해답을 찾아냅니다. 여기서 '해결사'의 역할을 하는 것이 **ILP(정수 선형 계획법) 솔버**입니다.

## 스케줄링 과정 흐름

스케줄은 다음과 같은 단계를 거쳐 생성됩니다.

1.  **입력 정보 준비 (`prepareContext` 함수):**
    *   사용자가 UI를 통해 입력한 시작 날짜, 근무 기간, 근무자 명단, 휴가/휴일 정보, 이전 달의 보정치(`carryover`) 등을 시스템이 이해할 수 있는 내부 데이터 구조로 변환하고, ILP 모델 구축에 필요한 모든 사전 계산을 수행합니다.
    *   예를 들어, 각 근무자의 휴가일, 당직 불가일, Day-off 희망일 등을 `Set` 형태로 정리하고, 각 근무자별 역할별 당직 가능 횟수(`capBy`, `capEu` 등)를 미리 계산합니다.

2.  **규칙(제약 조건) 설정 (`buildModel` 함수):**
    *   `prepareContext`에서 준비된 데이터를 바탕으로, 스케줄링의 모든 규칙들을 ILP 솔버가 이해할 수 있는 수학적인 '제약 조건' 형태로 정의합니다.
    *   각 근무자가 특정 날짜의 특정 슬롯에 배정될지 여부를 나타내는 이진 변수(`x_pds`)를 생성하고, 이 변수들이 지켜야 할 모든 규칙(예: '모든 슬롯은 채워져야 한다', '연속 당직 금지' 등)을 제약 조건으로 추가합니다.

3.  **ILP 문제 생성 및 해결 (`solver.Solve(model)`):**
    *   `buildModel`에서 구축된 ILP 문제(`model`)를 **ILP 솔버**에게 전달합니다. 솔버는 이 모든 제약 조건들을 동시에 만족하면서 가장 낮은 '페널티'(최적화 목표)를 가지는 당직 조합을 계산하여 찾아냅니다.
    *   만약 모든 제약 조건을 만족하는 해를 찾을 수 없다면, 솔버는 '해 없음(infeasible)'을 반환합니다.

4.  **결과 생성 및 표시 (`buildResultFromSolution` 함수):**
    *   ILP 솔버가 찾아낸 수학적인 해답(각 `x_pds` 변수의 값)을 사람이 보기 좋은 당직표, 주간 근무 시간 통계, 다음 달 보정치 등의 형태로 가공하여 화면에 표시합니다.
    *   이 과정에서 스케줄이 제대로 채워지지 않은 '빈 슬롯(underfill)'이나 기타 경고 사항들을 함께 보고합니다.

## 주요 규칙 및 제약 조건

스케줄러는 다음과 같은 핵심 규칙들을 바탕으로 당직을 배정합니다.

### 1. 기본 배정 규칙
- **자격 요건:** 각 당직 슬롯(병당, 응당)에는 해당 날짜와 요일에 맞는 특정 연차(R1~R4)의 근무자만 배정될 수 있습니다.
- **휴가/휴일:** 휴가 또는 당직 불가로 설정된 날에는 해당 근무자에게 당직이 배정되지 않습니다.
- **Day-off 희망:** 특정 날짜에 Day-off를 희망하는 경우, 해당 Day-off를 얻기 위해 **그 전날에 반드시 당직을 서도록** 합니다. 만약 전날 당직이 불가능하면 스케줄 생성이 실패할 수 있습니다.

### 2. 근무 시간 및 공평성 규칙
- **주간 최대 근무 시간:** 모든 근무자의 주간 총 근무 시간(정규 근무 + 당직)은 72시간을 초과하지 않도록 합니다.
- **당직 횟수 분배:** 연차 내에서 모든 근무자가 최대한 비슷한 횟수의 당직(병당, 응당)을 서도록 분배합니다.
- **Day-off 분배:** 평일 당직 다음 날 주어지는 Day-off 횟수 또한 연차 내에서 최대한 공평하게 분배됩니다.
- **이전 달 보정치 적용:** 이전 달에 당직이나 Day-off가 많거나 적었던 것을 보정치로 입력받아, 이번 달 스케줄에 반영하여 여러 달에 걸쳐 공평함이 유지되도록 합니다.

### 3. 3년차(R3) 특별 규칙
- **주 1회 당직 제한:** 3년차는 **주 1회**를 초과하여 당직을 서지 않는 것을 원칙으로 합니다.
- **예외 상황 처리:**
    - 만약 3년차 근무자의 휴가로 인해 이 규칙을 도저히 지킬 수 없는 경우에만, 시스템은 이 규칙을 자동으로 완화하여 스케줄을 생성합니다.
    - 그 외의 경우에는 이 규칙이 **반드시** 지켜집니다. 규칙을 지킬 수 없으면 스케줄 생성이 실패하고 사용자에게 알려줍니다.
- **소아과 수요일 당직 제외:** 소아과 3년차는 수요일에 당직이 배정되지 않습니다.
- **짝수 인원 분배:** 소아과가 아닌 3년차가 2명일 경우, 두 근무자의 병당, 응당, Day-off 횟수가 서로 1회 이상 차이 나지 않도록 최대한 동일하게 맞춥니다.

### ILP 모델 입력값 도출 과정 (사전 계산)

ILP 솔버에 전달되는 제약 조건들은 단순히 고정된 값이 아니라, 사용자의 입력과 스케줄링 기간의 특성(휴일, 요일 등)에 따라 동적으로 계산됩니다. 다음은 주요 입력값들이 어떻게 도출되는지에 대한 설명입니다.

1.  **정규 근무 시간 (`RegularHours_p`)**:
    *   **계산 함수:** `scheduler.js`의 `rebuildLedger` 함수에서 최종 스케줄을 바탕으로 계산됩니다.
    *   **설명:** 모든 근무자 `p`에 대해, 당직이 없는 날의 정규 근무 시간은 **8시간**으로 고정됩니다. 하지만 근무자 `p`가 당직을 수행한 다음 날이거나, UI에서 'Day-off 희망일'로 지정된 날에는 정규 근무 시간 계산에서 제외됩니다 (즉, 해당 날의 `RegularHours_p`는 **0시간**으로 간주됩니다).
    *   **역할:** 이 값은 ILP 모델 내에서 주간 총 근무 시간 제약(`SUM_d_in_week( SUM_s (x_pds * DutyHours_s) + RegularHours_p ) <= C_p`)을 구성할 때 사용됩니다.

2.  **주간 최대 허용 근무 시간 (`C_p`)**:
    *   **계산 함수:** `scheduler.js`의 `buildModel` 함수 내에서 각 근무자 `p`와 각 주(`week`)에 대해 동적으로 계산됩니다.
    *   **설명:**
        *   기본적으로 모든 근무자의 주간 최대 근무 시간은 **72시간**입니다.
        *   하지만 특정 연차(`klass`)의 근무자 중 한 명이라도 해당 주에 휴가가 있다면, 해당 연차의 모든 근무자에 대한 주간 최대 근무 시간은 **80시간**으로 일시적으로 완화됩니다.
        *   또한, 근무자 `p`가 해당 주에 휴가를 사용한 경우, 그 휴가 일수만큼 정규 근무 시간(8시간/일)이 차감되어 `C_p`가 조정됩니다. 이는 휴가로 인해 실제로 근무할 수 있는 시간이 줄어들었음을 반영합니다.
    *   **코드 스니펫 (buildModel 내):**
        ```javascript
        const cap = vacationKlasses.has(person.klass) ? 80 : 72;
        const numWeekdays = weekdaysInWeek.get(wk) || 0;
        const numVacationDays = vacationWeekdays.get(person.id)?.get(wk) || 0;
        const effectiveCap = cap - (numWeekdays * REGULAR_HOURS) + (numVacationDays * REGULAR_HOURS);
        // ...
        model.constraints[constraintName] = { max: effectiveCap };
        ```
    *   **수학적 표현:**
        `C_p = BaseCap - (NumWorkdays_in_week * RegularHours_per_day) + (VacationDays_p_in_week * RegularHours_per_day)`
        -   `BaseCap`: 기본 72시간 또는 연차 내 휴가자 존재 시 80시간
        -   `NumWorkdays_in_week`: 해당 주에 있는 총 평일 수
        -   `VacationDays_p_in_week`: 근무자 `p`가 해당 주에 사용한 휴가 일수
        -   `RegularHours_per_day`: 8시간
    *   **역할:** 이 값은 ILP 모델 내에서 주간 총 근무 시간 제약(`SUM_d_in_week( SUM_s (x_pds * DutyHours_s) + RegularHours_p ) <= C_p`)의 우변 값으로 사용됩니다.

3.  **Day-off 최소/최대 허용 횟수 (`MinDO_p`, `MaxDO_p`)**:
    *   **계산 함수:** `scheduler.js`의 `buildModel` 함수 내에서 비(非)R3 근무자들을 대상으로 계산됩니다.
    *   **설명:** Day-off는 평일 당직 다음 날 주어지는 휴무를 의미합니다. 전체 스케줄 기간 동안 발생할 수 있는 총 Day-off 횟수를 계산하고, 이를 Day-off 배정 대상 근무자 수로 나누어 평균 Day-off 횟수를 구합니다. 각 근무자 `p`의 `MinDO_p`는 `평균 Day-off 횟수 - 3`, `MaxDO_p`는 `평균 Day-off 횟수 + 3`으로 설정됩니다. (3년차는 이 규칙에서 제외됩니다.)
    *   **이전 달 보정치 적용:** `MinDO_p`와 `MaxDO_p`는 이전 달로부터 이월된 Day-off 보정치(`CarryoverDO_p`)를 반영하여 조정됩니다.
    *   **코드 스니펫 (buildModel 내):**
        ```javascript
        let actualPossibleDayoffs = 0;
        for (let i = 0; i < days.length; i++) {
          const currentDay = days[i];
          const nextDay = days[i + 1];
          if (nextDay && isWorkday(currentDay, holidaySet) && isWorkday(nextDay, holidaySet)) {
            actualPossibleDayoffs += 2; // 각 평일 슬롯 2개
          }
        }
        const totalDayoffs = actualPossibleDayoffs;
        const eligibleForDayoffCap = employees.filter(p => p.klass !== 'R3');
        const avgDayoffs = totalDayoffs / Math.max(1, eligibleForDayoffCap.length);
        const minDayoffs = Math.max(0, Math.floor(avgDayoffs) - 3);
        const maxDayoffs = Math.ceil(avgDayoffs) + 3;

        for (const person of eligibleForDayoffCap) {
          const carryover = person.carryover.off || 0;
          model.constraints[`dayoff_cap_${person.id}`] = {
            min: minDayoffs - carryover,
            max: maxDayoffs - carryover,
          };
        }
        ```
    *   **수학적 표현:**
        `MinDO_p = floor(AvgDO) - 3 - CarryoverDO_p`
        `MaxDO_p = ceil(AvgDO) + 3 - CarryoverDO_p`
        -   `AvgDO`: `totalDayoffs` / Day-off 배정 대상 근무자 수
        -   `totalDayoffs`: `SUM_d (2 * I(d is workday and d+1 is workday))`
        -   `CarryoverDO_p`: 근무자 `p`의 이전 달 Day-off 보정치
    *   **역할:** 이 값은 ILP 모델 내에서 비(非)R3 근무자들의 Day-off 횟수 균형을 맞추는 제약 조건의 상한 및 하한 값으로 사용됩니다.

4.  **역할별 당직 최소/최대 허용 횟수 (`MinRole_pr`, `MaxRole_pr`)**:
    *   **계산 함수:** `scheduler.js`의 `computeRoleCaps` 함수에서 각 근무자 `p`와 역할 `r`에 대해 계산됩니다.
    *   **설명:** 각 역할(`role`, 예: 병당, 응당)에 대해, 전체 스케줄 기간 동안 필요한 총 당직 횟수를 계산하고, 이를 해당 역할에 배정 가능한 근무자 수로 나누어 평균 당직 횟수를 구합니다. 각 근무자 `p`의 `MinRole_pr`과 `MaxRole_pr`은 해당 역할의 평균 당직 횟수를 기준으로 일정 범위 내에서 설정됩니다.
    *   **이전 달 보정치 적용:** `MinRole_pr`과 `MaxRole_pr` 또한 이전 달로부터 이월된 해당 역할의 당직 보정치(`CarryoverRole_pr`)를 반영하여 조정됩니다.
    *   **코드 스니펫 (computeRoleCaps 내):**
        ```javascript
        const roleDeviationLimit = (klass) => { /* ... */ }; // 연차별 허용 편차
        // ...
        const tBy = sBy > 0 ? (slots.by * (eligBy.get(p.id) || 0) / sBy) : (slots.by / numInClass);
        const tEu = sEu > 0 ? (slots.eu * (eligEu.get(p.id) || 0) / sEu) : (slots.eu / numInClass);
        const limit = roleDeviationLimit(k);

        if (Number.isFinite(limit)) {
          capBy.set(p.id, Math.max(Math.ceil(tBy), Math.floor(tBy) + limit));
          capEu.set(p.id, Math.max(Math.ceil(tEu), Math.floor(tEu) + limit));
          minCapBy.set(p.id, Math.max(0, Math.ceil(tBy) - limit));
          minCapEu.set(p.id, Math.max(0, Math.ceil(tEu) - limit));
        } // ...
        ```
    *   **수학적 표현:**
        `MinRole_pr = floor(AvgRole_r) - DeviationLimit_r - CarryoverRole_pr`
        `MaxRole_pr = ceil(AvgRole_r) + DeviationLimit_r - CarryoverRole_pr`
        -   `AvgRole_r`: 역할 `r`의 총 당직 횟수 / 역할 `r` 배정 가능 근무자 수
        -   `DeviationLimit_r`: 역할 `r`에 대한 허용 편차 (일반적으로 1, 완화 모드 시 2, R3는 2)
        -   `CarryoverRole_pr`: 근무자 `p`의 역할 `r`에 대한 이전 달 당직 보정치
    *   **역할:** 이 값은 ILP 모델 내에서 근무자별 역할별 당직 횟수 균형을 맞추는 제약 조건의 상한 및 하한 값으로 사용됩니다.

5.  **이전 달 보정치 (`CarryoverDO_p`, `CarryoverRole_pr`)**:
    *   **계산 함수:** `app.js`의 `getPreviousStatsFromUI` 함수를 통해 UI에서 입력받거나, `app.js`의 `computeCarryoverDeltas` 함수를 통해 이전 달 스케줄 결과에서 자동으로 계산됩니다.
    *   **설명:** 이 보정치는 특정 근무자가 이전 달에 평균보다 당직을 더 많이 섰다면 음수(-), 적게 섰다면 양수(+)로 기록되어, 이번 달 스케줄에서 해당 근무자에게 당직을 더 적게/많이 배정하도록 유도합니다.
    *   **계산 방식 (`computeCarryoverDeltas` 함수):**
        1.  이전 달의 각 근무자별 당직 횟수(병당, 응당) 및 Day-off 횟수를 집계합니다.
        2.  각 연차 및 역할별로 근무자들의 횟수를 비교하여 중앙값(median) 또는 최빈값(mode)을 기준으로 삼습니다.
        3.  각 근무자의 횟수와 기준값의 차이(`횟수 - 기준값`)를 보정치로 계산합니다. 이 보정치는 다음 달 스케줄의 제약 조건에 반영되어, 이전 달의 불균형을 해소하는 데 기여합니다.
    *   **역할:** 이 값은 ILP 모델 내에서 Day-off 및 역할별 당직 횟수 제약 조건의 상한 및 하한 값을 조정하는 데 사용됩니다.

### ILP 모델의 주요 제약 조건 (수학적 표현)

스케줄링 시스템은 다음 변수와 제약 조건들을 사용하여 최적의 당직표를 계산합니다.

**변수 정의:**
-   `x_pds`: 근무자 `p`가 날짜 `d`의 슬롯 `s`에 배정되면 1, 아니면 0 (이진 변수)
    -   `p`: 근무자 ID
    -   `d`: 날짜 인덱스 (0부터 시작)
    -   `s`: 슬롯 인덱스 (0: 병당, 1: 응당)

**주요 제약 조건:**

1.  **모든 슬롯은 채워져야 한다:**
    *   **설명:** 각 날짜 `d`의 각 당직 슬롯 `s` (병당, 응당)은 정확히 한 명의 근무자에게 배정되어야 합니다. 이는 스케줄에 빈 슬롯이 없도록 하는 가장 기본적인 제약입니다.
    *   **수학적 표현:** `SUM_p (x_pds) = 1` (모든 `d`, `s`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        for (let i = 0; i < days.length; i += 1) {
          for (let slot = 0; slot < 2; slot += 1) {
            const constraintName = `slot_${i}_${slot}`;
            model.constraints[constraintName] = { equal: 1 }; // 정확히 1명 배정
            // underfill 변수를 통해 슬롯이 채워지지 않을 경우 높은 페널티 부여
            const underfillName = `underfill_${i}_${slot}`;
            model.variables[underfillName] = { penalty: UNDERFILL_WEIGHT, [constraintName]: 1 };
            model.binaries[underfillName] = 1;
          }
        }
        ```

2.  **근무자별 일일 최대 당직 횟수 (연속 당직 금지 포함):**
    *   **설명:**
        *   어떤 근무자 `p`도 특정 날짜 `d`에 1개 이상의 당직을 맡을 수 없습니다. (예: 병당과 응당을 동시에 맡을 수 없음)
        *   또한, 근무자 `p`가 날짜 `d`에 당직을 맡았다면, 다음 날인 `d+1`에는 당직을 맡을 수 없습니다. (연속 당직 금지)
    *   **수학적 표현:**
        *   `SUM_s (x_pds) <= 1` (모든 `p`, `d`에 대해)
        *   `SUM_s (x_pds) + SUM_s (x_p(d+1)s) <= 1` (모든 `p`, `d`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        for (const person of employees) {
          for (let dayIdx = 0; dayIdx < days.length; dayIdx += 1) {
            // 일일 최대 당직 횟수 (1회)
            model.constraints[`pd_${person.id}_${dayIdx}`] = { max: 1 };
            // 연속 당직 금지
            if (dayIdx < days.length - 1) {
              model.constraints[`pc_${person.id}_${dayIdx}`] = { max: 1 };
            }
          }
        }
        // 변수 연결 (메인 할당 루프 내)
        // model.variables[varName][`pd_${person.id}_${dayIdx}`] = 1;
        // if (dayIdx > 0) { model.variables[varName][`pc_${person.id}_${dayIdx - 1}`] = 1; }
        // if (dayIdx < days.length - 1) { model.variables[varName][`pc_${person.id}_${dayIdx}`] = 1; }
        ```

3.  **Day-off 희망 (강제 당직):**
    *   **설명:** 근무자 `p`가 날짜 `D_off`에 Day-off를 희망하는 경우, `D_off`의 전날 `D_prev`에 반드시 당직을 맡도록 강제합니다. 이는 희망하는 Day-off를 얻기 위한 필수 조건입니다.
    *   **수학적 표현:** `SUM_s (x_p(D_prev)s) = 1` (모든 `p`, `D_prev`에 대해, `D_prev`는 희망 Day-off의 전날)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        // buildDayoffWishes 함수에서 희망 Day-off 전날의 인덱스를 계산하여 wishes 배열에 저장
        for (const wish of dayoffWishes) {
          const constraintName = `wish_${wish.personId}_${wish.dayIndex}`;
          model.constraints[constraintName] = { equal: 1 }; // 전날 당직 강제
        }
        // 변수 연결 (메인 할당 루프 내)
        // const wishConstraintName = `wish_${person.id}_${dayIdx}`;
        // if (model.constraints[wishConstraintName]) {
        //   model.variables[varName][wishConstraintName] = 1;
        // }
        ```

4.  **주간 최대 근무 시간:**
    *   **설명:** 근무자 `p`의 주간 총 근무 시간은 `C_p` 시간을 초과할 수 없습니다. `C_p`는 'ILP 모델 입력값 도출 과정' 섹션에서 설명된 대로 근무자의 연차, 휴가 여부 등에 따라 동적으로 계산됩니다.
    *   **수학적 표현:** `SUM_d_in_week( SUM_s (x_pds * DutyHours_s) + RegularHours_p ) <= C_p` (모든 `p`, `week`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        for (const person of employees) {
          for (const wk of weekKeys) {
            // C_p 계산 로직 (vacationKlasses, weekdaysInWeek, vacationWeekdays 사용)
            const cap = vacationKlasses.has(person.klass) ? 80 : 72;
            const numWeekdays = weekdaysInWeek.get(wk) || 0;
            const numVacationDays = vacationWeekdays.get(person.id)?.get(wk) || 0;
            const effectiveCap = cap - (numWeekdays * REGULAR_HOURS) + (numVacationDays * REGULAR_HOURS);

            const constraintName = `total_week_hours_${person.id}_${wk}`;
            model.constraints[constraintName] = { max: effectiveCap };
          }
        }
        // 변수 연결 (메인 할당 루프 내)
        // const coefficient = isWeekday ? (DUTY_HOURS.weekday - REGULAR_HOURS) : DUTY_HOURS.weekend;
        // model.variables[varName][`total_week_hours_${person.id}_${weekKey}`] = coefficient;
        ```

5.  **1년차(R1) 주간 당직 횟수 제한:**
    *   **설명:** 1년차 근무자 `p`는 특정 주 `week`에 2회 초과하여 당직을 맡을 수 없습니다. 이 제약은 `enforceR1WeeklyCap` 플래그가 `true`일 때만 적용됩니다.
    *   **수학적 표현:** `SUM_d_in_week( SUM_s (x_pds) ) <= 2` (모든 R1 근무자 `p`, `week`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        if (enforceR1WeeklyCap) {
          const r1s = employees.filter(p => p.klass === 'R1');
          for (const person of r1s) {
            for (const wk of weekKeys) {
              const constraintName = `r1_weekly_cap_${person.id}_${wk}`;
              model.constraints[constraintName] = { max: 2 };
            }
          }
        }
        // 변수 연결 (메인 할당 루프 내)
        // if (enforceR1WeeklyCap && person.klass === 'R1') {
        //   const constraintName = `r1_weekly_cap_${person.id}_${weekKey}`;
        //   if (model.constraints[constraintName]) {
        //     model.variables[varName][constraintName] = 1;
        //   }
        // }
        ```

6.  **3년차(R3) 주간 당직 횟수 제한:**
    *   **설명:** 3년차 근무자 `p`는 특정 주 `week`에 1회 초과하여 당직을 맡을 수 없습니다. 이 제약은 `enforceR3WeeklyCap` 플래그가 `true`일 때만 적용됩니다.
    *   **수학적 표현:** `SUM_d_in_week( SUM_s (x_pds) ) <= 1` (모든 R3 근무자 `p`, `week`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        if (enforceR3WeeklyCap) {
          const r3s = employees.filter(p => p.klass === 'R3');
          for (const person of r3s) {
            for (const wk of weekKeys) {
              const constraintName = `r3_weekly_cap_${person.id}_${wk}`;
              model.constraints[constraintName] = { max: 1 };
            }
          }
        }
        // 변수 연결 (메인 할당 루프 내)
        // if (enforceR3WeeklyCap && person.klass === 'R3') {
        //   const constraintName = `r3_weekly_cap_${person.id}_${weekKey}`;
        //   if (model.constraints[constraintName]) {
        //     model.variables[varName][constraintName] = 1;
        //   }
        // }
        ```

7.  **Day-off 균형:**
    *   **설명:** 비(非)R3 근무자 `p`의 Day-off 횟수는 `MinDO_p`와 `MaxDO_p` 사이에 있어야 합니다. `MinDO_p`와 `MaxDO_p`는 'ILP 모델 입력값 도출 과정' 섹션에서 설명된 대로 계산됩니다.
    *   **수학적 표현:** `MinDO_p <= DayOffCount_p <= MaxDO_p` (모든 비R3 근무자 `p`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        const eligibleForDayoffCap = employees.filter(p => p.klass !== 'R3');
        // ... minDayoffs, maxDayoffs 계산 ...
        for (const person of eligibleForDayoffCap) {
          const carryover = person.carryover.off || 0;
          model.constraints[`dayoff_cap_${person.id}`] = {
            min: minDayoffs - carryover,
            max: maxDayoffs - carryover,
          };
        }
        // 변수 연결 (메인 할당 루프 내)
        // if (isWeekday && person.klass !== 'R3') {
        //   model.variables[varName][`dayoff_cap_${person.id}`] = 1;
        // }
        ```

8.  **역할별 당직 횟수 균형:**
    *   **설명:** 근무자 `p`의 특정 역할 `role` (병당/응당) 당직 횟수는 `MinRole_pr`와 `MaxRole_pr` 사이에 있어야 합니다. `MinRole_pr`과 `MaxRole_pr`은 'ILP 모델 입력값 도출 과정' 섹션에서 설명된 대로 계산됩니다.
    *   **수학적 표현:** `MinRole_pr <= RoleDutyCount_pr <= MaxRole_pr` (모든 `p`, `role`에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
        for (const person of employees) {
          if (person.klass === 'R3') {
            // R3는 병당/응당 통합 제한
            const maxCombined = (capBy.get(person.id) || 0) + (capEu.get(person.id) || 0);
            const minCombined = (minCapBy.get(person.id) || 0) + (minCapEu.get(person.id) || 0);
            const carryoverCombined = (person.carryover.byung || 0) + (person.carryover.eung || 0);
            const constraintName = `role_combined_${person.id}`;
            model.constraints[constraintName] = {
              min: minCombined - carryoverCombined,
              max: maxCombined - carryoverCombined,
            };
          } else {
            // 비R3는 병당/응당 개별 제한
            const maxBy = capBy.get(person.id);
            const minBy = minCapBy.get(person.id);
            if (Number.isFinite(maxBy)) {
              model.constraints[`role_byung_${person.id}`] = {
                min: minBy - (person.carryover.byung || 0),
                max: maxBy - (person.carryover.byung || 0),
              };
            }
            const maxEu = capEu.get(person.id);
            const minEu = minCapEu.get(person.id);
            if (Number.isFinite(maxEu)) {
              model.constraints[`role_eung_${person.id}`] = {
                min: minEu - (person.carryover.eung || 0),
                max: maxEu - (person.carryover.eung || 0),
              };
            }
          }
        }
        // 변수 연결 (메인 할당 루프 내)
        // if (person.klass === 'R3') {
        //   model.variables[varName][`role_combined_${person.id}`] = 1;
        // } else {
        //   if (slot === 0) { model.variables[varName][`role_byung_${person.id}`] = 1; }
        //   if (slot === 1) { model.variables[varName][`role_eung_${person.id}`] = 1; }
        // }
        ```

9.  **R3 Day-off 균형:**
    *   **설명:** R3 근무자가 2명 이상일 경우, R3 그룹 내에서 Day-off 횟수의 차이가 최대 1회 이내가 되도록 제한합니다. 이 제약은 이전 달의 Day-off 보정치(`carryover`)를 반영하여 조정된 Day-off 횟수를 기준으로 균형을 맞춥니다.
    *   **수학적 표현:** `max(AdjustedDO_p) - min(AdjustedDO_p) <= 1` (모든 R3 근무자 `p`에 대해)
        -   `AdjustedDO_p = DayOffCount_p + CarryoverDO_p`
    *   **구현 (`buildModel` 함수):**
        ```javascript
        const r3s = employees.filter(p => p.klass === 'R3');
        if (r3s.length > 1) {
          model.variables['min_r3_dayoffs'] = { penalty: 0 };
          model.variables['max_r3_dayoffs'] = { penalty: 0 };
          model.constraints['r3_dayoff_diff'] = { max: 1 };
          model.variables['max_r3_dayoffs']['r3_dayoff_diff'] = 1;
          model.variables['min_r3_dayoffs']['r3_dayoff_diff'] = -1;

          for (const person of r3s) {
            const carryoverOff = person.carryover.off || 0;
            model.constraints[`r3_dayoff_link_min_${person.id}`] = { min: -carryoverOff };
            model.constraints[`r3_dayoff_link_max_${person.id}`] = { max: -carryoverOff };
            // 변수 연결 (메인 할당 루프 내)
            // model.variables[varName][`r3_dayoff_link_min_${person.id}`] = 1;
            // model.variables[varName][`r3_dayoff_link_max_${person.id}`] = 1;
          }
        }
        ```

10. **R3 비소아과 짝수 인원 분배:**
    *   **설명:** 소아과가 아닌 R3 근무자가 정확히 2명일 경우, 이 두 근무자의 병당 당직 횟수, 응당 당직 횟수, Day-off 횟수가 각각 최대 1회 이내로 차이 나도록 제한합니다.
    *   **수학적 표현:** `|DutyCount_p1 - DutyCount_p2| <= 1` (병당, 응당, Day-off 각각에 대해)
    *   **구현 (`buildModel` 함수):**
        ```javascript
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
          // 변수 연결 (메인 할당 루프 내)
          // if (person.id === p1Id || person.id === p2Id) {
          //   const sign = person.id === p1Id ? 1 : -1;
          //   if (slot === 0) { model.variables[varName][`r3_balance_byung_1`] = sign; ... }
          // }
        }
        ```

11. **근무자 자격 조건 (`isEligibleForSlot` 함수):**
    *   **설명:** 각 근무자는 특정 당직 슬롯에 배정되기 위한 여러 자격 조건을 만족해야 합니다. 이 조건들은 ILP 모델의 제약 조건으로 직접 추가되기보다는, `buildModel` 함수 내에서 `x_pds` 변수 자체를 생성할지 말지를 결정하는 필터 역할을 합니다. 즉, 자격이 없는 근무자에 대해서는 해당 `x_pds` 변수가 아예 생성되지 않아 솔버가 고려할 필요가 없게 됩니다.
    *   **주요 조건:**
        *   **연차 일치:** 근무자의 연차(`klass`)가 해당 슬롯에 필요한 연차와 일치해야 합니다.
        *   **휴가/당직 불가:** 해당 날짜에 휴가 중이거나 당직 불가로 지정되지 않아야 합니다.
        *   **Day-off 희망:** Day-off 희망일의 전날이 아니어야 합니다. (이전 로직)
        *   **전일 당직 쿨다운:** 전날 당직을 섰다면 다음 날 당직 배정 불가 (연속 당직 금지).
        *   **R3 소아과 수요일 제외:** 소아과 R3는 수요일 당직 불가.
    *   **구현 (`isEligibleForSlot` 함수):**
        ```javascript
        function isEligibleForSlot({ person, neededClass, date, dayKey, slot, isWeekday, holidaySet, dayIdx, priorCooldownIndex }) {
          if ((person.klass || '') !== neededClass) return false;
          if (person.vacationDays.has(dayKey)) return false;
          if (person.dutyUnavailable.has(dayKey)) return false;
          if (person.dayoffWish.has(dayKey)) return false; // Day-off 희망일 전날 당직 금지 (이전 로직)
          if (priorCooldownIndex.get(person.id)?.has(dayIdx)) return false; // 전일 당직 쿨다운
          if (date.getDay() === 3 && person.klass === 'R3' && person.pediatric) return false; // R3 소아과 수요일 제외
          return true;
        }
        ```

12. **전일 당직 후 쿨다운 (`buildPriorCooldown` 함수):**
    *   **설명:** 스케줄 시작일의 전날에 당직을 선 근무자(`priorDayDuty`)는 스케줄 시작일 당일에 당직을 맡을 수 없습니다. 이는 연속 당직 금지 규칙의 확장으로, 스케줄 기간을 넘어선 연속 당직을 방지합니다.
    *   **구현 (`buildPriorCooldown` 함수):**
        ```javascript
        function buildPriorCooldown(days, employees) {
          const map = new Map();
          for (const person of employees) {
            map.set(person.id, new Set());
          }
          if (days.length > 0) {
            for (const p of employees) {
              if (p.isPriorDuty) { // isPriorDuty는 prepareContext에서 설정됨
                map.get(p.id).add(0); // 스케줄 첫째 날(인덱스 0) 당직 불가
              }
            }
          }
          return map;
        }
        ```

## 최적화 및 재시도 로직

최초 스케줄이 생성된 후에도, 시스템은 더 나은 결과를 찾기 위해 여러 번의 재시도를 수행합니다. 이 과정은 `app.js`의 `onGenerate` 함수 내에서 관리됩니다.

1.  **R1/R3 주간 당직 제약의 초기 적용 결정:**
    *   스케줄 생성 전, 1년차(R1)와 3년차(R3) 근무자 중 스케줄 기간 내에 휴가를 가는 사람이 있는지 각각 확인합니다.
    *   **휴가자가 없는 경우:** 해당 연차의 주간 당직 제약(R1: 2회, R3: 1회)을 **강제 적용**합니다. 만약 이 제약을 지키지 못하면 스케줄 생성은 실패하고 오류를 반환합니다.
    *   **휴가자가 있는 경우:** 해당 연차의 주간 당직 제약을 **적용하여** 스케줄 생성을 시도합니다. 만약 이 시도가 실패하면, 해당 제약을 **완화(해제)**하고 다시 스케줄 생성을 시도하여 일단 가능한 스케줄을 확보합니다.
    *   **구현 (`app.js`의 `onGenerate` 함수):**
        ```javascript
        // R1 휴가자 여부 확인 (anyR1HasVacation)
        // R3 휴가자 여부 확인 (anyR3HasVacation)

        let bestResult;
        let r1CapEnforced = true; // R1 주간 당직 제약 적용 여부
        let r3CapEnforced = true; // R3 주간 당직 제약 적용 여부

        try {
            // ... 초기 제약 적용 시도 ...
            const initialR1Cap = !anyR1HasVacation;
            const initialR3Cap = !anyR3HasVacation;
            bestResult = runSchedule(roleHardcapMode, undefined, initialR3Cap, initialR1Cap);
            r1CapEnforced = initialR1Cap;
            r3CapEnforced = initialR3Cap;
        } catch (e) {
            // ... 실패 시 제약 완화 후 재시도 ...
            r1CapEnforced = false;
            r3CapEnforced = false;
            bestResult = runSchedule(roleHardcapMode, undefined, false, false);
        }
        ```

2.  **반복 최적화:**
    *   초기 스케줄 생성 후, 시스템은 `bestResult`를 개선하기 위해 여러 번의 재시도를 수행합니다 (최대 50회).
    *   이 재시도 과정에서 `runSchedule` 함수를 호출할 때, 위 1단계에서 결정된 `r1CapEnforced`와 `r3CapEnforced` 플래그 값을 **그대로 사용합니다.**
    *   **목표:**
        1.  주간 근무시간 72시간 초과 최소화
        2.  연차 내 당직 횟수 편차 최소화
        3.  비어있는 당직 슬롯 최소화
    *   **구현 (`app.js`의 `onGenerate` 함수 내 최적화 루프):**
        ```javascript
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            // ...
            const candidateResult = runSchedule(roleHardcapMode, undefined, r3CapEnforced, r1CapEnforced);
            // ... 더 나은 결과가 발견되면 bestResult 업데이트 ...
        }
        ```
