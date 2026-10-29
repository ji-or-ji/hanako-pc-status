/**
 * machine_state：读取本机当前状态。
 *
 * 覆盖电源（交流/电池、百分比、剩余时间、电池健康）、电源计划、系统负载
 * （CPU / 内存 / 磁盘）、以及 hana-server 等进程是否存活。
 */
import { collectMachineState, formatMachineStateText } from "../lib/system-state.js";
import { readNetworkState } from "../lib/network-watch.js";

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

export async function register(sdk, runtime) {
  await sdk.tools.register({
    name: "machine_state",
    description:
      "读取这台电脑的实时状态：供电与电池（是否插电、电量百分比、剩余可用时间、电池健康）、"
      + "当前电源计划、系统运行时长、CPU 与内存负载、各磁盘剩余空间，以及 hana-server / HanaAgent 进程是否存活。"
      + "在开始耗时较长或可能耗电的任务前、怀疑机器资源不足、任务莫名其妙中断后，先调用它确认环境。"
      + "告警阈值与文案由 PC Status 的设置页控制，这里只负责采集。",
    parameters: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "text 返回人类可读摘要（默认），json 返回原始结构",
        },
        includeBatteryHealth: {
          type: "boolean",
          description: "是否额外查询电池设计容量与满充容量（多花约 1 秒，台式机可忽略）",
        },
        allPowerSchemes: {
          type: "boolean",
          description: "是否列出系统里所有电源计划而不只是当前生效的那个",
        },
      },
    },
    // 纯读取，不需要用户审批
    sessionPermission: { readOnly: true },
    execute: async (args = {}) => {
      const result = await collectMachineState({
        includeBatteryHealth: args?.includeBatteryHealth === true,
        allPowerSchemes: args?.allPowerSchemes === true,
      });

      if (!result.ok) {
        return text(
          `读取本机状态失败：${result.error}\n`
          + "（只支持 Windows；若在别的系统上运行，请直接说一声，这个 App 需要补平台实现）",
        );
      }

      const config = await runtime.config();
      const network = readNetworkState(sdk.dataDir);

      if (args?.format === "json") {
        return text(JSON.stringify({ ...result.data, network }, null, 2));
      }
      return text(formatMachineStateText(result.data, config, null, network));
    },
  });
}
