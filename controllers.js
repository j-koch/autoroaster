/**
 * Controllers Module
 * 
 * Implements various control strategies for the coffee roaster:
 * - PID Controller: Classic proportional-integral-derivative control
 * - Neural Controller: MPC-trained neural network controller (future)
 */

/**
 * PID Controller
 * 
 * A classic PID controller for temperature tracking.
 * The controller computes control actions based on:
 * - P (Proportional): Error between setpoint and measurement
 * - I (Integral): Accumulated error over time
 * - D (Derivative): Rate of change of error
 * 
 * Control output = Kp*error + Ki*integral + Kd*derivative
 */
class PIDController {
    /**
     * Create a PID controller
     * 
     * @param {number} Kp - Proportional gain
     * @param {number} Ki - Integral gain  
     * @param {number} Kd - Derivative gain
     * @param {number} outputMin - Minimum output value (default 0.0)
     * @param {number} outputMax - Maximum output value (default 1.0)
     * @param {number} integralMin - Minimum integral term for anti-windup (default -1.0)
     * @param {number} integralMax - Maximum integral term for anti-windup (default 1.0)
     */
    constructor(Kp = 0.01, Ki = 0.001, Kd = 0.005, 
                outputMin = 0.0, outputMax = 1.0,
                integralMin = -1.0, integralMax = 1.0) {
        // PID gains
        this.Kp = Kp;
        this.Ki = Ki;
        this.Kd = Kd;
        
        // Output limits (clamping)
        this.outputMin = outputMin;
        this.outputMax = outputMax;
        
        // Integral limits (anti-windup)
        this.integralMin = integralMin;
        this.integralMax = integralMax;
        
        // Internal state
        this.integral = 0.0;        // Accumulated error
        this.previousError = 0.0;   // Error from last timestep
        this.previousTime = null;   // Time of last update
        
        // Diagnostics (for tuning and debugging)
        this.lastP = 0.0;
        this.lastI = 0.0;
        this.lastD = 0.0;
        this.lastOutput = 0.0;
    }
    
    /**
     * Compute control output for current timestep
     * 
     * @param {number} setpoint - Desired value (target temperature in °C)
     * @param {number} measurement - Current measured value (current temperature in °C)
     * @param {number} currentTime - Current time in seconds
     * @returns {number} - Control output (0.0 to 1.0)
     */
    compute(setpoint, measurement, currentTime) {
        // Calculate error
        const error = setpoint - measurement;
        
        // Calculate time delta (dt)
        let dt = 1.0;  // Default to 1 second if first call
        if (this.previousTime !== null) {
            dt = currentTime - this.previousTime;
            // Prevent division by zero or negative dt
            if (dt <= 0) {
                dt = 1.0;
            }
        }
        
        // Proportional term: responds to current error
        const P = this.Kp * error;
        
        // Integral term: responds to accumulated error (with anti-windup)
        this.integral += error * dt;
        // Anti-windup: clamp integral to prevent excessive accumulation
        this.integral = Math.max(this.integralMin, Math.min(this.integralMax, this.integral));
        const I = this.Ki * this.integral;
        
        // Derivative term: responds to rate of change of error
        const derivative = (error - this.previousError) / dt;
        const D = this.Kd * derivative;
        
        // Compute total output
        let output = P + I + D;
        
        // Clamp output to valid range
        output = Math.max(this.outputMin, Math.min(this.outputMax, output));
        
        // Store for next iteration
        this.previousError = error;
        this.previousTime = currentTime;
        
        // Store diagnostics
        this.lastP = P;
        this.lastI = I;
        this.lastD = D;
        this.lastOutput = output;
        
        return output;
    }
    
    /**
     * Reset controller state
     * Call this when starting a new control session
     */
    reset() {
        this.integral = 0.0;
        this.previousError = 0.0;
        this.previousTime = null;
        this.lastP = 0.0;
        this.lastI = 0.0;
        this.lastD = 0.0;
        this.lastOutput = 0.0;
    }
    
