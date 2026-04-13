import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// World-space brush radii (model is scaled to ~2 units tall)
const BRUSH_RADII = { S: 0.002, M: 0.009, L: 0.022 };

// Max interpolation steps per mousemove event (per brush size)
const MAX_STEPS  = { S: 16, M: 8, L: 5 };

// NDC distance between interpolated sample points
const STEP_NDC   = { S: 0.003, M: 0.005, L: 0.010 };

export class Viewer3D {
  constructor(container) {
    this.container = container;
    this.scene      = null;
    this.camera     = null;
    this.renderer   = null;
    this.controls   = null;
    this.modelGroup = null;
    this.meshes     = [];
    this.annotatedFaces = new Map();   // meshIndex -> Set<faceIndex>
    this.faceCentroids  = new Map();   // meshIndex -> Float32Array (world-space cx,cy,cz…)

    this.currentTool = 'cursor';
    this.brushSize   = 'S';

    this.raycaster = new THREE.Raycaster();
    this.mouse     = new THREE.Vector2();
    this.lastNDC   = new THREE.Vector2();   // NDC of previous mousemove sample
    this.lastNDCSet = false;                 // whether lastNDC is valid

    this.isDrawing = false;
    this.isErasing = false;

    this.defaultColor = new THREE.Color(0.84, 0.72, 0.58);
    this.paintColor   = new THREE.Color(0.95, 0.18, 0.18);

    // Callbacks
    this.onLoadProgress    = null;
    this.onLoadComplete    = null;
    this.onLoadError       = null;
    this.onStatsReady      = null;
    this.onAnnotationChange = null;

    this._init();
  }

