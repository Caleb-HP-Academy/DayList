/* global daylist */
'use strict';

let state = { tasks: [], archive: [], meta: {} };
let saveTimer = null;
let reminderTargetId = null;
let selectedId = null;
let highAlertTimer = null;

const $ = (sel) => document.querySelector(sel);
const lists = {
  focus: document.querySelector('.task-list[data-priority="focus"]'),
  high: document.querySelector('.task-list[data-priority="high"]'),
  medium: document.querySelector('.task-list[data-priority="medium"]'),
  low: document.querySelector('.task-list[data-priority="low"]'),
  done: document.querySelector('.task-list[data-priority="done"]')
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const CTX = (window.daylist && window.daylist.context) || { mode: 'main', name: 'DayList', store: 'main' };

async function init() {
  if (CTX.mode === 'project') {
    document.body.classList.add('project-mode');
    document.querySelector('.app-name').textContent = CTX.name;
    document.title = CTX.name;
    daylist.onProjectRenamed((name) => { document.querySelector('.app-name').textContent = name; document.title = name; });
  }

  state = await daylist.getTasks();
  normalizeState();
  render();
  updateDateLabel();
  await loadSettings();
  wireEvents();
  maybePromptNewDay();
  $('#set-standup-morning').checked = !!(state.meta && state.meta.standupMorning);
  if (CTX.mode === 'main') maybeShowStandup();

  daylist.onTasksUpdated((data) => {
    state = data;
    normalizeState();
    render();
    $('#set-standup-morning').checked = !!(state.meta && state.meta.standupMorning);
    if (selectedId) fillDetail(byId(selectedId)); // keep sidebar in sync
  });
  daylist.onSettingsUpdated((s) => applySettingsToUI(s));
  daylist.onReminderFired((payload) => handleReminderFired(payload));

  if (window.initTimerUI) window.initTimerUI(document.getElementById('timer-panel'), { isPopout: false });

  setInterval(render, 30000); // refresh "due" styling
}

function normalizeState() {
  if (!state.tasks) state.tasks = [];
  if (!state.archive) state.archive = [];
  if (!Array.isArray(state.recurring)) state.recurring = [];
  if (!state.meta) state.meta = {};
}

function updateDateLabel() {
  const d = new Date();
  $('#date-label').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => daylist.saveTasks(state), 150);
}
function byId(id) { return state.tasks.find((t) => t.id === id); }
function newId() { return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  for (const key of Object.keys(lists)) lists[key].innerHTML = '';
  const now = Date.now();
  let doneCount = 0;
  const total = state.tasks.length;

  for (const task of state.tasks) {
    const li = renderTask(task, now);
    if (task.done) { lists.done.appendChild(li); doneCount++; }
    else if (task.current) { lists.focus.appendChild(li); }
    else (lists[task.priority] || lists.medium).appendChild(li);
  }

  // Current Focus section only shows when a task is current
  $('#focus-group').classList.toggle('hidden', lists.focus.children.length === 0);

  ['high', 'medium', 'low'].forEach((p) => {
    if (lists[p].children.length === 0) {
      const hint = document.createElement('li');
      hint.className = 'empty-hint';
      hint.textContent = '—';
      lists[p].appendChild(hint);
    }
  });

  $('#done-count').textContent = doneCount;

  // focus mode: dim everything except the current task
  const hasCurrent = state.tasks.some((t) => t.current && !t.done);
  $('#lists').classList.toggle('has-current', hasCurrent);

  applyCollapsed();

  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  $('#progress-fill').style.width = pct + '%';
  $('#progress-text').textContent = `${doneCount} / ${total}`;
}

function applyCollapsed() {
  const c = (state.meta && state.meta.collapsed) || {};
  document.querySelectorAll('.prio-group').forEach((sec) => {
    sec.classList.toggle('collapsed', !!c[sec.dataset.priority]);
  });
}
function toggleCollapse(key) {
  state.meta = state.meta || {};
  state.meta.collapsed = state.meta.collapsed || {};
  state.meta.collapsed[key] = !state.meta.collapsed[key];
  save();
  applyCollapsed();
}

