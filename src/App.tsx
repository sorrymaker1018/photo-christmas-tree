import { useState, useMemo, useRef, useEffect, useCallback, Suspense } from 'react';
import { Canvas, useFrame, extend, useThree } from '@react-three/fiber';
import {
  OrbitControls,
  PerspectiveCamera,
  shaderMaterial,
  Float,
  Stars,
  Sparkles
} from '@react-three/drei';
import { EffectComposer, Bloom, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { MathUtils } from 'three';
import * as random from 'maath/random';
import { GestureRecognizer, FilesetResolver, DrawingUtils } from "@mediapipe/tasks-vision";
import { addPhotos, clearPhotos as clearStoredPhotos, listPhotos, requestPersistence, type PhotoItem } from './photoStore';

// --- 设备分级：低配手机自动进入轻量模式 ---
const IS_SMALL_SCREEN = typeof window !== 'undefined'
  && window.matchMedia('(max-width: 820px)').matches;
// Chrome/Android 的 deviceMemory 只会报 0.5/1/2/4/8，≤2 基本就是 2–3GB 的低配机
const DEVICE_MEMORY = typeof navigator !== 'undefined' ? (navigator as any).deviceMemory as number | undefined : undefined;
const CPU_CORES = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
const FORCE_LITE = typeof location !== 'undefined' && new URLSearchParams(location.search).has('lite');
const FORCE_FULL = typeof location !== 'undefined' && new URLSearchParams(location.search).has('full');
const IS_LOW_END = FORCE_LITE || (!FORCE_FULL && IS_SMALL_SCREEN && ((DEVICE_MEMORY !== undefined && DEVICE_MEMORY <= 2) || CPU_CORES <= 4));

// --- 默认照片列表（用小尺寸图，省显存；用户上传后整体替换） ---
const BASE = import.meta.env.BASE_URL;
const DEFAULT_PHOTO_DIR = `${BASE}${IS_LOW_END ? 'photos-512' : 'photos-768'}`;
const DEFAULT_BODY_COUNT = IS_LOW_END ? 7 : 12;
const DEFAULT_PHOTO_PATHS = [
  `${DEFAULT_PHOTO_DIR}/top.jpg`,
  ...Array.from({ length: DEFAULT_BODY_COUNT }, (_, i) => `${DEFAULT_PHOTO_DIR}/${i + 1}.jpg`)
];

// --- 调试开关（URL 参数）：?nobloom=1 关闭辉光，?chaos=1 以散开状态启动，?lite=1 强制轻量模式 ---
const DEBUG_NO_BLOOM = typeof location !== 'undefined' && new URLSearchParams(location.search).has('nobloom');
const DEBUG_START_CHAOS = typeof location !== 'undefined' && new URLSearchParams(location.search).has('chaos');
const DEBUG_OPEN_VIEWER = typeof location !== 'undefined' && new URLSearchParams(location.search).has('viewer');

// --- 视觉配置 ---
const CONFIG = {
  colors: {
    emerald: '#004225', // 纯正祖母绿
    gold: '#FFD700',
    silver: '#ECEFF1',
    red: '#D32F2F',
    green: '#2E7D32',
    white: '#FFFFFF',   // 纯白色
    warmLight: '#FFD54F',
    lights: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'], // 彩灯
    // 拍立得边框颜色池 (复古柔和色系)
    borders: ['#FFFAF0', '#F0E68C', '#E6E6FA', '#FFB6C1', '#98FB98', '#87CEFA', '#FFDAB9'],
    // 圣诞元素颜色
    giftColors: ['#D32F2F', '#FFD700', '#1976D2', '#2E7D32'],
    candyColors: ['#FF0000', '#FFFFFF']
  },
  counts: {
    foliage: IS_LOW_END ? 3000 : IS_SMALL_SCREEN ? 6000 : 15000,
    ornaments: IS_LOW_END ? 36 : IS_SMALL_SCREEN ? 80 : 300,   // 拍立得数量
    elements: IS_LOW_END ? 36 : IS_SMALL_SCREEN ? 70 : 200,    // 圣诞元素
    lights: IS_LOW_END ? 80 : IS_SMALL_SCREEN ? 150 : 400,     // 彩灯
    stars: IS_LOW_END ? 1200 : IS_SMALL_SCREEN ? 3000 : 5000,  // 背景星空
    sparkles: IS_LOW_END ? 180 : IS_SMALL_SCREEN ? 400 : 600   // 漂浮光点
  },
  limits: {
    maxPhotos: IS_LOW_END ? 12 : 30,
    maxPhotoEdge: IS_LOW_END ? 420 : IS_SMALL_SCREEN ? 560 : 720
  },
  tree: { height: 22, radius: 9 }, // 树体尺寸
  photos: {
    body: DEFAULT_PHOTO_PATHS
  }
};

// 本机最多保存多少张照片（超出后自动丢弃最旧的）
const MAX_STORED_PHOTOS = IS_LOW_END ? 24 : 48;

// --- Shader Material (Foliage) ---
const FoliageMaterial = shaderMaterial(
  { uTime: 0, uColor: new THREE.Color(CONFIG.colors.emerald), uProgress: 0 },
  `uniform float uTime; uniform float uProgress; attribute vec3 aTargetPos; attribute float aRandom;
  varying vec2 vUv; varying float vMix;
  float cubicInOut(float t) { return t < 0.5 ? 4.0 * t * t * t : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0; }
  void main() {
    vUv = uv;
    vec3 noise = vec3(sin(uTime * 1.5 + position.x), cos(uTime + position.y), sin(uTime * 1.5 + position.z)) * 0.15;
    float t = cubicInOut(uProgress);
    vec3 finalPos = mix(position, aTargetPos + noise, t);
    vec4 mvPosition = modelViewMatrix * vec4(finalPos, 1.0);
    gl_PointSize = (60.0 * (1.0 + aRandom)) / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    vMix = t;
  }`,
  `uniform vec3 uColor; varying float vMix;
  void main() {
    float r = distance(gl_PointCoord, vec2(0.5)); if (r > 0.5) discard;
    vec3 finalColor = mix(uColor * 0.3, uColor * 1.2, vMix);
    gl_FragColor = vec4(finalColor, 1.0);
  }`
);
extend({ FoliageMaterial });

// --- Helper: Tree Shape ---
const getTreePosition = () => {
  const h = CONFIG.tree.height; const rBase = CONFIG.tree.radius;
  const y = (Math.random() * h) - (h / 2); const normalizedY = (y + (h/2)) / h;
  const currentRadius = rBase * (1 - normalizedY); const theta = Math.random() * Math.PI * 2;
  const r = Math.random() * currentRadius;
  return [r * Math.cos(theta), y, r * Math.sin(theta)];
};

// --- Component: Foliage ---
const Foliage = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const materialRef = useRef<any>(null);
  const { positions, targetPositions, randoms } = useMemo(() => {
    const count = CONFIG.counts.foliage;
    const positions = new Float32Array(count * 3); const targetPositions = new Float32Array(count * 3); const randoms = new Float32Array(count);
    const spherePoints = random.inSphere(new Float32Array(count * 3), { radius: 25 }) as Float32Array;
    for (let i = 0; i < count; i++) {
      positions[i*3] = spherePoints[i*3]; positions[i*3+1] = spherePoints[i*3+1]; positions[i*3+2] = spherePoints[i*3+2];
      const [tx, ty, tz] = getTreePosition();
      targetPositions[i*3] = tx; targetPositions[i*3+1] = ty; targetPositions[i*3+2] = tz;
      randoms[i] = Math.random();
    }
    return { positions, targetPositions, randoms };
  }, []);
  useFrame((rootState, delta) => {
    if (materialRef.current) {
      materialRef.current.uTime = rootState.clock.elapsedTime;
      const targetProgress = state === 'FORMED' ? 1 : 0;
      materialRef.current.uProgress = MathUtils.damp(materialRef.current.uProgress, targetProgress, 1.5, delta);
    }
  });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aTargetPos" args={[targetPositions, 3]} />
        <bufferAttribute attach="attributes-aRandom" args={[randoms, 1]} />
      </bufferGeometry>
      {/* @ts-ignore */}
      <foliageMaterial ref={materialRef} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

// --- 动态加载照片纹理（支持手机上传后即时替换） ---
const usePhotoTextures = (urls: string[]) => {
  const [textures, setTextures] = useState<THREE.Texture[]>([]);
  const prevRef = useRef<THREE.Texture[]>([]);
  useEffect(() => {
    let alive = true;
    const loader = new THREE.TextureLoader();
    const results: THREE.Texture[] = [];
    let pending = urls.length;
    if (!urls.length) {
      setTextures([]);
      const old = prevRef.current;
      prevRef.current = [];
      old.forEach((t) => t.dispose());
      return () => { alive = false; };
    }
    const finish = () => {
      if (!alive) return;
      const ready = results.filter(Boolean);
      if (!ready.length) return;
      const old = prevRef.current;
      prevRef.current = ready;
      setTextures(ready);
      // 新图已经生效后再释放旧纹理所占的显存
      if (old.length) setTimeout(() => old.forEach((t) => t.dispose()), 250);
    };
    urls.forEach((url, i) => {
      loader.load(url, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        results[i] = tex;
        pending -= 1;
        if (pending <= 0) finish();
      }, undefined, () => {
        pending -= 1;
        if (pending <= 0) finish();
      });
    });
    return () => { alive = false; };
  }, [urls]);
  return textures;
};

