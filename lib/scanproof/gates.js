'use strict'

/**
 * 规范闸门（spec gates）
 *
 * 每条闸门只回答一个客观问题，并给出 ISO/IEC 18004 / WCAG 的可追溯依据。
 * 严重度：
 *   error   —— 规范硬性要求被违反，或产物客观上不可读
 *   warning —— 规范允许但存在实证风险（有实验支撑，见 docs/EVIDENCE.md）
 *   info    —— 仅提示，不影响可扫性
 */

const S = require('./geometry')

const GATES = [
  {
    id: 'quiet-zone',
    severity: 'error',
    title: '静区不足 4 模块',
    ref: 'ISO/IEC 18004:2015 §6.3.8',
    check (g) {
      if (g.quietZoneModules >= S.QUIET_ZONE_MODULES) return null
      return {
        detail: `当前静区 ${g.quietZoneModules} 个模块，规范要求至少 ${S.QUIET_ZONE_MODULES} 个`,
        fix: `把 margin 提高到 ${S.QUIET_ZONE_MODULES}（默认值即为 4）`
      }
    }
  },
  {
    id: 'module-pixels',
    severity: 'error',
    title: '模块像素过小，采样不可靠',
    ref: '经验下限（见 docs/EVIDENCE.md 实验 G1）',
    check (g) {
      if (g.modulePx >= S.MIN_MODULE_PIXELS - 1e-9) return null
      return {
        detail: `当前每个模块只有 ${fmt(g.modulePx)} px，低于 ${S.MIN_MODULE_PIXELS} px 下限`,
        fix: `把 width 提高到至少 ${Math.ceil(g.totalModules * S.MIN_MODULE_PIXELS)}，或提高 scale`
      }
    }
  },
  {
    id: 'contrast',
    severity: 'error',
    title: '前景/背景对比度不足',
    ref: 'WCAG 2.1 SC 1.4.11 非文本对比度下限 3:1',
    check (g, ctx) {
      const ratio = S.contrastRatio(g.color.dark, g.color.light)
      ctx._contrast = ratio
      if (ratio >= 3) return null
      return {
        detail: `深色 ${g.color.dark} 与浅色 ${g.color.light} 对比度 ${ratio.toFixed(2)}:1，低于 3:1`,
        fix: '加深深色或提亮浅色；如需保持品牌色，至少把深色压到相对亮度 ≤ 0.15'
      }
    }
  },
  {
    id: 'polarity',
    severity: 'warning',
    title: '极性反了（浅色模块、深色背景）',
    ref: '多数扫描器默认按深底浅，反色需要额外尝试（jsQR 的 inversionAttempts 会多花约 50% 时间）',
    check (g) {
      const darkLum = S.relativeLuminanceForGate(g.color.dark)
      const lightLum = S.relativeLuminanceForGate(g.color.light)
      if (darkLum < lightLum) return null
      return {
        detail: `color.dark=${g.color.dark} 比 color.light=${g.color.light} 更亮，产物为反色`,
        fix: '若必须反色（深色主题），请确保扫码端支持反色检测；本报告会用 inversionAttempts=attemptBoth 复测一次'
      }
    }
  },
  {
    id: 'integer-scale',
    severity: 'warning',
    title: '缩放比例不是整数，模块宽度不均',
    ref: '实证：非整数缩放下同一行模块被量化成 2~5 种像素宽度（docs/EVIDENCE.md 实验 G2）',
    check (g) {
      if (g.integerScale) return null
      const nearest = Math.round(g.scale)
      return {
        detail: `scale=${fmt(g.scale)}（${g.pixels}px / ${g.totalModules} 模块），模块宽度会漂移`,
        fix: `改用整数比例：width=${g.totalModules * nearest}（scale=${nearest}）`
      }
    }
  },
  {
    id: 'occlusion',
    severity: 'warning',
    title: '静区被符号内容侵入（非整数缩放导致模块压到留白里）',
    ref: '静区必须与周围背景保持同色、无图形；正常参数下此比值为 0',
    check (g, ctx) {
      const r = ctx.rgba
      const w = ctx.width
      const h = ctx.height
      const quiet = Math.round(g.quietZonePx)
      if (quiet <= 0) return null
      const bg = g.palette.light
      let foreign = 0
      let total = 0

      const scan = (i) => {
        total++
        const p = i * 4
        // 静区里除了"背景色"以外的任何不透明像素都算侵占
        const opaque = r[p + 3] > 8
        const isBackground = Math.abs(r[p] - bg.r) <= 8 &&
          Math.abs(r[p + 1] - bg.g) <= 8 &&
          Math.abs(r[p + 2] - bg.b) <= 8
        if (opaque && !isBackground) foreign++
      }

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const inQuiet = x < quiet || y < quiet || x >= w - quiet || y >= h - quiet
          if (!inQuiet) continue
          scan(y * w + x)
        }
      }
      const ratio = total ? foreign / total : 0
      if (ctx._shared) ctx._shared._quietZoneForeignRatio = ratio
      // 反色情况下静区底色是 dark，静区"同色"即 shadow 像素；本闸门只在正常极性下判定
      const darkLum = S.relativeLuminanceForGate(g.color.dark)
      const lightLum = S.relativeLuminanceForGate(g.color.light)
      if (darkLum >= lightLum) return null
      if (ratio < 0.001) return null
      return {
        detail: `静区内有 ${(ratio * 100).toFixed(2)}% 的像素不是背景色（模块被四舍五入挤进了留白）`,
        fix: '改用整数 scale（本报告 integer-scale 一项给出具体取值），即可让静区回到纯净背景'
      }
    }
  },
  {
    id: 'opaque-background',
    severity: 'info',
    title: '背景是透明的（light alpha < 255）',
    ref: '静区需要与背景一致；透明背景在深色 UI 上会变成深底浅码',
    check (g) {
      if (g.color.lightAlpha === 255) return null
      return {
        detail: `color.light 的 alpha = ${g.color.lightAlpha}，导出 PNG 后背景透明`,
        fix: '若要在深色页面上使用，显式指定 color.light（例如 #ffffff）'
      }
    }
  },
  {
    id: 'error-correction',
    severity: 'info',
    title: '纠错等级偏低',
    ref: 'ISO/IEC 18004:2015 附录；L≈7% / M≈15% / Q≈25% / H≈30%',
    check (g) {
      if (g.errorCorrectionLevel === 'L') {
        return {
          detail: '纠错等级 L（约 7% 容错），稍有污损即失效',
          fix: '室外、小尺寸或会加 logo 的场景建议 Q 或 H'
        }
      }
      return null
    }
  },
  {
    id: 'module-oversize',
    severity: 'info',
    title: '单模块像素远超需要',
    ref: '仅影响体积，不影响可扫性',
    check (g) {
      if (g.modulePx <= S.MAX_MODULE_PIXELS) return null
      return {
        detail: `每个模块 ${fmt(g.modulePx)} px（>${S.MAX_MODULE_PIXELS}），位图体积偏大`,
        fix: '改用 SVG（矢量）或降低 scale'
      }
    }
  }
]

function fmt (n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

module.exports = { GATES, fmt }
