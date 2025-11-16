/**
 * Generator Layer Implementation
 * 
 * Manages recipe generation in the Canvas.
 * Provides:
 * - Model selection (roaster and bean models)
 * - Parameter controls (ambient temp, charge temp, mass, duration)
 * - Control profile editing (heater, fan, drum)
 * - ONNX model-based simulation
 * - Recipe saving
 * - Color customization
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import type { GeneratorLayerConfig, DataSeries } from './types';
import { Chart, registerables } from 'chart.js';
import 'chartjs-plugin-dragdata';

// Register Chart.js components
Chart.register(...registerables);

// Declare ONNX Runtime global from CDN
declare const ort: any;

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
 * Regression coefficients for initial conditions
 * Loaded from initial_conditions.json (computed by initial_conditions_finder.py)
 */
interface RegressionCoefficients {
  T_env: {
    a: number;  // Slope: T_env = a * T_bm + b
    b: number;  // Intercept
    r_squared: number;  // R² value (quality of fit)
    formula: string;
  };
  T_r: {
    a: number;  // Slope: T_r = a * T_bm + b
    b: number;  // Intercept
    r_squared: number;  // R² value (quality of fit)
    formula: string;
  };
}

/**
 * GeneratorLayer class
 * Handles all recipe generator layer operations
 */
export class GeneratorLayer {
  private user: User;
  private config: GeneratorLayerConfig;
  
  // ONNX model sessions
  private roasterSession: any = null;
  private beanSession: any = null;
  
  // Initial conditions regression coefficients (loaded from initial_conditions.json)
  // These provide a more consistent way to set initial conditions based on T_bm
  private initialConditionsCoefficients: RegressionCoefficients | null = null;
  
  // Simulated results cache
  private simulatedResults: {
    time: number[];
    bean_temp: number[];
    bean_surface_temp: number[];
    drum_temp: number[];
    air_temp: number[];
    env_probe_temp: number[];
    ror: number[];
  } | null = null;
  
  // Control editor chart instance
  private controlChart: any = null;
  
  // Active control being edited (heat, fan, or drum)
  private activeControl: 'heater' | 'fan' | 'drum' = 'heater';
  
  // Click tracking for double-click detection (to add control points)
  private lastClickTime: number = 0;
  private lastClickX: number = 0;
  private lastClickY: number = 0;
  private readonly DOUBLE_CLICK_TIME = 300; // milliseconds
  private readonly DOUBLE_CLICK_DISTANCE = 10; // pixels
  
  // Callback for when configuration changes (to trigger chart update)
  private onConfigChange: () => void;
  
  // Scaling factors - MUST match dataset.py and RecipeGenerator
  private readonly scalingFactors = {
    temperatures: {
      bean: 100.0,
      environment: 100.0,
      temp_difference: 100.0
    },
    controls: {
      heater: 100.0,
      fan: 100.0,
      drum: 100.0,
      ambient: 100.0,
      humidity: 100.0
    },
    mass: 100.0,
    time: 60.0
  };
  
  // Fixed parameters
  private readonly fixedParams = {
    humidity: 0.5
  };
  
  // Physics timestep (seconds)
  private readonly timestep: number = 1.5;
  
  constructor(user: User, config: GeneratorLayerConfig, onConfigChange: () => void) {
    this.user = user;
    this.config = config;
    this.onConfigChange = onConfigChange;
  }
  
  /**
   * Render the properties panel UI for this layer
   * @param container - DOM element to render into
   */
  async renderProperties(container: HTMLElement): Promise<void> {
    // Placeholder: Will be filled in
    container.innerHTML = `
      <div class="property-section">
        <h3>Recipe Generator Layer</h3>
        <div id="generator-layer-content">
          <!-- Content will be dynamically rendered here -->
        </div>
      </div>
    `;
    
    // Render the full UI
    await this.renderPropertiesUI(container);
  }
  
