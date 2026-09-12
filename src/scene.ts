import * as THREE from 'three';
import { SKY } from './config';
import type { SkyState } from './sky';

/**
 * Horizontal coordinates to scene space.
 *
 * Azimuth runs from North through East, matching `ecfToLookAngles`. The scene is
 * right-handed with +Y up, +X East and -Z North, so the camera's default forward
 * (-Z) looks North on load.
 */
export function altAzToVec3(azimuth: number, elevation: number, radius: number, out = new THREE.Vector3()) {
  const cosEl = Math.cos(elevation);
  return out.set(
    Math.sin(azimuth) * cosEl * radius,
    Math.sin(elevation) * radius,
    -Math.cos(azimuth) * cosEl * radius
  );
}

const POINT_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize;
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

export class SkyScene {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;

  private points: THREE.Points;
  private positions: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private colors: Float32Array;

  private trail: THREE.Line;
  private trailPositions: Float32Array;
  private trailCapacity: number;

  private yaw = 0;
  private pitch = THREE.MathUtils.degToRad(38);

  constructor(canvas: HTMLCanvasElement, capacity: number, trailCapacity = 4096) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x05070a, 1);

    // Wide by default: the piece is about how much is up there, so seeing a large
    // slice of the dome at once matters more than an undistorted field of view.
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.1, SKY.radius * 4);
    this.camera.position.set(0, 0, 0);

    this.scene.add(this.buildGraticule());
    this.scene.add(this.buildGround());

    // --- satellites ---------------------------------------------------------
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.colors = new Float32Array(capacity * 3);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geom.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    geom.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    geom.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
    geom.setDrawRange(0, 0);

    this.points = new THREE.Points(
      geom,
      new THREE.ShaderMaterial({
        vertexShader: POINT_VERT,
        fragmentShader: POINT_FRAG,
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

  /** Push one frame of satellite states into the GPU buffers. */
  update(states: SkyState[]) {
    const geom = this.points.geometry;
    const R = SKY.radius;
    const belowLimit = THREE.MathUtils.degToRad(SKY.showBelowHorizonDeg);
    const v = new THREE.Vector3();
    let n = 0;

    for (const s of states) {
      if (s.elevation < belowLimit) continue;
      if (n * 3 + 2 >= this.positions.length) break;

      altAzToVec3(s.azimuth, s.elevation, R, v);
      this.positions[n * 3] = v.x;
      this.positions[n * 3 + 1] = v.y;
      this.positions[n * 3 + 2] = v.z;

      const above = s.elevation >= 0;
      const lit = s.shadow < 0.5;
      const colour = !above ? COLOR_BELOW : lit ? COLOR_LIT : COLOR_ECLIPSED;
      this.colors[n * 3] = colour.r;
      this.colors[n * 3 + 1] = colour.g;
      this.colors[n * 3 + 2] = colour.b;

      // Nearer objects read as larger. Purely a depth cue - the dome has no scale.
      const nearness = THREE.MathUtils.clamp(1 - (s.range - 400) / 4000, 0.25, 1);
      this.sizes[n] = (above ? 16 : 8) * nearness * this.renderer.getPixelRatio();
      this.alphas[n] = above ? (lit ? 1 : 0.6) : 0.3;

      n++;
    }

    geom.setDrawRange(0, n);
    geom.attributes.position!.needsUpdate = true;
    geom.attributes.aSize!.needsUpdate = true;
    geom.attributes.aAlpha!.needsUpdate = true;
    geom.attributes.aColor!.needsUpdate = true;
  }

  /** Draw the track of one selected object across the dome. */
  setTrail(track: { azimuth: number; elevation: number }[]) {
    const R = SKY.radius;
    const belowLimit = THREE.MathUtils.degToRad(SKY.showBelowHorizonDeg);
    const v = new THREE.Vector3();
    let n = 0;

    for (const p of track) {
      if (p.elevation < belowLimit) continue;
      if (n >= this.trailCapacity) break;
      altAzToVec3(p.azimuth, p.elevation, R * 0.995, v);
      this.trailPositions[n * 3] = v.x;
      this.trailPositions[n * 3 + 1] = v.y;
      this.trailPositions[n * 3 + 2] = v.z;
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
