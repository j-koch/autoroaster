/**
 * Digital Testbed Module
 * 
 * This module provides a digital twin simulator interface integrated into the dashboard.
 * It allows users to select trained roaster and bean models, then interact with
 * a virtual roaster in real-time using manual controls.
 * 
 * Key features:
 * - Load trained System ID models (roaster physics)
 * - Load trained bean models (bean thermal dynamics)
 * - Manual control only (no PID or neural control)
 * - Real-time visualization matching index.html layout
 */

import { TestbedSimulator } from '../../simulator/TestbedSimulator';
import { supabase } from '../../lib/supabase';

/**
 * Training job configuration structure
 * These parameters control the data preprocessing, model architecture, and training process
 */
interface TrainingConfig {
    data?: {
        batch_size: number;
        sequence_length: number;
        stride: number;
        include_mass: boolean;
        include_dt: boolean;
        feature_sets: string[];
        delay: {
            time_horizon: number;
            num_points: number;
        };
    };
    model?: {
        n_latents: number;
        roaster_type: string;
        roaster_hidden_dims: number[];
        estimator_hidden_dim: number;
    };
    training?: {
        lr: number;
        max_epochs: number;
        patience: number;
        plot_interval: number;
        estim_weight?: number;
        cb_weight?: number;
        charge_weight?: number;
        air_temp_weight?: number;
        scheduler_factor: number;
        scheduler_patience: number;
        scheduler_min_lr: number;
        scheduler_verbose: boolean;
    };
    bean_hidden_dims?: number[]; // For bean models
}

/**
 * Training job record from the database
 * Status can be: pending, running, completed, or failed
 * Completed training jobs are effectively "trained models"
 */
interface TrainingJob {
    id: string;
    user_id: string;
    job_name: string | null;
    status: 'pending' | 'running' | 'completed' | 'failed';
    config: TrainingConfig;
    roast_file_ids: string[];
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    duration_seconds: number | null;
    error_message: string | null;
    loss_history: {
        total?: number[];
        recon?: number[];
        estim?: number[];
    } | null;
}

/**
 * Determine if a model is a roaster or bean model based on its configuration
 * Bean models have bean_hidden_dims in their config, roaster models don't
 * @param model - The training job (model) to check
 * @returns 'roaster' or 'bean'
 */
function getModelType(model: TrainingJob): 'roaster' | 'bean' {
    // Check if config has bean_hidden_dims property (bean model)
    if ((model.config as any).bean_hidden_dims) {
        return 'bean';
    }
    // Check if config has the full roaster model structure
    if (model.config.model && model.config.data) {
        return 'roaster';
    }
    // Default to roaster for backward compatibility
    return 'roaster';
}

/**
 * Testbed class manages the digital testbed interface
 * Handles model loading, simulator initialization, and UI state
 */
export class Testbed {
  private simulator: TestbedSimulator | null = null;
  
  // Selected model IDs (from training_jobs table)
  private selectedRoasterModelId: string = '';
  private selectedBeanModelId: string = '';
  
  // DOM elements - sidebar
  private readonly loadingDiv: HTMLDivElement;
  private readonly errorDiv: HTMLDivElement;
  private readonly emptyState: HTMLDivElement;
  private readonly loadBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly modelSelectionDiv: HTMLDivElement;
  private readonly controlsSection: HTMLDivElement;
  private readonly actionButtons: HTMLDivElement;
  
  // DOM elements - main area
  private readonly chartsContainer: HTMLDivElement;
  private readonly statusSection: HTMLDivElement;
  
  constructor() {
    console.log('Initializing Digital Testbed...');
    
    // Get sidebar DOM elements
    this.loadingDiv = document.getElementById('testbed-loading') as HTMLDivElement;
    this.errorDiv = document.getElementById('testbed-error') as HTMLDivElement;
    this.emptyState = document.getElementById('testbed-empty') as HTMLDivElement;
    this.loadBtn = document.getElementById('testbed-load-btn') as HTMLButtonElement;
    this.resetBtn = document.getElementById('testbed-reset-btn') as HTMLButtonElement;
    this.modelSelectionDiv = document.getElementById('testbed-model-selection') as HTMLDivElement;
    this.controlsSection = document.getElementById('testbed-controls-section') as HTMLDivElement;
    this.actionButtons = document.getElementById('testbed-action-buttons') as HTMLDivElement;
    
    // Get main area DOM elements
    this.chartsContainer = document.getElementById('testbed-charts-container') as HTMLDivElement;
    this.statusSection = document.getElementById('testbed-status-section') as HTMLDivElement;
    
    this.initializeUI();
  }
  
  /**
   * Initialize UI event listeners for model selection and actions
   */
  private async initializeUI(): Promise<void> {
    // Load available trained models from Supabase
    await this.loadAvailableModels();
    
    // Model selection dropdowns
    const roasterModelSelect = document.getElementById('testbed-roaster-model') as HTMLSelectElement;
    const beanModelInitialSelect = document.getElementById('testbed-bean-model-initial') as HTMLSelectElement;
    
    // Update selected model IDs when dropdowns change
    if (roasterModelSelect) {
      roasterModelSelect.addEventListener('change', (e) => {
        this.selectedRoasterModelId = (e.target as HTMLSelectElement).value;
      });
    }
    
    if (beanModelInitialSelect) {
      beanModelInitialSelect.addEventListener('change', (e) => {
        this.selectedBeanModelId = (e.target as HTMLSelectElement).value;
      });
    }
    
    // Load models button
    this.loadBtn.addEventListener('click', () => this.loadModels());
    
    // Reset button
    this.resetBtn.addEventListener('click', () => this.resetSimulation());
  }
  
