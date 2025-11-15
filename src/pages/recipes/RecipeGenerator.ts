/**
 * Recipe Generator Module
 * 
 * This module provides an interactive profile generator for creating roasting recipes.
 * Users can define control input profiles using spline-based curves with draggable control points.
 * The system simulates the roast using loaded ONNX models and displays predicted temperatures.
 * 
 * Key features:
 * - Load roaster and bean ONNX models
 * - Interactive spline editor for heater and fan control profiles
 * - Drag-and-drop control points to adjust profiles
 * - Click on lines to add control points, click points to remove
 * - Real-time simulation and visualization of predicted temperatures
 * - Save recipes to database
 */

import { supabase } from '../../lib/supabase';
import { Chart, registerables } from 'chart.js';
import 'chartjs-plugin-dragdata';

// Register Chart.js components including dragdata plugin
Chart.register(...registerables);

// Declare ONNX Runtime global from CDN
declare const ort: any;

// Chart.js instance for the combined control editor (shows both heater and fan)
let controlChart: any = null;

  // Track which control input is currently being edited
  let activeControl: 'heater' | 'fan' | 'drum' = 'heater';

// Track last click time for double-click detection
let lastClickTime: number = 0;
let lastClickX: number = 0;
let lastClickY: number = 0;
const DOUBLE_CLICK_TIME = 300; // milliseconds
const DOUBLE_CLICK_DISTANCE = 10; // pixels

/**
 * Represents a control point in the spline
 * Each point has a time (x) and value (y) coordinate
 */
interface ControlPoint {
  time: number;    // Time in seconds
  value: number;   // Value from 0 to 1 (0-100%)
}

/**
 * Control profile contains arrays of control points for each input
 */
interface ControlProfile {
  heater: ControlPoint[];   // Heater power control points
  fan: ControlPoint[];      // Fan speed control points
  drum: ControlPoint[];     // Drum speed control points (typically constant)
}

/**
 * Training job structure (for loading models)
 */
interface TrainingJob {
  id: string;
  job_name: string | null;
  completed_at: string | null;
  config: any;
}

/**
 * RecipeGenerator class manages the profile creation interface
 */
export class RecipeGenerator {
  // ONNX model sessions
  private roasterSession: any = null;
  private beanSession: any = null;
  
  // Selected model IDs
  private selectedRoasterModelId: string = '';
  private selectedBeanModelId: string = '';
  
  // Recipe parameters
  private beanMassG: number = 150;
  private ambientTempC: number = 24;
  private preheatTempC: number = 180;  // Initial bean probe temperature (adjustable)
  private durationSeconds: number = 600;
  private recipeName: string = 'Untitled Recipe';
  
  // Scaling factors - MUST match dataset.py and RoasterSimulator
  // These are used to normalize/denormalize values for the ONNX models
  private readonly scalingFactors = {
    temperatures: {
      bean: 100.0,        // Bean temperature - typical max ~250°C
      environment: 100.0, // Environment temperature - similar scale
      temp_difference: 100.0 // Temperature difference (BT - ET)
    },
    controls: {
      heater: 100.0,      // Heater power (0-100%) 
      fan: 100.0,         // Fan speed (0-100%)
      drum: 100.0,        // Drum speed (0-100%)
      ambient: 100.0,     // Ambient temperature in °C
      humidity: 100.0     // Humidity percentage
    },
    mass: 100.0,          // Typical batch size ~100g
    time: 60.0            // Convert seconds to minutes
  };
  
  // Fixed parameters (matching RoasterSimulator defaults)
  private readonly fixedParams = {
    drum: 0.6,        // Fixed drum speed (normalized 0-1)
    humidity: 0.5     // Fixed humidity (normalized 0-1)
  };
  
  // Physics timestep for simulation (seconds)
  private readonly timestep: number = 1.5;
  
  // Control profile with default initial points
  // Each control input starts with beginning and end points
  private controlProfile: ControlProfile = {
    heater: [
      { time: 0, value: 0.5 },
      { time: 600, value: 0.5 }
    ],
    fan: [
      { time: 0, value: 0.5 },
      { time: 600, value: 0.5 }
    ],
    drum: [
      { time: 0, value: 0.5 },
      { time: 600, value: 0.5 }
    ]
  };
  
  // Simulated results (predicted temperatures)
  private simulatedResults: {
    time: number[];
    bean_temp: number[];
    bean_surface_temp: number[];
    drum_temp: number[];
    air_temp: number[];
    env_probe_temp: number[];
  } | null = null;
  
  // DOM elements
  private readonly loadingDiv: HTMLDivElement;
  private readonly errorDiv: HTMLDivElement;
  private readonly emptyState: HTMLDivElement;
  private readonly loadBtn: HTMLButtonElement;
  private readonly modelSelectionDiv: HTMLDivElement;
  private readonly recipeInfoDiv: HTMLDivElement;
  private readonly parametersDiv: HTMLDivElement;
  private readonly actionButtons: HTMLDivElement;
  private readonly chartsContainer: HTMLDivElement;
  
  // Control sliders and inputs
  private readonly recipeNameInput: HTMLInputElement;
  private readonly massSlider: HTMLInputElement;
  private readonly massValue: HTMLSpanElement;
  private readonly ambientSlider: HTMLInputElement;
  private readonly ambientValue: HTMLSpanElement;
  private readonly preheatSlider: HTMLInputElement;
  private readonly preheatValue: HTMLSpanElement;
  private readonly durationInput: HTMLInputElement;
  
  // Action buttons
  private readonly simulateBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  
  // Artisan snap toggle
  private readonly artisanSnapCheckbox: HTMLInputElement;
  
