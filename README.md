# Codex 手机控制台

这是给使用者看的操作说明。所有命令都在 **Windows PowerShell** 执行，不需要 WSL，也不需要打开特殊入口。

## 先做这一步

每次打开 PowerShell 后，先进入项目目录：

```powershell
$ProjectRoot = 'C:\path\to\codex-mobile-console' # 改成实际项目目录
Set-Location $ProjectRoot
```

以后优先使用统一入口：

```powershell
.\scripts\codex-mobile.ps1 help
```

协议参考文件见 [Codex app-server 协议基线](protocol/schema/codex-app-server-baseline/)。目录中的 `0.147.0-alpha.6.5` 只是协议快照的来源版本，不是本项目版本，也不会锁定 Codex Desktop 或共享 app-server 的运行版本；运行时版本由脚本从 Windows 主机上动态解析。

### 只记这四条

| 目的 | 命令 | 是否会中断任务 |
|---|---|---:|
| 看状态 | `.\scripts\codex-mobile.ps1 status` | 否 |
| 做只读诊断 | `.\scripts\codex-mobile.ps1 diagnose` | 否 |
| 4500 未运行时启动 | `.\scripts\codex-mobile.ps1 start-4500` | 否 |
| 配置变更后维护重载 | `.\scripts\codex-mobile.ps1 reload -Apply -Confirmation RELOAD_SHARED_APP_SERVER` | 会，先关闭客户端 |

表格中的命令前不需要输入多余空格；复制下面代码块中的版本即可。遇到问题先执行 `status` 和 `diagnose`，不要直接双击或手动再启动一个 `codex.exe app-server`。

## 正常使用

先记住两个端口：

| 端口 | 作用 | 谁在使用 |
|---|---|---|
| `4500` | 共享 Codex app-server，保存任务运行状态并处理协议 | Codex Desktop、手机网关 |
| `4174` | 手机网页/PWA 网关 | iPhone Safari/PWA |

看门程序负责检查并按需启动这两个服务。安装过 Windows 登录自启动后，通常不需要手动分别启动 4500 和 4174；重启电脑后只需检查状态，缺哪个再用统一入口补起。

重启电脑后的标准操作：

```powershell
Set-Location $ProjectRoot
.\scripts\codex-mobile.ps1 status
```

如果看门没有运行：

```powershell
.\scripts\codex-mobile.ps1 start
```

如果 4500 没有运行：

```powershell
.\scripts\codex-mobile.ps1 start-4500
```

如果只有手机页面打不开而 4500 正常：

```powershell
.\scripts\codex-mobile.ps1 restart-gateway -Apply -Confirmation RESTART_MOBILE_GATEWAY
```

正常状态必须同时看到：4500 进程运行、`initialize + thread/list` 协议检查通过、磁盘配置已应用、手机网关运行。仅有端口监听或 `readyz=200` 不代表任务协议可用。

手机地址：

```text
https://<WINDOWS_PRIVATE_IP>:4174/
```

手机和桌面端使用同一套任务与聊天记录。

聊天输入栏支持一次选择最多 4 张图片。较大的照片会先在手机端压缩，再通过已认证的 4174 HTTPS 网关保存到 Windows 的 `.runtime\private\uploads\images`，随后以 `localImage` 交给共享 4500；图片文件和密钥一样不会提交到 Git。

## 部署（新机器第一次安装）

部署位置是 Windows 本机，不是 WSL。需要先准备：

- 已安装 Codex Desktop，并能正常登录或使用本地 provider。
- Node.js 22 或更高版本、Git、PowerShell 7。
- Windows 主机已接入 EasyTier、WireGuard 或其他私有网络，手机可以访问该主机的私网地址；实际地址只填写在本机配置中。
- 手机网关证书：`.runtime\tls\codex-mobile-server.crt`。
- 手机网关私钥：`.runtime\private\tls\codex-mobile-server.key`。

证书是手机访问 HTTPS 所必需的。自签名证书不需要购买，但必须把 CA 配置文件 `.runtime\tls\codex-mobile-ca.mobileconfig` 安装并信任到 iPhone。证书生成和 EasyTier 参数见 [docs/easytier-codex-remote.md](docs/easytier-codex-remote.md)。证书、私钥和 `.runtime\private` 不提交 Git。

首次部署时，把 Windows 私网地址保存为当前用户环境变量；脚本会读取它，未配置时只使用本机回环地址：

```powershell
[Environment]::SetEnvironmentVariable('CODEX_MOBILE_HOST', '<WINDOWS_PRIVATE_IP>', 'User')
```

设置后重新打开 PowerShell。`<WINDOWS_PRIVATE_IP>` 只替换为自己的私网地址，不要提交到仓库。

从另一台 Windows 机器迁移时，把这些运行文件通过安全方式放回相同路径；不要从 Git 拉取，也不要把私钥粘贴到聊天里。部署前可以只检查文件是否存在：

