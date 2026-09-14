import * as THREE from 'three';
import { HIGHLIGHT, SKY } from './config';
import { NO_POSITION, directionFromAltAz, type SkyFrame } from './sky-frame';
import type { FramePair } from './sky-stream';
import { pickNearest } from './picking';

/** The sky's own colour: the clear colour, and what the haze fades objects into. */
const SKY_COLOR = 0x05070a;

/**
 * Draw order of the transparent layers, back to front. Objects, their rings and the
 * trail sit under the haze, so they emerge together as they climb. The graticule and
 * compass labels sit above it, so the structure of the dome stays legible right down
 * to the horizon - move `graticule` below `haze` to let the haze swallow it too.
 */
const RENDER_ORDER = { points: 0, trail: 0, rings: 1, ground: 1, haze: 2, graticule: 3 } as const;

/** Horizontal coordinates to scene space, scaled. The mapping itself lives in sky-frame.ts. */
const scratch = [0, 0, 0];
export function altAzToVec3(azimuth: number, elevation: number, radius: number, out = new THREE.Vector3()) {
  directionFromAltAz(azimuth, elevation, scratch);
  return out.set(scratch[0]! * radius, scratch[1]! * radius, scratch[2]! * radius);
}

/**
 * Every object is drawn from TWO propagation ticks at once and blended on the GPU,
 * every frame, by one uniform. Ticks arrive a few times a second; the CPU work per
 * rendered frame is setting `uT`.
 *
 * Blending unit direction vectors and renormalising, rather than azimuth and
 * elevation, sidesteps the 359° -> 1° wrap entirely: there is no seam in a vector.
 *
 * This chunk is shared by the points and by the highlight rings, which draw the same
 * buffers through an index - so a ring can never drift from the object it encloses.
 *
 * position / aDir1  : unit direction from the observer at tick slot 0 / slot 1
 * aState0 / aState1 : x = shadow fraction, y = range km (negative = no position)
 */
const BLEND_GLSL = /* glsl */ `
  attribute vec3 aDir1;
  attribute vec2 aState0;
  attribute vec2 aState1;

  uniform float uT;
  uniform float uSinLowest;

  bool blendTicks(out vec3 dir, out float shadow, out float range) {
    dir = vec3(0.0);
    shadow = 0.0;
    range = 0.0;
    if (aState0.y < 0.0 || aState1.y < 0.0) return false;
    vec3 blended = mix(position, aDir1, uT);
    if (dot(blended, blended) < 1e-12) return false;
    dir = normalize(blended);
    if (dir.y < uSinLowest) return false;
    shadow = mix(aState0.x, aState1.x, uT);
    range = mix(aState0.y, aState1.y, uT);
    return true;
  }
`;

/** Outside clip space with zero size: the vertex draws nothing. */
const HIDE_GLSL = /* glsl */ `gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0;`;

/**
 * Appearance - above or below the horizon, lit or eclipsed, size by range - is
 * decided from the blended values, so an object changes colour exactly where it
 * crosses the horizon on screen, not at the next tick.
 */
