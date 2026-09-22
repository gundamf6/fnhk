#!/usr/bin/env node
// 飞海监控 (fn-hiknvr) · v0.2 —— 多摄像机 · 连续+事件双轨录像 · 本地移动侦测
// 只读拉流(RTSP)，绝不改动摄像机设置。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.NVR_CONF || path.join(__dir, 'config.json');
const PUB = path.join(__dir, 'public');
const DATA_ROOT = process.env.NVR_DATA || path.join(__dir, 'data');
const REC_ROOT = process.env.NVR_REC_ROOT || path.join(DATA_ROOT, 'rec');
const SNAP_ROOT = path.join(DATA_ROOT, 'snap');

// ---------- 海康 RTSP 地址模板：通道 1 主=101、子=102；通道 N 主=N01、子=N02 ----------
function hkRtsp(ip, port, user, pass, channel, main) {
  const ch = String(Math.max(1, parseInt(channel) || 1) * 100 + (main ? 1 : 2));
  return `rtsp://${encodeURIComponent(user || '')}:${encodeURIComponent(pass || '')}@${ip}:${port || 554}/Streaming/Channels/${ch}`;
}
const MAX_CAMS = 4;                        // 与界面/文档一致：最多 4 台摄像机
const camConfigured = cam => !!(cam && cam.ip);
const camIdGen = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function newCamera(o = {}) {
  return { id: camIdGen(), name: '', ip: '', port: 554, user: '', pass: '', channel: 1,
           previewStream: 'main', rtspMain: '', rtspSub: '', ...o };
}
function applyCameraUrls(c) {
  for (const cam of c.cameras) {
    if (cam.ip) {
      cam.rtspMain = hkRtsp(cam.ip, cam.port, cam.user, cam.pass, cam.channel, true);
      cam.rtspSub = hkRtsp(cam.ip, cam.port, cam.user, cam.pass, cam.channel, false);
    } else { cam.rtspMain = ''; cam.rtspSub = ''; }
  }
  return c;
}
// 目录名 = 摄像机名（清洗后）；重名自动加后缀；改名时同步重命名现有目录
function safeName(s) {
  const t = String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return t.slice(0, 40);
}
function syncCameraDirs(root) {
  const used = new Set();
  cfg.cameras.forEach((cam, i) => {
    let want = safeName(cam.name) || ('摄像机' + (i + 1));
    let d = want, k = 2;
    while (used.has(d)) d = want + '-' + (k++);
    used.add(d);
    if (cam.dir && cam.dir !== d) {
      const oldP = path.join(root, cam.dir), newP = path.join(root, d);
      try { if (fs.existsSync(oldP) && !fs.existsSync(newP)) fs.renameSync(oldP, newP); } catch {}
    }
    cam.dir = d;
  });
}
function defaultConfig() {
  return {
    cameras: [newCamera()],
    record: { enabled: true, segmentSeconds: 300, retentionDays: 3, root: REC_ROOT },
    live: { root: path.join(DATA_ROOT, 'live') },
    ring: { root: path.join(DATA_ROOT, 'ring'), segmentSeconds: 2 },
    motion: { enabled: true, fps: 2, width: 64, height: 48, diffThreshold: 22, changedRatio: 0.03,
              holdSeconds: 8, preRoll: 15, postRoll: 15 },
    http: { port: Number(process.env.NVR_PORT || 8091), host: '127.0.0.1', user: 'admin', pass: '' },  // 默认只听本机；局域网访问请改 host 并设置口令
    https: { enabled: String(process.env.NVR_HTTPS || 'false') === 'true', port: Number(process.env.NVR_HTTPS_PORT || 8444),
             host: '127.0.0.1', domain: process.env.NVR_DOMAIN || '', certDir: process.env.NVR_CERT_DIR || '' }
  };
}
function writeCfg() {
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));
  try { fs.chmodSync(CFG_PATH, 0o600); } catch {}     // 内含摄像头密码，仅本用户可读
}
if (!fs.existsSync(CFG_PATH)) {
  try { fs.mkdirSync(path.dirname(CFG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(CFG_PATH, JSON.stringify(defaultConfig(), null, 2));
  try { fs.chmodSync(CFG_PATH, 0o600); } catch {}
}
try { fs.chmodSync(CFG_PATH, 0o600); } catch {}       // 老配置文件也收紧权限
let cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
// ★ 配置归一化：老版本/手工改过的配置缺字段时，用默认值补齐（避免启动时 undefined 崩溃）
function mergeDefaults(dst, def) {
  for (const k of Object.keys(def)) {
    const dv = def[k];
    if (dst[k] === undefined || dst[k] === null) { dst[k] = dv; continue; }
    if (dv && typeof dv === 'object' && !Array.isArray(dv) && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeDefaults(dst[k], dv);
  }
  return dst;
}
cfg = mergeDefaults(cfg, defaultConfig());
// ---- 老版本(单摄像机 camera)配置迁移 ----
if (!Array.isArray(cfg.cameras)) {
  const old = cfg.camera || {};
  cfg.cameras = [newCamera({ name: old.name || '', ip: old.ip || '', port: old.port || 554, user: old.user || '',
    pass: old.pass || '', channel: old.channel || 1, previewStream: cfg.previewStream === 'sub' ? 'sub' : 'main' })];
  delete cfg.camera; delete cfg.previewStream;
}
if (!cfg.cameras.length) cfg.cameras = [newCamera()];
if (!cfg.http) cfg.http = { port: 8091, host: '127.0.0.1', user: 'admin', pass: '' };
applyCameraUrls(cfg);
for (const cam of cfg.cameras) if (!cam.id) cam.id = camIdGen();
syncCameraDirs(cfg.record.root);

// ⚠️ 已移除旧的 migrateRootLayout（会把录像根下所有「日期目录」搬进第一台摄像机目录）——
// 当录像根与其它应用共用时会误搬别人的数据。
// ⚠️ 也移除了它的补救函数 repairForeignDateDirs()：该函数会把「早于今天」的日期目录搬出摄像机目录
//    并剥掉文件名前缀 —— 正常运行时会把历史录像搬乱，不能留在启动流程里（补救已完成，不需要再跑）。

const PREFIX = process.env.NVR_PREFIX || '/app/fn-hiknvr';
function refreshPaths() {
  syncCameraDirs(cfg.record.root);
  for (const d of [cfg.record.root, cfg.live.root, cfg.ring.root, SNAP_ROOT]) fs.mkdirSync(d, { recursive: true });
  for (const cam of cfg.cameras) {
    for (const d of [path.join(cfg.live.root, cam.id), path.join(cfg.ring.root, cam.id)]) fs.mkdirSync(d, { recursive: true });
  }
}
refreshPaths();

const FFMPEG = process.env.NVR_FFMPEG || (['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(p => fs.existsSync(p)) || 'ffmpeg');
// ★ 日志脱敏：ffmpeg 的 stderr 会带完整输入地址（含摄像头密码），一律先脱敏再写日志
const redact = s => String(s)
  .replace(/rtsp:\/\/[^\s@/]*@/gi, 'rtsp://***@')
  .replace(/([?&](?:password|pwd|auth)=)[^&\s]*/gi, '$1***');
const log = (...a) => console.log(new Date().toISOString(), ...a.map(x => (typeof x === 'string' ? redact(x) : x)));

// ★ 安全：未设置访问口令时，禁止把服务监听到非本机地址（旧配置自动纠正）
function fixHosts() {
  for (const x of [cfg.http, cfg.https]) {
    if (!x || !x.host) continue;
    const h = String(x.host);
    if (!(cfg.http && cfg.http.pass) && !['127.0.0.1', 'localhost', '::1'].includes(h)) {
      log(`[sec] 未设置访问口令，监听地址 ${h} → 127.0.0.1（如需局域网访问，请设置 http.user / http.pass）`);
      x.host = '127.0.0.1';
    }
  }
}
fixHosts();

// ★ 保命：单个请求的异步错误绝不能让进程挂掉（挂了 = 停止录像）
process.on('uncaughtException', e => { log('[fatal-guard] uncaughtException:', e && e.message); });
process.on('unhandledRejection', e => { log('[fatal-guard] unhandledRejection:', e && (e.message || e)); });
const two = n => String(n).padStart(2, '0');
let shuttingDown = false;

// ---------- 每台摄像机的运行状态 ----------
const state = { cams: new Map() };
function cs(cam) {
  let s = state.cams.get(cam.id);
  if (!s) {
    s = { mainProc: null, motionProc: null, recDir: null,
          motion: { lastFrame: null, lastMotionTs: 0, eventActive: false, eventStart: 0,
                    lastEventEnd: 0, lastScore: 0, eventCount: 0, frames: 0, lastError: '' } };
    state.cams.set(cam.id, s);
  }
  return s;
}
const liveDirOf = cam => path.join(cfg.live.root, cam.id);
const ringDirOf = cam => path.join(cfg.ring.root, cam.id);
const recDirOf  = cam => path.join(cfg.record.root, cam.dir || cam.id);
const contDirOf  = (cam, d) => path.join(recDirOf(cam), ymdOf(d), halfOf(d), hourLabel(d));
const eventDirOf = (cam, d) => path.join(recDirOf(cam), ymdOf(d), '事件');

const COMMON = ['-hide_banner', '-loglevel', 'warning', '-rtsp_transport', 'tcp', '-timeout', '15000000', '-use_wallclock_as_timestamps', '1'];
const ymdOf = d => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const halfOf = d => (d.getHours() < 12 ? '上午' : '下午');
const hourLabel = d => `${two(d.getHours())}:00-${two(d.getHours())}:59:59`;
const stamp = ms => { const d = new Date(ms); return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`; };

function killP(proc) { try { proc?.kill('SIGTERM'); } catch {} }
function killHard(proc) { const pid = proc?.pid; killP(proc); if (pid) setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, 5000); }

// ---------- 主码流管线：一次拉流 → ① 连续录像 ② 事件环形 ③ HLS 直播（3 路输出）----------
// 海康只允许 3 路并发 RTSP 会话；main 拉 1 路复制成 3 输出、motion 走子码流 = 每台 2 路会话。
function ringKeepCount() {
  const span = cfg.motion.preRoll + cfg.motion.postRoll + 20;
  return Math.max(6, Math.ceil(span / cfg.ring.segmentSeconds));
}
function startMain(cam) {
  const s = cs(cam);
  if (shuttingDown || !cfg.record.enabled || !camConfigured(cam) || s.mainProc) return;
  if (diskLow()) {                                   // 磁盘写满保护：暂停录像，1 分钟后再试
    if (!diskPaused) { diskPaused = true; log('[disk] 剩余空间不足 500MB，已暂停录像（等清理后自动恢复）'); cleanup().catch(() => {}); }
    setTimeout(() => startMain(cam), 60000);
    return;
  }
  if (diskPaused) { diskPaused = false; log('[disk] 空间已恢复，继续录像'); }
  const RING = ringDirOf(cam), LIVE = liveDirOf(cam);
  const dir = contDirOf(cam, new Date());
  for (const d of [dir, RING, LIVE]) fs.mkdirSync(d, { recursive: true });
  s.recDir = dir;
  const recOut = path.join(dir, cam.dir.replace(/%/g, '%%') + '-%Y%m%d-%H%M%S.mp4');
  const ringOut = path.join(RING, '%Y%m%d-%H%M%S.ts');
  const A = ['-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1'];
  const args = [...COMMON, '-i', cam.rtspMain,
    ...A, '-f', 'segment', '-segment_time', String(cfg.record.segmentSeconds), '-reset_timestamps', '1',
    '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart', '-strftime', '1', recOut,
    ...A, '-f', 'segment', '-segment_time', String(cfg.ring.segmentSeconds), '-reset_timestamps', '1',
    '-segment_format', 'mpegts', '-strftime', '1', ringOut,
    ...A, '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(LIVE, 'seg%d.ts'), path.join(LIVE, 'index.m3u8')];
  log(`[main:${cam.dir}] start -> ${ymdOf(new Date())}/${halfOf(new Date())}`);
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  s.mainProc = p;
  p.stderr.on('data', d => log(`[main:${cam.dir}]`, d.toString().trim()));
  p.on('exit', () => { s.mainProc = null;
    if (!shuttingDown && cfg.record.enabled && cfg.cameras.includes(cam)) setTimeout(() => startMain(cam), 5000); });
}

// 跨「上午/下午」、跨天、跨小时自动切目录
setInterval(() => {
  if (shuttingDown || !cfg.record.enabled) return;
  for (const cam of cfg.cameras) {
    const s = cs(cam);
    if (s.mainProc && diskLow()) { log('[disk] 剩余空间不足，停止录像'); killP(s.mainProc); }
    const want = contDirOf(cam, new Date());
    if (s.recDir && want !== s.recDir) {
      log(`[main:${cam.dir}] 切换目录 ->`, path.relative(recDirOf(cam), want));
      s.recDir = want;
      if (s.mainProc) killP(s.mainProc); else startMain(cam);
    }
  }
}, 30000);

// ---------- 移动侦测（子码流 -> 低分辨率灰度原始帧） ----------
function startMotion(cam) {
  const s = cs(cam);
  if (shuttingDown || !cfg.motion.enabled || !cfg.record.enabled || !camConfigured(cam) || s.motionProc) return;
  const { width: W, height: H, fps } = cfg.motion;
  const frameSize = W * H;
  const LIVE = liveDirOf(cam);
  fs.mkdirSync(LIVE, { recursive: true });
  // 同一路子码流连接 → ① 省资源的 HLS 直播（供宫格用）② 低分辨率灰度帧做移动侦测
  const args = ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-timeout', '15000000', '-i', cam.rtspSub,
    '-map', '0:v', '-an', '-c:v', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_list_size', '5',
    '-hls_flags', 'delete_segments+independent_segments+omit_endlist',
    '-hls_segment_filename', path.join(LIVE, 'sub%d.ts'), path.join(LIVE, 'index-sub.m3u8'),
    '-map', '0:v', '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'];
  log(`[motion:${cam.dir}] start (${W}x${H}@${fps}fps)`);
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  s.motionProc = p;
  let buf = Buffer.alloc(0);
  p.stdout.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= frameSize) {
      const f = buf.subarray(0, frameSize); buf = buf.subarray(frameSize);
      analyzeFrame(cam, f, frameSize);
    }
  });
  p.stderr.on('data', d => { const t = d.toString().trim(); if (t) log(`[motion:${cam.dir}]`, t); });
  p.on('exit', () => { s.motionProc = null;
    if (!shuttingDown && cfg.motion.enabled && cfg.cameras.includes(cam)) setTimeout(() => startMotion(cam), 3000); });
}
function analyzeFrame(cam, frame, size) {
  const m = cs(cam).motion;
  m.frames++;
  if (m.lastFrame) {
    let changed = 0;
    for (let i = 0; i < size; i++) if (Math.abs(frame[i] - m.lastFrame[i]) > cfg.motion.diffThreshold) changed++;
    const ratio = changed / size;
    m.lastScore = ratio;
    if (ratio >= cfg.motion.changedRatio) onMotion(cam, ratio);
  }
  m.lastFrame = Buffer.from(frame);
}
function onMotion(cam, ratio) {
  const m = cs(cam).motion, now = Date.now();
  m.lastMotionTs = now;
  if (!m.eventActive) {
    m.eventActive = true; m.eventStart = now; m.eventCount++;
    log(`[motion:${cam.dir}] 事件开始 ratio=${ratio.toFixed(3)}`);
  }
}
setInterval(async () => {
  for (const cam of cfg.cameras) {
    const m = cs(cam).motion;
    if (!m.eventActive) continue;
    if (Date.now() - m.lastMotionTs < cfg.motion.holdSeconds * 1000) continue;
    m.eventActive = false; m.lastEventEnd = Date.now();
    log(`[motion:${cam.dir}] 事件结束`);
    try { await assembleClip(cam, m.eventStart, m.lastEventEnd); } catch (e) { log('[event] 剪辑失败', e.message); }
  }
}, 1000);

function parseRingMs(name) {
  const x = name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.ts$/);
  if (!x) return null;
  return new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5], +x[6]).getTime();
}
// 白名单：只有「符合本应用命名规则」的录像才归我们管（清理/扫描只动这些，避免误删同目录下别人的视频）
function oursName(name) {
  for (const cam of cfg.cameras) {
    const d = cam.dir; if (!d) continue;
    const re = new RegExp('^' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-\\d{8}-\\d{6}(-E)?\\.mp4$');
    if (re.test(name)) return true;
  }
  return false;
}
const parseRecMs = name => {
  const x = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-E)?\.mp4$/);   // 允许 <摄像机名>- 前缀
  if (!x) return null;
  return new Date(+x[1], +x[2] - 1, +x[3], +x[4], +x[5], +x[6]).getTime();
};
async function assembleClip(cam, fromMs, toMs) {
  const RING = ringDirOf(cam);
  const from = fromMs - cfg.motion.preRoll * 1000, to = toMs + cfg.motion.postRoll * 1000;
  const completeBefore = Date.now() - cfg.ring.segmentSeconds * 1000 - 500;
  let files = [];
  try {
    files = (await fsp.readdir(RING)).map(f => ({ f, t: parseRingMs(f) }))
      .filter(o => o.t !== null && o.t >= from && o.t <= to && o.t <= completeBefore)
      .sort((a, b) => a.t - b.t).map(o => o.f);
  } catch {}
  if (!files.length) { log(`[event:${cam.dir}] 无可用环形分片`); return; }
  const listPath = path.join(RING, `_concat_${Date.now()}.txt`);
  const outDir = eventDirOf(cam, new Date(toMs));
  await fsp.mkdir(outDir, { recursive: true });
  const outName = `${cam.dir}-${stamp(toMs)}-E.mp4`;
  await fsp.writeFile(listPath, files.map(f => `file '${path.join(RING, f)}'`).join('\n') + '\n');
  await new Promise(res => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', '-y', path.join(outDir, outName)], { stdio: ['ignore', 'ignore', 'pipe'] });
    p.stderr.on('data', d => log('[event]', d.toString().trim()));
    p.on('exit', () => res());
  });
  await fsp.unlink(listPath).catch(() => {});
  log(`[event:${cam.dir}] 已生成 ${outName}（${files.length} 片）`);
}

// ---------- 抓拍 ----------
function newestLiveSeg(cam, kind) {
  const LIVE = liveDirOf(cam);
  try {
    const now = Date.now();
    const re = kind === 'sub' ? /^sub\d+\.ts$/ : kind === 'main' ? /^seg\d+\.ts$/ : /\.ts$/;
    const arr = fs.readdirSync(LIVE).filter(f => re.test(f))
      .map(f => ({ p: path.join(LIVE, f), m: fs.statSync(path.join(LIVE, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!arr.length) return null;
    return (arr.find(x => now - x.m > 1200) || arr[0]).p;
  } catch { return null; }
}
async function snapshot(cam, opts = {}) {
  // opts.w: 缩略图宽度（0=原图）；opts.sub: 优先取子码流片段（更省 CPU/流量）
  const w = +opts.w || 0, sub = !!opts.sub;
  const name = w ? `thumb-${cam.id}.jpg` : `${cam.dir}-${stamp(Date.now())}.jpg`;
  const out = path.join(SNAP_ROOT, name), tmp = out + '.tmp';
  fs.mkdirSync(SNAP_ROOT, { recursive: true });
  const vf = w ? ['-vf', `scale=${w}:-2`] : [];
  const grab = src => new Promise(res => {
    const fin = () => { try { if (fs.existsSync(tmp) && fs.statSync(tmp).size > 0) fs.renameSync(tmp, out); } catch {} res(); };
    const rtsp = /^rtsp:\/\//i.test(src);
    const args = ['-hide_banner', '-loglevel', 'error', ...(rtsp ? ['-rtsp_transport', 'tcp'] : []), '-i', src, '-frames:v', '1', ...vf, '-f', 'image2', '-q:v', '4', '-y', tmp];
    const p = spawn(FFMPEG, args, { stdio: 'ignore' });
    p.on('exit', fin); p.on('error', fin);
    setTimeout(() => { try { p.kill(); } catch {} fin(); }, 8000);
  });
  const seg = newestLiveSeg(cam, sub ? 'sub' : 'main') || (sub ? newestLiveSeg(cam, 'main') : null);
  if (seg) await grab(seg);
  if (!fs.existsSync(out) && cam.rtspMain) {
    await grab(cam.rtspMain);
  }
  return fs.existsSync(out) ? out : null;
}
// 缩略图并发去重（首页 5~6s 一次，多台顺序请求）
const snapInflight = new Map();
function snapshotShared(cam, opts) {
  const key = (opts && opts.w ? 't' : 'f') + cam.id + (opts && opts.sub ? 's' : '');
  let pr = snapInflight.get(key);
  if (!pr) { pr = snapshot(cam, opts).finally(() => snapInflight.delete(key)); snapInflight.set(key, pr); }
  return pr;
}
// 清理一天前的快照文件（缩略图是固定名覆盖，只有手动抓拍会累积）
function pruneSnaps() {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(SNAP_ROOT)) {
      const p = path.join(SNAP_ROOT, f);
      try { if (now - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p); } catch {}
    }
  } catch {}
}
// 老录像文件名（20260922-134720.mp4）补上「摄像机名-」前缀 —— 幂等，一次性
function migrateNames() {
  let n = 0;
  for (const cam of cfg.cameras) {
    const walk = d => {
      let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/^\d{8}-\d{6}(-E)?\.mp4$/.test(e.name)) continue;
        try { fs.renameSync(p, path.join(d, cam.dir + '-' + e.name)); n++; } catch {}
      }
    };
    walk(recDirOf(cam));
  }
  if (n) log(`[migrate] 录像文件名已补「摄像机名-」前缀：${n} 个`);
}
// （已移除：旧录像根的一次性搬迁，属于开发环境的历史路径，公开版本不需要）

// ---------- 保留清理 / 环形清理 ----------
async function walkMp4(root) {
  const out = [];
  const rec = async dir => {
    let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile() && parseRecMs(e.name) !== null && oursName(e.name)) out.push(p);
    }
  };
  await rec(root);
  return out;
}
async function pruneEmptyDirs(dir) {
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return true; }
  let empty = true;
  for (const e of ents) {
    if (e.isDirectory()) { const sub = path.join(dir, e.name); if (await pruneEmptyDirs(sub)) await fsp.rmdir(sub).catch(() => {}); else empty = false; }
    else empty = false;
  }
  return empty;
}
async function hasMoov(fp) {
  try {
    const fh = await fsp.open(fp, 'r'); const buf = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(buf, 0, 65536, 0); await fh.close();
    return buf.subarray(0, bytesRead).includes(Buffer.from('moov'));
  } catch { return false; }
}
const moovCache = new Map();
async function fileComplete(fp, st) {
  const c = moovCache.get(fp);
  if (c && c.mtimeMs === st.mtimeMs) return c.complete;
  const complete = await hasMoov(fp);
  if (moovCache.size > 5000) moovCache.clear();
  moovCache.set(fp, { mtimeMs: st.mtimeMs, complete });
  return complete;
}
async function sweepBrokenTails() {
  const now = Date.now(); let n = 0;
  for (const fp of await walkMp4(cfg.record.root)) {
    try {
      const st = await fsp.stat(fp);
      const age = now - st.mtimeMs;
      if (age < 90000 || age > 3600000) continue;
      if (!(await hasMoov(fp))) { await fsp.unlink(fp).catch(() => {}); n++; log('[sweep] 删除损坏尾段', path.basename(fp)); }
    } catch {}
  }
  if (n) log(`[sweep] 清理损坏片段 ${n} 个`);
}
async function cleanup() {
  const cutoff = Date.now() - cfg.record.retentionDays * 86400_000;
  let n = 0;
  for (const p of await walkMp4(cfg.record.root)) {
    const t = parseRecMs(path.basename(p));
    if (t !== null && t < cutoff) { await fsp.unlink(p).catch(() => {}); n++; }
  }
  if (n) { log(`[cleanup] 删除过期录像 ${n} 个`); await pruneEmptyDirs(cfg.record.root); }
}
async function ringJanitor() {
  const keep = ringKeepCount();
  for (const cam of cfg.cameras) {
    const RING = ringDirOf(cam);
    try {
      const files = (await fsp.readdir(RING)).filter(f => f.endsWith('.ts'))
        .map(f => ({ f, t: parseRingMs(f) })).filter(o => o.t).sort((a, b) => a.t - b.t);
      for (const o of files.slice(0, Math.max(0, files.length - keep))) await fsp.unlink(path.join(RING, o.f));
    } catch {}
  }
}
setInterval(cleanup, 600000); setInterval(ringJanitor, 3000);

// ---------- 假死看门狗 ----------
const WATCH = {};
function _rchar(pid) { try { const s = fs.readFileSync(`/proc/${pid}/io`, 'utf8'); const m = s.match(/rchar:\s*(\d+)/); return m ? +m[1] : null; } catch { return null; } }
function watchStage(key, proc, limitMs) {
  if (!proc || !proc.pid) { delete WATCH[key]; return; }
  const rc = _rchar(proc.pid);
  const w = WATCH[key];
  if (!w || w.pid !== proc.pid || rc == null) { WATCH[key] = { pid: proc.pid, rc: rc || 0, t: Date.now() }; return; }
  if (rc > w.rc) { w.rc = rc; w.t = Date.now(); }
  else if (Date.now() - w.t > limitMs) {
    log(`[watch] ${key} 假死 ${Math.round((Date.now() - w.t) / 1000)}s 无数据，重启进程`);
    WATCH[key] = { pid: 0, rc: 0, t: Date.now() };
    killHard(proc);
  }
}
setInterval(() => {
  if (shuttingDown) return;
  for (const cam of cfg.cameras) {
    const s = cs(cam);
    watchStage('main:' + cam.id, s.mainProc, 30000);
    watchStage('motion:' + cam.id, s.motionProc, 30000);
  }
}, 10000);

// ---------- 孤儿清理 ----------
function _cmdline(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; } }
function reapOrphans() {
  let n = 0;
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = +d; if (pid === process.pid) continue;
    let ppid = -1;
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.lastIndexOf(')'); ppid = +s.slice(r + 2).split(' ')[1]; } catch { continue; }
    if (ppid !== 1) continue;
    const c = _cmdline(pid);
    if (!/^\S*ffmpeg\b/.test(c)) continue;
    // 判据收紧：必须引用本应用的数据目录（live/ring 输出），避免误杀用户或其它应用拉同一台摄像头的 ffmpeg
    if (!c.includes(DATA_ROOT + '/')) continue;
    try { process.kill(pid, 'SIGKILL'); n++; log('[reap] 清理孤儿 ffmpeg pid=' + pid); } catch {}
  }
  if (n) log(`[reap] 共清理 ${n} 个孤儿 ffmpeg`);
}

async function migrateFaststart() {
  const marker = path.join(DATA_ROOT, '.faststart-migrated');
  if (fs.existsSync(marker)) return;
  let n = 0;
  for (const fp of await walkMp4(cfg.record.root)) {
    try {
      const fh = await fsp.open(fp, 'r'); const head = Buffer.alloc(65536);
      const { bytesRead } = await fh.read(head, 0, 65536, 0); await fh.close();
      if (!head.subarray(0, bytesRead).includes(Buffer.from('moof'))) continue;
      const tmp = fp + '.tmp.mp4';
      await new Promise(res => { const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', fp, '-c', 'copy', '-movflags', '+faststart', '-y', tmp], { stdio: ['ignore', 'ignore', 'pipe'] }); p.stderr.on('data', d => log('[migrate]', d.toString().trim())); p.on('exit', () => res()); });
      if (fs.existsSync(tmp) && fs.statSync(tmp).size > 1024) { await fsp.rename(tmp, fp); n++; } else { await fsp.unlink(tmp).catch(() => {}); }
    } catch {}
  }
  fs.writeFileSync(marker, new Date().toISOString());
  log(`[migrate] faststart 完成，remux ${n} 个`);
}

setTimeout(() => { cleanup(); ringJanitor(); }, 5000);
setTimeout(() => { sweepBrokenTails().catch(e => log('[sweep] 失败', e.message)); }, 90000);
setTimeout(() => { migrateFaststart().catch(e => log('[migrate] 失败', e.message)); }, 8000);

// ---------- 启动 / 重启管线 ----------
function startAll() {
  for (const cam of cfg.cameras) { startMain(cam); startMotion(cam); }
  log(`[rec] 已启动 ${cfg.cameras.filter(camConfigured).length} 台摄像机的连续+事件录像`);
}
// ★ 必须等旧 ffmpeg 真正退出再起新的（否则旧进程仍占着 RTSP 会话 → 新进程被拒 SETUP 500 → 用户感觉要等 20~30 秒）
function restartPipeline() {
  const olds = [];
  for (const s of state.cams.values()) { if (s.mainProc) olds.push(s.mainProc); if (s.motionProc) olds.push(s.motionProc); }
  const pids = olds.map(p => p.pid).filter(Boolean);
  for (const s of state.cams.values()) { s.mainProc = null; s.motionProc = null; s.recDir = null; }
  olds.forEach(killP);
  const t0 = Date.now();
  const iv = setInterval(() => {
    const alive = pids.some(pid => fs.existsSync(`/proc/${pid}`));
    if (!alive || Date.now() - t0 > 6000) {
      clearInterval(iv);
      pids.forEach(pid => { try { process.kill(pid, 'SIGKILL'); } catch {} });
      for (const cam of cfg.cameras) {
        try { const L = liveDirOf(cam); for (const f of fs.readdirSync(L)) if (/\.(ts|m3u8)$/.test(f)) fs.unlinkSync(path.join(L, f)); } catch {}
      }
      try { refreshPaths(); } catch {}
      if (!shuttingDown) startAll();
      log(`[cfg] 管线重启完成（旧进程退出耗时 ${Date.now() - t0}ms）`);
    }
  }, 250);
  log('[cfg] 配置已更新，正在重启管线…');
}
async function waitLiveReady(ms) {
  const cam = cfg.cameras.find(camConfigured);
  if (!cam) return false;
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const pl = fs.readFileSync(path.join(liveDirOf(cam), 'index.m3u8'), 'utf8');
      if ((pl.match(/\.ts/g) || []).length >= 1) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

// ---------- 测试连接 ----------
function probeStream(url, ms) {
  return new Promise(resolve => {
    if (!url) return resolve({ ok: false, error: '未填写摄像机地址' });
    const args = ['-hide_banner', '-rtsp_transport', 'tcp', '-timeout', '8000000', '-i', url, '-t', '0.5', '-f', 'null', '-'];
    let err = '';
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const to = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, ms || 15000);
    p.stderr.on('data', d => err += d.toString());
    p.on('exit', () => {
      clearTimeout(to);
      const vm = /Stream #0:\d+.*?Video:\s*([A-Za-z0-9_]+)/.exec(err);
      const codec = vm ? vm[1].toLowerCase() : '';
      const hasAudio = /Stream #0:\d+.*?Audio:/.test(err);
      const wm = /,\s*(\d{3,5})x(\d{3,5})/.exec(err);
      if (!codec) {
        let msg = '连接失败';
        if (/401|Unauthorized/i.test(err)) msg = '认证失败：用户名或密码不对';
        else if (/Connection refused|No route to host|timed out|Could not find codec|Connection timed out/i.test(err)) msg = '连不上：检查 IP / 端口 / 网络';
        else if (/404|Not Found/i.test(err)) msg = '通道不存在：检查通道号';
        return resolve({ ok: false, error: msg });
      }
      resolve({ ok: true, codec, width: wm ? +wm[1] : 0, height: wm ? +wm[2] : 0, audio: hasAudio, h265: /^(hevc|h265)$/.test(codec) });
    });
  });
}

// ---------- 目录浏览（保存目录选择器） ----------
function volumes() {
  const out = [];
  try {
    for (const line of fs.readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [dev, mnt, fstype] = line.split(' ');
      const m = /^\/vol(\d+)$/.exec(mnt || '');
      if (!m) continue;
      let total = 0, free = 0;
      try { const s = fs.statfsSync(mnt); total = s.blocks * s.bsize; free = s.bavail * s.bsize; } catch {}
      out.push({ path: mnt, name: '存储空间 ' + m[1], total, free });
    }
  } catch {}
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
const volRoots = () => volumes().map(v => v.path);
function insideVolume(p) {
  const n = path.normalize(p);
  return volRoots().some(r => n === r || n.startsWith(r + path.sep));
}
function suggestRoot(uid) {
  const vols = volumes(); if (!vols.length) return null;
  const best = vols.slice().sort((a, b) => b.free - a.free)[0];
  const cands = [];
  if (uid) cands.push(path.join(best.path, String(uid)));
  try {
    for (const e of fs.readdirSync(best.path)) if (/^\d+$/.test(e)) { cands.push(path.join(best.path, e)); break; }
  } catch {}
  cands.push(best.path);
  return path.join(cands[0], 'NVR');
}
async function browse(dir) {
  const n = path.normalize(dir);
  if (!insideVolume(n)) return { error: '路径不在存储空间内' };
  let ents = [];
  try { ents = await fsp.readdir(n, { withFileTypes: true }); } catch (e) { return { error: '无法读取该目录（权限不足或不存在）' }; }
  const dirs = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('@') || e.name.startsWith('.')) continue;
    dirs.push({ name: e.name, path: path.join(n, e.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  let free = 0, total = 0;
  try { const s = fs.statfsSync(n); free = s.bavail * s.bsize; total = s.blocks * s.bsize; } catch {}
  let writable = false;
  try { fs.accessSync(n, fs.constants.W_OK); writable = true; } catch {}
  const parent = n === '/' ? null : path.dirname(n);
  return { path: n, parent: insideVolume(parent) && parent !== n ? parent : null, dirs, free, total, writable,
           isRoot: volRoots().includes(n) };
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json' };
// 鉴权规则：
//  · 统一网关（Unix Socket）转发来的请求 —— 网关已校验飞牛登录态，直接放行（socket 由文件权限保护）
//  · TCP（本机/局域网）—— 设了口令走 Basic；未设口令时只允许本机回环访问
function authed(req, viaSock) {
  if (viaSock) return true;
  if (cfg.http.pass) {
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/);
    if (!m) return false;
    const raw = Buffer.from(m[1], 'base64').toString();
    const i = raw.indexOf(':');
    return i > 0 && raw.slice(0, i) === cfg.http.user && raw.slice(i + 1) === cfg.http.pass;
  }
  const ra = String((req.socket && req.socket.remoteAddress) || '');
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
}
function sendFile(req, res, fp) {
  let st; try { st = fs.statSync(fp); } catch { res.writeHead(404); return res.end('not found'); }
  const H = { 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  const range = req.headers.range;
  const onErr = e => { log('[sendFile] 读取失败', fp, e.message); try { if (!res.headersSent) res.writeHead(500); res.destroy(); } catch {} };
  const m = range && range.match(/bytes=(\d*)-(\d*)/);
  let start = m && m[1] ? +m[1] : 0, end = m && m[2] ? +m[2] : st.size - 1;
  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= st.size) end = st.size - 1;
  if (m && start <= end) {                                   // 合法区间 → 206
    H['Content-Range'] = `bytes ${start}-${end}/${st.size}`; H['Content-Length'] = end - start + 1;
    res.writeHead(206, H); fs.createReadStream(fp, { start, end }).on('error', onErr).pipe(res);
  } else {                                                   // 非法/无 Range → 200 全量
    H['Content-Length'] = st.size; res.writeHead(200, H); fs.createReadStream(fp).on('error', onErr).pipe(res);
  }
}
const BODY_LIMIT = 1024 * 1024;                                  // 请求体上限 1MB
function readBody(req, limit) {
  const lim = limit || BODY_LIMIT;
  return new Promise((res, rej) => {
    let b = '', n = 0;
    req.on('data', d => {
      n += d.length;
      if (n > lim) { try { req.pause(); } catch {} rej(new Error('request body too large')); return; }
      b += d;
    });
    req.on('end', () => res(b));
    req.on('error', e => rej(e));
  });
}

function camBrief(cam) {
  const s = cs(cam);
  const m = s.motion;
  return { id: cam.id, name: cam.name, dir: cam.dir, configured: camConfigured(cam), previewStream: cam.previewStream,
    recAlive: !!s.mainProc, liveAlive: !!s.mainProc, ringAlive: !!s.mainProc, motionAlive: !!s.motionProc,
    motion: { active: m.eventActive, lastMotionTs: m.lastMotionTs, lastScore: m.lastScore, eventCount: m.eventCount },
    live: `/live/${cam.id}/index.m3u8` };
}
async function listRecordings(camDirFilter) {
  const out = [];
  for (const fp of await walkMp4(cfg.record.root)) {
    const name = path.basename(fp), t = parseRecMs(name); if (t === null) continue;
    const st = await fsp.stat(fp).catch(() => null); if (!st) continue;
    const rel = path.relative(cfg.record.root, fp).split(path.sep).join('/');
    const seg = rel.split('/');
    const camDir = seg.length > 1 ? seg[0] : '';
    if (camDirFilter && camDir !== camDirFilter) continue;
    const complete = await fileComplete(fp, st);
    out.push({ name, rel, cam: camDir, dir: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      start: t, size: st.size, event: /-E\.mp4$/.test(name), complete });
  }
  out.sort((a, b) => b.start - a.start); return out;
}

const handler = async (req, res, viaSock) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  if (PREFIX && (p === PREFIX || p.startsWith(PREFIX + '/'))) {
    p = p.slice(PREFIX.length) || '/';
    if (u.pathname === PREFIX) { res.writeHead(302, { Location: PREFIX + '/' + (u.search || '') }); return res.end(); }
  }
  if (!authed(req, viaSock)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="nvr"' });
    return res.end('auth required：未设口令时仅允许本机访问；局域网访问请在 config.json 设置 http.pass');
  }
  try {
    if (p === '/api/status') {
      return json(res, {
        cameras: cfg.cameras.map(camBrief),
        configured: cfg.cameras.some(camConfigured),
        enabled: cfg.record.enabled,
        retentionDays: cfg.record.retentionDays, segmentSeconds: cfg.record.segmentSeconds,
        recordRoot: cfg.record.root, disk: diskInfo(), diskLow: diskLow(), res: { cpu: RES.cpu, mem: RES.mem }, serverTime: Date.now()
      });
    }
    if (p === '/api/motion') {
      const id = u.searchParams.get('cam');
      const cam = cfg.cameras.find(c => c.id === id) || cfg.cameras[0];
      if (!cam) return json(res, {});
      const m = cs(cam).motion;
      let ring = 0; try { ring = (await fsp.readdir(ringDirOf(cam))).filter(f => f.endsWith('.ts')).length; } catch {}
      return json(res, { active: m.eventActive, lastMotionTs: m.lastMotionTs, lastScore: m.lastScore,
        eventCount: m.eventCount, frames: m.frames, ring });
    }
    if (p === '/api/diag') { log('[diag]', decodeURIComponent(u.search.slice(1)).slice(0, 120)); return json(res, { ok: true }); }
    if (p === '/api/list') { const cam = u.searchParams.get('cam'); return json(res, await listRecordings(cam || null)); }
    if (p === '/api/snap') {
      const id = u.searchParams.get('cam');
      const cam = cfg.cameras.find(c => c.id === id) || cfg.cameras[0];
      const w = Math.max(0, Math.min(3840, +u.searchParams.get('w') || 0));
      const sub = u.searchParams.get('sub') === '1';
      // 限流：同一路缩略图 1.5 秒内只生成一次，避免被高频请求反复起 ffmpeg
      if (cam && w) {
        const tp = path.join(SNAP_ROOT, `thumb-${cam.id}.jpg`);
        try { const st = fs.statSync(tp); if (Date.now() - st.mtimeMs < 1500) return sendFile(req, res, tp); } catch {}
      }
      const s = cam ? await snapshotShared(cam, { w, sub }) : null;
      if (!s) { res.writeHead(503); return res.end('no snap'); }
      return sendFile(req, res, s);
    }
    // ---- 目录浏览 ----
    if (p === '/api/browse') {
      const dir = u.searchParams.get('path');
      if (!dir) return json(res, { roots: volumes(), suggest: suggestRoot(req.headers['x-trim-userid']) });
      return json(res, await browse(dir));
    }
    if (p === '/api/mkdir' && req.method === 'POST') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
      const name = String(body.name || '').replace(/[\\/:*?"<>|]/g, '').trim();
      const parent = body.parent;
      if (!name || !parent) { status(res, 400); return json(res, { ok: false, error: '名字不能为空' }); }
      const full = path.normalize(path.join(parent, name));
      if (!insideVolume(full)) { status(res, 400); return json(res, { ok: false, error: '路径不在存储空间内' }); }
      try { fs.mkdirSync(full, { recursive: true }); return json(res, { ok: true, path: full }); }
      catch (e) { status(res, 500); return json(res, { ok: false, error: e.message }); }
    }
    if (p === '/api/config') {
      if (req.method === 'GET') {
        const c = JSON.parse(JSON.stringify(cfg));
        const hasPass = {};
        for (const cam of c.cameras) { hasPass[cam.id] = !!cam.pass; cam.pass = ''; cam.rtspMain = ''; cam.rtspSub = ''; }
        return json(res, { config: c, hasPass, configured: cfg.cameras.some(camConfigured), enabled: cfg.record.enabled,
          volumes: volumes(), suggest: suggestRoot(req.headers['x-trim-userid']) });
      }
      if (req.method === 'PUT') {
        let body; try { body = JSON.parse(await readBody(req)); }
        catch (e) { status(res, /too large/.test(e.message) ? 413 : 400); res.__bad = true; return json(res, { ok: false, error: /too large/.test(e.message) ? '请求体过大' : 'bad json' }); }
        const sig = () => cfg.cameras.map(cam => [cam.id, cam.ip, cam.port, cam.user, cam.pass, cam.channel, cam.previewStream].join(':')).join('|')
                       + '#' + [cfg.record.root, cfg.record.segmentSeconds].join('|');
        const before = sig();
        if (Array.isArray(body.cameras)) {
          const old = new Map(cfg.cameras.map(c => [c.id, c]));
          cfg.cameras = body.cameras.slice(0, MAX_CAMS).map(inp => {
            const prev = old.get(inp.id) || {};
            const cam = newCamera({ ...prev, id: inp.id && old.has(inp.id) ? inp.id : (inp.id || camIdGen()) });
            for (const k of ['name', 'ip', 'user']) if (inp[k] !== undefined) cam[k] = String(inp[k]).trim();
            if (inp.pass) cam.pass = String(inp.pass);          // 空 = 保持原密码
            cam.port = Math.max(1, parseInt(inp.port) || 554);
            cam.channel = Math.max(1, parseInt(inp.channel) || 1);
            cam.previewStream = inp.previewStream === 'sub' ? 'sub' : 'main';
            return cam;
          });
          if (!cfg.cameras.length) cfg.cameras = [newCamera()];
          for (const id of [...state.cams.keys()]) if (!cfg.cameras.some(c => c.id === id)) state.cams.delete(id);   // 回收已删除摄像机的状态
        }
        const rec = body.record || {};
        if (rec.retentionDays !== undefined) cfg.record.retentionDays = Math.min(365, Math.max(1, parseInt(rec.retentionDays) || 3));
        if (rec.segmentSeconds !== undefined) cfg.record.segmentSeconds = Math.min(3600, Math.max(60, parseInt(rec.segmentSeconds) || 300));
        if (rec.root) {
          const nr = path.normalize(String(rec.root).trim());
          if (!insideVolume(nr)) { status(res, 400); return json(res, { ok: false, error: '保存目录必须在存储空间（/vol1、/vol2…）内' }); }
          try { fs.mkdirSync(nr, { recursive: true }); fs.accessSync(nr, fs.constants.W_OK); cfg.record.root = nr; }
          catch { status(res, 400); return json(res, { ok: false, error: '该目录不可写，请换一个' }); }
        }
        if (rec.enabled !== undefined) cfg.record.enabled = !!rec.enabled;
        applyCameraUrls(cfg);
        refreshPaths();
        fixHosts();
        writeCfg();
        const changed = before !== sig();
        let liveReady = true;
        if (changed) { restartPipeline(); liveReady = await waitLiveReady(6000); }
        return json(res, { ok: true, configured: cfg.cameras.some(camConfigured), enabled: cfg.record.enabled,
          restarted: changed, liveReady, cameras: cfg.cameras.map(camBrief) });
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    if (p === '/api/test') {
      let body = {}; try { body = JSON.parse(await readBody(req)); } catch {}
      const prev = body.id ? cfg.cameras.find(c => c.id === body.id) : null;
      const cam = Object.assign({}, prev || {}, body.camera || {});
      if (!cam.pass && prev) cam.pass = prev.pass;
      if (!cam.ip) { status(res, 400); return json(res, { ok: false, error: '未填写摄像机 IP' }); }
      const uMain = hkRtsp(cam.ip, cam.port, cam.user, cam.pass, cam.channel, true);
      const uSub = hkRtsp(cam.ip, cam.port, cam.user, cam.pass, cam.channel, false);
      const main = await probeStream(uMain);
      const sub = await probeStream(uSub);
      const h265 = (main.h265 || sub.h265) || false;
      return json(res, { ok: !!(main.ok || sub.ok), main, sub, h265,
        advice: h265 ? '该码流为 H.265，手机/浏览器无法直接播放。请到摄像头后台「配置 → 视音频 → 视频」把编码改为 H.264（建议主、子码流都改），保存后再回来测试。' : '' });
    }
    // ---- 直播（每台一路） ----
    if (p === '/live/index.m3u8' || p.startsWith('/live/')) {
      const rest = p.slice(6).replace(/^\//, '');
      let camId = null, file = rest;
      if (rest.includes('/')) { const seg = rest.split('/'); camId = seg[0]; file = seg.slice(1).join('/'); }
      const cam = camId ? cfg.cameras.find(c => c.id === camId)
                        : (cfg.cameras.find(camConfigured) || cfg.cameras[0]);
      if (!cam) { res.writeHead(404); return res.end('no camera'); }
      return sendFile(req, res, path.join(liveDirOf(cam), path.basename(file)));
    }
    if (p.startsWith('/rec/')) {
      const rel = decodeURIComponent(p.slice(5));
      const fp = path.normalize(path.join(cfg.record.root, rel));
      if (fp !== cfg.record.root && !fp.startsWith(cfg.record.root + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
      return sendFile(req, res, fp);
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
    if (['/', '/index.html', '/app.js', '/sw.js', '/settings.html'].includes(p)) {
      log('[req]', p, '|dest=' + (req.headers['sec-fetch-dest'] || '-'),
        '|ua=' + String(req.headers['user-agent'] || '-').slice(0, 34),
        '|ref=' + String(req.headers['referer'] || '-').slice(0, 60));
    }
    const fp = path.join(PUB, rel);
    if (!fp.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
    if (fs.existsSync(fp)) return sendFile(req, res, fp);
    res.writeHead(404); res.end('not found');
  } catch (e) {
    log('[http] error', e.message);
    try { if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('err: ' + e.message); }
    catch (e2) { log('[http] error(2)', e2.message); try { res.destroy(); } catch {} }
  }
};
function status(res, code) { res.__code = code; }
function json(res, o, code) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  res.writeHead(code || res.__code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o));
}
const DISK_MIN_FREE = 500 * 1024 * 1024;             // 录像盘剩余 < 500MB 时暂停录像，等清理后自动恢复
function diskFree() { try { const s = fs.statfsSync(cfg.record.root); return s.bavail * s.bsize; } catch { return null; } }
function diskLow() { const f = diskFree(); return f !== null && f < DISK_MIN_FREE; }
let diskPaused = false;
function diskInfo() {
  try { const s = fs.statfsSync(cfg.record.root); const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
    return { total, free, usedRatio: 1 - free / total, path: cfg.record.root }; } catch { return null; }
}
// ---- 进程资源采样 ----
const RES = { cpu: 0, mem: 0 };
let resPrev = null;
function _jiffies(pid) { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const r = s.lastIndexOf(')'); const a = s.slice(r + 2).split(' '); return (+a[11]) + (+a[12]); } catch { return null; } }
function _rss(pid) { try { const m = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' '); return (+m[1]) * 4096; } catch { return 0; } }
function _kids(pid) { try { return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } }
function sampleRes() {
  const pids = [process.pid, ..._kids(process.pid)];
  let j = 0, rss = 0;
  for (const p of pids) { const x = _jiffies(p); if (x != null) j += x; rss += _rss(p); }
  const now = Date.now();
  if (resPrev) { const dt = (now - resPrev.t) / 1000; if (dt > 0) RES.cpu = Math.max(0, ((j - resPrev.j) / 100 / dt) * 100); }
  resPrev = { t: now, j }; RES.mem = rss;
}
sampleRes(); setInterval(sampleRes, 5000);

function resolveCert() {
  try {
    const base = cfg.https?.certDir; if (!base) return null;
    const cands = [];
    for (const sub of fs.readdirSync(base)) {
      const fc = path.join(base, sub, 'fullchain.crt');
      if (!fs.existsSync(fc)) continue;
      const key = fs.readdirSync(path.join(base, sub)).find(f => f.endsWith('.key'));
      if (key) cands.push([fs.statSync(fc).mtimeMs, fc, path.join(base, sub, key)]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    return cands[0] ? [cands[0][1], cands[0][2]] : null;
  } catch { return null; }
}
const httpServer = http.createServer(handler);
const servers = [httpServer];
const SOCK = process.env.NVR_SOCK || '';
if (SOCK) {
  try { fs.unlinkSync(SOCK); } catch {}
  const sockServer = http.createServer((req, res) => handler(req, res, true));   // viaSock：仅网关可走信任分支
  sockServer.listen(SOCK, () => {
    try { fs.chmodSync(SOCK, 0o666); } catch {}
    log('[main] unix socket', SOCK, 'prefix', PREFIX);
  });
  sockServer.on('error', e => log('[sock] 启动失败', e.message));
  servers.push(sockServer);
}
let httpsServer = null;
if (cfg.https && cfg.https.enabled) {
  try {
    const c = resolveCert();
    if (c) { httpsServer = https.createServer({ cert: fs.readFileSync(c[0]), key: fs.readFileSync(c[1]) }, handler);
      servers.push(httpsServer); log('[https] 证书', c[0]); }
    else log('[https] 未找到可用证书');
  } catch (e) { log('[https] 启动失败', e.message); }
}
function shutdown() {
  shuttingDown = true; log('[main] 退出中…');
  for (const s of state.cams.values()) { killP(s.mainProc); killP(s.motionProc); }
  servers.forEach(s => s.close(() => {}));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

reapOrphans();
setInterval(reapOrphans, 60000);
pruneSnaps();
setInterval(pruneSnaps, 3600000);
migrateNames();
startAll();
httpServer.on('error', e => log('[http] 监听失败', e.message));
httpServer.listen(cfg.http.port, cfg.http.host, () => log(`[main] http://${cfg.http.host}:${cfg.http.port}  cameras=${cfg.cameras.length}  rec=${cfg.record.root}`));
if (httpsServer) httpsServer.listen(cfg.https.port, cfg.https.host || '0.0.0.0', () =>
  log(`[main] https://${cfg.https.host || '0.0.0.0'}:${cfg.https.port}`));
