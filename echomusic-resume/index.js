/* EchoMusic 断点续播插件 · author: Luo
 * ======================================================================
 * 版本：v4.4.1（全局单槽 + 切号保护区 + 启动/切号恢复重试兜底 + 恢复不破坏宿主队列 +
 *   恢复期间用户手动接管不抢切：播放器为唯一实例，不分账号，
 *   仅记"最近一次正在播放且未播完的歌曲"，如同手边翻开的一本书——看到一半合上，换衣服（切号）回来
 *   继续翻；播完即合书，主动翻别的书才换书签）
 *
 * v4.4.1 变更（本轮）：修复"启动/切号恢复期间用户点下一首，歌曲被强制切回槽内旧曲且停在暂停态"。
 *  - 根因：v4.4.0 将 buildResumeQueue 改为 async（waitHostQueue 最长轮询 hostQueueWaitMs=3500ms）
 *    后，startupAutoPlay / accountAutoRestore 的 playTrack（切回槽内曲）会被推迟到用户点击下一首
 *    完成切歌之后才落地，与宿主切换争抢播放器实例，表现为"点击下一首直接暂停"。
 *  - 修复：引入 userTookOver 标记。onTrackChange 中非"恢复切回本身"的切歌（用户手动点歌/点下一首
 *    切到非槽内曲）即置位；startupAutoPlay 循环开头与 await buildResumeQueue 之后、accountAutoRestore
 *    接回前均做二次校验，检测到用户已接管则取消本次切回（清 restoringKey），新歌保持播放不动，
 *    不再被迟到 playTrack 打断。
 *
 * v4.2.0 变更（本轮）：切号保护（"换衣服继续看书"）。账号 = 衣服，正在听的歌 = 书。
 *  - 新增账号监测（user/account store uid 变化 → 判定切号），开启保护窗口 lockMs：
 *    窗口内播放器随切号自行播起的歌曲不再覆盖全局槽，书签进度保留；
 *    窗口内用户主动点歌（手动选曲，距切号 >500ms）仍正常替换书签（主动换书）。
 *  - 保护窗口结束后（switchDelay）若播放器仍停在非槽内歌曲、且期间无手动选曲，
 *    自动切回"这本书"并恢复进度。
 *  - switchPending 自动播放保护：切号引发的自动播放期间不写槽（saveProgress）、
 *    不清槽（onEnded），直至用户手动选曲 / 播放器回到槽内原书 / 60s 兜底超时。
 *  - 新增配置：switchDelay（切号后自动接回延迟，默认 1500ms）、lockMs（切号保护窗口，默认 2500ms）。
 *  - 槽 key 仍统一为 resume:last:__global__，不做账号维度隔离；删除的账号逻辑不回退。
 *
 * v4.1.0 变更（历史）：移除账号维度。
 *  - 播放器本身是唯一实例，无论登录哪个账号，槽统一为全局唯一
 *    resume:last:__global__：任何账号下被打断的最近一首歌都覆盖进这同一个槽。
 *  - 删除按账号隔离逻辑（uidDim / dimActive / isolateAccount / freeMode）、
 *    切号回播（accountSwitchAutoPlay / accountSwitchFallback / onAccountSignal /
 *    attachAccountHooks / lastSeenUid / accUid / accLockUntil / switchTimer /
 *    waitAccountReady）——不做"切号回播该账号上次歌曲"，只补"全局最近中断的一首"。
 *  - 启动时一次性清理历史残留：旧歌曲级记录 resume:<uid>:<track> 与
 *    旧账号隔离槽 resume:last:<uid> 均归并清除，只保留全局单槽与设置。
 *
 * v4.0.0 单槽语义重构：废弃"每首歌一条进度"的歌曲级记忆（resume:<uid>:<track> 双索引）。
 *        （历史版本轨迹，见 git/备份）
 *
 * 能力总览：
 *  1. 全局单槽进度记忆 —— 播放器全局只保留【最近一次正在播放且未播完的歌曲】及其进度
 *     （resume:last:__global__ 一个槽位）：槽随正在播放的歌曲即时更替，完整播完（onEnded）
 *     或距结尾过近即清空。既不会"每首歌都记进度"（避免类似影视断点续播的全量记忆），
 *     也不会丢"上次中断未播完"的收听位置——重启即补回这一首。
 *  2. 恢复可靠性 —— 等待播放器 duration 就绪后再 seek，并做 900ms 校验补偿；
 *     同曲 15s 去重防重复 seek。
 *  3. 隐私友好 —— 数据写入本机插件 storage，不联网、不采集任何个人信息。
 *
 * 兼容性：仅使用官方 ctx（storage / events / pinia / player store / ui），
 *         无硬编码账号、路径或机型依赖，第三方可直接复用。
 *
 * 存储结构（storage key）：
 *  - resume:last:__global__  全局"最近一次未播完歌曲"槽位（唯一）
 *                            { trackId, track, time, duration, ts }
 *                            随切歌更替，播完即清空（time=0/删除）。
 *  - resume:cfg              插件设置。
 *  （历史版本 resume:<uid>:<track> 歌曲级 / resume:last:<uid> 账号隔离槽，
 *   启动时由 cleanupLegacySlots 一次性移除。）
 *
 * 变更记录：
 *  v4.4.0 修复"随机循环在有放没有、在播却无曲"：根因是启动/切号自动续播在宿主随机池
 *        尚未构建（currentPlaylist 为空）时调用 buildResumeQueue，旧实现直接退化为单曲数组
 *        传给 playTrack —— 其第二参会整体替换 currentPlaylist（e.currentPlaylist = g），随机池
 *        被截断成一首歌（上一首/下一首失效、放完即停）。本轮将 buildResumeQueue 改为 async：
 *        宿主队列为空时先 waitHostQueue 轮询等待随机池/收藏队列就绪（默认 3500ms），
 *        就绪后沿用完整队列并把中断曲插队首续播，杜绝抢切宿主随机池；仅等待超时宿主
 *        仍无队列才单曲兜底。新增配置 hostQueueWaitMs。
 *  v4.3.2 修复"重启+切号后歌曲非中断曲"：根因是切号检测依赖 pinia $subscribe，
 *        真机该通道不可靠（历史故障：切号未触发保护，宿主自动播歌把全局槽覆盖为当日推荐曲）。
 *        新增两层兜底：① startUidPoll 定时轮询 computeUid，uid 变化即 onAccountSwitch 开保护窗；
 *        ② onTrackChange 写槽前同步快检 uid，发现新账号即判定切号自动播，跳过写槽保留书签。
 *        并扩展 computeUid 字段与遍历所有 store 取值，提高真机 uid 命中率。
 *  v4.3.1 修复恢复动作破坏播放队列：宿主 playTrack(id, tracks, opts) 把第二参整体赋给
 *        currentPlaylist，原实现传单曲数组导致队列只剩一首（上一首/下一首按钮失效、放完不连播）。
 *        新增 buildResumeQueue：优先沿用宿主 currentPlaylist 完整队列，中断曲不在则插队首，空则单曲兜底；
 *        同时去掉伪造的 sourceQueueId:'queue:history'，避免污染播放器 currentSourceQueueId。
 *  v4.3.0 恢复可靠性加固：启动自动续播（startupAutoPlay）与切号自动接回（accountAutoRestore）
 *        原实现为单次执行，播放器 store 未就绪（player()=null）或播放动作名探测失败时静默 return，
 *        导致重启/切号后没有恢复动作。现改为带重试：等待播放器就绪 + 探测 play 动作，失败按 400ms
 *        退避重试最多 12 次（约 12s），并输出原因日志，避免静默丢失。另加宽 computeUid 读取字段
 *        （userid/userId/id 多路径），提高切号识别率；activate 时输出启动诊断日志（版本/槽状态）。
 *  v4.2.0 切号保护（换衣服继续看书）：账号=衣服、正在听的歌=书；监测 uid 变化开启
 *        保护窗口，切号连带的自动播歌不覆盖全局槽；窗口内手动选曲正常换书签；窗口后自动接回。
 *  v4.1.0 全局单槽（不分账号）：播放器为唯一实例，删账号隔离与切号回播，
 *        槽固定 resume:last:__global__；启动清理旧账号槽与旧歌曲级记录。
 *  v4.0.0 单槽语义重构：废除"每首歌一条进度"的歌曲级记忆（resume:<uid>:<track> 双索引），
 *        改每账号/匿名维度仅保留一个"最近未播完歌曲"槽 resume:last:<uid>：切歌即时把槽更替
 *        为当前歌曲（time 归零、从头起步），进度经 onTimeUpdate 节流更新；onEnded 完整播完即
 *        清槽；距结尾 tailSkip 内不占槽。启动新增 startupAutoPlay：播放器当前未停留在槽内歌曲
 *        （即"重启后播放器显示另一首歌"）时主动切回并 resume；播放器已加载槽内歌曲则由 pursue
 *        直接恢复进度。存量 resume:<uid>:<track> 键由 cleanupLegacySlots 一次性清理。
 *  （以下为历史版本，仅存档不展开：v3.5.x 账号切换双通道 / v3.3 自动切歌抑制 /
 *    v3.0 模块化重构 / v2.x 账号隔离雏形）
 * ======================================================================
 */

