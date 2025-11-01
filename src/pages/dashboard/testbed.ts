/**
 * Digital Testbed Module
 * 
 * This module provides a digital twin simulator interface integrated into the dashboard.
 * It allows users to select roaster, bean, and controller models, then interact with
 * a virtual roaster in real-time.
 */

import { RoasterSimulator } from '../../simulator/RoasterSimulator';

/**
 * Testbed class manages the digital testbed interface
 * Handles model loading, simulator initialization, and UI state
 */
export class Testbed {
  private simulator: RoasterSimulator | null = null;
  
  // Selected model filenames
  private selectedRoasterModel: string = 'roast_stepper.onnx';
  private selectedBeanModel: string = 'bean_guji.onnx';
  private selectedController: string = 'manual';
  
  // DOM elements
  private readonly loadingDiv: HTMLDivElement;
  private readonly errorDiv: HTMLDivElement;
  private readonly controlsDiv: HTMLDivElement;
  private readonly emptyState: HTMLDivElement;
  private readonly simulatorDiv: HTMLDivElement;
  private readonly statusDiv: HTMLDivElement;
  private readonly loadBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  
  constructor() {
    console.log('Initializing Digital Testbed...');
    
    // Get DOM elements with proper type assertions
    this.loadingDiv = document.getElementById('testbed-loading') as HTMLDivElement;
    this.errorDiv = document.getElementById('testbed-error') as HTMLDivElement;
    this.controlsDiv = document.getElementById('testbed-controls') as HTMLDivElement;
    this.emptyState = document.getElementById('testbed-empty') as HTMLDivElement;
    this.simulatorDiv = document.getElementById('testbed-simulator') as HTMLDivElement;
    this.statusDiv = document.getElementById('testbed-status') as HTMLDivElement;
    this.loadBtn = document.getElementById('testbed-load-btn') as HTMLButtonElement;
    this.resetBtn = document.getElementById('testbed-reset-btn') as HTMLButtonElement;
    
    this.initializeUI();
  }
  
  /**
   * Initialize UI event listeners for model selection and actions
   */
  private initializeUI(): void {
    // Model selection dropdowns
    const roasterModelSelect = document.getElementById('testbed-roaster-model') as HTMLSelectElement;
    const beanModelSelect = document.getElementById('testbed-bean-model') as HTMLSelectElement;
    const controllerModelSelect = document.getElementById('testbed-controller-model') as HTMLSelectElement;
    
    // Update selected models when dropdowns change
    if (roasterModelSelect) {
      roasterModelSelect.addEventListener('change', (e) => {
        this.selectedRoasterModel = (e.target as HTMLSelectElement).value;
      });
    }
    
    if (beanModelSelect) {
      beanModelSelect.addEventListener('change', (e) => {
        this.selectedBeanModel = (e.target as HTMLSelectElement).value;
      });
    }
    
    if (controllerModelSelect) {
      controllerModelSelect.addEventListener('change', (e) => {
        this.selectedController = (e.target as HTMLSelectElement).value;
      });
    }
    
    // Load models button
    this.loadBtn.addEventListener('click', () => this.loadModels());
    
    // Reset button
    this.resetBtn.addEventListener('click', () => this.resetSimulation());
    
    // Hide loading, show controls
    this.loadingDiv.style.display = 'none';
    this.controlsDiv.style.display = 'block';
  }
  
