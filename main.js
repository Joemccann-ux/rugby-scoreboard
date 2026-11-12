// Rugby Scoreboard – desktop app (Electron)
// The control screen opens on the laptop. When a second screen (the scoreboard
// scaler) is connected, the scoreboard picture goes full screen on it automatically.
// Nothing happens to your screens unless the app is open.
const { app, BrowserWindow, screen, ipcMain, powerSaveBlocker, globalShortcut, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) { app.quit(); }

let control = null;
let output = null;
let targetId = 'auto';
let practice = false;
let quitting = false;

const clubsDir = app.isPackaged ? path.join(process.resourcesPath, 'clubs') : path.join(__dirname, 'clubs');

// ---------- displays ----------
function scoreboardDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (targetId !== 'auto') {
    const chosen = all.find(d => String(d.id) === String(targetId));
    if (chosen) return chosen;
  }
  return all.find(d => d.id !== primary.id) || null;
}
function displayInfo() {
  const primary = screen.getPrimaryDisplay();
  const target = scoreboardDisplay();
  return {
    target: target ? target.id : null,
    displays: screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: d.label || (d.id === primary.id ? 'Laptop screen' : `Screen ${i + 1}`),
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      primary: d.id === primary.id,
    })),
  };
}
function sendDisplays() {
  if (control && !control.isDestroyed()) control.webContents.send('displays-changed', displayInfo());
}
function placeOutput(win) {
  const d = practice ? null : scoreboardDisplay();
  if (!d) { // practice window on the laptop
    win.setBounds({ width: 960, height: 560 });
    win.center();
    return;
  }
  win.setBounds(d.bounds);
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setBounds(d.bounds);
    if (process.platform === 'darwin') win.setSimpleFullScreen(true); // instant, hides the menu bar, no new Space
    else win.setFullScreen(true);
  }, 150);
}

// ---------- clubs ----------
function readClubs() {
  const file = path.join(clubsDir, 'clubs.csv');
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const split = l => {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim()); return out;
  };
  const head = split(lines[0]).map(h => h.toLowerCase());
  const col = n => head.indexOf(n);
  return lines.slice(1).map(split).map(r => ({
    key: (r[col('club_name')] || '').toLowerCase(),
    name: r[col('club_name')] || '',
    board: (r[col('board_name')] || r[col('club_name')] || '').toUpperCase(),
    badge: r[col('badge_file')] || '',
    nameColour: /^#[0-9a-f]{6}$/i.test(r[col('name_colour')] || '') ? r[col('name_colour')] : '#ffffff',
    colour: /^#[0-9a-f]{6}$/i.test(r[col('team_colour')] || '') ? r[col('team_colour')] : '#2f7df6',
    tryVideo: r[col('try_video')] || '',
    convVideo: r[col('conversion_video')] || '',
    sponsors: (r[col('sponsors')] || '').split(/[;|]/).map(x => x.trim()).filter(Boolean),
  })).filter(c => c.name).sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- number pad keys that work in the background ----------
const PAD = { num0: 'Numpad0', num1: 'Numpad1', num2: 'Numpad2', num3: 'Numpad3', num4: 'Numpad4', num5: 'Numpad5',
  num6: 'Numpad6', num7: 'Numpad7', num8: 'Numpad8', num9: 'Numpad9', numdec: 'NumpadDecimal', numadd: 'NumpadAdd',
  nummult: 'NumpadMultiply', numdiv: 'NumpadDivide' };
function setGlobalKeys(on) {
  globalShortcut.unregisterAll();
  if (!on) return true;
  for (const [acc, code] of Object.entries(PAD)) {
    try { globalShortcut.register(acc, () => control && control.webContents.send('global-key', code)); } catch (e) {}
  }
  return true;
}

// ---------- windows ----------
function createControl() {
  control = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 700,
    title: 'Rugby Scoreboard',
    backgroundColor: '#14161a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'app', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  control.loadFile(path.join(__dirname, 'app', 'index.html'));

  control.webContents.setWindowOpenHandler(({ frameName, url }) => {
    if (frameName && frameName.startsWith('rugbySB_output')) {
      const d = practice ? null : scoreboardDisplay();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...(d ? { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height } : { width: 960, height: 560 }),
          frame: !d, title: 'Scoreboard output', backgroundColor: '#000000', autoHideMenuBar: true,
          fullscreenable: true, show: true,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (url && /^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  control.webContents.on('did-create-window', (win, details) => {
    if (!details.frameName || !details.frameName.startsWith('rugbySB_output')) return;
    output = win;
    placeOutput(win);
    win.on('closed', () => { if (output === win) output = null; });
  });

  control.on('close', e => {
    if (quitting) return;
    const choice = dialog.showMessageBoxSync(control, {
      type: 'question', buttons: ['Close', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Close Rugby Scoreboard?', detail: 'The scoreboard will go blank.',
    });
    if (choice !== 0) { e.preventDefault(); return; }
    quitting = true;
  });
  control.on('closed', () => { control = null; if (output && !output.isDestroyed()) output.close(); app.quit(); });
}

// ---------- IPC ----------
ipcMain.handle('displays', () => displayInfo());
ipcMain.handle('set-target', (_e, id) => { targetId = id || 'auto'; return displayInfo(); });
ipcMain.handle('set-practice', (_e, on) => { practice = !!on; return true; });
ipcMain.handle('clubs', () => readClubs());
ipcMain.handle('badge', (_e, file) => fs.readFileSync(path.join(clubsDir, 'badges', path.basename(String(file)))));
ipcMain.handle('asset', (_e, folder, file) => {
  if (!['badges', 'videos', 'sponsors'].includes(folder)) throw new Error('bad folder');
  const f = path.join(clubsDir, folder, path.basename(String(file)));
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
});
ipcMain.handle('global-keys', (_e, on) => setGlobalKeys(!!on));

// ---------- start ----------
app.whenReady().then(() => {
  powerSaveBlocker.start('prevent-display-sleep');   // stop the screens sleeping while the app is open
  createControl();
  const changed = () => {
    if (!practice && !scoreboardDisplay() && output && !output.isDestroyed()) output.close();
    sendDisplays();
  };
  screen.on('display-added', changed);
  screen.on('display-removed', changed);
  screen.on('display-metrics-changed', sendDisplays);
});
app.on('second-instance', () => { if (control) { if (control.isMinimized()) control.restore(); control.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
