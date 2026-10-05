/**
 * EchoMusic 四自研插件公共 SDK（echomusic-sdk）
 * 版本: 1.0.0
 * 作者: Luo
 *
 * 用途：把 echomusic-resume / kugou-concept-sign / echomusic-timer / echomusic-payskip
 * 四个自研插件中重复出现的宿主交互实现收敛为单一模块。各插件目录内以
 * `import * as SDK from './sdk.js'` 引用（副本模式，本文件为唯一事实源，
 * 由 sync_sdk.py 同步到各插件目录，禁止手工修改副本）。
 *
 * 约束（继承契约清单 §5.1 红线）：
 *   - 源码禁止使用 ?? / ?. 等 esprima 类解析器不识别/易误判的语法（已降级为 || / 显式判断）。
 *   - 全链路 try/catch 包裹，异常落日志不冒泡，避免拖垮渲染进程（render-process-gone）。
 *   - 不改变宿主契约：playTrack 第二参强制数组；onError 不作失败事件可靠来源；
 *     net.request 参数顺序 (pluginId, requestId, options, body)、带 body 的 POST 必须走 fetch。
 */

// ============================================================================
// [M1] 统一 player store 访问器
// 抽取来源：echomusic-resume player() / echomusic-timer store() / echomusic-payskip player()
// 兼容边界：顺序 ① ctx.pinia._s.get(name) ② ctx.stores[name] ③ null。
// ============================================================================
export function getPlayerStore(ctx, name) {
  const n = (name === undefined || name === null) ? 'player' : name;
  try {
    if (!ctx) return null;
    if (ctx.pinia && ctx.pinia._s && typeof ctx.pinia._s.get === 'function') {
      const s = ctx.pinia._s.get(n);
      if (s) return s;
    }
    if (ctx.stores && ctx.stores[n]) return ctx.stores[n];
  } catch (e) { return null; }
  return null;
}

// ============================================================================
// [M2] 动作名探测器
// 抽取来源：echomusic-resume（playTrack 系探测+缓存）、echomusic-payskip（next 系探测）
// ============================================================================
export const PLAY_TRACK_NAMES = ['playTrack', 'switchTrack', 'playSong'];
export const NEXT_TRACK_NAMES = ['next', 'nexttrack', 'nextTrack'];

/**
 * 在 store 上按优先级探测动作名（store[name] 或 store.$state[name] 为 function）。
 * @param {object} store
 * @param {Array<string>} names
 * @returns {string|null}
 */
export function detectActionName(store, names) {
  if (!store || !names || !names.length) return null;
  const st = (store.$state && typeof store.$state === 'object') ? store.$state : null;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (typeof store[n] === 'function') return n;
    if (st && typeof st[n] === 'function') return n;
  }
  return null;
}

/**
 * 带缓存的即时探测器：首次命中后缓存，store 引用变化时自动失效重探。
 * @param {Function} storeRef  返回当前 store（可每次调用实时取）
 * @param {object} table       { write: [...], next: [...], seek: [...] }
 * @returns {{ name(kind): string|null, probe(kind): string|null, reset(): void }}
 */
export function createActionDetector(storeRef, table) {
  const cache = {};
  const t = table || {};
  return {
    probe(kind) {
      const store = (typeof storeRef === 'function') ? storeRef() : storeRef;
      if (!store) return null;
      if (cache._store !== store) { cache._store = store; cache.byKind = {}; }
      if (cache.byKind && cache.byKind[kind]) return cache.byKind[kind];
      const names = t[kind] || [];
      const found = detectActionName(store, names);
      if (cache.byKind) cache.byKind[kind] = found;
      return found;
    },
    reset() { cache._store = undefined; cache.byKind = {}; },
  };
}

// ============================================================================
// [M3] 播放动作封装（含红线落点）
// 抽取来源：echomusic-resume play()/doSeek()、echomusic-payskip nextTrack()
// 红线①：playTrack 第二参必须为数组（宿主整体赋给 currentPlaylist，详见契约清单）。
// ============================================================================

