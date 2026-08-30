const { contextBridge, ipcRenderer } = require('electron');

// Each window is launched with --daylist-store / --daylist-mode / --daylist-name
const argv = process.argv;
const argVal = (p) => { const a = argv.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : ''; };
const STORE = argVal('--daylist-store=') || 'main';
const MODE = argVal('--daylist-mode=') || 'main';
const NAME = decodeURIComponent(argVal('--daylist-name=') || '') || 'DayList';

contextBridge.exposeInMainWorld('daylist', {
  context: { store: STORE, mode: MODE, name: NAME },

  getTasks: () => ipcRenderer.invoke('get-tasks', STORE),
  saveTasks: (data) => ipcRenderer.invoke('save-tasks', STORE, data),
  getSettings: () => ipcRenderer.invoke('get-settings', STORE),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('set-always-on-top', STORE, on),
  setStartup: (on) => ipcRenderer.invoke('set-startup', on),
  setOpacity: (v) => ipcRenderer.invoke('set-opacity', STORE, v),
  getTasksPath: () => ipcRenderer.invoke('get-tasks-path', STORE),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder', STORE),
  askClaude: (payload) => ipcRenderer.invoke('ask-claude', payload),
  connectClaude: () => ipcRenderer.invoke('connect-claude'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  getHyteSettings: () => ipcRenderer.invoke('get-hyte-settings'),
  setHyteSettings: (patch) => ipcRenderer.invoke('set-hyte-settings', patch),
  setStandupEnabled: (on) => ipcRenderer.invoke('set-standup-enabled', on),
  setStandupIncludeWeekends: (on) => ipcRenderer.invoke('set-standup-include-weekends', on),
  stopFlash: () => ipcRenderer.invoke('stop-flash', STORE),
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),

  // Projects
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: (name) => ipcRenderer.invoke('create-project', name),
  renameProject: (id, name) => ipcRenderer.invoke('rename-project', id, name),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  openProject: (id) => ipcRenderer.invoke('open-project', id),

  // Work/rest timer
  timerGet: () => ipcRenderer.invoke('timer-get'),
  timerAction: (action) => ipcRenderer.invoke('timer-action', action),
  timerSet: (settings) => ipcRenderer.invoke('timer-set', settings),
  timerPopout: () => ipcRenderer.invoke('timer-popout'),
  timerPopoutAOT: (on) => ipcRenderer.invoke('timer-popout-aot', on),
  onTimerUpdate: (cb) => ipcRenderer.on('timer-updated', (_e, s) => cb(s)),
  onTimerAlert: (cb) => ipcRenderer.on('timer-alert', (_e, p) => cb(p)),

  // Events
  onTasksUpdated: (cb) => ipcRenderer.on('tasks-updated', (_e, data) => cb(data)),
  onSettingsUpdated: (cb) => ipcRenderer.on('settings-updated', (_e, s) => cb(s)),
  onReminderFired: (cb) => ipcRenderer.on('reminder-fired', (_e, payload) => cb(payload)),
  onProjectRenamed: (cb) => ipcRenderer.on('project-renamed', (_e, name) => cb(name))
});
