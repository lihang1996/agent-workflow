import { z } from 'zod';
import type { Bot } from '../im/lark.js';
import {
  ArchitectureRequestSchema,
  ProductSpecRequestSchema,
  type ArchitectureRequest,
  type ProductSpecRequest,
} from '../core/product-spec.js';

const AnySpecRequestSchema = z.union([ProductSpecRequestSchema, ArchitectureRequestSchema]);

/** Wiki 链接统一归一化为 Docx 链接（产品方案与架构设计共用同一规则）。 */
export async function normalizeProductDocument<T extends ProductSpecRequest | ArchitectureRequest>(
  bot: Bot,
  input: T,
): Promise<T> {
  const request = AnySpecRequestSchema.parse(input) as T;
  if (request.deliveryMode !== 'lark-doc') return request;
  const url = new URL(request.documentUrl);
  if (!url.pathname.startsWith('/wiki/')) return request;
  const response = await bot.client.wiki.v2.space.getNode({ params: { token: url.pathname.split('/')[2] } });
  const node = response.data?.node;
  if (response.code || node?.obj_type !== 'docx' || !node.obj_token) {
    throw new Error(response.msg || '无法读取 Wiki 对应的 Docx，请授予当前 Bot 节点阅读权限，或提交原始 Docx 链接');
  }
  return AnySpecRequestSchema.parse({ ...request, documentUrl: `${url.origin}/docx/${node.obj_token}` }) as T;
}
