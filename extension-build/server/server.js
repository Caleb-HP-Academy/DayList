#!/usr/bin/env node
// DayList MCP server — lets Claude Desktop read and edit the DayList widget's
// stores (the main list + per-project lists). The widget watches these files,
// so changes appear live.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Store locations — resolved IN CODE (never via shell/template syntax).
// ---------------------------------------------------------------------------
function resolveMainStore() {
  const home = os.homedir();
  const DEFAULT = path.join(home, 'Desktop', 'DayList', 'tasks.json');
  const expand = (v) => {
    let out = v.replace(/%USERPROFILE%/gi, home).replace(/\$\{?HOME\}?/g, home);
    if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = path.join(home, out.slice(1));
    return out;
  };
  let p = (process.env.DAYLIST_TASKS_FILE || '').trim();
  if (!p) {
    const dir = (process.env.DAYLIST_DATA_DIR || '').trim();
    if (dir) p = path.join(dir, 'tasks.json');
  }
  if (!p) return DEFAULT;
  p = expand(p);
  if (/[$%{}]/.test(p) || !path.isAbsolute(p)) return DEFAULT;
  return path.normalize(p);
}

const MAIN_STORE = resolveMainStore();
const DATA_DIR = path.dirname(MAIN_STORE);
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const PROJECTS_INDEX = path.join(DATA_DIR, 'projects.json');
console.error('[daylist] main store: ' + MAIN_STORE);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function newId(prefix) {
  return (prefix || 't_') + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
function normalizeTask(t) {
  const valid = ['high', 'medium', 'low'];
  return {
    id: t.id || newId('t_'),
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
  return {
    id: r.id || newId('r_'),
    title: typeof r.title === 'string' ? r.title : String(r.title || ''),
    priority: ['high', 'medium', 'low'].includes(r.priority) ? r.priority : 'medium',
    notes: typeof r.notes === 'string' ? r.notes : '',
    freq: ['daily', 'weekdays', 'weekly'].includes(r.freq) ? r.freq : 'daily',
    days: Array.isArray(r.days) ? r.days.filter((n) => n >= 0 && n <= 6) : [],
    reminderTime: typeof r.reminderTime === 'string' ? r.reminderTime : '',
    lastAdded: r.lastAdded || null
  };
}

function readStore(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (e) {
    if (e.code === 'ENOENT') return { ok: false, reason: 'missing', path: file };
    return { ok: false, reason: 'unreadable', path: file, error: `${e.code} ${e.message}` };
  }
  if (!stat.isFile()) return { ok: false, reason: 'unreadable', path: file, error: 'not a file' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { return { ok: false, reason: 'unreadable', path: file, error: `${e.code} ${e.message}` }; }
  let d;
  try { d = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'corrupt', path: file, error: e.message }; }
  if (!Array.isArray(d.tasks)) d.tasks = [];
  if (!Array.isArray(d.archive)) d.archive = [];
  if (!Array.isArray(d.recurring)) d.recurring = [];
  d.tasks = d.tasks.map(normalizeTask);
  d.archive = d.archive.map(normalizeTask);
  d.recurring = d.recurring.map(normalizeRecurring);
  if (!d.meta) d.meta = { lastOpened: todayStr() };
  return { ok: true, data: d };
}
function storeErrMessage(s) {
  if (s.reason === 'missing') return `Store not found at:\n  ${s.path}\nOpen the DayList app once to create it.`;
  if (s.reason === 'unreadable') return `Cannot read store at:\n  ${s.path}\nOS error: ${s.error}`;
  if (s.reason === 'corrupt') return `Store is not valid JSON at:\n  ${s.path}\n${s.error}`;
  return `Store error at ${s.path}`;
}
function loadForWrite(file) {
  const s = readStore(file);
  if (s.ok) return s.data;
  if (s.reason === 'missing') return { tasks: [], archive: [], recurring: [], meta: { lastOpened: todayStr() } };
  throw new Error(storeErrMessage(s));
}
function writeData(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// Projects index
function readProjectsIndex() {
  try {
    const d = JSON.parse(fs.readFileSync(PROJECTS_INDEX, 'utf8'));
    return Array.isArray(d.projects) ? d.projects : [];
  } catch (e) { return []; }
}
function writeProjectsIndex(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PROJECTS_INDEX + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ projects: list }, null, 2), 'utf8');
  fs.renameSync(tmp, PROJECTS_INDEX);
}
function projectFile(id) { return path.join(PROJECTS_DIR, id + '.json'); }

