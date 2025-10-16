/**
 * Coffee Roaster Digital Twin Simulator
 * 
 * This simulator uses ONNX Runtime Web to run the trained coffee roaster models
 * in the browser. It implements a complete roasting workflow with physics-based
 * simulation using the trained neural network models.
 */

class RoasterSimulator {
    constructor() {
        // ONNX Runtime sessions for each model component
        this.sessions = {
            stateEstimator: null,
            roastStepper: null,
            beanModel: null
        };
        
        // Track the selected bean model filename
        // Default to 'bean_guji.onnx' (matches the default selected option in HTML)
        this.selectedBeanModel = 'bean_guji.onnx';
        
        // Simulation state
        this.isRunning = false;
        this.simulationInterval = null;
        this.timestep = 1.5; // Fixed timestep in seconds (for physics calculations)
        this.speedupFactor = 8; // Speedup multiplier (1x = real-time, 2x = double speed, etc.) - Default to 8x
        
        // Roasting phases (simplified - no preheating)
        this.phases = {
            IDLE: 'idle',
            CHARGING: 'charging',
            ROASTING: 'roasting',
            DROPPED: 'dropped'
        };
        this.currentPhase = this.phases.IDLE;
        
        // Preheat temperature setting (°C)
        this.preheatTemp = 180.0;
        
        // Simulation data storage
        this.timeData = [];
        this.temperatureData = {
            bean: [],
            environment: [],
            roaster: [],
            air: [],
            airMeasured: []
        };
        this.controlData = {
            heater: [],
            fan: [],
            drum: []
        };
        // Rate of rise data storage (°C/min)
        this.rateOfRiseData = [];
        this.startTime = null;
        
        // Forecast data storage (120-second predictions from current timestep)
        // Stores the most recent forecast trajectory computed at each simulation step
        this.forecastData = {
            time: [],           // Time points for the forecast (relative to current time)
            bean: [],           // Predicted bean temperatures
            environment: [],    // Predicted bean surface temperatures
            roaster: [],        // Predicted roaster temperatures
            air: [],            // Predicted air temperatures
            rateOfRise: []      // Predicted rate of rise (°C/min) for bean temperature
        };
        
        // Scaling factors from dataset.py - ArtisanRoastDataset.SCALING_FACTORS
        this.scalingFactors = {
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
            mass: 100.0,            // Typical batch size ~100g
            time: 60.0              // Convert seconds to minutes
        };
        
        // Current system state [T_r, T_b, T_air, T_bm, T_atm] (normalized)
        // Initialize with preheat conditions instead of room temperature
        this.currentState = this.initializePreheatState();
        
        // Fixed parameters (ambient temperature is adjustable via slider)
        this.fixedParams = {
            drum: 0.6,        // Fixed drum speed
            ambient: 24.0,    // Ambient temperature (°C) - adjustable via slider, default 24°C
            humidity: 0.5     // Fixed humidity
        };
        
        // Control inputs (user adjustable)
        this.controls = {
            heater: 0.5,
            fan: 0.5,
            mass: 100.0  // grams
        };
        
        // Previous state for rate of rise calculation
        this.previousBeanTemp = 25.0;
        this.previousTime = 0;
        
        // Simulation time tracking (separate from wall-clock time)
        this.simulationTime = 0; // Track simulation time in seconds
        this.stepCount = 0;      // Count of simulation steps taken
        
        this.initializeUI();
    }
    
