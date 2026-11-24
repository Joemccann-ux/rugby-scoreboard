/* =====================================================================
   POST-MATCH PHOTOS
   Plug a camera card in → every photo's focus is checked, the sharpest
   frame of each burst is kept → slideshow on the scoreboard, a TV, or both.
   Runs inside the control window; uses the globals from index.html
   (state, S_, save, stages, toast, $, esc, stopReel, stopMusic, updateNP…).
   ===================================================================== */
(function(){
'use strict';
const API_ = window.sbApi || null;
const PH = { items:[], seen:new Set(), sources:[], cards:[], show:null, tvWin:null, tvLayer:0 };
const latin1Dec = new TextDecoder('latin1');
const latin1 = u8 => latin1Dec.decode(u8);

/* ---------- helpers ---------- */
async function pool(arr, n, fn){
  let i=0;
  await Promise.all(Array.from({length:Math.min(n,arr.length)}, async ()=>{ while(i<arr.length){ const x=arr[i++]; await fn(x); } }));
}
function fmtLeft(s){ s=Math.max(0,Math.round(s)); return s<60 ? `${s}s` : `${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`; }

/* ---------- worker pool: focus scores and screen-sized copies, off the main thread ---------- */
const WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, op, buf, orient, fromImage } = e.data;
  try {
    const blob = new Blob([buf], { type: 'image/jpeg' });
    if (op === 'score') {
      let bmp;
      try { bmp = await createImageBitmap(blob, { resizeWidth: 1024, resizeQuality: 'low', imageOrientation: 'none' }); }
      catch (err) { bmp = await createImageBitmap(blob); }
      const w = Math.min(1024, bmp.width), h = Math.max(8, Math.round(bmp.height * w / bmp.width));
      const c = new OffscreenCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0, w, h); bmp.close && bmp.close();
      const d = x.getImageData(0, 0, w, h).data;
      const g = new Float32Array(w * h);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      const TX = 6, TY = 4, s = new Float64Array(TX * TY), s2 = new Float64Array(TX * TY), n = new Float64Array(TX * TY);
      for (let y = 1; y < h - 1; y++) {
        const ty = Math.floor(y * TY / h) * TX, row = y * w;
        for (let xx = 1; xx < w - 1; xx++) {
          const i = row + xx;
          const L = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
          const t = ty + Math.floor(xx * TX / w);
          s[t] += L; s2[t] += L * L; n[t]++;
        }
      }
      const v = [];
      for (let t = 0; t < TX * TY; t++) if (n[t]) { const m = s[t] / n[t]; v.push(s2[t] / n[t] - m * m); }
      v.sort((a, b) => b - a);
      self.postMessage({ id, score: v.length ? (v[0] + (v[1] ?? v[0])) / 2 : 0 });
    } else {
      let bmp;
      try { bmp = await createImageBitmap(blob, { imageOrientation: fromImage ? 'from-image' : 'none' }); }
      catch (err) { bmp = await createImageBitmap(blob); }
      const o = fromImage ? 1 : (orient || 1), rot = o === 6 || o === 8;
      const W = rot ? bmp.height : bmp.width, H = rot ? bmp.width : bmp.height;
      const draw = async (maxW, maxH, q) => {
        const sc = Math.min(1, maxW / W, maxH / H);
        const cw = Math.max(1, Math.round(W * sc)), ch = Math.max(1, Math.round(H * sc));
        const c = new OffscreenCanvas(cw, ch), x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        let dw = cw, dh = ch;
        if (o === 6) { x.translate(cw, 0); x.rotate(Math.PI / 2); dw = ch; dh = cw; }
        else if (o === 8) { x.translate(0, ch); x.rotate(-Math.PI / 2); dw = ch; dh = cw; }
        else if (o === 3) { x.translate(cw, ch); x.rotate(Math.PI); }
        x.drawImage(bmp, 0, 0, dw, dh);
        return await c.convertToBlob({ type: 'image/jpeg', quality: q });
      };
      const main = await draw(1920, 1080, 0.9);
      const thumb = await draw(360, 240, 0.75);
      bmp.close && bmp.close();
      self.postMessage({ id, main, thumb });
    }
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};`;
const workers=[], waiting=[], jobs=new Map();
let jobId=0;
function ensureWorkers(){
  if(workers.length) return;
  const url=URL.createObjectURL(new Blob([WORKER_SRC],{type:'text/javascript'}));
  const n=Math.max(2, Math.min(6, (navigator.hardwareConcurrency||4)-2));
  for(let i=0;i<n;i++){
    const w=new Worker(url); w.busy=false;
    w.onmessage=e=>{ const j=jobs.get(e.data.id); jobs.delete(e.data.id); w.busy=false; if(j) (e.data.error ? j.reject(new Error(e.data.error)) : j.resolve(e.data)); nextJob(); };
    workers.push(w);
  }
}
function nextJob(){
  while(waiting.length){
    const w=workers.find(x=>!x.busy); if(!w) return;
    const j=waiting.shift(); w.busy=true; jobs.set(j.msg.id,j); w.postMessage(j.msg,[j.msg.buf]);
  }
}
function work(msg){ ensureWorkers(); return new Promise((resolve,reject)=>{ msg.id=++jobId; waiting.push({msg,resolve,reject}); nextJob(); }); }

/* ---------- reading photo files (through the app, so it works on Mac and Windows) ---------- */
async function readBytes(f, off, len){
  if(off>=f.size || len<=0) return new Uint8Array(0);
  return new Uint8Array(await API_.photoRead(f.path, off, Math.min(len, f.size-off)));
}
async function makeReader(f){
  const head=await readBytes(f, 0, Math.min(262144, f.size));
  return { size:f.size, head, async read(off,len){ if(off+len<=head.length) return head.subarray(off,off+len); return readBytes(f,off,len); } };
}
function setRating(info, v){ if(v==null || isNaN(v)) return; info.rating = info.rating==null ? v : Math.max(info.rating, v); }
function xmpRating(s, info){ const re=/xmp:Rating\s*=\s*["']?(-?\d)|<xmp:Rating>\s*(-?\d)/g; let m; while((m=re.exec(s))) setRating(info, +(m[1] ?? m[2])); }

const TSIZE={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4};
async function readTiff(r, base, info){
  const h=await r.read(base,8);
  const le=h[0]===0x49 && h[1]===0x49;
  if(!le && !(h[0]===0x4D && h[1]===0x4D)) return;
  const u16=(a,i)=> le ? (a[i]|a[i+1]<<8) : (a[i]<<8|a[i+1]);
  const u32=(a,i)=> (le ? (a[i]|a[i+1]<<8|a[i+2]<<16|a[i+3]<<24) : (a[i]<<24|a[i+1]<<16|a[i+2]<<8|a[i+3]))>>>0;
  const visited=new Set();
  const bytes=async e=>{ const sz=(TSIZE[e.type]||1)*e.count; return sz<=4 ? e.raw : await r.read(base+u32(e.raw,0), Math.min(sz, 2000000)); };
  const nums=async e=>{ const d=await bytes(e), w=TSIZE[e.type]||4, out=[]; for(let i=0;i<e.count && i<64;i++) out.push(w===2?u16(d,i*2):u32(d,i*4)); return out; };
  const str=async e=>latin1(await bytes(e)).replace(/\0+$/,'');
  async function ifd(off, kind, depth){
    if(!off || visited.has(off) || depth>4 || visited.size>24 || base+off+2>r.size) return;
    visited.add(off);
    const n=u16(await r.read(base+off,2),0);
    if(!n || n>500) return;
    const d=await r.read(base+off+2, n*12+4);
    const E={};
    for(let i=0;i<n;i++){ const p=i*12; E[u16(d,p)]={type:u16(d,p+2), count:u32(d,p+4), raw:d.subarray(p+8,p+12)}; }
    if(kind==='ifd0' && E[0x0112]) info.orientation=(await nums(E[0x0112]))[0];
    if(E[0x4746]) setRating(info,(await nums(E[0x4746]))[0]);
    if(E[0x02BC]) xmpRating(await str(E[0x02BC]), info);
    if(E[0x9003] && !info.date) info.date=await str(E[0x9003]);
    if(E[0x9291] && !info.subsec) info.subsec=await str(E[0x9291]);
    if(E[0x0201] && E[0x0202]) info.previews.push({off:base+(await nums(E[0x0201]))[0], len:(await nums(E[0x0202]))[0]});
    if(E[0x0103] && (await nums(E[0x0103]))[0]===6 && E[0x0111] && E[0x0117] && E[0x0111].count===1)
      info.previews.push({off:base+(await nums(E[0x0111]))[0], len:(await nums(E[0x0117]))[0]});
    if(E[0x8769]) await ifd((await nums(E[0x8769]))[0],'exif',depth+1);
    if(E[0x014A]) for(const o of await nums(E[0x014A])) await ifd(o,'sub',depth+1);
    if(kind==='ifd0' || kind==='next') await ifd(u32(d,n*12),'next',depth+1);
  }
  await ifd(u32(h,4),'ifd0',0);
}
function parseMPF(t, tiffStart){
  const le=t[0]===0x49;
  const u16=i=> le ? (t[i]|t[i+1]<<8) : (t[i]<<8|t[i+1]);
  const u32=i=> (le ? (t[i]|t[i+1]<<8|t[i+2]<<16|t[i+3]<<24) : (t[i]<<24|t[i+1]<<16|t[i+2]<<8|t[i+3]))>>>0;
  const ifd=u32(4), n=u16(ifd), out=[];
  for(let k=0;k<n;k++){
    const p=ifd+2+k*12;
    if(u16(p)===0xB002){ const cnt=u32(p+4), at=u32(p+8);
      for(let e=0;e+16<=cnt;e+=16){ const size=u32(at+e+4), o=u32(at+e+8); if(o>0 && size>1000) out.push({off:tiffStart+o, len:size}); } }
  }
  return out;
}
async function jpegInfo(f){
  const r=await makeReader(f);
  const info={rating:null, orientation:null, date:'', subsec:'', previews:[], mpf:null};
  if(r.head[0]!==0xFF || r.head[1]!==0xD8) throw new Error('not a JPEG');
  let off=2;
  while(off+4<=r.size){
    const m=await r.read(off,4);
    if(m[0]!==0xFF) break;
    const mk=m[1];
    if(mk===0xFF){ off++; continue; }
    if(mk===0xD8 || mk===0x01 || (mk>=0xD0 && mk<=0xD7)){ off+=2; continue; }
    if(mk===0xDA || mk===0xD9) break;
    const len=(m[2]<<8)|m[3];
    if(mk===0xE2 && !info.mpf){
      const seg=await r.read(off+4, Math.max(0,len-2));
      if(seg[0]===0x4D && seg[1]===0x50 && seg[2]===0x46 && seg[3]===0){ try{ info.mpf=parseMPF(seg.subarray(4), off+8); }catch(e){} }
    }
    if(mk===0xE1){
      const seg=await r.read(off+4, Math.max(0,len-2));
      if(seg[0]===0x45 && seg[1]===0x78 && seg[2]===0x69 && seg[3]===0x66) await readTiff(r, off+10, info);
      else { const s=latin1(seg); if(s.startsWith('http://ns.adobe.com/xap/1.0/')) xmpRating(s, info); }
    }
    off+=2+len;
  }
  xmpRating(latin1(r.head), info);
  return info;
}
async function nefInfo(f){
  const r=await makeReader(f);
  const info={rating:null, orientation:null, date:'', subsec:'', previews:[]};
  await readTiff(r,0,info);
  xmpRating(latin1(r.head), info);
  return info;
}
async function nefPreview(f, info){
  const cands=info.previews.filter(p=>p.len>1000 && p.off+p.len<=f.size).sort((a,b)=>b.len-a.len);
  for(const p of cands){
    const b=await readBytes(f, p.off, 3);
    if(b[0]===0xFF && b[1]===0xD8) return readBytes(f, p.off, p.len);
  }
  return null;
}
function sortKey(info, f){
  let d=info.date;
  if(!/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(d||'')){
    const t=new Date(f.mtime||Date.now()), p=n=>String(n).padStart(2,'0');
    d=`${t.getFullYear()}:${p(t.getMonth()+1)}:${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
  }
  const name=f.path.split(/[\\/]/).pop();
  return d.slice(0,19)+'.'+String(info.subsec||'').replace(/\D/g,'').padEnd(3,'0').slice(0,3)+' '+name;
}
function timeMs(key){
  const m=key.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)\.(\d{3})/);
  return m ? Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6],+m[7]) : 0;
}
const buf = u8 => u8.buffer.slice(u8.byteOffset, u8.byteOffset+u8.byteLength);

