/* EchoMusic 酷狗概念版每日签到插件 · author: Luo
 * 通过官方插件机制实现自动/手动领取概念版每日 VIP，升级应用不丢失。
 *
 * v6.2.1（Luo 定制版）多轮审查返修：收敛容错计数 + 收窄冷却粒度 + 广告防重入——
 *   - 概念币（claimOneTask）：v6.2.0 的「连续同类错误计数」在错误码交替（如 11005/11006
 *     混杂）时永不到 3，会一路打到 COIN_PER_TASK_SAFE=80 且不拉黑不冷却、每 5 分钟重演
 *     （15→80 恶化）。改为「累计失败 ≥3」收敛——每次非 50003 异常错误 failCnt++、成功清零、
 *     累计 3 次即拉黑，判定独立于错误码序列。
 *   - 冷却收窄：渠道级 cooldown.coin 仅由「可重复任务累计 3 次失败」（异常多为账号级风控）
 *     触发；一次性任务（t.max===1）失败多为「今日已领/不可领」，仅 block.add 该 taskid
 *     （黑名单在 mergedCoinTasks 过滤，下轮自动跳过），不再锁全渠道误伤其它可领任务。
 *   - 看广告（runAdClaim）：网络/解析异常（error_code 为 undefined/null）≠ 风控——不再
 *     误设 30 分钟冷却 + 「疑似风控」误导 toast，与 claimOneTask 对齐为「不冷却、下轮重试」；
 *     新增 adBusy 防重入：扩量后单轮最长约 20×30s=600s 超过调度器 300s 周期，防止上一轮未
 *     结束下一轮 tick 又发起并发双循环。
 *   - KNOWN_DONE_CODES 补 50031（task/submit 确定性「任务不允许提交」完成码，签到虽已改走
 *     signon、但其余任务仍可能出现）→ 不再被误判为风控反复冷却。
 *   - mergedCoinTasks 静态 COIN_TASKS 循环补 block 账号黑名单过滤（与动态循环对齐）——
 *     二轮回归审查发现：静态列表原无 block 判断，被拉黑的 taskid 会经「动态循环因 block 跳过
 *     而未入 seen → 静态循环 reintroduce」或被 profile 解析失败路径直接放行，未真正被跳过；
 *     补齐后在黑名单有效期（profile 刷新前）内被拉黑任务不再每轮重试。
 *
 * v6.2.0（Luo 定制版）深度优化：看广告按服务端额度动态扩量 + 风控/未知错误码当日冷却——
 *   - 看广告（runAdClaim）：上限不再写死 AD_MAX=8，改为先读 play_status.remain（已打通只读
 *     接口）动态设置本轮上限（max(AD_MAX, remain) 保底），跑完预估额度仍一路成功时读一次
 *     最新 remain 续跑，AD_SAFE_CAP=20 防死循环；避免服务端今日可领 >8 次时漏领。
 *   - 风控冷却（cooldown.ad/coin）：仅 30002/130012 等确定性「今日已完成」码锁当日；其余
 *     未知错误码（频繁操作/风控类）统一进 30 分钟渠道冷却（WINDOW_COOLDOWN_MS），调度器
 *     冷却期内跳过该渠道，不再每 5 分钟盲撞接口加重风控；手动点击同样提示冷却剩余时间。
 *   - 概念币（claimOneTask）：同一错误码容错 15 → 3 次（一次性任务仍首次即停），连续同类
 *     错误未缓解即拉黑该 taskid 并触发渠道冷却；KNOWN_DONE_CODES（50003/11005/11006/130012/
 *     30002/304001/131001/61016/130011）视为当日正常结束，不触发冷却。
 *
 * v6.0.0（Luo 定制版）：单次点击连签至服务端上限 + 切号兼容重签——
 *   - 「概念币签到」一次点击自动连续领取当前账号当日所有可领任务：单任务
 *     claimOneTask 不再以本地预估 t.max 提前停领，改为以服务端应答为准持续
 *     task/submit 真实领取（errcode===0 继续叠加），遇停止码即中断并视为完成
 *     （50003=已达上限 / 其他非 0=今日已领/不可领/领取失败），COIN_PER_TASK_SAFE 兜底防死循环。
 *   - 动态任务失败黑名单 dynBlock 由全局 Set 改为按账号隔离 Map<uid, Set<taskid>>：
 *     切换账号后再点「概念币签到」不受上一账号黑名单影响，自动重签满新账号。
 *   - 逐任务显式提示：成功 +N 币 / 已达上限 / 不可领失败 / 网络异常分别 toast，
 *     失败与已领不再静默；调度器「达上限才当日不再轮询」语义保持不变。
 *
 * v5.9.1（Luo 定制版）：冗余清理与公共逻辑收口——
 *   - 删除死代码：fmtWelfareSummary / fmtBalance / calBlock / giftTypeText / runLottery /
 *     fmtLotteryResult / lastLotteryResult（v5.5.0 起独立抽奖按钮已并入「概念币签到」自动连抽，
 *     面板 runLot 入口与 lotBusy/lotRes/lotInfo 一并移除，连抽结果改为面板静态说明）。
 *   - 抽奖状态解析收口：welfareProbe.lottery 与 fetchLotteryInfo 共用 pickLotteryState；
 *     秒/毫秒时间戳与日期字符串解析收口到 toMs，fmtVipEnd 与 memberActive 复用同一解析。
 *
 * v5.8.0（Luo 定制版）：concepts 写接口按会员时长前置短路——每次巡检/切号先只读刷新
 * 当前账号会员状态，会员未过期（vip_end_time 在未来）则直接跳过 free_mode/free_package
 * 两个写接口（会员身份领粉小宝箱必 39403、免费包无收益），避免对会员有效期的无效触发；
 * 账号切换时按 uid 识别强制重刷后再判断。会员过期/切到无会员账号后自动恢复原条件触发。
 *
 * v5.6.0（Luo 定制版）：展示层与刷新机制优化——概念币签到按钮去除「含抽奖N」冗余后缀；
 * 会员到期时间新增天数倒计时「到期 X 天后（YYYY-MM-DD）」；会员状态周期只读刷新
 * （调度器每轮 checkStatus + 个人中心状态条 60s 重建）；看广告提示明确 +1 天 VIP 增益。
 *
 * 对齐已验证的接口实现：
 *   - 状态查询: GET  https://kugouvip.kugou.com/v1/get_union_vip?busi_type=concept
 *   - 听歌上报: POST https://gateway.kugou.com/youth/v2/report/listen_song
 *   - 领取 VIP: POST https://gateway.kugou.com/youth/v1/recharge/receive_vip_listen_song
 *     （receive_day 必须为当天 YYYY-MM-DD，source_id=90139；传 '1' 会报 304001 日期格式错误）
 *   - 概念币直领: POST https://gateway.kugou.com/yutc/youth/v1/task/submit（taskid 见 COIN_TASKS）
 *   - 看广告领取: POST /youth/v1/ad/play_report（ad_id=12307537187，每日次数有限）
 * 签名: md5(saltLite + k=v排序 + data + saltLite)，data 为 POST 请求体原文。
 *
 *
 * v5.0.2（Luo 定制版）修复「签到成功但会员状态不更新」：
 *   - 实机校准发现：get_union_vip 的 vip_clearday 只是「最近一次入账日」（svip/tvip 各存其
 *     领取日），并非「今日是否已领」的布尔标记；服务端对今日额度的真实判定在领取接口
 *     error_code=131001（今日已领）/ status=1（成功）。
 *   - 修正：改为本地今日标记 claimday:<uid>（storage）——领取返回成功或 131001 即落当日
 *     标记并计入连续签到；UI 状态条、设置面板、调度器一律以本地标记判断「今日已领」，
 *     不再因 clearday 非今天误判未领而重复请求，也消除「签到成功但状态不变」的假象。
 *   - 追加修复（实机校准）：带 JSON body 的 POST（listen/ad/coin）走桥通道返回
 *     20006「err signature」，因桥对 body 的序列化与服务端签名校验的 body 原文不一致；
 *     receive（无 body）不受影响仍 131001。http() 现对带 body 请求禁用桥、直接走 fetch，
 *     以 dataStr 原样字符串发送，签名必然一致。
 * v5.0.1（Luo 定制版）故障修复：
 *   - 修复网络桥 net.request 参数错位：主进程契约为 (pluginId, requestId, options, body)，
 *     旧实现误把请求对象放 requestId 位、body 放 options 位，导致 options 无 url 抛
 *     「网络请求 URL 无效」（net-bridge-fail 刷屏）。现已按正确顺序传参并带递增 requestId，
 *     桥通道恢复正常，fetch 仅作兜底。
 *   - 动态任务失败黑名单：profile 动态解析的任务 submit 返回 11005/11006（领取失败/
 *     任务状态已更新）等非上限错误时，本会话内跳过该 taskid，不再每轮巡检盲目反复提交；
 *     缓存过期重建时清空黑名单，次日/重置后可重新尝试。
 * v5.0.0（Luo 定制版）轻量 + 活动渠道自动化：
 *   - UI 轻量化：顶部一行合并账号/登录态/VIP 状态/余额；「会员相关签到」「概念币签到」
 *     两个主按钮并排；行内样式/色块/配色统一收敛，减少视觉重量；最近原始响应默认折叠、
 *     仅出错时自动展开（保持排查能力）；活动渠道区块可折叠（摘要一行+点开展开）。
 *   - 活动渠道自动化：调用已证实的 GET /yutc/youth/v1/system/profile 拉取任务定义，
 *     多路径防御性解析 taskid+名称+奖励类型（解析失败静默回退静态 COIN_TASKS，不报错、
 *     绝不编造未验证接口字段）；「概念币签到」遍历产出概念币的任务逐个 task/submit
 *     （复用 claimOneTask 与 50003/非0 停止规则）；profile 中产出会员时长/VIP 的任务
 *     并入「会员相关签到」链路；确实无法自动化的（邀新得会员、组队抽会员等手机端社交
 *     操作）保留折叠引导备注，并明确标注哪些已自动化、哪些需手动。
 * v4.0.0（Luo 定制版）功能重构：
 *   - 「立即签到」→「会员相关签到」：仅产出会员时长（听歌上报 → 领取当日概念版 VIP → 看广告领 VIP）。
 *   - 概念币领取独立为「概念币签到」按钮：复用 /yutc/youth/v1/task/submit 直领渠道
 *     （9/45/2011/2018/2019，COIN_TASKS），每日重置可反复叠加，与会员领取互不耦合。
 *   - 修复会员领取：receive_day 使用当天 YYYY-MM-DD、source_id=90139 对齐已验证链；
 *     error_code 细化（131001=今日已领取 / 304001=日期参数异常 / 30002=广告次数用光 /
 *     130012=广告今日已领取），并面板展示最近一次领取/刷币的原始错误响应便于排查。
 *   - 调试日志：所有关键动作双写 console + localStorage[kugou_sign_log]（最近 200 条）。
 *   - 面板新增「活动渠道」区块：整合 9 类无法自动化的获币/会员时长入口（纯引导文案，
 *     仅自动化已验证的 taskid 直领与广告渠道，绝不请求未验证接口）。
 *   - 调度器保持单一 5 分钟定时器；广告「今日已用光」/ 刷币「已达上限」即视为当日完成，
 *     避免每轮重复请求触发风控（修复 v3.4 反复重打接口的隐患）。
 *   - 保留个人中心「会员签到」状态条 + 连续签到天数，激活/停用/调度器逻辑完整。
 */
const PLUGIN_ID = 'kugou-concept-sign';
const SALT_LITE = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const APPID = 3116;
const APP_VER = 11440;
const BASE = 'https://gateway.kugou.com';
const VIP_BASE = 'https://kugouvip.kugou.com';
// v5.7.0：concepts 域（概念版手机端福利写接口同源服务），与 gateway 共用同一 SALT_LITE 签名体系
const CONCEPTS_BASE = 'https://concepts.kugou.com';
// v5.7.0：concepts 写接口条件触发记录（供面板展示最近一次触发结果）
let lastConceptClaim = null;
let lastConceptClaimAt = 0;
const UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const UA_REPORT = 'Android13-1070-10566-201-0-ReportPlaySongToServerProtocol-wifi';
// v6.3.0（Luo）修 E2 + 新增 E1 开关：needListenOnAuto/autoAd 默认开（自动巡检带听歌上报、
// 用上广告 VIP 额度）；autoSignon 为独立签到入口开关（默认 true）
const DEFAULT = { autoSign: true, needListenOnAuto: true, autoAd: true, autoCoin: false, autoSignon: true };
const AUTHOR = 'Luo';
const LOG_KEY = 'kugou_sign_log';
// 看广告领取：广告位 id 与批量参数（对齐 GitHub kugou 签到公开方案交叉验证）
const AD_ID = 12307537187;
const AD_MAX = 8;      // 看广告保底尝试次数；实际以 play_status.remain 动态扩量（v6.2.0）
const AD_GAP = 30000;  // 相邻两次广告上报间隔（ms），模拟真实播放节奏
// v6.2.0：风控/未知错误码统一进当日短冷却，避免调度器每 5 分钟盲目重撞接口加重风控
const AD_SAFE_CAP = 20;                            // 单次批量看广告绝对上限（防死循环兜底）
const WINDOW_COOLDOWN_MS = 30 * 60 * 1000;         // 疑似风控后的渠道冷却时长（30 分钟）
// 确定性「今日已完成/不可领/参数类」错误码：视为当日结束，不触发风控冷却。
// 其余未知错误码（如频繁操作/风控类）→ 触发渠道级冷却，冷却期内不再请求。
// v6.2.1：补 50031（task/submit「任务不允许提交」，签到改走 signon 后其余任务仍可能出现）
const KNOWN_DONE_CODES = new Set([50003, 50031, 11005, 11006, 130012, 30002, 304001, 131001, 61016, 130011]);
// 各渠道当日冷却到期时间戳：ad=看广告 / coin=概念币 —— < now 时允许再次尝试
const cooldown = { ad: 0, coin: 0 };
let adBusy = false; // v6.2.1：看广告防重入（扩量后单轮最长约 600s > 调度器 300s 周期）

