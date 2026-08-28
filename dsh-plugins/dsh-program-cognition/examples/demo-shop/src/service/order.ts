/**
 * 示例商城（demo-shop）—— dsh-program-cognition 端到端演示项目。
 * 业务链路：main → 下单（服务编排）→ 扣减库存（砖块）→ readStock（数据读取）。
 * 分层意图：domain 放业务砖块，service 放编排，util 放通用工具。
 */

/** 库存服务（数据层，副作用点）。 */
function readStock(skuId: string): number {
  console.log('读取库存', skuId)
  return 100
}

/** 业务砖块：扣减库存（纯计算）。 */
export function 扣减库存(skuId: string, qty: number): number {
  const stock = readStock(skuId)
  if (stock < qty) return -1
  return stock - qty
}

/** 业务砖块：校验用户（纯计算）。 */
export function 校验用户(userId: string): boolean {
  return userId.length >= 2
}

/** 服务编排：下单（调用砖块）。 */
export function 下单(userId: string, skuId: string): string {
  if (!校验用户(userId)) return '用户非法'
  const rest = 扣减库存(skuId, 1)
  if (rest < 0) return '库存不足'
  return `订单已创建，剩余库存 ${rest}`
}

/** 通用工具：金额格式化。 */
export function formatMoney(amount: number): string {
  return `¥${amount.toFixed(2)}`
}