// --- Component: Photo Ornaments (Double-Sided Polaroid) ---
const PhotoOrnaments = ({ state, photoUrls, onSelect }: { state: 'CHAOS' | 'FORMED'; photoUrls: string[]; onSelect: (url: string) => void }) => {
  const textures = usePhotoTextures(photoUrls);
  const count = CONFIG.counts.ornaments;
  const groupRef = useRef<THREE.Group>(null);
  const lookTarget = useMemo(() => new THREE.Vector3(), []);

  const borderGeometry = useMemo(() => new THREE.PlaneGeometry(1.2, 1.5), []);
  const photoGeometry = useMemo(() => new THREE.PlaneGeometry(1, 1), []);

  const data = useMemo(() => {
    if (!textures.length) return [];
    return new Array(count).fill(0).map((_, i) => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*70, (Math.random()-0.5)*70, (Math.random()-0.5)*70);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.5;
      const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const isBig = Math.random() < 0.2;
      const baseScale = isBig
        ? (IS_SMALL_SCREEN ? 2.8 : 2.2)
        : (IS_SMALL_SCREEN ? 1.15 + Math.random() * 0.75 : 0.8 + Math.random() * 0.6);
      const weight = 0.8 + Math.random() * 1.2;
      const borderColor = CONFIG.colors.borders[Math.floor(Math.random() * CONFIG.colors.borders.length)];

      const rotationSpeed = {
        x: (Math.random() - 0.5) * 1.0,
        y: (Math.random() - 0.5) * 1.0,
        z: (Math.random() - 0.5) * 1.0
      };
      const chaosRotation = new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);

      return {
        chaosPos, targetPos, scale: baseScale, weight,
        textureIndex: i % textures.length,
        borderColor,
        currentPos: chaosPos.clone(),
        chaosRotation,
        rotationSpeed,
        wobbleOffset: Math.random() * 10,
        wobbleSpeed: 0.5 + Math.random() * 0.5
      };
    });
  }, [textures.length, count]);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;

    groupRef.current.children.forEach((group, i) => {
      const objData = data[i];
      if (!objData) return;
      const target = isFormed ? objData.targetPos : objData.chaosPos;

      objData.currentPos.lerp(target, delta * (isFormed ? 0.8 * objData.weight : 0.5));
      group.position.copy(objData.currentPos);

      if (isFormed) {
         lookTarget.set(group.position.x * 2, group.position.y + 0.5, group.position.z * 2);
         group.lookAt(lookTarget);

         const wobbleX = Math.sin(time * objData.wobbleSpeed + objData.wobbleOffset) * 0.05;
         const wobbleZ = Math.cos(time * objData.wobbleSpeed * 0.8 + objData.wobbleOffset) * 0.05;
         group.rotation.x += wobbleX;
         group.rotation.z += wobbleZ;

      } else {
         group.rotation.x += delta * objData.rotationSpeed.x;
         group.rotation.y += delta * objData.rotationSpeed.y;
         group.rotation.z += delta * objData.rotationSpeed.z;
      }
    });
  });

  if (!textures.length || !data.length) return null;

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => (
        <group
          key={i}
          scale={[obj.scale, obj.scale, obj.scale]}
          rotation={state === 'CHAOS' ? obj.chaosRotation : [0,0,0]}
          onClick={(e: any) => { e.stopPropagation(); onSelect(photoUrls[obj.textureIndex]); }}
        >
          {/* 正面 */}
          <group position={[0, 0, 0.015]}>
            <mesh geometry={photoGeometry}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={CONFIG.colors.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
              <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} />
            </mesh>
          </group>
          {/* 背面 */}
          <group position={[0, 0, -0.015]} rotation={[0, Math.PI, 0]}>
            <mesh geometry={photoGeometry}>
              <meshStandardMaterial
                map={textures[obj.textureIndex]}
                roughness={0.5} metalness={0}
                emissive={CONFIG.colors.white} emissiveMap={textures[obj.textureIndex]} emissiveIntensity={1.0}
                side={THREE.FrontSide}
              />
            </mesh>
            <mesh geometry={borderGeometry} position={[0, -0.15, -0.01]}>
              <meshStandardMaterial color={obj.borderColor} roughness={0.9} metalness={0} side={THREE.FrontSide} />
            </mesh>
          </group>
        </group>
      ))}
    </group>
  );
};

