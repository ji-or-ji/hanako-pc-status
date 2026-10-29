/**
 * index.js — PC Status v2 入口。
 *
 * 一个进程、一个 ctx：配置、网络监测、钩子、工具都在这里接上，
 * 卸载时由宿主回收，不需要自己写 unload。
 */
import { defineApp } from "./sdk/app-contract/server-client.js";
import { createRuntime } from "./lib/runtime.js";
import { registerHooks } from "./lib/hooks.js";
import { register as registerMachineState } from "./tools/machine-state.js";
import { register as registerClockControl } from "./tools/clock-control.js";

export default defineApp(async (sdk) => {
  const runtime = createRuntime(sdk);

  await registerMachineState(sdk, runtime);
  await registerClockControl(sdk, runtime);
  registerHooks(sdk, runtime);

  // 设置贡献要等 apply 落定才登记，稍微等一下再按真配置起网络监测。
  // 定时器本身是固定节拍轮询，配置改了不用重启它。
  const kickoff = setTimeout(() => runtime.startNetworkWatch(), 3000);
  kickoff.unref?.();

  await sdk.logger.info("PC Status 已加载");
});
