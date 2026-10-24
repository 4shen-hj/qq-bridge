import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'qq-session-tools';
export const inject = ['tools'];

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const AUTH_FIELDS = ['key', 'token', 'groupId', 'userId'];
const PREFIX = 'mcp__snowluma__';

function bridgeAccess() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const configured = String(cfg.consoleToken ?? '').trim();
    const consoleToken = /^[A-Za-z0-9_-]{16,128}$/.test(configured)
      ? configured
      : fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(consoleToken)) throw new Error();
    const port = Number(cfg.consolePort ?? 3100);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return { consoleToken, port };
  } catch {
    throw new Error('QQ 会话认证不可用');
  }
}

export async function resolveSession(sessionId, signal) {
  try {
    if (signal?.aborted) throw new Error();
    const { consoleToken, port } = bridgeAccess();
    const deadline = AbortSignal.timeout(5000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const response = await fetch(`http://127.0.0.1:${port}/api/internal/session-tool-auth?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { 'x-console-token': consoleToken },
      signal: requestSignal
    });
    if (!response.ok) throw new Error();
    const body = await response.json();
    if (signal?.aborted) throw new Error();
    if (!body?.ok || typeof body.key !== 'string' || !/^(group|private):\d+$/.test(body.key)
      || typeof body.token !== 'string' || !body.token) throw new Error();
    return { key: body.key, token: body.token };
  } catch {
    throw new Error(signal?.aborted ? 'QQ 工具调用已取消' : 'QQ 会话认证不可用');
  }
}

function facadeSchema(definition) {
  const schema = definition?.parameters;
  const mentionsAuth = /"(?:key|token|groupId|userId)"\s*:/.test(JSON.stringify(schema ?? {}));
  if (!mentionsAuth) return null;
  if (!schema || schema.type !== 'object' || !schema.properties || typeof schema.properties !== 'object'
    || Array.isArray(schema.properties) || !Object.hasOwn(schema.properties, 'token')) return false;
  if (schema.$ref || schema.allOf || schema.anyOf || schema.oneOf || schema.patternProperties
    || schema.additionalProperties === true || !['key', 'groupId', 'userId'].some((field) => Object.hasOwn(schema.properties, field))) return false;
  const parameters = structuredClone(schema);
  for (const field of AUTH_FIELDS) delete parameters.properties[field];
  if (Array.isArray(parameters.required)) parameters.required = parameters.required.filter((field) => !AUTH_FIELDS.includes(field));
  return parameters;
}

function routedArgs(args, schema, auth) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('QQ 工具参数无效');
  if (AUTH_FIELDS.some((field) => Object.hasOwn(args, field))) throw new Error('会话目标和认证由宿主决定');
  const props = schema.properties;
  const result = { ...args, token: auth.token };
  if (Object.hasOwn(props, 'key')) result.key = auth.key;
  if (Object.hasOwn(props, 'groupId')) {
    if (!auth.key.startsWith('group:')) throw new Error('此工具只允许群会话');
    result.groupId = auth.key.slice(6);
  }
  if (Object.hasOwn(props, 'userId')) {
    if (!auth.key.startsWith('private:')) throw new Error('此工具只允许私聊会话');
    result.userId = auth.key.slice(8);
  }
  return result;
}

export function installSessionTools(ctx, resolver) {
  const facades = new Map();
  const selected = new WeakMap();
  let reconciling = false;

  function reconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      const globals = ctx.tools.schemas();
      const present = new Set();
      for (const { name: toolName } of globals) {
        if (!toolName.startsWith(PREFIX)) continue;
        const original = ctx.tools.get(toolName);
        const schema = facadeSchema(original);
        if (schema === null) continue;
        present.add(toolName);
        const prior = facades.get(toolName);
        if (prior && JSON.stringify(prior.source.parameters) === JSON.stringify(original.parameters)) continue;
        prior?.dispose();
        const safeSchema = schema || { type: 'object', properties: {} };
        const facade = {
          name: toolName,
          description: schema ? original.description : 'QQ 工具参数格式不受支持，已停用。',
          parameters: safeSchema,
          output: original.output,
          timeoutMs: original.timeoutMs,
          execute: async (args, exec) => {
            if (!exec?.agent?.session?.id || typeof exec.agent.session.id !== 'string') throw new Error('缺少可信 QQ 会话');
            const auth = await resolver(exec.agent.session.id, exec.signal);
            if (exec.signal?.aborted) throw new Error('QQ 工具调用已取消');
            const current = ctx.tools.get(toolName);
            const currentSchema = facadeSchema(current);
            if (!currentSchema || JSON.stringify(current.parameters) !== JSON.stringify(original.parameters)) {
              throw new Error('QQ 工具已重连或参数格式变化，请重试当前调用');
            }
            selected.set(exec, current);
            return current.execute(routedArgs(args, current.parameters, auth), exec);
          },
          projectContent: (exec, result) => selected.get(exec)?.projectContent?.(exec, result),
          finalizeContent: (exec, result) => selected.get(exec)?.finalizeContent?.(exec, result)
        };
        const dispose = ctx.tools.register(facade);
        facades.set(toolName, { source: original, dispose });
      }
      for (const [toolName, prior] of facades) {
        if (present.has(toolName)) continue;
        prior.dispose();
        facades.delete(toolName);
      }
    } finally {
      reconciling = false;
    }
  }

  ctx.on('tools/change', reconcile);
  reconcile();
}

export function apply(ctx) {
  installSessionTools(ctx, resolveSession);
}
