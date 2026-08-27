const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Data locations
//  - tasks.json          → the MAIN store (Claude reads/edits this one)
//  - projects.json       → index of projects [{id,name,createdAt}]
//  - projects/<id>.json  → one store per project (same schema as tasks.json)
//  - config.json         → per-window settings (bounds/alwaysOnTop/opacity)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(os.homedir(), 'Desktop', 'DayList');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const PROJECTS_INDEX = path.join(DATA_DIR, 'projects.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// storeId 'main' or a project id → { window, watcher, ignoreUntil }
const stores = new Map();

let tray = null;
let reminderTimer = null;
let isQuitting = false;

const mainWin = () => (stores.get('main') ? stores.get('main').window : null);

// ---------------------------------------------------------------------------
// Basic helpers
// ---------------------------------------------------------------------------
function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error(e); }
  try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch (e) { console.error(e); }
}
function cryptoId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
function projId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function storeFile(storeId) {
  return storeId === 'main' ? TASKS_FILE : path.join(PROJECTS_DIR, storeId + '.json');
}

// ---------------------------------------------------------------------------
// Store data (per storeId)
// ---------------------------------------------------------------------------
function defaultData(isMain) {
  const base = { tasks: [], archive: [], recurring: [], meta: { lastOpened: todayStr() } };
  if (isMain) {
    base.tasks = [
      mkTask('Welcome to DayList — double-click me to edit', 'high'),
      mkTask('Drag tasks to reorder or change priority', 'medium'),
      mkTask('Ask Claude to add or update items in tasks.json', 'low')
    ];
  }
  return base;
}
function mkTask(title, priority) {
  return normalizeTask({ title, priority });
}
function normalizeTask(t) {
  const valid = ['high', 'medium', 'low'];
  return {
    id: t.id || cryptoId(),
    title: typeof t.title === 'string' ? t.title : String(t.title || ''),
    priority: valid.includes(t.priority) ? t.priority : 'medium',
    done: !!t.done,
    current: !!t.current,
    reminder: t.reminder || null,
    reminderFired: !!t.reminderFired,
    notes: typeof t.notes === 'string' ? t.notes : '',
    createdAt: t.createdAt || new Date().toISOString(),
    completedAt: t.completedAt || null,
    archivedAt: t.archivedAt || null
  };
}
function normalizeRecurring(r) {
  const validFreq = ['daily', 'weekdays', 'weekly'];
  return {
    id: r.id || ('r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)),
    title: typeof r.title === 'string' ? r.title : String(r.title || ''),
    priority: ['high', 'medium', 'low'].includes(r.priority) ? r.priority : 'medium',
    notes: typeof r.notes === 'string' ? r.notes : '',
    freq: validFreq.includes(r.freq) ? r.freq : 'daily',
    days: Array.isArray(r.days) ? r.days.filter((n) => n >= 0 && n <= 6) : [], // for weekly: 0=Sun..6=Sat
    reminderTime: typeof r.reminderTime === 'string' ? r.reminderTime : '', // "HH:MM" or ''
    lastAdded: r.lastAdded || null
  };
}

// "HH:MM" -> ISO datetime today at that time (or null)
function timeToTodayISO(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function readData(storeId) {
  const file = storeFile(storeId);
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data.tasks)) data.tasks = [];
    if (!Array.isArray(data.archive)) data.archive = [];
    if (!Array.isArray(data.recurring)) data.recurring = [];
    data.tasks = data.tasks.map(normalizeTask);
    data.archive = data.archive.map(normalizeTask);
    data.recurring = data.recurring.map(normalizeRecurring);
    if (!data.meta) data.meta = { lastOpened: todayStr() };
    return data;
  } catch (e) {
    const d = defaultData(storeId === 'main');
    writeData(storeId, d);
    return d;
  }
}

function writeData(storeId, data) {
  ensureDataDir();
  const s = stores.get(storeId);
  if (s) s.ignoreUntil = Date.now() + 800; // suppress our own change event
  const file = storeFile(storeId);
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('Failed to write store', storeId, e);
  }
}

