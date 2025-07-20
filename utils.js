import DOMPurify from 'dompurify'; 
import { CONFIG } from './config.js';

export class BloomFilter {
  constructor(size = 100000, numHashes = 4) {
    this.size = size;
    this.numHashes = numHashes;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }
  
  add(item) {
    for (let i = 0; i < this.numHashes; i++) {
      const hash = this.hash(item + i) % this.size;
      const byte = Math.floor(hash / 8);
      const bit = hash % 8;
      this.bits[byte] |= (1 << bit);
    }
  }
  
  has(item) {
    for (let i = 0; i < this.numHashes; i++) {
      const hash = this.hash(item + i) % this.size;
      const byte = Math.floor(hash / 8);
      const bit = hash % 8;
      if ((this.bits[byte] & (1 << bit)) === 0) return false;
    }
    return true;
  }
  
  hash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
}

export class HierarchicalBloomFilter {
  constructor() {
    this.levels = [
      { filter: new BloomFilter(10000, 3), maxAge: 3600000, name: 'recent' },
      { filter: new BloomFilter(50000, 4), maxAge: 86400000, name: 'daily' },
      { filter: new BloomFilter(100000, 5), maxAge: 604800000, name: 'weekly' }
    ];
    this.timestamps = new Map();
    this.maxTimestamps = 50000; // ADDED: Maximum timestamps to store
  }
  
  add(item) {
    const now = Date.now();
    
    // Add to all levels
    this.levels.forEach(level => {
      level.filter.add(item);
    });
    
    // Track timestamp with size limit
    this.timestamps.set(item, now);
    
    // Force cleanup if over limit
    if (this.timestamps.size > this.maxTimestamps) {
      this.cleanup();
    }
  }
  
  has(item) {
    const timestamp = this.timestamps.get(item);
    if (!timestamp) return false;
    
    const age = Date.now() - timestamp;
    
    // Check appropriate level based on age
    for (const level of this.levels) {
      if (age <= level.maxAge) {
        return level.filter.has(item);
      }
    }
    
    // Item is too old, remove it
    this.timestamps.delete(item);
    return false;
  }
  
  cleanup() {
    const now = Date.now();
    const maxAge = this.levels[this.levels.length - 1].maxAge;
    
    const beforeSize = this.timestamps.size;
    
    // Remove old timestamps
    const toDelete = [];
    for (const [item, timestamp] of this.timestamps) {
      if (now - timestamp > maxAge) {
        toDelete.push(item);
      }
    }
    
    toDelete.forEach(item => this.timestamps.delete(item));
    
    // If still too many, remove oldest
    if (this.timestamps.size > this.maxTimestamps * 0.8) {
      const sorted = Array.from(this.timestamps.entries())
        .sort((a, b) => a[1] - b[1]);
      
      const toRemove = sorted.slice(0, sorted.length - Math.floor(this.maxTimestamps * 0.7));
      toRemove.forEach(([item]) => this.timestamps.delete(item));
    }
    
    // Reset bloom filters if we removed many items
    if (this.timestamps.size < beforeSize / 2) {
      console.log(`Resetting bloom filters (cleaned ${beforeSize - this.timestamps.size} items)`);
      const remainingItems = Array.from(this.timestamps.keys());
      this.levels.forEach(level => {
        level.filter = new BloomFilter(level.filter.size, level.filter.numHashes);
      });
      remainingItems.forEach(item => {
        this.levels.forEach(level => level.filter.add(item));
      });
    }
  }

  reset() {
    this.levels.forEach(level => {
      level.filter = new BloomFilter(level.filter.size, level.filter.numHashes);
    });
    this.timestamps.clear();
  }
  
  getStats() {
    return {
      totalItems: this.timestamps.size,
      levels: this.levels.map(level => ({
        name: level.name,
        size: level.filter.bits.length * 8,
        maxAge: level.maxAge
      }))
    };
  }
}


export const wait = ms => new Promise(r => setTimeout(r, ms));
    
export async function waitForWebTorrent() {
      if (CONFIG.LOCAL_MODE) return;
      const t0 = performance.now();
      while (typeof WebTorrent === "undefined") {
        if (performance.now() - t0 > 10_000) throw new Error("WebTorrent failed to load in 10 s");
        await wait(100);
      }
    }


