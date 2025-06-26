use wasm_bindgen::prelude::*;
use num_bigint::{BigUint, RandBigInt};
use num_traits::One;
use num_integer::Integer;
use sha2::{Sha256, Digest};
use rand::thread_rng;
use base64::{Engine as _, engine::general_purpose};
use js_sys::Function; 

// Enable console logging for debugging
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

// Use a wrapper struct for WASM since wasm_bindgen doesn't like String fields
#[wasm_bindgen]
pub struct VDFProof {
    y: String,     // Base64 encoded
    pi: String,    // Base64 encoded
    l: String,     // Base64 encoded
    r: String,     // Base64 encoded
    iterations: u64,
}

#[wasm_bindgen]
impl VDFProof {
    #[wasm_bindgen(constructor)]
    pub fn new(y: String, pi: String, l: String, r: String, iterations: u64) -> Self {
        VDFProof { y, pi, l, r, iterations }
    }
    
    #[wasm_bindgen(getter)]
    pub fn y(&self) -> String {
        self.y.clone()
    }
    
    #[wasm_bindgen(getter)]
    pub fn pi(&self) -> String {
        self.pi.clone()
    }
    
    #[wasm_bindgen(getter)]
    pub fn l(&self) -> String {
        self.l.clone()
    }
    
    #[wasm_bindgen(getter)]
    pub fn r(&self) -> String {
        self.r.clone()
    }
    
    #[wasm_bindgen(getter)]
    pub fn iterations(&self) -> u64 {
        self.iterations
    }
}

#[wasm_bindgen]
pub struct VDFComputer {
    modulus: BigUint,
}

#[wasm_bindgen]
impl VDFComputer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let modulus_hex = "C7970CEEDCC3B0754490201A7AA613CD73911081C790F5F1A8726F463550BB5B7FF0DB8E1EA1189EC72F93D1650011BD721AEEACC2ACDE32A04107F0648C2813A31F5B0B7765FF8B44B4B6FFC93384B646EB09C7CF5E8592D40EA33C80039F35B4F14A04B51F7BFD781BE4D1673164BA8EB991C2C4D730BBBE35F592BDEF524AF7E8DAEFD26C66FC02C479AF89D64D373F442709439DE66CEB955F3EA37D5159F6135809F85334B5CB1813ADDC80CD05609F10AC6A95AD65872C909525BDAD32BC729592642920F24C61DC5B3C3B7923E56B16A4D9D373D8721F24A3FC0F1B3131F55615172866BCCC30F95054C824E733A5EB6817F7BC16399D48C6361CC7E5";
        
        let modulus = BigUint::parse_bytes(modulus_hex.as_bytes(), 16)
            .expect("Failed to parse modulus");
        
        VDFComputer { modulus }
    }
    
    #[wasm_bindgen]
    pub fn compute_proof(&self, input: &str, iterations: u64, on_progress: &Function) -> Result<VDFProof, JsValue> {
        match self.compute_proof_internal(input, iterations, on_progress) {
            Ok(proof) => Ok(proof),
            Err(ref e) => Err(JsValue::from_str(e)), 
        }
    }
    
    #[wasm_bindgen]
    pub fn verify_proof(&self, input: &str, proof: &VDFProof) -> Result<bool, JsValue> {
        match self.verify_proof_internal(input, proof) {
            Ok(result) => Ok(result),
            Err(ref e) => Err(JsValue::from_str(e)),
        }
    }
    
    fn compute_proof_internal(&self, input: &str, iterations: u64, on_progress: &Function) -> Result<VDFProof, String> {
        if iterations < 1000 || iterations > 10_000_000 {
            return Err(format!("Invalid iterations: {}", iterations));
        }
        
        // Hash input to get starting value
        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        let hash = hasher.finalize();
        let x = BigUint::from_bytes_be(&hash);
        
        // Generate proof prime l (~128 bits)
        let l = generate_prime(128)?;
        
        // Calculate r = 2^t mod l
        let r = BigUint::from(2u32).modpow(&BigUint::from(iterations), &l);
        
        // Calculate y = x^(2^t) mod N using repeated squaring
        let mut y = x.clone();
        
        // Progress tracking for long computations
        let chunk_size = 1000;
        let chunks = iterations / chunk_size;
        let remainder = iterations % chunk_size;

        // Define the `this` context for the JavaScript function call
        let this = JsValue::null();
        
        for i in 0..chunks {
            for _ in 0..chunk_size {
                y = (&y * &y) % &self.modulus;
            }
            
            // Report progress back to JavaScript, for example every 1%
                let progress = (i * 100) / chunks;
                let progress_val = JsValue::from_f64(progress as f64);
                // Call the JavaScript callback function
                let _ = on_progress.call1(&this, &progress_val);
            
        }
        
        for _ in 0..remainder {
            y = (&y * &y) % &self.modulus;
        }

        // Final progress update to 100% to ensure it completes
        let _ = on_progress.call1(&this, &JsValue::from_f64(100.0));
        
        // Calculate q = (2^t - r) / l safely using the full 2^t
        let power = calculate_power_safely(iterations)?;
        let q_times_l = power - r.clone();
        let q = &q_times_l / &l;
        
        // Calculate proof π = x^q mod N
        let pi = x.modpow(&q, &self.modulus);
        
        Ok(VDFProof {
            y: general_purpose::STANDARD.encode(y.to_bytes_be()),
            pi: general_purpose::STANDARD.encode(pi.to_bytes_be()),
            l: general_purpose::STANDARD.encode(l.to_bytes_be()),
            r: general_purpose::STANDARD.encode(r.to_bytes_be()),
            iterations,
        })
    }
    
    fn verify_proof_internal(&self, input: &str, proof: &VDFProof) -> Result<bool, String> {
        // Validate iterations
        if proof.iterations < 1000 || proof.iterations > 10_000_000 {
            return Err(format!("Invalid iterations: {}", proof.iterations));
        }
        
        // Hash input
        let mut hasher = Sha256::new();
        hasher.update(input.as_bytes());
        let hash = hasher.finalize();
        let x = BigUint::from_bytes_be(&hash);
        
        // Decode base64 values
        let y = base64_to_biguint(&proof.y)?;
        let pi = base64_to_biguint(&proof.pi)?;
        let l = base64_to_biguint(&proof.l)?;
        let r = base64_to_biguint(&proof.r)?;
        
        // Verify l is a reasonable prime
        if l.bits() < 120 || !is_probable_prime(&l, 5) {
            return Err("Invalid proof prime l".to_string());
        }
        
        // Verify: y == pi^l * x^r mod N
        let pi_l = pi.modpow(&l, &self.modulus);
        let x_r = x.modpow(&r, &self.modulus);
        let right_side = (pi_l * x_r) % &self.modulus;
        
        Ok(y == right_side)
    }
}

