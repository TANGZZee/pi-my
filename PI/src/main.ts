// main.ts — Svelte 5 mount API
import './app.css'
import { mount } from 'svelte'
import App from './App.svelte'
import { initLocaleFromPrefs } from './i18n'

// 2-11：语言偏好要在组件渲染前生效
initLocaleFromPrefs()

mount(App, { target: document.getElementById('app')! })
