/* Record a walk from the phone's motion sensors (#51), with the browser's devicemotion
   event: tap Record, walk, hold to stop, answer two optional questions, and the recording
   loads like an uploaded file. Every sample keeps its own timestamp; nothing is resampled
   here. Turning samples into CSV text is StepCore.recordingCsv (core.js, no DOM). This file
   owns the listeners, the wake lock and the full-screen overlay, and hands the finished
   recording to app.js through onDone. */
(function () {
  'use strict';
  const C = window.StepCore;
  const $ = id => document.getElementById(id);
  const HOLD_MS = 1000, PRESS_MARGIN_MS = 300, NO_SENSOR_MS = 2500, MAX_S = 30 * 60;
  // The countdown is a setting (#recCount, remembered in this browser): 3 s was too short to put
  // the phone in a pocket (the owner's recordings, 2026-10-07).
  const COUNTDOWNS = ['3', '5', '10', '15', '30'], COUNTDOWN_KEY = 'gaitscope-countdown';
  // A locked screen hides the page, and browsers send no motion data to hidden pages (#86).
  const LOCK_ON = 'The screen stays on by itself; don\u2019t lock it, or the recording stops.',
    LOCK_OFF = 'This browser can\u2019t keep the screen on: make the screen timeout longer, and don\u2019t lock it, or the recording stops.',
    LOCK_LOST = 'The browser stopped keeping the screen on (battery saver?): make the screen timeout longer, and don\u2019t lock it, or the recording stops.',
    RELOCKS = 3; // asking again after the browser drops the lock, at most this often per recording

  // Phones and tablets: a motion API and a touch screen as the main pointer. Desktops usually
  // have the API but no sensor, so they get a hint to open the page on a phone instead.
  function available() {
    return typeof window.DeviceMotionEvent !== 'undefined' && !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  let st = null; // {phase, samples, started, timers, lock, gotData, onDone}
  const pad = n => String(n).padStart(2, '0');
  const clock = s => Math.floor(s / 60) + ':' + pad(Math.floor(s % 60));

  function show(phase, title, big, info) {
    const ov = $('recOverlay');
    ov.hidden = false; ov.dataset.phase = phase;
    document.body.classList.add('recording');
    $('recTitle').textContent = title;
    $('recBig').textContent = big;
    $('recInfo').textContent = info || '';
    $('recStop').hidden = phase !== 'recording';
    $('recForm').hidden = phase !== 'done';
    $('recErr').hidden = phase !== 'error';
  }
  function close() {
    $('recOverlay').hidden = true;
    document.body.classList.remove('recording');
  }
  function cleanup() {
    if (!st) return;
    window.removeEventListener('devicemotion', onMotion);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const t of st.timers) { clearTimeout(t); clearInterval(t); }
    st.timers = [];
    // forgotten before it's released: the browser may fire its release event straight away
    if (st.lock) { const lock = st.lock; st.lock = null; lock.release().catch(() => {}); }
  }
  function fail(title, fix, link) {
    cleanup();
    show('error', 'Can’t record', '', '');
    $('recErrText').textContent = title;
    $('recErrFix').textContent = fix || '';
    $('recErrLink').hidden = !link;
    if (link) $('recErrLink').href = link;
    st = null;
  }

  async function start(onDone) {
    if (st) return;
    if (window.isSecureContext === false) {
      // the same page over https, when it was opened over http (GitHub Pages serves both)
      const https = location.protocol === 'http:' ? location.href.replace(/^http:/, 'https:') : '';
      return fail('Motion sensors need a secure (https://) page, and this one was opened over http.',
        https ? 'Open the same page over https: ' + https : 'Open the dashboard from an https:// address.', https);
    }
    if (typeof window.DeviceMotionEvent === 'undefined') return fail('This browser has no access to motion sensors.', 'Open the page in Chrome on Android or Safari on iPhone.');
    // iPhone (Safari 13+): permission must be asked from the tap itself
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      let answer;
      try { answer = await DeviceMotionEvent.requestPermission(); } catch (e) { answer = 'denied'; }
      if (answer !== 'granted') {
        return fail('Motion access was not allowed.', 'On iPhone, Safari asks once per visit: close this tab, open the page again and tap Allow. If it doesn’t ask, go to Settings → Apps → Safari → Clear History and Website Data. On Android, check Chrome’s Site settings → Motion sensors.');
      }
    }
    st = { phase: 'countdown', samples: [], started: null, timers: [], lock: null, gotData: false, onDone };
    window.addEventListener('devicemotion', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    st.timers.push(setTimeout(() => {
      if (st && !st.gotData) fail('No motion sensor is sending data.', 'Open this page on a phone. Most computers have no accelerometer.');
    }, NO_SENSOR_MS));
    let left = Number($('recCount').value) || 5;
    show('countdown', 'Get ready', String(left), 'Put the phone where you will carry it. Don\u2019t lock the screen: the recording stops when it locks. Tap to start now.');
    st.timers.push(setInterval(() => { if (--left <= 0) begin(); else $('recBig').textContent = String(left); }, 1000));
  }

  async function begin() {
    if (!st || st.phase !== 'countdown') return;
    for (const t of st.timers.splice(1)) clearInterval(t); // keep the no-sensor timer
    st.phase = 'recording'; st.samples = []; st.started = new Date();
    show('recording', 'Recording', '0:00', '');
    st.lockNote = LOCK_OFF; st.relocks = 0;
    await keepAwake();
    if (!st) { return; }
    const tick = () => {
      if (!st || st.phase !== 'recording') return;
      const n = st.samples.length, dur = n > 1 ? (st.samples[n - 1].ts - st.samples[0].ts) / 1000 : 0;
      $('recBig').textContent = clock((Date.now() - st.started.getTime()) / 1000);
      $('recInfo').textContent = n + ' samples' + (dur > 1 ? ', about ' + Math.round((n - 1) / dur) + ' Hz' : '') + '. ' + st.lockNote;
    };
    tick();
    st.timers.push(setInterval(tick, 250));
  }

  /* The Screen Wake Lock keeps the screen from timing out (it can't stop a lock by hand). The
     browser can drop it, e.g. in battery saver: then ask again while the page is visible, a few
     times at most, and otherwise say the screen may turn off. */
  async function keepAwake() {
    if (!st || st.phase !== 'recording') return;
    let lock;
    try {
      if (!navigator.wakeLock) return;
      lock = await navigator.wakeLock.request('screen');
    } catch (e) { if (st) st.lockNote = st.relocks ? LOCK_LOST : LOCK_OFF; return; }
    if (!st || st.phase !== 'recording') { lock.release().catch(() => {}); return; }
    st.lock = lock; st.lockNote = LOCK_ON;
    lock.addEventListener('release', () => {
      if (!st || st.lock !== lock) return; // released by us (cleanup)
      st.lock = null;
      if (st.phase !== 'recording' || document.hidden) return;
      if (st.relocks++ < RELOCKS) keepAwake(); else st.lockNote = LOCK_LOST;
    });
  }

  function onMotion(e) {
    if (!st) return;
    const g = e.accelerationIncludingGravity;
    if (!g || g.x === null || g.x === undefined) return; // desktops may send empty events
    st.gotData = true;
    if (st.phase !== 'recording') return;
    const a = e.acceleration, r = e.rotationRate;
    st.samples.push({ ts: e.timeStamp, g: [g.x, g.y, g.z],
      a: a && a.x !== null && a.x !== undefined ? [a.x, a.y, a.z] : null,
      r: r && r.alpha !== null && r.alpha !== undefined ? [r.alpha, r.beta, r.gamma] : null });
    if ((e.timeStamp - st.samples[0].ts) / 1000 >= MAX_S) stop('limit');
  }
  // the phone stops sending motion data when the screen locks or the page is hidden
  function onVisibility() {
    if (!st || !document.hidden) return;
    if (st.phase === 'recording') stop('hidden');
    else if (st.phase === 'countdown') { cleanup(); st = null; close(); }
  }

  /* pressAt: how many samples had arrived when the finger came down on Stop, when a hold
     stopped the recording. Reaching for the button and pressing it move the phone, and a
     detector can count that as a step (the owner's first recordings, 2026-10-07: a bump about
     0.2 s before the touch and during it). So the samples from PRESS_MARGIN_MS before the
     touch onwards are left out. */
  function stop(reason, pressAt) {
    if (!st || st.phase !== 'recording') return;
    cleanup();
    st.phase = 'done'; st.reason = reason; st.trimmed = 0;
    if (pressAt !== undefined && st.samples.length) {
      const s = st.samples, end = pressAt > 0 ? s[pressAt - 1].ts - PRESS_MARGIN_MS : -Infinity;
      const kept = s.slice(0, pressAt).filter(x => x.ts <= end);
      st.trimmed = (s[s.length - 1].ts - (kept.length ? kept[kept.length - 1].ts : s[0].ts)) / 1000;
      st.samples = kept;
    }
    const rc = C.recordingChecks(st.samples, reason);
    if (!rc.ok) return fail(rc.checks[0].detail, rc.checks[0].fix);
    st.checks = rc.checks;
    const s = st.samples, dur = (s[s.length - 1].ts - s[0].ts) / 1000;
    st.rate = (s.length - 1) / dur;
    show('done', 'Recording finished', clock(dur), s.length + ' samples at about ' + Math.round(st.rate) + ' Hz.' +
      (reason === 'hidden' ? ' It stopped early because the screen locked or the page was hidden; what was captured is kept.' : '') +
      (st.trimmed ? ' The last ' + C.fmt(st.trimmed, 1) + ' s, from just before you touched Stop, was left out.' : ''));
    $('recSteps').value = ''; $('recPos').value = '';
  }

  function finish(e) {
    e.preventDefault();
    if (!st || st.phase !== 'done') return;
    const steps = $('recSteps').value.trim(), pos = $('recPos').value;
    const d = st.started;
    const meta = {
      recorder: 'gaitscope (browser devicemotion)', started: d.toISOString(), device: navigator.userAgent,
      sample_rate_hz: st.rate.toFixed(1), samples: st.samples.length, stopped: st.reason, trimmed_end_s: st.trimmed ? st.trimmed.toFixed(2) : '',
      steps_counted: /^\d+$/.test(steps) ? Number(steps) : '', phone_position: C.PHONE_POSITIONS[pos] || '',
    };
    const name = 'recording_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.csv';
    const done = st.onDone, checks = st.checks;
    const csv = C.recordingCsv(st.samples, meta);
    st = null; close();
    done({ csv, name, checks, position: pos });
  }

  // Hold to stop: a pocket can tap, but rarely holds still on one spot for a second. Only a
  // hold that stops the recording cuts the touch out of it; a touch let go early cuts nothing.
  function wireStop() {
    const b = $('recStop');
    let timer = 0;
    const release = () => { clearTimeout(timer); b.classList.remove('holding'); };
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); b.classList.add('holding');
      const pressAt = st ? st.samples.length : 0;
      timer = setTimeout(() => { release(); stop('user', pressAt); }, HOLD_MS);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, release);
    b.addEventListener('contextmenu', e => e.preventDefault()); // long-press menu on phones
    b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stop('user'); } });
  }

  function init(onDone) {
    const ok = available();
    const cd = $('recCount');
    try { const v = window.localStorage.getItem(COUNTDOWN_KEY); if (COUNTDOWNS.includes(v)) cd.value = v; } catch (e) { /* the default */ }
    cd.addEventListener('change', () => { try { window.localStorage.setItem(COUNTDOWN_KEY, cd.value); } catch (e) { /* not remembered, still used */ } });
    $('recCountRow').hidden = !ok;
    for (const id of ['recBtn', 'emptyRec']) {
      $(id).hidden = !ok;
      $(id).addEventListener('click', () => start(onDone));
    }
    $('recHint').hidden = ok;
    wireStop();
    $('recBox').addEventListener('click', () => { if (st && st.phase === 'countdown') begin(); }); // tap to start now
    $('recForm').addEventListener('submit', finish);
    $('recDiscard').addEventListener('click', () => { cleanup(); st = null; close(); });
    $('recClose').addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && st && st.phase === 'countdown') { cleanup(); st = null; close(); } });
  }

  window.StepRecorder = { init, available };
})();