// 概念币直领渠道（已实测，每日重置可反复叠加；errcode=50003 表示今日已达上限）
// v6.3.0（Luo）修 E6：补 1139（L852 注释自曝可直领）——profile 失败/未含时仍有静态兜底；
// 其真实名称以 profile 动态下发为准，此处静态名仅用于面板标注，max 会被服务端 dynMax 覆盖
const COIN_TASKS = [
  { id: 9,    name: '刷创意视频',   max: 12 },
  { id: 45,   name: '直达广告任务', max: 10 },
  { id: 2011, name: '隐藏任务2011', max: 6 },
  { id: 2018, name: '隐藏任务2018', max: 6 },
  { id: 2019, name: '隐藏任务2019', max: 6 },
  { id: 1139, name: '隐藏任务1139', max: 6 },
];

// 活动渠道（需手动完成的获币/会员时长入口，手机概念版内操作，插件仅引导文案）：
// 已自动化范围见上方 COIN_TASKS 静态直领与下方 profile 动态任务解析，此处仅保留无法自动化的社交/手动操作
const ACTIVITY_CHANNELS = [
  { t: '主页免费得 0.5 元', d: '概念版主页「免费得 0.5 元」入口看广告，可多次领取，每日手动操作。' },
  { t: '浏览五秒签到超级奖励', d: '每日签到旁「浏览五秒」入口，浏览完成后签到超级奖励（概念币/会员时长），手动浏览领取。' },
  { t: '福利限时免费领', d: '福利中心「限时免费领」每日手动领取，含概念币与 VIP 时长。' },
  { t: '试玩任务', d: '福利中心「试玩任务」下载试玩指定应用得概念币，手动完成。' },
  { t: '福利小宝箱浏览应用', d: '「福利小宝箱」浏览应用任务，浏览完成后领取概念币。' },
  { t: '白赚夺宝每日任务', d: '「白赚夺宝」每日任务完成后参与夺宝，可获概念币/会员奖励。' },
  { t: '100% 领币浏览视频/应用抽奖', d: '「100% 领币」浏览视频/应用完成抽奖，必得概念币，每日手动。' },
  { t: '邀新得会员', d: '「邀请新用户」完成任务得畅听/概念会员时长，手动分享邀请。' },
  { t: '组队抽会员', d: '「组队抽会员」活动组队后抽取会员时长，手动参与。' },
  { t: '打开消息提醒+300', d: '福利中心任务：手机概念版开启系统消息提醒后直发 300 概念币。已逆向定位接口 /yutc/youth/v1/user/subscribe（GET 报参数错误必带 body），业务 body 静态逆向不可得，PC 无直领路径，需手机端开启一次推送。' },
];

let ctxRef = null;
let stateCfg = { ...DEFAULT };
let timers = [];
let lastBusi = null;      // 最近一次成功查询到的概念会员(svip)状态，供个人中心状态条展示
let lastVips = {};        // busi_vip 全量拆分：{ tvip: 畅听会员, svip: 概念会员 }
let streakInfo = null;    // 连续签到计数缓存：{ days, lastDay, uid }
let lastAdResult = null;  // 最近一次批量广告领取结果 {count, stop}
let lastCoinResult = null;// 最近一次刷币结果 {perTask, totalGot, net}
let balanceInfo = null;   // 最近一次查询到的概念币余额
let lastMemRaw = null;    // 最近一次领取当日 VIP 的原始响应（供面板排查）
let lastCoinRaw = null;   // 最近一次刷币的最后失败响应（供面板排查）
let lastWelfare = null;   // v5.2.0 最近一次手机端福利中心状态探测结果（面板展示）
let welfareAt = 0;        // welfare 探测缓存时间戳
let lotteryInfo = null;   // v5.3.0 抽奖状态缓存 {chances, coins, done, maxDone, gifts}
let lotteryAt = 0;        // 抽奖状态缓存时间戳

/* v5.2.0 手机端福利中心：PC 端直调手机 App 同源接口（同一 SALT_LITE/gateway 签名体系，
 * token/userid/dfid/mid 互通，已实测打通），把手机端福利渠道固化为只读状态探测 + 可领提示。
 * 渠道与接口映射（均 GET 只读，无写风险）：
 *  - 粉色宝箱(免费模式)   /youth/v1/ad/free_mode_info  → free_mode_award/award_vip_hour/mode_status
 *  - 广告宝箱(看广告领VIP)/youth/v2/ad/play_status     → done/remain/ad_award[].award_status/vip_hour
 *  - 广告累计时长         /youth/v1/ad/get_ad_vip_time  → vip_time
 *  - 听歌福利             /youth/v1/activity/get_listen_song_task → task_status
 *  - 限时免费领(免费包)   /youth/v1/free_package/get_vip_task    → task_status
 *  - 话题活动             /youth/v1/topic/activity_list
 *  - 活动列表(组队/邀新等)/youth/v2/activity/task_list → stat 参与状态
 * 写操作边界（需真实客户端抓包一次点亮参数后固化，见 manifest）：
 *  set_free_mode / 打卡 clock_in 领取 / 免费包 receive 的精确 body 在 dex 中无字符串 xref（运行时拼装/加密），
 *  静态逆向不可得，插件内不编造字段调用，仅探测状态并提示。
 */
const WELFARE_TTL = 5 * 60 * 1000;
function welfareProbe() {
  const state = capture();
  if (!state) return null;
  async function get(path, base) { return http({ state, path, method: 'get', base: base || BASE }); }
  const item = async (path, pick, base) => {
    try {
      const r = await get(path, base);
      const j = (r && r.json && typeof r.json === 'object' && r.json.data && typeof r.json.data === 'object')
        ? r.json.data : (r && r.json && typeof r.json === 'object' ? r.json : null);
      return j ? pick(j, r.json) : { unreachable: true };
    } catch (e) { return { unreachable: true }; }
  };
  return {
    freeMode: async () => item('/youth/v1/ad/free_mode_info', (d) => ({
      mode: d.mode_status, award: d.free_mode_award, awardHours: d.award_vip_hour, vipTime: d.vip_time,
    })),
    adBox: async () => item('/youth/v2/ad/play_status', (d) => ({
      done: d.done, remain: d.remain, total: d.total, getVipHour: d.get_vip_hour,
      award: ((d.ad_award && d.ad_award[0]) || null) ? { status: d.ad_award[0].award_status, hour: d.ad_award[0].vip_hour } : null,
    })),
    adTime: async () => item('/youth/v1/ad/get_ad_vip_time', (d) => ({ vipEnd: d.vip_end_time || d.vip_time, serverTime: d.server_time })),
    listen: async () => item('/youth/v1/activity/get_listen_song_task', (d) => ({ status: d.task_status, day: d.day, total: d.receive_total })),
    freePkg: async () => item('/youth/v1/free_package/get_vip_task', (d) => ({ status: d.task_status })),
    topic: async () => item('/youth/v1/topic/activity_list', (d) => ({ list: Array.isArray(d.list) ? d.list.length : 0 })),
    act: async () => item('/youth/v2/activity/task_list', (d) => ({
      // data.list = 分组数组，每组 {task_type_name, task_list:[{task_name,task_stat,...}]}
      groups: Array.isArray(d.list) ? d.list.length : 0,
      participating: (function () {
        let n = 0, taskCount = 0;
        if (Array.isArray(d.list)) { d.list.forEach((g) => { if (g && Array.isArray(g.task_list)) { g.task_list.forEach((t) => { if (t && typeof t === 'object') { taskCount++; if (t.task_stat) n++; } }); } }); }
        return n;
      })(),
    })),
    // v5.3.0 每日抽奖：/yutc/youth/v1/lottery/info 只读状态（chances 机会/coins/今日已抽/gifts 奖项池）
    // v5.9.1：与 fetchLotteryInfo 重复的解析收口到公共 pickLotteryState
    lottery: async () => item('/yutc/youth/v1/lottery/info', (d) => pickLotteryState(d)),
  };
}
// 并行探测（软失败：任一项失败不阻断整体），结果供面板展示与巡检提示
async function probeWelfare() {
  const state = capture();
  if (!state) return null;
  if (lastWelfare && Date.now() - welfareAt < WELFARE_TTL) return lastWelfare;
  try {
    const p = welfareProbe();
    const [freeMode, adBox, adTime, listen, freePkg, act, lottery] = await Promise.all([
      p.freeMode().catch(() => ({ unreachable: true })),
      p.adBox().catch(() => ({ unreachable: true })),
      p.adTime().catch(() => ({ unreachable: true })),
      p.listen().catch(() => ({ unreachable: true })),
      p.freePkg().catch(() => ({ unreachable: true })),
      p.act().catch(() => ({ unreachable: true })),
      p.lottery().catch(() => ({ unreachable: true })),
    ]);
    lastWelfare = { at: Date.now(), freeMode, adBox, adTime, listen, freePkg, act, lottery };
    if (lottery && !lottery.unreachable) { lotteryInfo = lottery; lotteryAt = Date.now(); }
    welfareAt = Date.now();
    return lastWelfare;
  } catch (e) { log({ ev: 'welfare-err', err: String(e) }); return null; }
}

/* ---------------- v5.7.0 concepts 域写接口：条件触发（方案B） ---------------- */
// 原则：有资格才领、无资格跳过。仅当探测状态显示「可领」才提交写接口；
// 当前账号（已会员 / 非随心包）资格缺失即跳过，会员过期或开通随心包后自动生效。
// 已实机定形：
//   POST concepts.kugou.com/v1/free_mode/receive_vip?business=auto_send（免费模式粉小宝箱）
//     - 免费模式未开启(mode_status=0) / 本周期已领 → 跳过
//     - 会员身份 → 39403「已是会员，无法领取」→ 当日拉黑不再重复
//   POST gateway.kugou.com/youth/v1/free_package/receive_vip_award body={}（限时免费领/随心包）
//     - get_vip_task task_status=1（任务达标）才领
//     - 非随心包 → 130011「用户不是随心包会员」→ 当日拉黑不再重复
let conceptClaimSkip = {}; // { key: todayStr() }：当日已确认无资格的渠道
async function runConceptClaims() {
  const state = capture();
  if (!state) { lastStatusUid = null; lastBusi = null; lastVips = {}; return null; }
  const tk = todayStr();
  const out = { at: Date.now(), fm: null, fp: null };
  // v5.8.0：会员时长前置短路——先只读刷新当前账号会员状态（启动巡检/切号均按需触发），
  // 会员未过期时两个写接口必无收益（free_mode/receive_vip 会员领=39403，free_package 免费包
  // 与概念会员不叠加），直接整体跳过、不做探测；会员过期/无时长账号自动走下方原条件触发。
  // 跳过不写当日锁：同一账号会员过期后当日稍后仍可正常领取，不会被误锁。
  if (lastStatusUid !== state.userid || Date.now() - lastStatusAt > 60000) {
    await refreshMemberStatus().catch(() => {});
  }
  if (lastStatusUid === state.userid && memberActive(lastBusi && lastBusi.vip_end_time)) {
    out.fm = { skip: '会员未过期，无需领取' };
    out.fp = { skip: '会员未过期，无需领取' };
    lastConceptClaim = out; lastConceptClaimAt = Date.now();
    return out;
  }
  // 1) 免费模式粉小宝箱
  if (conceptClaimSkip.fm !== tk) {
    try {
      const fm = await welfareProbe().freeMode().catch(() => null);
      if (fm && !fm.unreachable && fm.mode === 1 && fm.award) {
        const r = await http({
          state, base: CONCEPTS_BASE, path: '/v1/free_mode/receive_vip', method: 'post',
          biz: { business: 'auto_send' }, headers: { 'content-type': 'application/json; charset=utf-8' },
        });
        const j = (r && r.json && typeof r.json === 'object') ? r.json : {};
        out.fm = { ok: String(j.status) === '1', code: j.error_code, msg: j.msg || j.error_msg, raw: j };
        log({ ev: 'concept-fm', body: j });
        if (typeof j.error_code === 'number' && [39403, 50003, 304001, 39401].indexOf(j.error_code) >= 0) conceptClaimSkip.fm = tk;
      } else {
        conceptClaimSkip.fm = tk;
        out.fm = { skip: fm && !fm.unreachable ? (fm.mode !== 1 ? '免费模式未开启(需客户端)' : '本周期已领') : '探测失败' };
      }
    } catch (e) { out.fm = { err: String(e) }; }
  } else { out.fm = { skip: '当日已确认无资格' }; }
  // 2) 限时免费领（随心包）
  if (conceptClaimSkip.fp !== tk) {
    try {
      const fp = await welfareProbe().freePkg().catch(() => null);
      if (fp && !fp.unreachable && fp.status === 1) {
        const r = await http({
          state, path: '/youth/v1/free_package/receive_vip_award', method: 'post',
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }, {});
        const j = (r && r.json && typeof r.json === 'object') ? r.json : {};
        out.fp = { ok: String(j.status) === '1', code: j.error_code, msg: j.msg || j.error_msg, raw: j };
        log({ ev: 'concept-fp', body: j });
        if (typeof j.error_code === 'number' && [130011, 50003].indexOf(j.error_code) >= 0) conceptClaimSkip.fp = tk;
      } else {
        conceptClaimSkip.fp = tk;
        out.fp = { skip: fp && !fp.unreachable ? '任务未达标(随心包)' : '探测失败' };
      }
    } catch (e) { out.fp = { err: String(e) }; }
  } else { out.fp = { skip: '当日已确认无资格' }; }
  lastConceptClaim = out; lastConceptClaimAt = Date.now();
  return out;
}
function fmtConceptClaim() {
  if (!lastConceptClaim) return '未触发（会员过期/开通随心包后将自动领取）';
  const p = [];
  if (lastConceptClaim.fm) p.push('宝箱:' + (lastConceptClaim.fm.skip || (lastConceptClaim.fm.ok ? '已领' : ('code=' + lastConceptClaim.fm.code))));
  if (lastConceptClaim.fp) p.push('免费领:' + (lastConceptClaim.fp.skip || (lastConceptClaim.fp.ok ? '已领' : ('code=' + lastConceptClaim.fp.code))));
  return p.length ? p.join('；') : '已检查无资格';
}

