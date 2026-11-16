# 环境层：正式路径真正要的那点系统能力（shared/ui-card/environment.ps1）
#
# 只有四样，都有正式调用方：
#   - 原生调用：**建窗**、显示、可见性测量、任务栏闪烁、拖动标题；
#     **置顶只来自建窗**：`New-CardForm` 派生的 Form 在 `CreateParams` 里补 `WS_EX_TOPMOST(0x8)`，
#     随 `CreateWindowEx` 一起交给系统（DECISIONS D-41 取代 D-39 的「层级由 SetWindowPos 决定」）——
#     非前台进程事后改 Z 序会被系统静默忽略，实测 exstyle 停在 0x50000，建窗时才是 0x50008；
#     显示那一步只做显示兜底（`SetWindowPos(…, 0x0053)` 里的 SWP_SHOWWINDOW），不抢焦点；
#     拖动也只是 ReleaseCapture + WM_NCLBUTTONDOWN/HTCAPTION 进系统的移动循环，
#     不碰窗口过程、不改大小、不动层级；
#   - 让位（DECISIONS D-43）：`WS_EX_TOPMOST` 不会自动衰减，置顶的窗口只能**自己**退出 topmost 层。
#     所以装一个低层鼠标钩子（`WH_MOUSE_LL`），用户第一次按在卡片之外就
#     `SetWindowPos(…, HWND_NOTOPMOST(-2), …, 0x0013)` 降层并卸钩；点在卡片自己身上不动，
#     全程事件驱动（无定时器、无轮询、不看前台窗口——卡片从不获得前台）；
#   - DPI 缩放：WinForms 几何是物理像素，卡片 CSS 是逻辑像素，换算要靠它；
#   - 可见性实测：Show() 之后必须量一次，别靠肉眼判断「到底显示出来没有」；
#   - 窗口形状与落位：圆角 Region、居中/右下角坐标（只读屏幕与 DPI，不做布局决策）。
#
# 不放在这里：截图 / 字体枚举 / 完整性级别 / 配置 / 日志 —— 这些只服务于验收，
# 验收脚本放在 shared/ui-card/debug/ 与仓库根 tests/ 里，由它们自己实现。
#
# 注意 $PSScriptRoot 的坑：函数被调用时它已经是**调用方**的目录了，所以本文件执行时
# 就要把要用的路径算好，不能写进函数里。

$script:DpiScale = $null
$script:NativeReady = $false
# 任务栏闪烁的埋点文件：一次调用一行 JSON，只留最近 20 行。真机上「到底闪没闪」只能靠它取证
# （DECISIONS D-28）；路径取 %TEMP%，用户自己看，不进仓库。
$script:FlashLogPath = Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-card-flash.log'
$script:FlashLogMaxLines = 20

function Initialize-CardNative {
    <#
    .SYNOPSIS
        编译一次 P/Invoke 声明（进程内只编一次）。
    #>
    [CmdletBinding()]
    param()

    if ($script:NativeReady) { return }
    if (-not ('DshUiCard.Native' -as [type])) {
        Add-Type -Namespace DshUiCard -Name Native -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern System.IntPtr GetDC(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern int ReleaseDC(System.IntPtr hWnd, System.IntPtr hDC);
// 拖动标题：ReleaseCapture 放掉页面对鼠标的捕获，SendMessage 发 WM_NCLBUTTONDOWN + HTCAPTION，
// 等价于「按住系统标题栏拖」——移动循环由 Windows 自己跑，不改窗口过程、不做 hit-test。
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr hWnd, int msg, System.IntPtr wParam, System.IntPtr lParam);
// 让位（D-43）：低层鼠标钩子。WH_MOUSE_LL = 14，回调跑在**装钩子的线程**上（卡片的 DoEvents 泵）。
// 钩子只回答一个问题：这次按下的位置，根窗口是不是卡片自己。
public delegate System.IntPtr CardHookProc(int nCode, System.IntPtr wParam, System.IntPtr lParam);
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[StructLayout(LayoutKind.Sequential)]
public struct MSLLHOOKSTRUCT {
  public POINT pt;
  public uint mouseData;
  public uint flags;
  public uint time;
  public System.IntPtr dwExtraInfo;
}
[DllImport("user32.dll", SetLastError = true)]
public static extern System.IntPtr SetWindowsHookEx(int idHook, CardHookProc lpfn, System.IntPtr hMod, uint dwThreadId);
[DllImport("user32.dll", SetLastError = true)]
public static extern bool UnhookWindowsHookEx(System.IntPtr hhk);
[DllImport("user32.dll")]
public static extern System.IntPtr CallNextHookEx(System.IntPtr hhk, int nCode, System.IntPtr wParam, System.IntPtr lParam);
[DllImport("user32.dll")]
public static extern System.IntPtr WindowFromPoint(POINT point);
[DllImport("user32.dll")]
public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint gaFlags);
// 只读扩展风格：让位日志要记降层前后的 exstyle / topmost（取证用），不写风格。
[DllImport("user32.dll")]
public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[DllImport("gdi32.dll")] public static extern int GetDeviceCaps(System.IntPtr hdc, int nIndex);
[StructLayout(LayoutKind.Sequential)]
public struct FLASHWINFO {
  public uint cbSize;
  public System.IntPtr hwnd;
  public uint dwFlags;
  public uint uCount;
  public uint dwTimeout;
}
[DllImport("user32.dll", SetLastError = true)]
public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
'@
    }
    $script:NativeReady = $true
}

