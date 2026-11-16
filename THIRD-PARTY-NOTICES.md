# 第三方组件声明

本仓库自己的代码（四个插件的 `index.js` / `lib` / `scripts` / `tests`，以及 `shared/ui-card` 的源码与构建配置）没有附带许可声明，默认保留所有权利。

下面列的是**随仓库一起分发、或被打包进入库产物**的第三方组件。只列组件、版本、许可与位置；MIT 类许可的完整条文在各 npm 包的 `LICENSE` 文件里（`node_modules` 不入库，拿到对应包即可取全文），需要逐条保留声明的两份 BSD 条文完整附在文末。

## 1. 随仓库分发的二进制

| 组件 | 版本 | 许可 | 位置 |
| :--- | :--- | :--- | :--- |
| WebView2 SDK：`Microsoft.Web.WebView2.Core.dll`、`Microsoft.Web.WebView2.WinForms.dll`、`WebView2Loader.dll` | 1.0.4314.35 | BSD-3-Clause，© Microsoft Corporation | `vendor/webview2/` |

三个 DLL **原样分发、未做任何修改**，仅作为窗口宿主加载（卡片外壳用它起 WebView2）。原件来自 NuGet 包 `Microsoft.Web.WebView2` 1.0.4314.35，同目录保留了上游的 `webview2.1.0.4314.35.nupkg` 与解包出的 `NOTICE.txt`。BSD-3 要求再分发二进制时附带版权与许可声明，全文见文末 **附录 A**。

## 2. 打包进 `shared/ui-card/dist/index.html`

`shared/ui-card/dist/index.html` 是 `app/` 用 vite 打出的**单文件产物**（入库、部署时随插件走），内联了下列库：

| 组件 | 版本 | 许可 |
| :--- | :--- | :--- |
| react / react-dom（含 scheduler、react-is） | 18.3.1 | MIT |
| antd（含其依赖：`rc-*` 系列组件、`@ant-design/cssinjs`、dayjs、classnames、stylis、compute-scroll-into-view、resize-observer-polyfill、throttle-debounce、toggle-selection、copy-to-clipboard、json2mq、string-convert、scroll-into-view-if-needed、nanoid） | 5.29.3（antd） | MIT |
| shiki（含 oniguruma-to-es、regex、regex-recursion、regex-utilities 等） | 4.5.0 | MIT |

完整依赖树与锁定版本见 `shared/ui-card/app/package-lock.json`；各库许可全文取 `shared/ui-card/app/node_modules/<包名>/LICENSE`，或重装依赖后同路径读取。

## 3. 打包进 `dsh-ssh-remote/index.bundle.js`

`dsh-ssh-remote/index.bundle.js` 是用 esbuild 打出的**单文件产物**（依赖已内联，运行时不需要 node），包含：

| 组件 | 版本 | 许可 |
| :--- | :--- | :--- |
| ssh2 | 1.17.0 | MIT，© Brian White |
| asn1 | 0.2.6 | MIT，© 2011 Mark Cavage |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause（Blowfish）＋ ISC 风格（bcrypt_pbkdf、Joyent 性能改进），全文见文末 **附录 B** |

这个 bundle 只内联 SSH 协议实现，不含任何主机清单或凭据（那些在本机 `%DSH_HOME%\plugin-data\` 下，用 Windows DPAPI 加密）。

## 4. 未随仓库分发

- WebView2 的 `.nupkg` 解包目录（`vendor/webview2/extracted/`）只在开发机上存在，不入库；
- 所有 `node_modules`、构建缓存、测试临时物都不入库。

---

## 附录 A：WebView2 SDK 许可全文（BSD-3-Clause）

```text
Copyright (C) Microsoft Corporation. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
   * The name of Microsoft Corporation, or the names of its contributors
may not be used to endorse or promote products derived from this
software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 附录 B：bcrypt-pbkdf 许可全文

```text
The Blowfish portions are under the following license:

Blowfish block cipher for OpenBSD
Copyright 1997 Niels Provos <provos@physnet.uni-hamburg.de>
All rights reserved.

Implementation advice by David Mazieres <dm@lcs.mit.edu>.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.
3. The name of the author may not be used to endorse or promote products
   derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.



The bcrypt_pbkdf portions are under the following license:

Copyright (c) 2013 Ted Unangst <tedu@openbsd.org>

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.



Performance improvements (Javascript-specific):

Copyright 2016, Joyent Inc
Author: Alex Wilson <alex.wilson@joyent.com>

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
