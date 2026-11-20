# Codex 手机控制台

这是给使用者看的操作说明。所有命令都在 **Windows PowerShell** 执行，不需要 WSL，也不需要打开特殊入口。

遇到“正在维护”、反复“配置待重载”，或分不清该重启哪个服务，请看 [维护与重载说明](docs/maintenance-and-reload.md)。它说明三个服务的边界、等待原因、检查和恢复步骤。

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

不想记 PowerShell 参数时，直接双击项目根目录的 `codex-mobile.cmd`。它会显示中文菜单：查看状态、诊断、启动/停止看门、启动/停止/重启 4500、重启 4174、安装或取消自启动。停止和重启操作会要求输入 `YES`，并继续使用底层的连接检查和受管进程校验。

也可以在命令行运行：

```cmd
cd /d C:\path\to\codex-mobile-console
codex-mobile.cmd
```

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

手机和桌面端使用同一套任务与聊天记录。网页点进会话后会进入对话页，点「返回任务」回到列表；不要依赖浏览器后退以外的空白区域退出。

任务列表右上角可以新建会话。工作目录从已有项目中选择，或输入 Windows 绝对路径。新建只会调用共享 4500 的 `thread/start`，不会改 `state_5.sqlite`，也不会启动第二个 app-server。

聊天输入栏点击回形针，可选择「照片或图片」「文件或压缩包」「文件夹」，也可以拖入文件或文件夹。附件在发送时上传，并显示进度；文件夹保留内部层级，ZIP 等压缩包原样保存，不自动解压。每条消息最多 10 个文件附件，单文件最多 100 MiB，单个文件夹最多 256 MiB、2,000 个文件。手机浏览器若不支持选择文件夹，请先压缩为 ZIP 后上传。

文件附件保存在 Windows 的 `.runtime\private\uploads\attachments`，发送时把已登记附件的路径交给共享 4500，由 Codex 按需读取。附件不提交到 Git，聊天页面只显示名称。图片仍使用独立通道：一次最多 4 张，每张上传上限 8 MiB；较大照片会先在手机端压缩，保存到 `.runtime\private\uploads\images`，再以 `localImage` 交给共享 4500。Codex 回图（`imageView` / `imageGeneration`）会显示在对话里：网关只把已签名的认证地址发给手机，不把 Windows 原路径暴露到网页。

Codex 输入栏的上下文圆环显示当前已用比例，点击可展开查看剩余比例和 token 数。打开旧会话时读取最近记录，运行时随真实 token 通知更新；尚无记录或模型未报告容量时显示「未知」，不按累计 token 猜测。

## 部署（新机器第一次安装）

私网拓扑和部署验证可参考[部署记录模板](docs/easytier-deployment-template.md)。

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

Codex Desktop/primary runtime 升级后，看门会独立检测安装目录中的完整 bundle。候选必须连续两次保持相同，随后才会复制到 `.runtime\codex-bundles` 并登记“版本切换待处理”。此过程不会停止健康的 4500，也不会把未验证候选直接覆盖为首选版本。

```powershell
.\scripts\codex-mobile.ps1 status
```

状态会分别显示“已安装版本”“4500 实际版本”“版本切换目标”和“版本等待原因”。两者不一致时，以 4500 监听 PID 的 `ExecutablePath` 及该文件的 `--version` 为准；PATH 中的 `codex --version` 只代表磁盘安装版本。

版本候选完成预存后，等任务结束，再关闭 Codex Desktop 和手机页面。看门只有在客户端已断开、任务明确空闲，并连续两次检查通过后才自动重载（默认约 1 分钟）。任务仍在执行、状态未知或检查失败时继续等待，不会因等待时间过长而强制停止 4500。

自动重载失败后，默认冷却 5 分钟再有限重试；同一目标累计失败 3 次后暂停，避免不断重启。`status` 会显示冷却、暂停或具体阻塞原因；失败阶段和回滚结果保存在本机 `.runtime/failed-auto-reload.json`。旧版失败标记也纳入该机制，不再一次失败就永久静默跳过。要自己掌控时机，用等待模式：

