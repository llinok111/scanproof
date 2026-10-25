# 基线记录（改动前，2026-10-25）

环境：Windows 10.0.26300 / Node v22.22.2 / npm 10.9.7 / Git Bash
上游 commit：`3848ed2c17de5bcdead487417dbf14c5dd017f8d`（v1.5.4, 2024-08-05）

## 1. 依赖安装

```
npm install --ignore-scripts
```

- 默认 `npm install` **失败**：devDependency `canvas@2.x` 在本机无预编译包，node-gyp 编译失败。
- 加 `--ignore-scripts` 后安装成功；`rollup` / `tap` / `standard` 均可用。
- **已知限制**：`canvas@2` 缺失导致 3 个 canvas 相关测试无法执行（下表标 SKIP，不计入通过）。

## 2. 构建

```
npm run build
```
→ `build/qrcode.js` 23,010 B、`build/qrcode.tosjis.js` 21,566 B。**成功**。

## 3. 上游测试基线

上游 `test.js` 在 Windows 上直接崩溃：它 `spawn('node', ['node_modules/.bin/tap', ...])`，
而 `node_modules/.bin/tap` 是 `#!/bin/sh` 脚本，被 node 当 JS 解析 → `SyntaxError: missing ) after argument list`。
另外上游依赖 `NODE_PATH=./;./lib` 的写法，Windows 下 `./` 无法解析（POSIX 路径符）。

为拿到可复现基线，新增 `test/run-tests.js`（不改动上游任何测试文件）：
规范化 `NODE_PATH` 为绝对路径，并用 `node node_modules/tap/bin/run.js` 调用。

```
node test/run-tests.js
```

| 结果 | 数量 |
|---|---|
| 测试文件总数 | 33 |
| 通过 | 28 |
| **失败** | **5** |
| SKIP（canvas 缺失） | 0 文件级 / 内部用例计入失败文件 |

失败文件与根因（均在改动前即存在，与本次改动无关）：

| 文件 | 根因 |
|---|---|
| `test/unit/renderer/canvas.test.js` | 需要 `canvas` 原生模块 |
| `test/e2e/toCanvas.test.js` | 同上 |
| `test/e2e/toDataURL.test.js` | 同上 |
| `test/e2e/toFile.test.js` | 同上（含 canvas 分支） |
| `test/e2e/toString.test.js` | `svgtag.expected.out` 在 Windows 检出为 CRLF，实际输出为 LF |

`git ls-files --eol` 显示 `i/lf w/crlf`：仓库内存 LF，工作区因 `core.autocrlf=true` 变 CRLF。
`solved` 方式：交付版加 `.gitattributes` 固定 `eol=lf`（见交付说明），不修改上游期望文件内容。

## 4. 生成产物可解码性（基线探针）

探针脚本：`.probe/exp1.js`（`QRCode.toBuffer` → `pngjs` 解码 → `jsQR` 识别）。

| 参数 | 像素 | jsQR |
|---|---|---|
| 默认（margin=4, scale=4） | 148×148 | PASS |
| margin=0 / 1 / 2 / 3 | 116 / 124 / 132 / 140 | PASS |
| 反色（dark=#fff, light=#000） | 148×148 | PASS |
| 低对比（#777 on #fff） | 148×148 | PASS |
| `width: 40` | 40×40 | **FAIL** |
| `width: 60` | 60×60 | PASS |

结论：上游**能**生成可扫产物，但没有任何机制告知调用方"这次生成的产物扫不出来"。
`width: 40` 静默产出一张 40×40 的图（29 模块 + 8 静区 = 37 单元被塞进 40 像素，模块宽 ≈1.08 px），
调用方拿到的 Buffer 完全合法，问题要到线下扫码才暴露。

## 5. 几何探针：模块宽度漂移

`PNG` 逐行扫描游程长度（`.probe/exp5.js`），统计同一行内不同游程长度：

| `width` 参数 | 实际像素 | 该行出现的游程长度集合 |
|---|---|---|
| 132 | 132 | 29, 4, 3, 7, 17, 18, 21 |
| 133 | 133 | 29, 4, 3, 8, 18, 7, 21 |
| 148 | 148 | 32, 4, 8, 20, 24 |
| 264 | 264 | 58, 7, 14, 8, 35, 15, 36, 42 |
| 265 | 265 | 58, 7, 14, 8, 36, 42 |

上游 `getScale()` 返回**浮点**比例（`width / (size + margin*2)`），
`qrToImageData()` 用 `Math.floor((i - margin) / scale)` 反查源模块 →
非整数缩放下同一行内不同模块被量化成 2~5 种像素宽度，且**随位置变化**。
这是几何层面的客观事实（模块不等宽），但**尚未证明它会单独导致解码失败**——
本项目的报告口径因此把它列为"几何警告"，而不是"扫不出来"。

## 6. 解码器分歧（决定是否需要双引擎）

| 场景 | jsQR | zxing |
|---|---|---|
| 基线 | PASS | PASS |
| blur 1.8（132 px） | PASS | **fail** |
| 旋转 3° / 5° / 8° / 12° | PASS | **fail** |
| 静区被侵占（margin=4，2 px 侵入） | fail | fail |
| margin=0 且无侵入 | PASS | PASS |
| 降采样到 52×52 | fail | fail |
| 亮度 0.6 / 1.8、线性对比 ± | PASS | PASS |

结论：两引擎在**边缘场景结论不一致**。若只用一个引擎，报告会把"某引擎可读"说成"可扫"。
因此设计上必须两个引擎都跑并显式标注分歧，而不是二选一。

## 7. 本次未能验证的部分（诚实记录）

- `canvas@2` 原生模块在本机不可安装 → `toCanvas`/`toDataURL` 相关 4 个测试文件无法执行。
  这些文件**均未被我改动**，改动前后状态一致。
- 真实手机摄像头未参与验证。所有"可扫"结论均来自软件解码器，语义为"至少一个独立解码器能读出原文"。