// --- Component: Christmas Elements ---
const ChristmasElements = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.elements;
  const groupRef = useRef<THREE.Group>(null);

  const boxGeometry = useMemo(() => new THREE.BoxGeometry(0.8, 0.8, 0.8), []);
  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(0.5, 16, 16), []);
  const caneGeometry = useMemo(() => new THREE.CylinderGeometry(0.15, 0.15, 1.2, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height;
      const y = (Math.random() * h) - (h / 2);
      const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) * 0.95;
      const theta = Math.random() * Math.PI * 2;

      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));

      const type = Math.floor(Math.random() * 3);
      let color; let scale = 1;
      if (type === 0) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.8 + Math.random() * 0.4; }
      else if (type === 1) { color = CONFIG.colors.giftColors[Math.floor(Math.random() * CONFIG.colors.giftColors.length)]; scale = 0.6 + Math.random() * 0.4; }
      else { color = Math.random() > 0.5 ? CONFIG.colors.red : CONFIG.colors.white; scale = 0.7 + Math.random() * 0.3; }

      const rotationSpeed = { x: (Math.random()-0.5)*2.0, y: (Math.random()-0.5)*2.0, z: (Math.random()-0.5)*2.0 };
      return { type, chaosPos, targetPos, color, scale, currentPos: chaosPos.clone(), chaosRotation: new THREE.Euler(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI), rotationSpeed };
    });
  }, [boxGeometry, sphereGeometry, caneGeometry]);

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    groupRef.current.children.forEach((child, i) => {
      const mesh = child as THREE.Mesh;
      const objData = data[i];
      if (!objData) return;
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 1.5);
      mesh.position.copy(objData.currentPos);
      mesh.rotation.x += delta * objData.rotationSpeed.x; mesh.rotation.y += delta * objData.rotationSpeed.y; mesh.rotation.z += delta * objData.rotationSpeed.z;
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => {
        let geometry; if (obj.type === 0) geometry = boxGeometry; else if (obj.type === 1) geometry = sphereGeometry; else geometry = caneGeometry;
        return ( <mesh key={i} scale={[obj.scale, obj.scale, obj.scale]} geometry={geometry} rotation={obj.chaosRotation}>
          <meshStandardMaterial color={obj.color} roughness={0.3} metalness={0.4} emissive={obj.color} emissiveIntensity={0.2} />
        </mesh> )})}
    </group>
  );
};

