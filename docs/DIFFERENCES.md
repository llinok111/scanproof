# 与原项目的差异（ScanProof vs node-qrcode 1.5.4）

> 一句话：**上游回答"怎么生成"，本层回答"生成的能不能扫"。**
> 上游代码零改动（除 `package.json` 元数据与 `.gitattributes`），新增能力全部是叠加。

## 1. 能力差异

| 维度 | node-qrcode 1.5.4 | ScanProof 2.0.0 |
|---|---|---|
| 核心能力 | 生成二维码（PNG/SVG/UTF8/Terminal） | 生成 + **验收** |
| 产物是否被回读 | **从不**。`grep -rniE "decode\|scannab\|blur\|contrast"` 在 `lib/` 零命中 | 每个产物都被两个独立解码器回读 |
| 参数错误的反馈 | 只有"数据放不下"这一类硬错误；`width:40` 静默产出 40×40 图 | 9 条闸门 + 8 个退化场景，逐条给现象与修法 |
| 静区 | `margin` 默认 4，不检查 | 检查（<4 判 error），并给出像素级侵占比例 |
| 对比度 | README 一句 "dark color should always be darker than light" | WCAG 3:1 硬门槛 + 极性检测 |
| 模块尺寸 | 无下限 | <2px 判 error，并算出需要的 `scale` |
| 修复建议 | 无 | `suggest` 生成补丁 → **实际重跑验收** → 只保留结论严格变好的 |
| 已有图片验收 | 无 | `--file` / `auditBuffer`（从像素反推静区、模块尺寸、极性） |
| CI 可用性 | 无退出码契约 | 0/1/2/3 四档退出码，语义明确 |
| 浏览器内验收 | 无 | `demo/` 演示页，与 CLI 同一套代码（打包为 577 KiB） |
| 测试 | 33 个文件（canvas 相关 3 个在 Windows 不可跑） | 上游 33 + **新增 8 个文件 / 408 条断言** |

## 2. 代码差异

### 新增（全部为新文件，不碰上游逻辑）

| 路径 | 行数 | 职责 |
|---|---|---|
| `lib/scanproof/geometry.js` | 125 | 几何计算（与渲染器同源，`renderRGBA` 与官方 PNG 渲染器**逐字节一致**，有测试锁定） |
| `lib/scanproof/gates.js` | 179 | 9 条规范闸门，每条带 ISO/WCAG 依据 |
| `lib/scanproof/decoder.js` | 197 | 双解码器集成（jsQR + ZXing），含参数校验与日志静音 |
| `lib/scanproof/variants.js` | 249 | 8 个确定性退化变换 |
| `lib/scanproof/report.js` | 286 | 报告合成 + Markdown 渲染 |
| `lib/scanproof/suggest.js` | 126 | 修复建议（累积补丁 + 逐个验证） |
| `lib/scanproof/buffer.js` | 216 | 已有 PNG 的像素级验收 |
| `lib/scanproof/index.js` | 31 | 公共 API |
| `lib/scanproof/version.js` | 13 | 版本常量（有测试锁死与 package.json 一致） |
| `bin/qr-scanproof` | 148 | CLI，四档退出码 |
| `scripts/measure.js` | 125 | 度量脚本（事实矩阵 + 中位耗时） |
| `scripts/build-demo.js` | 54 | 演示页打包 |
| `scripts/verify-demo.mjs` | 274 | 真实浏览器验收（13 项断言） |
| `demo/index.html` + `demo/app.js` | 420 | 演示页 |
| `test/scanproof/*.test.js` | 8 文件 / 889 行 | 408 条断言 |
| `test/run-tests.js` | 18 | Windows 下可跑的上游测试入口（修 `node_modules/.bin/tap` 的 sh 脚本问题） |

合计新增源码 **3,617 行**（2,728 行代码 + 889 行测试，不含 `docs/`）。

### 改动（仅元数据与工程配置）

