/**
 * Tech-Space settings row registered into the General section item slot:
 * title + three skin choice cards (follow system / tech light / deep-space
 * dark), each previewing its backdrop gradient, plus a backdrop scene row
 * (space / city / ocean) that picks the animated background theme.
 */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_SKIN, SKINS, type BackdropScene } from './skins.ts'
import type { AppleSkinKey } from './locales.ts'
import type { createSkinStore } from './skin-store.ts'

/** Injected business face: the skin and scene writes. */
export interface SkinRowInjected {
  /** Switch the skin (theme id or `system`). */
  setSkin: (id: string) => void
  /** Switch the backdrop scene theme. */
  setScene: (scene: BackdropScene) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type SkinRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createSkinStore>>
  & PropsLocale<'settings.appleGlass'> & SkinRowInjected

/** Row layout (inline styles; the skin owns no stylesheet of its own). */
const styles = {
  group: {
    display: 'flex', flexDirection: 'column' as const, gap: 10,
    padding: '2px 0',
  },
  title: {
    fontSize: 13, lineHeight: '18px', fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
  },
  card: {
    display: 'flex', flexDirection: 'column' as const, gap: 6,
    padding: 8, borderRadius: 10, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l1)',
    background: 'var(--dsw-alias-bg-layer-2)',
    font: 'inherit', textAlign: 'left' as const,
    color: 'var(--dsw-alias-label-primary)',
    transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
  },
  cardSelected: {
    borderColor: 'var(--dsw-alias-brand-primary)',
    boxShadow: '0 0 0 1px var(--dsw-alias-brand-primary)',
  },
  swatch: {
    height: 36, borderRadius: 6,
    backgroundSize: 'cover', backgroundPosition: 'center',
    border: '1px solid var(--dsw-alias-border-l1)',
  },
  cardLabel: {
    fontSize: 12, lineHeight: '16px', fontWeight: 500,
  },
  cardDesc: {
    fontSize: 11, lineHeight: '15px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  divider: {
    height: 1, background: 'var(--dsw-alias-border-l1)', margin: '4px 0',
  },
} as const

/** One selectable choice card. */
function Choice({
  label, desc, selected, swatch, onClick, children,
}: {
  label: string
  desc: string
  selected: boolean
  swatch?: string
  onClick: () => void
  children?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={selected ? { ...styles.card, ...styles.cardSelected } : styles.card}
    >
      {swatch !== undefined ? <div style={{ ...styles.swatch, background: swatch }} /> : children}
      <span style={styles.cardLabel}>{label}</span>
      <span style={styles.cardDesc}>{desc}</span>
    </button>
  )
}

/** Scene gradient previews (per-skin base colors, shown in the cards). */
const SCENE_PREVIEWS: Record<BackdropScene, string> = {
  space: 'linear-gradient(160deg, #02040a, #0a1630)',
  city: 'linear-gradient(160deg, #05070f, #101c30)',
  ocean: 'linear-gradient(160deg, #02121f, #04304a)',
  matrix: 'linear-gradient(180deg, #000805, #002411)',
}

/**
 * Render the Tech-Space skin row (skin cards + backdrop scene cards).
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function SkinRow({ t, setSkin, setScene, useStore }: SkinRowComponentProps) {
  const skin = useStore(s => s.skin)
  const scene = useStore(s => s.scene)
  const selectedSkin = SKINS.some(candidate => candidate.id === skin) ? skin : null
  return (
    <div style={styles.group}>
      <div style={styles.title}>{t('skin.title')}</div>
      <div style={styles.grid}>
        <Choice
          label={t('skin.default')}
          desc={t('skin.defaultDesc')}
          selected={selectedSkin === null}
          onClick={() => setSkin(DEFAULT_SKIN)}
          children={<div style={styles.swatch} />}
        />
        {SKINS.map(skinDefinition => (
          <Choice
            key={skinDefinition.id}
            label={t(`skin.${skinDefinition.labelKey}`)}
            desc={t(`skin.${skinDefinition.labelKey}Desc`)}
            selected={selectedSkin === skinDefinition.id}
            swatch={skinDefinition.backdrop}
            onClick={() => setSkin(skinDefinition.id)}
          />
        ))}
      </div>
      <div style={styles.divider} />
      <div style={styles.title}>{t('scene.title')}</div>
      <div style={styles.grid}>
        {(['space', 'city', 'ocean', 'matrix'] as const).map(sceneId => (
          <Choice
            key={sceneId}
            label={t(`scene.${sceneId}`)}
            desc={t(`scene.${sceneId}Desc`)}
            selected={scene === sceneId}
            swatch={SCENE_PREVIEWS[sceneId]}
            onClick={() => setScene(sceneId)}
          />
        ))}
      </div>
    </div>
  )
}