// --- Component: Fairy Lights ---
const FairyLights = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const count = CONFIG.counts.lights;
  const groupRef = useRef<THREE.Group>(null);
  const geometry = useMemo(() => new THREE.SphereGeometry(0.8, 8, 8), []);

  const data = useMemo(() => {
    return new Array(count).fill(0).map(() => {
      const chaosPos = new THREE.Vector3((Math.random()-0.5)*60, (Math.random()-0.5)*60, (Math.random()-0.5)*60);
      const h = CONFIG.tree.height; const y = (Math.random() * h) - (h / 2); const rBase = CONFIG.tree.radius;
      const currentRadius = (rBase * (1 - (y + (h/2)) / h)) + 0.3; const theta = Math.random() * Math.PI * 2;
      const targetPos = new THREE.Vector3(currentRadius * Math.cos(theta), y, currentRadius * Math.sin(theta));
      const color = CONFIG.colors.lights[Math.floor(Math.random() * CONFIG.colors.lights.length)];
      const speed = 2 + Math.random() * 3;
      return { chaosPos, targetPos, color, speed, currentPos: chaosPos.clone(), timeOffset: Math.random() * 100 };
    });
  }, []);

  useFrame((stateObj, delta) => {
    if (!groupRef.current) return;
    const isFormed = state === 'FORMED';
    const time = stateObj.clock.elapsedTime;
    groupRef.current.children.forEach((child, i) => {
      const objData = data[i];
      if (!objData) return;
      const target = isFormed ? objData.targetPos : objData.chaosPos;
      objData.currentPos.lerp(target, delta * 2.0);
      const mesh = child as THREE.Mesh;
      mesh.position.copy(objData.currentPos);
      const intensity = (Math.sin(time * objData.speed + objData.timeOffset) + 1) / 2;
      if (mesh.material) { (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = isFormed ? 3 + intensity * 4 : 0; }
    });
  });

  return (
    <group ref={groupRef}>
      {data.map((obj, i) => ( <mesh key={i} scale={[0.15, 0.15, 0.15]} geometry={geometry}>
          <meshStandardMaterial color={obj.color} emissive={obj.color} emissiveIntensity={0} toneMapped={false} />
        </mesh> ))}
    </group>
  );
};

// --- Component: Top Star (No Photo, Pure Gold 3D Star) ---
const TopStar = ({ state }: { state: 'CHAOS' | 'FORMED' }) => {
  const groupRef = useRef<THREE.Group>(null);

  const starShape = useMemo(() => {
    const shape = new THREE.Shape();
    const outerRadius = 1.3; const innerRadius = 0.7; const points = 5;
    for (let i = 0; i < points * 2; i++) {
      const radius = i % 2 === 0 ? outerRadius : innerRadius;
      const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
      i === 0 ? shape.moveTo(radius*Math.cos(angle), radius*Math.sin(angle)) : shape.lineTo(radius*Math.cos(angle), radius*Math.sin(angle));
    }
    shape.closePath();
    return shape;
  }, []);

  const starGeometry = useMemo(() => {
    return new THREE.ExtrudeGeometry(starShape, {
      depth: 0.4, // 增加一点厚度
      bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.1, bevelSegments: 3,
    });
  }, [starShape]);

  // 纯金材质
  const goldMaterial = useMemo(() => new THREE.MeshStandardMaterial({
    color: CONFIG.colors.gold,
    emissive: CONFIG.colors.gold,
    emissiveIntensity: 1.5, // 适中亮度，既发光又有质感
    roughness: 0.1,
    metalness: 1.0,
  }), []);

  useFrame((_, delta) => {
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.5;
      const targetScale = state === 'FORMED' ? 1 : 0;
      groupRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 3);
    }
  });

  return (
    <group ref={groupRef} position={[0, CONFIG.tree.height / 2 + 1.8, 0]}>
      <Float speed={2} rotationIntensity={0.2} floatIntensity={0.2}>
        <mesh geometry={starGeometry} material={goldMaterial} />
      </Float>
    </group>
  );
};

