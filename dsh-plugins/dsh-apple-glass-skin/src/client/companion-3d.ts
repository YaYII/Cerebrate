/**
 * 3D companion renderer built on Three.js (loaded from a public CDN). A
 * programmatically constructed cartoon girl — sphere head with hair and eyes,
 * capsule body, cone skirt, capsule limbs — driven by the agent's live state.
 *
 * Three.js is used through an intentionally loose seam (any) because only a
 * handful of geometry/mesh factories and transform fields are consumed; a CDN
 * version bump cannot break compilation. When the CDN is unreachable or WebGL
 * is unavailable, callers fall back to the pixel-art renderer.
 */

export interface Companion3DState {
  thinking: boolean
  working: boolean
  asleep: boolean
}

/** CDN module URL (three@0.160 core only). */
const THREE_CDN = 'https://esm.sh/three@0.160.0'

/** Loaded Three.js module (loose). */
type AnyThree = Record<string, any>

let threePromise: Promise<AnyThree> | undefined
function loadThree(): Promise<AnyThree> {
  if (threePromise !== undefined) return threePromise
  threePromise = import(/* @vite-ignore */ THREE_CDN).then((mod) => {
    const m = mod as unknown as Record<string, any>
    // esm.sh exposes named exports directly; some variants put them under default.
    if (typeof m.Scene === 'function') return m
    if (typeof m.default?.Scene === 'function') return m.default
    return m
  })
  return threePromise
}

/**
 * Build the cartoon girl figure. Returns { THREE, group, parts } where parts
 * keeps pivot references for walk/think/animate.
 */
