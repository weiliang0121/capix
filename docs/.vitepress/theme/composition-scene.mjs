import * as THREE from 'three';

const fieldSize = 10.8;
const clusterDiameter = 3.2;
const fieldRevealStart = 1.6;
const fieldRevealDuration = 1.9;
const releaseStart = 4.6;
const formationDuration = 5.5;
const formationTime = releaseStart + formationDuration;
// Keep the established reorganization and orbital phases when extending the introduction.
const formationOrbitTime = 7.7;
const orbitHeight = 0.42;
const fieldLevel = -0.22;
const orbitRevealDuration = 0.2;
const orbitSpeed = 1.6;
const orbitAccelerationDuration = 0.8;
const clamp = (value) => Math.max(0, Math.min(1, value));
const smooth = (value) => value * value * (3 - 2 * value);
const ease = (value) => value * value * value * (value * (value * 6 - 15) + 10);
// The opening is one continuous reveal. These later anchors follow the descent and settle.
const cameraShots = [
  { time: releaseStart, azimuth: 30, elevation: 24, target: 1.2, span: 10.8 },
  { time: 6.4, azimuth: 38, elevation: 27, target: 0.25, span: 10.6 },
  { time: formationTime + 0.3, azimuth: 62, elevation: 42, target: -0.12, span: 11.4 },
];

