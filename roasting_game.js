/**
 * AutoRoaster Challenge - Game JavaScript
 * Complete game logic for the coffee roasting challenge
 * 
 * This file implements:
 * - Email entry and player registration
 * - Game mode selection (blind vs. lookahead)
 * - Real-time roaster simulation using ONNX models
 * - Lookahead prediction visualization
 * - Scoring system (MAPE calculation)
 * - Leaderboard integration with Supabase
 */

// Supabase Configuration
const SUPABASE_URL = 'https://iwjnsgjzbratogyiespi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml3am5zZ2p6YnJhdG9neWllc3BpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk3MTExMjEsImV4cCI6MjA3NTI4NzEyMX0.QmPziA27iNQ4ZXmptlm-hkrhy3JgknK5VsekYl7aCPQ';

// Initialize Supabase client
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Game State
 * Tracks all game variables including player info, mode, roast data, and simulation state
 */
const gameState = {
    // Player information
    playerEmail: null,
    playerId: null,
    
    // Game configuration
    gameMode: 'lookahead', // 'blind' or 'lookahead'
    
    // Target and actual temperature profiles (arrays of temperature values)
    targetProfile: null,
    actualProfile: [],
    
    // Timing
    roastStartTime: null,
    roastEndTime: null,
    
    // Simulation state
    isRoasting: false,
    
    // ONNX Runtime sessions (model instances)
    sessions: {
        stateEstimator: null,
        roastStepper: null,
        beanModel: null
    },
    
    // Current system state vector: [T_r, T_b, T_air, T_bm, T_atm] (normalized)
    // T_r: Roaster/drum temperature
    // T_b: Bean core temperature
    // T_air: Air temperature
    // T_bm: Bean measurement temperature (probe)
    // T_atm: Measured air temperature
    currentState: null,
    
    // Scaling factors for normalization (from roaster-simulator.js)
    scalingFactors: {
        temperatures: { bean: 100.0 },
        controls: { ambient: 100.0, humidity: 100.0 },
        mass: 100.0,
        time: 60.0
    },
    
    // Fixed simulation parameters
    timestep: 1.5, // Physics timestep in seconds
    speedupFactor: 8, // Run simulation at 8x real-time
    preheatTemp: 180.0, // Preheat temperature in °C
    fixedParams: {
        drum: 0.6,      // Fixed drum speed (60%)
        ambient: 24.0,  // Ambient temperature (°C)
        humidity: 0.5,  // Fixed humidity
        mass: 150.0     // Bean mass in grams
    },
    
    // User control inputs
    controls: {
        heater: 0.5,
        fan: 0.5
    },
    
    // Data arrays for plotting (all temperatures in °C)
    timeData: [],               // Time in minutes
    tempData: {
        beanProbe: [],          // T_bm - Bean probe measurement
        beanSurface: [],        // T_b - Bean surface/core temperature
        drum: [],               // T_r - Roaster/drum temperature
        air: [],                // T_air - Air temperature
        airMeasured: []         // T_atm - Measured air temperature
    },
    rateOfRiseData: [],         // Rate of rise (°C/min) for bean probe
    
    // Control data arrays (for plotting control inputs over time)
    controlData: {
        heater: [],             // Heater power (0-1)
        fan: []                 // Fan speed (0-1)
    },
    
    // Forecast data (for lookahead mode) - all temperatures in °C
    forecastData: {
        time: [],               // Forecast time points
        beanProbe: [],          // Predicted bean probe temps
        beanSurface: [],        // Predicted bean surface temps
        drum: [],               // Predicted drum temps
        air: [],                // Predicted air temps
        airMeasured: []         // Predicted measured air temps
    },
    
    // Simulation interval handle
    simulationInterval: null,
    simulationTime: 0  // Simulation time in seconds
};

/**
 * Initialize the game when page loads
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing AutoRoaster Challenge...');
    setupEmailScreen();
    setupGameControls();
    setupResultsModal();
});

/**
 * Setup email entry screen and mode selection
 * Handles user input, validation, and game start
 */
function setupEmailScreen() {
    const emailInput = document.getElementById('email-input');
    const startBtn = document.getElementById('start-game-btn');
    const modeCards = document.querySelectorAll('.mode-card');
    
    // Mode selection - user clicks on mode cards
    modeCards.forEach(card => {
        card.addEventListener('click', () => {
            modeCards.forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            gameState.gameMode = card.dataset.mode;
        });
    });
    
    // Start game button
    startBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        
        if (!email || !validateEmail(email)) {
            showError('Please enter a valid email address');
            return;
        }
        
        startBtn.disabled = true;
        startBtn.textContent = 'Loading...';
        
        try {
            // Register player in database
            await registerPlayer(email);
            
            // Update mode display first
            document.getElementById('current-mode-display').textContent = 
                gameState.gameMode === 'blind' ? '☕ Blind Mode' : '🤖 Lookahead Mode';
            
            // Initialize simulator and load models
            await initializeSimulator();
            
            // Hide email screen after everything is ready
            document.getElementById('email-overlay').classList.add('hidden');
            
        } catch (error) {
            console.error('Error starting game:', error);
            showError('Failed to start game. Please try again.');
            startBtn.disabled = false;
            startBtn.textContent = 'Start Roasting!';
        }
    });
    
    // Enter key to start
    emailInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            startBtn.click();
        }
    });
}

