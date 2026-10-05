/**
 * echomusic-payskip —— 遇费跳过
 * 作者: Luo
 * 版本: 1.2.3
 *
 * v1.2.3（Luo 优化）：缩短判卡停滞阈值 STALL_MS 由 10s 降至 5s，改善冷启动直接停在付费曲时
 *   的跳过体感（此前 10s 判定延迟内界面停在付费曲被视为「不自动跳」）。判定逻辑不变。
 *
 * 功能：
 *   播放到「无法播放」的付费/受限曲目时，宿主解析音频源失败会触发播放失败事件并暂停，
 *   此时歌曲卡在原地不动。本插件捕获播放失败事件后做防御性确认（延迟 + 仍在失败暂停态 +
 *   未真正出过声），确认无误后调用播放器 next 动作跳过该曲，继续正常播放。
 *
 * v1.2.0（Luo 定制版）：新增「轮询兜底」第二通道——宿主对部分卡死的付费/受限
 *   曲目（如《交换余生》）根本不推送任何播放失败事件，仅靠事件驱动够不着；现周期性
 *   轮询 player store 状态机（每 2s），仅对「切歌后从未真正播起过」且停滞满 10s 的
 *   曲目判定卡死，复用 handleError 入口触发跳过（同冷却/连续上限/notify 全复用）。
 *
 * v1.2.1（Luo 修复）：收紧轮询兜底判定——轮询判卡唯一的资格来源是「真实收到过播放失败
 *   事件」（playback-failed / track-not-playable / audio-url-unavailable / onError）并据此把曲目
 *   记入可疑集；轮询只对可疑集内的曲目做停滞判定，普通「未被播放」的正常歌曲（如进入界面时
 *   当前曲未自动播放）永不判卡，消除「正常未播放被误跳」问题。曲目恢复播放/判卡触发即从可疑
 *   集移除，杜绝反复判卡。注：宿主完全不发失败事件的卡死曲（如《交换余生》）本轮不再自动跳，
 *   属收紧后的预期取舍。
 *
 * v1.2.2（落地方案C）：CDP 探针实测确认——宿主对静默卡死付费曲（如《黑夜问白天》105271132）
 *   既不推失败事件，player store 又呈现「audioUrl 空」特征（currentTrackSnapshot.audioUrl="",
 *   currentAudioUrl="", currentAudioCandidateUrls=[]）；而正常可播曲（如《风吹麦浪》）audioUrl 有效。
 *   故轮询判卡资格从「仅失败事件入可疑集」扩展为「失败事件 OR audioUrl 空特征」，仅对 audioUrl 空
 *   且从未真正播起且停滞满 STALL_MS 的曲目判卡：静默卡死曲可自动跳、正常未播曲永不误跳。
 *   由开关 audioUrlStall 控制（默认开），关闭即回到 v1.2.1 语义。
 *
 * 触发链路（v1.1.0 基于宿主 app.asar 逆向修正）：
 *   - 付费曲失败宿主实际不走 ctx.events.onError，而是 player store 内部事件总线 emit
 *     `playback-failed` / `track-not-playable` / `audio-url-unavailable` 事件；
 *     ctx.events.on(e,t) 通过 createPluginContext 的 z() 订阅同一 onPlayerEvent 总线，可收到。
 *   - ctx.pinia._s.get('player') —— pinia player store，下一首动作实际命名为 next。
 *   - playerStore 状态字段：isPlaying / currentTime / currentTrackId 可直接读
 *
 * 防误跳/防死循环设计：
 *   - confirmMs：收到失败事件后延迟再复查，确认仍处于「未播放」态才跳（用户在失败后手动点播放
 *     会变成播放中，自动放弃跳过）
 *   - successSeconds：失败前已播超过该秒数即视为「已有正常播放」，不跳（避免误伤可播歌曲）
 *   - sameTrackCooldown：同一曲目跳过后的冷却，防止刚跳过又被宿主重试同一首反复连跳
 *   - maxConsecutive：连续失败跳过上限，超过即停止本轮自动跳过并提示，防整张表全不可播时死循环
 *
 * 安全约束：全链路 try/catch 包裹，任何异常只落到日志不冒泡，避免拖垮渲染进程（render-process-gone）。
 */

