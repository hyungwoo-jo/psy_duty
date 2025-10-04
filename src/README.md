# `scheduler.js` ILP 모델 아키텍처

스케줄링 시스템의 전반적인 동작 방식, 주요 규칙, 제약 조건 및 수학적 표현에 대한 비기술적인 설명은 [`logic.md`](./logic.md) 파일을 참조하십시오.

이 문서는 `scheduler.js`에서 사용되는 정수 선형 계획법(ILP) 모델의 제약 조건과 코드 구조를 설명합니다.

## 개요

이 스케줄링 모델은 복잡한 규칙들을 만족하는 유효한 해를 찾기 위해 ILP를 사용합니다. 모델의 핵심 목표는 최적의 "품질" 점수를 찾는 것이 아니라, 아래에 명시된 모든 **하드 제약 조건(Hard Constraint)**을 만족하는 실행 가능한 해를 찾는 것입니다. 즉, "가장 좋은 해"를 찾는 최적화 문제가 아닌, "규칙을 모두 지키는 해"를 찾는 제약 충족 문제입니다.

유일한 예외는 모든 슬롯을 반드시 채우도록 하는 제약으로, 이는 매우 높은 페널티를 부여하여 사실상 하드 제약 조건처럼 작동합니다.

## Constraints

The model uses a set of hard constraints to define a valid schedule. The solver then finds a solution that satisfies all these constraints.

### Eligibility Constraints

A person can only be assigned to a duty slot if all the following conditions are met:

1.  **Correct Class (`klass`)**: The person's resident year (R1-R4) must match the requirement for that specific slot.
2.  **Not on Vacation**: The person must not be on vacation on that day.
3.  **Not Unavailable**: The person must not be marked as unavailable for duty on that day.
4.  **No Day-off Wish**: The person must not have a day-off wish for that day.
5.  **No Consecutive Duties**: The person must not have had a duty on the previous day.
6.  **R3 Pediatric Rule**: R3 residents in pediatrics are not assigned duties on Wednesdays.

### Balancing and Fairness Constraints

(자세한 설명 및 수학적 표현은 [`logic.md`](./logic.md) 파일을 참조하십시오.)

1.  **Weekly Hours Cap**: A hard cap on the total weekly hours (regular work + duty hours).
    *   The base cap is 72 hours per week.
    *   This increases to 80 hours for all residents in a specific year (`klass`) if at least one resident of that year is on vacation.
    *   The effective cap for a person in a given week is dynamically calculated based on the number of workdays and their personal vacation days in that week.

2.  **Day-off Cap (for non-R3 residents)**:
    *   The number of day-offs (a day after a weekday duty) is balanced across all non-R3 residents.
    *   The allowed number of day-offs for each person is `average ± 3`.
    *   This cap is adjusted by the person's day-off carryover value from the previous month to ensure fairness over time.

3.  **Role-Specific Duty Caps**: 
    *   The number of duties for each role (`byung`, `eung`) is balanced for each person based on their eligibility and resident year.
    *   This cap is also adjusted by the person's role-specific carryover from the previous month.
    *   R3 residents have a combined cap for `byung` and `eung` duties.

4.  **R3-Specific Balancing**:
    (자세한 설명 및 수학적 표현은 [`logic.md`](./logic.md) 파일을 참조하십시오.)
    *   **Day-off Balancing**: The difference in the total number of day-offs between R3 residents is constrained to be at most 1.
    *   **Pair Balancing**: If there are exactly two R3 residents not in pediatrics, their `byung` duty counts, `eung` duty counts, and day-off counts are individually balanced to have a maximum difference of 1.


## 코드 구조

핵심 로직은 `scheduler.js` 내의 다음 함수들로 구성됩니다.

-   `generateSchedule(params)`: 모든 로직을 관장하는 메인 진입 함수입니다.
-   `prepareContext(params)`: 사용자의 입력을 받아 ILP 모델에 필요한 모든 데이터(기간, 근무자, 휴일, 제약 조건 등)를 준비하고 계산하는 역할을 합니다.
-   `buildModel(ctx)`: `prepareContext`에서 생성된 데이터를 바탕으로, 위에 설명된 모든 제약 조건을 정의하여 ILP 모델을 구축하는 핵심 함수입니다.
-   `buildResultFromSolution(...)`: ILP 솔버가 찾은 해를 사람이 읽을 수 있는 최종 스케줄 표와 통계 데이터로 가공합니다.
