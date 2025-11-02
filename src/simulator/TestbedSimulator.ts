/**
 * Simplified Testbed Simulator
 * 
 * A lightweight digital twin simulator designed specifically for the dashboard testbed.
 * This simulator provides manual control only and focuses on real-time visualization
 * of trained roaster and bean models.
 * 
 * Key differences from RoasterSimulator:
 * - Manual control only (no PID or neural control)
 * - Simpler initialization and UI management
 * - No game mode, profile editor, or advanced features
 * - Designed to work seamlessly within the dashboard layout
 */

import type {
  RoastPhase,
  ControlInputs,
  FixedParameters,
  ScalingFactors
} from './types';

/**
 * Plotly - external charting library
 */
declare const Plotly: any;

/**
 * ONNX Session collection for the testbed models
 */
interface ONNXSessions {
  stateEstimator: ort.InferenceSession | null;
  roastStepper: ort.InferenceSession | null;
  beanModel: ort.InferenceSession | null;
}

/**
 * Temperature data storage structure
 */
interface TemperatureData {
  bean: number[];
  environment: number[];
  roaster: number[];
  air: number[];
  airMeasured: number[];
}

/**
 * Control data storage structure
 */
interface ControlData {
  heater: number[];
  fan: number[];
  drum: number[];
}

/**
 * Roast phase constants
 */
const PHASES = {
  IDLE: 'idle' as const,
  CHARGING: 'charging' as const,
  ROASTING: 'roasting' as const,
  DROPPED: 'dropped' as const
};

/**
 * Testbed Simulator Class
 * 
 * Simplified simulator for the dashboard testbed that focuses on:
 * - Manual control mode only
 * - Real-time physics simulation using ONNX models
 * - Basic visualization with Plotly charts
 */
export class TestbedSimulator {
  // ONNX Runtime sessions for each model component
  private sessions: ONNXSessions;
  
  // Simulation state
  private isRunning: boolean = false;
  private simulationInterval: number | null = null;
  private readonly timestep: number = 1.5; // Fixed timestep in seconds
  private speedupFactor: number = 8; // Default to 8x speed
  
  // Roasting phases
  private readonly phases = PHASES;
  private currentPhase: RoastPhase = this.phases.IDLE;
  
  // Preheat temperature (°C)
  private readonly preheatTemp: number = 180.0;
  
  // Simulation data storage
  private timeData: number[] = [];
  private temperatureData: TemperatureData;
  private controlData: ControlData;
  private rateOfRiseData: number[] = [];
  
  // Forecast data storage (4-minute predictions from current timestep)
  private forecastData: {
    time: number[];
    bean: number[];
    environment: number[];
    roaster: number[];
    air: number[];
  };
  
  // Scaling factors (from dataset.py)
  private readonly scalingFactors: ScalingFactors;
  
  // Current system state [T_r, T_b, T_air, T_bm, T_atm] (normalized)
  private currentState: Float32Array;
  
  // Fixed parameters
  private fixedParams: FixedParameters;
  
  // Control inputs (user adjustable)
  private controls: ControlInputs;
  
  // Simulation time tracking
  private simulationTime: number = 0; // seconds
  
  // Element ID prefix for testbed elements
  private readonly idPrefix: string = 'testbed-';
  
  constructor() {
    // Initialize ONNX sessions
    this.sessions = {
      stateEstimator: null,
      roastStepper: null,
      beanModel: null
    };
    
    // Initialize temperature data storage
    this.temperatureData = {
      bean: [],
      environment: [],
      roaster: [],
      air: [],
      airMeasured: []
    };
    
    // Initialize control data storage
    this.controlData = {
      heater: [],
      fan: [],
      drum: []
    };
    
    // Initialize forecast data storage
    this.forecastData = {
      time: [],
      bean: [],
      environment: [],
      roaster: [],
      air: []
    };
    
    // Initialize scaling factors
    this.scalingFactors = {
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
    
    // Initialize state with preheat conditions
    this.currentState = this.initializePreheatState();
    
    // Initialize fixed parameters
    this.fixedParams = {
      drum: 0.6,
      ambient: 24.0,
      humidity: 0.5
    };
    
    // Initialize control inputs
    this.controls = {
      heater: 0.5,
      fan: 0.5,
      mass: 150.0
    };
    
    this.initializeUI();
  }
  
  /**
   * Get element by ID with testbed prefix
   */
  private getElement<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(this.idPrefix + id) as T | null;
  }
  