/**
 * 以探测到的写播放动作名调用播放。tracks 强制数组。
 * @param {object} store
 * @param {string} fnName   playTrack / switchTrack / playSong
 * @param {string|number} trackId
 * @param {Array} tracks
 * @param {object} opts     默认 { autoPlay: true }
 * @returns {*} 调用结果（可为 Promise）
 */
export function invokePlay(store, fnName, trackId, tracks, opts) {
  if (!store || typeof store[fnName] !== 'function') return null;
  const id = String(trackId);
  let queue = tracks;
  if (!Array.isArray(queue)) queue = queue === undefined || queue === null ? [id] : [queue];
  const o = opts || { autoPlay: true };
  try {
    return store[fnName](id, queue, o);
  } catch (e) { return null; }
}

/**
 * 自动探测 playTrack 系并调用（playTrack > switchTrack > playSong）。
 * @returns {*} 调用结果（可为 Promise）；无可用动作返回 null。
 */
export function playTrackSafe(store, trackId, tracks, opts) {
  const n = detectActionName(store, PLAY_TRACK_NAMES);
  if (!n) return null;
  return invokePlay(store, n, trackId, tracks, opts);
}

/**
 * 自动探测 next 系并调用（next > nexttrack > nextTrack）。
 * 返回 { ok, reason, name, result, error }；reason: 'ok' | 'no_action' | 'error'。
 * 约定：异步 rejection 不在此吞掉，由调用方对 result 挂 catch（保持各插件原日志语义，
 *      并避免 SDK 静默丢失调用方想记录的异常）。
 */
export function nextTrack(store) {
  const n = detectActionName(store, NEXT_TRACK_NAMES);
  if (!n) return { ok: false, reason: 'no_action', name: null, result: undefined, error: null };
  try {
    const r = store[n]();
    return { ok: true, reason: 'ok', name: n, result: r, error: null };
  } catch (e) {
    return { ok: false, reason: 'error', name: n, result: undefined, error: e };
  }
}

/**
 * seek 骨架（seconds），不含 resume 的「等 duration 就绪 + seekComp 补偿」业务。
 * @returns {*} 调用结果；无 seek 动作返回 null。
 */
export function seekTo(store, seconds) {
  if (!store) return null;
  const names = ['seek', 'seekTo', 'seekByTime'];
  const n = detectActionName(store, names);
  if (!n) return null;
  try { return store[n](Number(seconds)); } catch (e) { return null; }
}

// ============================================================================
// [M4] 播放器状态字段读取器
// 抽取来源：echomusic-resume / echomusic-payskip / echomusic-timer 三处重复实现
// ============================================================================

/** 归一化状态对象：store.$state ?? store._state ?? store */
export function getPlayerState(store) {
  if (!store) return null;
  try {
    if (store.$state && typeof store.$state === 'object') return store.$state;
    if (store._state && typeof store._state === 'object') return store._state;
  } catch (e) { return store || null; }
  return store || null;
}

/** 是否播放中（多字段兼容；null 视为字段缺失，继续探测下一位） */
export function isPlayingOf(store) {
  const s = getPlayerState(store);
  if (!s) return false;
  if (s.isPlaying !== undefined && s.isPlaying !== null) return !!s.isPlaying;
  if (s.isPlay !== undefined && s.isPlay !== null) return !!s.isPlay;
  const ep = (s.enginePlayback && typeof s.enginePlayback === 'object') ? s.enginePlayback : null;
  if (ep) {
    if (ep.playing !== undefined && ep.playing !== null) return !!ep.playing;
    if (typeof ep.status !== 'undefined') return ep.status === 'playing';
  }
  if (s.playing !== undefined && s.playing !== null) return !!s.playing;
  return false;
}