function New-CardForm {
    <#
    .SYNOPSIS
        造卡片窗口要用的 Form：**建窗时就带 WS_EX_TOPMOST**（置顶只来自这里）。
    .DESCRIPTION
        非前台进程改不了 Z 序：窗口建好之后 `SetWindowPos(HWND_TOPMOST)`、
        `SetWindowLong(GWL_EXSTYLE, ex -bor 8)`、`AttachThreadInput` 到前台线程再抬、跨进程抬、
        先 HWND_TOP 再 HWND_TOPMOST——本机 12 组对照里**全部无效**（exstyle 仍是 0x50000，调用返回 True
        但窗口没进 topmost 层）。根因是 Z 序属于「前台进程才准动」的那一类，系统对非前台进程的 Z 序部分
        静默忽略；建窗时的扩展风格不属 Z 序操作（它随 CreateWindowEx 一起交给系统），所以成立。

        所以这里派生一个 Form，在 `CreateParams` 里补 `WS_EX_TOPMOST(0x00000008)`：窗口一出生就在
        topmost 层——本机实测 exstyle 0x50008、`IsWindowVisible=True`、且**没抢前台**
        （`GetForegroundWindow()` 不是本窗口）。「置顶」与「不抢焦点」可以同时满足（D-41）。

        幂等：environment.ps1 会被多个入口 dot-source（webview2.ps1、各测试脚本），类型已存在就不再编译。
        引用集必须取**当前进程已加载的全部程序集**：只写 `-ReferencedAssemblies System.Windows.Forms`
        会缺 `System.ComponentModel.Primitives`（`CreateParams` 那一支的基类型在里面）而编译失败。
    .OUTPUTS
        DshUiCard.Card.TopMostForm（System.Windows.Forms.Form 的派生类），其它属性照常用。
    #>
    [CmdletBinding()]
    param()

    Add-Type -AssemblyName System.Windows.Forms

    if (-not ('DshUiCard.Card.TopMostForm' -as [type])) {
        $refs = [AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object {
            try { $_.Location } catch { $null }
        } | Where-Object { $_ -and (Test-Path $_) }
        $typeSource = @'
namespace DshUiCard.Card {
  public class TopMostForm : System.Windows.Forms.Form {
    protected override System.Windows.Forms.CreateParams CreateParams {
      get { System.Windows.Forms.CreateParams cp = base.CreateParams; cp.ExStyle |= 0x00000008; return cp; }
    }
  }
}
'@
        Add-Type -ReferencedAssemblies $refs -TypeDefinition $typeSource
    }
    return New-Object DshUiCard.Card.TopMostForm
}

function Get-DpiScale {
    <#
    .SYNOPSIS
        屏幕缩放比例（1.0 = 100%）。缓存，一次进程只量一次。
    .DESCRIPTION
        走 GetDeviceCaps(LOGPIXELSX = 88)：只读系统 DPI，不建位图、不碰 Graphics。
        拿不到就按 1.0 算（宁可窗口偏小，也不要因为环境探测失败弹不出卡）。
    #>
    [CmdletBinding()]
    param()

    if ($null -ne $script:DpiScale) { return $script:DpiScale }
    $script:DpiScale = 1.0
    try {
        Initialize-CardNative
        $dc = [DshUiCard.Native]::GetDC([System.IntPtr]::Zero)
        if ($dc -ne [System.IntPtr]::Zero) {
            try {
                $dpi = [DshUiCard.Native]::GetDeviceCaps($dc, 88)
                if ($dpi -gt 0) { $script:DpiScale = [Math]::Round($dpi / 96.0, 2) }
            } finally {
                [void][DshUiCard.Native]::ReleaseDC([System.IntPtr]::Zero, $dc)
            }
        }
    } catch {
        $script:DpiScale = 1.0
    }
    return $script:DpiScale
}

function Invoke-CardForceShow {
    <#
    .SYNOPSIS
        显示窗口（显示兜底；置顶不是这里做的），返回「修前/修后」的实测值。
    .DESCRIPTION
        宿主拉起子进程时把 STARTUPINFO 设成 { dwFlags: 257, wShowWindow: 0 }
        （STARTF_USESHOWWINDOW + SW_HIDE），Windows 会拿这个 SW_HIDE 顶替本进程**第一次**
        ShowWindow 的参数，而 WinForms 的 Show() 正是那一次。第二次调用照我们给的参数走，
        所以「显示之后再显式 show 一遍」是稳定修法。

        **这里不承担置顶**：置顶在建窗时就已经定了——`New-CardForm` 的 `CreateParams` 把
        `WS_EX_TOPMOST(0x8)` 交给 `CreateWindowEx`（D-41；本机实测 exstyle 0x50000 vs 0x50008）。
        窗口建好之后，非前台进程的 `SetWindowPos` / `SetWindowLong` 对 **Z 序**无效：调用返回 True，
        层级却一动不动，这正是上一版「卡片还在浏览器后面」的根因。所以下面那次 `SetWindowPos`
        只当**显示兜底**（`SWP_SHOWWINDOW` 把窗口显出来、`SWP_NOACTIVATE` 不抢焦点），
        Z 序那半被系统忽略也没关系——层级已经由建窗时定好了。

        不轮询、不检测前台窗口；也**不**抢前台（这里只有显示与一次显示兜底，
        没有任何前台/激活 API）。**让位不在这里**：置顶退层由 `Start-CardTopMostYield`
        （D-43，低层鼠标钩子，事件驱动）负责，本函数一字节不动层级语义。
    .PARAMETER Activate
        用 SW_RESTORE(9)（用户自己触发的确认框适合）；不传则 SW_SHOWNOACTIVATE(4)，
        显示但不抢键盘焦点（通知类弹窗适合）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [switch]$Activate
    )

    $info = [ordered]@{ visibleBefore = $null; visibleAfter = $null; showWindow = $null; setWindowPos = $null; error = $null }
    try {
        Initialize-CardNative
        $info.visibleBefore = [DshUiCard.Native]::IsWindowVisible($Handle)
        $showCommand = if ($Activate) { 9 } else { 4 }
        $info.showWindow = [DshUiCard.Native]::ShowWindow($Handle, $showCommand)
        # HWND_TOPMOST(-1) + SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE|SWP_SHOWWINDOW：
        # 这一调用的作用是**把窗口显示出来**（SWP_SHOWWINDOW 兜住 SW_HIDE 之后的那一次），
        # 顺带保证不抢焦点（SWP_NOACTIVATE）。**它的 Z 序部分在非前台进程里无效**——实测 exstyle
        # 一直停在 0x50000，卡片仍在浏览器后面；置顶来自建窗时 CreateParams 的 WS_EX_TOPMOST（0x50008）。
        $info.setWindowPos = [DshUiCard.Native]::SetWindowPos($Handle, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0053)
        $info.visibleAfter = [DshUiCard.Native]::IsWindowVisible($Handle)
    } catch {
        $info.error = $_.Exception.Message
    }
    return $info
}