    /**
     * Initialize the user interface and event listeners
     */
    initializeUI() {
        // Control sliders
        const heaterSlider = document.getElementById('heater-slider');
        const fanSlider = document.getElementById('fan-slider');
        const massSlider = document.getElementById('mass-slider');
        const ambientSlider = document.getElementById('ambient-slider');
        const speedupSelect = document.getElementById('speedup-select');
        
        const heaterValue = document.getElementById('heater-value');
        const fanValue = document.getElementById('fan-value');
        const massValue = document.getElementById('mass-value');
        const ambientValue = document.getElementById('ambient-value');
        
        // Store references to slider elements for enabling/disabling
        this.sliderElements = {
            mass: massSlider,
            massValue: massValue,
            massStatus: document.getElementById('mass-status')
        };
        
        // Bean model selector
        const beanModelSelect = document.getElementById('bean-model-select');
        beanModelSelect.addEventListener('change', async (e) => {
            // Only allow changing bean model when idle (not during a roast)
            if (this.currentPhase !== this.phases.IDLE) {
                // Revert the selection back to the current model
                e.target.value = this.selectedBeanModel;
                alert('Please reset the simulation before changing the bean model.');
                return;
            }
            
            // Update the selected bean model
            this.selectedBeanModel = e.target.value;
            console.log(`Bean model changed to: ${this.selectedBeanModel}`);
            
            // Reload the bean model
            try {
                const beanModelPath = `onnx_models/${this.selectedBeanModel}`;
                console.log(`Loading bean model from: ${beanModelPath}`);
                this.sessions.beanModel = await ort.InferenceSession.create(beanModelPath);
                console.log('Bean model loaded successfully');
            } catch (error) {
                console.error('Error loading bean model:', error);
                this.showError('Failed to load bean model: ' + error.message);
            }
        });
        
        // Update control values and displays
        heaterSlider.addEventListener('input', (e) => {
            this.controls.heater = parseFloat(e.target.value);
            heaterValue.textContent = Math.round(this.controls.heater * 100) + '%';
        });
        
        fanSlider.addEventListener('input', (e) => {
            this.controls.fan = parseFloat(e.target.value);
            fanValue.textContent = Math.round(this.controls.fan * 100) + '%';
        });
        
        massSlider.addEventListener('input', (e) => {
            // Only update if slider is not disabled
            if (!e.target.disabled) {
                this.controls.mass = parseFloat(e.target.value);
                massValue.textContent = this.controls.mass + 'g';
            }
        });
        
        // Ambient temperature slider - updates the ambient temperature parameter
        ambientSlider.addEventListener('input', (e) => {
            this.fixedParams.ambient = parseFloat(e.target.value);
            ambientValue.textContent = this.fixedParams.ambient + '°C';
        });
        
        // Speedup control - can be changed during simulation
        speedupSelect.addEventListener('change', (e) => {
            this.speedupFactor = parseFloat(e.target.value);
            console.log(`Simulation speed changed to ${this.speedupFactor}x`);
            
            // If simulation is running, restart the interval with new timing
            if (this.isRunning && this.simulationInterval) {
                clearInterval(this.simulationInterval);
                // Calculate new interval: base timestep divided by speedup factor
                const intervalMs = (this.timestep * 1000) / this.speedupFactor;
                this.simulationInterval = setInterval(() => this.simulationStep(), intervalMs);
            }
        });
        
        // Action buttons (removed preheat button)
        document.getElementById('charge-btn').addEventListener('click', () => this.chargeBeans());
        document.getElementById('drop-btn').addEventListener('click', () => this.dropBeans());
        document.getElementById('reset-btn').addEventListener('click', () => this.reset());
        
        // Initialize charts
        this.initializeCharts();
    }
    
    /**
     * Load all ONNX models
     */
    async loadModels() {
        try {
            console.log('Loading ONNX models...');
            
            // Load each model component (no observer model needed)
            this.sessions.stateEstimator = await ort.InferenceSession.create('onnx_models/state_estimator.onnx');
            this.sessions.roastStepper = await ort.InferenceSession.create('onnx_models/roast_stepper.onnx');
            
            // Load the selected bean model (uses this.selectedBeanModel which defaults to 'bean_guji.onnx')
            const beanModelPath = `onnx_models/${this.selectedBeanModel}`;
            console.log(`Loading bean model from: ${beanModelPath}`);
            this.sessions.beanModel = await ort.InferenceSession.create(beanModelPath);
            
            console.log('All ONNX models loaded successfully');
            
            // Hide loading message and show interface
            document.getElementById('loading').style.display = 'none';
            document.getElementById('roast-phase').style.display = 'block';
            
            this.updatePhaseDisplay();
            
        } catch (error) {
            console.error('Error loading ONNX models:', error);
            this.showError('Failed to load ONNX models: ' + error.message);
        }
    }
    
    /**
     * Show error message to user
     */
    showError(message) {
        const errorDiv = document.getElementById('error');
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        document.getElementById('loading').style.display = 'none';
    }
    
    /**
     * Initialize state with preheat conditions
     * T_bm = preheat temp (180°C)
     * T_air = T_bm = 180°C  
     * T_roaster = T_bm + 50°C = 230°C
     * T_b = room temperature = 25°C
     * T_atm = measured air temp = T_air = 180°C
     */
    initializePreheatState() {
        const roomTemp = 25.0; // °C
        const preheatTemp = this.preheatTemp; // 180°C
        const roasterTemp = preheatTemp + 50.0; // 230°C
        const airTemp = preheatTemp - 40.0; // 180°C
        const measuredAirTemp = preheatTemp; // 180°C (T_atm - measured air temperature)
        
        // Normalize temperatures using scaling factor
        const tempScale = this.scalingFactors.temperatures.bean;
        
        return new Float32Array([
            roasterTemp / tempScale,     // T_r (roaster temperature)
            roomTemp / tempScale,        // T_b (bean core temperature - starts at room temp)
            airTemp / tempScale,         // T_air (air temperature)
            preheatTemp / tempScale,     // T_bm (bean measurement temperature)
            measuredAirTemp / tempScale  // T_atm (measured air temperature)
        ]);
    }