/** 当前播放位置（秒）。currentTimeMs 存在则毫秒归一；currentTime 以秒计，>1000 兜底做 ms 归一。 */
export function timeOf(store) {
  const s = getPlayerState(store);
  if (!s) return 0;
  if (s.currentTimeMs !== undefined && s.currentTimeMs !== null) {
    const v = Number(s.currentTimeMs) / 1000;
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  if (s.currentTime !== undefined && s.currentTime !== null) {
    const v = Number(s.currentTime);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return v > 1000 ? v / 1000 : v;
  }
  return 0;
}

/** 当前曲目 ID（多字段兼容链，覆盖三插件全部已知字段） */
export function trackIdOf(store) {
  const s = getPlayerState(store);
  if (!s) return '';
  const snap = s.currentTrackSnapshot && typeof s.currentTrackSnapshot === 'object' ? s.currentTrackSnapshot : null;
  const cur = s.currentTrack && typeof s.currentTrack === 'object' ? s.currentTrack : null;
  const cur2 = s.curTrack && typeof s.curTrack === 'object' ? s.curTrack : null;
  const pb = s.playback && typeof s.playback === 'object' ? s.playback : null;
  const song = s.song && typeof s.song === 'object' ? s.song : null;
  let v = s.currentTrackId;
  if ((v === undefined || v === null) && cur) v = cur.id;
  if ((v === undefined || v === null) && cur) v = cur.hash;
  if ((v === undefined || v === null) && snap) v = snap.id;
  if ((v === undefined || v === null) && snap) v = snap.hash;
  if ((v === undefined || v === null) && s.curTrackId !== undefined) v = s.curTrackId;
  if ((v === undefined || v === null) && cur2) v = cur2.id;
  if ((v === undefined || v === null) && pb) v = pb.currentTrackId;
  if ((v === undefined || v === null) && s.currentId !== undefined) v = s.currentId;
  if ((v === undefined || v === null) && s.trackId !== undefined) v = s.trackId;
  if ((v === undefined || v === null) && s.songId !== undefined) v = s.songId;
  if ((v === undefined || v === null) && song) v = song.id;
  return (v === undefined || v === null) ? '' : String(v);
}

/** 当前曲目时长（秒）。 */
export function durationOf(store) {
  const s = getPlayerState(store);
  if (!s) return 0;
  let v = s.duration;
  if ((v === undefined || v === null) && s.currentDuration !== undefined) v = s.currentDuration;
  if ((v === undefined || v === null) && s.songDuration !== undefined) v = s.songDuration;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1000 ? n / 1000 : n;
}

/** 是否已接近当前曲目结尾（剩余不足 threshold 秒）。来源：echomusic-timer nearTrackEnd 泛化。 */
export function nearTrackEnd(store, threshold) {
  const th = (threshold === undefined || threshold === null) ? 0.9 : Number(threshold);
  const dur = durationOf(store);
  const cur = timeOf(store);
  return dur > 0 && (dur - cur) < th;
}

// ============================================================================
// [M5] toast 封装
// 抽取来源：echomusic-payskip toast / echomusic-timer toast
// ============================================================================
export function toastCtx(ctx, msg, type) {
  const t = (type === undefined || type === null) ? 'info' : type;
  try {
    if (!ctx || !ctx.toast) return;
    if (typeof ctx.toast[t] === 'function') { ctx.toast[t](msg); return; }
    if (typeof ctx.toast.info === 'function' && t !== 'info') { ctx.toast.info(msg); }
  } catch (e) {}
}

// ============================================================================
// [M6] 日志器工厂
// 抽取来源：echomusic-timer diag（storage sink）/ echomusic-payskip log+dbgLog /
//          kugou-concept-sign LOG（console+localStorage 双写）
// sink 支持 'console' / 'storage' / 'localStorage' 或数组组合。
// storageFormat: 'lines'（{ lines:[...] }）| 'tsmsg'（[{ t, msg }]，payskip 原结构）。
// ============================================================================
export function createLogger(prefix, opts) {
  const o = opts || {};
  const sinks = Array.isArray(o.sink) ? o.sink : [o.sink || 'console'];
  const cap = (o.cap === undefined || o.cap === null) ? 100 : Number(o.cap);
  const storageKey = o.storageKey || '';
  const lsKey = o.localStorageKey || '';
  const cfmt = o.storageFormat === 'tsmsg' ? 'tsmsg' : 'lines';
  const consoleLabel = o.consolePrefix || prefix || '';
  let buf = [];
  let saving = false;

  function storageGet() {
    const getCtx = (typeof o.getCtx === 'function') ? o.getCtx : null;
    if (!getCtx) return null;
    const ctx = getCtx();
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return null;
    try { return ctx.storage.get(storageKey); } catch (e) { return null; }
  }
  function storageSet(val) {
    const getCtx = (typeof o.getCtx === 'function') ? o.getCtx : null;
    if (!getCtx) return;
    const ctx = getCtx();
    if (!ctx || !ctx.storage || typeof ctx.storage.set !== 'function') return;
    try {
      const p = ctx.storage.set(storageKey, val);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {}
  }

  /**
   * 追加一条日志：同步入本地 buf，随后合并存储端既有数据（幂等去重由 params 保证不重复落盘，
   * 采用先读后写）。为避免每次读盘，仅在新条目产生时刷新一次。
   */
  function flush() {
    if (!buf.length || saving) return;
    const batch = buf;
    buf = [];
    saving = true;
    const gp = storageGet();
    const mergeWrite = (existing) => {
      try {
        let list;
        if (cfmt === 'tsmsg') {
          list = (Array.isArray(existing) ? existing : []).slice(-(cap - batch.length));
          for (let i = 0; i < batch.length; i++) list.push({ t: Date.now(), msg: batch[i] });
        } else {
          const arr = (existing && Array.isArray(existing.lines)) ? existing.lines : (Array.isArray(existing) ? existing : []);
          list = arr.slice(-(cap - batch.length));
          for (let i = 0; i < batch.length; i++) list.push(batch[i]);
          list = { lines: list };
        }
        storageSet(list);
      } catch (e) {}
      saving = false;
    };
    if (gp && typeof gp.then === 'function') {
      gp.then(mergeWrite).catch(() => { mergeWrite(null); });
    } else {
      mergeWrite(gp);
    }
  }

  return {
    log() {
      const a = Array.prototype.slice.call(arguments);
      let txt = '';
      try {
        txt = a.map((v) => {
          if (typeof v === 'string') return v;
          try { return JSON.stringify(v); } catch (e) { return String(v); }
        }).join(' ');
      } catch (e) {}
      if (sinks.indexOf('console') >= 0) {
        try { console.log(consoleLabel, a.length === 1 ? a[0] : a); } catch (e) {}
      }
      if (sinks.indexOf('storage') >= 0 && storageKey) {
        buf.push(txt);
        if (buf.length >= cap) flush();
        if (!saving) setTimeout(flush, 0);
      }
      if (sinks.indexOf('localStorage') >= 0 && lsKey) {
        try {
          const prev = window && window.localStorage ? window.localStorage.getItem(lsKey) : null;
          let arr = [];
          try { arr = prev ? JSON.parse(prev) : []; } catch (e) { arr = []; }
          if (!Array.isArray(arr)) arr = [];
          arr.push(txt);
          if (arr.length > cap) arr = arr.slice(-cap);
          window.localStorage.setItem(lsKey, JSON.stringify(arr));
        } catch (e) {}
      }
    },
    flush,
  };
}

// ============================================================================
// [M7] storage 读写封装
// 抽取来源：四插件 ctx.storage.get/set 全量调用点
// ============================================================================
export async function storageGet(ctx, key, fallback) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.get !== 'function') return fallback || null;
    const v = await ctx.storage.get(key);
    return (v === undefined || v === null) ? (fallback || null) : v;
  } catch (e) { return fallback || null; }
}