function renderTask(task, now) {
  const li = document.createElement('li');
  li.className = 'task' + (task.done ? ' done' : '') + (task.current ? ' current' : '') + (task.id === selectedId ? ' selected' : '');
  li.dataset.id = task.id;
  li.draggable = true;

  const dueSoon = !task.done && task.reminder && !task.reminderFired && new Date(task.reminder).getTime() <= now;
  if (dueSoon) li.classList.add('due');

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'task-check';
  check.checked = task.done;
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => toggleDone(task.id, check.checked));

  const body = document.createElement('div');
  body.className = 'task-body';
  const title = document.createElement('div');
  title.className = 'task-title';
  title.textContent = task.title;
  body.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'task-meta';
  if (task.current) {
    const star = document.createElement('span');
    star.className = 'star-current';
    star.textContent = '★ current';
    meta.appendChild(star);
  }
  if (task.reminder) {
    const badge = document.createElement('span');
    badge.className = 'reminder-badge' + (dueSoon ? ' due' : '') + (task.priority === 'high' ? ' p-high' : '');
    badge.textContent = '⏰ ' + formatReminder(task.reminder);
    badge.title = 'Edit reminder';
    badge.addEventListener('click', (e) => { e.stopPropagation(); openReminder(task.id, e.currentTarget); });
    meta.appendChild(badge);
  }
  if (task.notes && task.notes.trim()) {
    const nd = document.createElement('span');
    nd.className = 'note-dot';
    nd.textContent = '🗒';
    nd.title = 'Has notes';
    meta.appendChild(nd);
  }
  if (meta.children.length) body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const starBtn = document.createElement('button');
  starBtn.className = 'mini-btn star' + (task.current ? ' active' : '');
  starBtn.textContent = task.current ? '★' : '☆';
  starBtn.title = task.current ? 'Current task — click to unset' : 'Set as current task';
  starBtn.addEventListener('click', (e) => { e.stopPropagation(); setCurrent(task.id); });
  const clockBtn = document.createElement('button');
  clockBtn.className = 'mini-btn';
  clockBtn.textContent = '⏰';
  clockBtn.title = 'Set reminder';
  clockBtn.addEventListener('click', (e) => { e.stopPropagation(); openReminder(task.id, e.currentTarget); });
  const delBtn = document.createElement('button');
  delBtn.className = 'mini-btn del';
  delBtn.textContent = '🗑';
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(task.id); });
  actions.appendChild(starBtn);
  actions.appendChild(clockBtn);
  actions.appendChild(delBtn);

  li.appendChild(check);
  li.appendChild(body);
  li.appendChild(actions);

  li.addEventListener('click', () => selectTask(task.id));
  li.addEventListener('dragstart', (e) => {
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', task.id); } catch (_) {}
  });
  li.addEventListener('dragend', () => {
    li.classList.remove('dragging');
    document.querySelectorAll('.task-list').forEach((l) => l.classList.remove('drag-over'));
    syncFromDOM();
  });

  return li;
}

function formatReminder(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + time;
}

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------
function addTask() {
  const input = $('#add-input');
  const text = input.value.trim();
  if (!text) return;
  state.tasks.push({
    id: newId(), title: text, priority: $('#add-priority').value,
    done: false, current: false, reminder: null, reminderFired: false,
    notes: '', createdAt: new Date().toISOString(), completedAt: null, archivedAt: null
  });
  input.value = '';
  save();
  render();
}

function toggleDone(id, done) {
  const t = byId(id);
  if (!t) return;
  t.done = done;
  t.completedAt = done ? new Date().toISOString() : null;
  if (done) t.current = false;
  save();
  render();
  if (selectedId === id) fillDetail(t);
}

function deleteTask(id) {
  state.tasks = state.tasks.filter((t) => t.id !== id);
  if (selectedId === id) closeDetail();
  save();
  render();
}

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------
function getDragAfterElement(list, y) {
  const els = [...list.querySelectorAll('.task:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}
function setupListDnD(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    list.classList.add('drag-over');
    const dragging = document.querySelector('.task.dragging');
    if (!dragging) return;
    const after = getDragAfterElement(list, e.clientY);
    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
  });
  list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('drag-over'); });
  list.addEventListener('drop', (e) => { e.preventDefault(); list.classList.remove('drag-over'); });
}
function syncFromDOM() {
  const newOrder = [];
  let firstFocusSeen = false;
  document.querySelectorAll('.task-list').forEach((list) => {
    const prio = list.dataset.priority;
    list.querySelectorAll('.task').forEach((li) => {
      const t = byId(li.dataset.id);
      if (!t) return;
      if (prio === 'done') {
        if (!t.done) t.completedAt = new Date().toISOString();
        t.done = true; t.current = false;
      } else if (prio === 'focus') {
        t.done = false; t.completedAt = null;
        // enforce a single current task if more than one got dropped here
        t.current = !firstFocusSeen;
        firstFocusSeen = true;
      } else {
        t.done = false; t.completedAt = null; t.current = false; t.priority = prio;
      }
      newOrder.push(t);
    });
  });
  if (newOrder.length === state.tasks.length) state.tasks = newOrder;
  save();
  render();
}