    /**
     * Initialize Plotly charts
     */
    initializeCharts() {
        // Temperature chart with dual y-axis (temperature + rate of rise)
        const tempLayout = {
            title: 'Temperature Profile & Rate of Rise',
            xaxis: { title: 'Time (minutes)' },
            yaxis: { 
                title: 'Temperature (°C)',
                side: 'left'
            },
            yaxis2: {
                title: 'Rate of Rise (°C/min)',
                side: 'right',
                overlaying: 'y',
                showgrid: false,
                zeroline: true,
                zerolinecolor: '#666',
                zerolinewidth: 1,
                range: [0, null]  // Set minimum to 0, let maximum auto-scale
            },
            showlegend: true,
            margin: { t: 50, r: 80, b: 50, l: 50 }  // Increased right margin for second y-axis
        };
        
        const tempData = [
            {
                x: [],
                y: [],
                name: 'Bean Probe',
                line: { color: '#8B4513', width: 3 },
                yaxis: 'y'  // Use left y-axis
            },
            {
                x: [],
                y: [],
                name: 'Bean Surface',
                line: { color: '#FF6B35', width: 2 },
                yaxis: 'y'  // Use left y-axis
            },
            {
                x: [],
                y: [],
                name: 'Drum',
                line: { color: '#4ECDC4', width: 2 },
                yaxis: 'y'  // Use left y-axis
            },
            {
                x: [],
                y: [],
                name: 'Env. Probe',
                line: { color: '#45B7D1', width: 2 },
                yaxis: 'y'  // Use left y-axis
            },
            {
                x: [],
                y: [],
                name: 'Rate of Rise',
                line: { color: '#FF1493', width: 2, dash: 'dot' },
                yaxis: 'y2'  // Use right y-axis
            },
            {
                x: [],
                y: [],
                name: 'Bean Forecast',
                line: { color: '#8B4513', width: 2, dash: 'dash' },
                yaxis: 'y',
                opacity: 0.6,
                showlegend: false  // Hide from legend
            },
            {
                x: [],
                y: [],
                name: 'Surface Forecast',
                line: { color: '#FF6B35', width: 1.5, dash: 'dash' },
                yaxis: 'y',
                opacity: 0.5,
                showlegend: false  // Hide from legend
            },
            {
                x: [],
                y: [],
                name: 'Drum Forecast',
                line: { color: '#4ECDC4', width: 1.5, dash: 'dash' },
                yaxis: 'y',
                opacity: 0.5,
                showlegend: false  // Hide from legend
            },
            {
                x: [],
                y: [],
                name: 'Air Forecast',
                line: { color: '#45B7D1', width: 1.5, dash: 'dash' },
                yaxis: 'y',
                opacity: 0.5,
                showlegend: false  // Hide from legend
            },
            {
                x: [],
                y: [],
                name: 'RoR Forecast',
                line: { color: '#FF1493', width: 2, dash: 'dash' },
                yaxis: 'y2',  // Use right y-axis (rate of rise axis)
                opacity: 0.6,
                showlegend: false  // Hide from legend
            }
        ];
        
        Plotly.newPlot('temperature-chart', tempData, tempLayout, {responsive: true});
        
        // Control chart
        const controlLayout = {
            title: 'Control Inputs',
            xaxis: { title: 'Time (minutes)' },
            yaxis: { title: 'Control Value (0-1)', range: [0, 1] },
            showlegend: true,
            margin: { t: 50, r: 50, b: 50, l: 50 }
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
        
        Plotly.newPlot('control-chart', controlData, controlLayout, {responsive: true});
    }
    
    /**
     * Update the phase display (simplified without preheat)
     */
    updatePhaseDisplay() {
        const phaseDiv = document.getElementById('roast-phase');
        const chargeBtn = document.getElementById('charge-btn');
        const dropBtn = document.getElementById('drop-btn');
        
        // Reset button states
        chargeBtn.disabled = true;
        dropBtn.disabled = true;
        
        switch (this.currentPhase) {
            case this.phases.IDLE:
                phaseDiv.textContent = `IDLE - Roaster Preheated to ${this.preheatTemp}°C`;
                phaseDiv.className = 'roast-phase phase-charging';
                chargeBtn.disabled = false;
                // Enable mass slider when idle
                this.setMassSliderEnabled(true);
                break;
                
            case this.phases.CHARGING:
                phaseDiv.textContent = 'CHARGING - Adding Beans';
                phaseDiv.className = 'roast-phase phase-charging';
                chargeBtn.disabled = true;
                // Disable mass slider once charging starts
                this.setMassSliderEnabled(false);
                break;
                
            case this.phases.ROASTING:
                phaseDiv.textContent = 'ROASTING - Beans in Progress';
                phaseDiv.className = 'roast-phase phase-roasting';
                chargeBtn.disabled = true;
                dropBtn.disabled = false;
                // Keep mass slider disabled during roasting
                this.setMassSliderEnabled(false);
                break;
                
            case this.phases.DROPPED:
                phaseDiv.textContent = 'DROPPED - Roast Complete';
                phaseDiv.className = 'roast-phase phase-dropped';
                chargeBtn.disabled = true;
                dropBtn.disabled = true;
                // Keep mass slider disabled after dropping
                this.setMassSliderEnabled(false);
                break;
        }
    }
    
    /**
     * Enable or disable the mass slider
     * @param {boolean} enabled - Whether the mass slider should be enabled
     */
    setMassSliderEnabled(enabled) {
        if (this.sliderElements) {
            this.sliderElements.mass.disabled = !enabled;
            
            // Update visual styling to indicate disabled state
            if (enabled) {
                this.sliderElements.mass.style.opacity = '1';
                this.sliderElements.mass.style.cursor = 'pointer';
                this.sliderElements.massValue.style.opacity = '1';
                this.sliderElements.massStatus.style.color = '#666';
            } else {
                this.sliderElements.mass.style.opacity = '0.5';
                this.sliderElements.mass.style.cursor = 'not-allowed';
                this.sliderElements.massValue.style.opacity = '0.7';
                this.sliderElements.massStatus.style.color = '#8B4513';
            }
        }
    }
    
    /**
     * Charge beans into the roaster and start simulation
     */
    chargeBeans() {
        console.log(`Charging beans (${this.controls.mass}g)...`);
        this.currentPhase = this.phases.CHARGING;
        this.updatePhaseDisplay();
        
        // Initialize simulation data
        this.timeData = [];
        this.temperatureData = { bean: [], environment: [], roaster: [], air: [], airMeasured: [] };
        this.controlData = { heater: [], fan: [], drum: [] };
        this.rateOfRiseData = [];  // Clear rate of rise data
        this.startTime = Date.now();
        
        // Reset simulation time tracking
        this.simulationTime = 0;
        this.stepCount = 0;
        
        // Reset state to preheat conditions
        this.currentState = this.initializePreheatState();
        
        // Start simulation loop with speedup factor
        this.isRunning = true;
        // Calculate interval: base timestep divided by speedup factor
        const intervalMs = (this.timestep * 1000) / this.speedupFactor;
        this.simulationInterval = setInterval(() => this.simulationStep(), intervalMs);
        
        console.log(`Starting simulation at ${this.speedupFactor}x speed (interval: ${intervalMs}ms) with ${this.controls.mass}g of beans`);
        
        // Simulate charging process (brief transition)
        setTimeout(() => {
            this.currentPhase = this.phases.ROASTING;
            this.updatePhaseDisplay();
        }, 2000);
    }
    
    /**
     * Drop beans from the roaster
     */
    dropBeans() {
        console.log('Dropping beans...');
        this.currentPhase = this.phases.DROPPED;
        this.updatePhaseDisplay();
        
        // Stop simulation after a brief delay
        setTimeout(() => {
            this.isRunning = false;
            if (this.simulationInterval) {
                clearInterval(this.simulationInterval);
                this.simulationInterval = null;
            }
        }, 1000);
    }
    
    /**
     * Reset the simulation
     */
    reset() {
        console.log('Resetting simulation...');
        
        // Stop simulation
        this.isRunning = false;
        if (this.simulationInterval) {
            clearInterval(this.simulationInterval);
            this.simulationInterval = null;
        }
        
        // Reset state
        this.currentPhase = this.phases.IDLE;
        this.currentState = this.initializePreheatState();
        this.previousBeanTemp = this.preheatTemp; // Start from preheat temperature
        this.previousTime = 0;
        
        // Clear data
        this.timeData = [];
        this.temperatureData = { bean: [], environment: [], roaster: [], air: [], airMeasured: [] };
        this.controlData = { heater: [], fan: [], drum: [] };
        this.rateOfRiseData = [];  // Clear rate of rise data
        
        // Reset simulation time tracking
        this.simulationTime = 0;
        this.stepCount = 0;
        
        // Update UI
        this.updatePhaseDisplay();
        this.updateStatusDisplay();
        this.updateCharts();
    }
    
    /**
     * Perform one simulation step (simplified without StateEstimator)
     */
    async simulationStep() {
        if (!this.isRunning) return;
        
        try {
            // Update simulation time tracking (independent of wall-clock time)
            // Each step advances simulation time by the physics timestep
            this.simulationTime += this.timestep; // Add timestep in seconds
            this.stepCount += 1;
            const currentTimeMinutes = this.simulationTime / 60; // Convert to minutes for plotting
            
            // Determine if beans are present based on phase
            // Beans should be present during both CHARGING and ROASTING phases
            const beansPresent = this.currentPhase === this.phases.CHARGING || this.currentPhase === this.phases.ROASTING;
            const massValue = beansPresent ? this.controls.mass : 0.0;
            
            // Get bean thermal capacity from bean model if beans are present
            let beanCapacity = 0.5; // Default thermal capacity (normalized)
            if (beansPresent && this.sessions.beanModel) {
                const beanModelResult = await this.sessions.beanModel.run({
                    bean_temperature: new ort.Tensor('float32', [this.currentState[1]], [1, 1])
                });
                beanCapacity = beanModelResult.thermal_capacity.data[0];
            }
            
            // Prepare controls for roast stepper
            // Based on DrumRoasterExtended.forward() in models.py: [heater, fan, drum, T_amb, humidity, mass, C_b]
            const stepperControls = new Float32Array(7);
            stepperControls[0] = this.controls.heater;  // Already 0-1
            stepperControls[1] = this.controls.fan;     // Already 0-1
            stepperControls[2] = this.fixedParams.drum; // Already 0-1 (0.6)
            stepperControls[3] = this.fixedParams.ambient / this.scalingFactors.controls.ambient;  // Scale temperature
            stepperControls[4] = this.fixedParams.humidity / this.scalingFactors.controls.humidity; // Scale humidity
            stepperControls[5] = massValue / this.scalingFactors.mass;  // Scale mass
            stepperControls[6] = beanCapacity;  // Bean thermal capacity
            
            // Time step (normalized)
            const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
            
            // Run roast stepper to get next state (now expects 5-dimensional state)
            const stepperResult = await this.sessions.roastStepper.run({
                current_state: new ort.Tensor('float32', this.currentState, [1, 5]),
                current_controls: new ort.Tensor('float32', stepperControls, [1, 7]),
                dt: new ort.Tensor('float32', dt, [1, 1])
            });
            
            // Update current state
            this.currentState = new Float32Array(stepperResult.next_state.data);
            
            // Store data for plotting
            this.timeData.push(currentTimeMinutes);
            const currentBeanTemp = this.denormalizeTemperature(this.currentState[3]); // T_bm (Bean Temperature Measured)
            this.temperatureData.bean.push(currentBeanTemp);
            this.temperatureData.environment.push(this.denormalizeTemperature(this.currentState[1])); // T_b (Bean Core Temperature)
            this.temperatureData.roaster.push(this.denormalizeTemperature(this.currentState[0])); // T_r (Roaster Temperature)
            this.temperatureData.air.push(this.denormalizeTemperature(this.currentState[2])); // T_air (Air Temperature)
            this.temperatureData.airMeasured.push(this.denormalizeTemperature(this.currentState[4])); // T_atm (Measured Air Temperature)
            
            // Calculate rate of rise (°C/min) for plotting
            // For the first data point, rate of rise is 0
            if (this.timeData.length === 1) {
                this.rateOfRiseData.push(0);
            } else {
                // Calculate rate of rise based on the last two data points
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
            
            // Compute 120-second forecast from current state
            // This inner loop predicts the next 120 seconds using current control inputs
            if (beansPresent) {
                const forecast = await this.compute60SecondForecast();
                this.forecastData.time = forecast.time;
                this.forecastData.bean = forecast.bean;
                this.forecastData.environment = forecast.environment;
                this.forecastData.roaster = forecast.roaster;
                this.forecastData.air = forecast.air;
                this.forecastData.rateOfRise = forecast.rateOfRise;
            } else {
                // Clear forecast if no beans present
                this.forecastData.time = [];
                this.forecastData.bean = [];
                this.forecastData.environment = [];
                this.forecastData.roaster = [];
                this.forecastData.air = [];
                this.forecastData.rateOfRise = [];
            }
            
            // Update UI
            this.updateStatusDisplay();
            this.updateCharts();
            
        } catch (error) {
            console.error('Simulation step error:', error);
            this.showError('Simulation error: ' + error.message);
            this.isRunning = false;
            if (this.simulationInterval) {
                clearInterval(this.simulationInterval);
                this.simulationInterval = null;
            }
        }
    }
    
    /**
     * Compute 120-second forecast from current state using current control inputs
     * This is an inner loop that predicts future temperatures over the next 120 seconds
     * using the control inputs fixed at their current values
     * 
     * @returns {Object} forecast - Object containing time and temperature arrays for all state variables
     */
    async compute60SecondForecast() {
        const forecastHorizon = 240; // seconds into the future
        const forecastSteps = Math.ceil(forecastHorizon / this.timestep); // Number of steps to forecast
        
        // Arrays to store forecast trajectory for all state variables
        const forecastTime = [];           // Time points in minutes (relative to current simulation time)
        const forecastBeanTemp = [];       // Predicted bean probe temperatures (T_bm) in °C
        const forecastEnvironmentTemp = []; // Predicted bean surface temperatures (T_b) in °C
        const forecastRoasterTemp = [];    // Predicted roaster temperatures (T_r) in °C
        const forecastAirTemp = [];        // Predicted air temperatures (T_air) in °C
        
        // Create a copy of current state to use for forecasting
        // We don't want to modify the actual simulation state
        let forecastState = new Float32Array(this.currentState);
        
        // Determine if beans are present (same logic as main simulation)
        const beansPresent = this.currentPhase === this.phases.CHARGING || this.currentPhase === this.phases.ROASTING;
        const massValue = beansPresent ? this.controls.mass : 0.0;
        
        // Get current bean thermal capacity (will be updated in the loop)
        let beanCapacity = 0.5; // Default
        if (beansPresent && this.sessions.beanModel) {
            const beanModelResult = await this.sessions.beanModel.run({
                bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
            });
            beanCapacity = beanModelResult.thermal_capacity.data[0];
        }
        
        // Prepare control inputs (fixed at current values for the entire forecast)
        // Shape: [heater, fan, drum, T_amb, humidity, mass, C_b]
        const forecastControls = new Float32Array(7);
        forecastControls[0] = this.controls.heater;  // Current heater setting
        forecastControls[1] = this.controls.fan;     // Current fan setting
        forecastControls[2] = this.fixedParams.drum; // Fixed drum speed
        forecastControls[3] = this.fixedParams.ambient / this.scalingFactors.controls.ambient;
        forecastControls[4] = this.fixedParams.humidity / this.scalingFactors.controls.humidity;
        forecastControls[5] = massValue / this.scalingFactors.mass;
        
        // Normalized timestep for model
        const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
        
        // Run forecast loop: iterate forward in time using the roast stepper
        for (let step = 0; step < forecastSteps; step++) {
            // Update bean capacity based on current forecast state
            if (beansPresent && this.sessions.beanModel) {
                const beanModelResult = await this.sessions.beanModel.run({
                    bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
                });
                beanCapacity = beanModelResult.thermal_capacity.data[0];
                forecastControls[6] = beanCapacity;  // Update bean thermal capacity
            } else {
                forecastControls[6] = beanCapacity;
            }
            
            // Predict next state using roast stepper
            const stepperResult = await this.sessions.roastStepper.run({
                current_state: new ort.Tensor('float32', forecastState, [1, 5]),
                current_controls: new ort.Tensor('float32', forecastControls, [1, 7]),
                dt: new ort.Tensor('float32', dt, [1, 1])
            });
            
            // Update forecast state for next iteration
            forecastState = new Float32Array(stepperResult.next_state.data);
            
            // Store forecast data point
            // Time is relative to current simulation time (in minutes)
            const forecastTimePoint = this.simulationTime / 60 + (step + 1) * this.timestep / 60;
            forecastTime.push(forecastTimePoint);
            
            // Extract and denormalize all state variables
            // State vector: [T_r, T_b, T_air, T_bm, T_atm]
            forecastRoasterTemp.push(this.denormalizeTemperature(forecastState[0]));      // T_r (roaster)
            forecastEnvironmentTemp.push(this.denormalizeTemperature(forecastState[1]));  // T_b (bean surface)
            forecastAirTemp.push(this.denormalizeTemperature(forecastState[2]));          // T_air (air)
            forecastBeanTemp.push(this.denormalizeTemperature(forecastState[3]));         // T_bm (bean probe)
        }
        
        // Calculate rate of rise for the forecast
        // Rate of rise (°C/min) is the change in temperature divided by the change in time
        const forecastRateOfRise = [];
        for (let i = 0; i < forecastBeanTemp.length; i++) {
            if (i === 0) {
                // For the first forecast point, calculate RoR from current actual temperature to first forecast
                const currentBeanTemp = this.denormalizeTemperature(this.currentState[3]);
                const timeDiff = forecastTime[0] - (this.simulationTime / 60);
                const tempDiff = forecastBeanTemp[0] - currentBeanTemp;
                const rateOfRise = timeDiff > 0 ? tempDiff / timeDiff : 0;
                forecastRateOfRise.push(rateOfRise);
            } else {
                // For subsequent points, calculate RoR between consecutive forecast points
                const timeDiff = forecastTime[i] - forecastTime[i - 1];
                const tempDiff = forecastBeanTemp[i] - forecastBeanTemp[i - 1];
                const rateOfRise = timeDiff > 0 ? tempDiff / timeDiff : 0;
                forecastRateOfRise.push(rateOfRise);
            }
        }
        
        return {
            time: forecastTime,
            bean: forecastBeanTemp,
            environment: forecastEnvironmentTemp,
            roaster: forecastRoasterTemp,
            air: forecastAirTemp,
            rateOfRise: forecastRateOfRise
        };
    }
    
    /**
     * Convert normalized temperature back to Celsius
     */
    denormalizeTemperature(normalizedTemp) {
        return normalizedTemp * this.scalingFactors.temperatures.bean;
    }
    
    /**
     * Update status display
     */
    updateStatusDisplay() {
        if (this.timeData.length === 0) {
            // Display initial preheat values
            document.getElementById('bean-temp').textContent = this.preheatTemp + '°C';
            document.getElementById('env-temp').textContent = (this.preheatTemp + 30) + '°C';
            document.getElementById('roaster-temp').textContent = (this.preheatTemp + 50) + '°C';
            document.getElementById('air-temp').textContent = (this.preheatTemp) + '°C';
            document.getElementById('air-temp-measured').textContent = (this.preheatTemp) + '°C';
            document.getElementById('roast-time').textContent = '00:00';
            document.getElementById('rate-of-rise').textContent = '0°C/min';
            return;
        }
        
        const latest = this.timeData.length - 1;
        const currentTime = this.timeData[latest];
        const currentBeanTemp = this.temperatureData.bean[latest];
        
        // Update temperature displays
        document.getElementById('bean-temp').textContent = Math.round(currentBeanTemp) + '°C';
        document.getElementById('env-temp').textContent = Math.round(this.temperatureData.environment[latest]) + '°C';
        document.getElementById('roaster-temp').textContent = Math.round(this.temperatureData.roaster[latest]) + '°C';
        document.getElementById('air-temp').textContent = Math.round(this.temperatureData.air[latest]) + '°C';
        document.getElementById('air-temp-measured').textContent = Math.round(this.temperatureData.airMeasured[latest]) + '°C';
        
        // Update time display
        const minutes = Math.floor(currentTime);
        const seconds = Math.floor((currentTime - minutes) * 60);
        document.getElementById('roast-time').textContent = 
            String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
        
        // Calculate and display rate of rise (°C/min)
        if (this.timeData.length > 1) {
            const timeDiff = currentTime - this.previousTime;
            const tempDiff = currentBeanTemp - this.previousBeanTemp;
            const rateOfRise = timeDiff > 0 ? tempDiff / timeDiff : 0;
            document.getElementById('rate-of-rise').textContent = rateOfRise.toFixed(1) + '°C/min';
            
            this.previousTime = currentTime;
            this.previousBeanTemp = currentBeanTemp;
        }
    }
    
    /**
     * Update Plotly charts
     */
    updateCharts() {
        // Calculate xlimit: maximum of 10 minutes or (last time stamp) + forecast horizon
        let xlimit = 10; // Default minimum of 10 minutes
        if (this.timeData.length > 0) {
            const lastTimeStamp = this.timeData[this.timeData.length - 1];
            // If we have forecast data, extend to the end of the forecast
            // Otherwise, add 1 minute as a buffer
            if (this.forecastData.time.length > 0) {
                const lastForecastTime = this.forecastData.time[this.forecastData.time.length - 1];
                xlimit = Math.max(10, lastForecastTime + 0.5); // Add 0.5 minute buffer beyond forecast
            } else {
                xlimit = Math.max(10, lastTimeStamp + 1);
            }
        }
        
        // Calculate ylimit for temperature chart: maximum of 200°C and (max temperature + 25°C)
        let ylimit = 200; // Default minimum of 200°C
        if (this.timeData.length > 0) {
            // Find maximum temperature across all temperature data arrays
            const allTemps = [
                ...this.temperatureData.bean,
                ...this.temperatureData.environment,
                ...this.temperatureData.roaster,
                ...this.temperatureData.air
            ];
            const maxTemp = Math.max(...allTemps);
            ylimit = Math.max(200, maxTemp + 25);
        }
        
        // Update temperature chart (including rate of rise on second y-axis and all forecasts)
        const tempUpdate = {
            x: [
                this.timeData, this.timeData, this.timeData, this.timeData, this.timeData,
                this.forecastData.time, this.forecastData.time, this.forecastData.time, this.forecastData.time, this.forecastData.time
            ],
            y: [
                this.temperatureData.bean,
                this.temperatureData.environment,
                this.temperatureData.roaster,
                this.temperatureData.air,
                this.rateOfRiseData,           // Rate of rise (5th trace, second y-axis)
                this.forecastData.bean,        // Bean forecast (6th trace)
                this.forecastData.environment, // Surface forecast (7th trace)
                this.forecastData.roaster,     // Drum forecast (8th trace)
                this.forecastData.air,         // Air forecast (9th trace)
                this.forecastData.rateOfRise   // Rate of rise forecast (10th trace, second y-axis)
            ]
        };
        Plotly.restyle('temperature-chart', tempUpdate);
        
        // Calculate y2limit for rate of rise: maximum of 10°C/min and (max rate of rise + 2°C/min)
        let y2limit = 10; // Default minimum of 10°C/min
        if (this.rateOfRiseData.length > 0) {
            const maxRateOfRise = Math.max(...this.rateOfRiseData);
            y2limit = Math.max(10, maxRateOfRise + 2);
        }
        
        // Add vertical line at current time to mark forecast boundary
        const currentTimeMinutes = this.timeData.length > 0 ? this.timeData[this.timeData.length - 1] : 0;
        const shapes = this.timeData.length > 0 ? [{
            type: 'line',
            x0: currentTimeMinutes,
            x1: currentTimeMinutes,
            y0: 0,
            y1: 1,
            yref: 'paper',  // Use paper coordinates (0-1) for y-axis to span full height
            line: {
                color: 'rgba(0, 0, 0, 0.3)',
                width: 2,
                dash: 'dot'
            }
        }] : [];
        
        // Update temperature chart axis ranges and add vertical line
        const tempLayoutUpdate = {
            'xaxis.range': [0, xlimit],
            'yaxis.range': [0, ylimit],
            'yaxis2.range': [0, y2limit],  // Ensure second y-axis starts at 0
            shapes: shapes  // Add vertical line marking current time
        };
        Plotly.relayout('temperature-chart', tempLayoutUpdate);
        
        // Update control chart
        const controlUpdate = {
            x: [this.timeData, this.timeData, this.timeData],
            y: [
                this.controlData.heater,
                this.controlData.fan,
                this.controlData.drum
            ]
        };
        Plotly.restyle('control-chart', controlUpdate);
        
        // Add vertical line at current time to control chart as well
        const controlShapes = this.timeData.length > 0 ? [{
            type: 'line',
            x0: currentTimeMinutes,
            x1: currentTimeMinutes,
            y0: 0,
            y1: 1,
            yref: 'paper',  // Use paper coordinates (0-1) for y-axis to span full height
            line: {
                color: 'rgba(0, 0, 0, 0.3)',
                width: 2,
                dash: 'dot'
            }
        }] : [];
        
        // Update control chart x-axis range and add vertical line
        const controlLayoutUpdate = {
            'xaxis.range': [0, xlimit],
            shapes: controlShapes  // Add vertical line marking current time
        };
        Plotly.relayout('control-chart', controlLayoutUpdate);
    }
}

// Initialize the simulator when the page loads
let simulator;

// Overlay management functions - ensure they're in global scope
window.closeInfoOverlay = function() {
    const overlay = document.getElementById('info-overlay');
    if (overlay) {
        overlay.classList.add('hidden');
        console.log('Overlay closed'); // Debug logging
    }
};

window.showInfoOverlay = function() {
    const overlay = document.getElementById('info-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        console.log('Overlay shown'); // Debug logging
    }
};

// Initialize overlay functionality when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    console.log('DOM loaded, setting up overlay event listeners');
    
    // Set up click-outside-to-close functionality
    const overlay = document.getElementById('info-overlay');
    const modal = document.querySelector('.info-modal');
    const closeButton = document.querySelector('.close-button');
    const startButton = document.querySelector('.get-started-button');
    
    if (overlay) {
        overlay.addEventListener('click', function(e) {
            // Only close if clicking on the overlay itself (not the modal content)
            if (e.target === overlay) {
                window.closeInfoOverlay();
            }
        });
    }
    
    // Set up close button functionality
    if (closeButton) {
        closeButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            window.closeInfoOverlay();
        });
    }
    
    // Set up start button functionality
    if (startButton) {
        startButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            window.closeInfoOverlay();
        });
    }
    
    // Set up info button functionality
    const infoButton = document.getElementById('info-button');
    if (infoButton) {
        infoButton.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            window.showInfoOverlay();
        });
    }
    
    // Set up escape key functionality
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            const overlay = document.getElementById('info-overlay');
            if (overlay && !overlay.classList.contains('hidden')) {
                window.closeInfoOverlay();
            }
        }
    });
    
    // Mobile menu toggle functionality
    const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
    const sidebar = document.getElementById('sidebar');
    
    if (mobileMenuToggle && sidebar) {
        // Toggle sidebar when hamburger menu is clicked
        mobileMenuToggle.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            sidebar.classList.toggle('active');
            
            // Update button appearance when sidebar is open
            if (sidebar.classList.contains('active')) {
                mobileMenuToggle.textContent = '✕'; // Change to X when open
            } else {
                mobileMenuToggle.textContent = '☰'; // Change back to hamburger when closed
            }
        });
        
        // Close sidebar when clicking outside of it on mobile
        document.addEventListener('click', function(e) {
            // Check if click is outside sidebar and toggle button
            if (sidebar.classList.contains('active') && 
                !sidebar.contains(e.target) && 
                !mobileMenuToggle.contains(e.target)) {
                sidebar.classList.remove('active');
                mobileMenuToggle.textContent = '☰';
            }
        });
        
        // Close sidebar when clicking on buttons inside it (like Add Beans, Stop, Reset)
        // This improves UX on mobile - after user clicks a button, they probably want to see the charts
        const sidebarButtons = sidebar.querySelectorAll('button');
        sidebarButtons.forEach(button => {
            // Only auto-close for action buttons, not the info button
            if (button.id !== 'info-button') {
                button.addEventListener('click', function() {
                    // Check if we're on mobile (sidebar has active class capability)
                    if (window.innerWidth <= 768 && sidebar.classList.contains('active')) {
                        sidebar.classList.remove('active');
                        mobileMenuToggle.textContent = '☰';
                    }
                });
            }
        });
    }
});

window.addEventListener('load', async () => {
    console.log('Page loaded, initializing simulator');
    simulator = new RoasterSimulator();
    await simulator.loadModels();
    
    // Show the info overlay when the page loads
    // Longer delay to ensure everything is ready on hosted environments
    setTimeout(() => {
        console.log('Showing initial overlay');
        window.showInfoOverlay();
    }, 500);
});
