# DayList

A compact, always-on-top daily to-do widget for Windows. Native `.exe`, drag-and-drop
priorities, tick-off, native reminder notifications, and live sync with Claude.

## Running it

- **Portable (no install):** double-click `dist\DayList-Portable.exe`.
- **Installer:** run `dist\DayList Setup 1.0.0.exe` (creates Start-menu + desktop shortcuts).

The app lives in the tray (checkmark icon). Click the tray icon to show/hide.
Closing the window hides it to the tray; **Quit** from the tray menu to fully exit.

## Using it

- **Add** — type in the box, pick a priority, press Enter.
- **Complete** — click the checkbox (moves to Completed).
- **Open a task** — click it to slide out the **detail sidebar** (edit title, priority,
  notes, reminder; mark it the **Current task**; or **Ask Claude for help**).
- **Reorder / re-prioritise** — drag a task within a group or into another group.
  Dragging into *Completed* marks it done.
- **Reminder** — hover a task and click ⏰ (or the reminder button in the sidebar).
  Quick presets (+1 hr, +3 hr, 6 pm, tomorrow 9 am) or pick an exact time, then **Set reminder**.
- **Current task** — in the sidebar, "Set as current task" highlights that task **green**
  so the one thing you're focused on stands out.
- **Ask Claude for help** — opens Claude with the task (and your notes) as a prompt, and
  copies the same prompt to your clipboard as a fallback (paste with Ctrl+V).
- **Start a new day** — button above the add box (and an auto-prompt the first time you
  open it on a new day). Moves completed tasks to the **Archive** and keeps unfinished ones.
- **Archive** — ⚙ → *View archive* to review past completed tasks and their notes; restore
  or delete any of them.
- **Settings** (⚙) — Always on top, Run on startup, window Opacity, show/hide Completed.

### Reminder urgency by priority

- **Low** — subtle, silent notification + soft tone.
- **Medium** — normal notification with sound.
- **High** — urgent notification, the window jumps to the front and flashes, and an on-screen
  alert keeps sounding until you click **Dismiss**.

## Always on top & Run on startup

Both are toggles in the ⚙ settings panel *and* in the tray right-click menu.
"Run on startup" registers the app with Windows so it launches when you log in.

## Claude Desktop extension (connector)

`DayList.mcpb` is a one-click Claude Desktop extension that lets the Claude desktop app
read and edit your list. Because the widget watches `tasks.json`, anything Claude changes
shows up live.

**Install:** in DayList, open ⚙ settings → **Connect to Claude app**. That opens Claude
Desktop and reveals the bundled `DayList.mcpb` ready to drag. Then in Claude Desktop go to
**Settings → Extensions**, drop the file in (or use **Install Extension…**), and **Install**.
The "DayList tasks file" setting already defaults to the right path, so you can leave it.
Then start a chat and ask things like *"add 'call the dealer' as high priority, remind me at
5pm"* or *"what's left on my list today?"*.

(There's no fully silent install: Windows has no `.mcpb` association and Claude Desktop
requires you to confirm the extension — the button just gets you one drag away.)

Tools it adds: `list_tasks`, `add_task`, `update_task`, `complete_task`, `set_current_task`,
`delete_task`, `view_archive`.

The extension is rebuilt from `extension-build/` with:
```bash
npx @anthropic-ai/mcpb pack extension-build DayList.mcpb
```
The MCP server source lives in `mcp/` (`npm install` there for local dev).

## Claude sync (file)

Everything is stored in a single file the app watches live:

```
C:\Users\caleb\Desktop\DayList\tasks.json
```

Ask Claude (in this folder) to add, change, complete, reorder, or remove tasks — it edits
that file and the widget updates within a second. Schema and rules are in `CLAUDE.md`.

## Rebuilding

```bash
npm install       # first time (approve the electron install script if prompted)
npm start         # run in dev
npm run dist       # rebuild the .exe files into dist/
node assets/make-icon.js   # regenerate the app icon
```
