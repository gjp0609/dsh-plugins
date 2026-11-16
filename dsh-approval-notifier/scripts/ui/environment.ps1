# 环境层（scripts\ui\environment.ps1）
#
# 只做「把界面跑起来」需要的准备，不含任何布局或业务：
#   - 原生调用：完整性级别（排障用）+ 屏幕抓图（验收用）；
#   - DPI 缩放比例（验收脚本算按钮坐标要用）；
#   - 「真写一个文件」判断目录可写。
#
# 窗口的显示/置顶/任务栏闪烁由共享外壳 shared/ui-card/environment.ps1 负责，不在这里重复：
# 这条插件只剩 WebView2 一条渲染路径，原生卡的显示逻辑（关窗、拖动、闪烁）已随它一起删除。
#
# 由 prompt.ps1 dot-source。注意 $PSScriptRoot 的坑：函数被调用时它已经是**调用方**的目录了，
# 所以要在本文件执行时就把路径算好，不能写进函数里。
#
# 函数一律带 Approval 前缀：本文件与 shared/ui-card/environment.ps1 会被 dot-source 进
# **同一个**脚本作用域，同名函数会静默互相覆盖（外壳那边叫 Get-DpiScale / Invoke-TaskbarFlash /
# Invoke-CardForceShow）。前缀的另一半作用是语义：这里只有自检/验收用的能力。

$script:ApprovalDpiScale = $null
$script:ApprovalNativeReady = $false

function Initialize-ApprovalNative {
    <#
    .SYNOPSIS
        编译一次 P/Invoke 声明（进程内只编一次）。
    #>
    if ($script:ApprovalNativeReady) { return }
    if (-not ('DshApprovalNotifier.Native' -as [type])) {
        Add-Type -Namespace DshApprovalNotifier -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetDC(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern int ReleaseDC(System.IntPtr hWnd, System.IntPtr hDC);
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[DllImport("gdi32.dll")] public static extern bool BitBlt(System.IntPtr hdcDest, int x, int y, int w, int h, System.IntPtr hdcSrc, int xs, int ys, uint rop);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(System.IntPtr processHandle, uint desiredAccess, out System.IntPtr tokenHandle);
[DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(System.IntPtr tokenHandle, int tokenInformationClass, System.IntPtr tokenInformation, int tokenInformationLength, out int returnLength);
[DllImport("advapi32.dll")] public static extern System.IntPtr GetSidSubAuthority(System.IntPtr sid, uint subAuthorityIndex);
[DllImport("advapi32.dll")] public static extern System.IntPtr GetSidSubAuthorityCount(System.IntPtr sid);
[DllImport("kernel32.dll")] public static extern System.IntPtr GetCurrentProcess();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(System.IntPtr handle);
public static int IntegrityRid() {
  System.IntPtr token;
  if (!OpenProcessToken(GetCurrentProcess(), 0x0008u, out token)) return -1;
  try {
    int size = 0;
    GetTokenInformation(token, 25, System.IntPtr.Zero, 0, out size);
    if (size <= 0) return -1;
    System.IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      int written = 0;
      if (!GetTokenInformation(token, 25, buffer, size, out written)) return -1;
      System.IntPtr sid = Marshal.ReadIntPtr(buffer);
      if (sid == System.IntPtr.Zero) return -1;
      byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      if (count == 0) return -1;
      return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  } finally {
    CloseHandle(token);
  }
}
'@
    }
    $script:ApprovalNativeReady = $true
}

function Get-ApprovalDpiScale {
    <#
    .SYNOPSIS
        屏幕缩放比例（1.0 = 100%）。缓存，一次进程只量一次。
    .DESCRIPTION
        几何尺寸在 WinForms 里是物理像素，而卡片里的 CSS 是逻辑像素，两者要靠它换算。
        验收脚本（tests\card-click.ps1）按它把按钮坐标从 CSS px 换成屏幕像素。
    #>
    if ($null -ne $script:ApprovalDpiScale) { return $script:ApprovalDpiScale }
    $script:ApprovalDpiScale = 1.0
    try {
        $bitmap = New-Object System.Drawing.Bitmap 1, 1
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $script:ApprovalDpiScale = [Math]::Round(([double]$graphics.DpiX / 96.0), 2)
        $graphics.Dispose()
        $bitmap.Dispose()
    } catch {
        $script:ApprovalDpiScale = 1.0
    }
    return $script:ApprovalDpiScale
}

function Test-WritableDir {
    <#
    .SYNOPSIS
        真写一个文件来判断目录可写（不是靠权限推断）。
    .DESCRIPTION
        必须用会抛异常的 .NET 调用：Set-Content 的失败是非终止性错误，try/catch 接不住，
        会得出假的「能写」。
    #>
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return 'empty-path' }
    $probe = Join-Path $Path ('.dsh-approval-notifier-probe-' + [guid]::NewGuid().ToString('n'))
    try {
        [System.IO.File]::WriteAllText($probe, 'ok')
        [System.IO.File]::Delete($probe)
        return 'ok'
    } catch {
        return ($_.Exception.GetType().Name + ': ' + $_.Exception.Message)
    }
}

function Get-ProcessIntegrity {
    <#
    .SYNOPSIS
        进程完整性级别（写数据目录/结果文件与它有关，排障时最有用的一条）。
    #>
    Initialize-ApprovalNative
    $rid = $null
    try { $rid = [DshApprovalNotifier.Native]::IntegrityRid() } catch { $rid = $null }
    $label = switch ($rid) {
        4096 { 'Low' }
        8192 { 'Medium' }
        12288 { 'High' }
        16384 { 'System' }
        default { "rid=$rid" }
    }
    return [pscustomobject]@{ Rid = $rid; Label = $label }
}

function Save-ScreenCapture {
    <#
    .SYNOPSIS
        把屏幕上指定矩形抓成 PNG（只给 `prompt.ps1 -ScreenShot` 这个验收开关用）。
    .DESCRIPTION
        必须用 BitBlt + CAPTUREBLT(0x40CC0020)：Graphics.CopyFromScreen 会漏掉置顶/分层窗口，
        截出来是一张白卡。
    #>
    param(
        [Parameter(Mandatory = $true)][System.IntPtr]$Handle,
        [Parameter(Mandatory = $true)][string]$Path
    )
    Initialize-ApprovalNative
    $rect = New-Object DshApprovalNotifier.Native+RECT
    if (-not [DshApprovalNotifier.Native]::GetWindowRect($Handle, [ref]$rect)) { return $false }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) { return $false }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $destDc = $graphics.GetHdc()
        $screenDc = [DshApprovalNotifier.Native]::GetDC([System.IntPtr]::Zero)
        # SRCCOPY | CAPTUREBLT
        [void][DshApprovalNotifier.Native]::BitBlt($destDc, 0, 0, $width, $height, $screenDc, $rect.Left, $rect.Top, 0x40CC0020)
        [void][DshApprovalNotifier.Native]::ReleaseDC([System.IntPtr]::Zero, $screenDc)
        $graphics.ReleaseHdc($destDc)
        $graphics.Dispose()
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $bitmap.Dispose()
    }
    return $true
}
