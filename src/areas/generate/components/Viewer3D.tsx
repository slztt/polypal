import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, ErrorInfo, MutableRefObject } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { ContactShadows, Environment, GizmoHelper, Html, Lightformer, Line, OrbitControls, useGizmoContext, useGLTF } from '@react-three/drei'
import { EffectComposer, Outline, Select, Selection } from '@react-three/postprocessing'
import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

// Patch THREE pour utiliser BVH sur tous les meshes — réduit le raycast O(N) → O(log N)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree as any
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree as any
THREE.Mesh.prototype.raycast = acceleratedRaycast
import SplatViewer, { type SplatViewerHandle } from './SplatViewer'
import { useGeneration } from '@shared/hooks/useGeneration'
import { useAppStore } from '@shared/stores/appStore'
import { ViewerToolbar, type ViewMode } from './ViewerToolbar'
import type { LightSettings, PointLight } from '@shared/stores/appStore'
import { DEFAULT_LIGHT_SETTINGS } from '@shared/stores/appStore'
import type { MeshViewStats } from '@shared/stores/appStore'
import { computeDeviation, type DeviationResult } from '../deviation'
import { formatDimensions, formatLength, formatNumber, formatUnitless } from '@shared/utils/units'

export type GizmoMode = 'translate' | 'rotate' | 'scale'

const SELECTION_OUTLINE_VISIBLE_COLOR = 0x22c55e
const SELECTION_OUTLINE_HIDDEN_COLOR = 0x15803d
const SELECTION_OUTLINE_EDGE_STRENGTH = 2.5
const SELECTION_OUTLINE_BLUR = false
const SELECTION_OUTLINE_MULTISAMPLING = 0
const SELECTION_OUTLINE_RESOLUTION_SCALE = 0.5

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function createMatcapTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(size * 0.35, size * 0.3, 0, size / 2, size / 2, size / 2)
  grad.addColorStop(0, '#ffffff')
  grad.addColorStop(0.45, '#aaaaaa')
  grad.addColorStop(1, '#222222')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)
  return new THREE.CanvasTexture(canvas)
}

function createCheckerTexture(): THREE.CanvasTexture {
  const size = 256
  const tileCount = 8
  const tileSize = size / tileCount
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  for (let row = 0; row < tileCount; row++) {
    for (let col = 0; col < tileCount; col++) {
      ctx.fillStyle = (row + col) % 2 === 0 ? '#e0e0e0' : '#888888'
      ctx.fillRect(col * tileSize, row * tileSize, tileSize, tileSize)
    }
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  return tex
}

const SELECTION_OUTLINE_COLOR = '#22c55e'

function makeLightBulbTexture(color: string, isSelected: boolean): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!

  const cx = size / 2
  const cy = size / 2

  // Draws the bulb glyph (rays + circle + base). `pad` grows every part by a
  // few pixels — used to lay down an oversized accent-green silhouette behind the
  // normal-sized icon, so the outline hugs the actual glyph shape instead of
  // being a plain circle around it.
  const drawGlyph = (fillColor: string, pad: number) => {
    ctx.strokeStyle = fillColor
    ctx.lineWidth = 2 + pad * 2
    ctx.lineCap = 'round'
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2
      const r1 = 20 - pad
      const r2 = 27 + pad
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      ctx.stroke()
    }

    ctx.beginPath()
    ctx.arc(cx, cy - 1, 12 + pad, 0, Math.PI * 2)
    ctx.fillStyle = fillColor
    ctx.fill()
    if (pad === 0) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    ctx.fillStyle = fillColor
    ctx.fillRect(cx - 4 - pad, cy + 11 - pad, 8 + pad * 2, 8 + pad * 2)
    if (pad === 0) {
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.strokeRect(cx - 4, cy + 11, 8, 8)
    }
  }

  if (isSelected) drawGlyph(SELECTION_OUTLINE_COLOR, 2.5)
  drawGlyph(color, 0)

  return new THREE.CanvasTexture(canvas)
}

// ---------------------------------------------------------------------------
// CanvasCapture — exposes gl.domElement ref outside Canvas
// ---------------------------------------------------------------------------

function CanvasCapture({
  domRef,
}: {
  domRef: React.MutableRefObject<HTMLCanvasElement | null>
}): null {
  const { gl } = useThree()
  useEffect(() => {
    domRef.current = gl.domElement
    // eslint-disable-next-line react-hooks/exhaustive-deps -- domRef is a stable ref
  }, [gl])
  return null
}

// ---------------------------------------------------------------------------
// ModelErrorBoundary — catches useGLTF load failures (e.g. 404)
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
  resetKey?: string | null
}

interface ErrorBoundaryState {
  hasError: boolean
}

class ModelErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn('[Viewer3D] Failed to load model:', error.message, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render(): ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}

