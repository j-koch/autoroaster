/**
 * Landing Page - AutoRoaster
 * 
 * Handles the interactive demo simulation on the landing page.
 * This provides a complete preview of the digital twin technology
 * using the actual ONNX models with full physics simulation.
 */

import * as Plotly from 'plotly.js-dist-min';

// ============================================================================
// Constants and Configuration
// ============================================================================

const DT = 1.5; // seconds - simulation timestep (matches main simulator)
const UPDATE_INTERVAL = 100; // milliseconds - chart update rate (10 Hz)
const SPEEDUP = 1; // simulation speedup factor (2x real-time for demo)
const MAX_TIME = 600; // seconds - 10 minutes maximum display time
const FORECAST_HORIZON = 240; // seconds - 4 minute lookahead forecast

// Scaling factors from dataset.py - must match the training data normalization
const SCALING_FACTORS = {
    temperatures: {
        bean: 100.0,        // Bean temperature scale
        environment: 100.0, // Environment temperature scale
        temp_difference: 100.0
    },
    controls: {
        heater: 100.0,
        fan: 100.0,
        drum: 100.0,
        ambient: 100.0,
        humidity: 100.0
    },
    mass: 100.0,  // Typical batch size
    time: 60.0    // Convert seconds to minutes
};

// Initial conditions (matching index.html defaults)
const INITIAL_CONDITIONS = {
    preheatTemp: 180.0,  // °C - preheat temperature
    ambientTemp: 24.0,   // °C - ambient temperature
    beanMass: 150.0,     // g - bean mass
    drumSpeed: 0.6,      // 0-1 - fixed drum speed (60%)
    humidity: 0.5,       // 0-1 - fixed humidity
    heaterPower: 0.6,    // 0-1 - initial heater power (60%)
    fanSpeed: 0.5        // 0-1 - initial fan speed (50%)
};

// ============================================================================
// State Management
// ============================================================================

interface DemoState {
    isRunning: boolean;
    time: number;  // Simulation time in seconds
    
    // Temperature data arrays (in °C)
    beanTemp: number[];      // T_bm - Bean probe temperature
    beanSurface: number[];   // T_b - Bean surface/core temperature
    drumTemp: number[];      // T_r - Roaster/drum temperature
    airTemp: number[];       // T_air - Air surrounding beans
    envTemp: number[];       // T_atm - Environment probe temperature
    rateOfRise: number[];    // Rate of rise in °C/min
    
    // Time data array (in minutes for plotting)
    timeData: number[];
    
    // Control data arrays (0-1 normalized)
    heaterPower: number[];
    fanSpeed: number[];
    drumSpeed: number[];
    
    // Current state vector [T_r, T_b, T_air, T_bm, T_atm] (normalized)
    currentState: Float32Array;
    
    // Current control inputs
    heater: number;  // 0-1
    fan: number;     // 0-1
}

let demoState: DemoState;
let roasterSession: ort.InferenceSession | null = null;
let beanSession: ort.InferenceSession | null = null;
let simulationInterval: number | null = null;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize simulation state with preheat conditions
 * This matches the initializePreheatState() function from RoasterSimulator.ts
 */
function initializeState(): void {
    const roomTemp = 25.0; // °C
    const preheatTemp = INITIAL_CONDITIONS.preheatTemp;
    const roasterTemp = preheatTemp + 80.0; // 260°C - drum starts hotter
    const airTemp = preheatTemp; // 180°C - air surrounding beans
    const envTemp = preheatTemp - 40.0; // 140°C - environment probe
    
    // Normalize temperatures for the state vector
    const tempScale = SCALING_FACTORS.temperatures.bean;
    
    demoState = {
        isRunning: false,
        time: 0,
        
        // Initialize empty data arrays
        beanTemp: [],
        beanSurface: [],
        drumTemp: [],
        airTemp: [],
        envTemp: [],
        rateOfRise: [],
        timeData: [],
        
        // Initialize control arrays
        heaterPower: [],
        fanSpeed: [],
        drumSpeed: [],
        
        // Initialize state vector: [T_r, T_b, T_air, T_bm, T_atm]
        currentState: new Float32Array([
            roasterTemp / tempScale,  // T_r (roaster temperature)
            roomTemp / tempScale,     // T_b (bean core - starts at room temp)
            airTemp / tempScale,      // T_air (air surrounding beans)
            preheatTemp / tempScale,  // T_bm (bean probe measurement)
            envTemp / tempScale       // T_atm (environment probe)
        ]),
        
        // Current control values
        heater: INITIAL_CONDITIONS.heaterPower,
        fan: INITIAL_CONDITIONS.fanSpeed
    };
}