// A single introduction recomposes the same finite set of bodies, then orbits indefinitely. Sizes and orbital periods are illustrative,
// not an astronomical scale model or an N-body simulation.
export function createCompositionScene(host, callbacks) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-8, 8, 6.35, -6.35, 0.1, 100);
  const geometries = new Set();
  const materials = new Set();
  const fieldSources = [];
  const orbitGuides = [];
  const formationAngles = [];
  const suspended = [
    [0, -0.1, 3.55],
    [-1.35, -0.55, 3],
    [-0.75, -0.45, 3.15],
    [0.65, -0.5, 3.1],
    [1.25, -0.7, 3],
    [-1.35, 0.05, 3.65],
    [-1.25, -0.1, 4.1],
    [0.9, 0.25, 3.8],
    [-0.4, -0.6, 4.05],
    [0.15, 0.55, 4],
    [-0.65, 0.2, 3.95],
    [0.3, -0.6, 3.05],
    [1.3, 0.65, 4.05],
    [1.35, -0.3, 3.5],
    [-0.3, 0.6, 3.1],
  ];
  const bodies = [];
  const position = new THREE.Vector3();
  const destination = new THREE.Vector3();
  const color = new THREE.Color();
  // The same fifteen bodies are released together and reorganized into these roles.
  // Primary orbits separate the full radial envelopes of moons and rings, so the
  // steady system remains collision-free for arbitrarily long playback.
  const specs = [
    { name: 'sun', radius: 0.31, orbit: 0, omega: 0, phase: 0, spin: 0.09, parent: -1 },
    { name: 'mercury', radius: 0.065, orbit: 0.55, omega: 0.43, phase: 1.4, spin: 0.12, parent: 0 },
    { name: 'venus', radius: 0.09, orbit: 0.76, omega: 0.31, phase: 4.8, spin: -0.07, parent: 0 },
    { name: 'earth', radius: 0.105, orbit: 1.17, omega: 0.23, phase: 2.3, spin: 0.32, parent: 0 },
    { name: 'moon', attractionLead: -0.15, radius: 0.052, orbit: 0.21, omega: 0.95, phase: 0.4, spin: 0.12, parent: 3, inclination: 0.22 },
    { name: 'mars', radius: 0.078, orbit: 1.67, omega: 0.18, phase: 5.3, spin: 0.26, parent: 0 },
    { name: 'phobos', radius: 0.038, orbit: 0.15, omega: 1.2, phase: 2.7, spin: 0.3, parent: 5, inclination: 0.16 },
    { name: 'jupiter', radius: 0.175, orbit: 2.36, omega: 0.135, phase: 0.7, spin: 0.38, parent: 0 },
    { name: 'io', radius: 0.052, orbit: 0.28, omega: 0.82, phase: 4.4, spin: 0.2, parent: 7, inclination: 0.16 },
    { name: 'europa', attractionLead: 0.2, radius: 0.048, orbit: 0.4, omega: 0.62, phase: 1.1, spin: 0.16, parent: 7, inclination: -0.2 },
    { name: 'saturn', attractionLead: 0.3, radius: 0.145, outerRadius: 0.34, orbit: 3.32, omega: 0.104, phase: 3.1, spin: 0.3, parent: 0 },
    { name: 'titan', attractionLead: 0.5, descentLead: -0.5, radius: 0.055, orbit: 0.405, omega: 0.57, phase: 4.1, spin: 0.14, parent: 10, inclination: 0.2 },
    { name: 'uranus', radius: 0.11, orbit: 3.95, omega: 0.083, phase: 5.1, spin: -0.16, parent: 0 },
    { name: 'neptune', radius: 0.105, orbit: 4.4, omega: 0.068, phase: 1.9, spin: 0.2, parent: 0 },
    { name: 'triton', radius: 0.048, orbit: 0.23, omega: -0.65, phase: 0.8, spin: 0.11, parent: 13, inclination: -0.24 },
  ];
  const introDuration = formationTime * 1000;
  const completedFlowTime = introDuration + 1200;
  let fieldAttribute;
  let fieldGrid;
  let fieldSurface;
  let fieldSurfaceAttribute;
  let fieldRim;
  let fieldTime = NaN;
  let waveStrength = 0;
  let wavePhase = 0;
  let renderer;
  let environmentTarget;
  let resizeObserver;
  let intersectionObserver;
  let motionQuery;
  let disposed = false;
  let visible = false;
  let reduced = false;
  let requestedPlaying = true;
  let ready = false;
  let elapsed = 0;
  let previousTime;
  let frame = 0;
  let width = 0;
  let height = 0;
  let pixelRatio = 0;
  let motionState = '';

  function geometry(value) {
    geometries.add(value);
    return value;
  }
  function material(value) {
    materials.add(value);
    return value;
  }
  function textureColor(name, x, y, z) {
    // All bodies belong to one graphite/platinum material family. Broad mineral bands
    // reveal rotation without introducing a second, astronomical colour vocabulary.
    const tones = { sun: 0xababab, mercury: 0x888888, venus: 0xc6c6c6, earth: 0x969696, moon: 0xd4d4d4, mars: 0x777777, phobos: 0xaaaaaa, jupiter: 0xb0b0b0, io: 0xe0e0e0, europa: 0x929292, saturn: 0xbdbdbd, titan: 0x858585, uranus: 0xd0d0d0, neptune: 0x727272, triton: 0xc4c4c4 };
    const grain = Math.sin(x * 29 + y * 17) * Math.sin(y * 23 - z * 19);
    const band = Math.sin(z * 13 + Math.sin(x * 3 + y * 2) * 0.45);
    color.setHex(tones[name]).multiplyScalar(0.96 + band * 0.045 + grain * 0.012);
    return color;
  }
  function makeBody(spec) {
    const shape = geometry(new THREE.SphereGeometry(spec.radius, 48, 32));
    const attribute = shape.attributes.position;
    const colors = new Float32Array(attribute.count * 3);
    for (let index = 0; index < attribute.count; index++) {
      textureColor(spec.name, attribute.getX(index) / spec.radius, attribute.getY(index) / spec.radius, attribute.getZ(index) / spec.radius);
      color.toArray(colors, index * 3);
    }
    shape.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const gas = ['sun', 'jupiter', 'saturn', 'uranus', 'neptune', 'venus', 'titan'].includes(spec.name);
    const surface = material(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: gas ? 0.52 : 0.68, metalness: gas ? 0.24 : 0.12 }));
    return new THREE.Mesh(shape, surface);
  }
  function build() {
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const root = new THREE.Group();
      const sphere = makeBody(spec);
      root.add(sphere);
      root.visible = false;
      scene.add(root);
      if (spec.name === 'saturn') {
        const rings = new THREE.Group();
        rings.rotation.x = 0.4;
        for (const [inner, outer, tint, opacity] of [
          [0.19, 0.255, 0xc7c7c7, 0.7],
          [0.27, 0.34, 0x929292, 0.4],
        ]) {
          const shape = geometry(new THREE.RingGeometry(inner, outer, 112, 24));
          const positions = shape.attributes.position;
          const colors = new Float32Array(positions.count * 4);
          for (let vertex = 0; vertex < positions.count; vertex++) {
            const radius = Math.hypot(positions.getX(vertex), positions.getY(vertex));
            const across = clamp((radius - inner) / (outer - inner));
            const shade = 0.94 + Math.cos(across * Math.PI * 2) * 0.07 + Math.sin(across * Math.PI * 10) * 0.03;
            const edge = 0.35 + 0.65 * smooth(clamp(Math.min(across, 1 - across) / 0.12));
            colors.set([shade, shade, shade, edge], vertex * 4);
          }
          shape.setAttribute('color', new THREE.BufferAttribute(colors, 4));
          const ring = new THREE.Mesh(shape, material(new THREE.MeshStandardMaterial({ color: tint, vertexColors: true, roughness: 0.8, metalness: 0, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })));
          rings.add(ring);
        }
        root.add(rings);
      }
      root.traverse((child) => {
        if (!child.material) return;
        child.material.transparent = true;
        child.renderOrder = 10;
      });
      bodies.push({ root, sphere });
    }
    buildField();
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      fieldSources.push({ center: new THREE.Vector3(), depth: 0, width: index === 0 ? 1.05 : 0.24 + spec.radius * 1.8 });
      orbitalPose(index, formationTime, position);
      formationAngles.push(Math.atan2(position.y, position.x));
      if (spec.parent >= 0) buildOrbitGuide(index, spec.parent === 0);
    }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x171717, 0.18));
    const key = new THREE.DirectionalLight(0xffffff, 1.25);
    key.position.set(-4, -5, 8);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(5, 3, 4);
    scene.add(fill);
    camera.up.set(0, 0, 1);
    camera.position.set(6, -14, 13.1);
    camera.lookAt(0, 0, 1.1);
  }
  function layout() {
    const nextWidth = host.clientWidth;
    const nextHeight = host.clientHeight;
    const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
    if (nextWidth <= 0 || nextHeight <= 0) return false;
    if (width !== nextWidth || height !== nextHeight || pixelRatio !== nextRatio) {
      width = nextWidth;
      height = nextHeight;
      pixelRatio = nextRatio;
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
    }
    return true;
  }
  function buildEnvironment() {
    // Broad softboxes give the rough surfaces a continuous highlight instead of extra coats.
    const studio = new THREE.Scene();
    studio.background = new THREE.Color(0x171717);
    const panel = new THREE.PlaneGeometry(1, 1);
    const lights = [];
    let generator;
    try {
      generator = new THREE.PMREMGenerator(renderer);
      for (const [x, y, z, w, h, tint, intensity] of [
        [-4, -5, 6, 6, 7, 0xffffff, 4],
        [5, 2, 4, 4, 6, 0xffffff, 2],
        [-1, 5, 2, 5, 3, 0xffffff, 1.5],
      ]) {
        const surface = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(intensity), side: THREE.DoubleSide });
        lights.push(surface);
        const light = new THREE.Mesh(panel, surface);
        light.position.set(x, y, z);
        light.scale.set(w, h, 1);
        light.lookAt(0, 0, 0);
        studio.add(light);
      }
      environmentTarget = generator.fromScene(studio, 0.05);
      scene.environment = environmentTarget.texture;
      scene.environmentIntensity = 0.45;
    } finally {
      generator?.dispose();
      panel.dispose();
      for (const surface of lights) surface.dispose();
      studio.clear();
    }
  }
  function buildField() {
    const membrane = geometry(new THREE.PlaneGeometry(fieldSize, fieldSize, 64, 64));
    fieldSurfaceAttribute = membrane.attributes.position;
    fieldSurfaceAttribute.setUsage(THREE.DynamicDrawUsage);
    membrane.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    const membraneColors = new Float32Array(fieldSurfaceAttribute.count * 4);
    for (let index = 0; index < fieldSurfaceAttribute.count; index++) {
      const edge = Math.max(Math.abs(fieldSurfaceAttribute.getX(index)), Math.abs(fieldSurfaceAttribute.getY(index))) / (fieldSize / 2);
      const fade = smooth(clamp((1 - edge) / 0.3));
      membraneColors.set([1, 1, 1, fade], index * 4);
    }
    membrane.setAttribute('color', new THREE.BufferAttribute(membraneColors, 4));
    fieldSurface = new THREE.Mesh(membrane, material(new THREE.MeshStandardMaterial({ color: 0x292929, emissive: 0x080808, emissiveIntensity: 0.12, roughness: 0.6, metalness: 0.16, transparent: true, opacity: 0, vertexColors: true, side: THREE.DoubleSide, depthWrite: false })));
    fieldRim = new THREE.DirectionalLight(0xffffff, 0.55);
    fieldRim.position.set(-2, 4, 2.2);
    scene.add(fieldRim);
    fieldSurface.frustumCulled = false;
    fieldSurface.renderOrder = 0;
    scene.add(fieldSurface);
    const points = [];
    const colors = [];
    const indices = [];
    const lines = 12;
    const segments = 64;
    for (let axis = 0; axis < 2; axis++) {
      for (let line = 0; line <= lines; line++) {
        const fixed = (line / lines - 0.5) * fieldSize;
        for (let step = 0; step <= segments; step++) {
          const along = (step / segments - 0.5) * fieldSize;
          const x = axis === 0 ? fixed : along;
          const y = axis === 0 ? along : fixed;
          const edge = Math.max(Math.abs(x), Math.abs(y)) / (fieldSize / 2);
          const fade = 0.06 + 0.94 * (1 - edge ** 2) ** 2;
          const index = points.length / 3;
          points.push(x, y, 0);
          colors.push(fade, fade, fade);
          if (step > 0) indices.push(index - 1, index);
        }
      }
    }
    const shape = geometry(new THREE.BufferGeometry());
    fieldAttribute = new THREE.Float32BufferAttribute(points, 3);
    fieldAttribute.setUsage(THREE.DynamicDrawUsage);
    shape.setAttribute('position', fieldAttribute);
    shape.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    shape.setIndex(indices);
    const surface = material(new THREE.LineBasicMaterial({ color: 0x858585, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
    fieldGrid = new THREE.LineSegments(shape, surface);
    fieldGrid.frustumCulled = false;
    fieldGrid.renderOrder = 1;
    scene.add(fieldGrid);
  }
  function buildOrbitGuide(index, major) {
    const segments = major ? 192 : 96;
    const shape = geometry(new THREE.BufferGeometry());
    const attribute = new THREE.Float32BufferAttribute(new Float32Array((segments + 1) * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    shape.setAttribute('position', attribute);
    const surface = material(new THREE.LineDashedMaterial({ color: 0xa1a1a1, transparent: true, opacity: 0, dashSize: major ? 0.055 : 0.022, gapSize: major ? 0.065 : 0.026, depthWrite: false, toneMapped: false }));
    const object = new THREE.Line(shape, surface);
    object.visible = false;
    object.frustumCulled = false;
    object.renderOrder = 2;
    scene.add(object);
    orbitGuides.push({ index, segments, object, attribute, opacity: major ? 0.25 : 0.2 });
  }
  function orbitalPose(index, seconds, output) {
    const spec = specs[index];
    if (spec.parent < 0) output.set(0, 0, orbitHeight);
    else orbitalPose(spec.parent, seconds, output);
    if (spec.orbit > 0) {
      const angle = spec.phase + spec.omega * orbitalTime(seconds);
      output.x += Math.cos(angle) * spec.orbit;
      output.y += Math.sin(angle) * spec.orbit * Math.cos(spec.inclination ?? 0);
      output.z += Math.sin(angle) * spec.orbit * Math.sin(spec.inclination ?? 0);
    }
    return output;
  }
  function orbitalTime(seconds) {
    // Preserve the formation paths, then smoothly increase orbital and spin speed.
    const age = Math.max(0, seconds - formationTime);
    const ramp = clamp(age / orbitAccelerationDuration);
    const extra = age >= orbitAccelerationDuration ? age - orbitAccelerationDuration / 2 : orbitAccelerationDuration * (ramp ** 3 - ramp ** 4 / 2);
    return formationOrbitTime + seconds - formationTime + (orbitSpeed - 1) * extra;
  }
  function bodyPose(index, seconds, output) {
    const progress = clamp((seconds - releaseStart) / formationDuration);
    // A bounded lead changes travel speed without a height offset: u + lead*u*(1-u) is
    // monotone for |lead| <= 1. Every body has one uninterrupted approach.
    const amount = ease(progress + (specs[index].attractionLead ?? 0) * progress * (1 - progress));
    const start = suspended[index];
    if (amount === 0) return output.fromArray(start);
    orbitalPose(index, seconds, output);
    if (amount === 1) return output;
    // Titan completes its outward arc before approaching the ring plane.
    const descent = ease(progress + (specs[index].descentLead ?? specs[index].attractionLead ?? 0) * progress * (1 - progress));
    const height = THREE.MathUtils.lerp(start[2], output.z, descent);
    if (index === 0) return output.set(start[0] * (1 - amount), start[1] * (1 - amount), height);
    // Open arcs join the moving orbit directly, without an intermediate landing plane.
    const reference = formationAngles[index];
    const startAngle = Math.atan2(start[1], start[0]);
    const endAngle = Math.atan2(output.y, output.x);
    const from = reference + Math.atan2(Math.sin(startAngle - reference), Math.cos(startAngle - reference));
    const to = reference + Math.atan2(Math.sin(endAngle - reference), Math.cos(endAngle - reference));
    const radius = THREE.MathUtils.lerp(Math.hypot(start[0], start[1]), Math.hypot(output.x, output.y), amount);
    const angle = THREE.MathUtils.lerp(from, to, amount);
    return output.set(Math.cos(angle) * radius, Math.sin(angle) * radius, height);
  }
  function prepareField(seconds) {
    if (fieldTime === seconds) return;
    fieldTime = seconds;
    const revealed = smooth(clamp((seconds - fieldRevealStart) / fieldRevealDuration));
    const progress = clamp((seconds - releaseStart) / formationDuration);
    const calming = 1 - smooth(clamp(progress * 3));
    waveStrength = 0.22 * revealed * calming;
    wavePhase = (seconds - fieldRevealStart) * 2.4;
    for (let index = 0; index < specs.length; index++) {
      const source = fieldSources[index];
      bodyPose(index, seconds, source.center);
      const settled = ease(progress);
      source.depth = (index === 0 ? 1.25 : 0.65 * (specs[index].radius / specs[0].radius) ** 2) * settled;
    }
  }
  function fieldHeightAt(x, y) {
    let depth = 0;
    for (const source of fieldSources) {
      if (source.depth === 0) continue;
      const distanceSquared = (x - source.center.x) ** 2 + (y - source.center.y) ** 2;
      depth += source.depth * Math.exp(-distanceSquared / (2 * source.width ** 2));
    }
    const edge = clamp(Math.max(Math.abs(x), Math.abs(y)) / (fieldSize / 2));
    const wave = waveStrength * (1 - edge ** 2) ** 2 * (0.8 * Math.sin(Math.hypot(x, y) * 2.6 - wavePhase) + 0.2 * Math.sin(x * 1.3 + y * 0.9 - wavePhase * 0.8));
    return fieldLevel - 1.35 * Math.tanh(depth / 1.35) + wave;
  }
  function updateOrbitGuides(seconds) {
    const age = Math.max(0, seconds - formationTime);
    const amount = reduced ? 1 : smooth(clamp(age / orbitRevealDuration));
    for (const guide of orbitGuides) {
      const spec = specs[guide.index];
      const sweep = Math.sign(spec.omega) * Math.PI * 2 * amount;
      const startAngle = spec.phase + spec.omega * orbitalTime(formationTime);
      guide.object.visible = amount > 0;
      if (amount === 0) continue;
      guide.object.material.opacity = guide.opacity * Math.min(1, amount * 4);
      bodyPose(spec.parent, seconds, destination);
      for (let step = 0; step <= guide.segments; step++) {
        // Reveal the whole guide quickly from the formation point, never a first-orbit trail.
        const angle = startAngle + (step / guide.segments) * sweep;
        guide.attribute.setXYZ(step, destination.x + Math.cos(angle) * spec.orbit, destination.y + Math.sin(angle) * spec.orbit * Math.cos(spec.inclination ?? 0), destination.z + Math.sin(angle) * spec.orbit * Math.sin(spec.inclination ?? 0));
      }
      guide.attribute.needsUpdate = true;
      guide.object.computeLineDistances();
    }
  }
  function pose() {
    const seconds = elapsed / 1000;
    renderer.domElement.style.setProperty('--scene-opacity', '1');
    prepareField(seconds);
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      const body = bodies[index];
      body.root.visible = true;
      bodyPose(index, seconds, position);
      body.root.position.copy(position);
      body.sphere.rotation.z = orbitalTime(seconds) * spec.spin;
    }
    const revealed = ease(clamp((seconds - fieldRevealStart) / fieldRevealDuration));
    fieldGrid.visible = revealed > 0;
    const organized = smooth(clamp((seconds - releaseStart) / formationDuration));
    fieldGrid.material.opacity = THREE.MathUtils.lerp(0.22, 0.09, organized) * revealed;
    fieldSurface.visible = revealed > 0;
    fieldRim.intensity = THREE.MathUtils.lerp(0.55, 1.2, organized);
    fieldSurface.material.opacity = THREE.MathUtils.lerp(0.6, 0.5, organized) * revealed;
    for (let index = 0; index < fieldSurfaceAttribute.count; index++) fieldSurfaceAttribute.setZ(index, fieldHeightAt(fieldSurfaceAttribute.getX(index), fieldSurfaceAttribute.getY(index)));
    fieldSurfaceAttribute.needsUpdate = true;
    fieldSurface.geometry.computeVertexNormals();
    // The initial wave calms as the same field responds to the approaching bodies.
    for (let index = 0; index < fieldAttribute.count; index++) fieldAttribute.setZ(index, fieldHeightAt(fieldAttribute.getX(index), fieldAttribute.getY(index)) + 0.006);
    fieldAttribute.needsUpdate = true;
    updateOrbitGuides(seconds);
    updateCamera(seconds, revealed);
  }
  function updateCamera(seconds, revealed) {
    let azimuth;
    let elevation;
    let target;
    let authoredSpan;
    if (seconds < releaseStart) {
      const amount = ease(clamp(seconds / releaseStart));
      const rest = 1 - amount;
      const bezier = (a, b, c, d) => rest ** 3 * a + 3 * rest ** 2 * amount * b + 3 * rest * amount ** 2 * c + amount ** 3 * d;
      azimuth = bezier(-38, -28, 15, 30);
      elevation = bezier(10, 12, 22, 24);
      target = bezier(3.52, 3.52, 1.2, 1.2);
      authoredSpan = bezier(3, 3, 10.8, 10.8);
    } else {
      let next = 1;
      while (next < cameraShots.length - 1 && seconds > cameraShots[next].time) next++;
      const from = cameraShots[next - 1];
      const to = cameraShots[next];
      const amount = ease(clamp((seconds - from.time) / (to.time - from.time)));
      azimuth = THREE.MathUtils.lerp(from.azimuth, to.azimuth, amount);
      elevation = THREE.MathUtils.lerp(from.elevation, to.elevation, amount);
      target = THREE.MathUtils.lerp(from.target, to.target, amount);
      authoredSpan = THREE.MathUtils.lerp(from.span, to.span, amount);
    }
    azimuth = THREE.MathUtils.degToRad(azimuth);
    elevation = THREE.MathUtils.degToRad(elevation);
    const aspect = width > 0 && height > 0 ? width / height : 1;
    // A circular bound fits the suspended bodies without the old container's empty corners.
    // Smooth bounds preserve camera velocity across azimuth zero and responsive fit changes.
    const projectedFieldWidth = fieldSize * (Math.hypot(Math.cos(azimuth), 0.02) + Math.hypot(Math.sin(azimuth), 0.02));
    const projectedWidth = THREE.MathUtils.lerp(clusterDiameter, projectedFieldWidth, revealed);
    const fitSpan = (projectedWidth * 1.1) / aspect;
    const span = (authoredSpan + fitSpan + Math.hypot(authoredSpan - fitSpan, 0.15)) / 2;
    camera.left = (-span * aspect) / 2;
    camera.right = -camera.left;
    camera.top = span / 2;
    camera.bottom = -camera.top;
    camera.position.set(20 * Math.sin(azimuth), -20 * Math.cos(azimuth), target + 20 * Math.tan(elevation));
    camera.lookAt(0, 0, target);
    camera.updateProjectionMatrix();
  }
  function playing() {
    return requestedPlaying && !reduced && visible && !document.hidden && !disposed;
  }
  function notifyMotion() {
    // Captions share the scene clock, so pause, replay and reduced motion stay aligned.
    const chapter = elapsed < releaseStart * 1000 ? 0 : elapsed < introDuration ? 1 : 2;
    const value = { playing: playing(), canAnimate: !reduced, settled: elapsed >= introDuration, chapter };
    const key = JSON.stringify(value);
    if (key !== motionState) {
      motionState = key;
      callbacks.motion?.(value);
    }
  }
  function render(timestamp) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    try {
      if (playing() && previousTime !== undefined) elapsed += Math.min(100, timestamp - previousTime);
      previousTime = playing() ? timestamp : undefined;
      if (!layout()) return;
      pose();
      renderer.render(scene, camera);
      if (!ready) {
        ready = true;
        callbacks.ready?.();
      }
      notifyMotion();
      if (playing()) requestRender();
    } catch {
      fail();
    }
  }
  function requestRender() {
    if (!disposed && visible && !document.hidden && !frame) frame = requestAnimationFrame(render);
  }
  function activityChanged() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = undefined;
    notifyMotion();
    requestRender();
  }
  function preferenceChanged() {
    reduced = motionQuery.matches;
    if (reduced) elapsed = completedFlowTime;
    activityChanged();
  }
  function replay() {
    if (disposed) return;
    elapsed = reduced ? completedFlowTime : 0;
    requestedPlaying = true;
    activityChanged();
  }
  function pause() {
    requestedPlaying = false;
    activityChanged();
  }
  function resume() {
    requestedPlaying = true;
    activityChanged();
  }
  function setTheme() {
    // The neutral illustration keeps the same black stage in either document theme.
    requestRender();
  }
  function fail(event) {
    event?.preventDefault();
    dispose();
    callbacks.unavailable?.();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver?.disconnect();
    intersectionObserver?.disconnect();
    motionQuery?.removeEventListener('change', preferenceChanged);
    document.removeEventListener('visibilitychange', activityChanged);
    window.removeEventListener('resize', requestRender);
    renderer?.domElement.removeEventListener('webglcontextlost', fail);
    for (const value of geometries) value.dispose();
    for (const value of materials) value.dispose();
    scene.environment = null;
    environmentTarget?.dispose();
    renderer?.dispose();
    if (renderer && !renderer.getContext().isContextLost()) renderer.forceContextLoss();
    renderer?.domElement.remove();
    scene.clear();
  }

  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.domElement.setAttribute('aria-hidden', 'true');
    host.appendChild(renderer.domElement);
    renderer.domElement.addEventListener('webglcontextlost', fail);
    build();
    buildEnvironment();
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = motionQuery.matches;
    if (reduced) elapsed = completedFlowTime;
    motionQuery.addEventListener('change', preferenceChanged);
    resizeObserver = new ResizeObserver(requestRender);
    resizeObserver.observe(host);
    if ('IntersectionObserver' in window) {
      intersectionObserver = new IntersectionObserver((entries) => {
        visible = entries.some((entry) => entry.isIntersecting);
        activityChanged();
      });
      intersectionObserver.observe(host);
    } else visible = true;
    document.addEventListener('visibilitychange', activityChanged);
    window.addEventListener('resize', requestRender, { passive: true });
    notifyMotion();
    requestRender();
    return { setTheme, dispose, replay, pause, resume };
  } catch (error) {
    dispose();
    throw error;
  }
}
