/**
 * Simulator Layer Implementation
 * 
 * Provides an interactive roast simulator in the Canvas.
 * Features:
 * - Model selection (roaster and bean models)
 * - Real-time manual controls (heat, fan, drum sliders)
 * - Parameter controls (ambient temp, charge mass, bean temp set value)
 * - Live simulation visualization
 * - Color customization
 * - Stop/Reset functionality
 */

import { supabase } from '../../lib/supabase';
import type { User } from '@supabase/supabase-js';
import type { SimulatorLayerConfig, DataSeries } from './types';

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
 * SimulatorLayer class
 * Handles all simulator layer operations
 */
export class SimulatorLayer {
  private user: User;
  private config: SimulatorLayerConfig;
  
  // ONNX model sessions
  private roasterSession: any = null;
  private beanSession: any = null;
  
  // Simulation state
  private isRunning: boolean = false;
  private simulationTimer: any = null;
  private speedupFactor: number = 1; // Simulation speed multiplier (1x, 2x, 4x, 8x)
  
  // Current simulator values (from sliders)
  private currentControls = {
    heater: 0.5,   // 0-1
    fan: 0.5,      // 0-1
    drum: 0.5      // 0-1
  };
  
  // Simulated results storage
  private simulatedResults: {
    time: number[];
    bean_temp: number[];
    bean_surface_temp: number[];
    drum_temp: number[];
    air_temp: number[];
    env_probe_temp: number[];
    ror: number[];
    heater_history: number[];
    fan_history: number[];
    drum_history: number[];
  } | null = null;
  
  // Forecast data storage (4-minute lookahead)
  private forecastData: {
    time: number[];
    bean_temp: number[];
    bean_surface_temp: number[];
    drum_temp: number[];
    air_temp: number[];
    env_probe_temp: number[];
    ror: number[];
  } | null = null;
  
  // Current simulation state vector
  private currentState: Float32Array | null = null;
  
  // Callback for when configuration changes (to trigger chart update)
  private onConfigChange: () => void;
  
  // Scaling factors - MUST match dataset.py
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
  
  constructor(user: User, config: SimulatorLayerConfig, onConfigChange: () => void) {
    this.user = user;
    this.config = config;
    this.onConfigChange = onConfigChange;
  }
  