  /**
   * Load available trained models from Supabase and populate dropdowns
   * Following training.ts pattern: completed training jobs ARE the trained models
   */
  private async loadAvailableModels(): Promise<void> {
    try {
      if (this.loadingDiv) {
        this.loadingDiv.style.display = 'block';
      }
      
      // Query for completed training jobs (these are our "models")
      const { data, error } = await supabase
        .from('training_jobs')
        .select('*')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false });
      
      if (error) throw error;
      
      const allModels = (data as TrainingJob[]) || [];
      
      // Separate roaster and bean models
      const roasterModels = allModels.filter(model => getModelType(model) === 'roaster');
      const beanModels = allModels.filter(model => getModelType(model) === 'bean');
      
      // Populate roaster model dropdown
      const roasterSelect = document.getElementById('testbed-roaster-model') as HTMLSelectElement;
      if (roasterSelect) {
        roasterSelect.innerHTML = '<option value="">-- Select from trained models --</option>';
        roasterModels.forEach((model: TrainingJob) => {
          const option = document.createElement('option');
          option.value = model.id;
          const modelName = model.job_name || `Model ${model.id.slice(0, 8)}`;
          const date = new Date(model.completed_at!).toLocaleDateString();
          option.textContent = `${modelName} (${date})`;
          roasterSelect.appendChild(option);
        });
      }
      
      // Populate bean model dropdown
      const beanSelect = document.getElementById('testbed-bean-model-initial') as HTMLSelectElement;
      if (beanSelect) {
        beanSelect.innerHTML = '<option value="">-- Select from trained models --</option>';
        beanModels.forEach((model: TrainingJob) => {
          const option = document.createElement('option');
          option.value = model.id;
          const modelName = model.job_name || `Model ${model.id.slice(0, 8)}`;
          const date = new Date(model.completed_at!).toLocaleDateString();
          option.textContent = `${modelName} (${date})`;
          beanSelect.appendChild(option);
        });
      }
      
      if (this.loadingDiv) {
        this.loadingDiv.style.display = 'none';
      }
      
    } catch (error) {
      console.error('Failed to load available models:', error);
      this.showError(`Failed to load model list: ${(error as Error).message}`);
      if (this.loadingDiv) {
        this.loadingDiv.style.display = 'none';
      }
    }
  }
  
  /**
   * Load selected ONNX models and initialize the simulator
   */
  private async loadModels(): Promise<void> {
    try {
      // Validate model selection
      if (!this.selectedRoasterModelId || !this.selectedBeanModelId) {
        this.showError('Please select both a roaster model and a bean model');
        return;
      }
      
      console.log('Loading models...', {
        roaster: this.selectedRoasterModelId,
        bean: this.selectedBeanModelId
      });
      
      // Disable load button and show loading state
      if (this.loadBtn) {
        this.loadBtn.disabled = true;
        this.loadBtn.textContent = 'Loading...';
      }
      if (this.errorDiv) {
        this.errorDiv.style.display = 'none';
      }
      if (this.loadingDiv) {
        this.loadingDiv.style.display = 'block';
      }
      
      // TODO: Download models from Supabase storage and load them
      // Storage path format: {user_id}/jobs/{job_id}/model.onnx
      // For now, use placeholder pre-trained models from public folder
      // This will be replaced with actual Supabase storage download logic
      
      // Configure ONNX Runtime Web
      if (typeof ort !== 'undefined') {
        ort.env.wasm.numThreads = 1; // Single-threaded to avoid WASM issues
        ort.env.wasm.simd = true; // Enable SIMD for performance
      }
      
      // Create a TestbedSimulator instance (no need for element remapping)
      this.simulator = new TestbedSimulator();
      
      // Load the models
      await this.simulator.loadModels();
      
      // Hide model selection, show controls and simulator UI
      this.modelSelectionDiv.style.display = 'none';
      this.controlsSection.style.display = 'block';
      this.actionButtons.style.display = 'flex';
      this.emptyState.style.display = 'none';
      this.chartsContainer.style.display = 'flex';  // Show merged charts container
      this.statusSection.style.display = 'block';
      this.loadingDiv.style.display = 'none';
      
      // Show roast phase indicator
      const phaseDiv = document.getElementById('testbed-phase') as HTMLDivElement;
      if (phaseDiv) {
        phaseDiv.style.display = 'block';
      }
      
      console.log('✅ Testbed models loaded successfully');
      
    } catch (error) {
      console.error('Failed to load testbed models:', error);
      this.showError(`Failed to load models: ${(error as Error).message}`);
      if (this.loadBtn) {
        this.loadBtn.disabled = false;
        this.loadBtn.textContent = 'Load Models & Start';
      }
      if (this.loadingDiv) {
        this.loadingDiv.style.display = 'none';
      }
    }
  }
  
  
  /**
   * Reset the simulation to initial state
   */
  private resetSimulation(): void {
    if (this.simulator) {
      // Hide simulator UI elements
      this.chartsContainer.style.display = 'none';  // Hide merged charts container
      this.statusSection.style.display = 'none';
      this.controlsSection.style.display = 'none';
      this.actionButtons.style.display = 'none';
      
      // Hide phase indicator
      const phaseDiv = document.getElementById('testbed-phase') as HTMLDivElement;
      if (phaseDiv) {
        phaseDiv.style.display = 'none';
      }
      
      // Show empty state and model selection
      this.emptyState.style.display = 'block';
      this.modelSelectionDiv.style.display = 'block';
      this.loadBtn.disabled = false;
      this.loadBtn.textContent = 'Load Models & Start';
      
      // Clear simulator instance
      this.simulator = null;
      
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
