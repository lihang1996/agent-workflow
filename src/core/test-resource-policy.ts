/** 破坏性测试资源的统一、显式操作员授权；不得由 Agent 临时发明其它变量名替代。 */
export const TEST_RESOURCE_SENTINEL_ENV = 'AGENT_OS_TEST_RESOURCE_SENTINEL';

export function isTestResourceSentinelAuthorized(): boolean {
  return process.env[TEST_RESOURCE_SENTINEL_ENV]?.trim().toLowerCase() === 'true';
}
