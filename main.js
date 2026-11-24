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
let tvWin = null;
let tvTargetId = 'auto';
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

// TV for the post-match photo slideshow: the chosen screen, or any screen that is neither the laptop nor the scoreboard
function tvDisplay() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  if (tvTargetId !== 'auto') {
    const chosen = all.find(d => String(d.id) === String(tvTargetId));
    if (chosen) return chosen;
  }
  const board = scoreboardDisplay();
  return all.find(d => d.id !== primary.id && (!board || d.id !== board.id)) || null;
}
function placeFull(win, d) {
  if (!d) { win.setBounds({ width: 960, height: 560 }); win.center(); return; }
  win.setBounds(d.bounds);
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setBounds(d.bounds);
    if (process.platform === 'darwin') win.setSimpleFullScreen(true); else win.setFullScreen(true);
  }, 150);
}

// ---------- photos from camera cards ----------
const PHOTO_EXT = /\.(jpe?g|nef)$/i;
const allowedRoots = new Set();
function cardRoots() {
  const out = [];
  const add = (name, root, volume) => {
    try { if (fs.statSync(root).isDirectory()) { out.push({ name, root, volume }); allowedRoots.add(path.resolve(root)); } } catch (e) {}
  };
  if (process.platform === 'darwin') {
    let vols = [];
    try { vols = fs.readdirSync('/Volumes'); } catch (e) {}
    for (const v of vols) add(v, path.join('/Volumes', v, 'DCIM'), path.join('/Volumes', v));
  } else if (process.platform === 'win32') {
    for (const L of 'DEFGHIJKLMNOPQRSTUVWXYZ') add(`Card (${L}:)`, `${L}:\\DCIM`, `${L}:\\`);
  } else {
    for (const base of ['/media', '/run/media']) {
      let users = [];
      try { users = fs.readdirSync(base); } catch (e) {}
      for (const u of users) {
        let vols = [];
        try { vols = fs.readdirSync(path.join(base, u)); } catch (e) {}
        for (const v of vols) add(v, path.join(base, u, v, 'DCIM'), path.join(base, u, v));
      }
    }
  }
  return out;
}
function allowedPath(p) {
  const r = path.resolve(String(p));
  for (const a of allowedRoots) if (r === a || r.startsWith(a + path.sep)) return true;
  return false;
}
async function listPhotos(root) {
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 6) return;
    let ents = [];
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (PHOTO_EXT.test(e.name)) {
        try { const st = await fs.promises.stat(p); out.push({ path: p, size: st.size, mtime: st.mtimeMs }); } catch (err) {}
      }
    }
  };
  await walk(root, 0);
  return out;
}
let lastCards = '';
function watchCards() {
  const cards = cardRoots();
  const sig = cards.map(c => c.root).join('|');
  if (sig !== lastCards) {
    const before = new Set(lastCards ? lastCards.split('|') : []);
    const added = lastCards === '' ? [] : cards.filter(c => !before.has(c.root));   // nothing counts as "new" at start-up
    lastCards = sig || ' ';
    if (control && !control.isDestroyed()) control.webContents.send('cards-changed', { cards, added });
  }
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
    home: parseInt(r[col('home_club')], 10) || (/^(y|yes|true)$/i.test(r[col('home_club')] || '') ? 99 : 0),
    tryVideo: r[col('try_video')] || '',
    convVideo: r[col('conversion_video')] || '',
    tryMusic: r[col('try_music')] || '',
    tryMusicStart: parseFloat(r[col('try_music_start')]) || 0,
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
    if (frameName && frameName.startsWith('rugbySB_tv')) {
      const d = tvDisplay();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...(d ? { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height } : { width: 960, height: 560 }),
          frame: !d, title: 'Photos on TV', backgroundColor: '#000000', autoHideMenuBar: true,
          fullscreenable: true, show: true,
          webPreferences: { backgroundThrottling: false },
        },
      };
    }
    if (url && /^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  control.webContents.on('did-create-window', (win, details) => {
    if (details.frameName && details.frameName.startsWith('rugbySB_tv')) {
      tvWin = win;
      placeFull(win, tvDisplay());
      win.on('closed', () => { if (tvWin === win) tvWin = null; });
      return;
    }
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
  control.on('closed', () => {
    control = null;
    if (output && !output.isDestroyed()) output.close();
    if (tvWin && !tvWin.isDestroyed()) tvWin.close();
    app.quit();
  });
}

// ---------- IPC ----------
ipcMain.handle('displays', () => displayInfo());
ipcMain.handle('set-target', (_e, id) => { targetId = id || 'auto'; return displayInfo(); });
ipcMain.handle('set-practice', (_e, on) => { practice = !!on; return true; });
ipcMain.handle('clubs', () => readClubs());
ipcMain.handle('badge', (_e, file) => fs.readFileSync(path.join(clubsDir, 'badges', path.basename(String(file)))));
ipcMain.handle('asset', (_e, folder, file) => {
  if (!['badges', 'videos', 'sponsors', 'music'].includes(folder)) throw new Error('bad folder');
  const f = path.join(clubsDir, folder, path.basename(String(file)));
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
});
ipcMain.handle('global-keys', (_e, on) => setGlobalKeys(!!on));
// photos
ipcMain.handle('photo-cards', () => { const c = cardRoots(); lastCards = c.map(x => x.root).join('|') || ' '; return c; });
ipcMain.handle('photo-choose-folder', async () => {
  const r = await dialog.showOpenDialog(control, { properties: ['openDirectory'], title: 'Choose a folder of photos (or a card)' });
  if (r.canceled || !r.filePaths[0]) return null;
  const root = path.resolve(r.filePaths[0]);
  allowedRoots.add(root);
  return { name: path.basename(root), root, volume: null };
});
ipcMain.handle('photo-list', async (_e, root) => {
  if (!allowedPath(root)) throw new Error('not allowed');
  return listPhotos(path.resolve(root));
});
ipcMain.handle('photo-read', async (_e, p, off, len) => {
  if (!allowedPath(p)) throw new Error('not allowed');
  const fh = await fs.promises.open(path.resolve(p), 'r');
  try {
    const n = Math.max(0, Math.min(Number(len) || 0, 64 * 1024 * 1024));
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, Math.max(0, Number(off) || 0));
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
});
ipcMain.handle('set-tv-target', (_e, id) => { tvTargetId = id || 'auto'; const d = tvDisplay(); return d ? d.id : null; });
const REPO = 'Joemccann-ux/rugby-scoreboard';
function currentBuild() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'app', 'build.json'), 'utf8')).build || 0; } catch (e) { return 0; }
}
ipcMain.handle('check-update', async () => {
  const current = currentBuild();
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'rugby-scoreboard-app', Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { current, latest: 0 };
    const j = await r.json();
    const latest = parseInt(String(j.tag_name || '').replace(/\D+/g, ''), 10) || 0;
    const want = process.platform === 'darwin' ? /Mac\.zip$/ : /Windows-Setup\.exe$/;
    const asset = (j.assets || []).find(a => want.test(a.name));
    return { current, latest, page: j.html_url, download: asset ? asset.browser_download_url : j.html_url };
  } catch (e) { return { current, latest: 0 }; }
});
ipcMain.handle('open-download', (_e, url) => {
  if (/^https:\/\/github\.com\//.test(String(url))) shell.openExternal(url);
  return true;
});

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
  setInterval(watchCards, 2500);   // notice camera cards being plugged in
});
app.on('second-instance', () => { if (control) { if (control.isMinimized()) control.restore(); control.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