/* ---------------- 调试日志：console + localStorage ---------------- */
function log(o) {
  try { console.log('[sign]', JSON.stringify(o)); } catch (e) {}
  try {
    const a = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    a.push(Object.assign({ at: Date.now() }, o));
    localStorage.setItem(LOG_KEY, JSON.stringify(a.slice(-200)));
  } catch (e) {}
}
function fmtRaw(r) {
  try {
    const j = (r && r.json && typeof r.json === 'object') ? r.json : (r || {});
    return JSON.stringify(j).slice(0, 320) || '无';
  } catch (e) { return '无'; }
}

/* ---------------- 概念版图标（日历来签到，与会员状态条视觉一致） ---------------- */
const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
  '<defs><linearGradient id="kcs-bg" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#2f6fee"/><stop offset="1" stop-color="#1b4fd0"/></linearGradient></defs>' +
  '<rect x="2" y="2" width="60" height="60" rx="16" fill="url(#kcs-bg)"/>' +
  '<circle cx="48" cy="18" r="8" fill="rgba(255,255,255,.14)"/>' +
  '<rect x="14" y="12" width="36" height="40" rx="8" fill="#fff"/>' +
  '<rect x="20" y="12" width="24" height="9" rx="4" fill="#2f6fee"/>' +
  '<rect x="20" y="27" width="24" height="3.5" rx="1.75" fill="#c6d4f7"/>' +
  '<rect x="20" y="35" width="24" height="3.5" rx="1.75" fill="#c6d4f7"/>' +
  '<rect x="20" y="43" width="14" height="3.5" rx="1.75" fill="#c6d4f7"/>' +
  '<circle cx="44" cy="41" r="9" fill="#31cfa1" stroke="#fff" stroke-width="3.5"/>' +
  '<path d="M40 41l3 3 5-6" fill="none" stroke="#0b5c45" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_DATA_URI = 'data:image/svg+xml;utf8,' + encodeURIComponent(ICON_SVG);
// 小尺寸行内日历图标（用于状态条 / 面板标题，随 currentColor 变色）
const ICON_INLINE =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0">' +
  '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>';

/* ---------------- MD5（RFC 1321 标准实现） ---------------- */
function md5(s) {
  function toUTF8Bytes(str) {
    var out = [], i, c, c2, c3;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else if (c >= 0xd800 && c <= 0xdbff) {
        c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          c3 = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(0xf0 | (c3 >> 18), 0x80 | ((c3 >> 12) & 0x3f), 0x80 | ((c3 >> 6) & 0x3f), 0x80 | (c3 & 0x3f));
          i++;
        } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return out;
  }
  var msg = toUTF8Bytes(s);
  var origLenBits = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  var low = origLenBits >>> 0, high = Math.floor(origLenBits / 0x100000000) >>> 0, b;
  for (b = 0; b < 4; b++) msg.push((low >>> (8 * b)) & 0xff);
  for (b = 0; b < 4; b++) msg.push((high >>> (8 * b)) & 0xff);
  var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  var sft = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function add32(x, y) {
    var l = (x & 0xffff) + (y & 0xffff);
    var m = (x >> 16) + (y >> 16) + (l >> 16);
    return (m << 16) | (l & 0xffff);
  }
  for (var off = 0; off < msg.length; off += 64) {
    var M = new Array(16), j;
    for (j = 0; j < 16; j++) {
      M[j] = msg[off + 4 * j] | (msg[off + 4 * j + 1] << 8) | (msg[off + 4 * j + 2] << 16) | (msg[off + 4 * j + 3] << 24);
    }
    var A = a0, B = b0, C = c0, D = d0;
    for (var ii = 0; ii < 64; ii++) {
      var F, g;
      if (ii < 16) { F = (B & C) | (~B & D); g = ii; }
      else if (ii < 32) { F = (D & B) | (~D & C); g = (5 * ii + 1) % 16; }
      else if (ii < 48) { F = B ^ C ^ D; g = (3 * ii + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * ii) % 16; }
      var T = Math.floor(Math.abs(Math.sin(ii + 1)) * 4294967296);
      F = add32(add32(F, A), add32(M[g], T));
      var tmp = D; D = C; C = B;
      B = add32(B, rol(F, sft[Math.floor(ii / 16) * 4 + (ii % 4)]));
      A = tmp;
    }
    a0 = add32(a0, A); b0 = add32(b0, B); c0 = add32(c0, C); d0 = add32(d0, D);
  }
  function w2hex(w) {
    var h = '';
    for (var k = 0; k < 4; k++) { h += ('0' + ((w >>> (8 * k)) & 0xff).toString(16)).slice(-2); }
    return h;
  }
  return w2hex(a0) + w2hex(b0) + w2hex(c0) + w2hex(d0);
}
function safeParse(t) { try { return JSON.parse(t); } catch (e) { return null; } }

/* ---------------- 登录态读取（renderer pinia） ---------------- */
function capture() {
  try {
    const us = ctxRef.pinia && ctxRef.pinia._s && ctxRef.pinia._s.get('user');
    const de = ctxRef.pinia && ctxRef.pinia._s && ctxRef.pinia._s.get('device');
    const ui = (us && (us.info || (us.$state && us.$state.info))) || null;
    const di = (de && (de.info || (de.$state && de.$state.info))) || null;
    if (!ui || !ui.token || !ui.userid) return null;
    return {
      token: ui.token,
      userid: String(ui.userid),
      nickname: ui.nickname || '用户' + ui.userid,
      dfid: (di && di.dfid) || '',
      mid: di ? String(di.mid || '') : '',
    };
  } catch (e) { return null; }
}

/* ---------------- 签名与请求 ---------------- */
function sign(params, dataStr) {
  const ks = Object.keys(params).sort();
  let ps = '';
  for (const k of ks) ps += k + '=' + params[k];
  return md5(SALT_LITE + ps + dataStr + SALT_LITE);
}
function qs(p) {
  return Object.keys(p).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(p[k])).join('&');
}
function normalize(res) {
  if (!res || typeof res !== 'object') return { raw: res };
  const out = { ok: !!(res.ok !== false && (res.status >= 200 && res.status < 400 || !res.status)), status: res.status, via: 'net', raw: res };
  let j = null;
  if (typeof res.data === 'string') j = safeParse(res.data);
  else if (res.data && typeof res.data === 'object') j = res.data;
  else if (typeof res.body === 'string') j = safeParse(res.body);
  else if (res.body && typeof res.body === 'object') j = res.body;
  else if (typeof res.text === 'string') j = safeParse(res.text);
  if (j) out.json = j;
  return out;
}
let reqSeq = 0; // 网络桥 requestId 递增序号（v5.0.1 修复）
// v5.9.0：全通道统一超时（毫秒），防止网络挂死长时间阻塞 5 分钟调度器
const NET_TIMEOUT = 12000;
async function http(opt, body) {
  const st = opt.state;
  const clienttime = Math.floor(Date.now() / 1000);
  const p = {
    dfid: st.dfid, mid: st.mid, uuid: '-', appid: APPID,
    clientver: opt.clientver || APP_VER, clienttime, token: st.token, userid: st.userid,
  };
  if (opt.biz) Object.assign(p, opt.biz);
  const dataStr = body ? JSON.stringify(body) : '';
  p.signature = sign(p, dataStr);
  const url = (opt.base || BASE) + opt.path + '?' + qs(p);
  const hdrs = {
    'User-Agent': opt.ua || UA, dfid: st.dfid, clienttime: String(clienttime),
    mid: st.mid, 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  };
  if (opt.headers) Object.assign(hdrs, opt.headers);

  // 通道 A：官方插件网络桥（受限沙箱、不泄露 referer）。
  // ⚠️ v5.0.2：带 JSON body 的 POST 禁用桥通道——实机校准发现桥对 body 的序列化与
  // 服务端签名校验的 body 原文不一致，会返回 20006「err signature」；fetch 直接发送
  // dataStr 原样字符串，签名必然一致。无 body 的请求（get_union_vip / receive 等）仍走桥。
  const net = typeof window !== 'undefined' && window.electron && window.electron.plugins && window.electron.plugins.net;
  if (net && typeof net.request === 'function' && !body) {
    // v5.0.1 修复：主进程 handler 契约为 (event, pluginId, requestId, options, body)，
    // 旧实现把对象误放 requestId 位、body 放 options 位导致 options 无 url 抛「网络请求 URL 无效」。
    // 现按 requestId(options)body 顺序正确传参，requestId 用递增序号避免复读。
    let tid = null;
    try {
      const timer = new Promise((_, rej) => { tid = setTimeout(() => rej(new Error('net-bridge-timeout')), NET_TIMEOUT); });
      const res = await Promise.race([
        net.request(PLUGIN_ID, String(++reqSeq), { url, method: (opt.method || 'get').toLowerCase(), headers: hdrs }, body || undefined),
        timer,
      ]);
      clearTimeout(tid); tid = null;
      const n = normalize(res);
      if (n.json || n.raw || !res) return n;
    } catch (e) {
      if (tid) { clearTimeout(tid); tid = null; }
      log({ ev: 'net-bridge-fail', err: String(e) });
    }
  }
  // 通道 B：renderer fetch 直连（兜底）
  let ac = null;
  try {
    const fetchOpt = { method: (opt.method || 'get').toUpperCase(), headers: hdrs };
    if (body) fetchOpt.body = dataStr;
    if (typeof AbortController !== 'undefined') {
      ac = new AbortController();
      fetchOpt.signal = ac.signal;
      setTimeout(() => ac && ac.abort(), NET_TIMEOUT);
    }
    const fr = await fetch(url, fetchOpt);
    const text = await fr.text();
    return { ok: fr.ok, status: fr.status, via: 'fetch', json: safeParse(text), text };
  } catch (e) {
    return { ok: false, via: 'fail', err: String((e && e.message) || e) };
  } finally {
    ac = null;
  }
}

/* ---------------- 业务：工具函数 ---------------- */
function extractBusi(vip) {
  if (!vip || typeof vip !== 'object') return {};
  const data = vip.data || vip;
  let bv = data.busi_vip;
  if (Array.isArray(bv) && bv.length) return bv[0];
  if (bv && typeof bv === 'object') return bv;
  return data && typeof data === 'object' ? data : {};
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dayStrOf(delta) {
  const d = new Date();
  d.setDate(d.getDate() + (delta || 0));
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isToday(ts) { return typeof ts === 'string' && ts.indexOf(todayStr()) === 0; }
/* v5.0.2 今日已领标记：vip_clearday 实为「最近一次入账日」而非「今日已领」布尔，
 * 服务端对今日额度的判定在领取接口 error_code=131001（今日已领）/ status=1（成功）。
 * 故以本地记录 claimday:<uid> == 今天 为准，避免 UI/调度误判导致反复请求与状态不变。 */
let claimTodayFlag = false;
async function loadClaimToday(uid) { try { return (await ctxRef.storage.get('claimday:' + uid)) === todayStr(); } catch (e) { return false; } }
async function markClaimToday(uid) { claimTodayFlag = true; try { await ctxRef.storage.set('claimday:' + uid, todayStr()); } catch (e) {} }
// v6.3.0（Luo）修 R1：每日签到(signon)与每日 VIP 领取原来共用 'claimday:<uid>' 标记互相污染，
// signon 先落标会误短路 runSignIn 的 claimday 判定导致 VIP 漏领。现拆独立 key 'signon_day:<uid>'，
// 供 runDailySignon 落标；runSignIn 的短路与落标继续用 claimday。<uid> 语义唯一。
async function loadSignonDay(uid) { try { return (await ctxRef.storage.get('signon_day:' + uid)) === todayStr(); } catch (e) { return false; } }
async function markSignonDay(uid) { try { await ctxRef.storage.set('signon_day:' + uid, todayStr()); } catch (e) {} }
function splitVips(data) {
  let bv = data && data.busi_vip;
  if (!Array.isArray(bv)) bv = bv && typeof bv === 'object' ? [bv] : [];
  const out = {};
  (bv || []).forEach((b) => { if (b && b.product_type) out[b.product_type] = b; });
  return out;
}

// v5.6.0：会员到期天数倒计时——vip_end_time 支持秒/毫秒时间戳或日期字符串，
// 空/0 视为无时长；天数按到期时刻与当前时刻之差向上取整到天
// v5.9.1：秒/毫秒时间戳或日期字符串解析统一收口到 toMs，消除 fmtVipEnd 与 memberActive 的重复解析
function toMs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v > 100000000000 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 100000000000 ? n : n * 1000; }
  const mk = new Date(s);
  return !isNaN(mk.getTime()) ? mk.getTime() : NaN;
}
function fmtVipEnd(v) {
  if (!v || String(v).trim() === '') return '无时长';
  const ms = toMs(v);
  if (isNaN(ms)) return '无时长';
  const end = new Date(ms);
  const left = Math.ceil((ms - Date.now()) / 86400000);
  const ymd = end.getFullYear() + '-' + String(end.getMonth() + 1).padStart(2, '0') + '-' + String(end.getDate()).padStart(2, '0');
  if (left < 1) return '已过期';
  return '到期 ' + left + ' 天后（' + ymd + '）';
}