  /**
   * Render the complete properties UI
   */
  private async renderPropertiesUI(container: HTMLElement): Promise<void> {
    const contentDiv = container.querySelector('#generator-layer-content') as HTMLElement;
    if (!contentDiv) return;
    
    // Show loading state initially
    contentDiv.innerHTML = `
      <div style="padding: 20px; text-align: center;">
        <div class="loading-spinner"></div>
        <div>Loading models...</div>
      </div>
    `;
    
    // Load available models
    const { roasterModels, beanModels } = await this.loadAvailableModels();
    
    // Build the UI with all sections
    contentDiv.innerHTML = `
      <!-- Color picker section -->
      <div class="property-group">
        <label class="property-label">Line Color</label>
        <div class="property-control">
          <input type="color" id="gen-color-input" value="${this.config.color || '#2ecc71'}">
        </div>
      </div>
      
      <!-- Model Selection Tables -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Model Selection</h4>
      
      <div class="property-group">
        <label class="property-label">Roaster Model</label>
        <div id="gen-roaster-table-container" style="max-height: 200px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-top: 8px;">
          <!-- Roaster model table will be inserted here -->
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Bean Model</label>
        <div id="gen-bean-table-container" style="max-height: 200px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-top: 8px;">
          <!-- Bean model table will be inserted here -->
        </div>
      </div>
      
      <!-- Control Profile Editor Section -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Control Profile Editor</h4>
      
      <div class="property-group">
        <label class="property-label">Edit Control Curve</label>
        <div class="control-selector" style="display: flex; gap: 8px; margin-top: 8px; margin-bottom: 12px;">
          <button class="control-selector-btn active" data-control="heater" style="flex: 1; padding: 8px; border: 2px solid #e74c3c; background: #e74c3c; color: white; border-radius: 4px; cursor: pointer; font-weight: bold;">
            Heat
          </button>
          <button class="control-selector-btn" data-control="fan" style="flex: 1; padding: 8px; border: 2px solid #3498db; background: transparent; color: #3498db; border-radius: 4px; cursor: pointer; font-weight: bold;">
            Fan
          </button>
          <button class="control-selector-btn" data-control="drum" style="flex: 1; padding: 8px; border: 2px solid #9b59b6; background: transparent; color: #9b59b6; border-radius: 4px; cursor: pointer; font-weight: bold;">
            Drum
          </button>
        </div>
        
        <!-- Control editor canvas -->
        <div style="height: 250px; margin-bottom: 12px; border: 1px solid #ddd; border-radius: 4px; background: white;">
          <canvas id="gen-control-chart"></canvas>
        </div>
        
        <!-- Instructions and Artisan snap -->
        <div style="font-size: 11px; color: #666; margin-bottom: 8px;">
          <strong>Instructions:</strong> Double-click to add point • Click point to remove • Drag to adjust
        </div>
        
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 12px;">
          <input type="checkbox" id="gen-artisan-snap" checked>
          <span>Snap to Artisan increments (5%)</span>
        </label>
      </div>
      
      <!-- Parameters Section -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Parameters</h4>
      
      <div class="property-group">
        <label class="property-label">Bean Mass (g)</label>
        <div class="property-control">
          <input type="range" min="50" max="200" step="5" value="${this.config.beanMassG}" id="gen-mass-slider">
        </div>
        <div class="property-value-display">
          <span id="gen-mass-value">${this.config.beanMassG}g</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Ambient Temperature (°C)</label>
        <div class="property-control">
          <input type="range" min="15" max="35" step="1" value="${this.config.ambientTempC}" id="gen-ambient-slider">
        </div>
        <div class="property-value-display">
          <span id="gen-ambient-value">${this.config.ambientTempC}°C</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Initial Bean Probe Temp (°C)</label>
        <div class="property-control">
          <input type="range" min="100" max="220" step="5" value="${this.config.preheatTempC}" id="gen-preheat-slider">
        </div>
        <div class="property-value-display">
          <span id="gen-preheat-value">${this.config.preheatTempC}°C</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Roast Duration (seconds)</label>
        <div class="property-control">
          <input type="number" min="300" max="1200" step="10" value="${this.config.durationSeconds}" id="gen-duration-input" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
        </div>
      </div>
      
      <!-- Recipe Info Section -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Recipe Info</h4>
      
      <div class="property-group">
        <label class="property-label">Recipe Name</label>
        <div class="property-control">
          <input type="text" id="gen-recipe-name" placeholder="My Recipe" value="Untitled Recipe" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
        </div>
      </div>
      
      <!-- Action Buttons -->
      <div class="property-group" style="margin-top: 20px;">
        <button id="gen-simulate-btn" class="btn-primary" style="width: 100%; margin-bottom: 8px;">
          Simulate Profile
        </button>
        <button id="gen-save-btn" class="btn-success" style="width: 100%;">
          Save Recipe
        </button>
      </div>
      
      <!-- Status message area -->
      <div id="gen-status-message" style="margin-top: 10px; padding: 10px; border-radius: 4px; display: none;"></div>
    `;
    
    // Render model tables
    this.renderModelTables(roasterModels, beanModels);
    
    // Attach event listeners
    this.attachEventListeners();
  }
  
  /**
   * Load available trained models from database
   */
  private async loadAvailableModels(): Promise<{ roasterModels: TrainingJob[], beanModels: TrainingJob[] }> {
    try {
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
      
      return { roasterModels, beanModels };
    } catch (error) {
      console.error('Failed to load available models:', error);
      return { roasterModels: [], beanModels: [] };
    }
  }
  
  /**
   * Render model selection tables
   */
  private renderModelTables(roasterModels: TrainingJob[], beanModels: TrainingJob[]): void {
    // Render roaster model table
    const roasterTableContainer = document.getElementById('gen-roaster-table-container');
    if (roasterTableContainer) {
      if (roasterModels.length === 0) {
        roasterTableContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No trained roaster models found</div>';
      } else {
        roasterTableContainer.innerHTML = `
          <table style="width: 100%; font-size: 12px;">
            <thead style="position: sticky; top: 0; background: #f5f5f5;">
              <tr>
                <th style="padding: 8px; text-align: left;">Model Name</th>
                <th style="padding: 8px; text-align: left;">Date</th>
              </tr>
            </thead>
            <tbody id="gen-roaster-table-body">
            </tbody>
          </table>
        `;
        
        const tbody = document.getElementById('gen-roaster-table-body');
        if (tbody) {
          roasterModels.forEach(model => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.dataset.modelId = model.id;
            
            // Highlight if selected
            if (this.config.roasterModelId === model.id) {
              row.style.backgroundColor = '#e3f2fd';
            }
            
            const modelName = model.job_name || `Model ${model.id.slice(0, 8)}`;
            const date = new Date(model.completed_at!).toLocaleDateString();
            
            row.innerHTML = `
              <td style="padding: 8px;">${modelName}</td>
              <td style="padding: 8px;">${date}</td>
            `;
            
            row.addEventListener('click', () => this.selectRoasterModel(model.id));
            
            // Hover effects
            row.addEventListener('mouseenter', () => {
              if (this.config.roasterModelId !== model.id) {
                row.style.backgroundColor = '#f5f5f5';
              }
            });
            row.addEventListener('mouseleave', () => {
              if (this.config.roasterModelId !== model.id) {
                row.style.backgroundColor = '';
              }
            });
            
            tbody.appendChild(row);
          });
        }
      }
    }
    