// Resolve which store file a `project` argument refers to (undefined = main).
function resolveStore(project) {
  if (!project || !String(project).trim()) return { file: MAIN_STORE, label: 'main list' };
  const q = String(project).trim().toLowerCase();
  const list = readProjectsIndex();
  const p = list.find((x) => x.id === project)
    || list.find((x) => x.name.toLowerCase() === q)
    || list.find((x) => x.name.toLowerCase().includes(q));
  if (!p) {
    const avail = list.map((x) => x.name).join(', ') || '(none yet)';
    throw new Error(`No project matching "${project}". Available projects: ${avail}`);
  }
  return { file: projectFile(p.id), label: `project "${p.name}"`, id: p.id, name: p.name };
}

function parseWhen(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function summarize(t) {
  const flags = [];
  if (t.current) flags.push('★current');
  if (t.done) flags.push('done');
  if (t.reminder) flags.push('⏰ ' + new Date(t.reminder).toLocaleString());
  return `• [${t.priority}] ${t.title}${flags.length ? '  (' + flags.join(', ') + ')' : ''}  {id:${t.id}}`;
}
const ok = (text) => ({ content: [{ type: 'text', text }] });
const findTask = (d, q) =>
  d.tasks.find((t) => t.id === q) ||
  d.tasks.find((t) => t.title.toLowerCase() === String(q).toLowerCase()) ||
  d.tasks.find((t) => t.title.toLowerCase().includes(String(q).toLowerCase()));

// A read tool wrapper that resolves the store and surfaces errors nicely.
function readCtx(project) {
  const s = resolveStore(project); // may throw
  const r = readStore(s.file);
  return { store: s, res: r };
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------
const server = new McpServer({ name: 'daylist', version: '1.2.0' });
const PROJECT_ARG = z.string().optional().describe('Project name (or id) to target. Omit for the main list.');

server.tool(
  'list_tasks',
  'List DayList tasks from the main list or a project. Filter by status/priority.',
  {
    status: z.enum(['active', 'done', 'all']).optional().describe('active (default), done, or all'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    project: PROJECT_ARG
  },
  async ({ status = 'active', priority, project }) => {
    let ctx;
    try { ctx = readCtx(project); } catch (e) { return ok(e.message); }
    if (!ctx.res.ok) return ok(storeErrMessage(ctx.res));
    let tasks = ctx.res.data.tasks;
    if (status === 'active') tasks = tasks.filter((t) => !t.done);
    else if (status === 'done') tasks = tasks.filter((t) => t.done);
    if (priority) tasks = tasks.filter((t) => t.priority === priority);
    if (!tasks.length) return ok(`No matching tasks in the ${ctx.store.label}.`);
    return ok(`Tasks in the ${ctx.store.label}:\n` + tasks.map(summarize).join('\n'));
  }
);

server.tool(
  'add_task',
  'Add a task to the main list or a project.',
  {
    title: z.string().describe('The task text'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    reminder: z.string().optional().describe('When to remind, e.g. "2026-08-27 17:00" or ISO datetime'),
    notes: z.string().optional(),
    current: z.boolean().optional().describe('Make it the current focus task'),
    project: PROJECT_ARG
  },
  async ({ title, priority = 'medium', reminder, notes, current, project }) => {
    let store;
    try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    let d;
    try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    if (current) d.tasks.forEach((t) => (t.current = false));
    const task = normalizeTask({
      id: newId('t_'), title, priority, notes: notes || '',
      reminder: parseWhen(reminder), current: !!current, createdAt: new Date().toISOString()
    });
    d.tasks.push(task);
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Store: ${store.file}\nError: ${e.code || ''} ${e.message}`); }
    return ok(`Added to the ${store.label}:\n` + summarize(task));
  }
);

server.tool(
  'update_task',
  'Update a task (match by id or title) in the main list or a project.',
  {
    task: z.string().describe('Task id or title (or part of the title)'),
    title: z.string().optional(),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    reminder: z.string().optional().describe('New reminder time, or "none" to clear'),
    notes: z.string().optional(),
    done: z.boolean().optional(),
    project: PROJECT_ARG
  },
  async ({ task, title, priority, reminder, notes, done, project }) => {
    let store;
    try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    let d;
    try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    const t = findTask(d, task);
    if (!t) return ok(`No task found matching "${task}" in the ${store.label}.`);
    if (title !== undefined) t.title = title;
    if (priority !== undefined) t.priority = priority;
    if (notes !== undefined) t.notes = notes;
    if (done !== undefined) { t.done = done; t.completedAt = done ? new Date().toISOString() : null; if (done) t.current = false; }
    if (reminder !== undefined) {
      if (reminder.toLowerCase() === 'none' || reminder === '') { t.reminder = null; t.reminderFired = false; }
      else { const iso = parseWhen(reminder); if (iso) { t.reminder = iso; t.reminderFired = false; } }
    }
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Error: ${e.code || ''} ${e.message}`); }
    return ok(`Updated in the ${store.label}:\n` + summarize(t));
  }
);

server.tool(
  'complete_task',
  'Mark a task complete (match by id or title).',
  { task: z.string().describe('Task id or title'), project: PROJECT_ARG },
  async ({ task, project }) => {
    let store; try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    let d; try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    const t = findTask(d, task);
    if (!t) return ok(`No task found matching "${task}" in the ${store.label}.`);
    t.done = true; t.completedAt = new Date().toISOString(); t.current = false;
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Error: ${e.code || ''} ${e.message}`); }
    return ok(`Completed in the ${store.label}:\n` + summarize(t));
  }
);

server.tool(
  'set_current_task',
  'Set the one "current" focus task (clears current on all others in that list).',
  { task: z.string().describe('Task id or title'), project: PROJECT_ARG },
  async ({ task, project }) => {
    let store; try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    let d; try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    const t = findTask(d, task);
    if (!t) return ok(`No task found matching "${task}" in the ${store.label}.`);
    d.tasks.forEach((x) => (x.current = false));
    t.current = true; t.done = false; t.completedAt = null;
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Error: ${e.code || ''} ${e.message}`); }
    return ok(`Now the current task in the ${store.label}:\n` + summarize(t));
  }
);