// ----------------------------- 默认配置 -----------------------------
const DEFAULTS = {
  enabled: true,          // 总开关
  confirmMs: 1200,        // 失败事件后延迟复查毫秒数（等宿主可能的内置重试完成）
  successSeconds: 6,      // 已播放超过该秒数视为正常播放，不跳过
  sameTrackCooldown: 15000, // 同一曲目跳过冷却毫秒
  maxConsecutive: 3,      // 连续不可播最大跳过次数（0=不限制）
  consecResetMs: 60000,   // 连续计数重置窗口毫秒（窗口内无新跳过则归零）
  notify: true,           // 跳过时 toast 提示
  audioUrlStall: true,    // v1.2.2: audioUrl 空特征判卡（静默卡死付费曲兜底；false=回到 v1.2.1 语义）
};
const STORAGE_KEY = 'payskip:cfg';
const DEBUG_KEY = 'payskip:debuglog';   // 诊断日志落盘键（保留最近 100 条 {t,msg}）
const DEBUG_MAX = 100;
const FAIL_EVENTS = ['playback-failed', 'track-not-playable', 'audio-url-unavailable'];

// ----------------------------- 全局状态 -----------------------------
let ctxRef = null;
let state = { ...DEFAULTS };

// 跳过防抖/防重入
let lastErrorAt = 0;        // 最近一次失败事件时间
let handling = false;       // 确认流程进行中（防并发重入）
let lastSkipTrack = '';     // 最近跳过的曲目 id
let lastSkipAt = 0;         // 最近跳过时间
let consecutive = 0;        // 连续跳过计数（跨曲目累加，防整表全不可播死循环）
let lastConsecAt = 0;       // 最近一次连续跳过时间（超时窗口则重置）
let lastGoodAt = 0;         // 最近一次确认「正常播放」的时间（出现正常播放即重置计数）
const trackStates = new Map(); // 轮询兜底：trackId -> { lastTime, lastUpdAt, everPlayed, stallSince }
const suspiciousTracks = new Map(); // 已确认存在播放失败的曲目：trackId -> 最近失败时间（仅对有失败事件的曲目允许轮询判卡，防误跳正常未播放的歌）
const SUSPECT_TTL = 5 * 60 * 1000;  // 可疑条目有效期：超时自动清理，防 Map 膨胀
let pollTimer = null;          // 轮询兜底定时器

/** sleep */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 诊断日志落盘：写 ctx.storage payskip:debuglog（保留最近 100 条 {t,msg}），全 try/catch 防拖垮渲染进程 */
function dbgLog(msg) {
  try {
    const st = ctxRef?.storage;
    if (!st || !st.get || !st.set) return;
    const gp = st.get(DEBUG_KEY);
    if (gp && typeof gp.then === 'function') {
      gp.then((arr) => {
        try {
          const list = (Array.isArray(arr) ? arr : []).slice(-(DEBUG_MAX - 1));
          list.push({ t: Date.now(), msg: String(msg) });
          const sp = st.set(DEBUG_KEY, list);
          if (sp && typeof sp.catch === 'function') sp.catch(() => {});
        } catch {}
      }).catch(() => {});
    }
  } catch {}
}
/** 日志（devtools console + 同步落盘 payskip:debuglog） */
function log(...a) {
  let txt = '';
  try {
    txt = a.map((v) => {
      if (typeof v === 'string') return v;
      try { return JSON.stringify(v); } catch { return String(v); }
    }).join(' ');
  } catch {}
  try { console?.log?.('[payskip]', ...a); } catch {}
  dbgLog(txt);
}

/** toast */
function toastOk(msg) { try { ctxRef?.toast?.success?.(msg); } catch {} }
function toastWarn(msg) { try { ctxRef?.toast?.info?.(msg); } catch {} }

/** 获取 pinia player store（多兜底） */
function player() {
  if (!ctxRef) return null;
  try { return ctxRef.pinia?._s?.get('player') ?? null; } catch { return null; }
}

