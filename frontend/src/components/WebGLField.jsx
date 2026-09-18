import { useEffect, useRef } from 'react';
import * as THREE from 'three';

/**
 * Ambient aurora: cyan / purple / gold ribbons plus rising motes.
 * Skips the loop when the user prefers reduced motion.
 */
export default function WebGLField() {
  const hostRef = useRef(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce.matches) return undefined;

    const width = window.innerWidth;
    const height = window.innerHeight;

    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 40);
    camera.position.set(0, 0, 9);

    const scene = new THREE.Scene();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const cyan = new THREE.Color(0x7ab8ff);
    const purple = new THREE.Color(0x6d4aff);
    const gold = new THREE.Color(0xf5c518);
    const mist = new THREE.Color(0xc4b5fd);

    const ribbons = [];
    const ribbonSpecs = [
      { amp: 1.15, speed: 0.22, phase: 0.2, colorA: cyan, colorB: purple, y: 1.6 },
      { amp: 0.85, speed: 0.16, phase: 1.4, colorA: purple, colorB: gold, y: 0.1 },
      { amp: 1.35, speed: 0.12, phase: 2.6, colorA: gold, colorB: cyan, y: -1.4 },
      { amp: 0.7, speed: 0.28, phase: 3.8, colorA: mist, colorB: cyan, y: 2.4 },
    ];

    ribbonSpecs.forEach((spec) => {
      const N = 160;
      const positions = new Float32Array(N * 3);
      const colors = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        positions[i * 3] = -10 + t * 20;
        positions[i * 3 + 1] = spec.y;
        positions[i * 3 + 2] = -1.5 + Math.sin(t * 4) * 0.4;
        const c = spec.colorA.clone().lerp(spec.colorB, t);
        colors[i * 3] = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.055,
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat);
      scene.add(points);
      ribbons.push({ geo, mat, points, spec, n: N });
    });

    const COUNT = 160;
    const motePos = new Float32Array(COUNT * 3);
    const moteCol = new Float32Array(COUNT * 3);
    const moteSeeds = [];
    const tints = [cyan, purple, gold, mist];
    for (let i = 0; i < COUNT; i++) {
      motePos[i * 3] = THREE.MathUtils.randFloatSpread(18);
      motePos[i * 3 + 1] = THREE.MathUtils.randFloatSpread(10);
      motePos[i * 3 + 2] = THREE.MathUtils.randFloatSpread(6);
      const tint = tints[i % tints.length];
      moteCol[i * 3] = tint.r;
      moteCol[i * 3 + 1] = tint.g;
      moteCol[i * 3 + 2] = tint.b;
      moteSeeds.push({
        x: motePos[i * 3],
        v: 0.004 + Math.random() * 0.01,
        w: 0.2 + Math.random() * 0.5,
        p: Math.random() * Math.PI * 2,
      });
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos, 3));
    moteGeo.setAttribute('color', new THREE.BufferAttribute(moteCol, 3));
    const moteMat = new THREE.PointsMaterial({
      size: 0.04,
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const motes = new THREE.Points(moteGeo, moteMat);
    scene.add(motes);
    const moteAttr = moteGeo.getAttribute('position');

    renderer.setAnimationLoop((time) => {
      const t = time / 1000;
      ribbons.forEach((ribbon) => {
        const pos = ribbon.geo.getAttribute('position');
        for (let i = 0; i < ribbon.n; i++) {
          const x = pos.getX(i);
          const u = (i / (ribbon.n - 1)) * Math.PI * 2;
          pos.setY(
            i,
            ribbon.spec.y
              + Math.sin(u + t * ribbon.spec.speed + ribbon.spec.phase) * ribbon.spec.amp
              + Math.sin(x * 0.35 + t * 0.4) * 0.18,
          );
        }
        pos.needsUpdate = true;
      });
      for (let i = 0; i < COUNT; i++) {
        const s = moteSeeds[i];
        let y = moteAttr.getY(i) + s.v;
        if (y > 5.4) y = -5.4;
        moteAttr.setY(i, y);
        moteAttr.setX(i, s.x + Math.sin(y * s.w + t * 0.5 + s.p) * 0.22);
      }
      moteAttr.needsUpdate = true;
      scene.rotation.z = Math.sin(t * 0.05) * 0.03;
      renderer.render(scene, camera);
    });

    function onResize() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', onResize);

    return () => {
      renderer.setAnimationLoop(null);
      window.removeEventListener('resize', onResize);
      ribbons.forEach((r) => {
        r.geo.dispose();
        r.mat.dispose();
      });
      moteGeo.dispose();
      moteMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div className="webgl-field" ref={hostRef} aria-hidden="true" />;
}
