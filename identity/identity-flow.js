import { state } from '../main.js';
import { notify, showConnectScreen, updateLoadingMessage } from '../ui.js';
import { JSONParseWithBigInt, JSONStringifyWithBigInt, arrayBufferToBase64, base64ToArrayBuffer } from '../utils.js';
import wasmVDF from '../vdf-wrapper.js';
import {broadcast} from '../p2p/network-manager.js';

/* ---------- IDENTITY ---------- */
export async function initIdentity() {
  return new Promise(async (resolve, reject) => {
    
    // First, try to load a saved identity from localStorage.
    const stored = localStorage.getItem("ephemeral-id");
    if (stored) {
      try {
        const identity = JSONParseWithBigInt(stored);

        
        // Convert the stored secret key back to a Uint8Array
        if (identity.secretKey) {
            if (Array.isArray(identity.secretKey)) {
                identity.secretKey = new Uint8Array(identity.secretKey);
            } else if (typeof identity.secretKey === 'string') {
                identity.secretKey = new Uint8Array(identity.secretKey.split(',').map(Number));
            } else {
                console.warn("Unexpected type for identity.secretKey during load:", typeof identity.secretKey);
                identity.secretKey = null;
            }
        }
        // Convert the public key from base64 back to Uint8Array
        if (identity.publicKey) {
            identity.publicKey = base64ToArrayBuffer(identity.publicKey);
        }
        if (identity.vdfProof && identity.vdfProof.iterations) {
            // Ensure iterations is a BigInt
            if (typeof identity.vdfProof.iterations === 'string') {
                identity.vdfProof.iterations = BigInt(identity.vdfProof.iterations);
            } else if (typeof identity.vdfProof.iterations === 'number') {
                identity.vdfProof.iterations = BigInt(identity.vdfProof.iterations);
            }
        }
        // If the identity is valid, set it as the current state and resolve the promise.
        if (identity.publicKey && identity.secretKey && identity.handle) {
          state.myIdentity = identity;
          // This successfully completes the function.
          return resolve(); 
        }
      } catch (e) {
        console.error("Failed to load identity, creating a new one.", e);
        // If loading fails, we proceed to the identity creation UI below.
      }
    }

    // If no valid stored identity was found, proceed to create a new one.
    // This code is the original identity creation logic, now acting as the "else" path.
    const overlay = document.getElementById('identity-creation-overlay');
    const step0 = document.getElementById('identity-step-0-disclaimer');
    const acknowledgeButton = document.getElementById('acknowledge-button');
    const step1 = document.getElementById('identity-step-1-calibrate');
    const step2 = document.getElementById('identity-step-2-pow');
    const step3 = document.getElementById('identity-step-3-prompt');

    async function startVdfProcess() {

      // --- Step 1: Calibration ---
      step1.innerHTML = `
        <div class="spinner"></div>
        <div id="identity-status-text">
          <strong>Step 1/3:</strong> Calibrating your device's performance...<br/>
          This will take a few seconds.
        </div>
      `;
      step1.style.display = 'block';

          try {
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

            // --- Step 2: UI Setup ---
            step1.style.display = 'none';
            step2.innerHTML = `
              <div class="spinner"></div>
              <div id="identity-status-text-2">
                <strong>Step 2/3:</strong> Computing your unique identity proof...
              </div>
              <progress id="identity-progress-bar" value="0" max="100"></progress>
              <div id="identity-progress-percent">0%</div>
            `;
            step2.style.display = 'block';

            const progressBar = document.getElementById('identity-progress-bar');
            const progressPercent = document.getElementById('identity-progress-percent');
            
            // **This is now clean and easy to read**
            const onProgress = (percentage) => {
                if (progressBar) progressBar.value = percentage;
                if (progressPercent) progressPercent.textContent = `${Math.round(percentage)}%`;
            };
            
            
            const uniqueId = Math.random().toString(36).substr(2, 9);
            const vdfInput = "ephemeral-identity-creation-" + uniqueId;
            
            // The call looks like a simple async function, but is now non-blocking!
            const wasmProof = await wasmVDF.computeVDFProofWithTimeout(
                vdfInput, 
                targetIterations, 
                onProgress
            );
            
            // Convert the special WASM object to a plain JavaScript object.**
            const proofResult = {
                y: wasmProof.y,
                pi: wasmProof.pi,
                l: wasmProof.l,
                r: wasmProof.r,
                // Ensure iterations is a standard number for JSON compatibility
                iterations: wasmProof.iterations 
            };


        // --- Step 3: Handle selection ---
        step2.style.display = 'none';
        step3.innerHTML = `
          <p>Identity proof complete! Please choose your unique handle.</p>
          <input type="text" id="identity-handle-input" placeholder="e.g., alice_crypto" />
          <button id="identity-confirm-button" class="primary-button">Register Identity</button>
          <div style="font-size: 12px; color: #666; margin-top: 10px;">
            Your proof: ${Number(targetIterations).toLocaleString()} iterations completed
          </div>
        `;
        step3.style.display = 'block';
        
        const handleInput = document.getElementById('identity-handle-input');
        const confirmButton = document.getElementById('identity-confirm-button');

        const finalize = async () => {
            const handle = handleInput.value.trim();
            
            if (!handle) {
              notify("Please enter a handle");
              return;
            }
            
            if (handle.length < 3) {
              notify("Handle must be at least 3 characters");
              return;
            }
            
            if (!/^[a-zA-Z0-9_]+$/.test(handle)) {
              notify("Handle can only contain letters, numbers, and underscores");
              return;
            }
            
            // Check if handle is available
            try {
              if (state.identityRegistry) {
                const existingClaim = await state.identityRegistry.lookupHandle(handle);
                if (existingClaim) {
                  notify(`Handle "${handle}" is already taken. Please choose another.`);
                  return;
                }
              }
            } catch (e) {
              console.warn("Could not check handle availability:", e);
            }
            
            const keyPair = nacl.sign.keyPair();
            const hashBuffer = await crypto.subtle.digest('SHA-1', keyPair.publicKey);
           let nodeId;
            try {
              const hashBuffer = await crypto.subtle.digest('SHA-1', keyPair.publicKey);
              nodeId = new Uint8Array(hashBuffer);
            } catch (e) {
              console.error("Failed to generate node ID with crypto.subtle:", e);
              // Fallback to simple random node ID
              nodeId = new Uint8Array(20);
              crypto.getRandomValues(nodeId);
              console.log("Using fallback random node ID");
            }

            const proof = {
                y: proofResult.y,
                pi: proofResult.pi,
                l: proofResult.l,
                r: proofResult.r,
                 iterations: BigInt(proofResult.iterations),
            };
            console.log('[Identity Creation] VDF proof created:', {
                hasIterations: !!proof.iterations,
                iterationsType: typeof proof.iterations,
                iterationsValue: proof.iterations.toString()
            });
            
            console.log('[Debug] WASM proof object:', {
    type: typeof wasmProof,
    constructor: wasmProof.constructor.name,
    iterations: wasmProof.iterations,
    iterations_getter: wasmProof.iterations,
    hasIterationsMethod: typeof wasmProof.iterations === 'function',
    allProperties: Object.getOwnPropertyNames(wasmProof),
    prototype: Object.getPrototypeOf(wasmProof)
});
            
             try {
              // **Construct the identity object first.**
              // Note that 'isRegistered' is now false, as we are waiting for the network.
              state.myIdentity = {
                handle: handle,
                publicKey: arrayBufferToBase64(keyPair.publicKey),
                secretKey: keyPair.secretKey,
                vdfProof: proof,
                vdfInput: vdfInput,
                uniqueId: uniqueId,
                nodeId: nodeId,
                identityClaim: null, // This will be populated by the network later
                isRegistered: false, // Not yet confirmed by the network
                registrationVerified: false, // Not yet confirmed
                deviceCalibration: {
                  iterationsPerMs: iterationsPerMs,
                  calibrationTime: calibrationTime,
                  targetIterations: Number(targetIterations)
                }
              };
            // Sign the core claim data**
            const claimDataToSign = JSONStringifyWithBigInt({
                handle: state.myIdentity.handle,
                publicKey: state.myIdentity.publicKey, // Use the base64 version
                vdfProof: state.myIdentity.vdfProof
            });
            const signature = nacl.sign(new TextEncoder().encode(claimDataToSign), keyPair.secretKey);

            // **Attach the signature to the claim object before broadcasting**
            state.myIdentity.signature = signature;
            
              // ** Broadcast the new identity as a "provisional claim".**
              // This replaces the direct call to state.identityRegistry.registerIdentity().
              broadcast({
                type: 'provisional_identity_claim',
                claim: state.myIdentity
              });
              
            //  Track our own claim while we wait for confirmations.
            state.provisionalIdentities.set(state.myIdentity.handle, {
                claim: state.myIdentity,
                confirmations: new Set() // Start with an empty set of confirmers
            });

              notify('Broadcasting identity claim to the network for confirmation...');
              
            
            // Serialize for localStorage
            const serializableIdentity = {
                ...state.myIdentity,
                publicKey: arrayBufferToBase64(keyPair.publicKey),
                secretKey: Array.from(keyPair.secretKey),
                vdfProof: state.myIdentity.vdfProof, // Include VDF proof
                deviceCalibration: state.myIdentity.deviceCalibration // Include calibration data
            };
            localStorage.setItem("ephemeral-id", JSONStringifyWithBigInt(serializableIdentity));
              document.getElementById('identity-creation-overlay').style.display = 'none';
              
              // This resolves the main promise, completing the function.
              resolve(); 
              
            } catch (error) {
              notify(`Registration failed: ${error.message}`);
              console.error("Identity registration failed:", error);
              confirmButton.textContent = "Register Identity";
              confirmButton.disabled = false;
            }
        };

        confirmButton.onclick = finalize;
        handleInput.onkeydown = (e) => {
          if (e.key === 'Enter') finalize();
        };
        
        handleInput.focus();
        
      } catch (error) {
        console.error("VDF calibration failed:", error);
        step1.style.display = 'none';
        step2.innerHTML = `
          <div style="text-align: center;">
            <h3>Calibration Failed</h3>
            <p>Unable to calibrate your device's performance.</p>
            <button onclick="location.reload()" class="primary-button">Try Again</button>
          </div>
        `;
        step2.style.display = 'block';
      }
    }

    acknowledgeButton.onclick = () => {
      step0.style.display = 'none';
      startVdfProcess();
    };

    overlay.style.display = 'flex';
  });
}
