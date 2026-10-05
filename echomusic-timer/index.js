// echomusic-timer v3.7.1 · author: Luo
// v3.7.1：修复 toast 堆积 bug——once 模式到点进入「等待播完」后未停掉每秒到点判断 tick，下一秒仍满足到点条件重复 startPending()：每秒弹 toast 堆积成 ×n，且 pending 反复重建使无播放缓冲/2h 硬兜底永不触发；现到点后停掉该 tick，只保留 500ms 等待轮询。另：teardown 补停 popupTick，消除卸载时读秒 interval 泄漏。
// v3.7.0：「播完再执行」升级——到点无条件进入等待态（不再要求"到点时刻正在播放"），中途打开播放器开始播也能等到该曲播完再执行；等待期间无任何播放迹象超过 15 分钟（无播放缓冲）则直接执行，2 小时硬兜底保留。
// v3.6.9：修复「播完再执行」误判——isPlaying() 在 store 探测失败/字段缺失时 return false 被误判为播完直接执行（播一半即关机）；改用 isPlayingReal()（宿主 nowPlaying 桥兜底）三态判定：true=在播继续等、false=确认不在播、null=无法探测不判结束；仅「确认不在播放且当前曲目被清空（停止）」才算结束，手动暂停（曲目仍在）继续等待。
// v3.6.8：stopTimer 仅在 sysShutdownPending 为真（本会话确实排程过系统关机）时才联动取消，消除 stop/close 等非关机场景误弹「已取消系统关机」；到点自动关闭不再弹「如需每天执行请重新开启」冗余提示，动作结果统一由 fire() 提示。
// v3.6.1（Luo 定制版）：在 v3.6.0 恢复的 238px 旧版 UI 基础上，将弹窗上下高度整体压缩至约 2/3
//   （标题/正文 padding、各控件行高/间距/字号同步收紧，结构不变）。
// v3.6.0 历史：
//   · UI 回退：用户反馈 120px 极窄弹窗过小、还是之前的 UI 好看，弹窗恢复 v3.4.0 前的
//     238px 旧版样式（et-lb2 标签列 + 宽松排版 + 底部说明行），控件重新占位。
//   · 保留 v3.5.0 全部逻辑修复与「结束时机」选项（立即 / 播完再执行，独立分段控件）。
//   · 历史修复（v3.5.0 保留）：「只有提示生效、实际未执行」根因（逆向宿主主进程核实）：
//     - 关闭软件 quit：宿主 plugins.process.launch 硬性只允许插件目录内 .exe，系统 taskkill
//       永远被拒且 doQuitApp 未检查返回即 return true（假成功）。真相：宿主注册全局 IPC
//       'quit-app' → app.quit() 才是唯一真退出通道，改走 window.electron.ipcRenderer.send('quit-app')。
//     - 停止播放 stop：插件运行上下文（页内宿主 ctx）根本不注入 pinia player store，
//       store() 恒为 null 导致播放控制永远失败。真相：用 preload 暴露的
//       window.electron.nowPlaying.getSnapshot()/command('togglePlayback') 桥接宿主主界面真实播放状态。
//     - 定时关机 shutdown：宿主无系统关机通道、process.launch 又拒系统 exe，故只能由插件目录
//       内置「关机启动器.exe」+ process.launch 实现（首次宿主弹授权确认，允许后免确认）。
// v3.4.0（Luo 定制版）：UI 整体重设美观化（紧凑 238px→120px，视觉层级/控件精致化）；
//   新增「结束时机」选项——立即 / 播完当前曲目再执行（endWhen: now|songEnd：到点若在播放
//   则等待当前曲目播完再执行，检测 isPlaying/currentTrackId/播放位置，等待期间可随时取消，
//   防呆 2 小时兜底强执行）。
// v3.3.0（Luo 定制版）：移除未使用的 $ / $$ DOM 查询助手；activate 的 dispose 清理回调
//   与 deactivate 完全重复，统一收口到 teardown()。
// 定时执行：停止播放 / 关闭 EchoMusic / 定时关机
// 触发方式：指定时刻（HH:mm，已过顺延到明日）或 倒计时（分钟）
// 重复：仅一次 / 每天
//
// v3.2.1（Luo 定制版，【版本号对齐】）：manifest 已升至 3.2.1，本文件头部注释与
//   启动 toast 同步对齐至 v3.2.1（此前注释停留在 v2.5/v2.6、toast 显示 v2.5，
//   三处版本描述互相矛盾）。历史变更以 v2.x 系列记录保留如下。
//
// v2.6（Luo 定制版）：修复「点击弹窗外空白无法取消/关闭」——打开弹窗时注册全局
//   mousedown（capture）+ ESC 监听，点击目标不在弹窗内也不在入口图标上即关闭；
//   关闭弹窗时移除监听，避免残留。
//
// v2.4（Luo 定制版）：弹窗缩放动画对齐顶部时钟图标——transform-origin 动态计算
//   指向锚点（时钟图标）位置，弹窗从图标处「放大长出」（scale .72→1 + 弹性缓动）
//   而非自身中心缩放；关闭时反向缩小回图标处。找不到锚点回退右上角原点。
//
// v2.5（Luo 定制版）：定时设置/定时停止图标竖对齐——优先把弹窗锚定到顶栏
//   「定时」入口图标（插件按钮）自身：弹窗右缘与图标右缘贴齐、竖直方向紧贴图标
//   正下方展开，缩放动画原点同步指向该图标，实现“弹窗与图标竖排对齐”；
//   插件按钮不在场时才回退到时钟元素启发式。
//
// v2.3（Luo 定制版）：
//   - 弹窗锚定顶部「时间/时钟」元素右下方：右缘与时钟右缘对齐（整体左移、
//     竖边贴齐图标右侧），垂直跟随；找不到时钟元素回退锚定插件按钮。
//   - 「暂停播放 / 停止播放」统一为「停止播放」：二者在播放器行为上无实质
//     区别，实际执行均调 player.stop（无 stop 时回退暂停），旧配置自动迁移。
//
// v2.2（Luo 定制版）：弹窗紧凑化——宽度 278→238、内边距/字号全面缩小、
//   精简标题栏待执行标签与底部提示，降低遮挡，弹窗锚定顶部按钮下方不受影响。
//
// v2.1 修复：
//   - 改用官方 activate(ctx) 插件 API：storage/toast 走 ctx 通道，
//     不再依赖不存在的全局 kugou.methods（旧版导致配置读取失效）。
//   - 播放控制改为调用 player store（pause/togglePlay/stop），
//     不再依赖不存在的 window.electron.plugins.player（旧版导致动作无效）。
//   - 新增顶部标题栏入口按钮（.titlebar-nav 内 .tb-search 之后，仿 zhs-plugin-btn），
//     轮询保位，解决「顶部图标消失 / 入口丢失」问题。
//   - 保留侧栏 .plugin-list li 入口兜底，兼容未来宿主侧栏。

