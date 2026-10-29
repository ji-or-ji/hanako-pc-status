# PC Status

让 Agent 感知这台电脑的状态，并在长时间任务里保持时间感。

> 仓库两条线：`main` 是 v1 插件（永久兼容层，含崩溃监测）；`v2`（默认分支）是 v2 App。
> v2 用新的授权与生命周期，功能上少了一样东西，见下面「v2 少掉的一项」。

## 能力

**1. 工具 `machine_state`**

一次调用返回：

- 供电：交流电还是电池、电量百分比、是否在充电、剩余可用时间（多来源交叉取值）、电池健康
- 当前电源计划（含 GUID，可选列出全部方案）
- 系统：开机运行时长、CPU 瞬时负载、内存占用、各固定磁盘剩余空间
- `hana-server` / `hana-win-sandbox` / `HanaAgent` 进程是否存活、占用内存、已运行时长
- 内存占用前五的进程
- 风险提示：低电量、内存吃紧、磁盘将满、后端进程缺失

参数 `format: "json"` 可拿原始结构，适合需要精确数值判断的场合。

**2. 时钟注入（`tools/post-execute` 钩子）**

挂在工具返回链路上。任意工具返回时，若距上次注入已超过设定间隔（默认 10 分钟），
就在该次结果末尾追加一行：

```
[pc-status] 时钟 2026-10-27 20:29:17 +08:00 周二 · 电量 21%（偏低，充电中）
```

单次工具调用耗时超过 60 秒时，还会追加一行耗时提示。工具原本的输出不做改动。

电量落在偏低或危急区间、且当前模型匹配「鼓励语」规则时，再多一行：

```
[pc-status] 资源紧张只是提醒，不影响执行：按原计划完整做完，不要缩减输出。
```

这一条是为那些一看见资源紧张就开始缩手缩脚的模型准备的。v2 里模型标识来自一次
`session:get`，拿不到就当作未知、不追加（v1 是从 Pi 的 handler 上下文里取的）。

**3. 网络监测**

每隔一段时间探一次（默认 25 秒）：在线/离线切换后，下一次工具调用就提示；
断得够久（超过阈值，默认 5 分钟）时另外记一条，在下一轮对话开头递一张便条给 agent。

系统睡过一段时间再唤醒时，会重建基线而不是拿旧时间戳算「断网时长」，
否则关一晚机器会被报成断网八小时。

## v2 少掉的一项

v1 有「hana-server 异常终止后提醒 agent 对进度」。v2 里做不了诚实的版本：AppHost 拿不到
正常退出信号（宿主直接杀进程，Windows 上连 SIGTERM 处理器都不走），据此判断崩溃等于把每次
正常退出都报成崩溃。宁可不报，也不报错。要用这一条请留在 v1 那条线。

## 安装（v2）

把 `pc-status/` 整个目录（或打包出的 .zip）装进 HanaAgent 设置 → 扩展 → 已安装 → App 类目的安装入口。
首次装载的确认卡会列出它申请的能力：

- 跑外部命令（调用 PowerShell 采集状态）
- 在工具调用前后与回合开始前插手（时钟注入、网络便条）
- 访问 `www.baidu.com`（唯一的网络用途：探连通性）

要求宿主版本：1.3.6-beta 及以上。

## 为什么是 www.baidu.com

v1 直连 `223.5.5.5:53` 判 TCP、再单独查一次域名，能把「网断了」和「能连 IP 但解析不出来」分开。
v2 的 AppHost 用 Node 权限模型把 `net` 与 `dns` 全关了（实测都返 `ERR_ACCESS_DENIED`），
所以探测只能走宿主放行的出站通道，拿的是一个 HTTP 状态码。能拿到状态码就算在线，
DNS 那一维就跟着倒了，相关文案留着但不会再单独触发。

## 配置

两种入口，改的是同一份数据：

- **设置页**：设置 → 扩展 → PC Status，表单由清单的 `contributes.settings` 生成
- **工具**：`clock_control`，不带参数即查看

界面里的键名带头缀（`textBatteryLowCharging`），工具参数里用短名（`batteryLowCharging`），两种写法工具都认。

### 注入行为