// ============================================================================
// Model Loading
// ============================================================================

/**
 * Load ONNX models for the demo
 */
async function loadModels(): Promise<void> {
    try {
        // Configure ONNX Runtime Web BEFORE loading models
        ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.0/dist/';
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.simd = true;
        
        console.log('ONNX Runtime WASM path configured:', ort.env.wasm.wasmPaths);
        
        // Get base URL from Vite
        const baseUrl = import.meta.env.BASE_URL;
        
        // Load roaster stepper model (physics simulation)
        console.log(`Loading roaster model from: ${baseUrl}onnx_models/roast_stepper.onnx`);
        roasterSession = await ort.InferenceSession.create(`${baseUrl}onnx_models/roast_stepper.onnx`);
        
        // Load bean model (default to Guji)
        console.log(`Loading bean model from: ${baseUrl}onnx_models/bean_guji.onnx`);
        beanSession = await ort.InferenceSession.create(`${baseUrl}onnx_models/bean_guji.onnx`);
        
        console.log('✅ Demo models loaded successfully');
    } catch (error) {
        console.error('❌ Error loading demo models:', error);
        throw error;
    }
}

// ============================================================================
// Simulation Logic
// ============================================================================

/**
 * Denormalize temperature from normalized value to °C
 */
function denormalizeTemperature(normalizedTemp: number): number {
    return normalizedTemp * SCALING_FACTORS.temperatures.bean;
}

/**
 * Step the simulation forward by one timestep
 * Uses actual ONNX models for physics-based prediction
 */