server.tool(
  'delete_task',
  'Delete a task permanently (match by id or title).',
  { task: z.string().describe('Task id or title'), project: PROJECT_ARG },
  async ({ task, project }) => {
    let store; try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    let d; try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    const t = findTask(d, task);
    if (!t) return ok(`No task found matching "${task}" in the ${store.label}.`);
    d.tasks = d.tasks.filter((x) => x.id !== t.id);
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Error: ${e.code || ''} ${e.message}`); }
    return ok(`Deleted from the ${store.label}: ${t.title}`);
  }
);

server.tool(
  'view_archive',
  'List archived (completed and cleared) tasks with notes.',
  { project: PROJECT_ARG },
  async ({ project }) => {
    let ctx; try { ctx = readCtx(project); } catch (e) { return ok(e.message); }
    if (!ctx.res.ok) return ok(storeErrMessage(ctx.res));
    const archive = ctx.res.data.archive;
    if (!archive.length) return ok(`Archive is empty for the ${ctx.store.label}.`);
    return ok(
      archive.slice().reverse().map((t) => {
        const when = t.completedAt || t.archivedAt;
        return `• [${t.priority}] ${t.title}${when ? '  (' + new Date(when).toLocaleDateString() + ')' : ''}` +
          (t.notes ? `\n    notes: ${t.notes}` : '');
      }).join('\n')
    );
  }
);

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
server.tool('list_projects', 'List DayList projects (each is a separate task list).', {}, async () => {
  const list = readProjectsIndex();
  if (!list.length) return ok('No projects yet. Create one with create_project.');
  return ok(list.map((p) => {
    let active = 0;
    const r = readStore(projectFile(p.id));
    if (r.ok) active = r.data.tasks.filter((t) => !t.done).length;
    return `• ${p.name} — ${active} active  {id:${p.id}}`;
  }).join('\n'));
});

server.tool('create_project', 'Create a new DayList project (its own task list / window).',
  { name: z.string().describe('Project name, e.g. "C10 engine swap"') },
  async ({ name }) => {
    const clean = String(name || '').trim();
    if (!clean) return ok('Please give the project a name.');
    const list = readProjectsIndex();
    if (list.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return ok(`A project named "${clean}" already exists.`);
    const id = newId('p_');
    list.push({ id, name: clean, createdAt: new Date().toISOString() });
    writeProjectsIndex(list);
    writeData(projectFile(id), { tasks: [], archive: [], recurring: [], meta: { lastOpened: todayStr() } });
    return ok(`Created project "${clean}". Open it from DayList's 📁 Projects (or the tray). {id:${id}}`);
  }
);