// ---------------------------------------------------------------------------
// Recurring tasks — auto-add instances for templates due today
// ---------------------------------------------------------------------------
function applyRecurring(storeId) {
  const data = readData(storeId);
  if (!data.recurring || !data.recurring.length) return false;
  const today = todayStr();
  const dow = new Date().getDay(); // 0=Sun..6=Sat
  let added = false;

  for (const r of data.recurring) {
    if (r.lastAdded === today) continue;
    let due = false;
    if (r.freq === 'daily') due = true;
    else if (r.freq === 'weekdays') due = dow >= 1 && dow <= 5;
    else if (r.freq === 'weekly') due = r.days.includes(dow);
    if (!due) continue;

    const reminder = timeToTodayISO(r.reminderTime);
    data.tasks.push(normalizeTask({
      title: r.title, priority: r.priority, notes: r.notes,
      reminder,
      // if the scheduled time already passed today, don't fire late
      reminderFired: reminder ? new Date(reminder).getTime() < Date.now() : false,
      createdAt: new Date().toISOString()
    }));
    r.lastAdded = today;
    added = true;
  }
  if (added) writeData(storeId, data);
  return added;
}

// ---------------------------------------------------------------------------
// Config (per window)
// ---------------------------------------------------------------------------
function readConfig() {
  const defaults = { main: {}, projects: {}, runOnStartup: false };
  try {
    const cfg = Object.assign(defaults, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    if (!cfg.projects) cfg.projects = {};
    if (!cfg.main) cfg.main = {};
    return cfg;
  } catch (e) {
    return defaults;
  }
}
function writeConfig(cfg) {
  ensureDataDir();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) { console.error(e); }
}
function storeConfig(storeId) {
  const cfg = readConfig();
  const bucket = storeId === 'main' ? cfg.main : (cfg.projects[storeId] || {});
  return {
    bounds: bucket.bounds || { width: storeId === 'main' ? 340 : 320, height: storeId === 'main' ? 600 : 520 },
    alwaysOnTop: bucket.alwaysOnTop !== undefined ? bucket.alwaysOnTop : true,
    opacity: bucket.opacity || 1
  };
}
function setStoreConfig(storeId, patch) {
  const cfg = readConfig();
  const bucket = storeId === 'main' ? (cfg.main || {}) : (cfg.projects[storeId] || {});
  Object.assign(bucket, patch);
  if (storeId === 'main') cfg.main = bucket; else cfg.projects[storeId] = bucket;
  writeConfig(cfg);
}