export async function createCompanionFigure() {
  const THREE = await loadThree()
  const group = new THREE.Group()
  const mat = (color: string, opts: Record<string, unknown> = {}) =>
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.8, ...opts })
  const parts: Record<string, any> = {}

  // ---- Head: East-Asian girl (warm yellow skin, black straight hair) ----
  const SKIN = '#ffe4d3'   // fair skin with a soft rosy undertone (白里透红)
  const BLUSH_R = '#f2a6b5' // natural cheek red
  const UB_HAIR = '#141414'
  const HAIR = '#141414'   // jet black straight hair
  const head = new THREE.Mesh(new THREE.SphereGeometry(1.05, 28, 22), mat(SKIN))
  head.position.y = 3.2
  group.add(head)
  // Black hair cap (top + upper back of head).
  const hair = new THREE.Mesh(new THREE.SphereGeometry(1.12, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.52), mat(HAIR))
  hair.position.y = 3.32
  group.add(hair)
  // Straight black hair flowing down the back (long, straight, Song-style).
  const hairBack = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 1.1, 2.1, 16), mat(HAIR))
  hairBack.position.set(0, 2.15, -0.25)
  group.add(hairBack)
  // Straight fringe (bang) across the forehead.
  // Straight fringe hugging only the forehead crown (does not cover the eyes).
  const fringe = new THREE.Mesh(new THREE.SphereGeometry(1.08, 22, 14, Math.PI * 0.55, Math.PI * 0.7, 0, Math.PI), mat(HAIR))
  fringe.position.set(0, 3.58, 0.4)
  group.add(fringe)
  // Two small hair buns (double topknots) for a little girl.
  const bunL = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), mat(HAIR))
  bunL.position.set(-0.5, 4.25, 0.05)
  group.add(bunL)
  const bunR = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), mat(HAIR))
  bunR.position.set(0.5, 4.25, 0.05)
  group.add(bunR)
  // Eyes: refined proportions — sclera + iris + glint, plus subtle brows.
  const eyeY = 3.28   // golden-section placement on the face
  const eyeZ = 0.95
  // Sclera (white of the eye).
  const scleraL = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 16), mat('#ffffff'))
  scleraL.position.set(-0.46, eyeY, eyeZ + 0.04)
  group.add(scleraL)
  const scleraR = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 16), mat('#ffffff'))
  scleraR.position.set(0.46, eyeY, eyeZ + 0.04)
  group.add(scleraR)
  // Iris (dark brown) with a small glint.
  for (const side of [-1, 1]) {
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 14), mat('#241007'))
    iris.position.set(side * 0.42, eyeY, eyeZ + 0.14)
    group.add(iris)
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), mat('#ffffff'))
    glint.position.set(side * 0.42 - 0.035, eyeY + 0.045, eyeZ + 0.24)
    group.add(glint)
    // Slender brow (golden-section arch above the eye).
    const brow = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.46, 8), mat('#1f1406'))
    brow.rotation.z = side * -0.12
    brow.rotation.x = Math.PI / 2
    brow.position.set(side * 0.42, eyeY + 0.3, eyeZ + 0.08)
    group.add(brow)
  }
  // Small cherry lips (golden-section placement below the eyes).
  const lip = new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), mat('#d2303e'))
  lip.position.set(0, 2.76, 0.95)
  lip.scale.set(1, 0.5, 0.5)
  group.add(lip)
  // Tiny nose bump.
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), mat('#f7cdbb'))
  nose.position.set(0, 3.02, 1.03)
  nose.scale.set(1, 1.15, 0.6)
  group.add(nose)

  // Petal-pink cheeks (subtle).
  const cheekL = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mat('#ef8f9f'))
  cheekL.position.set(-0.62, 2.96, 0.82)
  group.add(cheekL)
  const cheekR = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mat('#ef8f9f'))
  cheekR.position.set(0.62, 2.96, 0.82)
  group.add(cheekR)

  // ---- Clothing: Song-dynasty ruqun (交领襦裙) with a willow-waist figure ----
  // The torso uses a lathe profile: shoulders → gentle bust → very narrow
  // waist (扶风细柳腰) → flaring hips, i.e. a smooth hourglass instead of a
  // barrel. The skirt then flares from the thin waist to the ground.
  const torsoProfile = [
    new THREE.Vector2(0.52, 3.1),   // shoulder
    new THREE.Vector2(0.56, 2.95),  // upper bust
    new THREE.Vector2(0.55, 2.8),   // bust
    new THREE.Vector2(0.47, 2.6),   // bust taper
    new THREE.Vector2(0.32, 2.35),  // narrow waist (柳腰)
    new THREE.Vector2(0.38, 2.1),   // waist to hip
    new THREE.Vector2(0.5, 1.9),    // hip
    new THREE.Vector2(0.55, 1.75),  // hip flare
  ]
  const torso = new THREE.Mesh(new THREE.LatheGeometry(torsoProfile, 24), mat('#cf1f2f'))
  group.add(torso)
  // Deep crimson inner garment peeking at the collar.
  const inner = new THREE.Mesh(new THREE.LatheGeometry([
    new THREE.Vector2(0.5, 3.0),
    new THREE.Vector2(0.44, 2.6),
    new THREE.Vector2(0.32, 2.3),
  ], 20), mat('#a41d28'))
  inner.position.z = -0.02
  group.add(inner)
  // Gold-edged crossed collar.
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 8, 20, Math.PI * 1.4), mat('#e8c37a'))
  collar.position.y = 2.98
  collar.rotation.x = Math.PI * 0.4
  collar.rotation.z = 0.55
  group.add(collar)
  // Willowy long skirt flaring from the waist to the ground.
  const skirt = new THREE.Mesh(new THREE.LatheGeometry([
    new THREE.Vector2(0.34, 2.15),   // waist top
    new THREE.Vector2(0.5, 1.7),     // hip spread
    new THREE.Vector2(0.78, 0.9),    // mid flare
    new THREE.Vector2(1.12, 0.1),    // hem
    new THREE.Vector2(1.16, 0.0),    // hem edge
  ], 28), mat('#c8102e'))
  group.add(skirt)
  // Golden waist sash hugging the slender waist.
  const sash = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.09, 8, 26), mat('#e8c37a'))
  sash.position.y = 2.15
  sash.rotation.x = Math.PI / 2
  group.add(sash)

  // ---- Arms: wide Song sleeves (褙子宽袖) in jacket color ----
  const armL = new THREE.Group()
  armL.position.set(-0.62, 2.85, 0)
  armL.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 8, 12), mat('#cf1f2f')))
  armL.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.4, 6, 10), mat(SKIN)))
  const handL = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), mat(SKIN))
  handL.position.x = 0.15
  armL.add(handL)
  group.add(armL)
  const armR = new THREE.Group()
  armR.position.set(0.62, 2.85, 0)
  armR.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 8, 12), mat('#cf1f2f')))
  armR.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.4, 6, 10), mat(SKIN)))
  const handR = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), mat(SKIN))
  handR.position.x = 0.15
  armR.add(handR)
  group.add(armR)

  // ---- Legs (mostly hidden under the long skirt; soft shoes peek out) ----
  const legL = new THREE.Group()
  legL.position.set(-0.28, 0.55, 0)
  legL.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.5, 6, 10), mat(SKIN)))
  const shoeL = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mat('#a41d28'))
  shoeL.position.y = -0.55
  legL.add(shoeL)
  group.add(legL)
  const legR = new THREE.Group()
  legR.position.set(0.28, 0.55, 0)
  legR.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.5, 6, 10), mat(SKIN)))
  const shoeR = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mat('#7a4a2a'))
  shoeR.position.y = -0.55
  legR.add(shoeR)
  group.add(legR)

  parts.head = head
  parts.armL = armL
  parts.armR = armR
  parts.legL = legL
  parts.legR = legR
  parts.skirt = skirt
  return { THREE, group, parts, kind: 'proc' as const }
}
/**
 * Create the WebGL renderer + scene + camera wired to a target canvas.
 */
