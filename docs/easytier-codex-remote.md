# 私有网络接入说明（EasyTier / WireGuard）

> 这是公开仓库可使用的概要说明。真实公网地址、私网地址、网络密钥、SSH 用户和证书内容只保存在部署机器上，不写入仓库。

## 1. 用途与边界

手机通过现有的 EasyTier、WireGuard 或同类私有网络访问 Windows 上的手机网关。网关再通过本机回环地址连接唯一的 Codex app-server；桌面端和手机端继续共用同一任务与会话存储。

逻辑拓扑如下：

```text
iPhone
  |  私有网络客户端
  v
私有网络中继（可选公网入口）
  v
家庭网关 / 局域网路由
  v
Windows 主机
  |-- 127.0.0.1:4500  共享 Codex app-server（仅本机）
  `-- <WINDOWS_PRIVATE_IP>:4174  手机 HTTPS 网关
```

4500 只监听 Windows 回环地址，不直接暴露给局域网或公网；手机只访问 4174。私有网络的路由、防火墙和密钥由部署者自行维护。

## 2. 部署时填写的本地参数

下面的占位符仅用于示例，真实值放在本机环境变量、服务配置或密码管理器中：

| 参数 | 示例占位符 | 说明 |
|---|---|---|
| 私有网络中继 | `<RELAY_HOST>:<UDP_PORT>` | 手机或网关的私有网络入口 |
| 手机私网地址 | `<MOBILE_OVERLAY_IP>` | 由 EasyTier/WireGuard 分配 |
| Windows 私网地址 | `<WINDOWS_PRIVATE_IP>` | 手机访问 4174 的地址 |
| 局域网网段 | `<LAN_SUBNET>` | 仅在确实需要访问时发布 |
| 覆盖网段 | `<OVERLAY_SUBNET>` | 手机、网关和 Windows 之间的私网段 |

网络密钥、SSH 私钥、证书私钥和配对密钥不要写入 README、Git 或聊天记录。

## 3. Codex Mobile Console

项目目录：`<PROJECT_DIR>`

```text
共享 app-server：ws://127.0.0.1:4500
手机网关：      https://<WINDOWS_PRIVATE_IP>:4174
```

日常优先使用统一管理入口：

```powershell
$ProjectRoot = 'C:\path\to\codex-mobile-console' # 改成实际项目目录
Set-Location $ProjectRoot
.\scripts\codex-mobile.ps1 status
.\scripts\codex-mobile.ps1 start
```

- `start`：启动看门，并按需补起 4500 与 4174。
- `start-4500`：仅在 4500 未运行时使用。
- `restart-gateway -Apply -Confirmation RESTART_MOBILE_GATEWAY`：只重启 4174。
- `restart-4500 -Apply -Confirmation RELOAD_SHARED_APP_SERVER`：维护窗口重启 4500；执行前关闭桌面端和手机页面。

不要手动启动第二个 `codex.exe app-server`，也不要让 4500 绑定到 `0.0.0.0`。

### 首次部署或单独调试

只有在首次部署、排查网关或没有安装看门任务时，才直接设置环境变量运行网关：

```powershell
$ProjectRoot = 'C:\path\to\codex-mobile-console' # 改成实际项目目录
Set-Location $ProjectRoot
$env:CODEX_MOBILE_HOST = '<WINDOWS_PRIVATE_IP>'
$env:CODEX_MOBILE_PORT = '4174'
$env:CODEX_MOBILE_APP_SERVER_URL = 'ws://127.0.0.1:4500'
$env:CODEX_MOBILE_PAIRING_SECRET_FILE = "$PWD\.runtime\private\pairing-secret.txt"
$env:CODEX_MOBILE_TLS_CERT = "$PWD\.runtime\tls\codex-mobile-server.crt"
$env:CODEX_MOBILE_TLS_KEY = "$PWD\.runtime\private\tls\codex-mobile-server.key"
$env:CODEX_MOBILE_LOG_FILE = "$PWD\.runtime\gateway.ndjson"
$env:CODEX_MOBILE_SESSION_STORE_FILE = "$PWD\.runtime\private\sessions.json"
pwsh -File .\scripts\start-gateway.ps1
```

部署完成并安装看门后，改用 `scripts\codex-mobile.ps1`，避免手动启动重复的 4174 进程。

## 4. HTTPS 与防火墙

- 手机网关绑定非回环地址时必须启用 HTTPS。
- 自签名证书可以免费生成；iPhone 需要安装并信任对应 CA 配置文件。
- Windows 防火墙只放行来自覆盖网段的 TCP 4174：

```text
TCP 4174 / 来源 <OVERLAY_SUBNET>
```

- 4500 保持 `127.0.0.1:4500`，不添加公网端口映射。

## 5. 手机访问与快速检查

在 iPhone 连接私有网络后打开：

```text
https://<WINDOWS_PRIVATE_IP>:4174/
```

Windows 上检查网关连通性：

```powershell
Test-NetConnection <WINDOWS_PRIVATE_IP> -Port 4174
pwsh -File .\scripts\show-gateway-logs.ps1
```

`/api/health` 需要登录会话；未登录返回 401 属于正常认证行为。

若手机能连私有网络但打不开页面，依次检查：私有网络路由、Windows 防火墙、网关证书与绑定地址、4174 监听状态。若页面能打开但任务读取或发送失败，再执行：

```powershell
.\scripts\codex-mobile.ps1 check-4500
.\scripts\codex-mobile.ps1 diagnose
```

只在维护窗口应用配置或重启 4500；不要直接编辑会话数据库。