// ---------------------------------------------------------------------------
// Projects index
// ---------------------------------------------------------------------------
function readProjects() {
  try {
    const d = JSON.parse(fs.readFileSync(PROJECTS_INDEX, 'utf8'));
    return Array.isArray(d.projects) ? d.projects : [];
  } catch (e) {
    return [];
  }
}
function writeProjects(list) {
  ensureDataDir();
  try { fs.writeFileSync(PROJECTS_INDEX, JSON.stringify({ projects: list }, null, 2), 'utf8'); } catch (e) { console.error(e); }
}
function projectsWithCounts() {
  return readProjects().map((p) => {
    let active = 0;
    try {
      const d = readData(p.id);
      active = d.tasks.filter((t) => !t.done).length;
    } catch (e) {}
    return { ...p, active };
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createWindow(storeId, name, mode) {
  const cfg = storeConfig(storeId);
  const win = new BrowserWindow({
    width: cfg.bounds.width,
    height: cfg.bounds.height,
    x: cfg.bounds.x,
    y: cfg.bounds.y,
    minWidth: 280,
    minHeight: 360,
    frame: false,
    backgroundColor: '#1a1b1e',
    alwaysOnTop: cfg.alwaysOnTop,
    resizable: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [
        '--daylist-store=' + storeId,
        '--daylist-mode=' + mode,
        '--daylist-name=' + encodeURIComponent(name || 'DayList')
      ]
    }
  });

  stores.set(storeId, { window: win, watcher: null, ignoreUntil: 0 });

  win.setOpacity(cfg.opacity);
  if (cfg.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');

  applyRecurring(storeId);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (win.isDestroyed()) return;
    setStoreConfig(storeId, { bounds: win.getBounds() });
  };
  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  win.on('close', (e) => {
    if (storeId === 'main' && !isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    const s = stores.get(storeId);
    if (s && s.watcher) { try { s.watcher.close(); } catch (e) {} }
    stores.delete(storeId);
  });

  startWatching(storeId);
  return win;
}

function openProjectWindow(id) {
  const existing = stores.get(id);
  if (existing && existing.window && !existing.window.isDestroyed()) {
    existing.window.show();
    existing.window.focus();
    return;
  }
  const proj = readProjects().find((p) => p.id === id);
  if (!proj) return;
  createWindow(id, proj.name, 'project');
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function makeTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  if (fs.existsSync(iconPath)) {
    const img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) return img;
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAT0lEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFAAAoAAB/6q0mQAAAABJRU5ErkJggg==',
    'base64'
  );
  return nativeImage.createFromBuffer(png);
}
function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip('DayList');
  rebuildTrayMenu();
  tray.on('click', () => toggleMain());
}
function rebuildTrayMenu() {
  const projects = readProjects();
  const projItems = projects.length
    ? projects.map((p) => ({ label: '📁 ' + p.name, click: () => openProjectWindow(p.id) }))
    : [{ label: '(no projects yet)', enabled: false }];
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide DayList', click: () => toggleMain() },
    { type: 'separator' },
    { label: 'Projects', submenu: projItems },
    { type: 'separator' },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: storeConfig('main').alwaysOnTop,
      click: (item) => setAlwaysOnTop('main', item.checked)
    },
    {
      label: 'Run on startup',
      type: 'checkbox',
      checked: getStartupEnabled(),
      click: (item) => setStartup(item.checked)
    },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.showItemInFolder(TASKS_FILE) },
    { label: 'Quit DayList', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}
function toggleMain() {
  const w = mainWin();
  if (!w) { createWindow('main', 'DayList', 'main'); return; }
  if (w.isVisible() && !w.isMinimized()) w.hide();
  else { w.show(); w.focus(); }
}

// ---------------------------------------------------------------------------
// Per-window settings actions
// ---------------------------------------------------------------------------
function winOf(storeId) {
  const s = stores.get(storeId);
  return s && s.window && !s.window.isDestroyed() ? s.window : null;
}
function setAlwaysOnTop(storeId, on) {
  setStoreConfig(storeId, { alwaysOnTop: on });
  const w = winOf(storeId);
  if (w) w.setAlwaysOnTop(on, 'screen-saver');
  if (storeId === 'main') rebuildTrayMenu();
  if (w) w.webContents.send('settings-updated', publicSettings(storeId));
}
function setOpacity(storeId, value) {
  const v = Math.max(0.3, Math.min(1, value));
  setStoreConfig(storeId, { opacity: v });
  const w = winOf(storeId);
  if (w) w.setOpacity(v);
}
function getStartupEnabled() {
  try { return app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
}
function setStartup(on) {
  try { app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: [] }); } catch (e) { console.error(e); }
  const cfg = readConfig(); cfg.runOnStartup = on; writeConfig(cfg);
  rebuildTrayMenu();
  const w = mainWin();
  if (w) w.webContents.send('settings-updated', publicSettings('main'));
}
function publicSettings(storeId) {
  const c = storeConfig(storeId);
  return { alwaysOnTop: c.alwaysOnTop, opacity: c.opacity, runOnStartup: getStartupEnabled() };
}

// ---------------------------------------------------------------------------
// File watching per store
// ---------------------------------------------------------------------------
function startWatching(storeId) {
  ensureDataDir();
  const file = storeFile(storeId);
  if (!fs.existsSync(file)) writeData(storeId, defaultData(storeId === 'main'));
  const s = stores.get(storeId);
  if (!s) return;
  try {
    if (s.watcher) s.watcher.close();
    let t = null;
    s.watcher = fs.watch(file, { persistent: true }, () => {
      if (Date.now() < s.ignoreUntil) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const w = winOf(storeId);
        if (w) w.webContents.send('tasks-updated', readData(storeId));
        checkReminders();
      }, 250);
    });
  } catch (e) {
    console.error('watch failed', storeId, e);
  }
}

