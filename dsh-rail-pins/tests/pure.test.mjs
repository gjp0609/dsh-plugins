import test from 'node:test';
import assert from 'node:assert/strict';

import {
  abbreviateHomePath,
  buildWorkspacePathMap,
  countRunningChildren,
  firstGlyph,
  glyphStyle,
  interpolate,
  layerOffset,
  orderPinnedByWorkspace,
  parseRunBits,
  relativeTime,
  resolveRunning,
  shouldRenderRailPins,
  statusPresentation,
} from '../src/pure.mjs';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('层偏移：正常换算成相对层原点的 left/top', () => {
  assert.deepEqual(
    layerOffset(
      { left: 100, top: 50, width: 36, height: 400 },
      { left: 8, top: 37, width: 0, height: 0 },
    ),
    { left: 92, top: 13, width: 36, height: 400 },
  );
});

test('层偏移：层原点在目标右/下方时得到负偏移', () => {
  assert.deepEqual(
    layerOffset(
      { left: 100, top: 50, width: 36, height: 400 },
      { left: 200, top: 300, width: 0, height: 0 },
    ),
    { left: -100, top: -250, width: 36, height: 400 },
  );
});

test('层偏移：锚点缺失或全 0 返回 null', () => {
  const target = { left: 100, top: 50, width: 36, height: 400 };
  assert.equal(layerOffset(target, null), null);
  assert.equal(layerOffset(target, undefined), null);
  assert.equal(layerOffset(target, { left: 0, top: 0, width: 0, height: 0 }), null);
});

test('层偏移：目标尺寸为 0 返回 null', () => {
  const anchor = { left: 10, top: 20, width: 0, height: 0 };
  assert.equal(layerOffset({ left: 100, top: 50, width: 0, height: 400 }, anchor), null);
  assert.equal(layerOffset({ left: 100, top: 50, width: 36, height: 0 }, anchor), null);
});

test('层偏移：连续调用两次结果一致（纯函数，不依赖上一次输出）', () => {
  const target = { left: 100, top: 50, width: 36, height: 400 };
  const anchor = { left: 0, top: 37, width: 0, height: 0 };
  const first = layerOffset(target, anchor);
  const second = layerOffset(target, anchor);
  assert.deepEqual(second, first);
  assert.deepEqual(first, { left: 100, top: 13, width: 36, height: 400 });
});

test('插值：正常替换 {n} 与多占位', () => {
  assert.equal(interpolate('{n} 分钟前', { n: 3 }), '3 分钟前');
  assert.equal(interpolate('打开 {title}（{status}）', { title: '会话', status: '空闲' }), '打开 会话（空闲）');
});

test('插值：缺变量时原样保留 {x}，不抛', () => {
  assert.equal(interpolate('{n} 分钟前', { m: 3 }), '{n} 分钟前');
  assert.equal(interpolate('{a} / {b}', { a: 1 }), '1 / {b}');
  assert.equal(interpolate('{n}', undefined), '{n}');
  assert.equal(interpolate(undefined, { n: 1 }), '');
});

test('插值：变量值是数字也转成字符串', () => {
  assert.equal(interpolate('{n} 小时前', { n: 0 }), '0 小时前');
  assert.equal(interpolate('{n} 天前', { n: 12 }), '12 天前');
});

test('首字：中文标题取第一个字符', () => {
  assert.equal(firstGlyph('会话标题'), '会');
  assert.equal(firstGlyph('修复：侧栏折叠后的空白'), '修');
});

test('首字：去掉 markdown 井号标题前缀', () => {
  assert.equal(firstGlyph('# 标题'), '标');
  assert.equal(firstGlyph('### 标题'), '标');
});

test('首字：去掉列表/引用/强调/代码前缀', () => {
  assert.equal(firstGlyph('- 标题'), '标');
  assert.equal(firstGlyph('>   标题'), '标');
  assert.equal(firstGlyph('* 标题'), '标');
  assert.equal(firstGlyph('` 标题'), '标');
  assert.equal(firstGlyph('  -  # 标题'), '标');
});

test('首字：第一个词前三个字符，大小写不动', () => {
  assert.equal(firstGlyph('API design'), 'API');
});