/**
 * Validate email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid email format
 */
function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

/**
 * Show error message on email screen
 * @param {string} message - Error message to display
 */
function showError(message) {
    const errorDiv = document.getElementById('email-error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

/**
 * Register player in database (or get existing player ID)
 * @param {string} email - Player's email address
 */
async function registerPlayer(email) {
    gameState.playerEmail = email;
    
    // Check if player already exists
    const { data: existingPlayer, error: fetchError } = await supabase
        .from('game_players')
        .select('id')
        .eq('email', email)
        .single();
    
    if (existingPlayer) {
        // Player exists, use their ID
        gameState.playerId = existingPlayer.id;
        console.log('Existing player:', gameState.playerId);
    } else {
        // New player, insert into database
        const { data: newPlayer, error: insertError } = await supabase
            .from('game_players')
            .insert({ email: email })
            .select('id')
            .single();
        
        if (insertError) {
            throw new Error('Failed to register player: ' + insertError.message);
        }
        
        gameState.playerId = newPlayer.id;
        console.log('New player registered:', gameState.playerId);
    }
}

/**
 * Initialize simulator and load ONNX models
 */
async function initializeSimulator() {
    try {
        console.log('Loading ONNX models...');
        
        // Load ONNX models
        gameState.sessions.stateEstimator = await ort.InferenceSession.create('onnx_models/state_estimator.onnx');
        gameState.sessions.roastStepper = await ort.InferenceSession.create('onnx_models/roast_stepper.onnx');
        gameState.sessions.beanModel = await ort.InferenceSession.create('onnx_models/bean_guji.onnx');
        
        console.log('ONNX models loaded successfully');
        
        // Initialize state to preheat conditions
        initializePreheatState();
        
        // Generate target profile
        generateTargetProfile();
        
        // Initialize chart
        initializeChart();
        
        // Hide loading, show game controls
        document.getElementById('loading').style.display = 'none';
        document.getElementById('game-controls').style.display = 'block';
        
        // Load initial leaderboard for current mode
        await loadLiveLeaderboard();
        
        console.log('Game initialized successfully');
        
    } catch (error) {
        console.error('Failed to initialize simulator:', error);
        document.getElementById('loading').textContent = 'Error loading models: ' + error.message;
        document.getElementById('loading').style.color = '#dc3545';
    }
}

/**
 * Initialize state with preheat conditions
 * Roaster is preheated to 180°C before beans are added
 */
function initializePreheatState() {
    const roomTemp = 25.0; // °C
    const preheatTemp = gameState.preheatTemp; // 180°C
    const roasterTemp = preheatTemp + 50.0; // 230°C
    const airTemp = preheatTemp - 40.0; // 140°C
    const measuredAirTemp = preheatTemp; // 180°C
    
    // Normalize temperatures using scaling factor
    const tempScale = gameState.scalingFactors.temperatures.bean;
    
    // State vector: [T_r, T_b, T_air, T_bm, T_atm]
    gameState.currentState = new Float32Array([
        roasterTemp / tempScale,        // T_r (roaster temperature)
        roomTemp / tempScale,           // T_b (bean core - starts at room temp)
        airTemp / tempScale,            // T_air (air temperature)
        preheatTemp / tempScale,        // T_bm (bean measurement temp)
        measuredAirTemp / tempScale     // T_atm (measured air temp)
    ]);
}

/**
 * Generate target temperature profile using ProfileGenerator
 */
function generateTargetProfile() {
    // Generate time array (10 minutes with 0.1 minute resolution)
    const times = [];
    for (let t = 0; t <= 10; t += 0.1) {
        times.push(t);
    }
    
    // Use ProfileGenerator to create the default profile
    const profile = ProfileGenerator.generateDefaultProfile(times);
    gameState.targetProfile = profile.temps;
    
    console.log('Generated target profile with', gameState.targetProfile.length, 'points');
}

/**
 * Setup game controls and event listeners
 */
function setupGameControls() {
    // Heater slider
    const heaterSlider = document.getElementById('heater-slider');
    const heaterValue = document.getElementById('heater-value');
    heaterSlider.addEventListener('input', (e) => {
        gameState.controls.heater = parseFloat(e.target.value);
        heaterValue.textContent = Math.round(gameState.controls.heater * 100) + '%';
    });
    
    // Fan slider
    const fanSlider = document.getElementById('fan-slider');
    const fanValue = document.getElementById('fan-value');
    fanSlider.addEventListener('input', (e) => {
        gameState.controls.fan = parseFloat(e.target.value);
        fanValue.textContent = Math.round(gameState.controls.fan * 100) + '%';
    });
    
    // Charge button - starts the roast
    document.getElementById('charge-btn').addEventListener('click', () => {
        startRoast();
    });
    
    // Reset button - resets the game
    document.getElementById('reset-btn').addEventListener('click', () => {
        resetGame();
    });
    
    // Switch mode button (in-game) - toggles between blind and lookahead modes
    document.getElementById('switch-mode-in-game-btn').addEventListener('click', () => {
        // Toggle mode
        gameState.gameMode = gameState.gameMode === 'blind' ? 'lookahead' : 'blind';
        
        // Update display
        document.getElementById('current-mode-display').textContent = 
            gameState.gameMode === 'blind' ? '☕ Blind Mode' : '🤖 Lookahead Mode';
        
        // Reset the game with new mode
        resetGame();
    });
}

/**
 * Start the roasting session
 */
function startRoast() {
    console.log('Starting roast...');
    gameState.isRoasting = true;
    gameState.roastStartTime = Date.now();
    gameState.actualProfile = [];
    
    // Reset data arrays with proper structure
    gameState.timeData = [];
    gameState.tempData = {
        beanProbe: [],
        beanSurface: [],
        drum: [],
        air: [],
        airMeasured: []
    };
    gameState.rateOfRiseData = [];
    gameState.simulationTime = 0;
    
    // Reset state to preheat conditions
    initializePreheatState();
    
    // Update UI
    document.getElementById('charge-btn').disabled = true;
    
    // Start simulation loop - run at 8x speed (187.5ms intervals for 1.5s timestep)
    const intervalMs = (gameState.timestep * 1000) / gameState.speedupFactor;
    gameState.simulationInterval = setInterval(() => simulationStep(), intervalMs);
    
    console.log(`Simulation started at ${gameState.speedupFactor}x speed`);
}

/**
 * Run one simulation step
 * This is the core physics simulation that advances the roaster state forward in time
 */
async function simulationStep() {
    try {
        // Get bean thermal capacity from bean model
        const beanModelResult = await gameState.sessions.beanModel.run({
            bean_temperature: new ort.Tensor('float32', [gameState.currentState[1]], [1, 1])
        });
        const beanCapacity = beanModelResult.thermal_capacity.data[0];
        
        // Prepare controls: [heater, fan, drum, ambient, humidity, mass, beanCapacity]
        const controls = new Float32Array(7);
        controls[0] = gameState.controls.heater;
        controls[1] = gameState.controls.fan;
        controls[2] = gameState.fixedParams.drum;
        controls[3] = gameState.fixedParams.ambient / gameState.scalingFactors.controls.ambient;
        controls[4] = gameState.fixedParams.humidity / gameState.scalingFactors.controls.humidity;
        controls[5] = gameState.fixedParams.mass / gameState.scalingFactors.mass;
        controls[6] = beanCapacity;
        
        // Time step (normalized)
        const dt = new Float32Array([gameState.timestep / gameState.scalingFactors.time]);
        
        // Run stepper to get next state
        const stepperResult = await gameState.sessions.roastStepper.run({
            current_state: new ort.Tensor('float32', gameState.currentState, [1, 5]),
            current_controls: new ort.Tensor('float32', controls, [1, 7]),
            dt: new ort.Tensor('float32', dt, [1, 1])
        });
        
        // Update state
        gameState.currentState = new Float32Array(stepperResult.next_state.data);
        
        // Advance simulation time
        gameState.simulationTime += gameState.timestep;
        const currentTimeMin = gameState.simulationTime / 60;
        
        // Extract all temperatures from state vector and denormalize
        // State vector: [T_r, T_b, T_air, T_bm, T_atm]
        const tempScale = gameState.scalingFactors.temperatures.bean;
        const temps = {
            drum: gameState.currentState[0] * tempScale,           // T_r - Roaster/drum temperature
            beanSurface: gameState.currentState[1] * tempScale,    // T_b - Bean surface/core temperature
            air: gameState.currentState[2] * tempScale,            // T_air - Air temperature
            beanProbe: gameState.currentState[3] * tempScale,      // T_bm - Bean probe measurement (primary)
            airMeasured: gameState.currentState[4] * tempScale     // T_atm - Measured air temperature
        };
        
        // Store data - time and all temperatures
        gameState.timeData.push(currentTimeMin);
        gameState.tempData.beanProbe.push(temps.beanProbe);
        gameState.tempData.beanSurface.push(temps.beanSurface);
        gameState.tempData.drum.push(temps.drum);
        gameState.tempData.air.push(temps.air);
        gameState.tempData.airMeasured.push(temps.airMeasured);
        
        // Store control inputs for plotting
        gameState.controlData.heater.push(gameState.controls.heater);
        gameState.controlData.fan.push(gameState.controls.fan);
        
        // Store bean surface (core) temperature for scoring (this is what we compare to target)
        gameState.actualProfile.push(temps.beanSurface);
        
        // Calculate rate of rise (°C/min) for bean probe temperature
        // Clamp to zero minimum (never show negative RoR)
        if (gameState.tempData.beanProbe.length > 1) {
            const prevTemp = gameState.tempData.beanProbe[gameState.tempData.beanProbe.length - 2];
            const prevTime = gameState.timeData[gameState.timeData.length - 2];
            const timeDiff = currentTimeMin - prevTime;
            const tempDiff = temps.beanProbe - prevTemp;
            const ror = timeDiff > 0 ? tempDiff / timeDiff : 0;
            // Clamp to minimum of 0 (don't show negative RoR values)
            gameState.rateOfRiseData.push(Math.max(0, ror));
        } else {
            gameState.rateOfRiseData.push(0);
        }
        
        // Compute forecast if in lookahead mode
        if (gameState.gameMode === 'lookahead') {
            await computeForecast();
        }
        
        // Update UI
        updateStatusDisplay();
        updateChart();
        
        // Auto-stop after 10 minutes
        if (currentTimeMin >= 10) {
            endRoast();
        }
        
    } catch (error) {
        console.error('Simulation error:', error);
        if (gameState.simulationInterval) {
            clearInterval(gameState.simulationInterval);
            gameState.simulationInterval = null;
        }
        gameState.isRoasting = false;
    }
}

/**
 * Compute 240-second (4-minute) forecast from current state
 * Uses current control settings to predict future temperatures
 */
async function computeForecast() {
    const forecastHorizon = 240; // 4 minutes = 240 seconds
    const forecastSteps = Math.ceil(forecastHorizon / gameState.timestep);
    
    // Arrays to store all forecast temperatures
    const forecastTime = [];
    const forecastBeanProbe = [];
    const forecastBeanSurface = [];
    const forecastDrum = [];
    const forecastAir = [];
    const forecastAirMeasured = [];
    
    // Create a copy of current state for forecasting
    let forecastState = new Float32Array(gameState.currentState);
    
    // Get bean capacity
    let beanCapacity = 0.5;
    if (gameState.sessions.beanModel) {
        const beanModelResult = await gameState.sessions.beanModel.run({
            bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
        });
        beanCapacity = beanModelResult.thermal_capacity.data[0];
    }
    
    // Prepare controls (fixed at current values)
    const forecastControls = new Float32Array(7);
    forecastControls[0] = gameState.controls.heater;
    forecastControls[1] = gameState.controls.fan;
    forecastControls[2] = gameState.fixedParams.drum;
    forecastControls[3] = gameState.fixedParams.ambient / gameState.scalingFactors.controls.ambient;
    forecastControls[4] = gameState.fixedParams.humidity / gameState.scalingFactors.controls.humidity;
    forecastControls[5] = gameState.fixedParams.mass / gameState.scalingFactors.mass;
    
    const dt = new Float32Array([gameState.timestep / gameState.scalingFactors.time]);
    const tempScale = gameState.scalingFactors.temperatures.bean;
    
    // Run forecast loop
    for (let step = 0; step < forecastSteps; step++) {
        // Update bean capacity
        if (gameState.sessions.beanModel) {
            const beanModelResult = await gameState.sessions.beanModel.run({
                bean_temperature: new ort.Tensor('float32', [forecastState[1]], [1, 1])
            });
            beanCapacity = beanModelResult.thermal_capacity.data[0];
            forecastControls[6] = beanCapacity;
        }
        
        // Predict next state
        const stepperResult = await gameState.sessions.roastStepper.run({
            current_state: new ort.Tensor('float32', forecastState, [1, 5]),
            current_controls: new ort.Tensor('float32', forecastControls, [1, 7]),
            dt: new ort.Tensor('float32', dt, [1, 1])
        });
        
        // Update forecast state
        forecastState = new Float32Array(stepperResult.next_state.data);
        
        // Store all forecast temperatures (denormalized)
        // State vector: [T_r, T_b, T_air, T_bm, T_atm]
        const forecastTimePoint = gameState.simulationTime / 60 + (step + 1) * gameState.timestep / 60;
        forecastTime.push(forecastTimePoint);
        forecastDrum.push(forecastState[0] * tempScale);         // T_r - Drum
        forecastBeanSurface.push(forecastState[1] * tempScale);  // T_b - Bean surface
        forecastAir.push(forecastState[2] * tempScale);          // T_air - Air
        forecastBeanProbe.push(forecastState[3] * tempScale);    // T_bm - Bean probe
        forecastAirMeasured.push(forecastState[4] * tempScale);  // T_atm - Air measured
    }
    
    // Store all forecast data
    gameState.forecastData.time = forecastTime;
    gameState.forecastData.beanProbe = forecastBeanProbe;
    gameState.forecastData.beanSurface = forecastBeanSurface;
    gameState.forecastData.drum = forecastDrum;
    gameState.forecastData.air = forecastAir;
    gameState.forecastData.airMeasured = forecastAirMeasured;
}

/**
 * Update status display with current temperatures and time
 */
function updateStatusDisplay() {
    if (gameState.timeData.length === 0) {
        return;
    }
    
    const latest = gameState.timeData.length - 1;
    const currentTime = gameState.timeData[latest];
    const currentBeanProbe = gameState.tempData.beanProbe[latest];
    const currentBeanSurface = gameState.tempData.beanSurface[latest];  // Bean core/surface (used for scoring)
    const currentRoR = gameState.rateOfRiseData[latest];
    
    // Update temperature display (show bean probe temperature)
    document.getElementById('bean-temp').textContent = Math.round(currentBeanProbe) + '°C';
    
    // Update time
    const minutes = Math.floor(currentTime);
    const seconds = Math.floor((currentTime - minutes) * 60);
    document.getElementById('roast-time').textContent = 
        String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    
    // Update rate of rise
    document.getElementById('rate-of-rise').textContent = currentRoR.toFixed(1) + '°C/min';
    
    // Calculate current error vs target using BEAN SURFACE temperature (this is what we score on)
    const targetIndex = Math.floor(currentTime * 10); // Target has 0.1 min resolution
    if (targetIndex < gameState.targetProfile.length) {
        const targetTemp = gameState.targetProfile[targetIndex];
        const error = Math.abs(currentBeanSurface - targetTemp);  // Error based on bean surface, not probe
        document.getElementById('current-error').textContent = error.toFixed(1) + '°C';
    }
}

/**
 * End the roasting session and calculate score
 */
async function endRoast() {
    console.log('Ending roast...');
    
    // Stop simulation
    gameState.isRoasting = false;
    gameState.roastEndTime = Date.now();
    
    if (gameState.simulationInterval) {
        clearInterval(gameState.simulationInterval);
        gameState.simulationInterval = null;
    }
    
    // Calculate duration
    const durationSeconds = Math.floor((gameState.roastEndTime - gameState.roastStartTime) / 1000);
    
    // Calculate MAPE score
    const score = calculateMAPE(gameState.targetProfile, gameState.actualProfile);
    
    console.log(`Roast complete! Score: ${score.toFixed(2)}%, Duration: ${durationSeconds}s`);
    
    // Update UI
    document.getElementById('charge-btn').disabled = false;
    
    // Submit score and show results
    try {
        await submitScore(score, durationSeconds);
        await loadLeaderboards();
        showResults(score);
    } catch (error) {
        console.error('Error submitting score:', error);
        alert('Failed to submit score. Please try again.');
    }
}

/**
 * Calculate Mean Absolute Percentage Error (MAPE)
 * This is the scoring metric - lower is better
 * 
 * Properly interpolates actual profile to match target profile time points
 * 
 * @param {Array} targetProfile - Array of target temperatures (101 points, 0.1 min resolution)
 * @param {Array} actualProfile - Array of actual temperatures (variable length, 1.5s resolution)
 * @returns {number} MAPE score as percentage
 */
function calculateMAPE(targetProfile, actualProfile) {
    if (!targetProfile || !actualProfile || targetProfile.length === 0 || actualProfile.length === 0) {
        return 100.0;
    }
    
    // Target profile is at 0.1 minute intervals (0, 0.1, 0.2, ..., 10.0)
    // Actual profile is collected at gameState.timeData intervals
    // We need to interpolate actual values at target time points
    
    let sumPercentageError = 0;
    let validPoints = 0;
    
    // For each target time point, find corresponding actual temperature via interpolation
    for (let i = 0; i < targetProfile.length; i++) {
        const targetTime = i * 0.1; // Time in minutes for this target point
        const targetTemp = targetProfile[i];
        
        // Skip if target is too close to zero (avoid division by zero)
        if (Math.abs(targetTemp) < 0.1) {
            continue;
        }
        
        // Find actual temperature at this time via linear interpolation
        const actualTemp = interpolateActualTemp(targetTime);
        
        if (actualTemp === null) {
            // No data available at this time (roast not started or already ended)
            continue;
        }
        
        // Calculate absolute percentage error
        const percentageError = Math.abs((actualTemp - targetTemp) / targetTemp);
        sumPercentageError += percentageError;
        validPoints++;
    }
    
    if (validPoints === 0) {
        return 100.0;
    }
    
    // Calculate mean and convert to percentage
    const mape = (sumPercentageError / validPoints) * 100;
    
    return mape;
}

/**
 * Interpolate actual temperature at a specific time point
 * Uses linear interpolation between recorded data points
 * 
 * @param {number} targetTime - Time in minutes to interpolate at
 * @returns {number|null} Interpolated temperature or null if out of range
 */
function interpolateActualTemp(targetTime) {
    const timeData = gameState.timeData;
    const tempData = gameState.actualProfile; // Bean surface temps
    
    if (!timeData || timeData.length === 0) {
        return null;
    }
    
    // If target time is before first data point, return null
    if (targetTime < timeData[0]) {
        return null;
    }
    
    // If target time is after last data point, return last value
    if (targetTime >= timeData[timeData.length - 1]) {
        return tempData[tempData.length - 1];
    }
    
    // Find the two points to interpolate between
    for (let i = 0; i < timeData.length - 1; i++) {
        const t1 = timeData[i];
        const t2 = timeData[i + 1];
        
        if (targetTime >= t1 && targetTime <= t2) {
            // Linear interpolation
            const temp1 = tempData[i];
            const temp2 = tempData[i + 1];
            const fraction = (targetTime - t1) / (t2 - t1);
            return temp1 + fraction * (temp2 - temp1);
        }
    }
    
    // Should never reach here, but return last value as fallback
    return tempData[tempData.length - 1];
}

/**
 * Submit score to Supabase database
 * @param {number} score - MAPE score
 * @param {number} durationSeconds - Roast duration in seconds
 */
async function submitScore(score, durationSeconds) {
    const { data, error } = await supabase
        .from('game_scores')
        .insert({
            player_id: gameState.playerId,
            mode: gameState.gameMode,
            score: score,
            duration_seconds: durationSeconds,
            target_profile_id: 'default_profile'
        })
        .select();
    
    if (error) {
        throw new Error('Failed to submit score: ' + error.message);
    }
    
    console.log('Score submitted successfully');
    return data;
}

/**
 * Load live leaderboard for current mode
 */
async function loadLiveLeaderboard() {
    const viewName = gameState.gameMode === 'blind' ? 'leaderboard_blind' : 'leaderboard_lookahead';
    const title = gameState.gameMode === 'blind' ? '☕ Blind Top 10' : '🤖 Lookahead Top 10';
    
    // Update title
    document.getElementById('leaderboard-title').textContent = title;
    
    // Load data
    const { data, error } = await supabase
        .from(viewName)
        .select('*')
        .limit(10);
    
    if (!error && data) {
        displayLeaderboard('live-leaderboard', data);
    }
}

/**
 * Load leaderboards for both modes from Supabase
 */
async function loadLeaderboards() {
    // Load blind mode leaderboard
    const { data: blindData, error: blindError } = await supabase
        .from('leaderboard_blind')
        .select('*')
        .limit(10);
    
    if (!blindError && blindData) {
        displayLeaderboard('leaderboard-blind', blindData);
    }
    
    // Load lookahead mode leaderboard
    const { data: lookaheadData, error: lookaheadError } = await supabase
        .from('leaderboard_lookahead')
        .select('*')
        .limit(10);
    
    if (!lookaheadError && lookaheadData) {
        displayLeaderboard('leaderboard-lookahead', lookaheadData);
    }
}

/**
 * Display leaderboard data in table
 * @param {string} tableBodyId - ID of tbody element
 * @param {Array} data - Leaderboard data from database
 */
function displayLeaderboard(tableBodyId, data) {
    const tbody = document.getElementById(tableBodyId);
    
    if (!data || data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: #999;">No scores yet!</td></tr>';
        return;
    }
    
    // Build HTML for rows
    const rows = data.map((entry, index) => {
        const rank = index + 1;
        const isCurrentPlayer = entry.player_name && 
            entry.player_name.includes(gameState.playerEmail.substring(0, 3));
        const highlightClass = isCurrentPlayer ? 'highlight' : '';
        
        // Anonymize email (show first 3 chars + ***)
        const displayName = entry.player_name || gameState.playerEmail.substring(0, 3) + '***';
        
        return `
            <tr class="${highlightClass}">
                <td><span class="rank-badge">${rank}</span></td>
                <td>${displayName}</td>
                <td>${entry.score.toFixed(2)}%</td>
            </tr>
        `;
    }).join('');
    
    tbody.innerHTML = rows;
}

/**
 * Show results modal
 * @param {number} score - Final MAPE score
 */
function showResults(score) {
    document.getElementById('final-score').textContent = score.toFixed(2) + '%';
    document.getElementById('results-modal').classList.add('active');
}

/**
 * Setup results modal button handlers
 */
function setupResultsModal() {
    // Play again button
    document.getElementById('play-again-btn').addEventListener('click', () => {
        document.getElementById('results-modal').classList.remove('active');
        resetGame();
    });
    
    // Switch mode button
    document.getElementById('switch-mode-btn').addEventListener('click', () => {
        // Toggle mode
        gameState.gameMode = gameState.gameMode === 'blind' ? 'lookahead' : 'blind';
        
        // Update display
        document.getElementById('current-mode-display').textContent = 
            gameState.gameMode === 'blind' ? '☕ Blind Mode' : '🤖 Lookahead Mode';
        
        // Close modal and reset
        document.getElementById('results-modal').classList.remove('active');
        resetGame();
    });
}

/**
 * Reset the game to initial state
 */
function resetGame() {
    console.log('Resetting game...');
    
    // Stop simulation if running
    if (gameState.simulationInterval) {
        clearInterval(gameState.simulationInterval);
        gameState.simulationInterval = null;
    }
    
    // Reset state
    gameState.isRoasting = false;
    gameState.actualProfile = [];
    gameState.roastStartTime = null;
    gameState.roastEndTime = null;
    gameState.timeData = [];
    gameState.tempData = {
        beanProbe: [],
        beanSurface: [],
        drum: [],
        air: [],
        airMeasured: []
    };
    gameState.rateOfRiseData = [];
    gameState.controlData = {
        heater: [],
        fan: []
    };
    gameState.forecastData = {
        time: [],
        beanProbe: [],
        beanSurface: [],
        drum: [],
        air: [],
        airMeasured: []
    };
    gameState.simulationTime = 0;
    
    // Reset to preheat state
    initializePreheatState();
    
    // Update UI
    document.getElementById('charge-btn').disabled = false;
    
    // Reset sliders
    document.getElementById('heater-slider').value = 0.5;
    document.getElementById('heater-value').textContent = '50%';
    document.getElementById('fan-slider').value = 0.5;
    document.getElementById('fan-value').textContent = '50%';
    
    // Reset status displays
    document.getElementById('bean-temp').textContent = '180°C';
    document.getElementById('roast-time').textContent = '00:00';
    document.getElementById('current-error').textContent = '-';
    document.getElementById('rate-of-rise').textContent = '0°C/min';
    
    // Update live leaderboard for new mode
    loadLiveLeaderboard();
    
    // Clear chart
    updateChart();
}

/**
 * Initialize Plotly chart with all temperature traces
 */
function initializeChart() {
    // Generate time array for target profile
    const times = [];
    for (let t = 0; t <= 10; t += 0.1) {
        times.push(t);
    }
    
    const layout = {
        title: 'Temperature Profile',
        xaxis: { title: 'Time (minutes)', range: [0, 10] },
        yaxis: { title: 'Temperature (°C)' },  // Primary y-axis (left) for temperature
        yaxis2: {
            title: 'Rate of Rise (°C/min)',
            overlaying: 'y',
            side: 'right',  // Secondary y-axis (right) for RoR
            rangemode: 'tozero'  // Force minimum to be zero (no negative values)
        },
        showlegend: true,
        margin: { t: 50, r: 50, b: 50, l: 50 }
    };
    
    // Actual temperature traces (indices 0-4)
    const data = [
        {
            x: [],
            y: [],
            name: 'Bean Probe',
            line: { color: '#8B4513', width: 3 },
            mode: 'lines'
        },
        {
            x: [],
            y: [],
            name: 'Bean Core',
            line: { color: '#FF6B35', width: 2 },
            mode: 'lines'
        },
        {
            x: [],
            y: [],
            name: 'Drum',
            line: { color: '#4ECDC4', width: 2 },
            mode: 'lines'
        },
        {
            x: [],
            y: [],
            name: 'Air',
            line: { color: '#95E1D3', width: 2 },
            mode: 'lines'
        },
        {
            x: [],
            y: [],
            name: 'Air Measured',
            line: { color: '#45B7D1', width: 2 },
            mode: 'lines'
        },
        // Forecast traces (indices 5-9, dashed versions)
        {
            x: [],
            y: [],
            name: 'Bean Forecast',
            line: { color: '#8B4513', width: 2, dash: 'dash' },
            mode: 'lines',
            opacity: 0.6,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Surface Forecast',
            line: { color: '#FF6B35', width: 1.5, dash: 'dash' },
            mode: 'lines',
            opacity: 0.5,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Drum Forecast',
            line: { color: '#4ECDC4', width: 1.5, dash: 'dash' },
            mode: 'lines',
            opacity: 0.5,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Air Forecast',
            line: { color: '#95E1D3', width: 1.5, dash: 'dash' },
            mode: 'lines',
            opacity: 0.5,
            showlegend: false
        },
        {
            x: [],
            y: [],
            name: 'Air Meas Forecast',
            line: { color: '#45B7D1', width: 1.5, dash: 'dash' },
            mode: 'lines',
            opacity: 0.5,
            showlegend: false
        },
        // Target profile (index 10)
        {
            x: times,
            y: gameState.targetProfile,
            name: 'Target Profile',
            line: { color: 'rgba(139, 69, 19, 0.4)', width: 3, dash: 'dashdot' },
            mode: 'lines'
        },
        // Rate of Rise (index 11) - using secondary y-axis
        {
            x: [],
            y: [],
            name: 'Rate of Rise',
            line: { color: '#FF1493', width: 2 },
            mode: 'lines',
            yaxis: 'y2'
        }
    ];
    
    Plotly.newPlot('temperature-chart', data, layout, {responsive: true});
    
    // Initialize control chart
    const controlLayout = {
        title: 'Control Inputs',
        xaxis: { title: 'Time (minutes)', range: [0, 10] },
        yaxis: { title: 'Control Value (0-1)', range: [0, 1] },
        showlegend: true,
        margin: { t: 50, r: 50, b: 50, l: 50 }
    };
    
    const controlData = [
        {
            x: [],
            y: [],
            name: 'Heater Power',
            line: { color: '#FF4444', width: 2 },
            mode: 'lines'
        },
        {
            x: [],
            y: [],
            name: 'Fan Speed',
            line: { color: '#4444FF', width: 2 },
            mode: 'lines'
        }
    ];
    
    Plotly.newPlot('control-chart', controlData, controlLayout, {responsive: true});
}

/**
 * Update Plotly charts with new data for all temperature traces and control inputs
 */
function updateChart() {
    // Determine if forecast should be shown based on game mode
    const showForecast = gameState.gameMode === 'lookahead';
    
    // Update all temperature traces
    // Traces 0-4: actual temperatures
    // Traces 5-9: forecast temperatures (shown only in lookahead mode)
    // Trace 10: target profile (static)
    // Trace 11: Rate of Rise (RoR)
    Plotly.restyle('temperature-chart', {
        x: [
            gameState.timeData,                          // 0: Bean Probe
            gameState.timeData,                          // 1: Bean Surface
            gameState.timeData,                          // 2: Drum
            gameState.timeData,                          // 3: Air
            gameState.timeData,                          // 4: Air Measured
            showForecast ? gameState.forecastData.time : [],  // 5: Bean Forecast
            showForecast ? gameState.forecastData.time : [],  // 6: Surface Forecast
            showForecast ? gameState.forecastData.time : [],  // 7: Drum Forecast
            showForecast ? gameState.forecastData.time : [],  // 8: Air Forecast
            showForecast ? gameState.forecastData.time : [],  // 9: Air Meas Forecast
            [],                                          // 10: Target (static, no update needed)
            gameState.timeData                           // 11: Rate of Rise
        ],
        y: [
            gameState.tempData.beanProbe,                              // 0: Bean Probe
            gameState.tempData.beanSurface,                            // 1: Bean Surface
            gameState.tempData.drum,                                   // 2: Drum
            gameState.tempData.air,                                    // 3: Air
            gameState.tempData.airMeasured,                            // 4: Air Measured
            showForecast ? gameState.forecastData.beanProbe : [],      // 5: Bean Forecast
            showForecast ? gameState.forecastData.beanSurface : [],    // 6: Surface Forecast
            showForecast ? gameState.forecastData.drum : [],           // 7: Drum Forecast
            showForecast ? gameState.forecastData.air : [],            // 8: Air Forecast
            showForecast ? gameState.forecastData.airMeasured : [],    // 9: Air Meas Forecast
            [],                                                        // 10: Target (static, no update needed)
            gameState.rateOfRiseData                                   // 11: Rate of Rise
        ]
    }, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    
    // Add vertical line at current time to mark forecast boundary
    const currentTimeMinutes = gameState.timeData.length > 0 ? gameState.timeData[gameState.timeData.length - 1] : 0;
    const shapes = gameState.timeData.length > 0 && showForecast ? [{
        type: 'line',
        x0: currentTimeMinutes,
        x1: currentTimeMinutes,
        y0: 0,
        y1: 250,
        line: {
            color: 'rgba(0, 0, 0, 0.3)',
            width: 2,
            dash: 'dot'
        }
    }] : [];
    
    Plotly.relayout('temperature-chart', { shapes: shapes });
    
    // Update control chart
    Plotly.restyle('control-chart', {
        x: [gameState.timeData, gameState.timeData],
        y: [gameState.controlData.heater, gameState.controlData.fan]
    }, [0, 1]);
}