/** Bundled Meshy chibi model file (served by the host half's glb route). */
const CHIBI_GLB = '/dsh-apple-glass-skin/glb/Meshy_AI_Chibi_Figure_0820031320_texture.glb'

/** GLTFLoader CDN module URL (must match the three version above). */
const GLTF_LOADER_CDN = 'https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js'

/** Try loading the written-real chibi model; resolves the figure group or null. */
async function tryLoadChibi(THREE: Record<string, any>): Promise<Record<string, any> | null> {
  try {
    const { GLTFLoader } = await import(/* @vite-ignore */ GLTF_LOADER_CDN)
    const loader = new GLTFLoader()
    const gltf = await new Promise<{ scene: Record<string, any>; animations: unknown[] }>((resolve, reject) => {
      loader.load(CHIBI_GLB, resolve, undefined, reject)
    })
    const group = gltf.scene
    // Meshy models use the MTM double-sided material; force everything to be
    // visible from both sides so the figure reads from every angle.
    group.traverse((obj: Record<string, any>) => {
      if (obj.isMesh && obj.material) {
        obj.material.side = THREE.DoubleSide
        obj.material.needsUpdate = true
      }
    })
    return { kind: 'glb' as const, group, parts: {} }
  } catch (error) {
    console.warn('[dsh-apple-glass-skin] chibi glb load failed, using procedural figure:', error)
    return null
  }
}

export async function createCompanionScene(canvas: HTMLCanvasElement) {
  const THREE = await loadThree()
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setClearColor(0x000000, 0)
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 50)
  camera.position.set(0, 1.6, 5.2)
  camera.lookAt(0, 1.3, 0)
  scene.add(new THREE.AmbientLight(0xffffff, 0.7))
  scene.add(new THREE.DirectionalLight(0xffffff, 0.9))
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 0.4))

  // Prefer the written-real chibi model; fall back to the procedural girl.
  const figure = (await tryLoadChibi(THREE)) ?? (await createCompanionFigure())
  const group = figure.group
  // Fit the model to the scene: normalize the chibi's scale/position so it sits
  // on the same ground as the procedural figure.
  if (figure.kind === 'glb') {
    const box = new THREE.Box3().setFromObject(group)
    const size = box.getSize(new THREE.Vector3())
    const targetH = 4.1
    const scale = size.y > 0 ? targetH / size.y : 1
    group.scale.setScalar(scale)
    const box2 = new THREE.Box3().setFromObject(group)
    const center = box2.getCenter(new THREE.Vector3())
    const size2 = box2.getSize(new THREE.Vector3())
    // Align the model's feet to the bottom of the camera frustum so the full
    // figure fills the canvas height (no dead transparent band above the head).
    const fovRad = (45 * Math.PI) / 180
    const viewBottom = 1.3 - Math.tan(fovRad / 2) * 5.2
    group.position.set(0, viewBottom + size2.y / 2, 0)
  }
  scene.add(group)
  return { THREE, scene, camera, renderer, group, parts: figure.parts, kind: figure.kind }
}