async function stepSimulation(): Promise<void> {
    if (!roasterSession || !beanSession || !demoState.isRunning) {
        return;
    }
    
    try {
        // Update simulation time
        demoState.time += DT;
        const currentTimeMinutes = demoState.time / 60;
        
        // Check if we've reached MAX_TIME - if so, show end overlay
        if (demoState.time >= MAX_TIME) {
            showEndOverlay();
            stopDemo(false);
            return;
        }
        
        // Get bean thermal capacity from bean model
        const beanModelResult = await beanSession.run({
            bean_temperature: new ort.Tensor('float32', [demoState.currentState[1]], [1, 1])
        });
        const beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
        
        // Prepare control inputs for roast stepper
        // Format: [heater, fan, drum, T_amb, humidity, mass, C_b]
        const controls = new Float32Array(7);
        controls[0] = demoState.heater;  // Heater power (0-1)
        controls[1] = demoState.fan;     // Fan speed (0-1)
        controls[2] = INITIAL_CONDITIONS.drumSpeed;  // Fixed drum speed
        controls[3] = INITIAL_CONDITIONS.ambientTemp / SCALING_FACTORS.controls.ambient;
        controls[4] = INITIAL_CONDITIONS.humidity / SCALING_FACTORS.controls.humidity;
        controls[5] = INITIAL_CONDITIONS.beanMass / SCALING_FACTORS.mass;
        controls[6] = beanCapacity;  // Bean thermal capacity
        
        // Normalized timestep
        const dt = new Float32Array([DT / SCALING_FACTORS.time]);
        
        // Run roast stepper to predict next state
        const stepperResult = await roasterSession.run({
            current_state: new ort.Tensor('float32', demoState.currentState, [1, 5]),
            current_controls: new ort.Tensor('float32', controls, [1, 7]),
            dt: new ort.Tensor('float32', dt, [1, 1])
        });
        
        // Update current state from model prediction
        demoState.currentState = new Float32Array(stepperResult.next_state.data as any as number[]);
        
        // Extract and denormalize temperatures from state vector
        // State vector: [T_r, T_b, T_air, T_bm, T_atm]
        const drumTemp = denormalizeTemperature(demoState.currentState[0]);      // T_r
        const beanSurface = denormalizeTemperature(demoState.currentState[1]);   // T_b
        const airTemp = denormalizeTemperature(demoState.currentState[2]);       // T_air
        const beanTemp = denormalizeTemperature(demoState.currentState[3]);      // T_bm
        const envTemp = denormalizeTemperature(demoState.currentState[4]);       // T_atm
        
        // Store temperature data
        demoState.timeData.push(currentTimeMinutes);
        demoState.beanTemp.push(beanTemp);
        demoState.beanSurface.push(beanSurface);
        demoState.drumTemp.push(drumTemp);
        demoState.airTemp.push(airTemp);
        demoState.envTemp.push(envTemp);
        
        // Calculate rate of rise (°C/min)
        if (demoState.beanTemp.length === 1) {
            demoState.rateOfRise.push(0);  // First point has no rate of rise
        } else {
            const prevTime = demoState.timeData[demoState.timeData.length - 2];
            const prevTemp = demoState.beanTemp[demoState.beanTemp.length - 2];
            const timeDiff = currentTimeMinutes - prevTime;
            const tempDiff = beanTemp - prevTemp;
            const ror = timeDiff > 0 ? tempDiff / timeDiff : 0;
            demoState.rateOfRise.push(ror);
        }
        
        // Store control data
        demoState.heaterPower.push(demoState.heater);
        demoState.fanSpeed.push(demoState.fan);
        demoState.drumSpeed.push(INITIAL_CONDITIONS.drumSpeed);
        
    } catch (error) {
        console.error('Error in simulation step:', error);
        stopDemo(false);
    }
}

/**
 * Compute forecast trajectory from current state
 * Predicts temperature evolution over the next FORECAST_HORIZON seconds
 */
