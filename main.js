const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, shell, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');

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

// Local HTTP server that serves a compact read/complete widget view of the
// main list, for embedding via URL in things like a Hyte case screen iFrame.
const HYTE_DEFAULT_PORT = 57123;
let hyteServer = null;
let hytePort = null;

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
    claudeNotes: typeof t.claudeNotes === 'string' ? t.claudeNotes : '',
    personal: !!t.personal,
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
// Right-click context menu: spelling suggestions (when over a misspelled
// word) plus standard cut/copy/paste, for any editable field in a window.
function attachSpellcheckMenu(win) {
  win.webContents.on('context-menu', (_e, params) => {
    const template = [];
    if (params.isEditable) {
      if (params.misspelledWord) {
        if (params.dictionarySuggestions.length) {
          for (const s of params.dictionarySuggestions) {
            template.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
          }
        } else {
          template.push({ label: 'No spelling suggestions', enabled: false });
        }
        template.push({ type: 'separator' });
        template.push({
          label: 'Add to dictionary',
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        });
        template.push({ type: 'separator' });
      }
      template.push({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut });
      template.push({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy });
      template.push({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste });
    } else if (params.selectionText) {
      template.push({ label: 'Copy', role: 'copy' });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
}
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
  attachSpellcheckMenu(win);

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
    {
      label: hytePort ? `📺 Copy Hyte widget URL (:${hytePort})` : '📺 Hyte widget starting…',
      enabled: !!hytePort,
      click: () => { clipboard.writeText(`http://localhost:${hytePort}/`); }
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
  const cfg = readConfig();
  return {
    alwaysOnTop: c.alwaysOnTop, opacity: c.opacity, runOnStartup: getStartupEnabled(),
    showStandup: cfg.showStandup !== false,
    standupIncludeWeekends: cfg.standupIncludeWeekends !== false
  };
}
function setStandupEnabled(on) {
  const cfg = readConfig(); cfg.showStandup = !!on; writeConfig(cfg);
  const w = mainWin();
  if (w) w.webContents.send('settings-updated', publicSettings('main'));
}
function setStandupIncludeWeekends(on) {
  const cfg = readConfig(); cfg.standupIncludeWeekends = !!on; writeConfig(cfg);
  const w = mainWin();
  if (w) w.webContents.send('settings-updated', publicSettings('main'));
}

// ---------------------------------------------------------------------------
// Per-priority color + notification sound preferences — global (not per
// store), so every window (main + all projects) and the Hyte widget agree.
// ---------------------------------------------------------------------------
const DEFAULT_PRIORITY_PREFS = {
  high: { color: '#ff5c5c', sound: 'alert' },
  medium: { color: '#ffb020', sound: 'chime' },
  low: { color: '#4fc98a', sound: 'soft' }
};
function getPriorityPrefs() {
  const cfg = readConfig();
  const saved = cfg.priorityPrefs || {};
  const out = {};
  for (const p of ['high', 'medium', 'low']) {
    out[p] = { ...DEFAULT_PRIORITY_PREFS[p], ...(saved[p] || {}) };
  }
  return out;
}
function setPriorityPrefs(priority, patch) {
  if (!['high', 'medium', 'low'].includes(priority)) return getPriorityPrefs();
  const cfg = readConfig();
  cfg.priorityPrefs = cfg.priorityPrefs || {};
  cfg.priorityPrefs[priority] = { ...DEFAULT_PRIORITY_PREFS[priority], ...(cfg.priorityPrefs[priority] || {}), ...patch };
  writeConfig(cfg);
  const prefs = getPriorityPrefs();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('priority-prefs-updated', prefs);
  }
  return prefs;
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
// Hyte widget — small local HTTP server (main list only, localhost-only)
// ---------------------------------------------------------------------------
function hyteState() {
  const data = readData('main');
  const active = data.tasks.filter((t) => !t.done);
  const current = active.find((t) => t.current) || null;
  const order = { high: 0, medium: 1, low: 2 };
  const rest = active
    .filter((t) => !current || t.id !== current.id)
    .slice()
    .sort((a, b) => order[a.priority] - order[b.priority]);
  const hyte = getHyteSettings();
  const colors = getPriorityPrefs();
  return {
    current: current ? { id: current.id, title: current.title } : null,
    tasks: rest.slice(0, 8).map((t) => ({ id: t.id, title: t.title, priority: t.priority })),
    textScale: hyte.textScale,
    buttonScale: hyte.buttonScale,
    colors: { high: colors.high.color, medium: colors.medium.color, low: colors.low.color }
  };
}
function getHyteSettings() {
  const cfg = readConfig();
  return {
    url: hytePort ? `http://localhost:${hytePort}/` : null,
    textScale: typeof cfg.hyteTextScale === 'number' ? cfg.hyteTextScale : 1,
    buttonScale: typeof cfg.hyteButtonScale === 'number' ? cfg.hyteButtonScale : 1
  };
}
function setHyteSettings(patch) {
  const cfg = readConfig();
  if (patch && typeof patch.textScale === 'number') cfg.hyteTextScale = Math.max(0.6, Math.min(3, patch.textScale));
  if (patch && typeof patch.buttonScale === 'number') cfg.hyteButtonScale = Math.max(0.6, Math.min(2, patch.buttonScale));
  writeConfig(cfg);
  return getHyteSettings();
}
function completeMainTaskById(id) {
  const data = readData('main');
  const t = data.tasks.find((x) => x.id === id);
  if (!t) return false;
  t.done = true;
  t.completedAt = new Date().toISOString();
  t.current = false;
  writeData('main', data);
  const w = winOf('main');
  if (w) w.webContents.send('tasks-updated', readData('main'));
  checkReminders();
  return true;
}
function hyteHtmlPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DayList</title>
<style>
  :root{
    --bg-elev:rgba(35,36,40,.55);--bg-elev2:rgba(43,44,49,.55);--border:rgba(255,255,255,.16);
    --text:#f2f3f5;--text-dim:#c2c3c8;--text-faint:#9a9ba1;
    --high:#ff5c5c;--medium:#ffb020;--low:#4fc98a;--current:#35d07f;
    --text-scale:1;--btn-scale:1;
  }
  *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
  html,body{height:100%;background:transparent;color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;overflow:hidden;}
  body{display:flex;flex-direction:column;padding:clamp(6px,2vw,12px);gap:clamp(8px,2vw,12px);touch-action:manipulation;}
  .hdr{font-size:calc(clamp(12px,3.8vw,16px) * var(--text-scale));letter-spacing:1.5px;text-transform:uppercase;color:var(--text-faint);font-weight:700;flex:none;text-shadow:0 1px 3px rgba(0,0,0,.6);}
  .reconn{color:var(--medium);}
  .reconn.hidden{display:none;}
  .focus-card{
    flex:none;background:linear-gradient(135deg,var(--bg-elev),var(--bg-elev2));
    border:1px solid var(--current);border-radius:14px;padding:clamp(12px,4vw,20px);
    display:flex;align-items:center;gap:clamp(10px,3vw,16px);transition:opacity .2s ease,background .1s ease;
    box-shadow:0 2px 10px rgba(0,0,0,.35);cursor:pointer;touch-action:manipulation;
  }
  .focus-card.empty{border-color:var(--border);opacity:.7;cursor:default;}
  .focus-card.completing{opacity:0;}
  .focus-card:active{background:linear-gradient(135deg,var(--bg-elev2),var(--bg-elev2));}
  .check{
    flex:none;width:calc(clamp(48px,16vw,72px) * var(--btn-scale));height:calc(clamp(48px,16vw,72px) * var(--btn-scale));border-radius:50%;
    border:calc(5px * var(--btn-scale)) solid var(--current);pointer-events:none;
  }
  .check.high{border-color:var(--high);} .check.medium{border-color:var(--medium);} .check.low{border-color:var(--low);}
  .focus-label{font-size:calc(clamp(12px,3.5vw,15px) * var(--text-scale));color:var(--current);text-transform:uppercase;letter-spacing:1px;font-weight:700;}
  .focus-title{font-size:calc(clamp(22px,8vw,34px) * var(--text-scale));font-weight:600;line-height:1.3;overflow-wrap:anywhere;text-shadow:0 1px 3px rgba(0,0,0,.6);}
  .empty-msg{font-size:calc(clamp(16px,4.5vw,20px) * var(--text-scale));color:var(--text-dim);font-style:italic;}
  .list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:clamp(8px,2vw,12px);}
  .row{
    display:flex;align-items:center;gap:clamp(10px,3vw,16px);
    background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;
    padding:clamp(12px,4vw,18px);transition:opacity .2s ease,background .1s ease;box-shadow:0 1px 6px rgba(0,0,0,.3);
    cursor:pointer;touch-action:manipulation;min-height:calc(clamp(56px,17vw,80px) * var(--btn-scale));
  }
  .row:active{background:var(--bg-elev2);}
  .row.completing{opacity:0;}
  .row .title{flex:1;font-size:calc(clamp(18px,7vw,28px) * var(--text-scale));line-height:1.35;overflow-wrap:anywhere;text-shadow:0 1px 3px rgba(0,0,0,.6);}
  .list::-webkit-scrollbar{width:4px;}
  .list::-webkit-scrollbar-thumb{background:var(--bg-elev2);border-radius:3px;}
  .all-done{flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-dim);font-size:calc(clamp(18px,5vw,22px) * var(--text-scale));text-align:center;}
</style>
</head>
<body>
  <div class="hdr">DayList <span id="reconn" class="reconn hidden">— reconnecting…</span></div>
  <div id="focus"></div>
  <div id="list" class="list"></div>
  <script>
  function el(tag, cls){ var e=document.createElement(tag); if(cls) e.className=cls; return e; }
  function complete(id, cardEl){
    if(cardEl.dataset.busy) return;
    cardEl.dataset.busy = '1';
    cardEl.classList.add('completing');
    function revert(){ cardEl.classList.remove('completing'); delete cardEl.dataset.busy; }
    fetch('/api/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
      .then(function(r){ return r.json().catch(function(){ return {ok:false}; }); })
      .then(function(res){ if(!res || !res.ok) revert(); load(); })
      .catch(function(){ revert(); load(); });
  }
  // The whole card/row is the tap target (not just the small circle) — much
  // more forgiving on a touchscreen. Bind both click and touchend defensively,
  // since some embedded webviews are inconsistent about synthesizing click
  // from a touch, and guard against a click firing right after a touchend.
  function bindTap(elm, handler){
    var lastTouch = 0;
    elm.addEventListener('touchend', function(e){ lastTouch = Date.now(); handler(); }, {passive:true});
    elm.addEventListener('click', function(){ if(Date.now() - lastTouch < 700) return; handler(); });
  }
  // Skip rebuilding the DOM when nothing actually changed, so a poll tick
  // landing mid-tap can't yank the element out from under an in-progress touch.
  var lastRenderKey = null;
  function render(d){
    var key = JSON.stringify(d);
    if(key === lastRenderKey) return;
    lastRenderKey = key;
    var focusWrap = document.getElementById('focus');
    focusWrap.innerHTML = '';
    if(d.current){
      var card = el('div','focus-card');
      var chk = el('div','check');
      var text = el('div');
      var lbl = el('div','focus-label'); lbl.textContent = 'Current Focus';
      var title = el('div','focus-title'); title.textContent = d.current.title;
      text.appendChild(lbl); text.appendChild(title);
      card.appendChild(chk); card.appendChild(text);
      bindTap(card, function(){ complete(d.current.id, card); });
      focusWrap.appendChild(card);
    } else {
      var card2 = el('div','focus-card empty');
      var msg = el('div','empty-msg'); msg.textContent = 'No current focus set';
      card2.appendChild(msg);
      focusWrap.appendChild(card2);
    }
    var list = document.getElementById('list');
    list.innerHTML = '';
    if(!d.tasks.length && !d.current){
      var done = el('div','all-done'); done.textContent = 'All caught up';
      list.appendChild(done);
      return;
    }
    d.tasks.forEach(function(t){
      var row = el('div','row');
      var chk = el('div','check ' + t.priority);
      var title = el('div','title'); title.textContent = t.title;
      row.appendChild(chk); row.appendChild(title);
      bindTap(row, function(){ complete(t.id, row); });
      list.appendChild(row);
    });
  }
  // If DayList itself gets closed and reopened, this page's fetches start
  // failing until the server comes back — track how long that's been going
  // on so the panel shows it's disconnected instead of silently freezing on
  // stale data, and force a full reload after a sustained outage in case the
  // connection got stuck in a bad state rather than just "server not up yet".
  var consecutiveFails = 0;
  function load(){
    fetch('/api/state').then(function(r){ return r.json(); }).then(function(d){
      consecutiveFails = 0;
      document.getElementById('reconn').classList.add('hidden');
      var root = document.documentElement.style;
      root.setProperty('--text-scale', d.textScale || 1);
      root.setProperty('--btn-scale', d.buttonScale || 1);
      if(d.colors){
        if(d.colors.high) root.setProperty('--high', d.colors.high);
        if(d.colors.medium) root.setProperty('--medium', d.colors.medium);
        if(d.colors.low) root.setProperty('--low', d.colors.low);
      }
      render(d);
    }).catch(function(){
      consecutiveFails++;
      if(consecutiveFails >= 2) document.getElementById('reconn').classList.remove('hidden');
      if(consecutiveFails >= 10) location.reload();
    });
  }
  load();
  setInterval(load, 3000);
  </script>
</body>
</html>`;
}
// Standalone diagnostic page — point the Hyte iFrame widget at /tap-test
// temporarily to check whether the panel forwards touch input into iframe
// content AT ALL, independent of anything DayList's own widget does.
function hyteTapTestPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tap test</title>
<style>
  html,body{height:100%;margin:0;background:#111;color:#fff;font-family:system-ui,sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;touch-action:manipulation;}
  #btn{width:80vw;height:40vh;max-width:400px;background:#35d07f;color:#111;font-size:8vw;font-weight:800;
    border-radius:20px;display:flex;align-items:center;justify-content:center;text-align:center;user-select:none;cursor:pointer;}
  #btn.hit{background:#ff5c5c;}
  #log{font-size:4vw;text-align:center;color:#9a9ba1;}
</style>
</head>
<body>
  <div id="btn">TAP ME<br>0</div>
  <div id="log">waiting for first tap…</div>
  <script>
  var n = 0;
  var btn = document.getElementById('btn');
  var log = document.getElementById('log');
  function hit(kind){
    n++;
    btn.innerHTML = 'TAP ME<br>' + n;
    btn.classList.add('hit');
    setTimeout(function(){ btn.classList.remove('hit'); }, 150);
    log.textContent = 'last event: ' + kind + ' (' + new Date().toLocaleTimeString() + ')';
  }
  btn.addEventListener('touchend', function(e){ hit('touchend'); }, {passive:true});
  btn.addEventListener('click', function(){ hit('click'); });
  </script>
</body>
</html>`;
}
function startHyteServer() {
  const cfg = readConfig();
  const desiredPort = cfg.hyteWidgetPort || HYTE_DEFAULT_PORT;
  const server = http.createServer((req, res) => {
    // Permissive CORS: the embedding app (e.g. Hyte Nexus) does a cross-origin
    // HEAD preflight against this URL to decide whether it's safe to iframe —
    // without this header that fetch() throws and gets treated as "blocked".
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      // CORS preflight — needed for the JSON POST from /api/complete when the
      // iframe's browsing context has an opaque origin (e.g. sandboxed without
      // allow-same-origin), which makes even a same-URL fetch look cross-origin.
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      });
      res.end();
      return;
    }
    const url = (req.url || '/').split('?')[0];
    const isRoot = url === '/' || url === '/index.html';
    if ((req.method === 'GET' || req.method === 'HEAD') && url === '/tap-test') {
      const html = hyteTapTestPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
    } else if ((req.method === 'GET' || req.method === 'HEAD') && isRoot) {
      const html = hyteHtmlPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
      res.end(req.method === 'HEAD' ? undefined : html);
    } else if ((req.method === 'GET' || req.method === 'HEAD') && url === '/api/state') {
      const json = JSON.stringify(hyteState());
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
      res.end(req.method === 'HEAD' ? undefined : json);
    } else if (req.method === 'POST' && url === '/api/complete') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        let id;
        try { id = JSON.parse(body || '{}').id; } catch (e) {}
        const done = id ? completeMainTaskById(id) : false;
        res.writeHead(done ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: done }));
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  const tryListen = (port, attemptsLeft) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && attemptsLeft > 0) tryListen(port + 1, attemptsLeft - 1);
      else console.error('[daylist] Hyte widget server failed to start:', e.message);
    });
    server.listen(port, '127.0.0.1', () => {
      hytePort = port;
      console.log('[daylist] Hyte widget available at http://localhost:' + port + '/');
      // Remember the port we actually landed on, so a future restart prefers
      // it over the default — keeps the widget URL stable across relaunches
      // instead of drifting if this run had to bump past a transient conflict.
      const c = readConfig();
      if (c.hyteWidgetPort !== port) { c.hyteWidgetPort = port; writeConfig(c); }
      rebuildTrayMenu();
    });
  };
  tryListen(desiredPort, 5);
  hyteServer = server;
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
ipcMain.handle('get-hyte-settings', () => getHyteSettings());
ipcMain.handle('set-hyte-settings', (_e, patch) => setHyteSettings(patch || {}));
ipcMain.handle('set-standup-enabled', (_e, on) => { setStandupEnabled(!!on); return publicSettings('main'); });
ipcMain.handle('set-standup-include-weekends', (_e, on) => { setStandupIncludeWeekends(!!on); return publicSettings('main'); });
ipcMain.handle('get-priority-prefs', () => getPriorityPrefs());
ipcMain.handle('set-priority-prefs', (_e, priority, patch) => setPriorityPrefs(priority, patch || {}));

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
// Generic: move a task from one store to another (main <-> project, or
// project <-> project). Used both by the project window's "Move to main
// list" and the main window's "Move to project".
ipcMain.handle('move-task-to-store', (_e, fromStoreId, taskId, toStoreId) => {
  if (!fromStoreId || !toStoreId || fromStoreId === toStoreId) return false;
  const src = readData(fromStoreId);
  const idx = src.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return false;
  const [task] = src.tasks.splice(idx, 1);
  writeData(fromStoreId, src);
  const dest = readData(toStoreId);
  // Clear 'current' — that flag is meant to be unique per store, and blindly
  // carrying it over could silently create a second "current" task there.
  dest.tasks.push(normalizeTask({ ...task, current: false }));
  writeData(toStoreId, dest);
  const srcWin = winOf(fromStoreId);
  if (srcWin) srcWin.webContents.send('tasks-updated', readData(fromStoreId));
  const destWin = winOf(toStoreId);
  if (destWin) destWin.webContents.send('tasks-updated', readData(toStoreId));
  checkReminders();
  return true;
});