// ---------------------------------------------------------------------------
// Detail sidebar
// ---------------------------------------------------------------------------
function selectTask(id) {
  selectedId = id;
  const t = byId(id);
  if (!t) return;
  $('#detail-source').open = false;
  fillDetail(t);
  $('#detail').classList.remove('closed');
  $('#detail-backdrop').classList.remove('hidden');
  render();
}
function closeDetail() {
  selectedId = null;
  $('#detail').classList.add('closed');
  $('#detail-backdrop').classList.add('hidden');
  render();
}
function splitSourceLine(notes) {
  const s = notes || '';
  const nl = s.indexOf('\n');
  const firstLine = nl === -1 ? s : s.slice(0, nl);
  if (/^Source:/.test(firstLine)) {
    return { source: firstLine, rest: nl === -1 ? '' : s.slice(nl + 1) };
  }
  return { source: null, rest: s };
}
function fillDetail(t) {
  if (!t) return;
  $('#detail-title').value = t.title;
  $('#detail-priority').value = t.priority;
  const { source, rest } = splitSourceLine(t.notes);
  $('#detail-source').classList.toggle('hidden', !source);
  $('#detail-source-text').textContent = source || '';
  $('#detail-notes').value = rest;
  const rb = $('#detail-reminder');
  if (t.reminder) { rb.textContent = '⏰ ' + formatReminder(t.reminder) + '  (edit)'; rb.classList.add('set'); }
  else { rb.textContent = 'Set a reminder…'; rb.classList.remove('set'); }
  const cb = $('#detail-current');
  cb.classList.toggle('active', !!t.current);
  cb.textContent = t.current ? '★ Current task' : '★ Set as current task';
  const pb = $('#detail-personal');
  pb.classList.toggle('active', !!t.personal);
  pb.textContent = t.personal ? '🔒 Personal (hidden from standup)' : '🔒 Mark as personal';
  $('#detail-complete').textContent = t.done ? '↺ Reopen task' : '✓ Mark complete';
  const parts = [];
  if (t.createdAt) parts.push('Created ' + new Date(t.createdAt).toLocaleString());
  if (t.completedAt) parts.push('Completed ' + new Date(t.completedAt).toLocaleString());
  $('#detail-meta').textContent = parts.join('\n');
}
function setCurrent(id) {
  const t = byId(id);
  if (!t) return;
  const makeCurrent = !t.current;
  state.tasks.forEach((x) => { x.current = false; });
  t.current = makeCurrent;
  if (makeCurrent) { t.done = false; t.completedAt = null; }
  save();
  render();
  fillDetail(t);
}
function togglePersonal(id) {
  const t = byId(id);
  if (!t) return;
  t.personal = !t.personal;
  save();
  fillDetail(t);
}

// ---------------------------------------------------------------------------
// Reminder popover
// ---------------------------------------------------------------------------
function openReminder(id, anchorEl) {
  reminderTargetId = id;
  const pop = $('#reminder-pop');
  const input = $('#reminder-input');
  const t = byId(id);
  input.value = t && t.reminder ? toLocalInput(t.reminder) : toLocalInput(new Date(Date.now() + 3600000).toISOString());

  pop.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const pw = 240, ph = 200;
  let left = Math.min(rect.left, window.innerWidth - pw - 8);
  let top = rect.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 6);
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}
function toLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function applyPreset(kind) {
  const d = new Date();
  if (kind === '1h') d.setHours(d.getHours() + 1);
  else if (kind === '3h') d.setHours(d.getHours() + 3);
  else if (kind === 'eve') { d.setHours(18, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); }
  else if (kind === 'tom9') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  $('#reminder-input').value = toLocalInput(d.toISOString());
}
function closeReminder() { $('#reminder-pop').classList.add('hidden'); reminderTargetId = null; }
function saveReminder() {
  const t = byId(reminderTargetId);
  const val = $('#reminder-input').value;
  if (t && val) { t.reminder = new Date(val).toISOString(); t.reminderFired = false; }
  const wasSelected = reminderTargetId;
  closeReminder();
  save();
  render();
  if (wasSelected === selectedId) fillDetail(byId(selectedId));
}
function clearReminder() {
  const t = byId(reminderTargetId);
  if (t) { t.reminder = null; t.reminderFired = false; }
  const wasSelected = reminderTargetId;
  closeReminder();
  save();
  render();
  if (wasSelected === selectedId) fillDetail(byId(selectedId));
}

// ---------------------------------------------------------------------------
// New day + archive
// ---------------------------------------------------------------------------
function startNewDay(silent) {
  const done = state.tasks.filter((t) => t.done);
  if (done.length === 0) {
    markDay();
    if (!silent) toast('Nothing completed yet — day reset.');
    save();
    return;
  }
  if (!silent && !confirm(`Archive ${done.length} completed task(s) and start fresh? Unfinished tasks stay.`)) return;
  const now = new Date().toISOString();
  done.forEach((t) => { t.archivedAt = now; });
  state.archive = (state.archive || []).concat(done);
  state.tasks = state.tasks.filter((t) => !t.done);
  markDay();
  hideDayPrompt();
  save();
  render();
  toast(`Archived ${done.length} task(s). Fresh start!`);
}
function markDay() { state.meta = state.meta || {}; state.meta.lastOpened = todayStr(); }