async function computeForecast(): Promise<{
    time: number[];
    beanTemp: number[];
    beanSurface: number[];
    drumTemp: number[];
    envTemp: number[];
    rateOfRise: number[];
}> {
    if (!roasterSession || !beanSession) {
        return { time: [], beanTemp: [], beanSurface: [], drumTemp: [], envTemp: [], rateOfRise: [] };
    }
    
    const forecastSteps = Math.ceil(FORECAST_HORIZON / DT);
    const forecastTime: number[] = [];
    const forecastBeanTemp: number[] = [];
    const forecastBeanSurface: number[] = [];
    const forecastDrumTemp: number[] = [];
    const forecastEnvTemp: number[] = [];
    const forecastRateOfRise: number[] = [];
    
    // Copy current state for forecast
    let forecastState = new Float32Array(demoState.currentState);
    
    // Get current bean capacity
    let beanModelResult = await beanSession.run({
        bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
    });
    let beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
    
    // Prepare control inputs (fixed at current values)
    const controls = new Float32Array(7);
    controls[0] = demoState.heater;
    controls[1] = demoState.fan;
    controls[2] = INITIAL_CONDITIONS.drumSpeed;
    controls[3] = INITIAL_CONDITIONS.ambientTemp / SCALING_FACTORS.controls.ambient;
    controls[4] = INITIAL_CONDITIONS.humidity / SCALING_FACTORS.controls.humidity;
    controls[5] = INITIAL_CONDITIONS.beanMass / SCALING_FACTORS.mass;
    
    const dt = new Float32Array([DT / SCALING_FACTORS.time]);
    
    // Run forecast loop
    for (let step = 0; step < forecastSteps; step++) {
        // Update bean capacity
        beanModelResult = await beanSession.run({
            bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
        });
        beanCapacity = beanModelResult.thermal_capacity.data[0] as number;
        controls[6] = beanCapacity;
        
        // Predict next state
        const stepperResult = await roasterSession.run({
            current_state: new ort.Tensor('float32', forecastState, [1, 5]),
            current_controls: new ort.Tensor('float32', controls, [1, 7]),
            dt: new ort.Tensor('float32', dt, [1, 1])
        });
        
        forecastState = new Float32Array(stepperResult.next_state.data as any as number[]);
        
        // Store forecast data
        const forecastTimePoint = demoState.time / 60 + (step + 1) * DT / 60;
        forecastTime.push(forecastTimePoint);
        forecastDrumTemp.push(denormalizeTemperature(forecastState[0]));
        forecastBeanSurface.push(denormalizeTemperature(forecastState[1]));
        const beanTemp = denormalizeTemperature(forecastState[3]);
        forecastBeanTemp.push(beanTemp);
        forecastEnvTemp.push(denormalizeTemperature(forecastState[4]));
        
        // Calculate rate of rise for forecast (°C/min)
        if (step === 0) {
            // First forecast point - use rate from current actual data
            if (demoState.beanTemp.length > 0) {
                const lastActualTemp = demoState.beanTemp[demoState.beanTemp.length - 1];
                const lastActualTime = demoState.timeData[demoState.timeData.length - 1];
                const timeDiff = forecastTimePoint - lastActualTime;
                const tempDiff = beanTemp - lastActualTemp;
                const ror = timeDiff > 0 ? tempDiff / timeDiff : 0;
                forecastRateOfRise.push(ror);
            } else {
                forecastRateOfRise.push(0);
            }
        } else {
            // Subsequent points - calculate from previous forecast point
            const prevTime = forecastTime[step - 1];
            const prevTemp = forecastBeanTemp[step - 1];
            const timeDiff = forecastTimePoint - prevTime;
            const tempDiff = beanTemp - prevTemp;
            const ror = timeDiff > 0 ? tempDiff / timeDiff : 0;
            forecastRateOfRise.push(ror);
        }
    }
    
    return {
        time: forecastTime,
        beanTemp: forecastBeanTemp,
        beanSurface: forecastBeanSurface,
        drumTemp: forecastDrumTemp,
        envTemp: forecastEnvTemp,
        rateOfRise: forecastRateOfRise
    };
}

// ============================================================================
// Chart Management
// ============================================================================

/**
 * Initialize Plotly charts for temperature and control visualization
 */
