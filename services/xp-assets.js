// services/xp-assets.js
import { getImageStore } from './instances.js';

function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function dataUrlToParts(dataUrl) {
  const [meta, b64] = dataUrl.split(',', 2);
  const mime = (meta.match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
  return { mime, b64 };
}
async function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = reject;
    fr.onload = () => resolve(fr.result);
    fr.readAsDataURL(blob);
  });
}

const store = () => getImageStore();

/** ---------- WASM ---------- */
export async function storeWasm(arrayBuffer, meta = {}) {
  const s = store();
  // Fast path: if the store supports generic blobs, use it.
  if (s.put instanceof Function) {
    const blob = new Blob([arrayBuffer], { type: 'application/wasm' });
    return s.put(blob, { ...meta, type: 'wasm', mime: blob.type, size: blob.size });
  }
  // Fallback: your existing data-URL route.
  const b64 = 'data:application/wasm;base64,' + abToBase64(arrayBuffer);
  return s.storeImage(b64, { ...meta, type: 'wasm', mime: 'application/wasm', size: arrayBuffer.byteLength });
}

export async function retrieveWasm(hash) {
  const s = store();
  if (s.getArrayBuffer instanceof Function) return s.getArrayBuffer(hash);
  if (s.getBlob instanceof Function) return (await s.getBlob(hash)).arrayBuffer();

  // Fallback: decode from data URL
  const dataUrl = await s.retrieveImage(hash);
  if (!dataUrl) return null;
  const { b64 } = dataUrlToParts(dataUrl);
  return base64ToUint8Array(b64).buffer;
}

/** ---------- asset packs / generic blobs ---------- */
export async function storeAssetPack(arrayBuffer, mime = 'application/zip', meta = {}) {
  const s = store();
  if (s.put instanceof Function) {
    const blob = new Blob([arrayBuffer], { type: mime });
    return s.put(blob, { ...meta, type: 'asset-pack', mime, size: blob.size });
  }
  const b64 = `data:${mime};base64,` + abToBase64(arrayBuffer);
  return s.storeImage(b64, { ...meta, type: 'asset-pack', mime, size: arrayBuffer.byteLength });
}

export async function retrieveAssetPack(hash) {
  const s = store();
  if (s.getArrayBuffer instanceof Function) return s.getArrayBuffer(hash);
  if (s.getBlob instanceof Function) return (await s.getBlob(hash)).arrayBuffer();

  const dataUrl = await s.retrieveImage(hash);
  if (!dataUrl) return null;
  const { b64 } = dataUrlToParts(dataUrl);
  return base64ToUint8Array(b64).buffer;
}

/** ---------- handy extras for your game pipeline ---------- */
export async function storeJSON(obj, meta = {}) {
  const json = JSON.stringify(obj);
  const s = store();
  if (s.put instanceof Function) {
    const blob = new Blob([json], { type: 'application/json' });
    return s.put(blob, { ...meta, type: 'json', mime: 'application/json', size: blob.size });
  }
  const dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
  return s.storeImage(dataUrl, { ...meta, type: 'json', mime: 'application/json', size: json.length });
}

export async function retrieveJSON(hash) {
  const s = store();
  if (s.getText instanceof Function) return JSON.parse(await s.getText(hash));
  if (s.getBlob instanceof Function) return JSON.parse(await (await s.getBlob(hash)).text());

  const dataUrl = await s.retrieveImage(hash);
  if (!dataUrl) return null;
  const { b64 } = dataUrlToParts(dataUrl);
  return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

export async function retrieveBlobAsURL(hash) {
  const s = store();
  if (s.getBlob instanceof Function) return URL.createObjectURL(await s.getBlob(hash));
  const dataUrl = await s.retrieveImage(hash);
  if (!dataUrl) return null;
  // Data URLs are already URLs, pass through; callers can treat it as a src.
  return dataUrl;
}

export async function storeBlob(blob, meta = {}) {
  const s = store();
  if (s.put instanceof Function) {
    return s.put(blob, { ...meta, type: meta.type || 'blob', mime: blob.type || meta.mime });
  }
  const dataUrl = await blobToDataURL(blob);
  return s.storeImage(dataUrl, { ...meta, type: meta.type || 'blob', mime: blob.type || meta.mime });
}