export function storageSet(ctx, key, value) {
  try {
    if (!ctx || !ctx.storage || typeof ctx.storage.set !== 'function') return;
    const p = ctx.storage.set(key, value);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) {}
}

// ============================================================================
// [M8] 配置骨架工厂
// 抽取来源：resume/sign/timer/payskip 各自 loadCfg/saveCfg
// migrate(state) 在 load 后调用（如 timer 的 action:'pause'→'stop' 迁移留在插件侧）。
// ============================================================================
export function createConfig(getCtx, key, defaults, opts) {
  const o = opts || {};
  const state = { ...defaults };
  return {
    state,
    /** 加载存储端配置并合并默认值；合并顺序 { ...defaults, ...stored }，对齐各插件原语义。 */
    async load() {
      try {
        const v = await storageGet(getCtx(), key, null);
        if (!v || typeof v !== 'object') return;
        const merged = { ...defaults };
        for (const k in v) { merged[k] = v[k]; }
        Object.assign(state, merged);
      } catch (e) {}
    },
    save() {
      try {
        storageSet(getCtx(), key, { ...state });
      } catch (e) {}
    },
  };
}

// ============================================================================
// [M9] 设置面板组件工厂
// 抽取来源：echomusic-payskip createSettingsComponent / echomusic-resume settings /
//          kugou-concept-sign settingsPanel
// 注意：样式类名与各插件字段集合留在各插件内（UI 外观不变）。
// ============================================================================
export function createSettingsToolkit(ctx) {
  const vue = ctx && ctx.vue ? ctx.vue : null;
  const ui = ctx && ctx.ui ? ctx.ui : null;
  const h = vue && typeof vue.h === 'function' ? vue.h : null;
  const defineComponent = vue && typeof vue.defineComponent === 'function' ? vue.defineComponent : null;
  const defineAsyncComponent = vue && typeof vue.defineAsyncComponent === 'function' ? vue.defineAsyncComponent : null;
  let Switch = null;
  try {
    if (defineAsyncComponent && ui && ui.components && ui.components.Switch) {
      Switch = defineAsyncComponent(ui.components.Switch);
    }
  } catch (e) { Switch = null; }

  /** 行布局：label + 可选 hint + control */
  function row(label, hint, control, extraCls) {
    if (!h) return control || null;
    const cls = extraCls || 'sdk-row';
    const children = [];
    children.push(h('span', { class: cls + '-title' }, label));
    if (hint) children.push(h('span', { class: cls + '-hint' }, hint));
    children.push(h('div', { class: cls + '-control' }, [control]));
    return h('div', { class: cls }, children);
  }

  /** 开关行：value 与 setValue 由调用方注入（内部 state 由插件持有） */
  function toggleRow(label, value, setValue, hint, extraCls) {
    const cls = extraCls || 'sdk-row';
    if (!h) return null;
    const el = Switch
      ? h(Switch, {
          modelValue: Boolean(value()),
          'onUpdate:modelValue': (v) => { setValue(Boolean(v)); },
        })
      : h('input', {
          type: 'checkbox',
          checked: Boolean(value()),
          onChange: (e) => { setValue(!!e.target.checked); },
        });
    return row(label, hint, el, cls);
  }

  /** 数字输入行 */
  function numberField(label, getValue, setValue, hint, extraCls, step) {
    if (!h) return null;
    const st = (step === undefined || step === null) ? 1 : step;
    const onChange = (e) => {
      const v = Number(e.target.value);
      if (!Number.isFinite(v)) return;
      setValue(v);
    };
    const el = h('input', {
      type: 'number',
      step: st,
      min: 0,
      value: String(getValue() || 0),
      onInput: onChange,
      onChange: onChange,
      style: 'width:120px;padding:4px 8px;border:1px solid rgba(128,128,128,.4);border-radius:6px;background:transparent;color:inherit;font-size:13px;',
    });
    return row(label, hint, el, extraCls || 'sdk-row');
  }

  return { h, defineComponent, defineAsyncComponent, Switch, row, toggleRow, numberField };
}