test('首字：多词只取第一个词的前三个字符', () => {
  assert.equal(firstGlyph('Design Flow Chart Extra'), 'Des');
});

test('首字：单词取前三个字符', () => {
  assert.equal(firstGlyph('Design'), 'Des');
});

test('首字：不足三个字符就取实际长度', () => {
  assert.equal(firstGlyph('De'), 'De');
});

test('首字：小写原样保留', () => {
  assert.equal(firstGlyph('debug the parser'), 'deb');
});

test('首字：大写也原样保留', () => {
  assert.equal(firstGlyph('Debug the parser'), 'Deb');
});

test('首字：单个小写字母不转大写', () => {
  assert.equal(firstGlyph('d'), 'd');
});

test('首字：剥 markdown 前缀后仍取第一个词，大小写不动', () => {
  assert.equal(firstGlyph('  `dsh-rail-pins`'), 'dsh');
});

test('首字：中文仍取一个码点', () => {
  assert.equal(firstGlyph('设计一个东西'), '设');
});

test('首字：数字开头只取第一个码点', () => {
  assert.equal(firstGlyph('## 123 456'), '1');
});

test('字号阶梯：单字符 16px（中文也是）', () => {
  assert.deepEqual(glyphStyle('设'), { fontSize: '16px' });
  assert.deepEqual(glyphStyle('D'), { fontSize: '16px' });
});

test('字号阶梯：两字符 14px 并收紧字距', () => {
  assert.deepEqual(glyphStyle('De'), { fontSize: '14px', letterSpacing: '-0.2px' });
});

test('字号阶梯：三字符 12px 并再收紧字距', () => {
  assert.deepEqual(glyphStyle('Des'), { fontSize: '12px', letterSpacing: '-0.3px' });
});

test('首字：只有一个 emoji 时保留完整 code point', () => {
  assert.equal(firstGlyph('🙂'), '🙂');
  assert.equal(firstGlyph('🚀 上线'), '🚀');
});

test('首字：空串回退到工作区目录名（并转大写）', () => {
  assert.equal(firstGlyph('', 'C:\\work\\my-project'), 'M');
  assert.equal(firstGlyph('   ', 'C:\\work\\my-project'), 'M');
  assert.equal(firstGlyph('### ', '/home/me/zed'), 'Z');
});

test('首字：目录名也取不到时退回中点', () => {
  assert.equal(firstGlyph(''), '·');
  assert.equal(firstGlyph('', ''), '·');
  assert.equal(firstGlyph(undefined, undefined), '·');
  assert.equal(firstGlyph('###', '/'), '·');
});

test('pin 顺序：工作区顺序压过 pin 时间顺序', () => {
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', sessionIds: ['s2'] },
  ];
  assert.deepEqual(orderPinnedByWorkspace(['s2', 's1'], workspaces), ['s1', 's2']);
});

test('pin 顺序：组内按 sessionIds 顺序', () => {
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['a', 'b', 'c'] }];
  assert.deepEqual(orderPinnedByWorkspace(['c', 'a'], workspaces), ['a', 'c']);
});

test('pin 顺序：未分组垫后并保持 pin 顺序', () => {
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['s1'] }];
  assert.deepEqual(orderPinnedByWorkspace(['g2', 's1', 'g1'], workspaces), ['s1', 'g2', 'g1']);
});

test('pin 顺序：工作区里未 pin 的会话排除', () => {
  const workspaces = [{ workspaceId: 'w1', sessionIds: ['s1', 's2'] }];
  assert.deepEqual(orderPinnedByWorkspace(['s2'], workspaces), ['s2']);
});

test('pin 顺序：重复 id 只留第一次', () => {
  const workspaces = [
    { workspaceId: 'w1', sessionIds: ['a'] },
    { workspaceId: 'w2', sessionIds: ['a'] },
  ];
  assert.deepEqual(orderPinnedByWorkspace(['a'], workspaces), ['a']);
});

test('pin 顺序：没有 pin 返回空数组', () => {
  assert.deepEqual(orderPinnedByWorkspace([], [{ workspaceId: 'w1', sessionIds: ['a'] }]), []);
});