function ModelLoadError(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-600 pointer-events-none">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      <p className="mt-3 text-sm">Model file not found</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MeshModel
// ---------------------------------------------------------------------------

interface MeshModelProps {
  url: string
  jobId: string
  viewMode: ViewMode
  selected: boolean
  onStats: (stats: MeshViewStats) => void
  onSelect: () => void
  onObject: (obj: THREE.Object3D | null) => void
  /** Clipping plane for the before/after wipe (keeps the positive side). */
  clipPlane?: THREE.Plane | null
  /** Per-vertex deviation colours for the 'deviation' view mode. */
  deviation?: DeviationResult | null
  /** When set, clicks report a surface point instead of selecting the mesh. */
  onPick?: (point: THREE.Vector3) => void
}

function MeshModel(props: MeshModelProps): JSX.Element {
  const extension = props.url.split('?')[0]?.split('.').pop()?.toLowerCase()
  return extension === 'obj' ? <ObjMeshModel {...props} /> : <GltfMeshModel {...props} />
}

function GltfMeshModel(props: MeshModelProps): JSX.Element {
  const { scene } = useGLTF(props.url)
  return <SceneMeshModel {...props} scene={scene} loaderType="gltf" />
}

function ObjMeshModel(props: MeshModelProps): JSX.Element {
  const scene = useLoader(OBJLoader, props.url)
  return <SceneMeshModel {...props} scene={scene} loaderType="obj" />
}

function SceneMeshModel({
  url,
  viewMode,
  selected,
  onStats,
  onSelect,
  onObject,
  clipPlane = null,
  deviation = null,
  onPick,
  scene,
  loaderType,
}: MeshModelProps & {
  scene: THREE.Group | THREE.Scene
  loaderType: 'gltf' | 'obj'
}): JSX.Element {
  const captured = useRef(false)
  const edgeHelpers = useRef<THREE.LineSegments[]>([])

  // Expose the scene object so Viewer3D can attach the transform gizmo to it.
  useEffect(() => {
    onObject(scene)
    return () => onObject(null)
  }, [scene, onObject])

  // Free GPU resources and loader cache when this model is replaced or unmounted
  useEffect(() => {
    return () => {
      if (loaderType === 'obj') {
        useLoader.clear(OBJLoader, url)
      } else {
        useGLTF.clear(url)
      }
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose()
          const materials = Array.isArray(child.material) ? child.material : [child.material]
          materials.forEach((m: THREE.Material) => m.dispose())
        }
      })
    }
  }, [loaderType, scene, url])

  // Compute BVH on all geometries for fast raycasting (O(log N) vs O(N)).
  // Also force DoubleSide on every material so faces with inverted normals
  // (a known artifact of the flexible-dual-grid mesh decoder) are still visible.
  useEffect(() => {
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        (child.geometry as any).computeBoundsTree()
        const mats = Array.isArray(child.material) ? child.material : [child.material]
        mats.forEach((m: THREE.Material) => { m.side = THREE.DoubleSide })
      }
    })
    return () => {
      scene.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          (child.geometry as any).disposeBoundsTree?.()
        }
      })
    }
  }, [scene])

  // Centre the mesh on the grid. Runs only on first load / model change — never
  // on plain re-renders, so a live gizmo transform is not silently overwritten.
  useEffect(() => {
    // Clear any cached transform before measuring (useGLTF may reuse a scene
    // that still carries an earlier gizmo pose).
    scene.position.set(0, 0, 0)
    scene.rotation.set(0, 0, 0)
    scene.scale.set(1, 1, 1)
    const box = new THREE.Box3().setFromObject(scene)
    const center = new THREE.Vector3()
    box.getCenter(center)
    const size = new THREE.Vector3()
    box.getSize(size)
    scene.position.set(-center.x, -box.min.y, -center.z)

    // Compute stats
    let vertices = 0
    let triangles = 0
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        vertices += child.geometry.attributes.position?.count ?? 0
        triangles += child.geometry.index
          ? child.geometry.index.count / 3
          : (child.geometry.attributes.position?.count ?? 0) / 3
      }
    })
    const roundedTriangles = Math.round(triangles)
    onStats({ vertices: Math.round(vertices), triangles: roundedTriangles, extents: [size.x, size.y, size.z] })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute on scene change only; onStats is a stable callback
  }, [scene])

  // Thumbnail capture (kept for future use)
  useEffect(() => {
    captured.current = false
  }, [url])

  // Material swapping based on viewMode
  useEffect(() => {
    // Remove any edge helpers from previous wireframe pass
    edgeHelpers.current.forEach((lines) => lines.parent?.remove(lines))
    edgeHelpers.current = []

    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return

      // Save original material on first visit
      if (!child.userData.originalMaterial) {
        child.userData.originalMaterial = child.material
      }

      // Leaving the deviation view: put back any vertex colours it replaced.
      if (child.userData.deviationApplied) {
        const saved = child.userData.savedColor as THREE.BufferAttribute | undefined
        if (saved) child.geometry.setAttribute('color', saved)
        else child.geometry.deleteAttribute('color')
        child.userData.deviationApplied = false
        child.userData.savedColor = undefined
      }

      let next: THREE.Material
      switch (viewMode) {
        case 'deviation': {
          const colors = deviation?.colors.get(child.uuid)
          if (!colors || colors.length / 3 !== child.geometry.attributes.position.count) {
            next = new THREE.MeshLambertMaterial({ color: 0x52525b })
            break
          }
          child.userData.savedColor = child.geometry.getAttribute('color') ?? undefined
          child.userData.deviationApplied = true
          child.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
          next = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })
          break
        }
        case 'wireframe': {
          next = new THREE.MeshBasicMaterial({ color: 0x4ade80, wireframe: true })
          break
        }
        case 'normals':
          // Ensure vertex normals exist — AI-generated meshes often skip this
          child.geometry.computeVertexNormals()
          next = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide })
          break
        case 'matcap':
          next = new THREE.MeshMatcapMaterial({ matcap: createMatcapTexture() })
          break
        case 'uv':
          next = new THREE.MeshBasicMaterial({ map: createCheckerTexture() })
          break
        default:
          next = child.userData.originalMaterial as THREE.Material
      }

      child.material = next
    })
  }, [scene, viewMode, deviation])

  // Before/after wipe: clip whatever material is active to one side.
  useEffect(() => {
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m: THREE.Material) => {
        m.clippingPlanes = clipPlane ? [clipPlane] : null
        m.needsUpdate = true
      })
    })
  }, [scene, viewMode, deviation, clipPlane])

  return (
    <Select enabled={selected}>
      <primitive
        object={scene}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation()
          if (onPick) onPick(e.point.clone())
          else onSelect()
        }}
      />
    </Select>
  )

}

// ---------------------------------------------------------------------------
// Orientation gizmo — coloured bubbles only (X/Y/Z)
// ---------------------------------------------------------------------------

function makeAxisLabelTexture(letter: string, bg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 64
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(32, 32, 16, 0, 2 * Math.PI)
  ctx.closePath()
  ctx.fillStyle = bg
  ctx.fill()
  ctx.font = '18px Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillStyle = '#ffffff'
  ctx.fillText(letter, 32, 41)
  return new THREE.CanvasTexture(canvas)
}

const GIZMO_AXES: {
  letter: string
  color: string
  pos: [number, number, number]
  lineRotation: [number, number, number]
}[] = [
  { letter: 'X', color: '#f87171', pos: [1, 0, 0], lineRotation: [0, 0, 0] },
  { letter: 'Y', color: '#4ade80', pos: [0, 1, 0], lineRotation: [0, 0, Math.PI / 2] },
  { letter: 'Z', color: '#60a5fa', pos: [0, 0, 1], lineRotation: [0, -Math.PI / 2, 0] },
]

