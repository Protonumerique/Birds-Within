import * as THREE from 'three';
import { SKY } from './config';
import { NO_POSITION, directionFromAltAz, type SkyFrame } from './sky-frame';
import type { FramePair } from './sky-stream';

/** Horizontal coordinates to scene space, scaled. The mapping itself lives in sky-frame.ts. */
const scratch = [0, 0, 0];
export function altAzToVec3(azimuth: number, elevation: number, radius: number, out = new THREE.Vector3()) {
  directionFromAltAz(azimuth, elevation, scratch);
  return out.set(scratch[0]! * radius, scratch[1]! * radius, scratch[2]! * radius);
}

/**
 * Every object is drawn from TWO propagation ticks at once and blended here, every
 * frame, by one uniform. Ticks arrive a few times a second; the CPU work per
 * rendered frame is setting `uT`. This is what removed the snapping.
 *
 * Blending unit direction vectors and renormalising, rather than azimuth and
 * elevation, sidesteps the 359° -> 1° wrap entirely: there is no seam in a vector.
 * Appearance - above or below the horizon, lit or eclipsed, size by range - is
 * decided from the blended values, so an object changes colour exactly where it
 * crosses the horizon on screen, not at the next tick.
 */
const POINT_VERT = /* glsl */ `
  // position / aDir1  : unit direction from the observer at tick slot 0 / slot 1
  // aState0 / aState1 : x = shadow fraction, y = range km (negative = no position)
  attribute vec3 aDir1;
  attribute vec2 aState0;
  attribute vec2 aState1;

  uniform float uT;
  uniform float uRadius;
  uniform float uPixelRatio;
  uniform float uSinLowest;
  uniform vec3 uColorLit;
  uniform vec3 uColorEclipsed;
  uniform vec3 uColorBelow;

  varying float vAlpha;
  varying vec3 vColor;

  void hide() {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    vColor = vec3(0.0);
  }

  void main() {
    if (aState0.y < 0.0 || aState1.y < 0.0) { hide(); return; }

    vec3 blended = mix(position, aDir1, uT);
    if (dot(blended, blended) < 1e-12) { hide(); return; }
    vec3 dir = normalize(blended);
    if (dir.y < uSinLowest) { hide(); return; }

    bool above = dir.y >= 0.0;
    bool lit = mix(aState0.x, aState1.x, uT) < 0.5;
    float range = mix(aState0.y, aState1.y, uT);

    vColor = above ? (lit ? uColorLit : uColorEclipsed) : uColorBelow;
    vAlpha = above ? (lit ? 1.0 : 0.6) : 0.3;

    // Nearer objects read as larger. Purely a depth cue - the dome has no scale.
    float nearness = clamp(1.0 - (range - 400.0) / 4000.0, 0.25, 1.0);
    gl_PointSize = (above ? 16.0 : 8.0) * nearness * uPixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * uRadius, 1.0);
  }
`;

const POINT_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    // Soft round sprite with a hot core, so dense clusters still read as many.
    // Blending is additive, which multiplies rgb by alpha and adds: intensity
    // therefore belongs in rgb, and the alpha channel stays at 1.
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = smoothstep(1.0, 0.0, r);
    float glow = pow(core, 2.5);
    gl_FragColor = vec4(vColor * (0.22 * core + 1.9 * glow) * vAlpha, 1.0);
  }