test('pin 顺序：忽略非字符串/空 id 与缺失 workspaces', () => {
  assert.deepEqual(orderPinnedByWorkspace(['', 'a', null, 'b', 3], undefined), ['a', 'b']);
});

test('状态：approval 映射到官方 warning', () => {
  const presentation = statusPresentation('approval', false, false);
  assert.equal(presentation.tone, 'warning');
  assert.equal(presentation.labelKey, 'status.waitingApproval');
});

test('状态：plan-review 映射到官方 warning', () => {
  const presentation = statusPresentation('plan-review', false, false);
  assert.equal(presentation.tone, 'warning');
  assert.equal(presentation.labelKey, 'status.planReview');
});

test('状态：question 映射到官方 warning', () => {
  const presentation = statusPresentation('question', false, false);
  assert.equal(presentation.tone, 'warning');
  assert.equal(presentation.labelKey, 'status.waitingAnswer');
});

test('状态：running 映射到官方 ongoing，且压过未读完成', () => {
  const presentation = statusPresentation(null, true, true);
  assert.equal(presentation.tone, 'ongoing');
  assert.equal(presentation.labelKey, 'status.running');
});

test('状态：completionUnread 映射到官方 done', () => {
  const presentation = statusPresentation(null, false, true);
  assert.equal(presentation.tone, 'done');
  assert.equal(presentation.labelKey, 'status.completed');
});

test('状态：都没有时 tone 为 null（不画角标）', () => {
  const presentation = statusPresentation(null, false, false);
  assert.equal(presentation.tone, null);
  assert.equal(presentation.labelKey, 'status.idle');
  assert.equal(statusPresentation(undefined, undefined, undefined).tone, null);
});

test('状态：pendingInteraction 压过 running', () => {
  assert.equal(statusPresentation('approval', true, false).tone, 'warning');
});

test('运行状态回落：状态表是布尔时以状态表为准', () => {
  assert.equal(resolveRunning(true, false), true);
  assert.equal(resolveRunning(false, true), false);
});

test('运行状态回落：状态表 undefined 时用摘要', () => {
  assert.equal(resolveRunning(undefined, true), true);
  assert.equal(resolveRunning(undefined, false), false);
});

test('运行状态回落：两级都缺省为 false', () => {
  assert.equal(resolveRunning(undefined, undefined), false);
  assert.equal(resolveRunning(null, undefined), false);
});

test('子代理计数：两个都在跑', () => {
  assert.equal(countRunningChildren(['a', 'b'], [undefined, undefined], [true, true]), 2);
});

test('子代理计数：状态表 false 压过摘要 true', () => {
  assert.equal(countRunningChildren(['a', 'b'], [false, undefined], [true, true]), 1);
});

test('子代理计数：全都不跑', () => {
  assert.equal(countRunningChildren(['a', 'b'], [false, false], [false, false]), 0);
});

test('子代理计数：空目录或空 id 返回 0', () => {
  assert.equal(countRunningChildren([], [], []), 0);
  assert.equal(countRunningChildren(['', 'a'], [true], [true]), 0);
});

test('运行位串：1/0/- 分别还原为 true/false/undefined', () => {
  assert.deepEqual(parseRunBits('10-'), [true, false, undefined]);
});

test('运行位串：空串返回空数组', () => {
  assert.deepEqual(parseRunBits(''), []);
  assert.deepEqual(parseRunBits(undefined), []);
});

test('状态：只有一个子代理在跑时出 ongoing 与单数文案', () => {
  const presentation = statusPresentation(null, false, false, 1);
  assert.equal(presentation.tone, 'ongoing');
  assert.equal(presentation.labelKey, 'status.subagentsRunning.one');
  assert.deepEqual(presentation.labelVars, { n: 1 });
});

test('状态：多个子代理在跑时压过未读完成', () => {
  const presentation = statusPresentation(null, false, true, 2);
  assert.equal(presentation.tone, 'ongoing');
  assert.equal(presentation.labelKey, 'status.subagentsRunning.other');
  assert.deepEqual(presentation.labelVars, { n: 2 });
});

test('状态：父会话自己在跑时仍用 running 文案', () => {
  const presentation = statusPresentation(null, true, false, 3);
  assert.equal(presentation.labelKey, 'status.running');
  assert.equal(presentation.labelVars, undefined);
});