// ---------------------------------------------------------------------------
// Reminders — scan the main store + every project store
// ---------------------------------------------------------------------------
function allStoreIds() {
  return ['main', ...readProjects().map((p) => p.id)];
}
function checkReminders() {
  const now = Date.now();
  for (const storeId of allStoreIds()) {
    let data;
    try { data = readData(storeId); } catch (e) { continue; }
    let changed = false;
    for (const t of data.tasks) {
      if (t.done || t.reminderFired || !t.reminder) continue;
      const due = new Date(t.reminder).getTime();
      if (!isNaN(due) && due <= now) {
        fireReminder(storeId, t);
        t.reminderFired = true;
        changed = true;
      }
    }
    if (changed) {
      writeData(storeId, data);
      const w = winOf(storeId);
      if (w) w.webContents.send('tasks-updated', data);
    }
  }
}
function showAndFocus(storeId) {
  const w = winOf(storeId) || mainWin();
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}
function fireReminder(storeId, task) {
  const priority = ['high', 'medium', 'low'].includes(task.priority) ? task.priority : 'medium';
  const proj = storeId === 'main' ? null : (readProjects().find((p) => p.id === storeId) || {}).name;

  if (Notification.isSupported()) {
    const n = new Notification({
      title: (priority === 'high' ? '⚠ DayList — URGENT' : 'DayList reminder') + (proj ? ` · ${proj}` : ''),
      body: task.title,
      silent: priority === 'low',
      urgency: priority === 'high' ? 'critical' : 'normal'
    });
    n.on('click', () => showAndFocus(storeId));
    n.show();
  }

  const w = winOf(storeId);
  if (w) {
    if (priority === 'high') {
      showAndFocus(storeId);
      try { w.flashFrame(true); } catch (e) {}
    }
    w.webContents.send('reminder-fired', { id: task.id, title: task.title, priority });
  }
}

// ---------------------------------------------------------------------------
// Work / Rest timer (Pomodoro-style) — the clock lives here so the inline
// timer and the pop-out window stay in sync and notifications fire regardless.
// ---------------------------------------------------------------------------
let timer = null;
let timerTick = null;