```powershell
.\scripts\codex-mobile.ps1 restart-4500 -Wait -Apply -Confirmation RELOAD_SHARED_APP_SERVER
```

预览会列出阻塞连接和目标版本。正式重载会明确授权启动待切换快照，核对新 PID、实际路径、完整 bundle 哈希、`--version`、`readyz`、`initialize + thread/list` 与配置指纹；启动或验证失败时会恢复上一个已验证快照，并保留待处理标记供诊断。快速连续升级只会在最新候选连续稳定后更新目标；若 4500 在维护前意外退出，看门仍恢复旧首选快照，不会借故障自愈偷偷切换版本。

如果 `status` 显示“配置待处理”，先关闭 Codex Desktop 和手机页面，执行 `reload` 预览；确认没有连接后再使用带 `-Apply` 的重载命令。更新过程不编辑 `state_5.sqlite`，也不会替换 API key。

### 如何理解“已升级，但配置仍待处理”

版本切换、配置应用和待处理标记是不同状态。以「4500实际版本」确认升级，以协议检查确认服务可用，不要仅凭“待处理”就判断升级失败。

重载期间，如果外部配置切换工具或桌面再次保存配置，新进程可能已正常启动，但磁盘又出现下一批变更。此时应保留健康进程，将新配置留到下一个安全维护窗口；不应只因标记仍存在就回滚、再重启。若只剩已经应用过的旧版本标记，看门在核对运行程序和完整 bundle 哈希后忽略该旧标记，不需要为清标记再重启一次。

遇到这种提示，先执行 `status` 和不带 `-Apply` 的 `restart-4500` 预览。不要连续运行强制停止命令，也不要手动删除待处理文件来隐藏问题。

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

重启 4500 推荐这样做：先启动等待，再关窗口。

```powershell
.\scripts\codex-mobile.ps1 restart-4500 -Wait -Apply -Confirmation RELOAD_SHARED_APP_SERVER
```

先等任务结束，再关闭 Codex Desktop 和手机页面。命令默认最多等 3 分钟，只有客户端断开且任务明确空闲后才重载；到时仍未满足条件则保留待处理状态。确认词也可以写成 `RESTART_4500`。

只看当前谁连着、会不会打断任务：

```powershell
.\scripts\codex-mobile.ps1 restart-4500
```

窗口已经关掉的话，可以直接：

```powershell
.\scripts\codex-mobile.ps1 restart-4500 -Apply -Confirmation RELOAD_SHARED_APP_SERVER
```

`restart-4500` 和 `reload` 是同一套受控重启：停旧 PID、起新 PID、应用配置、验证协议。不会编辑 `state_5.sqlite`。

看门在桌面开着时不会重载。关掉桌面和手机后，只有任务明确空闲且连续检查通过才会自动重载。`status` 的「重载等待」会写明卡在桌面、手机、运行中任务、未知状态、失败冷却还是暂停。不要用 `Stop-Process`，不要再开第二个 `codex.exe app-server`。

### 升级后仍显示旧版本，怎么办？

1. 运行 `.\scripts\codex-mobile.ps1 status`，对比「已安装版本」和「4500实际版本」，并看「版本等待原因」。桌面窗口重开不等于后台 4500 已换版本。
2. 运行 `.\scripts\codex-mobile.ps1 restart-4500` 只看预览；它不会停止进程或写入配置。
3. 等所有任务完成后，再执行上面的 `restart-4500 -Wait -Apply` 命令，并关闭桌面和手机页面。
4. 重载结束后重新运行 `status`，确认实际版本、协议检查和配置状态。失败时看 `.runtime/failed-auto-reload.json` 与 `.runtime/reload-watch.*.stderr.log`，不要删除标记或反复强杀进程。