  /**
   * Initialize UI event listeners
   */
  private initializeUI(): void {
    // Control sliders
    const heaterSlider = this.getElement<HTMLInputElement>('heater-slider');
    const fanSlider = this.getElement<HTMLInputElement>('fan-slider');
    const massSlider = this.getElement<HTMLInputElement>('mass-slider');
    const ambientSlider = this.getElement<HTMLInputElement>('ambient-slider');
    const speedupSelect = this.getElement<HTMLSelectElement>('speedup-select');
    
    const heaterValue = this.getElement('heater-value');
    const fanValue = this.getElement('fan-value');
    const massValue = this.getElement('mass-value');
    const ambientValue = this.getElement('ambient-value');
    
    // Update control values
    if (heaterSlider && heaterValue) {
      heaterSlider.addEventListener('input', (e) => {
        this.controls.heater = parseFloat((e.target as HTMLInputElement).value);
        heaterValue.textContent = Math.round(this.controls.heater * 100) + '%';
      });
    }
    
    if (fanSlider && fanValue) {
      fanSlider.addEventListener('input', (e) => {
        this.controls.fan = parseFloat((e.target as HTMLInputElement).value);
        fanValue.textContent = Math.round(this.controls.fan * 100) + '%';
      });
    }
    
    if (massSlider && massValue) {
      massSlider.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        if (!target.disabled) {
          this.controls.mass = parseFloat(target.value);
          massValue.textContent = this.controls.mass + 'g';
        }
      });
    }
    
    if (ambientSlider && ambientValue) {
      ambientSlider.addEventListener('input', (e) => {
        this.fixedParams.ambient = parseFloat((e.target as HTMLInputElement).value);
        ambientValue.textContent = this.fixedParams.ambient + '°C';
      });
    }
    
    // Speedup control
    if (speedupSelect) {
      speedupSelect.addEventListener('change', (e) => {
        this.speedupFactor = parseFloat((e.target as HTMLSelectElement).value);
        console.log(`Simulation speed changed to ${this.speedupFactor}x`);
        
        // Restart interval with new timing if running
        if (this.isRunning && this.simulationInterval) {
          clearInterval(this.simulationInterval);
          const intervalMs = (this.timestep * 1000) / this.speedupFactor;
          this.simulationInterval = window.setInterval(() => this.simulationStep(), intervalMs);
        }
      });
    }
    
    // Action buttons
    const chargeBtn = this.getElement<HTMLButtonElement>('charge-btn');
    const dropBtn = this.getElement<HTMLButtonElement>('drop-btn');
    const resetBtn = this.getElement<HTMLButtonElement>('reset-btn');
    
    if (chargeBtn) chargeBtn.addEventListener('click', () => this.chargeBeans());
    if (dropBtn) dropBtn.addEventListener('click', () => this.dropBeans());
    if (resetBtn) resetBtn.addEventListener('click', () => this.reset());
    
    // Initialize charts
    this.initializeCharts();
  }
  
  /**
   * Load ONNX models
   */
  async loadModels(): Promise<void> {
    try {
      console.log('Loading testbed ONNX models...');
      
      const baseUrl = import.meta.env.BASE_URL;
      
      // Load model components
      this.sessions.stateEstimator = await ort.InferenceSession.create(`${baseUrl}onnx_models/state_estimator.onnx`);
      this.sessions.roastStepper = await ort.InferenceSession.create(`${baseUrl}onnx_models/roast_stepper.onnx`);
      this.sessions.beanModel = await ort.InferenceSession.create(`${baseUrl}onnx_models/bean_guji.onnx`);
      
      console.log('✅ Testbed ONNX models loaded successfully');
      
      // Hide loading and show interface
      const loadingEl = this.getElement('loading');
      const phaseEl = this.getElement('phase');
      if (loadingEl) loadingEl.style.display = 'none';
      if (phaseEl) phaseEl.style.display = 'block';
      
      this.updatePhaseDisplay();
      
    } catch (error) {
      console.error('Error loading testbed ONNX models:', error);
      this.showError('Failed to load ONNX models: ' + (error as Error).message);
    }
  }
  
  /**
   * Show error message
   */
  private showError(message: string): void {
    const errorDiv = this.getElement('error');
    const loadingDiv = this.getElement('loading');
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.style.display = 'block';
    }
    if (loadingDiv) {
      loadingDiv.style.display = 'none';
    }
  }
  
  /**
   * Initialize state with preheat conditions
   */
  private initializePreheatState(): Float32Array {
    const roomTemp = 25.0;
    const preheatTemp = this.preheatTemp;
    const roasterTemp = preheatTemp + 50.0;
    const airTemp = preheatTemp - 40.0;
    const measuredAirTemp = preheatTemp;
    
    const tempScale = this.scalingFactors.temperatures.bean;
    
    // State vector: [T_r, T_b, T_air, T_bm, T_atm]
    return new Float32Array([
      roasterTemp / tempScale,
      roomTemp / tempScale,
      airTemp / tempScale,
      preheatTemp / tempScale,
      measuredAirTemp / tempScale
    ]);
  }
  
  /**
   * Initialize Plotly charts
   */
  private initializeCharts(): void {
    // Temperature chart
    const tempLayout = {
      title: 'Temperature Profile',
      xaxis: { 
        title: 'Time (minutes)',
        gridcolor: '#e0e0e0'
      },
      yaxis: { 
        title: 'Temperature (°C)',
        gridcolor: '#e0e0e0'
      },
      showlegend: true,
      margin: { t: 50, r: 80, b: 50, l: 60 },
      autosize: true
    };
    
    const tempData = [
      {
        x: [],
        y: [],
        name: 'Bean Probe',
        line: { color: '#8B4513', width: 3 }
      },
      {
        x: [],
        y: [],
        name: 'Bean Surface',
        line: { color: '#FF6B35', width: 2 }
      },
      {
        x: [],
        y: [],
        name: 'Drum',
        line: { color: '#4ECDC4', width: 2 }
      },
      {
        x: [],
        y: [],
        name: 'Env. Probe',
        line: { color: '#45B7D1', width: 2 }
      },
      {
        x: [],
        y: [],
        name: 'Bean Forecast',
        line: { color: '#8B4513', width: 2, dash: 'dash' },
        opacity: 0.6,
        showlegend: false
      },
      {
        x: [],
        y: [],
        name: 'Surface Forecast',
        line: { color: '#FF6B35', width: 1.5, dash: 'dash' },
        opacity: 0.5,
        showlegend: false
      },
      {
        x: [],
        y: [],
        name: 'Drum Forecast',
        line: { color: '#4ECDC4', width: 1.5, dash: 'dash' },
        opacity: 0.5,
        showlegend: false
      },
      {
        x: [],
        y: [],
        name: 'Air Forecast',
        line: { color: '#45B7D1', width: 1.5, dash: 'dash' },
        opacity: 0.5,
        showlegend: false
      }
    ];
    
    const config = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false
    };
    
    const tempChartDiv = this.getElement('temperature-chart');
    if (tempChartDiv) {
      tempChartDiv.style.visibility = 'hidden';
      Plotly.newPlot(this.idPrefix + 'temperature-chart', tempData, tempLayout, config);
      requestAnimationFrame(() => {
        Plotly.Plots.resize(this.idPrefix + 'temperature-chart');
        tempChartDiv.style.visibility = 'visible';
      });
    }
    
    // Control chart
    const controlLayout = {
      title: 'Control Inputs',
      xaxis: { 
        title: 'Time (minutes)',
        gridcolor: '#e0e0e0'
      },
      yaxis: { 
        title: 'Control Value (0-1)', 
        range: [0, 1],
        gridcolor: '#e0e0e0'
      },
      showlegend: true,
      margin: { t: 50, r: 80, b: 50, l: 60 },
      autosize: true
    };
    
    const controlData = [
      {
        x: [],
        y: [],
        name: 'Heat',
        line: { color: '#FF4444', width: 2 }
      },
      {
        x: [],
        y: [],
        name: 'Fan',
        line: { color: '#4444FF', width: 2 }
      },
      {
        x: [],
        y: [],
        name: 'Drum (fixed)',
        line: { color: '#888888', width: 2, dash: 'dash' }
      }
    ];
    
    const controlChartDiv = this.getElement('control-chart');
    if (controlChartDiv) {
      controlChartDiv.style.visibility = 'hidden';
      Plotly.newPlot(this.idPrefix + 'control-chart', controlData, controlLayout, config);
      requestAnimationFrame(() => {
        Plotly.Plots.resize(this.idPrefix + 'control-chart');
        controlChartDiv.style.visibility = 'visible';
      });
    }
  }
  
  /**
   * Update phase display
   */
  private updatePhaseDisplay(): void {
    const phaseDiv = this.getElement('phase');
    const chargeBtn = this.getElement<HTMLButtonElement>('charge-btn');
    const dropBtn = this.getElement<HTMLButtonElement>('drop-btn');
    const massSlider = this.getElement<HTMLInputElement>('mass-slider');
    
    if (!phaseDiv || !chargeBtn || !dropBtn) return;
    
    chargeBtn.disabled = true;
    dropBtn.disabled = true;
    
    switch (this.currentPhase) {
      case this.phases.IDLE:
        phaseDiv.textContent = `IDLE - Roaster Preheated to ${this.preheatTemp}°C`;
        phaseDiv.className = 'roast-phase phase-charging';
        chargeBtn.disabled = false;
        if (massSlider) massSlider.disabled = false;
        break;
        
      case this.phases.CHARGING:
        phaseDiv.textContent = 'CHARGING - Adding Beans';
        phaseDiv.className = 'roast-phase phase-charging';
        if (massSlider) massSlider.disabled = true;
        break;
        
      case this.phases.ROASTING:
        phaseDiv.textContent = 'ROASTING - Beans in Progress';
        phaseDiv.className = 'roast-phase phase-roasting';
        dropBtn.disabled = false;
        if (massSlider) massSlider.disabled = true;
        break;
        
      case this.phases.DROPPED:
        phaseDiv.textContent = 'DROPPED - Roast Complete';
        phaseDiv.className = 'roast-phase phase-dropped';
        if (massSlider) massSlider.disabled = true;
        break;
    }
  }
  
  /**
   * Charge beans and start simulation
   */
  private chargeBeans(): void {
    console.log(`Charging beans (${this.controls.mass}g)...`);
    this.currentPhase = this.phases.CHARGING;
    this.updatePhaseDisplay();
    
    // Initialize simulation data
    this.timeData = [];
    this.temperatureData = { bean: [], environment: [], roaster: [], air: [], airMeasured: [] };
    this.controlData = { heater: [], fan: [], drum: [] };
    this.rateOfRiseData = [];
    this.simulationTime = 0;
    
    // Reset state to preheat conditions
    this.currentState = this.initializePreheatState();
    
    // Start simulation loop
    this.isRunning = true;
    const intervalMs = (this.timestep * 1000) / this.speedupFactor;
    this.simulationInterval = window.setInterval(() => this.simulationStep(), intervalMs);
    
    console.log(`Starting testbed simulation at ${this.speedupFactor}x speed`);
    
    // Transition to roasting after brief delay
    setTimeout(() => {
      this.currentPhase = this.phases.ROASTING;
      this.updatePhaseDisplay();
    }, 2000);
  }
  
  /**
   * Drop beans from roaster
   */
  private dropBeans(): void {
    console.log('Dropping beans...');
    this.currentPhase = this.phases.DROPPED;
    this.updatePhaseDisplay();
    
    setTimeout(() => {
      this.isRunning = false;
      if (this.simulationInterval) {
        clearInterval(this.simulationInterval);
        this.simulationInterval = null;
      }
    }, 1000);
  }
  
  /**
   * Reset simulation
   */
  private reset(): void {
    console.log('Resetting testbed simulation...');
    
    this.isRunning = false;
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    
    this.currentPhase = this.phases.IDLE;
    this.currentState = this.initializePreheatState();
    this.simulationTime = 0;
    
    // Clear data
    this.timeData = [];
    this.temperatureData = { bean: [], environment: [], roaster: [], air: [], airMeasured: [] };
    this.controlData = { heater: [], fan: [], drum: [] };
    this.rateOfRiseData = [];
    
    this.updatePhaseDisplay();
    this.updateStatusDisplay();
    this.updateCharts();
  }
  
  /**
   * Perform one simulation step
   */
  private async simulationStep(): Promise<void> {
    if (!this.isRunning) return;
    
    try {
      this.simulationTime += this.timestep;
      const currentTimeMinutes = this.simulationTime / 60;
      
      // Determine if beans are present
      const beansPresent = this.currentPhase === this.phases.CHARGING || this.currentPhase === this.phases.ROASTING;
      const massValue = beansPresent ? this.controls.mass : 0.0;
      
      // Get bean thermal capacity
      let beanCapacity = 0.5;
      if (beansPresent && this.sessions.beanModel) {
        const beanModelResult = await this.sessions.beanModel.run({
          bean_temperature: new ort.Tensor('float32', [this.currentState[1]], [1, 1])
        });
        beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
      }
      
      // Prepare controls for roast stepper
      const stepperControls = new Float32Array(7);
      stepperControls[0] = this.controls.heater;
      stepperControls[1] = this.controls.fan;
      stepperControls[2] = this.fixedParams.drum;
      stepperControls[3] = this.fixedParams.ambient / this.scalingFactors.controls.ambient;
      stepperControls[4] = this.fixedParams.humidity / this.scalingFactors.controls.humidity;
      stepperControls[5] = massValue / this.scalingFactors.mass;
      stepperControls[6] = beanCapacity;
      
      const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
      
      // Run roast stepper
      if (!this.sessions.roastStepper) {
        throw new Error('Roast stepper model not loaded');
      }
      
      const stepperResult = await this.sessions.roastStepper.run({
        current_state: new ort.Tensor('float32', this.currentState, [1, 5]),
        current_controls: new ort.Tensor('float32', stepperControls, [1, 7]),
        dt: new ort.Tensor('float32', dt, [1, 1])
      });
      
      // Update current state
      this.currentState = new Float32Array(stepperResult.next_state.data as any as number[]);
      
      // Store data for plotting
      this.timeData.push(currentTimeMinutes);
      const currentBeanTemp = this.denormalizeTemperature(this.currentState[3]);
      this.temperatureData.bean.push(currentBeanTemp);
      this.temperatureData.environment.push(this.denormalizeTemperature(this.currentState[1]));
      this.temperatureData.roaster.push(this.denormalizeTemperature(this.currentState[0]));
      this.temperatureData.air.push(this.denormalizeTemperature(this.currentState[2]));
      this.temperatureData.airMeasured.push(this.denormalizeTemperature(this.currentState[4]));
      
      // Calculate rate of rise
      if (this.timeData.length === 1) {
        this.rateOfRiseData.push(0);
      } else {
        const prevTime = this.timeData[this.timeData.length - 2];
        const prevBeanTemp = this.temperatureData.bean[this.temperatureData.bean.length - 2];
        const timeDiff = currentTimeMinutes - prevTime;
        const tempDiff = currentBeanTemp - prevBeanTemp;
        const rateOfRise = timeDiff > 0 ? tempDiff / timeDiff : 0;
        this.rateOfRiseData.push(rateOfRise);
      }
      
      this.controlData.heater.push(this.controls.heater);
      this.controlData.fan.push(this.controls.fan);
      this.controlData.drum.push(this.fixedParams.drum);
      
      // Compute 4-minute forecast from current state
      if (beansPresent) {
        const forecast = await this.compute4MinuteForecast();
        this.forecastData.time = forecast.time;
        this.forecastData.bean = forecast.bean;
        this.forecastData.environment = forecast.environment;
        this.forecastData.roaster = forecast.roaster;
        this.forecastData.air = forecast.air;
      } else {
        // Clear forecast if no beans present
        this.forecastData.time = [];
        this.forecastData.bean = [];
        this.forecastData.environment = [];
        this.forecastData.roaster = [];
        this.forecastData.air = [];
      }
      
      // Update UI
      this.updateStatusDisplay();
      this.updateCharts();
      
    } catch (error) {
      console.error('Testbed simulation step error:', error);
      this.showError('Simulation error: ' + (error as Error).message);
      this.isRunning = false;
      if (this.simulationInterval) {
        clearInterval(this.simulationInterval);
        this.simulationInterval = null;
      }
    }
  }
  
  /**
   * Compute 4-minute (240-second) forecast from current state
   * Predicts future temperatures over the next 4 minutes using current control inputs
   * 
   * @returns forecast - Object containing time and temperature arrays for all state variables
   */
  private async compute4MinuteForecast(): Promise<{
    time: number[];
    bean: number[];
    environment: number[];
    roaster: number[];
    air: number[];
  }> {
    const forecastHorizon = 240; // seconds into the future (4 minutes)
    const forecastSteps = Math.ceil(forecastHorizon / this.timestep);
    
    // Arrays to store forecast trajectory
    const forecastTime: number[] = [];
    const forecastBeanTemp: number[] = [];
    const forecastEnvironmentTemp: number[] = [];
    const forecastRoasterTemp: number[] = [];
    const forecastAirTemp: number[] = [];
    
    // Create a copy of current state for forecasting
    let forecastState = new Float32Array(this.currentState);
    
    // Determine if beans are present
    const beansPresent = this.currentPhase === this.phases.CHARGING || this.currentPhase === this.phases.ROASTING;
    const massValue = beansPresent ? this.controls.mass : 0.0;
    
    // Get current bean thermal capacity
    let beanCapacity = 0.5;
    if (beansPresent && this.sessions.beanModel) {
      const beanModelResult = await this.sessions.beanModel.run({
        bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
      });
      beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
    }
    
    // Prepare control inputs (fixed at current values for the entire forecast)
    const forecastControls = new Float32Array(7);
    forecastControls[0] = this.controls.heater;
    forecastControls[1] = this.controls.fan;
    forecastControls[2] = this.fixedParams.drum;
    forecastControls[3] = this.fixedParams.ambient / this.scalingFactors.controls.ambient;
    forecastControls[4] = this.fixedParams.humidity / this.scalingFactors.controls.humidity;
    forecastControls[5] = massValue / this.scalingFactors.mass;
    
    const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
    
    // Run forecast loop
    for (let step = 0; step < forecastSteps; step++) {
      // Update bean capacity based on current forecast state
      if (beansPresent && this.sessions.beanModel) {
        const beanModelResult = await this.sessions.beanModel.run({
          bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
        });
        beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
        forecastControls[6] = beanCapacity;
      } else {
        forecastControls[6] = beanCapacity;
      }
      
      // Predict next state using roast stepper
      if (!this.sessions.roastStepper) {
        throw new Error('Roast stepper model not loaded');
      }
      
      const stepperResult = await this.sessions.roastStepper.run({
        current_state: new ort.Tensor('float32', forecastState, [1, 5]),
        current_controls: new ort.Tensor('float32', forecastControls, [1, 7]),
        dt: new ort.Tensor('float32', dt, [1, 1])
      });
      
      // Update forecast state
      forecastState = new Float32Array(stepperResult.next_state.data as any as number[]);
      
      // Store forecast data point
      const forecastTimePoint = this.simulationTime / 60 + (step + 1) * this.timestep / 60;
      forecastTime.push(forecastTimePoint);
      
      // Extract and denormalize state variables
      // State vector: [T_r, T_b, T_air, T_bm, T_atm]
      forecastRoasterTemp.push(this.denormalizeTemperature(forecastState[0]));
      forecastEnvironmentTemp.push(this.denormalizeTemperature(forecastState[1]));
      forecastAirTemp.push(this.denormalizeTemperature(forecastState[2]));
      forecastBeanTemp.push(this.denormalizeTemperature(forecastState[3]));
    }
    
    return {
      time: forecastTime,
      bean: forecastBeanTemp,
      environment: forecastEnvironmentTemp,
      roaster: forecastRoasterTemp,
      air: forecastAirTemp
    };
  }
  
  /**
   * Convert normalized temperature to Celsius
   */
  private denormalizeTemperature(normalizedTemp: number): number {
    return normalizedTemp * this.scalingFactors.temperatures.bean;
  }
  
  /**
   * Update status display
   */
  private updateStatusDisplay(): void {
    if (this.timeData.length === 0) {
      // Display initial preheat values
      const beanTempEl = this.getElement('bean-temp');
      const envTempEl = this.getElement('env-temp');
      const roasterTempEl = this.getElement('roaster-temp');
      const airTempEl = this.getElement('air-temp');
      const airTempMeasuredEl = this.getElement('air-temp-measured');
      const roastTimeEl = this.getElement('roast-time');
      const rateOfRiseEl = this.getElement('rate-of-rise');
      
      if (beanTempEl) beanTempEl.textContent = this.preheatTemp + '°C';
      if (envTempEl) envTempEl.textContent = (this.preheatTemp + 30) + '°C';
      if (roasterTempEl) roasterTempEl.textContent = (this.preheatTemp + 50) + '°C';
      if (airTempEl) airTempEl.textContent = this.preheatTemp + '°C';
      if (airTempMeasuredEl) airTempMeasuredEl.textContent = this.preheatTemp + '°C';
      if (roastTimeEl) roastTimeEl.textContent = '00:00';
      if (rateOfRiseEl) rateOfRiseEl.textContent = '0°C/min';
      return;
    }
    
    const latest = this.timeData.length - 1;
    const currentTime = this.timeData[latest];
    const currentBeanTemp = this.temperatureData.bean[latest];
    
    // Update displays
    const beanTempEl = this.getElement('bean-temp');
    const envTempEl = this.getElement('env-temp');
    const roasterTempEl = this.getElement('roaster-temp');
    const airTempEl = this.getElement('air-temp');
    const airTempMeasuredEl = this.getElement('air-temp-measured');
    const roastTimeEl = this.getElement('roast-time');
    const rateOfRiseEl = this.getElement('rate-of-rise');
    
    if (beanTempEl) beanTempEl.textContent = Math.round(currentBeanTemp) + '°C';
    if (envTempEl) envTempEl.textContent = Math.round(this.temperatureData.environment[latest]) + '°C';
    if (roasterTempEl) roasterTempEl.textContent = Math.round(this.temperatureData.roaster[latest]) + '°C';
    if (airTempEl) airTempEl.textContent = Math.round(this.temperatureData.air[latest]) + '°C';
    if (airTempMeasuredEl) airTempMeasuredEl.textContent = Math.round(this.temperatureData.airMeasured[latest]) + '°C';
    
    // Update time
    const minutes = Math.floor(currentTime);
    const seconds = Math.floor((currentTime - minutes) * 60);
    if (roastTimeEl) {
      roastTimeEl.textContent = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }
    
    // Update rate of rise
    if (this.rateOfRiseData.length > 0) {
      const rateOfRise = this.rateOfRiseData[this.rateOfRiseData.length - 1];
      if (rateOfRiseEl) rateOfRiseEl.textContent = rateOfRise.toFixed(1) + '°C/min';
    }
  }
  
  /**
   * Update Plotly charts
   */
  private updateCharts(): void {
    // Calculate x-axis limit: extend to forecast if available
    let xlimit = 10;
    if (this.timeData.length > 0) {
      const lastTimeStamp = this.timeData[this.timeData.length - 1];
      // If we have forecast data, extend to the end of the forecast
      if (this.forecastData.time.length > 0) {
        const lastForecastTime = this.forecastData.time[this.forecastData.time.length - 1];
        xlimit = Math.max(10, lastForecastTime + 0.5);
      } else {
        xlimit = Math.max(10, lastTimeStamp + 1);
      }
    }
    
    // Calculate y-axis limit for temperature
    let ylimit = 200;
    if (this.timeData.length > 0) {
      const allTemps = [
        ...this.temperatureData.bean,
        ...this.temperatureData.environment,
        ...this.temperatureData.roaster,
        ...this.temperatureData.air
      ];
      const maxTemp = Math.max(...allTemps);
      ylimit = Math.max(200, maxTemp + 25);
    }
    
    // Update temperature chart (including forecast traces)
    const tempUpdate = {
      x: [
        this.timeData, 
        this.timeData, 
        this.timeData, 
        this.timeData,
        this.forecastData.time,  // Bean forecast
        this.forecastData.time,  // Surface forecast
        this.forecastData.time,  // Drum forecast
        this.forecastData.time   // Air forecast
      ],
      y: [
        this.temperatureData.bean,
        this.temperatureData.environment,
        this.temperatureData.roaster,
        this.temperatureData.air,
        this.forecastData.bean,        // Bean forecast
        this.forecastData.environment, // Surface forecast
        this.forecastData.roaster,     // Drum forecast
        this.forecastData.air          // Air forecast
      ]
    };
    Plotly.restyle(this.idPrefix + 'temperature-chart', tempUpdate);
    
    // Add vertical line at current time to mark forecast boundary
    const currentTimeMinutes = this.timeData.length > 0 ? this.timeData[this.timeData.length - 1] : 0;
    const shapes = this.timeData.length > 0 ? [{
      type: 'line',
      x0: currentTimeMinutes,
      x1: currentTimeMinutes,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: {
        color: 'rgba(0, 0, 0, 0.3)',
        width: 2,
        dash: 'dot'
      }
    }] : [];
    
    const tempLayoutUpdate = {
      'xaxis.range': [0, xlimit],
      'yaxis.range': [0, ylimit],
      shapes: shapes
    };
    Plotly.relayout(this.idPrefix + 'temperature-chart', tempLayoutUpdate);
    
    // Update control chart
    const controlUpdate = {
      x: [this.timeData, this.timeData, this.timeData],
      y: [
        this.controlData.heater,
        this.controlData.fan,
        this.controlData.drum
      ]
    };
    Plotly.restyle(this.idPrefix + 'control-chart', controlUpdate);
    
    // Add vertical line to control chart as well
    const controlShapes = this.timeData.length > 0 ? [{
      type: 'line',
      x0: currentTimeMinutes,
      x1: currentTimeMinutes,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: {
        color: 'rgba(0, 0, 0, 0.3)',
        width: 2,
        dash: 'dot'
      }
    }] : [];
    
    const controlLayoutUpdate = {
      'xaxis.range': [0, xlimit],
      shapes: controlShapes
    };
    Plotly.relayout(this.idPrefix + 'control-chart', controlLayoutUpdate);
  }
}
