import nacl from 'tweetnacl';
import { notify } from '../ui.js';
import { serviceCallbacks } from '../services/callbacks.js';
import { state } from '../state.js';
import { arrayBufferToBase64, JSONStringifyWithBigInt } from '../utils.js';
import { HyParView } from '../p2p/hyparview.js';
import { LocalIdentity } from '../models/local-identity.js';

import wasmVDF from '../vdf-wrapper.js';

export async function createNewIdentity() {
  return new Promise(async (resolve, reject) => {
          console.log('[DEBUG] createNewIdentity called.'); //

    const overlay = document.getElementById('identity-creation-overlay');
    const step0 = document.getElementById('identity-step-0-disclaimer');
    const acknowledgeButton = document.getElementById('acknowledge-button');
    
    acknowledgeButton.onclick = () => {
              console.log('[DEBUG] Acknowledge button clicked.'); //

      step0.style.display = 'none';
      showHandleSelection();
    };
    
    overlay.style.display = 'flex';
    
    async function showHandleSelection() {
              console.log('[DEBUG] showHandleSelection called.'); //

      const step3 = document.getElementById('identity-step-3-prompt');
      
      step3.innerHTML = `
        <p>Choose your unique handle:</p>
        <input type="text" id="identity-handle-input" placeholder="e.g., alice_crypto" />
        <div id="handle-availability" style="margin-top: 10px; font-size: 12px;"></div>
        <button id="identity-confirm-button" class="primary-button" disabled>Claim Handle</button>
      `;
      step3.style.display = 'block';
      
      const handleInput = document.getElementById('identity-handle-input');
      const availabilityDiv = document.getElementById('handle-availability');
      const confirmButton = document.getElementById('identity-confirm-button');
      
      let checkTimeout;
      let lastCheckedHandle = '';
      
      // Real-time handle checking
      handleInput.oninput = async (e) => {
        const handle = e.target.value.trim();
        
        // Clear previous timeout
        if (checkTimeout) clearTimeout(checkTimeout);
        
        // Validate format first
        if (!handle) {
          availabilityDiv.innerHTML = '';
          confirmButton.disabled = true;
          return;
        }
        
        if (handle.length < 3) {
          availabilityDiv.innerHTML = '<span style="color: #ff6b4a">Handle must be at least 3 characters</span>';
          confirmButton.disabled = true;
          return;
        }
        
        if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
          availabilityDiv.innerHTML = '<span style="color: #ff6b4a">Only letters, numbers, and underscores allowed</span>';
          confirmButton.disabled = true;
          return;
        }
        
        // Show checking status
        availabilityDiv.innerHTML = '<span style="color: #ff8c42">Checking availability...</span>';
        confirmButton.disabled = true;
        
        // Debounce the actual check
        checkTimeout = setTimeout(async () => {
                      console.log('[DEBUG] Checking handle availability for:', handle); //

          try {
            // First check if we even have peers
            if (state.peers.size === 0) {
              // We're the first node! All handles are available
                            console.log('[DEBUG] No peers found. Assuming handle is available.'); //

              availabilityDiv.innerHTML = '<span style="color: #44ff44">✓ Handle available! (First node)</span>';
              confirmButton.disabled = false;
              lastCheckedHandle = handle;
                            console.log('[DEBUG] lastCheckedHandle is now:', lastCheckedHandle); //

              return;
            }
            
            // Set a timeout for the DHT lookup
            const checkPromise = state.identityRegistry.lookupHandle(handle);
            const timeoutPromise = new Promise((resolve) => 
              setTimeout(() => resolve({ timeout: true }), 5000)
            );
            
            const result = await Promise.race([checkPromise, timeoutPromise]);
            
            if (handle !== handleInput.value.trim()) return; // Handle changed while checking
            
            if (result && result.timeout) {
              // DHT lookup timed out - probably no peers responding
              availabilityDiv.innerHTML = '<span style="color: #ffa500">⚠️ Network timeout - proceeding anyway</span>';
              confirmButton.disabled = false;
              lastCheckedHandle = handle;
            } else if (result) {
              availabilityDiv.innerHTML = '<span style="color: #ff6b4a">❌ Handle already taken</span>';
              confirmButton.disabled = true;
            } else {
              // Check if handle exists in DHT even if verification failed
              try {
                const pubkeyB64 = await state.dht.get(`handle-to-pubkey:${handle.toLowerCase()}`);
                if (pubkeyB64) {
                  // Handle exists but verification failed - still taken!
                  availabilityDiv.innerHTML = '<span style="color: #ff6b4a">❌ Handle already taken</span>';
                  confirmButton.disabled = true;
                  console.log('[DEBUG] Handle exists in DHT but verification failed');
                  return;
                }
              } catch (e) {
                console.error('[DEBUG] Error checking DHT directly:', e);
              }
              
              // Handle is truly available
              availabilityDiv.innerHTML = '<span style="color: #44ff44">✓ Handle available!</span>';
              confirmButton.disabled = false;
              lastCheckedHandle = handle;
            }
          } catch (e) {
            // Network error - we might be the only node
            console.warn("Handle check failed:", e);
            availabilityDiv.innerHTML = '<span style="color: #ffa500">⚠️ Network unavailable - proceeding as first node</span>';
            confirmButton.disabled = false;
            lastCheckedHandle = handle;
          }
        }, 500);// 500ms debounce
      };
      
      confirmButton.onclick = async () => {
        const handle = handleInput.value.trim();
                console.log('[DEBUG] Claim Handle button clicked.'); //
        console.log('[DEBUG] Current handle value:', handle); //
        console.log('[DEBUG] lastCheckedHandle value:', lastCheckedHandle); //

        // Double-check it's still available
        if (handle !== lastCheckedHandle) {
                      console.log('[DEBUG] Gatekeeper FAILED: handle does not match lastCheckedHandle.'); //

          availabilityDiv.innerHTML = '<span style="color: #ff6b4a">Please wait for availability check</span>';
          return;
        }
                console.log('[DEBUG] Gatekeeper PASSED. Proceeding to VDF computation.'); //

        // Disable inputs during VDF computation
        handleInput.disabled = true;
        confirmButton.disabled = true;
        
        // Now compute VDF
        await computeVDFAndRegister(handle, resolve,reject);
      };
      
      handleInput.focus();
    }
    
    async function computeVDFAndRegister(handle, resolve, reject) {
      const step3 = document.getElementById('identity-step-3-prompt');
      const step2 = document.getElementById('identity-step-2-pow');
      
      // Hide handle selection
      step3.style.display = 'none';
      
      // Show VDF computation
      step2.innerHTML = `
        <div class="spinner"></div>
        <div id="identity-status-text-2">
          <strong>Computing proof of work for:</strong> ${handle}
        </div>
        <progress id="identity-progress-bar" value="0" max="100"></progress>
        <div id="identity-progress-percent">0%</div>
      `;
      step2.style.display = 'block';
      
      try {
        // Calibration (quick)
        const calibrationIterations = 5000n;
        const calibrationStart = performance.now();
        await wasmVDF.computeVDFProofWithTimeout(
            "calibration-test",
            calibrationIterations,
            () => {}
        );
        const calibrationTime = performance.now() - calibrationStart;
        
        const iterationsPerMs = Number(calibrationIterations) / calibrationTime;
        const targetWorkTime = 30000;
        const targetIterations = BigInt(Math.max(1000, Math.min(Math.floor(iterationsPerMs * targetWorkTime), 1000000)));
        
        // Compute VDF
        const progressBar = document.getElementById('identity-progress-bar');
        const progressPercent = document.getElementById('identity-progress-percent');
        
        const onProgress = (percentage) => {
            if (progressBar) progressBar.value = percentage;
            if (progressPercent) progressPercent.textContent = `${Math.round(percentage)}%`;
        };
        
        const uniqueId = Math.random().toString(36).substr(2, 9);
        const vdfInput = "ephemeral-identity-creation-" + handle + "-" + uniqueId;
        
        const wasmProof = await wasmVDF.computeVDFProofWithTimeout(
            vdfInput, 
            targetIterations, 
            onProgress
        );
        
        const proofResult = {
            y: wasmProof.y,
            pi: wasmProof.pi,
            l: wasmProof.l,
            r: wasmProof.r,
            iterations: wasmProof.iterations
        };
        
        // Generate keypair
        const keyPair = nacl.sign.keyPair();
        const encryptionKeyPair = nacl.box.keyPair(); // NEW: encryption keys
        const nodeId = new Uint8Array(await crypto.subtle.digest('SHA-1', keyPair.publicKey));
                const idKey = Array.from(nodeId).map(b => b.toString(16).padStart(2, '0')).join('');

        // Create identity object with default profile
             const identity = {
            handle: handle,
            publicKey: arrayBufferToBase64(keyPair.publicKey),
            secretKey: keyPair.secretKey,
            encryptionPublicKey: arrayBufferToBase64(encryptionKeyPair.publicKey), 
            encryptionSecretKey: encryptionKeyPair.secretKey, 
            vdfProof: proofResult,
    
        vdfInput: vdfInput,
            uniqueId: uniqueId,
            nodeId: nodeId,
            idKey: idKey, 
            deviceCalibration: {
                iterationsPerMs: iterationsPerMs,
                calibrationTime: calibrationTime,
                targetIterations: Number(targetIterations)
 
           },
            profile: {
                handle: handle,
                bio: '',
                profilePictureHash: null,
                theme: {
        
            backgroundColor: '#000000',
                    fontColor: '#ffffff',
                    accentColor: '#ff1493'
                },
                updatedAt: Date.now()
            
            }
        };
        state.myIdentity = new LocalIdentity(identity);

        // Register immediately in DHT
        try {
            const identityClaim = await state.identityRegistry.registerIdentity(
                handle,
                keyPair,
                encryptionKeyPair.publicKey, 
                proofResult,
                vdfInput
            );
            state.myIdentity.identityClaim = identityClaim;
            state.myIdentity.isRegistered = true;
            state.myIdentity.registrationVerified = true;
            state.myIdentity.signature = identityClaim.signature;
            state.myIdentity.claimedAt = identityClaim.claimedAt;
        } catch (e) {
            // This will now correctly catch if a handle is already taken
            notify(e.message);
            // Re-show the handle selection screen so the user can pick another
            step2.style.display = 'none';
            showHandleSelection();
            reject(e); // <--  Reject the main promise on registration failure
            return; // Stop the process
        }
        
        
        // Update the DHT nodeId now that we have our real identity
        if (state.dht && state.myIdentity.nodeId) {
          state.dht.nodeId = state.myIdentity.nodeId;
          state.dht.bootstrap().catch(e => console.error("DHT bootstrap failed:", e));
          // Re-initialize HyParView with correct node ID
          if (state.hyparview) {
            state.hyparview.destroy();
          }
          state.hyparview = new HyParView(state.myIdentity.nodeId, state.dht);
          // Don't await bootstrap here as it might block
          state.hyparview.bootstrap().catch(e => 
            console.error("HyParView bootstrap failed:", e)
          );
        }
        
        
        // Save to localStorage
        const serializableIdentity = {
            ...state.myIdentity,
            publicKey: arrayBufferToBase64(keyPair.publicKey),
            secretKey: Array.from(keyPair.secretKey),
            encryptionPublicKey: arrayBufferToBase64(encryptionKeyPair.publicKey), 
            encryptionSecretKey: Array.from(encryptionKeyPair.secretKey), 
            vdfProof: state.myIdentity.vdfProof,
            deviceCalibration: state.myIdentity.deviceCalibration,
            nodeId: Array.from(state.myIdentity.nodeId),
            profile: state.myIdentity.profile
        };
        localStorage.setItem("ephemeral-id", JSON.stringify(state.myIdentity.toJSON()));

        
        // Success!
        step2.innerHTML = `
          <div style="text-align: center;">
            <h3 style="color: #44ff44;">✓ Identity Registered!</h3>
            <p>Welcome to Ember, <strong>${handle}</strong>!</p>
          </div>
        `;

        // ADDED: Broadcast initial profile
        console.log('[Identity] Broadcasting initial profile...');
        await serviceCallbacks.broadcastProfileUpdate(state.myIdentity.profile);
        console.log('[Identity] Initial profile broadcast complete');

        setTimeout(() => {
          document.getElementById('identity-creation-overlay').style.display = 'none';
          notify(`Identity "${handle}" successfully registered! 🎉`);
          serviceCallbacks.initializeUserProfileSection();
          resolve();
        }, 2000);
        
    } catch (error) {
        console.error("Identity registration failed:", error);
        step2.innerHTML = `
          <div style="text-align: center;">
            <h3 style="color: #ff6b4a;">Registration Failed</h3>
            <p>${error.message}</p>
            <button onclick="location.reload()" class="primary-button">Try Again</button>
          </div>
        `;
        reject(error);
      }
    }
  });
}