# ---------------------------------------------------------------------------
# 让位（DECISIONS D-43）：卡片弹出即置顶，用户第一次按在卡片之外就把自己降回普通层。
#
# 为什么必须自己降：`WS_EX_TOPMOST` 不会自动衰减——窗口一出生就在 topmost 层，除非**它自己**
# 调 `SetWindowPos(HWND_NOTOPMOST)`。三条替代路都不通，且都已实测：① 非前台进程替**别人的**
# 窗口降层无效（exstyle 停在 0x50000）；② 「前台窗口变化」当不了触发（卡片从不获得前台，浏览器
# 始终在前台，事件永远不触发）；③ 定时降层会盖掉还没看完的内容。唯一可用的是全局低层鼠标钩子：
# 它在**装钩子的线程**上被回调，而卡片的泵（Application.DoEvents）正好在跑。
#
# 本层只做窗口与钩子，不认识业务；装不上也不影响卡片（继续置顶，只是不会让位），所以不抛异常。
# ---------------------------------------------------------------------------

$script:YieldHook = [System.IntPtr]::Zero    # 0 = 没装（Stop 的幂等就靠它）
$script:YieldProc = $null                    # 回调委托的强引用：必须放 $script:，否则被 GC 回收、钩子静默失效
$script:YieldHandle = [System.IntPtr]::Zero  # 卡片窗口句柄（回调里比对根窗口用）
$script:YieldLogPath = ''                    # 本次让位的埋点文件（默认沿用闪窗日志）
$script:YieldDone = $false                   # 已经降过层 / 已经放弃：之后不再处理

