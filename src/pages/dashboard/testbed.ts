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
      
      // Separate roaster and bean models (same logic as RecipeGenerator)
      const roasterModels = allModels.filter(m => !m.config.bean_hidden_dims);
      const beanModels = allModels.filter(m => m.config.bean_hidden_dims);
      
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
   * Load selected ONNX models from Supabase storage and initialize the simulator
   * Downloads the user's trained models and creates ONNX Runtime sessions
   */
  private async loadModels(): Promise<void> {
    try {
      // Validate model selection
      if (!this.selectedRoasterModelId || !this.selectedBeanModelId) {
        this.showError('Please select both a roaster model and a bean model');
        return;
      }
      
      console.log('Loading ONNX models from Supabase storage...', {
        roasterId: this.selectedRoasterModelId,
        beanId: this.selectedBeanModelId
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
      
      // Configure ONNX Runtime Web
      if (typeof ort !== 'undefined') {
        ort.env.wasm.numThreads = 1; // Single-threaded to avoid WASM issues
        ort.env.wasm.simd = true; // Enable SIMD for performance
        console.log('✓ ONNX Runtime configured');
      } else {
        throw new Error('ONNX Runtime not available - please ensure ort is loaded from CDN');
      }
      
      // Get current user
      console.log('Getting authenticated user...');
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) {
        console.error('Auth error:', authError);
        throw new Error(`Authentication error: ${authError.message}`);
      }
      if (!user) {
        throw new Error('Not authenticated - please log in');
      }
      console.log('✓ User authenticated:', user.id);
      
      // First, let's check what files exist in storage for debugging
      await this.listStorageFiles(user.id, this.selectedRoasterModelId);
      await this.listStorageFiles(user.id, this.selectedBeanModelId);
      
      // Download roaster model (roast_stepper.onnx)
      console.log('Downloading roaster model...');
      const roasterModelBlob = await this.downloadModelFromStorage(
        user.id,
        this.selectedRoasterModelId,
        'roast_stepper.onnx'
      );
      
      // Validate blob before attempting to load
      console.log(`Roaster model blob size: ${roasterModelBlob.size} bytes, type: ${roasterModelBlob.type}`);
      if (roasterModelBlob.size === 0) {
        throw new Error('Downloaded roaster model file is empty');
      }
      
      // Get bean model metadata to find the correct filename
      console.log('Fetching bean model metadata...');
      const { data: beanJobData, error: beanJobError } = await supabase
        .from('training_jobs')
        .select('config')
        .eq('id', this.selectedBeanModelId)
        .single();
      
      if (beanJobError) {
        throw new Error(`Failed to fetch bean model metadata: ${beanJobError.message}`);
      }
      
      // Log the config structure for debugging
      console.log('Bean model config:', JSON.stringify(beanJobData?.config, null, 2));
      
      // Try to extract bean variety from config
      // Check multiple possible locations where it might be stored
      let beanVariety = beanJobData?.config?.bean_variety || 
                        beanJobData?.config?.variety ||
                        beanJobData?.config?.bean?.variety;
      
      let beanModelFilename: string;
      
      if (beanVariety) {
        // If we found the variety in config, use it
        beanModelFilename = `bean_${beanVariety.toLowerCase()}.onnx`;
        console.log(`Bean model filename from config: ${beanModelFilename}`);
      } else {
        // Fallback: List files in storage and find the bean model
        console.log('Bean variety not found in config, searching storage for bean model file...');
        const storagePath = `${user.id}/jobs/${this.selectedBeanModelId}`;
        const { data: files, error: listError } = await supabase.storage
          .from('trained-models')
          .list(storagePath);
        
        if (listError) {
          throw new Error(`Failed to list storage files: ${listError.message}`);
        }
        
        // Find any file that starts with "bean_" and ends with ".onnx"
        const beanModelFile = files?.find(f => f.name.startsWith('bean_') && f.name.endsWith('.onnx'));
        
        if (!beanModelFile) {
          throw new Error(`No bean model file (bean_*.onnx) found in storage at ${storagePath}. Available files: ${files?.map(f => f.name).join(', ')}`);
        }
        
        beanModelFilename = beanModelFile.name;
        console.log(`Bean model filename from storage: ${beanModelFilename}`);
      }
      
      // Download bean model (bean_{variety}.onnx)
      console.log('Downloading bean model...');
      const beanModelBlob = await this.downloadModelFromStorage(
        user.id,
        this.selectedBeanModelId,
        beanModelFilename
      );
      
      // Validate blob before attempting to load
      console.log(`Bean model blob size: ${beanModelBlob.size} bytes, type: ${beanModelBlob.type}`);
      if (beanModelBlob.size === 0) {
        throw new Error('Downloaded bean model file is empty');
      }
      
      // Create a TestbedSimulator instance and pass the downloaded models
      this.simulator = new TestbedSimulator();
      
      // Load the models into the simulator
      await this.simulator.loadModels(roasterModelBlob, beanModelBlob);
      
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
   * List files in a storage directory for debugging
   * @param userId - User ID
   * @param jobId - Job ID
   */
  private async listStorageFiles(userId: string, jobId: string): Promise<void> {
    try {
      const storagePath = `${userId}/jobs/${jobId}`;
      console.log(`Listing files in storage path: ${storagePath}`);
      
      const { data, error } = await supabase.storage
        .from('trained-models')
        .list(storagePath);
      
      if (error) {
        console.warn(`Could not list files in ${storagePath}:`, error);
        return;
      }
      
      if (data && data.length > 0) {
        console.log(`Files found in ${storagePath}:`, data.map(f => f.name));
      } else {
        console.warn(`No files found in ${storagePath}`);
      }
    } catch (error) {
      console.warn('Error listing storage files:', error);
    }
  }
  
  /**
   * Download an ONNX model file from Supabase storage
   * Models are stored at: {user_id}/jobs/{job_id}/{filename}
   * 
   * @param userId - User ID (owner of the trained model)
   * @param jobId - Training job ID (completed training job)
   * @param filename - Name of the ONNX file to download (e.g., 'roast_stepper.onnx', 'bean_{variety}.onnx')
   * @returns Promise<Blob> - The ONNX model file as a Blob
   */
  private async downloadModelFromStorage(
    userId: string,
    jobId: string,
    filename: string
  ): Promise<Blob> {
    try {
      // Construct storage path: {user_id}/jobs/{job_id}/{filename}
      const storagePath = `${userId}/jobs/${jobId}/${filename}`;
      
      console.log(`Downloading model from storage: ${storagePath}`);
      
      // Download the file from Supabase storage bucket 'trained-models'
      const { data, error } = await supabase.storage
        .from('trained-models')
        .download(storagePath);
      
      if (error) {
        console.error(`Storage download error for ${filename}:`, error);
        throw new Error(`Failed to download ${filename} from storage: ${error.message || JSON.stringify(error)}`);
      }
      
      if (!data) {
        throw new Error(`No data received when downloading ${filename} from ${storagePath}`);
      }
      
      console.log(`✓ Successfully downloaded ${filename} (${data.size} bytes)`);
      return data;
      
    } catch (error: any) {
      console.error(`Error in downloadModelFromStorage for ${filename}:`, error);
      throw new Error(`Failed to download ${filename}: ${error.message || error.toString()}`);
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
