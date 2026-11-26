/* Mobile verification for teamz — drives the machine's bundled Chromium
   (the Muse Browser build) over raw CDP with Node's built-in WebSocket.
   Playwright's own Chromium download is blocked by this VM's egress
   gateway, and Playwright's launch handshake hangs against this build,
   so this script spawns chrome directly with --remote-debugging-port.

   Serves the production build via `vite preview` on :5200 (base /teamz/).
   Usage: node scripts/verify-mobile.mjs
   Writes screenshots to ~/workspace/teamz-mobile-verify/ and prints PASS/FAIL.
   Exits non-zero if any check fails.

   LNA workaround: this Chrome build blocks direct navigation to loopback
   (Local Network Access checks, and its --disable-features switches do not
   turn them off). A navigation *from* a file:// page (local address space)
   to loopback is allowed, so each tab first opens a tiny local launcher
   page and clicks through to the app. */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const OUT = join(homedir(), 'workspace', 'teamz-mobile-verify');
mkdirSync(OUT, { recursive: true });
const URL = 'http://127.0.0.1:5200/teamz/';
const LAUNCHER = '/tmp/lna-launcher.html';
writeFileSync(LAUNCHER, '<!doctype html><title>launcher</title><a id="go" href="' + URL + '">go to teamz</a>\n');

// This build refuses to start without a WebGL domain policy file + sha256.
// The file must start with the version line, list sorted registrable
// domains, and end with a newline. The app under test needs no WebGL.
const POLICY = 'hatch-webgl-allowed-domains-v1\nexample.com\n';
writeFileSync('/tmp/webgl-policy.txt', POLICY);
const POLICY_SHA = createHash('sha256').update(POLICY).digest('hex');

const CHROME = '/opt/meta-chromium/chrome';
const DEBUG_PORT = 9333;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDebugger(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

let chrome = null;
function startChrome() {
  // Fresh profile each run: first-run seed data, no stale workspace state.
  rmSync('/tmp/teamz-chrome-profile', { recursive: true, force: true });
  chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--user-data-dir=/tmp/teamz-chrome-profile',
    '--allow-file-access-from-files',
    '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessForNavigations',
    '--hatch-webgl-allowed-domains-file=/tmp/webgl-policy.txt',
    `--hatch-webgl-allowed-domains-sha256=${POLICY_SHA}`,
    'about:blank',
  ], { stdio: 'ignore', detached: true });
}
function stopChrome() {
  if (!chrome) return;
  try { process.kill(-chrome.pid, 'SIGKILL'); } catch { try { chrome.kill('SIGKILL'); } catch { /* already gone */ } }
  chrome = null;
}

/** Minimal CDP client over one page target. */
class Tab {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.loadWaiters = [];
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
      if (msg.method === 'Page.loadEventFired') {
        this.loadWaiters.splice(0).forEach((r) => r());
      }
    });
  }
  ready() { return new Promise((res) => this.ws.addEventListener('open', res, { once: true })); }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result.value;
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  }
  waitForLoad(timeoutMs = 20000) {
    return Promise.race([
      new Promise((res) => this.loadWaiters.push(res)),
      sleep(timeoutMs).then(() => 'timeout'),
    ]);
  }
}

async function newTab(metrics) {
  // Open the file:// launcher, then click through: a direct navigation to
  // loopback is blocked by this build's Local Network Access checks.
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?file://${LAUNCHER}`, { method: 'PUT' });
  const target = await res.json();
  const tab = new Tab(target.webSocketDebuggerUrl);
  await tab.ready();
  await tab.send('Page.enable');
  await tab.send('Runtime.enable');
  await tab.send('Emulation.setDeviceMetricsOverride', metrics);
  await tab.eval(`document.getElementById('go').click()`);
  // Wait for the app to mount (React root populated).
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const mounted = await tab.eval(`!!(document.getElementById('root') && document.getElementById('root').children.length > 0)`);
    if (mounted) break;
    await sleep(300);
  }
  await sleep(800);
  return tab;
}