function Start-CardTopMostYield {
    <#
    .SYNOPSIS
        装一个低层鼠标钩子：用户第一次按在**卡片之外**时，卡片自己降回普通层（不抢焦点）。
    .DESCRIPTION
        卡片弹出即置顶（`New-CardForm` 的 `WS_EX_TOPMOST`，D-41），但置顶不会自动退：用户切到浏览器
        之后卡片仍压在上面，挡着用。窗口的 Z 序只能由**自己**降（实测本源进程
        `SetWindowPos(HWND_NOTOPMOST(-2), …, 0x0013)` 能把 `0x50008` 降成 `0x50000`，返回 True、
        不抢焦点；跨进程替它降无效）。

        触发只用 `WH_MOUSE_LL(14)` 全局低层鼠标钩子：回调在装钩子的线程上跑，卡片的 DoEvents 泵正好
        在转，所以**不用定时器、不用轮询**，也不看前台窗口（卡片从不获得前台，那条路永远是死路）。

        命中判定用「点在哪」而不是「谁被激活」：`WindowFromPoint` + `GetAncestor(…, GA_ROOT=2)` 归到
        根窗口，等于卡片句柄就**不动**（WebView2 的子窗口也能归回来）；不等于就降层、卸钩、之后不再处理。

        装钩子失败**不许**打断弹窗：吞掉异常、记一条埋点，卡片继续置顶（让位是体验优化，不是功能前提）。
    .PARAMETER Handle
        卡片窗口的 HWND（`$form.Handle`）。
    .PARAMETER LogPath
        埋点文件路径，默认沿用 `$script:FlashLogPath`（%TEMP%\dsh-card-flash.log，一次一行 JSON）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [string]$LogPath = ''
    )

    # 幂等：已经装过就不再装第二个（一张卡一个进程一般只有一次，重复调用只能是误用）。
    if ($script:YieldHook -ne [System.IntPtr]::Zero) { return }

    $yieldLog = if ([string]::IsNullOrWhiteSpace($LogPath)) { $script:FlashLogPath } else { $LogPath }
    try {
        Initialize-CardNative
        $script:YieldLogPath = $yieldLog
        $script:YieldHandle = $Handle
        $script:YieldDone = $false

        # 装钩子**之前**先记一条：真机上「到底装没装、装的时候是不是还置顶」只能靠它取证。
        $exstyle = [int][DshUiCard.Native]::GetWindowLong($Handle, -20)
        Write-CardFlashLog -Path $yieldLog -Fields ([ordered]@{
                kind    = 'yield-armed'
                hwnd    = ('0x{0:X}' -f $Handle.ToInt64())
                exstyle = ('0x{0:X}' -f $exstyle)
                topmost = (($exstyle -band 8) -eq 8)
                note    = '装钩子前：这时卡片应当还在 topmost 层'
            })

        # 回调委托**必须**留在 $script: 作用域：局部变量出了函数就被回收，钩子随后静默失效
        # （demo 里踩过这个点），现象是「点了外面毫无反应，也不报错」。
        $script:YieldProc = [DshUiCard.Native+CardHookProc]{
            param($nCode, $wParam, $lParam)
            try {
                if ($nCode -ge 0 -and -not $script:YieldDone) {
                    $message = [int]$wParam
                    # 只看按下类消息：左键 WM_LBUTTONDOWN(0x0201)、右键 0x0204、中键 0x0207。
                    if ($message -eq 0x0201 -or $message -eq 0x0204 -or $message -eq 0x0207) {
                        $info = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
                            $lParam, [type]'DshUiCard.Native+MSLLHOOKSTRUCT')
                        $under = [DshUiCard.Native]::WindowFromPoint($info.pt)
                        # 命中的可能还是 WebView2 的宿主/子窗口：往上归到根窗口再比（GA_ROOT = 2）。
                        $root = if ($under -ne [System.IntPtr]::Zero) {
                            [DshUiCard.Native]::GetAncestor($under, 2)
                        } else {
                            [System.IntPtr]::Zero
                        }
                        if ($root -ne $script:YieldHandle) {
                            # 点在卡片外面：降回普通层。HWND_NOTOPMOST(-2) + SWP_NOSIZE|SWP_NOMOVE|
                            # SWP_NOACTIVATE(0x0013)——只动层级，不改尺寸/位置、不抢焦点。
                            $script:YieldDone = $true
                            $ret = [DshUiCard.Native]::SetWindowPos(
                                $script:YieldHandle, [System.IntPtr]::new(-2), 0, 0, 0, 0, 0x0013)
                            $ex = [int][DshUiCard.Native]::GetWindowLong($script:YieldHandle, -20)
                            Write-CardFlashLog -Path $script:YieldLogPath -Fields ([ordered]@{
                                    kind    = 'yield'
                                    hwnd    = ('0x{0:X}' -f $script:YieldHandle.ToInt64())
                                    ret     = [bool]$ret
                                    exstyle = ('0x{0:X}' -f $ex)
                                    topmost = (($ex -band 8) -eq 8)
                                })
                        }
                        # 点在卡片自己身上（$root -eq 卡片句柄）：什么都不做，继续等下一次按下。
                    }
                }
            } catch {
                # 回调里出事不许影响鼠标：吞掉，下一次按下照常判断。
            }
            # 链式调用必须转发，否则卡片之外的鼠标事件在我们这里断掉。
            return [DshUiCard.Native]::CallNextHookEx($script:YieldHook, $nCode, $wParam, $lParam)
        }

        $script:YieldHook = [DshUiCard.Native]::SetWindowsHookEx(14, $script:YieldProc, [System.IntPtr]::Zero, 0)
        $lastError = [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Write-CardFlashLog -Path $yieldLog -Fields ([ordered]@{
                kind      = 'yield-hook'
                hwnd      = ('0x{0:X}' -f $Handle.ToInt64())
                hhook     = ('0x{0:X}' -f $script:YieldHook.ToInt64())
                lastError = $lastError
                armed     = ($script:YieldHook -ne [System.IntPtr]::Zero)
                note      = 'armed=false 只说明这次没装上：卡片保持置顶，不影响使用'
            })
    } catch {
        # 任何失败都退回「只置顶、不让位」：卡片照常可用，不许因为装钩子失败弹不出窗。
        $script:YieldHook = [System.IntPtr]::Zero
        $script:YieldDone = $true
        try {
            Write-CardFlashLog -Path $yieldLog -Fields ([ordered]@{
                    kind  = 'yield-hook'
                    hwnd  = ('0x{0:X}' -f $Handle.ToInt64())
                    armed = $false
                    error = $_.Exception.Message
                })
        } catch {
        }
    }
}