function maybePromptNewDay() {
  if (state.meta && state.meta.lastOpened && state.meta.lastOpened !== todayStr()) {
    const doneCount = state.tasks.filter((t) => t.done).length;
    $('#day-prompt-text').textContent = doneCount
      ? `New day! Archive ${doneCount} completed task(s) from last time?`
      : `Welcome back — it's a new day.`;
    $('#day-prompt').classList.remove('hidden');
  }
}
function hideDayPrompt() { $('#day-prompt').classList.add('hidden'); }

function openArchive() {
  const list = $('#archive-list');
  list.innerHTML = '';
  const items = (state.archive || []).slice().reverse();
  if (items.length === 0) {
    list.innerHTML = '<div class="archive-empty">No archived tasks yet.<br>Completed tasks land here after "Start a new day".</div>';
  } else {
    for (const t of items) list.appendChild(renderArchiveItem(t));
  }
  $('#archive-modal').classList.remove('hidden');
}
function renderArchiveItem(t) {
  const wrap = document.createElement('div');
  wrap.className = 'archive-item';
  const top = document.createElement('div');
  top.className = 'archive-item-top';
  const dot = document.createElement('span');
  dot.className = 'dot dot-' + t.priority;
  const title = document.createElement('span');
  title.className = 'archive-item-title';
  title.textContent = t.title;
  const date = document.createElement('span');
  date.className = 'archive-item-date';
  const when = t.completedAt || t.archivedAt;
  date.textContent = when ? new Date(when).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
  top.appendChild(dot); top.appendChild(title); top.appendChild(date);
  wrap.appendChild(top);
  if (t.notes && t.notes.trim()) {
    const notes = document.createElement('div');
    notes.className = 'archive-item-notes';
    notes.textContent = t.notes;
    wrap.appendChild(notes);
  }
  const acts = document.createElement('div');
  acts.className = 'archive-item-actions';
  const restore = document.createElement('button');
  restore.className = 'text-btn';
  restore.textContent = '↺ Restore';
  restore.addEventListener('click', () => restoreArchived(t.id));
  const del = document.createElement('button');
  del.className = 'text-btn';
  del.textContent = 'Delete';
  del.addEventListener('click', () => { state.archive = state.archive.filter((a) => a.id !== t.id); save(); openArchive(); });
  acts.appendChild(restore); acts.appendChild(del);
  wrap.appendChild(acts);
  return wrap;
}
function restoreArchived(id) {
  const t = (state.archive || []).find((a) => a.id === id);
  if (!t) return;
  state.archive = state.archive.filter((a) => a.id !== id);
  t.done = false; t.completedAt = null; t.archivedAt = null; t.reminderFired = false;
  state.tasks.push(t);
  save();
  render();
  openArchive();
  toast('Restored to your list.');
}

// ---------------------------------------------------------------------------
// Daily standup draft (from DayList data)
// ---------------------------------------------------------------------------
function buildStandup() {
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const prevDay = (d, skipWeekends) => {
    const x = new Date(d);
    x.setDate(x.getDate() - 1);
    if (skipWeekends) while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() - 1);
    return x;
  };
  const todayStart = startOfDay(new Date());
  // With weekends excluded, "yesterday" on a Monday resolves to Friday —
  // the weekend is treated as if it doesn't exist for standup purposes.
  const yStart = prevDay(todayStart, standupSkipWeekends);

  // completed = done tasks still in the list + everything in the archive
  // (excluding anything marked personal, which never appears in the standup)
  const completed = [
    ...state.tasks.filter((t) => t.done && !t.personal),
    ...(state.archive || []).filter((t) => !t.personal)
  ]
    .map((t) => ({ title: t.title, when: t.completedAt || t.archivedAt }))
    .filter((x) => x.when)
    .map((x) => ({ title: x.title, when: new Date(x.when) }))
    .filter((x) => !isNaN(x.when));

  let dayStart = yStart;
  let inDay = completed.filter((x) => startOfDay(x.when).getTime() === dayStart.getTime());
  if (inDay.length === 0) {
    // weekend / gap — fall back to the most recent prior day that had completions
    const prior = completed.filter((x) => x.when < todayStart);
    if (prior.length) {
      const latest = prior.reduce((a, b) => (a.when > b.when ? a : b)).when;
      dayStart = startOfDay(latest);
      inDay = completed.filter((x) => startOfDay(x.when).getTime() === dayStart.getTime());
    }
  }

  const seen = new Set();
  const yesterday = [];
  for (const x of inDay) {
    const k = x.title.trim();
    if (k && !seen.has(k)) { seen.add(k); yesterday.push(x.title); }
  }

  const rank = { high: 0, medium: 1, low: 2 };
  const active = state.tasks.filter((t) => !t.done && !t.personal).slice();
  active.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || rank[a.priority] - rank[b.priority]);
  const today = active.map((t) => t.title);

  return {
    isYesterday: dayStart.getTime() === yStart.getTime(),
    label: dayStart.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
    yesterday,
    today
  };
}