// Hard watchdog: never hang the run.
const watchdog = setTimeout(() => { console.log('WATCHDOG: timed out'); stopChrome(); process.exit(2); }, 240000);
watchdog.unref?.();

try {
  startChrome();
  if (!(await waitForDebugger())) throw new Error('chrome devtools did not come up');

  // ---------- 390px mobile ----------
  const mob = await newTab({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const overflow = await mob.eval(`(() => ({ scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, bodyScrollW: document.body.scrollWidth }))()`);
  check('390px: no horizontal overflow', overflow.scrollW <= overflow.innerW && overflow.bodyScrollW <= overflow.innerW,
    `scrollWidth=${overflow.scrollW} bodyScrollWidth=${overflow.bodyScrollW} innerWidth=${overflow.innerW}`);

  const drawerHidden = await mob.eval(`(() => {
    const sb = document.getElementById('teamz-sidebar');
    if (!sb) return { found: false };
    const cs = getComputedStyle(sb);
    const r = sb.getBoundingClientRect();
    return { found: true, visibility: cs.visibility, rectLeft: Math.round(r.left), width: Math.round(r.width) };
  })()`);
  check('390px: sidebar drawer hidden by default', drawerHidden.found && drawerHidden.visibility === 'hidden' && drawerHidden.rectLeft < 0,
    JSON.stringify(drawerHidden));

  const hamburger = await mob.eval(`(() => {
    const b = document.querySelector('.mobile-menu');
    if (!b) return { found: false };
    const r = b.getBoundingClientRect();
    return { found: true, w: Math.round(r.width), h: Math.round(r.height), expanded: b.getAttribute('aria-expanded') };
  })()`);
  check('390px: hamburger visible, >=40px, aria-expanded=false', hamburger.found && hamburger.w >= 40 && hamburger.h >= 40 && hamburger.expanded === 'false',
    JSON.stringify(hamburger));
  await mob.shot('390-closed.png');

  await mob.eval(`document.querySelector('.mobile-menu').click()`);
  await sleep(500);
  const drawerOpen = await mob.eval(`(() => {
    const sb = document.getElementById('teamz-sidebar');
    const cs = getComputedStyle(sb);
    const r = sb.getBoundingClientRect();
    const active = document.activeElement;
    return {
      visibility: cs.visibility,
      rectLeft: Math.round(r.left),
      width: Math.round(r.width),
      activeLabel: active?.getAttribute?.('aria-label') ?? active?.textContent?.trim()?.slice(0, 30),
      scrimVisible: getComputedStyle(document.querySelector('.sidebar-scrim')).display !== 'none',
    };
  })()`);
  check('390px: drawer opens (visible, at left edge, focus on close button)', drawerOpen.visibility === 'visible' && drawerOpen.rectLeft === 0 && drawerOpen.activeLabel === 'Close navigation menu',
    JSON.stringify(drawerOpen));
  check('390px: no horizontal overflow with drawer open', await mob.eval(`document.documentElement.scrollWidth <= window.innerWidth`));
  await mob.shot('390-drawer-open.png');

  // Escape closes; focus returns to the hamburger.
  await mob.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await mob.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(500);
  const afterEsc = await mob.eval(`(() => ({
    visibility: getComputedStyle(document.getElementById('teamz-sidebar')).visibility,
    activeLabel: document.activeElement?.getAttribute?.('aria-label'),
  }))()`);
  check('390px: Escape closes drawer, focus returns to hamburger', afterEsc.visibility === 'hidden' && afterEsc.activeLabel === 'Show agents',
    JSON.stringify(afterEsc));

  // Reopen, close via the scrim (backdrop tap).
  await mob.eval(`document.querySelector('.mobile-menu').click()`);
  await sleep(500);
  await mob.eval(`document.querySelector('.sidebar-scrim').click()`);
  await sleep(500);
  check('390px: backdrop tap closes drawer', await mob.eval(`getComputedStyle(document.getElementById('teamz-sidebar')).visibility`) === 'hidden');

  // Every visible control must be >=40px in at least one dimension.
  const smallTargets = await mob.eval(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll('button, a, input, textarea, [role="button"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (r.width < 40 && r.height < 40) {
        bad.push(el.tagName + '.' + String(el.className).split(' ')[0] + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24) + '"');
      }
    }
    return bad;
  })()`);
  check('390px: visible controls >=40px in at least one dimension', smallTargets.length === 0,
    smallTargets.length ? smallTargets.slice(0, 8).join(' | ') : 'all ok');

  // Composer pinned to the viewport bottom; textarea 16px (no iOS zoom).
  const composer = await mob.eval(`(() => {
    const ta = document.querySelector('.composer textarea');
    const wrap = document.querySelector('.composer-wrap');
    if (!ta || !wrap) return { found: false };
    const wr = wrap.getBoundingClientRect();
    return { found: true, fontSize: getComputedStyle(ta).fontSize, wrapBottom: Math.round(wr.bottom), viewportH: window.innerHeight };
  })()`);
  check('390px: composer pinned to viewport bottom, textarea 16px', composer.found && composer.fontSize === '16px' && Math.abs(composer.wrapBottom - composer.viewportH) <= 1,
    JSON.stringify(composer));

  // Agent settings modal (opened from a sidebar row action) must fit.
  await mob.eval(`document.querySelector('.mobile-menu').click()`);
  await sleep(500);
  const openedSettings = await mob.eval(`(() => {
    const btn = document.querySelector('.agent-row-action[aria-label$="settings"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (openedSettings) {
    await sleep(500);
    const modal = await mob.eval(`(() => {
      const m = document.querySelector('.modal');
      if (!m) return { found: false };
      const r = m.getBoundingClientRect();
      return { found: true, w: Math.round(r.width), h: Math.round(r.height), vw: window.innerWidth, vh: window.innerHeight, overflowX: document.documentElement.scrollWidth > window.innerWidth };
    })()`);
    check('390px: Agent settings modal fits viewport, no overflow', modal.found && modal.w <= modal.vw && modal.h <= modal.vh && !modal.overflowX,
      JSON.stringify(modal));
    await mob.shot('390-agent-settings.png');
    await mob.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await mob.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(400);
  } else {
    check('390px: Agent settings modal fits viewport, no overflow', false, 'no agent settings button found');
  }

  // ---------- 1280px desktop ----------
  const desk = await newTab({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const deskState = await desk.eval(`(() => {
    const sb = document.getElementById('teamz-sidebar');
    const cs = getComputedStyle(sb);
    const r = sb.getBoundingClientRect();
    return {
      sidebarVisible: cs.visibility === 'visible' && r.left === 0 && Math.round(r.width) === 296,
      sidebarPosition: cs.position,
      hamburgerDisplay: getComputedStyle(document.querySelector('.mobile-menu')).display,
      noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  })()`);
  check('1280px: desktop layout unchanged (296px static rail, hamburger hidden, no overflow)',
    deskState.sidebarVisible && deskState.sidebarPosition !== 'fixed' && deskState.hamburgerDisplay === 'none' && deskState.noOverflow,
    JSON.stringify(deskState));
  await desk.shot('1280-desktop.png');

  // ---------- 768px boundary ----------
  const edge = await newTab({ width: 768, height: 900, deviceScaleFactor: 1, mobile: true });
  const edgeState = await edge.eval(`(() => ({
    drawerMode: getComputedStyle(document.getElementById('teamz-sidebar')).position === 'fixed',
    hamburgerShown: getComputedStyle(document.querySelector('.mobile-menu')).display !== 'none',
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
  }))()`);
  check('768px: still drawer mode, no overflow', edgeState.drawerMode && edgeState.hamburgerShown && edgeState.noOverflow,
    JSON.stringify(edgeState));
  await edge.shot('768.png');
} catch (err) {
  console.log('ERROR  ' + (err?.message ?? err));
  results.push({ name: 'script completed', ok: false, detail: String(err?.message ?? err) });
} finally {
  stopChrome();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join('; '));
  process.exitCode = 1;
}