export const generateId = () => {
  const bytes = new Uint8Array(16); // 128 bits of randomness
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};
export function sanitize(content) {
  // 1. Trim early
  if (content.length > CONFIG.MAX_POST_SIZE) {
    content = content.slice(0, CONFIG.MAX_POST_SIZE);
  }

  // 2. Use DOMPurify when available with SAFE settings
  if (DOMPurify) {
    const purified = DOMPurify.sanitize(content, {
      ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a', 'code', 'br'],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
      ALLOW_URI_WITHOUT_PROTOCOL: false,  // CHANGED: Disallow protocol-less URLs
      ALLOWED_URI_REGEXP: /^https?:\/\//,  // ADDED: Only allow http/https
      RETURN_TRUSTED_TYPE: false
    });

    // 3. Force safe link behaviour
    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        // Additional check for javascript: URLs
        if (node.getAttribute('href').toLowerCase().startsWith('javascript:')) {
          node.removeAttribute('href');
        }
      }
    });

    return purified;
  }

  // 4. Fallback: plain-text escape
  const d = document.createElement('div');
  d.textContent = content;
  return d.innerHTML;
}

export function sanitizeDM(content) {
  // Force text-only for DMs
  const d = document.createElement('div');
  d.textContent = content;
  return d.innerHTML;
}


export function timeAgo(ts) {
      const s = ~~((Date.now() - ts) / 1000);
      if (s < 5) return "just now";
      if (s < 60) return `${s}s ago`;
      const m = ~~(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = ~~(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${~~(h / 24)}d ago`;
    }
    
export function notify(msg, dur = 3000) {
      const n = document.createElement("div");
      n.className = "notification";
      n.textContent = msg;
      document.body.appendChild(n);
      setTimeout(() => {
        n.style.animationDirection = "reverse";
        setTimeout(() => n.remove(), 300);
      }, dur);
    }


export function arrayBufferToBase64(buffer) {
    if (!buffer) return null;
    if (typeof buffer === 'string') return buffer; // Already base64
    
    // Handle various buffer-like objects
    let bytes;
    if (buffer instanceof Uint8Array) {
        bytes = buffer;
    } else if (buffer instanceof ArrayBuffer) {
        bytes = new Uint8Array(buffer);
    } else if (buffer.buffer instanceof ArrayBuffer) {
        // Handle typed arrays
        bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } else if (buffer.data) {
        // Handle objects with data property
        bytes = new Uint8Array(buffer.data);
    } else {
        console.error('Unknown buffer type:', typeof buffer, buffer);
        return null;
    }
    
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export const base64ToArrayBuffer = (base64) => {
    // Handle null/undefined
    if (!base64) return null;
    
    // If it's already an ArrayBuffer or Uint8Array, return as is
    if (base64 instanceof ArrayBuffer) return new Uint8Array(base64);
    if (base64 instanceof Uint8Array) return base64;
    
    // If it's an object with data property (from JSON serialization)
    if (typeof base64 === 'object' && base64.data) {
        return new Uint8Array(base64.data);
    }
    
    // Only process strings
    if (typeof base64 !== 'string') {
        console.error('Invalid input for base64 decoding:', typeof base64, base64);
        return null;
    }
    
    try {
        // Remove any whitespace
        const cleaned = base64.trim();
        
        // Validate base64 string
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        if (!base64Regex.test(cleaned)) {
            console.error('Invalid base64 string format:', cleaned.substring(0, 50) + '...');
            return null;
        }
        
        const binary = atob(cleaned);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    } catch (e) {
        console.error('Failed to decode base64:', e.message, 'Input:', base64.substring(0, 50) + '...');
        return null;
    }
};
export function normalizePeerId(id) {
  if (!id) return null;

  if (typeof id === 'string') {
    return id;
  } else if (id instanceof Uint8Array) {
    return Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (id && id.constructor && id.constructor.name === 'Buffer') {
    const uint8 = new Uint8Array(id);
    return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (id && (id.type === 'Buffer' || id.data)) {
    const uint8 = new Uint8Array(id.data || id);
    return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (ArrayBuffer.isView(id)) {
    const uint8 = new Uint8Array(id.buffer, id.byteOffset, id.byteLength);
    return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  console.error('Unknown peer ID type:', typeof id, id);
  return null;
}

export function hexToUint8Array (hex) {
  if (hex.length % 2) throw new Error('hex length must be even');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export const JSONStringifyWithBigInt = (obj) => {
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString() + 'n'; // Add 'n' suffix to identify BigInts
        }
        return value;
    });
};

export const JSONParseWithBigInt = (str) => {
    return JSON.parse(str, (key, value) => {
        // More strict check for BigInt format
        if (typeof value === 'string' && /^\d+n$/.test(value)) {
            // Additional validation: check if the number part is valid
            const numPart = value.slice(0, -1);
            if (/^\d+$/.test(numPart) && numPart.length < 100) { // Limit BigInt size
                try {
                    return BigInt(numPart);
                } catch (e) {
                    // If BigInt creation fails, return original string
                    return value;
                }
            }
        }
        return value;
    });
};
export const isReply = (post) => post && post.parentId;