/* ----------------------------- 常量区 ----------------------------- */
const PREFIX = 'resume:';
const LAST_PREFIX = PREFIX + 'last:';
const GLOBAL_UID = '__global__'; // 播放器全局唯一实例，不分账号：所有槽统一写这一个 key
const DEFAULT = {
  enabled: true,        // 总开关
  minSeconds: 12,       // 播放时长 >= N 秒才记录（跳过高片头噪音）
  tailSkip: 8,          // 距结尾 N 秒内视为已听完，不记录（避免听歌末尾误存）
  saveInterval: 3000,   // 节流：进度保存间隔（ms）
  restoreDelay: 600,    // 同曲恢复：等 duration 就绪后的起始延迟（ms）
  hostQueueWaitMs: 3500, // 恢复前等待宿主播放队列就绪的最长时长（ms，防抢切宿主随机池）
  seekComp: 900,        // 恢复后校验补偿 seek（ms）
  suppressOnAuto: true, // 自动切歌（下一首/随机/DJ）时不回带进度
  autoSuppressMs: 3000, // 自动切歌后的抑制窗口（ms）
  switchDelay: 1500,    // 切号后自动接回上次未播完歌曲的延迟（ms，等账号切换稳定）
  lockMs: 2500,         // 切号保护窗口：切号引发的曲目变化不覆盖槽（ms）
};
/* --------------------------- 可变状态区 --------------------------- */
let state = { ...DEFAULT };
let ctxRef = null;
let curTrack = null;    // 当前歌曲对象（onTrackChange 的 snap）
let curKey = '';        // 当前歌曲唯一 id
let lastSave = 0;       // 上次保存进度的时间戳
let restoreKey = '';    // 最近一次恢复的歌曲 key
let restoreAt = 0;      // 最近一次恢复时间戳
let restoringKey = '';  // 主动切回进行中的目标歌曲 key（切回触发的 onTrackChange 不再把槽清零）
let hookTimer = null;   // 动作监听重试定时器
let accHookTimer = null; // 账号监测重试定时器（独立于动作监听，避免互相覆盖）
let uidPollTimer = null; // uid 轮询定时器（切号检测兜底，不依赖 $subscribe）
let uidReady = false;   // uid 是否已就绪（首个非空 uid 仅作锚点，不作为切号信号）
let manualFlag = false; // 最近一次播放动作是否为手动（点歌/主动播放）
let lastAutoAt = 0;     // 最近一次自动切歌时间戳
let lastUid = '';       // 最近一次确认的账号 uid（仅用于识别"切号"，不做按账号记录）
let accSwitchAt = 0;    // 最近一次切号时间戳（切号保护窗口起点）
let accLockUntil = 0;   // 切号保护到期时间戳
let switchTimer = null; // 切号后延迟自动接回定时器
let switchPending = false; // 切号引发的自动播放态：此阶段不写槽/不清槽（保护书签），
                           // 直至用户手动选曲、播放器回到槽内原书、或超时兜底解除
let switchPendingTimer = null; // 切号保护兜底解除定时器
let userTookOver = false; // 用户在恢复等待/重试期间已手动接管播放（点歌/点下一首/切歌），须放弃强制切回
/* ---- 诊断 trace（本轮新增，纯只读，不改播放行为）---- */
const TRACE_KEY = PREFIX + 'trace'; // resume:trace，环形保留最近 N 条切歌快照
const MAX_TRACE = 40;
let traceBuf = null;   // 已加载的 trace 数组（懒加载）
let traceTimer = null; // 落盘防抖定时器
const cleanups = [];    // 卸载清理函数集合

/* --------------------------- 基础工具区 --------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 歌曲唯一 id：兼容 id / hash 两种字段 */
function trackKey(t) {
  if (!t) return '';
  return String(t?.id ?? t?.hash ?? '');
}

/** 序列化歌曲对象（去函数/循环引用），用于安全存入 storage */
function cleanTrack(o) {
  if (!o || typeof o !== 'object') return null;
  try { return JSON.parse(JSON.stringify(o)); }
  catch {
    const out = {};
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v !== null && typeof v !== 'function' && typeof v !== 'object') out[k] = v;
    }
    return out;
  }
}