function Stop-CardTopMostYield {
    <#
    .SYNOPSIS
        卸掉让位钩子（幂等：没装就什么都不做）。
    .DESCRIPTION
        收尾（关窗、超时、异常）时调用：钩子是进程级的，留着会在卡片销毁后继续被回调。先 `UnhookWindowsHookEx`
        再清强引用；日志只在**真的卸了**的时候写一行（没装过就不该多一行噪声）。任何失败都吞掉，
        绝不允许影响关窗。
    #>
    [CmdletBinding()]
    param()

    try {
        if ($script:YieldHook -ne [System.IntPtr]::Zero) {
            $hhook = $script:YieldHook
            [void][DshUiCard.Native]::UnhookWindowsHookEx($hhook)
            $lastError = [int][System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            $logPath = if ([string]::IsNullOrWhiteSpace($script:YieldLogPath)) { $script:FlashLogPath } else { $script:YieldLogPath }
            Write-CardFlashLog -Path $logPath -Fields ([ordered]@{
                    kind      = 'yield-disarm'
                    hwnd      = ('0x{0:X}' -f $script:YieldHandle.ToInt64())
                    hhook     = ('0x{0:X}' -f $hhook.ToInt64())
                    lastError = $lastError
                })
        }
    } catch {
    } finally {
        $script:YieldHook = [System.IntPtr]::Zero
        $script:YieldProc = $null
        $script:YieldDone = $true
    }
}

function Write-CardFlashLog {
    <#
    .SYNOPSIS
        把一次任务栏闪烁的实测结果追加成一行 JSON（只留最近 20 行）。
    .DESCRIPTION
        记的是「闪的时候现场是什么样」：传进去的 cbSize / flags / 次数 / 节奏、结构体大小靠
        Marshal.SizeOf 算出来的值、FlashWindowEx 的返回值与 last error、闪之前的可见性与前台判定，
        加上调用方补的上下文（ShowInTaskbar、是否 -Activate、显示后过了多少毫秒）。
        没有这些，真机上「没闪」到底是没调成功、窗口在前台从而按语义不闪、还是任务栏按钮
        还没建出来，全都分不清（D-28）。

        **任何失败都不抛**：埋点是为了排查，不许把弹窗弄坏。
    .PARAMETER Fields
        要写进这一行的键值对，顺序就是 JSON 里的顺序。
    .PARAMETER Path
        埋点文件，默认 `$script:FlashLogPath`。让位（D-43）允许调用方另给一个路径，格式与轮转规则不变。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Fields,
        [string]$Path = ''
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { $Path = $script:FlashLogPath }
    try {
        $record = [ordered]@{ ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') }
        foreach ($key in $Fields.Keys) { $record[[string]$key] = $Fields[$key] }
        $line = ($record | ConvertTo-Json -Compress -Depth 3)

        $lines = [System.Collections.Generic.List[string]]::new()
        if ([System.IO.File]::Exists($Path)) {
            foreach ($existing in [System.IO.File]::ReadAllLines($Path)) { $lines.Add($existing) }
        }
        $lines.Add($line)
        # 只留最近 20 行：日志有用，但无限长就会变成没人看的垃圾。
        while ($lines.Count -gt $script:FlashLogMaxLines) { $lines.RemoveAt(0) }
        [System.IO.File]::WriteAllLines($Path, $lines)
    } catch {
    }
}

function Invoke-TaskbarFlash {
    <#
    .SYNOPSIS
        开始闪任务栏按钮，返回「该在多少毫秒后显式停」的会话（停不下来是 Windows 的老行为，见 D-28）。
    .DESCRIPTION
        dwFlags = FLASHW_ALL(3) = FLASHW_CAPTION(1) | FLASHW_TRAY(2)，uCount 5、dwTimeout 500。

        **uCount / dwTimeout 只是「闪的节奏」，不是「闪多久」**：窗口不在前台时，任务栏的
        「请求注意」会一直闪到那个窗口被激活为止——真机实测「一直闪不停，直到卡片关掉」就是这条
        （D-28 的日志：visible=true / isForeground=false / flags=3 / uCount=5 / dwTimeout=500，
        参数全对、调用也进去了，就是不停）。所以停止**必须显式做**：调用方在约 2.5 秒后调
        Stop-TaskbarFlash 发一次 FLASHW_STOP。

        **不用 FLASHW_TIMERNOFG(12)**：它的语义本来就是「一直闪到窗口到前台为止」，正是要去掉的
        行为；而且窗口本来就在前台时它什么都不做（传了 -Activate 的卡片会激活自己）。

        卡片是 FormBorderStyle.None 的无边框窗口，没有标题栏可闪，所以 FLASHW_CAPTION 这一半在
        卡上**没有可见效果**；真正起作用的是任务栏按钮。保留 ALL 是为了语义完整。

        只抬注意、不抬窗口——置顶由建窗时的 `WS_EX_TOPMOST` 决定（`New-CardForm`，D-41），
        闪烁是抢不到焦点时的补充手段。
    .PARAMETER Note
        调用方补的上下文（ShowInTaskbar / 是否 -Activate / ShowWindow 结果 / 显示后到闪烁之间的
        毫秒数），只写进埋点日志，不参与行为。
    .OUTPUTS
        StopAfterMs（uCount × dwTimeout，即该在多少毫秒后显式停）+ Watch（从发出闪烁起算的秒表，
        停止那一行用它算 stoppedAtMs）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [System.Collections.IDictionary]$Note = @{}
    )

    $fields = [ordered]@{}
    $watch = [System.Diagnostics.Stopwatch]::new()
    $stopAfterMs = 0
    try {
        Initialize-CardNative
        $sizeOf = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DshUiCard.Native+FLASHWINFO')
        $info = New-Object 'DshUiCard.Native+FLASHWINFO'
        $info.cbSize = [uint32]$sizeOf
        $info.hwnd = $Handle
        # FLASHW_ALL：标题栏 + 任务栏按钮。5 × 500ms 只是节奏，到点由 Stop-TaskbarFlash 显式收尾。
        $info.dwFlags = 3
        $info.uCount = 5
        $info.dwTimeout = 500
        $stopAfterMs = [int]($info.uCount * $info.dwTimeout)

        $fields.cbSize = [int]$info.cbSize
        $fields.sizeOf = [int]$sizeOf
        $fields.dwFlags = [int]$info.dwFlags
        $fields.uCount = [int]$info.uCount
        $fields.dwTimeout = [int]$info.dwTimeout

        # 闪之前的现场：可见性、前台是谁。FlashWindowEx 不改这两样，先量再说。
        $fields.visible = [bool][DshUiCard.Native]::IsWindowVisible($Handle)
        $foreground = [DshUiCard.Native]::GetForegroundWindow()
        $fields.isForeground = ($foreground -eq $Handle)
        $fields.foregroundHwnd = ('0x{0:X}' -f $foreground.ToInt64())

        $fields.flashReturn = [int][DshUiCard.Native]::FlashWindowEx([ref]$info)
        $fields.lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $watch.Start()
    } catch {
        $fields.error = $_.Exception.Message
    } finally {
        $record = [ordered]@{ kind = 'flash' }
        foreach ($key in $Note.Keys) { $record[[string]$key] = $Note[$key] }
        $record['hwnd'] = ('0x{0:X}' -f $Handle.ToInt64())
        foreach ($key in $fields.Keys) { $record[[string]$key] = $fields[$key] }
        # 这两个值都不是成功/失败，写清楚，免得下次又被 lastError 带偏。
        $record['retNote'] = '返回值=调用前窗口是否已画成活动态，0 是正常'
        $record['errNote'] = 'lastError 只在声明 SetLastError 的调用上有意义'
        Write-CardFlashLog -Fields $record
    }
    return [pscustomobject]@{ StopAfterMs = $stopAfterMs; Watch = $watch }
}

function Stop-TaskbarFlash {
    <#
    .SYNOPSIS
        显式停掉任务栏的「请求注意」（FLASHW_STOP）——「闪几秒就停」靠它，不靠 uCount / dwTimeout。
    .DESCRIPTION
        非前台窗口的「请求注意」**不会**因为 uCount / dwTimeout 到点就停：Windows 会一直闪到该窗口
        被激活为止（D-28 真机结论：「一直闪不停，直到卡片关掉」）。dwFlags = 0（FLASHW_STOP）、
        uCount = 0、dwTimeout = 0、同一个句柄，是唯一能保证「闪几秒就停」的手段。

        停止时句柄可能已经随卡片销毁（用户提前关窗）：先 IsWindow 判活再发；任何异常都吞掉，
        绝不允许影响关窗。
    .PARAMETER ElapsedMs
        从发出闪烁到这次停止之间过了多少毫秒，只写进埋点日志（正常应接近 2500）。
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [int]$ElapsedMs = 0
    )

    $fields = [ordered]@{}
    try {
        Initialize-CardNative
        $alive = [bool][DshUiCard.Native]::IsWindow($Handle)
        $fields.isWindow = $alive
        if ($alive) {
            $sizeOf = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'DshUiCard.Native+FLASHWINFO')
            $info = New-Object 'DshUiCard.Native+FLASHWINFO'
            $info.cbSize = [uint32]$sizeOf
            $info.hwnd = $Handle
            $info.dwFlags = 0        # FLASHW_STOP：显式停掉请求注意。
            $info.uCount = 0
            $info.dwTimeout = 0
            $fields.cbSize = [int]$info.cbSize
            $fields.sizeOf = [int]$sizeOf
            $fields.dwFlags = [int]$info.dwFlags
            $fields.uCount = [int]$info.uCount
            $fields.dwTimeout = [int]$info.dwTimeout
            $fields.stopReturn = [int][DshUiCard.Native]::FlashWindowEx([ref]$info)
            $fields.lastError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        }
    } catch {
        $fields.error = $_.Exception.Message
    } finally {
        $record = [ordered]@{ kind = 'stop'; stoppedAtMs = $ElapsedMs }
        $record['hwnd'] = ('0x{0:X}' -f $Handle.ToInt64())
        foreach ($key in $fields.Keys) { $record[[string]$key] = $fields[$key] }
        $record['retNote'] = '返回值=调用前窗口是否已画成活动态，不要当成功/失败'
        Write-CardFlashLog -Fields $record
    }
}