/* ---------- picking ---------- */
function autoPick(cands){
  const S=S_();
  const max=Math.max(0, +S.phMax||0);
  const ok=cands.filter(c=>c.score!=null && !(c.rating<0));
  if(!ok.length) return cands.filter(c=>c.rating>=1);
  const sorted=ok.map(c=>c.score).sort((a,b)=>a-b);
  const pct={relaxed:0.30, normal:0.50, strict:0.72}[S.phPick] ?? 0.5;
  const thr=sorted[Math.floor(pct*(sorted.length-1))];
  ok.sort((a,b)=>a.t-b.t);
  let chosen=[];
  if(S.phBurst){
    let grp=[];
    const flush=()=>{ if(grp.length){ const best=grp.reduce((a,b)=>b.score>a.score?b:a); if(best.score>=thr) chosen.push(best); } grp=[]; };
    for(const c of ok){ if(grp.length && (c.t-grp[grp.length-1].t>700 || c.t-grp[0].t>2000)) flush(); grp.push(c); }
    flush();
  } else chosen=ok.filter(c=>c.score>=thr);
  const set=new Set(chosen);
  for(const c of cands) if(c.rating>=1) set.add(c);
  chosen=[...set];
  if(max && chosen.length>max){
    const starred=chosen.filter(c=>c.rating>=1);
    const rest=chosen.filter(c=>!(c.rating>=1)).sort((a,b)=>b.score-a.score).slice(0, Math.max(0, max-starred.length));
    chosen=starred.concat(rest);
  }
  return chosen.sort((a,b)=>a.t-b.t);
}