`;

/** Sunlit, above horizon: what you could actually see with the naked eye. */
const COLOR_LIT = new THREE.Color('#fff2d6');
/** In Earth's shadow: present, tracked, invisible to the eye. */
const COLOR_ECLIPSED = new THREE.Color('#86b4d2');
/** Below the horizon: on the other side of the world. */
const COLOR_BELOW = new THREE.Color('#3f5b6e');

interface TickSlot {
  direction: THREE.BufferAttribute;
  state: THREE.BufferAttribute;
  frame: SkyFrame | null;
}

export class SkyScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private slots: [TickSlot, TickSlot];
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms = {
    uT: { value: 0 },
    uRadius: { value: SKY.radius },
    uPixelRatio: { value: 1 },
    uSinLowest: { value: Math.sin(THREE.MathUtils.degToRad(SKY.showBelowHorizonDeg)) },
    uColorLit: { value: COLOR_LIT },
    uColorEclipsed: { value: COLOR_ECLIPSED },
    uColorBelow: { value: COLOR_BELOW },
  };

  private trail: THREE.Line;
  private trailPositions: Float32Array;
  private trailCapacity: number;

  private yaw = 0;
  private pitch = THREE.MathUtils.degToRad(38);

  constructor(canvas: HTMLCanvasElement, count: number, trailCapacity = 4096) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070a, 1);
    this.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();

    // Wide by default: the piece is about how much is up there, so seeing a large
    // slice of the dome at once matters more than an undistorted field of view.
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.1, SKY.radius * 4);
    this.camera.position.set(0, 0, 0);

    this.scene.add(this.buildGraticule());
    this.scene.add(this.buildGround());

    // --- satellites ---------------------------------------------------------
    const makeSlot = (): TickSlot => {
      const state = new Float32Array(count * 2);
      // Hidden until the first tick lands.
      for (let i = 0; i < count; i++) state[i * 2 + 1] = NO_POSITION;
      return {
        direction: new THREE.BufferAttribute(new Float32Array(count * 3), 3).setUsage(THREE.DynamicDrawUsage),
        state: new THREE.BufferAttribute(state, 2).setUsage(THREE.DynamicDrawUsage),
        frame: null,
      };
    };
    this.slots = [makeSlot(), makeSlot()];

    const geom = new THREE.BufferGeometry();
    // three.js sizes the draw from `position`, so slot 0's directions go there.
    geom.setAttribute('position', this.slots[0].direction);
    geom.setAttribute('aDir1', this.slots[1].direction);
    geom.setAttribute('aState0', this.slots[0].state);
    geom.setAttribute('aState1', this.slots[1].state);
    geom.setDrawRange(0, count);

    this.points = new THREE.Points(
      geom,
      new THREE.ShaderMaterial({
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // --- trail --------------------------------------------------------------
    this.trailCapacity = trailCapacity;
    this.trailPositions = new Float32Array(trailCapacity * 3);
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    trailGeom.setDrawRange(0, 0);
    this.trail = new THREE.Line(
      trailGeom,
      new THREE.LineBasicMaterial({ color: 0x7fa6bf, transparent: true, opacity: 0.6 })
    );
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.attachLook(canvas);
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /**
   * Show a pair of ticks blended by `t`. Uploads only a frame the GPU does not
   * already hold - normally one per tick, into whichever slot is now stale.
   */
  showFrames({ from, to, t }: FramePair) {
    const slotOf = (frame: SkyFrame) => (this.slots[0].frame === frame ? 0 : this.slots[1].frame === frame ? 1 : -1);
    let fromSlot = slotOf(from);
    let toSlot = slotOf(to);

    if (from === to) {
      if (fromSlot < 0) fromSlot = this.upload(0, from);
      this.uniforms.uT.value = fromSlot;
      return;
    }

    if (fromSlot < 0 && toSlot < 0) {
      fromSlot = this.upload(0, from);
      toSlot = this.upload(1, to);
    } else if (fromSlot < 0) {
      fromSlot = this.upload(1 - toSlot, from);
    } else if (toSlot < 0) {
      toSlot = this.upload(1 - fromSlot, to);
    }

    // uT always runs slot 0 -> slot 1, whichever of them is older.
    this.uniforms.uT.value = fromSlot === 0 ? t : 1 - t;
  }

  private upload(index: number, frame: SkyFrame): number {
    const slot = this.slots[index]!;
    (slot.direction.array as Float32Array).set(frame.direction);
    const state = slot.state.array as Float32Array;
    for (let i = 0; i < frame.count; i++) {
      state[i * 2] = frame.shadow[i]!;
      state[i * 2 + 1] = frame.range[i]!;
    }
    slot.direction.needsUpdate = true;
    slot.state.needsUpdate = true;
    slot.frame = frame;
    return index;
  }

  /** Horizon ring, almucantars and meridians - the only structure in the scene. */
  private buildGraticule(): THREE.Group {
    const group = new THREE.Group();
    const R = SKY.radius;
    const ring = (elevationDeg: number, opacity: number) => {
      const el = THREE.MathUtils.degToRad(elevationDeg);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 256; i++) {
        pts.push(altAzToVec3((i / 256) * Math.PI * 2, el, R));
      }
      return new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x4a6f8a, transparent: true, opacity })
      );
    };

    group.add(ring(0, 0.85));
    for (const el of [15, 30, 45, 60, 75]) group.add(ring(el, 0.16));

    for (let i = 0; i < 16; i++) {
      const az = (i / 16) * Math.PI * 2;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 48; j++) {
        pts.push(altAzToVec3(az, (j / 48) * (Math.PI / 2), R));
      }
      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({
            color: 0x4a6f8a,
            transparent: true,
            opacity: i % 4 === 0 ? 0.3 : 0.1,
          })
        )
      );
    }

    // Zenith: a small cross, so straight up is always locatable.
    const z = SKY.radius;
    const arm = SKY.radius * 0.035;
    group.add(
      new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-arm, z, 0),
          new THREE.Vector3(arm, z, 0),
          new THREE.Vector3(0, z, -arm),
          new THREE.Vector3(0, z, arm),
        ]),
        new THREE.LineBasicMaterial({ color: 0x7fa6bf, transparent: true, opacity: 0.5 })
      )
    );

    for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
      const sprite = this.makeLabel(label);
      altAzToVec3(THREE.MathUtils.degToRad(az), THREE.MathUtils.degToRad(3), R * 0.98, sprite.position);
      group.add(sprite);
    }

    return group;
  }

  private makeLabel(text: string): THREE.Sprite {
    const size = 128;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#8fb4cc';
    ctx.font = '600 46px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.65, depthWrite: false })
    );
    sprite.scale.setScalar(SKY.radius * 0.08);
    return sprite;
  }

  /** A dark disc at the horizon so "below" reads as ground rather than as sky. */
  private buildGround(): THREE.Mesh {
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(SKY.radius * 1.2, 96),
      new THREE.MeshBasicMaterial({
        color: 0x070b10,
        transparent: true,
        // Not opaque: objects on the far side of the Earth stay faintly present
        // through the ground rather than being cut away. That is the title.
        opacity: 0.72,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 1;
    return mesh;
  }

  /** Drag to look around. First-person, anchored at the observer. */
  private attachLook(canvas: HTMLCanvasElement) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.yaw -= (e.clientX - lastX) * 0.004;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + (e.clientY - lastY) * 0.004,
        THREE.MathUtils.degToRad(-20),
        THREE.MathUtils.degToRad(89)
      );
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 25, 130);
        this.camera.updateProjectionMatrix();
      },
      { passive: false }
    );
  }

  /** Draw one selected object's track across the dome, from unit directions. */
  setTrail(directions: Float32Array) {
    const R = SKY.radius * 0.995;
    const lowest = this.uniforms.uSinLowest.value;
    let n = 0;

    for (let i = 0; i + 2 < directions.length && n < this.trailCapacity; i += 3) {
      if (directions[i + 1]! < lowest) continue;
      this.trailPositions[n * 3] = directions[i]! * R;
      this.trailPositions[n * 3 + 1] = directions[i + 1]! * R;
      this.trailPositions[n * 3 + 2] = directions[i + 2]! * R;
      n++;
    }

    this.trail.geometry.setDrawRange(0, n);
    this.trail.geometry.attributes.position!.needsUpdate = true;
  }

  render() {
    const dir = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    this.camera.lookAt(dir);
    this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const w = innerWidth;
    const h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