| 参数 | 默认 | 说明 |
|------|------|------|
| `enabled` | true | 是否启用时钟注入 |
| `intervalMinutes` | 10 | 两次注入的最小间隔（分钟） |
| `includeVitals` | true | 注入时是否附带电量 |
| `reportSlowToolSeconds` | 60 | 慢调用提示阈值，0 关闭 |
| `networkWatchEnabled` | true | 监测网络状态切换 |
| `networkProbeIntervalSeconds` | 25 | 探测间隔，10 到 300 秒 |
| `networkOutageThresholdMinutes` | 5 | 断网超过这么久算一次「被打断」 |

### 阈值

| 参数 | 默认 | 说明 |
|------|------|------|
| `batteryLowPercent` | 30 | 电量低于或等于它算偏低 |
| `batteryCriticalPercent` | 10 | 电量低于或等于它算危急 |
| `memoryHighPercent` | 92 | 内存使用率达到它告警 |
| `diskLowGB` | 5 | 任一磁盘剩余低于它告警 |
| `serverMemoryHighMB` | 2048 | hana-server 占用超过它告警 |

危急线高于低位线时会被自动压回低位线，避免告警顺序失去意义。

### 文案

`texts` 里只传要改的键，其余保持不变；`resetTexts: true` 一次恢复全部默认。

| 键 | 用在哪 |
|----|--------|
| `batteryCritical` | 电量危急告警 |
| `batteryLowDischarging` | 电量偏低且未接电源 |
| `batteryLowCharging` | 电量偏低但在充电 |
| `memoryHigh` | 内存告警 |
| `diskLow` | 磁盘告警 |
| `serverMissing` | hana-server 不在 |
| `serverHeavy` | hana-server 占用过大 |
| `clockLine` | 注入的时钟行 |
| `clockVitalsSuffix` | 时钟行里电量摘要的前导分隔 |
| `slowTool` | 慢调用提示 |
| `networkOffline` | 网络中断 |
| `networkOnline` | 网络恢复 |
| `networkDnsDown` / `networkDnsBack` | DNS 异常与恢复（v2 实际不会触发） |
| `encouragement` | 鼓励语本体 |

可用占位符：`{percent}` `{usedPercent}` `{disk}` `{freeGB}` `{memoryMB}` `{clock}`
`{offset}` `{weekday}` `{vitals}` `{vitalsSuffix}` `{tool}` `{elapsed}` `{seconds}`
`{reason}` `{duration}`。
模板只替换认识的占位符，写错的 `{xxx}` 会原样留在输出里，方便一眼看出笔误。

### 鼓励语

| 参数 | 默认 | 说明 |
|------|------|------|
| `encouragementMode` | auto | `auto` 看模型、`always` 只看电量、`off` 关闭 |
| `encouragementText` | 空 | 空则沿用 `texts.encouragement` |
| `encouragementModels` | `deepseek` | auto 模式下按子串匹配模型标识 |

## 权限

v2 的权限按能力逐项声明，装载确认卡里逐条列出，之后可以在设置 → 安全 → 应用能力里单独开关：

- `app/process.spawn` —— 调用 PowerShell 采集状态（这扇门在进程启动时决定，改要重启 App）
- `app/hooks.tools-pre-execute` / `app/hooks.tools-post-execute` —— 时钟、电量、慢调用旁注
- `app/hooks.agent-before-start` —— 断网便条
- `app/tools.expose-to-model` —— 让模型能主动调用 `machine_state`
- `network.allowedHosts: www.baidu.com` —— 唯一的出站目标

## 平台

仅 Windows。状态采集走 PowerShell 5.1（`GetSystemPowerStatus` P/Invoke + 少量 CIM 查询），
不依赖第三方模块，也不需要管理员权限。电池健康查询在部分机型上会返回空，属正常。

## 自测

```bash
node test/hooks.test.mjs           # 时钟注入、节流、断网便条、machine_state
node test/clock-control.test.mjs   # 查看/修改配置的写入路径
node test/network-watch.test.mjs   # 探测判定、去抖状态机、待提示事件
```

三个测试都用假 sdk 驱动，不启动 Hana。`hooks.test.mjs` 会真实调一次 PowerShell。

## 实现说明

- 脚本以 `-EncodedCommand`（UTF-16LE base64）送入，避免 Windows PowerShell 5.1
  按 ANSI 读 UTF-8 脚本导致中文乱码
- 注入失败一律静默降级，绝不污染工具返回
- 采集分两档：完整状态约 2 到 3 秒，轻量电量约 0.5 秒（仅注入时使用）
- 配置每次读都有 5 秒缓存，工具返回链路上不至于每一步都走一次 RPC；`clock_control`
  写完配置会主动让缓存失效

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
