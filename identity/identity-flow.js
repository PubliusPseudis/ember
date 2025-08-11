import nacl from 'tweetnacl';
import { notify } from '../ui.js';
import { serviceCallbacks } from '../services/callbacks.js';
import { state } from '../state.js';
import { arrayBufferToBase64, JSONStringifyWithBigInt,  deriveKeyFromPassword, encryptVault, decryptVault } from '../utils.js';
import { HyParView } from '../p2p/hyparview.js';
import { LocalIdentity } from '../models/local-identity.js';

import wasmVDF from '../vdf-wrapper.js';


export async function unlockIdentity(encryptedIdentity) {
  return new Promise((resolve, reject) => {
    // Use the dedicated UNLOCK overlay (has the password fields)
    const overlay = document.getElementById('unlock-overlay');
    // Make sure the creation overlay is hidden so it doesn't sit under/steal focus
    const creationOverlay = document.getElementById('identity-creation-overlay');
    if (creationOverlay) creationOverlay.style.display = 'none';
    
    
    // Ensure the loading screen doesn't block the unlock UI
    const loadingOverlay = document.getElementById('loading');
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    // Belt-and-suspenders in case CSS z-index competes
    overlay.style.zIndex = '10001';
    overlay.style.display = 'flex';

    const passwordInput = document.getElementById('unlock-password');
    const errorDiv = document.getElementById('unlock-error');
    const unlockButton = document.getElementById('unlock-button');
    const resetButton = document.getElementById('reset-identity-button');

    const hide = () => { overlay.style.display = 'none'; };

    passwordInput.focus();
    passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlockButton.click();
    });

    unlockButton.onclick = async () => {
      const password = passwordInput.value;
      if (!password) {
        errorDiv.textContent = 'Please enter your password.';
        return;
      }

      unlockButton.disabled = true;
      unlockButton.textContent = 'Decrypting...';
      errorDiv.textContent = '';

      try {
        // Derive key and decrypt the vault
        const salt = new Uint8Array(encryptedIdentity.encryptedVault.salt);
        const key = await deriveKeyFromPassword(password, salt);
        const decrypted = await decryptVault(encryptedIdentity.encryptedVault, key);

        // Restore secret keys (handle either plain arrays or Uint8Array)
        const toU8 = (v) => (v instanceof Uint8Array ? v : new Uint8Array(v));
        encryptedIdentity.secretKey = toU8(decrypted.secretKey);
        encryptedIdentity.encryptionSecretKey = toU8(decrypted.encryptionSecretKey);

        hide();
        resolve(encryptedIdentity);
      } catch (err) {
        console.error('Decryption failed:', err);
        errorDiv.textContent = 'Incorrect password. Please try again.';
        unlockButton.disabled = false;
        unlockButton.textContent = 'Unlock';
        passwordInput.focus();
        passwordInput.select();
      }
    };

    resetButton.onclick = () => {
      hide();
      reject(new Error('Password forgotten'));
    };
  });
}