/** 读播放器状态字段（兼容 $state / _state 路径） */
function stOf(p) { return p ? (p?.$state ?? p?._state ?? p) : null; }
function isPlayingOf(p) {
  const s = stOf(p);
  if (!s) return false;
  let ip = s?.isPlaying ?? s?.isPlay;
  // 兼容 enginePlayback 嵌套
  if (ip === undefined || ip === null) ip = s?.enginePlayback?.status === 'playing';
  return !!ip;
}
function timeOf(p) {
  const s = stOf(p);
  return +(s?.currentTime ?? s?.currentTimeMs ?? 0) / (s?.currentTimeMs !== undefined ? 1000 : 1) || 0;
}
function trackIdOf(p) {
  const s = stOf(p);
  if (!s) return '';
  return String(
    s?.currentTrackId ?? s?.currentTrack?.id ?? s?.currentTrack?.hash ??
    s?.curTrackId ?? s?.curTrack?.id ?? s?.playback?.currentTrackId ??
    s?.trackId ?? s?.song?.id ?? ''
  );
}

/** v1.2.2 方案C：判定当前曲是否「audioUrl 空」——静默卡死受限曲的 store 特征 */
function isAudioUrlEmptyOf(p) {
  try {
    const s = stOf(p);
    if (!s) return false;
    const snap = s?.currentTrackSnapshot ?? {};
    const uMain = String(s?.currentAudioUrl ?? '');
    const uSnap = String(snap?.audioUrl ?? snap?.url ?? '');
    const cands = s?.currentAudioCandidateUrls;
    const noCand = !Array.isArray(cands) || cands.length === 0;
    return uMain.trim() === '' && uSnap.trim() === '' && noCand;
  } catch { return false; }
}

/** 调用播放器「下一首」动作（宿主 store 实际动作为 next） */
function nextTrack() {
  const p = player();
  if (!p) return false;
  const names = ['next', 'nexttrack', 'nextTrack'];
  let fn = null;
  let usedName = '';
  for (const n of names) {
    if (typeof p[n] === 'function') { fn = p[n]; usedName = n; break; }
  }
  if (!fn) { log('[NEXT] 播放器无可用 next 动作', names.join('/')); return false; }
  try {
    const r = fn();
    log('[NEXT]', usedName || 'next', '调用成功', r && typeof r.then === 'function' ? '(异步)' : '(同步)');
    if (r && typeof r.then === 'function') r.catch((e) => log('[NEXT] next 动作异常', e));
  }
  catch (e) { log('[NEXT] next 调用失败', e); return false; }
  return true;
}

