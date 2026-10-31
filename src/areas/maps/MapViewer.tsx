// 3D preview of a built map. Doors are separate hinged nodes (with
// `polypal_door` extras from the GLB) — click one to swing it open or shut.
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls, useGLTF } from '@react-three/drei'
import { playSfx } from '@shared/utils/sfx'

interface DoorInfo { object: THREE.Object3D; base: THREE.Quaternion; swing: number; angle: number }

const Y = new THREE.Vector3(0, 1, 0)

function MapModel({ url, openDoors, onToggle, onHover }: {
  url: string
  openDoors: Record<string, boolean>
  onToggle: (name: string) => void
  onHover: (name: string | null) => void
}): JSX.Element {
  const { scene } = useGLTF(url)
  useEffect(() => () => useGLTF.clear(url), [url])

  const doors = useMemo(() => {
    const found = new Map<string, DoorInfo>()
    scene.traverse((obj) => {
      const extra = obj.userData?.polypal_door as { swing?: number; angle_deg?: number } | undefined
      if (extra) {
        found.set(obj.name, {
          object: obj,
          base: obj.quaternion.clone(),
          swing: extra.swing ?? 1,
          angle: THREE.MathUtils.degToRad(extra.angle_deg ?? 90),
        })
      }
      if ((obj as THREE.Mesh).isMesh) {
        obj.castShadow = true
        obj.receiveShadow = true
      }
    })
    return found
  }, [scene])

  const target = useRef(new THREE.Quaternion())
  useFrame((_, delta) => {
    const t = 1 - Math.pow(0.0015, delta)  // frame-rate independent ease
    doors.forEach((door, name) => {
      const open = openDoors[name] ? door.swing * door.angle : 0
      target.current.copy(door.base).multiply(new THREE.Quaternion().setFromAxisAngle(Y, open))
      door.object.quaternion.slerp(target.current, t)
    })
  })

  const doorName = (e: ThreeEvent<PointerEvent>): string | null => {
    let obj: THREE.Object3D | null = e.object
    while (obj) {
      if (doors.has(obj.name)) return obj.name
      obj = obj.parent
    }
    return null
  }

  return (
    <primitive
      object={scene}
      onPointerDown={(e: ThreeEvent<PointerEvent>) => {
        const name = doorName(e)
        if (!name) return
        e.stopPropagation()
        playSfx(openDoors[name] ? 'close' : 'open')
        onToggle(name)
      }}
      onPointerMove={(e: ThreeEvent<PointerEvent>) => onHover(doorName(e))}
      onPointerOut={() => onHover(null)}
    />
  )
}

export function MapViewer({ url, size, openDoors, onToggle }: {
  url: string
  size: [number, number, number]
  openDoors: Record<string, boolean>
  onToggle: (name: string) => void
}): JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null)
  const [w, , d] = size
  const center: [number, number, number] = [w / 2, 0, d / 2]
  const reach = Math.max(w, d)

  return (
    <div data-polypal-viewer className="relative h-full w-full" style={{ cursor: hovered ? 'pointer' : 'grab' }}>
      <Canvas shadows camera={{ position: [w / 2, reach * 1.0, d / 2 + reach * 1.05], fov: 45, near: 0.05, far: reach * 20 }} dpr={[1, 2]} gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <color attach="background" args={['#0f1512']} />
        <hemisphereLight args={['#f4f7f5', '#26302b', 0.9]} />
        <directionalLight
          position={[center[0] + reach * 0.4, reach, center[2] + reach * 0.3]}
          intensity={1.6}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-reach}
          shadow-camera-right={reach}
          shadow-camera-top={reach}
          shadow-camera-bottom={-reach}
          shadow-camera-far={reach * 4}
        />
        <Suspense fallback={null}>
          <MapModel url={url} openDoors={openDoors} onToggle={onToggle} onHover={setHovered} />
        </Suspense>
        <OrbitControls target={center} makeDefault maxPolarAngle={Math.PI / 2.05} enableDamping />
      </Canvas>
      {hovered && (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 animate-pop rounded-full bg-black/70 px-3 py-1 text-xs text-white backdrop-blur">
          Click to {openDoors[hovered] ? 'close' : 'open'} {hovered.replace('_', ' ')}
        </div>
      )}
    </div>
  )
}