/** 获取 storage store */
function store() {
  if (!ctxRef) return null;
  try { return ctxRef.storage; } catch { return null; }
}

/** 获取 pinia player store */
function player() {
  if (!ctxRef) return null;
  try { return ctxRef.pinia?._s?.get('player') ?? null; } catch { return null; }
}

/* 真机字段读取：pinia store 实例自身即 reactive 代理，顶层字段可直接读；
 * 同时兼容 $state / _state 两种取值路径，避免字段读不到导致 duration/进度恒为 0。 */
function durOf(p) {
  if (!p) return 0;
  return +(p?.duration ?? p?.$state?.duration ?? p?._state?.duration ?? 0) || 0;
}
function timeOf(p) {
  if (!p) return 0;
  return +(p?.currentTime ?? p?.$state?.currentTime ?? p?._state?.currentTime ?? 0) || 0;
}

/** 从 player store 读取当前曲目 id（多字段兜底） */
function currentTrackId() {
  const p = player();
  if (!p) return '';
  const st = p.$state ?? p;
  return String(
    st?.currentTrackId ?? st?.currentTrack?.id ?? st?.currentTrack?.hash ??
    st?.curTrackId ?? st?.curTrack?.id ?? st?.playback?.currentTrackId ??
    st?.trackId ?? st?.song?.id ?? ''
  );
}

/** 从 pinia user/account store 读取当前登录账号 uid（仅用于识别"切号"事件，不做按账号记录） */
function uidOfStore(o) {
  if (!o || typeof o !== 'object') return '';
  try {
    const s = o.$state ?? o;
    const u = o.user ?? s.user ?? s.info ?? s.data ?? null;
    const raw = s?.userid ?? s?.userId ?? s?.uid ?? s?.id;
    return String(
      u?.userid ?? u?.info?.userid ?? u?.userId ?? u?.uid ?? u?.id ??
      s?.userid ?? s?.userId ?? s?.uid ?? s?.id ?? raw ??
      o?.userid ?? o?.userId ?? o?.uid ?? o?.id ?? ''
    );
  } catch { return ''; }
}
function computeUid() {
  try {
    const names = ['user', 'account', 'userInfo', 'auth', 'profile', 'login'];
    const sMap = ctxRef?.pinia?._s;
    // ① 常见 store 名优先
    for (const n of names) {
      const v = sMap?.get?.(n);
      const uid = v ? (uidOfStore(v) || uidOfStore(v.$state)) : '';
      if (uid) return uid;
    }
    // ② 遍历所有 store 兜底：取第一个能读出非空 uid 的 store（findSkipped 访问顺序稳定）
    if (sMap && typeof sMap.forEach === 'function') {
      let hit = '';
      sMap.forEach((v) => {
        if (hit) return;
        const uid = v ? (uidOfStore(v) || uidOfStore(v.$state)) : '';
        if (uid) hit = uid;
      });
      if (hit) return hit;
    }
    return '';
  } catch { return ''; }
}

/* --------------------------- 进度读写区（v4.1.0 全局单槽） --------------------------- */
/**
 * 写入全局"最近未播完歌曲"槽位（resume:last:__global__，播放器唯一，不分账号）。
 * @param {object} extra { time?, duration? } —— 显式给定进度；缺省则读播放器实时位置
 *        （time=0 由切歌路径传入，表示新歌从头起步）。
 */
async function writeSlot(extra = {}) {
  const st = store();
  if (!st || !curTrack || !curKey) return;
  try {
    const key = LAST_PREFIX + GLOBAL_UID;
    const prev = await st.get(key);
    const d = player();
    const time = 'time' in extra
      ? Math.max(0, Math.floor(extra.time))
      : Math.max(0, Math.floor((timeOf(d) || 0) || (prev?.time ?? 0)));
    await st.set(key, {
      trackId: curKey,
      track: cleanTrack(curTrack),
      time,
      duration: Math.floor('duration' in extra ? extra.duration : durOf(d)),
      ts: Date.now(),
    });
  } catch {}
}

/** 清空全局槽位（完整播完时调用）；storage 无 remove 时用空记录占位兜底 */
async function clearSlot() {
  const st = store();
  const key = LAST_PREFIX + GLOBAL_UID;
  if (!st) return;
  try {
    if (typeof st.remove === 'function') await st.remove(key);
    else {
      await st.set(key, {
        trackId: '', track: null, time: 0, duration: 0, ts: Date.now(),
      });
    }
  } catch {}
}

/** 读取全局槽位；无记录 / 空记录 → null */
async function readSlot() {
  const st = store();
  if (!st) return null;
  try {
    const r = await st.get(LAST_PREFIX + GLOBAL_UID);
    if (!r || !r.trackId) return null;
    return r;
  } catch { return null; }
}

/**
 * v4.1.0 全局单槽写入：仅当当前歌曲"正在播放且未播完"时更新槽位进度。
 *  - minSeconds：试听未满最短时长不占槽；
 *  - tailSkip：距结尾过近视为已听完，不写入（与 onEnded 清槽语义一致）。
 */
async function saveProgress(t, force) {
  if (!state.enabled || !curKey) return;
  // 切号自动播放保护：播放器随切号自行播的歌不是用户主动选的书，不把其进度写入全局槽
  if (switchPending && !manualFlag && !force) return;
  if (t < state.minSeconds && !force) return; // 试听未满最短时长不占槽；force 强制落盘时绕过
  const st = store();
  if (!st) return;

  const now = Date.now();
  if (!force && now - lastSave < state.saveInterval) return;
  lastSave = now;

  const s = player();
  const dur = durOf(s);
  if (dur > 0 && t + state.tailSkip >= dur) return; // 距结尾过近：视为已听完，不占槽

  await writeSlot({ time: Math.max(0, Math.floor(t)), duration: Math.floor(dur) });
}

/** v4.1.0 存量清理：启动时一次性移除历史残留——
 *  ① 旧版本按账号隔离的槽 resume:last:<uid>；
 *  ② 更早版本的歌曲级记录 resume:<uid>:<trackId>（每首歌一条）。
 *  仅保留全局单槽 resume:last:__global__ 与设置 resume:cfg。
 *  仅当 storage 暴露 keys() 时执行。 */
async function cleanupLegacySlots() {
  const st = store();
  if (!st) return;
  try {
    const ks = typeof st.keys === 'function' ? await st.keys() : null;
    if (!Array.isArray(ks)) return;
    const keep = new Set(['resume:cfg', LAST_PREFIX + GLOBAL_UID]);
    let n = 0;
    for (const k of ks) {
      if (typeof k !== 'string' || !k.startsWith(PREFIX)) continue;
      if (keep.has(k)) continue; // 保留设置与全局单槽
      try {
        if (typeof st.remove === 'function') await st.remove(k);
        else await st.set(k, null);
        n++;
      } catch {}
    }
    if (n > 0) { try { console?.warn?.('[resume] v4.1.0 已清理历史进度记录 ' + n + ' 条'); } catch {} }
  } catch {}
}