let ctxRef = null;
let cfg = {
  enabled: false,
  action: 'stop',    // stop / quit / shutdown（pause 已并入 stop：暂停/停止统一为停止）
  gate: 'hhmm',      // hhmm / cd
  hhmm: '23:59',
  cdMin: 30,
  repeat: 'once',    // once / daily
  endWhen: 'now',    // now / songEnd（结束时机：到点立即执行 / 等当前曲目播放完毕再执行）
};
let tick = null;
let nextStamp = 0;
let scheduleStart = 0;   // 本周期倒计时起算时刻（环形进度比例基准，未启用清 0）
let entryWatch = null;
let topBtnRef = null;

const BTN_ID = 'et-luo-topbtn';
const ENTRY_ID = 'et-luo-entry';
const ET_STYLE_ID = 'et-luo-topbtn-style';
const pad2 = (n) => String(n).padStart(2, '0');

// v3.5.0：动作+结束时机合并为单一紧凑下拉的映射键（action:endWhen）
function actKey() {
  let a = cfg.action;
  if (a === 'pause') a = 'stop';
  if (['stop', 'quit', 'shutdown'].indexOf(a) < 0) a = 'stop';
  return a + ':' + (cfg.endWhen === 'songEnd' ? 'songEnd' : 'now');
}

function store() {
  try {
    return (ctxRef && ctxRef.pinia && ctxRef.pinia._s && ctxRef.pinia._s.get('player')) ||
      (ctxRef && ctxRef.stores && ctxRef.stores.player) || null;
  } catch (e) { return null; }
}

