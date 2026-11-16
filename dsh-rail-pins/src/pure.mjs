// ==== pure（与 src/pure.mjs 逐字一致，见 DECISIONS.md）====
// 纯函数：首字、路径缩写、相对时间、状态映射、轨道渲染判定、工作区归属。
// 这份代码在 client.js 内有一份逐字副本（Module Loader 只能 require baseline 模块，
// client.js 不能 import 本地 ESM）；两边必须同步，tests/pure-sync.test.mjs 逐字比对。
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** rail 下 listArea 约 36px；展开态几百 px，超过这个宽度就不接管。 */
const RAIL_MAX_WIDTH = 80;

function finiteRect(rect) {
  if (rect === null || typeof rect !== 'object') return null;
  const { left, top, width, height } = rect;
  if (!Number.isFinite(left) || !Number.isFinite(top)
    || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { left, top, width, height };
}

/**
 * 按 `{name}` 占位替换；缺变量时保留原样（不抛），非字符串模板退空串。
 * 只做 `{n}` / `{title}` / `{status}` 这类单层占位，不认表达式。
 */
export function interpolate(template, vars) {
  if (typeof template !== 'string') return '';
  if (vars === null || typeof vars !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
}

function baseNameOf(path) {
  if (typeof path !== 'string' || path === '') return '';
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function firstGlyph(title, fallbackDirPath) {
  const stripped = typeof title === 'string' ? title.replace(/^[\s#>\-*`]+/, '') : '';
  const words = stripped.split(/\s+/).filter((word) => word !== '');
  const word = words[0];
  if (typeof word === 'string' && word !== '') {
    const chars = Array.from(word);
    // 第一个词以拉丁字母开头：取前三个字符，大小写照原文；否则只取第一个码点。
    if (/^[A-Za-z]$/.test(chars[0])) return chars.slice(0, 3).join('');
    return chars[0];
  }
  const baseChars = Array.from(baseNameOf(fallbackDirPath));
  if (baseChars.length > 0) {
    const upper = baseChars[0].toUpperCase();
    return Array.from(upper)[0] || '·';
  }
  return '·';
}

export function glyphStyle(text) {
  const length = Array.from(typeof text === 'string' ? text : '').length;
  if (length >= 3) return { fontSize: '12px', letterSpacing: '-0.3px' };
  if (length === 2) return { fontSize: '14px', letterSpacing: '-0.2px' };
  return { fontSize: '16px' };
}

export function abbreviateHomePath(path) {
  if (typeof path !== 'string' || path === '') return '';
  const match = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/.exec(path);
  if (match === null) return path;
  return `~${path.slice(match[1].length)}`;
}

export function relativeTime(updatedAt, now) {
  const elapsed = Math.max(0, (typeof now === 'number' ? now : Date.now()) - (typeof updatedAt === 'number' ? updatedAt : 0));
  if (elapsed < MINUTE_MS) return { unit: 'now', n: 0 };
  if (elapsed < HOUR_MS) return { unit: 'minute', n: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { unit: 'hour', n: Math.floor(elapsed / HOUR_MS) };
  if (elapsed < 2 * DAY_MS) return { unit: 'yesterday', n: 1 };
  return { unit: 'day', n: Math.floor(elapsed / DAY_MS) };
}

export function statusPresentation(pendingKind, running, completionUnread, runningSubagents) {
  if (typeof pendingKind === 'string' && pendingKind !== '') {
    if (pendingKind === 'approval') return { tone: 'warning', labelKey: 'status.waitingApproval' };
    if (pendingKind === 'plan-review') return { tone: 'warning', labelKey: 'status.planReview' };
    if (pendingKind === 'question') return { tone: 'warning', labelKey: 'status.waitingAnswer' };
    return { tone: 'warning', labelKey: 'status.waiting' };
  }
  if (running === true) return { tone: 'ongoing', labelKey: 'status.running' };
  if (typeof runningSubagents === 'number' && runningSubagents > 0) {
    return {
      tone: 'ongoing',
      labelKey: runningSubagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other',
      labelVars: { n: runningSubagents },
    };
  }
  if (completionUnread === true) return { tone: 'done', labelKey: 'status.completed' };
  return { tone: null, labelKey: 'status.idle' };
}

// 状态表的 running 在基线到达前是 undefined；官方用 ?? 回落到 SessionSummary.running。
// 状态表一旦给出布尔值就是更权威的实时值，摘要只在它缺省时兜底。
export function resolveRunning(statusRunning, summaryRunning) {
  if (statusRunning === true || statusRunning === false) return statusRunning;
  return summaryRunning === true;
}

// 子代理目录的位串：'1' 运行、'0' 不运行、'-' 状态表还没有这一项。
export function parseRunBits(bits) {
  if (typeof bits !== 'string' || bits === '') return [];
  return Array.from(bits, (bit) => (bit === '1' ? true : bit === '0' ? false : undefined));
}

// 官方 runningChildCount 同款：逐个订阅项都走 resolveRunning，再数仍在跑的。
export function countRunningChildren(childIds, statusRuns, summaryRuns) {
  if (!Array.isArray(childIds)) return 0;
  let count = 0;
  for (let i = 0; i < childIds.length; i += 1) {
    const id = childIds[i];
    if (typeof id !== 'string' || id === '') continue;
    const statusRun = Array.isArray(statusRuns) ? statusRuns[i] : undefined;
    const summaryRun = Array.isArray(summaryRuns) ? summaryRuns[i] : undefined;
    if (resolveRunning(statusRun, summaryRun) === true) count += 1;
  }
  return count;
}

export function orderPinnedByWorkspace(pinnedIds, workspaces) {
  const pinned = new Set();
  if (Array.isArray(pinnedIds)) {
    for (const id of pinnedIds) {
      if (typeof id === 'string' && id !== '') pinned.add(id);
    }
  }
  const ordered = [];
  const seen = new Set();
  if (Array.isArray(workspaces)) {
    for (const workspace of workspaces) {
      if (workspace === null || typeof workspace !== 'object') continue;
      const sessionIds = workspace.sessionIds;
      if (!Array.isArray(sessionIds)) continue;
      for (const id of sessionIds) {
        if (!pinned.has(id) || seen.has(id)) continue;
        seen.add(id);
        ordered.push(id);
      }
    }
  }
  // 不属于任何工作区的 pin 垫后，保持 pinnedSessionIds 原有顺序。
  if (Array.isArray(pinnedIds)) {
    for (const id of pinnedIds) {
      if (typeof id !== 'string' || id === '' || !pinned.has(id) || seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

export function shouldRenderRailPins(pinnedIds, rect) {
  if (!Array.isArray(pinnedIds) || pinnedIds.length === 0) return false;
  if (rect === null || typeof rect !== 'object') return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  return rect.width <= RAIL_MAX_WIDTH;
}

/**
 * 把目标矩形的视口坐标换算成「相对层原点」的坐标。
 * 锚点 rect 的 origin 就是层原点；它是纯函数，同一对输入永远同一结果，
 * 不依赖上一次输出，避免「自己量自己」的漂移。
 * 锚点缺失/全 0（通常是没挂载，getBoundingClientRect 返回全 0）或目标尺寸为 0 → null。
 */
export function layerOffset(targetRect, anchorRect) {
  const target = finiteRect(targetRect);
  const anchor = finiteRect(anchorRect);
  if (target === null || anchor === null) return null;
  if (target.width <= 0 || target.height <= 0) return null;
  if (anchor.left === 0 && anchor.top === 0 && anchor.width === 0 && anchor.height === 0) return null;
  return {
    left: target.left - anchor.left,
    top: target.top - anchor.top,
    width: target.width,
    height: target.height,
  };
}

export function buildWorkspacePathMap(workspaces) {
  const map = new Map();
  if (!Array.isArray(workspaces)) return map;
  for (const workspace of workspaces) {
    if (workspace === null || typeof workspace !== 'object') continue;
    if (typeof workspace.path !== 'string' || workspace.path === '') continue;
    for (const sessionId of workspace.sessionIds ?? []) {
      if (typeof sessionId === 'string' && !map.has(sessionId)) map.set(sessionId, workspace.path);
    }
  }
  return map;
}
// ==== /pure ====
