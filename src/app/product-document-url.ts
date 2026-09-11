import type { Bot } from '../im/lark.js';
import { ProductSpecRequestSchema, type ProductSpecRequest } from '../core/product-spec.js';

export async function normalizeProductDocument(bot: Bot, input: ProductSpecRequest): Promise<ProductSpecRequest> {
  const request = ProductSpecRequestSchema.parse(input);
  if (request.deliveryMode !== 'lark-doc') return request;
  const url = new URL(request.documentUrl);
  if (!url.pathname.startsWith('/wiki/')) return request;
  const response = await bot.client.wiki.v2.space.getNode({ params: { token: url.pathname.split('/')[2] } });
  const node = response.data?.node;
  if (response.code || node?.obj_type !== 'docx' || !node.obj_token) {
    throw new Error(response.msg || '无法读取 Wiki 对应的 Docx，请授予当前 Bot 节点阅读权限，或提交原始 Docx 链接');
  }
  return ProductSpecRequestSchema.parse({ ...request, documentUrl: `${url.origin}/docx/${node.obj_token}` });
}
