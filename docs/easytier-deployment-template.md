# 私有网络部署记录模板

公开仓库只保留拓扑和验证方法。真实地址、主机名、服务账号、密钥、证书和路由器路径填写在本地副本，不要提交 Git。

## 部署结果

- 中继节点：`<RELAY_HOST>`，服务状态：`<STATUS>`。
- 家庭网关：`<HOME_GATEWAY>`，私有网络地址：`<GATEWAY_OVERLAY_IP>`。
- Windows 主机：`<WINDOWS_PRIVATE_IP>`，发布网段：`<LAN_SUBNET>`。
- 手机私有地址：`<MOBILE_OVERLAY_IP>`。
- 手机网关：`https://<WINDOWS_PRIVATE_IP>:4174`。
- 共享 app-server：`ws://127.0.0.1:4500`，仅本机监听。

## 验证清单

- 中继与家庭网关连接正常。
- 家庭网关到 Windows 私网地址连通。
- Windows 防火墙仅允许覆盖网段访问 TCP 4174。
- 手机可打开 4174 并完成配对认证。
- `initialize + thread/list` 协议探针通过。
- 未配置公网端口映射，4500 未绑定到非回环地址。

## 回退边界

- 停止私有网络服务不会修改 Codex 会话数据库。
- 删除回程路由前先确认没有正在使用的任务。
- 网络密钥和 SSH 私钥只保存在部署机器或密码管理器中。