    /**
     * Update PID gains
     * 
     * @param {number} Kp - Proportional gain
     * @param {number} Ki - Integral gain
     * @param {number} Kd - Derivative gain
     */
    setGains(Kp, Ki, Kd) {
        this.Kp = Kp;
        this.Ki = Ki;
        this.Kd = Kd;
    }
    
    /**
     * Get current PID gains
     * 
     * @returns {Object} - {Kp, Ki, Kd}
     */
    getGains() {
        return {
            Kp: this.Kp,
            Ki: this.Ki,
            Kd: this.Kd
        };
    }
    
    /**
     * Get diagnostic information for tuning
     * 
     * @returns {Object} - {P, I, D, output, integral}
     */
    getDiagnostics() {
        return {
            P: this.lastP,
            I: this.lastI,
            D: this.lastD,
            output: this.lastOutput,
            integral: this.integral
        };
    }
}


/**
 * Dual PID Controller for Heater and Fan
 * 
 * Controls both heater and fan to track a temperature setpoint.
 * Strategy:
 * - Heater: Primary control for heating (positive error)
 * - Fan: Secondary control for cooling (negative error) and rate limiting
 */
class DualPIDController {
    /**
     * Create a dual PID controller
     * 
     * @param {Object} heaterGains - {Kp, Ki, Kd} for heater PID
     * @param {Object} fanGains - {Kp, Ki, Kd} for fan PID
     */
    constructor(heaterGains = {Kp: 0.01, Ki: 0.001, Kd: 0.005},
                fanGains = {Kp: 0.005, Ki: 0.0005, Kd: 0.002}) {
        // Create separate PID controllers for heater and fan
        this.heaterPID = new PIDController(
            heaterGains.Kp, heaterGains.Ki, heaterGains.Kd
        );
        
        this.fanPID = new PIDController(
            fanGains.Kp, fanGains.Ki, fanGains.Kd
        );
        
        // Fan baseline (minimum fan speed to maintain)
        this.fanBaseline = 0.3;  // 30% minimum fan speed
    }
    
    /**
     * Compute control outputs for both heater and fan
     * 
     * @param {number} setpoint - Target temperature in °C
     * @param {number} measurement - Current temperature in °C
     * @param {number} currentTime - Current time in seconds
     * @returns {Object} - {heater: number, fan: number}
     */
    compute(setpoint, measurement, currentTime) {
        const error = setpoint - measurement;
        
        // Heater control: increases when below setpoint
        let heater = 0.0;
        if (error > 0) {
            // Below setpoint - apply heat
            heater = this.heaterPID.compute(setpoint, measurement, currentTime);
        } else {
            // At or above setpoint - no heat, reset heater PID
            this.heaterPID.reset();
            heater = 0.0;
        }
        
        // Fan control: increases when above setpoint or rate is too high
        let fan = this.fanBaseline;  // Start with baseline
        if (error < 0) {
            // Above setpoint - increase fan to cool
            const fanAdjust = this.fanPID.compute(measurement, setpoint, currentTime);
            fan = this.fanBaseline + fanAdjust;
        } else {
            // Below setpoint - reset fan PID but maintain baseline
            this.fanPID.reset();
        }
        
        // Clamp outputs to valid range [0, 1]
        heater = Math.max(0.0, Math.min(1.0, heater));
        fan = Math.max(0.0, Math.min(1.0, fan));
        
        return {
            heater: heater,
            fan: fan
        };
    }
    
    /**
     * Reset both controllers
     */
    reset() {
        this.heaterPID.reset();
        this.fanPID.reset();
    }
    
    /**
     * Update controller gains
     * 
     * @param {Object} heaterGains - {Kp, Ki, Kd} for heater
     * @param {Object} fanGains - {Kp, Ki, Kd} for fan
     */
    setGains(heaterGains, fanGains) {
        if (heaterGains) {
            this.heaterPID.setGains(heaterGains.Kp, heaterGains.Ki, heaterGains.Kd);
        }
        if (fanGains) {
            this.fanPID.setGains(fanGains.Kp, fanGains.Ki, fanGains.Kd);
        }
    }
    
