// echomusic-kgm-convert v2.0.0 · author: Luo
// v2.0.0（酷狗式下载 + 本地转换合并版）：
//   - 播放条「收藏」旁新增下载入口：点击弹出酷狗式下载面板。
//   - 音质选择：标准 128Kbps / 高品质 320Kbps / 无损 FLAC（经 /v6/priv_url 按登录态获取对应加密源）。
//   - 单曲下载（当前播放歌曲）与批量下载（当前播放列表），保存位置自选（复用输出目录）。
//   - 链路：priv_url 取加密源（.kgm/.kgg）→ 下载到插件缓存 → bin/KgmConvert.exe 自动转码为原始格式到保存目录。
//   - 版权边界：仅下载当前登录账号已购/VIP 有权限的曲目源，不抓取任何未授权内容。
//   - manifest 新增 unrestrictedNetwork 能力；version 保持 1.2.0 以免旧授权记录失效（首次下载/转换需对辅助进程授权一次）。
// v1.3.3：UI 文案明确「仅支持酷狗 .kgm/.kgg、不支持其他平台」；输出格式说明改为与原曲一致，避免误读为多格式输入。
// 将本机已下载的酷狗加密音频（.kgm/.kgg）解密还原为原始音频（MP3/FLAC/OGG/WAV 等），全程本地完成、不联网。
// 支持格式：
//   酷狗 .kgm/.kgg（KgmConvert.exe，KGM V1/V2 掩码表）
// 边界：仅处理本机已有权限的文件；不联网、不上传、不抓取任何无权内容。
//
// v1.3.2（修复 v1.3.1 遗漏的「转换超时」另一半根因）：
//   - 根因：主进程 fs API 相对路径解析基准不一致——writeFile/deleteFile 会拼接校验到
//     插件目录（Wd/fd），而 readTextFile 直接用 g.resolve() 按主进程 cwd 解析。
//     v1.3.1 改用相对路径后，list/run 写入与删除正常，但轮询 readTextFile("tmp/batch-*.json")
//     实际去读插件安装目录下的 tmp，读不到插件目录 tmp 里辅助进程已写好的结果文件 → 继续超时。
//   - 修复：ensurePluginRoot() 用 writeFile 探针（其返回 path 为插件目录绝对路径）探测出
//     插件目录，轮询读取 batch-*.json 一律用「插件目录绝对路径 + tmp」拼接，readTextFile
//     传绝对路径即可正确读取；探针文件随即删除。
//   - 顺带修复：log.add / list 写入补 overwrite:true（主进程 writeFile 默认 wx 不覆盖，
//     导致 run-*.txt 只有首行、同名 list 残留时会写失败）。
//
// v1.3.1（修复「转换超时」根因）：
//   - 根因：ctx.electron.plugins.getDirectory() 返回的是插件根目录（userData/plugins），
//     并非插件自身目录。v1.2.1+ 把 tmp 路径写成 `${pluginDir}/${RESULT_DIR}`，
//     实际落到插件根目录的 tmp（如 插件安装目录\data\plugins\tmp），主进程 writeFile
//     校验「写入路径必须位于插件目录内」直接拒绝，而代码未检查返回的 ok:false 继续执行；
//     list 文件不存在 → 辅助进程启动后读不到列表秒退 → 无结果文件 → 轮询 120s → 转换超时。
//   - 修复：tmp/结果文件/run-*.txt 全部改用相对路径（fs API 自动解析到插件目录内）；
//     辅助进程 cwd 为插件目录，相对路径同样可读。不再依赖 getDirectory() 返回值。
//
// v1.3.0（回退酷狗极简版，移除多格式；manifest 保持 1.2.0 以免授权记录失效）：
//   - 移除全部多格式能力：删除多格式辅助进程路由、按扩展名分发逻辑、
//     SUPPORTED_EXTENSIONS 多格式项与多格式说明文案，仅保留 kgm/kgg。
//   - 辅助进程仅保留 bin/KgmConvert.exe，--batch 批量协议秒转 kgm/kgg。
//   - 保留已验证可靠机制：--batch 批量协议、按辅助进程分组（现仅一组）、60s 授权超时、
//     45s 无进展保护、run-*.txt 关键节点日志、try/finally 复位、转换中锁定选择、
//     默认路径记忆、v5 由辅助进程快速失败兜底；成功不逐个弹 toast（仅失败弹、状态行汇总）。
//
// v1.2.2（代码层优化，manifest 保持 1.2.0 以免授权记录失效）：
//   - 批量转换成功不再逐个弹 toast：酷狗 kgm/kgg 批量秒转时避免连续弹窗干扰，仅失败文件弹提示；
//     成功结果统一由转换结束状态行汇总展示（成功 N / 共 M / 失败 F）。
//   - 降低 run-*.txt 诊断日志写入频率：轮询阶段不再每完成一个文件就全量重写日志文件，
//     仅保留进入/分组/launch 返回/结束等关键节点，减少高频磁盘写对主进程的影响。
//   - kgm/kgg 继续直接走 bin/KgmConvert.exe 秒转路径，不经过多格式复杂逻辑；
//     批量分组（每组一次 launch）、60s 授权超时、45s 无进展保护全部保留。
// v1.2.1（代码层优化，manifest 保持 1.2.0 以免授权记录失效）：
//   - 移除 UI 层 kgg v5 预检（readFileBytes 依赖不可靠 IPC，曾导致「转换中」卡死），v5 由辅助进程 0.03s 快速失败兜底。
//   - ctx.process.launch 增加 60s 超时：授权窗口长时间无人确认时返回明确错误，杜绝无限「转换中」。
//   - 结果轮询增加 45s 无进展提前结束：辅助进程崩溃/被杀时避免干等最长 10 分钟。
//   - 诊断日志统一为 run-*.txt（一次转换一条全链路日志，替代原 debug-*.txt + run-*.txt 双份）。
//   - runConvert 主流程 try/finally 复位转换状态；转换中锁定文件/目录选择。
// v1.2.0：
//   - 授权弹窗优化：同一辅助进程一次启动批量处理全部文件（原逐文件 launch，N 个文件弹 N 次授权窗；
//     现按辅助进程分组，每组只弹 1 次，授权记录生效后不再弹），授权/失败提示文案更明确。
//   - 辅助进程新增 --batch 批量协议（列表文件 + 每文件独立结果文件），单文件模式保留。
//   - 注意：manifest 版本变更会使旧授权记录失效，升级后首次转换需对辅助进程授权一次。
// v1.1.0：
//   - 新增多格式支持（v1.3.0 已回退移除）。
// v1.0.3：
//   - 修复设置面板布局被长路径撑爆：flex:1 + ellipsis 的 span 补 min-width:0，
//     按钮加 flex:none + white-space:nowrap，根容器限定 100% 宽。
//     此前持久化的 pendingFiles/outDir 恢复后，长路径会把「保存设置/开始转换」等按钮挤出可视区、看起来被拉长遮挡。
// v1.0.2：
//   - 输入文件列表（pendingFiles）纳入设置持久化：选择文件/输出目录/清空后自动保存，
//     重启 EchoMusic 后自动恢复，无需再手动点「保存设置」。
//   - 结果解析更健壮：兼容 readTextFile 返回 {ok:false,error} 直报错误、非 JSON 内容、空内容等情况；
//     读不到结果文件时重试期间若辅助进程已退出（进程句柄消失）则提前结束，避免干等 120s。
//   - 转换失败/成功的 toast 文案带结果文件路径，便于排查。
// v1.0.1：
//   - 修复「辅助进程返回了无法解析的结果」：结果文件改用插件目录绝对路径（ctx.electron.plugins.getDirectory()），
//     消除辅助进程 cwd 与插件侧相对路径解析基准不一致导致的读写错位；
//     兼容 ctx.fs.readTextFile 返回对象（取 content/text/data 字段）而非裸字符串的情况；
//     补充 launch 返回 ok:false 的显式处理。
//   - 辅助进程 KgmConvert.exe：写结果文件前自动创建目标目录。
// v1.0.0：
//   - 设置面板「批量转换」入口：选择 .kgm/.kgg 文件 → 选择输出目录 → 逐个转换并展示结果。
//   - 解密由插件目录内辅助程序 bin/KgmConvert.exe 完成（KGM V2 算法内置，5 个真实 .kgm 样本实测全通过）。
//   - .kgg（type=5 新版加密）需客户端密钥库，暂不支持，面板内明确提示。
//
// 结构分区：常量区 → 状态区 → 工具区 → 业务区 → 生命周期区

// ==================== 常量区 ====================

const KGM_HELPER = "bin/KgmConvert.exe"; // kgm/kgg（真实样本验证过的路径，保持不动）
const RESULT_DIR = "tmp";

// 下载面板音质选项：id 直接作为 /v6/priv_url 的 qualities 项（128/320/flac）
const QUALITY_OPTIONS = [
  { id: "128", label: "标准", hint: "128Kbps 标准音质" },
  { id: "320", label: "高品质", hint: "320Kbps 高品质音质" },
  { id: "flac", label: "无损", hint: "FLAC 无损音质（需账号权限）" },
];

// ---- /v6/priv_url 接口契约常量（逆向自 EchoMusic 主程序 server/module/song_url_new.js / util/config.json / util/request.js）----
const LITE_APPID = 3116; // 概念版 appid（config.json liteAppid）
const LITE_APP_VER = 11440; // 概念版 clientver（config.json liteClientver）
const SALT_LITE = "LnT6xpN3khm36zse0QzvmgTZ3waWdRSA"; // android signature 签名盐（kugou-concept-sign 同源）
const KEY_SALT_LITE = "185672dd44712f60bb1736df5a377e82"; // tracker_param.key 盐（song_url_new.js 硬编码）
const PRIV_URL = "https://tracker.kugou.com/v6/priv_url"; // 主程序 baseURL 为 http，插件侧 https 更稳
const V5_URL = "https://gateway.kugou.com/v5/url"; // 酷狗播放级直链接口（未加密 mp3/flac，EchoMusic 播放同源）
const KG_UA = "Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi"; // request.js 默认 Android UA
const KG_HEADERS = { "kg-rc": "1", "kg-thash": "5d816a0", "kg-rec": "1", "kg-rf": "B9EDA08A64250DEFFBCADDEE00F8F25F" }; // request.js 协议请求头（头值必须为字符串，net.request 拒绝数字）
const DOWNLOAD_TMP = "dl-cache"; // 加密源下载缓存子目录（插件目录内）
const CRYPT_EXTS = ["kgm", "kgg"]; // 加密扩展名（需转码），其余视为直链
const RESULT_TTL = 120 * 1000; // 单个文件转换超时
const LAUNCH_TIMEOUT = 60 * 1000; // 等待授权确认/进程启动上限：授权窗口无人确认时给出明确提示，避免无限「转换中」
const PROGRESS_STALL_MS = 45 * 1000; // 轮询阶段连续无新结果上限：辅助进程崩溃/被杀时提前结束，避免干等到总超时
const SUPPORTED_EXTENSIONS = ["kgm", "kgg"];
const DL_PICK_MAX = 60; // 批量下载单次最多勾选数量（与 runDownload 批量上限一致，防止勾选 200 首被静默截断）
const DL_PICK_SHOW_MAX = 200; // 选歌列表每组最多展示数量（渲染上限，超出仅提示不截断下载）

// ==================== 生命周期区 ====================