    // Render bean model table
    const beanTableContainer = document.getElementById('gen-bean-table-container');
    if (beanTableContainer) {
      if (beanModels.length === 0) {
        beanTableContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No trained bean models found</div>';
      } else {
        beanTableContainer.innerHTML = `
          <table style="width: 100%; font-size: 12px;">
            <thead style="position: sticky; top: 0; background: #f5f5f5;">
              <tr>
                <th style="padding: 8px; text-align: left;">Model Name</th>
                <th style="padding: 8px; text-align: left;">Date</th>
              </tr>
            </thead>
            <tbody id="gen-bean-table-body">
            </tbody>
          </table>
        `;
        
        const tbody = document.getElementById('gen-bean-table-body');
        if (tbody) {
          beanModels.forEach(model => {
            const row = document.createElement('tr');
            row.style.cursor = 'pointer';
            row.dataset.modelId = model.id;
            
            // Highlight if selected
            if (this.config.beanModelId === model.id) {
              row.style.backgroundColor = '#e3f2fd';
            }
            
            const modelName = model.job_name || `Model ${model.id.slice(0, 8)}`;
            const date = new Date(model.completed_at!).toLocaleDateString();
            
            row.innerHTML = `
              <td style="padding: 8px;">${modelName}</td>
              <td style="padding: 8px;">${date}</td>
            `;
            
            row.addEventListener('click', () => this.selectBeanModel(model.id));
            
            // Hover effects
            row.addEventListener('mouseenter', () => {
              if (this.config.beanModelId !== model.id) {
                row.style.backgroundColor = '#f5f5f5';
              }
            });
            row.addEventListener('mouseleave', () => {
              if (this.config.beanModelId !== model.id) {
                row.style.backgroundColor = '';
              }
            });
            
            tbody.appendChild(row);
          });
        }
      }
    }
  }
  
  /**
   * Select a roaster model
   */
  private async selectRoasterModel(modelId: string): Promise<void> {
    this.config.roasterModelId = modelId;
    
    // Update table highlighting
    const rows = document.querySelectorAll('#gen-roaster-table-body tr');
    rows.forEach(row => {
      const rowElement = row as HTMLElement;
      if (rowElement.dataset.modelId === modelId) {
        rowElement.style.backgroundColor = '#e3f2fd';
      } else {
        rowElement.style.backgroundColor = '';
      }
    });
    
    // Clear cached session to force reload
    this.roasterSession = null;
    
    // Load the model
    await this.loadModelsIfNeeded();
    
    // Auto-simulate if both models are loaded
    if (this.roasterSession && this.beanSession) {
      await this.simulateProfile();
    }
  }
  
  /**
   * Select a bean model
   */
  private async selectBeanModel(modelId: string): Promise<void> {
    this.config.beanModelId = modelId;
    
    // Update table highlighting
    const rows = document.querySelectorAll('#gen-bean-table-body tr');
    rows.forEach(row => {
      const rowElement = row as HTMLElement;
      if (rowElement.dataset.modelId === modelId) {
        rowElement.style.backgroundColor = '#e3f2fd';
      } else {
        rowElement.style.backgroundColor = '';
      }
    });
    
    // Clear cached session to force reload
    this.beanSession = null;
    
    // Load the model
    await this.loadModelsIfNeeded();
    
    // Auto-simulate if both models are loaded
    if (this.roasterSession && this.beanSession) {
      await this.simulateProfile();
    }
  }
  
  /**
   * Load ONNX models if not already loaded
   */
  private async loadModelsIfNeeded(): Promise<void> {
    try {
      // Check if models need to be loaded
      if (!this.config.roasterModelId || !this.config.beanModelId) {
        return;
      }
      
      // Load roaster model if not already loaded
      if (!this.roasterSession && this.config.roasterModelId) {
        this.showStatus('Loading roaster model...', 'info');
        
        // Configure ONNX Runtime
        if (typeof ort !== 'undefined') {
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.simd = true;
        } else {
          throw new Error('ONNX Runtime not available');
        }
        
        // Download roaster model from storage
        const roasterModelBlob = await this.downloadModelFromStorage(
          this.user.id,
          this.config.roasterModelId,
          'roast_stepper.onnx'
        );
        
        // Create ONNX session
        const arrayBuffer = await roasterModelBlob.arrayBuffer();
        this.roasterSession = await ort.InferenceSession.create(arrayBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        
        console.log('✓ Roaster model loaded');
      }
      
      // Load bean model if not already loaded
      if (!this.beanSession && this.config.beanModelId) {
        this.showStatus('Loading bean model...', 'info');
        
        // Get bean model metadata to find filename
        const { data: beanJobData, error: beanJobError } = await supabase
          .from('training_jobs')
          .select('config')
          .eq('id', this.config.beanModelId)
          .single();
        
        if (beanJobError) {
          throw new Error(`Failed to fetch bean model metadata: ${beanJobError.message}`);
        }
        
        // Try to extract bean variety from config
        let beanVariety = beanJobData?.config?.bean_variety || 
                          beanJobData?.config?.variety ||
                          beanJobData?.config?.bean?.variety;
        
        let beanModelFilename: string;
        
        if (beanVariety) {
          beanModelFilename = `bean_${beanVariety.toLowerCase()}.onnx`;
        } else {
          // Fallback: List files in storage and find the bean model
          const storagePath = `${this.user.id}/jobs/${this.config.beanModelId}`;
          const { data: files, error: listError } = await supabase.storage
            .from('trained-models')
            .list(storagePath);
          
          if (listError) {
            throw new Error(`Failed to list storage files: ${listError.message}`);
          }
          
          const beanModelFile = files?.find(f => f.name.startsWith('bean_') && f.name.endsWith('.onnx'));
          
          if (!beanModelFile) {
            throw new Error(`No bean model file found in storage`);
          }
          
          beanModelFilename = beanModelFile.name;
        }
        
        // Download bean model from storage
        const beanModelBlob = await this.downloadModelFromStorage(
          this.user.id,
          this.config.beanModelId,
          beanModelFilename
        );
        
        // Create ONNX session
        const arrayBuffer = await beanModelBlob.arrayBuffer();
        this.beanSession = await ort.InferenceSession.create(arrayBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });
        
        console.log('✓ Bean model loaded');
      }
      
      // Try to load initial conditions regression coefficients
      // This is optional - if not found, we'll fall back to hardcoded offsets
      await this.loadInitialConditionsCoefficients(this.user.id, this.config.roasterModelId);
      
      this.showStatus('Models loaded successfully', 'success');
      
      // Initialize control editor if not already initialized
      if (!this.controlChart) {
        this.initializeControlEditor();
      }
      
      // Run initial simulation
      await this.simulateProfile();
      
    } catch (error) {
      console.error('Failed to load models:', error);
      this.showStatus(`Failed to load models: ${(error as Error).message}`, 'error');
    }
  }
  
  /**
   * Load initial conditions regression coefficients from Supabase storage
   * This is optional - if not found, we'll fall back to hardcoded offsets
   * 
   * @param userId - User ID
   * @param roasterJobId - Roaster model job ID
   */
  private async loadInitialConditionsCoefficients(userId: string, roasterJobId: string): Promise<void> {
    try {
      console.log('Attempting to load initial conditions coefficients...');
      
      // Try to download initial_conditions.json from roaster model storage
      const storagePath = `${userId}/jobs/${roasterJobId}/initial_conditions.json`;
      
      const { data, error } = await supabase.storage
        .from('trained-models')
        .download(storagePath);
      
      if (error) {
        console.warn('Initial conditions file not found, will use hardcoded offsets:', error);
        return;
      }
      
      if (!data) {
        console.warn('No data in initial conditions file');
        return;
      }
      
      // Parse JSON from blob
      const text = await data.text();
      const initialConditionsData = JSON.parse(text);
      
      // Extract regression coefficients
      if (initialConditionsData.regression_coefficients) {
        const coeffs = initialConditionsData.regression_coefficients;
        this.initialConditionsCoefficients = coeffs;
        
        console.log('✓ Initial conditions coefficients loaded:', {
          T_env: coeffs.T_env.formula,
          T_r: coeffs.T_r.formula,
          T_env_r2: coeffs.T_env.r_squared.toFixed(4),
          T_r_r2: coeffs.T_r.r_squared.toFixed(4)
        });
      } else {
        console.warn('No regression coefficients found in initial conditions file');
      }
      
    } catch (error) {
      console.warn('Failed to load initial conditions coefficients:', error);
      // Not a critical error - we'll fall back to hardcoded offsets
    }
  }
  
  /**
   * Download an ONNX model file from Supabase storage
   * Models are stored at: {user_id}/jobs/{job_id}/{filename}
   */
  private async downloadModelFromStorage(
    userId: string,
    jobId: string,
    filename: string
  ): Promise<Blob> {
    const storagePath = `${userId}/jobs/${jobId}/${filename}`;
    
    console.log(`Downloading model from storage: ${storagePath}`);
    
    const { data, error } = await supabase.storage
      .from('trained-models')
      .download(storagePath);
    
    if (error) {
      throw new Error(`Failed to download ${filename}: ${error.message}`);
    }
    
    if (!data) {
      throw new Error(`No data received when downloading ${filename}`);
    }
    
    console.log(`✓ Downloaded ${filename} (${data.size} bytes)`);
    return data;
  }
  
  /**
   * Attach event listeners to property controls
   */
  private attachEventListeners(): void {
    // Color picker
    const colorInput = document.getElementById('gen-color-input') as HTMLInputElement;
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        this.config.color = (e.target as HTMLInputElement).value;
        this.onConfigChange();
      });
    }
    
    // Parameter sliders
    const massSlider = document.getElementById('gen-mass-slider') as HTMLInputElement;
    const massValue = document.getElementById('gen-mass-value');
    if (massSlider && massValue) {
      massSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.beanMassG = value;
        massValue.textContent = `${value}g`;
        this.onParameterChange();
      });
    }
    
    const ambientSlider = document.getElementById('gen-ambient-slider') as HTMLInputElement;
    const ambientValue = document.getElementById('gen-ambient-value');
    if (ambientSlider && ambientValue) {
      ambientSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.ambientTempC = value;
        ambientValue.textContent = `${value}°C`;
        this.onParameterChange();
      });
    }
    
    const preheatSlider = document.getElementById('gen-preheat-slider') as HTMLInputElement;
    const preheatValue = document.getElementById('gen-preheat-value');
    if (preheatSlider && preheatValue) {
      preheatSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.preheatTempC = value;
        preheatValue.textContent = `${value}°C`;
        this.onParameterChange();
      });
    }
    
    const durationInput = document.getElementById('gen-duration-input') as HTMLInputElement;
    if (durationInput) {
      durationInput.addEventListener('change', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.durationSeconds = value;
        this.onParameterChange();
      });
    }
    
    // Action buttons
    const simulateBtn = document.getElementById('gen-simulate-btn');
    if (simulateBtn) {
      simulateBtn.addEventListener('click', () => this.simulateProfile());
    }
    
    const saveBtn = document.getElementById('gen-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.saveRecipe());
    }
  }
  
  /**
   * Handle parameter changes (auto-simulate if models are loaded)
   */
  private async onParameterChange(): Promise<void> {
    if (this.roasterSession && this.beanSession) {
      await this.simulateProfile();
    }
  }
  
  /**
   * Simulate the roast profile using loaded ONNX models
   * Runs the roaster and bean models forward in time using the control profile
   */
  private async simulateProfile(): Promise<void> {
    try {
      if (!this.roasterSession || !this.beanSession) {
        this.showStatus('Models not loaded yet', 'error');
        return;
      }
      
      this.showStatus('Simulating profile...', 'info');
      
      // Initialize state with preheat conditions
      // State vector dimensions: [T_r, T_b, T_air, T_bm, T_atm]
      const preheatTemp = this.config.preheatTempC;  // Bean probe initial temperature (°C)
      const roomTemp = this.config.ambientTempC;     // Bean core starts at ambient (°C)
      
      // Calculate initial conditions using regression coefficients if available
      // Otherwise fall back to hardcoded offsets
      let roasterTemp: number;
      let envTemp: number;
      
      if (this.initialConditionsCoefficients) {
        // Use linear regression: T = a * T_bm + b
        roasterTemp = this.initialConditionsCoefficients.T_r.a * preheatTemp + 
                      this.initialConditionsCoefficients.T_r.b;
        envTemp = this.initialConditionsCoefficients.T_env.a * preheatTemp + 
                  this.initialConditionsCoefficients.T_env.b;
        
        console.log('Using regression-based initial conditions:', {
          T_bm: preheatTemp.toFixed(1) + '°C',
          T_r: roasterTemp.toFixed(1) + '°C (from regression)',
          T_env: envTemp.toFixed(1) + '°C (from regression)'
        });
      } else {
        // Fallback to hardcoded offsets (original behavior)
        roasterTemp = preheatTemp + 50.0;  // Roaster/drum temp ~50°C above bean probe
        envTemp = preheatTemp - 40.0;      // Environment temp ~40°C below bean probe
        
        console.log('Using hardcoded offsets for initial conditions:', {
          T_bm: preheatTemp.toFixed(1) + '°C',
          T_r: roasterTemp.toFixed(1) + '°C (T_bm + 50)',
          T_env: envTemp.toFixed(1) + '°C (T_bm - 40)'
        });
      }
      
      const airTemp = preheatTemp;  // Air temp starts at bean probe temp
      
      // Normalize using scaling factors
      const tempScale = this.scalingFactors.temperatures.bean;
      let currentState = new Float32Array([
        roasterTemp / tempScale,   // T_r (roaster temperature)
        roomTemp / tempScale,      // T_b (bean core temperature)
        airTemp / tempScale,       // T_air (air temperature)
        preheatTemp / tempScale,   // T_bm (bean measurement temperature)
        envTemp / tempScale        // T_atm (environment temperature)
      ]);
      
      // Results storage
      const time: number[] = [];
      const bean_temp: number[] = [];          // T_bm (Bean Probe)
      const bean_surface_temp: number[] = [];  // T_b (Bean Core)
      const drum_temp: number[] = [];          // T_r (Roaster/Drum)
      const air_temp: number[] = [];           // T_air (Air)
      const env_probe_temp: number[] = [];     // T_atm (Environment Probe)
      
      // Calculate number of simulation steps
      const numSteps = Math.ceil(this.config.durationSeconds / this.timestep);
      const dt = new Float32Array([this.timestep / this.scalingFactors.time]); // Normalized timestep
      
      console.log(`Running ${numSteps} simulation steps (${this.timestep}s each)`);
      
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
        // Control profiles use step functions (piecewise constant)
        const heaterValue = this.getControlValueAtTime('heater', currentTime);
        const fanValue = this.getControlValueAtTime('fan', currentTime);
        const drumValue = this.getControlValueAtTime('drum', currentTime);
        
        // Get bean thermal capacity from bean model
        // Bean model input: bean_temperature (normalized)
        // Bean model output: thermal_capacity (normalized)
        const beanModelResult = await this.beanSession.run({
          bean_temperature: new ort.Tensor('float32', [currentState[1]], [1, 1])
        });
        const beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
        
        // Prepare control inputs for roast stepper
        // Based on DrumRoasterExtended.forward(): [heater, fan, drum, T_amb, humidity, mass, C_b]
        const stepperControls = new Float32Array(7);
        stepperControls[0] = heaterValue;  // Heater power (0-1)
        stepperControls[1] = fanValue;     // Fan speed (0-1)
        stepperControls[2] = drumValue;    // Drum speed (0-1)
        stepperControls[3] = this.config.ambientTempC / this.scalingFactors.controls.ambient;
        stepperControls[4] = this.fixedParams.humidity;
        stepperControls[5] = this.config.beanMassG / this.scalingFactors.mass;
        stepperControls[6] = beanCapacity;
        
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
      
      // Calculate Rate of Rise (RoR) - derivative of bean temperature
      // RoR is expressed in °C/min
      const ror: number[] = [];
      for (let i = 0; i < time.length; i++) {
        if (i === 0) {
          ror.push(0); // First point has no previous point
        } else {
          const dt = time[i] - time[i-1]; // seconds
          const dTemp = bean_temp[i] - bean_temp[i-1]; // °C
          const rorValue = (dTemp / dt) * 60; // Convert to °C/min
          ror.push(Math.max(0, rorValue)); // Only positive RoR
        }
      }
      
      // Store final results
      this.simulatedResults = {
        time,
        bean_temp,
        bean_surface_temp,
        drum_temp,
        air_temp,
        env_probe_temp,
        ror
      };
      
      console.log('✅ Simulation complete', {
        steps: numSteps,
        finalTemp: bean_temp[bean_temp.length - 1].toFixed(1) + '°C'
      });
      
      this.showStatus('Simulation complete', 'success');
      
      // Trigger chart update
      this.onConfigChange();
      
    } catch (error) {
      console.error('Failed to simulate profile:', error);
      this.showStatus(`Simulation failed: ${(error as Error).message}`, 'error');
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
    const profile = this.config[`${input}Profile`] as { time: number; value: number }[];
    const sortedPoints = [...profile].sort((a, b) => a.time - b.time);
    
    // With 'before' stepping: find the last point at or before this time
    let i = 0;
    while (i < sortedPoints.length - 1 && sortedPoints[i + 1].time <= time) {
      i++;
    }
    
    // Return the value at this control point
    return sortedPoints[i].value;
  }
  
  /**
   * Save the current recipe to database
   */
  private async saveRecipe(): Promise<void> {
    try {
      if (!this.simulatedResults) {
        this.showStatus('Please simulate the profile first before saving', 'error');
        return;
      }
      
      this.showStatus('Saving recipe...', 'info');
      
      // Get recipe name from input
      const recipeNameInput = document.getElementById('gen-recipe-name') as HTMLInputElement;
      const recipeName = recipeNameInput?.value || 'Untitled Recipe';
      
      // Prepare recipe data
      const recipeData = {
        user_id: this.user.id,
        name: recipeName,
        duration_seconds: this.config.durationSeconds,
        bean_mass_g: this.config.beanMassG,
        ambient_temp_c: this.config.ambientTempC,
        roaster_model_id: this.config.roasterModelId,
        bean_model_id: this.config.beanModelId,
        control_profile: {
          heater: {
            time: this.config.heaterProfile.map(p => p.time),
            values: this.config.heaterProfile.map(p => p.value)
          },
          fan: {
            time: this.config.fanProfile.map(p => p.time),
            values: this.config.fanProfile.map(p => p.value)
          },
          drum: {
            time: this.config.drumProfile.map(p => p.time),
            values: this.config.drumProfile.map(p => p.value)
          }
        },
        simulated_results: {
          time: this.simulatedResults.time,
          bean_temp: this.simulatedResults.bean_temp,
          bean_surface_temp: this.simulatedResults.bean_surface_temp,
          drum_temp: this.simulatedResults.drum_temp,
          air_temp: this.simulatedResults.air_temp,
          env_probe_temp: this.simulatedResults.env_probe_temp
        },
        target_temp_c: this.simulatedResults.bean_temp[this.simulatedResults.bean_temp.length - 1]
      };
      
      // Insert into database
      const { error } = await supabase
        .from('recipes')
        .insert([recipeData]);
      
      if (error) throw error;
      
      this.showStatus('Recipe saved successfully!', 'success');
      console.log('✅ Recipe saved');
      
    } catch (error) {
      console.error('Failed to save recipe:', error);
      this.showStatus(`Failed to save recipe: ${(error as Error).message}`, 'error');
    }
  }
  
  /**
   * Get data series for this layer
   * @returns Array of data series to plot
   * 
   * Generates all temperature traces and control traces scaled to 0-100 range
   * All traces are plotted on the same y-axis for easy comparison
   */
  async getDataSeries(): Promise<DataSeries[]> {
    const series: DataSeries[] = [];
    
    // If no simulation results, return empty
    if (!this.simulatedResults) {
      return series;
    }
    
    // Base color for this layer
    const baseColor = this.config.color || '#2ecc71';
    
    // Temperature traces (in °C, 0-350 range)
    // Bean temperature (primary)
    series.push({
      label: 'BT (Generated)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.bean_temp[i] 
      })),
      style: {
        color: baseColor,
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Rate of Rise (plotted on right axis, 0-50 °C/min range)
    series.push({
      label: 'RoR (Generated)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.ror[i] 
      })),
      style: {
        color: baseColor,
        lineWidth: 1.5,
        showPoints: false,
        pointRadius: 0,
        lineDash: [2, 2], // Dotted
        fill: false,
        fillOpacity: 0.2
      },
      yAxisID: 'y2'
    });
    
    // Bean surface temperature
    series.push({
      label: 'Bean Surface (Generated)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.bean_surface_temp[i] 
      })),
      style: {
        color: baseColor,
        lineWidth: 1,
        showPoints: false,
        pointRadius: 0,
        lineDash: [5, 5], // Dashed
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Drum temperature
    series.push({
      label: 'Drum (Generated)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.drum_temp[i] 
      })),
      style: {
        color: '#3498db',
        lineWidth: 1.5,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Air temperature
    series.push({
      label: 'Air (Generated)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.air_temp[i] 
      })),
      style: {
        color: '#9b59b6',
        lineWidth: 1.5,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Environment probe temperature
    series.push({
      label: 'Env Probe (Generated)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.env_probe_temp[i] 
      })),
      style: {
        color: '#95a5a6',
        lineWidth: 1.5,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Control traces (scaled to 0-100 range, same as temperatures)
    // Controls are piecewise constant functions - use Chart.js stepped mode
    
    // Heater control
    series.push({
      label: 'Heater (Generated)',
      data: this.config.heaterProfile.map(p => ({ 
        x: p.time, 
        y: p.value * 100  // Convert 0-1 to 0-100
      })),
      style: {
        color: '#e74c3c',
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0,
        stepped: 'before'  // Piecewise constant with 'before' stepping
      },
      yAxisID: 'y'
    });
    
    // Fan control
    series.push({
      label: 'Fan (Generated)',
      data: this.config.fanProfile.map(p => ({ 
        x: p.time, 
        y: p.value * 100  // Convert 0-1 to 0-100
      })),
      style: {
        color: '#3498db',
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0,
        stepped: 'before'  // Piecewise constant with 'before' stepping
      },
      yAxisID: 'y'
    });
    
    // Drum control
    series.push({
      label: 'Drum (Generated)',
      data: this.config.drumProfile.map(p => ({ 
        x: p.time, 
        y: p.value * 100  // Convert 0-1 to 0-100
      })),
      style: {
        color: '#9b59b6',
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0,
        stepped: 'before'  // Piecewise constant with 'before' stepping
      },
      yAxisID: 'y'
    });
    
    return series;
  }
  
  /**
   * Show a status message
   */
  private showStatus(message: string, type: 'success' | 'error' | 'info'): void {
    const statusDiv = document.getElementById('gen-status-message');
    if (!statusDiv) return;
    
    statusDiv.style.display = 'block';
    statusDiv.textContent = message;
    
    // Set color based on type
    if (type === 'success') {
      statusDiv.style.backgroundColor = '#d4edda';
      statusDiv.style.color = '#155724';
      statusDiv.style.border = '1px solid #c3e6cb';
    } else if (type === 'error') {
      statusDiv.style.backgroundColor = '#f8d7da';
      statusDiv.style.color = '#721c24';
      statusDiv.style.border = '1px solid #f5c6cb';
    } else {
      statusDiv.style.backgroundColor = '#d1ecf1';
      statusDiv.style.color = '#0c5460';
      statusDiv.style.border = '1px solid #bee5eb';
    }
    
    // Auto-hide after 3 seconds
    setTimeout(() => {
      statusDiv.style.display = 'none';
    }, 3000);
  }
  
  /**
   * Initialize the interactive control editor with Chart.js
   * Creates a chart showing heater, fan, and drum control curves
   * Only one control is editable at a time (selected via buttons)
   */
  private initializeControlEditor(): void {
    const canvas = document.getElementById('gen-control-chart') as HTMLCanvasElement;
    if (!canvas) {
      console.error('Control chart canvas not found');
      return;
    }
    
    // Prepare datasets for all three controls
    const heaterData = this.config.heaterProfile.map(p => ({ x: p.time, y: p.value * 100 }));
    const fanData = this.config.fanProfile.map(p => ({ x: p.time, y: p.value * 100 }));
    const drumData = this.config.drumProfile.map(p => ({ x: p.time, y: p.value * 100 }));
    
    // Create the control chart with dragdata plugin
    this.controlChart = new Chart(canvas, {
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
        animation: false,
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
          dragData: {
            round: 1,
            showTooltip: true,
            dragX: true,
            onDragStart: (_e: any, datasetIndex: number, _index: number, _value: any) => {
              // Only allow dragging the active control
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              return controlName === this.activeControl;
            },
            onDrag: ((_e: any, datasetIndex: number, index: number, value: any) => {
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              const points = this.config[`${controlName}Profile`] as { time: number; value: number }[];
              
              // Anchor first and last points at time 0 and durationSeconds
              const currentPoint = points[index];
              const isFirstPoint = currentPoint.time === 0;
              const isLastPoint = currentPoint.time === this.config.durationSeconds;
              
              let constrainedX: number;
              if (isFirstPoint) {
                constrainedX = 0;
              } else if (isLastPoint) {
                constrainedX = this.config.durationSeconds;
              } else {
                constrainedX = Math.max(0, Math.min(this.config.durationSeconds, value.x));
              }
              
              // Y (power) constrained to 0-100%
              let constrainedY = Math.max(0, Math.min(1, value.y / 100));
              
              // Apply Artisan snapping if enabled
              const snapCheckbox = document.getElementById('gen-artisan-snap') as HTMLInputElement;
              if (snapCheckbox && snapCheckbox.checked) {
                constrainedY = this.snapToArtisanIncrement(constrainedY);
              }
              
              // Update the point
              points[index].time = constrainedX;
              points[index].value = constrainedY;
              
              return {
                x: constrainedX,
                y: constrainedY * 100
              };
            }) as any,
            onDragEnd: (_e: any, datasetIndex: number, _index: number, _value: any) => {
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              const points = this.config[`${controlName}Profile`] as { time: number; value: number }[];
              
              // Sort points by time
              points.sort((a, b) => a.time - b.time);
              
              // Update the chart data
              const sortedData = points.map(p => ({ x: p.time, y: p.value * 100 }));
              this.controlChart.data.datasets[datasetIndex].data = sortedData;
              this.controlChart.update();
              
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
            max: this.config.durationSeconds,
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
          
          // Check for double-click
          const timeDiff = currentTime - this.lastClickTime;
          const distX = Math.abs(clickX - this.lastClickX);
          const distY = Math.abs(clickY - this.lastClickY);
          const isDoubleClick = timeDiff < this.DOUBLE_CLICK_TIME && 
                                distX < this.DOUBLE_CLICK_DISTANCE && 
                                distY < this.DOUBLE_CLICK_DISTANCE;
          
          if (isDoubleClick) {
            // Double-click: add a control point
            const chartArea = chart.chartArea;
            if (chartArea && clickX >= chartArea.left && clickX <= chartArea.right && 
                clickY >= chartArea.top && clickY <= chartArea.bottom) {
              
              const xScale = chart.scales?.x;
              const yScale = chart.scales?.y;
              
              if (xScale && yScale && xScale.getValueForPixel && yScale.getValueForPixel) {
                const timeValue = xScale.getValueForPixel(clickX) as number;
                const powerValue = yScale.getValueForPixel(clickY) as number;
                
                const constrainedPower = Math.max(0, Math.min(100, powerValue));
                this.addControlPoint(this.activeControl, timeValue, constrainedPower / 100);
              }
            }
            
            this.lastClickTime = 0;
          } else {
            // Single click: check if clicking on a point to remove it
            if (activeElements.length > 0) {
              const element = activeElements[0];
              const datasetIndex = element.datasetIndex;
              const controlName = datasetIndex === 0 ? 'heater' : datasetIndex === 1 ? 'fan' : 'drum';
              
              if (controlName === this.activeControl) {
                this.removeControlPoint(controlName, element.index);
              }
            }
            
            // Update click tracking
            this.lastClickTime = currentTime;
            this.lastClickX = clickX;
            this.lastClickY = clickY;
          }
        }
      }
    });
    
    // Set up control selector buttons
    this.setupControlSelector();
    
    // Update visuals to show active control
    this.updateControlVisuals();
  }
  
  /**
   * Set up control selector buttons
   */
  private setupControlSelector(): void {
    const buttons = document.querySelectorAll('.control-selector-btn');
    
    buttons.forEach(button => {
      button.addEventListener('click', (e) => {
        const btn = e.target as HTMLButtonElement;
        const control = btn.getAttribute('data-control') as 'heater' | 'fan' | 'drum';
        
        if (!control) return;
        
        // Update active control
        this.activeControl = control;
        
        // Update button states
        buttons.forEach(b => {
          b.classList.remove('active');
          const btnElement = b as HTMLButtonElement;
          const btnControl = btnElement.getAttribute('data-control');
          if (btnControl === 'heater') {
            btnElement.style.background = 'transparent';
            btnElement.style.color = '#e74c3c';
          } else if (btnControl === 'fan') {
            btnElement.style.background = 'transparent';
            btnElement.style.color = '#3498db';
          } else if (btnControl === 'drum') {
            btnElement.style.background = 'transparent';
            btnElement.style.color = '#9b59b6';
          }
        });
        
        btn.classList.add('active');
        if (control === 'heater') {
          btn.style.background = '#e74c3c';
          btn.style.color = 'white';
        } else if (control === 'fan') {
          btn.style.background = '#3498db';
          btn.style.color = 'white';
        } else if (control === 'drum') {
          btn.style.background = '#9b59b6';
          btn.style.color = 'white';
        }
        
        // Update visual appearance
        this.updateControlVisuals();
      });
    });
  }
  
  /**
   * Update the visual appearance of control datasets
   */
  private updateControlVisuals(): void {
    if (!this.controlChart || !this.controlChart.data.datasets || this.controlChart.data.datasets.length < 3) return;
    
    const heaterDataset = this.controlChart.data.datasets[0];
    const fanDataset = this.controlChart.data.datasets[1];
    const drumDataset = this.controlChart.data.datasets[2];
    
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
    if (this.activeControl === 'heater') {
      heaterDataset.pointRadius = 8;
      heaterDataset.pointHoverRadius = 10;
      heaterDataset.borderWidth = 2;
      heaterDataset.pointBackgroundColor = '#e74c3c';
      heaterDataset.borderColor = '#e74c3c';
    } else if (this.activeControl === 'fan') {
      fanDataset.pointRadius = 8;
      fanDataset.pointHoverRadius = 10;
      fanDataset.borderWidth = 2;
      fanDataset.pointBackgroundColor = '#3498db';
      fanDataset.borderColor = '#3498db';
    } else if (this.activeControl === 'drum') {
      drumDataset.pointRadius = 8;
      drumDataset.pointHoverRadius = 10;
      drumDataset.borderWidth = 2;
      drumDataset.pointBackgroundColor = '#9b59b6';
      drumDataset.borderColor = '#9b59b6';
    }
    
    this.controlChart.update();
  }
  
  /**
   * Add a new control point
   */
  private addControlPoint(input: 'heater' | 'fan' | 'drum', time: number, value: number): void {
    const points = this.config[`${input}Profile`] as { time: number; value: number }[];
    
    // Find insertion point
    let insertIndex = points.findIndex(p => p.time > time);
    if (insertIndex === -1) insertIndex = points.length;
    
    // Insert new point
    points.splice(insertIndex, 0, { time, value });
    
    // Update chart
    const datasetIndex = input === 'heater' ? 0 : input === 'fan' ? 1 : 2;
    this.controlChart.data.datasets[datasetIndex].data = points.map(p => ({ x: p.time, y: p.value * 100 }));
    this.controlChart.update();
    
    // Automatically simulate after adding a point
    this.simulateProfile();
  }
  
  /**
   * Remove a control point
   */
  private removeControlPoint(controlInput: 'heater' | 'fan' | 'drum', pointIndex: number): void {
    const points = this.config[`${controlInput}Profile`] as { time: number; value: number }[];
    
    // Don't allow removing first or last point
    if (pointIndex === 0 || pointIndex === points.length - 1) {
      alert('Cannot remove first or last control point');
      return;
    }
    
    // Remove the point
    points.splice(pointIndex, 1);
    
    // Update chart
    const datasetIndex = controlInput === 'heater' ? 0 : controlInput === 'fan' ? 1 : 2;
    this.controlChart.data.datasets[datasetIndex].data = points.map(p => ({ x: p.time, y: p.value * 100 }));
    this.controlChart.update();
    
    // Automatically simulate after removing a point
    this.simulateProfile();
  }
  
  /**
   * Snap a value (0-1) to the nearest Artisan increment (5%)
   */
  private snapToArtisanIncrement(value: number): number {
    const increment = 0.05;
    return Math.round(value / increment) * increment;
  }
}