    /**
     * Get diagnostic information
     * 
     * @returns {Object} - {heater: Object, fan: Object}
     */
    getDiagnostics() {
        return {
            heater: this.heaterPID.getDiagnostics(),
            fan: this.fanPID.getDiagnostics()
        };
    }
}


/**
 * Neural Controller
 * 
 * Uses an ONNX model (MPC-trained neural network) to compute control actions.
 * The controller uses a receding horizon approach with:
 * - Current state (temperatures)
 * - Reference trajectory (from background profile)
 * - Forecast trajectory (predicted future states)
 * - Historical states and actions (memory buffer)
 */
class NeuralController {
    /**
     * Create a neural controller
     * 
     * @param {Object} onnxSession - ONNX Runtime inference session for the policy network
     * @param {Object} config - Controller configuration from metadata
     * @param {Object} simulator - Reference to RoasterSimulator for accessing forecast generation
     */
    constructor(onnxSession, config, simulator) {
        this.session = onnxSession;
        this.config = config;
        this.simulator = simulator;
        
        // Extract MPC parameters from config
        this.nHorizon = config.mpc_parameters.n_horizon;  // 30 seconds
        this.dstep = config.mpc_parameters.dstep;  // 2 seconds
        this.nPastStates = config.mpc_parameters.n_past_states;  // 10
        this.nSamples = config.mpc_parameters.n_samples;  // 15
        
        // Extract input dimensions
        this.inputDim = config.policy_network.input_dim;  // 90
        this.inputBreakdown = config.policy_network.input_breakdown;
        
        // Initialize history buffers
        // Past states: [T_b] for last n_past_states timesteps
        // Shape: Array of length n_past_states
        this.pastStatesBuffer = new Array(this.nPastStates).fill(0);
        
        // Past actions: [heat, fan] for last n_past_states timesteps
        // Shape: Array of length n_past_states, each element is [heat, fan]
        this.pastActionsBuffer = new Array(this.nPastStates).fill(null).map(() => [0, 0]);
        
        console.log('NeuralController initialized:');
        console.log(`  Horizon: ${this.nHorizon}s, Subsample: ${this.dstep}s`);
        console.log(`  Past states: ${this.nPastStates}, Samples: ${this.nSamples}`);
        console.log(`  Input dimension: ${this.inputDim}`);
    }
    