// v5.6.0 最近一次成功 checkStatus 的时间戳（毫秒），供状态条/调度器判断是否需刷新
let lastStatusAt = 0;
// v5.8.0：最近一次成功 checkStatus 的账号 uid，供切号识别与会员时长短路判断
let lastStatusUid = null;
// v5.8.0：会员时长是否在有效期内（vip_end_time 在未来）。秒/毫秒时间戳或日期字符串均可解析
function memberActive(v) {
  if (v == null || String(v).trim() === '' || v === 0) return false;
  const ms = toMs(v);
  return !isNaN(ms) && ms > Date.now();
}
// v5.6.0：只读刷新会员状态缓存（不触发任何写操作），供面板/状态条天数倒计时使用
async function refreshMemberStatus() {
  const st = capture();
  if (!st) { lastStatusUid = null; lastBusi = null; lastVips = {}; return false; }
  try {
    const r = await checkStatus(st);
    if (r.ok) {
      lastBusi = r.busi;
      lastVips = r.vips || {};
      lastStatusAt = Date.now();
      lastStatusUid = st.userid;
      return true;
    }
  } catch (e) { log({ ev: 'status-refresh-err', err: String(e) }); }
  return false;
}

/* ---------------- 会员领取链路（仅产出会员时长） ---------------- */
async function checkStatus(state) {
  const r = await http({ state, base: VIP_BASE, path: '/v1/get_union_vip', method: 'get', biz: { busi_type: 'concept' } });
  if (r.json && r.json.status === 1) {
    const data = r.json.data && typeof r.json.data === 'object' ? r.json.data : {};
    return { ok: true, busi: extractBusi(data), vips: splitVips(data), raw: r.json };
  }
  return { ok: false, raw: r };
}
async function reportListen(state) {
  return http({ state, path: '/youth/v2/report/listen_song', method: 'post', clientver: 10566, ua: UA_REPORT, headers: { 'content-type': 'application/json; charset=utf-8' } }, { mixsongid: 666075191 });
}
// 领取当日概念版 VIP：receive_day 必须为当天 YYYY-MM-DD（历史版本误传 '1' 会报 304001 日期格式错误）
async function doReceive(state) {
  return http({
    state, path: '/youth/v1/recharge/receive_vip_listen_song', method: 'post',
    biz: { source_id: 90139, receive_day: todayStr() },
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  }, null);
}

/* ---------------- 看广告领取 VIP（会员时长） ---------------- */
async function adReport(state) {
  const now = Date.now();
  return http({
    state, path: '/youth/v1/ad/play_report', method: 'post',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }, { ad_id: AD_ID, play_end: now, play_start: now - 30000 });
}
// 批量看广告领取：逐支上报直到次数用光（30002）/今日已领（130012）。
// v6.2.0：上限以 play_status.remain 动态扩量（不低于 AD_MAX 保底），跑完预估额度仍一路
// 成功时（服务端动态补额）读一次最新 remain 续跑，AD_SAFE_CAP 防死循环；遇未知/风控类
// 错误码进 30 分钟渠道冷却，不再让调度器每 5 分钟重撞接口。
async function runAdClaim() {
  // v6.2.1：防重入——扩量后单轮最长约 20×30s=600s 超过调度器 300s 周期，防止上一轮未结束
  // 下一轮 tick 又发起并发双循环（各自独立 upper/count、共享 lastAdResult，可能重复上报）
  if (adBusy) return { ok: false, count: 0, done: false, busy: true };
  adBusy = true;
  try {
    const state = capture();
    if (!state) { toastErr('未登录：请先登录酷狗账号'); return { ok: false, count: 0, done: false }; }
    if (Date.now() < cooldown.ad) {
      const waitMin = Math.ceil((cooldown.ad - Date.now()) / 60000);
      toastInfo('看广告处于风控冷却中，约 ' + waitMin + ' 分钟后自动恢复');
      return { ok: false, count: 0, done: false, cooldown: true };
    }
  let count = 0, stop = '';
  let upper = AD_MAX;
  const refreshUpper = async () => {
    try {
      const box = await welfareProbe().adBox().catch(() => null);
      const remain = box && !box.unreachable ? Number(box.remain) : NaN;
      if (!isNaN(remain) && remain >= 0) upper = Math.max(upper, Math.min(remain, AD_SAFE_CAP));
      return !isNaN(remain) && remain > 0;
    } catch (e) { return true; }
  };
  await refreshUpper();
  for (let i = 1; i <= AD_SAFE_CAP; i++) {
    if (i > upper && !(await refreshUpper())) break; // 跑完预估仍一路成功 → 刷新 remain；无额度则收尾
    const r = await adReport(state);
    log({ ev: 'ad#' + i, body: (r.json && typeof r.json === 'object') ? r.json : r.raw });
    const j = (r.json && typeof r.json === 'object') ? r.json : {};
    if (String(j.status) === '1') {
      count++;
      toastOk('看广告 +1 天 VIP（第 ' + i + ' 次），今日累计 ' + count + ' 天 VIP');
      await sleep(AD_GAP);
    } else if (j.error_code === 30002) { stop = '今日次数已用光'; toastInfo('今日看广告领取次数已用光'); break; }
    else if (j.error_code === 130012) { stop = '该广告今日已领取'; toastInfo('该广告今日已领取'); break; }
    else {
      const code = j.error_code;
      const msg = (j.msg || j.error_msg) || ('error_code=' + code) || JSON.stringify(j).slice(0, 120);
      if (typeof code === 'number' && KNOWN_DONE_CODES.has(code)) {
        // 已知完成/不可领码：当日结束但非风控，不触发冷却
        stop = '今日不可再领取：' + msg;
        toastInfo('看广告领取停止：' + msg);
      } else if (typeof code !== 'number') {
        // v6.2.1（Luo）：网络/解析异常（error_code 为 undefined/null）≠ 风控，与 claimOneTask
        // 对齐：不设冷却、不误导提示，仅收尾，调度器下轮可重试。
        stop = '网络异常（无 error_code，下轮自动重试）';
        toastInfo('看广告网络异常：' + msg);
        log({ ev: 'ad-net-err', code, msg });
      } else {
        // 未知错误码（含风控/频繁类）→ 当日短冷却，调度器冷却期内不再重撞
        cooldown.ad = Date.now() + WINDOW_COOLDOWN_MS;
        stop = '疑似风控，' + Math.round(WINDOW_COOLDOWN_MS / 60000) + ' 分钟后重试';
        toastErr('广告领取疑似风控：' + msg);
        log({ ev: 'ad-cooldown', code, msg });
      }
      break;
    }
  }
    lastAdResult = { count, stop: stop || (count > 0 ? '达到本次预估上限' : '') };
    // v6.3.0（Luo）修 R2：手动按钮路径（runMember）调 runAdClaim 后不写当日锁，会致调度器
    // autoAd 下轮整链重跑。此处成功/已领/达上限即回写 lastAutoDate.ad，与调度器判定一致；
    // 风控/网络异常不写锁（冷却或下轮可重试）。
    if (count > 0 || stop === '今日次数已用光' || stop === '该广告今日已领取' || (stop && stop.indexOf('今日不可再领取') === 0)) lastAutoDate.ad = todayKey();
    // done=true 表示"今日额度已用尽/已领"，调度器据此当日不再重复请求
    return { ok: count > 0, count, done: stop === '今日次数已用光' || stop === '该广告今日已领取' || (stop && stop.indexOf('今日不可再领取') === 0) };
  } finally {
    adBusy = false;
  }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmtAdResult() {
  if (!lastAdResult) return '';
  if (!lastAdResult.count && lastAdResult.stop) return '未领取成功：' + lastAdResult.stop;
  return '看广告共 +' + lastAdResult.count + ' 天 VIP' + (lastAdResult.stop ? '（' + lastAdResult.stop + '）' : '');
}

/* ---------------- 每日抽奖（福利中心 lottery，taskid=1107） ---------------- */
/* v5.3.0 实测打通（纯 PC 直调，同 /yutc/ 签名体系，无需真机）：
 *   - /yutc/youth/v1/lottery/info 只读：state.chances / state.coins / state.done_count /
 *     profile._gifts（奖项池，type=coin 命中直接到账概念币）
 *   - /yutc/youth/v1/task/submit body={taskid:1107, source:'draw', lottery_pool:[{id,type,num}]}
 *     消耗 1 次机会抽奖，成功直接入账（实测命中 20 币：coins 220→240、done_count 2→3）
 *   - lottery/exchange(way=view/ad/coin) 三种均实测返回 status=1 但机会不变：view/ad 依赖
 *     原生 uni SDK 真实浏览/广告成效回执(traceid)，coin 需服务端支付会话判定；纯接口无法伪造，
 *     加次数只能靠手机概念版真实浏览/看广告。插件仅展示机会并引导，不编造成效调用。 */
const LOTTERY_TASKID = 1107;
// v5.9.1：抽奖状态解析公共收口（state+profile），welfareProbe.lottery 与 fetchLotteryInfo 共用
function pickLotteryState(d) {
  const st = (d && d.state) || {}, pr = (d && d.profile) || {};
  return {
    chances: (st.lottery && st.lottery.chances != null) ? st.lottery.chances : 0,
    coins: st.coins != null ? st.coins : (pr.coins != null ? pr.coins : 0),
    done: st.done_count || 0, maxDone: st.max_done_count || 0,
    exchangeCoins: pr.exchange_coins,
    gifts: Array.isArray(pr._gifts) ? pr._gifts.map((g) => ({ id: g.id, type: g.type, num: g.num, name: g.name || '' })) : [],
  };
}
async function fetchLotteryInfo() {
  const state = capture();
  if (!state) return null;
  try {
    const r = await http({ state, path: '/yutc/youth/v1/lottery/info', method: 'get' });
    const j = (r && r.json && typeof r.json === 'object') ? r.json : null;
    if (!j || j.errcode !== 0 || !j.data) return null;
    const info = pickLotteryState(j.data); // v5.9.1：与 welfareProbe.lottery 共用解析
    lotteryInfo = info; lotteryAt = Date.now();
    return info;
  } catch (e) { log({ ev: 'lottery-info-err', err: String(e) }); return null; }
}
/* v5.4.0 自动连抽：机会>0 时把抽奖次数全部抽完（并入概念币签到链路）。
 * v5.9.1：移除 v5.3.0「一键抽奖」runLottery/fmtLotteryResult/giftTypeText——v5.5.0 起独立
 * 抽奖按钮已并入「概念币签到」（机会>0 自动连抽），其面板入口 runLot 与 lotBusy/lotRes/lotInfo
 * 一并清理，连抽结果由面板静态说明，杜绝两套抽奖路径并存。
 * 只消耗已有机会，绝不兑换概念币；循环有 SAFE_MAX 防死循环，遇失败/达上限即停。 */
async function autoDrawAllChances() {
  const state = capture();
  if (!state) return { ok: false, skipped: true, drew: 0 };
  const SAFE_MAX = 20;
  let info;
  try { info = await fetchLotteryInfo(); } catch (e) { return { ok: false, skipped: true, drew: 0 }; }
  if (!info) return { ok: false, skipped: true, drew: 0 };
  if ((info.chances || 0) < 1) return { ok: false, skipped: true, drew: 0 };
  if (!info.gifts.length) return { ok: false, skipped: false, drew: 0, err: '奖项池为空' };
  const pool = info.gifts.map((g) => ({ id: g.id, type: g.type, num: g.num, ...(g.name ? { name: g.name } : {}) }));
  let drew = 0, total = info.coins;
  for (let i = 0; i < SAFE_MAX; i++) {
    if ((info.chances || 0) < 1) break;
    try {
      const r = await http({ state, path: '/yutc/youth/v1/task/submit', method: 'post' }, { taskid: LOTTERY_TASKID, source: 'draw', lottery_pool: pool });
      const j = (r && r.json && typeof r.json === 'object') ? r.json : null;
      if (!j || j.errcode !== 0 || !j.data) break; // 非零/失败即停（含 61016 次数用尽）
      const st2 = j.data.state || {};
      total = st2.coins != null ? st2.coins : total;
      drew++;
      info = { ...info, chances: (st2.lottery && st2.lottery.chances != null) ? st2.lottery.chances : 0, coins: st2.coins != null ? st2.coins : info.coins };
      await sleep(400);
    } catch (e) { break; }
  }
  if (drew > 0) { lotteryInfo = info; lotteryAt = Date.now(); return { ok: true, drew, coins: total }; }
  return { ok: false, skipped: false, drew: 0 };
}

/* ---------------- 活动渠道自动化：profile 任务定义拉取与解析 ---------------- */
/* 通过已证实的 /yutc/youth/v1/system/profile 拉取任务定义，多路径防御性解析出
 * 「可直领的概念币任务(taskid+名称)」与「产出会员时长/VIP 的任务」；动态解析全部
 * try/catch 兜底，解析失败静默回退静态 COIN_TASKS 渠道，绝不报错、绝不编造未验证字段。 */
const DYN_TTL = 10 * 60 * 1000; // profile 缓存有效期
let dynCache = null;   // { coinTasks:[{id,name}], vipTasks:[{id,name}] }
let dynCacheAt = 0;    // 缓存时间戳
let lastVipTaskRaw = null; // 最近一次会员任务提交原始响应（供面板排查）
let lastSignonRaw = null;  // v5.1.0 最近一次每日签到(signon)原始响应（供面板排查）
// v5.0.1：动态任务失败黑名单——profile 解析出的任务若 submit 返回非 0 且非「已达上限」错误
// （如 11005 领取失败/任务状态已更新），说明该 taskid 本会话内不可直领，加入黑名单跳过，
// 避免每轮巡检盲目反复提交刷租日志；缓存过期重建时一并清空，确保次日/重置后可重新尝试。
// v6.0.0：黑名单改为按账号隔离（Map<uid, Set<taskid>>）——切号后新账号不受上一账号黑名单
// 影响，再次点击「概念币签到」即可重新签满该账号；未取到 uid 时兜底 allBlock（不应发生）。
const dynBlock = new Map(); // uid -> Set<taskid>
let dynBlockAt = 0;
const allBlock = new Set(); // 未取到 uid 时的兜底黑名单
function blockOf(uid) {
  if (!uid) return allBlock;
  let s = dynBlock.get(uid);
  if (!s) { s = new Set(); dynBlock.set(uid, s); }
  return s;
}

async function fetchProfile() {
  const state = capture();
  if (!state) return null;
  try {
    const r = await http({ state, path: '/yutc/youth/v1/system/profile', method: 'get' });
    return (r && r.json && typeof r.json === 'object') ? r.json : null;
  } catch (e) { log({ ev: 'profile-err', err: String(e) }); return null; }
}
function parseProfileFlow(json) {
  // 多路径防御性解析任务数组；解析失败返回 null（调用方回退静态渠道，不报错）
  if (!json || typeof json !== 'object') return null;
  try {
    const data = (json.data && typeof json.data === 'object') ? json.data : json;
    const arrs = [
      data.tasks, data.task_list, data.taskList, data.activities, data.list,
      data.items, data.task_info, data.taskInfo, data.user_tasks, data.reward_tasks,
    ];
    let tasks = null;
    for (const a of arrs) { if (Array.isArray(a) && a.length) { tasks = a; break; } }
    if (!tasks && data && typeof data === 'object') {
      // 兜底：遍历任意数组字段，仅当元素形似任务对象时采纳
      for (const k of Object.keys(data)) {
        const v = data[k];
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' &&
            ('taskid' in v[0] || 'task_id' in v[0] || 'award_coins' in v[0] || ('award' in v[0] && 'name' in v[0]))) { tasks = v; break; }
      }
    }
    if (!Array.isArray(tasks) || !tasks.length) return null;
    const coinTasks = [], vipTasks = [], signTasks = [];
    for (const t of tasks) {
      if (!t || typeof t !== 'object') continue;
      // v5.1.0：未开放(open=0)/已下线(offline=1) 的任务跳过——实测应用评分(2013)、青春认证(2010)、
      // 分享故事(2004)、开通音乐馆(2009)、我页入口广告(2022) 等 open=0 任务 submit 只会返回失败，
      // 过去会让 runCoinClaim 在首个任务即 break，导致其后 9/45/1139 等可直领任务全部被跳过（漏领根因）
      if (t.open === 0 || t.offline === 1) continue;
      const rawId = (t.taskid != null && t.taskid !== '') ? t.taskid
        : (t.task_id != null && t.task_id !== '') ? t.task_id
        : (t.id != null && t.id !== '') ? t.id : null;
      const id = rawId == null ? null : Number(rawId);
      if (id == null || Number.isNaN(id)) continue;
      const name = String(t.name || t.title || t.task_name || t.taskName || t.task_name_cn || ('任务' + id));
      const awardType = Number(t.award_type ?? t.awardType ?? -1);
      const votext = String(t.reward_type ?? t.rewardType ?? t.award_type ?? t.awardType ?? '') + ' ' +
                     String(t.reward ?? t.award ?? t.award_desc ?? t.desc ?? t.reward_desc ?? '');
      // 奖励类型判定：明确含「会员/时长/天/VIP」且不含币/积分 → 会员任务；其余默认按概念币任务
      const isVip = /会员|时长|vip|VIP|剩余.?天|天数/.test(votext) && !/币|coins?|积分/.test(votext);
      // v5.1.0：每日签到专属任务（award_type=25）→ 拆到 signTasks，走独立 /task/signon，
      // 不再经 task/submit（实测 taskid=1 提交返回 50031「任务不允许提交」并会 break 整条币链）
      if (awardType === 25 || /每日签到|每日打卡|签到得/.test(votext)) signTasks.push({ id, name });
      else if (isVip) vipTasks.push({ id, name });
      else coinTasks.push({ id, name });
    }
    if (!coinTasks.length && !vipTasks.length && !signTasks.length) return null;
    return { coinTasks, vipTasks, signTasks };
  } catch (e) { return null; }
}
async function loadDynTasks() {
  if (dynCache && Date.now() - dynCacheAt < DYN_TTL) return dynCache;
  try {
    const json = await fetchProfile();
    const parsed = parseProfileFlow(json);
    if (parsed) {
      dynCache = parsed; dynCacheAt = Date.now();
      // v6.0.0：仅清空当前账号的黑名单（次日/重置后该账号可重新尝试；不影响其他账号）
      try { const st0 = capture(); blockOf(st0 && st0.userid).clear(); } catch (e) {}
      dynBlockAt = Date.now();
    }
  } catch (e) { /* 解析失败回退静态渠道，不报错 */ }
  return dynCache || null;
}
// 概念币签到任务列表：profile 动态概念币任务 + 静态渠道，按 id 去重
function mergedCoinTasks(dyn) {
  const block = blockOf((capture() || {}).userid); // v6.0.0：按当前账号取黑名单
  const out = [];
  const seen = new Set();
  // v5.4.1：以服务端下发的可重复上限为准（广告/视频类 max_done_count 可变），覆盖硬编码值
  const dynMax = new Map();
  for (const t of ((dyn && dyn.coinTasks) || [])) {
    if (t && t.id != null && Number(t.max) > 0) dynMax.set(t.id, Number(t.max));
  }
  for (const t of ((dyn && dyn.coinTasks) || [])) {
    if (seen.has(t.id)) continue;
    if (block.has(t.id)) continue; // v5.0.1：本账号内已确认不可直领的任务跳过（v6.0.0 按账号隔离）
    seen.add(t.id);
    out.push({ id: t.id, name: t.name, max: dynMax.get(t.id) || 6, dyn: true });
  }
  for (const t of COIN_TASKS) {
    if (seen.has(t.id)) continue;
    if (block.has(t.id)) continue; // v6.2.1：静态渠道同样按账号黑名单过滤（二轮审查回归修复）
    seen.add(t.id);
    const svc = dynMax.get(t.id);
    // 服务端上限更高时跟随服务端，避免写死值漏刷可重复广告/视频额度
    out.push({ id: t.id, name: t.name, max: (svc && svc > t.max) ? svc : t.max });
  }
  return out;
}
// 会员相关签到链路的 profile 会员任务：逐个 task/submit（复用非 0 停止规则）
async function runVipTaskClaim() {
  const dyn = await loadDynTasks();
  const vip = dyn && dyn.vipTasks;
  if (!vip || !vip.length) return null;
  const state = capture();
  if (!state) return null;
  let got = 0;
  for (const t of vip) {
    const r = await http({ state, path: '/yutc/youth/v1/task/submit', method: 'post', headers: { 'content-type': 'application/json; charset=utf-8' } }, { taskid: t.id, is_double: false });
    const j = (r.json && typeof r.json === 'object') ? r.json : {};
    log({ ev: 'viptask#' + t.id, body: j });
    const ok = (j.errcode === 0) || ((j.errcode === undefined || j.errcode === null) && String(j.status) === '1');
    if (ok) {
      got++;
      lastVipTaskRaw = j;
      toastOk('会员任务「' + t.name + '」领取成功');
    } else if (j.errcode === 50003) {
      if (lastVipTaskRaw === undefined || lastVipTaskRaw === null) lastVipTaskRaw = j; // 已达上限：记录并继续
    } else {
      lastVipTaskRaw = j;
      // v5.0.1：会员任务非上限失败（含 11005 状态已更新等）→ 本账号黑名单跳过，防反复重试
      // （v6.0.0：黑名单按账号隔离，切号后新账号不受影响）
      if (j.errcode === 11005 || j.errcode === 11006) blockOf(state.userid).add(t.id);
      break; // 非 50003 错误码：停止后续任务
    }
    await sleep(300);
  }
  return got;
}

