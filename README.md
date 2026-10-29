# PC Status

让 Agent 感知这台电脑的状态，并在长时间任务里保持时间感。

## 两个能力

**1. 工具 `pc-status_machine_state`**

一次调用返回：

- 供电：交流电还是电池、电量百分比、是否在充电、剩余可用时间（多来源交叉取值）、电池健康
- 当前电源计划（含 GUID，可选列出全部方案）
- 系统：开机运行时长、CPU 瞬时负载、内存占用、各固定磁盘剩余空间
- `hana-server` / `hana-win-sandbox` / `HanaAgent` 进程是否存活、占用内存、已运行时长
- 内存占用前五的进程
- 风险提示：低电量、内存吃紧、磁盘将满、后端进程缺失

参数 `format: "json"` 可拿原始结构，适合需要精确数值判断的场合。

**2. 时钟注入（extension）**

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

这一条是为那些一看见资源紧张就开始缩手缩脚的模型准备的。它默认只在检测到
DeepSeek 系模型时出现，因为 extension 能通过 Pi SDK 的 handler 上下文拿到当前模型标识；
工具层拿不到模型，所以 `machine_state` 的告警里只会体现 `always` 模式。

**3. 崩溃监测（lifecycle + extension）**

hana-server 崩掉时连日志都写不出来，插件也随之消失，那一刻什么都记不下。
所以反过来做：运行期间每 20 秒写一次心跳时间戳，下次启动时看断点有多远。

判定为“上一次异常终止”需要同时满足：

- 心跳断点超过 90 秒
- 断点不超过 2 小时（更久更可能是关机或长期离线）
- 没有晚于心跳的干净退出标记
- 进程号变了（同 pid 只是插件重载，不算崩溃）

命中后写一条待提醒记录，extension 在下一个会话启动时递一张便条给 agent：

```html
<pc-status-crash-notice>
上一轮 hana-server 不是正常退出的，它在运行中直接断掉了。
最后心跳时间：2026-10-27 20:51:53 +08:00
中断约 3分3秒 后重新启动。
崩溃前这次运行已经持续了 1小时57分。

这意味着上一段工作可能在你不知道的地方停住了...
</pc-status-crash-notice>
```

这条消息用 `display: false` 发出，用户看不见，只有 agent 收到，且只提醒一次。
`machine_state` 里也会显示 `上次崩溃` 一行，方便事后排查。

**4. 网络监测（lifecycle + extension）**

每隔一段时间探一次基础连通（默认 25 秒），不算域名，直接 TCP 连 `223.5.5.5:53` 这类固定地址，避免 DNS 本身坏掉时误判。连通后再单独查一次常用域名，区分两种情况：

| 状态 | 含义 |
| :-- | :-- |
| 在线 | TCP 通，DNS 正常 |
| 离线 | TCP 不通 |
| DNS 异常 | TCP 通但域名解析不出来 |

状态切换要连续两次探测一致才确认，防抖动。变动分两档处理：

- **普通变动**：在下一次工具调用时就注入一行，不用等新会话。比如 `[pc-status] 网络已恢复（中断约 2小时5分）`
- **断得久**（超过阈值，默认 5 分钟）：额外记一条，下次会话开头给 agent 递一张便条，跟崩溃提醒一个待遇

系统睡过一段时间再唤醒时，会重建基线而不是拿旧时间戳算“断网时长”，否则关一晚机器会被报成断网八小时。

## 配置

两种入口，改的是同一份数据：

- **设置界面**：插件管理里点这个插件的齿轮，表单由 manifest 的 `contributes.configuration` 生成
- **工具**：`pc-status_clock_control`，不带参数即查看

界面里的键名带头缀（`textBatteryLowCharging`），工具参数里用短名（`batteryLowCharging`），两种写法工具都认。

配置落在 `${HANA_HOME}/plugin-data/pc-status/config.json`，结构是 `{ schemaVersion, global, agents, sessions }`，实际值在 `global` 里。extension 直接读这个文件，所以界面改完一分钟内就会生效，不用重开对话。

### 注入行为

| 参数 | 默认 | 说明 |
|------|------|------|
| `enabled` | true | 是否启用时钟注入 |
| `intervalMinutes` | 10 | 两次注入的最小间隔（分钟） |
| `includeVitals` | true | 注入时是否附带电量 |
| `reportSlowToolSeconds` | 60 | 慢调用提示阈值，0 关闭 |
| `crashNoticeEnabled` | true | 崩溃后在下次会话提醒 agent |
| `networkWatchEnabled` | true | 监测网络状态切换 |
| `networkProbeIntervalSeconds` | 25 | 探测间隔，10 到 300 秒 |
| `networkOutageThresholdMinutes` | 5 | 断网超过这么久算一次“被打断” |

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
| `networkDnsDown` / `networkDnsBack` | DNS 异常与恢复 |
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
| `encouragementModels` | `["deepseek"]` | auto 模式下按子串匹配模型标识 |

配置落在 `${HANA_HOME}/plugin-data/pc-status/clock.json`。

## 权限

`trust: full-access`，因为时钟注入依赖 Pi SDK 的 `extensions/` 拦截能力。
需要在 设置 → 插件 里打开「允许全权插件」开关，否则插件不会加载。

`extensions/` 在会话创建时绑定。装完或升级后，正在进行的对话不会立刻带上新钩子，
新开一个对话或重启 Hana 即可。

## 升级时的一个坑

Hana 加载插件工具时只对入口文件（`tools/*.js`、`extensions/*.js`）做缓存刷新，
它们 `import` 的 `lib/*.js` 不会重新载入。所以插件升级后如果改了 lib 里的模块，
server 进程里跑的还是旧版，会报 `does not provide an export named ...`。

两种解法：重启一次 Hana；或者给改过的 lib 文件改名（本插件就把 `clock-config.js`
换成了 `settings.js`，让新入口点到新的模块 URL）。

## 平台

仅 Windows。状态采集走 PowerShell 5.1（`GetSystemPowerStatus` P/Invoke + 少量 CIM 查询），
不依赖第三方模块，也不需要管理员权限。电池健康查询在部分机型上会返回空，属正常。

## 自测

```bash
node test/clock-inject.test.mjs   # 注入、节流、模板、鼓励语
node test/crash-watch.test.mjs    # 崩溃判定与提醒（不需要真的把 server 弄崩）
node test/network-watch.test.mjs  # 网络状态机与变动提示
node test/lifecycle.test.mjs      # 心跳写入与干净退出标记
```

用假的 pi 实例驱动 extension，不启动 Hana 也能验证注入、节流、慢调用提示、
自定义模板、鼓励语命中与异常降级。

## 实现说明

- 脚本以 `-EncodedCommand`（UTF-16LE base64）送入，避免 Windows PowerShell 5.1
  按 ANSI 读 UTF-8 脚本导致中文乱码
- 注入失败一律静默降级，绝不污染工具返回
- 采集分两档：完整状态约 2 到 3 秒，轻量电量约 0.5 秒（仅注入时使用）
- 崩溃监测只能看到“最后活着的时间”，捕捉不到崩溃瞬间；强杀、断电也会被判为非正常终止，
  区别只是断点长短，而超过 2 小时的断点会被当成关机忽略

## 许可

Apache License 2.0，见 [LICENSE](LICENSE)。