**更新脚本不等于已启用新看门。** 完成本节操作前，可在维护窗口用 `.\scripts\codex-mobile.ps1 restart` 让新看门生效。该命令本身只重启看门，但新看门发现待处理升级且满足空闲条件时会自动重载 4500；正在执行任务时不要把它当成无影响的状态检查。

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
| `restart-4500 -Wait -Apply` | 先等窗口断开再受控重启 | 是 | 先运行再关窗口 |
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

## 查看完整执行详情

Codex 对话默认只显示轻量摘要，避免长日志拖慢手机。展开“执行过程”和对应工具卡片后，点击 **查看完整输出** 或 **查看完整差异**，即可读取 app-server 保留的命令输出或文件 diff。

- 长内容分段加载，点击 **加载更多详情** 继续读取；代码和日志区域支持左右滑动。
- 文件 diff 区分新增、删除和区块标题；一次修改的多个文件都会保留。
- 任务还在运行时，可点击 **刷新详情** 获取最新内容；页面不会自动反复拉取完整日志。
- 如果历史分页或内容版本发生变化，按提示刷新详情或对应历史记录。app-server 本身未保存的内容不会由手机端补造。
- 查看详情只执行读取请求，不恢复会话、不启动 MCP、不修改任务或会话库。

## Claude Code 手机控制

手机仍打开原来的 4174 网址，导航中的 **Codex / Claude** 分别显示两套会话。

- **已支持**：按项目查看 Claude 会话、分页历史、继续已有会话、流式回答、公开思考、工具执行过程、错误详情、停止任务、审批及回答 Claude 提问；折叠的模型/推理强度/权限设置、实时耗时、已报告 Token 和独立子任务进度卡片。
- **新建会话**：在 Claude 会话列表点击“新建会话”，选择已有项目目录，或填写电脑上已存在的绝对目录。进入会话后可选择模型、推理强度和权限，再发送第一条消息。点击创建本身不调用模型、不启动 CLI/MCP；空会话保存于本机 `.runtime/private/claude-mobile-sessions.json` 私有索引，首次发送时才由官方 SDK 创建 Claude 历史。该索引也用于识别手机会话，不会将其他程序的顾问会话混入列表，备份时请保留。
- **尚未开放**：Claude 附件和历史图片。
- 4500 继续只负责 Codex；Claude 的 4600 是独立的本机服务，不是第二个 Codex app-server。
- 阅读历史和查看设置不调用模型、不启动 Claude CLI/MCP、不修改 Claude 会话；只有点发送才会由官方 SDK 续接本机 CLI。默认优先沿用会话模型，再使用本机用户/项目/本地设置，不在代码里固定模型、上游或 key。权限跟随本机设置（包括 `bypassPermissions` 免审批），也可以按会话选择逐次审批；Claude 向你询问选项时仍显示问题供你回答。

### 手机怎样继续任务

1. 打开 **Claude**，选择项目中的会话，在底部输入并发送。手机发起的任务会显示“正在启动 / 运行中 / 等待审批 / 已完成 / 执行失败”。
2. 需要工具权限时，在会话内选择“允许本次”或“拒绝”；需要回答问题时，填写回答再提交。单次允许不会写入永久权限规则。
3. 点击输入框旁的停止按钮，只停止当前手机任务。切换会话、锁屏或断网不会取消运行；重新打开页面会自动连接并取回当前状态及待审批内容。
4. 如果显示“电脑端占用”，先退出该会话对应的 Claude 终端。即使终端空闲，也不同时用两个进程续写同一会话；其他会话仍可正常使用。

输入框上方的“模型与权限”默认收起；手动选择仅在当前浏览器为该会话保存，从下一条消息生效，不改全局 Claude 配置。运行期间锁定设置，防止中途切换。

