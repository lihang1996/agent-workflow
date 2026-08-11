const MUTATION_TERMS = /(?:实现|修复|修补|新增|添加|补充|创建|生成|开发|改造|优化|完善|调整|修改|更改|更新|编辑|替换|重构|删除|移除|升级|迁移|接入|集成|部署|落地|写入|implement|fix|patch|add|create|build|optimi[sz]e|improve|adjust|change|modify|update|edit|replace|refactor|remove|delete|upgrade|migrate|integrate|deploy|generate|write)/i;
const DELIVERY_TARGETS = /(?:代码|项目|仓库|功能|接口|页面|组件|服务|系统|应用|工作流|流程|前端|后端|样式|提示词|数据库|配置|依赖|测试|脚本|文档|code|project|repo|feature|api|page|component|service|system|app|workflow|frontend|backend|style|prompt|database|config|dependency|test|script|documentation|readme|file)/i;

/** 保守识别会产生项目交付物的自然语言任务；只读问答和单纯审查不进入门禁流水线。 */
export function isDeliveryMutationTask(input: string): boolean {
  const normalized = input.trim();
  if (!normalized) return false;
  return MUTATION_TERMS.test(normalized) && DELIVERY_TARGETS.test(normalized);
}