/* ---------- scanning a card ---------- */
async function photoBytes(c){
  if(c.jpg){
    return readBytes(c.jpg, 0, c.jpg.size);
  }
  return nefPreview(c.nef, c.info);
}
async function scan(card){
  if(!API_) return;
  const src={label:card.name, total:0, checked:0, failed:0, phase:'Looking for photos', done:false, added:0, prepTotal:0, prepDone:0, t0:performance.now(), hint:''};
  PH.sources.unshift(src); renderSources();
  let files=[];
  try{ files=await API_.photoList(card.root); }catch(e){ src.hint='Couldn\'t read that card.'; }
  const groups=new Map();
  for(const f of files){
    const k=f.path.replace(/\.[^.\\/]+$/,'').toLowerCase();
    const g=groups.get(k)||{};
    if(/\.nef$/i.test(f.path)) g.nef=f; else g.jpg=f;
    groups.set(k,g);
  }
  const list=[...groups.values()];
  src.total=list.length; src.phase='Checking focus'; renderSources();
  if(!list.length){ src.done=true; src.hint=src.hint||'No JPEG or NEF photos found here.'; renderSources(); return; }

  const cands=[];
  let lastUI=0;
  await pool(list, 4, async g=>{
    const f=g.jpg||g.nef;
    const dk=f.path+'|'+f.size;
    try{
      if(PH.seen.has(dk)) return;
      const info=g.jpg ? await jpegInfo(g.jpg) : await nefInfo(g.nef);
      if(g.jpg && g.nef && !(info.rating>=1)){ try{ const n=await nefInfo(g.nef); setRating(info,n.rating); }catch(e){} }
      const c={jpg:g.jpg, nef:g.jpg?null:g.nef, info, dk, rating:info.rating, key:sortKey(info,f), score:null};
      c.t=timeMs(c.key);
      if(!(info.rating<0)){
        let bytes=null;
        if(g.jpg && info.mpf && info.mpf.length){               // camera's built-in smaller copy: much quicker to check
          const p=[...info.mpf].filter(m=>m.off+m.len<=g.jpg.size).sort((a,b)=>b.len-a.len)[0];
          if(p) bytes=await readBytes(g.jpg, p.off, p.len);
        }
        if(!bytes) bytes=await photoBytes(c);
        if(!bytes) throw new Error('no picture inside');
        c.score=(await work({op:'score', buf:buf(bytes)})).score;
      }
      cands.push(c);
    }catch(e){ src.failed++; console.warn(f.path, e); }
    finally{
      src.checked++;
      if(performance.now()-lastUI>200 || src.checked===src.total){ lastUI=performance.now(); renderSources(); }
    }
  });

  const picks=autoPick(cands);
  src.phase='Preparing'; src.prepTotal=picks.length; renderSources();
  await pool(picks, 3, async c=>{
    try{
      if(PH.seen.has(c.dk)) return;
      PH.seen.add(c.dk);
      const bytes=await photoBytes(c);
      if(!bytes) throw new Error('no picture inside');
      const r=await work({op:'display', buf:buf(bytes), orient:c.info.orientation||1, fromImage:!!c.jpg});
      const it={id:c.dk, key:c.key, name:(c.jpg||c.nef).path.split(/[\\/]/).pop(), url:URL.createObjectURL(r.main), thumb:URL.createObjectURL(r.thumb), off:false};
      const i=PH.items.findIndex(x=>x.key>it.key);
      if(i<0) PH.items.push(it); else PH.items.splice(i,0,it);
      src.added++;
      addThumb(it);
    }catch(e){ PH.seen.delete(c.dk); src.failed++; console.warn(e); }
    finally{ src.prepDone++; renderSources(); renderCount(); }
  });
  src.done=true;
  if(!src.added && src.total>src.failed) src.hint='Couldn\'t pick anything from this card – try "How picky: Relaxed" and scan it again.';
  renderSources(); renderCount();
  if(src.added) toast(`${src.added} photos ready from ${card.name}`);
}