function defaultTimer() {
  const c = readConfig().timer || {};
  const workMs = (c.workMinutes || 60) * 60000;
  return {
    phase: 'work', running: false,
    remainingMs: workMs, endsAt: null,
    workMs, restMs: (c.restMinutes || 10) * 60000,
    autoRepeat: !!c.autoRepeat,
    sound: c.sound !== false,
    taskTitle: ''
  };
}
function timerSnapshot() {
  const rem = timer.running && timer.endsAt ? Math.max(0, timer.endsAt - Date.now()) : timer.remainingMs;
  return {
    phase: timer.phase, running: timer.running, remainingMs: rem,
    workMs: timer.workMs, restMs: timer.restMs,
    autoRepeat: timer.autoRepeat, sound: timer.sound, taskTitle: timer.taskTitle
  };
}
function broadcastTimer() {
  const snap = timerSnapshot();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('timer-updated', snap);
  }
}
function currentTaskTitle() {
  for (const id of allStoreIds()) {
    try {
      const d = readData(id);
      const t = d.tasks.find((x) => x.current && !x.done);
      if (t) return t.title;
    } catch (e) {}
  }
  return '';
}
function startTimerTick() {
  if (timerTick) return;
  timerTick = setInterval(() => {
    if (timer.running && timer.endsAt) {
      if (Date.now() >= timer.endsAt) handlePhaseEnd();
      else broadcastTimer();
    }
  }, 500);
}
function handlePhaseEnd() {
  const finished = timer.phase;
  notifyPhaseEnd(finished);
  const next = finished === 'work' ? 'rest' : 'work';
  timer.phase = next;
  timer.remainingMs = next === 'work' ? timer.workMs : timer.restMs;
  if (timer.autoRepeat) {
    timer.running = true;
    timer.endsAt = Date.now() + timer.remainingMs;
  } else {
    timer.running = false;
    timer.endsAt = null;
  }
  broadcastTimer();
}
let lastNotification = null; // keep a reference so the toast isn't garbage-collected early
function notifyPhaseEnd(finished) {
  if (Notification.isSupported()) {
    lastNotification = new Notification({
      title: finished === 'work' ? '⏱ Work done — time to REST' : '⏱ Rest over — back to WORK',
      body: finished === 'work' ? 'Take your break 🧘' : "Break's over — let's go 💪",
      silent: !timer.sound,
      urgency: 'critical',
      timeoutType: 'never' // ask Windows to keep it up (best effort)
    });
    lastNotification.show();
  }
  // For the "act now" moment (manual mode), surface a timer window so the pulse is seen.
  if (!timer.autoRepeat) {
    const pop = stores.get('timer');
    if (pop && pop.window && !pop.window.isDestroyed()) pop.window.show();
    else { const w = mainWin(); if (w) w.show(); }
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    w.webContents.send('timer-alert', { phase: finished, sound: timer.sound, autoRepeat: timer.autoRepeat });
    try { w.flashFrame(true); } catch (e) {}
  }
}
function timerToggle() {
  if (timer.running) {
    timer.remainingMs = Math.max(0, timer.endsAt - Date.now());
    timer.running = false; timer.endsAt = null;
  } else {
    if (timer.remainingMs <= 0) timer.remainingMs = timer.phase === 'work' ? timer.workMs : timer.restMs;
    timer.taskTitle = currentTaskTitle();
    timer.running = true; timer.endsAt = Date.now() + timer.remainingMs;
  }
  broadcastTimer();
}
function timerReset() {
  timer.running = false; timer.endsAt = null;
  timer.remainingMs = timer.phase === 'work' ? timer.workMs : timer.restMs;
  broadcastTimer();
}
function timerSkip() {
  const next = timer.phase === 'work' ? 'rest' : 'work';
  timer.phase = next; timer.running = false; timer.endsAt = null;
  timer.remainingMs = next === 'work' ? timer.workMs : timer.restMs;
  broadcastTimer();
}
function timerCancel() {
  timer.phase = 'work'; timer.running = false; timer.endsAt = null;
  timer.remainingMs = timer.workMs;
  broadcastTimer();
}
function timerSet(s) {
  const c = readConfig(); c.timer = c.timer || {};
  if (s.workMinutes) { timer.workMs = Math.max(1, Math.min(300, s.workMinutes)) * 60000; c.timer.workMinutes = s.workMinutes; }
  if (s.restMinutes) { timer.restMs = Math.max(1, Math.min(180, s.restMinutes)) * 60000; c.timer.restMinutes = s.restMinutes; }
  if (s.autoRepeat !== undefined) { timer.autoRepeat = !!s.autoRepeat; c.timer.autoRepeat = !!s.autoRepeat; }
  if (s.sound !== undefined) { timer.sound = !!s.sound; c.timer.sound = !!s.sound; }
  writeConfig(c);
  if (!timer.running) timer.remainingMs = timer.phase === 'work' ? timer.workMs : timer.restMs;
  broadcastTimer();
}
function openTimerPopout() {
  const s = stores.get('timer');
  if (s && s.window && !s.window.isDestroyed()) { s.window.show(); s.window.focus(); return; }
  const c = readConfig().timer || {};
  const b = c.popoutBounds || {};
  const aot = c.popoutAlwaysOnTop !== false;
  const win = new BrowserWindow({
    width: b.width || 250, height: b.height || 210, x: b.x, y: b.y,
    minWidth: 190, minHeight: 170, frame: false, backgroundColor: '#1a1b1e',
    alwaysOnTop: aot, resizable: true, show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: ['--daylist-store=timer', '--daylist-mode=timer', '--daylist-name=' + encodeURIComponent('Timer')]
    }
  });
  stores.set('timer', { window: win, watcher: null, ignoreUntil: 0 });
  if (aot) win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'src', 'timer.html'));
  win.once('ready-to-show', () => win.show());
  const saveB = () => { if (win.isDestroyed()) return; const cc = readConfig(); cc.timer = cc.timer || {}; cc.timer.popoutBounds = win.getBounds(); writeConfig(cc); };
  win.on('moved', saveB);
  win.on('resized', saveB);
  win.on('closed', () => stores.delete('timer'));
}
function timerPopoutAOT(on) {
  const c = readConfig(); c.timer = c.timer || {}; c.timer.popoutAlwaysOnTop = on; writeConfig(c);
  const s = stores.get('timer');
  if (s && s.window && !s.window.isDestroyed()) s.window.setAlwaysOnTop(on, 'screen-saver');
}
function timerPopoutAOTState() { return readConfig().timer && readConfig().timer.popoutAlwaysOnTop !== false; }

