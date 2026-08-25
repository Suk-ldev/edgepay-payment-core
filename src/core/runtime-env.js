/**
 * 运行时在 env 上的挂载点。
 *
 * 单独成文件是为了让路由、订单操作、通道解析都能拿到运行时，
 * 又不互相 import 造成环。运行时由 createPaymentWorker 在每次请求前挂上去。
 */

export const RUNTIME_KEY = '__edgepayRuntime';

export function runtimeOf(env) {
  const runtime = env?.[RUNTIME_KEY];
  if (!runtime) throw new Error('Payment 运行时未初始化，必须经由 createPaymentWorker 启动');
  return runtime;
}

export function registryOf(env) {
  return runtimeOf(env).registry;
}

/** 拿不到运行时就返回 null。给那些在纯单测里会收到空 env 的纯函数用。 */
export function tryRuntimeOf(env) {
  return env?.[RUNTIME_KEY] ?? null;
}

/** 把运行时挂到 env 上，交给下游处理器。 */
export function withRuntime(env, runtime) {
  return { ...env, [RUNTIME_KEY]: runtime };
}