/* ---------------- 概念币：独立直领（每日重置可反复叠加） ---------------- */
async function getCoinBalance() {
  const state = capture();
  if (!state) return null;
  const r = await http({ state, path: '/yutc/youth/v1/user/info', method: 'get' });
  if (r.json && String(r.json.status) === '1' && r.json.data && r.json.data.account) {
    const a = r.json.data.account;
    balanceInfo = { balance: Number(a.balance_coins) || 0, total: Number(a.total_coins) || 0, cash: Number(a.cash) || 0 };
    return balanceInfo;
  }
  return null;
}
// v6.0.0：单任务「连续签到至服务端上限」——每次点击都真实调用官方领取接口，不伪造数值。
// 循环不再以本地预估 t.max 提前停领：只要 submit 返回 errcode===0（成功到账）就继续叠加领取，
// 直到服务端返回停止码才中断（50003=今日已达上限、其他非 0=今日已领/不可领/领取失败），
// 遇「已领/不可领/达上限」即视为该任务完成；t.max 仅作为服务端明确 max_done_count 的参考
// （本地值偏低也不阻断——配额耗尽由服务端 50003 兜底返回），COIN_PER_TASK_SAFE 为防死循环兜底。
// 返回 { got, coins, lastStop, lastRaw, exhausted }
const COIN_PER_TASK_SAFE = 80;
async function claimOneTask(state, t) {
  const block = blockOf(state.userid); // v6.0.0：按当前账号拉黑
  let got = 0, coins = 0, lastStop = '', lastRaw = null;
  let exhausted = false; // 被服务端以「已达上限」中断 → 视为当日完成（调度器据此不再轮询）
  let failCnt = 0; // v6.2.1：累计异常错误计数（成功清零，判定独立于错误码序列）
  for (let i = 1; i <= COIN_PER_TASK_SAFE; i++) {
    const r = await http({ state, path: '/yutc/youth/v1/task/submit', method: 'post', headers: { 'content-type': 'application/json; charset=utf-8' } }, { taskid: t.id, is_double: false });
    const j = (r.json && typeof r.json === 'object') ? r.json : {};
    log({ ev: 'coin#' + t.id + '-' + i, body: j });
    if (j.errcode === 0) {
      failCnt = 0; // 成功到账即重置失败计数
      got++;
      if (t.max === 1) break; // v6.3.0 修 R3：一次性任务首次成功即停，消除必补打 1 次的冗余请求
      // v6.x 修复：成功响应金币实际位于 data.awards.coins（本次到账），顶层无 award_coins，
      // 旧实现恒为 0 导致 gotCoins=0 误报「今日渠道已达上限」。多路径兼容取值。
      const winCoin = Number(j.award_coins)
        || (j.data && j.data.awards && Number(j.data.awards.coins))
        || (j.data && j.data.awards && Number(j.data.awards.award))
        || (j.data && j.data.state && Number(j.data.state.last_coins))
        || 0;
      coins += winCoin;
      if (i < COIN_PER_TASK_SAFE) await sleep(400);
    } else {
      const c = j.errcode;
      if (c === 50003) { lastStop = '已达上限'; exhausted = true; }
      else if (c === undefined || c === null) lastStop = '网络异常（无 errcode，下轮可重试）';
      else lastStop = '不可领/领取失败（停止码 ' + c + (j.msg ? ' ' + j.msg : '') + '）';
      lastRaw = j;
      // v6.2.1（Luo）：容错收敛改为「累计失败 ≥3」——v6.2.0 的严格连续同类计数在错误码
      // 交替（如 11005/11006/参数码混杂）时永不到 3，会一路打到 COIN_PER_TASK_SAFE=80 且
      // 不拉黑不冷却（每 5 分钟重演，15→80 恶化）。现每次非 50003 异常错误 failCnt++、
      // 成功清零，累计 3 次即判「真不可领」拉黑；一次性任务（t.max===1）仍首次即停，
      // 网络层无 errcode（c 为 undefined/null）始终不拉黑不计数，下轮可重试。
      // 冷却收窄：渠道级 cooldown.coin 仅由可重复任务（连续领取、异常多为账号级风控）触发；
      // 一次性任务失败多为「该任务今日已领/不可领」，仅 block.add 本 taskid（黑名单在
      // mergedCoinTasks 过滤，下轮自动跳过），不锁全渠道误伤其它可领任务。
      if (c !== undefined && c !== null && c !== 50003) {
        failCnt++;
        if ((t.max == null || t.max > 1) && failCnt < 3) {
          if (i < COIN_PER_TASK_SAFE) await sleep(500);
          continue;
        }
        block.add(t.id);
        const repeatable = t.max == null || t.max > 1;
        if (repeatable && !KNOWN_DONE_CODES.has(c)) cooldown.coin = Date.now() + WINDOW_COOLDOWN_MS;
      }
      break;
    }
  }
  return { got, coins, lastStop, lastRaw, exhausted };
}
/* ---------------- 每日签到（概念币/7天超级奖励）独立接口 ---------------- */
const SIGNON_PATH = '/yutc/youth/v1/task/signon';
const SIGN_STATE_PATH = '/yutc/youth/v1/task/sign_state';
// v6.3.0（Luo）：逆向福利中心 H5（chunk index.2aee6b30 / chunk-2dec）点亮 signon 真实调用：
//   - sign_state(GET)：params={userid,token,appid,from:"client"}，返回 data.list（每项含
//     today/state/code/double_code 等）与 data.profile。今日待签项 today==1 且 state==0，
//     code 即签到提交凭证。
//   - signon(POST)：params={userid,token,appid,from:"client"}，body={code,source,...}。
//     body 最小必填为 code（previously，插件以 GET 无 body 直调 → 服务端 20010「参数
//     错误-body」，是长期点不亮的根源）；H5 签名 signature=md5(salt+k=v排序+data+salt)
//     与插件 SALT_LITE 同源，故直接复用 http() 带 body 的 POST 通道即可。
//   - taskid=1 的每日签到不走 task/submit（返回 50031 不可提交）；H5 内签到统一以
//     taskid=100001 过 check_risk GET 预检后调 signon，本实现以 sign_state 状态直接判定，
//     跳过 check_risk 预检（服务端若强制预检会返回明确错误码，届时再加）。
// 防御式调用：成功即落今日标记，失败仅记日志、绝不阻断概念币链路。
async function runDailySignon() {
  const state = capture();
  if (!state) return { ok: false, why: 'not-login' };
  const biz = { from: 'client' }; // H5 对 sign_state/signon 均显式传 from:"client"
  try {
    // 0) 先 POST 态查询：GET sign_state 拿今日项（today==1）的 state / code
    const sr = await http({ state, path: SIGN_STATE_PATH, method: 'get', biz });
    const sj = (sr.json && typeof sr.json === 'object') ? sr.json : {};
    log({ ev: 'sign_state', body: sj });
    if (String(sj.status) !== '1' || !sj.data || !Array.isArray(sj.data.list)) {
      lastSignonRaw = sj;
      log({ ev: 'signon-failed', note: 'sign_state 未达预期（无 data.list），已跳过不阻断', body: sj });
      return { ok: false, why: 'sign-state-fail', raw: sj };
    }
    let todayItem = null;
    for (const it of sj.data.list) {
      if (it && Number(it.today) === 1) { todayItem = it; break; }
    }
    if (!todayItem) {
      log({ ev: 'signon', note: 'sign_state 未返回 today==1 的今日签到项，已跳过', body: sj });
      return { ok: false, why: 'no-today-item', raw: sj };
    }
    if (Number(todayItem.state) === 1) {
      // 今日已签：落本地标记防止反复请求（与 v5.0.2 claimday 语义一致）
      await markSignonDay(state.userid);
      lastSignonRaw = sj;
      log({ ev: 'signon', note: '今日已签名（sign_state.state==1，err=0）', body: sj });
      return { ok: true, already: true, raw: sj };
    }
    const code = todayItem.code;
    if (!code) {
      log({ ev: 'signon', note: '今日签到项缺 code 字段，无法构造提交 body，已跳过', body: sj });
      return { ok: false, why: 'no-code', raw: sj };
    }
    // 1) POST signon：body={code,source}，翻倍码存在时附带（双倍概念币由看广告渠道先行点亮）
    const body = { code, source: '-' };
    if (todayItem.double_code) body.double_code = todayItem.double_code;
    const r = await http({ state, path: SIGNON_PATH, method: 'post', biz }, body);
    const j = (r.json && typeof r.json === 'object') ? r.json : {};
    log({ ev: 'signon', body: j });
    const ok = String(j.status) === '1' || j.errcode === 0 ||
               (j.err_code !== undefined && j.err_code === 0) || j.error_code === 0;
    if (ok) {
      await markSignonDay(state.userid);
      lastSignonRaw = j;
      toastOk('每日签到成功' + (j.data && j.data.sign_days ? '，累计 ' + j.data.sign_days + ' 天' : ''));
      return { ok: true, raw: j };
    }
    lastSignonRaw = j;
    if (KNOWN_DONE_CODES.has(j.errcode)) {
      await markSignonDay(state.userid); // 确定性完成码（50003/11005/131001 等）→ 落标防重复
      log({ ev: 'signon', note: '今日签到已达成（err=' + j.errcode + '）', body: j });
    } else {
      log({ ev: 'signon-failed', note: 'signon POST 失败 err=' + j.errcode, body: j });
    }
    return { ok: false, raw: j };
  } catch (e) {
    log({ ev: 'signon-err', err: String(e) });
    return { ok: false, why: String(e) };
  }
}

