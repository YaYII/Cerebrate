/** 示例商城入口：触发下单业务链路。 */
import { 下单 } from './service/order.ts'

/** 主入口：演示参数触发一次完整下单。 */
export function main(): string {
  globalThis.__COG_LOG?.({k:'service',p:'entry',id:'src/index.ts:main'})
  return 下单('u1', 'SKU-1001')

  globalThis.__COG_LOG?.({k:'service',p:'exit',id:'src/index.ts:main'})
}