# ---------------------------------------------------------------------------
# 窗口形状与落位：圆角 Region、坐标。放在环境层是因为它们只读系统的屏幕/DPI 信息，
# 不做布局决策（多高多宽由 webview2.ps1 量完再传进来）。
# ---------------------------------------------------------------------------

function New-CardRegion {
    <#
    .SYNOPSIS
        造一个圆角窗口 Region；半径不合适时返回 $null（窗口保持直角，不算失败）。
    .PARAMETER Radius
        物理像素。调用方按 DPI 把 CSS 的圆角换算过来。
    #>
    [CmdletBinding()]
    param(
        [int]$Width,
        [int]$Height,
        [int]$Radius
    )

    if ($Radius -le 0 -or $Width -le ($Radius * 2) -or $Height -le ($Radius * 2)) { return $null }
    $diameter = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
        $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
        $path.AddArc($Width - $diameter, 0, $diameter, $diameter, 270, 90)
        $path.AddArc($Width - $diameter, $Height - $diameter, $diameter, $diameter, 0, 90)
        $path.AddArc(0, $Height - $diameter, $diameter, $diameter, 90, 90)
        $path.CloseFigure()
        return [System.Drawing.Region]::new($path)
    } finally {
        $path.Dispose()
    }
}

function Resolve-CardScreenArea {
    <#
    .SYNOPSIS
        退让链的**纯函数**部分：给定三块候选区域，挑第一块可用的；一块都没有就返回 $null。
    .DESCRIPTION
        为什么单独一个函数：退让链以前和 WinForms 调用缠在一起，只能靠「真插第二块显示器」才测得到
        （tests/card-placement.ps1 里原来只能测「不抛」）。把选择逻辑抽出来之后，三条分支都能拿假数据钉死，
        而且能保证**只能返回传进来的某一块**——所以返回值必然等于某块真屏的 work area，不会凭空造一个矩形。
        `Get-CardScreenArea` 只负责取三块候选（I/O），选择全在这里。
    .PARAMETER ForegroundArea
        前台窗口所在屏的 work area（首选）。
    .PARAMETER CursorArea
        光标所在屏的 work area（前台信息拿不到时）。
    .PARAMETER PrimaryArea
        主屏 work area（最后兜底）。
    .OUTPUTS
        pscustomobject：Left / Top / Width / Height / Right / Bottom；三块都不可用（$null、宽或高 ≤ 0）时返回 $null。
    #>
    [CmdletBinding()]
    param(
        [object]$ForegroundArea = $null,
        [object]$CursorArea = $null,
        [object]$PrimaryArea = $null
    )

    foreach ($candidate in @($ForegroundArea, $CursorArea, $PrimaryArea)) {
        if ($null -eq $candidate) { continue }
        # 宽或高为 0 的矩形等于「没解析到」：拿它算限高会被下限抬成 160、算落位会落到 (0,0)。
        if ([int]$candidate.Width -le 0 -or [int]$candidate.Height -le 0) { continue }
        return [pscustomobject]@{
            Left = [int]$candidate.Left; Top = [int]$candidate.Top
            Width = [int]$candidate.Width; Height = [int]$candidate.Height
            Right = [int]$candidate.Right; Bottom = [int]$candidate.Bottom
        }
    }
    return $null
}