// ============================================================================
// [M10] 事件注册器
// 抽取来源：echomusic-resume bindEvents（语义事件）/ echomusic-payskip activate（原始+onError）
// 红线②：不把 onError 当作播放失败的可靠来源；失败事件名由调用方传入。
// defs = { semantic: {'onTrackChange': cb}, raw: [{name, cb}], onError: cb }
// ============================================================================
export function registerEvents(ctx, defs) {
  const d = defs || {};
  const unsubs = [];
  const ev = ctx && ctx.events ? ctx.events : null;
  try {
    if (ev) {
      if (d.semantic) {
        for (const name in d.semantic) {
          if (typeof ev[name] === 'function') {
            try {
              const r = ev[name](d.semantic[name]);
              if (r && typeof r === 'function') unsubs.push(r);
            } catch (e) {}
          }
        }
      }
      if (Array.isArray(d.raw)) {
        for (let i = 0; i < d.raw.length; i++) {
          const item = d.raw[i];
          if (!item || typeof ev.on !== 'function') continue;
          try {
            const r = ev.on(item.name, item.cb);
            if (r && typeof r === 'function') unsubs.push(r);
          } catch (e) {}
        }
      }
      if (typeof d.onError === 'function' && typeof ev.onError === 'function') {
        try {
          const r = ev.onError(d.onError);
          if (r && typeof r === 'function') unsubs.push(r);
        } catch (e) {}
      }
    }
  } catch (e) {}
  return { unsubs };
}

