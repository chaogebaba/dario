#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let pass = 0;
let fail = 0;
function check(label, condition) {
  if (condition) { console.log(`  PASS ${label}`); pass++; }
  else { console.log(`  FAIL ${label}`); fail++; }
}

const home = await mkdtemp(join(tmpdir(), 'dario-account-lock-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const moduleUrl = pathToFileURL(join(process.cwd(), 'dist', 'account-operation-lock.js')).href;
const { withAccountLocks } = await import(moduleUrl);
const startedPath = join(home, 'child-started');
const acquiredPath = join(home, 'child-acquired');

let releaseParent;
let parentEntered;
const parentEnteredPromise = new Promise((resolve) => { parentEntered = resolve; });
const parentGate = new Promise((resolve) => { releaseParent = resolve; });

try {
  const parentOperation = withAccountLocks(['shared'], async () => {
    parentEntered();
    await parentGate;
  });
  await parentEnteredPromise;

  const childScript = `
    const { writeFile } = await import('node:fs/promises');
    const { withAccountLocks } = await import(${JSON.stringify(moduleUrl)});
    await writeFile(${JSON.stringify(startedPath)}, 'started');
    await withAccountLocks(['SHARED'], async () => {
      await writeFile(${JSON.stringify(acquiredPath)}, 'acquired');
    });
  `;
  const child = spawn(process.execPath, ['-e', childScript], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await waitForFile(startedPath);
  await delay(100);
  check('a second process waits for the same case-folded alias', !await exists(acquiredPath));

  releaseParent();
  await parentOperation;
  const childResult = await waitForChild(child);
  check('the waiting process continues after release',
    childResult.code === 0 && await readFile(acquiredPath, 'utf-8') === 'acquired');
} finally {
  releaseParent?.();
  await rm(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

async function waitForFile(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await exists(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(20);
  }
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