ipcMain.handle('timer-get', () => ({ ...timerSnapshot(), popoutAlwaysOnTop: timerPopoutAOTState() }));
ipcMain.handle('timer-action', (_e, action) => {
  if (action === 'toggle') timerToggle();
  else if (action === 'reset') timerReset();
  else if (action === 'skip') timerSkip();
  else if (action === 'cancel') timerCancel();
  return timerSnapshot();
});
ipcMain.handle('timer-set', (_e, s) => { timerSet(s || {}); return timerSnapshot(); });
ipcMain.handle('timer-popout', () => { openTimerPopout(); return true; });
ipcMain.handle('timer-popout-aot', (_e, on) => { timerPopoutAOT(on); return true; });

// ---------------------------------------------------------------------------
// IPC — task stores (storeId is passed by the preload of each window)
// ---------------------------------------------------------------------------
ipcMain.handle('get-tasks', (_e, storeId) => { applyRecurring(storeId || 'main'); return readData(storeId || 'main'); });
ipcMain.handle('save-tasks', (_e, storeId, data) => {
  storeId = storeId || 'main';
  if (data && Array.isArray(data.tasks)) {
    data.tasks = data.tasks.map(normalizeTask);
    if (!Array.isArray(data.archive)) data.archive = [];
    data.archive = data.archive.map(normalizeTask);
    if (!Array.isArray(data.recurring)) data.recurring = [];
    data.recurring = data.recurring.map(normalizeRecurring);
    if (!data.meta) data.meta = { lastOpened: todayStr() };
    writeData(storeId, data);
    checkReminders();
  }
  return true;
});
ipcMain.handle('get-settings', (_e, storeId) => publicSettings(storeId || 'main'));
ipcMain.handle('set-always-on-top', (_e, storeId, on) => { setAlwaysOnTop(storeId || 'main', on); return publicSettings(storeId || 'main'); });
ipcMain.handle('set-startup', (_e, on) => { setStartup(on); return publicSettings('main'); });
ipcMain.handle('set-opacity', (_e, storeId, v) => { setOpacity(storeId || 'main', v); return publicSettings(storeId || 'main'); });
ipcMain.handle('get-tasks-path', (_e, storeId) => storeFile(storeId || 'main'));
ipcMain.handle('open-data-folder', (_e, storeId) => { shell.showItemInFolder(storeFile(storeId || 'main')); });
ipcMain.handle('stop-flash', (_e, storeId) => { const w = winOf(storeId || 'main'); if (w) { try { w.flashFrame(false); } catch (e) {} } });
ipcMain.handle('copy-text', (_e, text) => { try { clipboard.writeText(String(text || '')); return true; } catch (e) { return false; } });

