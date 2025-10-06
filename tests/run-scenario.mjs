#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { scenario: 'sample', prefix: '/app/', port: 0, headless: true };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '--scenario' || arg === '-s') && args[i + 1]) {
      opts.scenario = args[++i];
    } else if ((arg === '--port' || arg === '-p') && args[i + 1]) {
      opts.port = Number(args[++i]);
    } else if (arg === '--no-headless') {
      opts.headless = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node tests/run-scenario.mjs [--scenario sample] [--port 0] [--no-headless]');
      process.exit(0);
    }
  }
  return opts;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(err.message)) {
      console.error('\nPlaywright is required for headless runs. Install it with:');
      console.error('  npm install --save-dev playwright');
      console.error('  npx playwright install chromium');
      process.exit(1);
    }
    throw err;
  }
}

async function startServer(prefix, port) {
  console.log(`[runner] launching local server (port=${port || 'auto'}, prefix=${prefix})...`);
  const args = ['-u', 'serve/serve.py', '--prefix', prefix];
  let listeningPort = port;
  if (Number.isInteger(port) && port > 0) {
    args.push('--port', String(port));
  }
  const server = spawn('python3', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });

  const rl = createInterface({ input: server.stdout });

  let resolved = false;
  const ready = new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      process.stdout.write(`[serve] ${line}\n`);
      const portMatch = line.match(/:(\d+)\/(?:[^\s]+)/);
      if (portMatch && !resolved) {
        resolved = true;
        listeningPort = Number(portMatch[1]);
        resolve({ server, url: `http://localhost:${listeningPort}${prefix}` });
      }
    });
    server.once('exit', (code) => {
      if (!resolved) {
        reject(new Error(`serve.py exited with code ${code}`));
      }
    });
    server.once('error', reject);
  });

  const { server: proc, url } = await ready;
  console.log(`[runner] server ready at ${url}`);
  return { proc, url };
}

function buildHarnessUrl(baseUrl, scenario, headless) {
  const url = new URL('./tests/harness.html', baseUrl);
  url.searchParams.set('scenario', scenario);
  if (headless) url.searchParams.set('headless', '1');
  return url.toString();
}

async function runScenario(playwright, harnessUrl, headless) {
  console.log(`[runner] launching Chromium (headless=${headless})...`);
  const browser = await playwright.chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log(`[runner] navigating to ${harnessUrl}`);
  await page.goto(harnessUrl, { waitUntil: 'networkidle' });
  console.log('[runner] waiting for harness to finish...');
  await page.waitForFunction(() => window.__HARNESS_DONE__ === true, { timeout: 120000 });
  const payload = await page.evaluate(() => window.__HARNESS_RESULT__);
  await browser.close();
  return payload;
}

function printResult(result) {
  const output = JSON.stringify(result, null, 2);
  console.log('\n=== Scenario Result ===');
  console.log(output);
}

function determineExitCode(result) {
  if (!result) return 1;
  if (result.status === 'error') return 1;
  if (result.assertions && Array.isArray(result.assertions.warn) && result.assertions.warn.length > 0) {
    return 2; // soft failure when expectations missing
  }
  return 0;
}

async function main() {
  const opts = parseArgs();
  console.log(`[runner] options: ${JSON.stringify(opts)}`);
  const playwright = await loadPlaywright();
  const { proc: server, url: baseUrl } = await startServer(opts.prefix, opts.port);
  try {
    const harnessUrl = buildHarnessUrl(baseUrl, opts.scenario, opts.headless);
    console.log(`Running scenario '${opts.scenario}' at ${harnessUrl}`);
    const result = await runScenario(playwright, harnessUrl, opts.headless);
    printResult(result);
    const code = determineExitCode(result);
    if (code === 2) {
      console.warn('\nWarnings detected in assertions. Inspect output above.');
    }
    process.exitCode = code;
  } catch (err) {
    console.error('\nScenario run failed:', err);
    process.exitCode = 1;
  } finally {
    if (server && !server.killed) {
      server.kill('SIGINT');
      await once(server, 'exit').catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