/* ---------- slideshow ---------- */
const visible=()=>PH.items.filter(i=>!i.off);
const TV_HTML=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>PHOTOS</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none;font-family:-apple-system,"Segoe UI",Arial,sans-serif}
img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .8s}
img.on{opacity:1}
#cap,#cnt{position:absolute;bottom:3vh;color:#fff;font-weight:600;text-shadow:0 1px 6px #000,0 0 2px #000}
#cap{left:3vw;font-size:3.2vh}#cnt{right:3vw;font-size:2.2vh;opacity:.8}
#hint{position:absolute;right:16px;top:12px;color:#777;font-size:13px;cursor:default}</style></head>
<body><img id="a"><img id="b"><div id="cap"></div><div id="cnt"></div><div id="hint">Drag onto the TV and double-click for full screen</div></body></html>`;
async function openTv(){
  if(PH.tvWin && !PH.tvWin.closed) return;
  if(API_) await API_.setTvTarget(S_().phTv||'auto');
  const w=window.open('', 'rugbySB_tv', 'width=960,height=540');
  if(!w){ toast('The TV window was blocked'); return; }
  w.document.open(); w.document.write(TV_HTML); w.document.close();
  w.document.addEventListener('dblclick',()=>{ if(!w.document.fullscreenElement) w.document.documentElement.requestFullscreen().catch(()=>{}); });
  w.document.addEventListener('keydown',e=>{ if(e.code==='Escape' && !w.document.fullscreenElement) stop(); });
  if(API_) w.document.getElementById('hint').style.display='none';
  PH.tvWin=w; PH.tvLayer=0;
}
function closeTv(){ if(PH.tvWin && !PH.tvWin.closed){ try{ PH.tvWin.close(); }catch(e){} } PH.tvWin=null; }
function tvShow(it, pos){
  const w=PH.tvWin; if(!w || w.closed) return;
  const d=w.document, imgs=[d.getElementById('a'), d.getElementById('b')];
  const next=imgs[1-PH.tvLayer], cur=imgs[PH.tvLayer];
  next.classList.remove('on'); next.src=it.url;
  const reveal=()=>{ next.classList.add('on'); cur.classList.remove('on'); };
  next.decode ? next.decode().then(reveal, reveal) : reveal();
  PH.tvLayer=1-PH.tvLayer;
  d.getElementById('cap').textContent=S_().phCaption||'';
  d.getElementById('cnt').textContent=pos;
}
async function start(){
  const list=visible();
  if(!list.length){ toast('No photos yet – plug in a card or choose a folder'); return; }
  stop();
  const target=S_().phTarget||'board';
  const board=target!=='tv', tv=target!=='board';
  if(board){
    // clear the board first (these would otherwise stop the new show)
    if(typeof stopReel==='function') stopReel();
    if(typeof stopMusic==='function') stopMusic(150);
    if(typeof liveRun!=='undefined') liveRun++;
    if(state.standby){ state.standby=false; save(); for(const s of stages()) s.renderStandby(true); updateStandbyBtn(); }
    for(const s of stages()) s.clearAll();
    current=null;
  }
  PH.show={i:-1, board, tv, paused:false, timer:null};
  if(tv) await openTv();
  step(1);
  renderShow();
}
function step(d){
  const sh=PH.show; if(!sh) return;
  const list=visible(); if(!list.length){ stop(); return; }
  const curId = sh.cur;
  let i = curId ? list.findIndex(x=>x.id===curId) : -1;
  if(i<0 && curId && d>0) i=sh.i-1;   // the current one was left out: carry on from roughly the same place
  i=((i+d)%list.length+list.length)%list.length;
  sh.i=i; sh.cur=list[i].id;
  const it=list[i], pos=`${i+1} / ${list.length}`;
  const fill=(S_().phFit||'fill')==='fill';
  if(sh.board) for(const s of stages()) s.showPhoto(it.url, fill);
  if(sh.tv) tvShow(it, pos);
  sh.pos=pos;
  document.querySelectorAll('#phGrid figure').forEach(f=>f.classList.toggle('now', f.dataset.id===it.id));
  schedule(); renderShow();
  if(sh.board && typeof updateNP==='function') updateNP();
}
function schedule(){
  const sh=PH.show; if(!sh) return;
  clearTimeout(sh.timer);
  if(sh.paused) return;
  sh.timer=setTimeout(()=>step(1), Math.max(1, +S_().phSecs||6)*1000);
}
function stop(){
  const sh=PH.show; if(!sh) return;
  clearTimeout(sh.timer);
  if(sh.board) for(const s of stages()) s.hidePhotos();
  closeTv();
  PH.show=null;
  document.querySelectorAll('#phGrid figure.now').forEach(f=>f.classList.remove('now'));
  renderShow();
  if(typeof updateNP==='function') updateNP();
}
function boardOff(){                // something else went on the scoreboard (Esc, a video, a try…)
  const sh=PH.show; if(!sh || !sh.board) return;
  sh.board=false;
  for(const s of stages()) s.hidePhotos();
  if(!sh.tv) stop(); else renderShow();
}
function togglePause(){ const sh=PH.show; if(!sh) return; sh.paused=!sh.paused; schedule(); renderShow(); }

/* ---------- screen bits ---------- */
function renderSources(){
  const box=$('phSources'); if(!box) return;
  box.innerHTML=PH.sources.map(s=>{
    let txt, frac;
    if(s.done){ txt=`${esc(s.label)}: done · ${s.added} photos picked from ${s.total}`+(s.failed?` · ${s.failed} couldn't be read`:''); frac=1; }
    else if(s.phase==='Preparing'){ txt=`${esc(s.label)}: preparing ${s.prepDone}/${s.prepTotal} picked photos`; frac=s.prepTotal?s.prepDone/s.prepTotal:1; }
    else {
      const el=(performance.now()-s.t0)/1000, left=s.checked>8 && s.total>s.checked ? el/s.checked*(s.total-s.checked) : null;
      txt=`${esc(s.label)}: ${s.phase.toLowerCase()} ${s.checked}/${s.total}`+(left!=null?` · about ${fmtLeft(left)} left`:'');
      frac=s.total?s.checked/s.total:0;
    }
    return `<div class="phSrc ${s.done?'done':''}"><div>${txt}</div><div class="bar"><i style="width:${(100*frac).toFixed(1)}%"></i></div>${s.hint?`<div class="hint">${esc(s.hint)}</div>`:''}</div>`;
  }).join('');
}
function renderCards(){
  const box=$('phCards'); if(!box) return;
  if(!API_){ box.innerHTML='<p class="hint">Photos from camera cards work in the desktop app.</p>'; return; }
  box.innerHTML = PH.cards.length
    ? PH.cards.map((c,i)=>`<div class="phCard"><span>💾</span><b>${esc(c.name)}</b><button class="primary" data-card="${i}">Pick photos</button></div>`).join('')
    : '<p class="hint" style="margin:0">No camera card plugged in. Put one in the card reader – it\'s picked up automatically.</p>';
}
function addThumb(it){
  const grid=$('phGrid'); if(!grid) return;
  const fig=document.createElement('figure');
  fig.dataset.id=it.id; fig.dataset.key=it.key; fig.title=it.name;
  fig.innerHTML=`<img alt=""><figcaption>${esc(it.key.slice(11,19))}</figcaption>`;
  fig.querySelector('img').src=it.thumb;
  fig.onclick=()=>{ it.off=!it.off; fig.classList.toggle('off', it.off); renderCount(); };
  const after=[...grid.children].find(c=>c.dataset.key>it.key);
  grid.insertBefore(fig, after||null);
}
function renderCount(){
  const on=visible().length, off=PH.items.length-on;
  if($('phCount')) $('phCount').textContent = PH.items.length ? `– ${on} in the slideshow`+(off?`, ${off} left out`:'') : '';
  const q=$('btnPhotosQuick');
  if(q){ q.style.display = PH.items.length ? '' : 'none'; q.textContent = PH.show ? `📷 ${PH.show.pos||''}` : `📷 ${on} ready`; q.title = PH.show ? 'Photos are showing – click to control them' : 'Picked photos are ready – click to start the slideshow'; }
  if($('phStart')) $('phStart').disabled = !on;
}
function renderShow(){
  const sh=PH.show;
  const where = sh ? [sh.board&&'scoreboard', sh.tv&&'TV'].filter(Boolean).join(' and ') : '';
  if($('phNow')) $('phNow').innerHTML = sh ? `Showing photo <b>${sh.pos||''}</b> on the <b>${where}</b>${sh.paused?' – paused':''}` : '';
  if($('phPause')) $('phPause').textContent = sh && sh.paused ? '▶ Resume' : '❚❚ Pause';
  ['phPrev','phPause','phNext','phStop'].forEach(id=>{ if($(id)) $(id).disabled=!sh; });
  if($('phStart')) $('phStart').textContent = sh ? '↻ Restart photos' : '▶ Start photos';
  if($('phTvCol')) $('phTvCol').style.display = (S_().phTarget||'board')==='board' ? 'none' : '';
  renderCount();
}
async function renderTvScreens(){
  const sel=$('phTv'); if(!sel) return;
  if(!API_){ sel.innerHTML='<option value="auto">Opens a window – drag it onto the TV</option>'; return; }
  let info; try{ info=await API_.displays(); }catch(e){ return; }
  sel.innerHTML='<option value="auto">Automatic (a screen that isn\'t the laptop or the scoreboard)</option>'+
    info.displays.map(d=>`<option value="${d.id}">${esc(d.label)} – ${d.width}×${d.height}${d.primary?' (laptop)':''}</option>`).join('');
  sel.value = info.displays.some(d=>String(d.id)===String(S_().phTv)) ? String(S_().phTv) : 'auto';
}
function clearAll(){
  if(!PH.items.length) return;
  if(!confirm('Remove all the picked photos? (Nothing is deleted from the card.)')) return;
  stop();
  for(const it of PH.items){ URL.revokeObjectURL(it.url); URL.revokeObjectURL(it.thumb); }
  PH.items=[]; PH.seen.clear(); PH.sources=[];
  $('phGrid').innerHTML=''; renderSources(); renderCount();
}

