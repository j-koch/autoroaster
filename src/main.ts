/**
 * Main entry point for the AutoRoaster web application
 * 
 * This file initializes the roaster simulator by creating an instance
 * and loading the ONNX models. The RoasterSimulator class handles all
 * UI management and simulation logic internally.
 */

import { RoasterSimulator } from './simulator/RoasterSimulator';
import * as ort from 'onnxruntime-web';

/**
 * Main initialization function
 * Creates the simulator instance and loads models
 */
async function main(): Promise<void> {
  try {
    console.log('Initializing AutoRoaster...');
    
    // Set up info overlay close handlers FIRST, before loading models
    // This ensures the modal controls work immediately
    setupInfoOverlay();
    
    // Configure ONNX Runtime Web BEFORE any model loading
    // Use CDN for WASM files to avoid bundling issues
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.16.3/dist/';
    ort.env.wasm.numThreads = 1; // Disable multi-threading for compatibility
    ort.env.wasm.simd = true; // Enable SIMD for performance
    
    console.log('ONNX Runtime WASM path configured:', ort.env.wasm.wasmPaths);
    
    // Create simulator instance
    // The constructor automatically sets up all UI event listeners
    const simulator = new RoasterSimulator();
    
    // Load ONNX models
    // This is an async operation that loads:
    // - roast_stepper.onnx (physics model)
    // - bean_*.onnx (bean thermal models)
    // - state_estimator.onnx (state estimation)
    // - control_policy.onnx (neural controller, optional)
    await simulator.loadModels();
    
    // Store simulator instance globally for external access
    // (e.g., profile editor, game API)
    window.simulator = simulator;
    
    console.log('✅ AutoRoaster initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize AutoRoaster:', error);
    
    // Show error to user
    const errorDiv = document.getElementById('error');
    const loadingDiv = document.getElementById('loading');
    if (errorDiv) {
      errorDiv.textContent = `Failed to initialize: ${error instanceof Error ? error.message : String(error)}`;
      errorDiv.style.display = 'block';
    }
    if (loadingDiv) {
      loadingDiv.style.display = 'none';
    }
  }
}

/**
 * Setup the info overlay modal handlers
 */
function setupInfoOverlay(): void {
  const overlay = document.getElementById('info-overlay');
  const closeButton = overlay?.querySelector('.close-button');
  const getStartedButton = overlay?.querySelector('.get-started-button');
  
  // Function to close the overlay
  const closeOverlay = () => {
    overlay?.classList.add('hidden');
  };
  
  // Close button handler
  closeButton?.addEventListener('click', closeOverlay);
  
  // Get started button handler
  getStartedButton?.addEventListener('click', closeOverlay);
  
  // Click outside modal to close
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeOverlay();
    }
  });
  
  // Store close function globally for external access
  window.closeInfoOverlay = closeOverlay;
  window.showInfoOverlay = () => {
    overlay?.classList.remove('hidden');
  };
}

// Wait for DOM to be ready, then initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  // DOM is already loaded
  main();
}