// ---------------------------------------------------------------------------
// Update check — reads the latest GitHub Release for the public repo.
// No auto-download/install: just tells the user a newer version exists and
// links to the release page, since silent auto-update isn't reliable without
// code signing (the same unsigned-binary friction seen with AV on installs).
// ---------------------------------------------------------------------------
const UPDATE_REPO = 'Caleb-HP-Academy/DayList';
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
function checkForUpdates() {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'DayList-App', Accept: 'application/vnd.github+json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode === 404) { resolve({ ok: false, error: 'no releases published yet' }); return; }
          if (res.statusCode !== 200) { resolve({ ok: false, error: 'HTTP ' + res.statusCode }); return; }
          try {
            const data = JSON.parse(body);
            const latest = String(data.tag_name || '').replace(/^v/i, '');
            const current = app.getVersion();
            if (!latest) { resolve({ ok: false, error: 'No release found' }); return; }
            // Prefer a direct link to the Windows installer asset so
            // "Download" starts the file immediately instead of landing on
            // the release page — fall back to the page if the asset naming
            // ever changes.
            const setupAsset = (data.assets || []).find((a) => /^DayList-Setup-.*\.exe$/i.test(a.name));
            resolve({
              ok: true, current, latest,
              updateAvailable: compareVersions(latest, current) > 0,
              url: setupAsset ? setupAsset.browser_download_url : (data.html_url || `https://github.com/${UPDATE_REPO}/releases`)
            });
          } catch (e) { resolve({ ok: false, error: 'Unexpected response' }); }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'Timed out' }); });
  });
}
ipcMain.handle('check-for-updates', () => checkForUpdates());
ipcMain.handle('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
const SUGGESTION_EMAIL = 'caleb@hpacademy.com';
ipcMain.handle('send-suggestion', async () => {
  const subject = encodeURIComponent('DayList suggestion');
  const body = encodeURIComponent(`What would you like to see changed or added?\n\n\n\n— sent from DayList v${app.getVersion()}`);
  try {
    // Rejects when Windows has no working handler for mailto: (e.g. a stale
    // "default mail app" registration pointing at something uninstalled) —
    // confirmed this is a real, silent failure mode, not just theoretical.
    await shell.openExternal(`mailto:${SUGGESTION_EMAIL}?subject=${subject}&body=${body}`);
    return { ok: true, email: SUGGESTION_EMAIL };
  } catch (e) {
    return { ok: false, email: SUGGESTION_EMAIL };
  }
});

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
  const claudeNotes = (payload && payload.claudeNotes) || '';
  const prompt =
    `I'm working on this task from my DayList to-do app and need help.\n\n` +
    `Task: ${title}\n` + (notes ? `My notes: ${notes}\n` : '') +
    (claudeNotes ? `Notes for Claude: ${claudeNotes}\n` : '') +
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
    startHyteServer();

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
    if (hyteServer) { try { hyteServer.close(); } catch (e) {} }
    for (const s of stores.values()) if (s.watcher) { try { s.watcher.close(); } catch (e) {} }
  });
}
