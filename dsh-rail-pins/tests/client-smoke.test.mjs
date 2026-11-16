import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLIENT_FILE = join(PACKAGE_ROOT, 'client.js');
const MANIFEST_FILE = join(PACKAGE_ROOT, 'package.json');

/** 最小 React 替身：工厂执行期只用到 memo/createElement；函数组件调用时直接执行。 */
const FAKE_REACT = {
  createElement: (type, props, ...children) => (
    typeof type === 'function' ? type(props ?? {}) : { type, props, children }
  ),
  memo: (component) => component,
  useState: () => [null, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
};

function loadDefinition() {
  let definition;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value;
        },
      },
    },
  };
  vm.runInNewContext(readFileSync(CLIENT_FILE, 'utf8'), sandbox, { filename: CLIENT_FILE });
  assert.ok(definition, 'client.js 没有调用 window.__ModuleLoader__.load');
  return definition;
}

function applyWithMocks(options = {}) {
  const definition = loadDefinition();
  const module = definition.factory(() => FAKE_REACT);
  const calls = { locales: [], slot: null, effects: 0 };
  const ctx = {
    effect(callback) {
      calls.effects += 1;
      return callback();
    },
    locale: {
      register(namespace, id, dict) {
        if (options.failLocale === true) throw new Error('locale boom');
        calls.locales.push({ namespace, id, dict });
        return () => {};
      },
    },
    uiWorkspace: { openSession() {} },
    slots: {
      inject(name, callback) {
        assert.equal(name, 'shell.overlay');
        return callback();
      },
      register(entryOptions, component) {
        calls.slot = { options: entryOptions, component };
        return () => {};
      },
    },
  };
  module.apply(ctx);
  return { module, calls };
}

test('工厂 id 与 package.json 的包名一致，并导出 inject/apply', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const definition = loadDefinition();
  assert.equal(definition.id, manifest.name);
  assert.equal(definition.id, 'dsh-rail-pins');
  assert.equal(typeof definition.factory, 'function');
  const module = definition.factory(() => FAKE_REACT);
  assert.deepEqual(Array.from(module.inject), ['slots', 'uiWorkspace', 'locale', 'layout']);
  assert.equal(typeof module.apply, 'function');
});

test('apply 逐语言注册 locale，并注册 shell.overlay 条目（不带 locale 选项）', () => {
  const { calls } = applyWithMocks();
  assert.equal(calls.effects, 1);
  assert.equal(calls.locales.length, 2);
  const byId = new Map(calls.locales.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('en').namespace, 'dsh-rail-pins');
  assert.equal(byId.get('zh').namespace, 'dsh-rail-pins');
  assert.equal(typeof byId.get('en').dict['item.open'], 'string');
  assert.equal(typeof byId.get('zh').dict['item.open'], 'string');
  assert.equal(calls.slot.options.name, 'shell.overlay');
  assert.equal(calls.slot.options.id, 'rail-pins');
  assert.equal(calls.slot.options.order, 50);
  assert.equal('locale' in calls.slot.options, false);
  assert.equal(typeof calls.slot.component, 'function');
});

test('locale 注册抛错不拖垮 apply：slot 仍然注册', () => {
  const { calls } = applyWithMocks({ failLocale: true });
  assert.equal(calls.locales.length, 0);
  assert.equal(calls.slot.options.name, 'shell.overlay');
  assert.equal(typeof calls.slot.component, 'function');
});

test('四个标准 props 任一缺失时返回 null，且不先调用 hooks', () => {
  const { calls } = applyWithMocks();
  let callsOfUseWorkspaces = 0;
  const props = {
    useSessions: () => undefined,
    useSessionStatus: () => undefined,
    useWorkspaces: () => {
      callsOfUseWorkspaces += 1;
      return [];
    },
    // usePanelInfo 缺失
  };
  assert.equal(calls.slot.component(props), null);
  assert.equal(callsOfUseWorkspaces, 0);
});

test('中英词典键集合一致，且覆盖四态与相对时间文案', () => {
  const { calls } = applyWithMocks();
  const en = calls.locales.find((entry) => entry.id === 'en').dict;
  const zh = calls.locales.find((entry) => entry.id === 'zh').dict;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of [
    'status.waitingApproval',
    'status.planReview',
    'status.waitingAnswer',
    'status.running',
    'status.subagentsRunning.one',
    'status.subagentsRunning.other',
    'status.completed',
    'status.idle',
    'time.now',
    'time.minute',
    'time.hour',
    'time.yesterday',
    'time.day',
  ]) {
    assert.equal(typeof en[key], 'string', `en 缺少 ${key}`);
    assert.equal(typeof zh[key], 'string', `zh 缺少 ${key}`);
  }
  assert.match(zh['time.minute'], /\{n\}/);
  assert.match(zh['status.subagentsRunning.other'], /\{n\}/);
  assert.match(en['status.subagentsRunning.other'], /\{n\}/);
  assert.match(en['item.open'], /\{title\}/);
  assert.match(en['item.open'], /\{status\}/);
});

test('primitives 模块拿不到时工厂仍能加载（角标降级，不拖垮插件）', () => {
  const definition = loadDefinition();
  const module = definition.factory((id) => {
    if (id === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('missing primitives');
    return FAKE_REACT;
  });
  assert.equal(typeof module.apply, 'function');
  assert.deepEqual(Array.from(module.inject), ['slots', 'uiWorkspace', 'locale', 'layout']);
});