// ---------------------------------------------------------------------------
// Recurring tasks
// ---------------------------------------------------------------------------
function recurringSummary(r) {
  let f = r.freq === 'daily' ? 'every day' : r.freq === 'weekdays' ? 'weekdays'
    : 'weekly ' + (r.days || []).map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join('/');
  if (r.reminderTime) f += ` @ ${r.reminderTime}`;
  return `• [${r.priority}] ${r.title} — ${f}  {id:${r.id}}`;
}

server.tool('list_recurring', 'List recurring task templates for the main list or a project.',
  { project: PROJECT_ARG },
  async ({ project }) => {
    let ctx; try { ctx = readCtx(project); } catch (e) { return ok(e.message); }
    if (!ctx.res.ok) return ok(storeErrMessage(ctx.res));
    const rec = ctx.res.data.recurring;
    if (!rec.length) return ok(`No recurring tasks in the ${ctx.store.label}.`);
    return ok(rec.map(recurringSummary).join('\n'));
  }
);

server.tool('add_recurring', 'Add a recurring task template that auto-adds a task each matching day.',
  {
    title: z.string().describe('The task text that repeats'),
    freq: z.enum(['daily', 'weekdays', 'weekly']).describe('daily, weekdays, or weekly'),
    days: z.array(z.number().int().min(0).max(6)).optional().describe('For weekly: weekdays as 0=Sun..6=Sat'),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    time: z.string().optional().describe('Optional reminder time "HH:MM" (24h) added to each instance'),
    notes: z.string().optional(),
    project: PROJECT_ARG
  },
  async ({ title, freq, days, priority = 'medium', time, notes, project }) => {
    let store; try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    if (freq === 'weekly' && (!days || !days.length)) return ok('For weekly, provide at least one weekday in `days` (0=Sun..6=Sat).');
    let d; try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    let reminderTime = '';
    if (time && /^\d{1,2}:\d{2}$/.test(time.trim())) reminderTime = time.trim();
    const r = normalizeRecurring({ id: newId('r_'), title, priority, notes: notes || '', freq, days: days || [], reminderTime, lastAdded: null });
    d.recurring.push(r);
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Error: ${e.code || ''} ${e.message}`); }
    return ok(`Added recurring to the ${store.label} (appears on the next matching day):\n` + recurringSummary(r));
  }
);

server.tool('remove_recurring', 'Remove a recurring task template (match by id or title).',
  { task: z.string().describe('Recurring template id or title'), project: PROJECT_ARG },
  async ({ task, project }) => {
    let store; try { store = resolveStore(project); } catch (e) { return ok(e.message); }
    let d; try { d = loadForWrite(store.file); } catch (e) { return ok(e.message); }
    const q = String(task).toLowerCase();
    const r = d.recurring.find((x) => x.id === task) || d.recurring.find((x) => x.title.toLowerCase().includes(q));
    if (!r) return ok(`No recurring template matching "${task}" in the ${store.label}.`);
    d.recurring = d.recurring.filter((x) => x.id !== r.id);
    try { writeData(store.file, d); } catch (e) { return ok(`Could not save. Error: ${e.code || ''} ${e.message}`); }
    return ok(`Removed recurring: ${r.title}`);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
