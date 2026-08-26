/**
 * Skin row slot store: a mirror of the theme service preference plus the
 * plugin's backdrop scene choice. The plugin's apply-world change listener
 * is the only writer; the row component reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { BackdropScene } from './skins.ts'

/** Store state mirrored from the theme snapshot. */
export interface SkinRowState {
  /** Persisted preference (selection state reads this, never the resolved active theme). */
  skin: string
  /** Backdrop scene theme (space / city / ocean). */
  scene: BackdropScene
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type SkinRowActions = {
  sync: (draft: SkinRowState, skin: string, scene: BackdropScene, revision: number) => void
}

/**
 * Declares the skin row state and write surface.
 * @returns the store handle.
 */
export function createSkinStore(): EngineStoreHandle<SkinRowState, SkinRowActions> {
  return defineStore({
    init: (): SkinRowState => ({ skin: 'system', scene: 'space', revision: -1 }),
    actions: {
      sync: (d, skin: string, scene: BackdropScene, revision: number) => {
        if (revision <= d.revision) return
        d.skin = skin
        d.scene = scene
        d.revision = revision
      },
    },
  })
}
