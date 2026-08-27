# Building DayList for macOS

## Option A: let CI build it (no Mac required to build)

Once this repo is pushed to GitHub, `.github/workflows/build.yml` builds both the Windows
installers and the Mac `.dmg`s automatically on GitHub's own macOS runners — you don't need
to touch a Mac to produce the build. To trigger it:

- Push a version tag: `git tag v1.0.0 && git push origin v1.0.0` — this also creates a GitHub
  Release with all installers attached, or
- Run it manually from the GitHub UI: **Actions → Build DayList installers → Run workflow**
  (no tag needed; installers are attached to the run as downloadable artifacts).

Caveat: because the `.dmg` is downloaded from the internet rather than built locally,
Gatekeeper **will** quarantine it on first open — same "unidentified developer" prompt
described in step 4 below (right-click → Open, or `xattr -cr`). Building locally on a Mac
(Option B) is the only way to avoid that prompt without paying for a Developer ID cert.

## Option B: build it yourself on a Mac

Do this **on the Mac** (a `.dmg` can only be built on macOS).

## 1. Get the project onto the Mac
Copy the DayList project folder to the Mac — **but do NOT copy `node_modules` or `dist`**
(the Windows `node_modules` contains a Windows Electron binary and won't work on macOS).

Easiest: copy the folder, then delete `node_modules` and `dist` on the Mac. Or copy just the
source files: `main.js`, `preload.js`, `package.json`, `assets/`, `src/`, and (optional)
`DayList.mcpb`, the `.md` docs.

## 2. Install Node.js (once)
If `node -v` doesn't work in Terminal, install Node from https://nodejs.org (LTS).

## 3. Install dependencies and build
Open Terminal, `cd` into the DayList folder, then:

```bash
npm install
npm run dist:mac
```

- If `npm install` prints a message about a blocked install script for `electron`, run
  `npm approve-scripts electron` (or `npm install` again) so the Electron binary downloads.
- `npm run dist:mac` produces disk images in `dist/`:
  - `DayList-1.0.0-arm64.dmg`  (Apple Silicon — M1/M2/M3)
  - `DayList-1.0.0-x64.dmg`    (older Intel Macs)

## 4. Install / run
Open the `.dmg` that matches the Mac, drag **DayList** to **Applications**, and launch it.

Because you built it locally, macOS Gatekeeper won't quarantine it, so it should open
directly. If it ever refuses ("unidentified developer"), **right-click the app → Open →
Open** once, or run: `xattr -cr /Applications/DayList.app`.

## Notes
- Data is stored at `~/Desktop/DayList/tasks.json` (same layout as Windows).
- Everything works the same: reminders, projects, timer, standup, tray (menu-bar) icon,
  always-on-top, run-on-startup.
- The build is **unsigned**. That's fine for your own machines. To distribute a Mac build
  to others without Gatekeeper warnings you'd need an Apple Developer ID certificate
  (`$99/yr`) and notarization — a separate step we can add later.
- To build for only your Mac's chip and go faster, use `npx electron-builder --mac dmg --arm64`
  (Apple Silicon) or `--x64` (Intel).