  /**
   * Render the properties panel UI for this layer
   * @param container - DOM element to render into
   */
  async renderProperties(container: HTMLElement): Promise<void> {
    // Start with placeholder
    container.innerHTML = `
      <div class="property-section">
        <h3>Simulator Layer</h3>
        <div id="simulator-layer-content">
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
    const contentDiv = container.querySelector('#simulator-layer-content') as HTMLElement;
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
          <input type="color" id="sim-color-input" value="${this.config.color || '#3498db'}">
        </div>
      </div>
      
      <!-- Model Selection Tables -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Model Selection</h4>
      
      <div class="property-group">
        <label class="property-label">Roaster Model</label>
        <div id="sim-roaster-table-container" style="max-height: 200px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-top: 8px;">
          <!-- Roaster model table will be inserted here -->
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Bean Model</label>
        <div id="sim-bean-table-container" style="max-height: 200px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-top: 8px;">
          <!-- Bean model table will be inserted here -->
        </div>
      </div>
      
      <!-- Parameters Section -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Roast Parameters</h4>
      
      <div class="property-group">
        <label class="property-label">Bean Mass (g)</label>
        <div class="property-control">
          <input type="range" min="50" max="200" step="5" value="${this.config.beanMassG}" id="sim-mass-slider">
        </div>
        <div class="property-value-display">
          <span id="sim-mass-value">${this.config.beanMassG}g</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Ambient Temperature (°C)</label>
        <div class="property-control">
          <input type="range" min="15" max="35" step="1" value="${this.config.ambientTempC}" id="sim-ambient-slider">
        </div>
        <div class="property-value-display">
          <span id="sim-ambient-value">${this.config.ambientTempC}°C</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Initial Bean Probe Temp (°C)</label>
        <div class="property-control">
          <input type="range" min="100" max="220" step="5" value="${this.config.preheatTempC}" id="sim-preheat-slider">
        </div>
        <div class="property-value-display">
          <span id="sim-preheat-value">${this.config.preheatTempC}°C</span>
        </div>
      </div>
      
      <!-- Simulation Speed Section -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Simulation Speed</h4>
      
      <div class="property-group">
        <label class="property-label">Speed</label>
        <div class="property-control">
          <select id="sim-speed-select" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">
            <option value="1">1x (Real-time)</option>
            <option value="2">2x</option>
            <option value="4">4x</option>
            <option value="8" selected>8x</option>
          </select>
        </div>
      </div>
      
      <!-- Manual Controls Section -->
      <h4 style="margin-top: 20px; margin-bottom: 10px;">Manual Controls</h4>
      
      <div class="property-group">
        <label class="property-label">Heater Power (%)</label>
        <div class="property-control">
          <input type="range" min="0" max="100" step="1" value="50" id="sim-heater-slider" ${!this.isRunning ? 'disabled' : ''}>
        </div>
        <div class="property-value-display">
          <span id="sim-heater-value">50%</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Fan Speed (%)</label>
        <div class="property-control">
          <input type="range" min="0" max="100" step="1" value="50" id="sim-fan-slider" ${!this.isRunning ? 'disabled' : ''}>
        </div>
        <div class="property-value-display">
          <span id="sim-fan-value">50%</span>
        </div>
      </div>
      
      <div class="property-group">
        <label class="property-label">Drum Speed (%)</label>
        <div class="property-control">
          <input type="range" min="0" max="100" step="1" value="50" id="sim-drum-slider" ${!this.isRunning ? 'disabled' : ''}>
        </div>
        <div class="property-value-display">
          <span id="sim-drum-value">50%</span>
        </div>
      </div>
      
      <!-- Action Buttons -->
      <div class="property-group" style="margin-top: 20px;">
        <button id="sim-start-btn" class="btn-primary" style="width: 100%; margin-bottom: 8px;">
          Start Simulation
        </button>
        <button id="sim-stop-btn" class="btn-secondary" style="width: 100%; margin-bottom: 8px;" disabled>
          Stop Simulation
        </button>
        <button id="sim-reset-btn" class="btn-secondary" style="width: 100%;">
          Reset
        </button>
      </div>
      
      <!-- Status display -->
      <div id="sim-status" style="margin-top: 10px; padding: 10px; background: #f0f0f0; border-radius: 4px; font-size: 12px; display: none;">
        <div style="font-weight: bold; margin-bottom: 4px;">Status</div>
        <div id="sim-status-text">Ready</div>
      </div>
      
      <!-- Status message area -->
      <div id="sim-status-message" style="margin-top: 10px; padding: 10px; border-radius: 4px; display: none;"></div>
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
    // Placeholder - will implement
    try {
      const { data, error } = await supabase
        .from('training_jobs')
        .select('*')
        .eq('status', 'completed')
        .order('completed_at', { ascending: false });
      
      if (error) throw error;
      
      const allModels = (data as TrainingJob[]) || [];
      
      // Separate roaster and bean models
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
    // Placeholder - will implement model tables similar to GeneratorLayer
    this.renderRoasterModelTable(roasterModels);
    this.renderBeanModelTable(beanModels);
  }
  
  /**
   * Render roaster model table
   */
  private renderRoasterModelTable(roasterModels: TrainingJob[]): void {
    // Placeholder
    const roasterTableContainer = document.getElementById('sim-roaster-table-container');
    if (!roasterTableContainer) return;
    
    if (roasterModels.length === 0) {
      roasterTableContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No trained roaster models found</div>';
      return;
    }
    
    // Create table
    roasterTableContainer.innerHTML = `
      <table style="width: 100%; font-size: 12px;">
        <thead style="position: sticky; top: 0; background: #f5f5f5;">
          <tr>
            <th style="padding: 8px; text-align: left;">Model Name</th>
            <th style="padding: 8px; text-align: left;">Date</th>
          </tr>
        </thead>
        <tbody id="sim-roaster-table-body">
        </tbody>
      </table>
    `;
    
    const tbody = document.getElementById('sim-roaster-table-body');
    if (!tbody) return;
    
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
  
  /**
   * Render bean model table
   */
  private renderBeanModelTable(beanModels: TrainingJob[]): void {
    // Placeholder
    const beanTableContainer = document.getElementById('sim-bean-table-container');
    if (!beanTableContainer) return;
    
    if (beanModels.length === 0) {
      beanTableContainer.innerHTML = '<div style="padding: 20px; text-align: center; color: #999;">No trained bean models found</div>';
      return;
    }
    
    // Create table
    beanTableContainer.innerHTML = `
      <table style="width: 100%; font-size: 12px;">
        <thead style="position: sticky; top: 0; background: #f5f5f5;">
          <tr>
            <th style="padding: 8px; text-align: left;">Model Name</th>
            <th style="padding: 8px; text-align: left;">Date</th>
          </tr>
        </thead>
        <tbody id="sim-bean-table-body">
        </tbody>
      </table>
    `;
    
    const tbody = document.getElementById('sim-bean-table-body');
    if (!tbody) return;
    
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
  
  /**
   * Select a roaster model
   */
  private async selectRoasterModel(modelId: string): Promise<void> {
    // Placeholder
    this.config.roasterModelId = modelId;
    
    // Update table highlighting
    const rows = document.querySelectorAll('#sim-roaster-table-body tr');
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
  }
  
  /**
   * Select a bean model
   */
  private async selectBeanModel(modelId: string): Promise<void> {
    // Placeholder
    this.config.beanModelId = modelId;
    
    // Update table highlighting
    const rows = document.querySelectorAll('#sim-bean-table-body tr');
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
  }
  
  /**
   * Load ONNX models if not already loaded
   */
  private async loadModelsIfNeeded(): Promise<void> {
    try {
      // Check if models need to be loaded
      if (!this.config.roasterModelId || !this.config.beanModelId) {
        throw new Error('Please select both roaster and bean models');
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
      
      this.showStatus('Models loaded successfully', 'success');
      
    } catch (error) {
      console.error('Failed to load models:', error);
      throw error;
    }
  }
  
  /**
   * Download an ONNX model file from Supabase storage
   */
  private async downloadModelFromStorage(
    userId: string,
    jobId: string,
    filename: string
  ): Promise<Blob> {
    // Placeholder - will implement
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
    // Placeholder - will implement all event listeners
    this.attachColorListener();
    this.attachParameterListeners();
    this.attachControlSliderListeners();
    this.attachActionButtonListeners();
  }
  
  /**
   * Attach color picker listener
   */
  private attachColorListener(): void {
    const colorInput = document.getElementById('sim-color-input') as HTMLInputElement;
    if (colorInput) {
      colorInput.addEventListener('input', (e) => {
        this.config.color = (e.target as HTMLInputElement).value;
        this.onConfigChange();
      });
    }
  }
  
  /**
   * Attach parameter slider listeners
   */
  private attachParameterListeners(): void {
    // Bean mass slider
    const massSlider = document.getElementById('sim-mass-slider') as HTMLInputElement;
    const massValue = document.getElementById('sim-mass-value');
    if (massSlider && massValue) {
      massSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.beanMassG = value;
        massValue.textContent = `${value}g`;
      });
    }
    
    // Ambient temperature slider
    const ambientSlider = document.getElementById('sim-ambient-slider') as HTMLInputElement;
    const ambientValue = document.getElementById('sim-ambient-value');
    if (ambientSlider && ambientValue) {
      ambientSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.ambientTempC = value;
        ambientValue.textContent = `${value}°C`;
      });
    }
    
    // Preheat temperature slider
    const preheatSlider = document.getElementById('sim-preheat-slider') as HTMLInputElement;
    const preheatValue = document.getElementById('sim-preheat-value');
    if (preheatSlider && preheatValue) {
      preheatSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.config.preheatTempC = value;
        preheatValue.textContent = `${value}°C`;
      });
    }
  }
  
  /**
   * Attach control slider listeners (heater, fan, drum)
   */
  private attachControlSliderListeners(): void {
    // Heater control slider
    const heaterSlider = document.getElementById('sim-heater-slider') as HTMLInputElement;
    const heaterValue = document.getElementById('sim-heater-value');
    if (heaterSlider && heaterValue) {
      heaterSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.currentControls.heater = value / 100; // Convert 0-100 to 0-1
        heaterValue.textContent = `${value}%`;
      });
    }
    
    // Fan control slider
    const fanSlider = document.getElementById('sim-fan-slider') as HTMLInputElement;
    const fanValue = document.getElementById('sim-fan-value');
    if (fanSlider && fanValue) {
      fanSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.currentControls.fan = value / 100; // Convert 0-100 to 0-1
        fanValue.textContent = `${value}%`;
      });
    }
    
    // Drum control slider
    const drumSlider = document.getElementById('sim-drum-slider') as HTMLInputElement;
    const drumValue = document.getElementById('sim-drum-value');
    if (drumSlider && drumValue) {
      drumSlider.addEventListener('input', (e) => {
        const value = parseInt((e.target as HTMLInputElement).value);
        this.currentControls.drum = value / 100; // Convert 0-100 to 0-1
        drumValue.textContent = `${value}%`;
      });
    }
  }
  
  /**
   * Attach action button listeners (start, stop, reset)
   */
  private attachActionButtonListeners(): void {
    // Start button
    const startBtn = document.getElementById('sim-start-btn');
    if (startBtn) {
      startBtn.addEventListener('click', () => this.startSimulation());
    }
    
    // Stop button
    const stopBtn = document.getElementById('sim-stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => this.stopSimulation());
    }
    
    // Reset button
    const resetBtn = document.getElementById('sim-reset-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => this.resetSimulation());
    }
    
    // Speed selector
    const speedSelect = document.getElementById('sim-speed-select') as HTMLSelectElement;
    if (speedSelect) {
      speedSelect.addEventListener('change', (e) => {
        this.speedupFactor = parseFloat((e.target as HTMLSelectElement).value);
        console.log(`Simulation speed changed to ${this.speedupFactor}x`);
        
        // Restart interval with new timing if running
        if (this.isRunning && this.simulationTimer) {
          clearInterval(this.simulationTimer);
          const intervalMs = (this.timestep * 1000) / this.speedupFactor;
          this.simulationTimer = window.setInterval(() => this.simulationStep(), intervalMs);
        }
      });
    }
  }
  
  /**
   * Start the simulation
   */
  private async startSimulation(): Promise<void> {
    try {
      // Load models if needed
      await this.loadModelsIfNeeded();
      
      // Initialize simulation state with preheat conditions
      // State vector: [T_r, T_b, T_air, T_bm, T_atm] (all normalized)
      const preheatTemp = this.config.preheatTempC;  // Bean probe temperature
      const roomTemp = this.config.ambientTempC;     // Bean core starts at ambient
      const tempScale = this.scalingFactors.temperatures.bean;
      
      // Initial state (normalized temperatures)
      const roasterTemp = preheatTemp + 50.0;  // Roaster temp ~50°C above probe
      const envTemp = preheatTemp - 40.0;      // Env temp ~40°C below probe
      const airTemp = preheatTemp;             // Air temp starts at probe temp
      
      this.currentState = new Float32Array([
        roasterTemp / tempScale,   // T_r (roaster/drum temperature)
        roomTemp / tempScale,      // T_b (bean core temperature)
        airTemp / tempScale,       // T_air (air temperature)
        preheatTemp / tempScale,   // T_bm (bean measurement/probe temperature)
        envTemp / tempScale        // T_atm (environment probe temperature)
      ]);
      
      // Initialize results storage
      this.simulatedResults = {
        time: [0],
        bean_temp: [preheatTemp],
        bean_surface_temp: [roomTemp],
        drum_temp: [roasterTemp],
        air_temp: [airTemp],
        env_probe_temp: [envTemp],
        ror: [0],
        heater_history: [this.currentControls.heater * 100],
        fan_history: [this.currentControls.fan * 100],
        drum_history: [this.currentControls.drum * 100]
      };
      
      // Initialize forecast storage
      this.forecastData = {
        time: [],
        bean_temp: [],
        bean_surface_temp: [],
        drum_temp: [],
        air_temp: [],
        env_probe_temp: [],
        ror: []
      };
      
      // Set running state
      this.isRunning = true;
      
      // Enable control sliders
      const heaterSlider = document.getElementById('sim-heater-slider') as HTMLInputElement;
      const fanSlider = document.getElementById('sim-fan-slider') as HTMLInputElement;
      const drumSlider = document.getElementById('sim-drum-slider') as HTMLInputElement;
      if (heaterSlider) heaterSlider.disabled = false;
      if (fanSlider) fanSlider.disabled = false;
      if (drumSlider) drumSlider.disabled = false;
      
      // Update button states
      const startBtn = document.getElementById('sim-start-btn') as HTMLButtonElement;
      const stopBtn = document.getElementById('sim-stop-btn') as HTMLButtonElement;
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      
      // Start simulation timer (run step every timestep, adjusted by speedup factor)
      const intervalMs = (this.timestep * 1000) / this.speedupFactor;
      this.simulationTimer = setInterval(() => {
        this.simulationStep();
      }, intervalMs); // Convert seconds to milliseconds and adjust for speed
      
      this.showStatus('Simulation started', 'success');
      
      // Show status display
      const statusDiv = document.getElementById('sim-status');
      if (statusDiv) {
        statusDiv.style.display = 'block';
      }
      
    } catch (error) {
      console.error('Failed to start simulation:', error);
      this.showStatus(`Failed to start: ${(error as Error).message}`, 'error');
    }
  }
  
  /**
   * Stop the simulation
   */
  private stopSimulation(): void {
    // Stop the timer
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
    
    // Set running state
    this.isRunning = false;
    
    // Disable control sliders
    const heaterSlider = document.getElementById('sim-heater-slider') as HTMLInputElement;
    const fanSlider = document.getElementById('sim-fan-slider') as HTMLInputElement;
    const drumSlider = document.getElementById('sim-drum-slider') as HTMLInputElement;
    if (heaterSlider) heaterSlider.disabled = true;
    if (fanSlider) fanSlider.disabled = true;
    if (drumSlider) drumSlider.disabled = true;
    
    // Update button states
    const startBtn = document.getElementById('sim-start-btn') as HTMLButtonElement;
    const stopBtn = document.getElementById('sim-stop-btn') as HTMLButtonElement;
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    
    this.showStatus('Simulation stopped', 'info');
  }
  
  /**
   * Reset the simulation
   */
  private resetSimulation(): void {
    // Stop if running
    this.stopSimulation();
    
    // Clear results
    this.simulatedResults = null;
    this.forecastData = null;
    this.currentState = null;
    
    // Reset control sliders to 50%
    const heaterSlider = document.getElementById('sim-heater-slider') as HTMLInputElement;
    const fanSlider = document.getElementById('sim-fan-slider') as HTMLInputElement;
    const drumSlider = document.getElementById('sim-drum-slider') as HTMLInputElement;
    const heaterValue = document.getElementById('sim-heater-value');
    const fanValue = document.getElementById('sim-fan-value');
    const drumValue = document.getElementById('sim-drum-value');
    
    if (heaterSlider && heaterValue) {
      heaterSlider.value = '50';
      heaterValue.textContent = '50%';
      this.currentControls.heater = 0.5;
    }
    if (fanSlider && fanValue) {
      fanSlider.value = '50';
      fanValue.textContent = '50%';
      this.currentControls.fan = 0.5;
    }
    if (drumSlider && drumValue) {
      drumSlider.value = '50';
      drumValue.textContent = '50%';
      this.currentControls.drum = 0.5;
    }
    
    // Hide status display
    const statusDiv = document.getElementById('sim-status');
    if (statusDiv) {
      statusDiv.style.display = 'none';
    }
    
    // Trigger chart update to clear the plot
    this.onConfigChange();
    
    this.showStatus('Simulation reset', 'info');
  }
  
  /**
   * Run a single simulation step
   * This method is called repeatedly by the simulation timer
   */
  private async simulationStep(): Promise<void> {
    if (!this.isRunning || !this.currentState || !this.simulatedResults) {
      return;
    }
    
    try {
      // Get current time (last time in results)
      const currentTime = this.simulatedResults.time[this.simulatedResults.time.length - 1];
      
      // Get bean thermal capacity from bean model
      // Input: bean_temperature (normalized bean core temp, T_b)
      const beanModelResult = await this.beanSession.run({
        bean_temperature: new ort.Tensor('float32', [this.currentState[1]], [1, 1])
      });
      const beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
      
      // Prepare control inputs for roast stepper
      // [heater, fan, drum, T_amb, humidity, mass, C_b]
      const stepperControls = new Float32Array(7);
      stepperControls[0] = this.currentControls.heater;  // Heater power (0-1)
      stepperControls[1] = this.currentControls.fan;     // Fan speed (0-1)
      stepperControls[2] = this.currentControls.drum;    // Drum speed (0-1)
      stepperControls[3] = this.config.ambientTempC / this.scalingFactors.controls.ambient;
      stepperControls[4] = this.fixedParams.humidity;
      stepperControls[5] = this.config.beanMassG / this.scalingFactors.mass;
      stepperControls[6] = beanCapacity;
      
      // Normalized timestep
      const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
      
      // Run roast stepper to get next state
      // Inputs: current_state [1,5], current_controls [1,7], dt [1,1]
      // Output: next_state [1,5]
      const stepperResult = await this.roasterSession.run({
        current_state: new ort.Tensor('float32', this.currentState, [1, 5]),
        current_controls: new ort.Tensor('float32', stepperControls, [1, 7]),
        dt: new ort.Tensor('float32', dt, [1, 1])
      });
      
      // Update current state
      this.currentState = new Float32Array(stepperResult.next_state.data as any as number[]);
      
      // Denormalize temperatures for storage and display
      const tempScale = this.scalingFactors.temperatures.bean;
      const newTime = currentTime + this.timestep;
      const beanTemp = this.currentState[3] * tempScale;        // T_bm (bean probe)
      const beanSurfaceTemp = this.currentState[1] * tempScale; // T_b (bean core)
      const drumTemp = this.currentState[0] * tempScale;        // T_r (roaster/drum)
      const airTemp = this.currentState[2] * tempScale;         // T_air
      const envProbeTemp = this.currentState[4] * tempScale;    // T_atm (env probe)
      
      // Calculate RoR (°C/min)
      const prevBeanTemp = this.simulatedResults.bean_temp[this.simulatedResults.bean_temp.length - 1];
      const ror = Math.max(0, ((beanTemp - prevBeanTemp) / this.timestep) * 60);
      
      // Store results
      this.simulatedResults.time.push(newTime);
      this.simulatedResults.bean_temp.push(beanTemp);
      this.simulatedResults.bean_surface_temp.push(beanSurfaceTemp);
      this.simulatedResults.drum_temp.push(drumTemp);
      this.simulatedResults.air_temp.push(airTemp);
      this.simulatedResults.env_probe_temp.push(envProbeTemp);
      this.simulatedResults.ror.push(ror);
      this.simulatedResults.heater_history.push(this.currentControls.heater * 100);
      this.simulatedResults.fan_history.push(this.currentControls.fan * 100);
      this.simulatedResults.drum_history.push(this.currentControls.drum * 100);
      
      // Compute 4-minute forecast from current state
      const forecast = await this.compute4MinuteForecast();
      this.forecastData = {
        time: forecast.time,
        bean_temp: forecast.bean,
        bean_surface_temp: forecast.environment,
        drum_temp: forecast.roaster,
        air_temp: forecast.air,
        env_probe_temp: forecast.airMeasured,
        ror: forecast.rateOfRise
      };
      
      // Update status display
      const statusText = document.getElementById('sim-status-text');
      if (statusText) {
        const minutes = Math.floor(newTime / 60);
        const seconds = Math.floor(newTime % 60);
        statusText.innerHTML = `
          Time: ${minutes}:${seconds.toString().padStart(2, '0')}<br>
          Bean Temp: ${beanTemp.toFixed(1)}°C<br>
          RoR: ${ror.toFixed(1)}°C/min
        `;
      }
      
      // Trigger chart update
      this.onConfigChange();
      
    } catch (error) {
      console.error('Simulation step failed:', error);
      this.stopSimulation();
      this.showStatus(`Simulation error: ${(error as Error).message}`, 'error');
    }
  }
  
  /**
   * Compute 4-minute (240-second) forecast from current state
   * Predicts future temperatures and RoR over the next 4 minutes using current control inputs
   * 
   * @returns forecast - Object containing time, temperature, and RoR arrays for all state variables
   */
  private async compute4MinuteForecast(): Promise<{
    time: number[];
    bean: number[];
    environment: number[];
    roaster: number[];
    air: number[];
    airMeasured: number[];
    rateOfRise: number[];
  }> {
    // Safety check: ensure we have a current state
    if (!this.currentState) {
      return {
        time: [],
        bean: [],
        environment: [],
        roaster: [],
        air: [],
        airMeasured: [],
        rateOfRise: []
      };
    }
    
    const forecastHorizon = 240; // seconds into the future (4 minutes)
    const forecastSteps = Math.ceil(forecastHorizon / this.timestep);
    
    // Arrays to store forecast trajectory
    const forecastTime: number[] = [];
    const forecastBeanTemp: number[] = [];
    const forecastEnvironmentTemp: number[] = [];
    const forecastRoasterTemp: number[] = [];
    const forecastAirTemp: number[] = [];
    const forecastAirMeasuredTemp: number[] = [];
    
    // Create a copy of current state for forecasting
    let forecastState = new Float32Array(this.currentState);
    
    // Get bean thermal capacity at current state
    let beanCapacity = 0.5;
    if (this.beanSession) {
      const beanModelResult = await this.beanSession.run({
        bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
      });
      beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
    }
    
    // Prepare control inputs (fixed at current values for the entire forecast)
    const forecastControls = new Float32Array(7);
    forecastControls[0] = this.currentControls.heater;
    forecastControls[1] = this.currentControls.fan;
    forecastControls[2] = this.currentControls.drum;
    forecastControls[3] = this.config.ambientTempC / this.scalingFactors.controls.ambient;
    forecastControls[4] = this.fixedParams.humidity / this.scalingFactors.controls.humidity;
    forecastControls[5] = this.config.beanMassG / this.scalingFactors.mass;
    
    const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
    
    // Get current simulation time (in seconds)
    const currentTime = this.simulatedResults ? this.simulatedResults.time[this.simulatedResults.time.length - 1] : 0;
    
    // Run forecast loop
    for (let step = 0; step < forecastSteps; step++) {
      // Update bean capacity based on current forecast state
      if (this.beanSession) {
        const beanModelResult = await this.beanSession.run({
          bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
        });
        beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
        forecastControls[6] = beanCapacity;
      } else {
        forecastControls[6] = beanCapacity;
      }
      
      // Predict next state using roast stepper
      if (!this.roasterSession) {
        throw new Error('Roast stepper model not loaded');
      }
      
      const stepperResult = await this.roasterSession.run({
        current_state: new ort.Tensor('float32', forecastState, [1, 5]),
        current_controls: new ort.Tensor('float32', forecastControls, [1, 7]),
        dt: new ort.Tensor('float32', dt, [1, 1])
      });
      
      // Update forecast state
      forecastState = new Float32Array(stepperResult.next_state.data as any as number[]);
      
      // Store forecast data point (time in seconds)
      const forecastTimePoint = currentTime + (step + 1) * this.timestep;
      forecastTime.push(forecastTimePoint);
      
      // Extract and denormalize state variables
      // State vector: [T_r, T_b, T_air, T_bm, T_atm]
      const tempScale = this.scalingFactors.temperatures.bean;
      forecastRoasterTemp.push(forecastState[0] * tempScale);
      forecastEnvironmentTemp.push(forecastState[1] * tempScale);
      forecastAirTemp.push(forecastState[2] * tempScale);
      forecastBeanTemp.push(forecastState[3] * tempScale);
      forecastAirMeasuredTemp.push(forecastState[4] * tempScale);
    }
    
    // Calculate rate of rise for the forecast
    // Rate of rise (°C/min) is the change in temperature divided by the change in time
    const forecastRateOfRise: number[] = [];
    for (let i = 0; i < forecastBeanTemp.length; i++) {
      if (i === 0) {
        // For the first forecast point, calculate RoR from current actual temperature to first forecast
        const currentBeanTemp = this.simulatedResults ? 
          this.simulatedResults.bean_temp[this.simulatedResults.bean_temp.length - 1] : 0;
        const timeDiff = (forecastTime[0] - currentTime) / 60; // Convert to minutes
        const tempDiff = forecastBeanTemp[0] - currentBeanTemp; // °C
        const rateOfRise = timeDiff > 0 ? tempDiff / timeDiff : 0;
        forecastRateOfRise.push(Math.max(0, rateOfRise));
      } else {
        // For subsequent points, calculate RoR between consecutive forecast points
        const timeDiff = (forecastTime[i] - forecastTime[i - 1]) / 60; // Convert to minutes
        const tempDiff = forecastBeanTemp[i] - forecastBeanTemp[i - 1]; // °C
        const rateOfRise = timeDiff > 0 ? tempDiff / timeDiff : 0;
        forecastRateOfRise.push(Math.max(0, rateOfRise));
      }
    }
    
    return {
      time: forecastTime,
      bean: forecastBeanTemp,
      environment: forecastEnvironmentTemp,
      roaster: forecastRoasterTemp,
      air: forecastAirTemp,
      airMeasured: forecastAirMeasuredTemp,
      rateOfRise: forecastRateOfRise
    };
  }
  
  /**
   * Get data series for this layer
   * @returns Array of data series to plot
   * 
   * Plots all traces on the same y-axis (0-350°C range):
   * - Bean temperature (BT)
   * - Drum temperature
   * - Air temperature
   * - Environment probe temperature
   * - RoR (on right y-axis, 0-50°C/min)
   * - Control traces (heater, fan, drum) scaled to 0-100 range
   * - 4-minute lookahead curves (dashed lines with reduced opacity)
   */
  async getDataSeries(): Promise<DataSeries[]> {
    const series: DataSeries[] = [];
    
    // If no simulation results, return empty
    if (!this.simulatedResults) {
      return series;
    }
    
    // Base color for this layer
    const baseColor = this.config.color || '#3498db';
    
    // Bean temperature (primary trace)
    series.push({
      label: 'BT (Sim)',
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
    
    // Rate of Rise (on right axis)
    series.push({
      label: 'RoR (Sim)',
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
        fillOpacity: 0
      },
      yAxisID: 'y2'
    });
    
    // Drum temperature
    series.push({
      label: 'Drum (Sim)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.drum_temp[i] 
      })),
      style: {
        color: '#e67e22',
        lineWidth: 1.5,
        showPoints: false,
        pointRadius: 0,
        lineDash: [5, 5], // Dashed
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Air temperature
    series.push({
      label: 'Air (Sim)',
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
      label: 'Env Probe (Sim)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.env_probe_temp[i] 
      })),
      style: {
        color: '#95a5a6',
        lineWidth: 1.5,
        showPoints: false,
        pointRadius: 0,
        lineDash: [3, 3],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Control traces (scaled to 0-100 range to match temperature axis)
    // Heater control
    series.push({
      label: 'Heater (Sim)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.heater_history[i]
      })),
      style: {
        color: '#e74c3c',
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Fan control
    series.push({
      label: 'Fan (Sim)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.fan_history[i]
      })),
      style: {
        color: '#3498db',
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Drum control
    series.push({
      label: 'Drum Speed (Sim)',
      data: this.simulatedResults.time.map((t, i) => ({ 
        x: t, 
        y: this.simulatedResults!.drum_history[i]
      })),
      style: {
        color: '#f39c12',
        lineWidth: 2,
        showPoints: false,
        pointRadius: 0,
        lineDash: [],
        fill: false,
        fillOpacity: 0
      },
      yAxisID: 'y'
    });
    
    // Add 4-minute lookahead forecast traces (if available)
    if (this.forecastData && this.forecastData.time.length > 0) {
      // Bean temperature forecast
      series.push({
        label: 'BT Forecast (Sim)',
        data: this.forecastData.time.map((t, i) => ({ 
          x: t, 
          y: this.forecastData!.bean_temp[i] 
        })),
        style: {
          color: baseColor,
          lineWidth: 2,
          showPoints: false,
          pointRadius: 0,
          lineDash: [5, 5], // Dashed
          fill: false,
          fillOpacity: 0
        },
        yAxisID: 'y'
      });
      
      // Bean surface forecast
      series.push({
        label: 'Surface Forecast (Sim)',
        data: this.forecastData.time.map((t, i) => ({ 
          x: t, 
          y: this.forecastData!.bean_surface_temp[i] 
        })),
        style: {
          color: '#e67e22',
          lineWidth: 1.5,
          showPoints: false,
          pointRadius: 0,
          lineDash: [5, 5], // Dashed
          fill: false,
          fillOpacity: 0
        },
        yAxisID: 'y'
      });
      
      // Drum temperature forecast
      series.push({
        label: 'Drum Forecast (Sim)',
        data: this.forecastData.time.map((t, i) => ({ 
          x: t, 
          y: this.forecastData!.drum_temp[i] 
        })),
        style: {
          color: '#e67e22',
          lineWidth: 1.5,
          showPoints: false,
          pointRadius: 0,
          lineDash: [5, 5], // Dashed
          fill: false,
          fillOpacity: 0
        },
        yAxisID: 'y'
      });
      
      // Air temperature forecast
      series.push({
        label: 'Air Forecast (Sim)',
        data: this.forecastData.time.map((t, i) => ({ 
          x: t, 
          y: this.forecastData!.air_temp[i] 
        })),
        style: {
          color: '#9b59b6',
          lineWidth: 1.5,
          showPoints: false,
          pointRadius: 0,
          lineDash: [5, 5], // Dashed
          fill: false,
          fillOpacity: 0
        },
        yAxisID: 'y'
      });
      
      // Rate of Rise forecast
      series.push({
        label: 'RoR Forecast (Sim)',
        data: this.forecastData.time.map((t, i) => ({ 
          x: t, 
          y: this.forecastData!.ror[i] 
        })),
        style: {
          color: baseColor,
          lineWidth: 1.5,
          showPoints: false,
          pointRadius: 0,
          lineDash: [5, 5], // Dashed
          fill: false,
          fillOpacity: 0
        },
        yAxisID: 'y2'
      });
    }
    
    return series;
  }
  
  /**
   * Show a status message
   */
  private showStatus(message: string, type: 'success' | 'error' | 'info'): void {
    const statusDiv = document.getElementById('sim-status-message');
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
   * Cleanup when layer is removed
   */
  destroy(): void {
    if (this.simulationTimer) {
      clearInterval(this.simulationTimer);
      this.simulationTimer = null;
    }
  }
}