/** 处理一次播放失败：确认是「不可播已暂停」后跳过 */
async function handleError() {
  if (!state.enabled) { log('[SKIP] 插件未启用，忽略'); return; }
  if (handling) { log('[SKIP] 确认流程进行中（防重入），忽略'); return; }
  const now = Date.now();
  if (now - lastErrorAt < 500) { log('[SKIP] 去抖窗口内，忽略重复失败事件'); return; }
  lastErrorAt = now;

  const p = player();
  if (!p) { log('[SKIP] player store 不存在'); return; }
  const tid = trackIdOf(p);
  if (!tid) { log('[SKIP] 读不到当前曲目 id'); return; }

  // 同曲冷却：跳过刚发生，宿主若重试同一首则不连跳
  if (tid === lastSkipTrack && now - lastSkipAt < state.sameTrackCooldown) {
    log('[SKIP] 同曲冷却中，不跳过', tid);
    return;
  }

  // 已经正常播过一段 → 误伤保护
  if (timeOf(p) >= state.successSeconds) { log('[SKIP] 已播时长保护，不跳过', timeOf(p)); return; }

  handling = true;
  try {
    await sleep(state.confirmMs);
    const p2 = player();
    if (!p2) { log('[SKIP] 复查时 player store 不存在'); return; }
    // 复查期间曲目已被切换（用户手动/宿主自动跳走）→ 不再处理
    if (trackIdOf(p2) !== tid) { log('[SKIP] 复查期间曲目已切换', tid, '->', trackIdOf(p2)); return; }
    // 复查时已是播放中（用户在失败后点了播放）→ 放弃跳过，并视为「恢复正常播放」
    if (isPlayingOf(p2)) {
      // 短暂复查窗口内已见播放中：确认失败后手动播放 / 宿主自动恢复 → 重置连续计数
      if (Date.now() - lastGoodAt > 3000) { lastGoodAt = Date.now(); consecutive = 0; }
      log('[SKIP] 复查为播放中，放弃跳过并视为恢复正常');
      return;
    }
    // 已播出一段 → 放弃
    if (timeOf(p2) >= state.successSeconds) {
      if (Date.now() - lastGoodAt > 3000) { lastGoodAt = Date.now(); consecutive = 0; }
      log('[SKIP] 复查已播出保护，放弃跳过', timeOf(p2));
      return;
    }

    // 连续跳过计数（跨曲目累加，不随换曲清零；仅成功播放或超时窗口后重置）
    const win = state.consecResetMs || 60000; // 连续窗口：窗口内无新跳过则视为已结束
    if (Date.now() - lastConsecAt > win) consecutive = 0;
    if (state.maxConsecutive > 0 && consecutive >= state.maxConsecutive) {
      if (state.notify) toastWarn('连续多首无法播放，已暂停自动跳过，请检查音源/网络');
      log('[SKIP] 达连续跳过上限，停止本轮', consecutive);
      consecutive = 0;
      lastConsecAt = 0;
      return;
    }

    const ok = nextTrack();
    if (ok) {
      consecutive++;
      lastSkipTrack = tid;
      lastSkipAt = Date.now();
      lastConsecAt = Date.now();
      if (state.notify) toastOk('无法播放，已自动跳过当前歌曲');
      log('[NEXT] next 调用成功，已发起跳过', tid, '连续', consecutive);
    }
  } catch (e) {
    log('确认流程异常', e);
  } finally {
    handling = false;
  }
}

/* ----------------------------- 轮询兜底（第二通道） ----------------------------- */
// 宿主对部分卡死的付费/受限曲目（如《交换余生》）不推送任何失败事件，本通道周期性
// 轮询 player store 状态机：仅对「切歌后从未真正播起过」且停滞满 STALL_MS 的曲目判定
// 卡死，触发时复用 handleError 同一入口（去抖/同曲冷却/连续上限/notify 全复用）。
const POLL_MS = 2000;      // 轮询周期
const STALL_MS = 5000;     // 无进展累计阈值：isPlaying=false 且从未播过，停滞满 5s 判卡死（v1.2.3 由 10s 缩短）

