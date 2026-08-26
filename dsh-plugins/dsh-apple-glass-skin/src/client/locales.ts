/**
 * Tech-Space settings-row copy. Keyed by the settings-row locale namespace;
 * the settings row translates through the locale plugin's merged dictionaries.
 */

/** Locale keys for the Tech-Space settings row. */
export type AppleSkinKey =
  | 'skin.title'
  | 'skin.default'
  | 'skin.defaultDesc'
  | 'skin.light'
  | 'skin.lightDesc'
  | 'skin.dark'
  | 'skin.darkDesc'
  | 'skin.matrix'
  | 'skin.matrixDesc'
  | 'scene.title'
  | 'scene.space'
  | 'scene.spaceDesc'
  | 'scene.city'
  | 'scene.cityDesc'
  | 'scene.ocean'
  | 'scene.oceanDesc'
  | 'scene.matrix'
  | 'scene.matrixDesc'

/** Simplified Chinese copy. */
export const zh: Record<AppleSkinKey, string> = {
  'skin.title': '深空科技皮肤',
  'skin.default': '跟随系统',
  'skin.defaultDesc': '使用 DSH 内置外观',
  'skin.light': '科技浅色',
  'skin.lightDesc': '冷白网格 · 科技蓝描边',
  'skin.dark': '深空科技蓝',
  'skin.darkDesc': '深蓝黑底 · 霓虹光晕 · 科技背景',
  'skin.matrix': '黑客帝国',
  'skin.matrixDesc': '0/1 数字雨 · 霓虹绿',
  'scene.title': '背景场景',
  'scene.space': '宇宙深空',
  'scene.spaceDesc': '星云 · 星球 · 流星',
  'scene.city': '赛博城市',
  'scene.cityDesc': '天际线 · 霓虹 · 雨夜',
  'scene.ocean': '海底世界',
  'scene.oceanDesc': '光柱 · 鲸鱼 · 气泡',
  'scene.matrix': '数字矩阵',
  'scene.matrixDesc': '0/1 数字雨 · 霓虹绿',
}

/** English copy. */
export const en: Record<AppleSkinKey, string> = {
  'skin.title': 'Tech-Space skin',
  'skin.default': 'Follow system',
  'skin.defaultDesc': 'Use the built-in DSH appearance',
  'skin.light': 'Tech light',
  'skin.lightDesc': 'Cool white grid · tech-blue accents',
  'skin.dark': 'Deep-space blue',
  'skin.darkDesc': 'Deep blue-black · neon glow · tech backdrop',
  'skin.matrix': 'Matrix',
  'skin.matrixDesc': '0/1 digital rain · neon green',
  'scene.title': 'Backdrop scene',
  'scene.space': 'Deep space',
  'scene.spaceDesc': 'Nebula · planet · meteors',
  'scene.city': 'Cyber city',
  'scene.cityDesc': 'Skyline · neon · rain',
  'scene.ocean': 'Underwater',
  'scene.oceanDesc': 'Light shafts · whale · bubbles',
  'scene.matrix': 'Digital matrix',
  'scene.matrixDesc': '0/1 digital rain · neon green',
}