const POINT_VERT = /* glsl */ `
  ${BLEND_GLSL}

  uniform float uRadius;
  uniform float uPixelRatio;
  uniform vec3 uColorLit;
  uniform vec3 uColorEclipsed;
  uniform vec3 uColorBelow;

  varying float vAlpha;
  varying vec3 vColor;

  void main() {
    vec3 dir;
    float shadow;
    float range;
    if (!blendTicks(dir, shadow, range)) {
      ${HIDE_GLSL}
      vAlpha = 0.0;
      vColor = vec3(0.0);
      return;
    }

    bool above = dir.y >= 0.0;
    bool lit = shadow < 0.5;

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

/**
 * Three kinds of ring share one draw, because they are all the same ring: the plain
 * white one the readout puts on whatever is highest, the amber one the pointer puts
 * on what it is touching, and the amber one a click leaves behind.
 *
 * Hover is a uniform compared against a static per-object index, so sweeping the
 * pointer across the sky uploads nothing at all. Marks are a per-object attribute,
 * re-uploaded on a click - rare enough that the whole column can go at once.
 *
 * A marked ring's brightness comes from the blended elevation, in the shader, so it
 * fades as the object descends in exact step with what is drawn, and in step with the
 * readout's ordering. Its row in the panel dims by the same curve.
 */
const RING_VERT = /* glsl */ `
  ${BLEND_GLSL}

  attribute float aIndex;
  attribute float aMark;

  uniform float uRadius;
  uniform float uPixelRatio;
  uniform float uRingPx;
  uniform float uHovered;
  uniform float uHoverScale;
  uniform vec3 uRingColor;
  uniform vec3 uMarkColor;
  uniform float uDimAtHorizon;
  uniform float uFullBright;

  varying float vSizePx;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec3 dir;
    float shadow;
    float range;
    if (!blendTicks(dir, shadow, range)) {
      ${HIDE_GLSL}
      vSizePx = 0.0;
      vColor = vec3(0.0);
      vAlpha = 0.0;
      return;
    }

    bool hovered = abs(aIndex - uHovered) < 0.5;
    bool marked = aMark > 0.5;

    float elevation = asin(clamp(dir.y, -1.0, 1.0));
    float bright = mix(uDimAtHorizon, 1.0, clamp(elevation / uFullBright, 0.0, 1.0));

    vColor = (hovered || marked) ? uMarkColor : uRingColor;
    vAlpha = hovered ? 1.0 : (marked ? bright : 1.0);

    vSizePx = uRingPx * (hovered ? uHoverScale : 1.0) * uPixelRatio;
    gl_PointSize = vSizePx;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(dir * uRadius, 1.0);
  }
`;

const RING_FRAG = /* glsl */ `
  uniform float uStrokePx;
  uniform float uPixelRatio;

  varying float vSizePx;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Work in device pixels so the stroke is the same width at any size, with a
    // one-pixel antialiased edge and a pixel of margin inside the sprite.
    float dist = length(gl_PointCoord - vec2(0.5)) * vSizePx;
    float stroke = uStrokePx * uPixelRatio;
    float ringRadius = 0.5 * vSizePx - 0.5 * stroke - 1.0;
    float alpha = 1.0 - smoothstep(-0.5, 0.5, abs(dist - ringRadius) - 0.5 * stroke);
    alpha *= vAlpha;
    if (alpha <= 0.0) discard;
    gl_FragColor = vec4(vColor, alpha);
  }
`;

/**
 * The haze is a band of sphere from the horizon to `topDeg`, sky-coloured, with its
 * opacity computed per pixel from the true elevation - so the gradient is smooth
 * however coarse the geometry.
 */
const HAZE_VERT = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HAZE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTop;

  varying vec3 vDirection;

  void main() {
    float elevation = asin(clamp(normalize(vDirection).y, -1.0, 1.0));
    float t = clamp(elevation / uTop, 0.0, 1.0);
    gl_FragColor = vec4(uColor, uOpacity * (1.0 - smoothstep(0.0, 1.0, t)));
    // Colour-managed like the clear colour, so a fully hazed patch is exactly the
    // sky rather than a slightly darker band.
    #include <colorspace_fragment>
  }
`;

/** Sunlit, above horizon: what you could actually see with the naked eye. */
const COLOR_LIT = new THREE.Color('#fff2d6');
/** In Earth's shadow: present, tracked, invisible to the eye. */
const COLOR_ECLIPSED = new THREE.Color('#86b4d2');
/** Below the horizon: on the other side of the world. */
const COLOR_BELOW = new THREE.Color('#3f5b6e');

/** How far a press may travel, in CSS pixels, and still count as a click. */
const DRAG_SLOP = 6;

