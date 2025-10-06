# Test Harness

This folder contains a lightweight browser harness that drives the existing UI with canned scenarios. It is useful when you want to reproduce scheduling issues quickly or let an agent run the generator end-to-end without manual input.

## Quick start (browser harness)

1. Serve the repo (any static server works). Example:
   ```bash
   python3 serve/serve.py --port 1734 --prefix /app/ --open
   ```
2. Open the harness page:
   - `http://localhost:1734/app/tests/harness.html` → loads the default `sample` scenario
   - Append `?scenario=<name>` to load a different file from `tests/scenarios/`
3. The harness auto-fills the forms inside the embedded app, clicks “당직표 생성”, and prints the resulting summary/messages. When generation finishes you will see the outcome card below the iframe.

## CLI runner

Run scenarios from the terminal with Playwright (Chromium headless).

```bash
# install once
npm install --save-dev playwright
npx playwright install chromium

# run a scenario (defaults to sample)
node tests/run-scenario.mjs --scenario sample
```

Options:

- `--scenario <name>` – load `tests/scenarios/<name>.json`
- `--port <number>` – serve on a fixed port (defaults to 0 = random)
- `--no-headless` – launch Chromium with a visible window (useful for debugging)

Exit codes:

- `0` – success, expectations satisfied
- `1` – failure (errors, solver issues, etc.)
- `2` – completed with warnings (e.g., expected strings not found in summary)

## Scenario format

Each scenario is a JSON file with the following (optional) fields:

| Field | Type | Notes |
| --- | --- | --- |
| `label` | string | Friendly name, rendered in the harness header |
| `description` | string | Additional context for humans |
| `startDate`, `endDate` | string (YYYY-MM-DD) | Empty values fall back to UI defaults |
| `weeks` | number | 1-8; ignored if `endDate` is present |
| `retryAttempts` | number | Overrides the UI retry count |
| `employees`, `holidays`, `unavailable`, `dayoffWish`, `vacations` | string | Direct text dropped into the matching textarea |
| `toggles` | object | Boolean flags keyed by rule id (see below) |
| `scores` | object | Override scoring inputs, e.g. `{ "overtimeSoft": 1.5 }` |

Supported toggle keys: `r1WeeklyCap`, `r3WeeklyCap`, `r2WeeklyMin`, `r3Balance`, `dayoffWish`, `r3PediatricWednesday`, `vacationExclusion`, `unavailableExclusion`.

Supported score keys map to the input ids minus the `score-` prefix: `overtimeSoft`, `overtimeHard`, `under40`, `dayoffBase`, `dayoffIncrement`, `roleBase`, `roleIncrement`.

## Writing new scenarios

Create `tests/scenarios/<name>.json` following the structure above. Once the file exists, open `harness.html?scenario=<name>` to run it. Feel free to add `expectedSummaryContains` or `expectedWarnings` fields if you want to add simple assertions (the harness will emit warnings when expectations are not met).

## Automating

Because the harness lives inside regular HTML/JS, any automation tool (Playwright, Selenium, etc.) can open the page, wait for the `#run-output` element to populate, and read the summary JSON to make go/no-go decisions. No additional build steps are required.
