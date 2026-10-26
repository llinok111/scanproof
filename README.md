# ScanProof

**在生成二维码之后，回答"这份产物真的能扫吗"。**

[![CI](https://github.com/llinok111/scanproof/actions/workflows/ci.yml/badge.svg)](https://github.com/llinok111/scanproof/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](license)

ScanProof 是 [node-qrcode](https://github.com/soldair/node-qrcode)（MIT，8.2k★，周下载 1,900 万）的**验收层**：
生成引擎原样保留，新增一层对产物做可扫性验收——几何闸门、双解码器回读、退化场景扫描、以及经实测验证的修复建议。

> 上游生成 API 的完整文档保留在 [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md)（未删改）。

---

## 它解决什么问题

上游 `node-qrcode` 只负责生成，**从不回读自己的产物**：

```bash
$ grep -rniE "decode|scannab|blur|contrast|robust" node_modules/qrcode/lib/
lib/core/alignment-pattern.js:3:  * in a matrix symbology, which enables the decode software to re-synchronise
```

唯一一处命中是注释。这意味着下面这类调用会**静默产出不可扫的图**：

```js
// 37 个单元被塞进 40 像素 → 每模块 1.08px → 两个解码器都读不出
await QRCode.toFile('bad.png', 'https://example.com/order/12345', { width: 40 })
// 返回的 Buffer 完全合法，问题要到线下扫码才暴露
```

```js
// 静区 0 → 违反 ISO/IEC 18004 §6.3.8。贴在深色卡片上必然失效。
await QRCode.toFile('bad2.png', text, { margin: 0 })
// 但它自己扫码器反而读得出（浅色背景上），于是更难被发现
```

ScanProof 把这些变成可测量的结论：

```bash
$ npx qr-scanproof "https://example.com/order/12345" --margin 0
```
```
# ScanProof 报告

**结论：❌ FAIL**

| 项 | 值 |
| --- | --- |
| 版本 / 纠错 | v3 / M |
| 静区 | 0 模块 / 0 px |
| 单模块 | 4 px（整数比例） |
| 解码 | read-by-both（jsqr=read, zxing=read） |

## 发现的问题

- **错误** `quiet-zone` — 静区不足 4 模块
  - 依据：ISO/IEC 18004:2015 §6.3.8
  - 现象：当前静区 0 个模块，规范要求至少 4 个
  - 建议：把 margin 提高到 4（默认值即为 4）
```

注意 `解码 = read-by-both` 却仍然判 **FAIL**：能读出 ≠ 该上线。这是本工具最核心的设计取舍（见 [docs/DIFFERENCES.md §3](docs/DIFFERENCES.md)）。

---

## 安装与运行

```bash
git clone https://github.com/llinok111/scanproof.git
cd scanproof
npm install          # 若 canvas 编译失败，用 npm install --ignore-scripts
npm test             # 上游回归 + 新增测试
npm run build        # 库分发 + 演示页打包
npm run measure      # 事实矩阵与耗时（实测输出，非估算）
```

**解码器是可选依赖**（`jsqr` / `@zxing/library`）。装不上时验收仍能跑，只是把结论标成 `inconclusive`，
绝不会把"没测"算成"通过"。

> `@zxing/library` 锁在 `^0.21.3`：0.22.0 起要求 `node >= 24`，npm 会**静默跳过**不满足的可选依赖
> ——不报错、不警告，双解码器会悄悄退化成单解码器。这个坑只在 `npm ci` 干净环境里暴露
> （见 [docs/LIMITS.md](docs/LIMITS.md)）。

---

## 用法

### CLI

```bash
# 验收一组参数（默认跑全部 8 个退化场景）
npx qr-scanproof "https://example.com"

# 给出修复建议（每条建议都会重新跑一遍验收，只保留结论严格变好的）
npx qr-scanproof "https://example.com" --margin 0 --suggest

# 按建议直接生成可用产物
npx qr-scanproof "https://example.com" --margin 0 --suggest --write fixed.png

# 验收一张已有的 PNG（从像素反推静区/模块尺寸/极性）
npx qr-scanproof --file design-export.png

# 机器可读
npx qr-scanproof "https://example.com" --json
```

**退出码契约**（可直接用于 CI）：

| 码 | 含义 |
|---|---|
| 0 | 通过 |
| 1 | 警告（能扫，但存在风险） |
| 2 | 失败（读不出 / 违反规范硬性要求） |
| 3 | 不确定（解码器不可用，未验证） |

```yaml
# 在 CI 里拦住不可扫的产物
- run: npx qr-scanproof "$(cat qr-payload.txt)" --no-variants
```

### 库

```js
const { audit, applySuggestions } = require('scanproof/lib/scanproof')

const report = await audit('https://example.com', { errorCorrectionLevel: 'M' })
if (report.verdict !== 'pass') {
  for (const g of report.gates) {
    console.log(`[${g.severity}] ${g.id}: ${g.detail}`)
    console.log(`  → ${g.fix}`)
  }
}

// 自动修：只在结论严格变好时采纳，每条都会重新验收
const { options, report: after } = await applySuggestions('https://example.com', { margin: 0 })
```

`require('scanproof')` 仍然是原来的 `qrcode` API —— 默认行为零改动（有逐字节测试锁定）。

### 浏览器

`demo/index.html` 是独立可跑的演示页（打包后 577 KiB，全部计算在本地，不上传任何内容）。
它和 CLI 跑的是同一套 `lib/scanproof` 代码。

---

## 报告长什么样

```jsonc
{
  "schema": "scanproof/report@1",
  "verdict": "warn",
  "geometry": {
    "version": 3, "errorCorrectionLevel": "M",
    "modulesPerSide": 29, "totalModules": 37,
    "modulePx": 2.703, "pixels": 100,
    "integerScale": false, "polarity": "normal"
  },
  "contrast": 21,
  "quietZoneForeignRatio": 0.0222,
  "gates": [
    { "id": "integer-scale", "severity": "warning",
      "detail": "scale=2.703（100px / 37 模块），模块宽度会漂移",
      "fix": "改用整数比例：width=111（scale=3）" }
  ],
  "decode": {
    "consensus": "read-by-both",
    "decoders": { "jsqr": { "verdict": "read" }, "zxing": { "verdict": "read" } }
  },
  "variants": [ { "id": "blur-1px", "verdict": "read-by-both" } ],
  "warnings": []
}
```

报告是**确定性**的：同一输入两次生成的 JSON 逐字节相同（有测试断言）。
耗时这类环境相关值默认不进报告，只有显式 `withTiming` 才带。

---

## 九条闸门

| id | 级别 | 依据 | 检查什么 |
|---|---|---|---|
| `quiet-zone` | error | ISO/IEC 18004:2015 §6.3.8 | 静区 < 4 模块 |
| `module-pixels` | error | 实测下限（[EVIDENCE G1](docs/EVIDENCE.md)） | 每模块 < 2px |
| `contrast` | error | WCAG 2.1 SC 1.4.11（3:1） | 前景/背景对比度 |
| `polarity` | warning | 实测（[EVIDENCE G5](docs/EVIDENCE.md)） | 深色比浅色更亮（反色） |
| `integer-scale` | warning | 像素游程实测（[EVIDENCE G2](docs/EVIDENCE.md)） | 缩放比例非整数 |
| `occlusion` | warning | 像素统计 | 模块被四舍五入挤进静区 |
| `opaque-background` | info | — | 背景透明（深色 UI 上会变反色） |
| `error-correction` | info | 经验 | 纠错等级 L |
| `module-oversize` | info | — | 单模块 > 20px（体积浪费） |

每条闸门都带 `ref`（依据）与 `fix`（可执行的修法），不写"建议优化"这类空话。

---

## 双解码器

用两个**独立实现**回读，而不是一个：

- [jsQR](https://github.com/cozmo/jsqr)（Apache-2.0）
- [@zxing/library](https://github.com/zxing-js/library)（Apache-2.0）

这不是为了"更保险"，而是实测发现两者**结论会分歧**：252 个场景（3 文本 × 3 尺寸 × 28 退化档位）里
**27 个（10.7%）两引擎结论不一致**，且分歧是**双向的**：

| 场景 | jsQR | ZXing |
|---|---|---|
| 2px 模糊（116px） | pass | **fail** |
| 1% 噪点（116px） | pass | **fail** |
| 低照度 ×0.3（116px） | **fail** | pass |
| 低照度 ×0.3（148px） | **fail** | pass |
| 旋转 2°（60px） | pass | **fail** |
| 旋转 6°（161px） | **fail** | pass |

在噪点/模糊上 jsQR 更强，在低照度与部分旋转上 ZXing 更强——换任何一个单引擎，
都会在约一半的分歧场景里给出错误结论。所以报告里两个结论**并列**，
`read-by-one` 一律降级为 `warn`（详见 [docs/EVIDENCE.md G4](docs/EVIDENCE.md)）。

---

## 退化场景

8 个纯 JS、确定性、无随机数的像素级变换（[docs/VARIANTS.md](docs/VARIANTS.md)）：

降采样 ×2 / 降采样 ×3（边界）/ 1px 模糊 / 旋转 5° / 旋转 15° / 低照度 / 镜面高光（边界）/ 印刷噪点。

**为什么不用 sharp**：它的 resize/blur 结果依赖 VIPS 版本，跨平台可能差几像素，
会让报告不可复现。代价是慢一点（完整 8 个变体约 210ms），换来"任何装了 Node 的机器上结论一致"。

---

## 实测数字

以下为 `npm run measure` 的真实输出（Node 22 / Windows 10.0.26300）：

| 用例 | 结论 | 解码 | 模块 px | 闸门 |
|---|---|---|---|---|
| 默认参数 | pass | read-by-both | 4.000 | — |
| margin=0 | fail | read-by-both | 4.000 | error:quiet-zone |
| width=100 | warn | read-by-both | 2.703 | warning:integer-scale, warning:occlusion |
| width=111 | pass | read-by-both | 3.000 | — |
| width=40（EC=M） | fail | no-read-by-any | 1.081 | error:module-pixels + 6 变体失败 |
| width=40（EC=H） | pass | read-by-both | 4.000 | — |
| 反色 | fail | no-read-by-any | 4.000 | warning:polarity（`attemptBoth` 后可读） |
| 低对比 #bbb/#fff | fail | no-read-by-any | 4.000 | error:contrast（1.92:1） |
| 长文本 v10+ | pass | read-by-both | 4.000 | — |

**成本**（每个配置 5 次取中位数，重复 7 轮；`@zxing/library` 0.21.3）：

| 操作 | 中位耗时 |
|---|---|
| 上游生成 PNG | 3 ms |
| 完整验收（9 闸门 + 双解码 + 8 变体） | **126–320 ms**（7 轮中 6 轮落在 126–145） |
| 跳过变体 | 14–17 ms |
| 跳过解码 | 1 ms |

区间不是"测量误差"，是**真实的负载敏感性**：本机空载 131 ms，同机并行跑其他任务时出现 320 ms
（2.4 倍差距）。因此只报中位数与区间，不报单次值——单次计时在同负载下都能得出相反结论。

注：早期版本用 `@zxing/library@0.23.0`，同机测得 241–533 ms。降到 0.21.3 后明显更快，
这是**依赖版本差异**而不是本项目的优化，如实标注以免误读为性能改进。

---

## 测试

```bash
npm test               # 全部（上游 + 新增）
npm run test:upstream  # 只跑上游回归
npm run test:scanproof # 只跑新增
npm run verify:demo    # 真实浏览器验收演示页（13 项功能断言）
npm run probe:layout   # 布局探针（9 项：区块尺寸/重叠/溢出/WCAG 对比度/移动端）
npm run decoders:agreement  # 双解码器分歧搜索（docs/EVIDENCE.md G4 的依据）
npm run decoders:parity -- --baseline . --compare <dir>  # 解码器版本对照
```

当前状态（本机实测）：

| 范围 | 文件 | 通过 | 失败 | 说明 |
|---|---|---|---|---|
| 上游 unit + e2e | 33 | 30 | 3 | 3 个失败均因 `canvas@2` 原生模块在本机装不上（**改动前基线即如此**，见 [docs/BASELINE.md §3](docs/BASELINE.md)） |
| 新增 scanproof | 8 | 8 | 0 | 367 条断言 |
| 浏览器演示页 | — | 13 + 9 | 0 | 13 项功能断言（含 canvas 像素统计、截图非白屏）+ 9 项布局断言（含 WCAG 对比度、无重叠、移动端单列） |

新增测试覆盖的重点不是"代码有没有跑"，而是：

- **确定性**：同一输入两次报告逐字节相同；每个变体两次变换逐字节相同
- **零侵入**：`audit` 调用前后上游 SVG 输出逐字节相同；`renderRGBA` 与官方 PNG 渲染器逐像素相同
- **诚实降级**：解码器不可用时 verdict 必须是 `inconclusive`，不能是 `pass`
- **失败可读**：缺文件 / 非 PNG / 尺寸非法都给出可读错误，且 `decodeBoth` 拒绝静默吞掉调用方的 bug
- **打包一致**：`lib/scanproof/version.js` 必须等于 `package.json` version；解码器必须在 `optionalDependencies`

---

## 已知限制

完整清单见 **[docs/LIMITS.md](docs/LIMITS.md)**。最重要的四条：

1. **没有真机验证**。"可扫"的语义是"至少一个独立解码器能读出原文"，不是"你的手机一定扫得出"。
2. **退化场景不是物理仿真**。盒式模糊 ≠ 镜头失焦，圆形高光 ≠ 真实反光。
3. **`--file` 路径无法反推纠错等级**。纠错等级不体现在可见模块上，报告会显式标 `unknown`，不猜。
4. **不做 GS1 / Micro QR / Structured Append**。上游不支持，本层不越界。

另外：`canvas@2` 原生模块在本机装不上，因此 `toCanvas` / `toDataURL` 路径的产物未纳入验收。

---

## 与原项目的差异

详见 **[docs/DIFFERENCES.md](docs/DIFFERENCES.md)**。一句话概括：

> 上游 `lib/core/` 与 `lib/renderer/` **一行未改**（可用 `git log -- lib/core` 核查），
> 新增 3,617 行验收层；判定原则是"规范违规"与"读不出"分别判定，不互相掩盖。

---

## 许可证与来源

- 本仓库是 [node-qrcode](https://github.com/soldair/node-qrcode) 的衍生作品，沿用 **MIT**。
  上游版权声明保留在 [`license`](license)，衍生关系与第三方组件声明在 [`NOTICE`](NOTICE)。
- 第三方解码器 jsQR / @zxing/library 均为 **Apache-2.0**，作为**可选依赖**在运行时加载，不打包进本仓库代码。
- "QR Code" 是 DENSO WAVE INCORPORATED 的注册商标。本项目与该公司无关联。
- ScanProof 的判定是作者的启发式工程实践，**不是** ISO/IEC 18004 的一致性测试套件。

---

## 相关文档

| 文件 | 内容 |
|---|---|
| [docs/CANDIDATES.md](docs/CANDIDATES.md) | 三个候选仓库的核实记录与淘汰理由 |
| [docs/BASELINE.md](docs/BASELINE.md) | 改动前的可复现基线（测试、构建、可解码性） |
| [docs/EVIDENCE.md](docs/EVIDENCE.md) | 每个阈值的实验来源与原始数字 |
| [docs/LIMITS.md](docs/LIMITS.md) | 能力边界、不能反推的信息、已知误判 |
| [docs/VARIANTS.md](docs/VARIANTS.md) | 8 个退化场景的理由与阈值 |
| [docs/DIFFERENCES.md](docs/DIFFERENCES.md) | 与原项目的逐项差异 |
| [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md) | 上游 node-qrcode 的原始 API 文档（未删改） |
| [docs/UPSTREAM-README.md](docs/UPSTREAM-README.md) | 上游 node-qrcode 的原始 API 文档 |