// 一键刷币：合并 profile 动态概念币任务与静态渠道，累计入账，刷新余额覆盖旧值
async function runCoinClaim() {
  const state = capture();
  if (!state) { toastErr('未登录：请先登录酷狗账号'); return { ok: false, net: 0, exhausted: false }; }
  if (Date.now() < cooldown.coin) {
    const waitMin = Math.ceil((cooldown.coin - Date.now()) / 60000);
    toastInfo('概念币处于风控冷却中，约 ' + waitMin + ' 分钟后自动恢复');
    return { ok: false, net: 0, exhausted: false, cooldown: true };
  }
  const dyn = await loadDynTasks(); // profile 解析失败时回退静态 COIN_TASKS，不报错
  // v6.3.0（Luo）修 E1：每日签到不再依赖「profile 成功且 signTasks 非空」前提——签名本身
  // 不需要 profile，即使 profile 失败也直接 GET sign_state 判定后 POST signon；失败不阻断概念币链路。
  await runDailySignon().catch(() => null);
  const tasks = mergedCoinTasks(dyn);
  const before = await getCoinBalance();
  const b0 = before ? before.balance : 0;
  const perTask = [];
  let totalGot = 0, allExhausted = true;
  for (const t of tasks) {
    const res = await claimOneTask(state, t);
    perTask.push({ name: t.name, ...res });
    totalGot += res.got;
    // v6.1.0（Luo）：取消逐任务 toast——所有渠道（含可重复广告任务）统一领至服务端拒绝为止，
    // 不再逐条提示「成功+N币/已达上限/不可领」，仅在整条链路收尾时汇总一句。
    // v5.1.0：单任务失败（非已达上限）不再 break 整条链路——记录后继续下一个任务；
    // 该 taskid 已在 claimOneTask 按确定性错误码加入本账号 dynBlock 黑名单，本会话内不会重复提交
    if (res.lastStop === '已达上限') { if (res.lastRaw) lastCoinRaw = res.lastRaw; }
    else { allExhausted = false; if (res.lastRaw) lastCoinRaw = res.lastRaw; }
    await sleep(300);
  }
  const after = await getCoinBalance();
  const b1 = after ? after.balance : b0;
  const net = b1 - b0;
  // v5.4.0：每日抽奖并入「概念币签到」链路——机会>0 自动抽完（task/submit 1107 消耗机会、
  // 命中直发概念币），绝不消耗概念币兑换加次数（lottery/exchange coin 付费兜底已禁用）
  const draw = await autoDrawAllChances().catch(() => null);
  const drawGot = (draw && draw.ok) ? draw.drew : 0;
  lastCoinResult = { perTask, totalGot, b0, b1, net, draw: draw || null };
  // v5.6.0：提示展示「本次实际领取币数」（各任务累计 award_coins，而非总余额）；
  // 达上限时给出兜底文案，避免「领取 0 币」误导；连抽结果并入同一行保持极简
  const gotCoins = perTask.reduce((s, p) => s + (p.coins || 0), 0);
  // v6.1.1（Luo）：收尾统一为一句「签到成功，领取X币」——X 为本次实际领取币数，
  // 不再区分「成功/已达上限」分支；可重复广告任务已在上方循环领至服务端拒绝为止
  toastOk('签到成功，领取 ' + gotCoins + ' 币');
  // v6.3.0（Luo）修 R2：手动一键刷币成功/达上限后回写当日锁，避免调度器 autoCoin
  // 下轮整链重跑；冷却中/未登录提前 return 的分支不写锁（当日未真正执行）。
  if (totalGot > 0 || drawGot > 0 || (allExhausted && totalGot === 0)) lastAutoDate.coin = todayKey();
  return { ok: totalGot > 0 || drawGot > 0, net, exhausted: allExhausted && totalGot === 0 };
}
function fmtCoinResult() {
  if (!lastCoinResult) return '';
  const r = lastCoinResult;
  const lines = r.perTask.filter((p) => p.got > 0).map((p) => p.name + ' x' + p.got);
  return '成功任务：' + (lines.length ? lines.join('、') : '无') + ' ｜ 净增 ' + r.net + ' 币（' + r.b0 + ' → ' + r.b1 + '）';
}
/* ---------------- 会员签到（听歌上报 + 领取当日 VIP，仅会员时长） ---------------- */
async function runSignIn({ listen } = {}) {
  const state = capture();
  if (!state) { toastErr('未登录：请先登录酷狗账号'); return null; }
  const uid = state.userid;
  // 本地「今日已领」标记优先：vip_clearday 实为最近入账日，不可作今日判定（见 claimTodayFlag 说明）
  if (await loadClaimToday(uid)) {
    updateStreak(true, uid).catch(() => {});
    toastOk('今日概念版 VIP 已领取');
    return { status: 'claimed' };
  }
  const st = await checkStatus(state);
  if (!st.ok) { log({ ev: 'status-fail', body: st.raw }); toastErr('查询状态失败（网络受限或接口变更），见面板原始响应'); return null; }
  lastBusi = st.busi;
  lastVips = st.vips || {};
  if (listen) {
    const lr = await reportListen(state);
    log({ ev: 'listen', body: lr.json || lr.text || lr.raw });
  }
  const rr = await doReceive(state);
  lastMemRaw = (rr.json && typeof rr.json === 'object') ? rr.json : rr; // 保存原始响应供面板排查
  log({ ev: 'receive', body: lastMemRaw });
  const j = (rr.json && typeof rr.json === 'object') ? rr.json : {};
  const code = j.error_code;
  if (String(j.status) === '1' || code === 131001) {
    // 领取成功 / 服务端确认今日已领 → 落本地标记并计入连续签到
    await markClaimToday(uid);
    updateStreak(true, uid).catch(() => {});
    toastOk(code === 131001 ? '今日概念版 VIP 已领取' : '概念版 VIP 领取成功');
    return { status: code === 131001 ? 'claimed' : 'receive', resp: rr, busi: st.busi };
  }
  const msg = (j.msg || j.error_msg) || (code !== undefined ? 'error_code=' + code : '') || JSON.stringify(rr.raw || rr).slice(0, 120);
  claimTodayFlag = false;
  if (code === 304001) toastErr('领取失败（日期参数异常）：' + msg); // receive_day 格式错误
  else toastErr('领取失败：' + msg);
  return { status: 'fail', resp: rr, busi: st.busi };
}
// 「会员相关签到」= 听歌上报 + 领取当日 VIP + profile 会员任务 + 看广告领 VIP（仅产出会员时长）
async function runMemberSign() {
  await runSignIn({ listen: true }).catch(() => null);
  await runVipTaskClaim().catch(() => null); // profile 动态会员任务（无法解析时静默跳过）
  await runAdClaim().catch(() => null);
  return true;
}

function toast(m, type) { try { const t = ctxRef && ctxRef.toast; if (t && t[type]) t[type](m); } catch (e) {} }
function toastInfo(m) { toast(m, 'info'); }
function toastOk(m) { toast(m, 'success'); }
function toastErr(m) { toast(m, 'danger'); }

/* ---------------- 连续签到计数（本地，按账号隔离） ---------------- */
async function loadStreak() {
  try {
    const st = capture();
    if (!st) return;
    const rec = await ctxRef.storage.get('streak:' + st.userid);
    if (rec && typeof rec === 'object') {
      streakInfo = { days: Number(rec.count) || 0, lastDay: rec.lastDay || '', uid: st.userid };
    }
  } catch (e) {}
}
async function updateStreak(claimed, uidArg) {
  try {
    const st = capture();
    const uid = uidArg || (st && st.userid);
    if (!uid) return;
    const key = 'streak:' + uid;
    const today = todayStr(), yesterday = dayStrOf(-1);
    let rec = null;
    try { rec = await ctxRef.storage.get(key); } catch (e) {}
    const prevDay = rec && rec.lastDay;
    const prevCount = Number(rec && rec.count) || 0;
    if (claimed && prevDay === yesterday && prevCount > 0) rec = { lastDay: today, count: prevCount + 1 };
    else if (claimed && prevDay === today) rec = { lastDay: today, count: prevCount || 1 };
    else if (claimed) rec = { lastDay: today, count: 1 };
    else rec = rec || { lastDay: '', count: 0 };
    try { await ctxRef.storage.set(key, rec); } catch (e) {}
    streakInfo = { days: Number(rec.count) || 0, lastDay: rec.lastDay || '', uid: uid };
  } catch (e) {}
}

