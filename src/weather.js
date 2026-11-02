// Погода: снегопад и летящие искры у вулкана — точки в коробке вокруг камеры, весь расчёт на видеокарте.
import * as THREE from 'three';
import { WIND } from './config.js';

const KINDS = {
  snow: { n: 2600, box: [90, 46, 90], vel: [WIND.x * 2.2, -3.2, WIND.z * 2.2], size: [0.9, 2.2], color: [1, 1, 1], alpha: 0.85, additive: false, flicker: 0 },
  embers: { n: 1400, box: [110, 50, 110], vel: [WIND.x * 3.0, 2.6, WIND.z * 3.0], size: [0.5, 1.5], color: [1, 0.45, 0.12], alpha: 1, additive: true, flicker: 1 },
};

export class Weather {
  constructor(scene, kind, pxScale) {
    const k = KINDS[kind];
    this.k = k;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(k.n * 3), seed = new Float32Array(k.n * 2);
    for (let i = 0; i < k.n; i++) {
      pos[i * 3] = Math.random() * k.box[0];
      pos[i * 3 + 1] = Math.random() * k.box[1];
      pos[i * 3 + 2] = Math.random() * k.box[2];
      seed[i * 2] = Math.random();
      seed[i * 2 + 1] = Math.random();
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
    this.u = {
      uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uPx: { value: 400 },
      uBox: { value: new THREE.Vector3(...k.box) }, uVel: { value: new THREE.Vector3(...k.vel) },
      uSize: { value: new THREE.Vector2(...k.size) }, uColor: { value: new THREE.Color(...k.color) },
      uAlpha: { value: k.alpha }, uFlicker: { value: k.flicker },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u, transparent: true, depthWrite: false, fog: false,
      blending: k.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      vertexShader: /* glsl */ `
        uniform vec3 uCam, uBox, uVel; uniform float uTime, uPx, uFlicker; uniform vec2 uSize;
        attribute vec2 aSeed;
        varying float vA;
        void main() {
          float sp = 0.6 + aSeed.x * 0.8;
          vec3 p = position + uVel * sp * uTime;
          p.x += sin(uTime * (0.6 + aSeed.y) + aSeed.x * 40.0) * 1.2;
          p.z += cos(uTime * (0.5 + aSeed.x) + aSeed.y * 40.0) * 1.2;
          vec3 rel = mod(p - uCam, uBox);
          vec3 w = uCam + rel - uBox * 0.5;
          vec4 mv = viewMatrix * vec4(w, 1.0);
          float d = -mv.z;
          gl_Position = projectionMatrix * mv;
          float sz = mix(uSize.x, uSize.y, aSeed.y);
          gl_PointSize = clamp(sz * uPx / max(d, 0.5) * 0.12, 1.0, 14.0);
          float edge = smoothstep(0.0, 0.18, 1.0 - length((rel / uBox - 0.5) * 2.0));
          vA = edge * (1.0 - uFlicker * (0.5 + 0.5 * sin(uTime * 9.0 + aSeed.x * 60.0)) * 0.7);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAlpha;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float a = smoothstep(0.5, 0.15, length(c)) * vA * uAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * (1.0 + 0.6 * a), a);
        }`,
    });
    this.mesh = new THREE.Points(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  update(dt, camPos, canvasHeight) {
    this.u.uTime.value += dt;
    this.u.uCam.value.copy(camPos);
    this.u.uPx.value = canvasHeight;
  }
}