// Projects
ipcMain.handle('list-projects', () => projectsWithCounts());
ipcMain.handle('create-project', (_e, name) => {
  const clean = String(name || '').trim() || 'Untitled project';
  const id = projId();
  const list = readProjects();
  list.push({ id, name: clean, createdAt: new Date().toISOString() });
  writeProjects(list);
  writeData(id, defaultData(false));
  rebuildTrayMenu();
  openProjectWindow(id);
  return { id, name: clean };
});
ipcMain.handle('rename-project', (_e, id, name) => {
  const list = readProjects();
  const p = list.find((x) => x.id === id);
  if (p) { p.name = String(name || '').trim() || p.name; writeProjects(list); rebuildTrayMenu(); }
  const w = winOf(id);
  if (w) w.webContents.send('project-renamed', p ? p.name : '');
  return true;
});
ipcMain.handle('delete-project', (_e, id) => {
  const w = winOf(id);
  if (w) w.destroy();
  writeProjects(readProjects().filter((x) => x.id !== id));
  try { fs.unlinkSync(storeFile(id)); } catch (e) {}
  const cfg = readConfig();
  if (cfg.projects && cfg.projects[id]) { delete cfg.projects[id]; writeConfig(cfg); }
  rebuildTrayMenu();
  return true;
});
ipcMain.handle('open-project', (_e, id) => { openProjectWindow(id); return true; });

// App-level (main window only)
ipcMain.handle('connect-claude', async () => {
  const mcpb = app.isPackaged
    ? path.join(process.resourcesPath, 'DayList.mcpb')
    : path.join(__dirname, 'DayList.mcpb');
  if (!fs.existsSync(mcpb)) return { ok: false, msg: 'Connector file not found. Rebuild the app.' };
  shell.showItemInFolder(mcpb);
  let launched = false;
  try { await shell.openExternal('claude://'); launched = true; } catch (e) {}
  const detail =
    'A folder just opened with the DayList.mcpb file selected' +
    (launched ? ', and Claude Desktop is opening.' : '.') +
    '\n\nTo finish connecting:\n\n' +
    '1.  In Claude Desktop, open  Settings → Extensions.\n' +
    '2.  Drag  DayList.mcpb  from the folder onto that window\n' +
    '     (or click “Install Extension…” and pick the file).\n' +
    '3.  Click Install, and leave the tasks-file path as the default.\n\n' +
    'Then just ask Claude things like “what’s on my DayList today?”';
  const w = mainWin();
  if (w) {
    dialog.showMessageBox(w, {
      type: 'info', title: 'Connect DayList to Claude',
      message: 'Almost there — one quick drag', detail,
      buttons: ['Got it', 'Show the file again'], defaultId: 0, cancelId: 0, noLink: true
    }).then((res) => { if (res.response === 1) shell.showItemInFolder(mcpb); }).catch(() => {});
  }
  return { ok: true, msg: '' };
});
ipcMain.handle('ask-claude', (_e, payload) => {
  const title = (payload && payload.title) || '';
  const notes = (payload && payload.notes) || '';
  const prompt =
    `I'm working on this task from my DayList to-do app and need help.\n\n` +
    `Task: ${title}\n` + (notes ? `My notes: ${notes}\n` : '') +
    `\nPlease help me figure out how to get this done.`;
  try { clipboard.writeText(prompt); } catch (e) {}
  shell.openExternal('https://claude.ai/new?q=' + encodeURIComponent(prompt));
  return true;
});

ipcMain.on('window-minimize', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.hide(); });
ipcMain.on('window-close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  // main window hides to tray; project windows close
  const isMain = mainWin() && w.id === mainWin().id;
  if (isMain) w.hide(); else w.close();
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { const w = mainWin(); if (w) { w.show(); w.focus(); } });

  app.whenReady().then(() => {
    ensureDataDir();
    if (!fs.existsSync(TASKS_FILE)) writeData('main', defaultData(true));

    createWindow('main', 'DayList', 'main');
    createTray();

    timer = defaultTimer();
    startTimerTick();

    checkReminders();
    reminderTimer = setInterval(() => {
      // also refresh recurring across open windows around midnight rollover
      for (const id of allStoreIds()) if (winOf(id)) applyRecurring(id);
      checkReminders();
    }, 15000);

    app.on('activate', () => { if (!mainWin()) createWindow('main', 'DayList', 'main'); });
  });

  app.on('window-all-closed', () => { /* stay in tray */ });

  app.on('before-quit', () => {
    isQuitting = true;
    if (reminderTimer) clearInterval(reminderTimer);
    if (timerTick) clearInterval(timerTick);
    for (const s of stores.values()) if (s.watcher) { try { s.watcher.close(); } catch (e) {} }
  });
}