function pollCheck() {
  if (!state.enabled) return;                 // 轮询只在启用时运行
  const p = player();
  if (!p) return;
  const tid = trackIdOf(p);
  if (!tid) return;
  const now = Date.now();
  const ct = timeOf(p);
  const playing = isPlayingOf(p);

  // 收紧判定：仅对「已确认播放失败（收到过失败事件）」的曲目允许轮询判卡。
  // 普通未被播放的正常歌曲（如进入界面时当前曲未自动播放）不在此列，永不误跳。
  const emptySrc = state.audioUrlStall && isAudioUrlEmptyOf(p);   // v1.2.2 方案C：audioUrl 空也可判
  if (!suspiciousTracks.has(tid) && !emptySrc) {
    trackStates.delete(tid);
    return;
  }
  // 清理过期可疑条目，防 Map 膨胀
  if (suspiciousTracks.size) {
    for (const [k, t] of suspiciousTracks) {
      if (now - t > SUSPECT_TTL) suspiciousTracks.delete(k);
    }
  }

  let st = trackStates.get(tid);
  if (!st) {
    // 新曲目：currentTime>0.5 或正在播放视为「已播起过」；其余按从未播起处理
    st = { lastTime: ct, lastUpdAt: now, everPlayed: ct > 0.5 || playing, stallSince: 0 };
    trackStates.set(tid, st);
    if (emptySrc) { const _s = stOf(p); log('[POLL] audioUrl 空特征入监控', tid, 'cands=', Array.isArray(_s?.currentAudioCandidateUrls) ? _s.currentAudioCandidateUrls.length : 0); }
    if (trackStates.size > 100) trackStates.clear();   // 防膨胀：旧曲目条目自然清空
  }

  const dt = ct - st.lastTime;
  if (dt > 0.5) {
    // 播放确实在推进 -> 正常播放过；该曲永不判卡，复位停滞标记，并从可疑集移除
    st.everPlayed = true;
    st.stallSince = 0;
    st.lastTime = ct;
    st.lastUpdAt = now;
    suspiciousTracks.delete(tid);
    log('[POLL] 播放有进展', tid, 'ct=', ct.toFixed(1), 's');
    return;
  }
  if (playing) {
    // 正在播放但 currentTime 未增长：疑似缓冲/加载中，仅更新时间戳，不判卡
    st.lastUpdAt = now;
    log('[POLL] 播放中缓冲', tid, 'ct=', ct.toFixed(1), 's');
    return;
  }

  // 未在播放：仅对「从未真正播起过」的曲目判卡（手动暂停 / 已播过 => 永不判卡）
  if (st.everPlayed || ct > 0) { st.lastUpdAt = now; return; }
  if (!st.stallSince) st.stallSince = now;
  const stall = now - st.stallSince;
  if (stall < STALL_MS) {
    log('[POLL] 卡死候选（未达阈值）', tid, '停滞', (stall / 1000).toFixed(1), 's /', STALL_MS / 1000, 's');
    return;
  }
  // 停滞满阈值：判定卡死，触发共用跳过入口；stallSince 清零防同曲重复判定（交给 handleError 内去抖/冷却兜底），并从可疑集移除避免反复判卡
  st.stallSince = 0;
  suspiciousTracks.delete(tid);
  log('[POLL] 判定曲目卡死，触发跳过', tid, '停滞', (stall / 1000).toFixed(1), 's', emptySrc ? '(audioUrl空)' : '(失败事件)');
  handleError().catch(() => {});
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollCheck, POLL_MS);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  trackStates.clear();
  suspiciousTracks.clear();
}

/** 保存设置到宿主 storage */
async function saveCfg() {
  try { await ctxRef?.storage?.set?.(STORAGE_KEY, { ...state }); } catch {}
}

/* --------------------------- 设置面板（component 新格式） --------------------------- */
function createSettingsComponent(ctx) {
  const { h } = ctx.vue;
  const defineAsyncComponent = ctx.vue.defineAsyncComponent;
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);

  const row = (label, hint, control) =>
    h('div', { class: 'payskip-row' }, [
      h('div', { class: 'payskip-row-head' }, [
        h('span', { class: 'payskip-row-title' }, label),
        hint ? h('span', { class: 'payskip-row-hint' }, hint) : null,
      ]),
      h('div', { class: 'payskip-row-control' }, [control]),
    ]);

  // 数字输入行
  const numberField = (label, key, hint, step = 1) => {
    const onChange = (e) => {
      let v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state[key] = v;
      saveCfg();
    };
    return row(
      label,
      hint,
      h('input', {
        type: 'number',
        step,
        min: 0,
        value: String(state[key] ?? 0),
        onInput: onChange,
        onChange: onChange,
        style: 'width:120px;padding:4px 8px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;font-size:13px;'
      })
    );
  };

  // 开关行
  const toggleRow = (label, key, hint) =>
    row(
      label,
      hint,
      h(Switch, {
        modelValue: Boolean(state[key]),
        'onUpdate:modelValue': (v) => { state[key] = Boolean(v); saveCfg(); },
      })
    );

  return ctx.vue.defineComponent({
    name: 'PayskipSettings',
    setup() {
      return () =>
        h('div', { class: 'payskip-settings' }, [
          toggleRow('启用遇费跳过', 'enabled', '关闭后保留设置，但不再自动跳过。'),
          numberField('确认延迟（毫秒）', 'confirmMs', '收到失败事件后延迟复查，等宿主内置重试完成', 100),
          numberField('已播秒数保护', 'successSeconds', '失败前已播超过该秒数视为正常播放，不跳过', 1),
          numberField('同曲冷却（毫秒）', 'sameTrackCooldown', '同一曲目跳过后的防连跳冷却', 500),
          numberField('连续跳过上限（0=不限）', 'maxConsecutive', '整表全不可播时防止死循环', 1),
          numberField('连续计数重置（毫秒）', 'consecResetMs', '窗口内无新跳过则计数归零', 1000),
          toggleRow('跳过时提示', 'notify', '跳过时显示 toast 提示。'),
        ]);
    },
  });
}