```powershell
Test-Path .\.runtime\tls\codex-mobile-server.crt
Test-Path .\.runtime\tls\codex-mobile-ca.mobileconfig
Test-Path .\.runtime\private\tls\codex-mobile-server.key
```

首次部署命令：

```powershell
Set-Location $ProjectRoot
npm ci
npm run build
```

首次生成配对密钥（已经在使用的机器不要重复执行）：

```powershell
pwsh -File .\scripts\new-pairing-secret.ps1
```

保护配对密钥、会话文件和私钥：

```powershell
pwsh -File .\scripts\protect-sensitive-runtime.ps1 -Apply
```

安装 Windows 登录自启动并立即启动：

```powershell
.\scripts\codex-mobile.ps1 install -Apply -Confirmation INSTALL_CODEX_MOBILE_AUTOSTART
.\scripts\codex-mobile.ps1 start
```

部署完成后验证：

```powershell
.\scripts\codex-mobile.ps1 status
.\scripts\codex-mobile.ps1 diagnose
```

应看到 4500 和 4174 正常，`healthz=200`、`readyz=200`，并且 `4500协议` 的 `initialize + thread/list` 通过。看门只维护一个共享 4500，不复制会话库，也不启动第二个 app-server。

### iPhone 安装

1. 在 iPhone 上连接同一 EasyTier 网络。
2. 用 Safari 打开 `https://<WINDOWS_PRIVATE_IP>:4174/`；Chrome 可以访问，但添加到主屏幕优先使用 Safari。将占位符替换为 Windows 主机的私网地址。
3. 按页面提示输入配对密钥。密钥只从 Windows 本机读取：

```powershell
Get-Content -LiteralPath .\.runtime\private\pairing-secret.txt
```

4. 需要 PWA 时，在 Safari 使用“分享”->“添加到主屏幕”。

## 部署更新（代码或 Codex 升级后）

先确认当前任务已完成，再更新项目：

```powershell
Set-Location $ProjectRoot
git status
git pull --ff-only origin main
npm ci
npm run build
```

构建完成后只重启看门，让新脚本生效：

```powershell
.\scripts\codex-mobile.ps1 restart
.\scripts\codex-mobile.ps1 diagnose
```

这一步不会主动重启 4500。若本次更新包含 `src/server` 或网页代码，还需要重启手机网关使新的 `dist` 生效：

```powershell
.\scripts\codex-mobile.ps1 restart-gateway -Apply -Confirmation RESTART_MOBILE_GATEWAY
```

Codex Desktop 升级导致旧运行时路径变化时，看门会自动发现新 bundle、生成快照，并在 4500 下次退出或维护重载时使用它。

如果 `status` 显示“配置待处理”，先关闭 Codex Desktop 和手机页面，执行 `reload` 预览；确认没有连接后再使用带 `-Apply` 的重载命令。更新过程不编辑 `state_5.sqlite`，也不会替换 API key。

## 启动、停止、重启

### 管理共享 4500

这组命令直接管理共享 Codex App Server。桌面端和手机端都依赖它。

查看 4500 的真实协议状态：

```powershell
.\scripts\codex-mobile.ps1 check-4500
```

启动 4500：

```powershell
.\scripts\codex-mobile.ps1 start-4500
```

启动命令会复用现有实例；检测到其他 app-server 时会停止操作，不会启动第二个实例。它还会恢复看门，并实测 `initialize + thread/list`。

停止 4500 时先预览：

```powershell
.\scripts\codex-mobile.ps1 stop-4500
```

关闭 Codex Desktop 和手机页面、确认没有正在执行的任务后再执行：

```powershell
.\scripts\codex-mobile.ps1 stop-4500 -Apply -Confirmation STOP_SHARED_APP_SERVER
```

停止命令会同时暂停看门，否则看门会在 30 秒内重新拉起 4500。4174 保持运行，但在 4500 恢复前不能读取任务。使用 `start-4500` 恢复。

重启 4500 时先预览：

```powershell
.\scripts\codex-mobile.ps1 restart-4500
```

确认没有桌面端和手机连接后执行：

```powershell
.\scripts\codex-mobile.ps1 restart-4500 -Apply -Confirmation RELOAD_SHARED_APP_SERVER
```

`restart-4500` 和原来的 `reload` 使用同一套受控重启逻辑：停止旧 PID、启动一个新 PID、应用最新配置指纹、验证新进程。它不会编辑 `state_5.sqlite`。

### 管理看门

```powershell
# 启动看门
.\scripts\codex-mobile.ps1 start

# 停止看门
.\scripts\codex-mobile.ps1 stop

# 重启看门
.\scripts\codex-mobile.ps1 restart
```

看门负责自动维护 4500 和 4174。`stop` 和 `restart` 不会主动停止桌面端、正在执行的任务或共享 4500。