function initializeCharts(): void {
    // Temperature chart with dual y-axis (temperature + rate of rise)
    const tempLayout = {
        title: {
            text: 'James\'s Kaleido M1',
            font: { size: 14 }
        },
        xaxis: {
            title: '',
            gridcolor: '#e0e0e0'
        },
        yaxis: {
            title: 'Temperature (°C)',
            side: 'left' as const,
            gridcolor: '#e0e0e0'
        },
        yaxis2: {
            title: 'Rate of Rise (°C/min)',
            side: 'right' as const,
            overlaying: 'y' as const,
            showgrid: false,
            zeroline: true,
            zerolinecolor: '#666',
            zerolinewidth: 1
        },
        showlegend: true,
        legend: {
            x: 0.98,
            xanchor: 'right' as const,
            y: 0.02,
            yanchor: 'bottom' as const,
            bgcolor: 'rgba(255, 255, 255, 0.9)',
            bordercolor: '#e0e0e0',
            borderwidth: 1
        },
        margin: { t: 35, r: 80, b: 35, l: 60 },
        autosize: true
    };
    
    const tempData = [
        {
            x: [],
            y: [],
            name: 'Bean Probe',
            line: { color: '#8B4513', width: 3 },
            yaxis: 'y'
        },
        {
            x: [],
            y: [],
            name: 'Bean Surface',
            line: { color: '#FF6B35', width: 2 },
            yaxis: 'y'
        },
        {
            x: [],
            y: [],
            name: 'Drum',
            line: { color: '#4ECDC4', width: 2 },
            yaxis: 'y'
        },
        {
            x: [],
            y: [],
            name: 'Environment',
            line: { color: '#45B7D1', width: 2 },
            yaxis: 'y'
        },
        {
            x: [],
            y: [],
            name: 'Rate of Rise',
            line: { color: '#FF1493', width: 2, dash: 'dot' },
            yaxis: 'y2'
        },
        // Forecast traces (dashed lines)
        {
            x: [],
            y: [],
            name: 'Bean Forecast',
            line: { color: '#8B4513', width: 2, dash: 'dash' },
            yaxis: 'y',
            opacity: 0.6,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Surface Forecast',
            line: { color: '#FF6B35', width: 1.5, dash: 'dash' },
            yaxis: 'y',
            opacity: 0.5,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Drum Forecast',
            line: { color: '#4ECDC4', width: 1.5, dash: 'dash' },
            yaxis: 'y',
            opacity: 0.5,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Env Forecast',
            line: { color: '#45B7D1', width: 1.5, dash: 'dash' },
            yaxis: 'y',
            opacity: 0.5,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'RoR Forecast',
            line: { color: '#FF1493', width: 1.5, dash: 'dash' },
            yaxis: 'y2',
            opacity: 0.5,
            showlegend: false
        }
    ];
    
    const tempConfig = {
        responsive: true,
        displayModeBar: false
    };
    
    Plotly.newPlot('demo-temp-chart', tempData, tempLayout, tempConfig);
    
    // Control chart
    const controlLayout = {
        xaxis: {
            title: 'Time (minutes)',
            gridcolor: '#e0e0e0'
        },
        yaxis: {
            title: 'Power level',
            range: [0, 1],
            gridcolor: '#e0e0e0'
        },
        showlegend: true,
        legend: {
            x: 0.98,
            xanchor: 'right' as const,
            y: 0.02,
            yanchor: 'bottom' as const,
            bgcolor: 'rgba(255, 255, 255, 0.9)',
            bordercolor: '#e0e0e0',
            borderwidth: 1
        },
        margin: { t: 10, r: 80, b: 50, l: 60 },
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
    
    const controlConfig = {
        responsive: true,
        displayModeBar: false
    };
    
    Plotly.newPlot('demo-control-chart', controlData, controlLayout, controlConfig);
    
    // Trigger resize to ensure proper sizing
    setTimeout(() => {
        Plotly.Plots.resize('demo-temp-chart');
        Plotly.Plots.resize('demo-control-chart');
    }, 100);
}

/**
 * Update charts with current simulation data and forecast
 */
async function updateCharts(): Promise<void> {
    // Compute forecast
    const forecast = await computeForecast();
    
    // Update temperature chart with actual data and forecast
    const tempUpdate = {
        x: [
            demoState.timeData,      // Bean probe (actual)
            demoState.timeData,      // Bean surface (actual)
            demoState.timeData,      // Drum (actual)
            demoState.timeData,      // Environment (actual)
            demoState.timeData,      // Rate of rise (actual)
            forecast.time,           // Bean forecast
            forecast.time,           // Surface forecast
            forecast.time,           // Drum forecast
            forecast.time,           // Env forecast
            forecast.time            // RoR forecast
        ],
        y: [
            demoState.beanTemp,
            demoState.beanSurface,
            demoState.drumTemp,
            demoState.envTemp,
            demoState.rateOfRise,
            forecast.beanTemp,
            forecast.beanSurface,
            forecast.drumTemp,
            forecast.envTemp,
            forecast.rateOfRise
        ]
    };
    (Plotly as any).restyle('demo-temp-chart', tempUpdate);
    
    // Calculate x-axis range: fixed at 0-10 minutes
    const maxTimeMinutes = MAX_TIME / 60;  // 10 minutes
    
    // Temperature y-axis range (fixed at 300°C)
    const yLimit = 300;
    
    // Calculate y-axis range for rate of rise (fixed at 30 °C/min)
    const y2Limit = 30;
    
    // Current time marker (vertical line)
    const currentTimeMinutes = demoState.timeData.length > 0 ? demoState.timeData[demoState.timeData.length - 1] : 0;
    const shapes = demoState.timeData.length > 0 ? [{
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
    
    // Update temperature chart layout with fixed axis
    const tempLayoutUpdate = {
        'xaxis.range': [0, maxTimeMinutes],
        'yaxis.range': [0, yLimit],
        'yaxis2.range': [0, y2Limit],
        shapes: shapes
    };
    (Plotly as any).relayout('demo-temp-chart', tempLayoutUpdate);
    
    // Update control chart
    const controlUpdate = {
        x: [
            demoState.timeData,  // Heater
            demoState.timeData,  // Fan
            demoState.timeData   // Drum
        ],
        y: [
            demoState.heaterPower,
            demoState.fanSpeed,
            demoState.drumSpeed
        ]
    };
    (Plotly as any).restyle('demo-control-chart', controlUpdate);
    
    // Update control chart layout with fixed axis
    const controlShapes = demoState.timeData.length > 0 ? [{
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
        'xaxis.range': [0, maxTimeMinutes],
        shapes: controlShapes
    };
    (Plotly as any).relayout('demo-control-chart', controlLayoutUpdate);
}

// ============================================================================
// Demo Control
// ============================================================================

/**
 * Start the demo simulation
 */
async function startDemo(): Promise<void> {
    const loadingElement = document.getElementById('demo-loading');
    
    // Initialize charts
    initializeCharts();
    
    // Load models if not already loaded
    if (!roasterSession || !beanSession) {
        try {
            await loadModels();
        } catch (error) {
            console.error('Failed to load models:', error);
            if (loadingElement) {
                loadingElement.innerHTML = '<p style="color: #dc3545;">Failed to load simulation. Please refresh the page.</p>';
            }
            return;
        }
    }
    
    // Hide loading overlay
    if (loadingElement) {
        loadingElement.style.display = 'none';
    }
    
    // Initialize simulation state
    initializeState();
    demoState.isRunning = true;
    
    // Start simulation loop at SPEEDUP times real-time
    simulationInterval = window.setInterval(async () => {
        for (let i = 0; i < SPEEDUP; i++) {
            await stepSimulation();
        }
        updateCharts();
    }, UPDATE_INTERVAL);
    
    console.log('Demo simulation started at', SPEEDUP, 'x speed');
}

/**
 * Stop the demo simulation
 * @param showFade - Whether to show the fade overlay with CTA
 */
function stopDemo(showFade: boolean = false): void {
    demoState.isRunning = false;
    
    if (simulationInterval !== null) {
        clearInterval(simulationInterval);
        simulationInterval = null;
    }
    
    if (showFade) {
        const fadeElement = document.getElementById('demo-fade');
        if (fadeElement) {
            fadeElement.style.display = 'flex';
        }
    }
    
    console.log('Demo simulation stopped');
}

/**
 * Show the end-of-simulation overlay when MAX_TIME is reached
 * Displays options to reset simulation or contact for full demo
 */
function showEndOverlay(): void {
    const endOverlay = document.getElementById('demo-end-overlay');
    if (endOverlay) {
        endOverlay.style.display = 'flex';
    }
    console.log('Simulation complete - showing end overlay');
}

/**
 * Hide the end-of-simulation overlay
 */
function hideEndOverlay(): void {
    const endOverlay = document.getElementById('demo-end-overlay');
    if (endOverlay) {
        endOverlay.style.display = 'none';
    }
}

/**
 * Reset the simulation - clears all data and restarts from initial conditions
 */
async function resetSimulation(): Promise<void> {
    console.log('Resetting simulation...');
    
    // Stop current simulation if running
    stopDemo(false);
    
    // Hide end overlay
    hideEndOverlay();
    
    // Show loading overlay briefly
    const loadingElement = document.getElementById('demo-loading');
    if (loadingElement) {
        loadingElement.style.display = 'flex';
    }
    
    // Clear charts
    initializeCharts();
    
    // Reset sliders to initial values
    const heaterSlider = document.getElementById('demo-heater-slider') as HTMLInputElement;
    const fanSlider = document.getElementById('demo-fan-slider') as HTMLInputElement;
    const heaterValue = document.getElementById('demo-heater-value');
    const fanValue = document.getElementById('demo-fan-value');
    
    if (heaterSlider && heaterValue) {
        heaterSlider.value = String(INITIAL_CONDITIONS.heaterPower * 100);
        heaterValue.textContent = Math.round(INITIAL_CONDITIONS.heaterPower * 100) + '%';
    }
    
    if (fanSlider && fanValue) {
        fanSlider.value = String(INITIAL_CONDITIONS.fanSpeed * 100);
        fanValue.textContent = Math.round(INITIAL_CONDITIONS.fanSpeed * 100) + '%';
    }
    
    // Reinitialize state
    initializeState();
    
    // Brief delay then restart
    setTimeout(async () => {
        if (loadingElement) {
            loadingElement.style.display = 'none';
        }
        
        demoState.isRunning = true;
        
        // Start simulation loop
        simulationInterval = window.setInterval(async () => {
            for (let i = 0; i < SPEEDUP; i++) {
                await stepSimulation();
            }
            updateCharts();
        }, UPDATE_INTERVAL);
        
        console.log('Simulation reset and restarted');
    }, 500);
}

// ============================================================================
// UI Event Handlers
// ============================================================================

/**
 * Set up slider controls for interactive demo
 */
function setupSliderControls(): void {
    const heaterSlider = document.getElementById('demo-heater-slider') as HTMLInputElement;
    const fanSlider = document.getElementById('demo-fan-slider') as HTMLInputElement;
    const heaterValue = document.getElementById('demo-heater-value');
    const fanValue = document.getElementById('demo-fan-value');
    
    if (heaterSlider && heaterValue) {
        heaterSlider.addEventListener('input', (e: Event) => {
            const value = parseInt((e.target as HTMLInputElement).value);
            demoState.heater = value / 100; // Convert percentage to 0-1
            heaterValue.textContent = value + '%';
        });
    }
    
    if (fanSlider && fanValue) {
        fanSlider.addEventListener('input', (e: Event) => {
            const value = parseInt((e.target as HTMLInputElement).value);
            demoState.fan = value / 100; // Convert percentage to 0-1
            fanValue.textContent = value + '%';
        });
    }
}

/**
 * Initialize the landing page
 */
function initializeLandingPage(): void {
    console.log('Initializing landing page...');
    
    // Set up slider event listeners
    setupSliderControls();
    
    // Set up reset button listener
    const resetButton = document.getElementById('demo-reset-btn');
    if (resetButton) {
        resetButton.addEventListener('click', () => {
            resetSimulation();
        });
    }
    
    // Auto-start the demo simulation after a short delay
    setTimeout(() => {
        startDemo();
    }, 500);
    
    // Smooth scroll for anchor links
    document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener('click', (e: Event) => {
            e.preventDefault();
            const href = anchor.getAttribute('href');
            if (href && href !== '#') {
                const target = document.querySelector(href);
                if (target) {
                    target.scrollIntoView({
                        behavior: 'smooth',
                        block: 'start'
                    });
                }
            }
        });
    });
    
    console.log('Landing page initialized - demo will auto-start');
}

// ============================================================================
// Entry Point
// ============================================================================

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeLandingPage);
} else {
    initializeLandingPage();
}
