import assert from 'node:assert/strict';
import test from 'node:test';
import { loadBotConfigs } from '../src/core/bot-config.js';

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('未配置独立审计/终审 Bot 时不加载这些角色', () => {
  withEnv({
    BOT_QA_APP_ID: 'cli_qa',
    BOT_QA_APP_SECRET: 'secret-qa',
    BOT_REVIEWER_APP_ID: 'cli_reviewer',
    BOT_REVIEWER_APP_SECRET: 'secret-reviewer',
    BOT_RUNTIME_AUDITOR_APP_ID: undefined,
    BOT_RUNTIME_AUDITOR_APP_SECRET: undefined,
    BOT_FINAL_REVIEWER_APP_ID: undefined,
    BOT_FINAL_REVIEWER_APP_SECRET: undefined,
  }, () => {
    const ids = loadBotConfigs().map((bot) => bot.id);
    assert.ok(ids.includes('qa'));
    assert.ok(ids.includes('reviewer'));
    assert.ok(!ids.includes('runtime_auditor'));
    assert.ok(!ids.includes('final_reviewer'));
  });
});

test('配置独立审计/终审凭证后加载对应 Bot', () => {
  withEnv({
    BOT_RUNTIME_AUDITOR_APP_ID: 'cli_audit',
    BOT_RUNTIME_AUDITOR_APP_SECRET: 'secret-audit',
    BOT_RUNTIME_AUDITOR_NAME: '运行时审计',
    BOT_FINAL_REVIEWER_APP_ID: 'cli_final',
    BOT_FINAL_REVIEWER_APP_SECRET: 'secret-final',
  }, () => {
    const bots = loadBotConfigs();
    const auditor = bots.find((bot) => bot.id === 'runtime_auditor');
    const finalReviewer = bots.find((bot) => bot.id === 'final_reviewer');
    assert.equal(auditor?.role, 'runtime_auditor');
    assert.equal(auditor?.name, '运行时审计');
    assert.equal(finalReviewer?.role, 'final_reviewer');
  });
});