/** Scene bundle returned by createCompanionScene. */
export type CompanionScene = Awaited<ReturnType<typeof createCompanionScene>> & { kind: 'glb' | 'proc' }

/**
 * Advance the 3D figure by one animation tick.
 */
export function animateCompanion3D(
  ctx: CompanionScene,
  state: Companion3DState,
  time: number,
): void {
  const { group, parts, renderer, scene, camera, kind } = ctx
  const breath = Math.sin(time * 1.8) * 0.04
  group.position.y = breath

  // For the procedural figure we can swing limbs; the written-real chibi model
  // has no skeleton, so its state is expressed through whole-body motion.
  if (kind === 'proc') {
    const head = parts.head
    const armL = parts.armL
    const armR = parts.armR
    const legL = parts.legL
    const legR = parts.legR
    const skirt = parts.skirt
    if (state.thinking) {
      head.rotation.z = 0.22 + Math.sin(time * 1.4) * 0.05
      head.position.y = 3.2 + Math.sin(time * 1.2) * 0.02
      armL.rotation.z = 0.35
      armR.rotation.z = -0.35
      legL.rotation.x = 0
      legR.rotation.x = 0
      skirt.rotation.z = Math.sin(time * 1.4) * 0.03
    } else if (state.working) {
      const swing = Math.sin(time * 5) * 0.45
      armL.rotation.z = 0.15 + swing
      armR.rotation.z = -0.15 - swing
      legL.rotation.x = swing
      legR.rotation.x = -swing
      head.rotation.z = 0
      head.position.y = 3.2
      skirt.rotation.z = Math.sin(time * 5) * 0.04
    } else if (state.asleep) {
      head.rotation.z = 0.4
      armL.rotation.z = 0.8
      armR.rotation.z = -0.8
      legL.rotation.x = 0.1
      legR.rotation.x = 0.1
    } else {
      head.rotation.z = Math.sin(time * 0.9) * 0.03
      armL.rotation.z = 0.08
      armR.rotation.z = -0.08
      legL.rotation.x = 0
      legR.rotation.x = 0
      skirt.rotation.z = Math.sin(time * 0.9) * 0.02
    }
  } else {
    // GLB: whole-body state animation.
    if (state.thinking) {
      group.rotation.z = 0.09 + Math.sin(time * 1.4) * 0.05   // slight head-tilt sway
      group.rotation.x = Math.sin(time * 0.8) * 0.04
      group.scale.setScalar(1 + Math.sin(time * 1.4) * 0.015)  // curious bob
    } else if (state.working) {
      group.rotation.z = Math.sin(time * 5) * 0.08             // bouncing walk-walk
      group.rotation.x = Math.sin(time * 2.5) * 0.03
      group.scale.setScalar(1 + Math.sin(time * 5) * 0.02)
    } else if (state.asleep) {
      group.rotation.z = 0.5                                   // slumped to one side
      group.rotation.x = 0.1
      group.scale.setScalar(0.98 + Math.sin(time * 0.5) * 0.005)
    } else {
      group.rotation.z = Math.sin(time * 0.9) * 0.03           // gentle idle sway
      group.rotation.x = 0
      group.scale.setScalar(1 + Math.sin(time * 1.8) * 0.01)
    }
  }

  renderer.render(scene, camera)
}

/** Size the renderer backing store to its element and update the camera. */
export function resizeCompanion3D(ctx: CompanionScene, width: number, height: number): void {
  const { renderer, camera } = ctx
  renderer.setSize(width, height, false)
  camera.aspect = width / height
  camera.updateProjectionMatrix()
}