  /**
   * Load selected ONNX models and initialize the simulator
   */
  private async loadModels(): Promise<void> {
    try {
      console.log('Loading models...', {
        roaster: this.selectedRoasterModel,
        bean: this.selectedBeanModel,
        controller: this.selectedController
      });
      
      // Disable load button and show loading state
      this.loadBtn.disabled = true;
      this.loadBtn.textContent = 'Loading...';
      this.errorDiv.style.display = 'none';
      
      // Configure ONNX Runtime Web
      ort.env.wasm.numThreads = 1; // Single-threaded to avoid WASM issues
      ort.env.wasm.simd = true; // Enable SIMD for performance
      
      // Create a custom RoasterSimulator instance for the testbed
      // We'll pass element IDs with 'testbed-' prefix
      this.simulator = this.createTestbedSimulator();
      
      // Load the models
      await this.simulator.loadModels();
      
      // Show success state
      this.loadBtn.style.display = 'none';
      this.resetBtn.style.display = 'inline-block';
      this.statusDiv.style.display = 'block';
      this.emptyState.style.display = 'none';
      this.simulatorDiv.style.display = 'block';
      
      console.log('✅ Testbed models loaded successfully');
      
    } catch (error) {
      console.error('Failed to load testbed models:', error);
      this.showError(`Failed to load models: ${(error as Error).message}`);
      this.loadBtn.disabled = false;
      this.loadBtn.textContent = 'Load Models';
    }
  }
  
  /**
   * Create a RoasterSimulator instance customized for the testbed
   * This creates temporary element aliases so RoasterSimulator can find the testbed elements
   */
  private createTestbedSimulator(): RoasterSimulator {
    // The RoasterSimulator class expects specific element IDs
    // We'll temporarily add aliases to our testbed elements so it can find them
    
    // Create a mapping of expected IDs to testbed IDs
    const elementMapping = {
      'temperature-chart': 'testbed-temperature-chart',
      'control-chart': 'testbed-control-chart',
      'heater-slider': 'testbed-heater-slider',
      'fan-slider': 'testbed-fan-slider',
      'mass-slider': 'testbed-mass-slider',
      'ambient-slider': 'testbed-ambient-slider',
      'speedup-select': 'testbed-speedup-select',
      'heater-value': 'testbed-heater-value',
      'fan-value': 'testbed-fan-value',
      'mass-value': 'testbed-mass-value',
      'ambient-value': 'testbed-ambient-value',
      'charge-btn': 'testbed-charge-btn',
      'drop-btn': 'testbed-drop-btn',
      'reset-btn': 'testbed-reset-btn',
      'roast-phase': 'testbed-phase',
      'bean-temp': 'testbed-bean-temp',
      'env-temp': 'testbed-env-temp',
      'roaster-temp': 'testbed-roaster-temp',
      'air-temp': 'testbed-air-temp',
      'roast-time': 'testbed-roast-time',
      'rate-of-rise': 'testbed-rate-of-rise',
      'loading': 'testbed-loading',
      'error': 'testbed-error',
      'bean-model-select': 'testbed-bean-model'
    };
    
    // Temporarily set IDs on testbed elements to match what RoasterSimulator expects
    for (const [expectedId, testbedId] of Object.entries(elementMapping)) {
      const element = document.getElementById(testbedId);
      if (element && !document.getElementById(expectedId)) {
        // Store the original ID
        element.setAttribute('data-original-id', testbedId);
        // Set the ID that RoasterSimulator expects
        element.id = expectedId;
      }
    }
    
    // Create the simulator instance - it will now find the elements
    const simulator = new RoasterSimulator();
    
    return simulator;
  }
  
  /**
   * Reset the simulation to initial state
   */
  private resetSimulation(): void {
    if (this.simulator) {
      // Reset simulator state (call reset method if available)
      // For now, we'll reload the models
      this.simulatorDiv.style.display = 'none';
      this.emptyState.style.display = 'block';
      this.statusDiv.style.display = 'none';
      this.resetBtn.style.display = 'none';
      this.loadBtn.style.display = 'inline-block';
      this.loadBtn.disabled = false;
      this.loadBtn.textContent = 'Load Models';
      
      console.log('Testbed reset');
    }
  }
  
  /**
   * Display error message to user
   */
  private showError(message: string): void {
    this.errorDiv.textContent = message;
    this.errorDiv.style.display = 'block';
  }
  
  /**
   * Check if testbed is currently active/visible
   */
  isActive(): boolean {
    const testbedView = document.getElementById('testbed-view');
    return testbedView?.classList.contains('active') || false;
  }
}