运行状态栏每秒更新耗时，后台返回后按实际时间恢复；Token 随 CLI 的用量事件实时刷新，包含输入、输出、缓存读取和缓存写入。上游尚未回传的数字显示“统计中”，不通过文本长度猜测；主会话和子任务的消息按 API 消息编号去重，子任务卡片的汇总不会再次叠加。续写后的会话累计 `modelUsage` 不当作本轮用量。

上游超时或返回错误时，列表和会话显示“上游重试中”，输入栏说明 HTTP 状态或连接错误、重试次数和等待情况。超过一分钟没有新进度会显示等待时长；计时增长不代表任务已经产出内容。收到新输出后自动恢复正常状态。重试沿用 Claude CLI 自身策略，不重复提交任务；可随时停止当前会话。重试和结束原因会写入 Claude 后台日志，便于排查。

子任务默认折叠，显示任务说明、状态和耗时，展开查看已报告 Token、最近工具动作、公开输出及错误。子任务内容与主对话分开。手机刷新后可恢复服务仍保留的运行快照；服务重启后的已完成过程以 CLI 历史为准，内存中的统计卡片不会永久保存。

最多同时运行四个手机 Claude 会话；第五个会给出明确提示。同一条消息发生网络重试时复用发送编号，避免重复启动任务。未由手机接管的历史标为“未接管”，不根据文件更新时间猜测运行状态。发送失败时先刷新确认记录，再决定是否重试。

### 部署和启停

在项目目录先运行 `npm ci` 和 `npm run build`。官方 SDK 固定为 `0.3.316`，兼容性探针对应 Claude CLI `2.1.316`；升级后需重新核对，不跟随 CLI 自动更新 SDK。

打开项目的中文管理菜单：

- **13 查看 Claude 状态**：只看 4600 状态。
- **14 启用 Claude 手机控制**：启动独立 4600，登记本机启用标记。
- **15 停止 Claude 服务**：取消启用，停止手机发起的 CLI 任务并关闭 4600；不停止 4174、4500 或独立终端中的 Claude 会话。

等价命令：

```powershell
.\scripts\codex-mobile.ps1 claude-status
.\scripts\codex-mobile.ps1 start-claude
.\scripts\codex-mobile.ps1 stop-claude
```

部署或升级本功能时，先执行 `npm ci` 和 `npm run build`，确认没有需要保留的手机 Claude 任务，再依次选择菜单 **15、14** 重启 4600，最后选择 **9** 重启手机网关 4174。**不需要重启 4500。** 新版停止流程会先清理手机任务及其 SDK 子进程，不直接强杀运行中的服务。现有看门脚本下次启动后会读取 `.runtime\claude-enabled` 并维护 4600；仅替换脚本不会更新已运行的进程。

4600 只监听 `127.0.0.1`，拒绝浏览器跨域访问。4174 在服务器端附加独立派生的内部凭据，手机不接触此凭据；写操作额外核对页面来源。公开版的 4174 默认要求配对验证；如果自行关闭验证，能访问网关的设备就能读取历史和操作 Claude。请仅通过可信私网访问，勿将此入口暴露到公网。实时反馈通过同一私网网关传输，断线重连不会重新发送任务。

为避免大历史拖慢本机，一次显示 30 条消息，缓存最多两页，不保留整份原始历史。官方 SDK 在独立读取线程中重建会话分支，每次只运行一个读取任务，线程 JS 堆预算为 256 MiB，超过 10 秒会结束本次读取。不再以 32 MiB 直接拒绝正常的大历史；单文件仍保留 128 MiB 的资源保护上限，超限或读取失败会明确提示，原始记录不做截断或改写。Claude 服务未启动时，页面提示 4600 未连接，Codex 功能仍可使用。

日志：`.runtime\claude-backend.stdout.log`、`.runtime\claude-backend.stderr.log`。内部凭据不写进日志。回退本功能可先选择菜单 15，再恢复更新前的代码及构建并仅重启 4174；不要为撤销 Claude 接入执行上面的“完整回滚”，那会涉及 Codex 4500。