// --- Main Scene Experience ---
const Experience = ({ sceneState, rotationRef, photoUrls, onSelect }: { sceneState: 'CHAOS' | 'FORMED', rotationRef: { current: number }, photoUrls: string[], onSelect: (url: string) => void }) => {
  const controlsRef = useRef<any>(null);
  const size = useThree((s) => s.size);
  const isPortrait = size.height > size.width;
  const velRef = useRef(0);
  useFrame((_, delta) => {
    if (!controlsRef.current) return;
    // 手势速度做平滑插值，避免识别抖动导致画面一顿一顿
    const target = rotationRef.current;
    velRef.current += (target - velRef.current) * Math.min(1, delta * 10);
    // 没检测到手时恢复缓慢自转，不会看起来“冻住”
    const idle = sceneState === 'FORMED' && Math.abs(target) < 0.001 ? 0.0314 : 0;
    const speed = velRef.current + idle;
    if (Math.abs(speed) > 0.0005) {
      controlsRef.current.setAzimuthalAngle(controlsRef.current.getAzimuthalAngle() + speed * delta);
      controlsRef.current.update();
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault position={[0, 8, isPortrait ? 66 : 60]} fov={isPortrait ? 55 : 45} />
      <OrbitControls ref={controlsRef} enablePan={false} enableZoom={true} minDistance={30} maxDistance={120} autoRotate={false} maxPolarAngle={Math.PI / 1.7} />

      <color attach="background" args={['#000300']} />
      <Stars radius={100} depth={50} count={CONFIG.counts.stars} factor={4} saturation={0} fade speed={1} />

      <ambientLight intensity={0.4} color="#003311" />
      <pointLight position={[30, 30, 30]} intensity={100} color={CONFIG.colors.warmLight} />
      <pointLight position={[-30, 10, -30]} intensity={50} color={CONFIG.colors.gold} />
      <pointLight position={[0, -20, 10]} intensity={30} color="#ffffff" />

      <group position={[0, -6, 0]}>
        <Foliage state={sceneState} />
        <Suspense fallback={null}>
           <PhotoOrnaments state={sceneState} photoUrls={photoUrls} onSelect={onSelect} />
           <ChristmasElements state={sceneState} />
           <FairyLights state={sceneState} />
           <TopStar state={sceneState} />
        </Suspense>
        <Sparkles count={CONFIG.counts.sparkles} scale={50} size={8} speed={0.4} opacity={0.4} color={CONFIG.colors.silver} />
      </group>

      {!DEBUG_NO_BLOOM && !IS_LOW_END && (
        <EffectComposer>
          <Bloom luminanceThreshold={0.8} luminanceSmoothing={0.1} intensity={1.5} radius={0.5} mipmapBlur />
          <Vignette eskil={false} offset={0.1} darkness={1.2} />
        </EffectComposer>
      )}
    </>
  );
};

// --- Gesture Controller (本地模型 + 帧率节流 + 关键点兜底判定 + 手势缩放) ---
const GestureController = ({ onGesture, onMove, onStatus, onDetect, onPinch, pinchActive, debugMode, active }: any) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 用 ref 读调试开关，避免切换预览时把模型和摄像头重启
  const debugRef = useRef(debugMode);
  useEffect(() => { debugRef.current = debugMode; }, [debugMode]);

  // 看图模式下切换成“手势缩放”，用 ref 读取避免重开模型
  const pinchActiveRef = useRef(pinchActive);
  const smoothPinchRef = useRef(0);
  const pinchHandRef = useRef(false);
  useEffect(() => {
    pinchActiveRef.current = pinchActive;
    if (!pinchActive) {
      smoothPinchRef.current = 0;
      pinchHandRef.current = false;
      window.dispatchEvent(new Event('gesture-pinch-end'));
      onDetect('');
    }
  }, [pinchActive, onDetect]);

  useEffect(() => {
    if (!active) return;
    let gestureRecognizer: GestureRecognizer | undefined;
    let stream: MediaStream | undefined;
    let requestRef = 0;
    let videoFrameRef = 0;
    let cancelled = false;

    let lastVideoTime = -1;
    let lastProcessAt = 0;
    let candidate = '';
    let candidateHits = 0;
    let lastEmitAt = 0;
    let lastEmitted = '';

    const dist = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
    // 用 21 个手部关键点自己数伸出的手指，模型置信度低时兜底
    const countFingers = (lm: any) => {
      let n = 0;
      for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
        if (dist(lm[tip], lm[0]) > dist(lm[pip], lm[0]) * 1.12) n += 1;
      }
      if (dist(lm[4], lm[5]) > dist(lm[2], lm[5]) * 1.15) n += 1;
      return n;
    };

    const emit = (name: string) => {
      const now = performance.now();
      if (name === candidate) candidateHits += 1;
      else { candidate = name; candidateHits = 1; }
      if (candidateHits < 3) return;          // 连续 3 帧一致才触发，过滤抖动
      if (now - lastEmitAt < 700) return;     // 冷却，避免来回跳
      if (name === lastEmitted && now - lastEmitAt < 2500) return;
      lastEmitAt = now;
      lastEmitted = name;
      if (name === 'Closed_Fist') onGesture('FORMED');
      else if (name === 'Open_Palm') onGesture('CHAOS');
      onDetect(name);
    };

    const processFrame = (now: number) => {
      const video = videoRef.current;
      if (!gestureRecognizer || !video || !canvasRef.current) return;
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const results = gestureRecognizer.recognizeForVideo(video, now);

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        if (debugRef.current) {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (results.landmarks) {
            const drawingUtils = new DrawingUtils(ctx);
            for (const landmarks of results.landmarks) {
              drawingUtils.drawConnectors(landmarks, GestureRecognizer.HAND_CONNECTIONS, { color: '#FFD700', lineWidth: 2 });
              drawingUtils.drawLandmarks(landmarks, { color: '#FF0000', lineWidth: 1 });
            }
          }
        } else if (canvas.width > 1) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
      }

      const lm = results.landmarks?.[0];
      let name = '';
      let score = 0;
      if (results.gestures.length) {
        name = results.gestures[0][0].categoryName;
        score = results.gestures[0][0].score;
      }
      const pinching = !!pinchActiveRef.current;

      if (lm) {
        // 拇指尖(4) 与食指尖(8) 的距离 / 手掌尺寸 → 捏合张开程度（0.1≈捏紧，0.6≈完全张开）
        const handScale = dist(lm[0], lm[9]) || 0.001;
        const raw = dist(lm[4], lm[8]) / handScale;
        smoothPinchRef.current = smoothPinchRef.current
          ? smoothPinchRef.current * 0.8 + raw * 0.2
          : raw;

        if (pinching) {
          if (!pinchHandRef.current) { pinchHandRef.current = true; onDetect('PINCH'); }
          onMove(0);
          onPinch(smoothPinchRef.current);
          if (debugRef.current) onStatus(`手势缩放 ${smoothPinchRef.current.toFixed(2)} · 张开=放大`);
        } else {
          if (score < 0.6) {
            const fingers = countFingers(lm);
            if (fingers <= 1) { name = 'Closed_Fist'; score = 0.95; }
            else if (fingers >= 4) { name = 'Open_Palm'; score = 0.95; }
          }
          const speed = (0.5 - lm[0].x) * 0.24;   // 手掌左右位置 → 旋转速度
          onMove(Math.abs(speed) > 0.035 ? Math.max(-0.09, Math.min(0.09, speed)) : 0);
          if (debugRef.current) onStatus(`手指数 ${countFingers(lm)} · ${name || '—'} ${score.toFixed(2)}`);
        }
      } else {
        onMove(0);
        smoothPinchRef.current = 0;
        if (pinchHandRef.current) {
          pinchHandRef.current = false;
          window.dispatchEvent(new Event('gesture-pinch-end'));
        }
        if (debugRef.current) onStatus(pinching ? 'AI 就绪 · 手势缩放待检测' : 'AI 就绪 · 未检测到手');
      }

      if (!pinching && score >= 0.55 && (name === 'Closed_Fist' || name === 'Open_Palm')) emit(name);
    };

    const tick = () => {
      if (cancelled || document.hidden) return;
      const video = videoRef.current;
      if (!gestureRecognizer || !video) return;
      const now = performance.now();
      const interval = IS_LOW_END ? 100 : 70;          // 低配 10 帧/秒，普通 14 帧/秒
      if (now - lastProcessAt < interval) return;       // 节流，避免重复推理拖慢手机
      if (video.currentTime === lastVideoTime) return;  // 没有新视频帧就跳过
      lastVideoTime = video.currentTime;
      lastProcessAt = now;
      processFrame(now);
    };

    // 优先用 requestVideoFrameCallback：只在“真的有新画面”时推理，比 rAF 更省 CPU
    const schedule = () => {
      if (cancelled) return;
      const video = videoRef.current as any;
      if (!video) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        videoFrameRef = video.requestVideoFrameCallback(() => { tick(); schedule(); });
      } else {
        requestRef = requestAnimationFrame(() => { tick(); schedule(); });
      }
    };

    const setup = async () => {
      onStatus('加载手势模型中…');
      try {
        const vision = await FilesetResolver.forVisionTasks(`${BASE}mediapipe/wasm`);
        const makeRecognizer = (delegate: 'GPU' | 'CPU') => GestureRecognizer.createFromOptions(vision, {
          baseOptions: { modelAssetPath: `${BASE}models/gesture_recognizer.task`, delegate },
          runningMode: 'VIDEO',
          numHands: 1,
          // 调低门槛，手离得远一点、光线差一点也能先“抓住”手
          minHandDetectionConfidence: 0.4,
          minHandPresenceConfidence: 0.4,
          minTrackingConfidence: 0.4
        });
        // 低配机 CPU 推理通常比 GPU 更稳（不会和 3D 场景抢显存/带宽），高端机优先 GPU
        const preferred: 'GPU' | 'CPU' = IS_LOW_END ? 'CPU' : 'GPU';
        const fallback: 'GPU' | 'CPU' = preferred === 'GPU' ? 'CPU' : 'GPU';
        try { gestureRecognizer = await makeRecognizer(preferred); }
        catch { gestureRecognizer = await makeRecognizer(fallback); }
        if (cancelled) return;

        onStatus('请求摄像头权限…');
        stream = await navigator.mediaDevices.getUserMedia({
          video: IS_LOW_END
            ? { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } }
            : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
          audio: false
        });
        if (cancelled) return;
        const track = stream.getVideoTracks()[0];
        try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any); } catch { /* 部分机型不支持 */ }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          try { await videoRef.current.play(); } catch { /* ignore */ }
          onStatus('AI 就绪 · 把手放进画面');
          schedule();
        }
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
          onStatus('需要 HTTPS 才能使用摄像头');
        } else {
          onStatus(`ERROR: ${msg.slice(0, 70)}`);
        }
      }
    };

    setup();
    return () => {
      cancelled = true;
      cancelAnimationFrame(requestRef);
      const v = videoRef.current as any;
      if (v?.cancelVideoFrameCallback) { try { v.cancelVideoFrameCallback(videoFrameRef); } catch { /* ignore */ } }
      if (gestureRecognizer) {
        try { gestureRecognizer.close(); } catch { /* 释放模型内存 */ }
      }
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [active, onGesture, onMove, onStatus, onDetect, onPinch]);

  return (
    <>
      <video ref={videoRef} style={{ opacity: debugMode ? 0.65 : 0, position: 'fixed', top: 0, left: 0, width: debugMode ? '42vw' : '1px', zIndex: debugMode ? 100 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} playsInline muted autoPlay />
      <canvas ref={canvasRef} style={{ position: 'fixed', top: 0, left: 0, width: debugMode ? '42vw' : '1px', height: 'auto', zIndex: debugMode ? 101 : -1, pointerEvents: 'none', transform: 'scaleX(-1)' }} />
    </>
  );
};

