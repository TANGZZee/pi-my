// 静态资源与 Vite 专属导入的类型声明
//
// Vite 允许 `import logo from './assets/x.png'`，但 TypeScript 不知道这是合法模块，
// svelte-check 会报 "Cannot find module './assets/pi-my-logo.png'"。
// 这里补上声明，让类型检查能覆盖到组件里的资源引用。

declare module '*.png' {
  const src: string
  export default src
}
declare module '*.jpg' {
  const src: string
  export default src
}
declare module '*.jpeg' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
declare module '*.webp' {
  const src: string
  export default src
}
declare module '*.gif' {
  const src: string
  export default src
}
declare module '*.json' {
  const value: unknown
  export default value
}

/** Vite 注入的环境变量（本轮只用到极少字段） */
interface ImportMetaEnv {
  readonly DEV: boolean
  readonly PROD: boolean
  readonly MODE: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