  constructor() {
    console.log('Initializing Recipe Generator...');
    
    // Get DOM elements
    this.loadingDiv = document.getElementById('generator-loading') as HTMLDivElement;
    this.errorDiv = document.getElementById('generator-error') as HTMLDivElement;
    this.emptyState = document.getElementById('generator-empty') as HTMLDivElement;
    this.loadBtn = document.getElementById('generator-load-btn') as HTMLButtonElement;
    this.modelSelectionDiv = document.getElementById('generator-model-selection') as HTMLDivElement;
    this.recipeInfoDiv = document.getElementById('generator-recipe-info') as HTMLDivElement;
    this.parametersDiv = document.getElementById('generator-parameters') as HTMLDivElement;
    this.actionButtons = document.getElementById('generator-action-buttons') as HTMLDivElement;
    this.chartsContainer = document.getElementById('generator-charts-container') as HTMLDivElement;
    
    this.recipeNameInput = document.getElementById('recipe-name') as HTMLInputElement;
    this.massSlider = document.getElementById('generator-mass-slider') as HTMLInputElement;
    this.massValue = document.getElementById('generator-mass-value') as HTMLSpanElement;
    this.ambientSlider = document.getElementById('generator-ambient-slider') as HTMLInputElement;
    this.ambientValue = document.getElementById('generator-ambient-value') as HTMLSpanElement;
    this.preheatSlider = document.getElementById('generator-preheat-slider') as HTMLInputElement;
    this.preheatValue = document.getElementById('generator-preheat-value') as HTMLSpanElement;
    this.durationInput = document.getElementById('generator-duration') as HTMLInputElement;
    
    this.simulateBtn = document.getElementById('generator-simulate-btn') as HTMLButtonElement;
    this.saveBtn = document.getElementById('generator-save-btn') as HTMLButtonElement;
    this.resetBtn = document.getElementById('generator-reset-btn') as HTMLButtonElement;
    
    this.artisanSnapCheckbox = document.getElementById('artisan-snap-checkbox') as HTMLInputElement;
    
    this.initializeUI();
  }
  
  /**
   * Initialize UI event listeners
   */
  private async initializeUI(): Promise<void> {
    // Load available models
    await this.loadAvailableModels();
    
    // Model selection
    const roasterSelect = document.getElementById('generator-roaster-model') as HTMLSelectElement;
    const beanSelect = document.getElementById('generator-bean-model') as HTMLSelectElement;
    
    if (roasterSelect) {
      roasterSelect.addEventListener('change', (e) => {
        this.selectedRoasterModelId = (e.target as HTMLSelectElement).value;
      });
    }
    
    if (beanSelect) {
      beanSelect.addEventListener('change', (e) => {
        this.selectedBeanModelId = (e.target as HTMLSelectElement).value;
      });
    }
    
    // Load models button
    this.loadBtn.addEventListener('click', () => this.loadModels());
    
    // Parameter controls
    this.recipeNameInput.addEventListener('change', (e) => {
      this.recipeName = (e.target as HTMLInputElement).value;
    });
    
    this.massSlider.addEventListener('input', (e) => {
      this.beanMassG = parseFloat((e.target as HTMLInputElement).value);
      this.massValue.textContent = `${this.beanMassG}g`;
      // Automatically re-run simulation when bean mass changes
      this.simulateProfile();
    });
    
    this.ambientSlider.addEventListener('input', (e) => {
      this.ambientTempC = parseFloat((e.target as HTMLInputElement).value);
      this.ambientValue.textContent = `${this.ambientTempC}°C`;
      // Automatically re-run simulation when ambient temperature changes
      this.simulateProfile();
    });
    
    this.preheatSlider.addEventListener('input', (e) => {
      this.preheatTempC = parseFloat((e.target as HTMLInputElement).value);
      this.preheatValue.textContent = `${this.preheatTempC}°C`;
      // Automatically re-run simulation when preheat temperature changes
      this.simulateProfile();
    });
    
    this.durationInput.addEventListener('change', (e) => {
      const newDuration = parseFloat((e.target as HTMLInputElement).value);
      this.updateDuration(newDuration);
    });
    
    // Action buttons
    this.simulateBtn.addEventListener('click', () => this.simulateProfile());
    this.saveBtn.addEventListener('click', () => this.saveRecipe());
    this.resetBtn.addEventListener('click', () => this.resetGenerator());
  }
  
