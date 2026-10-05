// tools/download.mjs — node 流式下载，绕过 ctx.fs 8MB 沙箱限制
// 用法: node download.mjs <url> <outPath> <resultJson>
// 成功: resultJson = {"ok":true,"size":N} 退出码 0
// 失败: resultJson = {"ok":false,"error":"..."} 退出码 1
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";

function fetchStream(url, outPath, redirects) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error("非法 URL"));
    }
    const lib = u.protocol === "https:" ? https : http;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const tmp = outPath + ".part";
    const ws = fs.createWriteStream(tmp);
    const req = lib.get(
      u,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept": "*/*",
          "Referer": "https://www.kugou.com/",
        },
        timeout: 300000,
      },
      (res) => {
        const sc = res.statusCode || 0;
        if (sc >= 300 && sc < 400 && res.headers.location) {
          res.resume();
          ws.close();
          fs.unlink(tmp, () => {});
          if (redirects >= 5) return reject(new Error("重定向次数过多"));
          return fetchStream(new URL(res.headers.location, url).toString(), outPath, (redirects || 0) + 1)
            .then(resolve)
            .catch(reject);
        }
        if (sc !== 200 && sc !== 206) {
          res.resume();
          ws.close();
          fs.unlink(tmp, () => {});
          return reject(new Error("HTTP " + sc));
        }
        res.pipe(ws);
        ws.on("finish", () => {
          ws.close();
          try {
            const st = fs.statSync(tmp);
            if (!st.size) {
              fs.unlink(tmp, () => {});
              return reject(new Error("空文件"));
            }
            fs.renameSync(tmp, outPath);
            resolve(st.size);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", (e) => {
      ws.close();
      fs.unlink(tmp, () => {});
      reject(e);
    });
    req.on("timeout", () => {
      req.destroy(new Error("下载超时（300 秒）"));
    });
  });
}

const [url, outPath, resFile] = process.argv.slice(2);
(async () => {
  try {
    const size = await fetchStream(url, outPath, 0);
    fs.writeFileSync(resFile, JSON.stringify({ ok: true, size }));
    process.exit(0);
  } catch (e) {
    try {
      fs.writeFileSync(resFile, JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
    } catch (e2) {}
    process.exit(1);
  }
})();
