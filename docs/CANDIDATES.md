# 三候选核实记录（2026-10-25）

核实方式：GitHub REST API（`repos` / `releases` / `commits` / `issues` / `contents`）+ 本地克隆后 grep 源码。
所有数值为核实时快照，不是宣传口径。

## 候选 A：`soldair/node-qrcode`

| 项 | 事实 |
|---|---|
| Star / Fork | 8,180 / 690 |
| 许可证 | MIT（`license` 文件全文在库，Copyright (c) 2012 Ryan Day） |
| 最近提交 | 2024-08-05（v1.5.4，即最新 release） |
| 提交总数 | 342 |
| 未关闭 issue | 126 |
| 周下载量 | 19,036,000（npm `qrcode`，2026-10-16 ~ 10-22） |
| 源码规模 | `lib/` + `bin/` + `helper/` = 3,180 行 |

关键事实（本地核实）：
- 能力只有**生成**：`lib/index.js → lib/server.js` 暴露 `create/toCanvas/toString/toDataURL/toBuffer/toFile/toFileStream`。
- `grep -rniE "decode|scannab|blur|contrast|robust"` 在 `lib/` 全量零命中（唯一命中是 `alignment-pattern.js` 的一句注释）。
- 没有任何代码在生成后会重新读回产物；`color.dark/light`、`margin`、`width` 三个直接影响可扫性的选项被**直接透传到渲染器**，README 只写一句 "dark color should always be darker than light"。
- 未关闭 issue 中与"产物质量"直接相关的：#375（无法加 logo）、#367（CSS 设宽高无效）、#390（CLI 参数失效）、#394/#362/#346（build 目录缺失）、#412（`getPenaltyN4` 在 50% 两侧不对称）。

## 候选 B：`nayuki/QR-Code-generator`

| 项 | 事实 |
|---|---|
| Star / Fork | 6,803 / 1,292 |
| 许可证 | **GitHub 未识别为任何 SPDX**（`license: null`），仓库根目录无 LICENSE 文件 |
| 最近提交 | 2026-08-31（活跃） |
| 最近 release | v1.8.0（2022-04-17） |
| 未关闭 issue | 13 |
| JS 源码 | `typescript-javascript/qrcodegen.ts` 单文件 41,022 字节 |

淘汰理由：**根目录没有 LICENSE 文件**。只有在各语言子目录的 Readme 里提到 MIT。
按本次任务"许可证是否允许计划中的源码复用和再发布"这一条，缺完整许可文本意味着再发布的法律依据不足——
这一点与工作区上次（fontkit）的淘汰理由一致，处理标准保持一致。另外它是"教学级实现 + 单文件库"，
没有测试目录、没有 renderer、没有 CI，二次开发的落点不在同一层次。

## 候选 C：`zxing-js/library`

| 项 | 事实 |
|---|---|
| Star / Fork | 2,942 / 582 |
| 许可证 | Apache-2.0 |
| 最近提交 | 2026-04-29（v0.23.0） |
| 未关闭 issue | 182 |
| 仓库体积 | 72,275 KB（含大量测试图片） |
| README 自述 | "The project is in maintenance mode... There is otherwise no active development or roadmap for this project. It is 'DIY'." |

淘汰理由：它本身是**解码**库，与候选 A 恰好互补，但作为"二创主体"不合适——
① 自述维护模式、无路线图；② 72 MB 仓库主要是 CV 测试语料，二次开发的改动面会被语料淹没；
③ 它的价值恰恰在于"作为独立解码器被调用"，把它当底座反而会破坏这种独立性（判定不中立）。

**结论：选定 A（`soldair/node-qrcode`）作为二创底座，C（`zxing-js/library`）作为解码器的第二意见来源之一。**
