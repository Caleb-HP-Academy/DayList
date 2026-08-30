/* global daylist */
// Shared timer UI. initTimerUI(rootEl, { isPopout }) wires a timer widget that
// reads/controls the main-process clock via the daylist bridge.
'use strict';
(function () {
  function fmt(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(s / 60);
    const ss = s % 60;
    return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  // Web Audio chimes (no files needed)
  let ac = null;
  function ctx() {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function beep(freq, durMs, type, gain, whenS) {
    const c = ctx();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(c.destination);
    const t0 = c.currentTime + (whenS || 0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    o.start(t0); o.stop(t0 + durMs / 1000 + 0.02);
  }
  function chime(finishedPhase) {
    if (finishedPhase === 'work') {
      // work finished → calming descending tones (go rest)
      beep(680, 260, 'sine', 0.26, 0);
      beep(540, 340, 'sine', 0.26, 0.24);
      beep(440, 420, 'sine', 0.24, 0.5);
    } else {
      // rest finished → energetic ascending (back to work)
      beep(600, 150, 'triangle', 0.28, 0);
      beep(800, 150, 'triangle', 0.28, 0.16);
      beep(1000, 160, 'triangle', 0.28, 0.32);
      beep(1250, 260, 'triangle', 0.3, 0.48);
    }
  }

  function initTimerUI(root, opts) {
    opts = opts || {};
    const q = (s) => root.querySelector(s);
    const phaseEl = q('.timer-phase');
    const timeEl = q('.timer-time');
    const startBtn = q('[data-tcmd="toggle"]');
    const taskEl = q('.timer-task');

    function apply(s) {
      if (!s) return;
      timeEl.textContent = fmt(s.remainingMs);
      phaseEl.textContent = s.phase === 'work' ? 'WORK' : 'REST';
      root.classList.toggle('phase-rest', s.phase === 'rest');
      root.classList.toggle('running', s.running);
      const full = s.phase === 'work' ? s.workMs : s.restMs;
      startBtn.textContent = s.running ? 'Pause' : (s.remainingMs > 0 && s.remainingMs < full ? 'Resume' : 'Start');
      if (taskEl) taskEl.textContent = s.taskTitle || '';
      const w = q('.ts-work'), r = q('.ts-rest'), rep = q('.ts-repeat'), snd = q('.ts-sound'), aot = q('.ts-aot');
      if (w && document.activeElement !== w) w.value = Math.round(s.workMs / 60000);
      if (r && document.activeElement !== r) r.value = Math.round(s.restMs / 60000);
      if (rep) rep.checked = !!s.autoRepeat;
      if (snd) snd.checked = !!s.sound;
      if (aot && s.popoutAlwaysOnTop !== undefined) aot.checked = !!s.popoutAlwaysOnTop;
    }

    // Phase-change alert: pulse the window + repeat the chime until acknowledged
    let alertPulseTimer = null, alertChimeTimer = null;
    const pulseEl = document.getElementById('alert-pulse');
    function startAlert(finishedPhase, sound, autoRepeat) {
      const incoming = finishedPhase === 'work' ? 'rest' : 'work';
      if (pulseEl) pulseEl.className = 'alert-pulse on ' + incoming;
      root.classList.add('alerting');
      if (sound) {
        chime(finishedPhase);
        let reps = autoRepeat ? 1 : 5; // manual mode keeps nudging you until you act
        clearInterval(alertChimeTimer);
        alertChimeTimer = setInterval(() => {
          if (reps <= 0) { clearInterval(alertChimeTimer); return; }
          chime(finishedPhase); reps--;
        }, 2500);
      }
      clearTimeout(alertPulseTimer);
      alertPulseTimer = setTimeout(clearAlert, autoRepeat ? 4000 : 30000);
    }
    function clearAlert() {
      if (pulseEl) pulseEl.className = 'alert-pulse';
      root.classList.remove('alerting');
      clearTimeout(alertPulseTimer); clearInterval(alertChimeTimer);
      alertPulseTimer = alertChimeTimer = null;
    }

    daylist.timerGet().then(apply);
    daylist.onTimerUpdate(apply);
    daylist.onTimerAlert((p) => { if (p) startAlert(p.phase, p.sound, p.autoRepeat); });

    root.querySelectorAll('[data-tcmd]').forEach((b) => {
      b.addEventListener('click', () => {
        const cmd = b.dataset.tcmd;
        clearAlert(); // any control press acknowledges the alert
        if (cmd === 'popout') daylist.timerPopout();
        else if (cmd === 'settings') q('.timer-settings').classList.toggle('hidden');
        else daylist.timerAction(cmd);
      });
    });

    const push = () => daylist.timerSet({
      workMinutes: parseInt(q('.ts-work').value, 10) || undefined,
      restMinutes: parseInt(q('.ts-rest').value, 10) || undefined,
      autoRepeat: q('.ts-repeat').checked,
      sound: q('.ts-sound').checked
    });
    ['.ts-work', '.ts-rest', '.ts-repeat', '.ts-sound'].forEach((sel) => {
      const el = q(sel);
      if (el) el.addEventListener('change', push);
    });
    const aot = q('.ts-aot');
    if (aot) aot.addEventListener('change', () => daylist.timerPopoutAOT(aot.checked));

    // popout-only vs inline differences
    const aotRow = q('.ts-aot-row');
    const popBtn = q('[data-tcmd="popout"]');
    if (opts.isPopout) {
      if (popBtn) popBtn.style.display = 'none';
      if (aotRow) aotRow.classList.remove('hidden');
    } else {
      if (aotRow) aotRow.classList.add('hidden');
    }
  }

  window.initTimerUI = initTimerUI;
})();