function Get-CardScreenArea {
    <#
    .SYNOPSIS
        当前活动窗口所在屏幕的可用区（物理像素）。
    .DESCRIPTION
        多屏时卡片要跟人正在干活的那块屏走（PREFERENCES B-24），屏幕解析按下面顺序退让：
          1. 前台窗口所在屏：user32!GetForegroundWindow → Screen.FromHandle(hwnd)；
          2. 光标所在屏：Screen.FromPoint(Cursor.Position)；
          3. 主屏：Screen.PrimaryScreen。
        1 是主路径；2、3 只是兜底（为什么不能只用它们，见 DECISIONS D-25）。
        单位是**物理像素**，与现有落位一致：DPI 缩放由调用方按 $Scale 用在边距与间隔上。
        这里只取三块候选，选哪块由 Resolve-CardScreenArea 决定（纯函数，可测）。
    .OUTPUTS
        pscustomobject：Left / Top / Width / Height / Right / Bottom；三条路全失败时返回 $null。
        **不再退回全零矩形**：0 高的区域算出 0 的可用高度，限高会被下限抬成 160、落位会落到 (0,0)，
        等于凭空编一个尺寸（2026-11-12 排查「页面报 291、窗口 271」时改，见 D-46）。
        调用方拿到 $null 必须报错，不许猜。
    #>
    [CmdletBinding()]
    param()

    Add-Type -AssemblyName System.Windows.Forms

    $foregroundArea = $null
    try {
        # Initialize-CardNative 自己幂等（$script:NativeReady + 类型存在守卫），重复调用不会重复 Add-Type。
        Initialize-CardNative
        $hwnd = [DshUiCard.Native]::GetForegroundWindow()
        if ($hwnd -ne [System.IntPtr]::Zero) {
            $screen = [System.Windows.Forms.Screen]::FromHandle($hwnd)
            if ($null -ne $screen) { $foregroundArea = $screen.WorkingArea }
        }
    } catch {
        $foregroundArea = $null
    }

    $cursorArea = $null
    try { $cursorArea = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea }
    catch { $cursorArea = $null }

    $primaryArea = $null
    try { $primaryArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea }
    catch { $primaryArea = $null }

    Resolve-CardScreenArea -ForegroundArea $foregroundArea -CursorArea $cursorArea -PrimaryArea $primaryArea
}

