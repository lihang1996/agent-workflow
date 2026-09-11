import { findProductSpecRequest, type ProductSpecRequest } from '../core/product-spec.js';
import type { CliRunResult } from '../cli/types.js';

export interface ProductSpecSubmission { result: CliRunResult; request?: ProductSpecRequest }

export async function ensureProductSpecSubmission(options: {
  result: CliRunResult;
}): Promise<ProductSpecSubmission> {
  // Only a real, validated tool call submits an artifact. Ordinary conversation
  // must never manufacture approvals or expire an existing proposal.
  return { result: options.result, request: findProductSpecRequest(options.result.toolCalls) };
}
