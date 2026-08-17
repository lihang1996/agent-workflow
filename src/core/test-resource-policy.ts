/** 破坏性测试资源的统一、显式操作员授权；不得由 Agent 临时发明其它变量名替代。 */
export const TEST_RESOURCE_SENTINEL_ENV = 'AGENT_OS_TEST_RESOURCE_SENTINEL';

/** 注入到 CLI 子进程，Skill 脚本只信这个名字，不硬编码产品哨兵。 */
export const EXPECTED_SENTINEL_ENV_NAME = 'AGENT_OS_EXPECTED_SENTINEL_ENV';

export function isTestResourceSentinelAuthorized(): boolean {
  return process.env[TEST_RESOURCE_SENTINEL_ENV]?.trim().toLowerCase() === 'true';
}