function Get-CardPlacement {
    <#
    .SYNOPSIS
        算窗口左上角坐标（物理像素）。不改窗口。
    .DESCRIPTION
        center：居中到活动窗口所在屏幕的可用区（一般弹窗）。
        corner：同一块屏的右下角，同时在场的多个弹窗按次序往上错开（通知类，别互相盖住）。
        屏幕只用 Get-CardScreenArea 解析出来的那一块（可用 -Area 直接传，让落位数学可测）；
        corner 不再硬编码主屏——通知卡也该落在用户所在的屏。
    .PARAMETER Area
        屏幕可用区，需要 Left / Top / Width / Height / Right / Bottom。
        不传就用 Get-CardScreenArea（前台窗口 → 光标 → 主屏）。
    #>
    [CmdletBinding()]
    param(
        [int]$Width,
        [int]$Height,
        [ValidateSet('center', 'corner')][string]$Position = 'center',
        [double]$Scale = 1,
        [int]$SlotIndex = 0,
        [int]$SlotCount = 1,
        [object]$Area = $null
    )

    # 解析一次、只在这一处：传进来就完全按它算，不传才去问系统。
    $area = if ($null -eq $Area) { Get-CardScreenArea } else { $Area }
    # 解析不出来就报错：拿空区域算落位只会落到 (0,0)，看起来像「卡片跑到左上角」这种玄学 bug（D-46）。
    if ($null -eq $area -or [int]$area.Width -le 0 -or [int]$area.Height -le 0) {
        throw '算不了落位：没有可用的屏幕区域（Get-CardScreenArea 与调用方都没给）'
    }

    if ($Position -eq 'corner') {
        $margin = [int][Math]::Round(16 * $Scale)
        $gap = [int][Math]::Round(8 * $Scale)
        $left = $area.Right - $Width - $margin
        if ($left -lt $area.Left) { $left = $area.Left }
        $baseY = $area.Bottom - $Height - $margin
        $step = $Height + $gap
        if ($SlotCount -gt 1) {
            $available = $baseY - ($area.Top + $gap)
            $fitted = [int][Math]::Floor($available / ($SlotCount - 1))
            $floor = [int][Math]::Round(44 * $Scale)
            if ($fitted -lt $floor) { $fitted = $floor }
            if ($fitted -lt $step) { $step = $fitted }
        }
        $top = $baseY - ($SlotIndex * $step)
        if ($top -lt ($area.Top + $gap)) { $top = $area.Top + $gap }
        return [pscustomobject]@{ Left = $left; Top = $top }
    }

    $centerLeft = $area.Left + [int](($area.Width - $Width) / 2)
    if ($centerLeft -lt $area.Left) { $centerLeft = $area.Left }
    $centerTop = $area.Top + [int](($area.Height - $Height) / 2)
    if ($centerTop -lt $area.Top) { $centerTop = $area.Top }
    [pscustomobject]@{ Left = $centerLeft; Top = $centerTop }
}
