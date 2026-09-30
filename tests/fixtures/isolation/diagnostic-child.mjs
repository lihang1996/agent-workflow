#!/usr/bin/env node
/**
 * G-W6b-FIX 诊断子进程（fixture 专用，不进 src/）。
 *
 * 模拟「模型驱动的工具调用」在隔离边界内的实际读写行为，输出可审计 JSON：
 * - self.read：读取 <protectedRoot>/kb/sentinel.txt（读隔离目标，open+read）；
 * - self.write-protected / write-scratch：两类写尝试（应拒 / 应允许）；
 * - backend：spawn node 子进程重复尝试——S2「常驻后端」surface 的 fixture
 *   等价物（验证 fork/exec 后代是否继承同一策略），记录其后代 pid；
 * - descendantSpawn：又一个普通 node 后代重复读/写尝试——**只证明普通后代
 *   继承策略，不是 agent_os MCP 注册路径的 canary**（真实 MCP surface 仍
 *   unverified/blocked，须沿 --mcp-config/-c 注册路径实测，见 119 号 P2）。
 *
 * 结果写入 argv[3] 指定的 JSON 文件（调用方放在 scratch 内），并打印到
 * stdout。判读由可信测试进程按「尝试 + 实际落盘」双证据完成。
 */
import { spawnSync } from 'node:child_process';
import { openSync, readSync, closeSync, writeFileSync } from 'node:fs';

const [, , protectedRoot, scratchDir, reportPath] = process.argv;

function readAttempt() {
  let fd;
  try {
    fd = openSync(`${protectedRoot}/kb/sentinel.txt`, 'r');
    const buffer = Buffer.alloc(256);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return { ok: true, echoed: buffer.subarray(0, bytes).includes('SENTINEL') };
  } catch (error) {
    return { ok: false, code: error.code ?? null, message: error.message };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAttempt(target) {
  try {
    writeFileSync(target, `attempt by ${process.pid}`);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code ?? null, message: error.message };
  }
}

const self = {
  pid: process.pid,
  read: readAttempt(),
  writeProtected: writeAttempt(`${protectedRoot}/attempt-self-${process.pid}.txt`),
  writeScratch: writeAttempt(`${scratchDir}/attempt-self-${process.pid}.txt`),
};

const backendScript = `
  const fs = require('node:fs');
  const out = { pid: process.pid };
  try {
    out.read = { ok: true, echoed: fs.readFileSync(process.argv[2] + '/kb/sentinel.txt').includes('SENTINEL') };
  } catch (e) { out.read = { ok: false, code: e.code ?? null, message: e.message }; }
  try {
    fs.writeFileSync(process.argv[2] + '/attempt-backend-' + process.pid + '.txt', 'x');
    out.writeProtected = { ok: true };
  } catch (e) { out.writeProtected = { ok: false, code: e.code ?? null, message: e.message }; }
  try {
    fs.writeFileSync(process.argv[3] + '/attempt-backend-' + process.pid + '.txt', 'x');
    out.writeScratch = { ok: true };
  } catch (e) { out.writeScratch = { ok: false, code: e.code ?? null, message: e.message }; }
  process.stdout.write(JSON.stringify(out));
`;
const backend = spawnSync(process.execPath, ['-e', backendScript, 'argv0', protectedRoot, scratchDir], {
  encoding: 'utf8',
});

const mcpScript = `
  const fs = require('node:fs');
  const out = { pid: process.pid };
  try {
    out.read = { ok: true, echoed: fs.readFileSync(process.argv[2] + '/kb/sentinel.txt').includes('SENTINEL') };
  } catch (e) { out.read = { ok: false, code: e.code ?? null, message: e.message }; }
  try {
    fs.writeFileSync(process.argv[3] + '/attempt-mcp-' + process.pid + '.txt', 'x');
    out.writeScratch = { ok: true };
  } catch (e) { out.writeScratch = { ok: false, code: e.code ?? null, message: e.message }; }
  process.stdout.write(JSON.stringify(out));
`;
const mcp = spawnSync(process.execPath, ['-e', mcpScript, 'argv0', protectedRoot, scratchDir], {
  encoding: 'utf8',
});

const report = {
  self,
  backend: backend.status === 0
    ? JSON.parse(backend.stdout)
    : { spawnError: backend.error?.message ?? `exit=${backend.status}` },
  descendantSpawn: mcp.status === 0
    ? JSON.parse(mcp.stdout)
    : { spawnError: mcp.error?.message ?? `exit=${mcp.status}` },
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(JSON.stringify(report));
