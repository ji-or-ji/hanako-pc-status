/**
 * PowerShell 调用层
 *
 * 为什么用 -EncodedCommand 而不是 -File：
 * Windows PowerShell 5.1 读 .ps1 文件时按系统 ANSI（中文环境为 GBK）解码，
 * UTF-8 无 BOM 的脚本里中文字面量会变乱码。把脚本内容以 UTF-16LE base64
 * 直接送进命令行，彻底绕开文件编码问题。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * 执行一个 .ps1 文件，返回 { ok, data } 或 { ok: false, error }。
 * 脚本约定：把结果 JSON 写到 stdout。
 */
export async function runPowerShellScript(scriptPath, options = {}) {
  const { flags = [], timeoutMs = 12000 } = options;

  let script;
  try {
    script = await readFile(scriptPath, "utf8");
  } catch (err) {
    return { ok: false, error: `读取脚本失败：${err.message}` };
  }

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
    encoded,
  ];

  return await new Promise((resolve) => {
    execFile(
      powershellPath(),
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, HANA_PC_STATUS_FLAGS: flags.join(",") },
      },
      (err, stdout) => {
        if (err && !stdout) {
          const reason = err.killed ? "调用超时" : err.message;
          resolve({ ok: false, error: `PowerShell 执行失败：${reason}` });
          return;
        }
        const text = String(stdout || "");
        const start = text.indexOf("{");
        if (start < 0) {
          resolve({ ok: false, error: "PowerShell 没有返回可解析的 JSON" });
          return;
        }
        try {
          resolve({ ok: true, data: JSON.parse(text.slice(start).trim()) });
        } catch (parseErr) {
          resolve({ ok: false, error: `解析输出失败：${parseErr.message}` });
        }
      },
    );
  });
}