/* --------------------------- 恢复执行区 --------------------------- */
/**
 * v4.4.0 构造续播队列（async）：优先沿用宿主当前播放列表，保留完整队列（连播/切歌均可用）。
 * 关键修复：宿主队列为空时不再立即退化为单曲——先等待宿主异步构建随机池/收藏队列
 * （waitHostQueue），就绪后再把中断曲插到队首；仅当等待超时宿主仍无队列才单曲兜底
 * （此时宿主本无可截断的池，单曲兜底既能续播又不破坏任何随机池）。调用方必须 await。
 */

/** 读取宿主当前播放队列快照；无有效队列返回 null */
function snapshotPlaylist() {
  try {
    const p = player();
    if (Array.isArray(p?.currentPlaylist) && p.currentPlaylist.length) return p.currentPlaylist.slice();
  } catch {}
  return null;
}

/** 等待宿主播放队列就绪（启动/唤醒早期宿主可能异步构建随机池/收藏队列）：
 *  轮询 currentPlaylist，非空即返回其快照；maxMs 超时返回 null。 */
async function waitHostQueue(maxMs = 3500) {
  const step = 200;
  const deadline = Date.now() + maxMs;
  for (;;) {
    const snap = snapshotPlaylist();
    if (snap) return snap;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

async function buildResumeQueue(slotTrack) {
  // 宿主还处于"切歌/建池"阶段时 currentPlaylist 可能短暂为空：先快照，空则等待宿主池就绪
  let base = snapshotPlaylist() || (await waitHostQueue(state.hostQueueWaitMs));
  const target = slotTrack ? [slotTrack] : [];
  if (!base) return target;      // 等待超时宿主仍无队列：单曲兜底（宿主无池，不截断随机）
  if (!target.length) return base; // 无中断曲信息：沿用宿主队列
  const want = trackKey(target[0]);
  if (want) {
    const hit = base.findIndex((t) => trackKey(t) === want);
    if (hit < 0) base.unshift(target[0]); // 中断曲不在队列：插到队首续播
  }
  return base;
}

/**
 * 真正的 seek 动作：等待 duration 就绪 → seek → 900ms 后校验补偿。
 * @param {number} t 目标秒数
 */
async function doSeek(t) {
  const p = player();
  if (!p || typeof p.seek !== 'function') return;

  // 等 duration 就绪（最多 8s）
  for (let i = 0; i < 40; i++) {
    if (durOf(p) > 0) break;
    await sleep(200);
  }

  try {
    const d = durOf(p);
    // 尾部修正：目标距结尾不足 tailSkip 时视为已听过，只回退一小段收尾播放，
    // 不要用 seekComp(ms) 当作秒做 d-seekComp（会把目标推成 0 导致从头播）。
    if (d > 0 && t + state.tailSkip >= d) t = Math.max(0, d - 2);
    p.seek(t);
  } catch {}

  // 校验补偿：seek 后 900ms 复查，若被播放器拒掉则再补一次
  await sleep(state.seekComp);
  try {
    const cur = timeOf(p);
    if (Math.abs(cur - t) > 3) p.seek(t);
  } catch {}
}

/**
 * 对单曲执行恢复（不做任何前置判断，由调用方保证目标歌曲已在播放）。
 * 15s 内同曲去重。
 */
async function attemptRestore(track, rec) {
  const key = trackKey(track);
  const now = Date.now();
  if (key && key === restoreKey && now - restoreAt < 15000) return;
  if (key) { restoreKey = key; restoreAt = now; }

  const t = Math.max(0, Number(rec?.time ?? 0));
  await sleep(state.restoreDelay);
  await doSeek(t);
}

/* ------------------------- 播放来源判定区 ------------------------- */
/* 通过 pinia store 的 $onAction 监听播放器动作名，区分「手动」与「自动」：
 * 手动动作（点歌/主动播放）→ 允许回带进度；自动动作（下一首/随机/DJ/连播）→ 抑制。
 * 监听失败或窗口外无法辨识时，一律按「可恢复」处理，保证不误杀手动点歌。 */
const MANUAL_ACT = /(^|[_.])(play|switch|click|pick|tap|selected|single|search)/i;
const AUTO_ACT = /(^|[_.])(next|prev|random|shuffle|auto|radio|dj|loop|follow|suggest)/i;

/* 挂载 $onAction 动作监听（区分手动/自动切歌）；player store 未就绪时返回 null */
function attachActionHook() {
  try {
    const p = player();
    if (!p || typeof p.$onAction !== 'function') return null;
    const off = p.$onAction(({ name }) => {
      const now = Date.now();
      if (AUTO_ACT.test(name)) { manualFlag = false; lastAutoAt = now; }
      else if (MANUAL_ACT.test(name)) {
        // 自动连播切歌若由含 'play/switch' 泛词的动作触发，$onAction 会走到 MANUAL 分支，
        // 若在此清掉 onEnded/AUTO_ACT 刚置的 lastAutoAt，自动抑制窗口立即失效，仍会回带曾听旧曲进度。
        // 修正：仍在自动抑制窗口内（距上次自动标记 < autoSuppressMs）时不清 lastAutoAt、不置手动，
        // 让 shouldSuppressAuto 的高优先级判定继续生效；只有窗口过期后的手动点歌才恢复「回带」资格。
        // 例外：切号保护窗口内（距切号 > 500ms，排除切号瞬间连带的自动播歌泛词）——
        // 此时到达的手动动作视为用户主动选曲（"换一件衣服后主动换本书"），需置手动标记以允许覆盖槽。
        if (now < accLockUntil && now - accSwitchAt > 500) {
          manualFlag = true; lastAutoAt = 0; endSwitchPending();
        } else if (!(lastAutoAt && now - lastAutoAt < state.autoSuppressMs)) {
          manualFlag = true; lastAutoAt = 0; endSwitchPending();
        }
      }
    });
    return () => { try { off(); } catch {} };
  } catch { return null; }
}

/** 动作监听时机修复：activate 时 player store 可能尚未注册（player() 返回 null），
 *  原实现直接 return 会导致监听永久失效。现改为未就绪时每 500ms 重试，最多 20 次
 * （约 10s）；成功即注册清理并停止重试。重试定时器由 unload 统一清理。 */
function hookActions() {
  const un = attachActionHook();
  if (un) { cleanups.push(un); return; }
  let tries = 0;
  const attempt = () => {
    const u2 = attachActionHook();
    if (u2) { cleanups.push(u2); clearTimeout(hookTimer); hookTimer = null; return; }
    if (++tries < 20) hookTimer = setTimeout(attempt, 500);
    else hookTimer = null;
  };
  hookTimer = setTimeout(attempt, 500);
}

/** 是否应抑制本次进度恢复（自动切歌场景） */
function shouldSuppressAuto() {
  if (!state.suppressOnAuto) return false;
  // 高优先级判定：距上次自动标记仍在抑制窗口内 → 无条件抑制恢复，
  // 不受 manualFlag 影响（onEnded 已可靠置位自动标记，兜住 $onAction 覆盖不到的路径）。
  if (lastAutoAt && Date.now() - lastAutoAt < state.autoSuppressMs) return true;
  return false;
}

/* --------------------------- 切号保护区（"换衣服继续看书"） --------------------------- */
/**
 * 语义（对齐用户比喻）：正在听的歌 = 手边翻开的一本书，账号 = 衣服。
 * 换衣服（切号）不影响"接着看同一本书"——书签（全局槽）不因切号丢失；
 * 只有用户主动去点别的书（手动选曲）才换书签覆盖槽。
 *
 * 实现：监测 pinia user/account store 的 uid 变化，判定"切号"后开启保护窗口 lockMs：
 *  - 窗口内播放器自行触发的切歌（切号连带的自动播歌）不再覆盖槽，保留原书签；
 *  - 窗口内用户主动点歌（手动动作，距切号 >500ms）仍正常覆盖槽（主动换书）；
 *  - 窗口结束后（switchDelay）若播放器仍停在非槽内歌曲、且期间无手动选曲，
 *    自动切回"这本书"并恢复进度。
 */

/** 挂载账号 store 订阅，uid 变化即触发切号保护；store 未就绪时返回 null。
 *  找不到已知名字的 account store 时，退化订阅所有 store（任一变即比对 uid），
 *  最大限度覆盖宿主 store 命名差异；即便全部失效，startUidPoll 轮询仍可兜底切号检测。 */
function attachAccountHook() {
  try {
    const sMap = ctxRef?.pinia?._s;
    if (!sMap) return null;
    const names = ['user', 'account', 'userInfo', 'auth', 'profile', 'login'];
    let roots = [];
    for (const n of names) {
      const v = sMap.get?.(n);
      if (v && typeof v.$subscribe === 'function') roots.push(v);
    }
    if (!roots.length && typeof sMap.forEach === 'function') {
      sMap.forEach((v) => { if (v && typeof v.$subscribe === 'function') roots.push(v); });
    }
    if (!roots.length) return null;
    let last = computeUid();
    const off = roots.map((root) => root.$subscribe(() => {
      const uid = computeUid();
      if (uid && uid !== last) { onAccountSwitch(uid); last = uid; return; }
      // uid 读不到时（两个账号都取不到字段）：无法区分切号，打日志便于排障，不误触发
      if (!uid && process?.env?.RESUME_DEBUG) { try { console?.log?.('[resume] computeUid 读不到 uid（store 变更但 uid 为空）'); } catch {} }
    }, { detached: true }));
    return () => { try { off.forEach((fn) => fn()); } catch {} };
  } catch { return null; }
}

/** uid 轮询切号检测（兜底通道）：$subscribe 在真机可能不可用 / 触发不可靠，
 *  改为定时主动比对 uid，变化即切入号保护。activate 起随生命周期长驻，卸载时清理。 */
function startUidPoll() {
  clearTimeout(uidPollTimer);
  uidPollTimer = setTimeout(() => {
    try {
      const uid = computeUid();
      if (uid) {
        if (!uidReady) { lastUid = uid; uidReady = true; } // 首个非空 uid 仅作锚点
        else if (uid !== lastUid) { onAccountSwitch(uid); } // 账号变化 → 开保护窗口
      }
    } catch {}
    uidPollTimer = setTimeout(() => startUidPoll(), 800);
  }, 800);
}

/** v4.3.2 防竞态写槽：槽内尚有有效书签（time>0）且出于非手动切歌时，延迟 1.2s 二次确认——
 *  期间若检测到账号变化（切号），判定本次切歌是"切号连带的自动播歌"：不覆盖书签，
 *  直接开启切号保护由 accountAutoRestore 接回；确认无切号才真正换书签。 */
async function confirmWriteSlot(extra) {
  const beginTs = Date.now();
  try {
    const before = computeUid();
    await sleep(1200);
    const after = computeUid();
    const finalUid = after || before;
    // ① 保护窗口已开启（快检 / 轮询任一通道已判定切号）→ 放弃写槽，保留书签
    if (switchPending || (accLockUntil && Date.now() < accLockUntil)) {
      if (finalUid && finalUid !== lastUid) lastUid = finalUid;
      return false;
    }
    // ② uid 相对锚点变化但保护窗未开（仅本通道抓到）→ 主动开保护窗
    const switched = !!finalUid && !!lastUid && finalUid !== lastUid;
    if (switched) {
      onAccountSwitch(finalUid);
      return false; // 判定切号自动播：不写槽
    }
  } catch {}
  // 写前最新性检查：延迟期间槽已被更新的写入（如更新切歌已落槽）时，放弃本次，避免乱序覆盖
  try {
    const st = store();
    const cur = await st?.get?.(LAST_PREFIX + GLOBAL_UID);
    if (cur?.ts && cur.ts > beginTs) return true;
  } catch {}
  await writeSlot(extra);
  return true;
}

/** 解除切号自动播放保护：用户已接管（动手选曲/回到原书），恢复正常的写槽/清槽行为 */
function endSwitchPending() {
  switchPending = false;
  clearTimeout(switchPendingTimer);
  switchPendingTimer = null;
}

/** 账号切换保护：开启保护窗口 + 定时自动接回 */
function onAccountSwitch(uid) {
  lastUid = uid;
  const now = Date.now();
  accSwitchAt = now;
  accLockUntil = now + state.lockMs;
  manualFlag = false;       // 切号这一刻起，播放器连带的动作视为自动行为
  lastAutoAt = now;         // 让切号自动播歌落在"自动"窗口内，避免误判为手动
  switchPending = true;     // 进入切号自动播放保护：期间不写槽/不清槽
  clearTimeout(switchTimer);
  clearTimeout(switchPendingTimer);
  // 兜底：自动接回迟迟未闭环（play 被拒等）时 60s 后解除保护，避免槽永久冻结
  switchPendingTimer = setTimeout(() => endSwitchPending(), 60000);
  switchTimer = setTimeout(() => accountAutoRestore().catch(() => {}), state.switchDelay);
}

/** 切号保护窗口结束后自动接回"这本书"：仅当播放器停在非槽内歌曲、且期间用户未主动选曲时执行 */
async function accountAutoRestore() {
  switchTimer = null;
  if (!state.enabled) return;
  // 仍在保护窗口内（例如用户沿用默认值 lockMs 很长）——先不动作，等窗口结束后再来
  if (Date.now() < accLockUntil) { switchTimer = setTimeout(() => accountAutoRestore().catch(() => {}), 400); return; }
  // 保护窗口内用户主动选过曲（读了别的书）→ 尊重用户，不再切回
  if (manualFlag) return;

  const slot = await readSlot();
  if (!slot) return; // 无书签
  const nowKey = currentTrackId();
  if (nowKey && String(nowKey) === String(slot.trackId)) {
    // 已在"这本书"上 → 仅恢复进度；先清除自动抑制标记，避免 pursue 被 autoSuppress 窗口拦截
    lastAutoAt = 0;
    pursue();
    return;
  }

  const p = player();
  if (!p) return;
  const playFnName = ['playTrack', 'switchTrack', 'playSong'].find((n) => typeof p[n] === 'function');
  if (!playFnName) return;
  restoringKey = String(slot.trackId);
  setTimeout(() => { if (restoringKey && restoringKey === String(slot.trackId)) restoringKey = ''; }, 5000);
  try {
    // 宿主 store playTrack 签名为 (id, tracks数组, options)：第二参必须是数组，传 {playlist} 对象会在宿主内部触发 e.map 崩溃。
    // v4.3.1：第二参不给单曲——宿主会把它整体当作 currentPlaylist，导致上一首/下一首失效、放完不连播。
    // 先用 buildResumeQueue 保留宿主完整队列（中断曲不在则插到队首）。
    const queue = await buildResumeQueue(slot.track);
    // v4.4.1：await buildResumeQueue 期间用户可能已手动切歌（onTrackChange 置位 userTookOver），
    // 此时接回会把用户刚选的新歌强制切回旧曲 → 取消本次接回，尊重用户当前选择。
    if (userTookOver || (manualFlag && String(currentTrackId()) !== String(slot.trackId))) {
      restoringKey = '';
      try { console?.log?.('[resume] 切号接回等待期间用户已手动切歌，取消接回'); } catch {}
      return;
    }
    p[playFnName](String(slot.trackId), queue, { autoPlay: true });
  } catch (e) {
    restoringKey = '';
    // 播放动作抛错（store 重建中 / 播放器状态异常）→ 短延迟重试一次，避免切号瞬间静默丢失接回
    try { console?.warn?.('[resume] 切号接回调用失败，400ms 后重试：', String(e)); } catch {}
    setTimeout(() => { restoringKey = String(slot.trackId); accountAutoRestore().catch(() => {}); }, 400);
  }
}

/** 账号监测未就绪时重试（与 hookActions 同理）；使用独立定时器 accHookTimer。 */
function hookAccount() {
  const un = attachAccountHook();
  if (un) { cleanups.push(un); return; }
  let tries = 0;
  const attempt = () => {
    const u2 = attachAccountHook();
    if (u2) { cleanups.push(u2); clearTimeout(accHookTimer); accHookTimer = null; return; }
    if (++tries < 20) accHookTimer = setTimeout(attempt, 500);
    else accHookTimer = null;
  };
  accHookTimer = setTimeout(attempt, 500);
}

/* ----------------------------- 核心逻辑 ----------------------------- */
/** 追播当前歌曲（v4.1.0 全局单槽语义）：仅当当前歌曲恰为全局槽内"最近未播完歌曲"
 *  时恢复进度；非槽内歌曲一律从头播放，不再回带任何历史进度（自动切歌时抑制）。 */
async function pursue() {
  if (!state.enabled) return;
  if (shouldSuppressAuto()) return;
  // 启动兜底：事件注册晚于恢复播放时 curKey 可能为空，用 store 现读取
  if (!curKey) curKey = currentTrackId();
  if (!curKey) return;

  const st = store();
  if (!st) return;
  const slot = await readSlot();
  if (!slot || String(slot.trackId) !== curKey) return; // 非槽内歌曲：从头播
  await attemptRestore(curTrack || { id: curKey }, slot);
}

/** 启动自动续播（v4.1.0）：解决"重启后播放器显示另一首歌"——启动时若播放器当前加载的
 *  不是全局槽内"最近未播完歌曲"，则主动切回并恢复进度；已加载槽内歌曲则由 pursue 直接恢复。
 *  启动期仅执行一次。 */
async function startupAutoPlay() {
  if (!state.enabled || !ctxRef) return;
  const st = store();
  if (!st) return;
  const slot = await readSlot();
  if (!slot) return; // 无"未播完歌曲"记录：不打扰用户

  const first = Date.now();
  let tries = 0;
  // 播放器 store / play 动作可能启动早期尚未就绪（尤其多进程/多窗口冷启动）：
  // 未就绪或切回失败时按 400ms 退避重试，最长约 12s，避免单次执行静默放弃。
  for (;;) {
    // 用户已在恢复等待期间手动接管（onTrackChange 置位）→ 立即退出，不再强制切回
    if (userTookOver) return;
    const nowKey = currentTrackId();
    // 播放器已加载槽内歌曲 → 仅恢复进度
    if (nowKey && String(nowKey) === String(slot.trackId)) { pursue(); return; }

    const p = player();
    const playFnName = p ? ['playTrack', 'switchTrack', 'playSong'].find((n) => typeof p[n] === 'function') : null;
    if (p && playFnName) {
      restoringKey = String(slot.trackId);
      setTimeout(() => { if (restoringKey && restoringKey === String(slot.trackId)) restoringKey = ''; }, 5000);
      let ok = true;
      try {
        // 宿主 store playTrack 签名为 (id, tracks数组, options)：第二参必须是数组，传 {playlist} 对象会在宿主内部触发 e.map 崩溃。
        // v4.3.1：第二参不给单曲——宿主会把它整体当作 currentPlaylist，导致上一首/下一首失效、放完不连播。
        // 先用 buildResumeQueue 保留宿主完整队列（中断曲不在则插到队首）。
        const queue = await buildResumeQueue(slot.track);
        // v4.4.1：await buildResumeQueue（最长 hostQueueWaitMs=3500ms 的轮询）期间，用户可能已经手动
        // 点击下一首/切歌并完成切歌（onTrackChange 已置位 userTookOver，或当前曲已变化）。此时再下发
        // playTrack 会把用户刚选的新歌强制切回槽内旧曲，与宿主争抢播放器实例，表现为"点下一首直接暂停"。
        // 二次校验：发车前用户已接管 → 取消本次切回，跳出的曲/新歌原样继续。
        if (userTookOver) { restoringKey = ''; return; }
        const nowKey2 = currentTrackId();
        if (nowKey2 && String(nowKey2) !== String(slot.trackId)) {
          try { console?.log?.('[resume] 恢复等待期间用户已手动切歌，取消迟到的切回（当前已停在其他曲目）'); } catch {}
          restoringKey = '';
          return;
        }
        p[playFnName](String(slot.trackId), queue, { autoPlay: true });
      } catch (e) { ok = false; restoringKey = ''; }
      try { console?.log?.('[resume] 启动续播：切回', String(slot.trackId), ok ? '(已下发)' : '(调用失败，将重试)', 'delay', Date.now() - first, 'ms'); } catch {}
      if (ok) { await sleep(800); if (!restoringKey) return; } // 已被 onTrackChange 消费 → 成功
      // play 静默未生效（restoringKey 仍挂着）：继续重试
    }
    if (++tries >= 12) {
      try { console?.warn?.('[resume] 启动续播重试', tries, '次后放弃（播放器可能未就绪或歌单受限）'); } catch {}
      return;
    }
    await sleep(400);
  }
}

/* ----------------------------- 诊断 trace（本轮新增，纯只读，不改播放行为） ----------------------------- */
/** 读取已有 trace 记录（storage 缺失/损坏返回空数组） */
async function readTrace() {
  try {
    const r = await store()?.get?.(TRACE_KEY);
    return Array.isArray(r) ? r : [];
  } catch { return []; }
}
/** 取当前 player store 关键状态快照（只读，不触发任何动作） */
function playerStateSnap() {
  try {
    const p = player();
    const s = p?.$state ?? p ?? {};
    return {
      currentTrackId: String(s?.currentTrackId ?? s?.currentTrack?.id ?? ''),
      playing: !!s?.playing, paused: !!s?.paused,
      time: Math.floor(+(s?.currentTime ?? 0) || 0),
      duration: Math.floor(+(s?.duration ?? 0) || 0),
    };
  } catch { return {}; }
}
/** 追加一条切歌诊断记录：内存缓冲 + 防抖落盘（每次切歌 1 条），不 touch 播放器状态 */
function pushTrace(prev, snap, meta) {
  try {
    const rec = {
      ts: Date.now(),
      prev: prev ? { key: String(prev.key), title: prev.track?.title ?? prev.track?.name ?? '', artist: prev.track?.artist ?? '', hash: prev.track?.hash ?? '', hasAudioUrl: !!prev.track?.audioUrl } : null,
      cur: snap ? { key: String(snap.id ?? snap.hash ?? ''), title: snap.title ?? snap.name ?? '', artist: snap.artist ?? '', hash: snap.hash ?? '', hasAudioUrl: !!snap.audioUrl } : null,
      state: playerStateSnap(),
      meta: meta || {},
    };
    (async () => {
      let arr = traceBuf;
      if (!arr) { arr = await readTrace(); traceBuf = arr; }
      arr.push(rec);
      if (arr.length > MAX_TRACE) arr.splice(0, arr.length - MAX_TRACE);
      clearTimeout(traceTimer);
      traceTimer = setTimeout(() => { try { void store()?.set?.(TRACE_KEY, arr); } catch {} traceTimer = null; }, 300);
    })();
  } catch {}
}

/* ----------------------------- 事件绑定 ----------------------------- */
function bindEvents() {
  const ev = ctxRef.events;
  if (!ev) return;

  // 切歌：更新当前歌曲 + 把全局槽更替为当前歌曲（零点起步） + 尝试追播
  ev.onTrackChange?.(async (snap) => {
    if (!snap) return;
    const prevInfo = { key: curKey, track: curTrack }; // 下一曲前的上一曲快照（供诊断 trace）
    curTrack = snap;
    const k = trackKey(snap);
    const changed = k !== curKey;
    curKey = k;
    let resumeConsumed = false; // 本次切歌是否为"恢复切回"本身被消费（如是则不算用户手动接管）
    if (changed) {
      if (restoringKey && String(restoringKey) === k) {
        // v4.0.0 fix：本次切歌是"主动切回槽内歌曲"（启动/续播）触发的——
        // 保留槽内原进度不清零，pursue 随即恢复该进度；消费标记后清除。
        resumeConsumed = true;
        restoringKey = '';
        endSwitchPending(); // 已回到"这本书"：切号自动播放态结束，恢复正常写槽
      } else if (Date.now() < accLockUntil && !manualFlag) {
        // 切号保护区：播放器随切号自行播起的歌曲（此时用户未主动选曲）不覆盖槽，
        // 保留"这本书"的书签进度，稍后由 accountAutoRestore 接回；窗口内用户手动点歌
        // （manualFlag 已置位）则走下方常规分支正常换书签。
      } else {
        // v4.3.2：写槽前同步快检一次 uid——宿主切号瞬间轮询可能还没抓到，若此刻发现
        // 是新账号（uid !== lastUid），判定当前切歌是"切号连带的自动播歌"：不覆盖书签，
        // 立即开启切号保护，由 accountAutoRestore 把"这本书"接回。
        const uidNow = computeUid();
        if (uidNow && !lastUid) { lastUid = uidNow; uidReady = true; }
        else if (uidNow && uidNow !== lastUid) {
          onAccountSwitch(uidNow);
          return; // 本次切歌视为切号自动播：跳过写槽，保留原书签
        }
        // 回到"这本书"且槽内仍有其进度（切号保护期等未覆盖场景）→ 保留槽不清零，
        // 交由 pursue 恢复进度；切到其他新歌才把槽更替并从头起步。
        let reserved = false;
        let prevHasProgress = false;
        try {
          const slot = await readSlot();
          reserved = !!(slot && String(slot.trackId) === k && (slot.time || 0) > 0);
          prevHasProgress = !!(slot && String(slot.trackId) !== k && (slot.time || 0) > 0);
        } catch {}
        // v4.1.0：常规切歌把全局槽更替为"当前歌曲"并从零点起步，进度随后由 onTimeUpdate 节流写入——
        // 槽始终是"最近一次正在播放的未播完歌曲"，不为每首歌保留记录。
        // v4.3.2：若旧槽还有有效书签进度、且本次非用户手动点歌，"更换书签"先经 confirmWriteSlot
        // 延迟确认是否切号自动播——防宿主切号自动播放把"这本书"的书签覆盖掉（换书签延迟 1.2s 可接受）。
        if (!reserved) {
          if (prevHasProgress && !manualFlag) confirmWriteSlot({ time: 0 });
          else writeSlot({ time: 0 });
        }
      }
    }
    // v4.4.1：用户手动切歌产生的 onTrackChange（切到非槽内曲，且不是恢复切回本身）→ 标记用户已接管，
    // 让 startupAutoPlay 在 await buildResumeQueue 期间迟到落地的 playTrack 立即放弃，避免把用户刚点
    // 的下一首强制切回槽内旧曲、与宿主争抢实例停在暂停态。
    if (changed && !resumeConsumed) userTookOver = true;
    // 诊断 trace（本轮新增，纯只读）：切歌瞬间记录上一曲/当前曲/播放器状态快照到 resume:trace
    if (changed) pushTrace(prevInfo, snap, { consumed: resumeConsumed, restoring: !!restoringKey, manual: manualFlag });
    pursue();
  });

  // 进度落点（节流保存）
  ev.onTimeUpdate?.(() => {
    const p = player();
    if (!p) return;
    saveProgress(timeOf(p), false);
  });

  // seek 打断：清掉去重标记，允许后续再次精准恢复
  ev.onSeek?.(() => { restoreKey = ''; });

  // 播放结束：此曲结束即视为进入自动连播/下一曲，onEnded 是自动连播都必经的钩子，
  // 在此强制标记「最近一次为自动」+ 清空 manualFlag，使后续命中曾听旧曲时不回带旧进度；
  // 同时完整播完的歌曲不占槽——槽只保留"上次中断未播完"的歌曲，播完即清空，
  // 若接着连播下一首，onTrackChange 会写入新歌零点槽。
  ev.onEnded?.(() => {
    lastSave = 0;
    lastAutoAt = Date.now();
    manualFlag = false;
    // 切号自动播放保护：随切号自行播的这首是"临时播放"，完整播完也不视为用户在听原书
    // 已读完——书签保留，不执行 clearSlot；等用户手动接管或回到原书后再恢复清槽语义。
    if (switchPending) return;
    clearSlot();
  });
}

/* ----------------------------- 生命周期 ----------------------------- */
/** 保存设置到宿主 storage */
async function saveResumeCfg() {
  try { await ctxRef?.storage?.set?.('resume:cfg', { ...state }); } catch {}
}

/* --------------------------- 设置面板（component 新格式） --------------------------- */
function createSettingsComponent(ctx) {
  const { h } = ctx.vue;
  const defineAsyncComponent = ctx.vue.defineAsyncComponent;
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);

  const row = (label, hint, control) =>
    h('div', { class: 'resume-setting-row' }, [
      h('div', { class: 'resume-setting-head' }, [
        h('span', { class: 'resume-setting-title' }, label),
        hint ? h('span', { class: 'resume-setting-hint' }, hint) : null,
      ]),
      h('div', { class: 'resume-setting-control' }, [control]),
    ]);

  const numberField = (label, key, hint, step = 1) => {
    const onInput = (e) => {
      let v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      state[key] = v;
      saveResumeCfg();
    };
    return row(
      label,
      hint,
      h('input', {
        type: 'number',
        step,
        min: 0,
        value: String(state[key] ?? 0),
        onInput,
        onChange: onInput,
        style: 'width:120px;padding:4px 8px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;font-size:13px;',
      })
    );
  };

  const toggleRow = (label, key, hint) =>
    row(
      label,
      hint,
      h(Switch, {
        modelValue: Boolean(state[key]),
        'onUpdate:modelValue': (v) => { state[key] = Boolean(v); saveResumeCfg(); },
      })
    );

  return ctx.vue.defineComponent({
    name: 'ResumeSettings',
    setup() {
      return () =>
        h('div', { class: 'resume-settings' }, [
          toggleRow('启用断点续播', 'enabled', '关闭后保留槽数据，但不再自动恢复/记录进度。'),
          toggleRow('随机/自动切歌不回带进度', 'suppressOnAuto', '自动连播/随机/DJ 切歌时不回带旧进度。'),
          numberField('最短记录时长（秒）', 'minSeconds', '播放时长 >= N 秒才记录，跳过高片头噪音', 1),
          numberField('保存间隔（毫秒）', 'saveInterval', '进度保存节流间隔', 500),
          numberField('恢复延迟（毫秒）', 'restoreDelay', '同曲恢复：等 duration 就绪后的起始延迟', 100),
          numberField('切号后自动接回延迟（毫秒）', 'switchDelay', '等账号切换稳定后再接回上次未播完歌曲', 100),
          numberField('切号保护窗口（毫秒）', 'lockMs', '切号引发的曲目变化不覆盖槽', 100),
        ]);
    },
  });
}

export async function activate(ctx) {
  ctxRef = ctx;

  // 加载已有配置
  try {
    const u = await ctx.storage?.get?.('resume:cfg');
    if (u && typeof u === 'object') state = { ...DEFAULT, ...u };
  } catch {}

  // 设置面板（新版 component 格式，宿主要求必须提供 component）
  try {
    ctx.ui?.settings?.define?.({
      title: '断点续播',
      description: '自动记录播放进度，切歌后回到上次位置。',
      component: createSettingsComponent(ctx),
    });
  } catch (e) { console?.log?.('[resume] 设置面板注册失败', e); }

  bindEvents();
  hookActions(); // 监听播放器动作来源，区分手动/自动切歌
  hookAccount(); // 切号保护区：监测账号变化（$subscribe 通道）
  startUidPoll(); // 切号检测兜底：uid 轮询通道（$subscribe 不可用时仍可靠）
  userTookOver = false; // v4.4.1：插件加载即复位"用户已接管"标记

  // 启动诊断日志（devtools console 可见）：确认当前加载插件版本与槽状态
  setTimeout(async () => {
    try {
      const slot = await readSlot();
      console?.log?.('[resume] v4.4.1 已激活 | 当前曲目:', currentTrackId() || '(空)', '| 槽:', slot ? (slot.trackId + ' @' + slot.time + '/' + slot.duration) : '(空)', '| uid:', computeUid() || '(读不到)');
    } catch {}
  }, 1500);

  // 启动即追播（播放器已加载槽内歌曲则直接恢复进度）
  setTimeout(() => pursue(), state.restoreDelay + 200);
  // v4.1.0：启动自动续播 —— 播放器当前加载的不是"最近未播完歌曲"（如"重启后显示另一首"）
  // 时主动切回并恢复进度；已就绪场景由上面的 pursue 处理。
  setTimeout(() => startupAutoPlay().catch(() => {}), state.restoreDelay + 900);
  // v4.1.0：一次性清理历史残留（旧账号隔离槽 + 旧歌曲级记录）
  setTimeout(() => cleanupLegacySlots().catch(() => {}), 2000);

  return {
    unload() {
      // v4.4.2：退出前强制落盘当前进度（force 绕过节流与最短时长），避免最后几秒
      // 进度未写入、重启后从偏前位置恢复。
      try { saveProgress(timeOf(player()), true); } catch {}
      clearTimeout(hookTimer);
      clearTimeout(accHookTimer);
      clearTimeout(uidPollTimer);
      clearTimeout(switchTimer);
      clearTimeout(switchPendingTimer);
      cleanups.forEach((fn) => { try { fn(); } catch {} });
      cleanups.length = 0;
    },
  };
}