/** The pointer over the sky. Coordinates are viewport, as the events give them. */
export interface PointerHandlers {
  hover(clientX: number, clientY: number): void;
  leave(): void;
  click(clientX: number, clientY: number): void;
}

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
  readonly rings: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms = {
    uT: { value: 0 },
    uRadius: { value: SKY.radius },
    uPixelRatio: { value: 1 },
    uSinLowest: { value: Math.sin(THREE.MathUtils.degToRad(SKY.showBelowHorizonDeg)) },
    uColorLit: { value: COLOR_LIT },
    uColorEclipsed: { value: COLOR_ECLIPSED },
    uColorBelow: { value: COLOR_BELOW },
  };

  private highlightIndex: THREE.BufferAttribute;
  private highlightCount = 0;
  /** Per-object 0/1: is this one stuck to the pointer's last click. */
  private markAttribute: THREE.BufferAttribute;
  private marked: number[] = [];
  private readonly ringUniforms;

  private trail: THREE.Line;
  private trailPositions: Float32Array;
  private trailCapacity: number;

  private yaw = 0;
  private pitch = THREE.MathUtils.degToRad(38);
  private pointer: PointerHandlers | null = null;
  private canvasRect: DOMRect;

  constructor(canvas: HTMLCanvasElement, count: number, trailCapacity = 4096) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(SKY_COLOR, 1);
    this.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();

    // Wide by default: the piece is about how much is up there, so seeing a large
    // slice of the dome at once matters more than an undistorted field of view.
    this.camera = new THREE.PerspectiveCamera(95, 1, 0.1, SKY.radius * 4);
    this.camera.position.set(0, 0, 0);

    const graticule = this.buildGraticule();
    graticule.renderOrder = RENDER_ORDER.graticule;
    this.scene.add(graticule);
    this.scene.add(this.buildGround());
    this.scene.add(this.buildHaze());

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

    // Both geometries hold the SAME attribute objects, so three.js uploads each tick
    // once and the rings read exactly the buffers the points do.
    const withTicks = (geom: THREE.BufferGeometry) => {
      // three.js sizes a non-indexed draw from `position`, so slot 0's directions go there.
      geom.setAttribute('position', this.slots[0].direction);
      geom.setAttribute('aDir1', this.slots[1].direction);
      geom.setAttribute('aState0', this.slots[0].state);
      geom.setAttribute('aState1', this.slots[1].state);
      return geom;
    };

    const pointsGeom = withTicks(new THREE.BufferGeometry());
    pointsGeom.setDrawRange(0, count);
    this.points = new THREE.Points(
      pointsGeom,
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
    this.points.renderOrder = RENDER_ORDER.points;
    this.scene.add(this.points);

    // --- highlight rings ----------------------------------------------------
    const ringsGeom = withTicks(new THREE.BufferGeometry());
    // Its own vertex id, so hover can be one uniform rather than an upload per move.
    const ids = new Float32Array(count);
    for (let i = 0; i < count; i++) ids[i] = i;
    ringsGeom.setAttribute('aIndex', new THREE.BufferAttribute(ids, 1));
    this.markAttribute = new THREE.BufferAttribute(new Float32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    ringsGeom.setAttribute('aMark', this.markAttribute);
    // A ring per object is the ceiling: the readout's rows, every mark, and the hover.
    this.highlightIndex = new THREE.BufferAttribute(new Uint32Array(count), 1).setUsage(THREE.DynamicDrawUsage);
    ringsGeom.setIndex(this.highlightIndex);
    ringsGeom.setDrawRange(0, 0);
    this.ringUniforms = {
      uT: this.uniforms.uT,
      uSinLowest: this.uniforms.uSinLowest,
      uRadius: this.uniforms.uRadius,
      uPixelRatio: this.uniforms.uPixelRatio,
      uRingPx: { value: HIGHLIGHT.diameterPx },
      uStrokePx: { value: HIGHLIGHT.strokePx },
      uRingColor: { value: new THREE.Color(HIGHLIGHT.color) },
      uMarkColor: { value: new THREE.Color(HIGHLIGHT.markColor) },
      uHovered: { value: -1 },
      uHoverScale: { value: HIGHLIGHT.hoverScale },
      uDimAtHorizon: { value: HIGHLIGHT.dimAtHorizon },
      uFullBright: { value: THREE.MathUtils.degToRad(HIGHLIGHT.fullBrightDeg) },
    };
    this.rings = new THREE.Points(
      ringsGeom,
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: this.ringUniforms,
        transparent: true,
        depthWrite: false,
      })
    );
    this.rings.frustumCulled = false;
    this.rings.renderOrder = RENDER_ORDER.rings;
    this.scene.add(this.rings);

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
    this.trail.renderOrder = RENDER_ORDER.trail;
    this.scene.add(this.trail);

    this.attachLook(canvas);
    this.canvasRect = canvas.getBoundingClientRect();
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

  /**
   * Ring these objects: what the readout lists, plus every mark, plus the hover.
   * Indices into the frame columns; only a change reaches the GPU, and a change is
   * a handful of integers.
   */
  setHighlights(indices: readonly number[]) {
    const index = this.highlightIndex.array as Uint32Array;
    const n = Math.min(indices.length, index.length);
    let changed = n !== this.highlightCount;
    for (let i = 0; i < n; i++) {
      if (index[i] !== indices[i]) {
        index[i] = indices[i]!;
        changed = true;
      }
    }
    if (!changed) return;
    this.highlightCount = n;
    this.highlightIndex.needsUpdate = true;
    this.rings.geometry.setDrawRange(0, n);
  }

  /**
   * Stick the amber ring to these objects and take it off the rest. Only a click
   * changes this, so re-uploading the whole column is cheaper than tracking ranges.
   */
  setMarks(marked: Iterable<number>): void {
    const mark = this.markAttribute.array as Float32Array;
    for (const i of this.marked) mark[i] = 0;
    this.marked = [...marked];
    for (const i of this.marked) if (i >= 0 && i < mark.length) mark[i] = 1;
    this.markAttribute.needsUpdate = true;
  }

  /** The object under the pointer, or -1. One uniform: a sweep uploads nothing. */
  setHovered(index: number): void {
    this.ringUniforms.uHovered.value = index;
  }

  /**
   * Which object is under these viewport coordinates, given what is on screen now.
   *
   * The canvas rectangle is the one taken at the last resize: reading it here would
   * flush layout inside the render loop, once per frame for as long as the pointer
   * is over the sky, and the canvas is fixed to the viewport anyway.
   */
  pickAt(pair: FramePair, clientX: number, clientY: number): number {
    return pickNearest({ camera: this.camera, rect: this.canvasRect }, pair, clientX, clientY, HIGHLIGHT.pickRadiusPx);
  }

  /** The pointer is over something takeable. */
  setPickCursor(over: boolean): void {
    this.renderer.domElement.classList.toggle('over', over);
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
    mesh.renderOrder = RENDER_ORDER.ground;
    return mesh;
  }

  /** Sky-coloured haze from the horizon up to SKY.haze.topDeg. */
  private buildHaze(): THREE.Mesh {
    const top = THREE.MathUtils.degToRad(SKY.haze.topDeg);
    // SphereGeometry measures theta down from +Y, so the band from elevation 0 to `top`
    // starts at theta = 90° - top and spans `top`.
    const geometry = new THREE.SphereGeometry(SKY.radius * 0.97, 128, 16, 0, Math.PI * 2, Math.PI / 2 - top, top);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.ShaderMaterial({
        vertexShader: HAZE_VERT,
        fragmentShader: HAZE_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color(SKY_COLOR) },
          uOpacity: { value: SKY.haze.horizonOpacity },
          uTop: { value: top },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.BackSide,
      })
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.haze;
    return mesh;
  }

  /** Where the pointer is, and what it took. Picking itself happens in main. */
  setPointerHandlers(handlers: PointerHandlers): void {
    this.pointer = handlers;
  }

  /**
   * Drag to look around, and the same gesture carries hover and click.
   *
   * The two have to be told apart by hand: the canvas fills the window, so every
   * click to take an object begins as a potential drag. A press that travels less
   * than DRAG_SLOP is a click; anything further was someone turning to look, and
   * must not mark whatever happened to be under the release.
   */
  private attachLook(canvas: HTMLCanvasElement) {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let travelled = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      travelled = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
      if (travelled < DRAG_SLOP) this.pointer?.click(e.clientX, e.clientY);
      // The view may have turned under a still pointer: re-read what is beneath it.
      this.pointer?.hover(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) {
        this.pointer?.hover(e.clientX, e.clientY);
        return;
      }
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      travelled += Math.abs(dx) + Math.abs(dy);
      this.yaw -= dx * 0.004;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + dy * 0.004,
        THREE.MathUtils.degToRad(-20),
        THREE.MathUtils.degToRad(89)
      );
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener('pointerleave', () => this.pointer?.leave());
    canvas.addEventListener('pointercancel', () => {
      dragging = false;
      this.pointer?.leave();
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.fov = THREE.MathUtils.clamp(this.camera.fov + e.deltaY * 0.03, 25, 130);
        this.camera.updateProjectionMatrix();
        // The sky just moved under a still pointer; what it is on has changed.
        this.pointer?.hover(e.clientX, e.clientY);
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
    this.canvasRect = this.renderer.domElement.getBoundingClientRect();
  }
}
