// FILE: engine-three.js
// Minimal Three.js adapter that draws a declarative scene spec from lpState.gfx.
// Safe: no LP code executed; only data-driven scene description.
//
// Scene spec sketch (lpState.gfx):
// {
//   three: true,
//   background: "#000",
//   camera: { fov: 60, near: 0.1, far: 100, x:0, y:2, z:6, lookAt:[0,0,0] },
//   lights: [{ type:"hemisphere", sky:"#fff", ground:"#444", intensity:0.9 }],
//   objects: [
//     { type:"box", w:1,h:1,d:1, x:0,y:0.5,z:0, rotY:0.3, color:"#44ccff" },
//     { type:"plane", w:20,h:20, x:0,y:0,z:0, rotX:-1.5708, color:"#333" },
//     { type:"sphere", r:0.5, x:2,y:0.5,z:0, color:"#ff8844" }
//   ],
//   sprites: [{ hash:"<imageHash>", x:0,y:1,z:0, w:1,h:1 }], // billboard
//   post: { bloom:false },
//   tick: { autoplay:true } // simple RAF loop; use sparingly
// }

let THREE = null;

async function ensureThree() {
  if (THREE) return THREE;
  try {
    // Try local/bundled 'three'
    THREE = (await import('three')).default || (await import('three'));
    return THREE;
  } catch (_e1) {
    // Try CDN ESM as a fallback
    try {
      THREE = (await import('https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js')).default
           || (await import('https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js'));
      return THREE;
    } catch (e) {
      console.warn('[engine-three] Failed to load three:', e);
      throw e;
    }
  }
}

function makeRenderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: false });
  r.setPixelRatio(window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  r.setSize(rect.width, rect.height, false);
  return r;
}

function resizeRendererToDisplaySize(renderer, camera) {
  const canvas = renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const width = Math.floor(rect.width * (window.devicePixelRatio || 1));
  const height = Math.floor(rect.height * (window.devicePixelRatio || 1));
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setSize(rect.width, rect.height, false);
    if (camera && camera.isPerspectiveCamera) {
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    }
  }
}

function addLights(scene, spec, THREE) {
  const arr = spec.lights || [{ type: 'hemisphere', sky: '#ffffff', ground: '#444444', intensity: 0.8 }];
  arr.forEach(l => {
    if (l.type === 'hemisphere') {
      const light = new THREE.HemisphereLight(l.sky || 0xffffff, l.ground || 0x444444, l.intensity || 1);
      scene.add(light);
    } else if (l.type === 'directional') {
      const light = new THREE.DirectionalLight(l.color || 0xffffff, l.intensity || 1);
      light.position.set(l.x || 3, l.y || 10, l.z || 10);
      scene.add(light);
    } else if (l.type === 'ambient') {
      const light = new THREE.AmbientLight(l.color || 0xffffff, l.intensity || 0.5);
      scene.add(light);
    }
  });
}

function makeMaterial(color, THREE) {
  return new THREE.MeshStandardMaterial({ color: new THREE.Color(color || '#cccccc') });
}

function addObjects(scene, objects, THREE) {
  (objects || []).forEach(o => {
    let mesh = null;
    if (o.type === 'box') {
      const geo = new THREE.BoxGeometry(o.w || 1, o.h || 1, o.d || 1);
      mesh = new THREE.Mesh(geo, makeMaterial(o.color, THREE));
    } else if (o.type === 'sphere') {
      const geo = new THREE.SphereGeometry(o.r || 0.5, 32, 32);
      mesh = new THREE.Mesh(geo, makeMaterial(o.color, THREE));
    } else if (o.type === 'plane') {
      const geo = new THREE.PlaneGeometry(o.w || 10, o.h || 10);
      const m = makeMaterial(o.color || '#666', THREE);
      m.side = THREE.DoubleSide;
      mesh = new THREE.Mesh(geo, m);
    }
    if (mesh) {
      mesh.position.set(o.x || 0, o.y || 0, o.z || 0);
      mesh.rotation.set(o.rotX || 0, o.rotY || 0, o.rotZ || 0);
      scene.add(mesh);
    }
  });
}

export async function mountThreeOnCanvas(canvas, spec, opts = {}) {
  const T = await ensureThree();

  const renderer = makeRenderer(canvas);
  const scene = new T.Scene();

  if (spec.background) scene.background = new T.Color(spec.background);

  const camSpec = spec.camera || {};
  const camera = new T.PerspectiveCamera(
    camSpec.fov || 60,
    (canvas.clientWidth || 1) / (canvas.clientHeight || 1),
    camSpec.near || 0.1,
    camSpec.far || 100
  );
  camera.position.set(camSpec.x ?? 0, camSpec.y ?? 2, camSpec.z ?? 6);
  const la = camSpec.lookAt || [0, 0, 0];
  camera.lookAt(new T.Vector3(la[0], la[1], la[2]));

  addLights(scene, spec, T);
  addObjects(scene, spec.objects, T);

  // rudimentary sprite/billboard support (uses ImageBitmap)
  if (Array.isArray(spec.sprites) && spec.sprites.length) {
    for (const s of spec.sprites) {
      try {
        const uri = s.dataUri || (s.hash && (await (await import('./services/instances.js')).getImageStore().retrieveImage(s.hash)));
        if (!uri) continue;
        const tex = new T.TextureLoader().load(uri);
        const mat = new T.SpriteMaterial({ map: tex, transparent: true });
        const spr = new T.Sprite(mat);
        spr.position.set(s.x || 0, s.y || 0, s.z || 0);
        spr.scale.set(s.w || 1, s.h || 1, 1);
        scene.add(spr);
      } catch (e) {
        console.warn('[engine-three] sprite load failed', e);
      }
    }
  }

  // basic RAF loop (opt-in)
  const autoplay = !!(spec.tick && spec.tick.autoplay);
  let raf = 0;
  function frame() {
    resizeRendererToDisplaySize(renderer, camera);
    renderer.render(scene, camera);
    if (autoplay) raf = requestAnimationFrame(frame);
  }
  frame();

  // Minimal input (optional)
  if (opts.postId || typeof opts.onInput === 'function') {
    if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');
    canvas.addEventListener('keydown', (e) => {
      const payload = { action: 'key', kind: 'down', key: e.key };
      if (typeof opts.onInput === 'function') opts.onInput(payload);
      else if (opts.postId && window.interactWithLivingPost) window.interactWithLivingPost(opts.postId, JSON.stringify(payload));
    });
    canvas.addEventListener('keyup', (e) => {
      const payload = { action: 'key', kind: 'up', key: e.key };
      if (typeof opts.onInput === 'function') opts.onInput(payload);
      else if (opts.postId && window.interactWithLivingPost) window.interactWithLivingPost(opts.postId, JSON.stringify(payload));
    });
  }

  // Return a small controller in case caller wants to dispose
  return {
    dispose() {
      cancelAnimationFrame(raf);
      renderer.dispose();
      // naive scene cleanup
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
  };
}