export async function createNewIdentity() {
  // Safety check to prevent double creation
  if (state.myIdentity && window.identityReady) {
    console.warn("[Identity] Attempted to create new identity when one already exists");
    return;
  }
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
    const loadingOverlay = document.getElementById('loading');
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    overlay.style.zIndex = '10001';
    overlay.style.display = 'flex';



    async function promptForPassword(identity, resolve, reject) {
      const step2 = document.getElementById('identity-step-2-pow');
      const step4 = document.getElementById('identity-step-4-password');
      const passwordInput = document.getElementById('identity-password');
      const confirmInput = document.getElementById('identity-password-confirm');
      const errorDiv = document.getElementById('password-error');
      const finishButton = document.getElementById('set-password-button');

      step2.style.display = 'none';
      step4.style.display = 'block';
      passwordInput.focus();

      finishButton.onclick = async () => {
        const password = passwordInput.value;
        const confirm = confirmInput.value;

        if (!password || password.length < 8) {
          errorDiv.textContent = 'Password must be at least 8 characters.';
          return;
        }
        if (password !== confirm) {
          errorDiv.textContent = 'Passwords do not match.';
          return;
        }
        errorDiv.textContent = '';
        finishButton.disabled = true;
        finishButton.textContent = 'Encrypting...';

        try {
          // 1. Generate a salt
          const salt = crypto.getRandomValues(new Uint8Array(16));

          // 2. Derive the encryption key
          const key = await deriveKeyFromPassword(password, salt);

          // 3. Prepare the secret data for the vault
          const secretData = {
            secretKey: Array.from(identity.secretKey),
            encryptionSecretKey: Array.from(identity.encryptionSecretKey),
          };

          // 4. Encrypt the data
          const encryptedVault = await encryptVault(secretData, key);

          // 5. Create the vault object to be stored
          const vaultToStore = {
            ...encryptedVault,
            salt: Array.from(salt),
            kdf: 'PBKDF2',
            iterations: 310000,
          };

          // 6. Update the identity object for storage
          // IMPORTANT: Remove raw secret keys and add the encrypted vault
          state.myIdentity = new LocalIdentity({
            ...identity,
            secretKey: null, // Remove raw key
            encryptionSecretKey: null, // Remove raw key
            encryptedVault: vaultToStore, // Add vault
          });

          // 7. Save the now-secure identity object
          localStorage.setItem("ephemeral-id", JSON.stringify(state.myIdentity.toJSON()));

          // 8. Decrypt keys into memory for the current session
          const decrypted = await decryptVault(vaultToStore, key);
          state.myIdentity.secretKey = new Uint8Array(decrypted.secretKey);
          state.myIdentity.encryptionSecretKey = new Uint8Array(decrypted.encryptionSecretKey);

          // 9. Finish
          step4.innerHTML = `<h3 style="color: #44ff44;">✓ Identity Secured!</h3><p>Welcome, <strong>${identity.handle}</strong>!</p>`;
          await serviceCallbacks.broadcastProfileUpdate(state.myIdentity.profile);

          setTimeout(() => {
            document.getElementById('identity-creation-overlay').style.display = 'none';
            notify(`Identity "${identity.handle}" successfully registered! 🎉`);
            serviceCallbacks.initializeUserProfileSection();
            resolve();
          }, 2000);

        } catch (err) {
          errorDiv.textContent = `Encryption failed: ${err.message}`;
          finishButton.disabled = false;
          finishButton.textContent = 'Set Password & Finish';
          reject(err);
        }
      };
    }


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
    const encryptionKeyPair = nacl.box.keyPair();
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
    
    const createdIdentity = new LocalIdentity(identity);

    try {
      const identityClaim = await state.identityRegistry.registerIdentity(
          handle,
          keyPair,
          encryptionKeyPair.publicKey,
          proofResult,
          vdfInput
      );
      createdIdentity.identityClaim = identityClaim;
      createdIdentity.isRegistered = true;
      createdIdentity.registrationVerified = true;
      createdIdentity.signature = identityClaim.signature;
      createdIdentity.claimedAt = identityClaim.claimedAt;
      
    } catch (e) {
      // This will now correctly catch if a handle is already taken
      notify(e.message);
      // Re-show the handle selection screen so the user can pick another
      step2.style.display = 'none';
      showHandleSelection();
      reject(e);
      return;
    }
    
    // CRITICAL: DO NOT save to localStorage or state here!
    // Just pass the identity to password creation
    // The promptForPassword function will handle saving after encryption
    
    // Update the DHT nodeId now that we have our real identity
    if (state.dht && createdIdentity.nodeId) {
      state.dht.nodeId = createdIdentity.nodeId;
      state.dht.bootstrap().catch(e => console.error("DHT bootstrap failed:", e));
      // Re-initialize HyParView with correct node ID
      if (state.hyparview) {
        state.hyparview.destroy();
      }
      state.hyparview = new HyParView(createdIdentity.nodeId, state.dht);
      // Don't await bootstrap here as it might block
      state.hyparview.bootstrap().catch(e => 
        console.error("HyParView bootstrap failed:", e)
      );
    }
    
    // REMOVED: All the localStorage saving code that was here
    // REMOVED: The success UI that was here
    
    // Proceed directly to password creation
    await promptForPassword(createdIdentity, resolve, reject);
    
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