| 文件 | 改动 | 理由 |
|---|---|---|
| `package.json` | 改名 `scanproof`、版本 2.0.0、加 `bin.qr-scanproof`、解码器移入 `optionalDependencies`、加分段测试脚本 | 不改名会占用 `qrcode` 这个 registry 名字，属于越界 |
| `.gitattributes` | 新增，只对 `test/e2e/*.expected.out` 与新文件固定 `eol=lf` | 修 Windows 下 3 个 e2e 测试的假失败（见 BASELINE.md §3） |
| `NOTICE` | 新增 | 声明衍生关系、第三方解码器、商标归属 |
| `docs/*.md` | 新增 5 份 | 候选核实 / 基线 / 证据 / 边界 / 变体 |

**上游 `lib/core/` 与 `lib/renderer/` 一行未改**。这是可核查的事实，不是声明：
`git log --oneline -- lib/core lib/renderer` 在本仓库里只会看到上游提交。

## 3. 判定逻辑差异（最关键的一条）

上游没有判定。本层的判定遵循一条原则：**规范违规与"读不出"是两件事，分别判定，不互相掩盖。**

举例：`margin: 0` 的产物在 jsQR 和 ZXing 下**都能读出**。若只看解码结果，这份产物会"通过"。
但它违反 ISO/IEC 18004 的静区要求——贴到任何深色背景上就会失效。
所以 `quiet-zone` 是 `error` 级，`verdict = fail`，即便解码器说能读。

反过来：`width: 100` 的产物有非整数缩放（warning）和静区被压（warning），但**没有规范硬性违规**，
所以 `verdict = warn`，而不是 fail。报告里逐条写清"是几何事实，尚未证明会导致失败"。

这条分界线的意义：**把"能不能读"和"该不该上线"分开**。前者是解码器的事，后者是工程判断。

补充一条关于解码器本身的实测结论：两个引擎在 252 个退化场景里有 27 个（10.7%）结论不一致，
且分歧是**双向**的——噪点/模糊上 jsQR 更强，低照度与部分旋转上 ZXing 更强
（数据见 docs/EVIDENCE.md G4）。所以"选一个更强的引擎"这个思路不成立，
必须并列报告 + 单引擎可读降级为 warn。

## 4. 不做的差异（明确不越界）

| 不做 | 理由 |
|---|---|
| 不改生成算法（分段、掩码、纠错） | 那是上游的领域，改了就变成 fork，且会破坏 `compat.test.js` 的逐字节锁定 |
| 不加 logo / 美化 / 圆角 | issue #375 有人要，但那是"生成"侧需求，与本层定位冲突 |
| 不修上游的 CLI / build 问题（#390/#394/#362） | 那些是上游 issue，本项目只在自己的路径上绕开（`test/run-tests.js`），不改上游文件 |
| 不做 GS1 / Micro QR / Structured Append | 上游不支持，本层不越界补 |
| 不改默认行为 | 所有新能力都是 `require('scanproof/lib/scanproof')` 或 `qr-scanproof` CLI 显式调用；`require('scanproof')` 仍是原来的 `qrcode` API |

## 5. 性能差异（实测，非估算）

| 操作 | 中位耗时（5 次 × 7 轮，Node 22 / Windows，zxing 0.21.3） |
|---|---|
| 上游生成 PNG（`toBuffer`） | 3 ms |
| 完整验收（9 闸门 + 双解码 + 8 变体） | **126–320 ms**（空载 131，并行跑其他任务时 320） |
| 验收跳过变体 | 14–17 ms |
| 验收跳过解码 | 1 ms |

**不要把 241→131 读成优化**：这是把 `@zxing/library` 从 0.23.0 降到 0.21.3 带来的依赖差异
（0.23.0 要求 node>=24，在 Node 22 上装不上）。本项目没有做任何解码性能改动。

验收成本约是生成本身的 80 倍。这不是缺陷，是"回读 + 退化扫描"的固有代价：
8 个变体 × 2 个解码器 = 16 次解码，每次解码要在 148×148 像素上做定位图案搜索。
因此 CLI 提供 `--no-variants`（28ms）与 `--no-decode`（1ms）两档降级，供 CI 按需选择。

**注意**：只报中位数与区间，不报单次值。实测单次计时在同一负载下能差 2 倍以上，
单点采样得出的"快/慢"结论不可靠。
