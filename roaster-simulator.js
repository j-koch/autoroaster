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
            observer: null,
            roastStepper: null,
            beanModel: null
        };
        
        // Simulation state
        this.isRunning = false;
        this.simulationInterval = null;
        this.timestep = 1.5; // Fixed timestep in seconds
        
        // Roasting phases
        this.phases = {
            IDLE: 'idle',
            PREHEATING: 'preheating', 
            READY: 'ready',
            CHARGING: 'charging',
            ROASTING: 'roasting',
            DROPPED: 'dropped'
        };
        this.currentPhase = this.phases.IDLE;
        
        // Simulation data storage
        this.timeData = [];
        this.temperatureData = {
            bean: [],
            environment: [],
            roaster: [],
            air: []
        };
        this.controlData = {
            heater: [],
            fan: [],
            drum: []
        };
        this.startTime = null;
        
        // Current system state [T_r, T_b, T_air, T_bm] (normalized)
        this.currentState = new Float32Array([0.25, 0.25, 0.25, 0.25]); // Start at 25°C normalized
        
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
        
        // Fixed parameters
        this.fixedParams = {
            drum: 0.6,        // Fixed drum speed
            ambient: 24.0,    // Fixed ambient temperature (°C)
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
        
        const heaterValue = document.getElementById('heater-value');
        const fanValue = document.getElementById('fan-value');
        const massValue = document.getElementById('mass-value');
        
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
            this.controls.mass = parseFloat(e.target.value);
            massValue.textContent = this.controls.mass + 'g';
        });
        
        // Action buttons
        document.getElementById('preheat-btn').addEventListener('click', () => this.startPreheat());
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
            
            // Load each model component
            this.sessions.stateEstimator = await ort.InferenceSession.create('onnx_models/state_estimator.onnx');
            this.sessions.observer = await ort.InferenceSession.create('onnx_models/observer.onnx');
            this.sessions.roastStepper = await ort.InferenceSession.create('onnx_models/roast_stepper.onnx');
            this.sessions.beanModel = await ort.InferenceSession.create('onnx_models/bean_model.onnx');
            
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
     * Initialize Plotly charts
     */
    initializeCharts() {
        // Temperature chart
        const tempLayout = {
            title: 'Temperature Profile',
            xaxis: { title: 'Time (minutes)' },
            yaxis: { title: 'Temperature (°C)' },
            showlegend: true,
            margin: { t: 50, r: 50, b: 50, l: 50 }
        };
        
        const tempData = [
            {
                x: [],
                y: [],
                name: 'Bean Temperature',
                line: { color: '#8B4513', width: 3 }
            },
            {
                x: [],
                y: [],
                name: 'Environment Temperature',
                line: { color: '#FF6B35', width: 2 }
            },
            {
                x: [],
                y: [],
                name: 'Roaster Temperature',
                line: { color: '#4ECDC4', width: 2 }
            },
            {
                x: [],
                y: [],
                name: 'Air Temperature',
                line: { color: '#45B7D1', width: 2 }
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
                name: 'Heater Power',
                line: { color: '#FF4444', width: 2 }
            },
            {
                x: [],
                y: [],
                name: 'Fan Speed',
                line: { color: '#4444FF', width: 2 }
            },
            {
                x: [],
                y: [],
                name: 'Drum Speed (Fixed)',
                line: { color: '#888888', width: 2, dash: 'dash' }
            }
        ];
        
        Plotly.newPlot('control-chart', controlData, controlLayout, {responsive: true});
    }
    
    /**
     * Update the phase display
     */
    updatePhaseDisplay() {
        const phaseDiv = document.getElementById('roast-phase');
        const preheatBtn = document.getElementById('preheat-btn');
        const chargeBtn = document.getElementById('charge-btn');
        const dropBtn = document.getElementById('drop-btn');
        
        // Reset button states
        preheatBtn.disabled = false;
        chargeBtn.disabled = true;
        dropBtn.disabled = true;
        
        switch (this.currentPhase) {
            case this.phases.IDLE:
                phaseDiv.textContent = 'IDLE - Ready to Start';
                phaseDiv.className = 'roast-phase phase-preheat';
                preheatBtn.textContent = 'Start Preheat';
                break;
                
            case this.phases.PREHEATING:
                phaseDiv.textContent = 'PREHEATING - Warming Up Roaster';
                phaseDiv.className = 'roast-phase phase-preheat';
                preheatBtn.disabled = true;
                break;
                
            case this.phases.READY:
                phaseDiv.textContent = 'READY - Roaster Preheated';
                phaseDiv.className = 'roast-phase phase-charging';
                preheatBtn.disabled = true;
                chargeBtn.disabled = false;
                break;
                
            case this.phases.CHARGING:
                phaseDiv.textContent = 'CHARGING - Adding Beans';
                phaseDiv.className = 'roast-phase phase-charging';
                preheatBtn.disabled = true;
                chargeBtn.disabled = true;
                break;
                
            case this.phases.ROASTING:
                phaseDiv.textContent = 'ROASTING - Beans in Progress';
                phaseDiv.className = 'roast-phase phase-roasting';
                preheatBtn.disabled = true;
                chargeBtn.disabled = true;
                dropBtn.disabled = false;
                break;
                
            case this.phases.DROPPED:
                phaseDiv.textContent = 'DROPPED - Roast Complete';
                phaseDiv.className = 'roast-phase phase-dropped';
                preheatBtn.disabled = true;
                chargeBtn.disabled = true;
                dropBtn.disabled = true;
                break;
        }
    }
    
    /**
     * Start the preheating process
     */
    startPreheat() {
        console.log('Starting preheat...');
        this.currentPhase = this.phases.PREHEATING;
        this.updatePhaseDisplay();
        
        // Initialize simulation data
        this.timeData = [];
        this.temperatureData = { bean: [], environment: [], roaster: [], air: [] };
        this.controlData = { heater: [], fan: [], drum: [] };
        this.startTime = Date.now();
        
        // Set initial state to room temperature (normalized)
        this.currentState = new Float32Array([0.25, 0.25, 0.25, 0.25]); // 25°C normalized
        
        // Start simulation loop
        this.isRunning = true;
        this.simulationInterval = setInterval(() => this.simulationStep(), this.timestep * 1000);
    }
    
    /**
     * Charge beans into the roaster
     */
    chargeBeans() {
        console.log('Charging beans...');
        this.currentPhase = this.phases.CHARGING;
        this.updatePhaseDisplay();
        
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
        this.currentState = new Float32Array([0.25, 0.25, 0.25, 0.25]);
        this.previousBeanTemp = 25.0;
        this.previousTime = 0;
        
        // Clear data
        this.timeData = [];
        this.temperatureData = { bean: [], environment: [], roaster: [], air: [] };
        this.controlData = { heater: [], fan: [], drum: [] };
        
        // Update UI
        this.updatePhaseDisplay();
        this.updateStatusDisplay();
        this.updateCharts();
    }
    
    /**
     * Perform one simulation step
     */
    async simulationStep() {
        if (!this.isRunning) return;
        
        try {
            // Calculate current time
            const currentTime = (Date.now() - this.startTime) / 1000; // seconds
            const currentTimeMinutes = currentTime / 60; // minutes
            
            // Determine if beans are present based on phase
            const beansPresent = this.currentPhase === this.phases.ROASTING;
            const massValue = beansPresent ? this.controls.mass : 0.0;
            
            // Check if we should transition from preheating to ready
            if (this.currentPhase === this.phases.PREHEATING) {
                const avgTemp = this.denormalizeTemperature((this.currentState[0] + this.currentState[2]) / 2);
                if (avgTemp > 150) { // When average of roaster and air temp > 150°C
                    this.currentPhase = this.phases.READY;
                    this.updatePhaseDisplay();
                }
            }
            
            // Prepare inputs for state estimator
            // Based on metadata: observables (9) + inputs (5) + mass_indicator (1) = 15
            const estimatorInput = new Float32Array(15);
            
            // Observables (9): [bean_temp, env_temp, temp_diff, delayed versions...]
            // For simplicity, we'll use current state for all delayed observables
            const beanTemp = this.currentState[3]; // T_bm (bean measurement)
            const envTemp = this.currentState[0]; // Use roaster temp as environment temp approximation
            const tempDiff = beanTemp - envTemp;
            
            // Fill observables (current + delayed copies)
            estimatorInput[0] = beanTemp;     // bean_temp
            estimatorInput[1] = envTemp;      // environment_temp  
            estimatorInput[2] = tempDiff;     // temp_difference
            estimatorInput[3] = beanTemp;     // bean_temp_t-0.1 (delayed)
            estimatorInput[4] = envTemp;      // environment_temp_t-0.1 (delayed)
            estimatorInput[5] = tempDiff;     // temp_difference_t-0.1 (delayed)
            estimatorInput[6] = beanTemp;     // bean_temp_t-0.1 (duplicate)
            estimatorInput[7] = envTemp;      // environment_temp_t-0.1 (duplicate)
            estimatorInput[8] = tempDiff;     // temp_difference_t-0.1 (duplicate)
            
            // Inputs (5): [heater, fan, drum, ambient_temp, humidity] (normalized)
            // Controls are already in [0,1] range, but ambient temp and humidity need scaling
            estimatorInput[9] = this.controls.heater;  // Already 0-1
            estimatorInput[10] = this.controls.fan;    // Already 0-1
            estimatorInput[11] = this.fixedParams.drum; // Already 0-1 (0.6)
            estimatorInput[12] = this.fixedParams.ambient / this.scalingFactors.controls.ambient;
            estimatorInput[13] = this.fixedParams.humidity / this.scalingFactors.controls.humidity;
            
            // Mass indicator (1): boolean converted to float
            estimatorInput[14] = beansPresent ? 1.0 : 0.0;
            
            // Run state estimator
            const estimatorResult = await this.sessions.stateEstimator.run({
                estimator_input: new ort.Tensor('float32', estimatorInput, [1, 15])
            });
            const latentStates = estimatorResult.latent_states.data; // [T_r, T_b, T_air, C_b, latent]
            
            // Get bean thermal capacity from bean model if beans are present
            let beanCapacity = latentStates[3]; // Default from estimator
            if (beansPresent && this.sessions.beanModel) {
                const beanModelResult = await this.sessions.beanModel.run({
                    bean_temperature: new ort.Tensor('float32', [this.currentState[1]], [1, 1])
                });
                beanCapacity = beanModelResult.thermal_capacity.data[0];
            }
            
            // Prepare controls for roast stepper
            // Based on DrumRoaster.forward() in models.py: [heat, fan, drum, T_amb, humidity, mass, C_b, latent]
            const stepperControls = new Float32Array(8);
            stepperControls[0] = this.controls.heater;  // Already 0-1
            stepperControls[1] = this.controls.fan;     // Already 0-1
            stepperControls[2] = this.fixedParams.drum; // Already 0-1 (0.6)
            stepperControls[3] = this.fixedParams.ambient / this.scalingFactors.controls.ambient;  // Scale temperature
            stepperControls[4] = this.fixedParams.humidity / this.scalingFactors.controls.humidity; // Scale humidity
            stepperControls[5] = massValue / this.scalingFactors.mass;  // Scale mass
            stepperControls[6] = beanCapacity;  // Already normalized from model
            stepperControls[7] = latentStates[4]; // Additional latent
            
            // Time step (normalized)
            const dt = new Float32Array([this.timestep / this.scalingFactors.time]);
            
            // Run roast stepper to get next state
            const stepperResult = await this.sessions.roastStepper.run({
                current_state: new ort.Tensor('float32', this.currentState, [1, 4]),
                current_controls: new ort.Tensor('float32', stepperControls, [1, 8]),
                dt: new ort.Tensor('float32', dt, [1, 1])
            });
            
            // Update current state
            this.currentState = new Float32Array(stepperResult.next_state.data);
            
            // Store data for plotting
            this.timeData.push(currentTimeMinutes);
            this.temperatureData.bean.push(this.denormalizeTemperature(this.currentState[3])); // T_bm
            this.temperatureData.environment.push(this.denormalizeTemperature(this.currentState[0])); // T_r
            this.temperatureData.roaster.push(this.denormalizeTemperature(this.currentState[0])); // T_r
            this.temperatureData.air.push(this.denormalizeTemperature(this.currentState[2])); // T_air
            
            this.controlData.heater.push(this.controls.heater);
            this.controlData.fan.push(this.controls.fan);
            this.controlData.drum.push(this.fixedParams.drum);
            
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
            // Reset to initial values
            document.getElementById('bean-temp').textContent = '25°C';
            document.getElementById('env-temp').textContent = '25°C';
            document.getElementById('roaster-temp').textContent = '25°C';
            document.getElementById('air-temp').textContent = '25°C';
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
        // Calculate xlimit: maximum of 10 minutes or (last time stamp) + 1 minute
        let xlimit = 10; // Default minimum of 10 minutes
        if (this.timeData.length > 0) {
            const lastTimeStamp = this.timeData[this.timeData.length - 1];
            xlimit = Math.max(10, lastTimeStamp + 1);
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
        
        // Update temperature chart
        const tempUpdate = {
            x: [this.timeData, this.timeData, this.timeData, this.timeData],
            y: [
                this.temperatureData.bean,
                this.temperatureData.environment,
                this.temperatureData.roaster,
                this.temperatureData.air
            ]
        };
        Plotly.restyle('temperature-chart', tempUpdate);
        
        // Update temperature chart axis ranges
        const tempLayoutUpdate = {
            'xaxis.range': [0, xlimit],
            'yaxis.range': [0, ylimit]
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
        
        // Update control chart x-axis range
        const controlLayoutUpdate = {
            'xaxis.range': [0, xlimit]
        };
        Plotly.relayout('control-chart', controlLayoutUpdate);
    }
}

// Initialize the simulator when the page loads
let simulator;

window.addEventListener('load', async () => {
    simulator = new RoasterSimulator();
    await simulator.loadModels();
});