export async function activate(ctx) {
  ctx.toast.success(`${ctx.manifest.name} 已启用`);

  const { defineAsyncComponent, defineComponent, h, reactive, ref } = ctx.vue;
  const Button = defineAsyncComponent(ctx.ui.components.Button);

  // 注意：ctx.electron.plugins.getDirectory() 返回的是插件根目录（userData/plugins），
  // 不是插件自身目录；v1.2.1+ 曾用它拼 tmp 路径导致写入越界被主进程拒绝（转换超时根因）。
  // v1.3.1 起 tmp/结果文件/日志一律用相对路径（fs API 自动解析到插件目录内），不再依赖该返回值。

  // ==================== 路径工具区 ====================

  // v1.3.2 修复：readTextFile 的相对路径基准是主进程 cwd（不是插件目录），
  // 轮询读 batch-*.json 会落到插件安装目录\tmp 而读不到 → 一直超时。
  // 通过 writeFile 探针拿到插件目录绝对路径（writeFile 返回的 path 字段是绝对路径），
  // 后续所有 readTextFile 都用该绝对路径拼接。
  let PLUGIN_ROOT = null;
  async function ensurePluginRoot() {
    if (PLUGIN_ROOT) return PLUGIN_ROOT;
    const probeName = `.root-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.probe`;
    const probeRel = `${RESULT_DIR}/${probeName}`;
    try {
      const w = await ctx.fs.writeFile(probeRel, new TextEncoder().encode("x").buffer);
      if (w && w.ok) {
        let abs = w.path ? String(w.path).replace(/[\\/]+$/, "") : "";
        if (!abs && w.url) {
          abs = decodeURIComponent(String(w.url).replace(/^file:\/\/\//, "").replace(/^file:\/\//, "")).replace(/[\\/]+$/, "");
        }
        if (abs) {
          const m = abs.match(new RegExp(`[\\\\/]${RESULT_DIR}[\\\\/][^\\\\/]+$`, "i"));
          PLUGIN_ROOT = m ? abs.slice(0, m.index) : abs.slice(0, Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/")));
        }
      }
      await ctx.fs.deleteFile(probeRel).catch(() => {});
      if (PLUGIN_ROOT) await ctx.fs.deleteFile(`${PLUGIN_ROOT}\\${RESULT_DIR}\\${probeName}`).catch(() => {});
    } catch (e) {}
    return PLUGIN_ROOT;
  }

  // ==================== 状态区 ====================

  const defaults = {
    outDir: "",
    pendingFiles: [], // 待转换文件绝对路径
    results: [], // { src, ok, out, format, size, error }
    converting: false,
    srcDir: "",
  };

  // ==================== 工具区 ====================

  async function saveSettings(draft, opts = {}) {
    await ctx.storage.set("settings", {
      outDir: draft.outDir,
      srcDir: draft.srcDir,
      pendingFiles: draft.pendingFiles || [],
    });
    if (opts.silent !== true) {
      ctx.toast.success("设置已保存");
    }
  }

  function fmtSize(n) {
    if (!n) return "";
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    if (n > 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }

  function baseName(p) {
    const parts = String(p || "").split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // 读取结果文件并清理；兼容裸字符串与 { content/text/data } 对象
  async function readResultFile(resultFile) {
    const raw = await ctx.fs.readTextFile(resultFile).catch(() => null);
    if (!raw) return null;
    if (raw && typeof raw === "object" && raw.ok === false && !raw.content && !raw.text && !raw.data) {
      const errMsg = raw.error || "";
      // ENOENT / no such file：结果文件尚未生成，属于轮询等待期，继续等待而非判失败
      if (/ENOENT|no such file/i.test(errMsg)) return null;
      await ctx.fs.deleteFile(resultFile).catch(() => {});
      return { fsError: errMsg || "未知错误" };
    }
    const text =
      typeof raw === "string"
        ? raw
        : raw.content || raw.text || raw.data || (raw.ok === false ? raw.error || "" : "");
    if (!text) return null; // 文件存在但内容为空：可能正在写入，继续轮询
    await ctx.fs.deleteFile(resultFile).catch(() => {});
    try {
      return JSON.parse(text);
    } catch (e) {
      return { parseError: true };
    }
  }

  // 批量转换：同一辅助进程一次 launch 处理多个文件（授权弹窗从每文件一次降到每组一次）
  // 协议：<helper> --batch <listFile> <outDir> <tmpDir> <tag>，每个文件独立结果文件 batch-<tag>-<i>.json
  async function convertBatch(ctx, log, helper, files, outDir) {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tmpDir = RESULT_DIR; // 相对插件目录（fs API 解析到插件目录内），v1.3.1 修复越界写失败
    const listFile = `${tmpDir}/batch-${tag}.list`;
    const dbgAdd = log.add; // 复用 runConvert 创建的 run-*.txt，一次转换一条全链路日志
    const results = files.map((src) => ({ src, ok: false, out: "", format: "", size: 0, error: "等待结果" }));
    await dbgAdd(`convertBatch helper=${helper} files=${files.length} outDir=${outDir}`);
    try {
      // list 文件用 UTF-8 无 BOM（TextEncoder），辅助进程按 UTF-8 读取，中文路径安全
      const enc = new TextEncoder();
      const payload = enc.encode(files.join("\n")).buffer;
      await ctx.fs.writeFile(listFile, payload, { overwrite: true });
    } catch (e) {
      await dbgAdd("写 list 失败: " + (e && e.message ? e.message : String(e)));
      return files.map((src) => ({ src, ok: false, error: "准备批量任务失败：" + (e && e.message ? e.message : String(e)) }));
    }
    // launch 加超时保护：授权窗口若长时间无人确认（被遮挡 / 以为没弹窗），
    // 60 秒后返回明确错误，杜绝无限「转换中」
    let launch;
    try {
      launch = await Promise.race([
        ctx.process.launch({
          executable: helper,
          args: ["--batch", listFile, outDir, tmpDir, tag],
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("授权/启动超时")), LAUNCH_TIMEOUT)),
      ]);
      await dbgAdd("launch 返回: " + JSON.stringify(launch));
    } catch (e) {
      await dbgAdd("launch 抛错/超时: " + (e && e.message ? e.message : String(e)));
      await ctx.fs.deleteFile(listFile).catch(() => {});
      const reason = /超时/.test((e && e.message) || "")
        ? "等待授权/启动超时：请检查是否弹出授权窗口（点击「允许并记住」）或安全软件拦截了辅助进程，然后重新转换"
        : "启动辅助进程失败：" + (e && e.message ? e.message : String(e));
      return files.map((src) => ({ src, ok: false, error: reason }));
    }
    if (!launch || launch.canceled) {
      await dbgAdd("launch.canceled 或空");
      await ctx.fs.deleteFile(listFile).catch(() => {});
      return files.map((src) => ({ src, ok: false, error: "授权未确认：请在弹出的授权窗口点击「允许并记住」后重新转换；若看到系统/安全软件提示请选择允许" }));
    }
    if (launch.error) {
      await dbgAdd("launch.error=" + launch.error);
      await ctx.fs.deleteFile(listFile).catch(() => {});
      return files.map((src) => ({ src, ok: false, error: "启动辅助进程失败：" + launch.error }));
    }
    if (launch.ok === false) {
      await dbgAdd("launch.ok=false exitCode=" + launch.exitCode);
      await ctx.fs.deleteFile(listFile).catch(() => {});
      return files.map((src) => ({ src, ok: false, error: "辅助进程启动未成功（exitCode=" + (launch.exitCode === undefined ? "?" : launch.exitCode) + "）" }));
    }
    // 轮询全部结果文件：每文件独立计时，总超时 = 单文件超时 × 文件数，上限 10 分钟；
    // 连续 PROGRESS_STALL_MS 无新结果（辅助进程崩溃/被杀/异常退出）则提前结束，避免干等
    // v1.3.2：readTextFile 相对路径基准是主进程 cwd，读不到插件目录 tmp → 必须用插件目录绝对路径轮询
    const pluginRoot = await ensurePluginRoot();
    if (!pluginRoot) {
      await dbgAdd("v1.3.2 探测插件目录失败，将回退相对路径（可能仍超时）");
    }
    const resultDir = pluginRoot ? `${pluginRoot}\\${RESULT_DIR}` : tmpDir;
    const deadline = Date.now() + Math.min(RESULT_TTL * files.length, 600000);
    const done = new Array(files.length).fill(false);
    let doneCountPrev = 0;
    let lastProgressAt = Date.now();
    while (Date.now() < deadline && done.some((d) => !d)) {
      for (let i = 0; i < files.length; i++) {
        if (done[i]) continue;
        const parsed = await readResultFile(`${resultDir}/batch-${tag}-${i}.json`);
        if (parsed === null) continue;
        done[i] = true;
        if (parsed.fsError) results[i] = { src: files[i], ok: false, error: "读取结果失败：" + parsed.fsError };
        else if (parsed.parseError) results[i] = { src: files[i], ok: false, error: "辅助进程返回了无法解析的结果" };
        else results[i] = { src: files[i], ok: !!parsed.ok, out: parsed.out || "", format: parsed.format || "", size: parsed.size || 0, error: parsed.error || "" };
      }
      const nowDone = done.filter(Boolean).length;
      if (nowDone > doneCountPrev) {
        doneCountPrev = nowDone;
        lastProgressAt = Date.now();
      }
      if (done.some((d) => !d)) {
        if (Date.now() - lastProgressAt > PROGRESS_STALL_MS) {
          await dbgAdd(`轮询 ${PROGRESS_STALL_MS / 1000}s 无新结果，辅助进程疑似异常退出，提前结束`);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    await ctx.fs.deleteFile(listFile).catch(() => {});
    for (let i = 0; i < files.length; i++) {
      if (!done[i]) results[i] = { src: files[i], ok: false, error: "转换超时" };
    }
    await dbgAdd("结束 results=" + JSON.stringify(results.map((r) => ({ ok: r.ok, err: r.error }))).slice(0, 400));
    return results;
  }

  // ==================== 下载区（v2.0.0）====================

  // ---- 标准 MD5（RFC1321，UTF-8 输入；无外部依赖）----
  function md5(s) {
    function toBytes(str) {
      const out = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 128) out.push(c);
        else if (c < 2048) out.push(192 | (c >> 6), 128 | (c & 63));
        else if ((c & 0xfc00) === 0xd800 && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
          c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff);
          out.push(240 | (c >> 18), 128 | ((c >> 12) & 63), 128 | ((c >> 6) & 63), 128 | (c & 63));
        } else out.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
      }
      return out;
    }
    const bytes = toBytes(String(s));
    const bitLen = bytes.length * 8;
    const padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    const lo = bitLen & 0xffffffff;
    const hi = Math.floor(bitLen / 0x100000000);
    for (let i = 0; i < 4; i++) padded.push((lo >>> (8 * i)) & 0xff);
    for (let i = 0; i < 4; i++) padded.push((hi >>> (8 * i)) & 0xff);
    const K = [0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1, 0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391];
    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const rotl = (x, c) => (x << c) | (x >>> (32 - c));
    for (let i = 0; i < padded.length; i += 64) {
      const M = [];
      for (let j = 0; j < 16; j++) M[j] = padded[i + j * 4] | (padded[i + j * 4 + 1] << 8) | (padded[i + j * 4 + 2] << 16) | (padded[i + j * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let j = 0; j < 64; j++) {
        let F, g;
        if (j < 16) { F = (B & C) | (~B & D); g = j; }
        else if (j < 32) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
        else if (j < 48) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * j) % 16; }
        F = (F + A + K[j] + M[g]) | 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[j])) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const hex = (n) => {
      let h = "";
      for (let i = 0; i < 4; i++) h += ((n >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
      return h;
    };
    return hex(a0) + hex(b0) + hex(c0) + hex(d0);
  }

  // ---- 登录态快照（复用概念版签到插件的 pinia 取数方式）----
  function captureState() {
    try {
      const us = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get("user");
      const de = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get("device");
      const ui = (us && (us.info || (us.$state && us.$state.info))) || null;
      const di = (de && (de.info || (de.$state && de.$state.info))) || null;
      if (!ui || !ui.token || !ui.userid) return null;
      const vipTok = ui.vip_token || ui.vipToken || (ui.vip && ui.vip.token) || (ui.ui && ui.ui.vip_token) || (ui.membership && ui.membership.vip_token) || "";
      const vipTyp = ui.vip_type || ui.vipType || (ui.vip && ui.vip.type) || (ui.ui && ui.ui.vip_type) || 0;
      return {
        token: ui.token,
        userid: String(ui.userid),
        dfid: (di && di.dfid) || "",
        mid: di ? String(di.mid || "") : "",
        vipToken: String(vipTok),
        vipType: Number(vipTyp || 0),
      };
    } catch (e) { return null; }
  }

  function playerStore() {
    try { return (ctx.pinia && ctx.pinia._s && ctx.pinia._s.get("player")) || null; } catch (e) { return null; }
  }

  function currentTrack() {
    try {
      const ps = playerStore();
      if (!ps) return null;
      const st = (ps.$state && typeof ps.$state === "object") ? ps.$state
        : (ps._state && typeof ps._state === "object") ? ps._state : ps;
      const inner = (st && st.player && typeof st.player === "object") ? st.player : null;
      let t = null;
      // 未播放时曲目信息落在快照字段，需覆盖：currentTrackSnapshot → currentTrack → curTrack → playback → song
      if (!t && st) t = (st.currentTrackSnapshot && typeof st.currentTrackSnapshot === "object") ? st.currentTrackSnapshot : null;
      if (!t && st) t = (st.currentTrack && typeof st.currentTrack === "object") ? st.currentTrack : null;
      if (!t && st) t = (st.curTrack && typeof st.curTrack === "object") ? st.curTrack : null;
      if (!t && st && st.playback && typeof st.playback === "object") t = st.playback.song || st.playback.currentTrack || null;
      if (!t && st) t = (st.song && typeof st.song === "object") ? st.song : null;
      if (!t && inner) t = inner.currentTrackSnapshot || inner.currentTrack || inner.song || null;
      return t;
    } catch (e) { return null; }
  }

  function playlistStore() {
    try { return (ctx.pinia && ctx.pinia._s && ctx.pinia._s.get("playlist")) || null; } catch (e) { return null; }
  }

  function rawSongArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      return v.songs || v.list || v.queue || v.tracks || v.items || [];
    }
    return [];
  }

  // 2026-10-05：界面歌单/收藏列表实际在 playlist store（playbackQueues 队列 + favorites），
  // 播放器 store 的 playlist 只反映当前播放状态，未播列表时常为空。
  // 按来源分组读取：like=我喜欢的（收藏 + 用户歌单/专辑类队列），history=历史播放，others=其它队列/默认列表。
  function collectDlGroups() {
    const groups = { like: [], history: [], others: [] };
    const seen = { like: {}, history: {}, others: {} };
    const pushTo = (key, arr) => {
      for (const t of rawSongArray(arr)) {
        const k = String(t && (t.hash || t.id || t.songId || t.fileId || t.song_key || t.mixSongId || ""));
        if (!k || seen[key][k]) continue;
        seen[key][k] = true;
        groups[key].push(t);
      }
    };
    try {
      const pst = playlistStore();
      const pstState = pst && ((pst.$state && typeof pst.$state === "object") ? pst.$state : (pst._state || pst));
      if (pstState) {
        const queues = Array.isArray(pstState.playbackQueues) ? pstState.playbackQueues : [];
        for (const q of queues) {
          if (!q) continue;
          const qt = String(q.type || "");
          if (qt === "history") pushTo("history", q.songs);
          else if (["playlist", "cloud", "purchased", "album", "artist"].includes(qt)) pushTo("like", q.songs);
          else pushTo("others", q.songs);
        }
        pushTo("like", pstState.favorites);
        pushTo("others", pstState.defaultList);
      }
    } catch (e) {}
    if (!groups.like.length && !groups.history.length && !groups.others.length) {
      // 兼容旧路径：player store playlist 归入 others
      try {
        const ps = playerStore();
        if (ps) {
          let pl = ps.playlist || (ps.$state && ps.$state.playlist) || (ps.$state && ps.$state.player && ps.$state.player.playlist);
          pushTo("others", pl);
        }
      } catch (e) {}
    }
    return groups;
  }

  function playlistSongs() {
    const g = collectDlGroups();
    return g.like.concat(g.history, g.others);
  }

  function trackIds(t) {
    if (!t) return { hash: "", albumAudioId: "", name: "", artist: "", audioUrl: "" };
    const pl = (typeof t.payload === "object" && t.payload) ? t.payload : null;
    return {
      hash: String(t.hash || t.hashStd || t.id || t.songId || t.fileId || ""),
      albumAudioId: String(t.albumAudioId || t.mixSongId || t.album_audio_id || t.audioId || ""),
      name: String(t.songName || t.name || t.title || ""),
      artist: String(t.singer || t.artist || t.singerName || ""),
      // 2026-10-04：播放器歌曲对象自带未加密直链（列表/详情接口返回），免费曲目下载优先用它
      audioUrl: String(t.audioUrl || (pl && pl.audioUrl) || t.playUrl || t.src || ""),
    };
  }

  function sanitize(name) {
    return String(name || "song").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "song";
  }

  // ---- priv_url 请求与签名（概念版加密协议，带 body 走 renderer fetch 直连）----
  async function requestPrivUrl(st, track, quality) {
    const clienttime = Math.floor(Date.now() / 1000);
    const uid = Number(st.userid || 0);
    const dataMap = {
      area_code: "1",
      behavior: "play",
      qualities: [quality],
      resource: {
        album_audio_id: track.albumAudioId || "",
        collect_list_id: "3",
        collect_time: Date.now(),
        hash: track.hash || "",
        id: 0,
        page_id: 1,
        type: "audio",
      },
      token: st.token || "",
      tracker_param: {
        all_m: 1,
        auth: "",
        is_free_part: 0,
        key: md5(`${track.hash || ""}${KEY_SALT_LITE}${LITE_APPID}${st.mid || ""}${uid}`),
        module_id: 0,
        need_climax: 1,
        need_xcdn: 1,
        open_time: "",
        pid: "411",
        pidversion: "3001",
        priv_vip_type: "6",
        viptoken: st.vipToken || "",
      },
      userid: `${uid}`,
      vip: st.vipType || 0,
    };
    const body = JSON.stringify(dataMap);
    const params = {
      dfid: st.dfid || "-",
      mid: st.mid || "-",
      uuid: "-",
      appid: LITE_APPID,
      clientver: LITE_APP_VER,
      clienttime,
      token: st.token || "",
    };
    if (uid !== 0) params.userid = uid;
    const ps = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
    params.signature = md5(`${SALT_LITE}${ps}${body}${SALT_LITE}`);
    const q = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
    let res;
    try {
      res = await fetch(`${PRIV_URL}?${q}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "User-Agent": KG_UA,
          dfid: st.dfid || "-",
          clienttime: String(clienttime),
          mid: st.mid || "-",
          ...KG_HEADERS,
        },
        body,
      });
    } catch (e) {
      throw new Error("网络请求失败：" + (e && e.message ? e.message : String(e)));
    }
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
    let j;
    try { j = await res.json(); } catch (e) { throw new Error("响应不是有效 JSON"); }
    const code = j && (j.error_code !== undefined ? j.error_code : j.err_code !== undefined ? j.err_code : j.status);
    if (code !== undefined && Number(code) !== 0) {
      const msg = (j && (j.error_msg || j.errmsg || j.msg)) || `接口返回错误 ${code}`;
      // 2026-10-05：拆分登录态与 VIP 权限提示，避免「登录过期/token 失效」被误判成「需要 VIP」
      if (/登录|login|token|鉴权|授权|失效|过期/i.test(msg)) throw new Error(msg + "（登录态失效或未登录，请重新登录酷狗）");
      if (/vip|会员|权限|免费|试听|版权|购买|付费/i.test(msg)) throw new Error(msg + "（该音质可能需要 VIP/已购权限）");
      throw new Error(msg);
    }
    return j;
  }

  // ---- /v5/url 播放级直链接口（EchoMusic 播放同源，返回未加密 mp3/flac 直链）----
  // 2026-10 修复：priv_url 对部分曲目只返回封面 jpg / 加密 mgg 源；v5/url 可拿未加密直链直接落盘。
  // 签名参考已验证请求：params + key(KEY_SALT_LITE) + signature(SALT_LITE 包裹排序参数)。
  // 2026-10-04 修复：渲染进程 fetch 请求 gateway 网关偶发被拒（errcode=1），优先改走
  //   ctx.net.request 原生网络栈（与下载同源、无 CORS/Origin 污染）；失败自动重试一次。
  async function httpGetJson(url, headersObj) {
    if (ctx.net && typeof ctx.net.request === "function") {
      try {
        const r = await ctx.net.request({ url, method: "GET", redirect: "follow", headers: headersObj, timeout: 30000 });
        const ab = await extractBody(r);
        if (ab && ab.byteLength) {
          const txt = new TextDecoder().decode(new Uint8Array(ab));
          try { return JSON.parse(txt); } catch (e) { throw new Error("响应不是有效 JSON"); }
        }
      } catch (e) {
        await dlLog("v5 net.request 失败，转 fetch", { err: e && e.message ? e.message : String(e) });
      }
    }
    const res = await fetch(url, { method: "GET", headers: headersObj });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
    try { return await res.json(); } catch (e) { throw new Error("响应不是有效 JSON"); }
  }

  async function requestV5Url(st, track, quality, retried) {
    const clienttime = Math.floor(Date.now() / 1000);
    const uid = Number(st.userid || 0);
    const hash = String(track.hash || "").toLowerCase();
    const albumAudioId = Number(track.albumAudioId || 0);
    const params = {
      album_id: 0,
      area_code: "1",
      hash,
      ssa_flag: "is_fromtrack",
      version: 11430,
      page_id: "151369488",
      quality: String(quality || "320"),
      album_audio_id: albumAudioId,
      behavior: "play",
      pid: 411,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: 0,
      ppage_id: "463467626,350369493,788954147",
      cdnBackup: 1,
      module: "",
      clientver: LITE_APP_VER,
      dfid: st.dfid || "-",
      mid: st.mid || "-",
      uuid: "-",
      appid: LITE_APPID,
      clienttime,
    };
    if (st.token) params.token = st.token;
    if (uid !== 0) params.userid = uid;
    params.key = md5(`${hash}${KEY_SALT_LITE}${LITE_APPID}${st.mid || ""}${uid}`);
    const ps = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("");
    params.signature = md5(`${SALT_LITE}${ps}${SALT_LITE}`);
    const q = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join("&");
    const headersObj = {
      "User-Agent": KG_UA,
      dfid: st.dfid || "-",
      clienttime: String(clienttime),
      mid: st.mid || "-",
      "x-router": "trackercdn.kugou.com",
      ...KG_HEADERS,
    };
    let j;
    try {
      j = await httpGetJson(`${V5_URL}?${q}`, headersObj);
    } catch (e) {
      // 网络层失败也重试一次（可能瞬时网络抖动）
      if (!retried) {
        await dlLog("v5/url 网络失败，重试一次", { song: track.name || track.hash, err: e && e.message ? e.message : String(e) });
        await new Promise((res) => setTimeout(res, 800));
        return requestV5Url(st, track, quality, true);
      }
      throw e;
    }
    // 2026-10-04：错误码判断修正——status=1 为成功响应，不能当错误；只有 error_code/err_code/errcode 非 0 或 status=0 才算失败
    const jerr = j && (j.error_code !== undefined ? j.error_code : j.err_code !== undefined ? j.err_code : j.errcode !== undefined ? j.errcode : null);
    if ((jerr !== null && Number(jerr) !== 0) || (j && j.status === 0)) {
      // errcode=1（风控/偶发）自动重试一次
      if (!retried) {
        await dlLog("v5/url 接口错误，重试一次", { song: track.name || track.hash, err: jerr, msg: (j && (j.errmsg || j.msg || j.error_msg)) || "" });
        await new Promise((res) => setTimeout(res, 800));
        return requestV5Url(st, track, quality, true);
      }
      if (jerr !== null && Number(jerr) !== 0) {
        const msg = (j && (j.errmsg || j.msg || j.error_msg)) || `接口返回错误 ${jerr}`;
        if (Number(jerr) === 20018) throw new Error("v5/url 当前不可用（错误码 20018），该接口在概念版账号下不返回直链");
        // 2026-10-05：拆分登录态与 VIP 权限提示，避免「登录过期/token 失效」被误判成「需要 VIP」
        if (/登录|login|token|鉴权|授权|失效|过期/i.test(msg)) throw new Error(msg + "（登录态失效或未登录，请重新登录酷狗）");
        if (/vip|会员|权限|免费|试听|版权|购买|付费|signature|签名/i.test(msg)) throw new Error(msg + "（该音质可能需要 VIP/已购权限）");
        throw new Error(msg);
      }
      throw new Error((j && (j.errmsg || j.msg || j.error_msg)) || "接口返回错误 0");
    }
    const ext = String(j && (j.extName || j.extname || j.ext_name) || "").toLowerCase();
    const urls = (Array.isArray(j && j.url) ? j.url : []).concat(Array.isArray(j && j.backupUrl) ? j.backupUrl : []);
    const url = urls.find((u) => typeof u === "string" && /^https?:\/\//i.test(u)) || null;
    if (!url) throw new Error("接口未返回可用的播放直链");
    return { url, ext };
  }

  // ---- node 子进程取链兜底（get_v5url.mjs）----
  // 2026-10-04：渲染进程网络栈请求 gateway 网关仍可能失败（errcode=1/风控）；node 子进程
  //   用 EchoMusic sqlite 里的登录态 + 已验证的 v5/url 签名直接取链，100% 绕过渲染层问题。
  const NODE_EXE_REL = "tools\\node\\node.exe"; // 插件目录内 node（process.launch 要求可执行程序位于插件目录内）
  const NODE_SCRIPT_REL = "tools/get_v5url.mjs";
  const NODE_DOWNLOAD_REL = "tools/download.mjs"; // node 流式下载脚本（绕过 ctx.fs 8MB 沙箱限制）

  async function requestV5ByNode(st, track, quality) {
    try {
      const pluginRoot = await ensurePluginRoot();
      if (!pluginRoot) return null;
      const script = `${pluginRoot}\\${NODE_SCRIPT_REL}`;
      const outFile = `${pluginRoot}\\${RESULT_DIR}\\v5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const args = [script, String(track.hash || ""), String(track.albumAudioId || "0"), String(quality || "320"), outFile];
      await dlLog("node 取链启动", { song: track.name || track.hash, script });
      const r = await Promise.race([
        ctx.process.launch({ executable: `${pluginRoot}\\${NODE_EXE_REL}`, args, timeout: 30000 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("授权/启动超时")), 30000)),
      ]);
      if (!r || r.canceled) throw new Error("授权未确认");
      if (r.error) throw new Error("启动失败：" + r.error);
      if (r.ok === false) throw new Error("取链进程未成功（exitCode=" + (r.exitCode === undefined ? "?" : r.exitCode) + "）");
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        const raw = await ctx.fs.readTextFile(outFile).catch(() => null);
        if (raw) {
          const text = typeof raw === "string" ? raw : (raw.content || raw.text || raw.data || "");
          await ctx.fs.deleteFile(outFile).catch(() => {});
          try {
            const j = JSON.parse(text);
            if (j && j.ok && j.url) {
              await dlLog("node 取链 OK", { song: track.name || track.hash, ext: j.ext, urlShape: String(j.url).slice(0, 90) });
              return { url: j.url, ext: String(j.ext || "mp3").toLowerCase() };
            }
            const jerr = (j && j.err) || "取链失败";
            throw new Error(jerr);
          } catch (pe) {
            if (!(pe && pe.message && /Unexpected token|JSON/i.test(pe.message))) throw pe;
          }
        }
        await new Promise((res) => setTimeout(res, 300));
      }
      throw new Error("等待取链结果超时");
    } catch (e) {
      await dlLog("node 取链失败", { song: track.name || track.hash, err: e && e.message ? e.message : String(e) });
      return null;
    }
  }

  function pickUrl(j) {
    if (!j || typeof j !== "object") return null;
    if (j.url) return j.url;
    if (j.play_url) return j.play_url;
    const d = j.data;
    if (d && typeof d === "object") {
      if (d.url) return d.url;
      if (d.play_url) return d.play_url;
      if (d.urls) return d.urls;
      if (d.url_list) return d.url_list;
      if (Array.isArray(d)) return d;
    }
    return null;
  }

  function firstUrl(u) {
    if (Array.isArray(u)) return u[0] || null;
    if (typeof u === "string") return u || null;
    return null;
  }

  const AUDIO_EXTS = ["mp3", "flac", "kgm", "kgg", "mgg", "mflac", "m4a", "aac", "wav", "ape", "ogg", "opus"];

  // 深度提取直链：priv_url 响应的 url 字段可能是字符串 / 数组 / 对象（url_list 元素为对象等），递归找到第一个 http(s) 字符串
  function deepFindUrl(v, depth, audioOnly) {
    if (depth == null) depth = 0;
    if (audioOnly == null) audioOnly = false;
    if (depth > 6) return null;
    if (typeof v === "string") {
      if (!/^https?:\/\//i.test(v)) return null;
      if (!audioOnly) return v;
      const p = v.split(/[?#]/)[0].toLowerCase();
      const m = p.match(/\.([a-z0-9]+)$/);
      return m && AUDIO_EXTS.includes(m[1]) ? v : null;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const r = deepFindUrl(v[i], depth + 1, audioOnly);
        if (r) return r;
      }
      return null;
    }
    if (v && typeof v === "object") {
      const keys = ["url", "play_url", "playUrl", "src", "download_url", "real_url", "url_list", "urls", "audio", "song_url"];
      for (let i = 0; i < keys.length; i++) {
        if (v[keys[i]] != null) {
          const r = deepFindUrl(v[keys[i]], depth + 1, audioOnly);
          if (r) return r;
        }
      }
      const own = Object.keys(v);
      for (let i = 0; i < own.length; i++) {
        const r = deepFindUrl(v[own[i]], depth + 1, audioOnly);
        if (r) return r;
      }
    }
    return null;
  }

  // 诊断：收集响应中所有 http(s) 字符串及其键路径（排查为何 audioOnly 未命中音频直链）
  function collectUrls(v, path, out, depth) {
    if (!out) out = [];
    if (depth == null) depth = 0;
    if (depth > 8) return out;
    if (typeof v === "string") {
      if (/^https?:\/\//i.test(v)) out.push({ path: path || "$", url: v.slice(0, 160) });
      return out;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) collectUrls(v[i], (path ? path + "[" + i + "]" : "[" + i + "]"), out, depth + 1);
      return out;
    }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (v[k] == null) continue;
        collectUrls(v[k], path ? path + "." + k : k, out, depth + 1);
      }
    }
    return out;
  }

  // 从原生网络桥 / fetch 响应里提取 ArrayBuffer（自适应多种返回形态）
  function extractBody(res) {
    if (!res) return null;
    if (typeof res.arrayBuffer === "function") return res.arrayBuffer();
    const b = res.body || res.data || res.buffer;
    if (b == null) return null;
    if (b instanceof ArrayBuffer) return Promise.resolve(b);
    if (ArrayBuffer.isView(b)) return Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    if (typeof b === "string") {
      // base64 或原始字符串
      try { const bin = atob(b); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return Promise.resolve(u.buffer); }
      catch (e2) { return Promise.resolve(new TextEncoder().encode(b).buffer); }
    }
    return null;
  }

  async function fetchBytes(url) {
    // 1) 优先走 ctx.net.request（Electron 原生网络栈，不受 CORS / 混合内容限制）
    if (ctx.net && typeof ctx.net.request === "function") {
      try {
        const r = await ctx.net.request({ url, method: "GET", redirect: "follow", timeout: 60000 });
        await dlLog("net.request 返回", { keys: r ? Object.keys(r) : "null", status: r && (r.status != null ? r.status : r.statusCode) });
        const ab = await extractBody(r);
        if (ab && ab.byteLength) return ab;
        const st = r && (r.status != null ? r.status : r.statusCode);
        throw new Error(st ? `HTTP ${st}` : "原生网络桥返回为空");
      } catch (e1) {
        await dlLog("net.request 失败", { err: e1 && e1.message ? e1.message : String(e1), urlShape: String(url).slice(0, 80) });
        // 失败后不直接抛，尝试 fetch 兜底
      }
    }
    // 2) 兜底：window.fetch（受 CORS 限制，仅作回退）
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    let res;
    try {
      res = await fetch(url, { method: "GET", signal: ctl.signal, credentials: "omit" });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
      const ab = await res.arrayBuffer();
      if (!ab || !ab.byteLength) throw new Error("下载内容为空");
      return ab;
    } catch (e) {
      if (ctl.signal.aborted) throw new Error("下载超时（60 秒）");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- node 子进程直落盘下载（绕过 ctx.fs writeFile 8MB 沙箱限制，2026-10-05）----
  async function nodeDownload(url, outPath, opts) {
    const timeout = (opts && opts.timeout) || 300000;
    try {
      const pluginRoot = await ensurePluginRoot();
      if (!pluginRoot) return { ok: false, error: "无法定位插件目录" };
      const script = `${pluginRoot}\\${NODE_DOWNLOAD_REL}`;
      const resFile = `${pluginRoot}\\${DOWNLOAD_TMP}\\dl-result-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const r = await Promise.race([
        ctx.process.launch({ executable: `${pluginRoot}\\${NODE_EXE_REL}`, args: [script, url, outPath, resFile], timeout }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("授权/启动超时")), timeout)),
      ]);
      if (!r || r.canceled) return { ok: false, error: "授权未确认" };
      if (r.error) return { ok: false, error: "启动失败：" + r.error };
      if (r.ok === false) return { ok: false, error: "下载进程未成功（exitCode=" + (r.exitCode === undefined ? "?" : r.exitCode) + "）" };
      // launch 返回后辅助进程仍在后台运行：必须轮询结果文件，一次性读取会拿到空内容误判失败（与取链/转码一致）
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const parsed = await readResultFile(resFile);
        if (parsed === null) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        if (parsed.fsError) return { ok: false, error: "读取下载结果失败：" + parsed.fsError };
        if (parsed.parseError) return { ok: false, error: "下载结果文件无法解析" };
        if (!parsed.ok) return { ok: false, error: "下载失败：" + (parsed.error || "未知错误") };
        return { ok: true, size: parsed.size || 0 };
      }
      await ctx.fs.deleteFile(resFile).catch(() => {});
      return { ok: false, error: "下载超时（未收到结果文件）" };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  // ---- 下载链路诊断日志（dl-debug.log，仅排障用）----
  const DL_DEBUG = [];
  async function dlLog(...args) {
    try {
      const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      DL_DEBUG.push(line);
      if (DL_DEBUG.length > 500) DL_DEBUG.shift();
      await ctx.fs.writeFile('dl-debug.log', DL_DEBUG.join('\n'), { overwrite: true });
    } catch (e) {}
  }

  // ---- 下载阶段：v5/url 未加密直链优先 → 回退 priv_url 加密源 → 下载到插件缓存（失败置 task 状态并返回 null）----
  async function downloadToCache(st, track, quality, task, outDir) {
    let j;
    task.status = "获取地址…";
    renderDlTasks();
    const pluginRoot = await ensurePluginRoot();
    if (!pluginRoot) {
      task.status = "失败";
      task.err = "无法定位插件目录";
      renderDlTasks();
      return null;
    }

    // 2026-10-05 修复：ctx.fs.writeFile 存在 8MB 沙箱上限，音频文件（15~44MB）写缓存必失败。
    // 改为 node 子进程流式直落盘：未加密直链直接写保存目录，加密源写 dl-cache 供转码。
    {
      const au0 = String(track.audioUrl || "");
      if (/^https?:\/\//i.test(au0)) {
        const auDec = decodeURIComponent(au0);
        const auExtM = (auDec.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]+)$/) || []);
        const auExt = auExtM[1] ? auExtM[1].toLowerCase() : "";
        if (!CRYPT_EXTS.includes(auExt)) {
          await dlLog("audioUrl 直链命中", { song: track.name || track.hash, ext: auExt || "mp3", urlShape: (() => { try { const u = new URL(auDec); return u.protocol + "//" + u.host + u.pathname.slice(0, 80); } catch (e) { return String(auDec).slice(0, 120); } })() });
          task.status = "下载中…";
          renderDlTasks();
          const fnameA = `${sanitize(track.name || track.hash || "song")}-${quality}.${(auExt || "mp3")}`;
          const dstA = `${outDir}\\${fnameA}`;
          const rd = await nodeDownload(auDec, dstA, { timeout: 600000 });
          if (rd.ok) {
            task.status = "完成";
            task.out = dstA;
            task.ext = auExt || "mp3";
            task.size = rd.size || 0;
            await dlLog("audioUrl 直链落盘 OK", { song: track.name || track.hash, out: dstA, size: task.size });
            renderDlTasks();
            return { directOut: dstA, ext: auExt || "mp3", isCrypt: false, size: rd.size || 0 };
          }
          await dlLog("audioUrl 直链落盘失败，走接口回退", { song: track.name || track.hash, err: rd.error });
        } else {
          await dlLog("audioUrl 为加密源，走接口回退", { song: track.name || track.hash, ext: auExt });
        }
      }
    }

    // 2026-10 修复：优先 /v5/url 拿未加密播放直链（mp3/flac），规避 priv_url 返回封面 jpg / mgg 加密源
    // 2026-10-04：渲染层 v5 失败后不直接回退 priv_url，先走 node 子进程取链兜底（100% 绕过渲染层网关风控）
    let v5 = null;
    try {
      v5 = await requestV5Url(st, track, quality);
      await dlLog("v5/url OK", { song: track.name || track.hash, quality, ext: v5.ext, urlShape: (() => { try { const u = new URL(v5.url); return u.protocol + "//" + u.host + u.pathname.slice(0, 80); } catch (e) { return String(v5.url).slice(0, 120); } })() });
    } catch (e) {
      await dlLog("v5/url 失败，走 node 兜底", { song: track.name || track.hash, err: e && e.message ? e.message : String(e) });
    }
    if (!v5 || !v5.url) {
      const v5n = await requestV5ByNode(st, track, quality);
      if (v5n && v5n.url) v5 = v5n;
    }
    if (!v5 || !v5.url) {
      await dlLog("node 兜底也未取到直链，回退 priv_url", { song: track.name || track.hash });
    }

    let rawUrl = null;
    let ext = "";
    let isCrypt = false;
    if (v5 && v5.url) {
      rawUrl = v5.url;
      ext = v5.ext && ["mp3", "flac", "m4a", "aac", "wav", "ape", "ogg", "opus"].includes(v5.ext) ? v5.ext : "mp3";
      isCrypt = false;
    } else {
      // 回退：priv_url 加密源（仅当 v5/url 不可用时）
      try {
        j = await requestPrivUrl(st, track, quality);
        await dlLog("priv_url OK", { song: track.name || track.hash, quality });
        {
          const _dk = (j && j.data && typeof j.data === "object" && !Array.isArray(j.data)) ? Object.keys(j.data) : [];
          await dlLog("priv_url 响应", {
            song: track.name || track.hash,
            topKeys: j ? Object.keys(j) : [],
            dataKeys: _dk,
            urls: collectUrls(j, "", [], 0).slice(0, 30),
            json: JSON.stringify(j).slice(0, 3000),
          });
        }
      } catch (e) {
        task.status = "失败";
        task.err = e && e.message ? e.message : String(e);
        await dlLog("priv_url 失败", { song: track.name || track.hash, err: task.err });
        renderDlTasks();
        return null;
      }
      const u = deepFindUrl(j, 0, true) || deepFindUrl(j, 0, false);
      await dlLog("取链结果", { song: track.name || track.hash, hit: (() => { try { const uu = new URL(u); return uu.protocol + "//" + uu.host + uu.pathname.slice(0, 80); } catch (e) { return String(u).slice(0, 120); } })() });
      if (!u) {
        task.status = "失败";
        task.err = "响应中没有可用的播放地址";
        await dlLog("priv_url 无播放地址", { song: track.name || track.hash, j });
        renderDlTasks();
        return null;
      }
      rawUrl = u;
      const safeUrl0 = decodeURIComponent(String(rawUrl));
      const extMatch0 = (safeUrl0.split(/[?#]/)[0].match(/\.([a-zA-Z0-9]+)$/) || []);
      ext = extMatch0[1] ? extMatch0[1].toLowerCase() : "";
      if (["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) {
        task.status = "失败";
        task.err = "取链结果为封面图片而非音频（priv_url 未返回可用音频直链）";
        await dlLog("priv_url 命中封面图", { song: track.name || track.hash, url: safeUrl0.slice(0, 200) });
        renderDlTasks();
        return null;
      }
      isCrypt = CRYPT_EXTS.includes(ext);
      if (ext === "mgg" || ext === "mflac") {
        task.status = "失败";
        task.err = "该曲目为 mgg/mflac 新版加密源，本地暂不支持转码";
        await dlLog("priv_url 返回新版加密源", { song: track.name || track.hash, ext });
        renderDlTasks();
        return null;
      }
    }
    const safeUrl = decodeURIComponent(String(rawUrl));
    task.status = "下载中…";
    renderDlTasks();
    const fname = `${sanitize(track.name || track.hash || "song")}-${quality}.${ext || "bin"}`;
    if (isCrypt) {
      // 加密源（kgm/kgg）：node 写插件 dl-cache 物理路径，后续 KgmConvert 转码到保存目录
      const relName = `${DOWNLOAD_TMP}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${fname}`;
      const cacheAbs = `${pluginRoot}\\${relName.replace(/\//g, "\\")}`;
      const rd = await nodeDownload(safeUrl, cacheAbs, { timeout: 600000 });
      if (!rd.ok) {
        task.status = "失败";
        task.err = "下载失败：" + rd.error;
        await dlLog("加密源下载失败", { song: track.name || track.hash, err: task.err });
        renderDlTasks();
        return null;
      }
      task.cacheRel = relName;
      task.isCrypt = true;
      task.ext = ext;
      task.size = rd.size || 0;
      await dlLog("加密源缓存 OK", { rel: relName, size: task.size });
      renderDlTasks();
      return { cacheRel: relName, ext, isCrypt: true, size: rd.size || 0 };
    }
    // 未加密直链：node 直接写保存目录（跳过缓存与复制）
    const dst = `${outDir}\\${fname}`;
    const rd = await nodeDownload(safeUrl, dst, { timeout: 600000 });
    if (!rd.ok) {
      task.status = "失败";
      task.err = "下载失败：" + rd.error;
      await dlLog("直链下载失败", { song: track.name || track.hash, err: task.err, out: dst });
      renderDlTasks();
      return null;
    }
    task.status = "完成";
    task.out = dst;
    task.ext = ext;
    task.size = rd.size || 0;
    await dlLog("直链落盘 OK", { song: track.name || track.hash, out: dst, size: task.size });
    renderDlTasks();
    return { directOut: dst, ext, isCrypt: false, size: rd.size || 0 };
  }

  async function cleanupCache(cacheRel) {
    if (!cacheRel) return;
    try { await ctx.fs.deleteFile(cacheRel); } catch (e) {}
  }

  // ---- 非加密直链落盘：缓存文件（插件目录内）复制到保存目录（插件目录外）----
  // ctx.fs 沙箱只允许写插件目录内，跨目录复制必须走辅助进程；复用 launch 授权通道
  async function copyCacheToOutDir(cacheRel, outDir, fname) {
    try {
      const pluginRoot = await ensurePluginRoot();
      if (!pluginRoot) return { ok: false, error: "无法定位插件缓存目录" };
      const src = pluginRoot + "\\" + String(cacheRel).replace(/\//g, "\\");
      const dst = outDir + "\\" + fname;
      const r = await Promise.race([
        ctx.process.launch({
          executable: "cmd.exe",
          args: ["/c", "copy", "/Y", src, dst],
          timeout: LAUNCH_TIMEOUT,
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("授权/启动超时")), LAUNCH_TIMEOUT)),
      ]);
      if (!r || r.canceled) return { ok: false, error: "授权未确认" };
      if (r.error) return { ok: false, error: "启动失败：" + r.error };
      if (r.ok === false) return { ok: false, error: "复制进程未成功（exitCode=" + (r.exitCode === undefined ? "?" : r.exitCode) + "）" };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  // ---- 转码阶段：单个 task 的缓存转码（重试/单曲用）----
  async function transcodeOne(task, outDir) {
    if (!task.isCrypt) {
      // 未加密直链已在下载阶段由 node 直写保存目录，无需转码/复制
      if (task.status !== "完成") {
        task.status = "失败";
        task.err = "未找到落盘文件";
      }
      renderDlTasks();
      return;
    }
    task.status = "转码中…";
    renderDlTasks();
    const silentLog = { add: async () => {} };
    let rs;
    try {
      rs = await convertBatch(ctx, silentLog, KGM_HELPER, [task.cacheRel], outDir);
    } catch (e) {
      task.status = "失败";
      task.err = "转码异常：" + (e && e.message ? e.message : String(e));
      renderDlTasks();
      return;
    }
    const r = rs && rs[0];
    if (r && r.ok) {
      task.status = "完成";
      task.out = r.out || "";
      task.size = r.size || 0;
      await dlLog("单曲转码 OK", { song: task.name, out: task.out, size: task.size });
      await cleanupCache(task.cacheRel);
      renderDlTasks();
    } else {
      task.status = "失败";
      task.err = (r && r.error) || "转码失败";
      await dlLog("单曲转码失败", { song: task.name, err: task.err });
      renderDlTasks();
    }
  }

  // ---- 任务编排（单曲 / 批量播放列表）：先并发下载全部加密源，再统一批量转码 ----
  async function runDownload(opts) {
    if (dlBusy) return;
    const st = captureState();
    await dlLog("runDownload 开始", { single: !!opts.single, stOk: !!(st && st.token && st.userid), outDir: dlOutDir, quality: dlQuality });
    if (!st || !st.token || !st.userid) {
      ctx.toast.warning("未检测到酷狗登录态，请先登录后下载");
      return;
    }
    if (!dlOutDir) {
      ctx.toast.warning("请先选择保存位置");
      return;
    }
    let tracks = [];
    if (opts.single) {
      const t = currentTrack();
      if (!t) { ctx.toast.warning("当前无可下载歌曲（请在播放条选中一首）"); return; }
      const ids = trackIds(t);
      if (!ids.hash) { ctx.toast.warning("无法获取当前歌曲 hash（可能不是在线歌曲）"); return; }
      tracks = [ids];
    } else {
      const rawList = (opts.tracks && opts.tracks.length) ? opts.tracks : playlistSongs();
      for (const t of rawList) {
        const ids = t.hash ? t : trackIds(t);
        if (ids.hash) tracks.push(ids);
      }
      if (!tracks.length) { ctx.toast.warning("当前播放列表为空或无法读取"); return; }
      const seen = {};
      tracks = tracks.filter((x) => (seen[x.hash] ? false : (seen[x.hash] = true)));
      if (tracks.length > 60) {
        ctx.toast.warning(`播放列表共 ${tracks.length} 首，超过单次上限，本次仅下载前 60 首`);
        tracks = tracks.slice(0, 60);
      }
    }
    dlBusy = true;
    dlSummary = "";
    dlTasks = tracks.map((t) => ({
      track: t,
      name: `${t.name || t.hash}${t.artist ? " - " + t.artist : ""}`,
      status: "排队",
      err: "",
      out: "",
      size: 0,
      hint: "",
      cacheRel: "",
      isCrypt: false,
      ext: "",
      bufSize: 0,
    }));
    renderDlTasks();
    renderDlStatus();
    const quality = dlQuality;
    const outDir = dlOutDir;
    // 阶段1：并发下载全部加密源到缓存（下载相互独立，无状态依赖，最多 3 路并发）
    let cursor = 0;
    const CONCURRENCY = 3;
    const worker = async () => {
      while (cursor < dlTasks.length) {
        const i = cursor++;
        await downloadToCache(st, tracks[i], quality, dlTasks[i], outDir);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dlTasks.length) }, () => worker()));
    // 阶段2：统一批量转码（一次启动辅助进程，替代每首一次 launch）
    const cryptTasks = dlTasks.filter((t) => t.isCrypt && t.cacheRel);
    if (cryptTasks.length) {
      for (const t of cryptTasks) t.status = "转码中…";
      renderDlTasks();
      const silentLog = { add: async () => {} };
      let rs;
      try {
        rs = await convertBatch(ctx, silentLog, KGM_HELPER, cryptTasks.map((t) => t.cacheRel), outDir);
      } catch (e) {
        for (const t of cryptTasks) {
          t.status = "失败";
          t.err = "转码异常：" + (e && e.message ? e.message : String(e));
        }
      }
      if (rs) {
        for (let i = 0; i < cryptTasks.length; i++) {
          const t = cryptTasks[i];
          const r = rs[i];
          if (r && r.ok) {
            t.status = "完成";
            t.out = r.out || "";
            t.size = r.size || 0;
            await dlLog("批量转码 OK", { song: t.name, out: t.out, size: t.size });
            await cleanupCache(t.cacheRel);
          } else {
            t.status = "失败";
            t.err = (r && r.error) || "转码失败";
            await dlLog("批量转码失败", { song: t.name, err: t.err });
          }
        }
      }
      renderDlTasks();
    }
    const ok = dlTasks.filter((t) => t.status === "完成").length;
    const fail = dlTasks.length - ok;
    if (fail === 0) {
      dlSummary = `全部完成：${ok} 首`;
      ctx.toast.success(`下载完成：成功 ${ok} 首`);
    } else if (ok === 0) {
      dlSummary = `全部失败：${fail} 首未下载成功，请查看失败原因后点击重试`;
      ctx.toast.warning(`全部失败：${fail} 首未下载成功，打开下载面板查看原因并重试`);
    } else {
      dlSummary = `完成 ${ok} / 失败 ${fail}，失败项可点击重试`;
      ctx.toast.warning(`下载完成：成功 ${ok} 首 / 失败 ${fail} 首，失败项可点击重试`);
    }
    dlBusy = false;
    renderDlTasks();
    renderDlStatus();
  }

  // ---- 单首重试：重新走下载+转码 ----
  async function retryTask(i) {
    const task = dlTasks[i];
    if (!task || dlBusy) return;
    const st = captureState();
    if (!st || !st.token || !st.userid) {
      ctx.toast.warning("未检测到酷狗登录态，无法重试");
      return;
    }
    task.status = "排队";
    task.err = "";
    task.out = "";
    task.hint = "";
    task.cacheRel = "";
    task.isCrypt = false;
    task.size = 0;
    task.bufSize = 0;
    dlSummary = "";
    renderDlTasks();
    renderDlStatus();
    dlBusy = true;
    await downloadToCache(st, task.track, dlQuality, task, dlOutDir);
    if (task.status !== "失败") {
      await transcodeOne(task, dlOutDir);
    }
    dlBusy = false;
    renderDlTasks();
    renderDlStatus();
  }

  // ==================== 播放条入口 + 下载面板（v2.0.0）====================

  const DL_BTN_ID = "ekc-download-btn";
  const DL_BTN_SVG =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:block">' +
    '<path d="M12 3v10m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="2"></path>' +
    '<path d="M4 17v1.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V17" stroke="currentColor" stroke-width="2"></path></svg>';
  const DL_BTN_IDLE = "rgba(127,135,153,.55)";
  let dlBtnRef = null;
  let dlPopupEl = null;
  let dlTasks = [];
  let dlBusy = false;
  let dlSummary = "";
  let dlQuality = "320";
  let dlOutDir = "";

  (async () => {
    try {
      const saved = await ctx.storage.get("settings");
      if (saved && typeof saved === "object" && saved.dlOutDir) dlOutDir = saved.dlOutDir;
    } catch (e) {}
    // 探测 ctx 网络能力（一次性，写 dl-debug.log）
    try {
      const keys = Object.keys(ctx).sort();
      let netInfo = "none";
      try {
        const netv = ctx.net || (ctx.electron && ctx.electron.net) || null;
        netInfo = netv ? "obj:" + Object.keys(netv).join(",") : "none";
      } catch (en) { netInfo = "err:" + en.message; }
      await dlLog("ctx 探测", { keys: keys.join(","), netInfo, http: typeof ctx.http, fetch: typeof ctx.fetch });
    } catch (e0) {
      await dlLog("ctx 探测异常", { err: e0 && e0.message ? e0.message : String(e0) });
    }
  })();

  const FAV_SELECTORS = [
    '.player-bar [title="收藏"]',
    '.player-bar [title="喜欢"]',
    '.player-bar [title="红心"]',
    '.player-bar [title="赞"]',
    '.player-bar [title="Like"]',
    '.player-bar [title="Favorite"]',
    '.player-bar [aria-label="收藏"]',
    '.player-bar [aria-label="喜欢"]',
  ];

  function findFavBtn() {
    for (const sel of FAV_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    const scope = document.querySelector(".player-bar");
    if (!scope) return null;
    const cands = scope.querySelectorAll('button, [role="button"], [class*="btn"], [class*="icon"], svg');
    for (const c of cands) {
      const svg = c.tagName === "SVG" ? c : c.querySelector("svg");
      if (!svg) continue;
      const d = (svg.getAttribute("class") || "") + " " + (svg.innerHTML || "");
      if (/heart/i.test(d) || /M12\s*21|21\.35/i.test(d)) {
        return c.tagName === "SVG" ? c.parentElement || c : c;
      }
    }
    return null;
  }

  function setDlBtnState(active) {
    if (!dlBtnRef || !dlBtnRef.isConnected) return;
    dlBtnRef.style.color = active ? "var(--color-primary, #4f7cff)" : DL_BTN_IDLE;
  }

  function ensureDownloadEntry() {
    if (document.getElementById(DL_BTN_ID)) return true;
    const fav = findFavBtn();
    if (!fav) return false;
    const row = fav.parentElement;
    if (!row) return false;
    const b = document.createElement("button");
    b.id = DL_BTN_ID;
    b.type = "button";
    b.title = "下载音频";
    b.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;padding:0;background:transparent;border:0;border-radius:6px;line-height:1;cursor:pointer;color:" + DL_BTN_IDLE;
    b.innerHTML = DL_BTN_SVG;
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleDownloadPopup(); });
    b.addEventListener("mouseenter", () => setDlBtnState(true));
    b.addEventListener("mouseleave", () => setDlBtnState(!!(dlPopupEl && dlPopupEl.isConnected)));
    if (fav.nextSibling) row.insertBefore(b, fav.nextSibling);
    else row.appendChild(b);
    dlBtnRef = b;
    return true;
  }

  function closeDownloadPopup() {
    if (dlPopupEl && dlPopupEl.isConnected) dlPopupEl.remove();
    dlPopupEl = null;
    setDlBtnState(false);
  }

  function toggleDownloadPopup() {
    if (dlPopupEl && dlPopupEl.isConnected) { closeDownloadPopup(); return; }
    dlPickMode = false;
    dlPickTracks = [];
    dlPickSel = new Set();
    const btn = document.getElementById(DL_BTN_ID);
    if (!btn) return;
    const popup = document.createElement("div");
    popup.id = "ekc-dl-popup";
    dlPopupEl = popup;
    document.body.appendChild(popup);
    renderDlPopup();
    const rect = btn.getBoundingClientRect();
    const W = 340;
    let left = rect.left;
    if (left + W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - W - 8);
    popup.style.left = left + "px";
    popup.style.bottom = Math.max(8, window.innerHeight - rect.top + 8) + "px";
    setDlBtnState(true);
  }

  function renderDlPopup() {
    const popup = dlPopupEl;
    if (!popup) return;
    const t = currentTrack();
    const ids = t ? trackIds(t) : null;
    const songText = ids && ids.name ? `${ids.name}${ids.artist ? " - " + ids.artist : ""}` : "当前未选中歌曲（可从播放列表批量下载）";
    popup.innerHTML =
      '<div style="padding:14px 14px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.07);font-size:13px;font-weight:600;">' +
        '<span>下载音频</span><button data-dl-close style="background:transparent;border:0;color:rgba(255,255,255,.5);font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;">×</button>' +
      '</div>' +
      '<div style="padding:12px 14px;display:grid;gap:10px;font-size:12px;color:#e6e8ee;">' +
        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.85);">' + songText + '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;">' +
          '<span style="color:rgba(255,255,255,.5);flex:none;">音质</span>' +
          '<div style="display:flex;gap:4px;flex:1;min-width:0;">' +
            QUALITY_OPTIONS.map((q) =>
              '<button data-dl-quality="' + q.id + '" title="' + q.hint + '" style="flex:1;min-width:0;padding:5px 0;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid ' + (dlQuality === q.id ? "var(--color-primary,#4f7cff)" : "rgba(255,255,255,.14)") + ';background:' + (dlQuality === q.id ? "rgba(79,124,255,.18)" : "transparent") + ';color:' + (dlQuality === q.id ? "var(--color-primary,#6f9bff)" : "rgba(255,255,255,.75)") + ';">' + q.label + '</button>'
            ).join("") +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;min-width:0;">' +
          '<span style="color:rgba(255,255,255,.5);flex:none;">位置</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (dlOutDir || "未选择保存目录") + '</span>' +
          '<button data-dl-dir style="flex:none;padding:4px 8px;border-radius:6px;font-size:11px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.8);">选择</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button data-dl-single style="flex:1;padding:7px 0;border:0;border-radius:8px;font-size:12px;cursor:pointer;background:linear-gradient(90deg,#2f6fee,#6a5bff);color:#fff;' + (dlBusy ? "opacity:.55;pointer-events:none;" : "") + '">下载单曲</button>' +
          '<button data-dl-queue style="flex:1;padding:7px 0;border:0;border-radius:8px;font-size:12px;cursor:pointer;background:rgba(255,255,255,.08);color:rgba(255,255,255,.9);' + (dlBusy ? "opacity:.55;pointer-events:none;" : "") + '">批量下载列表</button>' +
        '</div>' +
        '<div data-dl-status style="font-size:11px;color:rgba(255,255,255,.55);min-height:14px;"></div>' +
      '</div>' +
      '<div data-dl-tasks style="max-height:230px;overflow:auto;padding:0 14px 12px;display:grid;gap:4px;"></div>';
    popup.style.cssText =
      "position:fixed;z-index:99999;width:340px;background:#1e2129;border:1px solid rgba(255,255,255,.08);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.55);color:#e6e8ee;font-size:12px;font-family:inherit;";
    renderDlTasks();
    renderDlStatus();
    popup.addEventListener("click", (e) => {
      const tgt = e.target;
      if (tgt.closest("[data-dl-close]")) { closeDownloadPopup(); return; }
      if (tgt.closest("[data-dl-dir]")) { selectDlOutDir(); return; }
      const q = tgt.closest("[data-dl-quality]");
      if (q) {
        // 音质切换只更新选中态，不整窗重建，避免任务列表/滚动位置丢失
        if (dlQuality === q.dataset.dlQuality) return;
        dlQuality = q.dataset.dlQuality;
        popup.querySelectorAll("[data-dl-quality]").forEach((b) => {
          const sel = b.dataset.dlQuality === dlQuality;
          b.style.borderColor = sel ? "var(--color-primary,#4f7cff)" : "rgba(255,255,255,.14)";
          b.style.background = sel ? "rgba(79,124,255,.18)" : "transparent";
          b.style.color = sel ? "var(--color-primary,#6f9bff)" : "rgba(255,255,255,.75)";
        });
        return;
      }
      if (tgt.closest("[data-dl-single]")) { dlPickMode = false; runDownload({ single: true }); return; }
      if (tgt.closest("[data-dl-open-dir]")) { openDlOutDir(); return; }
      if (tgt.closest("[data-dl-queue]")) { openPickList(); return; }
      const srcBtn = tgt.closest("[data-dl-src]");
      if (srcBtn) {
        const key = srcBtn.dataset.dlSrc;
        if (!key || !dlPickGroups[key]) return;
        dlPickSource = key;
        dlPickTracks = dlPickGroups[key];
        dlPickSel = new Set();
        renderDlPick();
        return;
      }
      const pk = tgt.closest("[data-dl-pick]");
      if (pk) {
        const i = parseInt(pk.dataset.dlPick, 10);
        if (!(i >= 0) || i >= dlPickTracks.length) return;
        // 2026-10-05：勾选上限 DL_PICK_MAX，与 runDownload 批量上限一致，防止静默截断
        if (dlPickSel.has(i)) {
          dlPickSel.delete(i);
        } else {
          if (dlPickSel.size >= DL_PICK_MAX) { ctx.toast.warning(`批量下载最多选 ${DL_PICK_MAX} 首`); return; }
          dlPickSel.add(i);
        }
        renderDlPick();
        return;
      }
      if (tgt.closest("[data-dl-pick-all]")) {
        // 2026-10-05：全选同样受上限约束，超出时勾选前 DL_PICK_MAX 首并提示
        if (dlPickTracks.length > DL_PICK_MAX) {
          for (let i = 0; i < DL_PICK_MAX; i++) dlPickSel.add(i);
          ctx.toast.warning(`列表共 ${dlPickTracks.length} 首，批量下载最多 ${DL_PICK_MAX} 首，已自动勾选前 ${DL_PICK_MAX} 首`);
        } else {
          for (let i = 0; i < dlPickTracks.length; i++) dlPickSel.add(i);
        }
        renderDlPick();
        return;
      }
      if (tgt.closest("[data-dl-pick-none]")) { dlPickSel.clear(); renderDlPick(); return; }
      if (tgt.closest("[data-dl-pick-go]")) {
        const sel = dlPickTracks.filter((_, i) => dlPickSel.has(i));
        if (!sel.length) return;
        dlPickMode = false;
        dlPickTracks = [];
        dlPickSel = new Set();
        runDownload({ single: false, tracks: sel });
        return;
      }
      const rt = tgt.closest("[data-dl-retry]");
      if (rt) { retryTask(parseInt(rt.dataset.dlRetry, 10)); return; }
    });
  }

  function renderDlStatus() {
    const popup = dlPopupEl;
    if (!popup) return;
    const el = popup.querySelector("[data-dl-status]");
    if (!el) return;
    el.textContent = dlSummary || (dlBusy ? "下载进行中…" : "");
    el.style.color = /失败|全部失败/.test(dlSummary) ? "rgb(248,113,113)" : "rgba(255,255,255,.55)";
  }

  // ---- 选歌下载：批量下载前先勾选要下载的歌曲（2026-10-05 新增）----
  let dlPickMode = false;
  let dlPickTracks = [];
  let dlPickSel = new Set();
  // 2026-10-05：按来源分组展示（like=我喜欢的 / history=历史播放 / others=其他 / all=全部）
  let dlPickSource = "like";
  let dlPickGroups = { like: [], history: [], others: [], all: [] };
  // 2026-10-05：各来源去重后的真实总数（可能超过展示上限，用于「共 N 首，仅显示前 200」提示）
  let dlPickRawCounts = { like: 0, history: 0, others: 0, all: 0 };

  function renderDlPick() {
    const popup = dlPopupEl;
    if (!popup) return;
    const box = popup.querySelector("[data-dl-tasks]");
    if (!box) return;
    const srcDefs = [
      { key: "like", label: "我喜欢的" },
      { key: "history", label: "历史播放" },
      { key: "others", label: "其他" },
      { key: "all", label: "全部" },
    ];
    const srcBar = '<div data-dl-src-bar style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:2px 0 8px;font-size:11px;">' +
      srcDefs.map((d) => {
        const n = dlPickGroups[d.key] ? dlPickGroups[d.key].length : 0;
        if (d.key !== "all" && !n) return "";
        const on = dlPickSource === d.key;
        const raw = dlPickRawCounts[d.key] || 0;
        // 2026-10-05：显示去重后真实总数；超出展示上限时 title 提示「共 N 首，仅显示前 200 首」
        const truncated = raw > n;
        const tip = truncated ? "共 " + raw + " 首，仅显示前 " + n + " 首" : (raw ? "共 " + raw + " 首" : "");
        return '<button data-dl-src="' + d.key + '" title="' + tip + '" style="padding:3px 8px;border-radius:6px;font-size:10px;cursor:pointer;border:1px solid ' + (on ? "rgba(79,124,255,.6)" : "rgba(255,255,255,.14)") + ';background:' + (on ? "rgba(79,124,255,.14)" : "transparent") + ';color:' + (on ? "#fff" : "rgba(255,255,255,.75)") + ';">' + d.label + ' <span style="opacity:.6;">' + n + '</span></button>';
      }).join("") +
      '</div>';
    if (!dlPickTracks.length) {
      box.innerHTML = srcBar + '<div style="font-size:11px;color:rgba(255,255,255,.5);padding:8px 2px;">当前来源没有可下载的歌曲，可切换上方来源</div>';
      return;
    }
    const rows = dlPickTracks.map((t, i) => {
      const on = dlPickSel.has(i);
      return '<div data-dl-pick="' + i + '" style="display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;cursor:pointer;background:' + (on ? "rgba(79,124,255,.14)" : "transparent") + ';border:1px solid ' + (on ? "rgba(79,124,255,.45)" : "rgba(255,255,255,.08)") + ';">' +
        '<span style="flex:none;width:16px;height:16px;border-radius:4px;border:1px solid ' + (on ? "var(--color-primary,#6f9bff)" : "rgba(255,255,255,.3)") + ';background:' + (on ? "var(--color-primary,#4f7cff)" : "transparent") + ';color:#fff;font-size:11px;line-height:15px;text-align:center;">' + (on ? "✓" : "") + '</span>' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + (on ? "#fff" : "rgba(255,255,255,.8)") + ';">' + (t.name || t.hash || "未知歌曲") + (t.artist ? ' <span style="color:rgba(255,255,255,.45);">- ' + t.artist + '</span>' : "") + '</span>' +
      '</div>';
    }).join("");
    const selN = dlPickSel.size;
    box.innerHTML = srcBar +
      '<div style="display:flex;gap:6px;align-items:center;padding:4px 2px 8px;font-size:11px;">' +
        '<button data-dl-pick-all style="padding:3px 8px;border-radius:6px;font-size:10px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.75);">全选</button>' +
        '<button data-dl-pick-none style="padding:3px 8px;border-radius:6px;font-size:10px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.75);">取消</button>' +
        '<span style="flex:1;text-align:right;color:rgba(255,255,255,.5);">已选 ' + selN + ' 首</span>' +
        '<button data-dl-pick-go style="flex:none;padding:4px 10px;border-radius:8px;font-size:11px;cursor:pointer;border:0;background:linear-gradient(90deg,#2f6fee,#6a5bff);color:#fff;' + (selN ? "" : "opacity:.5;pointer-events:none;") + '">开始下载</button>' +
      '</div>' +
      '<div style="display:grid;gap:4px;max-height:230px;overflow:auto;">' + rows + '</div>';
  }

  async function openPickList() {
    if (dlBusy) return;
    let groups = null;
    try { groups = collectDlGroups(); } catch (e) {}
    // 2026-10-05：playlist store 的队列可能只载入了元数据（songs 空但 songCount>0），
    // 从存储加载歌曲后重读，避免界面有列表而插件读空。
    if (!groups || (!groups.like.length && !groups.history.length && !groups.others.length)) {
      try {
        const pst = playlistStore();
        const pstState = pst && ((pst.$state && typeof pst.$state === "object") ? pst.$state : (pst._state || pst));
        const qs = (pstState && Array.isArray(pstState.playbackQueues)) ? pstState.playbackQueues : [];
        for (const q of qs) {
          if (!q || !(q.songCount || 0) || (q.songs && q.songs.length)) continue;
          if (pst && typeof pst.ensurePlaybackQueueSongsLoaded === "function") {
            try { await pst.ensurePlaybackQueueSongsLoaded(q.id); } catch (e2) {}
          }
        }
        groups = collectDlGroups();
      } catch (e) {}
    }
    // 每组转成统一的 track 对象并去重（每组最多展示 DL_PICK_SHOW_MAX 首，全部组单独去重）
    const toTracks = (arr) => {
      const seen = {};
      const out = [];
      for (const t of arr) {
        const ids = trackIds(t);
        if (!ids.hash) continue;
        const key = ids.hash + "|" + ids.albumAudioId;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(ids);
        if (out.length >= DL_PICK_SHOW_MAX) break;
      }
      return out;
    };
    // 2026-10-05：「全部」组改为各组轮转混排（like→history→others 交替），
    // 避免拼接顺序导致前 200 全被「我喜欢的」占满、历史/其他组的歌永远进不了列表
    const interleaveTracks = (arrs, max) => {
      const nonEmpty = arrs.filter((a) => a && a.length);
      const seen = {};
      const out = [];
      const maxLen = Math.max(...nonEmpty.map((a) => a.length), 0);
      for (let i = 0; i < maxLen && out.length < max; i++) {
        for (const arr of nonEmpty) {
          if (i >= arr.length) continue;
          const t = arr[i];
          const ids = trackIds(t);
          if (!ids.hash) continue;
          const key = ids.hash + "|" + ids.albumAudioId;
          if (seen[key]) continue;
          seen[key] = true;
          out.push(ids);
          if (out.length >= max) break;
        }
      }
      return out;
    };
    // 各来源去重后的真实总数（可能超过展示上限）
    const countAllUnique = (arrs) => {
      const seen = new Set();
      let n = 0;
      for (const arr of arrs) {
        for (const t of arr || []) {
          const ids = trackIds(t);
          if (!ids.hash) continue;
          const key = ids.hash + "|" + ids.albumAudioId;
          if (seen.has(key)) continue;
          seen.add(key);
          n++;
        }
      }
      return n;
    };
    const g = groups || { like: [], history: [], others: [] };
    const groupsTracks = {
      like: toTracks(g.like),
      history: toTracks(g.history),
      others: toTracks(g.others),
    };
    groupsTracks.all = interleaveTracks([g.like, g.history, g.others], DL_PICK_SHOW_MAX);
    dlPickGroups = groupsTracks;
    dlPickRawCounts = {
      like: g.like.length,
      history: g.history.length,
      others: g.others.length,
      all: countAllUnique([g.like, g.history, g.others]),
    };
    // 默认来源：我喜欢的优先，其次历史播放，再次其他，最后全部
    dlPickSource = groupsTracks.like.length ? "like"
      : groupsTracks.history.length ? "history"
      : groupsTracks.others.length ? "others" : "all";
    dlPickTracks = groupsTracks[dlPickSource];
    dlPickSel = new Set();
    dlPickMode = true;
    // 只更新任务列表区，禁止重建整个弹窗：重建会销毁按钮节点，
    // 原点击事件继续冒泡到 document 关闭监听，弹窗会被立即关闭（表现为点了没反应）
    renderDlTasks();
    renderDlStatus();
    await dlLog("openPickList", { like: groupsTracks.like.length, history: groupsTracks.history.length, others: groupsTracks.others.length, all: groupsTracks.all.length, source: dlPickSource });
  }

  function renderDlTasks() {
    const popup = dlPopupEl;
    if (!popup) return;
    const box = popup.querySelector("[data-dl-tasks]");
    if (!box) return;
    if (dlPickMode) { renderDlPick(); return; }
    // 2026-10-05：任务区顶部显示「打开目录」按钮（有保存位置时），一键定位下载产物
    const dirBar = dlOutDir
      ? '<div style="display:flex;gap:6px;align-items:center;padding:2px 0 6px;">' +
        '<button data-dl-open-dir style="flex:none;padding:3px 8px;border-radius:6px;font-size:10px;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:transparent;color:rgba(255,255,255,.75);">打开目录</button>' +
        '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:rgba(255,255,255,.4);font-size:10px;">' + dlOutDir + '</span>' +
        '</div>'
      : "";
    if (!dlTasks.length) { box.innerHTML = dirBar; return; }
    box.innerHTML = dirBar + dlTasks.map((t, i) => {
      const color = t.status === "完成" ? "rgb(74,222,128)" : t.status === "失败" ? "rgb(248,113,113)" : "rgba(255,255,255,.75)";
      const detail = t.status === "完成"
        ? (t.out ? " → " + baseName(t.out) + (t.size ? "（" + fmtSize(t.size) + "）" : "") : t.hint || "")
        : t.status === "失败" ? (t.err || "") : "";
      const retry = t.status === "失败"
        ? '<button data-dl-retry="' + i + '" style="flex:none;padding:2px 8px;border-radius:6px;font-size:10px;cursor:pointer;border:1px solid rgba(255,255,255,.18);background:transparent;color:rgba(255,255,255,.8);">重试</button>'
        : "";
      return '<div style="display:flex;gap:8px;align-items:flex-start;font-size:11px;line-height:1.5;">' +
        '<span style="flex:none;color:' + color + ';">' + (t.status === "完成" ? "✓" : t.status === "失败" ? "✗" : "…") + '</span>' +
        '<span style="flex:1;min-width:0;word-break:break-all;color:rgba(255,255,255,.85);">' + t.name + (detail ? '<span style="color:rgba(255,255,255,.5);"> ' + detail + '</span>' : "") + '</span>' +
        '<span style="flex:none;color:' + color + ';">' + t.status + '</span>' +
        retry +
      '</div>';
    }).join("");
  }

  async function selectDlOutDir() {
    const result = await ctx.dialog.selectDirectory({
      title: "选择音频保存目录",
      defaultPath: dlOutDir || undefined,
    });
    if (!result.canceled && result.paths[0]) {
      dlOutDir = result.paths[0];
      try { await ctx.storage.set("settings", { dlOutDir: dlOutDir }); } catch (e) {}
      renderDlPopup();
    }
  }

  // 2026-10-05：一键打开下载目录（复用辅助进程 node，规避 renderer 沙箱无 spawn/exec 的限制）
  async function openDlOutDir() {
    if (!dlOutDir) { ctx.toast.warning("请先选择保存位置"); return; }
    const pluginRoot = await ensurePluginRoot();
    if (!pluginRoot) return;
    const script = pluginRoot + "\\tools\\opendir.mjs";
    try {
      const launch = await Promise.race([
        ctx.process.launch({ executable: pluginRoot + "\\" + NODE_EXE_REL, args: [script, dlOutDir], timeout: 15000 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("授权/启动超时")), 15000)),
      ]);
      if (!launch || launch.ok === false || launch.error) {
        ctx.toast.warning("打开目录失败：" + ((launch && (launch.error || launch.message)) || "辅助进程未确认授权"));
      }
    } catch (e) {
      ctx.toast.warning("打开目录失败：" + (e && e.message ? e.message : String(e)));
    }
  }

  function initDownloadEntry() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (ensureDownloadEntry() || tries > 40) clearInterval(timer);
    }, 500);
    document.addEventListener("click", (e) => {
      if (dlPopupEl && dlPopupEl.isConnected) {
        // 2026-10-05：来源切换/勾选等交互会重写 data-dl-tasks 内容区（innerHTML），
        // 被点击的旧节点在冒泡到 document 前已被销毁，contains(旧节点) 恒为 false 会误关弹窗。
        // 仅当点击目标仍挂在文档中（isConnected）且不在弹窗/下载按钮内时才关闭。
        const t = e.target;
        const stillInDoc = !!(t && t.isConnected);
        if (stillInDoc && !dlPopupEl.contains(t) && !(dlBtnRef && dlBtnRef.contains(t))) closeDownloadPopup();
      }
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDownloadPopup(); });
    ctx.dispose(() => { clearInterval(timer); closeDownloadPopup(); });
  }

  // ==================== 业务区 ====================

  // 授权指引提示改为持久化标记：首次提示过一次后永久不再弹（避免每次启动软件都提示）
  let authTipShown = false;
  try {
    authTipShown = !!(await ctx.storage.get("authTipShown"));
  } catch (e) {
    authTipShown = false;
  }

  const SettingsPanel = defineComponent({
    setup() {
      const draft = reactive({ ...defaults });
      const status = ref(""); // 转换中的提示文案

      ctx.storage.get("settings").then((saved) => {
        if (saved && typeof saved === "object") {
          Object.assign(draft, { ...defaults, ...saved });
          if (!Array.isArray(draft.pendingFiles)) draft.pendingFiles = [];
        }
      });

      const selectOutDir = async () => {
        const result = await ctx.dialog.selectDirectory({
          title: "选择转换输出目录",
          defaultPath: draft.outDir || draft.srcDir || undefined,
        });
        if (!result.canceled && result.paths[0]) {
          draft.outDir = result.paths[0];
          await saveSettings(draft, { silent: true });
        }
      };

      const selectFiles = async () => {
        const result = await ctx.dialog.selectFiles({
          title: "选择加密音频文件",
          defaultPath: draft.srcDir || draft.outDir || undefined,
          multiple: true,
          filters: [
            { name: "加密音频", extensions: SUPPORTED_EXTENSIONS },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
        if (!result.canceled && Array.isArray(result.paths) && result.paths.length) {
          draft.pendingFiles = result.paths;
          if (result.paths[0]) {
            const parts = String(result.paths[0]).split(/[\\/]/);
            parts.pop();
            draft.srcDir = parts.join("\\");
          }
          await saveSettings(draft, { silent: true });
        }
      };

      const clearFiles = async () => {
        draft.pendingFiles = [];
        draft.srcDir = "";
        await saveSettings(draft, { silent: true });
      };

      const runConvert = async () => {
        // 统一诊断日志：一次转换一个 run-<tag>.txt，全链路（进入→分组→launch→轮询→结果）都有痕迹
        const log = (() => {
          const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const logFile = `${RESULT_DIR}/run-${tag}.txt`; // 相对插件目录，v1.3.1 修复越界写失败
          const lines = [];
          return {
            tag,
            logFile,
            async add(msg) {
              lines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
              try {
                await ctx.fs.writeFile(logFile, new TextEncoder().encode(lines.join("\n")).buffer, { overwrite: true });
              } catch (e) {}
            },
          };
        })();
        await log.add(`runConvert 进入 files=${draft.pendingFiles.length} outDir=${draft.outDir}`);
        const probeRoot = await ensurePluginRoot();
        await log.add(`v1.3.2 插件目录探测=${probeRoot || "失败(将回退相对路径)"}`);
        if (!draft.pendingFiles.length) {
          ctx.toast.warning("请先选择要转换的文件");
          return;
        }
        if (!draft.outDir) {
          ctx.toast.warning("请先选择输出目录");
          return;
        }
        if (!authTipShown) {
          ctx.toast.info("首次转换会弹出授权窗口，请点击「允许并记住」；若看到系统/安全软件提示请选择允许，之后不会再反复弹出");
          authTipShown = true;
          ctx.storage.set("authTipShown", true).catch(() => {});
        }
        draft.converting = true;
        draft.results = [];
        const files = draft.pendingFiles.slice();
        try {
        // 按辅助进程分组，每组只 launch 一次（授权弹窗从每文件一次降到每组一次）
        // 仅一个辅助进程 bin/KgmConvert.exe，分组结构保留但恒为单组
        // kgg v5 不再做 UI 层预检：readFileBytes 依赖不可靠的 IPC，曾导致「转换中」卡死；
        // 辅助进程侧已内置 v5 魔数快速失败（约 0.03s），失败原因同样秒级回显
        const groups = {};
        for (const f of files) {
          (groups[KGM_HELPER] = groups[KGM_HELPER] || []).push(f);
        }
        const helpers = Object.keys(groups);
        await log.add(`分组完成：${helpers.length} 组（${helpers.join(" | ")}）`);
        status.value = `开始转换 ${files.length} 个文件…`;
        let doneCount = 0;
        for (const helper of helpers) {
          const list = groups[helper];
          status.value = `正在转换 ${doneCount + 1}-${doneCount + list.length}/${files.length}（${baseName(helper)}）`;
          const rs = await convertBatch(ctx, log, helper, list, draft.outDir);
          for (const r of rs) {
            draft.results.push(r);
            // 成功不逐个弹 toast（批量秒转时连续弹窗干扰），由结束状态行汇总；仅失败文件弹提示
            if (!r.ok) {
              ctx.toast.warning(`转换失败：${baseName(r.src)}（${r.error || "未知错误"}）`);
            }
          }
          doneCount += list.length;
        }
        const okCount = draft.results.filter((r) => r.ok).length;
        const failCount = draft.results.length - okCount;
        status.value = `转换完成：成功 ${okCount} / 共 ${draft.results.length}${failCount ? `（失败 ${failCount}）` : ""}`;
        } finally {
          draft.converting = false;
        }
      };


      return () =>
        h(
          "div",
          { style: "display: grid; gap: 14px; width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box;" },
          [
          // 说明
          h(
            "div",
            {
              style:
                "font-size: 12px; color: var(--text-3, rgba(255,255,255,.45)); line-height: 1.6;",
            },
            [
              "将本机已下载的酷狗加密音频（.kgm/.kgg）还原为可剪辑的原始音频（输出格式与原曲一致，通常为 MP3/FLAC/OGG/WAV），全程本地完成、不联网。",
              h("br"),
              "仅支持酷狗格式：.kgm / .kgg（KGM V1/V2）；不支持网易云/QQ音乐/酷我等其他平台格式；kgg v5 新版加密需客户端密钥库，暂不支持。",
              h("br"),
              "仅处理你本机已有权限的文件。",
            ],
          ),

          // 输出目录
          h(
            "div",
            { style: "display: flex; gap: 8px; align-items: center; min-width: 0; width: 100%;" },
            [
              h(
                "span",
                { style: "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" },
                draft.outDir || "未选择输出目录",
              ),
              h(
                Button,
                { variant: "outline", size: "xs", onClick: selectOutDir, disabled: draft.converting, style: "flex: none; white-space: nowrap;" },
                { default: () => "选择输出目录" },
              ),
            ],
          ),

          // 文件选择
          h(
            "div",
            { style: "display: flex; gap: 8px; align-items: center; min-width: 0; width: 100%;" },
            [
              h(
                "span",
                { style: "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" },
                draft.pendingFiles.length
                  ? `已选 ${draft.pendingFiles.length} 个文件`
                  : "未选择文件",
              ),
              h(
                Button,
                { variant: "outline", size: "xs", onClick: selectFiles, disabled: draft.converting },
                { default: () => "选择文件" },
              ),
              draft.pendingFiles.length
                ? h(
                    Button,
                    { variant: "ghost", size: "xs", onClick: clearFiles, disabled: draft.converting },
                    { default: () => "清空" },
                  )
                : null,
            ],
          ),

          // 已选文件列表（前 5 个）
          draft.pendingFiles.length
            ? h(
                "div",
                { style: "display: grid; gap: 2px; font-size: 12px; color: var(--text-3, rgba(255,255,255,.45));" },
                draft.pendingFiles.slice(0, 5).map((f) => h("div", { style: "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" }, baseName(f))),
              )
            : null,
          draft.pendingFiles.length > 5
            ? h(
                "div",
                { style: "font-size: 12px; color: var(--text-3, rgba(255,255,255,.45));" },
                `…等 ${draft.pendingFiles.length} 个文件`,
              )
            : null,

          // 转换按钮
          h(
            Button,
            {
              size: "sm",
              disabled: draft.converting || !draft.pendingFiles.length || !draft.outDir,
              onClick: runConvert,
              style: "white-space: nowrap;",
            },
            { default: () => (draft.converting ? "转换中…" : "开始转换") },
          ),

          // 状态行
          status.value
            ? h("div", { style: "font-size: 12px; color: var(--text-3, rgba(255,255,255,.45));" }, status.value)
            : null,

          // 结果列表
          draft.results.length
            ? h(
                "div",
                { style: "display: grid; gap: 4px; min-width: 0;" },
                draft.results.map((r) =>
                  h(
                    "div",
                    {
                      style:
                        "display: flex; gap: 8px; align-items: flex-start; min-width: 0; font-size: 12px; padding: 4px 6px; border-radius: 6px; background: " +
                        (r.ok ? "rgba(74,222,128,.08); color: rgb(74,222,128);" : "rgba(248,113,113,.08); color: rgb(248,113,113);"),
                    },
                    [
                      h("span", { style: "flex: none;" }, r.ok ? "✓" : "✗"),
                      h(
                        "span",
                        { style: "flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" },
                        r.ok ? `${baseName(r.out)}（${r.format} · ${fmtSize(r.size)}）` : `${baseName(r.src)}：${r.error}`,
                      ),
                    ],
                  ),
                ),
              )
            : null,

          // 保存按钮
          h(Button, { size: "xs", variant: "outline", onClick: () => saveSettings(draft), style: "white-space: nowrap;" }, { default: () => "保存设置" }),
        ]);
    },
  });

  ctx.ui.settings.define({
    title: "酷狗加密音频转原始格式",
    component: SettingsPanel,
  });

  // v2.0.0：播放条「下载」入口注入（收藏旁）
  initDownloadEntry();
}
