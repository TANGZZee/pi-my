/** 皮肤 = 完整色板（表面/文字/边框/主色），再叠加浅色/深色。扩展：这里加一条 + app.css [data-appearance] 覆盖即可。 */
export type SkinId = 'graphite' | 'moss' | 'sea' | 'paper' | 'ink' | 'glass'

export type SkinPreset = {
  id: SkinId
  label: string
  desc: string
  /** 选色器里的预览色块 */
  preview: { bg: string; sidebar: string; panel: string; accent: string; border: string }
}

export const SKINS: readonly SkinPreset[] = [
  {
    id: 'graphite',
    label: '石墨',
    desc: '出厂灰阶，干净克制',
    preview: { bg: '#f4f4f4', sidebar: '#f2f2f2', panel: '#fafafa', accent: '#171717', border: '#d9d9d9' }
  },
  {
    id: 'moss',
    label: '苔原',
    desc: '纸感浅绿 + 鼠尾草主色',
    preview: { bg: '#f3f5ef', sidebar: '#eef2ea', panel: '#f8faf6', accent: '#4a7854', border: '#c8d0bf' }
  },
  {
    id: 'sea',
    label: '海雾',
    desc: '冷灰蓝表面 + 靛蓝强调',
    preview: { bg: '#eef5fb', sidebar: '#e8f1f8', panel: '#f6fafd', accent: '#2563eb', border: '#cddbe6' }
  },
  {
    id: 'paper',
    label: '宣纸',
    desc: '暖米色 + 琥珀强调',
    preview: { bg: '#f7f2ea', sidebar: '#f2ebdf', panel: '#fcf9f4', accent: '#b45309', border: '#ded2bf' }
  },
  {
    id: 'ink',
    label: '夜墨',
    desc: '高对比深色墨底',
    preview: { bg: '#121212', sidebar: '#171717', panel: '#1c1c1c', accent: '#e8e8e8', border: '#333333' }
  },
  {
    id: 'glass',
    label: '液态玻璃',
    desc: '半透明毛玻璃层叠，随浅色/深色切换',
    preview: { bg: '#e8f0f8', sidebar: '#dde9f3', panel: '#f4f9fd', accent: '#2563eb', border: '#c2d4e4' }
  }
]