  // ── Setup ──────────────────────────────────────────────────
  _init() {
    const w = this.container.clientWidth  || 800;
    const h = this.container.clientHeight || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07090f);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 200);
    this.camera.position.set(0, 1.0, 3.5);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled   = true;
    this.renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace    = THREE.SRGBColorSpace;
    this.renderer.toneMapping         = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    this.scene.add(new THREE.HemisphereLight(0xddeeff, 0x443322, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(2, 5, 3); dir.castShadow = true;
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0x99aaff, 0.3);
    fill.position.set(-3, 1, -2);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(10, 20, 0x222233, 0x1a1a2e);
    grid.position.y = -1.05;
    this.scene.add(grid);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(0, 0.8, 0);
    this.controls.update();

    this._bindEvents();
    new ResizeObserver(() => this._onResize()).observe(this.container);
    this._animate();
  }

  _bindEvents() {
    const canvas = this.renderer.domElement;
    canvas.addEventListener('mousedown',   (e) => this._onDown(e));
    canvas.addEventListener('mousemove',   (e) => this._onMove(e));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mouseup', () => {
      this.isDrawing  = false;
      this.isErasing  = false;
      this.lastNDCSet = false; // reset interpolation state on release
    });
  }

  // ── Input handling ─────────────────────────────────────────
  _onDown(e) {
    if (this.currentTool !== 'pen') return;
    this.lastNDCSet = false; // start fresh interpolation from this click
    if (e.button === 0) { this.isDrawing = true;  this._paintAtEvent(e, false); }
    if (e.button === 2) { this.isErasing = true;  this._paintAtEvent(e, true);  }
  }

  _onMove(e) {
    if (this.currentTool !== 'pen') return;
    if (this.isDrawing) this._paintAtEvent(e, false);
    if (this.isErasing) this._paintAtEvent(e, true);
  }

  /** Convert a MouseEvent to NDC [-1,1]. */
  _eventToNDC(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x:  ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      y: -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    };
  }

  /**
   * Main paint dispatcher.
   * Interpolates between the last sampled NDC and the current event NDC,
   * casting one ray per intermediate sample to fill gaps when drawing fast.
   */
  _paintAtEvent(e, erase) {
    const { x: nx, y: ny } = this._eventToNDC(e);

    if (!this.lastNDCSet) {
      // First sample in this stroke — just paint here
      this._castAndPaint(nx, ny, erase);
      this.lastNDC.set(nx, ny);
      this.lastNDCSet = true;
    } else {
      const dx   = nx - this.lastNDC.x;
      const dy   = ny - this.lastNDC.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 1e-6) return; // no movement

      // Number of intermediate steps based on distance and brush size
      const steps = Math.min(
        Math.ceil(dist / STEP_NDC[this.brushSize]),
        MAX_STEPS[this.brushSize]
      );

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this._castAndPaint(
          this.lastNDC.x + dx * t,
          this.lastNDC.y + dy * t,
          erase
        );
      }
      this.lastNDC.set(nx, ny);
    }

    this.onAnnotationChange?.();
  }

  /**
   * Cast a single ray at (ndcX, ndcY). On hit, paint the hit face + any
   * faces within the brush radius using precomputed centroid data.
   */
  _castAndPaint(ndcX, ndcY, erase) {
    this.mouse.x = ndcX;
    this.mouse.y = ndcY;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(this.meshes, false);
    if (!hits.length) return;

    const { object: mesh, faceIndex, point: worldHit } = hits[0];

    // Always paint the exact hit face
    this._paintFace(mesh, faceIndex, erase);

    // For M and L, also paint all faces within the brush radius
    const radius = BRUSH_RADII[this.brushSize];
    if (radius > 0) {
      this._paintRadius(worldHit, erase, radius);
    }
  }

  /**
   * Paint all faces whose centroid is within `radius` world units of `worldPoint`.
   * Uses the precomputed Float32Array centroid map for performance.
   */
  _paintRadius(worldPoint, erase, radius) {
    const r2 = radius * radius;
    const hx = worldPoint.x, hy = worldPoint.y, hz = worldPoint.z;

    this.meshes.forEach((mesh) => {
      const cents = this.faceCentroids.get(mesh.userData.meshIndex);
      if (!cents) return;
      const fc = cents.length / 3;

      for (let i = 0; i < fc; i++) {
        const dx = cents[i * 3]     - hx;
        const dy = cents[i * 3 + 1] - hy;
        const dz = cents[i * 3 + 2] - hz;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          this._paintFace(mesh, i, erase);
        }
      }
    });
  }

  /** Set vertex colors for a single triangle face. */
  _paintFace(mesh, faceIndex, erase) {
    const attr = mesh.geometry.attributes.color;
    if (!attr) return;
    const col = erase ? this.defaultColor : this.paintColor;
    const v   = faceIndex * 3;
    attr.setXYZ(v,   col.r, col.g, col.b);
    attr.setXYZ(v+1, col.r, col.g, col.b);
    attr.setXYZ(v+2, col.r, col.g, col.b);
    attr.needsUpdate = true;

    const set = this.annotatedFaces.get(mesh.userData.meshIndex);
    if (set) erase ? set.delete(faceIndex) : set.add(faceIndex);
  }

  // ── Model Loading ──────────────────────────────────────────
  loadModel(url) {
    if (this.modelGroup) {
      this.scene.remove(this.modelGroup);
      this.modelGroup.traverse((c) => {
        if (!c.isMesh) return;
        c.geometry.dispose();
        (Array.isArray(c.material) ? c.material : [c.material]).forEach(m => m.dispose());
      });
    }
    this.meshes = [];
    this.annotatedFaces.clear();
    this.faceCentroids.clear();

    const loader = new OBJLoader();
    loader.load(
      url,
      (obj) => this._onLoaded(obj),
      (prog) => { if (prog.total > 0) this.onLoadProgress?.(prog.loaded / prog.total); },
      (err)  => { console.error(err); this.onLoadError?.(err); }
    );
  }

  _onLoaded(obj) {
    let meshIndex = 0;
    obj.traverse((child) => {
      if (!child.isMesh) return;

      child.userData.meshIndex = meshIndex++;
      child.geometry = child.geometry.toNonIndexed();
      child.geometry.computeVertexNormals();

      const count = child.geometry.attributes.position.count;
      const col   = new Float32Array(count * 3);
      const dc    = this.defaultColor;
      for (let i = 0; i < count; i++) { col[i*3]=dc.r; col[i*3+1]=dc.g; col[i*3+2]=dc.b; }
      child.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));

      child.material = new THREE.MeshStandardMaterial({
        vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0.05,
      });
      child.castShadow = true;

      this.meshes.push(child);
      this.annotatedFaces.set(child.userData.meshIndex, new Set());
    });

    // Center + scale
    const box    = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const scale  = 2.0 / Math.max(size.x, size.y, size.z);
    obj.scale.setScalar(scale);
    obj.position.set(-center.x*scale, -center.y*scale, -center.z*scale);

    this.modelGroup = obj;
    this.scene.add(obj);

    // Recentre orbit target
    const newCenter = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    this.controls.target.copy(newCenter);
    this.controls.update();

    // Precompute world-space centroids AFTER adding to scene (matrixWorld is valid)
    obj.updateMatrixWorld(true);
    this.meshes.forEach((mesh) => {
      this.faceCentroids.set(mesh.userData.meshIndex, this._computeCentroids(mesh));
    });

    const totalFaces = this.meshes.reduce(
      (s, m) => s + Math.floor(m.geometry.attributes.position.count / 3), 0
    );
    this.onStatsReady?.({ totalFaces });
    this.onLoadComplete?.();
  }

  /**
   * Precompute a Float32Array of world-space centroids for each triangle.
   * Layout: [cx0,cy0,cz0, cx1,cy1,cz1, ...]
   * This is O(n) and done once at load time.
   */
  _computeCentroids(mesh) {
    const pos = mesh.geometry.attributes.position;
    const fc  = Math.floor(pos.count / 3);
    const out = new Float32Array(fc * 3);
    const e   = mesh.matrixWorld.elements; // column-major

    for (let i = 0; i < fc; i++) {
      const p = i * 3;
      // Local centroid
      const lx = (pos.getX(p) + pos.getX(p+1) + pos.getX(p+2)) / 3;
      const ly = (pos.getY(p) + pos.getY(p+1) + pos.getY(p+2)) / 3;
      const lz = (pos.getZ(p) + pos.getZ(p+1) + pos.getZ(p+2)) / 3;
      // Transform to world space (column-major matrix4 × point)
      out[p]   = e[0]*lx + e[4]*ly + e[8]*lz  + e[12];
      out[p+1] = e[1]*lx + e[5]*ly + e[9]*lz  + e[13];
      out[p+2] = e[2]*lx + e[6]*ly + e[10]*lz + e[14];
    }
    return out;
  }

  // ── Public API ─────────────────────────────────────────────

  setTool(tool) {
    this.currentTool = tool;
    this.controls.enabled = (tool === 'cursor');
    this.container.classList.toggle('pen-mode', tool === 'pen');
    if (tool !== 'pen') this.lastNDCSet = false;
  }

  setBrushSize(size) {
    this.brushSize = size;
  }

  clearAnnotations() {
    this.meshes.forEach((mesh) => {
      const attr = mesh.geometry.attributes.color;
      const dc   = this.defaultColor;
      for (let i = 0; i < attr.count; i++) attr.setXYZ(i, dc.r, dc.g, dc.b);
      attr.needsUpdate = true;
      this.annotatedFaces.get(mesh.userData.meshIndex)?.clear();
    });
    this.onAnnotationChange?.();
  }

  getAnnotationData() {
    const out = {};
    this.meshes.forEach((mesh) => {
      const idx = mesh.userData.meshIndex;
      out[idx]  = Array.from(this.annotatedFaces.get(idx) || []);
    });
    return out;
  }

  loadAnnotationData(data) {
    if (!data || !this.meshes.length) return;
    Object.entries(data).forEach(([idxStr, faceIndices]) => {
      const meshIndex = parseInt(idxStr, 10);
      const mesh      = this.meshes.find(m => m.userData.meshIndex === meshIndex);
      if (!mesh || !Array.isArray(faceIndices)) return;
      faceIndices.forEach(fi => this._paintFace(mesh, fi, false));
    });
  }

  calculateBSA() {
    if (!this.meshes.length) return null;
    let total = 0, annotated = 0, totalFaces = 0, annFaces = 0;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const tri = new THREE.Triangle();

    this.meshes.forEach((mesh) => {
      mesh.updateMatrixWorld(true);
      const pos = mesh.geometry.attributes.position;
      const fc  = Math.floor(pos.count / 3);
      const ann = this.annotatedFaces.get(mesh.userData.meshIndex) || new Set();
      totalFaces += fc;
      annFaces   += ann.size;
      for (let i = 0; i < fc; i++) {
        a.fromBufferAttribute(pos, i*3  ).applyMatrix4(mesh.matrixWorld);
        b.fromBufferAttribute(pos, i*3+1).applyMatrix4(mesh.matrixWorld);
        c.fromBufferAttribute(pos, i*3+2).applyMatrix4(mesh.matrixWorld);
        tri.set(a, b, c);
        const area = tri.getArea();
        total += area;
        if (ann.has(i)) annotated += area;
      }
    });

    const pct = total > 0 ? (annotated / total) * 100 : 0;
    return { totalArea: total, annotatedArea: annotated, percentage: pct, totalFaces, annotatedFaces: annFaces };
  }

  // ── Internal ───────────────────────────────────────────────
  _onResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
