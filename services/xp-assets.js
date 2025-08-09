// Wrap the existing ImageStore as a generic content-addressed blob store
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

export async function storeWasm(arrayBuffer, meta = {}) {
  const b64 = 'data:application/wasm;base64,' + abToBase64(arrayBuffer);
  const res = await getImageStore().storeImage(b64, { // reuse existing path
    ...meta,
    type: 'wasm',
    mime: 'application/wasm',
    size: arrayBuffer.byteLength,
  });
  return res; // { hash }
}

export async function retrieveWasm(hash) {
  // retrieveImage returns a data URL — convert back to bytes
  const dataUrl = await getImageStore().retrieveImage(hash);
  if (!dataUrl) return null;
  const [, b64] = dataUrl.split(',', 2);
  return base64ToUint8Array(b64).buffer;
}

export async function storeAssetPack(arrayBuffer, mime = 'application/zip', meta = {}) {
  const b64 = `data:${mime};base64,` + abToBase64(arrayBuffer);
  const res = await getImageStore().storeImage(b64, {
    ...meta,
    type: 'asset-pack',
    mime,
    size: arrayBuffer.byteLength,
  });
  return res;
}

export async function retrieveAssetPack(hash) {
  const dataUrl = await getImageStore().retrieveImage(hash);
  if (!dataUrl) return null;
  const [, b64] = dataUrl.split(',', 2);
  return base64ToUint8Array(b64).buffer;
}