// ============================================================================
// [M11] 生命周期收集器
// 抽取来源：echomusic-resume {unload} / echomusic-timer teardown /
//          echomusic-payskip {unload} / kugou-concept-sign dispose
// runClean() 幂等，可重复安全调用。
// ============================================================================
export function createLifecycle() {
  const timers = new Set();
  const cleanups = [];
  let done = false;
  return {
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      timers.add(id);
      return id;
    },
    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      timers.add(id);
      return id;
    },
    clear(id) {
      if (id === undefined || id === null) return;
      try { clearInterval(id); } catch (e) { try { clearTimeout(id); } catch (e2) {} }
      timers.delete(id);
    },
    onClean(fn) { if (typeof fn === 'function') cleanups.push(fn); },
    runClean() {
      if (done) return;
      done = true;
      const ids = Array.from(timers);
      for (let i = 0; i < ids.length; i++) {
        try { clearInterval(ids[i]); } catch (e) { try { clearTimeout(ids[i]); } catch (e2) {} }
      }
      timers.clear();
      for (let i = cleanups.length - 1; i >= 0; i--) {
        try { cleanups[i](); } catch (e) {}
      }
      cleanups.length = 0;
    },
    hasRuns() { return timers.size > 0 || cleanups.length > 0; },
  };
}

// ============================================================================
// [M12] 网络请求骨架（仅 kugou-concept-sign 引用）
// 抽取来源：kugou-concept-sign http（net.request 桥 + fetch 兜底）
// 红线③：net.request(pluginId, requestId, options, body)；带 body 的 POST 必须走 fetch，
//         否则 20006 err signature。签名/md5/冷却/黑名单等业务策略留在插件私有。
// ============================================================================
export function shouldUseBridge(body) {
  return body === undefined || body === null;
}

/** 网络桥调用：requestId 必为字符串/数字（传对象会抛「网络请求 URL 无效」）。 */
export function netRequest(net, pluginId, requestId, url, method, headers, body) {
  try {
    if (!net || typeof net.request !== 'function') return null;
    const opts = { url, method, headers: headers || {} };
    return net.request(pluginId, String(requestId), opts, body);
  } catch (e) { return null; }
}

/** fetch 兜底（带超时，默认 15s）。返回 fetch 原生响应。 */
export async function httpFetch(url, opts) {
  const o = opts || {};
  const timeout = o.timeout || 15000;
  const body = o.body;
  const controller = window && typeof window.AbortController === 'function' ? new window.AbortController() : null;
  let timer = null;
  if (controller) timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, timeout);
  try {
    const init = {};
    if (o.method) init.method = o.method;
    if (o.headers) init.headers = o.headers;
    if (body !== undefined && body !== null) init.body = body;
    if (controller) init.signal = controller.signal;
    return await fetch(url, init);
  } finally {
    if (timer) { clearTimeout(timer); timer = null; }
  }
}