/* ----------------------------- 生命周期 ----------------------------- */
export async function activate(ctx) {
  ctxRef = ctx;

  // 加载已有配置
  try {
    const u = await ctx.storage?.get?.(STORAGE_KEY);
    if (u && typeof u === 'object') state = { ...DEFAULTS, ...u };
  } catch {}

  // 设置面板（新版 component 格式，宿主要求必须提供 component）
  try {
    ctx.ui?.settings?.define?.({
      title: '遇费跳过',
      description: '不可播的付费/受限曲目自动跳过。',
      component: createSettingsComponent(ctx),
    });
  } catch (e) { log('设置面板注册失败', e); }

  // 监听播放失败事件（付费曲失败实际走 playback-failed / track-not-playable / audio-url-unavailable）
  let subscribedEvents = [];
  let unsubs = [];
  try {
    const ev = ctx.events;
    if (ev && typeof ev.on === 'function') {
      const on = (name) => {
        try {
          const r = ev.on(name, () => {
            log('[EVENT]', name);                 // 诊断：失败事件被收到即打日志并落盘
            // 收紧判定：仅当真实收到播放失败事件，才把当前曲目记入「可疑集」——
            // 轮询通道只对可疑集的曲目判卡，普通未播放的正常歌曲永不误跳
            try {
              const p = player();
              const tid = trackIdOf(p);
              if (tid) { suspiciousTracks.set(tid, Date.now()); log('[EVENT] 记入可疑集', name, tid); }
            } catch {}
            handleError().catch(() => {});
          });
          if (r && typeof r === 'function') { unsubs.push(r); subscribedEvents.push(name); }
        } catch (e) { log('订阅失败', name, e); }
      };
      FAIL_EVENTS.forEach(on);
      log('失败事件订阅已挂载:', FAIL_EVENTS.join(', '));
    }
    // 兜底：宿主 error 事件通道
    if (ev && typeof ev.onError === 'function') {
      const r = ev.onError(() => {
        log('[EVENT]', 'onError');
        try {
          const p = player();
          const tid = trackIdOf(p);
          if (tid) { suspiciousTracks.set(tid, Date.now()); log('[EVENT] 记入可疑集 onError', tid); }
        } catch {}
        handleError().catch(() => {});
      });
      if (r && typeof r === 'function') { unsubs.push(r); subscribedEvents.push('onError'); }
      log('onError 兜底已挂载');
    } else {
      log('宿主未暴露 onError');
    }
  } catch (e) { log('挂载事件失败', e); }

  // 启动轮询兜底（第二通道）：覆盖宿主不发失败事件的卡死付费曲
  startPolling();

  // 启动诊断日志
  setTimeout(() => {
    try {
      const p = player();
      log('v1.2.3 已激活 | 开关:', state.enabled, '| audioUrlStall:', state.audioUrlStall, '| STALL_MS:', STALL_MS,
          '| 当前曲目:', trackIdOf(p) || '(空)',
          '| isPlaying:', isPlayingOf(p),
          '| currentTime:', timeOf(p),
          '秒 | ctx.events 存在:', !!(ctxRef && ctxRef.events),
          '| pinia player store:', !!p,
          '| 已订阅事件:', subscribedEvents.join(', ') || '(无)');
    } catch {}
  }, 1500);

  return {
    unload() {
      try {
        stopPolling();
        unsubs.forEach((fn) => { try { fn(); } catch {} });
        unsubs = [];
      } catch {}
    },
  };
}
