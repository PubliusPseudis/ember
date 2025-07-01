// headless.js - Fixed version with comprehensive browser API mocking

import fs from 'fs';
import { JSONParseWithBigInt, base64ToArrayBuffer } from './utils.js';
import wasmVDF from './vdf-wrapper.js';
import { StatelessManager } from './stateless-manager.js';


async function main() {
  console.log("🔥 Initializing Headless Ember Relay Node...");

  try {
    // FIRST: Set up comprehensive global polyfills for Node.js environment
    // This must happen BEFORE importing main.js
    const { default: WebTorrent } = await import('webtorrent');

    // Create a mock window object with all properties ui.js might access
    globalThis.window = {
      currentDMConversation: null,
      ephemeralDebug: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
      location: { reload: () => {} },
      animationObserver: null,
      RTCPeerConnection: class {},
      WebTorrent: WebTorrent, 
      networkStartTime: Date.now()
    };
        console.log('[DEBUG in headless.js] The value of window.WebTorrent is now:', globalThis.window.WebTorrent);

    // Mock document
    globalThis.document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: {
          add: () => {},
          remove: () => {},
          toggle: () => {},
          contains: () => false
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        innerHTML: '',
        textContent: '',
        appendChild: () => {},
        querySelector: () => null,
        querySelectorAll: () => []
      }),
      body: {
        appendChild: () => {},
        classList: {
          add: () => {},
          remove: () => {},
          contains: () => false
        }
      },
      head: {
        appendChild: () => {}
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      hidden: false
    };
    
    // Mock localStorage
    const localStorageData = {};
    globalThis.localStorage = {
      getItem: (key) => localStorageData[key] || null,
      setItem: (key, value) => { localStorageData[key] = value; },
      removeItem: (key) => { delete localStorageData[key]; },
      clear: () => { for (let key in localStorageData) delete localStorageData[key]; }
    };
    
    // Mock other browser APIs
    globalThis.navigator = {
        userAgent: 'node.js', // Provide a mock user agent
        platform: 'linux'     // Provide a mock platform
    };
    globalThis.IntersectionObserver = class {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    
    globalThis.DOMPurify = {
      sanitize: (content) => content,
      addHook: () => {}
    };
    
    // Mock CustomEvent
    globalThis.CustomEvent = class CustomEvent {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict?.detail;
      }
    };
    
    // Mock crypto.subtle if not available
    if (!globalThis.crypto) {
      globalThis.crypto = {
        getRandomValues: (arr) => {
          for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
          }
          return arr;
        },
        subtle: {
          digest: async (algorithm, data) => {
            // Simple mock - in production you'd use Node's crypto
            return new ArrayBuffer(32);
          }
        }
      };
    }
    
    // Mock performance.memory
    if (!globalThis.performance) {
      globalThis.performance = {
        now: () => Date.now(),
        memory: {
          usedJSHeapSize: 50 * 1024 * 1024,
          jsHeapSizeLimit: 100 * 1024 * 1024
        }
      };
    }
    
    // Mock alert, confirm
    globalThis.alert = (msg) => console.log(`[ALERT] ${msg}`);
    globalThis.confirm = (msg) => {
      console.log(`[CONFIRM] ${msg} (auto-accepting in headless mode)`);
      return true;
    };
    
    // Mock nacl if needed
    if (!globalThis.nacl) {
      try {
        const { default: nacl } = await import('tweetnacl');
        globalThis.nacl = nacl;
      } catch (e) {
        console.warn("Could not load tweetnacl, some crypto functions may fail");
      }
    }
    
    

    globalThis.openDMPanel = (handle) => console.log(`[UI] openDMPanel called for ${handle} (no-op)`);
    globalThis.closeDMPanel = () => console.log('[UI] closeDMPanel called (no-op)');
    globalThis.sendDM = () => console.log('[UI] sendDM called (no-op)');
    globalThis.switchDrawer = (drawerId) => console.log(`[UI] switchDrawer called for ${drawerId} (no-op)`);

    // Mock content safety for headless
    globalThis.contentSafety = {
      checkContent: async (text) => ({ safe: true, violations: [], shouldBlock: false }),
      quickCheck: async (text) => ({ safe: true, violations: [], shouldBlock: false })
    };

    // NOW: Import main.js after all mocks are set up
    const mainModule = await import('./main.js');
    const { state, initNetworkWithTempId, initializeP2PProtocols, startMaintenanceLoop, verificationQueue, stateManager } = mainModule;

    // Replace stateManager with stateless version
    const statelessManager = new StatelessManager();
    Object.setPrototypeOf(stateManager, StatelessManager.prototype);
    Object.assign(stateManager, statelessManager);

    // Override any UI functions that might have been exposed globally
    if (globalThis.window) {
      const uiFunctions = [
        'createPostWithTopics', 'toggleCarry', 'createReply', 'handleImageSelect',
        'removeImage', 'toggleReplyForm', 'subscribeToTopic', 'filterByTopic',
        'setFeedMode', 'discoverAndFilterTopic', 'completeTopicSuggestion',
        'scrollToPost', 'clearLocalData', 'handleReplyImageSelect', 'removeReplyImage',
        'openDMPanel', 'closeDMPanel', 'sendDM', 'toggleThread', 'switchDrawer'
      ];
      
      uiFunctions.forEach(func => {
        globalThis.window[func] = () => {
          console.log(`[UI] ${func} called (no-op in headless mode)`);
        };
      });
    }

    // Rest of your existing code...
    // 1. Load Identity
    if (!fs.existsSync('headless-identity.json')) {
      console.error("❌ headless-identity.json not found! Please create an identity first:");
      console.error("   1. Run the browser version");
      console.error("   2. Create an identity");
      console.error("   3. Copy localStorage.getItem('ephemeral-id') to headless-identity.json");
      process.exit(1);
    }

    const identityData = fs.readFileSync('headless-identity.json', 'utf-8');
    const identityJSON = JSONParseWithBigInt(identityData);
    
    // Convert stored data back to proper types
    state.myIdentity = {
      ...identityJSON,
      secretKey: new Uint8Array(identityJSON.secretKey),
      encryptionSecretKey: new Uint8Array(identityJSON.encryptionSecretKey),
      publicKey: base64ToArrayBuffer(identityJSON.publicKey),
      encryptionPublicKey: base64ToArrayBuffer(identityJSON.encryptionPublicKey),
      nodeId: new Uint8Array(identityJSON.nodeId),
      vdfProof: { 
        ...identityJSON.vdfProof, 
        iterations: BigInt(identityJSON.vdfProof.iterations) 
      }
    };
    
    console.log(`✅ Relay node identity loaded for handle: ${state.myIdentity.handle}`);

    // 2. Initialize Core Services
    console.log("🔧 Initializing WASM VDF...");
    await wasmVDF.initialize();
    
    console.log("🔧 Initializing verification queue...");
    await verificationQueue.init();

    // 3. Start Networking
    console.log("🌐 Initializing network stack...");
    await initNetworkWithTempId(state.myIdentity.nodeId);
    
    // Give the DHT time to bootstrap before starting higher-level protocols
    console.log("⏳ Waiting for DHT bootstrap...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log("🔧 Initializing P2P protocols...");
    initializeP2PProtocols();

    // 4. Start Maintenance
    console.log("🔧 Starting maintenance loop...");
    startMaintenanceLoop();

    console.log("✅ Headless Ember Relay Node is online and ready!");
    console.log(`📊 Node ID: ${Array.from(state.myIdentity.nodeId).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 12)}...`);
    console.log("🔥 Listening for network activity and carrying the flame...");

    // Log periodic status
    setInterval(() => {
      const peerCount = state.peers?.size || 0;
      const postCount = state.posts?.size || 0;
      const dhtPeers = state.dht?.getStats()?.totalPeers || 0;
      
      console.log(`[HEARTBEAT] Peers: ${peerCount}, Posts: ${postCount}, DHT: ${dhtPeers} nodes`);
    }, 60000); // Every minute

  } catch (error) {
    console.error("❌ Failed to initialize headless node:", error);
    console.error("Stack trace:", error.stack);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔥 Gracefully shutting down Ember relay node...');
  
  if (globalThis.state?.client) {
    globalThis.state.client.destroy();
  }
  
  if (globalThis.state?.dht) {
    globalThis.state.dht.shutdown();
  }
  
  console.log('✅ Shutdown complete. The flame lives on in other nodes.');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🔥 Received SIGTERM, shutting down...');
  process.exit(0);
});

// Start the headless node
main().catch(err => {
  console.error("❌ A fatal error occurred in the headless node:", err);
  process.exit(1);
});