/* ---------------- 自动巡检调度器（单 5 分钟定时器） ---------------- */
let schedulerTimer = null;
const lastAutoDate = { ad: '', coin: '', signon: '' }; // v6.3.0：+signon 供独立签到入口当日锁
function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}
function schedulerTick() {
  const tk = todayKey();
  try {
    // v6.3.0（Luo）修 E1：每日签到独立自动入口（autoSignon 默认 true）——不再并入 autoCoin
    // 才触发；签名本身不需 profile；ok(成功)/already(今日已签) 落当日锁，防 5 分钟重复 POST。
    if (stateCfg.autoSignon && tk !== lastAutoDate.signon) {
      runDailySignon().then((res) => { if (res && (res.ok || res.already)) lastAutoDate.signon = tk; }).catch((e) => log({ ev: 'auto-signon-err', err: String(e) }));
    }
    // v5.8.0：会员状态只读刷新统一收口到 runConceptClaims（其内部按 uid/60s 阈值先刷新
    // 并据此做会员时长短路），此处不再单独触发，避免同轮并发重复 checkStatus
    if (stateCfg.autoSign) {
      runSignIn({ listen: stateCfg.needListenOnAuto }).catch((e) => log({ ev: 'auto-sign-err', err: String(e) }));
    }
    // 广告/概念币当日锁：成功或"今日额度用尽"都视为当日完成，避免每 5 分钟重复请求；
    // v6.2.0：疑似风控进入渠道冷却（cooldown.ad/coin 到期前跳过），不在风控期盲撞接口
    if (stateCfg.autoAd && Date.now() >= cooldown.ad && tk !== lastAutoDate.ad) {
      runAdClaim().then((res) => { if (res && (res.ok || res.done)) lastAutoDate.ad = tk; }).catch((e) => log({ ev: 'auto-ad-err', err: String(e) }));
    }
    if (stateCfg.autoCoin && Date.now() >= cooldown.coin && tk !== lastAutoDate.coin) {
      runCoinClaim().then((res) => { if (res && (res.ok || res.exhausted)) lastAutoDate.coin = tk; }).catch((e) => log({ ev: 'auto-coin-err', err: String(e) }));
    }
    // v5.2.0：手机端福利中心状态静默探测（只读），面板打开立即可见最新可领/进度
    probeWelfare().catch((e) => log({ ev: 'auto-welfare-err', err: String(e) }));
    // v5.7.0：concepts 写接口条件触发（有资格才领、无资格跳过；会员过期/开随心包后自动生效）
    runConceptClaims().catch((e) => log({ ev: 'auto-concept-err', err: String(e) }));
  } catch (e) { log({ ev: 'tick-err', err: String(e) }); }
}
function startScheduler() {
  if (schedulerTimer) return;
  schedulerTick(); // 启动即巡检一轮
  schedulerTimer = setInterval(schedulerTick, 300000);
  timers.push(schedulerTimer);
}

/* ---------------- 个人中心「会员签到」只读状态条 ---------------- */
const VIP_BAR_ID = 'luo-kcs-vipbar';
let vipBarEl = null;
let vipBarObserver = null;
let primaryColorCache = '';

