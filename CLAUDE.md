# DayList — how Claude edits the task list

The DayList desktop app reads and writes a single JSON file. To add, change, complete,
reorder, or remove tasks, **edit this file directly**:

```
C:\Users\caleb\Desktop\DayList\tasks.json
```

The running app watches this file and updates its window live (usually within a second).
The app also writes to this file when the user edits in the UI — always read the current
contents first, then write back the full object.

## Schema

```jsonc
{
  "tasks": [
    {
      "id": "t_abc123",            // unique string; generate any unique value for new tasks
      "title": "Call the supplier", // the task text (shown in the widget)
      "priority": "high",          // "high" | "medium" | "low"
      "done": false,               // true = shows under Completed
      "current": false,            // true = the ONE active task (green highlight); keep only one true
      "reminder": "2026-08-27T14:30:00.000Z", // ISO datetime, or null for none
      "reminderFired": false,      // set false when you set/replace a reminder so it alerts
      "notes": "",                 // optional free text, shown in the task's detail sidebar
      "createdAt": "2026-08-27T08:00:00.000Z",
      "completedAt": null,         // set automatically when completed
      "archivedAt": null           // set automatically when archived
    }
  ],
  "archive": [],                   // completed tasks moved here by "Start a new day"; same shape
  "recurring": [                   // templates that auto-add a task each matching day
    {
      "id": "r_abc",
      "title": "Check ClickUp",
      "priority": "medium",
      "notes": "",
      "freq": "daily",             // "daily" | "weekdays" | "weekly"
      "days": [1,3,5],             // for weekly only: 0=Sun..6=Sat
      "lastAdded": "2026-08-27"    // last date an instance was added (prevents duplicates)
    }
  ],
  "meta": { "lastOpened": "2026-08-27" }
}
```

**Projects:** each project is a separate store at `projects\<projectId>.json` with the same
schema, indexed in `projects.json`. The MCP connector (v1.2.0+) can target a project via the
`project` argument on the task/recurring tools, and has `list_projects` / `create_project`.
You can also edit any project file directly.

**Current Focus:** the task with `current:true` is lifted into a "Current Focus" section at
the top of the list and everything else dims. Keep only one task `current` at a time.

## Reminder priority behaviour

The reminder's alert style follows the task's `priority`:
- **low** — subtle, silent Windows toast + soft in-app tone.
- **medium** — normal toast with sound.
- **high** — urgent toast, the window is forced to the front and flashes, and an in-app
  alert stays on screen (with a repeating urgent tone) until the user clicks Dismiss.

So to make a reminder more noticeable, set the task `priority` to `high`.

## Rules

- **Order matters**: tasks appear in the widget in array order, grouped by `priority`.
  To move a task up, move its object earlier in the `tasks` array.
- **New task**: append an object with a unique `id`. Only `title` is truly required;
  missing fields are filled with sensible defaults by the app.
- **Complete a task**: set `"done": true`.
- **Add a reminder**: set `reminder` to an ISO datetime and `reminderFired` to `false`.
  The app fires a native Windows notification (with sound) at that time.
- **Delete a task**: remove its object from the array.
- Always write valid JSON (the app keeps the last good copy if a write is malformed).
