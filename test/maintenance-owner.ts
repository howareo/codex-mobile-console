import { spawn } from "node:child_process";
import { once } from "node:events";

// Exercise the actual Windows share mode used by the reload script.
export async function holdMaintenance(path: string) {
  const child = spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $stream = [IO.File]::Open($env:TEST_MAINTENANCE_PATH, 'CreateNew', 'Write', 'Read')
    $bytes = [Text.Encoding]::UTF8.GetBytes((@{version=2;ownerPid=$PID;nonce='test-window'} | ConvertTo-Json -Compress))
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush()
    [Console]::WriteLine('ready')
    [Console]::ReadLine() | Out-Null
    $stream.Dispose()
  `], { windowsHide: true, env: { ...process.env, TEST_MAINTENANCE_PATH: path }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Maintenance owner did not become ready")), 8000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`Maintenance owner exited: ${code}`)); });
      child.stdout.once("data", data => {
        clearTimeout(timer);
        if (data.toString().trim() === "ready") resolve(); else reject(new Error("Unexpected maintenance owner output"));
      });
    });
  } catch (error) { child.kill(); await exited; throw error; }
  return async () => { child.kill(); await exited; };
}