// Helper functions
fn base64_to_biguint(b64: &str) -> Result<BigUint, String> {
    let bytes = general_purpose::STANDARD.decode(b64)
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    
    if bytes.is_empty() {
        return Err("Empty bytes".to_string());
    }
    
    Ok(BigUint::from_bytes_be(&bytes))
}

// Generate a prime of specified bit length
fn generate_prime(bits: usize) -> Result<BigUint, String> {
    let mut rng = thread_rng();
    let max_attempts = 1000;
    
    for _ in 0..max_attempts {
        // Generate random odd number
        let mut candidate = rng.gen_biguint(bits as u64);
        candidate |= BigUint::one(); // Make odd
        candidate |= BigUint::one() << (bits - 1); // Set high bit
        
        if is_probable_prime(&candidate, 20) {
            return Ok(candidate);
        }
    }
    
    Err("Failed to generate prime".to_string())
}

// Miller-Rabin primality test
fn is_probable_prime(n: &BigUint, k: usize) -> bool {
    
    if n <= &BigUint::one() {
        return false;
    }
    
    if n == &BigUint::from(2u32) || n == &BigUint::from(3u32) {
        return true;
    }
    
    if n.is_even() {
        return false;
    }
    
    // Write n-1 as 2^r * d
    let one = BigUint::one();
    let two = BigUint::from(2u32);
    let n_minus_1 = n - &one;
    
    let mut r = 0;
    let mut d = n_minus_1.clone();
    
    while d.is_even() {
        d >>= 1;
        r += 1;
    }
    
    // Witness loop
    let mut rng = thread_rng();
    
    'witness: for _ in 0..k {
        // Random a in [2, n-2]
        let a = rng.gen_biguint_range(&two, &(n - &two));
        
        let mut x = a.modpow(&d, n);
        
        if x == one || x == n_minus_1 {
            continue 'witness;
        }
        
        for _ in 0..r-1 {
            x = x.modpow(&two, n);
            if x == n_minus_1 {
                continue 'witness;
            }
        }
        
        return false;
    }
    
    true
}

// Additional helper for JavaScript
#[wasm_bindgen]
pub fn estimate_iterations_for_seconds(seconds: f64) -> u64 {
    // Rough estimate: ~10M iterations per second on modern hardware
    // This will vary significantly by device
    let base_rate = 10_000_000.0;
    let iterations = (seconds * base_rate) as u64;
    
    // Clamp to reasonable bounds
    iterations.max(1000).min(10_000_000)
}
    fn calculate_power_safely(iterations: u64) -> Result<BigUint, String> {
        if iterations == 0 {
            return Ok(BigUint::one()); // 2^0 = 1
        }
        
        let base = BigUint::from(2u32);
        let mut exp_val = iterations;
        let mut result = BigUint::one();
        let mut current_power = base;

        while exp_val > 0 {
            if exp_val % 2 == 1 {
                result *= &current_power;
            }
            current_power = &current_power * &current_power;
            exp_val /= 2;
        }
        Ok(result)
    }