function AxisLine({ color, rotation }: { color: string; rotation: [number, number, number] }) {
  return (
    <group rotation={rotation}>
      <mesh position={[0.4, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  )
}

function AxisBubble({ letter, color, pos }: { letter: string; color: string; pos: [number, number, number] }) {
  const { tweenCamera } = useGizmoContext()
  const texture = useMemo(() => makeAxisLabelTexture(letter, color), [letter, color])
  const [hovered, setHovered] = useState(false)

  return (
    <sprite
      position={pos}
      scale={hovered ? 1.2 : 1}
      onPointerDown={(e) => { tweenCamera(e.object.position); e.stopPropagation() }}
      onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
      onPointerOut={() => setHovered(false)}
    >
      <spriteMaterial map={texture} alphaTest={0.3} toneMapped={false} />
    </sprite>
  )
}

function GizmoBubbles() {
  return (
    <group scale={40}>
      {GIZMO_AXES.map((axis) => (
        <AxisLine key={`line-${axis.letter}`} color={axis.color} rotation={axis.lineRotation} />
      ))}
      {GIZMO_AXES.map((axis) => (
        <AxisBubble key={axis.letter} {...axis} />
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// Transform gizmos — custom move / rotate / scale handles (shared style)
// ---------------------------------------------------------------------------

type GizmoAxis = 'x' | 'y' | 'z'
type TranslateHandleId = GizmoAxis | 'xy' | 'yz' | 'xz'
type ScaleHandleId = GizmoAxis | 'xyz'

const AXIS_COLORS: Record<GizmoAxis, string> = {
  x: '#f87171',
  y: '#4ade80',
  z: '#60a5fa',
}

const AXIS_DIR: Record<GizmoAxis, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
}

// Orient a +Y cylinder/cone/box onto each axis.
const AXIS_ROTATION: Record<GizmoAxis, [number, number, number]> = {
  x: [0, 0, -Math.PI / 2],
  y: [0, 0, 0],
  z: [Math.PI / 2, 0, 0],
}

// Orient a default-XY torus so its ring spins around each axis.
const RING_ROTATION: Record<GizmoAxis, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
}

// Two-axis plane handles, coloured by their locked (normal) axis.
const PLANE_HANDLES: {
  id: 'xy' | 'yz' | 'xz'
  normal: [number, number, number]
  color: string
  position: [number, number, number]
  rotation: [number, number, number]
}[] = [
  { id: 'xy', normal: [0, 0, 1], color: AXIS_COLORS.z, position: [0.26, 0.26, 0], rotation: [0, 0, 0] },
  { id: 'yz', normal: [1, 0, 0], color: AXIS_COLORS.x, position: [0, 0.26, 0.26], rotation: [0, -Math.PI / 2, 0] },
  { id: 'xz', normal: [0, 1, 0], color: AXIS_COLORS.y, position: [0.26, 0, 0.26], rotation: [Math.PI / 2, 0, 0] },
]

const GIZMO_SCREEN_SIZE = 0.12

function lightenColor(hex: string, amount = 0.5): string {
  return '#' + new THREE.Color(hex).lerp(new THREE.Color('#ffffff'), amount).getHexString()
}

function intersectPlane(ray: THREE.Ray, origin: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin)
  const hit = new THREE.Vector3()
  return ray.intersectPlane(plane, hit) ? hit : null
}

// Shared plumbing: follow the object, keep a constant on-screen size, and run
// the pointer-drag lifecycle (window listeners + OrbitControls locking).
function useGizmoBase(object: THREE.Object3D) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const raycaster = useThree((s) => s.raycaster)
  const controls = useThree((s) => s.controls) as { enabled: boolean } | null

  const groupRef = useRef<THREE.Group>(null)
  const ndc = useRef(new THREE.Vector2())
  const moveRef = useRef<((ev: PointerEvent) => void) | null>(null)
  const endRef = useRef<(() => void) | null>(null)

  useFrame(() => {
    const g = groupRef.current
    if (!g) return
    object.getWorldPosition(g.position)
    g.scale.setScalar(Math.max(camera.position.distanceTo(g.position) * GIZMO_SCREEN_SIZE, 0.001))
  })

  const pointerRay = useCallback((ev: PointerEvent): THREE.Ray => {
    const rect = gl.domElement.getBoundingClientRect()
    ndc.current.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(ndc.current, camera)
    return raycaster.ray
  }, [camera, gl, raycaster])

  const stop = useCallback(() => {
    if (!moveRef.current) return
    window.removeEventListener('pointermove', moveRef.current)
    window.removeEventListener('pointerup', stop)
    moveRef.current = null
    endRef.current?.()
    endRef.current = null
    if (controls) controls.enabled = true
    gl.domElement.style.cursor = ''
  }, [controls, gl])

  const start = useCallback((onMove: (ev: PointerEvent) => void, onEnd?: () => void) => {
    moveRef.current = onMove
    endRef.current = onEnd ?? null
    if (controls) controls.enabled = false
    gl.domElement.style.cursor = 'grabbing'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', stop)
  }, [controls, gl, stop])

  useEffect(() => stop, [stop])  // release the drag if unmounted mid-interaction

  return { camera, groupRef, pointerRay, start }
}

function hoverHandlers<T extends string>(
  id: T,
  setHovered: (value: T | null) => void,
  onDown: (e: ThreeEvent<PointerEvent>) => void,
) {
  return {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); setHovered(id) },
    onPointerOut: () => setHovered(null),
    onPointerDown: onDown,
  }
}

function GizmoArrow({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target spanning the whole arm */}
      <mesh position={[0, 0.55, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 1.1, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Shaft */}
      <mesh position={[0, 0.48, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.014, 0.014, 0.66, 16]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
      {/* Arrowhead */}
      <mesh position={[0, 0.9, 0]} renderOrder={999}>
        <coneGeometry args={[0.055, 0.2, 20]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoScaleArm({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target — starts above the centre cube so a
          centre click hits the uniform-scale handle, not an axis */}
      <mesh position={[0, 0.6, 0]}>
        <cylinderGeometry args={[0.09, 0.09, 0.8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {/* Shaft */}
      <mesh position={[0, 0.42, 0]} renderOrder={999}>
        <cylinderGeometry args={[0.014, 0.014, 0.7, 16]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
      {/* Cube head */}
      <mesh position={[0, 0.84, 0]} renderOrder={999}>
        <boxGeometry args={[0.11, 0.11, 0.11]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoRing({ color, active }: { color: string; active: boolean }): JSX.Element {
  const tint = active ? lightenColor(color) : color
  return (
    <group>
      {/* Invisible, fat hit target */}
      <mesh>
        <torusGeometry args={[0.9, 0.06, 8, 48]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh renderOrder={999}>
        <torusGeometry args={[0.9, 0.012, 12, 64]} />
        <meshBasicMaterial color={tint} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>
    </group>
  )
}

function GizmoPlane({ color, active }: { color: string; active: boolean }): JSX.Element {
  return (
    <mesh renderOrder={998}>
      <planeGeometry args={[0.26, 0.26]} />
      <meshBasicMaterial
        color={active ? lightenColor(color) : color}
        transparent
        opacity={active ? 0.6 : 0.28}
        side={THREE.DoubleSide}
        toneMapped={false}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  )
}

function TranslateGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { camera, groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<TranslateHandleId | null>(null)
  const [activeId, setActiveId] = useState<TranslateHandleId | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3 | null
    planeNormal: THREE.Vector3
    origin: THREE.Vector3
    startHit: THREE.Vector3
    startPos: THREE.Vector3
  } | null>(null)

  const beginDrag = useCallback((id: TranslateHandleId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    const startPos = object.position.clone()

    let axisDir: THREE.Vector3 | null = null
    let planeNormal: THREE.Vector3
    if (id === 'x' || id === 'y' || id === 'z') {
      axisDir = new THREE.Vector3(...AXIS_DIR[id])
      // Drag plane: contains the axis and faces the camera as much as possible.
      const view = new THREE.Vector3().subVectors(camera.position, origin)
      planeNormal = view.sub(axisDir.clone().multiplyScalar(view.dot(axisDir)))
      if (planeNormal.lengthSq() < 1e-6) planeNormal.set(axisDir.y ? 1 : 0, axisDir.y ? 0 : 1, 0)
      planeNormal.normalize()
    } else {
      planeNormal = new THREE.Vector3(...PLANE_HANDLES.find((p) => p.id === id)!.normal)
    }

    const startHit = intersectPlane(e.ray, origin, planeNormal)
    if (!startHit) return
    drag.current = { axisDir, planeNormal, origin, startHit, startPos }
    setActiveId(id)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.planeNormal)
      if (!hit) return
      const delta = new THREE.Vector3().subVectors(hit, d.startHit)
      if (d.axisDir) {
        object.position.copy(d.startPos).addScaledVector(d.axisDir, delta.dot(d.axisDir))
      } else {
        object.position.copy(d.startPos).add(delta)
      }
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, camera, pointerRay, start, onDragStart, onDragEnd])

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Central origin handle (decorative — never blocks picking) */}
      <mesh raycast={() => null} renderOrder={999}>
        <sphereGeometry args={[0.05, 20, 20]} />
        <meshBasicMaterial color="#e4e4e7" toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>

      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={AXIS_ROTATION[axis]} {...hoverHandlers<TranslateHandleId>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoArrow color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}

      {PLANE_HANDLES.map((plane) => (
        <group key={plane.id} position={plane.position} rotation={plane.rotation} {...hoverHandlers<TranslateHandleId>(plane.id, setHovered, (e) => beginDrag(plane.id, e))}>
          <GizmoPlane color={plane.color} active={hovered === plane.id || activeId === plane.id} />
        </group>
      ))}
    </group>
  )
}

function RotateGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<GizmoAxis | null>(null)
  const [activeId, setActiveId] = useState<GizmoAxis | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3
    origin: THREE.Vector3
    startVec: THREE.Vector3
    startQuat: THREE.Quaternion
  } | null>(null)

  const beginDrag = useCallback((axis: GizmoAxis, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    const axisDir = new THREE.Vector3(...AXIS_DIR[axis]).normalize()
    // Rotation happens in the plane perpendicular to the axis (the ring's plane).
    const startHit = intersectPlane(e.ray, origin, axisDir)
    if (!startHit) return
    const startVec = new THREE.Vector3().subVectors(startHit, origin)
    if (startVec.lengthSq() < 1e-9) return
    drag.current = { axisDir, origin, startVec, startQuat: object.quaternion.clone() }
    setActiveId(axis)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.axisDir)
      if (!hit) return
      const cur = new THREE.Vector3().subVectors(hit, d.origin)
      // Signed angle between the start and current vectors, around the axis.
      const cross = new THREE.Vector3().crossVectors(d.startVec, cur)
      const angle = Math.atan2(cross.dot(d.axisDir), d.startVec.dot(cur))
      const q = new THREE.Quaternion().setFromAxisAngle(d.axisDir, angle)
      object.quaternion.copy(d.startQuat).premultiply(q)
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, pointerRay, start, onDragStart, onDragEnd])

  return (
    <group ref={groupRef} renderOrder={999}>
      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={RING_ROTATION[axis]} {...hoverHandlers<GizmoAxis>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoRing color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}
    </group>
  )
}

function ScaleGizmo({ object, onDragStart, onDragEnd }: { object: THREE.Object3D; onDragStart?: () => void; onDragEnd?: () => void }): JSX.Element {
  const { camera, groupRef, pointerRay, start } = useGizmoBase(object)
  const [hovered, setHovered] = useState<ScaleHandleId | null>(null)
  const [activeId, setActiveId] = useState<ScaleHandleId | null>(null)
  const drag = useRef<{
    axisDir: THREE.Vector3 | null
    planeNormal: THREE.Vector3
    origin: THREE.Vector3
    startProj: number
    startScale: THREE.Vector3
    armLength: number
  } | null>(null)

  const beginDrag = useCallback((id: ScaleHandleId, e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const origin = new THREE.Vector3()
    object.getWorldPosition(origin)
    // World length of one local unit — maps drag distance to a sensible factor.
    const armLength = Math.max(groupRef.current?.scale.x ?? 1, 1e-4)

    let axisDir: THREE.Vector3 | null = null
    let planeNormal: THREE.Vector3
    if (id === 'xyz') {
      planeNormal = new THREE.Vector3().subVectors(camera.position, origin).normalize()
    } else {
      axisDir = new THREE.Vector3(...AXIS_DIR[id])
      const view = new THREE.Vector3().subVectors(camera.position, origin)
      planeNormal = view.sub(axisDir.clone().multiplyScalar(view.dot(axisDir)))
      if (planeNormal.lengthSq() < 1e-6) planeNormal.set(axisDir.y ? 1 : 0, axisDir.y ? 0 : 1, 0)
      planeNormal.normalize()
    }

    const startHit = intersectPlane(e.ray, origin, planeNormal)
    if (!startHit) return
    const startRel = new THREE.Vector3().subVectors(startHit, origin)
    const startProj = axisDir ? startRel.dot(axisDir) : startRel.length()
    drag.current = { axisDir, planeNormal, origin, startProj, startScale: object.scale.clone(), armLength }
    setActiveId(id)
    onDragStart?.()
    start((ev) => {
      const d = drag.current
      if (!d) return
      const hit = intersectPlane(pointerRay(ev), d.origin, d.planeNormal)
      if (!hit) return
      const rel = new THREE.Vector3().subVectors(hit, d.origin)
      const proj = d.axisDir ? rel.dot(d.axisDir) : rel.length()
      const factor = Math.max(0.01, 1 + (proj - d.startProj) / d.armLength)
      if (d.axisDir) {
        const s = d.startScale.clone()
        if (d.axisDir.x) s.x = Math.max(0.01, d.startScale.x * factor)
        if (d.axisDir.y) s.y = Math.max(0.01, d.startScale.y * factor)
        if (d.axisDir.z) s.z = Math.max(0.01, d.startScale.z * factor)
        object.scale.copy(s)
      } else {
        object.scale.copy(d.startScale).multiplyScalar(factor)
      }
    }, () => { drag.current = null; setActiveId(null); onDragEnd?.() })
  }, [object, camera, pointerRay, start, groupRef, onDragStart, onDragEnd])

  const uniformActive = hovered === 'xyz' || activeId === 'xyz'

  return (
    <group ref={groupRef} renderOrder={999}>
      {/* Central cube — uniform scale */}
      <mesh {...hoverHandlers<ScaleHandleId>('xyz', setHovered, (e) => beginDrag('xyz', e))} renderOrder={999}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshBasicMaterial color={uniformActive ? lightenColor('#e4e4e7') : '#e4e4e7'} toneMapped={false} transparent depthTest={false} depthWrite={false} />
      </mesh>

      {(['x', 'y', 'z'] as GizmoAxis[]).map((axis) => (
        <group key={axis} rotation={AXIS_ROTATION[axis]} {...hoverHandlers<ScaleHandleId>(axis, setHovered, (e) => beginDrag(axis, e))}>
          <GizmoScaleArm color={AXIS_COLORS[axis]} active={hovered === axis || activeId === axis} />
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
// PointLightMarker — renders a point light + billboard icon + optional gizmo
// ---------------------------------------------------------------------------

function PointLightMarker({
  light,
  isSelected,
  gizmoMode,
  onSelect,
  onPositionChange,
}: {
  light: PointLight
  isSelected: boolean
  gizmoMode: GizmoMode | null
  onSelect: () => void
  onPositionChange: (pos: [number, number, number]) => void
}) {
  const [group, setGroup] = useState<THREE.Group | null>(null)
  const iconTexture = useMemo(() => makeLightBulbTexture(light.color, isSelected), [light.color, isSelected])

  return (
    <>
      <group ref={setGroup} position={light.position}>
        <pointLight color={light.color} intensity={light.intensity} distance={8} decay={2} />
        <sprite
          scale={[0.3, 0.3, 1]}
          onClick={(e) => { e.stopPropagation(); onSelect() }}
        >
          <spriteMaterial map={iconTexture} toneMapped={false} depthTest={false} />
        </sprite>
      </group>
      {group && isSelected && gizmoMode === 'translate' && (
        <TranslateGizmo
          object={group}
          onDragEnd={() => onPositionChange([group.position.x, group.position.y, group.position.z])}
        />
      )}
      {group && isSelected && gizmoMode === 'rotate' && (
        <RotateGizmo
          object={group}
          onDragEnd={() => onPositionChange([group.position.x, group.position.y, group.position.z])}
        />
      )}
      {group && isSelected && gizmoMode === 'scale' && (
        <ScaleGizmo
          object={group}
          onDragEnd={() => onPositionChange([group.position.x, group.position.y, group.position.z])}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Diagnostics: reference model, before/after wipe, measuring
// ---------------------------------------------------------------------------

/** Distinct cache key so the reference never shares a scene object with the main model. */
function referenceUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}polypalRef=1`
}

function ReferenceScene({ scene, clipPlane, visible, onObject }: {
  scene: THREE.Group | THREE.Scene
  clipPlane: THREE.Plane | null
  visible: boolean
  onObject: (obj: THREE.Object3D | null) => void
}): JSX.Element {
  useEffect(() => {
    // Same placement rule as the main model: centred on X/Z, resting on Y = 0.
    scene.position.set(0, 0, 0)
    scene.rotation.set(0, 0, 0)
    scene.scale.set(1, 1, 1)
    const box = new THREE.Box3().setFromObject(scene)
    const center = new THREE.Vector3()
    box.getCenter(center)
    scene.position.set(-center.x, -box.min.y, -center.z)
    onObject(scene)
    return () => onObject(null)
  }, [scene, onObject])

  useEffect(() => {
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return
      const mats = Array.isArray(child.material) ? child.material : [child.material]
      mats.forEach((m: THREE.Material) => {
        m.side = THREE.DoubleSide
        m.clippingPlanes = clipPlane ? [clipPlane] : null
        m.needsUpdate = true
      })
    })
  }, [scene, clipPlane])

  return <primitive object={scene} visible={visible} raycast={() => null} />
}

function GltfReference(props: { url: string; clipPlane: THREE.Plane | null; visible: boolean; onObject: (o: THREE.Object3D | null) => void }): JSX.Element {
  const key = referenceUrl(props.url)
  const { scene } = useGLTF(key)
  useEffect(() => () => useGLTF.clear(key), [key])
  return <ReferenceScene scene={scene} {...props} />
}

function ObjReference(props: { url: string; clipPlane: THREE.Plane | null; visible: boolean; onObject: (o: THREE.Object3D | null) => void }): JSX.Element {
  const key = referenceUrl(props.url)
  const scene = useLoader(OBJLoader, key)
  useEffect(() => () => useLoader.clear(OBJLoader, key), [key])
  return <ReferenceScene scene={scene} {...props} />
}

function ReferenceModel(props: { url: string; clipPlane: THREE.Plane | null; visible: boolean; onObject: (o: THREE.Object3D | null) => void }): JSX.Element {
  const extension = props.url.split('?')[0]?.split('.').pop()?.toLowerCase()
  return extension === 'obj' ? <ObjReference {...props} /> : <GltfReference {...props} />
}

/**
 * Keeps the wipe planes vertical on screen: both pass through the point under
 * the slider at the orbit target's depth, with normals along the camera's
 * right vector. `after` keeps the right side, `before` the left.
 */
function WipeController({ position, after, before }: {
  position: number
  after: THREE.Plane
  before: THREE.Plane
}): null {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as { target?: THREE.Vector3 } | null
  const right = useMemo(() => new THREE.Vector3(), [])
  const point = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    const target = controls?.target ?? new THREE.Vector3()
    const depth = target.clone().project(camera).z
    point.set(position * 2 - 1, 0, depth).unproject(camera)
    right.setFromMatrixColumn(camera.matrixWorld, 0).normalize()
    after.setFromNormalAndCoplanarPoint(right, point)
    before.copy(after).negate()
  })
  return null
}

function MeasureLayer({ points, label, markerSize }: {
  points: THREE.Vector3[]
  label: string | null
  markerSize: number
}): JSX.Element | null {
  if (points.length === 0) return null
  const mid = points.length === 2 ? points[0].clone().add(points[1]).multiplyScalar(0.5) : null
  return (
    <group renderOrder={1000}>
      {points.map((p, i) => (
        <mesh key={i} position={p} raycast={() => null} renderOrder={1000}>
          <sphereGeometry args={[markerSize, 16, 16]} />
          <meshBasicMaterial color="#4ade80" depthTest={false} toneMapped={false} transparent />
        </mesh>
      ))}
      {points.length === 2 && (
        <Line points={[points[0], points[1]]} color="#4ade80" lineWidth={2} depthTest={false} renderOrder={1000} />
      )}
      {mid && label && (
        <Html position={mid} center zIndexRange={[30, 0]} style={{ pointerEvents: 'none' }}>
          <div className="px-2 py-0.5 rounded-md bg-zinc-950/90 border border-accent/50 text-[11px] font-mono text-accent-light whitespace-nowrap">
            {label}
          </div>
        </Html>
      )}
    </group>
  )
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState(): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-700 pointer-events-none">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.75">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
      </svg>
      <p className="mt-4 text-sm">3D model will appear here</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Viewer3D
// ---------------------------------------------------------------------------

type TransformSnapshot = { p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }

export default function Viewer3D({
  lightSettings = DEFAULT_LIGHT_SETTINGS,
  gizmoMode = null,
  gizmoUndoRef,
  pointLights = [],
  selectedPointLightId = null,
  onSelectPointLight,
  onPointLightsChange,
  realWorld = false,
}: {
  realWorld?: boolean
  lightSettings?: LightSettings
  gizmoMode?: GizmoMode | null
  gizmoUndoRef?: MutableRefObject<(() => boolean) | null>
  pointLights?: PointLight[]
  selectedPointLightId?: string | null
  onSelectPointLight?: (id: string | null) => void
  onPointLightsChange?: (lights: PointLight[]) => void
}): JSX.Element {
  const { currentJob } = useGeneration()
  const apiUrl = useAppStore((s) => s.apiUrl)

  const setStoreMeshStats = useAppStore((s) => s.setMeshStats)
  const meshStats = useAppStore((s) => s.meshStats)
  const setCurrentJob = useAppStore((s) => s.setCurrentJob)

  const [viewMode, setViewMode] = useState<ViewMode>('solid')
  const [autoRotate, setAutoRotate] = useState(false)
  const units = useAppStore((s) => s.units)
  const contactShadows = useAppStore((s) => s.contactShadows)
  const setContactShadows = useAppStore((s) => s.setContactShadows)
  const meshHistory = useAppStore((s) => s.meshHistory)
  const historyIndex = useAppStore((s) => s.historyIndex)

  // ── Diagnostics state ──
  const [compareActive, setCompareActive] = useState(false)
  const [compareAgainst, setCompareAgainst] = useState<'previous' | 'original'>('previous')
  const [wipe, setWipe] = useState(0.5)
  const [referenceObject, setReferenceObject] = useState<THREE.Object3D | null>(null)
  const [deviation, setDeviation] = useState<DeviationResult | null>(null)
  const [deviationBusy, setDeviationBusy] = useState(false)
  const [measureActive, setMeasureActive] = useState(false)
  const [measurePoints, setMeasurePoints] = useState<THREE.Vector3[]>([])
  const afterPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(1, 0, 0), 0), [])
  const beforePlane = useMemo(() => new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0), [])
  const wipeDragging = useRef(false)
  const viewerRef = useRef<HTMLDivElement | null>(null)
  const selected = useAppStore((s) => s.meshSelected)
  const setSelected = useAppStore((s) => s.setMeshSelected)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const splatRef = useRef<SplatViewerHandle | null>(null)

  const [meshObject, setMeshObject] = useState<THREE.Object3D | null>(null)

  // Local gizmo-transform history (live TRS), undoable with Ctrl+Z. A snapshot
  // is taken when a drag starts and committed on release only if it changed.
  const transformHistory = useRef<TransformSnapshot[]>([])
  const pendingTransform = useRef<TransformSnapshot | null>(null)

  const outputUrl = currentJob?.outputUrl ?? ''
  const modelUrl =
    currentJob?.status === 'done' && currentJob.outputUrl
      ? `${apiUrl}${currentJob.outputUrl}`
      : null

  // A .ply/.splat reaching the viewer is always a Gaussian splat here: mesh
  // plys are converted to GLB on import and workflow mesh outputs are .glb.
  const isSplat = /\.(ply|splat)$/i.test(outputUrl)

  // The splat viewer needs binary .splat — route raw workspace .ply through the
  // conversion endpoint; import URLs already point at a .splat via serve-file.
  const splatUrl = outputUrl.startsWith('/workspace/')
    ? `${apiUrl}/optimize/ply-to-splat?path=${encodeURIComponent(outputUrl.slice('/workspace/'.length))}`
    : modelUrl

  // The version the current mesh is compared against (wipe and heatmap).
  const referenceIndex = compareAgainst === 'original' ? 0 : historyIndex - 1
  const referenceMeshUrl = referenceIndex >= 0 && referenceIndex < historyIndex ? meshHistory[referenceIndex] : null
  const referenceModelUrl = referenceMeshUrl && referenceMeshUrl !== outputUrl && !/\.(ply|splat)$/i.test(referenceMeshUrl)
    ? `${apiUrl}${referenceMeshUrl}`
    : null
  const needsReference = !!referenceModelUrl && (compareActive || viewMode === 'deviation')

  // Reset view state when model changes
  useEffect(() => {
    setSelected(false)
    setViewMode((mode) => (mode === 'deviation' ? mode : 'solid'))
    setMeasurePoints([])
    setDeviation(null)
    setStoreMeshStats(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the model changes; setters are stable
  }, [modelUrl])

  // Heatmap: distances from the current mesh to the reference surface.
  useEffect(() => {
    if (viewMode !== 'deviation' || !meshObject || !referenceObject) { setDeviation(null); return }
    setDeviationBusy(true)
    // Let the "Computing…" state paint before the synchronous BVH pass.
    const timer = setTimeout(() => {
      try {
        setDeviation(computeDeviation(meshObject, referenceObject))
      } catch (err) {
        console.warn('[Viewer3D] deviation failed:', err)
        setDeviation(null)
      } finally {
        setDeviationBusy(false)
      }
    }, 30)
    return () => clearTimeout(timer)
  }, [viewMode, meshObject, referenceObject])

  useEffect(() => {
    if (!referenceModelUrl) {
      setCompareActive(false)
      setViewMode((mode) => (mode === 'deviation' ? 'solid' : mode))
    }
  }, [referenceModelUrl])

  // Measuring: Escape clears, leaving the tool clears.
  useEffect(() => { if (!measureActive) setMeasurePoints([]) }, [measureActive])

  const handlePick = useCallback((point: THREE.Vector3) => {
    setMeasurePoints((prev) => (prev.length >= 2 ? [point] : [...prev, point]))
  }, [])

  // Distances are taken in the model's own coordinates (gizmo pose undone),
  // so they match the file — metres when a real-world size is set.
  const measuredDistance = useMemo(() => {
    if (measurePoints.length !== 2 || !meshObject) return null
    const a = meshObject.worldToLocal(measurePoints[0].clone())
    const b = meshObject.worldToLocal(measurePoints[1].clone())
    return a.distanceTo(b)
  }, [measurePoints, meshObject])

  const modelSpan = Math.max(...(meshStats?.extents ?? [1, 1, 1]), 1e-3)

  function onWipePointer(e: React.PointerEvent) {
    const rect = viewerRef.current?.getBoundingClientRect()
    if (!rect) return
    setWipe(Math.min(0.98, Math.max(0.02, (e.clientX - rect.left) / rect.width)))
  }

  // Clear the shared selection when the viewer unmounts — the store would
  // otherwise keep it set and flash a stale selection on the next mount.
  useEffect(() => () => setSelected(false), [setSelected])

  // Delete key removes the model from the scene
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return
      if (document.activeElement instanceof HTMLInputElement) return
      if (!selected) return
      setCurrentJob(null)
      setSelected(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setSelected is a stable store setter
  }, [selected, setCurrentJob])

  // Deselect both mesh and point light when clicking empty space
  const handlePointerMissed = useCallback(() => {
    setSelected(false)
    onSelectPointLight?.(null)
  }, [setSelected, onSelectPointLight])

  // Select mesh and deselect any selected point light
  const handleMeshSelect = useCallback(() => {
    setSelected(true)
    onSelectPointLight?.(null)
  }, [setSelected, onSelectPointLight])

  const handleScreenshot = () => {
    const dataUrl = isSplat
      ? splatRef.current?.screenshot() ?? null
      : canvasRef.current?.toDataURL('image/png') ?? null
    if (!dataUrl) return
    const link = document.createElement('a')
    link.download = `polypal-${Date.now()}.png`
    link.href = dataUrl
    link.click()
  }

  // Snapshot the pre-drag pose when a gizmo manipulation starts.
  const handleGizmoDragStart = useCallback(() => {
    if (meshObject) {
      pendingTransform.current = {
        p: meshObject.position.clone(),
        q: meshObject.quaternion.clone(),
        s: meshObject.scale.clone(),
      }
    }
  }, [meshObject])

  // Commit the snapshot on release, but only if the pose actually changed.
  const handleGizmoDragEnd = useCallback(() => {
    const before = pendingTransform.current
    pendingTransform.current = null
    if (!before || !meshObject) return
    const changed = !meshObject.position.equals(before.p)
      || !meshObject.quaternion.equals(before.q)
      || !meshObject.scale.equals(before.s)
    if (changed) transformHistory.current.push(before)
  }, [meshObject])

  // Revert the most recent gizmo manipulation. Returns false when there is
  // nothing to undo, so the caller can fall back to the mesh-history undo.
  const undoTransform = useCallback((): boolean => {
    const prev = transformHistory.current.pop()
    if (!prev || !meshObject) return false
    meshObject.position.copy(prev.p)
    meshObject.quaternion.copy(prev.q)
    meshObject.scale.copy(prev.s)
    return true
  }, [meshObject])

  // Expose transform-undo so the page's Ctrl+Z undoes gizmo edits first.
  useEffect(() => {
    if (!gizmoUndoRef) return
    gizmoUndoRef.current = undoTransform
    return () => { if (gizmoUndoRef.current === undoTransform) gizmoUndoRef.current = null }
  }, [gizmoUndoRef, undoTransform])

  // Drop the transform history when the model changes.
  useEffect(() => {
    transformHistory.current = []
    pendingTransform.current = null
  }, [modelUrl])

  // Memoise the post-processing stack so its children stay referentially stable.
  // @react-three/postprocessing rebuilds (recompiles) all EffectPasses whenever the
  // <EffectComposer> children identity changes; without this, every Viewer3D re-render
  // (e.g. dragging a Lighting slider) recompiles the outline shader. The Outline still
  // tracks selection through the <Selection> context, so nothing here needs to depend
  // on render state.
  const postProcessing = useMemo(() => (
    <EffectComposer
      autoClear={false}
      multisampling={SELECTION_OUTLINE_MULTISAMPLING}
      resolutionScale={SELECTION_OUTLINE_RESOLUTION_SCALE}
      frameBufferType={THREE.HalfFloatType}
    >
      <Outline
        blur={SELECTION_OUTLINE_BLUR}
        edgeStrength={SELECTION_OUTLINE_EDGE_STRENGTH}
        visibleEdgeColor={SELECTION_OUTLINE_VISIBLE_COLOR}
        hiddenEdgeColor={SELECTION_OUTLINE_HIDDEN_COLOR}
        xRay={false}
      />
    </EffectComposer>
  ), [])


  return (
    <ModelErrorBoundary resetKey={modelUrl} fallback={<ModelLoadError />}>
      <div ref={viewerRef} className="relative w-full h-full bg-surface-400">
        {!modelUrl && <EmptyState />}

        {/* Splat path → fully isolated viewer (mkkellogg, outside R3F) */}
        {modelUrl && isSplat && splatUrl ? (
          <SplatViewer ref={splatRef} url={splatUrl} autoRotate={autoRotate} />
        ) : null}

        {/* Mesh path → original Canvas, unchanged */}
        {!isSplat && (
        <Canvas
          onPointerMissed={handlePointerMissed}
          camera={{ position: [0, 1.5, 4], fov: 45 }}
          dpr={[1, 2]}
          gl={{
            antialias: true,
            preserveDrawingBuffer: true,
            outputColorSpace: THREE.SRGBColorSpace,
            localClippingEnabled: true,
          }}
        >
          <color attach="background" args={['#18181b']} />
          <CanvasCapture domRef={canvasRef} />
          <ambientLight intensity={lightSettings.ambientIntensity ?? DEFAULT_LIGHT_SETTINGS.ambientIntensity} />
          <Environment background={false}>
            <Lightformer intensity={2 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[0, 4, 4]} scale={8} />
            <Lightformer intensity={0.5 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[-4, 2, -4]} scale={6} />
            <Lightformer intensity={0.3 * (lightSettings.envIntensity ?? DEFAULT_LIGHT_SETTINGS.envIntensity)} position={[4, 1, -4]} scale={6} />
          </Environment>

          <gridHelper args={[10, 20, '#3f3f46', '#27272a']} />

          {contactShadows && modelUrl && meshStats && (
            <ContactShadows
              position={[0, 0.0005, 0]}
              scale={Math.max(2, modelSpan * 3)}
              far={Math.max(0.5, (meshStats.extents?.[1] ?? 1) * 1.2)}
              blur={2.4}
              opacity={0.55}
              resolution={512}
              color="#000000"
            />
          )}

          {modelUrl && currentJob ? (
            <Selection enabled={selected}>
              {postProcessing}
              <Suspense fallback={null}>
                <directionalLight position={[5, 8, 5]} color={lightSettings.mainColor} intensity={lightSettings.mainIntensity} castShadow />
                <directionalLight position={[-4, 2, -4]} color={lightSettings.fillColor} intensity={lightSettings.fillIntensity} />
                <MeshModel
                  url={modelUrl}
                  jobId={currentJob.id}
                  viewMode={viewMode}
                  selected={selected}
                  onStats={setStoreMeshStats}
                  onSelect={handleMeshSelect}
                  onObject={setMeshObject}
                  clipPlane={compareActive && referenceModelUrl ? afterPlane : null}
                  deviation={deviation}
                  onPick={measureActive ? handlePick : undefined}
                />
              </Suspense>
              {needsReference && referenceModelUrl && (
                <Suspense fallback={null}>
                  <ReferenceModel
                    url={referenceModelUrl}
                    clipPlane={compareActive ? beforePlane : null}
                    visible={compareActive}
                    onObject={setReferenceObject}
                  />
                </Suspense>
              )}
            </Selection>
          ) : null}

          {compareActive && referenceModelUrl && <WipeController position={wipe} after={afterPlane} before={beforePlane} />}

          {measureActive && (
            <MeasureLayer
              points={measurePoints}
              markerSize={modelSpan * 0.008}
              label={measuredDistance === null ? null
                : realWorld ? formatLength(measuredDistance, units, 4) : `${formatNumber(measuredDistance, 4)} units`}
            />
          )}

          {/* Point light markers */}
          {onPointLightsChange && pointLights.map((pl) => (
            <PointLightMarker
              key={pl.id}
              light={pl}
              isSelected={pl.id === selectedPointLightId}
              gizmoMode={gizmoMode}
              onSelect={() => {
                setSelected(false)
                onSelectPointLight?.(pl.id)
              }}
              onPositionChange={(pos) => {
                onPointLightsChange!(pointLights.map((p) => p.id === pl.id ? { ...p, position: pos } : p))
              }}
            />
          ))}

          {selected && meshObject && gizmoMode === 'translate' && (
            <TranslateGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}
          {selected && meshObject && gizmoMode === 'rotate' && (
            <RotateGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}
          {selected && meshObject && gizmoMode === 'scale' && (
            <ScaleGizmo object={meshObject} onDragStart={handleGizmoDragStart} onDragEnd={handleGizmoDragEnd} />
          )}

          <OrbitControls
            makeDefault
            enablePan
            enableZoom
            enableRotate
            minDistance={0.5}
            maxDistance={20}
            autoRotate={autoRotate}
            autoRotateSpeed={1.5}
            enableDamping
            dampingFactor={0.05}
          />

          <GizmoHelper alignment="top-right" margin={[72, 72]} renderPriority={modelUrl && currentJob ? 2 : 0}>
            <GizmoBubbles />
          </GizmoHelper>
        </Canvas>
        )}

        {/* Left toolbar — visible only when a model is loaded */}
        {modelUrl && (
          <ViewerToolbar
            viewMode={viewMode}
            autoRotate={autoRotate}
            onViewMode={setViewMode}
            onAutoRotate={() => setAutoRotate((v) => !v)}
            onScreenshot={handleScreenshot}
            showViewModes={!isSplat}
            canCompare={!!referenceModelUrl}
            compareActive={compareActive}
            onCompare={() => setCompareActive((v) => !v)}
            measureActive={measureActive}
            onMeasure={() => setMeasureActive((v) => !v)}
            contactShadows={contactShadows}
            onContactShadows={() => setContactShadows(!contactShadows)}
          />
        )}

        {/* Before/after wipe handle */}
        {compareActive && referenceModelUrl && (
          <div className="absolute inset-0 pointer-events-none z-10">
            <div className="absolute top-0 bottom-0 w-px bg-accent-light/80" style={{ left: `${wipe * 100}%` }} />
            <div
              role="slider"
              aria-label="Before/after split"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(wipe * 100)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setWipe((w) => Math.max(0.02, w - 0.02))
                if (e.key === 'ArrowRight') setWipe((w) => Math.min(0.98, w + 0.02))
              }}
              onPointerDown={(e) => { wipeDragging.current = true; (e.target as HTMLElement).setPointerCapture(e.pointerId) }}
              onPointerMove={(e) => { if (wipeDragging.current) onWipePointer(e) }}
              onPointerUp={() => { wipeDragging.current = false }}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-zinc-900 border-2 border-accent-light shadow-lg flex items-center justify-center cursor-ew-resize pointer-events-auto"
              style={{ left: `${wipe * 100}%` }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5">
                <polyline points="9 6 3 12 9 18" /><polyline points="15 6 21 12 15 18" />
              </svg>
            </div>
            <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 pointer-events-auto">
              <span className="px-2 py-0.5 rounded bg-zinc-900/80 text-[10px] text-zinc-400">Before</span>
              <select
                value={compareAgainst}
                onChange={(e) => setCompareAgainst(e.target.value as 'previous' | 'original')}
                aria-label="Compare against"
                className="bg-zinc-900/90 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300"
              >
                <option value="previous">Previous version</option>
                <option value="original">Original</option>
              </select>
              <span className="px-2 py-0.5 rounded bg-zinc-900/80 text-[10px] text-accent-light">After</span>
            </div>
          </div>
        )}

        {/* Deviation legend */}
        {viewMode === 'deviation' && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-2 rounded-xl bg-zinc-900/85 border border-zinc-700/60 backdrop-blur-sm flex flex-col gap-1.5 min-w-[240px]">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Deviation from</span>
              <select
                value={compareAgainst}
                onChange={(e) => setCompareAgainst(e.target.value as 'previous' | 'original')}
                aria-label="Deviation reference"
                className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px] text-zinc-300"
              >
                <option value="previous">Previous version</option>
                <option value="original">Original</option>
              </select>
            </div>
            {deviationBusy || (!deviation && referenceModelUrl) ? (
              <p className="text-[11px] text-zinc-400">Computing…</p>
            ) : deviation ? (
              <>
                <div className="h-2 rounded-full" style={{ background: 'linear-gradient(90deg, rgb(18,92,84), rgb(33,196,94), rgb(250,191,36), rgb(240,69,69))' }} />
                <div className="flex justify-between text-[10px] font-mono text-zinc-400">
                  <span>0</span>
                  <span>{realWorld ? formatLength(deviation.scale, units) : `${formatNumber(deviation.scale)} u`}+</span>
                </div>
                <p className="text-[10px] text-zinc-500">
                  mean {realWorld ? formatLength(deviation.stats.mean, units) : formatNumber(deviation.stats.mean)}
                  {' · '}max {realWorld ? formatLength(deviation.stats.max, units) : formatNumber(deviation.stats.max)}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-zinc-500">No earlier version to compare with.</p>
            )}
          </div>
        )}

        {/* Measure hint */}
        {measureActive && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg bg-zinc-900/85 border border-zinc-700/60 text-[11px] text-zinc-300 pointer-events-none">
            {measurePoints.length < 2 ? `Click ${measurePoints.length === 0 ? 'two points' : 'a second point'} on the model to measure`
              : `Distance: ${measuredDistance !== null ? (realWorld ? formatLength(measuredDistance, units, 4) : `${formatNumber(measuredDistance, 4)} units`) : '—'} · click to start again`}
            {!realWorld && measurePoints.length === 2 && <span className="text-zinc-500"> (set a real-world size for true units)</span>}
          </div>
        )}

        {/* Bottom-left stats overlay */}
        {meshStats && (
          <div className="absolute bottom-4 left-4 pointer-events-none flex flex-col gap-0.5">
            {meshStats.extents && (
              <p className="text-xs text-zinc-400 font-mono" title={realWorld ? 'Real-world size (W × H × D)' : 'No real-world size set — open the Mesh Editor to set one'}>
                {realWorld ? formatDimensions(meshStats.extents, units) : formatUnitless(meshStats.extents)}
              </p>
            )}
            <p className="text-xs text-zinc-500">
              {meshStats.triangles.toLocaleString()} tri &bull; {meshStats.vertices.toLocaleString()} verts
            </p>
          </div>
        )}

        {/* Bottom-right hint */}
        {modelUrl && (
          <div className="absolute bottom-4 right-4 pointer-events-none">
            <p className="text-xs text-zinc-600">
              {selected
                ? <>Click mesh to select &bull; <span className="text-zinc-500">Delete</span> to remove</>
                : 'Drag to rotate \u2022 Scroll to zoom'
              }
            </p>
          </div>
        )}
      </div>
    </ModelErrorBoundary>
  )
}