## 第一次安装自动启动

只需安装一次：

```powershell
.\scripts\codex-mobile.ps1 install -Apply -Confirmation INSTALL_CODEX_MOBILE_AUTOSTART
```

以后 Windows 登录后会自动启动看门。取消自动启动：

```powershell
.\scripts\codex-mobile.ps1 uninstall -Apply -Confirmation REMOVE_CODEX_MOBILE_AUTOSTART
```

取消自动启动不会删除任务、聊天记录或配置。

## Codex 打不开或升级后异常

按顺序执行下面三条：

```powershell
.\scripts\codex-mobile.ps1 diagnose
.\scripts\codex-mobile.ps1 status
.\scripts\codex-mobile.ps1 start
```

诊断会显示 Codex/app-server 版本、4500/4174 的实际 PID、`healthz`、`readyz`、配置状态和常见错误次数。诊断是只读的，不会停止进程，不会修改 `state_5.sqlite`，不会显示 API key。

即使 Codex Desktop 完全打不开，PowerShell 和这套脚本仍然可以运行；不要等 Desktop 打开后才诊断。

只有 `readyz=200` 且 `4500协议` 显示 `initialize + thread/list` 通过，才说明共享 app-server 可以读取任务。如果 4500 未运行，使用 `start-4500`；如果 4500 已运行但协议异常或配置待处理，先关闭客户端，再在维护窗口使用 `restart-4500`。

## 配置切换后没有生效

如果切换了 provider、API key 或其他 Codex 配置，先预览：

```powershell
.\scripts\codex-mobile.ps1 reload
```

预览显示桌面端和手机端都没有连接后，再执行：

```powershell
.\scripts\codex-mobile.ps1 reload -Apply -Confirmation RELOAD_SHARED_APP_SERVER
```

有任务运行时不要执行 `-Apply`。关闭 Codex Desktop 和手机页面，等任务完成后再操作。这个命令只重启共享 app-server，不改会话数据库。重载完成后再运行：

```powershell
.\scripts\codex-mobile.ps1 diagnose
```

确认 `4500协议` 通过、配置状态为“已应用”后，再重新打开桌面端或手机页面。

## 只重启手机网关

手机页面打不开、但桌面端正常时，只重启 4174：

```powershell
.\scripts\codex-mobile.ps1 restart-gateway -Apply -Confirmation RESTART_MOBILE_GATEWAY
```

这不会重启 4500，也不会影响桌面任务。

## 完整回滚

只有需要撤销手机控制台接入时才使用。先预览：

```powershell
pwsh -File .\scripts\rollback.ps1
```

确认预览内容后执行：

```powershell
pwsh -File .\scripts\rollback.ps1 -Apply -Confirmation ROLLBACK_SHARED_APP_SERVER
```

回滚不会修改 `state_5.sqlite`。它会停止并禁用手机看门、停止共享 4500，并恢复桌面端原连接方式；已经单独运行的 4174 手机网关不会由回滚脚本强制结束。如需完全关闭手机入口，回滚完成后再执行：

```powershell
.\scripts\codex-mobile.ps1 stop-gateway -Apply -Confirmation STOP_MOBILE_GATEWAY
```

正在运行任务时不要回滚。

## 影响范围速查

| 命令 | 作用 | 会停止 4500？ | 会影响桌面任务？ |
|---|---|---:|---:|
| `status` | 查看状态 | 否 | 否 |
| `diagnose` | 只读诊断 | 否 | 否 |
| `check-4500` | 实测 initialize + thread/list | 否 | 否 |
| `start-4500` | 启动 4500 并恢复看门 | 否 | 否 |
| `stop-4500 -Apply` | 暂停看门并停止 4500 | 是 | 需先关闭连接 |
| `restart-4500 -Apply` | 受控重启并应用配置 | 是 | 需先关闭连接 |
| `start` | 启动看门 | 否 | 否 |
| `stop` | 停止看门 | 否 | 否 |
| `restart` | 重启看门 | 否 | 否 |
| `restart-gateway` | 重启手机网关 | 否 | 否 |
| `reload -Apply` | 应用配置 | 是 | 需先关闭连接 |
| `rollback -Apply` | 撤销看门和共享 4500 接入（4174 另行停止） | 是 | 需先停止任务 |

不要手动启动第二个 `codex.exe app-server`，不要直接编辑 `state_5.sqlite`，不要把 4500 暴露到局域网或公网。

## 日志位置

- 看门日志：`.runtime\autostart.log`
- 手机网关日志：`.runtime\gateway.ndjson`
- app-server 错误日志：`.runtime\shared-app-server.stderr.log`

需要把结果交给其他 Agent 时，直接把下面命令的输出发给它：

```powershell
.\scripts\codex-mobile.ps1 diagnose
```