function openStandup() {
  const s = buildStandup();
  $('#standup-y-label').textContent = s.isYesterday
    ? 'What did you do yesterday?'
    : `What did you do on ${s.label}? (last active day)`;
  buildStandupChecks('#standup-y-checks', s.yesterday, 'standup-yesterday');
  buildStandupChecks('#standup-t-checks', s.today, 'standup-today');
  refreshStandupText('#standup-y-checks', 'standup-yesterday');
  refreshStandupText('#standup-t-checks', 'standup-today');
  $('#standup-modal').classList.remove('hidden');
}

function buildStandupChecks(containerSel, items, textId) {
  const c = $(containerSel);
  c.innerHTML = '';
  if (!items.length) {
    c.innerHTML = '<div class="standup-empty">(nothing here — type directly in the box below)</div>';
    return;
  }
  items.forEach((title) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = title;
    const span = document.createElement('span');
    span.textContent = title;
    cb.addEventListener('change', () => {
      label.classList.toggle('off', !cb.checked);
      refreshStandupText(containerSel, textId);
    });
    label.appendChild(cb);
    label.appendChild(span);
    c.appendChild(label);
  });
}

function refreshStandupText(containerSel, textId) {
  const checked = [...$(containerSel).querySelectorAll('input:checked')].map((i) => i.value);
  $('#' + textId).value = checked.map((t) => '• ' + t).join('\n');
}