/* ---------------- 配置存取（via ctx.storage） ---------------- */
async function loadCfg() {
  try {
    const v = await ctxRef.storage.get('echomusic-timer.cfg');
    if (v && typeof v === 'object') cfg = { ...cfg, ...v };
  } catch (e) {}
  // v2.3：pause 与 stop 在播放器行为上无实质区别，统一为 stop，旧配置自动迁移
  if (cfg.action === 'pause') cfg.action = 'stop';
}
function persist() {
  try { const p = ctxRef.storage.set('echomusic-timer.cfg', cfg); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}

/* ---------------- v3.6.3 诊断日志（写 storage，宿主 sqlite 可核验） ---------------- */
const DIAG_CAP = 80;
let diagBuf = [];
function diag(...args) {
  try {
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    const line = '[' + ts + '] ' + args.map((a) => {
      try { return (typeof a === 'object') ? JSON.stringify(a) : String(a); } catch (e) { return String(a); }
    }).join(' ');
    diagBuf.push(line);
    if (diagBuf.length > DIAG_CAP) diagBuf = diagBuf.slice(-DIAG_CAP);
    const p = ctxRef && ctxRef.storage && ctxRef.storage.set('echomusic-timer.diag', { v: 'v3.6.8', lines: diagBuf });
    if (p && p.catch) p.catch(() => {});
  } catch (e) {}
}
function toast(m, type) {
  try {
    const t = ctxRef && ctxRef.toast;
    if (t && t[type || 'info']) t[type || 'info'](m);
  } catch (e) { console.log('[echomusic-timer]', m); }
}

/* ---------------- 时间计算 ---------------- */
function fmtStamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
/** 倒计时剩余时间：>=1 小时显示 HH:MM:SS，否则 X分X秒 / X秒；传入非法或 <=0 返回空串 */
function fmtCountdown(ms) {
  if (!(ms > 0)) return '';
  let s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  s = s % 60;
  if (h > 0) return pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  if (m > 0) return m + '分' + s + '秒';
  return s + '秒';
}
function calcNext() {
  const now = new Date();
  if (cfg.gate === 'cd') {
    const t = Math.max(1, Number(cfg.cdMin) || 15);
    return now.getTime() + t * 60 * 1000;
  }
  const [h, m] = (cfg.hhmm || '23:59').split(':').map(Number);
  const t = new Date(now);
  t.setHours(h || 0, m || 0, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

/* ---------------- 执行动作（player store + 官方桥） ---------------- */
function ensurePaused(fallbackToggle) {
  const s = store();
  if (!s) return false;
  try {
    if (typeof s.pause === 'function') { s.pause(); return true; }
    if (typeof s.togglePlay === 'function') {
      const st = s.$state || {};
      const ep = (st.enginePlayback && typeof st.enginePlayback === 'object') ? st.enginePlayback : {};
      const playing = ('playing' in ep) ? !!ep.playing : null;
      if (playing === null) {
        s.togglePlay();                     // 无法判断时切换一次
        return true;
      }
      if (playing) s.togglePlay();          // 正在播放才暂停
      return true;
    }
  } catch (e) { console.warn('[timer] pause fail', e); }
  if (fallbackToggle && s && typeof s.togglePlay === 'function') { try { s.togglePlay(); } catch (e) {} }
  return false;
}
/**
 * 宿主真实播放状态（preload 的 nowPlaying 桥，插件上下文可靠可用）
 * @returns {boolean|null} true=播放中 false=已暂停/停止 null=无法探测
 */
async function hostPlaybackState() {
  try {
    const np = window.electron && window.electron.nowPlaying;
    if (np && typeof np.getSnapshot === 'function') {
      const sn = await np.getSnapshot();
      if (sn && sn.playback) return !!sn.playback.isPlaying;
    }
  } catch (e) {}
  return null;
}

/**
 * 停止播放（v3.6.7bis 修复停止播放清空当前曲目的根因）：
 * 宿主 player store 的 stop() 语义=「停止并清空当前曲目/队列指针」（currentTrackId=null、
 * updateQueueCurrentTrack(null)），并非"暂停保留"。插件若优先调用 s.stop()，
 * 会造成"歌曲貌似被删、再点播放跳到别的歌"。
 * 修复：不再调用宿主 stop()。正确语义=仅暂停（保留队列与当前曲）。
 *   1) 优先 player store 的暂停路径（pause / 按真实播放态 togglePlay，即 ensurePaused）
 *   2) 其次走 preload nowPlaying 桥 togglePlayback（主界面 ⌘Space 同源命令，播放中→暂停）
 *   3) 兜底 store.togglePlay
 */
async function doPlayerStop() {
  const s = store();
  try { if (s && ensurePaused(true)) return true; } catch (e) {}
  try {
    const np = window.electron && window.electron.nowPlaying;
    if (np && typeof np.command === 'function') {
      const playing = await hostPlaybackState();
      if (playing !== false) np.command('togglePlayback'); // 播放中→暂停；无法探测时也尝试切换
      return true;
    }
  } catch (e) { console.warn('[timer] nowPlaying bridge fail', e); }
  if (s && typeof s.togglePlay === 'function') { try { s.togglePlay(); return true; } catch (e) {} }
  return false;
}

/**
 * 关闭 EchoMusic（v3.5.0 修复根因）：
 * 宿主 plugins.process.launch 只允许插件目录内 .exe，系统 taskkill 调用必然失败且旧代码
 * 未检查返回、直接 return true → 呈现"已关闭"但进程未退。经逆向宿主主进程：
 * 宿主全局注册了 IPC 通道 'quit-app' → 调用 app.quit() 真退出（ipcMain.on 无 sender 校验，
 * 插件页面 send 即可触发）。此通道为主力；quit 类 API / window.close 仅作兜底且不因返回值短路。
 */
function doQuitApp() {
  const E = window.electron;
  // 1) 主力：宿主全局 IPC 'quit-app' → app.quit()（已验证 ipcMain.on 注册、无发送方校验）
  try {
    if (E && E.ipcRenderer && typeof E.ipcRenderer.send === 'function') {
      E.ipcRenderer.send('quit-app');
      return true;
    }
  } catch (e) { console.warn('[timer] quit-app send fail', e); }
  // 2) 兜底：优雅退出 API（尽力而为）
  if (E) {
    const cands = [
      () => { const a = E.plugins && E.plugins.app; if (a && typeof a.quit === 'function') { try { a.quit(); } catch (e) {} return true; } return false; },
      () => { const a = E.app; if (a && typeof a.quit === 'function') { try { a.quit(); } catch (e) {} return true; } return false; },
      () => { if (typeof E.quit === 'function') { try { E.quit(); } catch (e) {} return true; } return false; },
    ];
    for (const fn of cands) { try { if (fn()) return true; } catch (e) {} }
  }
  // 3) 兜底：关闭渲染进程窗口
  try { if (typeof window.close === 'function') { window.close(); return true; } } catch (e) {}
  return false;
}

/**
 * 定时关机（宿主架构限制说明）：
 * 宿主 process.launch 硬性只允许「插件目录内」的 .exe/.com，系统 shutdown.exe 无法直接调用，
 * 主进程也无系统电源通道。可行方案：插件目录内置「关机启动器.exe」（调用系统 shutdown /s），
 * 经 process.launch 启动（首次宿主弹授权确认，允许并记住后免确认）。
 * 若插件目录存在 echo-timer-shutdown.exe 则以其为主力；否则明确告知不支持，避免假成功。
 */
async function doShutdown() {
  const P = window.electron && window.electron.plugins;
  const launcher = 'echo-timer-shutdown.exe'; // 需与插件同目录放置
  diag('shutdown:start', launcher);
  try {
    if (P && P.process && typeof P.process.launch === 'function') {
      diag('shutdown:bridge-ok launch-ing');
      try {
        const r = await P.process.launch('echomusic-timer', { executable: launcher, args: [] });
        diag('shutdown:launch-return', r);
        if (r && r.ok === true && Number.isFinite(r.pid)) { diag('shutdown:OK', 'pid=' + r.pid); sysShutdownPending = true; toast('已触发系统关机（延时 60 秒，回弹停止按钮即可取消）', 'warning'); return true; }
        if (r && r.canceled) { diag('shutdown:CANCELED'); toast('系统关机被取消：需在授权弹窗点【允许并记住】后才会执行', 'warning'); return false; }
        if (r && r.error) { diag('shutdown:ERROR', r.error); toast(`定时关机未触发：${r.error}`, 'danger'); return false; }
        diag('shutdown:NO-RETURN-FIELD', r);
        toast('定时关机未触发：关机启动器启动失败', 'danger');
        return false;
      } catch (e) {
        diag('shutdown:launch-throw', e && e.message ? e.message : String(e));
        console.warn('[timer] shutdown launcher fail（需在插件目录放置 echo-timer-shutdown.exe）', e);
      }
    } else {
      diag('shutdown:bridge-missing', 'el=' + !!window.electron, 'plugins=' + !!(window.electron && window.electron.plugins), 'process=' + !!(window.electron && window.electron.plugins && window.electron.plugins.process));
    }
  } catch (e) { diag('shutdown:outer-throw', String(e)); }
  toast('定时关机不可用：宿主禁止插件调用系统命令，请在插件目录放置关机工具', 'danger');
  return false;
}

/* v3.6.4：点【开始】主动触发一次关机授权（--dry 试运行，不真关机）。
 * 宿主授权白名单绑定 exe 哈希，预授权后到点 launch 同一 exe 直接放行、不再弹窗。 */
async function ensureShutdownConsent() {
  const P = window.electron && window.electron.plugins;
  if (!(P && P.process && typeof P.process.launch === 'function')) { diag('consent:bridge-missing'); return; }
  const launcher = 'echo-timer-shutdown.exe';
  diag('consent:launch-dry', 'probe');
  try {
    const r = await P.process.launch('echomusic-timer', { executable: launcher, args: ['--dry'] });
    diag('consent:return', r);
    if (r && r.ok === true && Number.isFinite(r.pid)) { diag('consent:OK'); return; }
    if (r && r.canceled) { diag('consent:CANCELED'); return; }
    if (r && r.error) { diag('consent:ERROR', r.error); return; }
    diag('consent:NO-RETURN-FIELD', r);
  } catch (e) {
    diag('consent:throw', e && e.message ? e.message : String(e));
  }
}

/* v3.6.5：停止定时时联动取消已排程的系统关机（shutdown /a，经插件目录 cancel exe）。
 * cancel exe 首次 launch 会触发宿主授权，故在点【开始】时用 --dry 预授权，停止时静默执行。 */
async function preAuthCancel() {
  const P = window.electron && window.electron.plugins;
  if (!(P && P.process && typeof P.process.launch === 'function')) return;
  try {
    const r = await P.process.launch('echomusic-timer', { executable: 'echo-timer-cancel.exe', args: ['--dry'] });
    diag('cancel:preauth', r && r.ok ? 'ok' : (r && r.error ? r.error : (r && r.canceled ? 'canceled' : 'unknown')));
  } catch (e) { diag('cancel:preauth-throw', e && e.message ? e.message : String(e)); }
}

async function cancelSystemShutdown(src) {
  diag('cancel:enter', 'src=' + (src || '?'), 'sysShutdownPending=' + sysShutdownPending, 'enabled=' + cfg.enabled);
  const P = window.electron && window.electron.plugins;
  if (!(P && P.process && typeof P.process.launch === 'function')) { diag('cancel:bridge-missing'); return; }
  // 无条件尝试取消系统关机（shutdown /a）：即使内存标志丢失 / 拐到旧实例，
  // 只要系统确实在倒计时，就能真正撤销，避免「点了停止却无法取消」。
  try {
    const r = await P.process.launch('echomusic-timer', { executable: 'echo-timer-cancel.exe', args: [] });
    diag('cancel:return', r);
    if (r && r.ok === true) {
      if (sysShutdownPending) { sysShutdownPending = false; updateEntryLabel(); try { syncStButton(); } catch (e) {} }
      diag('cancel:OK');
      toast('已取消系统关机', 'success');
    }
    else if (r && r.canceled) diag('cancel:CANCELED');
    else if (r && r.error) { diag('cancel:ERROR', r.error); toast('取消系统关机失败：' + r.error, 'warning'); }
    else if (r && r.ok === false) { diag('cancel:FAIL', r); toast('取消系统关机未生效（系统无待取消的关机排程）', 'info'); }
    else diag('cancel:NO-RETURN-FIELD', r);
  } catch (e) { diag('cancel:throw', e && e.message ? e.message : String(e)); }
}


async function fire() {
  const act = cfg.action;
  diag('fire:triggered', 'act=' + act, 'endWhen=' + cfg.endWhen, 'gate=' + cfg.gate, 'repeat=' + cfg.repeat, 'hhmm=' + cfg.hhmm, 'cdMin=' + cfg.cdMin);
  try {
    if (act === 'stop' || act === 'pause') {
      const ok = await doPlayerStop();
      diag('fire:stop-result', 'ok=' + ok);
      if (ok) toast('定时任务：已停止播放', 'success');
      else toast('无法停止：播放器不可用', 'danger');
    } else if (act === 'quit') {
      try {
        const ok = doQuitApp();
        diag('fire:quit-result', 'ok=' + ok);
        if (ok) toast('定时任务：已关闭 EchoMusic', 'success');
        else { toast('自动关闭失败（宿主桥不可用），请手动退出', 'danger'); console.log('[timer] 关闭 EchoMusic 失败：doQuitApp 返回 false'); }
      } catch (e) { toast('自动关闭失败（宿主桥不可用），请手动退出', 'danger'); console.warn('[timer] 关闭 EchoMusic 异常', e); }
    } else if (act === 'shutdown') {
      toast('定时任务：触发系统关机', 'warning');
      setTimeout(() => { doShutdown().catch(() => {}); }, 300);
    }
  } catch (e) { diag('fire:throw', e && e.message ? e.message : String(e)); console.warn('[timer] fire fail', e); }
}

/* ---------------- 结束时机：等待当前曲目播放完毕（v3.4.0） ---------------- */
let pending = null;   // { trackId, started, tick } —— 到点后 songEnd 等待状态
let sysShutdownPending = false; // v3.6.5: 系统级关机已排程标志（60s 缓冲期内可由 stop 取消）

/** 播放器是否正在播放（player store 多字段兼容） */
function isPlaying() {
  const s = store();
  if (!s) return false;
  try {
    const st = (s.$state && typeof s.$state === 'object') ? s.$state : s;
    const ep = (st.enginePlayback && typeof st.enginePlayback === 'object') ? st.enginePlayback : {};
    if ('playing' in ep) return !!ep.playing;
    if ('isPlaying' in st) return !!st.isPlaying;
    if ('playing' in st) return !!st.playing;
    if (typeof s.isPlaying === 'function') return !!s.isPlaying();
  } catch (e) {}
  return false;
}
/**
 * 播放器是否正在播放（含宿主桥兜底，v3.6.9）：
 * 返回 true=正在播放；false=确认不在播放；null=无法探测（store 与桥均失败）。
 * 无法探测不判结束，避免探测失败导致「播一半误判播完直接执行」。
 */
async function isPlayingReal() {
  if (isPlaying()) return true;
  const hp = await hostPlaybackState();
  if (hp === null) return null;
  return hp;
}
/** 当前曲目 ID（currentTrackId / currentTrackSnapshot / currentId 多字段兼容） */
function currentTrackId() {
  const s = store();
  if (!s) return '';
  try {
    const st = (s.$state && typeof s.$state === 'object') ? s.$state : s;
    if (st.currentTrackId) return String(st.currentTrackId);
    const snap = st.currentTrackSnapshot;
    if (snap && (snap.id || snap.hash)) return String(snap.id || snap.hash);
    if (st.currentId) return String(st.currentId);
    if (st.songId) return String(st.songId);
  } catch (e) {}
  return '';
}
/** 播放是否已接近结尾（剩余不足 0.9s） */
function nearTrackEnd() {
  const s = store();
  if (!s) return false;
  try {
    const st = (s.$state && typeof s.$state === 'object') ? s.$state : s;
    const dur = Number(st.duration || 0);
    const cur = Number(st.currentTime || 0);
    return dur > 0 && (dur - cur) < 0.9;
  } catch (e) { return false; }
}

/**
 * 到点且选择「播完当前曲目」：进入等待态，等当前曲目播放结束（下一首/停止/近结尾）再真正执行。
 * 等待期间可点弹窗「停止定时」或 teardown 取消。防呆：超过 2 小时强制执行，避免流媒体卡死。
 */
const NO_PLAY_GRACE_MS = 15 * 60 * 1000;   // v3.7.0：进入等待后无任何播放迹象的缓冲时长
function startPending() {
  stopPending();
  const trackId = currentTrackId();
  const started = Date.now();
  toast(cfg.action === 'shutdown' ? '定时到点：等待当前歌曲播完再关机' : '定时到点：等待当前歌曲播完…', 'info');
  updateEntryLabel();
  pending = {
    trackId, started,
    seenPlaying: !!trackId,     // 进入等待时已有曲目视为「正在播放中」
    noPlaySince: Date.now(),    // 无播放缓冲起点（seenPlaying 后不再生效）
    tick: setInterval(async () => {
      if (!pending) return;
      const id = currentTrackId();
      const playing = await isPlayingReal();
      if (!pending) return;   // 等待期间可能已被取消/teardown
      const p = pending;
      // 有播放迹象（正在播 / 存在曲目）→ 标记已进入播放，关闭无播放缓冲
      if (playing === true || id) {
        if (!p.seenPlaying) { p.seenPlaying = true; p.noPlaySince = 0; }
      }
      const now = Date.now();
      // v3.6.9：暂停（曲目仍在）≠ 播完，仅「确认不在播放且当前曲目被清空（停止）」才算结束；
      // 无法探测（playing===null）不判结束，交由近结尾/切歌/超时兜底。
      const stopped = playing === false && !id;
      const done = stopped || nearTrackEnd() || (p.trackId && id && id !== p.trackId);
      // v3.7.0：无播放缓冲——进入等待后从未出现播放迹象且超过缓冲时长 → 执行（防干等）
      const noPlayGrace = !p.seenPlaying && p.noPlaySince > 0 && (now - p.noPlaySince > NO_PLAY_GRACE_MS);
      // 硬兜底：2 小时强制
      const hardTimeout = (now - p.started > 2 * 3600 * 1000);
      if (done || noPlayGrace || hardTimeout) {
        stopPending();
        if (cfg.repeat !== 'daily') {
          stopTimer(true);   // v3.6.8: 到点自动关闭不重复 toast，动作结果统一由 fire() 提示
        }
        fire();
      }
    }, 500),
  };
}
function stopPending() {
  if (pending) {
    const p = pending;
    pending = null;
    if (p.tick) { clearInterval(p.tick); p.tick = null; }
  }
  updateEntryLabel();
}

/* ---------------- 调度 ---------------- */
function schedule() {
  if (tick) { clearInterval(tick); tick = null; }
  if (!cfg.enabled) return;
  nextStamp = calcNext();
  scheduleStart = Date.now();   // 本周期起算时刻
  tick = setInterval(async () => {
    updateEntryLabel();          // 每秒刷新侧栏与顶栏 title 的实时倒计时（不改变触发判断）
    if (Date.now() >= nextStamp) {
      // v3.4.0：结束时机=播完当前曲目 → 到点先进等待态，等当前曲目播完再执行
      // v3.7.0：不再要求「到点时刻正在播放」——中途打开播放器开始播也能等到该曲播完；无播放缓冲 15 分钟兜底
      if (cfg.endWhen === 'songEnd') {
        // v3.7.1：once 模式到点后必须停掉这个「每秒到点判断」tick，否则下一秒仍满足到点条件
        //    → 每秒重复 startPending()：① toast 每秒弹一次堆积成 ×n；② pending 被反复重建，
        //    seenPlaying/noPlaySince/started 反复重置 → 无播放缓冲(15min)与 2h 硬兜底永不触发。
        //    daily 交给 schedule() 内部清理并排下一次即可。
        if (cfg.repeat === 'daily') { schedule(); }
        else if (tick) { clearInterval(tick); tick = null; }
        startPending();
      } else {
        const once = cfg.repeat !== 'daily';
        if (once) {
          stopTimer(true);   // v3.6.8: 到点自动关闭不重复 toast，动作结果统一由 fire() 提示
        } else {
          schedule();          // 立即安排下一次
        }
        fire();
      }
    }
  }, 1000);
}

function stopTimer(clearFlag, src) {
  diag('stop:enter', 'src=' + (src || '?'), 'enabled-before=' + cfg.enabled, 'sysShutdownPending=' + sysShutdownPending, 'pending=' + !!pending, 'popupOpen=' + !!(popupEl && popupEl.isConnected));
  cfg.enabled = false;
  // v3.6.8: 仅本会话确实排程过系统关机才联动取消，避免 stop/shutdown 等非关机场景误弹「已取消系统关机」
  if (sysShutdownPending) cancelSystemShutdown(src);
  stopPending();                       // v3.4.0：取消定时的同时结束「等待播完」态
  if (tick) { clearInterval(tick); tick = null; }
  nextStamp = 0;
  scheduleStart = 0;                     // 未启用：环形进度清 0（环隐藏）
  if (clearFlag) persist();
  updateEntryLabel();
  try { syncStButton(); } catch (e) {}   // 弹窗若开着：立即把按钮刷成「启动定时」，不等每秒轮询
}

/* ---------------- 入口：顶部标题栏按钮（主） + 侧栏 li（兜底） ---------------- */
const BTN_SVG =
  '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block">' +
  '<circle id="et-luo-prog" cx="12" cy="12" r="10.4" fill="none" stroke="rgba(0,0,0,0)" stroke-width="3.2" stroke-dasharray="65.35" stroke-dashoffset="0" transform="rotate(-90 12 12)"></circle>' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"></circle>' +
  '<path d="M12 6.5V12l2.1 1.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

function injectTopBtnStyle() {
  if (document.getElementById(ET_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = ET_STYLE_ID;
  s.textContent = [
    '.et-topbtn {',
    ' width: 34px; height: 34px;',
    ' display: inline-flex; align-items: center; justify-content: center;',
    ' border-radius: 50%;',
    ' transition: all 0.2s;',
    ' background: transparent; border: none;',
    ' color: var(--color-text-main); opacity: 0.6;',
    ' cursor: pointer; flex-shrink: 0; flex: none;',
    ' padding: 2px 6px; vertical-align: middle; line-height: 1;',
    '}',
    '.et-topbtn:hover {',
    ' opacity: 1;',
    ' background-color: var(--control-hover-bg);',
    '}',
    '.et-topbtn svg {',
    ' width: 18px; height: 18px;',
    '}',
  ].join('\n');
  document.head.appendChild(s);
}

function ensureTopBtn() {
  if (document.getElementById(BTN_ID)) { updateEntryLabel(); return; }
  injectTopBtnStyle();
  const nav = document.querySelector('.titlebar-nav');
  if (!nav) return;
  const ref = nav.querySelector('.tb-search') || null;
  const b = document.createElement('button');
  b.id = BTN_ID;
  b.className = 'et-topbtn nav-btn';
  b.title = '定时停止';
  b.style.cssText = 'flex: none;';
  b.innerHTML = BTN_SVG;
  topBtnRef = b;
  b.addEventListener('click', (e) => { e.stopPropagation(); togglePopup(); });
  if (ref && ref.parentNode) ref.parentNode.insertBefore(b, ref.nextSibling);
  else nav.appendChild(b);
}

function updateEntryLabel() {
  // 环形倒计时进度：剩余比例 -> stroke-dashoffset；offset=周长 即环走完=到点；近结束(<5% 或 <10s)变红
  const ring = document.getElementById('et-luo-prog');
  try {
    if (cfg.enabled && scheduleStart > 0 && nextStamp > scheduleStart) {
      const remain = Math.max(0, nextStamp - Date.now());
      const total = nextStamp - scheduleStart;
      const ratio = total > 0 ? Math.min(1, remain / total) : 0;
      if (ring) {
        ring.setAttribute('stroke-dashoffset', String(65.35 * (1 - ratio)));
        ring.setAttribute('stroke-width', '3.2');
        ring.setAttribute('stroke', (ratio < 0.05 || remain < 10000) ? '#ff5f4d' : '#ffd166');
      }
    } else {
      // 未启用：进度环完全透明，只留干净的钟面（点击启用后才会出现黄色计时环）
      if (ring) { ring.setAttribute('stroke', 'rgba(0,0,0,0)'); ring.setAttribute('stroke-dashoffset', '0'); }
    }
  } catch (e) {}
  const cnt = cfg.enabled ? fmtCountdown(nextStamp - Date.now()) : '';
  const lb = document.getElementById('et-luo-lb');
  if (lb) {
    if (pending) {
      lb.textContent = '等待歌曲播完…';      // v3.4.0：songEnd 到点后等待态
    } else if (cfg.enabled) {
      lb.textContent = fmtStamp(nextStamp) + ' 启用' + (cnt ? ' · ' + cnt : '');
    } else {
      lb.textContent = '未启用';
    }
  }
  const tb = document.getElementById(BTN_ID);
  if (tb) {
    tb.title = pending
      ? '已到点 · 等待当前歌曲播放完再执行（点击可管理/取消）'
      : cfg.enabled
        ? ('定时进行中 · ' + fmtStamp(nextStamp) + (cnt ? ' · 剩 ' + cnt : '') + '（点击可管理/取消）')
        : '定时停止';
    if (cfg.enabled) {
      tb.style.color = '#ffd166';
    } else {
      tb.style.color = '';
      tb.style.boxShadow = '';
    }
  }
}

function ensureEntry() {
  if (document.getElementById(ENTRY_ID)) { updateEntryLabel(); return; }
  const list = document.querySelector('#panel > .plugin-list') || document.querySelector('#panelPluginList') || document.querySelector('.plugin-list');
  if (!list) return;
  const li = document.createElement('li');
  li.id = ENTRY_ID;
  li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;cursor:pointer;color:#cdd4e1;list-style:none';
  li.innerHTML =
    '<span style="flex:0 0 auto;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;' +
    'border-radius:6px;background:linear-gradient(135deg,#2f6fee,#6a5bff);color:#fff;font-size:11px">⏱</span>' +
    '<span style="flex:1">定时</span>' +
    '<span id="et-luo-lb" style="font-size:11px;color:#7f8799">未启用</span>';
  li.addEventListener('click', () => togglePopup());
  list.appendChild(li);
}

function ensureEntries() { ensureTopBtn(); ensureEntry(); }
function startEntryWatch() {
  if (entryWatch) return;
  ensureEntries();
  entryWatch = setInterval(() => { if (!ctxRef) return; try { ensureEntries(); } catch (e) {} }, 1200);
}
function stopEntryWatch() {
  if (entryWatch) { clearInterval(entryWatch); entryWatch = null; }
}

/* ---------------- 弹窗 ---------------- */
let popupEl = null;
let popupTick = null;   // 弹窗打开期间每秒刷新剩余倒计时（未启用不启动）

/** 弹窗 data-live 文案：时刻 + 剩余倒计时；剩余<=0 只显示时刻 */
function liveText() {
  const remain = nextStamp - Date.now();
  const base = fmtStamp(nextStamp);
  return remain > 0 ? (base + ' 剩' + fmtCountdown(remain)) : base;
}
function stRunning() { return !!cfg.enabled || sysShutdownPending; }
function syncStButton() {
  try {
    if (!popupEl || !popupEl.isConnected) return;
    const btn = popupEl.querySelector('[data-st]');
    if (!btn) return;
    const on = stRunning();
    btn.textContent = on ? '■ 停止定时' : '启动定时';
    btn.style.background = on ? 'linear-gradient(90deg,#e05a4b,#d44038)' : '';
    const liveEl = popupEl.querySelector('[data-live]');
    if (liveEl) liveEl.textContent = pending ? '等待播完…' : liveText();
  } catch (e) {}
}
function updateLive() {
  syncStButton();
}
function startPopupTick() {
  stopPopupTick();
  if (!stRunning()) return;
  updateLive();
  popupTick = setInterval(updateLive, 1000);
}
function stopPopupTick() {
  if (popupTick) { clearInterval(popupTick); popupTick = null; }
}
const POPUP_CSS = `
.et-root *{box-sizing:border-box}
.et-root button,.et-root input,.et-root select{font-family:inherit;line-height:1.35}
.et-root button{cursor:pointer}
.et-row2{display:flex;align-items:center;gap:6px;margin:2px 0}
.et-lb2{flex:none;width:40px;font-size:10px;color:#9aa3b5;text-align:right}
.et-ct2{flex:1;min-width:0}
.et-sel2,.et-inp2{width:100%;box-sizing:border-box;background:#141821;border:1px solid #333a4d;color:#e8ecf5;border-radius:5px;padding:2px 5px;font-size:10px;outline:none}
.et-sel2:focus,.et-inp2:focus{border-color:#4f7cff}
.et-seg2{display:flex;background:#141821;border:1px solid #333a4d;border-radius:6px;overflow:hidden}
.et-seg2 button{flex:1;background:transparent;border:0;color:#9aa3b5;font-size:10px;padding:2px 0;cursor:pointer}
.et-seg2 button.on{background:#2a3557;color:#fff}
.et-cd2{display:flex;gap:3px;align-items:center}
.et-chip2{flex:none;padding:1px 5px;border-radius:5px;background:#141821;border:1px solid #333a4d;color:#aab3c6;font-size:9px;cursor:pointer}
.et-chip2:hover{border-color:#4f7cff;color:#fff}
.et-warn2{display:none;font-size:9px;color:#e8b35a;margin:2px 0 0;line-height:1.4}
.et-warn2.on{display:block}
.et-ft2{display:flex;gap:6px;margin:4px 0 0}
.et-ft2 button{flex:1;border:0;border-radius:6px;padding:3.5px 0;font-size:10.5px;cursor:pointer}
.et-cxl2{background:#2a3040;color:#aab3c6}
.et-st2{background:linear-gradient(90deg,#4f7cff,#6a5bff);color:#fff;font-weight:700}
.et-note2{font-size:8.5px;color:#7f8799;text-align:center;padding-top:2px;margin-top:1px;border-top:1px solid rgba(255,255,255,.05)}
.et-note2 b{color:#4f7cff}
`;

// 定位顶部标题栏的时间/时钟元素（用户偏好：弹窗锚定时间图标右下方区域）。
// 三级启发式：HH:MM 文本 → time/clock/date 相关 class → svg 时钟图标；找不到返回 null 走按钮兜底。
function findClockEl() {
  try {
    const nav = document.querySelector('.titlebar-nav') || document.querySelector('.titlebar');
    if (!nav) return null;
    // 1) 文本匹配 HH:MM（排除带 '/' 的播放进度，如 02:34/04:12）
    const txtEls = nav.querySelectorAll('span,div,time,em');
    for (const el of txtEls) {
      const t = (el.textContent || '').trim();
      if (el.children.length === 0 && /^(0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/.test(t)) return el;
    }
    // 2) time/clock/date 相关 class 或 <time>
    const cand = nav.querySelectorAll('time,[class*="time"],[class*="clock"],[class*="date"]');
    for (const el of cand) {
      try { if (el.getBoundingClientRect().width > 1) return el; } catch (e) {}
    }
    // 3) svg 内嵌时钟图标
    const icons = nav.querySelectorAll('svg');
    for (const sv of icons) {
      const p = sv.querySelector('path');
      const d = (p && p.getAttribute('d')) || '';
      if (/M12 7v5l3 2|M12 2a10 10 0/.test(d)) { try { if (sv.getBoundingClientRect().width > 0) return sv.closest('button') || sv; } catch (e) {} }
    }
  } catch (e) {}
  return null;
}

// 弹窗：v2.5 优先锚定顶栏「定时设置/定时停止」图标（插件按钮）——弹窗右缘与图标
// 右缘贴齐、竖直方向紧贴图标正下方展开，实现与图标竖排对齐；插件按钮不在场时
// 回退锚定到顶部时钟元素右下方。
// v2.6（Luo 定制版）：修复「点击弹窗外空白无法取消/关闭」——打开弹窗时注册全局
//   mousedown（capture）+ ESC 监听：点击目标不在弹窗内、也不在入口图标上即关闭弹窗；
//   关闭弹窗时移除监听，避免残留。此前仅绑定弹窗内 ×/取消 按钮，点空白不响应。
let _outH = null;
let _escH = null;
function addOutsideClose() {
  if (!popupEl || !popupEl.isConnected) return;
  if (!_outH) {
    _outH = (e) => {
      if (!popupEl || !popupEl.isConnected) return;
      const t = e.target;
      if (popupEl.contains(t)) return;                                  // 弹窗内部点击：不关
      if (topBtnRef && (t === topBtnRef || topBtnRef.contains(t))) return; // 顶部入口图标：交给 click 开关
      const en = document.getElementById(ENTRY_ID);
      if (en && (t === en || en.contains(t))) return;                   // 侧栏入口：交给 click 开关
      closePopup();
    };
    document.addEventListener('mousedown', _outH, true);
  }
  if (!_escH) {
    _escH = (e) => { if (e.key === 'Escape') closePopup(); };           // v2.6：ESC 也能关闭
    document.addEventListener('keydown', _escH, true);
  }
}
function removeOutsideClose() {
  if (_outH) { document.removeEventListener('mousedown', _outH, true); _outH = null; }
  if (_escH) { document.removeEventListener('keydown', _escH, true); _escH = null; }
}
function togglePopup() {
  if (popupEl && popupEl.isConnected) { closePopup(); return; }
  popupEl = document.createElement('div');
  popupEl.className = 'et-root';
  const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
  const anchor = (topBtnRef && topBtnRef.isConnected) ? topBtnRef : (findClockEl() || null);
  let topY = 12;
  let rightPx = 16;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      // 右缘对齐锚点右缘（时钟在顶栏右侧时：整体比贴窗缘更靠左），垂直贴锚点下方
      rightPx = Math.max(4, vw - r.right);
      topY = Math.max(6, r.bottom + 8);
    }
  }
  Object.assign(popupEl.style, {
    position: 'fixed', zIndex: '2147483646', top: topY + 'px', right: rightPx + 'px', width: '238px',
    background: 'linear-gradient(180deg,#232837,#1b1f2b)', border: '1px solid #383f52', borderRadius: '10px',
    boxShadow: '0 10px 32px rgba(0,0,0,.55)', fontFamily: "-apple-system,'Segoe UI','Microsoft YaHei',sans-serif",
    color: '#e8ecf5', overflow: 'hidden', isolation: 'isolate', willChange: 'transform,opacity',
  });
  document.body.appendChild(popupEl);
  // v2.4：缩放动画对齐锚点（时钟图标）——transform-origin 精确指向锚点位置，
  // 弹窗从时钟图标处「放大长出」（scale .72→1 + 弹性缓动），而非自身中心缩放
  try {
    let ox = '72% 4%';
    if (anchor) {
      const pr = popupEl.getBoundingClientRect();
      if (pr.width > 0 && pr.height > 0) {
        const ar = anchor.getBoundingClientRect();
        const px = ((ar.left + ar.width / 2) - pr.left) / pr.width * 100;
        const py = (ar.top - pr.top) / pr.height * 100;
        ox = Math.max(0, Math.min(100, px)).toFixed(1) + '% ' + Math.max(0, Math.min(120, py)).toFixed(1) + '%';
      }
    }
    popupEl.style.transformOrigin = ox;
  } catch (e) {}
  Object.assign(popupEl.style, { opacity: '0', transform: 'scale(.72)' });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        Object.assign(popupEl.style, {
          opacity: '1', transform: 'scale(1)',
          transition: 'opacity .14s ease-out, transform .2s cubic-bezier(.2,.9,.3,1.18)',
        });
      } catch (e) {}
    });
  });
  renderPopup();
  addOutsideClose();   // v2.6：打开后挂载「点空白/ESC 关闭」
}

