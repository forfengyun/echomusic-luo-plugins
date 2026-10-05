// echomusic-kgm-convert 取链兜底脚本（node 子进程）
// 用法: node get_v5url.mjs <hash> <albumAudioId> <quality> <outJsonFile>
// 从 EchoMusic sqlite 读登录态，请求酷狗 /v5/url 取未加密直链，写结果 JSON 到 outJsonFile。
// 参数与签名已用真实账号验证：标准版 page_id/ppage_id + signature(android lite 盐)。
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');
const DB = path.resolve(PLUGIN_DIR, '..', '..', 'echomusic.sqlite'); // 插件数据目录下的 echomusic.sqlite

const KEY_SALT_LITE = '185672dd44712f60bb1736df5a377e82';
const SALT_LITE = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';
const LITE_APPID = 3116;
const LITE_APP_VER = 11440;
const KG_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi';
const KG_HEADERS = { 'kg-rc': '1', 'kg-thash': '5d816a0', 'kg-rec': 1, 'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F' };

const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

function readCookie() {
  try {
    const db = new DatabaseSync(DB, { readOnly: true });
    const getUser = db.prepare("SELECT value_json FROM app_kv WHERE key='pinia:user'").get();
    const getDev = db.prepare("SELECT value_json FROM app_kv WHERE key='pinia:device'").get();
    db.close();
    const u = JSON.parse(getUser ? getUser.value_json : '{}');
    const d = JSON.parse(getDev ? getDev.value_json : '{}');
    const info = (u && u.info) || {};
    const di = (d && d.info) || {};
    return {
      token: String(info.token || ''),
      userid: String(info.userid ?? info.userId ?? 0),
      mid: String(di.mid || ''),
      dfid: String(di.dfid || ''),
    };
  } catch (e) {
    return { token: '', userid: '', mid: '', dfid: '', err: e && e.message ? e.message : String(e) };
  }
}

function request(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', headers, timeout: timeoutMs || 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  const [hashIn, aaidIn, qualityIn, outJson] = process.argv.slice(2);
  const outFile = outJson || path.join(PLUGIN_DIR, 'tmp', `v5-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  const hash = String(hashIn || '').toLowerCase();
  const albumAudioId = Number(aaidIn || 0);
  const quality = String(qualityIn || '320');
  const writeOut = (obj) => {
    try { fs.writeFileSync(outFile, JSON.stringify(obj), 'utf8'); } catch (e) {}
  };
  try {
    const c = readCookie();
    if (!c.token || !c.mid || !c.dfid) {
      writeOut({ ok: false, err: 'cookie 缺失: ' + JSON.stringify(c).slice(0, 200) });
      return;
    }
    const clienttime = Math.floor(Date.now() / 1000);
    const uid = Number(c.userid || 0);
    const params = {
      album_id: 0, area_code: '1', hash, ssa_flag: 'is_fromtrack', version: 11430,
      page_id: '151369488', quality, album_audio_id: albumAudioId, behavior: 'play',
      pid: 411, cmd: 26, pidversion: 3001, IsFreePart: 0,
      ppage_id: '463467626,350369493,788954147', cdnBackup: 1, module: '',
      clientver: LITE_APP_VER, dfid: c.dfid, mid: c.mid, uuid: '-', appid: LITE_APPID, clienttime,
    };
    if (c.token) params.token = c.token;
    if (uid !== 0) params.userid = uid;
    params.key = md5(`${hash}${KEY_SALT_LITE}${LITE_APPID}${c.mid}${uid}`);
    const ps = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
    params.signature = md5(`${SALT_LITE}${ps}${SALT_LITE}`);
    const q = Object.keys(params).map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
    const headers = Object.assign({
      'User-Agent': KG_UA,
      dfid: c.dfid,
      clienttime: String(clienttime),
      mid: c.mid,
      'x-router': 'trackercdn.kugou.com',
    }, KG_HEADERS);
    const res = await request(`https://gateway.kugou.com/v5/url?${q}`, headers, 30000);
    if (res.status !== 200) {
      writeOut({ ok: false, err: `HTTP ${res.status}` });
      return;
    }
    let j;
    try { j = JSON.parse(res.body); } catch (e) { writeOut({ ok: false, err: 'JSON 解析失败' }); return; }
    const jerr = j && (j.error_code !== undefined ? j.error_code : j.err_code !== undefined ? j.err_code : j.errcode !== undefined ? j.errcode : null);
    if (jerr !== null && Number(jerr) !== 0) {
      writeOut({ ok: false, err: `接口错误 ${jerr} ${(j && (j.errmsg || j.msg || j.error_msg)) || ''}`.trim() });
      return;
    }
    if (j && j.status === 0) {
      writeOut({ ok: false, err: `status=0 ${(j && (j.errmsg || j.msg || j.error_msg)) || ''}`.trim() });
      return;
    }
    const ext = String(j && (j.extName || j.extname || j.ext_name) || 'mp3').toLowerCase();
    const urls = (Array.isArray(j && j.url) ? j.url : []).concat(Array.isArray(j && j.backupUrl) ? j.backupUrl : []);
    const url = urls.find((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;
    if (!url) { writeOut({ ok: false, err: '无播放直链' }); return; }
    writeOut({ ok: true, ext, url });
  } catch (e) {
    writeOut({ ok: false, err: e && e.message ? e.message : String(e) });
  }
}

main();