function maybeShowStandup() {
  if (!standupEnabled) return;
  if (state.meta && state.meta.standupMorning && state.meta.lastStandup !== todayStr()) {
    openStandup();
    state.meta.lastStandup = todayStr();
    save();
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
function mkTextBtn(label, fn) {
  const b = document.createElement('button');
  b.className = 'text-btn';
  b.textContent = label;
  b.addEventListener('click', fn);
  return b;
}
async function openProjects() {
  const list = await daylist.listProjects();
  const box = $('#projects-list');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="archive-empty">No projects yet.<br>Create one above — it opens in its own window with its own task list.</div>';
  } else {
    for (const p of list) box.appendChild(renderProjectItem(p));
  }
  $('#projects-modal').classList.remove('hidden');
}
function renderProjectItem(p) {
  const wrap = document.createElement('div');
  wrap.className = 'archive-item';
  const top = document.createElement('div');
  top.className = 'archive-item-top proj-open';
  top.title = 'Open project';
  const title = document.createElement('span');
  title.className = 'archive-item-title';
  title.textContent = p.name;
  const count = document.createElement('span');
  count.className = 'archive-item-date';
  count.textContent = (p.active || 0) + ' active';
  top.appendChild(title);
  top.appendChild(count);
  top.addEventListener('click', () => daylist.openProject(p.id));
  wrap.appendChild(top);
  const acts = document.createElement('div');
  acts.className = 'archive-item-actions';
  acts.appendChild(mkTextBtn('↗ Open', () => daylist.openProject(p.id)));
  acts.appendChild(mkTextBtn('Rename', async () => {
    const n = prompt('Rename project:', p.name);
    if (n && n.trim()) { await daylist.renameProject(p.id, n.trim()); openProjects(); }
  }));
  acts.appendChild(mkTextBtn('Delete', async () => {
    if (confirm(`Delete project "${p.name}" and all its tasks? This cannot be undone.`)) {
      await daylist.deleteProject(p.id);
      openProjects();
    }
  }));
  wrap.appendChild(acts);
  return wrap;
}
async function createProject() {
  const input = $('#project-name-input');
  const name = input.value.trim();
  if (!name) return;
  await daylist.createProject(name); // opens the project window
  input.value = '';
  openProjects();
}

// ---------------------------------------------------------------------------
// Recurring tasks
// ---------------------------------------------------------------------------
function freqLabel(r) {
  let base;
  if (r.freq === 'daily') base = 'Every day';
  else if (r.freq === 'weekdays') base = 'Weekdays';
  else {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    base = 'Weekly: ' + (r.days || []).slice().sort().map((d) => names[d]).join(', ');
  }
  return r.reminderTime ? base + ' · ⏰ ' + fmtTime(r.reminderTime) : base;
}
function fmtTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
// "HH:MM" -> ISO datetime today at that time (or null)
function timeToTodayISO(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function openRecurring() { renderRecurringList(); $('#recurring-modal').classList.remove('hidden'); }
function renderRecurringList() {
  const box = $('#recurring-list');
  box.innerHTML = '';
  if (!state.recurring.length) {
    box.innerHTML = '<div class="archive-empty">No recurring tasks.<br>Add one above — it drops into your list automatically on each matching day.</div>';
    return;
  }
  for (const r of state.recurring) {
    const wrap = document.createElement('div');
    wrap.className = 'archive-item';
    const top = document.createElement('div');
    top.className = 'archive-item-top';
    const dot = document.createElement('span');
    dot.className = 'dot dot-' + r.priority;
    const title = document.createElement('span');
    title.className = 'archive-item-title';
    title.textContent = r.title;
    const badge = document.createElement('span');
    badge.className = 'badge-freq';
    badge.textContent = freqLabel(r);
    top.appendChild(dot);
    top.appendChild(title);
    top.appendChild(badge);
    wrap.appendChild(top);
    const acts = document.createElement('div');
    acts.className = 'archive-item-actions';
    acts.appendChild(mkTextBtn('Delete', () => {
      state.recurring = state.recurring.filter((x) => x.id !== r.id);
      save();
      renderRecurringList();
    }));
    wrap.appendChild(acts);
    box.appendChild(wrap);
  }
}
function dueToday(r) {
  const dow = new Date().getDay();
  if (r.freq === 'daily') return true;
  if (r.freq === 'weekdays') return dow >= 1 && dow <= 5;
  if (r.freq === 'weekly') return (r.days || []).includes(dow);
  return false;
}
function createRecurring() {
  const title = $('#recurring-title').value.trim();
  if (!title) return;
  const priority = $('#recurring-priority').value;
  const freq = $('#recurring-freq').value;
  const reminderTime = $('#recurring-time').value || '';
  let days = [];
  if (freq === 'weekly') {
    days = [...$('#recurring-days').querySelectorAll('input:checked')].map((i) => parseInt(i.value, 10));
    if (!days.length) { toast('Pick at least one weekday.'); return; }
  }
  const r = {
    id: 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    title, priority, notes: '', freq, days, reminderTime, lastAdded: null
  };
  // add an instance now if due today, and mark so the main process won't double-add
  if (dueToday(r)) {
    const reminder = timeToTodayISO(reminderTime);
    state.tasks.push({
      id: newId(), title, priority, done: false, current: false,
      reminder,
      // if the time already passed today, don't nag late — mark as fired
      reminderFired: reminder ? new Date(reminder).getTime() < Date.now() : false,
      notes: '', createdAt: new Date().toISOString(),
      completedAt: null, archivedAt: null
    });
    r.lastAdded = todayStr();
  }
  state.recurring.push(r);
  save();
  render();
  renderRecurringList();
  $('#recurring-title').value = '';
  $('#recurring-time').value = '';
  $('#recurring-days').querySelectorAll('input').forEach((i) => (i.checked = false));
  toast('Recurring task added.');
}

// ---------------------------------------------------------------------------
// Ask Claude
// ---------------------------------------------------------------------------
async function askClaude(id) {
  const t = byId(id);
  if (!t) return;
  await daylist.askClaude({ title: t.title, notes: t.notes || '' });
  toast('Opening Claude — prompt also copied to clipboard (Ctrl+V).');
}

// ---------------------------------------------------------------------------
// Reminder sounds (Web Audio, no files needed)
// ---------------------------------------------------------------------------
let audioCtx = null;
function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function beep(freq, durMs, type, gain, whenS) {
  const ctx = ac();
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(ctx.destination);
  const t0 = ctx.currentTime + (whenS || 0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  o.start(t0);
  o.stop(t0 + durMs / 1000 + 0.02);
}
function playLow() { beep(430, 220, 'sine', 0.05, 0); }
function playMedium() { beep(620, 160, 'sine', 0.11, 0); beep(880, 200, 'sine', 0.11, 0.16); }
function playHighOnce() {
  beep(1000, 130, 'square', 0.16, 0);
  beep(1000, 130, 'square', 0.16, 0.2);
  beep(1320, 220, 'square', 0.18, 0.42);
}

let alertTaskId = null;
let highAlertAutoOffTimer = null;
function handleReminderFired(payload) {
  const priority = payload.priority || 'medium';
  if (priority === 'low') playLow();
  else if (priority === 'medium') playMedium();
  else {
    // high: urgent, repeating, and a persistent alert
    playHighOnce();
    showHighAlert(payload.id, payload.title);
  }
}
function showHighAlert(id, title) {
  alertTaskId = id;
  $('#alert-body').textContent = title;
  $('#alert-overlay').classList.remove('hidden');
  clearInterval(highAlertTimer);
  highAlertTimer = setInterval(playHighOnce, 1400); // keeps sounding until dismissed or 30s pass
  clearTimeout(highAlertAutoOffTimer);
  highAlertAutoOffTimer = setTimeout(dismissHighAlert, 30000);
}
function dismissHighAlert() {
  $('#alert-overlay').classList.add('hidden');
  clearInterval(highAlertTimer);
  highAlertTimer = null;
  clearTimeout(highAlertAutoOffTimer);
  highAlertAutoOffTimer = null;
  alertTaskId = null;
  daylist.stopFlash();
}
function snoozeAlert(minutes) {
  const t = byId(alertTaskId);
  if (t) {
    t.reminder = new Date(Date.now() + minutes * 60000).toISOString();
    t.reminderFired = false;
    save();
    render();
  }
  dismissHighAlert();
  toast(`Snoozed ${minutes < 60 ? minutes + ' min' : '1 hr'}.`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
let standupEnabled = true;
let standupSkipWeekends = false;
async function loadSettings() {
  applySettingsToUI(await daylist.getSettings());
  $('#path-hint').textContent = 'Data file (share this with Claude):\n' + (await daylist.getTasksPath());
  if (CTX.mode === 'main') await loadHyteSettings();
}
function applySettingsToUI(s) {
  $('#set-aot').checked = !!s.alwaysOnTop;
  $('#set-startup').checked = !!s.runOnStartup;
  $('#set-opacity').value = s.opacity || 1;
  standupEnabled = s.showStandup !== false;
  $('#set-standup-enabled').checked = standupEnabled;
  $('#btn-standup').classList.toggle('hidden', !standupEnabled);
  $('#set-standup-morning-row').classList.toggle('hidden', !standupEnabled);
  const includeWeekends = s.standupIncludeWeekends !== false;
  standupSkipWeekends = !includeWeekends;
  $('#set-standup-weekends').checked = includeWeekends;
  $('#set-standup-weekends-row').classList.toggle('hidden', !standupEnabled);
}
async function loadHyteSettings() {
  const hs = await daylist.getHyteSettings();
  applyHyteSettingsToUI(hs);
}
function applyHyteSettingsToUI(hs) {
  $('#hyte-url').value = hs.url || 'Starting…';
  $('#set-hyte-text-scale').value = hs.textScale || 1;
  $('#set-hyte-btn-scale').value = hs.buttonScale || 1;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
function wireEvents() {
  $('#add-btn').addEventListener('click', addTask);
  $('#add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask(); });

  $('#btn-settings').addEventListener('click', () => {
    const opening = $('#settings-panel').classList.contains('hidden');
    $('#settings-panel').classList.toggle('hidden');
    if (opening && CTX.mode === 'main') loadHyteSettings();
  });
  $('#btn-min').addEventListener('click', () => { $('#settings-panel').classList.add('hidden'); daylist.minimize(); });
  $('#btn-close').addEventListener('click', () => { $('#settings-panel').classList.add('hidden'); daylist.close(); });

  $('#set-aot').addEventListener('change', (e) => daylist.setAlwaysOnTop(e.target.checked));
  $('#set-startup').addEventListener('change', (e) => daylist.setStartup(e.target.checked));
  $('#set-opacity').addEventListener('input', (e) => daylist.setOpacity(parseFloat(e.target.value)));
  $('#set-show-done').addEventListener('change', (e) => $('#done-group').classList.toggle('hidden', !e.target.checked));
  $('#btn-folder').addEventListener('click', () => daylist.openDataFolder());
  $('#btn-archive').addEventListener('click', openArchive);
  $('#btn-recurring').addEventListener('click', openRecurring);

  // Projects
  $('#btn-projects').addEventListener('click', openProjects);
  $('#projects-close').addEventListener('click', () => $('#projects-modal').classList.add('hidden'));
  $('#projects-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'projects-modal') $('#projects-modal').classList.add('hidden'); });
  $('#project-create').addEventListener('click', createProject);
  $('#project-name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') createProject(); });

  // Recurring
  $('#recurring-close').addEventListener('click', () => $('#recurring-modal').classList.add('hidden'));
  $('#recurring-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'recurring-modal') $('#recurring-modal').classList.add('hidden'); });
  $('#recurring-create').addEventListener('click', createRecurring);
  $('#recurring-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') createRecurring(); });
  $('#recurring-freq').addEventListener('change', (e) => {
    $('#recurring-days').classList.toggle('hidden', e.target.value !== 'weekly');
  });

  // Alert snooze
  document.querySelectorAll('.snooze-btn').forEach((b) => {
    b.addEventListener('click', () => snoozeAlert(parseInt(b.dataset.snooze, 10)));
  });
  $('#btn-connect-claude').addEventListener('click', async () => {
    const r = await daylist.connectClaude();
    if (r && r.msg) toast(r.msg);
  });
  $('#btn-copy-hyte-url').addEventListener('click', async () => {
    const url = $('#hyte-url').value;
    if (url && url !== 'Starting…') { await daylist.copyText(url); toast('Widget URL copied.'); }
  });
  $('#set-hyte-text-scale').addEventListener('input', async (e) => {
    applyHyteSettingsToUI(await daylist.setHyteSettings({ textScale: parseFloat(e.target.value) }));
  });
  $('#set-hyte-btn-scale').addEventListener('input', async (e) => {
    applyHyteSettingsToUI(await daylist.setHyteSettings({ buttonScale: parseFloat(e.target.value) }));
  });

  $('#btn-newday-main').addEventListener('click', () => startNewDay(false));
  $('#btn-standup').addEventListener('click', openStandup);
  $('#set-standup-enabled').addEventListener('change', async (e) => {
    applySettingsToUI(await daylist.setStandupEnabled(e.target.checked));
  });
  $('#set-standup-weekends').addEventListener('change', async (e) => {
    applySettingsToUI(await daylist.setStandupIncludeWeekends(e.target.checked));
  });
  $('#set-standup-morning').addEventListener('change', (e) => {
    state.meta = state.meta || {};
    state.meta.standupMorning = e.target.checked;
    save();
  });
  $('#standup-close').addEventListener('click', () => $('#standup-modal').classList.add('hidden'));
  $('#standup-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'standup-modal') $('#standup-modal').classList.add('hidden'); });
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ta = document.getElementById(btn.dataset.copy);
      if (!ta) return;
      await daylist.copyText(ta.value);
      const orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1500);
    });
  });
  $('#day-prompt-go').addEventListener('click', () => startNewDay(true));
  $('#day-prompt-dismiss').addEventListener('click', () => { markDay(); hideDayPrompt(); save(); });

  // Detail sidebar
  $('#detail-backdrop').addEventListener('click', closeDetail);
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail-delete').addEventListener('click', () => { if (selectedId) deleteTask(selectedId); });
  $('#detail-title').addEventListener('input', (e) => { const t = byId(selectedId); if (t) { t.title = e.target.value; save(); render(); } });
  $('#detail-priority').addEventListener('change', (e) => { const t = byId(selectedId); if (t) { t.priority = e.target.value; save(); render(); } });
  $('#detail-notes').addEventListener('input', (e) => {
    const t = byId(selectedId);
    if (!t) return;
    const source = $('#detail-source').classList.contains('hidden') ? null : $('#detail-source-text').textContent;
    t.notes = source ? source + '\n' + e.target.value : e.target.value;
    save();
  });
  $('#detail-reminder').addEventListener('click', (e) => { if (selectedId) openReminder(selectedId, e.currentTarget); });
  $('#detail-current').addEventListener('click', () => { if (selectedId) setCurrent(selectedId); });
  $('#detail-personal').addEventListener('click', () => { if (selectedId) togglePersonal(selectedId); });
  $('#detail-complete').addEventListener('click', () => { const t = byId(selectedId); if (t) toggleDone(t.id, !t.done); });
  $('#detail-claude').addEventListener('click', () => { if (selectedId) askClaude(selectedId); });

  // Archive modal
  $('#archive-close').addEventListener('click', () => $('#archive-modal').classList.add('hidden'));
  $('#archive-clear').addEventListener('click', () => {
    if ((state.archive || []).length && confirm('Permanently delete all archived tasks?')) {
      state.archive = []; save(); openArchive();
    }
  });
  $('#archive-modal').addEventListener('mousedown', (e) => { if (e.target.id === 'archive-modal') $('#archive-modal').classList.add('hidden'); });

  // High alert
  $('#alert-dismiss').addEventListener('click', dismissHighAlert);

  // Reminder popover
  $('#reminder-save').addEventListener('click', saveReminder);
  $('#reminder-clear').addEventListener('click', clearReminder);
  document.querySelectorAll('.preset').forEach((b) => b.addEventListener('click', () => applyPreset(b.dataset.preset)));
  document.addEventListener('mousedown', (e) => {
    const pop = $('#reminder-pop');
    if (!pop.classList.contains('hidden') && !pop.contains(e.target)) {
      if (!e.target.closest('.reminder-badge') && !e.target.closest('.mini-btn') && !e.target.closest('#detail-reminder')) closeReminder();
    }
  });

  Object.values(lists).forEach(setupListDnD);

  // Collapsible section headers
  document.querySelectorAll('.group-header').forEach((h) => {
    h.addEventListener('click', () => {
      const sec = h.closest('.prio-group');
      if (sec) toggleCollapse(sec.dataset.priority);
    });
  });
}

window.addEventListener('DOMContentLoaded', init);
