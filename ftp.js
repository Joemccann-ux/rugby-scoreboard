// Tiny FTP server so a camera (e.g. Nikon Z9 "Connect to FTP server") can send photos straight to the app.
// Supports what cameras use: USER/PASS, PWD/CWD/MKD, TYPE, PASV/EPSV/PORT, STOR, plus harmless extras.
// Files are written into one folder; onFile(path) is called when an upload finishes.
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

function localAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

class CameraFtp {
  constructor(opts) {
    this.port = opts.port || 2121;
    this.user = opts.user || 'scoreboard';
    this.pass = opts.pass || '';
    this.folder = opts.folder;
    this.onFile = opts.onFile || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.server = null;
    this.pasvMin = 50000; this.pasvMax = 50100;
  }

  start() {
    return new Promise((resolve, reject) => {
      fs.mkdirSync(this.folder, { recursive: true });
      const srv = net.createServer(sock => this.session(sock));
      srv.on('error', reject);
      srv.listen(this.port, '0.0.0.0', () => { this.server = srv; srv.removeListener('error', reject); resolve(); });
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch (e) {} this.server = null; }
  }

  session(sock) {
    sock.setEncoding('binary');
    let buf = '', authed = false, user = null, cwd = '/', data = null, pasvSrv = null, rnfr = null, restOffset = 0;
    const peer = sock.remoteAddress;
    const reply = (code, msg) => { try { sock.write(`${code} ${msg}\r\n`); } catch (e) {} };
    const closePasv = () => { if (pasvSrv) { try { pasvSrv.close(); } catch (e) {} pasvSrv = null; } };
    this.onEvent({ type: 'connect', peer });
    reply(220, 'Rugby Scoreboard photo receiver ready');

    // data connection: resolves with a socket (passive or active)
    const getData = () => new Promise((resolve, reject) => {
      if (!data) return reject(new Error('no data connection'));
      if (data.socket) return resolve(data.socket);
      data.waiters.push(resolve);
      setTimeout(() => reject(new Error('data connection timeout')), 15000);
    });

    const openPasv = () => new Promise(resolve => {
      closePasv();
      data = { socket: null, waiters: [] };
      const d = data;
      const tryPort = (p) => {
        const s = net.createServer(ds => {
          d.socket = ds; d.waiters.splice(0).forEach(w => w(ds));
          s.close();
        });
        s.on('error', () => (p < this.pasvMax ? tryPort(p + 1) : resolve(null)));
        s.listen(p, '0.0.0.0', () => { pasvSrv = s; resolve(p); });
      };
      tryPort(this.pasvMin + Math.floor(Math.random() * 50));
    });

    const safeName = n => path.basename(String(n || '').replace(/\\/g, '/')).replace(/[^\w.\- ()]/g, '_') || `photo-${Date.now()}.jpg`;

    const handle = async (line) => {
      const sp = line.indexOf(' ');
      const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp < 0 ? '' : line.slice(sp + 1);
      if (!authed && !['USER', 'PASS', 'QUIT', 'FEAT', 'SYST', 'OPTS', 'NOOP', 'AUTH'].includes(cmd)) return reply(530, 'Please log in');
      switch (cmd) {
        case 'USER':
          user = arg;
          if (user.toLowerCase() === 'anonymous' && !this.pass) { authed = true; return reply(230, 'Logged in'); }
          return reply(331, 'Password please');
        case 'PASS':
          if (!this.pass || (user === this.user && arg === this.pass)) { authed = true; this.onEvent({ type: 'login', peer }); return reply(230, 'Logged in'); }
          this.onEvent({ type: 'badlogin', peer });
          return reply(530, 'Wrong user name or password');
        case 'AUTH': return reply(502, 'TLS not supported – use plain FTP');
        case 'SYST': return reply(215, 'UNIX Type: L8');
        case 'FEAT': try { sock.write('211-Features:\r\n PASV\r\n EPSV\r\n SIZE\r\n UTF8\r\n211 End\r\n'); } catch (e) {} return;
        case 'OPTS': return reply(200, 'OK');
        case 'NOOP': return reply(200, 'OK');
        case 'TYPE': return reply(200, 'Type set');
        case 'MODE': case 'STRU': return reply(200, 'OK');
        case 'PWD': case 'XPWD': return reply(257, `"${cwd}" is the current directory`);
        case 'CWD': case 'XCWD':
          cwd = arg.startsWith('/') ? arg : path.posix.join(cwd, arg || '');
          return reply(250, 'OK');
        case 'CDUP': case 'XCUP': cwd = path.posix.dirname(cwd); return reply(250, 'OK');
        case 'MKD': case 'XMKD': return reply(257, `"${arg}" created`);
        case 'RMD': case 'XRMD': return reply(250, 'OK');
        case 'DELE': return reply(250, 'OK');
        case 'ALLO': return reply(202, 'OK');
        case 'REST': restOffset = parseInt(arg, 10) || 0; return reply(350, 'OK');
        case 'SIZE': {
          const f = path.join(this.folder, safeName(arg));
          try { return reply(213, String(fs.statSync(f).size)); } catch (e) { return reply(550, 'No such file'); }
        }
        case 'MDTM': return reply(550, 'Not available');
        case 'RNFR': rnfr = safeName(arg); return reply(350, 'OK');
        case 'RNTO': {
          const from = path.join(this.folder, rnfr || ''), to = path.join(this.folder, safeName(arg));
          try { fs.renameSync(from, to); this.onFile(to); } catch (e) {}
          rnfr = null; return reply(250, 'OK');
        }
        case 'PASV': {
          const p = await openPasv();
          if (!p) return reply(425, 'No free port');
          const ip = (sock.localAddress || '127.0.0.1').replace(/^::ffff:/, '').split('.');
          return reply(227, `Entering Passive Mode (${ip.join(',')},${p >> 8},${p & 255})`);
        }
        case 'EPSV': {
          const p = await openPasv();
          if (!p) return reply(425, 'No free port');
          return reply(229, `Entering Extended Passive Mode (|||${p}|)`);
        }
        case 'PORT': {
          closePasv();
          const n = arg.split(',').map(Number);
          if (n.length !== 6) return reply(501, 'Bad PORT');
          const host = n.slice(0, 4).join('.'), port = n[4] * 256 + n[5];
          data = { socket: null, waiters: [], active: { host, port } };
          return reply(200, 'PORT OK');
        }
        case 'EPRT': {
          closePasv();
          const parts = arg.split(arg[0]);   // |1|host|port|
          data = { socket: null, waiters: [], active: { host: parts[2], port: parseInt(parts[3], 10) } };
          return reply(200, 'EPRT OK');
        }
        case 'LIST': case 'NLST': case 'MLSD': {
          try {
            const ds = await this.connectData(data, getData);
            reply(150, 'Here comes the listing');
            ds.end('', () => { reply(226, 'Done'); });
          } catch (e) { reply(425, 'Data connection failed'); }
          data = null; closePasv();
          return;
        }
        case 'APPE': case 'STOR': case 'STOU': {
          const name = cmd === 'STOU' ? `photo-${Date.now()}.jpg` : safeName(arg);
          const dest = path.join(this.folder, name);
          const part = dest + '.part';
          let ds;
          try { ds = await this.connectData(data, getData); }
          catch (e) { reply(425, 'Data connection failed'); data = null; closePasv(); return; }
          reply(150, 'Ready to receive');
          this.onEvent({ type: 'receiving', peer, name });
          const flags = (cmd === 'APPE' || restOffset > 0) ? 'a' : 'w';
          const out = fs.createWriteStream(part, { flags });
          restOffset = 0;
          ds.pipe(out);
          let failed = false;
          ds.on('error', () => { failed = true; });
          out.on('error', () => { failed = true; });
          out.on('close', () => {
            if (failed) { reply(451, 'Transfer failed'); this.onEvent({ type: 'failed', peer, name }); return; }
            try { fs.renameSync(part, dest); } catch (e) {}
            reply(226, 'Transfer complete');
            this.onFile(dest);
          });
          data = null; closePasv();
          return;
        }
        case 'RETR': return reply(550, 'Downloads are not available');
        case 'QUIT': reply(221, 'Bye'); try { sock.end(); } catch (e) {} return;
        default: return reply(502, 'Not implemented');
      }
    };

    // run commands one at a time, in order
    let chain = Promise.resolve();
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) chain = chain.then(() => handle(Buffer.from(line, 'binary').toString('utf8'))).catch(() => {});
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => { closePasv(); this.onEvent({ type: 'disconnect', peer }); });
  }

  connectData(data, getData) {
    if (data && data.active && !data.socket) {
      return new Promise((resolve, reject) => {
        const s = net.connect(data.active.port, data.active.host, () => resolve(s));
        s.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 15000);
      });
    }
    return getData();
  }
}

module.exports = { CameraFtp, localAddresses };
