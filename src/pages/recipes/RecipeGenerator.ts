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

// Declare Chart.js and Plotly globals from CDN
declare const Chart: any;
declare const Plotly: any;
declare const ort: any;

// Chart.js instance for the combined control editor (shows both heater and fan)
let controlChart: any = null;

// Track which control input is currently being edited
let activeControl: 'heater' | 'fan' = 'heater';

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
  private readonly durationInput: HTMLInputElement;
  
  // Action buttons
  private readonly simulateBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  
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
    this.durationInput = document.getElementById('generator-duration') as HTMLInputElement;
    
    this.simulateBtn = document.getElementById('generator-simulate-btn') as HTMLButtonElement;
    this.saveBtn = document.getElementById('generator-save-btn') as HTMLButtonElement;
    this.resetBtn = document.getElementById('generator-reset-btn') as HTMLButtonElement;
    
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
    });
    
    this.ambientSlider.addEventListener('input', (e) => {
      this.ambientTempC = parseFloat((e.target as HTMLInputElement).value);
      this.ambientValue.textContent = `${this.ambientTempC}°C`;
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
   * Load selected ONNX models
   * For now, loads the static models from the public directory
   * TODO: In future, download user's trained models from Supabase storage
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
      
      console.log('Loading ONNX models from public directory...');
      
      // Configure ONNX Runtime
      if (typeof ort !== 'undefined') {
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
      }
      
      // Get base URL from Vite
      const baseUrl = import.meta.env.BASE_URL;
      
      // Load roaster system models (roast_stepper)
      // Note: state_estimator is not used in recipe generation
      console.log('Loading roast stepper...');
      this.roasterSession = await ort.InferenceSession.create(`${baseUrl}onnx_models/roast_stepper.onnx`);
      console.log('✓ Roast stepper loaded');
      
      // Load bean model (default to bean_guji.onnx for now)
      // TODO: Map selectedBeanModelId to actual bean model files
      console.log('Loading bean model...');
      this.beanSession = await ort.InferenceSession.create(`${baseUrl}onnx_models/bean_guji.onnx`);
      console.log('✓ Bean model loaded');
      
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
      
    } catch (error) {
      console.error('Failed to load models:', error);
      this.showError(`Failed to load models: ${(error as Error).message}`);
      this.loadBtn.disabled = false;
      this.loadBtn.textContent = 'Load Models & Start';
      this.loadingDiv.style.display = 'none';
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
    
    // Prepare datasets - both heater and fan will be shown
    const heaterData = this.controlProfile.heater.map(p => ({ x: p.time, y: p.value * 100 }));
    const fanData = this.controlProfile.fan.map(p => ({ x: p.time, y: p.value * 100 }));
    
    // Create the combined control chart with both datasets
    // Dataset 0: Heater (editable when activeControl === 'heater')
    // Dataset 1: Fan (editable when activeControl === 'fan')
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
            // Callback when dragging a point
            onDrag: (_e: any, datasetIndex: number, index: number, value: any) => {
              // Only allow dragging control datasets (0 and 1), not temperature datasets (2+)
              if (datasetIndex >= 2) {
                return false; // Temperature datasets are not draggable
              }
              
              // Only allow dragging the active control
              const controlName = datasetIndex === 0 ? 'heater' : 'fan';
              if (controlName !== activeControl) {
                return false; // Prevent dragging inactive control
              }
              
              const points = this.controlProfile[controlName];
              
              // Constrain time to valid range (don't allow reordering points)
              const prevTime = index > 0 ? points[index - 1].time : 0;
              const nextTime = index < points.length - 1 ? points[index + 1].time : this.durationSeconds;
              
              // Constrain and update the point
              points[index].time = Math.max(prevTime + 1, Math.min(nextTime - 1, value.x));
              points[index].value = Math.max(0, Math.min(1, value.y / 100));
              
              // Return constrained values to update the chart
              return {
                x: points[index].time,
                y: points[index].value * 100
              };
            },
            onDragEnd: (_e: any, datasetIndex: number, index: number, value: any) => {
              console.log('Drag complete:', { datasetIndex, index, value });
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
              const controlName = datasetIndex === 0 ? 'heater' : 'fan';
              
              // Only allow removing points from the active control
              if (controlName === activeControl) {
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
   * Set up control selector buttons to switch between heater and fan editing
   */
  private setupControlSelector(): void {
    const buttons = document.querySelectorAll('.control-selector-btn');
    
    buttons.forEach(button => {
      button.addEventListener('click', (e) => {
        const btn = e.target as HTMLButtonElement;
        const control = btn.getAttribute('data-control') as 'heater' | 'fan';
        
        if (!control) return;
        
        // Update active control
        activeControl = control;
        
        // Update button states
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        console.log(`Switched to editing ${control} control`);
      });
    });
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
   * @param controlInput - Which control input ('heater' or 'fan')
   * @param pointIndex - Index of the point in the control array
   */
  private removeControlPoint(controlInput: 'heater' | 'fan', pointIndex: number): void {
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
   * Updates both heater and fan datasets in the combined chart
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
      
      controlChart.update();
    }
  }
  
  /**
   * Update duration and adjust control points accordingly
   * @param newDuration - New roast duration in seconds
   */
  private updateDuration(newDuration: number): void {
    const oldDuration = this.durationSeconds;
    this.durationSeconds = newDuration;
    
    // Scale all control points proportionally
    ['heater', 'fan', 'drum'].forEach(input => {
      const points = this.controlProfile[input as keyof ControlProfile];
      points.forEach(point => {
        point.time = (point.time / oldDuration) * newDuration;
      });
    });
    
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
      const preheatTemp = 180.0; // °C
      const roomTemp = 25.0; // °C
      const roasterTemp = preheatTemp + 50.0; // 230°C
      const airTemp = preheatTemp - 40.0; // 140°C
      const measuredAirTemp = preheatTemp; // 180°C
      
      // Normalize using scaling factors
      const tempScale = this.scalingFactors.temperatures.bean;
      let currentState = new Float32Array([
        roasterTemp / tempScale,     // T_r (roaster temperature)
        roomTemp / tempScale,        // T_b (bean core temperature - starts at room temp)
        airTemp / tempScale,         // T_air (air temperature)
        preheatTemp / tempScale,     // T_bm (bean measurement temperature)
        measuredAirTemp / tempScale  // T_atm (measured air temperature)
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
        stepperControls[2] = this.fixedParams.drum;  // Drum speed (fixed at 0.6)
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
   * Interpolate control points to create a smooth spline curve
   * Uses simple linear interpolation between points
   * @param points - Array of control points
   * @returns Array of interpolated points for smooth visualization
   */
  private interpolateSpline(points: ControlPoint[]): ControlPoint[] {
    // Sort points by time
    const sortedPoints = [...points].sort((a, b) => a.time - b.time);
    
    const interpolated: ControlPoint[] = [];
    const step = 1; // 1 second intervals
    
    for (let i = 0; i < sortedPoints.length - 1; i++) {
      const p1 = sortedPoints[i];
      const p2 = sortedPoints[i + 1];
      
      // Linear interpolation between p1 and p2
      for (let t = p1.time; t < p2.time; t += step) {
        const fraction = (t - p1.time) / (p2.time - p1.time);
        const value = p1.value + fraction * (p2.value - p1.value);
        interpolated.push({ time: t, value });
      }
    }
    
    // Add the last point
    interpolated.push(sortedPoints[sortedPoints.length - 1]);
    
    return interpolated;
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
    
    // Get current control datasets (heater and fan are datasets 0 and 1)
    // Ensure datasets exist before accessing them
    if (!controlChart.data.datasets || controlChart.data.datasets.length < 2) return;
    const heaterDataset = controlChart.data.datasets[0];
    const fanDataset = controlChart.data.datasets[1];
    
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
      }
    ];
    
    // Update the chart datasets - keep controls (0-1) and add temperatures (2-5)
    controlChart.data.datasets = [heaterDataset, fanDataset, ...tempDatasets];
    
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
      } else if (datasetIndex < 2) {
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
      const recipeData = {
        user_id: user.id,
        name: this.recipeName,
        duration_seconds: this.durationSeconds,
        bean_mass_g: this.beanMassG,
        ambient_temp_c: this.ambientTempC,
        roaster_model_id: this.selectedRoasterModelId,
        bean_model_id: this.selectedBeanModelId,
        control_profile: {
          time: this.interpolateSpline(this.controlProfile.heater).map(p => p.time),
          heater: this.interpolateSpline(this.controlProfile.heater).map(p => p.value),
          fan: this.interpolateSpline(this.controlProfile.fan).map(p => p.value),
          drum: this.interpolateSpline(this.controlProfile.drum).map(p => p.value)
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
    
    // Clear temperature datasets from the combined chart (keep only control datasets 0 and 1)
    if (controlChart && controlChart.data.datasets.length > 2) {
      controlChart.data.datasets = controlChart.data.datasets.slice(0, 2);
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