  /**
   * Load available trained models from database
   */
  private async loadAvailableModels(): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('training_jobs')
        .select('*')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false });
      
      if (error) throw error;
      
      const allModels = (data as TrainingJob[]) || [];
      
      // Separate roaster and bean models (same logic as testbed)
      const roasterModels = allModels.filter(m => !m.config.bean_hidden_dims);
      const beanModels = allModels.filter(m => m.config.bean_hidden_dims);
      
      // Populate dropdowns
      const roasterSelect = document.getElementById('generator-roaster-model') as HTMLSelectElement;
      if (roasterSelect) {
        roasterSelect.innerHTML = '<option value="">-- Select from trained models --</option>';
        roasterModels.forEach(model => {
          const option = document.createElement('option');
          option.value = model.id;
          const modelName = model.job_name || `Model ${model.id.slice(0, 8)}`;
          const date = new Date(model.completed_at!).toLocaleDateString();
          option.textContent = `${modelName} (${date})`;
          roasterSelect.appendChild(option);
        });
      }
      
      const beanSelect = document.getElementById('generator-bean-model') as HTMLSelectElement;
      if (beanSelect) {
        beanSelect.innerHTML = '<option value="">-- Select from trained models --</option>';
        beanModels.forEach(model => {
          const option = document.createElement('option');
          option.value = model.id;
          const modelName = model.job_name || `Model ${model.id.slice(0, 8)}`;
          const date = new Date(model.completed_at!).toLocaleDateString();
          option.textContent = `${modelName} (${date})`;
          beanSelect.appendChild(option);
        });
      }
      
    } catch (error) {
      console.error('Failed to load available models:', error);
      this.showError(`Failed to load model list: ${(error as Error).message}`);
    }
  }
  
  /**
   * Load selected ONNX models from Supabase storage
   * Downloads the user's trained models and creates ONNX Runtime sessions
   */
  private async loadModels(): Promise<void> {
    try {
      if (!this.selectedRoasterModelId || !this.selectedBeanModelId) {
        this.showError('Please select both a roaster model and a bean model');
        return;
      }
      
      this.loadBtn.disabled = true;
      this.loadBtn.textContent = 'Loading...';
      this.loadingDiv.style.display = 'block';
      this.errorDiv.style.display = 'none';
      
      console.log('Loading ONNX models from Supabase storage...', {
        roasterId: this.selectedRoasterModelId,
        beanId: this.selectedBeanModelId
      });
      
      // Configure ONNX Runtime
      if (typeof ort !== 'undefined') {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
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
      
      // Try loading with ArrayBuffer (sometimes more reliable despite URL being preferred)
      console.log('Creating ONNX session for roaster model using ArrayBuffer...');
      try {
        const arrayBuffer = await roasterModelBlob.arrayBuffer();
        console.log(`ArrayBuffer created, size: ${arrayBuffer.byteLength} bytes`);
        
        // Create session with explicit options
        this.roasterSession = await ort.InferenceSession.create(arrayBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        console.log('✓ Roaster model loaded successfully');
      } catch (onnxError: any) {
        console.error('ONNX Runtime error loading roaster model:', onnxError);
        console.error('Error type:', typeof onnxError);
        console.error('Error details:', {
          message: onnxError.message,
          name: onnxError.name,
          stack: onnxError.stack
        });
        
        // Provide more specific error message
        const errorCode = typeof onnxError === 'number' ? onnxError : onnxError.message;
        throw new Error(`Failed to create ONNX session for roaster model. Error: ${errorCode}. The model file may be corrupted or incompatible with ONNX Runtime Web. Please try retraining the model.`);
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
      
      // Try loading with ArrayBuffer (sometimes more reliable despite URL being preferred)
      console.log('Creating ONNX session for bean model using ArrayBuffer...');
      try {
        const arrayBuffer = await beanModelBlob.arrayBuffer();
        console.log(`ArrayBuffer created, size: ${arrayBuffer.byteLength} bytes`);
        
        // Create session with explicit options
        this.beanSession = await ort.InferenceSession.create(arrayBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        console.log('✓ Bean model loaded successfully');
      } catch (onnxError: any) {
        console.error('ONNX Runtime error loading bean model:', onnxError);
        console.error('Error type:', typeof onnxError);
        console.error('Error details:', {
          message: onnxError.message,
          name: onnxError.name,
          stack: onnxError.stack
        });
        
        // Provide more specific error message
        const errorCode = typeof onnxError === 'number' ? onnxError : onnxError.message;
        throw new Error(`Failed to create ONNX session for bean model. Error: ${errorCode}. The model file may be corrupted or incompatible with ONNX Runtime Web. Please try retraining the model.`);
      }
      
      // Show UI
      this.modelSelectionDiv.style.display = 'none';
      this.recipeInfoDiv.style.display = 'block';
      this.parametersDiv.style.display = 'block';
      this.actionButtons.style.display = 'flex';
      this.emptyState.style.display = 'none';
      this.chartsContainer.style.display = 'flex';
      this.loadingDiv.style.display = 'none';
      
      // Initialize control editor
      this.initializeControlEditor();
      
      // Hide simulate button since simulation is now automatic
      this.simulateBtn.style.display = 'none';
      
      // Run initial simulation with default control profile
      await this.simulateProfile();
      
      console.log('✅ All models loaded successfully');
      
    } catch (error: any) {
      console.error('Failed to load models:', error);
      const errorMessage = error?.message || error?.toString() || 'Unknown error occurred';
      this.showError(`Failed to load models: ${errorMessage}`);
      this.loadBtn.disabled = false;
      this.loadBtn.textContent = 'Load Models & Start';
      this.loadingDiv.style.display = 'none';
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
   * @param filename - Name of the ONNX file to download (e.g., 'roast_stepper.onnx', 'bean_model.onnx')
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
   * Initialize the interactive control editor with Chart.js
   * Creates a single chart showing both heater and fan, with only one editable at a time
   */
  private initializeControlEditor(): void {
    // Get the canvas element from the HTML
    const canvas = document.getElementById('generator-combined-chart') as HTMLCanvasElement;
    if (!canvas) {
      console.error('Combined chart canvas not found');
      return;
    }
    
    // Prepare datasets - heater, fan, and drum will be shown
    const heaterData = this.controlProfile.heater.map(p => ({ x: p.time, y: p.value * 100 }));
    const fanData = this.controlProfile.fan.map(p => ({ x: p.time, y: p.value * 100 }));
    const drumData = this.controlProfile.drum.map(p => ({ x: p.time, y: p.value * 100 }));
    
    // Create the combined control chart with all three control datasets
    // Dataset 0: Heater (editable when activeControl === 'heater')
    // Dataset 1: Fan (editable when activeControl === 'fan')
    // Dataset 2: Drum (editable when activeControl === 'drum')
    controlChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          {
            label: 'Heater',
            data: heaterData,
            borderColor: '#e74c3c',
            backgroundColor: 'rgba(231, 76, 60, 0.1)',
            pointBackgroundColor: '#e74c3c',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            pointRadius: 8,
            pointHoverRadius: 10,
            borderWidth: 2,
            stepped: 'before',
            fill: false
          },
          {
            label: 'Fan',
            data: fanData,
            borderColor: '#3498db',
            backgroundColor: 'rgba(52, 152, 219, 0.1)',
            pointBackgroundColor: '#3498db',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            pointRadius: 8,
            pointHoverRadius: 10,
            borderWidth: 2,
            stepped: 'before',
            fill: false
          },
          {
            label: 'Drum',
            data: drumData,
            borderColor: '#9b59b6',
            backgroundColor: 'rgba(155, 89, 182, 0.1)',
            pointBackgroundColor: '#9b59b6',
            pointBorderColor: '#fff',
            pointBorderWidth: 2,
            pointRadius: 8,
            pointHoverRadius: 10,
            borderWidth: 2,
            stepped: 'before',
            fill: false
          }
        ]
      },
      options: {
        animation: false,  // Disable animations for instant updates
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: true,
            position: 'top'
          },
          tooltip: {
            callbacks: {
              label: (context: any) => {
                return `${context.dataset.label}: ${context.parsed.y.toFixed(1)}% at ${context.parsed.x.toFixed(0)}s`;
              }
            }
          },
          // Configure dragdata plugin - only active dataset can be dragged
          dragData: {
            round: 1,
            showTooltip: true,
            dragX: true,  // Enable horizontal (time) dragging
            // Callback before dragging starts - return false to prevent drag
            onDragStart: (_e: any, datasetIndex: number, _index: number, _value: any) => {
              // Only allow dragging control datasets (0, 1, 2), not temperature datasets (3+)
              if (datasetIndex >= 3) {
                return false; // Temperature datasets are not draggable
              }
              
              // Only allow dragging the active control
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              if (controlName !== activeControl) {
                return false; // Prevent dragging inactive control
              }
              
              return true; // Allow drag to start
            },
            // Callback when dragging a point
            // Note: The return type is cast to any because chartjs-plugin-dragdata types are incomplete
            // The plugin actually accepts returning {x, y} to constrain drag values
            onDrag: ((_e: any, datasetIndex: number, index: number, value: any) => {
              // Map dataset index to control name
              // Dataset 0 = Heater, Dataset 1 = Fan, Dataset 2 = Drum
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              
              const points = this.controlProfile[controlName];
              
              // ANCHOR FIRST AND LAST POINTS: They should remain at time 0 and durationSeconds
              // We identify first/last by checking if current point is at time 0 or durationSeconds
              // This is more robust than using array indices which can shift during sorting
              const currentPoint = points[index];
              const isFirstPoint = currentPoint.time === 0;
              const isLastPoint = currentPoint.time === this.durationSeconds;
              
              let constrainedX: number;
              if (isFirstPoint) {
                // First point: anchor at time = 0, only allow vertical (value) movement
                constrainedX = 0;
              } else if (isLastPoint) {
                // Last point: anchor at time = durationSeconds, only allow vertical (value) movement
                constrainedX = this.durationSeconds;
              } else {
                // Middle points: allow horizontal movement but constrain to 0 to duration
                constrainedX = Math.max(0, Math.min(this.durationSeconds, value.x));
              }
              
              // Y (power) constrained to 0-100% for all points
              // Normalized to 0-1 range
              let constrainedY = Math.max(0, Math.min(1, value.y / 100));
              
              // Apply Artisan snapping if enabled
              // Check if the snap checkbox is checked
              if (this.artisanSnapCheckbox && this.artisanSnapCheckbox.checked) {
                constrainedY = this.snapToArtisanIncrement(constrainedY);
              }
              
              // Update the point with constrained values
              // Note: We don't sort here to avoid confusing the dragData plugin with changing indices
              points[index].time = constrainedX;
              points[index].value = constrainedY;
              
              // Return constrained values to update the chart visually
              return {
                x: constrainedX,
                y: constrainedY * 100
              };
            }) as any, // Type cast due to incomplete chartjs-plugin-dragdata type definitions
            onDragEnd: (_e: any, datasetIndex: number, _index: number, _value: any) => {
              // Map dataset index to control name
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              const points = this.controlProfile[controlName];
              
              // After dragging is complete, sort points by time to maintain proper order
              // This ensures middle points are in the correct sequence if they were dragged past each other
              points.sort((a, b) => a.time - b.time);
              
              // Update the chart data with sorted points
              const sortedData = points.map(p => ({ x: p.time, y: p.value * 100 }));
              controlChart.data.datasets[datasetIndex].data = sortedData;
              controlChart.update();
              
              console.log('Drag complete - points sorted');
              
              // Automatically simulate after dragging
              this.simulateProfile();
            }
          }
        },
        scales: {
          x: {
            type: 'linear',
            title: {
              display: true,
              text: 'Time (seconds)'
            },
            min: 0,
            max: this.durationSeconds,
            ticks: {
              stepSize: 60
            }
          },
          y: {
            type: 'linear',
            title: {
              display: true,
              text: 'Power (%)'
            },
            min: 0,
            max: 100,
            ticks: {
              stepSize: 10
            }
          }
        },
        interaction: {
          mode: 'nearest',
          intersect: true
        },
        onClick: (event: any, activeElements: any[], chart: any) => {
          const currentTime = Date.now();
          const rect = canvas.getBoundingClientRect();
          const clickX = event.native.clientX - rect.left;
          const clickY = event.native.clientY - rect.top;
          
          // Check if this is a double-click
          const timeDiff = currentTime - lastClickTime;
          const distX = Math.abs(clickX - lastClickX);
          const distY = Math.abs(clickY - lastClickY);
          const isDoubleClick = timeDiff < DOUBLE_CLICK_TIME && 
                                distX < DOUBLE_CLICK_DISTANCE && 
                                distY < DOUBLE_CLICK_DISTANCE;
          
          if (isDoubleClick) {
            // Double-click detected - add a control point
            const chartArea = chart.chartArea;
            if (chartArea && clickX >= chartArea.left && clickX <= chartArea.right && 
                clickY >= chartArea.top && clickY <= chartArea.bottom) {
              
              const xScale = chart.scales?.x;
              const yScale = chart.scales?.y;
              
              if (!xScale || !yScale || !xScale.getValueForPixel || !yScale.getValueForPixel) return;
              
              const timeValue = xScale.getValueForPixel(clickX) as number;
              const powerValue = yScale.getValueForPixel(clickY) as number;
              
              // Constrain power value to 0-100 range
              const constrainedPower = Math.max(0, Math.min(100, powerValue));
              
              // Add point to the currently active control input
              this.addControlPoint(activeControl, timeValue, constrainedPower / 100);
            }
            
            // Reset click tracking
            lastClickTime = 0;
          } else {
            // Single click - check if we clicked on a point to remove it
            if (activeElements.length > 0) {
              const element = activeElements[0];
              const datasetIndex = element.datasetIndex;
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              
              // Only allow removing points from the active control (only control datasets 0-2)
              if (datasetIndex < 3 && controlName === activeControl) {
                this.removeControlPoint(controlName, element.index);
              }
            }
            
            // Update click tracking for potential double-click
            lastClickTime = currentTime;
            lastClickX = clickX;
            lastClickY = clickY;
          }
        }
      }
    });
    
    // Set up control selector buttons
    this.setupControlSelector();
  }
  
  /**
   * Set up control selector buttons to switch between heater, fan, and drum editing
   */
  private setupControlSelector(): void {
    const buttons = document.querySelectorAll('.control-selector-btn');
    
    buttons.forEach(button => {
      button.addEventListener('click', (e) => {
        const btn = e.target as HTMLButtonElement;
        const control = btn.getAttribute('data-control') as 'heater' | 'fan' | 'drum';
        
        if (!control) return;
        
        // Update active control
        activeControl = control;
        
        // Update button states
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        // Update visual appearance of control points to show which is active/inactive
        this.updateControlVisuals();
        
        console.log(`Switched to editing ${control} control`);
      });
    });
  }
  
  /**
   * Snap a value (0-1) to the nearest Artisan increment (5%)
   * Artisan's resolution is in 5% increments: 0, 0.05, 0.10, 0.15, ..., 0.95, 1.00
   * @param value - The value to snap (0-1 scale)
   * @returns The snapped value
   */
  private snapToArtisanIncrement(value: number): number {
    // Artisan increments are every 5%, so 0.05 in normalized 0-1 scale
    const increment = 0.05;
    // Round to nearest increment
    return Math.round(value / increment) * increment;
  }
  
  /**
   * Update the visual appearance of control datasets to indicate active/inactive state
   * Active control has larger, more prominent points
   * Inactive controls have smaller, more transparent points
   */
  private updateControlVisuals(): void {
    if (!controlChart || !controlChart.data.datasets || controlChart.data.datasets.length < 3) return;
    
    // Heater is dataset 0, Fan is dataset 1, Drum is dataset 2
    const heaterDataset = controlChart.data.datasets[0];
    const fanDataset = controlChart.data.datasets[1];
    const drumDataset = controlChart.data.datasets[2];
    
    // Set all to inactive state first
    heaterDataset.pointRadius = 5;
    heaterDataset.pointHoverRadius = 7;
    heaterDataset.borderWidth = 1.5;
    heaterDataset.pointBackgroundColor = 'rgba(231, 76, 60, 0.5)';
    heaterDataset.borderColor = 'rgba(231, 76, 60, 0.5)';
    
    fanDataset.pointRadius = 5;
    fanDataset.pointHoverRadius = 7;
    fanDataset.borderWidth = 1.5;
    fanDataset.pointBackgroundColor = 'rgba(52, 152, 219, 0.5)';
    fanDataset.borderColor = 'rgba(52, 152, 219, 0.5)';
    
    drumDataset.pointRadius = 5;
    drumDataset.pointHoverRadius = 7;
    drumDataset.borderWidth = 1.5;
    drumDataset.pointBackgroundColor = 'rgba(155, 89, 182, 0.5)';
    drumDataset.borderColor = 'rgba(155, 89, 182, 0.5)';
    
    // Make the active control prominent
    if (activeControl === 'heater') {
      heaterDataset.pointRadius = 8;
      heaterDataset.pointHoverRadius = 10;
      heaterDataset.borderWidth = 2;
      heaterDataset.pointBackgroundColor = '#e74c3c';
      heaterDataset.borderColor = '#e74c3c';
    } else if (activeControl === 'fan') {
      fanDataset.pointRadius = 8;
      fanDataset.pointHoverRadius = 10;
      fanDataset.borderWidth = 2;
      fanDataset.pointBackgroundColor = '#3498db';
      fanDataset.borderColor = '#3498db';
    } else if (activeControl === 'drum') {
      drumDataset.pointRadius = 8;
      drumDataset.pointHoverRadius = 10;
      drumDataset.borderWidth = 2;
      drumDataset.pointBackgroundColor = '#9b59b6';
      drumDataset.borderColor = '#9b59b6';
    }
    
    controlChart.update();
  }
  
  /**
   * Add a new control point
   * @param input - Control input type
   * @param time - Time in seconds
   * @param value - Value (0-1)
   */
  private addControlPoint(input: 'heater' | 'fan' | 'drum', time: number, value: number): void {
    const points = this.controlProfile[input];
    
    // Find insertion point
    let insertIndex = points.findIndex(p => p.time > time);
    if (insertIndex === -1) insertIndex = points.length;
    
    // Insert new point
    points.splice(insertIndex, 0, { time, value });
    
    // Update chart
    this.updateControlEditor();
    
    // Automatically simulate after adding a point
    this.simulateProfile();
  }
  
  /**
   * Remove a control point
   * @param controlInput - Which control input ('heater', 'fan', or 'drum')
   * @param pointIndex - Index of the point in the control array
   */
  private removeControlPoint(controlInput: 'heater' | 'fan' | 'drum', pointIndex: number): void {
    // Don't allow removing first or last point
    const points = this.controlProfile[controlInput];
    if (pointIndex === 0 || pointIndex === points.length - 1) {
      alert('Cannot remove first or last control point');
      return;
    }
    
    // Remove the point
    points.splice(pointIndex, 1);
    
    // Re-render the control editor
    this.updateControlEditor();
    
    // Automatically simulate after removing a point
    this.simulateProfile();
  }
  
  /**
   * Update the control editor chart with current control profile data
   * Updates heater, fan, and drum datasets in the combined chart
   */
  private updateControlEditor(): void {
    if (controlChart) {
      // Update heater dataset (index 0)
      controlChart.data.datasets[0].data = this.controlProfile.heater.map(p => ({ 
        x: p.time, 
        y: p.value * 100 
      }));
      
      // Update fan dataset (index 1)
      controlChart.data.datasets[1].data = this.controlProfile.fan.map(p => ({ 
        x: p.time, 
        y: p.value * 100 
      }));
      
      // Update drum dataset (index 2)
      controlChart.data.datasets[2].data = this.controlProfile.drum.map(p => ({ 
        x: p.time, 
        y: p.value * 100 
      }));
      
      controlChart.update();
    }
  }
  
  /**
   * Update duration and adjust control points accordingly
   * @param newDuration - New roast duration in seconds
   */
  private updateDuration(newDuration: number): void {
    this.durationSeconds = newDuration;
    
    // Keep control points at their absolute time positions
    // Only update the last point to match the new duration
    ['heater', 'fan', 'drum'].forEach(input => {
      const points = this.controlProfile[input as keyof ControlProfile];
      if (points.length > 0) {
        // Update the last point's time to match new duration
        points[points.length - 1].time = newDuration;
      }
    });
    
    // Update the x-axis max to match new duration
    if (controlChart && controlChart.options.scales.x) {
      controlChart.options.scales.x.max = newDuration;
    }
    
    // Update the control editor if it's visible
    if (this.chartsContainer.style.display !== 'none') {
      this.updateControlEditor();
      
      // Automatically simulate after duration change
      this.simulateProfile();
    }
  }
  
  /**
   * Simulate the roast profile using loaded ONNX models
   * This runs the roaster and bean models forward in time using the control profile
   * Following the same physics-based approach as RoasterSimulator
   */
  private async simulateProfile(): Promise<void> {
    try {
      console.log('Simulating roast profile...');
      
      if (!this.roasterSession || !this.beanSession) {
        throw new Error('Models not loaded');
      }
      
      // Initialize state with preheat conditions (matching RoasterSimulator)
      // State vector: [T_r, T_b, T_air, T_bm, T_atm]
      // Use the adjustable preheat temperature (bean probe initial temperature)
      const preheatTemp = this.preheatTempC; // Bean probe/measurement temp (adjustable via UI slider)
      const roomTemp = 20.0; // Bean core starts at room temperature (°C)
      const roasterTemp = preheatTemp + 50.0; // Roaster/drum temp is typically higher than bean probe (°C)
      const airTemp = preheatTemp; // T_air (air surrounding beans) starts at bean probe temp (°C)
      const envTemp = preheatTemp - 40.0; // T_env (air surrounding drum) is ~40°C below bean probe (°C)
      
      // Normalize using scaling factors
      const tempScale = this.scalingFactors.temperatures.bean;
      let currentState = new Float32Array([
        roasterTemp / tempScale,     // T_r (roaster temperature)
        roomTemp / tempScale,        // T_b (bean core temperature - starts at room temp)
        airTemp / tempScale,         // T_air (air temperature - air surrounding beans)
        preheatTemp / tempScale,     // T_bm (bean measurement temperature)
        envTemp / tempScale          // T_atm (environment temperature - air surrounding drum)
      ]);
      
      // Results storage
      const time: number[] = [];
      const bean_temp: number[] = [];        // T_bm (Bean Probe / Measured Bean Temperature)
      const bean_surface_temp: number[] = []; // T_b (Bean Core Temperature)
      const drum_temp: number[] = [];        // T_r (Roaster/Drum Temperature)
      const air_temp: number[] = [];         // T_air (Air Temperature)
      const env_probe_temp: number[] = [];   // T_atm (Measured Air Temperature)
      
      // Calculate number of simulation steps
      const numSteps = Math.ceil(this.durationSeconds / this.timestep);
      const dt = new Float32Array([this.timestep / this.scalingFactors.time]); // Normalized timestep
      
      console.log(`Running ${numSteps} simulation steps (${this.timestep}s each, total ${this.durationSeconds}s)`);
      
      // Simulation loop - step through time using the physics model
      for (let step = 0; step < numSteps; step++) {
        const currentTime = step * this.timestep; // Current time in seconds
        
        // Store current state temperatures (denormalized)
        time.push(currentTime);
        bean_temp.push(currentState[3] * tempScale);        // T_bm
        bean_surface_temp.push(currentState[1] * tempScale); // T_b
        drum_temp.push(currentState[0] * tempScale);        // T_r
        air_temp.push(currentState[2] * tempScale);         // T_air
        env_probe_temp.push(currentState[4] * tempScale);   // T_atm
        
        // Get control values at this time from the control profile
        const heaterValue = this.getControlValueAtTime('heater', currentTime); // 0-1
        const fanValue = this.getControlValueAtTime('fan', currentTime);       // 0-1
        const drumValue = this.getControlValueAtTime('drum', currentTime);     // 0-1
        
        // Get bean thermal capacity from bean model
        // Bean model input: bean_temperature (normalized)
        // Bean model output: thermal_capacity (normalized)
        const beanModelResult = await this.beanSession.run({
          bean_temperature: new ort.Tensor('float32', [currentState[1]], [1, 1])
        });
        const beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
        
        // Prepare control inputs for roast stepper
        // Based on DrumRoasterExtended.forward() in models.py: [heater, fan, drum, T_amb, humidity, mass, C_b]
        const stepperControls = new Float32Array(7);
        stepperControls[0] = heaterValue;  // Heater power (already 0-1, no scaling needed)
        stepperControls[1] = fanValue;     // Fan speed (already 0-1, no scaling needed)
        stepperControls[2] = drumValue;    // Drum speed from control profile (0-1)
        stepperControls[3] = this.ambientTempC / this.scalingFactors.controls.ambient;  // Ambient temp (normalized)
        stepperControls[4] = this.fixedParams.humidity;  // Humidity (already normalized)
        stepperControls[5] = this.beanMassG / this.scalingFactors.mass;  // Bean mass (normalized)
        stepperControls[6] = beanCapacity;  // Bean thermal capacity from bean model
        
        // Run roast stepper to predict next state
        // Input shapes: current_state [1, 5], current_controls [1, 7], dt [1, 1]
        // Output: next_state [1, 5]
        const stepperResult = await this.roasterSession.run({
          current_state: new ort.Tensor('float32', currentState, [1, 5]),
          current_controls: new ort.Tensor('float32', stepperControls, [1, 7]),
          dt: new ort.Tensor('float32', dt, [1, 1])
        });
        
        // Update current state for next iteration
        currentState = new Float32Array(stepperResult.next_state.data as any as number[]);
      }
      
      // Store final results
      this.simulatedResults = {
        time,
        bean_temp,
        bean_surface_temp,
        drum_temp,
        air_temp,
        env_probe_temp
      };
      
      // Render temperature chart
      this.renderTemperatureChart();
      
      console.log('✅ Simulation complete', {
        steps: numSteps,
        finalTemp: bean_temp[bean_temp.length - 1].toFixed(1) + '°C'
      });
      
    } catch (error) {
      console.error('Failed to simulate profile:', error);
      this.showError(`Simulation failed: ${(error as Error).message}`);
    }
  }
  
  /**
   * Get control value at a specific time using step function (piecewise constant)
   * With 'before' stepping: the value changes AT the control point
   * @param input - Control input type ('heater', 'fan', 'drum')
   * @param time - Time in seconds
   * @returns Control value (0-1) at the given time
   */
  private getControlValueAtTime(input: 'heater' | 'fan' | 'drum', time: number): number {
    const points = this.controlProfile[input];
    const sortedPoints = [...points].sort((a, b) => a.time - b.time);
    
    // With 'before' stepping: find the last point at or before this time
    // The value changes exactly at the point's time
    let i = 0;
    while (i < sortedPoints.length - 1 && sortedPoints[i + 1].time <= time) {
      i++;
    }
    
    // Return the value at this control point
    return sortedPoints[i].value;
  }
  
  /**
   * Render the predicted temperature chart by adding temperature datasets to the combined chart
   * This adds the temperature traces on top of the control traces (heater and fan)
   * Since temperatures go up to ~350°C and controls are 0-100%, they share the same y-axis
   */
  private renderTemperatureChart(): void {
    if (!this.simulatedResults || !controlChart) return;
    
    // Get current control datasets (heater, fan, and drum are datasets 0, 1, 2)
    // Ensure datasets exist before accessing them
    if (!controlChart.data.datasets || controlChart.data.datasets.length < 3) return;
    const heaterDataset = controlChart.data.datasets[0];
    const fanDataset = controlChart.data.datasets[1];
    const drumDataset = controlChart.data.datasets[2];
    
    // Calculate Rate of Rise (RoR) - derivative of bean temperature
    // RoR is expressed in °C/min
    const rorData: {x: number, y: number}[] = [];
    for (let i = 1; i < this.simulatedResults.time.length; i++) {
      const dt = this.simulatedResults.time[i] - this.simulatedResults.time[i-1]; // seconds
      const dTemp = this.simulatedResults.bean_temp[i] - this.simulatedResults.bean_temp[i-1]; // °C
      const ror = (dTemp / dt) * 60; // Convert to °C/min
      rorData.push({
        x: this.simulatedResults.time[i],
        y: ror
      });
    }
    
    // Add temperature datasets (these will be datasets 2-6, including RoR)
    // We'll use different colors and line styles to distinguish them
    const results = this.simulatedResults; // Store reference for map callbacks
    const tempDatasets = [
      {
        label: 'Bean Probe',
        data: results.time.map((t, i) => ({
          x: t,
          y: results.bean_temp[i]
        })),
        borderColor: '#e74c3c',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.1,
        fill: false
      },
      {
        label: 'RoR',
        data: rorData,
        borderColor: 'rgba(231, 76, 60, 0.6)',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        borderDash: [2, 2],  // Dotted line pattern
        pointRadius: 0,
        tension: 0.2,  // Smooth the RoR curve
        fill: false,
        yAxisID: 'y2'  // Use right y-axis for RoR
      },
      {
        label: 'Bean Surface',
        data: results.time.map((t, i) => ({
          x: t,
          y: results.bean_surface_temp[i]
        })),
        borderColor: '#e67e22',
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderDash: [5, 5],
        pointRadius: 0,
        tension: 0.1,
        fill: false
      },
      {
        label: 'Drum',
        data: results.time.map((t, i) => ({
          x: t,
          y: results.drum_temp[i]
        })),
        borderColor: '#3498db',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        fill: false
      },
      {
        label: 'Air',
        data: results.time.map((t, i) => ({
          x: t,
          y: results.air_temp[i]
        })),
        borderColor: '#2ecc71',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        fill: false
      },
      {
        label: 'Env Probe',
        data: results.time.map((t, i) => ({
          x: t,
          y: results.env_probe_temp[i]
        })),
        borderColor: '#9b59b6',
        backgroundColor: 'transparent',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.1,
        fill: false
      }
    ];
    
    // Update the chart datasets - keep controls (0-2) and add temperatures (3-7)
    controlChart.data.datasets = [heaterDataset, fanDataset, drumDataset, ...tempDatasets];
    
    // Update y-axis to accommodate both control values (0-100) and temperatures (0-350)
    controlChart.options.scales.y.max = 350;
    controlChart.options.scales.y.title.text = 'Temperature (°C) / Control (%)';
    
    // Add y2 axis for RoR if not already present
    if (!controlChart.options.scales.y2) {
      controlChart.options.scales.y2 = {
        type: 'linear',
        position: 'right',
        title: {
          display: true,
          text: 'RoR (°C/min)'
        },
        min: 0,
        max: 50,  // Typical RoR range for coffee roasting
        grid: {
          drawOnChartArea: false  // Don't draw gridlines for right axis
        }
      };
    }
    
    // Update tooltip to show appropriate units
    controlChart.options.plugins.tooltip.callbacks.label = (context: any) => {
      const datasetIndex = context.datasetIndex;
      let label = context.dataset.label || '';
      if (label) {
        label += ': ';
      }
      // Check if this is RoR, control, or temperature
      if (label.includes('RoR')) {
        label += context.parsed.y.toFixed(1) + ' °C/min';
      } else if (datasetIndex < 3) {
        // Datasets 0-2 are controls (heater, fan, drum)
        label += context.parsed.y.toFixed(1) + '%';
      } else {
        label += context.parsed.y.toFixed(1) + '°C';
      }
      return label;
    };
    
    controlChart.update();
  }
  
  /**
   * Save the current recipe to database
   */
  private async saveRecipe(): Promise<void> {
    try {
      if (!this.simulatedResults) {
        alert('Please simulate the profile first before saving');
        return;
      }
      
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      
      // Prepare recipe data
      // IMPORTANT: Save control profile as discrete events (raw control points),
      // NOT as interpolated curves. This preserves the piecewise constant nature
      // of the control signals.
      //
      // Each control (heater, fan, drum) has its own time array since they can
      // have control changes at different times. The .alog generator will handle
      // interpolating these to a common timeline.
      const recipeData = {
        user_id: user.id,
        name: this.recipeName,
        duration_seconds: this.durationSeconds,
        bean_mass_g: this.beanMassG,
        ambient_temp_c: this.ambientTempC,
        roaster_model_id: this.selectedRoasterModelId,
        bean_model_id: this.selectedBeanModelId,
        control_profile: {
          // Store each control with its own time array as discrete events
          heater: {
            time: this.controlProfile.heater.map(p => p.time),
            values: this.controlProfile.heater.map(p => p.value)
          },
          fan: {
            time: this.controlProfile.fan.map(p => p.time),
            values: this.controlProfile.fan.map(p => p.value)
          },
          drum: {
            time: this.controlProfile.drum.map(p => p.time),
            values: this.controlProfile.drum.map(p => p.value)
          }
        },
        simulated_results: this.simulatedResults,
        target_temp_c: this.simulatedResults.bean_temp[this.simulatedResults.bean_temp.length - 1]
      };
      
      // Insert into database
      const { error } = await supabase
        .from('recipes')
        .insert([recipeData]);
      
      if (error) throw error;
      
      alert('Recipe saved successfully!');
      console.log('✅ Recipe saved');
      
    } catch (error) {
      console.error('Failed to save recipe:', error);
      alert(`Failed to save recipe: ${(error as Error).message}`);
    }
  }
  
  /**
   * Reset the generator to initial state
   */
  private resetGenerator(): void {
    // Reset control profile to defaults
    this.controlProfile = {
      heater: [
        { time: 0, value: 0.5 },
        { time: this.durationSeconds, value: 0.5 }
      ],
      fan: [
        { time: 0, value: 0.5 },
        { time: this.durationSeconds, value: 0.5 }
      ],
      drum: [
        { time: 0, value: 0.5 },
        { time: this.durationSeconds, value: 0.5 }
      ]
    };
    
    this.simulatedResults = null;
    
    // Update UI - reset the control editor and clear temperature traces from combined chart
    this.updateControlEditor();
    
    // Clear temperature datasets from the combined chart (keep only control datasets 0-2)
    if (controlChart && controlChart.data.datasets.length > 3) {
      controlChart.data.datasets = controlChart.data.datasets.slice(0, 3);
      controlChart.options.scales.y.max = 100; // Reset y-axis to control range
      controlChart.options.scales.y.title.text = 'Power (%)';
      controlChart.update();
    }
    
    console.log('Generator reset');
  }
  
  /**
   * Show error message
   * @param message - Error message to display
   */
  private showError(message: string): void {
    this.errorDiv.textContent = message;
    this.errorDiv.style.display = 'block';
  }
}