function closePopup() {
  stopPopupTick();       // 关闭弹窗：停止读秒刷新
  removeOutsideClose();  // v2.6：关闭时卸载监听
  if (!popupEl || !popupEl.isConnected) return;
  const el = popupEl;
  try {
    Object.assign(el.style, {
      opacity: '0', transform: 'scale(.72)',
      transition: 'opacity .12s ease-in, transform .12s ease-in',
    });
    setTimeout(() => { if (popupEl === el) { try { el.remove(); } catch (e) {} popupEl = null; } }, 120);
  } catch (e) {
    try { el.remove(); } catch (e2) {}
    if (popupEl === el) popupEl = null;
  }
}

function actWarn() {
  if (cfg.endWhen === 'songEnd') return '⏳ 到点后先等当前歌曲播完，再执行' + (cfg.action === 'shutdown' ? '关机' : '');
  return cfg.action === 'shutdown'
    ? '⚠ 到点将触发系统关机（60 秒倒计时可取消）'
    : (cfg.action === 'quit' ? '⚠ 到点将直接关闭 EchoMusic' : '');
}

function renderPopup() {
  const running = stRunning();
  popupEl.innerHTML =
    '<style>' + POPUP_CSS + '</style>' +
    '<div style="display:flex;align-items:center;gap:6px;padding:4px 10px 3px;border-bottom:1px solid rgba(255,255,255,.06);background:rgba(255,255,255,.03)">' +
    '<span style="flex:1;font-size:12px;font-weight:700;display:flex;align-items:center;gap:5px">⏱ ' + (running ? '定时进行中' : '定时设置') + '</span>' +
    (running ? '<span data-live style="font-size:9px;font-weight:600;color:#ffd166;border:1px solid rgba(255,209,102,.4);border-radius:4px;padding:0 4px">' + (pending ? '等待播完…' : liveText()) + '</span>' : '') +
    '<span data-x style="cursor:pointer;width:18px;height:18px;border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:12px;color:#9aa3b5">×</span></div>' +
    '<div style="padding:4px 10px 5px">' +
    '<div class="et-row2"><span class="et-lb2">执行动作</span><span class="et-ct2"><select class="et-sel2" data-act>' +
    '<option value="stop">停止播放</option>' +
    '<option value="quit">关闭 EchoMusic</option>' +
    '<option value="shutdown">定时关机</option></select></span></div>' +
    '<div class="et-row2"><span class="et-lb2">结束时机</span><span class="et-ct2"><span class="et-seg2" data-endseg>' +
    '<button data-e="now">立即执行</button><button data-e="songEnd">播完再执行</button></span></span></div>' +
    '<div class="et-row2"><span class="et-lb2">触发方式</span><span class="et-ct2"><span class="et-seg2" data-seg>' +
    '<button data-g="hhmm">指定时间</button><button data-g="cd">倒计时</button></span></span></div>' +
    '<div class="et-row2" data-panel="hhmm"><span class="et-lb2">时间</span><span class="et-ct2"><input class="et-inp2" type="time" data-time value="' + cfg.hhmm + '"></span></div>' +
    '<div class="et-row2" data-panel="cd" style="display:none"><span class="et-lb2">倒计时</span><span class="et-ct2"><span class="et-cd2">' +
    '<input class="et-inp2" type="number" data-cdmin min="1" value="' + cfg.cdMin + '" style="width:48px"> 分钟' +
    '<span class="et-chip2" data-chip="15">15</span><span class="et-chip2" data-chip="30">30</span><span class="et-chip2" data-chip="60">60</span>' +
    '</span></span></div>' +
    '<div class="et-row2"><span class="et-lb2">重复</span><span class="et-ct2"><select class="et-sel2" data-rpt>' +
    '<option value="once">仅一次</option><option value="daily">每天</option></select></span></div>' +
    '<div class="et-warn2" data-warn>' + actWarn() + '</div>' +
    '<div class="et-ft2">' +
    (running ? '<button class="et-cxl2" data-cxl>关闭弹窗</button><button class="et-st2" data-st style="background:linear-gradient(90deg,#e05a4b,#d44038)">■ 停止定时</button>'
             : '<button class="et-cxl2" data-cxl>取消</button><button class="et-st2" data-st>启动定时</button>') +
    '</div>' +
    '<div class="et-note2">' + (running ? (pending ? '正在等待当前歌曲播完，之后继续执行' : '到点执行后自动关闭。点「停止定时」可取消') : '到点自动执行，之后定时自动关闭') + '</div>' +
    '</div>';

  const act = popupEl.querySelector('[data-act]');
  const endSeg = popupEl.querySelector('[data-endseg]');
  const seg = popupEl.querySelector('[data-seg]');
  const rpt = popupEl.querySelector('[data-rpt]');
  const timeInp = popupEl.querySelector('[data-time]');
  const cdInp = popupEl.querySelector('[data-cdmin]');
  const warn = popupEl.querySelector('[data-warn]');

  act.value = cfg.action;
  rpt.value = cfg.repeat;
  endSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.e === cfg.endWhen));
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.g === cfg.gate));
  refreshGate();

  popupEl.querySelector('[data-x]').onclick = () => closePopup();
  popupEl.querySelector('[data-cxl]').onclick = () => {
    if (running) { stopTimer(true, 'popup-cxl'); updateEntryLabel(); toast('已取消定时', 'info'); }
    closePopup();
  };
  act.onchange = () => { cfg.action = act.value; refreshGate(); };
  rpt.onchange = () => { cfg.repeat = rpt.value; };
  timeInp.onchange = () => { cfg.hhmm = timeInp.value || '23:59'; };
  cdInp.onchange = () => { cfg.cdMin = Math.max(1, Number(cdInp.value) || 15); };
  popupEl.querySelectorAll('[data-chip]').forEach((c) => {
    c.onclick = () => { cfg.cdMin = Number(c.dataset.chip); cdInp.value = cfg.cdMin; };
  });
  popupEl.querySelector('[data-st]').onclick = () => {
    if (stRunning()) {
      // 已在运行 / 系统关机缓冲期：主按钮此时即「停止定时」且联动取消系统关机
      stopTimer(true, 'popup-st');
      updateEntryLabel();
      closePopup();
      toast('已取消定时', 'info');
      return;
    }
    cfg.enabled = true;
    schedule();
    persist();
    updateEntryLabel();
    closePopup();
    diag('start:clicked', 'act=' + cfg.action, 'gate=' + cfg.gate, 'cdMin=' + cfg.cdMin, 'hhmm=' + cfg.hhmm, 'nextStamp=' + nextStamp);
    if (cfg.action === 'shutdown') { ensureShutdownConsent(); preAuthCancel(); }
    toast('已设置' + (cfg.action === 'shutdown' ? '定时关机' : cfg.action === 'quit' ? '定时关闭软件' : '定时停止播放') + (cfg.endWhen === 'songEnd' ? '（播完再执行）' : '') + ' · ' + fmtStamp(nextStamp), 'success');
  };

  function refreshGate() {
    popupEl.querySelectorAll('[data-panel]').forEach((p) => { p.style.display = (p.dataset.panel === cfg.gate) ? 'flex' : 'none'; });
    warn.textContent = actWarn();
    warn.classList.toggle('on', !!actWarn());
  }
  seg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { cfg.gate = b.dataset.g; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); refreshGate(); };
  });
  endSeg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { cfg.endWhen = b.dataset.e; endSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); refreshGate(); };
  });
  startPopupTick();   // 弹窗打开：每秒刷新 data-live 剩余倒计时
}
/* ---------------- 生命周期（官方 API） ---------------- */
export async function activate(ctx) {
  ctxRef = ctx;
  await loadCfg();
  diag('activate', 'code-ver=3.7.1', 'manifest=3.7.1', 'enabled=' + cfg.enabled, 'sysShutdownPending=' + sysShutdownPending, 'pending=' + !!pending);
  startEntryWatch();
  if (cfg.enabled) schedule();
  toast('ECHO Timer v3.7.1 已就绪' + (cfg.enabled ? ' · ' + fmtStamp(nextStamp) + ' 待执行' : ''), 'info');
  ctx.dispose(teardown);
}

// v3.3.0：清理逻辑统一收口 teardown，activate 的 dispose 回调与 deactivate 共用一份
function teardown() {
  stopPending();                           // v3.4.0：插件卸载时结束「等待播完」态
  if (tick) { clearInterval(tick); tick = null; }
  stopPopupTick();                         // v3.7.1：卸载时停掉弹窗读秒 interval，避免泄漏
  stopEntryWatch();
  try { const el = document.getElementById(BTN_ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
  try { const el = document.getElementById(ENTRY_ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
  try { const st = document.getElementById(ET_STYLE_ID); if (st) st.remove(); } catch (e) {}
  if (popupEl) { try { popupEl.remove(); } catch (e) {} popupEl = null; }
  ctxRef = null;
}

export function deactivate() {
  teardown();
}
