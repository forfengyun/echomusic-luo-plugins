// opendir.mjs - 打开指定目录（供 echomusic-kgm-convert 插件「打开目录」按钮调用）
// 用法: node opendir.mjs <目录绝对路径>
// 返回码: 0=成功启动 explorer；2=缺少参数；3/4=启动失败
import { spawn } from "node:child_process";

const dir = process.argv[2];
if (!dir) {
  console.error("no dir arg");
  process.exit(2);
}

let child;
try {
  child = spawn("explorer.exe", [dir], { stdio: "ignore" });
} catch (e) {
  console.error(e && e.message ? e.message : String(e));
  process.exit(3);
}
child.on("error", (e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(4);
});
// explorer 打开窗口后进程立即返回；辅助进程再兜底等待 3s 后自行退出，避免残留
setTimeout(() => process.exit(0), 3000);
child.on("exit", () => process.exit(0));