function buildVipBar() {
  const st = capture();
  const claimed = !!(claimTodayFlag || (lastBusi && isToday(lastBusi.vip_clearday)));
  const primary = getPrimaryColor();
  const name = (st && st.nickname) || '';
  const days = streakInfo && streakInfo.uid === (st && st.userid) ? (Number(streakInfo.days) || 0) : 0;
  let secondLine;
  if (!st) secondLine = '未登录酷狗账号';
  else if (!lastBusi) secondLine = '状态查询中，进入设置面板手动刷新';
  else secondLine = (name ? escText(name) + ' · ' : '') + '连续签到 <b style="color:' + primary + ';font-weight:700">' + days + '</b> 天';
  const iconBg = claimed
    ? 'background:' + hexA(primary, 0.16) + ';color:' + primary
    : 'background:var(--control-hover-bg);color:var(--color-text-sub);opacity:.6';
  const icon = ICON_INLINE.replace('width="16"', 'width="18"').replace('height="16"', 'height="18"');
  const el = document.createElement('div');
  el.id = VIP_BAR_ID;
  el.setAttribute('data-plugin', PLUGIN_ID);
  el.style.cssText =
    'display:flex;align-items:center;gap:12px;padding:12px 14px;margin-top:8px;box-sizing:border-box;border-radius:16px;' +
    'border:1px solid ' + (claimed ? hexA(primary, 0.32) : 'transparent') + ';' +
    'background:' + (claimed ? hexA(primary, 0.08) : 'var(--control-hover-bg)') + ';' +
    'color:var(--color-text-main);';
  el.innerHTML =
    '<span style="flex:none;width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;' + iconBg + '">' + icon + '</span>' +
    '<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">' +
    '<span style="display:flex;align-items:center;gap:6px"><span style="font-size:13px;font-weight:600">会员签到</span>' +
    '<span style="font-size:9.5px;opacity:.35">by ' + AUTHOR + '</span></span>' +
    '<span style="font-size:11px;opacity:.62;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + secondLine + '</span></span>' +
    '<span style="flex:none;font-size:11px;font-weight:600;padding:3px 10px;border-radius:999px;' +
    (claimed ? 'color:' + primary + ';background:' + hexA(primary, 0.14) : 'color:var(--color-text-sub);background:rgba(0,0,0,.05)') + '">' +
    (claimed ? '已领取' : '未领取') + '</span>';
  return el;
}
function getPrimaryColor() {
  if (primaryColorCache) return primaryColorCache;
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const v of ['--color-primary', '--primary-color', '--color-brand', '--primary']) {
      const c = cs.getPropertyValue(v).trim();
      if (c && /^(#|rgba?\()/.test(c)) { primaryColorCache = c; return c; }
    }
  } catch (e) {}
  primaryColorCache = '#2f6fee';
  return primaryColorCache;
}
function hexA(hex, alpha) {
  try {
    const h = String(hex).replace('#', '').trim();
    if (/^[0-9a-fA-F]{6}$|^[0-9a-fA-F]{3}$/.test(h)) {
      const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
      return 'rgba(' + parseInt(full.slice(0, 2), 16) + ',' + parseInt(full.slice(2, 4), 16) + ',' + parseInt(full.slice(4, 6), 16) + ',' + alpha + ')';
    }
    return String(hex);
  } catch (e) { return String(hex); }
}
function escText(s) {
  try {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  } catch (e) { return String(s); }
}
function findVipCard() {
  const h3s = document.querySelectorAll('h3');
  for (let i = 0; i < h3s.length; i++) {
    const h = h3s[i];
    if (h.childNodes.length === 0 || (h.textContent || '').trim() !== '会员状态') continue;
    const card = h.parentElement && h.parentElement.parentElement;
    if (card && /畅听会员|概念会员/.test(card.textContent || '')) return { card, titleRow: h.parentElement };
  }
  return null;
}
function mountVipBar() {
  if (vipBarEl && !document.getElementById(VIP_BAR_ID)) vipBarEl = null;
  const anchor = findVipCard();
  if (!anchor) return false;
  const { card } = anchor;
  let kt = anchor.titleRow.nextElementSibling;
  if (!kt && card.children.length) kt = card.children[card.children.length - 1];
  if (!vipBarEl) vipBarEl = buildVipBar();
  if (vipBarEl.parentNode === card && (kt ? (kt.nextElementSibling === vipBarEl) : (card.lastElementChild === vipBarEl))) return true;
  if (kt && kt.nextSibling) card.insertBefore(vipBarEl, kt.nextSibling);
  else card.appendChild(vipBarEl);
  return true;
}
function startVipBarWatch() {
  if (vipBarObserver) return;
  vipBarObserver = setInterval(() => {
    try {
      if (!ctxRef) return;
      // v5.6.0：会员状态低频刷新——超过 60s 未成功 checkStatus 则只读刷新，成功后重建状态条
      //（重建数据含到期天数倒计时/已领取状态；纯只读，不触发任何写操作）
      if (Date.now() - lastStatusAt > 60000) {
        refreshMemberStatus().then((ok) => {
          try {
            if (!ok || !ctxRef) return;
            vipBarEl = null;
            const old = document.getElementById(VIP_BAR_ID);
            if (old && old.parentNode) old.parentNode.removeChild(old);
            mountVipBar();
          } catch (e) { log({ ev: 'vipbar-rebuild-err', err: String(e) }); }
        }).catch(() => {});
        lastStatusAt = Date.now(); // 防高频重试（即使失败也等到下个 60s 窗口）
      }
      if (document.getElementById(VIP_BAR_ID) || findVipCard()) mountVipBar();
      if (!document.getElementById(VIP_BAR_ID) && !findVipCard() && vipBarEl) vipBarEl = null;
    } catch (e) {}
  }, 1500);
  try { mountVipBar(); } catch (e) {}
}
function stopVipBarWatch() {
  if (vipBarObserver) { clearInterval(vipBarObserver); vipBarObserver = null; }
  try { const el = document.getElementById(VIP_BAR_ID); if (el && el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
  vipBarEl = null;
  lastBusi = null;
}

/* ---------------- 设置面板（v5.0.0 轻量紧凑版） ---------------- */
function settingsPanel() {
  const { defineComponent, h, ref, defineAsyncComponent } = ctxRef.vue;
  const Switch = defineAsyncComponent(ctxRef.ui.components.Switch);
  const Button = defineAsyncComponent(ctxRef.ui.components.Button);
  return defineComponent({
    setup() {
      const cfg = ref({ ...stateCfg });
      const memBusy = ref(false);
      const coinBusy = ref(false);
      const adRes = ref('');
      const memRaw = ref('');       // 最近一次领取当日 VIP 的原始响应
      const memRawErr = ref(false); // 该响应是否为异常
      const coinRes = ref('');
      const coinRaw = ref('');      // 最近一次刷币的原始响应
      const coinRawErr = ref(false);
      const rawOpen = ref(false);   // 最近响应区：默认折叠，出错自动展开
      const actOpen = ref(false);   // 活动渠道区：默认折叠
      const welOpen = ref(false);   // v5.2.0 手机端福利中心区：默认折叠
      const welText = ref('探测中…'); // v5.2.0 福利中心摘要
      const welDetail = ref('');      // v5.2.0 福利中心明细
      const coinBal = ref('…');
      const dynList = ref(null);    // profile 动态任务 { coin:[{id,name}], vip:[{id,name}] }
      const info = ref({ name: '', userid: '', vipStatus: '查询中…', clearday: '', endTime: '', svipHtml: '', tvipHtml: '', busing: false });

      // 「会员相关签到」：听歌上报 + 当日 VIP + profile 会员任务 + 看广告（仅会员时长）
      const runMember = async () => {
        if (memBusy.value) return;
        memBusy.value = true;
        try {
          await runMemberSign();
          memRaw.value = fmtRaw(lastMemRaw);
          const j = (lastMemRaw && lastMemRaw.json && typeof lastMemRaw.json === 'object') ? lastMemRaw.json : lastMemRaw;
          const code = j && j.status;
          memRawErr.value = !!(code !== undefined && String(code) !== '1');
          if (memRawErr.value) rawOpen.value = true; // 出错自动展开
          adRes.value = fmtAdResult() || '本次广告无入账（今日次数已用光或风控）';
        } finally { memBusy.value = false; }
        await refresh().catch(() => {});
      };
      // 「概念币签到」：profile 动态 + 静态直领渠道
      const runCoin = async () => {
        if (coinBusy.value) return;
        coinBusy.value = true;
        try {
          const r = await runCoinClaim().catch(() => ({ ok: false, net: 0, exhausted: false }));
          coinRes.value = fmtCoinResult() || '本次无入账（需等待次日重置或任务已上限）';
          coinRaw.value = fmtRaw(lastCoinRaw) || '无';
          coinRawErr.value = !!lastCoinRaw;
          if (coinRawErr.value) rawOpen.value = true;
          const b1 = await getCoinBalance().catch(() => null);
          if (b1) coinBal.value = b1.balance + ' 币';
        } finally { coinBusy.value = false; }
        loadDyn();
      };
      const refreshCoin = async () => {
        const b = await getCoinBalance().catch(() => null);
        if (b) coinBal.value = b.balance + ' 币';
      };
      // 拉取 profile 动态任务定义（用于面板标注自动化范围，失败静默）
      const loadDyn = async () => {
        const d = await loadDynTasks().catch(() => null);
        if (d) dynList.value = { coin: (d.coinTasks || []).slice(0, 12), vip: (d.vipTasks || []).slice(0, 12) };
      };

      // 刷新状态
      const refresh = async () => {
        try {
          const st = capture();
          if (!st) {
            info.value = { name: '未登录', userid: '', vipStatus: '请先登录酷狗账号', clearday: '', endTime: '', svipHtml: '', tvipHtml: '', busing: false, };
            refreshCoin();
            return { ok: false };
          }
          info.value = { ...info.value, name: st.nickname, userid: st.userid, busing: true };
          const r = await checkStatus(st);
          if (r.ok) {
            const b = r.busi;
            lastBusi = b;
            lastVips = r.vips || {};
            claimTodayFlag = await loadClaimToday(st.userid);
            lastStatusAt = Date.now(); // v5.6.0：手动刷新成功同样重置状态条刷新计时
            updateStreak(claimTodayFlag, st.userid).catch(() => {});
            const svip = lastVips.svip || b;
            const tvip = lastVips.tvip;
            const fmt = (v) => {
              if (!v) return '无时长';
              return (v.is_vip || v.vip_end_time || v.vip_endtime) ? fmtVipEnd(v.vip_end_time || v.vip_endtime) : '无时长';
            };
            info.value.vipStatus = claimTodayFlag ? '今日已领' : '今日未领，可领取';
            info.value.clearday = b.vip_clearday || '无';
            info.value.endTime = fmtVipEnd(b.vip_end_time || b.vip_endtime);
            info.value.svipHtml = (svip && (svip.is_vip || svip.vip_end_time || svip.vip_endtime)) ? '概念会员：' + fmt(svip) : '概念会员：无时长';
            info.value.tvipHtml = (tvip && (tvip.is_vip || tvip.vip_end_time || tvip.vip_endtime)) ? '畅听会员：' + fmt(tvip) : '畅听会员：无时长';
            return { ok: true };
          }
          info.value.vipStatus = '状态查询失败，请重试';
          return { ok: false };
        } catch (e) {
          info.value.vipStatus = '状态查询失败（' + String((e && e.message) || e).slice(0, 40) + '）';
          return { ok: false };
        } finally { info.value.busing = false; }
      };

      // 打开面板即刷新状态/余额/动态任务
      refresh().catch(() => {});
      refreshCoin();
      loadDyn();

      // v5.2.0：手机端福利中心状态探测（只读），供面板展示可领/已领进度
      const probePanelWelfare = async () => {
        try {
          const w = await probeWelfare();
          if (!w) { welText.value = '探测失败（未登录或接口不可达）'; welDetail.value = ''; return; }
          const fm = w.freeMode, ab = w.adBox, ls = w.listen, fp = w.freePkg, at = w.act;
          const lt = w.lottery;
          const lines = [];
          if (fm && !fm.unreachable) lines.push('粉色宝箱(免费模式)：' + (fm.award ? '可领 ' + (fm.awardHours || 0) + ' 小时 VIP' : '本周期已领') + (fm.vipTime != null ? '，累计时长 ' + Math.round(fm.vipTime / 3600) + ' 小时' : '') + (fm.mode == 0 ? '，免费模式未开启(需客户端操作)' : ''));
          if (ab && !ab.unreachable) lines.push('广告宝箱：今日 ' + (ab.done || 0) + '/' + (ab.total || 0) + ' 次' + (ab.remain > 0 ? '，剩余可看 ' + ab.remain + ' 次' : '') + (ab.award && ab.award.hour ? '，奖励 ' + ab.award.hour + ' 小时 VIP' + (ab.award.status === 1 ? '(待领)' : '(已领)') : ''));
          if (at && !at.unreachable) lines.push('活动列表：' + (at.groups || 0) + ' 组，已参与 ' + (at.participating || 0) + ' 项' + (at.participating > 0 ? '(组队/邀新需客户端操作)' : ''));
          if (ls && !ls.unreachable) lines.push('听歌福利：' + (ls.status ? '已达标' : '待完成') + (ls.day ? ('，周期 ' + ls.day) : ''));
          if (fp && !fp.unreachable) lines.push('限时免费领：' + (fp.status ? '已达标' : '待完成'));
          if (lt && !lt.unreachable) lines.push('每日抽奖：剩余机会 ' + (lt.chances || 0) + ' 次' + '，今日已抽 ' + (lt.done || 0) + '/' + (lt.maxDone || 0) + ' 次' + (lt.coins != null ? '，概念币 ' + lt.coins : '') + (lt.exchangeCoins ? '' : '（机会需手机版浏览/看广告）'));
          if (lastConceptClaim) lines.push('concepts写接口：' + fmtConceptClaim());
          welText.value = '已探测 ' + lines.length + ' 类渠道' + (lines.length ? '，详情见下' : '（状态为空）');
          welDetail.value = lines.join('\n');
          const advip = w.adTime;
          if (advip && !advip.unreachable && advip.vipEnd != null) welDetail.value += (welDetail.value ? '\n' : '') + '广告累计 VIP：' + (advip.vipEnd > 1000000000 ? '到期 ' + new Date(advip.vipEnd * 1000).toLocaleDateString() : Math.round(advip.vipEnd / 3600) + ' 小时');
        } catch (e) { welText.value = '探测异常'; welDetail.value = String((e && e.message) || e); }
      };
      probePanelWelfare();

      // 自动化任务总数（静态 + profile 动态）
      const autoCount = () => COIN_TASKS.length + (dynList.value ? (dynList.value.coin.length + dynList.value.vip.length) : 0);
      const dynDesc = () => {
        if (!dynList.value) return '解析中或暂无可直领任务（自动回退静态渠道）';
        const parts = [];
        if (dynList.value.coin.length) parts.push(dynList.value.coin.map((t) => t.name + '（币）').join('、'));
        if (dynList.value.vip.length) parts.push(dynList.value.vip.map((t) => t.name + '（会员）').join('、'));
        return parts.length ? parts.join('、') : '暂无（自动回退静态渠道）';
      };

      const row = (label, desc, control) =>
        h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0' }, [
          h('div', null, [h('div', { style: 'font-weight:600;font-size:12px' }, label), h('div', { style: 'opacity:.5;font-size:11px' }, desc)]),
          control,
        ]);
      const setCfg = (key, v) => {
        const val = !!v;
        cfg.value[key] = val;
        stateCfg[key] = val;
        saveCfg();
      };

      return () =>
        h('div', { style: 'display:flex;flex-direction:column;gap:6px;font-size:12px' }, [
          // 顶部一行：图标 + 昵称 + 登录态 + VIP 状态 + 余额（信息合并，收敛视觉重量）
          h('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 0' }, [
            h('span', { style: 'display:inline-flex;color:#2f6fee;flex:none', domProps: { innerHTML: ICON_INLINE } }),
            h('span', { style: 'font-weight:600' }, info.value.name || '未登录'),
            h('span', { style: 'opacity:.45;font-size:11px' }, '· ' + (info.value.userid ? 'ID ' + info.value.userid : '请先登录酷狗账号')),
            h('span', { style: 'opacity:.7;font-size:11px' }, '｜ ' + info.value.vipStatus + (info.value.busing ? '…' : '')),
            h('span', { style: 'opacity:.7;font-size:11px' }, '｜ 币 ' + coinBal.value),
          ]),
          // 两个主按钮并排 + 刷新（同一行）
          // v5.5.0：每日抽奖已并入「概念币签到」链路（机会>0 自动连抽，见 runCoinClaim），
          // 独立「每日抽奖」按钮与签到按钮功能重叠，予以合并精简，仅保留三个主按钮。
          // 按钮安全：各 onClick 为独立回调（无共享 handler/相同开关），此处再加 stopPropagation
          // 防御性隔离，杜绝事件冒泡/父级委托将「签到」动作级联到「刷新」，确保两按钮互不干扰。
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
            h(Button, { disabled: memBusy.value, onClick: (e) => { try { e && e.stopPropagation && e.stopPropagation(); } catch (x) {} runMember(); } }, () => (memBusy.value ? '领取中…' : '会员相关签到')),
            h(Button, { disabled: coinBusy.value, onClick: (e) => { try { e && e.stopPropagation && e.stopPropagation(); } catch (x) {} runCoin(); } }, () => (coinBusy.value ? '刷取中…' : '概念币签到')),
            h(Button, { disabled: memBusy.value || coinBusy.value, onClick: (e) => { try { e && e.stopPropagation && e.stopPropagation(); } catch (x) {} refresh().catch(() => {}); refreshCoin(); } }, () => '刷新'),
          ]),
          h('div', { style: 'opacity:.55;font-size:11px' }, '会员签到 = 听歌上报 + 当日 VIP + profile 会员任务 + 看广告；签到币 = 直领（静态 + profile 动态）。'),
          h('div', { style: 'opacity:.55;font-size:11px' }, adRes.value || '看广告领取结果显示在此；每日免费额度有限（听歌 + 广告合计约 2 天）。'),
          h('div', { style: 'opacity:.55;font-size:11px' }, '每日抽奖已并入「概念币签到」：机会>0 自动连抽（命中直发概念币）；机会需在手机概念版浏览/看广告获取。'),

          // 最近响应：默认折叠、出错自动展开（保持排查能力）
          h('div', { style: 'display:flex;align-items:center;gap:6px;font-size:11px;opacity:.6;cursor:pointer;user-select:none;padding:2px 0', onClick: () => { rawOpen.value = !rawOpen.value; } }, [
            h('span', {}, (rawOpen.value ? '▾' : '▸') + ' 最近响应（排查用）'),
            (memRawErr.value || coinRawErr.value) ? h('span', { style: 'color:#e5484d' }, '有异常，已自动展开') : null,
          ]),
          (rawOpen.value || memRawErr.value || coinRawErr.value) ? h('div', { style: 'font-size:11px;line-height:1.5;opacity:.6;word-break:break-all;font-family:monospace;padding:2px 0' }, [
            h('div', {}, '会员：' + (memRaw.value || '未执行')),
            h('div', {}, '币：' + (coinRaw.value || '未执行')),
          ]) : null,

          // v5.2.0 手机端福利中心：只读探测手机端各福利渠道实时状态（PC 直调同源接口）
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;font-size:11px;opacity:.75;cursor:pointer;user-select:none;padding:2px 0', onClick: () => { welOpen.value = !welOpen.value; probePanelWelfare().catch(() => {}); } }, [
            h('span', {}, (welOpen.value ? '▾' : '▸') + ' 手机端福利中心（' + welText.value + '）'),
            h('span', { style: 'opacity:.5' }, welOpen.value ? '收起' : '展开'),
          ]),
          welOpen.value ? h('div', { style: 'font-size:11px;line-height:1.6;padding:2px 0' }, [
            h('div', { style: 'opacity:.6;white-space:pre-line;word-break:break-all' }, welDetail.value || '正在探测手机端福利状态（免费模式宝箱/广告宝箱/听歌福利/限时免费领/活动列表）…'),
            h('div', { style: 'opacity:.45;font-size:10px;margin-top:2px' }, '说明：本区仅探测展示，不主动提交。粉色宝箱免费模式与广告宝箱的实际领取动作需客户端一次抓包点亮参数后固化（见活动渠道）。消息提醒+300 的 user/subscribe 接口 body 逆向不可得，亦不编造直领。'),
          ]) : null,

          // 活动渠道：可折叠，去大色块/厚重边框
          h('div', { style: 'display:flex;align-items:center;justify-content:space-between;font-size:11px;opacity:.75;cursor:pointer;user-select:none;padding:2px 0', onClick: () => { actOpen.value = !actOpen.value; } }, [
            h('span', {}, (actOpen.value ? '▾' : '▸') + ' 活动渠道（' + autoCount() + ' 项已自动化 · ' + ACTIVITY_CHANNELS.length + ' 项需手动）'),
            h('span', { style: 'opacity:.5' }, actOpen.value ? '收起' : '展开'),
          ]),
          actOpen.value ? h('div', { style: 'font-size:11px;line-height:1.6;padding:2px 0' }, [
            h('div', { style: 'font-weight:600;opacity:.75' }, '已自动化（插件自动领取）：'),
            h('div', { style: 'opacity:.6' }, '· 静态直领：' + COIN_TASKS.map((t) => t.name).join('、')),
            h('div', { style: 'opacity:.6' }, '· profile 动态：' + dynDesc()),
            h('div', { style: 'font-weight:600;opacity:.75;margin-top:4px' }, '需手动完成（手机概念版内操作，插件仅引导）：'),
            ACTIVITY_CHANNELS.map((c) => h('div', { style: 'opacity:.55' }, '· ' + c.t + '：' + c.d)),
          ]) : null,

          // 开关
          row('每日自动签到', '启动与每 5 分钟巡检，今日未领自动领取当日 VIP', h(Switch, { modelValue: cfg.value.autoSign, 'onUpdate:modelValue': (v) => setCfg('autoSign', v) })),
          row('每日自动签到概念币', 'v6.3.0 独立入口：每日自动签到领取概念币/累计超级奖励，与 VIP 领取互不影响', h(Switch, { modelValue: cfg.value.autoSignon, 'onUpdate:modelValue': (v) => setCfg('autoSignon', v) })),
          row('自动签到附带听歌上报', '部分场景领取前需先上报一次听歌行为', h(Switch, { modelValue: cfg.value.needListenOnAuto, 'onUpdate:modelValue': (v) => setCfg('needListenOnAuto', v) })),
          row('自动看广告领VIP', '不依赖签到模拟看完广告领概念VIP，每日次数有限（v6.3.0 起默认开）', h(Switch, { modelValue: cfg.value.autoAd, 'onUpdate:modelValue': (v) => setCfg('autoAd', v) })),
          row('概念币自动巡检', '每日配额重置后自动刷一次（含 profile 动态任务、抽奖机会>0 自动连抽）', h(Switch, { modelValue: cfg.value.autoCoin, 'onUpdate:modelValue': (v) => setCfg('autoCoin', v) })),
          h('div', { style: 'text-align:right;opacity:.4;font-size:11px;padding-top:2px' }, 'by ' + AUTHOR + ' · 仅请求酷狗官方接口'),
        ]);
    },
  });
}

async function saveCfg() {
  try { await ctxRef.storage.set('settings', stateCfg); } catch (e) {}
}

/* ---------------- 激活 / 停用 ---------------- */
export async function activate(ctx) {
  ctxRef = ctx;
  try {
    const v = await ctx.storage.get('settings');
    if (v && typeof v === 'object') stateCfg = { ...DEFAULT, ...v };
  } catch (e) {}

  ctx.ui.settings.define({
    title: '概念版签到',
    description: '酷狗概念版每日 VIP 自动/手动签到 · by ' + AUTHOR,
    component: settingsPanel(),
  });

  loadStreak().catch(() => {});
  // v5.0.2：启动时读取今日已领本地标记（不依赖不可靠的 vip_clearday）
  (async () => {
    try {
      const st0 = capture();
      if (st0 && st0.userid) claimTodayFlag = await loadClaimToday(st0.userid);
    } catch (e) {}
  })();

  // 统一调度器（单定时器：会员签到 / 看广告 / 概念币）
  startScheduler();
  // 个人中心「会员签到」只读状态条
  startVipBarWatch();

  ctx.dispose(() => {
    timers.forEach((t) => { try { clearInterval(t); } catch (e) {} });
    timers = [];
    stopVipBarWatch();
    ctxRef = null;
  });
}

export function deactivate() {
  timers.forEach((t) => { try { clearInterval(t); } catch (e) {} });
  timers = [];
  stopVipBarWatch();
  ctxRef = null;
}