// --- 照片放大查看（拖动旋转 / 双指缩放） ---
const PhotoViewer = ({ src, onClose }: { src: string; onClose: () => void }) => {
  const [view, setView] = useState({ rx: 0, ry: 0, s: 1 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchStart = useRef(0);
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  const gestureLast = useRef(0);
  const [shareTip, setShareTip] = useState('');
  const shareTimer = useRef<number | undefined>(undefined);

  const tip = (msg: string) => {
    setShareTip(msg);
    if (shareTimer.current) window.clearTimeout(shareTimer.current);
    shareTimer.current = window.setTimeout(() => setShareTip(''), 2400);
  };
  useEffect(() => () => { if (shareTimer.current) window.clearTimeout(shareTimer.current); }, []);

  const toBlob = async (): Promise<Blob | null> => {
    try {
      const res = await fetch(src);
      return await res.blob();
    } catch {
      return null;
    }
  };
  const doSave = async () => {
    const blob = await toBlob();
    if (!blob) { tip('无法读取这张照片'); return; }
    const name = `photo-${Date.now()}.jpg`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    tip('已保存到相册 / 下载目录');
  };
  const doShare = async () => {
    const blob = await toBlob();
    if (!blob) { tip('无法读取这张照片'); return; }
    const file = new File([blob], `photo-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
    const nav = navigator as any;
    if (nav.canShare && nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: '我的照片' });
      } catch (e: any) {
        if (!e || e.name !== 'AbortError') tip('分享未完成，可用“保存”');
      }
    } else {
      await doSave();
      tip('当前浏览器不支持直接分享，已改为保存');
    }
  };

  // 手势缩放：拇指与食指张开的比例直接驱动照片 scale（增量式，不需要“起始基准”）
  useEffect(() => {
    const onPinch = (e: any) => {
      const r = Number(e?.detail);
      if (!r || !Number.isFinite(r)) return;
      if (gestureLast.current === 0) { gestureLast.current = r; return; }
      const ratio = r / gestureLast.current;
      gestureLast.current = r;
      if (Math.abs(ratio - 1) < 0.02) return;   // 死区，过滤手抖
      setView((v) => ({ ...v, s: clamp(v.s * ratio, 0.6, 4) }));
    };
    const onEnd = () => { gestureLast.current = 0; };
    window.addEventListener('gesture-pinch', onPinch);
    window.addEventListener('gesture-pinch-end', onEnd);
    return () => {
      window.removeEventListener('gesture-pinch', onPinch);
      window.removeEventListener('gesture-pinch-end', onEnd);
    };
  }, []);

  const distance = () => {
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  const down = (e: any) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) pinchStart.current = distance();
    e.currentTarget?.setPointerCapture?.(e.pointerId);
  };
  const move = (e: any) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      setView((v) => ({ ...v, ry: v.ry + dx * 0.5, rx: clamp(v.rx - dy * 0.5, -75, 75) }));
    } else if (pointers.current.size === 2) {
      const d = distance();
      if (pinchStart.current > 0 && d > 0) {
        const ratio = d / pinchStart.current;
        setView((v) => ({ ...v, s: clamp(v.s * ratio, 0.6, 4) }));
        pinchStart.current = d;
      }
    }
  };
  const up = (e: any) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = 0;
  };

  return (
    <div className="viewer" onClick={onClose}>
      <button className="viewer-close" onClick={onClose} aria-label="关闭">×</button>
      <div
        className="viewer-stage"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onWheel={(e) => { e.preventDefault(); setView((v) => ({ ...v, s: clamp(v.s - e.deltaY * 0.0015, 0.6, 4) })); }}
      >
        <img
          className="viewer-img"
          src={src}
          alt=""
          draggable={false}
          style={{ transform: `perspective(1200px) rotateX(${view.rx}deg) rotateY(${view.ry}deg) scale(${view.s})` }}
        />
      </div>
      <div className="viewer-actions" onClick={(e) => e.stopPropagation()}>
        <button className="chip" onClick={doSave}>保存</button>
        <button className="chip primary" onClick={doShare}>分享</button>
      </div>
      {shareTip && <div className="viewer-tip">{shareTip}</div>}
      <p className="viewer-hint">拖动旋转 · 双指或滚轮缩放<br />手势开启时：拇指食指张开放大 / 收拢缩小</p>
    </div>
  );
};

// --- 手机照片压缩（避免大图撑爆显存；产出 Blob 便于保存到本机） ---
type Compressed = { blob: Blob; width: number; height: number };
const compressImage = async (file: File): Promise<Compressed> => {
  const MAX_EDGE = CONFIG.limits.maxPhotoEdge;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.82);
    });
    return { blob, width: canvas.width, height: canvas.height };
  } catch {
    // 兜底：个别机型不支持 createImageBitmap（如部分 HEIC），直接用原文件
    return { blob: file, width: 0, height: 0 };
  }
};

// --- App Entry ---
export default function GrandTreeApp() {
  const [sceneState, setSceneState] = useState<'CHAOS' | 'FORMED'>(DEBUG_START_CHAOS ? 'CHAOS' : 'FORMED');
  const rotationRef = useRef(0);
  const [aiStatus, setAiStatus] = useState("手势未开启");
  const [debugMode, setDebugMode] = useState(false);
  const [gestureOn, setGestureOn] = useState(false);
  const [photoUrls, setPhotoUrls] = useState<string[]>(DEFAULT_PHOTO_PATHS);
  const [uploading, setUploading] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [saveHint, setSaveHint] = useState('');
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(DEBUG_OPEN_VIEWER ? DEFAULT_PHOTO_PATHS[1] : null);
  const [detectedName, setDetectedName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const urlByIdRef = useRef<Map<number, string>>(new Map());

  // 把照片集合同步到画面；objectURL 按 id 复用，避免重复解码
  const applyPhotoSet = useCallback((items: PhotoItem[]) => {
    const next: string[] = [];
    const keepIds = new Set<number>();
    for (const it of items) {
      const id = it.id as number;
      if (typeof id !== 'number') continue;
      keepIds.add(id);
      let url = urlByIdRef.current.get(id);
      if (!url) {
        url = URL.createObjectURL(it.blob);
        urlByIdRef.current.set(id, url);
      }
      next.push(url);
    }
    for (const [id, url] of Array.from(urlByIdRef.current)) {
      if (!keepIds.has(id)) {
        URL.revokeObjectURL(url);
        urlByIdRef.current.delete(id);
      }
    }
    setPhotoUrls(next.length ? next : DEFAULT_PHOTO_PATHS);
    setUploadCount(next.length);
    setSceneState('FORMED');
  }, []);

  // 打开页面先读本机照片库：有就用自己的照片，没有就用示例图
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const saved = await listPhotos();
        if (!alive || !saved.length) return;
        applyPhotoSet(saved);
      } catch {
        // 隐私模式 / 浏览器不支持时静默降级
      }
    })();
    return () => {
      alive = false;
      for (const url of Array.from(urlByIdRef.current.values())) URL.revokeObjectURL(url);
      urlByIdRef.current.clear();
    };
  }, [applyPhotoSet]);

  // 保存结果提示 2.6 秒后自动消失
  useEffect(() => {
    if (!saveHint) return;
    const t = window.setTimeout(() => setSaveHint(''), 2600);
    return () => window.clearTimeout(t);
  }, [saveHint]);

  const clearMyPhotos = async () => {
    if (!uploadCount) return;
    if (!window.confirm('清空本机保存的照片？手机相册里的原图不会被删除。')) return;
    try {
      await clearStoredPhotos();
    } catch {
      // ignore
    }
    for (const url of Array.from(urlByIdRef.current.values())) URL.revokeObjectURL(url);
    urlByIdRef.current.clear();
    setPhotoUrls(DEFAULT_PHOTO_PATHS);
    setUploadCount(0);
    setSaveHint('已清空，恢复为示例照片');
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setUploading(true);
    try {
      const picked: File[] = [];
      for (const f of Array.from(files)) {
        if (f.type.startsWith('image/') && picked.length < CONFIG.limits.maxPhotos) picked.push(f);
      }
      if (!picked.length) return;
      const items: Omit<PhotoItem, 'id' | 'addedAt'>[] = [];
      for (const f of picked) {
        const c = await compressImage(f);
        items.push({ name: f.name, type: c.blob.type || 'image/jpeg', blob: c.blob, width: c.width, height: c.height });
      }
      let stored: PhotoItem[] | null = null;
      try {
        stored = await addPhotos(items, MAX_STORED_PHOTOS);
        void requestPersistence();
      } catch {
        stored = null;
      }
      if (stored && stored.length) {
        applyPhotoSet(stored);
        setSaveHint(`已存入本机 ${items.length} 张 · 共 ${stored.length} 张`);
      } else {
        // 浏览器不允许持久化时，退化为仅本次会话可见
        applyPhotoSet(items.map((it, i) => ({ ...it, id: -(Date.now() + i), addedAt: Date.now() } as PhotoItem)));
        setSaveHint('浏览器不允许本地保存，本次仅临时显示');
      }
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDetect = useCallback((name: string) => {
    setDetectedName(
      name === 'Closed_Fist' ? '握拳 · 聚成树'
        : name === 'Open_Palm' ? '张开手掌 · 散开'
          : name === 'PINCH' ? '手势缩放 · 张开放大'
            : ''
    );
  }, []);

  // 手势数据走 ref / 事件，不触发 React 重渲染，保证画面流畅
  const handleMove = useCallback((v: number) => { rotationRef.current = v; }, []);
  const handlePinch = useCallback((ratio: number) => {
    window.dispatchEvent(new CustomEvent('gesture-pinch', { detail: ratio }));
  }, []);

  const toggleGesture = () => {
    setGestureOn((v) => {
      const next = !v;
      setAiStatus(next ? "正在加载…" : "手势未开启");
      return next;
    });
  };

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#000', position: 'relative', overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0, zIndex: 1 }}>
        <Canvas
          dpr={IS_LOW_END ? [1, 1] : IS_SMALL_SCREEN ? [1, 1.4] : [1, 2]}
          gl={{ toneMapping: THREE.ReinhardToneMapping, powerPreference: 'high-performance', antialias: !IS_LOW_END }}
          shadows={!IS_LOW_END}
        >
            <Experience sceneState={sceneState} rotationRef={rotationRef} photoUrls={photoUrls} onSelect={setSelectedPhoto} />
        </Canvas>
      </div>
      <GestureController
        onGesture={setSceneState}
        onMove={handleMove}
        onStatus={setAiStatus}
        onDetect={handleDetect}
        onPinch={handlePinch}
        pinchActive={!!selectedPhoto}
        debugMode={debugMode}
        active={gestureOn}
      />

      {/* 左上角信息 */}
      {IS_LOW_END && <div className="hud-lite">轻量模式</div>}
      <div className="hud-stats">
        <p className="hud-label">Memories</p>
        <p className="hud-value">{uploadCount || DEFAULT_PHOTO_PATHS.length} <span>POLAROIDS</span></p>
      </div>

      {/* 顶部 AI 状态 */}
      <div className="hud-status" style={{ color: aiStatus.includes('ERROR') || aiStatus.includes('需要') ? '#ff5555' : 'rgba(255,215,0,0.55)' }}>
        {aiStatus}
      </div>

      {gestureOn && detectedName && (
        <div className="hud-detected">{detectedName}</div>
      )}

      {saveHint && <div className="hud-saved">{saveHint}</div>}

      <div className="hud-hint">
        {gestureOn
          ? '握拳聚树 · 张开散开 · 左右移动旋转 · 点照片放大'
          : '拖动旋转 · 双指缩放 · 点照片放大查看'}
      </div>

      {selectedPhoto && <PhotoViewer src={selectedPhoto} onClose={() => setSelectedPhoto(null)} />}

      {/* 底部操作栏 */}
      <div className="hud-bottom">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleFiles(e.target.files)}
        />
        <button className="chip primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? '导入中…' : '＋ 导入照片'}
        </button>
        {uploadCount > 0 && (
          <button className="chip subtle" onClick={clearMyPhotos}>清空照片</button>
        )}
        <button className="chip" onClick={() => setSceneState((s) => s === 'CHAOS' ? 'FORMED' : 'CHAOS')}>
          {sceneState === 'CHAOS' ? '聚成树' : '散开'}
        </button>
        <button className={`chip ${gestureOn ? 'on' : ''}`} onClick={toggleGesture}>
          {gestureOn ? '手势 ON' : '手势 OFF'}
        </button>
        <button className="chip" onClick={() => setDebugMode((v) => !v)}>
          {debugMode ? '隐藏预览' : '摄像头预览'}
        </button>
      </div>
    </div>
  );
}