function bind(id, key, num){
  const el=$(id); if(!el) return;
  const prop=el.type==='checkbox'?'checked':'value';
  el[prop]=S_()[key];
  el.addEventListener(prop==='checked'?'change':'input',()=>{ let v=el[prop]; if(num){ v=parseFloat(v); if(isNaN(v)) return; } S_()[key]=v; save(); renderShow(); });
}
function showTab(){ const b=document.querySelector('.tabs button[data-tab=photos]'); if(b) b.click(); }

function init(){
  bind('phAuto','phAuto'); bind('phPick','phPick'); bind('phBurst','phBurst'); bind('phMax','phMax',1);
  bind('phTarget','phTarget'); bind('phSecs','phSecs',1); bind('phFit','phFit'); bind('phCaption','phCaption');
  $('phTv').onchange=e=>{ S_().phTv=e.target.value; save(); if(API_) API_.setTvTarget(e.target.value); };
  $('phStart').onclick=start;
  $('phStop').onclick=stop;
  $('phNext').onclick=()=>step(1);
  $('phPrev').onclick=()=>step(-1);
  $('phPause').onclick=togglePause;
  $('phClear').onclick=clearAll;
  $('btnPhotosQuick').onclick=showTab;
  $('phFolder').onclick=async()=>{ if(!API_){ toast('Use the desktop app for photos'); return; } const c=await API_.photoFolder(); if(c) scan(c); };
  $('phCards').onclick=e=>{ const b=e.target.closest('[data-card]'); if(b) scan(PH.cards[+b.dataset.card]); };
  $('tabPhotos').addEventListener('click', renderTvScreens);
  renderCards(); renderShow(); renderTvScreens();
  if(API_){
    API_.photoCards().then(c=>{ PH.cards=c||[]; renderCards(); }).catch(()=>{});
    API_.onCards(({cards, added})=>{
      PH.cards=cards||[]; renderCards();
      for(const c of (added||[])){
        if(S_().phAuto){ toast(`Card plugged in: picking photos from ${c.name}…`); scan(c); }
        else toast(`Card plugged in: ${c.name} – open 📷 Photos to pick photos`);
      }
    });
    API_.onDisplays(()=>renderTvScreens());
  }
  // the TV window closing on its own (e.g. cable pulled) stops the TV part
  setInterval(()=>{ const sh=PH.show; if(sh && sh.tv && (!PH.tvWin || PH.tvWin.closed)){ sh.tv=false; PH.tvWin=null; if(!sh.board) stop(); else renderShow(); } }, 1000);
}

window.PHOTOS = {
  boardOff,
  onBoard: ()=>!!(PH.show && PH.show.board),
  position: ()=>PH.show ? (PH.show.pos||'') : '',
};
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