test('相对时间：60 秒以内是「刚刚」', () => {
  const now = 1_000_000_000;
  assert.deepEqual(relativeTime(now - 1_000, now), { unit: 'now', n: 0 });
  assert.deepEqual(relativeTime(now - 59_999, now), { unit: 'now', n: 0 });
});

test('相对时间：分钟', () => {
  const now = 1_000_000_000;
  assert.deepEqual(relativeTime(now - 3 * MINUTE, now), { unit: 'minute', n: 3 });
  assert.deepEqual(relativeTime(now - 59 * MINUTE, now), { unit: 'minute', n: 59 });
});

test('相对时间：小时', () => {
  const now = 1_000_000_000;
  assert.deepEqual(relativeTime(now - 2 * HOUR, now), { unit: 'hour', n: 2 });
  assert.deepEqual(relativeTime(now - 23 * HOUR, now), { unit: 'hour', n: 23 });
});

test('相对时间：24 到 48 小时是「昨天」', () => {
  const now = 1_000_000_000;
  assert.deepEqual(relativeTime(now - 25 * HOUR, now), { unit: 'yesterday', n: 1 });
});

test('相对时间：按天数，并对未来时间收敛到 0', () => {
  const now = 1_000_000_000;
  assert.deepEqual(relativeTime(now - 5 * DAY, now), { unit: 'day', n: 5 });
  assert.deepEqual(relativeTime(now - 40 * DAY, now), { unit: 'day', n: 40 });
  assert.deepEqual(relativeTime(now + 10 * MINUTE, now), { unit: 'now', n: 0 });
});

test('渲染判定：没有 pin 时整块不渲染', () => {
  assert.equal(shouldRenderRailPins([], { left: 0, top: 0, width: 36, height: 600 }), false);
  assert.equal(shouldRenderRailPins(undefined, { left: 0, top: 0, width: 36, height: 600 }), false);
});

test('渲染判定：量不到矩形时不渲染（fail-closed）', () => {
  assert.equal(shouldRenderRailPins(['s1'], null), false);
  assert.equal(shouldRenderRailPins(['s1'], { left: 0, top: 0, width: 0, height: 600 }), false);
  assert.equal(shouldRenderRailPins(['s1'], { left: 0, top: 0, width: 36, height: 0 }), false);
});

test('渲染判定：展开态（宽度超过 80）不接管', () => {
  assert.equal(shouldRenderRailPins(['s1'], { left: 0, top: 0, width: 81, height: 600 }), false);
  assert.equal(shouldRenderRailPins(['s1'], { left: 0, top: 0, width: 320, height: 600 }), false);
});

test('渲染判定：rail 宽度范围内且有 pin 才渲染', () => {
  assert.equal(shouldRenderRailPins(['s1'], { left: 10, top: 96, width: 36, height: 700 }), true);
  assert.equal(shouldRenderRailPins(['s1'], { left: 10, top: 96, width: 80, height: 700 }), true);
});

test('路径缩写：C:\\Users\\<用户>\\... 缩成 ~', () => {
  assert.equal(abbreviateHomePath('C:\\Users\\me\\project\\src'), '~\\project\\src');
  assert.equal(abbreviateHomePath('C:\\Users\\me'), '~');
  assert.equal(abbreviateHomePath('D:/Users/me/work'), '~/work');
});

test('路径缩写：非用户目录原样返回', () => {
  assert.equal(abbreviateHomePath('C:\\work\\project'), 'C:\\work\\project');
  assert.equal(abbreviateHomePath('/home/me/project'), '/home/me/project');
  assert.equal(abbreviateHomePath(''), '');
});

test('工作区归属：按 sessionIds 反查，查不到算未分组', () => {
  const map = buildWorkspacePathMap([
    { workspaceId: 'w1', path: 'C:\\work\\one', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', path: 'C:\\work\\two', sessionIds: ['s3'] },
  ]);
  assert.equal(map.get('s1'), 'C:\\work\\one');
  assert.equal(map.get('s3'), 'C:\\work\\two');
  assert.equal(map.get('s-missing'), undefined);
  assert.equal(buildWorkspacePathMap(undefined).size, 0);
});
