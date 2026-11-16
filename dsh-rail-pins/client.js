/**
 * dsh-rail-pins —— Client 半边（纯 JS，无构建）。
 *
 * 侧栏折叠成 56px rail 时，用 `shell.overlay` 覆盖 `_listArea` 那块空白，
 * 画出已 pin 会话的首字方块；视线和点击都不改 DSH 自己的结构。
 * 为什么只能走浮层：见同目录 DECISIONS.md。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rail-pins',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 官方状态圆点；拿不到就只显示首字，不画角标，绝不让整个插件挂掉。
    let StateDot = null;
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      StateDot = typeof primitives?.StateDot === 'function' ? primitives.StateDot : null;
    } catch {
      // 没有 primitives 模块时降级：不画角标。
    }

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
function interpolate(template, vars) {
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

function firstGlyph(title, fallbackDirPath) {
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

function glyphStyle(text) {
  const length = Array.from(typeof text === 'string' ? text : '').length;
  if (length >= 3) return { fontSize: '12px', letterSpacing: '-0.3px' };
  if (length === 2) return { fontSize: '14px', letterSpacing: '-0.2px' };
  return { fontSize: '16px' };
}

function abbreviateHomePath(path) {
  if (typeof path !== 'string' || path === '') return '';
  const match = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)(?=[\\/]|$)/.exec(path);
  if (match === null) return path;
  return `~${path.slice(match[1].length)}`;
}

function relativeTime(updatedAt, now) {
  const elapsed = Math.max(0, (typeof now === 'number' ? now : Date.now()) - (typeof updatedAt === 'number' ? updatedAt : 0));
  if (elapsed < MINUTE_MS) return { unit: 'now', n: 0 };
  if (elapsed < HOUR_MS) return { unit: 'minute', n: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { unit: 'hour', n: Math.floor(elapsed / HOUR_MS) };
  if (elapsed < 2 * DAY_MS) return { unit: 'yesterday', n: 1 };
  return { unit: 'day', n: Math.floor(elapsed / DAY_MS) };
}

function statusPresentation(pendingKind, running, completionUnread, runningSubagents) {
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
function resolveRunning(statusRunning, summaryRunning) {
  if (statusRunning === true || statusRunning === false) return statusRunning;
  return summaryRunning === true;
}

// 子代理目录的位串：'1' 运行、'0' 不运行、'-' 状态表还没有这一项。
function parseRunBits(bits) {
  if (typeof bits !== 'string' || bits === '') return [];
  return Array.from(bits, (bit) => (bit === '1' ? true : bit === '0' ? false : undefined));
}

// 官方 runningChildCount 同款：逐个订阅项都走 resolveRunning，再数仍在跑的。
function countRunningChildren(childIds, statusRuns, summaryRuns) {
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

function orderPinnedByWorkspace(pinnedIds, workspaces) {
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

function shouldRenderRailPins(pinnedIds, rect) {
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
function layerOffset(targetRect, anchorRect) {
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

function buildWorkspacePathMap(workspaces) {
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

    /** `_listArea` 的类名带构建哈希（如 bhn1Oq_listArea），只认后缀。 */
    const LIST_AREA_SELECTOR = '[class*="_listArea"]';
    const LOCALE_NS = 'dsh-rail-pins';
    const SIDEBAR_STORAGE_KEY = 'dsh-rail-pins.sidebar-collapsed';
    // 每次页面加载只恢复一次；observer 每个 mount 都重新挂，恢复动作只做一次。
    let sidebarRestored = false;

    const EN = {
      'item.open': 'Open {title} ({status})',
      'item.untitled': 'Untitled session',
      'hover.ungrouped': 'Ungrouped',
      'status.waitingApproval': 'Waiting for approval',
      'status.planReview': 'Plan awaiting review',
      'status.waitingAnswer': 'Waiting for an answer',
      'status.waiting': 'Waiting for you',
      'status.running': 'Running',
      'status.subagentsRunning.one': '1 subagent running',
      'status.subagentsRunning.other': '{n} subagents running',
      'status.completed': 'Completed',
      'status.idle': 'Idle',
      'time.now': 'just now',
      'time.minute': '{n} min ago',
      'time.hour': '{n} hr ago',
      'time.yesterday': 'yesterday',
      'time.day': '{n} days ago',
    };

    const ZH = {
      'item.open': '打开 {title}（{status}）',
      'item.untitled': '未命名会话',
      'hover.ungrouped': '未分组',
      'status.waitingApproval': '等待审批',
      'status.planReview': '计划待审',
      'status.waitingAnswer': '等待回答',
      'status.waiting': '等待你处理',
      'status.running': '正在运行',
      'status.subagentsRunning.one': '1 个子代理运行中',
      'status.subagentsRunning.other': '{n} 个子代理运行中',
      'status.completed': '已完成',
      'status.idle': '空闲',
      'time.now': '刚刚',
      'time.minute': '{n} 分钟前',
      'time.hour': '{n} 小时前',
      'time.yesterday': '昨天',
      'time.day': '{n} 天前',
    };

    const STYLE_TEXT = [
      '.dsh-rail-pins-tile:hover { background: var(--dsw-alias-interactive-bg-hover, #0000000f) !important; }',
      '.dsh-rail-pins-tile[aria-current="true"] { background: var(--dsw-alias-interactive-bg-hover, #0000000f) !important; font-weight: 500 !important; }',
      '.dsh-rail-pins-scroll::-webkit-scrollbar { display: none; }',
    ].join('\n');

    /** 零尺寸锚点：放在永不移动的外层 root 里，rect 的 origin 就是层原点。 */
    const ANCHOR_STYLE = {
      position: 'absolute',
      left: 0,
      top: 0,
      width: 0,
      height: 0,
      pointerEvents: 'none',
    };

    /** 官方口径：`mainView` 仍有保留的那个 Session 就是当前会话（ui-workspace 同款判断）。 */
    function findCurrentSessionId(snapshot) {
      for (const row of Object.values(snapshot.byId)) {
        if ((row.retainedBy?.mainView ?? 0) > 0) return row.id;
      }
      return undefined;
    }

    function formatRelativeTime(updatedAt, now, t) {
      const { unit, n } = relativeTime(updatedAt, now);
      if (unit === 'now') return t('time.now');
      if (unit === 'yesterday') return t('time.yesterday');
      return t(`time.${unit}`, { n });
    }

    /**
     * 量取 `_listArea` 相对本层的矩形。锚点挂在永不移动的外层 root 上，
     * 它的 rect 就是层原点；量不到（无节点 / display:none / 0×0 / 锚点未挂载）返回 null。
     *
     * 折叠/展开有约 150ms 的动画，只在 mount 量一次会停在中间值，所以每次信号
     * （resize / ResizeObserver / transitionend / 侧栏属性变化）都启动一个 500ms
     * 的 rAF 跟随窗，窗内逐帧重算，到期自动停，不常开。
     */
    function useListAreaRect(anchorRef) {
      const [rect, setRect] = React.useState(null);

      React.useEffect(() => {
        let observed = null;
        let resizeObserver = null;
        let scheduled = 0;
        let followFrame = 0;
        let followUntil = 0;
        let disposed = false;

        const apply = (next) => {
          setRect((previous) => {
            if (previous === next) return previous;
            if (previous !== null && next !== null
              && previous.left === next.left
              && previous.top === next.top
              && previous.width === next.width
              && previous.height === next.height) return previous;
            return next;
          });
        };

        const measureNow = () => {
          if (disposed) return;
          const element = document.querySelector(LIST_AREA_SELECTOR);
          const anchor = anchorRef.current;
          if (element === null || anchor === null) {
            apply(null);
            return;
          }
          const targetBox = element.getBoundingClientRect();
          const anchorBox = anchor.getBoundingClientRect();
          let next = layerOffset(targetBox, anchorBox);
          if (next === null
            && anchor.isConnected
            && anchorBox.left === 0
            && anchorBox.top === 0
            && targetBox.width > 0
            && targetBox.height > 0) {
            // 层原点正好在 (0,0) 时，0×0 锚点的 rect 与「未挂载」都是全 0；
            // 纯函数按 fail-closed 返回 null，这里靠 isConnected 把它认回来。
            next = {
              left: targetBox.left,
              top: targetBox.top,
              width: targetBox.width,
              height: targetBox.height,
            };
          }
          apply(next);
        };

        const scheduleMeasure = () => {
          if (disposed || scheduled !== 0) return;
          scheduled = window.requestAnimationFrame(() => {
            scheduled = 0;
            measureNow();
          });
        };

        const followTick = () => {
          followFrame = 0;
          measureNow();
          if (performance.now() < followUntil) {
            followFrame = window.requestAnimationFrame(followTick);
          }
        };

        const startFollow = () => {
          followUntil = performance.now() + 500;
          if (followFrame === 0) followFrame = window.requestAnimationFrame(followTick);
        };

        const onResize = () => {
          scheduleMeasure();
          startFollow();
        };
        const onTransitionEnd = () => {
          startFollow();
        };

        const trackTarget = () => {
          const element = document.querySelector(LIST_AREA_SELECTOR);
          if (element === observed) return;
          if (resizeObserver !== null) resizeObserver.disconnect();
          observed = element;
          resizeObserver = element === null ? null : new ResizeObserver(onResize);
          if (resizeObserver !== null) resizeObserver.observe(element);
        };

        trackTarget();
        measureNow();
        startFollow();
        window.addEventListener('resize', onResize);
        document.addEventListener('transitionend', onTransitionEnd, true);
        // 折叠/展开会重建节点；body 的 childList 只在跟踪节点掉线时重新挂观察者并量一次，
        // 流式输出的普通 DOM 变动不触发测量。
        const mutations = new MutationObserver(() => {
          if (observed === null || !observed.isConnected) {
            trackTarget();
            scheduleMeasure();
            startFollow();
          }
        });
        mutations.observe(document.body, { childList: true, subtree: true });
        // 只监听侧栏状态所在的根节点，不监听整个 body 的属性。
        const attributes = new MutationObserver(() => {
          scheduleMeasure();
          startFollow();
        });
        attributes.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed', 'class', 'style'],
        });

        return () => {
          disposed = true;
          if (scheduled !== 0) window.cancelAnimationFrame(scheduled);
          if (followFrame !== 0) window.cancelAnimationFrame(followFrame);
          window.removeEventListener('resize', onResize);
          document.removeEventListener('transitionend', onTransitionEnd, true);
          mutations.disconnect();
          attributes.disconnect();
          if (resizeObserver !== null) resizeObserver.disconnect();
        };
      }, [anchorRef]);

      return rect;
    }

    function readSidebarPreference() {
      try {
        const value = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
        return value === '1' || value === '0' ? value : null;
      } catch {
        // 无痕模式或禁用存储：读不到就当没存过。
        return null;
      }
    }

    function writeSidebarPreference(collapsed) {
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
      } catch {
        // 写不进去不影响渲染，下次刷新恢复不了而已。
      }
    }

    /** 折叠偏好：从锚点往上找 `_frame`，变更就存；仅页面加载后恢复一次。 */
    function useSidebarPersistence(anchorRef, layout) {
      React.useEffect(() => {
        const anchor = anchorRef.current;
        if (anchor === null) return undefined;

        let observer = null;
        let raf = 0;
        let disposed = false;

        raf = window.requestAnimationFrame(() => {
          if (disposed) return;
          let frame = anchor.parentElement;
          while (frame !== null) {
            if (typeof frame.className === 'string' && frame.className.includes('_frame')) break;
            frame = frame.parentElement;
          }
          if (frame === null) return;

          if (!sidebarRestored) {
            sidebarRestored = true;
            const stored = readSidebarPreference();
            if (stored !== null) {
              const target = stored === '1';
              const collapsed = frame.hasAttribute('data-sidebar-collapsed');
              if (target !== collapsed && typeof layout?.toggleSidebar === 'function') {
                try {
                  layout.toggleSidebar();
                } catch {
                  // 恢复失败不影响渲染。
                }
              }
            }
          }

          observer = new MutationObserver(() => {
            writeSidebarPreference(frame.hasAttribute('data-sidebar-collapsed'));
          });
          observer.observe(frame, {
            attributes: true,
            attributeFilter: ['data-sidebar-collapsed'],
          });
        });

        return () => {
          disposed = true;
          if (raf !== 0) window.cancelAnimationFrame(raf);
          if (observer !== null) observer.disconnect();
        };
      }, [anchorRef, layout]);
    }

    const RailPinTile = React.memo(function RailPinTile(props) {
      const { id, selected, fallbackDir, openSession, onHover, onLeave, t, bodyRef } = props;
      const summary = props.useSessions((snapshot) => snapshot.byId[id]);
      // 子代理目录：两个标量字符串订阅，避免整张 catalog/Map 引用变化打穿 memo。
      const childIdsKey = props.useSessions((snapshot) => {
        const catalog = snapshot.projectionsBySession?.[id]?.values.subagentCatalog;
        return catalog === undefined ? '' : catalog.map((child) => child.id).join(',');
      });
      const summaryBits = props.useSessions((snapshot) => {
        const catalog = snapshot.projectionsBySession?.[id]?.values.subagentCatalog;
        return catalog === undefined ? '' : catalog.map((child) => (snapshot.byId[child.id]?.running === true ? '1' : '0')).join('');
      });
      const statusBits = props.useSessionStatus((statuses) => {
        if (childIdsKey === '') return '';
        return childIdsKey.split(',').map((childId) => {
          const childRunning = statuses.get(childId)?.running;
          return childRunning === true ? '1' : childRunning === false ? '0' : '-';
        }).join('');
      });
      const pendingKind = props.useSessionStatus((snapshot) => {
        const status = snapshot.get(id);
        return status !== undefined && status.pendingInteraction !== undefined
          ? status.pendingInteraction.kind
          : null;
      });
      const statusRunning = props.useSessionStatus((snapshot) => snapshot.get(id)?.running);
      const running = resolveRunning(statusRunning, summary?.running);
      const completionUnread = props.useSessionStatus((snapshot) => snapshot.get(id)?.completionUnread === true);
      const childIds = childIdsKey === '' ? [] : childIdsKey.split(',');
      const runningSubagents = countRunningChildren(childIds, parseRunBits(statusBits), parseRunBits(summaryBits));
      const presentation = statusPresentation(pendingKind, running, completionUnread, runningSubagents);
      const title = summary !== undefined ? summary.displayTitle : t('item.untitled');
      const glyph = firstGlyph(summary !== undefined ? (summary.title || summary.displayTitle) : '', fallbackDir);
      const glyphTypography = glyphStyle(glyph);

      const showBubble = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const body = bodyRef.current;
        const bodyBox = body === null ? null : body.getBoundingClientRect();
        onHover({
          id,
          // 气泡在内层 body 里，top 必须是「方块相对内层顶部」的偏移，不能再混视口坐标。
          itemTop: bodyBox === null ? 0 : box.top - bodyBox.top,
          title,
          workspacePath: fallbackDir,
          updatedAt: summary !== undefined ? summary.updatedAt : Date.now(),
          presentation,
          now: Date.now(),
        });
      };

      return h('button', {
        type: 'button',
        className: 'dsh-rail-pins-tile',
        'aria-label': t('item.open', { title, status: t(presentation.labelKey, presentation.labelVars) }),
        'aria-current': selected ? 'true' : undefined,
        onClick: () => {
          onLeave();
          openSession(id);
        },
        onMouseEnter: showBubble,
        onMouseLeave: onLeave,
        onFocus: showBubble,
        onBlur: onLeave,
        style: {
          boxSizing: 'border-box',
          width: '36px',
          height: '36px',
          flex: 'none',
          padding: 0,
          border: 'none',
          borderRadius: '12px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary, #0f1115)',
          font: 'inherit',
          fontSize: glyphTypography.fontSize,
          letterSpacing: glyphTypography.letterSpacing,
          lineHeight: '20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          cursor: 'pointer',
          pointerEvents: 'auto',
        },
      },
        glyph,
        presentation.tone === null ? null : h('span', {
          key: 'badge',
          style: {
            position: 'absolute',
            bottom: '2px',
            right: '2px',
            display: 'flex',
            pointerEvents: 'none',
          },
        }, StateDot === null ? null : h(StateDot, { state: presentation.tone, size: 10 }))
      );
    });

    function RailPins(props) {
      // 标准 props 不是函数时当没装这个功能：先判后调，绝不先调用再炸。
      if (typeof props.useSessions !== 'function'
        || typeof props.useSessionStatus !== 'function'
        || typeof props.useWorkspaces !== 'function'
        || typeof props.usePanelInfo !== 'function') return null;
      // 注册选项里的 `locale` 不保证给 occupant 注入 `t`；拿不到就用英文词典兜底，
      // 宁可英文也不让整块 UI 崩（见 DECISIONS.md D-07）。useMemo 保证方块 memo 不被新闭包打穿。
      const t = React.useMemo(
        () => (typeof props.t === 'function'
          ? props.t
          : (key, vars) => interpolate(EN[key] ?? key, vars)),
        [props.t],
      );
      const pinnedIds = props.useWorkspaces((snapshot) => snapshot.pinnedSessionIds);
      const workspaces = props.useWorkspaces((snapshot) => snapshot.items);
      const panelActive = props.usePanelInfo((snapshot) => snapshot.activePanelId !== null);
      const currentSessionId = props.useSessions(findCurrentSessionId);
      const anchorRef = React.useRef(null);
      const bodyRef = React.useRef(null);
      const rect = useListAreaRect(anchorRef);
      useSidebarPersistence(anchorRef, props.layout);

      const ids = orderPinnedByWorkspace(pinnedIds, workspaces);
      const pathBySessionId = React.useMemo(() => buildWorkspacePathMap(workspaces), [workspaces]);
      const [hover, setHover] = React.useState(null);
      const clearHover = React.useCallback(() => setHover(null), []);
      const selectedId = panelActive ? undefined : currentSessionId;

      // 外层和锚点常驻（不可见、0 尺寸），这样第一次 pin 出现前就已经量好层原点；
      // 没有 pin 时只是不渲染内层 body，视觉上什么都不出现。
      const show = shouldRenderRailPins(ids, rect);
      const visibleHover = show && hover !== null && ids.includes(hover.id) ? hover : null;

      return h('div', {
        key: 'root',
        className: 'dsh-rail-pins-root',
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          pointerEvents: 'none',
        },
      },
        // 锚点只挂外层：外层 inset:0 永不移动，锚点 origin 恒等于层 origin；
        // 内层 body 按换算结果移动，不会反过来带动锚点（否则就是「自己量自己」）。
        h('div', { key: 'anchor', ref: anchorRef, style: ANCHOR_STYLE }),
        show ? h('div', {
          key: 'body',
          ref: bodyRef,
          className: 'dsh-rail-pins-body',
          style: {
            position: 'absolute',
            left: `${rect.left}px`,
            top: `${rect.top}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            padding: '2px 0',
            boxSizing: 'border-box',
            pointerEvents: 'none',
          },
        },
          h('style', { key: 'style' }, STYLE_TEXT),
          h('div', {
            key: 'divider',
            style: {
              height: '1px',
              width: '100%',
              flex: 'none',
              background: 'var(--dsw-alias-border-l2, #0000001a)',
            },
          }),
          h('div', {
            key: 'scroll',
            className: 'dsh-rail-pins-scroll',
            onScroll: clearHover,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              scrollbarWidth: 'none',
              // 滚动区自己接指针事件，否则滚轮落在方块之间的空隙上时滚不动；
              // 它只覆盖 rail 里本来空着的 36px 列，不会挡主界面。
              pointerEvents: 'auto',
            },
          }, ids.map((id) => h(RailPinTile, {
            key: id,
            id,
            selected: id === selectedId,
            fallbackDir: pathBySessionId.get(id),
            openSession: props.openSession,
            onHover: setHover,
            onLeave: clearHover,
            useSessions: props.useSessions,
            useSessionStatus: props.useSessionStatus,
            bodyRef,
            t,
          }))),
          visibleHover === null ? null : h('div', {
            key: 'bubble',
            className: 'dsh-rail-pins-bubble',
            style: {
              position: 'absolute',
              left: '100%',
              marginLeft: '8px',
              top: `${visibleHover.itemTop}px`,
              width: 'max-content',
              maxWidth: '280px',
              padding: '8px 10px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-l1, #cbcbcb)',
              background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
              color: 'var(--dsw-alias-label-primary, #0f1115)',
              fontSize: '12px',
              lineHeight: '17px',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              pointerEvents: 'auto',
              whiteSpace: 'normal',
              overflowWrap: 'anywhere',
              zIndex: 1,
            },
          },
            h('div', { key: 'title', style: { fontSize: '13px', fontWeight: 500 } }, visibleHover.title),
            h('div', { key: 'workspace', style: { color: 'var(--dsw-alias-label-secondary, #61666b)' } },
              visibleHover.workspacePath === undefined
                ? t('hover.ungrouped')
                : abbreviateHomePath(visibleHover.workspacePath)),
            h('div', { key: 'time', style: { color: 'var(--dsw-alias-label-secondary, #61666b)' } },
              formatRelativeTime(visibleHover.updatedAt, visibleHover.now, t)),
            h('div', { key: 'status', style: { color: 'var(--dsw-alias-label-secondary, #61666b)' } },
              t(visibleHover.presentation.labelKey, visibleHover.presentation.labelVars))
          )
        ) : null
      );
    }

    return {
      inject: ['slots', 'uiWorkspace', 'locale', 'layout'],
      apply(ctx) {
        // 逐语言注册：不依赖「{ en, zh } 一次合并」的签名；词典失败只影响文案
        // （t 还有英文兜底），绝不能拖垮 slot 注册。
        ctx.effect(() => {
          const dispose = [];
          for (const [id, dict] of [['en', EN], ['zh', ZH]]) {
            try {
              const off = ctx.locale.register(LOCALE_NS, id, dict);
              if (typeof off === 'function') dispose.push(off);
            } catch {
              // 词典没挂上也不影响列表渲染。
            }
          }
          return () => {
            for (const off of dispose) {
              try {
                off();
              } catch {
                // disposer 失败不影响卸载。
              }
            }
          };
        });
        const openSession = (sessionId) => {
          ctx.uiWorkspace.openSession(sessionId);
        };
        function RailPinsEntry(entryProps) {
          return h(RailPins, Object.assign({}, entryProps, { openSession, layout: ctx.layout }));
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'rail-pins',
          order: 50,
        }, RailPinsEntry));
      },
    };
  },
});