    /**
     * Compute control actions for current timestep
     * 
     * @param {Object} params - Controller input parameters
     * @param {Array} params.currentState - Current latent state [T_r, T_b, T_air, T_bm, T_atm] (NORMALIZED)
     * @param {number} params.currentTime - Current time in minutes
     * @param {Function} params.getSetpoint - Function to get setpoint at a given time (returns °C)
     * @param {Function} params.generateForecast - Function to generate forecast (returns °C)
     * @returns {Object} - {heat: number, fan: number} control actions
     */
    async compute(params) {
        const { currentState, currentTime, getSetpoint, generateForecast } = params;
        
        // Scaling factor for temperatures (matches training data)
        const TEMP_SCALE = 100.0;
        
        // Extract T_b (latent bean temperature) from current state (index 1)
        // This is NORMALIZED, need to denormalize for buffer
        const currentTb = currentState[1];
        
        // Get current and future reference points from profile (in °C)
        // These need to be NORMALIZED to match training data scaling
        // Sample at dstep intervals up to n_samples points
        const futureRef = [];
        for (let i = 0; i < this.nSamples; i++) {
            const futureTime = currentTime + (i * this.dstep) / 60;  // Convert seconds to minutes
            const setpoint = getSetpoint(futureTime);  // Returns °C
            futureRef.push(setpoint / TEMP_SCALE);  // Normalize
        }
        
        // Generate forecast using current control inputs held constant
        // This simulates what would happen if we don't change controls
        const lastActions = this.pastActionsBuffer[this.pastActionsBuffer.length - 1];
        const forecast = await generateForecast(lastActions[0], lastActions[1]);
        
        // Sample forecast at dstep intervals to match reference points
        // Forecast returns °C, need to NORMALIZE
        const sampledForecast = [];
        for (let i = 0; i < this.nSamples && i < forecast.bean.length; i++) {
            // Sample at every dstep point (forecast is at 1.5s intervals from simulator)
            const idx = Math.min(Math.round(i * this.dstep / 1.5), forecast.bean.length - 1);
            sampledForecast.push(forecast.bean[idx] / TEMP_SCALE);  // Normalize
        }
        
        // Pad if forecast is shorter than expected
        while (sampledForecast.length < this.nSamples) {
            const lastValue = sampledForecast.length > 0 ? 
                sampledForecast[sampledForecast.length - 1] : 
                currentState[3];  // Use T_bm if no forecast yet
            sampledForecast.push(lastValue);
        }
        
        // Calculate forecast error (forecast - reference)
        const forecastError = sampledForecast.map((f, i) => f - futureRef[i]);
        
        // Calculate historical error (past states - past references)
        // Both need to be normalized
        const historicalError = [];
        for (let i = 0; i < this.nPastStates; i++) {
            const pastTime = currentTime - ((this.nPastStates - 1 - i) * 1.5) / 60;  // Assuming 1.5s timestep
            const pastRef = getSetpoint(pastTime);  // Returns °C
            const pastState = this.pastStatesBuffer[i];  // Already normalized
            historicalError.push(pastState - (pastRef / TEMP_SCALE));  // Normalize reference
        }
        
        // Flatten past actions buffer for controller input
        const pastActionsFlat = [];
        for (let i = 0; i < this.nPastStates; i++) {
            pastActionsFlat.push(this.pastActionsBuffer[i][0]);  // heat
            pastActionsFlat.push(this.pastActionsBuffer[i][1]);  // fan
        }
        
        // Construct controller input vector (must match training order and scaling)
        // Order: forecast_error, future_ref, sampled_forecast, current_state,
        //        past_states, historical_error, past_actions
        const controllerInput = [
            ...forecastError,           // 15 elements
            ...futureRef,               // 15 elements
            ...sampledForecast,         // 15 elements
            ...currentState,            // 5 elements [T_r, T_b, T_air, T_bm, T_atm]
            ...this.pastStatesBuffer,   // 10 elements
            ...historicalError,         // 10 elements
            ...pastActionsFlat          // 20 elements (10 timesteps × 2 actions)
        ];
        
        // Verify input dimension
        if (controllerInput.length !== this.inputDim) {
            console.error(`Input dimension mismatch: ${controllerInput.length} != ${this.inputDim}`);
            console.error('Components:', {
                forecastError: forecastError.length,
                futureRef: futureRef.length,
                sampledForecast: sampledForecast.length,
                currentState: currentState.length,
                pastStates: this.pastStatesBuffer.length,
                historicalError: historicalError.length,
                pastActions: pastActionsFlat.length
            });
            throw new Error('Controller input dimension mismatch');
        }
        
        // Run ONNX inference
        const inputTensor = new ort.Tensor('float32', new Float32Array(controllerInput), [1, this.inputDim]);
        const outputs = await this.session.run({ controller_input: inputTensor });
        const actions = outputs.control_actions.data;  // [heat, fan]
        
        // Update history buffers
        this.updateBuffers(currentTb, [actions[0], actions[1]]);
        
        // Return control actions
        return {
            heat: Math.max(0, Math.min(1, actions[0])),  // Clamp to [0, 1]
            fan: Math.max(0, Math.min(1, actions[1]))
        };
    }
    
    /**
     * Update history buffers with new data
     * 
     * @param {number} currentTb - Current T_b (latent bean temperature)
     * @param {Array} actions - Control actions [heat, fan]
     */
    updateBuffers(currentTb, actions) {
        // Shift buffers and add new values
        this.pastStatesBuffer.shift();
        this.pastStatesBuffer.push(currentTb);
        
        this.pastActionsBuffer.shift();
        this.pastActionsBuffer.push([...actions]);
    }
    
    /**
     * Reset controller state
     * Call this when starting a new roast session
     */
    reset() {
        // Reset history buffers
        this.pastStatesBuffer = new Array(this.nPastStates).fill(0);
        this.pastActionsBuffer = new Array(this.nPastStates).fill(null).map(() => [0, 0]);
        
        console.log('NeuralController reset');
    }
}
